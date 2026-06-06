# ADR 0001 — Host / UI 两组件拆分，Host 作协议网关

- 状态：已接受（技术栈部分由 [ADR 0003](0003-host-in-rust.md) 修订：Host 改 Rust）
- 日期：2026-06-06

## 背景

需要为开源 `Simulator` 后端复刻一个前端。DevEco 的实现天然分成 preview-server
（`index.js`）与 Web UI（`ohpreviewer`）两层。后端暴露两条异构通道：
命令通道（LocalSocket/JSON，Simulator 为 client）与图像通道（WebSocket/二进制，
Simulator 为 server），且带 sid 鉴权、字节序敏感、平台相关（domain socket vs 命名管道）。

## 决策

1. 拆成 **Preview Host**（Node/TS）与 **Preview UI**（React/TS）两个组件。
2. **Host 作为唯一协议网关**：它建命令通道 server、作图像通道 client、解析帧头、
   翻译命令；对 UI 只暴露**单一 WebSocket**（帧 + 事件 + 控制）。

## 理由

- UI 不接触原生 socket / 命名管道 / 字节序 / sid，浏览器内即可运行，调试简单。
- 通道方向不对称、平台差异、鉴权都收敛在 Host 一处，UI 跨设备形态可复用。
- 与官方分层一致，未来若要嵌入 IDE WebView 不需重构。

## 取舍

- 多一跳转发（Simulator→Host→UI）带来极小延迟；本地回环可忽略，换来解耦与可测性，值得。
- 也考虑过 UI 直连 Simulator 的 WebSocket（去掉 Host）：被否决——命令通道是 domain
  socket / 命名管道，浏览器无法直接访问，且 sid/字节序处理放进 UI 会污染前端。

## 影响

- Host 需分别实现 unix / windows 的命令通道 server。
- Host↔UI 的内部 WS 协议可自行设计（建议：二进制帧用 jpeg blob + 文本元数据；
  控制/事件用 JSON），不必照搬 Simulator 的字节格式。
