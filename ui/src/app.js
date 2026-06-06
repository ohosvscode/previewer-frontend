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
// 首帧到达后才允许发交互坐标（finding #15）
new InputLayer(canvas, transport, () => screen.frameCount > 0);

let inspector = null;
let built = false;
let connected = false;
let dead = false; // Simulator 已退出

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

function buildUI(hello) {
  if (built) return;
  built = true;

  deviceEl.className = "device " + (hello.shape === "rect" ? "device--rect" : "device--circle");
  if (hello.width && hello.height) {
    canvas.width = hello.width;
    canvas.height = hello.height;
    canvas.style.width = hello.width + "px";
    canvas.style.height = hello.height + "px";
  }

  panelEl.innerHTML = "";
  if (!hello.isLite) inspector = new InspectorPanel(panelEl, transport);
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
  if (!ev) return;
  if (ev.type === "hello") { dead = false; buildUI(ev); return; }
  if (ev.type === "simulatorExited") { dead = true; setStatus("⚠ Simulator 已退出", "error"); return; }
  if (inspector && inspector.onEvent(ev)) return;
  if (ev.MessageType) console.log("[event]", ev.MessageType, ev.args ?? "");
  else if (ev.command) console.log("[result]", ev.command, ev.result ?? "");
});

transport.onState((s) => {
  if (s === "open") { connected = true; if (!dead) setStatus("已连接 · 等待画面…", "live"); }
  else if (s === "closed") { connected = false; if (!dead) setStatus("连接断开，重连中…", "error"); }
  else if (s === "error") { connected = false; if (!dead) setStatus("连接错误，重连中…", "error"); }
});

// 状态文案：仅在连接中、有帧且 Simulator 存活时显示 LIVE（finding #5）
setInterval(() => {
  if (connected && !dead && screen.frameCount > 0) {
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
