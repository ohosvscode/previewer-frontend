// detect —— 按宿主自动选择 Transport（见 ADR 0002）。
// 当前：VSCode webview（注入 acquireVsCodeApi）→ 预留 VsCodeTransport；否则默认 WebSocketTransport。

import { WebSocketTransport } from "./WebSocketTransport.js";

export function createTransport() {
  // VSCode webview 会注入全局 acquireVsCodeApi
  if (typeof globalThis.acquireVsCodeApi === "function") {
    // M5：return new VsCodeTransport();
    console.warn("[transport] 检测到 VSCode 宿主，但 VsCodeTransport 尚未实现（M5），回退 WebSocket");
  }
  return new WebSocketTransport();
}
