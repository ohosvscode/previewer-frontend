# Preview Host

进程编排 + 协议网关（替代 DevEco 闭源 `index.js`）。

详见 [`../docs/architecture.md`](../docs/architecture.md) §2 与
[`../docs/protocol.md`](../docs/protocol.md)。

## 结构（规划）

拆为**运行时无关的 core** 与**可插拔 gateway**（理由见
[`../docs/adr/0002-portable-transport-and-gateway.md`](../docs/adr/0002-portable-transport-and-gateway.md)）。

```
host/
├── src/
│   ├── core/                 运行时无关，不假设 UI 如何连接
│   │   ├── launcher.ts        分配端口/socket名/sid，拼 CLI，spawn 并监控 Simulator
│   │   ├── command-bridge.ts  命令通道 server（domain socket/命名管道），JSON `\0` 分帧，请求-响应关联
│   │   ├── frame-relay.ts     图像通道 WS client，解析 40 字节帧头，输出帧事件
│   │   └── session.ts         组装会话；暴露 onFrame/onEvent/postControl/dispose
│   ├── gateways/             可插拔，配对 UI Transport
│   │   ├── ws-gateway.ts       WebSocket server + 静态托管 ui 产物（浏览器/独立 webview）
│   │   └── embed-gateway.ts    进程内回调接口（供宿主接到自己的 IPC，如 VSCode postMessage）
│   └── bin/
│       └── cli.ts            独立入口：core + ws-gateway
└── integrations/
    └── vscode/               薄 VSCode 扩展：core + embed-gateway，桥接 webview postMessage
```

## 状态

规划阶段，尚无代码。第一步见 [`../docs/roadmap.md`](../docs/roadmap.md) 的 **M0 协议探针**。
