// ScreenCanvas —— 把帧流（JPEG Blob）绘制到 canvas。
// 维度从 JPEG 自身解码得到（createImageBitmap），分辨率变化自动适配。
// 单飞：同一时刻只解码一帧，解码期间到达的帧只保留最新，避免乱序覆盖与解码积压（finding #12）。

export class ScreenCanvas {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.frameCount = 0;
    this._decoding = false;
    this._pending = null;
  }

  /** @param {Blob} blob JPEG 帧 */
  draw(blob) {
    this._pending = blob; // 始终记录最新待绘帧
    if (this._decoding) return;
    this._pump();
  }

  async _pump() {
    this._decoding = true;
    try {
      while (this._pending) {
        const blob = this._pending;
        this._pending = null;
        let bmp;
        try {
          bmp = await createImageBitmap(blob);
        } catch (e) {
          console.error("[screen] 解码帧失败", e);
          continue;
        }
        if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
          this.canvas.width = bmp.width;
          this.canvas.height = bmp.height;
        }
        this.ctx.drawImage(bmp, 0, 0);
        bmp.close();
        this.frameCount++;
      }
    } finally {
      this._decoding = false;
    }
  }
}
