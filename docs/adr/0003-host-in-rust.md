# ADR 0003 — Host 用 Rust，编译为单一静态二进制

- 状态：已接受
- 日期：2026-06-06
- 关联：[ADR 0001](0001-two-component-host-ui-split.md)、[ADR 0002](0002-portable-transport-and-gateway.md)、[architecture §2/§5](../architecture.md)

## 背景

Host 需 spawn `Simulator`、说原生 domain socket / 命名管道、收二进制帧并桥接给 UI。
ADR 0001/0002 原假设 Host 用 Node/TS。但项目核心目标是「易移植、易分发」，Node 方案有硬伤：
依赖 Node 运行时（版本、`npm install`、体积），分发到 SDK / 各 webview 宿主时是持续摩擦。

## 决策

**Host 改用 Rust，编译为单一静态二进制 `previewer-host`，零运行时依赖。**

- 各宿主以**子进程**方式拉起该二进制（Tauri 下可直接作后端 / sidecar）。
- Host 只暴露**一个 WsGateway**（本地 WS + 静态托管）。沙箱宿主（VSCode remote/web）
  需要的 postMessage 桥，改为宿主侧一个**极薄的 relay shim**（VSCode 用 TS），不进 Rust core。

## 理由

- **零运行时依赖**：单文件可执行，直接随 SDK / 插件分发，无需装 Node。直接服务移植/分发目标。
- **Tauri 协同**：独立 webview 目标用 Tauri 时后端本就是 Rust，Host 可原生复用。
- **任务契合**：帧中继（二进制头解析 + JPEG 字节透传，无需解码）+ 双 socket 桥接 + 并发，
  正是 Rust + tokio 的强项；内存/性能可控。
- **交叉编译**：各平台静态二进制产出简单。

## 取舍

- **Node 宿主无法进程内 import Rust** → 改为 spawn 子进程。代价极小（单二进制无依赖），
  反而比「import 库」分发更干净。ADR 0002 的「进程内 EmbedGateway」随之废弃，
  收敛为「单一 WsGateway + 外置 relay shim」。
- **开发门槛**：Rust 高于 TS。但 Host 逻辑边界清晰（spawn + 2 socket + 1 ws server + 转发），
  复杂度可控，值得换取分发收益。
- **VSCode remote/web** 仍需一段 TS（relay shim）；这是宿主沙箱的固有约束，与语言选择无关，
  shim 很薄。

## 选型（建议）

| 关注点 | crate |
|--------|-------|
| 异步运行时 | `tokio` |
| WebSocket（图像通道 client + UIGateway server） | `tokio-tungstenite` |
| 跨平台 local socket / 命名管道（命令通道 server） | `interprocess`（`local_socket`） |
| JSON 编解码 | `serde` / `serde_json` |
| WS + 静态托管 | `axum` + `tower-http`（或精简自写） |
| 子进程管理 | `tokio::process` |
| CLI 参数 | `clap` |

JPEG 不在 Host 解码（纯字节透传给 UI），无需图像库。

## 影响

- 目录：`host/` 改为 Cargo 工程（`Cargo.toml` + `src/*.rs`）；`integrations/vscode/` 为 TS relay shim。
- M0 协议探针改用 Rust（或先用任意脚本验证协议、再用 Rust 固化）。
- roadmap M1 的 gateway 仅 `WsGateway`；M5 VSCode 改为「spawn 二进制 + TS relay shim」。
- UI 侧不受影响：仍只依赖 `PreviewTransport`，ADR 0002 的 Transport 抽象完全保留。
