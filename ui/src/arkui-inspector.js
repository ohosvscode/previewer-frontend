// 独立「ArkUI 组件树检查器（真机）」入口 —— 复用 InspectorPanel，数据源 = 活跃的 arkts-dap 真机调试会话。
// 桥接：InspectorPanel.fetch() → postMessage{fetchDeviceTree} → 扩展 vscode.debug.activeDebugSession
//        .customRequest("getArkUITree") → ConnectServer ArkUI domain → 完整树 + 设备截图 → 渲染 + 高亮。
// 真机树 schema（$type/$ID/$rect="[l,t],[r,b]"/$attrs/$children）与 previewer inspector 一致，InspectorPanel 直接吃。
// 点组件树节点 → 在设备截图上叠加高亮该节点的 $rect（与树同一像素坐标系）。

import { InspectorPanel } from "./components/InspectorPanel.js";

const vscode = acquireVsCodeApi();
const panelEl = document.getElementById("panel");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const shotImg = document.getElementById("shot");
const shotHint = document.getElementById("shot-hint");
const hl = document.getElementById("hl");

let snapW = 0; // 截图像素宽（树 $rect 的坐标系），用于高亮缩放
let lastRect = null; // 当前选中节点的 rect，供 resize / 图片 load 后重算掩膜

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "ai-status" + (cls ? " " + cls : "");
}

function countNodes(n) {
  if (!n) return 0;
  let c = 1;
  if (Array.isArray(n.$children)) for (const ch of n.$children) c += countNodes(ch);
  return c;
}

// 选中节点 → 在截图上画高亮框（rect 为 InspectorPanel 解析后的 {x,y,w,h}，设备像素）。
// rect 缓存到 lastRect；resize / 图片 load 后按缓存重算，使掩膜始终对齐缩放后的截图。
function highlightOnShot(rect) {
  lastRect = rect || null;
  if (!rect || !snapW || shotImg.style.display === "none" || !shotImg.clientWidth) {
    hl.style.display = "none";
    return;
  }
  const scale = shotImg.clientWidth / snapW;
  hl.style.display = "block";
  hl.style.left = shotImg.offsetLeft + rect.x * scale + "px";
  hl.style.top = shotImg.offsetTop + rect.y * scale + "px";
  hl.style.width = rect.w * scale + "px";
  hl.style.height = rect.h * scale + "px";
}

// 仅重算位置（不改 lastRect），供 resize / 图片 load 复用。
function rebuildMask() {
  highlightOnShot(lastRect);
}
// 页面大小变化 → 截图随之缩放 → 按当前选中节点重建掩膜（防错位）。
window.addEventListener("resize", rebuildMask);
// 截图真正 load 完才有 clientWidth；load 后重算一次（覆盖"选中早于图片就绪"）。
shotImg.addEventListener("load", rebuildMask);

// transport shim：InspectorPanel.fetch() 发 {command:"inspector"} → 触发真机取树（其它命令在真机模式忽略）。
const transport = {
  send(msg) {
    if (msg && msg.command === "inspector") {
      setStatus("正在从真机抓取组件树…");
      vscode.postMessage({ channel: "fetchDeviceTree" });
    }
  },
};

const inspector = new InspectorPanel(panelEl, transport, { onSelect: highlightOnShot });

refreshBtn.addEventListener("click", () => inspector.fetch());

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.channel === "deviceTree") {
    const meta = m.meta || {};
    const total = countNodes(m.tree);
    setStatus(`✅ windowId=${meta.windowId ?? "?"} · ${total} 节点`, "ok");
    // 设备截图
    hl.style.display = "none";
    if (m.snapshot && m.snapshot.base64) {
      snapW = m.snapshot.width || 0;
      shotImg.src = "data:image/png;base64," + m.snapshot.base64;
      shotImg.style.display = "block";
      shotHint.style.display = "none";
    } else {
      snapW = 0;
      shotImg.style.display = "none";
      shotHint.style.display = "block";
      shotHint.textContent = "（本次未返回设备截图）";
    }
    // 组件树（复用 InspectorPanel.onEvent 的 inspector 分支，result 为 JSON 字符串）
    inspector.onEvent({ command: "inspector", result: JSON.stringify(m.tree) });
  } else if (m.channel === "deviceStatus") {
    setStatus(m.message);
  } else if (m.channel === "deviceError") {
    setStatus("⚠ " + m.message, "error");
  }
});

setStatus("从活跃的 arkts-dap 真机调试会话抓取组件树…");
vscode.postMessage({ channel: "ready" });
inspector.fetch(); // 打开即自动抓一次
