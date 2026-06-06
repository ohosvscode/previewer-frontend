// detect —— 按宿主自动选择 Transport（见 ADR 0002/0003）。
//   VSCode webview（注入 acquireVsCodeApi）→ VsCodeTransport（postMessage，remote/web 也可用）
//   其它（浏览器/独立 webview）→ WebSocketTransport（默认通用）

import { WebSocketTransport } from "./WebSocketTransport.js";
import { VsCodeTransport } from "./VsCodeTransport.js";

export function createTransport() {
  if (typeof globalThis.acquireVsCodeApi === "function") {
    console.log("[transport] VSCode webview → VsCodeTransport");
    return new VsCodeTransport();
  }
  return new WebSocketTransport();
}
