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

移植成本被压在一个接缝上：UI 侧的 `PreviewTransport` 抽象 + Host 侧统一 `WsGateway`。
详见 [`docs/architecture.md` §5](docs/architecture.md) 与
[`docs/adr/0002-portable-transport-and-gateway.md`](docs/adr/0002-portable-transport-and-gateway.md)。

> 注意：可移植的是 **UI**。**Host 是 Rust 编译的单一静态二进制**（零运行时依赖，见
> [ADR 0003](docs/adr/0003-host-in-rust.md)），需 spawn `Simulator` 并说原生 socket；
> 各宿主以**子进程**方式拉起它（Tauri 下可作后端/sidecar）。

## 组成

| 目录 | 角色 | 替代对象 | 技术栈 |
|------|------|----------|--------|
| `host/` | Preview Host：进程编排 + 双通道协议网关（core + WsGateway） | `index.js` | **Rust**（单一静态二进制，零运行时依赖） |
| `ui/`   | Preview UI：画面渲染 + 交互采集 + 设备面板（纯 Web，可移植） | `ohpreviewer` | React + TypeScript + Canvas |

## 当前状态

**lite + rich 端到端可用** ✅（M0–M4、M6 完成，M5 部分，2026-06-06）。

```bash
# liteWearable（手表）：
cd host && cargo run --bin previewer-host   # 默认 spawn Simulator；浏览器开 http://127.0.0.1:9000
# rich（phone Stage）：
cargo run --bin previewer-host -- --sim <SDK>/previewer/common/bin/Previewer \
  --app <工程>/.../loader_out/default --device phone --shape rect --width 1080 --height 2340 \
  --project-model Stage --arp <工程>/.../res/default \
  --pages <工程>/.../res/default/resources/base/profile/main_pages.json --url pages/Index
```

| 里程碑 | 状态 | 内容 |
|--------|------|------|
| M0 协议探针 | ✅ | 两条通道 + sid + 大端帧 + JPEG，实跑验证 |
| M1 只读预览 | ✅ | Host(core+WsGateway) + vanilla UI（Transport 抽象、圆屏） |
| M2 可交互 | ✅ | 触摸→TouchPress、滚轮→表冠；命令往返闭环实测 |
| M3 设备面板 | ✅ | 11 项 liteWearable 传感器/系统态（心率等实测生效） |
| M4 工具/稳定 | ✅ | 断线重连/背压/崩溃检测/优雅退出/DoS 上限（评审加固，实测） |
| M5 VSCode | ◑ | `VsCodeTransport` + relay shim 扩展完成，契约已验证；待 VSCode 实跑 |
| M6 rich 形态 | ✅ | 驱动 `Previewer` 渲染 phone Stage；rich 工具栏 + **Inspector 组件树** 实跑 |
| M7 调试集成 | ✅ | 与 [arkts-dap](../arkts-dap/) 集成：一键预览+断点调试（共用 Previewer）+ **实时 Inspector** |

一键预览+调试（rich/Stage）：
```bash
scripts/preview-and-debug.sh <工程>/entry/build/default/intermediates
# 浏览器 http://127.0.0.1:9000 实时预览；arkts-dap --cdp-port 29900 断点调试（共用同一 Previewer）
```

**关键约束**：后端命令集按 **lite/rich 分流**——`inspector`/`ColorMode`/`Reload` 是 rich 专属，
lite 仅传感器/触摸/表冠/语言。UI 按 Host `hello.isLite` 自适应。`inspector` 实时树需 ArkTS 调试器，
standalone 自动回退 `inspectorDefault`（组件目录）。详见 [`docs/protocol.md` §3.5](docs/protocol.md)。

Backlog：rich 其它形态(tablet/tv/car)、`inspector` 实时树(接调试器)、Windows 命名管道、
Simulator 崩溃自动重启。见 [`docs/roadmap.md`](docs/roadmap.md)。

## 文档

- [`docs/overview.md`](docs/overview.md) — 项目目标与范围
- [`docs/architecture.md`](docs/architecture.md) — 组件、数据流、模块划分
- [`docs/protocol.md`](docs/protocol.md) — 与 Simulator 的双通道协议规格（逆向自开源后端）
- [`docs/reverse-engineering.md`](docs/reverse-engineering.md) — 源码 / DevEco 逆向证据与引用
- [`docs/roadmap.md`](docs/roadmap.md) — M0→M4 实施路线
- [`docs/adr/`](docs/adr/) — 架构决策记录

## 许可

拟采用 Apache-2.0，与 OpenHarmony 主仓一致。
