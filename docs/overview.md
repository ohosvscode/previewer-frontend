# 概述：目标与范围

## 1. 问题

OpenHarmony SDK 自带的 `Simulator`（如
`~/Library/OpenHarmony/Sdk/<ver>/previewer/liteWearable/bin/Simulator`）是**开源**的
（源码在 `ide/tools/previewer`，构建目标 `lite_previewer`，`output_name = "Simulator"`）。
它内置 ACELite（轻量级 ArkUI）引擎，能加载并渲染 JS 应用，把画面以二进制帧推出，
并接受交互/设备状态命令。

但是把这个后端「用起来」的前端——画面显示、设备外观、交互采集、设备状态面板、Inspector——
是 DevEco Studio 里**未开源**的部分。脱离 DevEco 就无法使用 previewer。

## 2. 目标

提供一套**开源前端**，在不修改 `Simulator` 的前提下完整驱动它，使得：

- 可在浏览器 / 独立窗口中实时预览 OpenHarmony 应用，不依赖 DevEco Studio。
- 协议层与 DevEco 一致，因此能直接复用 SDK 中现成的 `Simulator` 二进制。
- **UI 有 webview 即可移植**：同一份纯 Web 产物复用于浏览器、独立 webview
  （Electron/Tauri/pywebview）与 VSCode webview，移植成本收敛到一个 Transport 接缝
  （见 [`architecture.md` §5](architecture.md)、[`adr/0002`](adr/0002-portable-transport-and-gateway.md)）。
- 架构清晰、可测试、可逐设备形态扩展。

## 3. 范围

### 3.1 In scope（先做）

- **liteWearable 形态**（圆/方表盘）的完整预览闭环：启动、收帧渲染、交互注入、设备传感器面板。
- Preview Host（**Rust 单一静态二进制**，core + WsGateway）与 Preview UI（纯 Web + Transport 抽象）两个组件。
- 与 `Simulator` 的两条通道：命令通道（LocalSocket/JSON）与图像通道（WebSocket/二进制帧）。
- UI↔Host 的 `WebSocketTransport`（默认）+ 浏览器宿主闭环；为其他 webview 宿主预留 Transport 接缝。

### 3.2 Later（后续）

- **VSCode webview 嵌入**（`VsCodeTransport` + spawn Host 二进制 + TS relay shim，见 roadmap M5）。
- 其他独立 webview 宿主：Electron / Tauri sidecar / pywebview 打包。
- rich 形态（phone / tablet / tv / car，对应 `rich_previewer` 即 `Previewer` 二进制）。
- 组件 Inspector（`inspector` 命令返回的组件树）与画面高亮联动。
- 折叠屏、多分辨率切换、深浅色、国际化等高级特性。
- 热重载 / Fast Preview（`FastPreviewMsg` / `ReloadRuntimePage`）。

### 3.3 Out of scope（不做）

- 不修改、不重新编译 `Simulator` 后端（仅作为黑盒驱动）。
- 不复刻 DevEco 的工程构建链（hvigor）；JS 产物路径作为输入由使用者提供。
- 不逆向、不重分发任何 DevEco Studio 的闭源二进制 / 资源。仅以**可观测的协议行为**为依据复刻。

## 4. 名词

| 名词 | 含义 |
|------|------|
| Simulator / 后端 | 开源的 previewer 可执行文件，宿主 ACELite 引擎 |
| Preview Host / Host | 本项目的编排器，spawn Simulator 并桥接两条通道（替代 `index.js`） |
| Preview UI / UI | 本项目的 Web 前端（替代 `ohpreviewer`） |
| 命令通道 | LocalSocket（Unix domain socket / Windows 命名管道），传 JSON 命令 |
| 图像通道 | WebSocket，Simulator 侧 libwebsockets 服务，传二进制画面帧 |
| liteWearable | 轻量级可穿戴设备形态，由 `lite_previewer`（ACELite）渲染 |
