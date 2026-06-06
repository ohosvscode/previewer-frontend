//! WsGateway —— core 对外的唯一形态：本地 WebSocket server + 静态托管 UI。
//! 所有 webview 宿主都连这个 WS（沙箱宿主用外置 relay shim，见 ADR 0003）。
//! 见 ../../docs/architecture.md §5.3。

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;

use crate::core::Session;

/// 启动 UI gateway：在 bind_addr 上提供 `/ws`（帧/事件下行）+ 静态 UI 文件。
pub async fn serve(session: Arc<Session>, ui_dir: PathBuf, bind_addr: &str) -> Result<()> {
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&ui_dir))
        .with_state(session);

    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("bind UI gateway 失败: {bind_addr}"))?;
    println!(
        "[gateway] UI 服务: http://{}  （静态目录 {}）",
        bind_addr,
        ui_dir.display()
    );
    println!("[gateway] 浏览器打开 http://{bind_addr} 即可预览");
    axum::serve(listener, app).await.context("axum serve 失败")?;
    Ok(())
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(session): State<Arc<Session>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ui_client(socket, session))
}

/// 每个 UI 客户端：订阅帧流，把 JPEG 作为二进制 WS 消息转发；
/// 同时把 Simulator 上报事件作为文本 JSON 转发。
async fn handle_ui_client(mut socket: WebSocket, session: Arc<Session>) {
    println!("[gateway] UI 客户端已连接");
    let mut frames = session.subscribe_frames();
    let mut events = session.subscribe_events();

    // 连接即先发当前最新帧（若有），新客户端不必等下一次渲染
    let initial = frames.borrow_and_update().clone();
    if let Some(jpeg) = initial {
        if socket.send(Message::Binary(jpeg)).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            changed = frames.changed() => match changed {
                Ok(()) => {
                    let jpeg = frames.borrow_and_update().clone();
                    if let Some(jpeg) = jpeg {
                        if socket.send(Message::Binary(jpeg)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break, // 帧通道关闭
            },
            e = events.recv() => match e {
                Ok(v) => {
                    if let Ok(txt) = serde_json::to_string(&v) {
                        if socket.send(Message::Text(txt.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => {} // 事件通道关闭不致命，继续推帧
            },
            // 读取客户端消息（M2 交互上行）；当前仅检测断开
            msg = socket.recv() => match msg {
                Some(Ok(_)) => { /* M2: 解析控制/交互消息 → session.send_command */ }
                _ => break,
            },
        }
    }
    println!("[gateway] UI 客户端断开");
}
