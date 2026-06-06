// Preview UI 入口 —— 接 Transport 与 ScreenCanvas（M1：只读预览）。
// UI 不感知底层双通道/宿主，只依赖 PreviewTransport。

import { createTransport } from "./transport/detect.js";
import { ScreenCanvas } from "./components/ScreenCanvas.js";

const statusEl = document.getElementById("status");
const screen = new ScreenCanvas(document.getElementById("screen"));

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

const transport = createTransport();

let fps = 0;
transport.onFrame((blob) => {
  screen.draw(blob);
  fps++;
});

transport.onEvent((ev) => {
  if (ev && ev.MessageType) {
    console.log("[event]", ev.MessageType, ev.args ?? "");
  }
});

transport.onState((s) => {
  if (s === "open") setStatus("已连接 · 等待画面…", "live");
  else if (s === "closed") setStatus("连接断开，正在重连…", "error");
  else if (s === "error") setStatus("连接错误", "error");
});

// 每秒刷新 FPS / 帧计数
setInterval(() => {
  if (screen.frameCount > 0) {
    setStatus(`● LIVE · ${fps} fps · 累计 ${screen.frameCount} 帧`, "live");
  }
  fps = 0;
}, 1000);

async function connectLoop() {
  for (;;) {
    try {
      await transport.connect();
      return; // onclose 里不会自动重连，这里靠 onState 提示；简单起见重载页面或下方轮询
    } catch {
      setStatus("无法连接 Host，1s 后重试…", "error");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

connectLoop();
