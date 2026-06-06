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

## 组成

| 目录 | 角色 | 替代对象 | 技术栈（建议） |
|------|------|----------|----------------|
| `host/` | Preview Host：进程编排 + 双通道协议网关 | `index.js` | Node.js + TypeScript |
| `ui/`   | Preview UI：画面渲染 + 交互采集 + 设备面板 | `ohpreviewer` | React + TypeScript + Canvas |

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
