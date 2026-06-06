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

## M2 — 可交互 ✅ 已完成（2026-06-06）

目标：交互上行打通（UI→Host→Simulator），并由回包验证全链路往返。

产出：
- `host`：`gateway::ws` 解析 UI 上行（`{type:"command",command,cmdType,args}`）→ `core::build_command`
  加 `version:"1.0.1"` → `session.send_command`；上行/下行同一 WS。`command_bridge` 已支持 `send`。
- `ui`：`InputLayer`（指针坐标→original 换算→`MousePress/Move/Release`；滚轮→`CrownRotate`）、
  `Toolbar`（按设备能力自适应）。

**验收**：✅ 实测 `HeartRate=142` → 后端「Set heartRate run finished: 142」；
画布点击 → 后端「TouchPress(233,233...)」注入引擎；命令回包经 Host 转发回 UI（往返闭环验证）。

**关键发现**：命令集按 **lite/rich 分流**（见 protocol §3.5）。lite 仅传感器/触摸/表冠/语言；
`inspector/ColorMode/ReloadRuntimePage/BackClicked` 等为 rich 专属，向 lite 发会回 `Unsupported command`。
⇒ Host 在 UI 连接时发 `hello{isLite,device,shape,w,h}`，UI 据此自适应（隐藏 rich 专属操作）。

---

## M3 — 设备状态面板 ✅ 已完成（2026-06-06）

目标：liteWearable 传感器/系统态可调。

产出 `ui/components/ControlPanel`（声明式控件，11 项，均为 lite 命令集）：
`HeartRate` `StepCount` `Barometer` `Power` `ChargeMode` `Brightness` `BrightnessMode`
`WearingState` `KeepScreenOnState` `Language` `Location`（注意 Location 经测后端要 string）。
表冠：滚轮 → `CrownRotate`（`InputLayer`）。

> `ColorMode`/`Orientation` 属 rich 专属（lite 不支持），故不在 lite 面板。

**验收**：✅ 各控件变更即下发 `set` 命令，后端日志确认接收并生效（如心率 142）。

---

## M4 — 工具与稳定性 ◑ 部分完成（lite 范围内）

- **InspectorPanel**：✅ 已实现并按 rich 门控（`inspector` 是 **rich 专属**命令，lite 不可用）。
  组件树渲染 + 工具栏触发就绪；需驱动 rich 形态才能实跑（见 Backlog）。
- **健壮性**：✅ 图像通道断线自动重连（`frame_relay` 退避重试）；✅ UI 端 ⟲ 重连；
  ✅ 子进程随会话 `kill_on_drop` 清理；✅ 帧背压用 `watch` 自动丢旧帧。
- ◻ Simulator 崩溃自动重启（重新 spawn + 重绑端点）：Backlog。
- ◻ Windows 命名管道：`command_bridge` 当前用 unix socket；Windows 需切 `interprocess`/命名管道。

**验收**：✅ lite 下长时运行稳定、断线可恢复；Inspector 待 rich 形态验证。

---

## M5 — VSCode 嵌入（验证可移植性）◑ 代码完成，待 VSCode 实跑

目标：同一份 UI 产物在 VSCode webview 中跑通，证明移植接缝有效。

产出：
- `ui/transport/VsCodeTransport.js`：`PreviewTransport` 的 postMessage 实现；`detect()` 检测
  `acquireVsCodeApi` 自动选择。**UI 业务组件零改动。**
- `host/integrations/vscode/`：relay shim 扩展（`extension.js`+`package.json`+README）——spawn
  `previewer-host`、开 webview 加载 `ui/`、在 host `/ws` 与 webview postMessage 间转发。

**验收**：✅ `VsCodeTransport` postMessage 契约已在浏览器隔离验证（frame→Blob/event/command 往返）；
◻ 扩展本体需在 VSCode 中运行验证（依赖内置 Node 22+ 全局 WebSocket，或打包 `ws`）。
体现「零改动移植」：UI 与 Rust 二进制不变，仅加 `VsCodeTransport` + 薄扩展。

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
