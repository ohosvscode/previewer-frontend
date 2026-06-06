# 实施路线

原则：**先打通协议，再做体验**。每个里程碑都可独立验收、可演示。

## M0 — 协议探针（最高优先级）

目标：用最小代码验证 [`protocol.md`](protocol.md) 的全部假设，消除落地风险。

任务：
1. 读死阻塞点（见 protocol §5）：
   - `WebSocketServer::CheckSid` 的 sid 匹配方式与握手位置。
   - 帧头 region 字段逐字节偏移。
   - `version` 字段要求的正则。
2. 写一个 ~100 行脚本（Node/TS）：
   - 建命令通道 server（Unix domain socket）。
   - spawn `Simulator`，传最小 liteWearable 参数集。
   - 收到 WS 启动信号后连图像通道（带 sid）。
   - 解析帧头、校验 magic、把首帧负载 dump 成 `.jpg` 到磁盘。

**验收**：磁盘上出现一张正确的应用首屏 JPEG ⇒ 两条通道 + 帧格式 + sid 全部验证通过。

风险/产出：本阶段会把所有「待核对」项变成「已读死」，并更新 protocol.md。

---

## M1 — 只读预览

目标：浏览器里看到实时画面。

任务：
- `host/`：Launcher + FrameRelay + 最小 UIGateway（单 WS + 静态托管）。
- `ui/`：ScreenCanvas（JPEG 解码 + drawImage）+ DeviceFrame（liteWearable 圆/方屏）。
- 帧节奏处理：按 protocolVersion 分支、忽略 region 优化（先整屏覆盖）。

**验收**：`host` 启动后浏览器打开即见实时刷新的应用画面（圆屏裁剪正确）。

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

## 后续（Backlog）

- rich 形态（phone/tablet/tv/car，驱动 `Previewer` 二进制）。
- 折叠屏 `FoldStatus`/`-foldable`、多分辨率 `ResolutionSwitch`。
- Fast Preview 热重载（`FastPreviewMsg`）。
- IDE / 编辑器插件集成（WebView 嵌入）。
- 设备外观皮肤系统（多表盘 / 多设备外框资源）。

---

## 里程碑依赖图

```
M0 协议探针 ──► M1 只读预览 ──► M2 可交互 ──► M3 设备面板 ──► M4 工具&稳定
   (阻塞全部)      (Host+UI骨架)   (命令通道)     (命令扩展)      (体验&健壮)
```
