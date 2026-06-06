// InputLayer —— 把画布上的指针/滚轮事件换算成 original 坐标，发交互命令。
// 坐标系：显示尺寸 → 画布原始分辨率（见 ../../docs/protocol.md §3.5 交互注入）。

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class InputLayer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{send:(m:object)=>void}} transport
   */
  constructor(canvas, transport) {
    this.canvas = canvas;
    this.transport = transport;
    this.pressed = false;

    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", (e) => {
      this.pressed = true;
      canvas.setPointerCapture?.(e.pointerId);
      this._send("MousePress", e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.pressed) this._send("MouseMove", e);
    });
    const release = (e) => {
      if (this.pressed) {
        this._send("MouseRelease", e);
        this.pressed = false;
      }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    // 滚轮 → 表冠旋转
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.transport.send({
          type: "command",
          command: "CrownRotate",
          cmdType: "action",
          args: { rotate: e.deltaY },
        });
      },
      { passive: false }
    );
  }

  _coords(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * this.canvas.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * this.canvas.height);
    return {
      x: clamp(x, 0, this.canvas.width - 1),
      y: clamp(y, 0, this.canvas.height - 1),
    };
  }

  _send(command, e) {
    const { x, y } = this._coords(e);
    this.transport.send({ type: "command", command, cmdType: "action", args: { x, y } });
  }
}
