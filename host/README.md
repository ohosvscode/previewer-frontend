# Preview Host

进程编排 + 协议网关（替代 DevEco 闭源 `index.js`）。

**用 Rust 实现，编译为单一静态二进制 `previewer-host`，零运行时依赖**
（理由见 [`../docs/adr/0003-host-in-rust.md`](../docs/adr/0003-host-in-rust.md)）。
详见 [`../docs/architecture.md`](../docs/architecture.md) §2/§5 与 [`../docs/protocol.md`](../docs/protocol.md)。

## 结构（规划）

```
host/
├── Cargo.toml
├── src/
│   ├── main.rs              入口：解析参数 → core + WsGateway
│   ├── core/               不假设 UI 如何连接
│   │   ├── launcher.rs       分配端口/socket名/sid，拼 CLI，spawn 并监控 Simulator
│   │   ├── command_bridge.rs 命令通道 server（interprocess local_socket），JSON `\0` 分帧，请求-响应关联
│   │   ├── frame_relay.rs    图像通道 WS client，解析 40 字节帧头，输出帧
│   │   └── session.rs        组装会话；统一帧/事件下行、控制上行
│   └── gateway/
│       └── ws.rs            唯一对外形态：WebSocket server + 静态托管 ui 产物
└── (沙箱宿主的 relay shim 不在此 crate)
    integrations/vscode/     ↑ 见仓库 integrations，TS 薄扩展：spawn 二进制 + ws↔postMessage 转发
```

建议 crate：`tokio` · `tokio-tungstenite` · `interprocess` · `serde`/`serde_json` ·
`axum`+`tower-http` · `clap`。JPEG 纯透传，无需图像库。

## 状态

规划阶段，尚无代码。第一步见 [`../docs/roadmap.md`](../docs/roadmap.md) 的 **M0 协议探针**。
