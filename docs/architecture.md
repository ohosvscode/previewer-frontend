# 架构设计

## 1. 总览

```
┌─────────────────────────────────────────────────────────────┐
│  Preview UI  (ui/)   React + TS + Canvas                      │
│  ScreenCanvas · DeviceFrame · InputLayer · ControlPanel       │
│  InspectorPanel · Toolbar                                     │
└───────────────▲───────────────────────┬─────────────────────┘
                │  统一 WS（帧 + 事件）   │  统一 WS（交互 + 控制）
                │                        ▼
┌───────────────┴─────────────────────────────────────────────┐
│  Preview Host  (host/)   Node.js + TS                         │
│  UIGateway · CommandBridge · FrameRelay · Launcher            │
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

替代闭源 `index.js`。职责：进程生命周期 + 协议网关。单进程，四个模块。

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

### 2.4 UIGateway（对 UI 的统一出口）
- 对 UI 暴露**单一** WebSocket 端点（+ 静态文件服务，托管 ui 构建产物）。
- 下行：把 FrameRelay 的帧（重打包为 jpeg blob + 元数据）和 CommandBridge 的上报转发给 UI。
- 上行：把 UI 的交互/控制消息翻译成命令通道 JSON，经 CommandBridge 下发。
- UI 因此完全不感知底层双通道与字节序细节，便于多设备形态复用。

## 3. Preview UI（ui/）

替代闭源 `ohpreviewer`。React + TS。六个模块。

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

## 5. 进程与部署形态

- **开发**：`host` 起本地服务（含静态托管 `ui` 产物），浏览器打开即用。
- **IDE 集成（可选后续）**：`ui` 产物嵌入 WebView，`host` 作为后台进程，与本设计无冲突。
- Host 与 Simulator 全程 `127.0.0.1` 本地通信；socket/pipe 名与 `sid` 每次随机，避免多实例冲突。

## 6. 跨平台注意

| 关注点 | macOS / Linux | Windows |
|--------|---------------|---------|
| 命令通道 | Unix domain socket（`sun_path`） | 命名管道（`\\.\pipe\...`） |
| Simulator 文件名 | `Simulator` | `Simulator.exe` |
| 后端依赖 | `libide_*.dylib/.so` 随包 | `*.dll` 随包 |

LocalSocket 的两套实现见后端 `util/unix/` 与 `util/windows/`；Host 需对应分别建 server。
