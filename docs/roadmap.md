# 实施路线

原则：**先打通协议，再做体验**。每个里程碑都可独立验收、可演示。

## M0 — 协议探针 ✅ 已完成（2026-06-06）

目标：用最小代码验证 [`protocol.md`](protocol.md) 的全部假设，消除落地风险。

产出：`host/src/bin/m0_probe.rs`（Rust）。实跑端到端通过——从开源 Simulator 抓取并解码出
真实首帧（liteWearable 466×466 圆屏，渲染出测试应用的「您好 世界」）。

**已验证/读死**：
- 命令通道方向（Host=server）、路径陷阱（`-s` 是基名 → `/tmp/<base>_commandPipe`）。
- 启动参数（`-or/-cr` 各两值、`-url` 必填、cwd 必须是 bin 目录否则字体失败、`-sid` hex）。
- sid 握手（WS URL 末段路径，空 sid 不校验）。
- 启动信号 JSON、帧头逐字节（**大端**，对抗复核一致）、lite 恒整屏 JPEG。
- 完整命令 IDL（见 protocol §3.5）。

**测试资产**：
- Simulator：`~/Library/OpenHarmony/Sdk/23/previewer/liteWearable/bin/Simulator`
- 测试手表应用（已编译 lite 产物）：
  `~/DevEcoStudioProjects/claude/entry/build/default/intermediates/loader_out_lite/default/js/MainAbility`
- 探针默认参数已指向上述路径，`cargo run --bin m0-probe` 即可复现。

**验收**：✅ 磁盘出现正确的应用首屏 JPEG（`/tmp/ohprev_frame.jpg`）。

---

## M1 — 只读预览（确立移植接缝）✅ 已完成（2026-06-06）

目标：浏览器里看到实时画面，并**一次性把 Transport/gateway 接缝立起来**。

产出：
- `host`（Rust）：core（`launcher`/`command_bridge`/`frame_relay`/`session`）+ `gateway::ws`
  （axum WS server + `ServeDir` 静态托管），单一二进制 `previewer-host`。
- `ui`（vanilla，零构建）：`transport/`（`PreviewTransport` 契约 + `WebSocketTransport` + `detect`）、
  `components/ScreenCanvas`（`createImageBitmap` 解码 + drawImage）、`style.css` 圆屏外框。
- **Host 端最新帧缓存**（`tokio::watch`）：后连接的 UI 客户端立即拿到当前帧，解耦渲染/连接时序。

**验收**：✅ `cargo run --bin previewer-host` 后浏览器打开 `http://127.0.0.1:9000` 即见
liteWearable 实时画面（圆屏裁剪正确、LIVE 状态）。UI 仅依赖 `PreviewTransport`，接缝就位。

运行：
```bash
cd host && cargo run --bin previewer-host   # 默认指向 SDK Simulator + 测试手表应用
# 浏览器打开 http://127.0.0.1:9000
```

---

## M2 — 可交互

目标：点击/滑动/路由/重载有反馈。

任务：
- `host/`：CommandBridge（命令通道 server + JSON 分帧 + get 请求-响应关联）。
- `ui/`：InputLayer（坐标换算 + `MousePress/Move/Release`）、Toolbar（`ReloadRuntimePage`、
  `CurrentRouter`/`LoadContent`）。

**验收**：点击应用内按钮有响应；可跳转路由；可重载页面。

---

## M3 — 设备状态面板

目标：liteWearable 传感器/系统态全量可调。

任务：
- 逐条核对并接入 `set` 命令：`HeartRate` `StepCount` `Barometer` `WearingState`
  `Brightness`/`BrightnessMode` `Power`/`ChargeMode` `Volume` `Location` `KeepScreenOnState`
  `ColorMode` `Orientation` `Language`。
- `ui/`：ControlPanel 控件与命令绑定。
- 表冠交互：滚轮 → `CrownRotate`。

**验收**：改心率/电量/佩戴态/语言/深浅色，应用内有对应反馈。

---

## M4 — 工具与稳定性

目标：可长期使用，具备调试能力。

任务：
- InspectorPanel：`inspector` 组件树 + 画面高亮联动。
- region 局部刷新优化（按脏矩形贴图）。
- 健壮性：图像通道断线重连、Simulator 崩溃重启、丢帧/背压处理、优雅退出（`exit`）。
- 跨平台：Windows 命名管道路径打通。

**验收**：长时间运行稳定；组件树可查并能在画面上高亮；异常可自恢复。

---

## M5 — VSCode 嵌入（验证可移植性）

目标：同一份 UI 产物在 VSCode webview 中跑通，证明移植接缝有效。

任务：
- `integrations/vscode`：TS 薄扩展（relay shim）——spawn `previewer-host` 二进制，连其 WS，
  在 WS 与 `webview.postMessage`/`onDidReceiveMessage` 间转发。本地场景可直连 WS、跳过转发。
- `ui/transport`：`VsCodeTransport`（`acquireVsCodeApi`），`detect()` 自动选择。
- Webview HTML：用 `asWebviewUri` 加载 UI 产物，配好 CSP。

**验收**：在 VSCode 里打开预览面板即见实时画面并可交互，**UI 与 Rust core/二进制相对 M1 零改动**
（仅新增 UI 的 `VsCodeTransport` + TS relay shim 扩展壳）。

---

## 后续（Backlog）

- rich 形态（phone/tablet/tv/car，驱动 `Previewer` 二进制）。
- 折叠屏 `FoldStatus`/`-foldable`、多分辨率 `ResolutionSwitch`。
- Fast Preview 热重载（`FastPreviewMsg`）。
- 其他独立 webview 宿主：Electron / Tauri sidecar / pywebview 打包。
- 设备外观皮肤系统（多表盘 / 多设备外框资源）。

---

## 里程碑依赖图

```
M0 协议探针 ──► M1 只读预览 ──► M2 可交互 ──► M3 设备面板 ──► M4 工具&稳定
   (阻塞全部)   (接缝+骨架)      (命令通道)     (命令扩展)      (体验&健壮)
                    │
                    └────────────────────────────────► M5 VSCode 嵌入
                       (复用 Transport 接缝，验证可移植性)
```
