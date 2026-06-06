# 架构设计

## 1. 总览

```
┌─────────────────────────────────────────────────────────────┐
│  Preview UI  (ui/)   React + TS + Canvas   ← 纯 Web，可移植    │
│  ScreenCanvas · DeviceFrame · InputLayer · ControlPanel       │
│  InspectorPanel · Toolbar                                     │
│  ───────────────── PreviewTransport（移植接缝）─────────────── │
│  WebSocketTransport | VsCodeTransport | PostMessageTransport  │
└───────────────▲───────────────────────┬─────────────────────┘
       帧+事件   │   WS / postMessage     │  交互+控制（同一传输）
                │                        ▼
┌───────────────┴─────────────────────────────────────────────┐
│  Preview Host  (host/)   Rust 单一静态二进制  ← 零运行时依赖    │
│  gateway:  WsGateway（唯一对外；沙箱宿主用外置 relay shim）     │
│  core:     Launcher · CommandBridge · FrameRelay · Session    │
└───────┬───────────────────────────────────▲─────────────────┘
        │ spawn + CLI args                   │
        │                                    │
  ┌─────▼──────────┐   命令通道(JSON)   ┌─────┴────────┐
  │  Simulator     │◄──LocalSocket──────│  (Host 建 server)
  │  (开源后端)     │                    │
  │  ACELite 引擎   │──WebSocket(帧)────►│  (Host 作 client)
  └────────────────┘   图像通道(二进制)  └──────────────┘
```

> **通道方向不对称（关键）**：
> - 命令通道：Simulator 是 `connect()` 客户端 → **Host 必须先建 socket/pipe server** 并监听 `-s` 指定的名字。
> - 图像通道：Simulator 是 libwebsockets server → **Host 作为 WS client** 连 `-lws` 端口。
>
> 依据见 [`protocol.md`](protocol.md) 与 [`reverse-engineering.md`](reverse-engineering.md)。

## 2. Preview Host（host/）

替代闭源 `index.js`。职责：进程生命周期 + 协议网关。**用 Rust 实现，编译为单一静态二进制，
零运行时依赖**（[ADR 0003](adr/0003-host-in-rust.md)）。分 **core** 与 **WsGateway**（见 §5.3）。
core 四个模块如下。建议 crate：`tokio` + `tokio-tungstenite`（ws 收/发）+ `interprocess`
（跨平台 local socket / 命名管道）+ `serde_json` + `axum`（ws + 静态托管）+ `clap`。JPEG 纯透传，无需解码。

### 2.1 Launcher
- 分配空闲 WS 端口与唯一 socket/pipe 名（及 `sid`）。
- 拼接 CLI 参数（见 protocol §2），`child_process.spawn` 启动 Simulator。
- 监控 stdout/stderr/退出码；崩溃可重启；退出时回收资源、发 `exit` 命令优雅关闭。

### 2.2 CommandBridge（命令通道）
- 创建并监听 Unix domain socket（Win：命名管道），等待 Simulator `connect`。
- 报文编解码：JSON 字符串 + 结尾 `\0` 分帧（见 protocol §3.1）。
- 请求-响应关联：`get`/`action` 命令需匹配回包；`set` 通常无回包。
- 向上暴露 `send(command)` / `on('message', cb)`。

### 2.3 FrameRelay（图像通道）
- 作为 WS client 连 `127.0.0.1:<lws>`，握手携带 `sid`。
- 解析 40 字节帧头（magic 校验、宽高、protocolVersion、脏矩形），剥离负载。
- 输出 `{ originalW, originalH, version, rect, payload }` 事件。

### 2.4 Session（会话编排）
- 把 Launcher + CommandBridge + FrameRelay 组装成一次预览会话，是 **core 对外的唯一出口**。
- 对外暴露运行时无关接口：`onFrame(cb)` / `onEvent(cb)` / `postControl(msg)` / `dispose()`。
- 下行：把 FrameRelay 的帧（重打包为 jpeg bytes + 元数据）和 CommandBridge 的上报，统一发给订阅者。
- 上行：把控制消息翻译成命令通道 JSON，经 CommandBridge 下发。
- **不假设 UI 如何连接**——具体由 gateway（§5.3）接到 WebSocket 或 postMessage 上。
- UI 因此完全不感知底层双通道、字节序与宿主差异，既便于多设备形态复用，也便于跨 webview 移植。

## 3. Preview UI（ui/）

替代闭源 `ohpreviewer`。React + TS。**纯 Web 产物，可在任意 webview 移植**（见 §5）。
所有模块只依赖 `PreviewTransport` 接口，不直接接触 socket / 宿主 API。六个功能模块 + 一个传输层。

### 3.0 Transport（移植接缝，§5.2）
- `PreviewTransport` 接口 + 三个实现（`WebSocketTransport` / `VsCodeTransport` / `PostMessageTransport`）。
- 启动时 `detect()` 按宿主自动选择（VSCode 注入 `acquireVsCodeApi` → 选 postMessage，否则默认 WS）。

### 3.1 ScreenCanvas
- 订阅 Host 帧流。JPEG 帧用 `createImageBitmap(blob)` → `ctx.drawImage`。
- region 模式只重绘脏矩形区域（按帧头 rect）。
- 维护 original→display 缩放比，处理 HiDPI / devicePixelRatio。

### 3.2 DeviceFrame
- 设备外观（手表表盘圆/方、表带、边框），按 `-shape` 与分辨率渲染。
- liteWearable 圆屏：画布按圆形裁剪。

### 3.3 InputLayer
- 覆盖画布，捕获指针/键盘事件。
- 坐标按缩放比换算回 original 坐标系，发 `MousePress/MouseMove/MouseRelease`（或 `PointEvent`）。
- 滚轮 → `CrownRotate`（表冠）；键盘 → `KeyPress`；返回 → `BackClicked`。

### 3.4 ControlPanel（设备状态）
- liteWearable 传感器/系统态控件，每个绑定一条 `set` 命令：
  心率 `HeartRate`、步数 `StepCount`、电量/充电 `Power`/`ChargeMode`、气压 `Barometer`、
  佩戴 `WearingState`、亮度 `Brightness`/`BrightnessMode`、音量 `Volume`、定位 `Location`、
  常亮 `KeepScreenOnState`、语言 `Language`、深浅色 `ColorMode`、旋转 `Orientation`、折叠 `FoldStatus`。

### 3.5 InspectorPanel
- 调 `inspector`（`get`）拉组件树 JSON，树形展示。
- 选中节点 → 在画布叠加高亮框（坐标取自节点 rect）。

### 3.6 Toolbar
- 重载 `ReloadRuntimePage`、路由 `CurrentRouter`/`LoadContent`、
  分辨率 `ResolutionSwitch`、内存刷新 `MemoryRefresh`、Fast Preview `FastPreviewMsg`。

## 4. 端到端数据流（一次点击）

```
用户点画布
  → InputLayer 换算 original 坐标
  → UI WS  → Host.UIGateway → Host.CommandBridge
  → LocalSocket: {"version","command":"MousePress","type":"set","args":{"x":..,"y":..}}
  → Simulator → ACELite 处理事件 → 重绘
  → VirtualScreen 出帧 → WS(-lws) 二进制帧
  → Host.FrameRelay 解析头 → UI WS
  → UI.ScreenCanvas drawImage
  → 用户看到响应
```

## 5. 嵌入模型与可移植性

设计目标：**UI 是一份纯静态 Web 产物，只要有 webview 就能移植**——VSCode webview、
独立 webview（Electron/Tauri/pywebview）、或普通浏览器，三者复用同一份 UI。

### 5.1 哪部分可移植，哪部分不可移植

- **可移植 = UI**：纯浏览器技术（React + Canvas + WebSocket/postMessage），无运行时/原生依赖。
- **不可移植 = Host**：必须 spawn `Simulator` 进程并说原生 domain socket / 命名管道，是原生程序。
  **用 Rust 实现，编译为单一静态二进制**（见 [ADR 0003](adr/0003-host-in-rust.md)），零运行时依赖。
  各宿主以**子进程**方式拉起这个二进制（Tauri 下也可作为后端/sidecar）。

⇒ 移植工作只发生在「UI 用什么方式够到 Host」这一层。把它抽象成**可插拔 Transport** 即可。

### 5.2 UI 侧：Transport 抽象（移植的唯一接缝）

UI 不直接 `new WebSocket(...)`，而是面向一个接口编程：

```ts
interface PreviewTransport {
  connect(): Promise<void>;
  send(msg: ControlMessage): void;        // 上行：交互/控制 → Host
  onFrame(cb: (f: FrameMessage) => void): void;  // 下行：画面帧
  onEvent(cb: (e: EventMessage) => void): void;  // 下行：上报（路由变化/inspector 等）
  close(): void;
}
```

具体实现按宿主选择（启动时 `detect()` 自动判定）：

| Transport | 适用宿主 | 机制 |
|-----------|----------|------|
| `WebSocketTransport` | 浏览器、独立 webview | `ws://127.0.0.1:<port>`，默认/通用方案 |
| `VsCodeTransport` | VSCode webview | `acquireVsCodeApi().postMessage` ↔ 扩展宿主（绕过 CSP/沙箱，remote/web 也可用） |
| `PostMessageTransport` | 通用 iframe 嵌入 | `window.postMessage` |

UI 其余模块（ScreenCanvas / InputLayer / …）只依赖 `PreviewTransport`，**对宿主零感知**。

### 5.3 Host 侧：core + 单一 WsGateway；沙箱宿主用 relay shim

Rust Host 是单一二进制，不能被 Node 扩展宿主进程内 import（跨语言），因此**不做进程内 gateway**。
统一模型：

- **core**：`Launcher` + `CommandBridge` + `FrameRelay` + `Session`，产出/接收抽象的帧与控制消息。
- **WsGateway**（唯一对外形态）：起本地 WebSocket server + 静态托管 UI 产物。**所有宿主都连这个 WS**。
- **relay shim**（仅沙箱宿主需要）：当宿主 webview 不能直连 localhost WS（如 VSCode remote/web），
  由宿主侧一个**极薄的转发器**在 `WsGateway` 与宿主 IPC 之间桥接。VSCode 的 shim 用 TS 写在扩展里：
  spawn Host 二进制 → 连其 WS → 与 webview `postMessage` 互转。shim 是宿主特定的，**不进 Rust core**。

> 对比 ADR 0002 的「进程内 EmbedGateway」：改用 Rust 后该形态对 Node 宿主不成立，
> 故收敛为「单一 WsGateway + 外置 relay shim」。决策见 [ADR 0003](adr/0003-host-in-rust.md)。

### 5.4 嵌入矩阵

| 宿主 | UI 加载方式 | Transport | Host（Rust 二进制）运行位置 | UI→Host 路径 |
|------|------------|-----------|------------------------------|--------------|
| 浏览器 | `WsGateway` 静态托管 | WebSocket | 独立子进程 | 直连 WS |
| 独立 webview (Tauri/Electron/pywebview) | 本地文件 / `WsGateway` | WebSocket | Tauri 后端·sidecar / 子进程 | 直连 WS |
| VSCode（本地） | `Webview.html` + asWebviewUri | WebSocket* | 扩展 spawn 的子进程 | 直连 WS（CSP 放行 localhost） |
| VSCode（remote/web） | 同上 | postMessage | 扩展 spawn 的子进程 | TS relay shim 转发 |

> *VSCode 本地场景能直连 localhost WS 时优先 WS；remote/web 不可靠时回退 postMessage relay。
> 共识不变：**WebSocket 是默认与通用路径**，postMessage 仅沙箱兜底。所有宿主复用同一 UI 与同一 Host 二进制。

### 5.5 通用约束

- Host 与 Simulator 全程 `127.0.0.1` 本地通信；socket/pipe 名与 `sid` 每次随机，避免多实例冲突。
- Host↔UI 的内部消息格式由本项目自定义（见 protocol §3.2 风格），**不照搬** Simulator 的字节协议；
  二进制帧建议封成 `{meta-json}` + `jpeg bytes`，文本控制用 JSON，便于跨 Transport 一致序列化。

## 6. 跨平台注意

| 关注点 | macOS / Linux | Windows |
|--------|---------------|---------|
| 命令通道 | Unix domain socket（`sun_path`） | 命名管道（`\\.\pipe\...`） |
| Simulator 文件名 | `Simulator` | `Simulator.exe` |
| 后端依赖 | `libide_*.dylib/.so` 随包 | `*.dll` 随包 |
| Host 二进制 | `previewer-host`（静态链接） | `previewer-host.exe` |

- 命令通道两端：后端 LocalSocket 实现见 `util/unix/` 与 `util/windows/`；Host 侧用 `interprocess`
  的 `local_socket` 抽象统一处理 domain socket / 命名管道，分平台建 server。
- Rust Host 交叉编译为各平台静态二进制随 SDK / 插件分发，使用者无需任何运行时。
