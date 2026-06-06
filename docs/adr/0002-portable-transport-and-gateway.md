# ADR 0002 — 可移植性：UI Transport 抽象 + Host core/gateway 拆分

- 状态：已接受
- 日期：2026-06-06
- 关联：[ADR 0001](0001-two-component-host-ui-split.md)、[architecture §5](../architecture.md)

## 背景

目标：UI「只要有 webview 就易移植」——同一份 UI 跑在 VSCode webview、独立 webview
（Electron/Tauri/pywebview）、普通浏览器。

约束：
- Host 必须 spawn `Simulator` 并说原生 domain socket / 命名管道 → **不能跑在浏览器**，
  只能在有 Node 的宿主里（独立进程 / 扩展宿主 / Electron 主进程 / Tauri sidecar）。
- 不同 webview 宿主「UI 够到 Host」的方式不同：
  - 浏览器 / 独立 webview：可直接开 `ws://127.0.0.1:port`。
  - VSCode webview：沙箱 + CSP，且 remote/Codespaces/web 场景下 webview 与扩展宿主不同上下文，
    localhost ws 不可靠；官方且健壮的通道是 `acquireVsCodeApi().postMessage`。

## 决策

1. **UI 侧引入 `PreviewTransport` 接口**作为唯一移植接缝。UI 业务模块只依赖该接口，
   不直接 `new WebSocket`、不碰宿主 API。提供三实现：`WebSocketTransport`（默认/通用）、
   `VsCodeTransport`（postMessage）、`PostMessageTransport`（通用 iframe）。启动时 `detect()` 自动选。
2. **Host 侧拆 core / gateway**。core（Launcher/CommandBridge/FrameRelay/Session）运行时无关，
   只暴露 `onFrame/onEvent/postControl`。gateway 可插拔：`WsGateway`（WS server + 静态托管）与
   `EmbedGateway`（进程内回调，供宿主接到自己的 IPC，如 VSCode postMessage）。
3. **WebSocket 为默认与通用路径**，postMessage 仅用于 VSCode 这类沙箱宿主。

## 理由

- 移植成本被压到「实现/选择一个 Transport + 配一个 gateway」，UI 与 core 零改动。
- 三种宿主复用同一 UI 静态产物，符合「有 webview 即可移植」目标。
- core 运行时无关 → 既能作独立进程，也能被扩展宿主 / Electron / Tauri 直接 import。

## 取舍

- 维护多个 Transport/gateway 实现有成本；但每个都很薄（仅收发与序列化），且彼此隔离。
- 也考虑过「一律用 localhost ws，连 VSCode 也走 ws」：被否决——remote/web 场景不可靠，
  且 CSP 配置脆弱。保留 ws 为默认、postMessage 为沙箱兜底，最稳。
- Host↔UI 内部消息格式自定义（jpeg bytes + meta-json / JSON 控制），不照搬 Simulator 字节协议，
  以便在 ws 与 postMessage 两种传输上一致序列化（postMessage 走结构化克隆，Uint8Array 可直传）。

## 影响

- 目录：`ui/src/transport/`（接口 + 实现 + detect）；`host/src/core/` 与 `host/src/gateways/`；
  VSCode 集成放 `host/integrations/vscode/`（薄扩展，用 core + EmbedGateway 桥 postMessage）。
- roadmap：M1 落 `WebSocketTransport` + `WsGateway`（浏览器闭环）；VSCode adapter 作为独立里程碑（M5）。
- 性能：postMessage 每帧结构化克隆一次 jpeg（liteWearable 466² 约数十 KB @ ~25fps），可接受；
  必要时后续可在 VSCode 下改用 ws + 宽松 CSP 优化，但不作为默认。
