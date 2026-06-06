// Preview UI 入口 —— 装配 Transport 与各组件，按 hello 的设备能力自适应。
// UI 不感知底层双通道/宿主，只依赖 PreviewTransport。

import { createTransport } from "./transport/detect.js";
import { ScreenCanvas } from "./components/ScreenCanvas.js";
import { InputLayer } from "./components/InputLayer.js";
import { Toolbar } from "./components/Toolbar.js";
import { ControlPanel } from "./components/ControlPanel.js";
import { InspectorPanel } from "./components/InspectorPanel.js";

const statusEl = document.getElementById("status");
const canvas = document.getElementById("screen");
const deviceEl = document.getElementById("device");
const toolbarEl = document.getElementById("toolbar");
const panelEl = document.getElementById("panel");

const screen = new ScreenCanvas(canvas);
const transport = createTransport();
new InputLayer(canvas, transport);

let inspector = null;
let built = false;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

// 收到 hello 后按设备能力构建 UI（只构建一次）
function buildUI(hello) {
  if (built) return;
  built = true;

  // 设备外观
  deviceEl.className = "device " + (hello.shape === "rect" ? "device--rect" : "device--circle");
  if (hello.width && hello.height) {
    canvas.width = hello.width;
    canvas.height = hello.height;
    canvas.style.width = hello.width + "px";
    canvas.style.height = hello.height + "px";
  }

  panelEl.innerHTML = "";
  if (!hello.isLite) {
    inspector = new InspectorPanel(panelEl, transport);
  }
  // 设备状态面板：lite 传感器集（rich 暂复用占位）
  if (hello.isLite) new ControlPanel(panelEl, transport);

  new Toolbar(toolbarEl, transport, {
    isLite: hello.isLite,
    device: hello.device,
    url: hello.url || "pages/index/index",
    onInspect: inspector ? () => inspector.fetch() : null,
    onReconnect: () => transport.connect().catch(() => {}),
  });
}

let fps = 0;
transport.onFrame((blob) => {
  screen.draw(blob);
  fps++;
});

transport.onEvent((ev) => {
  if (ev && ev.type === "hello") {
    buildUI(ev);
    return;
  }
  if (inspector && inspector.onEvent(ev)) return;
  if (ev && ev.MessageType) console.log("[event]", ev.MessageType, ev.args ?? "");
  else if (ev && ev.command) console.log("[result]", ev.command, ev.result ?? "");
});

transport.onState((s) => {
  if (s === "open") setStatus("已连接 · 等待画面…", "live");
  else if (s === "closed") setStatus("连接断开，点 ⟲ 重连", "error");
  else if (s === "error") setStatus("连接错误", "error");
});

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
      return;
    } catch {
      setStatus("无法连接 Host，1s 后重试…", "error");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

connectLoop();
