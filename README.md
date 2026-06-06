# previewer-frontend

OpenHarmony Previewer 的**开源前端**实现。

驱动 SDK 内开源的 `Simulator` 后端（`ide/tools/previewer` 构建出的 `lite_previewer` / `rich_previewer`），
复刻 DevEco Studio 中**未开源**的 previewer 前端（`openharmony-preview-server` 的 `index.js` + `ohpreviewer` Web UI）。

## 背景

DevEco Studio 的预览能力分三层，其中**只有最底层是开源的**：

```
DevEco IDE (内嵌 WebView)
  └─ [闭源] ohpreviewer        React Web UI（画面 + 控制面板 + Inspector）
       └─ [闭源] index.js      preview-server：进程编排 + 协议网关
            └─ [开源] Simulator  ide/tools/previewer 编译产物（ACELite 引擎宿主）
```

本项目实现上面两层（开源替代），与未改动的 `Simulator` 通过其已暴露的固定协议对接。
协议规格见 [`docs/protocol.md`](docs/protocol.md)，逆向依据见 [`docs/reverse-engineering.md`](docs/reverse-engineering.md)。

## 设计目标：有 webview 即可移植

UI 是一份**纯静态 Web 产物**，目标是在任意 webview 宿主复用同一份代码：

- **浏览器** / **独立 webview**（Electron / Tauri / pywebview）→ 走 WebSocket（默认）
- **VSCode webview** → 走 `postMessage` 桥（绕过沙箱/CSP，remote/web 也可用）

移植成本被压在一个接缝上：UI 侧的 `PreviewTransport` 抽象 + Host 侧可插拔 gateway。
详见 [`docs/architecture.md` §5](docs/architecture.md) 与
[`docs/adr/0002-portable-transport-and-gateway.md`](docs/adr/0002-portable-transport-and-gateway.md)。

> 注意：可移植的是 **UI**。**Host** 需 spawn `Simulator` 并说原生 socket，必须跑在有 Node 的宿主里
> （独立进程 / VSCode 扩展宿主 / Electron 主进程 / Tauri sidecar）。

## 组成

| 目录 | 角色 | 替代对象 | 技术栈（建议） |
|------|------|----------|----------------|
| `host/` | Preview Host：进程编排 + 双通道协议网关（core + 可插拔 gateway） | `index.js` | Node.js + TypeScript |
| `ui/`   | Preview UI：画面渲染 + 交互采集 + 设备面板（纯 Web，可移植） | `ohpreviewer` | React + TypeScript + Canvas |

## 当前状态

**规划阶段**。本次提交仅落盘文档与架构规划，尚无可运行代码。
实施路线见 [`docs/roadmap.md`](docs/roadmap.md)，从 **M0 协议探针**起步。

## 文档

- [`docs/overview.md`](docs/overview.md) — 项目目标与范围
- [`docs/architecture.md`](docs/architecture.md) — 组件、数据流、模块划分
- [`docs/protocol.md`](docs/protocol.md) — 与 Simulator 的双通道协议规格（逆向自开源后端）
- [`docs/reverse-engineering.md`](docs/reverse-engineering.md) — 源码 / DevEco 逆向证据与引用
- [`docs/roadmap.md`](docs/roadmap.md) — M0→M4 实施路线
- [`docs/adr/`](docs/adr/) — 架构决策记录

## 许可

拟采用 Apache-2.0，与 OpenHarmony 主仓一致。
