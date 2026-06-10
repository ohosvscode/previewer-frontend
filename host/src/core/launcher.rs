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
    pub device: String, // "liteWearable" | "phone" | ...
    pub bundle: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub shape: String, // "circle" | "rect"
    pub sim_log: PathBuf,
    // rich（Stage 模型）专属，可选
    pub project_model: String,           // "FA" | "Stage"
    pub app_resource_path: Option<PathBuf>, // -arp
    pub pages: Option<PathBuf>,          // -pages（router 配置文件）
    // 调试模式（rich/Stage）：与 arkts-dap / VSCode 共用同一 Previewer 进程
    pub debug: bool,
    pub cdp_port: u16,                   // -p：CDP 调试端口（供 arkts-dap attach）
    pub debug_module: String,            // abp 用：module 名（如 "entry"）
    pub debug_ability: String,           // -abn / abp 用：ability 名（如 "EntryAbility"）
    pub loader_json: Option<PathBuf>,    // -ljPath：旁加载 pkgContextInfo.json（ohmurl 解析必需）
}

impl LaunchConfig {
    /// 是否轻量设备（命令集按 lite/rich 分流，见 protocol.md §3.5）。
    pub fn is_lite(&self) -> bool {
        matches!(self.device.as_str(), "liteWearable" | "smartVision")
    }
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
        // 固定宽度拼接，避免 pid/port 边界歧义造成跨会话碰撞（finding #26）；保持 [a-fA-F0-9]
        let sid = format!("{:08x}{:08x}", pid, ws_port);
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

    let app_str = cfg
        .app
        .to_str()
        .ok_or_else(|| anyhow!("应用目录路径非 UTF-8: {}", cfg.app.display()))?;

    let log = std::fs::File::create(&cfg.sim_log)
        .with_context(|| format!("创建日志失败: {}", cfg.sim_log.display()))?;
    let log_err = log.try_clone()?;
    let (w, h) = (cfg.width.to_string(), cfg.height.to_string());

    let port = ep.ws_port.to_string();
    let mut cmd = Command::new(&cfg.sim);
    cmd.current_dir(bin_dir).args([
        "-device", &cfg.device,
        "-shape", &cfg.shape,
        "-or", &w, &h,
        "-cr", &w, &h,
        "-j", app_str,
        "-n", &cfg.bundle,
        "-url", &cfg.url,
        "-s", &ep.base,
        "-lws", &port,
        "-sid", &ep.sid,
    ]);

    // rich（Stage/FA 非 lite）专属参数
    let cdp = cfg.cdp_port.to_string();
    let abp = format!(
        "@normalized:N&&&{}/src/main/ets/entryability/{}&",
        cfg.debug_module, cfg.debug_ability
    );
    if !cfg.is_lite() {
        cmd.args(["-pm", &cfg.project_model, "-projectID", "ohprev"]);
        if let Some(arp) = &cfg.app_resource_path {
            if let Some(s) = arp.to_str() {
                cmd.args(["-arp", s]);
            }
        }
        if let Some(pages) = &cfg.pages {
            if let Some(s) = pages.to_str() {
                cmd.args(["-pages", s]);
            }
        }
        // -ljPath 旁加载 pkgContextInfo.json：多模块工程的跨模块 ohmurl 解析必需（非仅调试）。
        if let Some(lj) = &cfg.loader_json {
            if let Some(s) = lj.to_str() {
                cmd.args(["-ljPath", s]);
            }
        }
        // 调试模式：与 arkts-dap/VSCode 共用同一 Previewer。运行时启动即阻塞等调试器 attach。
        // 归一化 ohmurl 入口见 arkts-dap/scripts/run-debug-target.sh（已实测命中断点）。
        if cfg.debug {
            cmd.args(["-d", "-p", &cdp, "-abn", &cfg.debug_ability, "-abp", &abp]);
        }
    }

    let child = cmd
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .kill_on_drop(true)
        .spawn()
        .context("spawn Simulator 失败")?;
    Ok(child)
}
