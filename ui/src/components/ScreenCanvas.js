// ScreenCanvas —— 把帧流（JPEG Blob）绘制到 canvas。
// 维度从 JPEG 自身解码得到（createImageBitmap），分辨率变化自动适配。

export class ScreenCanvas {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.frameCount = 0;
  }

  /** @param {Blob} blob JPEG 帧 */
  async draw(blob) {
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      console.error("[screen] 解码帧失败", e);
      return;
    }
    if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
      this.canvas.width = bmp.width;
      this.canvas.height = bmp.height;
    }
    this.ctx.drawImage(bmp, 0, 0);
    bmp.close();
    this.frameCount++;
  }
}
