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
    canvas.width = hello.width;   // 原始分辨率（渲染清晰 + 坐标映射正确）
    canvas.height = hello.height;
    // 显示尺寸按最大高度缩放适配（手机 1080x2340 不能 1:1 显示）
    const MAX_H = 620;
    const scale = Math.min(1, MAX_H / hello.height);
    canvas.style.width = Math.round(hello.width * scale) + "px";
    canvas.style.height = Math.round(hello.height * scale) + "px";
  }

  panelEl.innerHTML = "";
  if (!hello.isLite) {
    // 点击组件树节点 → 在画布上高亮该元素（节点带 $rect 时；实时树需 arkts-dap attach）
    inspector = new InspectorPanel(panelEl, transport, {
      onSelect: (rect) => screen.highlight(rect),
    });
  }
  if (hello.isLite) new ControlPanel(panelEl, transport);

  new Toolbar(toolbarEl, transport, {
    isLite: hello.isLite,
    device: hello.device,
    debug: hello.debug,
    cdpPort: hello.cdpPort,
    url: hello.url || "pages/index/index",
    onInspect: inspector ? () => inspector.fetch() : null,
    onReconnect: () => transport.connect().catch(() => {}),
  });

  // 调试模式：画面要等调试器 attach 并继续后才渲染（运行时启动即阻塞）
  if (hello.debug && screen.frameCount === 0) {
    setStatus(`🐞 等待调试器 attach（arkts-dap --cdp-port ${hello.cdpPort}）后画面才会出现`, "error");
  }
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
  // 应用未捕获异常（host 解析 Simulator 日志合成）→ 显著提示，否则只表现为白屏/空树
  if (ev.type === "appError") { showAppError(ev); return; }
  if (inspector && inspector.onEvent(ev)) return;
  if (ev.MessageType) console.log("[event]", ev.MessageType, ev.args ?? "");
  else if (ev.command) console.log("[result]", ev.command, ev.result ?? "");
});

let appCrashed = false;
function showAppError(ev) {
  appCrashed = true;
  const msg = ev.message || "未捕获异常";
  setStatus("⚠ 应用异常：" + msg, "error");
  console.error("[appError]", msg, ev.stack || []);
  // 在侧栏/状态下方挂一个可见的错误块（含调用栈），并标注「画面/组件树为空多因此异常」
  let box = document.getElementById("app-error");
  if (!box) {
    box = document.createElement("div");
    box.id = "app-error";
    box.className = "app-error";
    (panelEl || statusEl.parentElement).prepend(box);
  }
  const stack = (ev.stack || []).map((s) => "  at " + s).join("\n");
  box.textContent = "⚠ 应用未捕获异常（画面/组件树为空多因此）：\n" + msg + (stack ? "\n" + stack : "");
}

transport.onState((s) => {
  if (s === "open") { connected = true; if (!dead) setStatus("已连接 · 等待画面…", "live"); }
  else if (s === "closed") { connected = false; if (!dead) setStatus("连接断开，重连中…", "error"); }
  else if (s === "error") { connected = false; if (!dead) setStatus("连接错误，重连中…", "error"); }
});

// 状态文案：仅在连接中、有帧且 Simulator 存活且应用未崩时显示 LIVE（finding #5）
setInterval(() => {
  if (connected && !dead && !appCrashed && screen.frameCount > 0) {
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
