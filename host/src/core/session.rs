//! Session —— 把 Launcher + CommandBridge + FrameRelay 组装成一次预览会话。
//! 是 core 对外的唯一出口；不假设 UI 如何连接（由 gateway 接出）。
//! 见 ../../docs/architecture.md §2.4。

use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::command_bridge::CommandBridge;
use super::frame_relay;
use super::launcher::{self, Endpoints, LaunchConfig};

pub struct Session {
    pub endpoints: Endpoints,
    cfg: LaunchConfig,
    frames: watch::Sender<Option<Bytes>>,
    #[allow(dead_code)] // 保活：留一个 receiver 使 watch 通道不因零订阅者而关闭
    frames_keepalive: watch::Receiver<Option<Bytes>>,
    /// Simulator 是否已退出（崩溃/正常）。gateway/relay 据此收口。
    shutdown: watch::Sender<bool>,
    cmd: Arc<CommandBridge>,
    /// 监控任务：持有 child、await 其退出（完成 reap）、置 shutdown。
    monitor: JoinHandle<()>,
}

impl Session {
    /// UI 连接时的握手信息：设备类型/形状/分辨率，供 UI 自适应（lite/rich 命令集不同）。
    pub fn hello(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "hello",
            "device": self.cfg.device,
            "isLite": self.cfg.is_lite(),
            "shape": self.cfg.shape,
            "width": self.cfg.width,
            "height": self.cfg.height,
            "url": self.cfg.url,
            "debug": self.cfg.debug,
            "cdpPort": self.cfg.cdp_port,
        })
    }

    /// 启动会话：bind 命令通道 → spawn Simulator → accept 命令连接 → 启动帧中继 + 退出监控。
    pub async fn start(cfg: LaunchConfig) -> Result<Arc<Self>> {
        let ep = Endpoints::allocate()?;
        println!("[session] base={} ws_port={} sid={}", ep.base, ep.ws_port, ep.sid);

        // 1. 先 listen 命令通道（必须在 spawn 之前）
        let _ = std::fs::remove_file(&ep.cmd_pipe);
        let listener = UnixListener::bind(&ep.cmd_pipe)
            .with_context(|| format!("bind 命令通道失败: {}", ep.cmd_pipe))?;

        // 2. spawn Simulator
        let child = launcher::spawn_simulator(&cfg, &ep)?;
        println!("[session] Simulator spawned, cwd=bin, 日志 {}", cfg.sim_log.display());

        // 退出信号
        let (shutdown, shutdown_rx) = watch::channel(false);

        // 3. 退出监控：持有 child，await 退出（reap），置 shutdown
        let monitor = {
            let shutdown = shutdown.clone();
            let mut child = child;
            tokio::spawn(async move {
                match child.wait().await {
                    Ok(status) => println!("[session] Simulator 退出: {status}"),
                    Err(e) => eprintln!("[session] 等待 Simulator 失败: {e}"),
                }
                let _ = shutdown.send(true);
            })
        };

        // 4. accept 命令连接 + 启动上行读取
        let cmd = CommandBridge::listen_and_accept(listener).await?;
        println!("[session] 命令通道已连通");
        {
            let mut ev = cmd.subscribe();
            tokio::spawn(async move {
                while let Ok(v) = ev.recv().await {
                    if let Some(mt) = v.get("MessageType").and_then(|x| x.as_str()) {
                        println!("[session] 上报 MessageType={mt}");
                    }
                }
            });
        }

        // 5. 帧中继：连 Simulator 图像通道，写入 watch（保留最新帧），shutdown 时停止
        let (frames, frames_keepalive) = watch::channel::<Option<Bytes>>(None);
        tokio::spawn(frame_relay::run(ep.sim_ws_url(), frames.clone(), shutdown_rx));

        Ok(Arc::new(Self {
            endpoints: ep,
            cfg,
            frames,
            frames_keepalive,
            shutdown,
            cmd,
            monitor,
        }))
    }

    /// UI gateway 订阅帧流（watch：立即拿到最新帧，之后等变更）。
    pub fn subscribe_frames(&self) -> watch::Receiver<Option<Bytes>> {
        self.frames.subscribe()
    }

    /// 订阅 Simulator 退出信号（gateway 据此通知 UI 并关闭连接）。
    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }

    /// 订阅 Simulator 上报事件。
    pub fn subscribe_events(&self) -> tokio::sync::broadcast::Receiver<serde_json::Value> {
        self.cmd.subscribe()
    }

    /// 下发命令到 Simulator（M2 交互用）。
    pub async fn send_command(&self, cmd: &serde_json::Value) -> Result<()> {
        self.cmd.send(cmd).await
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // 终止监控任务 → child 被 drop（kill_on_drop 杀掉 Simulator）
        self.monitor.abort();
        // 清理命令通道 socket 文件（finding #7）
        let _ = std::fs::remove_file(&self.endpoints.cmd_pipe);
    }
}
