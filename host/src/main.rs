//! previewer-host —— 入口：启动预览会话 + WsGateway。
//! M1：浏览器打开 gateway 地址即可看到 liteWearable 实时画面。
//! 见 ../docs/architecture.md、../docs/roadmap.md。

mod core;
mod gateway;

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

use crate::core::{LaunchConfig, Session};

#[derive(Parser, Debug)]
#[command(about = "OpenHarmony previewer 开源前端 Host（驱动开源 Simulator）")]
struct Args {
    /// Simulator 可执行文件路径
    #[arg(
        long,
        default_value = "/Users/sanchuan/Library/OpenHarmony/Sdk/23/previewer/liteWearable/bin/Simulator"
    )]
    sim: PathBuf,

    /// 已编译的 liteWearable 应用目录（含 app.js + pages）
    #[arg(
        long,
        default_value = "/Users/sanchuan/DevEcoStudioProjects/claude/entry/build/default/intermediates/loader_out_lite/default/js/MainAbility"
    )]
    app: PathBuf,

    /// UI 静态资源目录（vanilla UI 产物）
    #[arg(long, default_value = "../ui")]
    ui: PathBuf,

    /// UI gateway 监听地址
    #[arg(long, default_value = "127.0.0.1:9000")]
    bind: String,

    #[arg(long, default_value = "liteWearable")]
    device: String,
    #[arg(long, default_value = "pages/index/index")]
    url: String,
    #[arg(long, default_value = "com.example.claude")]
    bundle: String,
    #[arg(long, default_value_t = 466)]
    width: u32,
    #[arg(long, default_value_t = 466)]
    height: u32,
    #[arg(long, default_value = "circle")]
    shape: String,
    #[arg(long, default_value = "/tmp/ohprev_sim.log")]
    sim_log: PathBuf,

    // rich（Stage 模型）专属
    #[arg(long, default_value = "FA")]
    project_model: String,
    /// -arp 应用资源目录（rich Stage 需要）
    #[arg(long)]
    arp: Option<PathBuf>,
    /// -pages router 配置文件路径（rich Stage 需要）
    #[arg(long)]
    pages: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    let cfg = LaunchConfig {
        sim: args.sim,
        app: args.app,
        device: args.device,
        bundle: args.bundle,
        url: args.url,
        width: args.width,
        height: args.height,
        shape: args.shape,
        sim_log: args.sim_log,
        project_model: args.project_model,
        app_resource_path: args.arp,
        pages: args.pages,
    };

    let session = Session::start(cfg).await?;
    let mut shutdown = session.subscribe_shutdown();

    // Simulator 退出 → Host 随之优雅关闭（单会话工具；自动重启见 roadmap backlog）
    tokio::select! {
        r = gateway::ws::serve(session.clone(), args.ui, &args.bind) => r?,
        _ = shutdown.changed() => {
            eprintln!("[host] Simulator 已退出，Host 关闭。");
        }
    }
    Ok(())
}
