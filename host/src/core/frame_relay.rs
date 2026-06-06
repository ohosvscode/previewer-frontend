//! FrameRelay —— 图像通道（Host 是 WS client）。
//! 连 Simulator 的 ws://127.0.0.1:<port>/<sid>，解析 40 字节大端帧头，
//! 把 JPEG 负载广播出去。见 ../../docs/protocol.md §4。

use std::time::Duration;

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::sync::watch;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::Message;

pub const MAGIC: u32 = 0x1234_5678;
pub const HEAD_SIZE: usize = 40;

/// 解析出的帧元信息（大端头）。
#[derive(Clone, Copy, Debug)]
pub struct FrameMeta {
    pub orig_w: i32,
    pub orig_h: i32,
    pub comp_w: i32,
    pub comp_h: i32,
    pub protocol_version: u16,
}

/// 校验并解析 40 字节大端帧头；返回 (meta, jpeg 负载起始偏移)。
pub fn parse_header(buf: &[u8]) -> Result<FrameMeta> {
    if buf.len() < HEAD_SIZE {
        return Err(anyhow!("帧长度 {} < 头 {}", buf.len(), HEAD_SIZE));
    }
    let be32 = |o: usize| i32::from_be_bytes(buf[o..o + 4].try_into().unwrap());
    let beu32 = |o: usize| u32::from_be_bytes(buf[o..o + 4].try_into().unwrap());
    let beu16 = |o: usize| u16::from_be_bytes(buf[o..o + 2].try_into().unwrap());
    if beu32(0) != MAGIC {
        return Err(anyhow!("magic 不匹配: {:#010x}", beu32(0)));
    }
    Ok(FrameMeta {
        orig_w: be32(4),
        orig_h: be32(8),
        comp_w: be32(12),
        comp_h: be32(16),
        protocol_version: beu16(20),
    })
}

/// 连接 Simulator 图像通道并持续中继。每帧把 JPEG 负载写入 frame_tx（watch，保留最新帧）。
/// 带重连：连接失败/断开后退避重试。
pub async fn run(ws_url: String, frame_tx: watch::Sender<Option<Bytes>>) {
    let mut backoff = Duration::from_millis(200);
    loop {
        match relay_once(&ws_url, &frame_tx).await {
            Ok(()) => {
                // 流正常结束（Simulator 关闭），短暂等待后重试。
                backoff = Duration::from_millis(200);
            }
            Err(e) => {
                eprintln!("[relay] {e}（{}ms 后重连 {ws_url}）", backoff.as_millis());
            }
        }
        sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(3));
    }
}

async fn relay_once(ws_url: &str, frame_tx: &watch::Sender<Option<Bytes>>) -> Result<()> {
    let (ws, _resp) = tokio_tungstenite::connect_async(ws_url).await?;
    println!("[relay] 已连 Simulator 图像通道 {ws_url}");
    let (_write, mut read) = ws.split();
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Binary(data) => match parse_header(&data) {
                Ok(_meta) => {
                    let jpeg = Bytes::copy_from_slice(&data[HEAD_SIZE..]);
                    frame_tx.send_replace(Some(jpeg)); // 保留最新帧，新 UI 客户端立即可得
                }
                Err(e) => eprintln!("[relay] 丢弃异常帧: {e}"),
            },
            Message::Close(_) => return Ok(()),
            _ => {}
        }
    }
    Ok(())
}
