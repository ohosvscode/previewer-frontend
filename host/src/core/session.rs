//! Session —— 把 Launcher + CommandBridge + FrameRelay 组装成一次预览会话。
//! 是 core 对外的唯一出口；不假设 UI 如何连接（由 gateway 接出）。
//! 见 ../../docs/architecture.md §2.4。

use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use tokio::io::AsyncBufReadExt;
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
        println!(
            "[session] base={} ws_port={} sid={}",
            ep.base, ep.ws_port, ep.sid
        );

        // 1. 先 listen 命令通道（必须在 spawn 之前）
        let _ = std::fs::remove_file(&ep.cmd_pipe);
        let listener = UnixListener::bind(&ep.cmd_pipe)
            .with_context(|| format!("bind 命令通道失败: {}", ep.cmd_pipe))?;

        // 2. spawn Simulator
        let child = launcher::spawn_simulator(&cfg, &ep)?;
        println!(
            "[session] Simulator spawned, cwd=bin, 日志 {}",
            cfg.sim_log.display()
        );

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

        // 4b. 应用诊断：tail Simulator 日志，解析未捕获 ArkRuntime 异常 → 合成 appError 事件推给 UI
        //     （否则应用 onCreate 等抛异常时只表现为静默白屏 + 空组件树，难以排查）。
        tokio::spawn(tail_app_errors(
            cfg.sim_log.clone(),
            cmd.clone(),
            shutdown.subscribe(),
        ));

        // 5. 帧中继：连 Simulator 图像通道，写入 watch（保留最新帧），shutdown 时停止
        let (frames, frames_keepalive) = watch::channel::<Option<Bytes>>(None);
        tokio::spawn(frame_relay::run(
            ep.sim_ws_url(),
            frames.clone(),
            shutdown_rx,
        ));

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

const ARK_MARK: &str = "[ArkRuntime Log] ";

/// ArkRuntime 未捕获异常的纯解析状态机（与 IO 解耦，便于单元测试）。
/// 逐行 `feed`：日志里一个异常块形如
/// ```text
/// ... [ArkRuntime Log] TypeError: Cannot read property x of undefined
/// ... [ArkRuntime Log]     at fn (module|...|src/.../File.ts:11:23)
/// ... [ArkRuntime Log]     at onCreate (...)
/// ```
/// 头行（含 `Error:`）开块、`at ...` 行累积栈、首个非 ArkRuntime 行或新头或 EOF 收口。
/// 收口时若消息非空且不同于上次，返回 `Some((message, stack))`（去重抑制运行时重复打印的同一异常）。
struct ArkErrorParser {
    pending: Option<(String, Vec<String>)>,
    last: String,
}

impl ArkErrorParser {
    fn new() -> Self {
        Self {
            pending: None,
            last: String::new(),
        }
    }

    /// 收口当前块；去重后返回待上报的事件载荷。
    fn flush(&mut self) -> Option<(String, Vec<String>)> {
        if let Some((msg, stack)) = self.pending.take() {
            if !msg.is_empty() && msg != self.last {
                self.last = msg.clone();
                return Some((msg, stack));
            }
        }
        None
    }

    /// 喂入一行日志；若该行触发了一个完整异常块收口，返回事件载荷。
    fn feed(&mut self, line: &str) -> Option<(String, Vec<String>)> {
        if let Some(idx) = line.find(ARK_MARK) {
            let body = line[idx + ARK_MARK.len()..].trim();
            if let Some(frame) = body.strip_prefix("at ") {
                if let Some((_, stack)) = self.pending.as_mut() {
                    if stack.len() < 30 {
                        stack.push(frame.trim().to_string());
                    }
                }
                None
            } else if body.contains("Error:") {
                // 新的未捕获异常头 → 先刷旧块，再开新块
                let flushed = self.flush();
                self.pending = Some((body.to_string(), Vec::new()));
                flushed
            } else {
                // 其它 [ArkRuntime Log] 行忽略
                None
            }
        } else {
            // 非 ArkRuntime 行 → 当前错误块结束
            self.flush()
        }
    }
}

/// tail Simulator 日志文件，解析未捕获 ArkRuntime 异常，
/// 合成 `{type:"appError", message, stack}` 事件经命令通道广播给 UI。
/// 让应用 onCreate 等抛异常时 UI 有明确提示，而非静默白屏 + 空组件树。
async fn tail_app_errors(
    sim_log: std::path::PathBuf,
    cmd: Arc<CommandBridge>,
    shutdown: watch::Receiver<bool>,
) {
    fn report(payload: Option<(String, Vec<String>)>, cmd: &CommandBridge) {
        if let Some((msg, stack)) = payload {
            println!("[session] 应用未捕获异常: {msg}");
            cmd.emit(serde_json::json!({ "type": "appError", "message": msg, "stack": stack }));
        }
    }

    // host 已 File::create 该日志；偶有竞态则短重试。
    let mut reader = None;
    for _ in 0..25 {
        if let Ok(f) = tokio::fs::File::open(&sim_log).await {
            reader = Some(tokio::io::BufReader::new(f));
            break;
        }
        if *shutdown.borrow() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let mut reader = match reader {
        Some(r) => r,
        None => return,
    };

    let mut parser = ArkErrorParser::new();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                report(parser.flush(), &cmd);
                if *shutdown.borrow() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            }
            Ok(_) => report(parser.feed(&line), &cmd),
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ArkErrorParser;

    /// 取自真实 Simulator 崩溃日志（MyApplication sample，EntryAbility.onCreate 抛 TypeError）。
    /// 运行时会把同一异常打印两遍（CallForNapi + Pending exception），中间穿插窗口/Simulator 行。
    const REAL_LOG: &str = "\
06-11 19:17:49.674 E C03f00/ArkCompiler: [debugger] JSPtHooks: Exception
06-11 19:17:49.674 E C03f00/ArkCompiler: [ArkRuntime Log] TypeError: Cannot read property shareIntent of undefined
06-11 19:17:49.674 E C03f00/ArkCompiler: [ArkRuntime Log]     at initShareIntent (phone|@ohos/abilitycommon|1.0.0|src/main/ets/abilityhelper/BaseAbilityHelper.ts:111:23)
06-11 19:17:49.674 E C03f00/ArkCompiler: [ArkRuntime Log]     at doOnCreate (phone|@ohos/abilitycommon|1.0.0|src/main/ets/abilityhelper/BaseAbilityHelper.ts:34:14)
06-11 19:17:49.674 E C03f00/ArkCompiler: [ArkRuntime Log]     at onCreate (phone|phone|1.0.0|src/main/ets/entryability/EntryAbility.ts:13:32)
06-11 19:17:49.674 E C01304/Simulator: [simulator259]napi call function failed
06-11 19:17:49.675 D C04200/WindowScene: Init: WindowScene with window session!
06-11 19:17:49.675 E C03f00/ArkCompiler: [ArkRuntime Log] TypeError: Cannot read property shareIntent of undefined
06-11 19:17:49.675 E C03f00/ArkCompiler: [ArkRuntime Log]     at initShareIntent (phone|@ohos/abilitycommon|1.0.0|src/main/ets/abilityhelper/BaseAbilityHelper.ts:111:23)
06-11 19:17:49.675 E C03f00/ArkCompiler: [ArkRuntime Log]     at onCreate (phone|phone|1.0.0|src/main/ets/entryability/EntryAbility.ts:13:32)
06-11 19:17:49.675 D C01304/Simulator: [js_runtime128]LoadSystemModule\n";

    fn drain<'a>(lines: impl IntoIterator<Item = &'a str>) -> Vec<(String, Vec<String>)> {
        let mut p = ArkErrorParser::new();
        let mut out = Vec::new();
        for l in lines {
            if let Some(ev) = p.feed(l) {
                out.push(ev);
            }
        }
        if let Some(ev) = p.flush() {
            out.push(ev);
        }
        out
    }

    #[test]
    fn parses_real_crash_with_stack_and_dedups_repeat() {
        let events = drain(REAL_LOG.lines());
        // 同一异常打印两遍 → 去重后只上报一次
        assert_eq!(events.len(), 1, "重复异常应被去重，实际 {events:?}");
        let (msg, stack) = &events[0];
        assert_eq!(
            msg,
            "TypeError: Cannot read property shareIntent of undefined"
        );
        assert_eq!(stack.len(), 3, "应抓到 3 帧栈，实际 {stack:?}");
        assert!(stack[0].starts_with("initShareIntent "));
        assert!(stack[2].starts_with("onCreate "));
        // 栈帧保留源码定位（.ts:line:col），供 UI 展示
        assert!(stack[2].contains("EntryAbility.ts:13:32"));
    }

    #[test]
    fn two_distinct_errors_both_reported() {
        let events = drain([
            "x [ArkRuntime Log] TypeError: first boom",
            "x [ArkRuntime Log]     at a (m|m|1.0.0|src/A.ts:1:1)",
            "x C01304/Simulator: unrelated",
            "x [ArkRuntime Log] RangeError: second boom",
            "x [ArkRuntime Log]     at b (m|m|1.0.0|src/B.ts:2:2)",
        ]);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "TypeError: first boom");
        assert_eq!(events[1].0, "RangeError: second boom");
    }

    #[test]
    fn non_error_ark_lines_emit_nothing() {
        let events = drain([
            "x [ArkRuntime Log] some informational line",
            "x C04200/WindowImpl: WindowImpl constructorCnt: 1",
        ]);
        assert!(events.is_empty());
    }
}
