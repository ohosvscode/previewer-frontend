// WebSocketTransport —— 默认/通用传输（浏览器、独立 webview）。
// 实现 PreviewTransport 契约（见 ../../docs/architecture.md §5.2）：
//   connect() / send(msg) / onFrame(cb) / onEvent(cb) / close()
// 下行：二进制帧 = JPEG（Blob，直接交给 createImageBitmap）；文本 = 事件 JSON。
// 上行：控制/交互 JSON。断线自动重连（退避），手动 close() 不重连。

export class WebSocketTransport {
  /** @param {string} [url] 默认同源 /ws */
  constructor(url) {
    const auto = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.url = url || auto;
    this.ws = null;
    this._frameCbs = [];
    this._eventCbs = [];
    this._stateCbs = [];
    this._manualClose = false;
    this._backoff = 500;
    this._reconnectTimer = null;
  }

  onFrame(cb) { this._frameCbs.push(cb); return this; }
  onEvent(cb) { this._eventCbs.push(cb); return this; }
  onState(cb) { this._stateCbs.push(cb); return this; }

  connect() {
    return new Promise((resolve, reject) => {
      this._manualClose = false;
      this._teardown(); // 清理旧连接，避免陈旧 ws 继续投递帧/翻转状态（finding #14）

      const ws = new WebSocket(this.url);
      ws.binaryType = "blob";
      this.ws = ws;

      ws.onopen = () => { this._backoff = 500; this._emitState("open"); resolve(); };
      ws.onerror = (e) => { this._emitState("error"); reject(e); };
      ws.onclose = () => {
        this._emitState("closed");
        if (!this._manualClose) this._scheduleReconnect(); // 自动重连（finding #13）
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          let v;
          try { v = JSON.parse(ev.data); } catch { return; }
          this._eventCbs.forEach((cb) => cb(v));
        } else {
          this._frameCbs.forEach((cb) => cb(ev.data));
        }
      };
    });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
  }

  close() {
    this._manualClose = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._teardown();
  }

  _teardown() {
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {}); // 失败会再次触发 onclose → 再排程
    }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, 5000);
  }

  _emitState(s) { this._stateCbs.forEach((cb) => cb(s)); }
}
