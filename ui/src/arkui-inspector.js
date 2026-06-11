// 独立「ArkUI 组件树检查器（真机）」入口 —— 复用 InspectorPanel，数据源 = 活跃的 arkts-dap 真机调试会话。
// 桥接：InspectorPanel.fetch() → postMessage{fetchDeviceTree} → 扩展 vscode.debug.activeDebugSession
//        .customRequest("getArkUITree") → ConnectServer ArkUI domain → 完整树 → postMessage{deviceTree} → 渲染。
// 真机树 schema（$type/$ID/$rect="[l,t],[r,b]"/$attrs/$children）与 previewer inspector 一致，InspectorPanel 直接吃。

import { InspectorPanel } from "./components/InspectorPanel.js";

const vscode = acquireVsCodeApi();
const panelEl = document.getElementById("panel");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");

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

// transport shim：InspectorPanel.fetch() 发 {command:"inspector"} → 触发真机取树（其它命令在真机模式忽略）。
const transport = {
  send(msg) {
    if (msg && msg.command === "inspector") {
      setStatus("正在从真机抓取组件树…");
      vscode.postMessage({ channel: "fetchDeviceTree" });
    }
  },
};

// 真机无画布可高亮，onSelect 留空——选中节点仍会在右侧展示属性（InspectorPanel 内部处理）。
const inspector = new InspectorPanel(panelEl, transport, { onSelect: () => {} });

refreshBtn.addEventListener("click", () => inspector.fetch());

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.channel === "deviceTree") {
    const meta = m.meta || {};
    const total = countNodes(m.tree);
    setStatus(`✅ windowId=${meta.windowId ?? "?"} · ${total} 节点`, "ok");
    // 复用 InspectorPanel.onEvent 的 inspector 分支（result 为 JSON 字符串）
    inspector.onEvent({ command: "inspector", result: JSON.stringify(m.tree) });
  } else if (m.channel === "deviceError") {
    setStatus("⚠ " + m.message, "error");
  }
});

setStatus("从活跃的 arkts-dap 真机调试会话抓取组件树…");
vscode.postMessage({ channel: "ready" });
inspector.fetch(); // 打开即自动抓一次
