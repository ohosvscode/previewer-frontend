//! Launcher —— 分配端点、拼 CLI、spawn 并监控 Simulator。
//! 见 ../../docs/protocol.md §1.1 / §2。

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::{Child, Command};

/// 一次预览会话的运行参数。
#[derive(Clone, Debug)]
pub struct LaunchConfig {
    pub sim: PathBuf,
    pub app: PathBuf,
    pub bundle: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub shape: String, // "circle" | "rect"
    pub sim_log: PathBuf,
}

/// Host 为本次会话分配的端点（命令通道基名/路径、WS 端口、sid）。
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub base: String,
    pub cmd_pipe: String,
    pub ws_port: u16,
    pub sid: String,
}

impl Endpoints {
    /// 基于 pid + 一个空闲 TCP 端口分配唯一端点。
    pub fn allocate() -> Result<Self> {
        let pid = std::process::id();
        // 借一个空闲端口给 Simulator 的 WS server 用（拿到后立即释放，spawn 前的小竞态可接受）。
        let ws_port = {
            let l = TcpListener::bind("127.0.0.1:0").context("分配空闲端口失败")?;
            l.local_addr()?.port()
        };
        let base = format!("ohprev{pid}{ws_port}");
        let sid = format!("{:x}{:x}", pid, ws_port);
        let cmd_pipe = format!("/tmp/{base}_commandPipe");
        Ok(Self { base, cmd_pipe, ws_port, sid })
    }

    pub fn sim_ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}/{}", self.ws_port, self.sid)
    }
}

/// spawn Simulator。**必须在命令通道已 listen 之后调用**，cwd 设为 bin 目录（字体）。
pub fn spawn_simulator(cfg: &LaunchConfig, ep: &Endpoints) -> Result<Child> {
    if !cfg.sim.is_file() {
        return Err(anyhow!("Simulator 不存在: {}", cfg.sim.display()));
    }
    if !cfg.app.is_dir() {
        return Err(anyhow!("应用目录不存在: {}", cfg.app.display()));
    }
    let bin_dir = cfg
        .sim
        .parent()
        .ok_or_else(|| anyhow!("无法取 Simulator 所在目录"))?;

    let log = std::fs::File::create(&cfg.sim_log)
        .with_context(|| format!("创建日志失败: {}", cfg.sim_log.display()))?;
    let log_err = log.try_clone()?;
    let (w, h) = (cfg.width.to_string(), cfg.height.to_string());

    let child = Command::new(&cfg.sim)
        .current_dir(bin_dir)
        .args([
            "-device", "liteWearable",
            "-shape", &cfg.shape,
            "-or", &w, &h,
            "-cr", &w, &h,
            "-j", cfg.app.to_str().unwrap(),
            "-n", &cfg.bundle,
            "-url", &cfg.url,
            "-s", &ep.base,
            "-lws", &ep.ws_port.to_string(),
            "-sid", &ep.sid,
        ])
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .kill_on_drop(true)
        .spawn()
        .context("spawn Simulator 失败")?;
    Ok(child)
}
