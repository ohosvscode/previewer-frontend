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

- **InspectorPanel**：✅ 已实现并实跑（rich/phone）。`inspector`（实时树）standalone 返回空（需 ArkTS
  调试器，DevEco 基建），故前端自动回退 `inspectorDefault`（默认组件目录，~63KB），实测渲染成功。
- **健壮性**（经评审加固）：✅ 图像通道断线自动重连（退避）+ UI WebSocketTransport 自动重连；
  ✅ **Simulator 崩溃检测**（监控任务 reap + shutdown 传播 → Host 优雅退出 + UI 显示「已退出」，实测）；
  ✅ 子进程 `kill_on_drop` + `Session::Drop` 清理 socket 文件；✅ 帧背压 `watch` 丢旧帧 + 单飞解码；
  ✅ 命令累积/单帧大小上限（防 DoS）；✅ 非回环绑定告警。
- ◻ Simulator 崩溃**自动重启**（当前为优雅退出；重启需重绑端点）：Backlog。
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

## M6 — rich 形态（phone/Stage）✅ 已完成（2026-06-06）

驱动 `common/bin/Previewer`（rich 二进制）渲染 phone Stage 应用，解锁 rich 专属能力。

产出：
- `launcher`：非 lite 设备追加 `-pm <FA|Stage>` `-arp` `-pages` `-projectID`；`--sim` 指向
  `common/bin/Previewer`（cwd 自动取其父目录，rpath/字体就位）。
- `main`：新增 `--project-model` `--arp` `--pages`；`hello.isLite=false` → UI 自动切 rich 工具栏。
- `ui`：phone 显示按最大高度缩放（1080×2340 不 1:1）；InspectorPanel `inspector`→`inspectorDefault` 回退。

**验收**（真实浏览器）：✅ phone 1080×2340 渲染 LIVE；✅ rich 工具栏 重载/返回/深色/Inspector 全部
被后端接受（非 Unsupported，日志确认 Create Command）；✅ Inspector 渲染组件树（inspectorDefault）。

运行：
```bash
APPB=<工程>/entry/build/default/intermediates
cargo run --bin previewer-host -- \
  --sim <SDK>/previewer/common/bin/Previewer \
  --app $APPB/loader_out/default --device phone --shape rect --width 1080 --height 2340 \
  --project-model Stage --arp $APPB/res/default \
  --pages $APPB/res/default/resources/base/profile/main_pages.json --url pages/Index --bundle entry
```

---

## M7 — 与 arkts-dap 集成（一键预览+调试 + 实时 Inspector）✅ 已完成（2026-06-10）

目标：一个 Previewer 进程同时服务「浏览器实时预览」与「断点调试」，并解锁实时组件树。

产出：
- `launcher`/`main`：新增 `--debug --cdp-port --debug-module --debug-ability --ljpath`。
  debug 模式给 Previewer 加 `-d -p <cdpPort> -abn -abp@normalized -ljPath`（启动配置见
  `../../arkts-dap/scripts/run-debug-target.sh`，已实测命中断点）。
- `hello` 暴露 `debug`/`cdpPort`；UI 显示 🐞 调试徽章 + attach 提示 + 「等待调试器」状态。
- `scripts/preview-and-debug.sh`：一键启动（host --debug + 打印 arkts-dap attach 命令）。

架构（两条独立通道，互不干扰、共用同一 Previewer）：
```
previewer-host  ──命令通道+图像通道──►  浏览器 UI（预览/交互/Inspector）
arkts-dap/VSCode ──CDP(:cdpPort)──►  同一个 Previewer（断点调试）
```

**验收**（真实浏览器 + arkts-dap）：✅ host --debug 启动 → Previewer 阻塞等调试器；
arkts-dap attach + continue → 浏览器渲染真实应用（Hello World, 1080×2340）+ 🐞 调试 :29902 徽章；
✅ **实时 Inspector 可用**（debug 模式下 `inspector` 返回真实 live 树 `{$type:root,...}`，非 fallback；
应用稳定运行态不再崩溃——此前崩溃是查询时机在 continue 中途的不稳定态）；
✅ 断点调试与预览共存（命令/图像通道 vs CDP 通道互不干扰）。

注意：debug 模式运行时启动即阻塞，画面要等调试器 attach 并 continue 过 break-on-start 后才出现。

---

## 复杂工程实测（sample_in_harmonyos / HMS World, 2026-06-10）

用 3.6MB 多模块 HarmonyOS 工程（products: phone/pc/tv/wearable + 8 个 feature HAR）实测：
- ✅ 用 DevEco 工具链 CLI 构建出预览产物（`ohpm install` + `hvigorw assembleHap` → 多模块 modules.abc + loader/res）。
- ✅ 工具链驱动复杂 app：previewer-host 连通命令/图像通道、渲染帧、浏览器 LIVE。
- ✅ **发现并修复真实缺陷**：`-ljPath`（pkgContextInfo）此前仅调试模式传，多模块工程的跨模块 ohmurl
  解析在普通预览也必需 → 已改为「提供即传」（`launcher.rs`）。
- ✅ arkts-dap 调试设施在复杂 app 上工作：attach、多模块 scriptParsed（url 如 `phone|@ohos/common|1.0.0|...`）、
  break-on-start、调用栈、continue。
- ⚠️ 完整 UI 渲染 + 具体行断点命中受 **HMS @kit 解析** 牵制：app 依赖 `@kit.UIDesignKit`(HdsNavigation)
  等系统 HSP，需 DevEco 的 HMS previewer 合成（systemHsp + module + apiMock，SDK 只读、为 DevEco 专有多步胶水）。
  ——这是 previewer/SDK 合成问题，非工具链缺陷（工具链正确驱动 previewer 产出的一切）。

## 后续（Backlog）

- HMS 应用完整渲染：复刻 DevEco HMS previewer 合成（合并 HMS `module`/`systemHsp`/`apiMock` + `-hsp`/`-ilt` 参数）。
- rich 其它形态（tablet/tv/car/2in1，分辨率/shape 不同）+ FA rich。
- 实时组件树更深（当前 live 树仅 root 层；深层遍历待 previewer 支持）+ 画面节点高亮联动。
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
