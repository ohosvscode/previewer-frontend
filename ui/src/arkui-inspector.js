// 独立「ArkUI 组件树检查器（真机）」入口 —— 复用 InspectorPanel，数据源 = 活跃的 arkts-dap 真机调试会话。
// 桥接：InspectorPanel.fetch() → postMessage{fetchDeviceTree} → 扩展 vscode.debug.activeDebugSession
//        .customRequest("getArkUITree") → ConnectServer ArkUI domain → 完整树 + 设备截图 → 渲染 + 高亮。
// 真机树 schema（$type/$ID/$rect="[l,t],[r,b]"/$attrs/$children）与 previewer inspector 一致，InspectorPanel 直接吃。
// 点组件树节点 → 在设备截图上叠加高亮该节点的 $rect（与树同一像素坐标系）。

import { InspectorPanel, parseRect } from "./components/InspectorPanel.js";

const vscode = acquireVsCodeApi();
const panelEl = document.getElementById("panel");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const shotImg = document.getElementById("shot");
const shotHint = document.getElementById("shot-hint");
const hl = document.getElementById("hl");
const mode3dBtn = document.getElementById("mode3d");
const wrap2d = document.getElementById("wrap2d");
const scene3d = document.getElementById("scene3d");
const stage3d = document.getElementById("stage3d");

let snapW = 0; // 截图像素宽（树 $rect 的坐标系），用于高亮缩放
let snapH = 0;
let snapUrl = null; // 截图 blob URL（3D 每层贴切片复用，避免 base64 内联 968 次爆内存）
let perComp = null; // Map<id, blobUrl>：ArkUI.tree.3D 的逐组件渲染图（含遮挡/滚动外内容）
let perCompUrls = []; // 待 revoke 的逐组件图 URL
let layers3dFetched = false; // 本树是否已请求过逐组件图

// base64 → Blob（PNG）。用于把整张截图建成一个 object URL，被所有 3D 层共享。
function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
let lastRect = null; // 当前选中节点的 rect，供 resize / 图片 load 后重算掩膜
let deviceTree = null; // 当前完整树根（原始 $type/$rect），供「点截图 → 反查节点」hit-test

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

// hit-test：在树里找**包含**点 (px,py) 的、面积最小（即最深/最具体）的节点 $ID。
function hitTest(node, px, py, best) {
  const r = parseRect(node.$rect);
  if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
    const area = r.w * r.h;
    if (!best || area <= best.area) best = { id: node.$ID, area };
  }
  if (Array.isArray(node.$children)) {
    for (const c of node.$children) best = hitTest(c, px, py, best);
  }
  return best;
}

// 点设备截图 → 换算到设备像素 → hit-test 反查节点 → 在树里选中它（DevEco 同款）。
shotImg.addEventListener("click", (e) => {
  if (!deviceTree || !snapW || shotImg.style.display === "none") return;
  const box = shotImg.getBoundingClientRect();
  const scale = shotImg.clientWidth / snapW;
  const px = (e.clientX - box.left) / scale;
  const py = (e.clientY - box.top) / scale;
  const hit = hitTest(deviceTree, px, py, null);
  if (hit && hit.id != null) inspector.selectById(hit.id);
});

// transport shim：InspectorPanel.fetch() 发 {command:"inspector"} → 触发真机取树（其它命令在真机模式忽略）。
const transport = {
  send(msg) {
    if (msg && msg.command === "inspector") {
      setStatus("正在从真机抓取组件树…");
      vscode.postMessage({ channel: "fetchDeviceTree" });
    }
  },
};

let selectedId = null; // 当前选中节点 id（2D/3D 联动 + 切模式保持）

// 选中联动：2D 截图高亮 + 3D 标记选中层。
function onNodeSelect(rect, node) {
  selectedId = node && node.id != null ? node.id : null;
  highlightOnShot(rect);
  mark3dSelected(selectedId);
}

const inspector = new InspectorPanel(panelEl, transport, { onSelect: onNodeSelect });

refreshBtn.addEventListener("click", () => inspector.fetch());

// ─────────────── 3D 分层视图 ───────────────
// 每个节点按 $rect 定位、按树深度沿 Z 轴拉开，透视旋转；拖拽旋转、滚轮缩放、点层选中。
let is3d = false;
let built3d = false;
let rotX = 8, rotY = -32, zoom = 1; // 初始视角（近似 DevEco 3D Layers）

function applyStage() {
  stage3d.style.transform =
    `translate(-50%, -50%) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(${zoom})`;
}

function build3D() {
  stage3d.innerHTML = "";
  if (!deviceTree || !snapW) return;
  const s = 220 / snapW; // 显示缩放（设备宽 → ~220px）
  const gap = 16; // 每层深度的 Z 间距
  stage3d.style.width = snapW * s + "px";
  stage3d.style.height = snapH * s + "px";
  const frag = document.createDocumentFragment();
  const walk = (node, depth) => {
    const r = parseRect(node.$rect);
    if (r && r.w > 0 && r.h > 0) {
      const el = document.createElement("div");
      el.className = "layer3d" + (depth === 0 ? " layer3d-top" : "");
      el.style.left = r.x * s + "px";
      el.style.top = r.y * s + "px";
      el.style.width = r.w * s + "px";
      el.style.height = r.h * s + "px";
      el.style.transform = `translateZ(${depth * gap}px)`;
      if (node.$ID != null) el.dataset.id = node.$ID;
      // 贴图优先级：① 逐组件渲染图(ArkUI.tree.3D，含遮挡/滚动外内容) ② 回退截图切片。
      const cid = node.$ID != null ? String(node.$ID) : null;
      if (cid && perComp && perComp.has(cid)) {
        el.style.backgroundImage = `url(${perComp.get(cid)})`;
        el.style.backgroundSize = "100% 100%";
        el.style.backgroundRepeat = "no-repeat";
      } else if (snapUrl) {
        // 截图整图定位到本层 rect 这一块（共享 blob URL）
        el.style.backgroundImage = `url(${snapUrl})`;
        el.style.backgroundSize = `${snapW * s}px ${snapH * s}px`;
        el.style.backgroundPosition = `${-r.x * s}px ${-r.y * s}px`;
        el.style.backgroundRepeat = "no-repeat";
      }
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (node.$ID != null) inspector.selectById(node.$ID);
      });
      frag.appendChild(el);
    }
    if (Array.isArray(node.$children)) for (const c of node.$children) walk(c, depth + 1);
  };
  walk(deviceTree, 0);
  stage3d.appendChild(frag);
  applyStage();
  built3d = true;
}

function mark3dSelected(id) {
  if (!stage3d) return;
  const prev = stage3d.querySelector(".layer3d.sel");
  if (prev) prev.classList.remove("sel");
  if (id == null) return;
  const el = stage3d.querySelector(`.layer3d[data-id="${CSS.escape(String(id))}"]`);
  if (el) el.classList.add("sel");
}

function setMode3d(on) {
  is3d = on;
  mode3dBtn.classList.toggle("active", on);
  wrap2d.style.display = on ? "none" : "";
  scene3d.style.display = on ? "" : "none";
  if (on && !built3d) build3D();
  if (on) mark3dSelected(selectedId); // 保持当前选中
  if (on && !layers3dFetched && deviceTree) requestLayers3d(); // 进 3D 自动取逐组件图
}

// 请求逐组件渲染图（ArkUI.tree.3D，逐个渲染较慢）。
function requestLayers3d() {
  layers3dFetched = true;
  setStatus("正在渲染逐组件图…（逐个渲染，较慢，请稍候）");
  vscode.postMessage({ channel: "fetch3dLayers" });
}

mode3dBtn.addEventListener("click", () => setMode3d(!is3d));

// 拖拽旋转
let drag = null;
scene3d.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, rx: rotX, ry: rotY };
  scene3d.classList.add("grabbing");
  scene3d.setPointerCapture(e.pointerId);
});
scene3d.addEventListener("pointermove", (e) => {
  if (!drag) return;
  rotY = drag.ry + (e.clientX - drag.x) * 0.4;
  rotX = Math.max(-85, Math.min(85, drag.rx - (e.clientY - drag.y) * 0.4));
  applyStage();
});
const endDrag = () => { drag = null; scene3d.classList.remove("grabbing"); };
scene3d.addEventListener("pointerup", endDrag);
scene3d.addEventListener("pointercancel", endDrag);
// 滚轮缩放
scene3d.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoom = Math.max(0.2, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
  applyStage();
}, { passive: false });

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.channel === "deviceTree") {
    const meta = m.meta || {};
    deviceTree = m.tree; // 存树供 hit-test（点截图反查节点）+ 3D 构建
    built3d = false; // 新树 → 3D 需重建
    // 逐组件图随新树失效
    if (perCompUrls.length) { perCompUrls.forEach((u) => URL.revokeObjectURL(u)); perCompUrls = []; }
    perComp = null;
    layers3dFetched = false;
    const total = countNodes(m.tree);
    setStatus(`✅ windowId=${meta.windowId ?? "?"} · ${total} 节点`, "ok");
    // 设备截图
    hl.style.display = "none";
    if (snapUrl) { URL.revokeObjectURL(snapUrl); snapUrl = null; }
    if (m.snapshot && m.snapshot.base64) {
      snapW = m.snapshot.width || 0;
      snapH = m.snapshot.height || 0;
      snapUrl = URL.createObjectURL(b64ToBlob(m.snapshot.base64, "image/png"));
      shotImg.src = snapUrl;
      shotImg.style.display = "block";
      shotHint.style.display = "none";
    } else {
      snapW = 0; snapH = 0;
      shotImg.style.display = "none";
      shotHint.style.display = "block";
      shotHint.textContent = "（本次未返回设备截图）";
    }
    // 组件树（复用 InspectorPanel.onEvent 的 inspector 分支，result 为 JSON 字符串）
    inspector.onEvent({ command: "inspector", result: JSON.stringify(m.tree) });
    if (is3d) build3D(); // 3D 模式下立即重建
  } else if (m.channel === "layers3d") {
    // 逐组件渲染图到达 → 建 id→blobUrl 映射并重建 3D。
    if (perCompUrls.length) { perCompUrls.forEach((u) => URL.revokeObjectURL(u)); perCompUrls = []; }
    perComp = new Map();
    for (const L of m.layers || []) {
      if (L.id == null || !L.base64) continue;
      const url = URL.createObjectURL(b64ToBlob(L.base64, "image/png"));
      perCompUrls.push(url);
      perComp.set(String(L.id), url);
    }
    const total = countNodes(deviceTree);
    if (perComp.size > 0) {
      setStatus(`✅ ${total} 节点 · 逐组件图 ${perComp.size} 层${m.complete ? "" : "（部分）"}`, "ok");
      if (is3d) build3D();
    } else {
      setStatus("⚠ 未获取到逐组件图" + (m.err ? "：" + m.err : "（设备可能不支持/超时）"), "error");
    }
  } else if (m.channel === "deviceStatus") {
    setStatus(m.message);
  } else if (m.channel === "deviceError") {
    setStatus("⚠ " + m.message, "error");
  }
});

setStatus("从活跃的 arkts-dap 真机调试会话抓取组件树…");
vscode.postMessage({ channel: "ready" });
inspector.fetch(); // 打开即自动抓一次
