# Preview UI

画面渲染 + 交互采集 + 设备状态面板 + Inspector（替代 DevEco 闭源 `ohpreviewer`）。

详见 [`../docs/architecture.md`](../docs/architecture.md) §3。

## 结构（规划）

纯 Web 产物，**可在任意 webview 移植**。所有功能模块只依赖 `PreviewTransport` 接口，
不直接接触 socket / 宿主 API（移植接缝见
[`../docs/adr/0002-portable-transport-and-gateway.md`](../docs/adr/0002-portable-transport-and-gateway.md)）。

```
ui/
└── src/
    ├── transport/            移植接缝：UI 够到 Host 的唯一抽象
    │   ├── Transport.ts        PreviewTransport 接口 + 消息类型
    │   ├── WebSocketTransport.ts  浏览器/独立 webview（默认）
    │   ├── VsCodeTransport.ts     VSCode webview（acquireVsCodeApi postMessage）
    │   ├── PostMessageTransport.ts 通用 iframe 嵌入
    │   └── detect.ts           按宿主自动选择 Transport
    └── components/
        ├── ScreenCanvas.tsx    订阅帧流，JPEG→drawImage，region 局部重绘，缩放/HiDPI
        ├── DeviceFrame.tsx     设备外观（手表圆/方屏裁剪、表带边框）
        ├── InputLayer.tsx      指针/键盘 → original 坐标 → 交互命令
        ├── ControlPanel.tsx    传感器/系统态控件 → `set` 命令
        ├── InspectorPanel.tsx  `inspector` 组件树 + 画面高亮
        └── Toolbar.tsx         重载/路由/分辨率/内存
```

UI 不感知底层双通道、字节序与宿主差异；换宿主只需选/实现一个 Transport。

## 状态

规划阶段，尚无代码。骨架将在 [`../docs/roadmap.md`](../docs/roadmap.md) 的 **M1** 落地
（含 `WebSocketTransport`）；VSCode 适配见 **M5**。
