# 协议规格：Host ↔ Simulator

本文件是复刻前端**唯一必须遵守的契约**，全部逆向自开源后端 `ide/tools/previewer`。
每条均附源码出处，便于核对与回归。证据汇总见 [`reverse-engineering.md`](reverse-engineering.md)。

> 字节序：所有二进制字段为 **小端（LE）**。

---

## 1. 进程拓扑与通道方向

| 通道 | 传输 | Simulator 角色 | Host 角色 | 启动参数 |
|------|------|----------------|-----------|----------|
| 命令通道 | LocalSocket（Unix domain socket / Win 命名管道） | **client**（`connect`） | **server**（监听） | `-s <name>` |
| 图像通道 | WebSocket（libwebsockets） | **server**（监听 `127.0.0.1:port`） | **client**（连接） | `-lws <port>` |

依据：
- 命令通道 Simulator 侧 `connect()`：`util/unix/LocalSocket.cpp:46`。
- 图像通道 Simulator 侧 libwebsockets 服务：`util/WebSocketServer.h`（`serverHostname = "127.0.0.1"`、`StartWebsocketListening`）。

⇒ Host 必须**先**建命令通道 server 并监听，**再** spawn Simulator；spawn 后**作为 client**去连图像通道。

---

## 2. 启动参数（spawn Simulator）

来源：`util/CommandParser.cpp`（参数注册与读取）、`jsapp/lite/JsAppImpl.cpp:InitJsApp`、
DevEco `index.js` 实测出现的参数集合。

| 参数 | 含义 | 必需 |
|------|------|------|
| `-j <path>` | JS 应用产物目录（含 `app.js` 或快照 `app.bc` + 页面） | 是 |
| `-n <name>` | bundle / app 名 | 是 |
| `-s <name>` | 命令通道 socket/pipe 名 | 是 |
| `-lws <port>` | 图像通道 WebSocket 端口 | 是 |
| `-or <w>` `-cr <h>` | original / compression 分辨率 | 是 |
| `-device <type>` | 设备类型，如 `liteWearable` | 是 |
| `-shape <rect\|circle>` | 屏幕形状（手表圆/方） | liteWearable 用 |
| `-cm <light\|dark>` | 颜色模式 | 否 |
| `-url <uri>` | 单页预览路由 | 否 |
| `-d` `-p <port>` | 调试模式 + 调试端口 | 否 |
| `-refresh <region\|full>` | 刷新策略（局部/全量） | 否 |
| `-foldable true` `-fr <...>` | 折叠屏及折叠分辨率 | 否 |
| `-hsp <size>` | JS 堆大小 | 否 |

> liteWearable 典型：
> `Simulator -device liteWearable -shape circle -or 466 -cr 466 -j <app> -n <bundle> -s <pipe> -lws <port>`

DevEco `index.js` 中实测出现的完整 flag 集合（供对照）：
`-j -n -s -lws -or -cr -cm -url -d -p -refresh -foldable -fr -shape -device -t -ts -sd -rt -av -x -rp -cjp -arp -abs -r -pm -pages -o -l -hsp`。
未列入上表的为 rich 形态 / 高级特性参数，liteWearable MVP 暂不需要。

---

## 3. 命令通道（JSON over LocalSocket）

### 3.1 分帧

- 一条消息 = 一段 JSON 文本，**以 `\0` 结尾**。
- 写：`WriteData(data, length + 1)`，发送内容含结尾 `\0` —— `util/unix/LocalSocket.cpp:130`。
- 读：`recv` 到缓冲，按 `\0` 切分 —— `util/unix/LocalSocket.cpp:74` + `operator>>`（:119）。
- 解析：`JsonReader::ParseJsonData2(message)` —— `cli/CommandLineInterface.cpp:ProcessCommandMessage`。

### 3.2 请求信封（Host → Simulator）

```jsonc
{
  "version": "<x.y.z>",     // 必需，须匹配后端版本正则
  "command": "<name>",      // 必需，见 §3.4 命令表
  "type": "set|get|action", // 必需
  "args": { /* 命令相关 */ } // set/action 通常需要
}
```

校验：缺 `type`/`command`/`version` 或 `version` 非字符串 → 丢弃
（`cli/CommandLineInterface.cpp:159-164`）。
`type` 取值映射：`set`/`get`/`action` → 否则 `INVALID`（`:172-179`）。

### 3.3 回复信封（Simulator → Host）

```jsonc
{
  "version": "<x.y.z>",
  "command": "<name>",
  "result":  <值>          // 或 "args": {...}，依命令而定
}
```

- 通用回复头：`version` + `command`（`cli/CommandLine.cpp:115-116`）。
- 不支持的命令：`result: "Unsupported command"`（`cli/CommandLineFactory.cpp:82-86`）。
- 携带数据的回复用 `SetResultToManager(...)`，键为 `args`/`result`（如 `CurrentJsRouter`、
  `MemoryRefresh`、`AvoidAreaChanged` —— `cli/CommandLine.cpp:757/1356/1739`）。

### 3.4 命令表

注册于 `cli/CommandLineFactory.cpp:33-74`。按用途分组：

**交互注入**
| command | type | args（已核对） | 出处 |
|---------|------|----------------|------|
| `MousePress` | set | `{x:int, y:int}` | CommandLine.cpp:166 |
| `MouseMove` | set | `{x:int, y:int}` | :283 |
| `MouseRelease` | set | `{x:int, y:int}` | :238 |
| `PointEvent` | set | `{x:double, y:double, ...}` | :192/:264/:309 |
| `CrownRotate` | set | `{rotate:double}` | :231 |
| `KeyPress` | set/action | `{...keyCode...}`（待核对字段名） | factory:46 |
| `BackClicked` | action | `{}` | factory:33 |

**设备能力（liteWearable 重点）**
| command | type | args（已核对/待核对） | 出处 |
|---------|------|----------------------|------|
| `HeartRate` | set | `{HeartRate:int}` ✓ | CommandLine.cpp:1181 |
| `StepCount` | set | `{...}` 待核对 | factory:62 |
| `Barometer` | set | `{...}` 待核对 | factory:54 |
| `WearingState` | set | `{...}` 待核对 | factory:57 |
| `Brightness` / `BrightnessMode` | set | 待核对 | factory:60/58 |
| `ChargeMode` / `Power` | set | 待核对 | factory:59/52 |
| `Volume` | set | 待核对 | factory:53 |
| `Location` | set | 待核对 | factory:55 |
| `KeepScreenOnState` | set | 待核对 | factory:56 |

**画面 / 布局**
`ResolutionSwitch` `Resolution` `Orientation` `ColorMode` `FoldStatus`
`AvoidArea` `AvoidAreaChanged` `DropFrame` `MemoryRefresh`（factory:36-50）

**路由 / 加载**
`CurrentRouter`（get，返回 `{args:{...}}` :757）`LoadContent` `LoadDocument`
`ReloadRuntimePage` `FastPreviewMsg`（factory:39-47）

**国际化**
`Language` `SupportedLanguages` `FontSelect`（factory:69/70/41）

**调试 / 生命周期**
`inspector` / `inspectorDefault`（get，返回组件树 JSON，factory:34-35）
`DeviceType` `exit`（factory:73/71）

> ✓ = args 字段名已读源码核对；其余标「待核对」，需在实现前逐条读对应 `*Command` 的
> `IsArgsValid()` / 取值逻辑（同在 `cli/CommandLine.cpp`）确认精确键名与类型。

### 3.5 启动握手

- 管道连通后，后端发 WebSocket 启动信号：`SendWebsocketStartupSignal()`
  （`cli/CommandLineInterface.cpp:ProcessCommand`，`isFirstWsSend` 触发一次）。
- ⇒ Host 应在收到该信号后再连图像通道，或重试连接直至成功。

---

## 4. 图像通道（二进制帧 over WebSocket）

### 4.1 帧结构

每帧 = **40 字节头 + 负载**。头由 `InitBuffer`（偏移 0 起）+ `WriteRefreshRegion`
（偏移 `VERSION_POS=20` 起）写入。来源：`mock/lite/VirtualScreenImpl.cpp:84-118`、
`mock/lite/VirtualScreenImpl.h:74`、`mock/VirtualScreen.h:127-133`。

```
偏移  字段               类型     说明
0     magic              u32 LE   0x12345678（headStart，帧起始校验）
4     originalWidth      i32 LE
8     originalHeight     i32 LE
12    compressionWidth   i32 LE
16    compressionHeight  i32 LE
20    protocolVersion    u16 LE   2=LOADNORMAL(JPEG) 3=LOADDOC 4=LOADDOCRGBA
22    regionX1           i16 LE   脏矩形左上 x
24    regionY1           i16 LE   脏矩形左上 y
26    regionWidth        i16 LE   脏矩形宽
28    regionHeight       i16 LE   脏矩形高
30..39                   —        reserved（headReservedSize=20，20..39 内含上面 region 字段）
40    payload            bytes    JPEG 字节流（v2/3）或 RGBA 裸数据（v4）
```

字段顺序与类型依据：
- `InitBuffer`：`headStart, orignalW, orignalH, compressionW, compressionH`（`VirtualScreenImpl.cpp:111-116`）。
- `WriteRefreshRegion`：`protocolVersion(u16), regionX1, regionY1, regionWidth, regionHeight`，自 `VERSION_POS=20` 写起（`VirtualScreenImpl.cpp:84-94`）。
- region 字段类型 `int16_t`（`VirtualScreenImpl.h:75-80`）。
- 常量：`headSize=40` `headReservedSize=20` `headStart=0x12345678` `pixelSize=4`（`VirtualScreen.h:129-131`）。

> ⚠ region 各字段的精确偏移以「`WriteBuffer` 调用顺序 + `sizeof`」为准
> （`WriteBuffer` 见 `VirtualScreenImpl.h:59`，按写入类型大小步进 `currentPos`）。
> M0 阶段需逐字节 dump 首帧核对上表，再写死解析器。

### 4.2 负载格式

- 默认 **JPEG**（`ProtocolVersion::LOADNORMAL=2`）。后端 `RgbToJpg` 编码，质量按像素量在
  75/85/90/100 间自适应（`GetJpgQualityValue`、`JpgQualityLevel`，`VirtualScreen.h:78-79`）。
- `LOADDOCRGBA=4` 为 RGBA 裸数据直传（无压缩）。
- 前端按 `protocolVersion` 分支解码。

### 4.3 帧节奏与丢帧

- 约 **40ms/帧**（`sendPeriod=40`，`VirtualScreen.h:127`）。
- 局部刷新（region 模式）只发脏矩形 —— 前端须按 `region*` 把负载贴到画布对应位置，而非整屏覆盖。
- 后端有丢帧逻辑：`JudgeAndDropFrame` / `DropFrame` 命令 / 静态画面停发
  （`JudgeStaticImage` / `StopSendStaticCardImage`）。前端不可假设固定帧率。
- **首帧缓存**：后端缓存 `firstImageBuffer`（`WebSocketServer.h` + `VirtualScreenImpl.cpp:141-152`），
  新连接客户端能立即拿到当前画面。

### 4.4 鉴权（sid）

- WS 连接需通过 `WebSocketServer::CheckSid`（`util/WebSocketServer.h`）校验 `sid`。
- `sid` 经命令通道 / 启动参数由 Host 侧约定下发（`SetSid`）。
- ⇒ M0 必须先从源码读清 `CheckSid` 的匹配方式（握手在哪带 sid、明文还是 hash），否则连不上。**这是首个落地阻塞点。**

---

## 5. 待核对清单（实现前必须读死）

1. `WebSocketServer::CheckSid` 的 sid 匹配方式与握手位置（`util/WebSocketServer.cpp`）。
2. 帧头 region 字段逐字节偏移（M0 dump 核对）。
3. `KeyPress` / `CrownRotate` / 各传感器 `set` 命令的精确 args 键名与类型（`cli/CommandLine.cpp` 各 `*Command`）。
4. `version` 字段要求的正则与取值（`cli/CommandLineInterface.cpp:164` 的 `regex_match`）。
5. `inspector` 返回的组件树 JSON schema（节点字段、坐标系）。
6. Windows 命名管道命名规则与建 server 方式（`util/windows/LocalSocket.cpp`）。
