//! M0 协议探针 —— 验证与开源 Simulator 后端的两条通道 + 帧格式。
//!
//! 流程（见 ../../docs/roadmap.md 的 M0）：
//!   1. 在 /tmp/<base>_commandPipe 建 Unix domain socket 的 **server**（Host 是服务端）。
//!   2. spawn Simulator（cwd = bin 目录，使其 getcwd/../config 能找到字体）。
//!   3. accept 命令通道连接，读取 NUL 分隔的 JSON（含启动信号 imageWebsocket）。
//!   4. 作为 WS **client** 连 ws://127.0.0.1:<port>/<sid>（sid 在 URL 末段路径）。
//!   5. 解析 40 字节 **大端** 帧头，校验 magic 0x12345678，剥离 JPEG 负载落盘。
//!
//! 协议依据：../../docs/protocol.md（已由源码精读 + 对抗复核确认）。

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncReadExt;
use tokio::net::UnixListener;
use tokio::process::Command;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::Message;

const MAGIC: u32 = 0x1234_5678;
const HEAD_SIZE: usize = 40;

#[derive(Parser, Debug)]
#[command(about = "OpenHarmony previewer M0 协议探针")]
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

    /// 图像通道 WebSocket 端口
    #[arg(long, default_value_t = 18890)]
    port: u16,

    /// 首页路由
    #[arg(long, default_value = "pages/index/index")]
    url: String,

    /// bundle 名
    #[arg(long, default_value = "com.example.claude")]
    bundle: String,

    /// 帧落盘路径
    #[arg(long, default_value = "/tmp/ohprev_frame.jpg")]
    out: PathBuf,

    /// Simulator 日志落盘路径
    #[arg(long, default_value = "/tmp/ohprev_sim.log")]
    sim_log: PathBuf,
}

/// 解析后的帧头（大端）。
#[derive(Debug)]
struct FrameHeader {
    orig_w: i32,
    orig_h: i32,
    comp_w: i32,
    comp_h: i32,
    protocol_version: u16,
    region: (i16, i16, i16, i16),
}

fn parse_header(buf: &[u8]) -> Result<FrameHeader> {
    if buf.len() < HEAD_SIZE {
        return Err(anyhow!("帧长度 {} < 头 {}", buf.len(), HEAD_SIZE));
    }
    let be32 = |o: usize| i32::from_be_bytes(buf[o..o + 4].try_into().unwrap());
    let beu32 = |o: usize| u32::from_be_bytes(buf[o..o + 4].try_into().unwrap());
    let be16 = |o: usize| i16::from_be_bytes(buf[o..o + 2].try_into().unwrap());
    let beu16 = |o: usize| u16::from_be_bytes(buf[o..o + 2].try_into().unwrap());

    let magic = beu32(0);
    if magic != MAGIC {
        return Err(anyhow!(
            "magic 不匹配: 期望 {:#010x} 得到 {:#010x}",
            MAGIC,
            magic
        ));
    }
    Ok(FrameHeader {
        orig_w: be32(4),
        orig_h: be32(8),
        comp_w: be32(12),
        comp_h: be32(16),
        protocol_version: beu16(20),
        region: (be16(22), be16(24), be16(26), be16(28)),
    })
}

/// 后台读取命令通道：NUL 分隔的 JSON，逐条打印（期望含 imageWebsocket 启动信号）。
async fn pump_command_channel(listener: UnixListener) {
    let stream = match timeout(Duration::from_secs(6), listener.accept()).await {
        Ok(Ok((s, _))) => {
            println!("[cmd] ✅ Simulator 已连接命令通道（Host=server 验证通过）");
            s
        }
        Ok(Err(e)) => {
            eprintln!("[cmd] accept 失败: {e}");
            return;
        }
        Err(_) => {
            eprintln!("[cmd] ⚠️ 6s 内无连接（Simulator 未连命令通道）");
            return;
        }
    };

    let mut stream = stream;
    let mut acc: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => {
                println!("[cmd] 连接关闭");
                return;
            }
            Ok(n) => {
                acc.extend_from_slice(&chunk[..n]);
                // 按 \0 切分
                while let Some(pos) = acc.iter().position(|&b| b == 0) {
                    let msg: Vec<u8> = acc.drain(..=pos).collect();
                    let text = String::from_utf8_lossy(&msg[..msg.len() - 1]);
                    let text = text.trim();
                    if !text.is_empty() {
                        println!("[cmd] <- {text}");
                    }
                }
            }
            Err(e) => {
                eprintln!("[cmd] 读取错误: {e}");
                return;
            }
        }
    }
}

/// 尝试连 WS 并在 wait 时间内抓一帧；成功返回完整帧字节。
async fn try_capture(url: &str, wait: Duration) -> Result<Vec<u8>> {
    let (ws, resp) = tokio_tungstenite::connect_async(url)
        .await
        .with_context(|| format!("连 WS 失败: {url}"))?;
    println!("[ws] ✅ 握手成功 (HTTP {})", resp.status());
    let (mut write, mut read) = ws.split();

    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remain.is_zero() {
            let _ = write.send(Message::Close(None)).await;
            return Err(anyhow!("等待超时，未收到二进制帧"));
        }
        match timeout(remain, read.next()).await {
            Ok(Some(Ok(Message::Binary(data)))) => {
                let bytes = data.to_vec();
                println!("[ws] <- 二进制 {} 字节", bytes.len());
                let _ = write.send(Message::Close(None)).await;
                return Ok(bytes);
            }
            Ok(Some(Ok(other))) => {
                println!("[ws] <- 非二进制消息: {other:?}");
            }
            Ok(Some(Err(e))) => return Err(anyhow!("WS 错误: {e}")),
            Ok(None) => return Err(anyhow!("WS 流结束")),
            Err(_) => { /* loop 顶部会判定超时 */ }
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // 校验输入
    if !args.sim.is_file() {
        return Err(anyhow!("Simulator 不存在: {}", args.sim.display()));
    }
    if !args.app.is_dir() {
        return Err(anyhow!("应用目录不存在: {}", args.app.display()));
    }
    let bin_dir = args
        .sim
        .parent()
        .ok_or_else(|| anyhow!("无法取 Simulator 所在目录"))?
        .to_path_buf();

    // 唯一基名 + 十六进制 sid（^[a-fA-F0-9]+$）
    let pid = std::process::id();
    let base = format!("ohprobe{pid}");
    let sid = format!("{:x}{:x}", pid, 0x5f3a9c_u32);
    let cmd_pipe = format!("/tmp/{base}_commandPipe");

    println!("=== M0 协议探针 ===");
    println!("  Simulator : {}", args.sim.display());
    println!("  cwd       : {}", bin_dir.display());
    println!("  app(-j)   : {}", args.app.display());
    println!("  -s base   : {base}  => 命令通道 {cmd_pipe}");
    println!("  -lws port : {}", args.port);
    println!("  -sid      : {sid}");
    println!("  WS URL    : ws://127.0.0.1:{}/{sid}", args.port);
    println!();

    // 1. 先建命令通道 server（必须在 spawn 之前）
    let _ = std::fs::remove_file(&cmd_pipe);
    let listener =
        UnixListener::bind(&cmd_pipe).with_context(|| format!("bind 命令通道失败: {cmd_pipe}"))?;
    let cmd_task = tokio::spawn(pump_command_channel(listener));

    // 2. spawn Simulator
    let log = std::fs::File::create(&args.sim_log)
        .with_context(|| format!("创建日志失败: {}", args.sim_log.display()))?;
    let log_err = log.try_clone()?;
    let mut child = Command::new(&args.sim)
        .current_dir(&bin_dir)
        .args([
            "-device",
            "liteWearable",
            "-shape",
            "circle",
            "-or",
            "466",
            "466",
            "-cr",
            "466",
            "466",
            "-j",
            args.app.to_str().unwrap(),
            "-n",
            &args.bundle,
            "-url",
            &args.url,
            "-s",
            &base,
            "-lws",
            &args.port.to_string(),
            "-sid",
            &sid,
        ])
        .stdout(log)
        .stderr(log_err)
        .spawn()
        .context("spawn Simulator 失败")?;
    println!(
        "[sim] 已启动 pid={:?}（日志 {}）",
        child.id(),
        args.sim_log.display()
    );

    // 3. 抓帧：首连等 2.5s；失败则重连（触发缓存首帧补发）
    let url = format!("ws://127.0.0.1:{}/{sid}", args.port);
    sleep(Duration::from_millis(600)).await; // 给 WS server 起来的时间

    let mut frame: Option<Vec<u8>> = None;
    for attempt in 1..=4 {
        println!("[ws] 第 {attempt} 次尝试连接 {url}");
        match try_capture(&url, Duration::from_millis(2500)).await {
            Ok(f) => {
                frame = Some(f);
                break;
            }
            Err(e) => {
                println!("[ws] 尝试 {attempt} 失败: {e}（将重连）");
                sleep(Duration::from_millis(400)).await;
            }
        }
    }

    // 4. 校验 + 落盘
    let result = match frame {
        Some(buf) => match parse_header(&buf) {
            Ok(h) => {
                println!("\n✅ 收到帧并解析成功：");
                println!("  原始分辨率 : {}x{}", h.orig_w, h.orig_h);
                println!("  压缩分辨率 : {}x{}（= JPEG 尺寸）", h.comp_w, h.comp_h);
                println!("  protocolVer: {}（2=LOADNORMAL/JPEG）", h.protocol_version);
                println!("  region     : {:?}", h.region);
                let payload = &buf[HEAD_SIZE..];
                let is_jpeg = payload.len() >= 3 && payload[0] == 0xFF && payload[1] == 0xD8;
                println!("  负载 {} 字节，JPEG SOI(FFD8): {}", payload.len(), is_jpeg);
                std::fs::write(&args.out, payload)
                    .with_context(|| format!("写帧失败: {}", args.out.display()))?;
                println!("  已落盘: {}", args.out.display());
                if is_jpeg {
                    Ok(())
                } else {
                    Err(anyhow!("负载不是 JPEG"))
                }
            }
            Err(e) => Err(anyhow!("帧头解析失败: {e}")),
        },
        None => Err(anyhow!("未能抓到任何帧")),
    };

    // 5. 清理
    let _ = child.start_kill();
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
    let _ = std::fs::remove_file(&cmd_pipe);
    cmd_task.abort();

    match &result {
        Ok(()) => println!("\n🎉 M0 探针成功：两条通道 + 帧格式 + sid 全部验证通过。"),
        Err(e) => {
            eprintln!("\n❌ M0 探针失败: {e}");
            eprintln!("   查看 Simulator 日志: {}", args.sim_log.display());
        }
    }
    result
}
