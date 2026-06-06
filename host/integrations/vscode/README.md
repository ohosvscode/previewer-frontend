# OpenHarmony Previewer —— VSCode 集成（relay shim）

证明「有 webview 即可移植」：**同一份 UI（`ui/`）与同一个 Rust 二进制（`previewer-host`）零改动**，
仅通过这层薄扩展在 VSCode webview 中跑起来。

## 工作原理

```
VSCode 扩展宿主 (Node)
├── spawn previewer-host（Rust 二进制，WsGateway @127.0.0.1:9000）
├── createWebviewPanel，加载 ui/（asWebviewUri）
└── relay：WS client(/ws) ↔ webview.postMessage
        ws 二进制帧  → {channel:"frame", bytes}
        ws 文本事件  → {channel:"event", payload}
        webview 命令 → ws.send(JSON)
```

UI 侧 `detect()` 检测到 `acquireVsCodeApi` → 选 `VsCodeTransport`（postMessage），
其余宿主用 `WebSocketTransport`。两者实现同一 `PreviewTransport` 契约，业务组件零感知。

> 为什么不让 webview 直连 localhost WS？本地 VSCode 可以，但 remote/Codespaces/web 场景
> webview 与扩展宿主不同上下文、CSP 受限，postMessage 是健壮通路（见 ADR 0002/0003）。

## 运行

```bash
# 1. 构建 host
cd host && cargo build --release

# 2. 在 VSCode 中以扩展开发宿主打开本目录（host/integrations/vscode/）
#    F5 / Run Extension，或 vsce 打包安装

# 3. 命令面板执行 “OpenHarmony: 打开预览”
```

配置项（settings）：`ohPreviewer.hostBin` / `ohPreviewer.sim` / `ohPreviewer.app` / `ohPreviewer.bind`。
留空时自动在 `host/target/{release,debug}/` 找 `previewer-host`。

## 状态

代码完成；`VsCodeTransport` 的 postMessage 契约已在浏览器中隔离验证（frame→Blob、event、command 往返）。
扩展本体需在 VSCode 中运行验证。依赖：VSCode 内置 Node 22+（提供全局 `WebSocket`）；
否则在扩展内打包 `ws` 包。
