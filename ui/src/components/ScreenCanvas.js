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
    this._hl = null; // 高亮覆盖框（Inspector 点击定位用）
  }

  /**
   * 在画布上高亮一个矩形（设备/渲染分辨率坐标），用于 Inspector「点击节点定位元素」。
   * @param {{x:number,y:number,w:number,h:number}|null} rect 传 null 清除高亮
   */
  highlight(rect) {
    if (!rect) return this.clearHighlight();
    const parent = this.canvas.offsetParent || this.canvas.parentElement;
    if (!parent) return;
    if (!this._hl) {
      this._hl = document.createElement("div");
      this._hl.className = "inspect-hl";
      parent.appendChild(this._hl);
    }
    // 渲染分辨率 → 显示像素：按 canvas 实际显示宽度比例缩放，加 canvas 在父容器内的偏移（表盘边框内嵌）。
    const scale = (this.canvas.clientWidth || this.canvas.width) / this.canvas.width;
    const s = this._hl.style;
    s.left = Math.round(this.canvas.offsetLeft + rect.x * scale) + "px";
    s.top = Math.round(this.canvas.offsetTop + rect.y * scale) + "px";
    s.width = Math.max(1, Math.round(rect.w * scale)) + "px";
    s.height = Math.max(1, Math.round(rect.h * scale)) + "px";
    s.display = "block";
  }

  clearHighlight() {
    if (this._hl) this._hl.style.display = "none";
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
