//! CommandBridge —— 命令通道（Host 是 server）。
//! 建 Unix domain socket，等 Simulator connect；收发 NUL 分隔的 JSON。
//! 见 ../../docs/protocol.md §3。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixListener;
use tokio::sync::{broadcast, Mutex};
use tokio::time::timeout;

/// 来自 Simulator 的上报消息（已解析 JSON）。
pub type Event = serde_json::Value;

/// 命令通道桥：持有写半边用于下发命令，广播上行事件。
pub struct CommandBridge {
    writer: Mutex<OwnedWriteHalf>,
    events: broadcast::Sender<Event>,
}

impl CommandBridge {
    /// 在 cmd_pipe 上 listen 并等待 Simulator 连接（必须在 spawn Simulator 之前调用 bind）。
    /// 返回桥实例；内部 spawn 一个读任务持续解析上行事件。
    pub async fn listen_and_accept(listener: UnixListener) -> Result<Arc<Self>> {
        let (stream, _) = timeout(Duration::from_secs(8), listener.accept())
            .await
            .map_err(|_| anyhow!("命令通道 8s 内无连接（Simulator 未连）"))?
            .context("accept 命令通道失败")?;

        let (mut read_half, write_half) = stream.into_split();
        let (events, _) = broadcast::channel(64);
        let bridge = Arc::new(Self {
            writer: Mutex::new(write_half),
            events: events.clone(),
        });

        // 读任务：NUL 分隔，逐条解析为 JSON 并广播。
        const MAX_ACC: usize = 4 * 1024 * 1024; // 单条消息上限，防内存 DoS（finding #19）
        tokio::spawn(async move {
            let mut acc: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match read_half.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(n) => {
                        acc.extend_from_slice(&chunk[..n]);
                        if acc.len() > MAX_ACC && !acc.contains(&0) {
                            eprintln!("[cmd] 累积消息超 {MAX_ACC} 字节仍无终止符，断开");
                            break;
                        }
                        while let Some(pos) = acc.iter().position(|&b| b == 0) {
                            let msg: Vec<u8> = acc.drain(..=pos).collect();
                            let text = String::from_utf8_lossy(&msg[..msg.len() - 1]);
                            let text = text.trim();
                            if text.is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Event>(text) {
                                Ok(v) => {
                                    let _ = events.send(v);
                                }
                                Err(e) => eprintln!("[cmd] JSON 解析失败: {e}: {text}"),
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[cmd] 读取错误: {e}");
                        break;
                    }
                }
            }
        });

        Ok(bridge)
    }

    /// 订阅上行事件。
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// 下发一条命令（JSON 文本 + 单个 NUL 结尾）。M2 交互用。
    pub async fn send(&self, json: &serde_json::Value) -> Result<()> {
        let mut buf = serde_json::to_vec(json)?;
        buf.push(0);
        let mut w = self.writer.lock().await;
        w.write_all(&buf).await.context("写命令通道失败")?;
        w.flush().await?;
        Ok(())
    }
}
