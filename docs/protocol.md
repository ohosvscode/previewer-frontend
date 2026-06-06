# 协议规格：Host ↔ Simulator

本文件是复刻前端**唯一必须遵守的契约**，全部逆向自开源后端 `ide/tools/previewer`，
并经 **M0 协议探针端到端验证**（`host/src/bin/m0_probe.rs`，2026-06-06 实跑通过：
启动 liteWearable Simulator → 命令通道 → sid 鉴权 → WS → 大端帧头 → JPEG 落盘出真实画面）。

> 状态图例：✅ 源码+实跑双验证 · 📖 源码已读死 · ⚠️ 注意点
> 字节序：**图像帧头为大端（network byte order）**；命令通道是 JSON 文本，无字节序问题。

---

## 1. 进程拓扑与通道方向 ✅

| 通道 | 传输 | Simulator 角色 | Host 角色 | 启动参数 |
|------|------|----------------|-----------|----------|
| 命令通道 | LocalSocket（Unix domain socket / Win 命名管道） | **client**（`connect`，启动后很早就连） | **server**（spawn 前先 listen） | `-s <base>` |
| 图像通道 | WebSocket（libwebsockets，二进制下行） | **server**（监听 `127.0.0.1:<port>`） | **client**（连接） | `-lws <port>` + `-sid <hex>` |

⇒ Host 必须**先**在命令通道路径上 listen，**再** spawn Simulator；spawn 后作为 WS client 去连。
依据：`util/unix/LocalSocket.cpp:46`（Simulator `connect`）、`util/WebSocketServer.h`（lws server, `127.0.0.1`）。

### 1.1 命令通道路径（关键陷阱）✅

`-s` 的值是**基名**，不是完整路径。实际路径由 `GetCommandPipeName` 拼接：

| 平台 | 命令通道实际路径 |
|------|------------------|
| unix（mac/linux） | `/tmp/<base>_commandPipe` |
| windows | `\\.\pipe\<base>_commandPipe` |

依据：`util/unix/LocalSocket.cpp:59-62`、`util/windows/LocalSocket.cpp:49-52`。
⇒ 传 `-s ohprobe123`，Host 就在 `/tmp/ohprobe123_commandPipe` 上 listen。
（trace 通道 `-ts` 用 `/tmp/<base>`，image 通道在 lite 走 WS 不走 socket。）

---

## 2. 启动参数（spawn Simulator）✅

来源：`util/CommandParser.cpp`、实跑验证。

### 2.1 liteWearable 最小必需集

```
Simulator \
  -device liteWearable -shape circle \
  -or 466 466  -cr 466 466 \
  -j <APP_DIR>  -url pages/index/index \
  -n <BUNDLE>   -s <BASE>  -lws <PORT>  -sid <HEX_SID>
```

⚠️ **三个易错点**：
1. `-or` / `-cr` **各需两个值**（width height）：`-or 466 466`。只给一个会 `not match regex` 直接 FATAL 退出。
   - `-or` = original 分辨率，`-cr` = compression 分辨率（= JPEG 实际尺寸）。
2. `-url` **必填且非空**，否则退出（`CommandParser.cpp:451-460`）。
3. **cwd 必须是 SDK 的 `liteWearable/bin/` 目录**。后端 `FileSystem::GetApplicationPath()` 返回的是
   `getcwd()`（不是二进制路径！`util/FileSystem.cpp:44-52`），字体从 `<cwd>/../config/` 加载。
   cwd 不对 → `Open font path failed` → 文字渲染不出来。

### 2.2 参数表

| 参数 | 值 | 必需 | 说明 |
|------|-----|------|------|
| `-device` | `liteWearable` | 形态必需 | 设备类型，`supportedDevices` 校验 |
| `-shape` | `rect`\|`circle` | 否（默认 circle） | 表盘形状 |
| `-or` | `<w> <h>` | ✅ | original 分辨率（两个值） |
| `-cr` | `<w> <h>` | ✅ | compression 分辨率（两个值，= JPEG 尺寸） |
| `-j` | `<dir>` | ✅ | 已编译 JS 应用目录（含 `app.js`+`pages`，目录须存在） |
| `-url` | `<uri>` | ✅ | 首页路由，非空 |
| `-n` | `<name>` | 否 | bundle/app 名 |
| `-s` | `<base>` | ✅ | 命令通道基名 → `/tmp/<base>_commandPipe` |
| `-lws` | `<port>` | ✅ | 图像 WS 端口（1024–65535） |
| `-sid` | `<hex>` | 鉴权用 | WS 鉴权 sid，须匹配 `^[a-fA-F0-9]+$` |
| `-cm` | `light`\|`dark` | 否 | 颜色模式 |
| `-d -p <port>` | | 否 | 调试 + 调试端口（lite 无需 abilityName/Path） |
| `-h` / `-v` | | — | 打印后退出（exit 0） |

> 完整 flag 集（rich/高级）见 reverse-engineering.md。

---

## 3. 命令通道（JSON over LocalSocket）✅

### 3.1 分帧 ✅
- 一条消息 = 一段 JSON 文本，**以单个 `\0` 结尾**。Host 回发也必须 `JSON + \0`。
- unix：`AF_UNIX` + `SOCK_STREAM`。写 `WriteData(data, len+1)`（含结尾 `\0`）；读 `operator>>` 逐字节
  到 `\0` 为界。依据：`util/unix/LocalSocket.cpp:74-131`。
- 编码 UTF-8 文本；无长度前缀（与图像帧不同）。
- 连接时序：Simulator 在 `main` 早期（`ThinPreviewer.cpp:117-121`，早于引擎启动）就 `connect`；
  连不上只打日志不退出，但仍置 `isPipeConnected=true`。⇒ Host 必须 spawn 前已 listen。

### 3.2 请求信封（Host → Simulator）📖
```jsonc
{ "version": "<x.y.z>", "command": "<name>", "type": "set|get|action", "args": { /* 命令相关 */ } }
```
校验（`cli/CommandLineInterface.cpp:159-179`）：必须是对象，且含 `type`+`command`+`version`；
`version` 须为字符串且匹配正则；`type`∈{set,get,action} 否则 INVALID 丢弃。`args` 可缺省。

### 3.3 回复信封（Simulator → Host）📖
两类：
1. **同步应答**（多数命令）：`{"version","command","result": <bool|string|object>}`。
   - 不支持的命令：`{"version","command","result":"Unsupported command"}`。
2. **数据/主动上报**（get 数据、启动信号等）：`{"MessageType": <type>, "args": <object>}`，
   **无 version/command**，靠 `MessageType` 关联（约定式，无 id/序号 → get 并发无法精确配对）。

### 3.4 启动信号（Simulator 主动发）✅
命令通道连通且 WS 开始监听后，首次 `ProcessCommand` 发一次（`isFirstWsSend` 守卫）：
```json
{ "MessageType": "imageWebsocket", "args": { "port": "<lws端口字符串>" } }
```
依据：`cli/CommandLineInterface.cpp:83-103`。M0 实测收到。
⚠️ **sid 不在此下发**——Host 自己知道 `-sid` 的值，拼进 WS URL。
内存上报：`{"version","property":"memoryUsage","result":{...}}`。

### 3.5 命令 IDL（type + args）📖

⚠️ **命令集按设备类型 lite/rich 分流**（`cli/CommandLineFactory.cpp:31-66`，M2 实测确认）。
向 liteWearable 发 rich 专属命令会回 `"Unsupported command"`。

**仅 liteWearable（lite 分支）**：`Power` `Volume` `Barometer` `Location` `KeepScreenOnState`
`WearingState` `BrightnessMode` `ChargeMode` `Brightness` `HeartRate` `StepCount`
`DistributedCommunications` `CrownRotate`。

**仅 rich（非 lite 分支）**：`BackClicked` `inspector` `inspectorDefault` `ColorMode`
`Orientation` `ResolutionSwitch` `CurrentRouter` `ReloadRuntimePage` `FontSelect`
`MemoryRefresh` `LoadDocument` `FastPreviewMsg` `DropFrame` `KeyPress` `LoadContent`
`FoldStatus` `AvoidArea` `AvoidAreaChanged`。

**两端通用**：`MousePress` `MouseRelease` `MouseMove` `PointEvent` `Language`
`SupportedLanguages` `exit` `Resolution` `DeviceType`。

⇒ UI 需按 Host `hello` 的 `isLite` 自适应：lite 只暴露传感器/触摸/表冠/语言；
inspector·重载·深色等仅 rich。下表 args 字段名/类型/范围均读自 `cli/CommandLine.cpp` 各
`*Command` 并经 `liteWearableSettingConfig.json` 交叉验证。坐标系为 **original 分辨率**。

**交互注入**
| command | type | args |
|---------|------|------|
| `MousePress`/`MouseRelease`/`MouseMove` | action | `{x:int, y:int}`（0..宽/高；运行时按 double 取） |
| `PointEvent` | action | `{x,y:int, button:int(≥-1), action:int(≥0), sourceType:int, sourceTool:int, axisValues:number[13], pressedButtons:int[]}` |
| `CrownRotate` | action | `{rotate:double}`（表冠/滚轮） |
| `KeyPress` | action | `{isInputMethod:bool, codePoint:int(IME时), keyCode:int(2000..2119), keyAction:int(0..2), pressedCodes:int[], keyString?:string}` |
| `BackClicked` | action | `{}` |

**设备能力（liteWearable 重点）** —— 均 set/get
| command | set args | get 回包 |
|---------|----------|----------|
| `HeartRate` | `{HeartRate:int 0..255}` | `{result:{HeartRate}}` |
| `StepCount` | `{StepCount:uint 0..999999}` | `{result:{StepCount}}` |
| `Barometer` | `{Barometer:uint 0..999900}` | … |
| `WearingState` | `{WearingState:bool}` | … |
| `Brightness` | `{Brightness:int 1..255}` | … |
| `BrightnessMode` | `{BrightnessMode:int 0..1}` | … |
| `ChargeMode` | `{ChargeMode:int 0..1}` | … |
| `Power` | `{Power:double 0.0..1.0}` | … |
| `KeepScreenOnState` | `{KeepScreenOnState:bool}` | … |
| `Location` | `{latitude:string 正则, longitude:string 正则}`（⚠️源码要 string，DevEco 下发 number——以源码为准） | … |
| `Language` | `{Language:string ∈{zh-CN,en-US}(lite)}` | `{result:{Language}}` |
| `Volume` | 已下线，回 `"Command offline"` | — |

**画面/布局/路由**
| command | type | args / 回包 |
|---------|------|-------------|
| `ColorMode` | set | `{ColorMode:string ∈{light,dark}}` |
| `Orientation` | set | `{Orientation:string ∈{portrait,landscape}}` |
| `FoldStatus` | set | `{FoldStatus:string ∈{fold,unfold,unknown,half_fold}, width:int 50..3000, height:int}` |
| `ResolutionSwitch` | set | `{originWidth,originHeight,width,height:int 50..3000, screenDensity:int 120..640, reason?:string}` |
| `AvoidArea` | set | `{topRect,bottomRect,leftRect,rightRect: {posX,posY:int≥0, width,height:uint≥0}}` |
| `AvoidAreaChanged` | get | 原样回显 → `{MessageType:"AvoidAreaChanged", args:<原 args>}` |
| `DropFrame` | set | `{frequency:int≥0 ms}` |
| `MemoryRefresh` | set | 整个 args 透传给 JsApp |
| `CurrentRouter` | get | → `{MessageType:"CurrentJsRouter", args:{CurrentRouter:string}}` |
| `LoadContent` | get | → `{MessageType:"AbilityCurrentJsRouter", args:{AbilityCurrentRouter:string}}` |
| `LoadDocument` | set | `{url:string, className:string, previewParam:{width,height,dpi,locale,colorMode,orientation,deviceType}}` |
| `ReloadRuntimePage` | set | `{ReloadRuntimePage:string(页面路径)}` |
| `FastPreviewMsg` | get | → `{MessageType:"MemoryRefresh", args:{FastPreviewMsg:string}}` |
| `Resolution`/`DeviceType` | set | 运行期 no-op（启动期配置项） |

**调试/国际化/生命周期**
| command | type | 回包 |
|---------|------|------|
| `inspector` / `inspectorDefault` | action | `{result: <组件树 JSON 字符串>}`（空树 `{"children":"empty json tree"}`） |
| `SupportedLanguages` | get | `{result:{SupportedLanguages:string[]}}` |
| `FontSelect` | set | `{FontSelect:bool}` |
| `DistributedCommunications` | action | `{DeviceId,bundleName,abilityName,message:string 非空}` |
| `exit` | action | `{result:true}` 后进程退出 |

---

## 4. 图像通道（二进制帧 over WebSocket）✅

### 4.1 连接 ✅
- URL：`ws://127.0.0.1:<lws端口>/<sid>`。**sid 放在 URL 最后一个路径段**（不是 query、不是 header）。
  CheckSid 取 GET URI 最后一个 `/` 之后的子串与服务端 sid 严格比较；服务端 sid 为空则不校验放行。
  不匹配 → `FILTER_PROTOCOL_CONNECTION` 返回 1，握手被拒。依据：`util/WebSocketServer.cpp:52-88`。
- 子协议：服务端注册名为 `"ws"` 的 protocol，但回调不强制校验子协议。客户端可不带。
- 下行二进制（`LWS_WRITE_BINARY`），无 TEXT、应用层不分片；`MAX_PAYLOAD_SIZE=6400000`。

### 4.2 帧布局（40 字节头 + 负载，**大端**）✅ 对抗复核一致
`WriteBuffer<T>` 经 `EndianUtil::ToNetworkEndian<T>` 写入 → 线缆上是**大端**
（`VirtualScreenImpl.h:58-65`）。偏移由「写入顺序 + `sizeof`」累加：

```
偏移  字段                类型      大端  说明
0     magic               u32       BE    0x12345678（帧同步）
4     originalWidth       i32       BE    原始(逻辑)屏宽
8     originalHeight      i32       BE
12    compressionWidth    i32       BE    JPEG 实际宽（= -cr 宽）
16    compressionHeight   i32       BE    （写完 currentPos=20=VERSION_POS）
20    protocolVersion     u16       BE    lite 恒=2 (LOADNORMAL/JPEG)
22    regionX1            i16       BE    脏矩形 x（lite 整屏=0）
24    regionY1            i16       BE
26    regionWidth         i16       BE    被赋为 originalWidth（整屏宽）
28    regionHeight        i16       BE    被赋为 originalHeight（写完 currentPos=30）
30..39 (reserved)         —         —     lite 路径从不写入，解析跳过
40    payload             bytes     —     JPEG（JCS_RGB 3 分量）
```
依据：`mock/lite/VirtualScreenImpl.cpp` `InitBuffer`(108-116)/`WriteRefreshRegion`(84-94)、
`mock/VirtualScreen.h:128-133`。M0 实测：466×466、ver=2、region (0,0,466,466)、负载 JPEG SOI `FFD8`。

### 4.3 lite 帧行为 ✅
- **lite 恒发整屏 JPEG**：`ScheduleBufferSend` 的 region/full 两分支都调 `SendFullBuffer`
  （`VirtualScreenImpl.cpp:129-133`）。region 字段语义=整屏。protocolVersion 恒 2，永不发 RGBA。
- 质量自适应：`RgbToJpg` 按像素量在 75/85/90/100 间取（`GetJpgQualityValue`）。

### 4.4 发送条件与拿帧策略 ✅
- 仅当 `isChanged && isWebSocketConfiged` 才发，发后 `isChanged=false`（`VirtualScreenImpl.cpp:118-157`）。
- 首帧渲染时若 WS 未配置会早退但 **`isChanged` 保持 true** → 客户端连上、`isWebSocketConfiged` 转真后
  下一次 schedule 即补发挂起帧。⇒ **M0 实测首连即可拿到首帧**。
- 静态画面（无新渲染）下，纯新连接不会主动补缓存帧（`webSocketWritable` 初值 INIT≠UNWRITEABLE）；
  **重连**（CLOSED→UNWRITEABLE）才会在 `SERVER_WRITEABLE` 立刻补发 `firstImageBuffer`。
  ⇒ Host 取帧策略：连上等帧；超时则重连兜底（探针已实现）。
- 约 40ms/帧（`sendPeriod=40`）；有 `DropFrame`/静态停发等节流，前端不可假设固定帧率。

---

## 5. 已全部读死的原「待核对」项 ✅

1. ✅ sid：经 `-sid`(hex 正则) 传入；WS URL 末段路径携带；服务端空 sid 则不校验。
2. ✅ 帧头逐字节：见 §4.2（大端，对抗复核一致）。
3. ✅ 命令 args：见 §3.5 完整 IDL。
4. 📖 `version` 正则与 `COMMAND_VERSION` 值：`cli/CommandLineInterface.cpp`（实现时取常量原文填入）。
5. 📖 `inspector` 组件树 JSON schema：`JsAppImpl::GetJSONTree()`（M4 Inspector 时细化）。
6. ✅ Windows 命名管道：`\\.\pipe\<base>_commandPipe`（`util/windows/LocalSocket.cpp`）。
