// VsCodeTransport —— 沙箱宿主（VSCode webview）传输，走 acquireVsCodeApi().postMessage。
// 与 WebSocketTransport 同契约（PreviewTransport）。UI 业务代码零改动即可切换。
//
// 与扩展(relay shim) 的约定（见 ../../integrations/vscode/extension.js）：
//   下行（扩展 → webview，window 'message'）:
//     { channel:"frame", bytes:[...]|ArrayBuffer }   —— JPEG 帧
//     { channel:"event", payload:{...} }             —— 命令通道事件/hello
//     { channel:"state", state:"open|closed|error" }
//   上行（webview → 扩展，vscode.postMessage）:
//     { channel:"command", msg:{...} }               —— 透传给 Host 命令

export class VsCodeTransport {
  constructor() {
    this.vscode = globalThis.acquireVsCodeApi();
    this._frameCbs = [];
    this._eventCbs = [];
    this._stateCbs = [];
  }

  onFrame(cb) { this._frameCbs.push(cb); return this; }
  onEvent(cb) { this._eventCbs.push(cb); return this; }
  onState(cb) { this._stateCbs.push(cb); return this; }

  connect() {
    window.addEventListener("message", (e) => {
      const m = e.data || {};
      if (m.channel === "frame") {
        const buf = m.bytes instanceof ArrayBuffer ? m.bytes : new Uint8Array(m.bytes).buffer;
        const blob = new Blob([buf], { type: "image/jpeg" });
        this._frameCbs.forEach((cb) => cb(blob));
      } else if (m.channel === "event") {
        this._eventCbs.forEach((cb) => cb(m.payload));
      } else if (m.channel === "state") {
        this._stateCbs.forEach((cb) => cb(m.state));
      }
    });
    // 告知扩展 webview 就绪，可以开始转发
    this.vscode.postMessage({ channel: "ready" });
    return Promise.resolve();
  }

  /** 上行控制/交互消息 → 扩展转发给 Host。*/
  send(msg) {
    this.vscode.postMessage({ channel: "command", msg });
  }

  close() {
    this.vscode.postMessage({ channel: "close" });
  }
}
