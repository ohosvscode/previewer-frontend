# Preview Host

进程编排 + 协议网关（替代 DevEco 闭源 `index.js`）。

详见 [`../docs/architecture.md`](../docs/architecture.md) §2 与
[`../docs/protocol.md`](../docs/protocol.md)。

## 模块（规划）

| 模块 | 文件（计划） | 职责 |
|------|--------------|------|
| Launcher | `src/launcher.ts` | 分配端口/socket名/sid，拼 CLI，spawn 并监控 Simulator |
| CommandBridge | `src/command-bridge.ts` | 命令通道 server（domain socket/命名管道），JSON `\0` 分帧，请求-响应关联 |
| FrameRelay | `src/frame-relay.ts` | 图像通道 WS client，解析 40 字节帧头，输出帧事件 |
| UIGateway | `src/ui-gateway.ts` | 对 UI 的单一 WS + 静态托管，双向翻译 |

## 状态

规划阶段，尚无代码。第一步见 [`../docs/roadmap.md`](../docs/roadmap.md) 的 **M0 协议探针**。
