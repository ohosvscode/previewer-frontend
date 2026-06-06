# 逆向证据与引用

本项目协议规格的全部依据。分两部分：**开源后端源码**（权威，决定协议）与
**DevEco 闭源前端观测**（佐证，确认官方确实这么用）。

> 原则：协议以**开源后端源码**为唯一权威。DevEco 观测仅用于交叉验证，不逆向其闭源逻辑、不复制其代码/资源。

---

## 1. 开源后端（权威来源）

根目录：`ide/tools/previewer/`（构建 `lite_previewer`，`output_name = "Simulator"`）。

### 1.1 构建与入口
- `BUILD.gn:98-126` — `lite_previewer` 目标，`output_name="Simulator"`，src=`ThinPreviewer.cpp`，
  依赖 `cli/jsapp/mock/util` 与 `ace_engine_lite/.../simulator:ace_lite`、`libwebsockets`。
- `BUILD.gn:136-146` — `copy_previewer_fonts_lite`，把字体拷到 `liteWearable/config/`。
- `ThinPreviewer.cpp:100` — `main()`：解析参数 → `InitSharedData` → `JsAppImpl::InitJsApp` → 主循环。

### 1.2 引擎拉起（参考链路，非协议）
- `jsapp/lite/JsAppImpl.cpp` — `InitJsApp`→`Start`→`ThreadCallBack`→`StartJsApp`→`JSAbility::Launch`。
- `ace_engine_lite/frameworks/src/core/context/js_ability.cpp` — `JSAbility::Launch/Show`。
- `.../js_ability_impl.cpp:41` — `InitEnvironment`（起 JerryScript + 框架，`Eval app.js`）。

### 1.3 命令通道
- `cli/CommandLineInterface.h` — 接口；持有 `LocalSocket`。
- `cli/CommandLineInterface.cpp`
  - `ProcessCommand` — 读循环；`isFirstWsSend` 触发 `SendWebsocketStartupSignal`。
  - `ProcessCommandMessage` — `ParseJsonData2` 解析。
  - `:159-164` — 信封校验（`type`/`command`/`version` 必需，version 须匹配正则）。
  - `:172-179` — `GetCommandType`：`set`/`get`/`action`。
- `cli/CommandLineFactory.cpp:33-74` — **命令注册表**（完整命令名清单）。
  - `:82-86` — 不支持命令回 `"Unsupported command"`。
- `cli/CommandLine.cpp` — 各 `*Command` 实现与 args 解析。已核对的字段：
  - `:166-171` `MousePress` `{x:int,y:int}`
  - `:238-243` `MouseRelease` `{x:int,y:int}`
  - `:283-288` `MouseMove` `{x:int,y:int}`
  - `:192-198/:264-270/:309-315` `PointEvent` `{x:double,y:double}`
  - `:231` `CrownRotate` `{rotate:double}`
  - `:1181-1188` `HeartRate` `{HeartRate:int}`
  - `:115-116` 回复通用头 `version`+`command`；`:120` `SetResultToManager`。
  - `:757/:771/:1356/:1739` 携带数据回复示例（CurrentJsRouter / MemoryRefresh / AvoidAreaChanged）。
- `util/LocalSocket.h`、`util/unix/LocalSocket.cpp`、`util/windows/LocalSocket.cpp`
  - unix `:46` `connect()`（Simulator 是 client）。
  - `:74` `ReadData`（`recv`），`:100/130` `WriteData`（发送含结尾 `\0`，长度 `len+1`）。
  - `:119` `operator>>`，`:128` `operator<<`。

### 1.4 图像通道
- `util/WebSocketServer.h` — libwebsockets 服务；`serverHostname="127.0.0.1"`；
  `CheckSid`、`SetSid`、`firstImageBuffer/firstImagebufferSize`、`WriteData`、
  `MAX_PAYLOAD_SIZE=6400000`、`webSocketWritable`。
- `mock/VirtualScreen.h`
  - `:72` `LoadDocType{INIT=3,START=1,FINISHED=2,NORMAL=0}`。
  - `:76` `ProtocolVersion{LOADNORMAL=2,LOADDOC=3,LOADDOCRGBA=4}`。
  - `:78-79` JPEG 像素量级与质量级别。
  - `:127-133` `sendPeriod=40` `pixelSize=4` `headSize=40` `headReservedSize=20`
    `headStart=0x12345678` `protocolVersion` 默认 `LOADNORMAL`。
  - `RgbToJpg` `JudgeAndDropFrame` `JudgeStaticImage` 等帧控接口。
- `mock/lite/VirtualScreenImpl.h`
  - `:59-64` `WriteBuffer<T>`（按 `sizeof(T)` 步进 `currentPos`）。
  - `:74` `VERSION_POS=20`。
  - `:75-80` `regionX1/Y1/Width/Height` 均 `int16_t`。
- `mock/lite/VirtualScreenImpl.cpp`
  - `:84-94` `WriteRefreshRegion`：自 `VERSION_POS` 写 `protocolVersion,regionX1,regionY1,regionWidth,regionHeight`。
  - `:108-116` `InitBuffer`：偏移 0 写 `headStart,origW,origH,compW,compH`。
  - `:118-176` `ScheduleBufferSend`/`Send`/`SendFullBuffer`/`SendRegionBuffer`（含 `RgbToJpg`、`WebSocketServer::WriteData`、首帧缓存）。

### 1.5 启动参数
- `util/CommandParser.cpp` — 参数注册与读取：
  `j`(:333) `n`(:350) `or/cr`(:368) `shape`(:423) `device`(:438) `url`(:453)
  `refresh`(:558) `cm`(:609) `lws`(:654) `s`(:718) `d`(:865) `foldable`(:936) `fr`(:972)。

---

## 2. DevEco 闭源前端（交叉验证）

路径：`/Applications/DevEco-Studio.app/Contents/plugins/openharmony/openharmony-preview-server/`
（同级 `harmony/harmony-preview-server/` 为 HarmonyOS 商用版，结构一致）。

### 2.1 分层结构（实测 `ls`）
- `index.js`（5.5MB，打包后的 Node preview-server）= 编排 + 网关。
- `public/ohpreviewer/`（`index.html` + `static/` + `asset-manifest.json`）= React Web UI。
- `deviceConfigJson/`（`previewConfigV2.json` 等）= 设备配置（分辨率/形状预设）。

### 2.2 `index.js` 关键字命中（`grep -o | uniq -c`，仅作存在性佐证）
- `Simulator`×35、`liteWearable`×25 — 确认 spawn 的就是开源 `Simulator`。
- `-lws`×2、`WebSocketServer`×3、`protocolVersion`×5、`arraybuffer`×2 — 确认图像通道与二进制帧解析。
- 命令名命中：`inspector`×48、`MousePress`×9、`FoldStatus`×10、`ResolutionSwitch`×6、
  `CurrentRouter`×5、`HeartRate`×3、`KeyPress`×1 — 与后端命令表逐一吻合。
- 实测 spawn flag 集合：`-j -n -s -lws -or -cr -cm -url -t -ts -sd -rt -av -x -rp -cjp
  -arp -abs -shape -r -pm -pages -p -o -l -hsp -fr -foldable -refresh -n`。

> 说明：以上仅为「字符串存在性」统计，用于确认官方前端与开源后端走同一协议；
> 不据此推断其内部实现。所有协议细节以 §1 源码为准。

---

## 3. 复现命令（便于回归）

```bash
SRC=ide/tools/previewer

# 命令注册表
grep -n 'typeMap\[' $SRC/cli/CommandLineFactory.cpp

# 帧头常量与字段
grep -nE 'headStart|headSize|VERSION_POS|ProtocolVersion|regionX1|sendPeriod' \
  $SRC/mock/VirtualScreen.h $SRC/mock/lite/VirtualScreenImpl.h $SRC/mock/lite/VirtualScreenImpl.cpp

# 信封校验与分帧
grep -nE 'IsMember\("type"\)|GetCommandType|operator>>|WriteData' \
  $SRC/cli/CommandLineInterface.cpp $SRC/util/unix/LocalSocket.cpp

# 启动参数
grep -nE 'IsSet\("' $SRC/util/CommandParser.cpp
```
