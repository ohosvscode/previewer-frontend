// WebSocketTransport —— 默认/通用传输（浏览器、独立 webview）。
// 实现 PreviewTransport 契约（见 ../../docs/architecture.md §5.2）：
//   connect() / send(msg) / onFrame(cb) / onEvent(cb) / close()
// 下行：二进制帧 = JPEG（Blob，直接交给 createImageBitmap）；文本 = 事件 JSON。
// 上行：控制/交互 JSON（M2）。

export class WebSocketTransport {
  /** @param {string} [url] 默认同源 /ws */
  constructor(url) {
    const auto =
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.url = url || auto;
    this.ws = null;
    this._frameCbs = [];
    this._eventCbs = [];
    this._stateCbs = [];
  }

  onFrame(cb) { this._frameCbs.push(cb); return this; }
  onEvent(cb) { this._eventCbs.push(cb); return this; }
  onState(cb) { this._stateCbs.push(cb); return this; }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "blob";
      this.ws = ws;

      ws.onopen = () => { this._emitState("open"); resolve(); };
      ws.onerror = (e) => { this._emitState("error"); reject(e); };
      ws.onclose = () => { this._emitState("closed"); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let v;
          try { v = JSON.parse(ev.data); } catch { return; }
          this._eventCbs.forEach((cb) => cb(v));
        } else {
          // Blob（JPEG 帧）
          this._frameCbs.forEach((cb) => cb(ev.data));
        }
      };
    });
  }

  /** 上行控制/交互消息（M2）。*/
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  close() { this.ws && this.ws.close(); }

  _emitState(s) { this._stateCbs.forEach((cb) => cb(s)); }
}
