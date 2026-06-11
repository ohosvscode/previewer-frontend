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
    // 用**实际**绑定地址（而非输入串）：支持 `--bind 127.0.0.1:0` 让 OS 动态分配，
    // 调用方（如 VSCode 扩展）可解析此行拿到真实端口再连 /ws。
    let actual = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| bind_addr.to_string());
    // 安全提示：UI gateway 无鉴权，非回环地址会把预览与命令上行暴露给网络（finding #21）
    if let Ok(addr) = listener.local_addr() {
        if !addr.ip().is_loopback() {
            eprintln!(
                "[gateway] ⚠️ 警告：绑定到非回环地址 {addr}，UI 无鉴权，任何可达此地址的客户端都能预览并注入命令。建议仅用 127.0.0.1。"
            );
        }
    }
    println!(
        "[gateway] UI 服务: http://{}  （静态目录 {}）",
        actual,
        ui_dir.display()
    );
    println!("[gateway] 浏览器打开 http://{actual} 即可预览");
    axum::serve(listener, app)
        .await
        .context("axum serve 失败")?;
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
    let mut shutdown = session.subscribe_shutdown();

    // 握手：先告知设备类型/分辨率，UI 据此自适应（lite/rich 命令集不同）
    if let Ok(hello) = serde_json::to_string(&session.hello()) {
        if socket.send(Message::Text(hello.into())).await.is_err() {
            return;
        }
    }

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
            // 读取客户端上行（M2 交互/控制）
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(txt))) => {
                    if let Err(e) = handle_uplink(&txt, &session).await {
                        eprintln!("[gateway] 处理上行失败: {e}");
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
            // Simulator 退出 → 通知 UI 并关闭（避免冻屏无提示，finding #2）
            r = shutdown.changed() => {
                if r.is_err() || *shutdown.borrow() {
                    let _ = socket
                        .send(Message::Text(
                            serde_json::json!({"type":"simulatorExited"}).to_string().into(),
                        ))
                        .await;
                    break;
                }
            },
        }
    }
    println!("[gateway] UI 客户端断开");
}

/// UI 上行消息（文本 JSON）→ 翻译成命令通道请求下发。
///
/// UI 约定：`{"type":"command","command":"<name>","cmdType":"set|get|action","args":{...}}`
async fn handle_uplink(txt: &str, session: &Arc<Session>) -> anyhow::Result<()> {
    let v: serde_json::Value = serde_json::from_str(txt)?;
    match v.get("type").and_then(|x| x.as_str()) {
        Some("command") => {
            let command = v
                .get("command")
                .and_then(|x| x.as_str())
                .ok_or_else(|| anyhow::anyhow!("缺 command"))?;
            let cmd_type = v.get("cmdType").and_then(|x| x.as_str()).unwrap_or("set");
            let args = v.get("args").cloned().unwrap_or(serde_json::json!({}));
            let envelope = crate::core::build_command(command, cmd_type, args);
            session.send_command(&envelope).await?;
        }
        other => {
            eprintln!("[gateway] 未知上行 type: {other:?}");
        }
    }
    Ok(())
}
