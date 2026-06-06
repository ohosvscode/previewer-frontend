# Preview UI

画面渲染 + 交互采集 + 设备状态面板 + Inspector（替代 DevEco 闭源 `ohpreviewer`）。

详见 [`../docs/architecture.md`](../docs/architecture.md) §3。

## 模块（规划）

| 模块 | 文件（计划） | 职责 |
|------|--------------|------|
| ScreenCanvas | `src/ScreenCanvas.tsx` | 订阅帧流，JPEG→drawImage，region 局部重绘，缩放/HiDPI |
| DeviceFrame | `src/DeviceFrame.tsx` | 设备外观（手表圆/方屏裁剪、表带边框） |
| InputLayer | `src/InputLayer.tsx` | 指针/键盘 → original 坐标 → 交互命令 |
| ControlPanel | `src/ControlPanel.tsx` | 传感器/系统态控件 → `set` 命令 |
| InspectorPanel | `src/InspectorPanel.tsx` | `inspector` 组件树 + 画面高亮 |
| Toolbar | `src/Toolbar.tsx` | 重载/路由/分辨率/内存 |

UI 仅通过 Host 暴露的单一 WebSocket 通信，不感知底层双通道。

## 状态

规划阶段，尚无代码。骨架将在 [`../docs/roadmap.md`](../docs/roadmap.md) 的 **M1** 落地。
