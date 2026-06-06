// VsCodeTransport —— 沙箱宿主（VSCode webview）传输，走 acquireVsCodeApi().postMessage。
// 与 WebSocketTransport 同契约（PreviewTransport）。UI 业务代码零改动即可切换。
//
// 与扩展(relay shim) 的约定（见 ../../integrations/vscode/extension.js）：
//   下行（扩展 → webview，window 'message'）:
//     { channel:"frame", bytes:[...]|ArrayBuffer }   —— JPEG 帧
//     { channel:"event", payload:{...} }             —— 命令通道事件/hello
//     { channel:"state", state:"open|closed|error" }
//   上行（webview → 扩展，vscode.postMessage）:
//     { channel:"ready" }                            —— 监听器就绪，扩展据此再连 WS（finding #1）
//     { channel:"reconnect" }                        —— 请求扩展重连底层 WS（finding #4）
//     { channel:"command", msg:{...} }               —— 透传给 Host 命令
//     { channel:"close" }

export class VsCodeTransport {
  constructor() {
    this.vscode = globalThis.acquireVsCodeApi();
    this._frameCbs = [];
    this._eventCbs = [];
    this._stateCbs = [];
    this._connected = false;

    // 监听器只注册一次（finding #3：避免每次 connect 重复挂载、内存泄漏与重复投递）
    this._onMsg = (e) => {
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
    };
    window.addEventListener("message", this._onMsg);
  }

  onFrame(cb) { this._frameCbs.push(cb); return this; }
  onEvent(cb) { this._eventCbs.push(cb); return this; }
  onState(cb) { this._stateCbs.push(cb); return this; }

  connect() {
    if (!this._connected) {
      // 首连：告知扩展 webview 就绪，扩展据此再连底层 WS（避免帧/hello 抢跑，finding #1）
      this._connected = true;
      this.vscode.postMessage({ channel: "ready" });
    } else {
      // 再次调用 = 用户点 ⟲ 重连：请求扩展重连 WS（finding #4）
      this.vscode.postMessage({ channel: "reconnect" });
    }
    return Promise.resolve();
  }

  send(msg) {
    this.vscode.postMessage({ channel: "command", msg });
  }

  close() {
    this.vscode.postMessage({ channel: "close" });
    window.removeEventListener("message", this._onMsg);
  }
}
