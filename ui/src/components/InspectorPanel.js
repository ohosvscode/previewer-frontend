// InspectorPanel —— 组件树**树状可视化** + 点击节点**在画布上定位元素**。
// 数据源（rich action 命令，回包 {command, result:<JSON 字符串>}）：
//   - inspector：实时组件树（节点含 $type/$ID/$rect/$attrs/$children），$rect 用于定位。
//     ⚠ standalone 返回空；需 ArkTS 调试器（arkts-dap）attach 到 -p 端口并续跑（见 docs/protocol.md §3.5）。
//   - inspectorDefault：默认组件目录（version/deviceType/defaultValue{...}），无实例/位置，仅供浏览。
// fetch() 先取 inspector，为空回退 inspectorDefault。

/** 解析 ArkUI $rect："[l,t],[r,b]" → {x,y,w,h}（设备/渲染分辨率坐标）。取不到返回 null。 */
export function parseRect(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*,\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/);
  if (!m) return null;
  const [l, t, r, b] = m.slice(1).map(Number);
  if ([l, t, r, b].some((n) => Number.isNaN(n))) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

/** 把任意 inspector 数据归一成树节点 {label, rect, attrs, children[]}。兼容实时树与默认目录。 */
export function toNode(key, v) {
  if (v && typeof v === "object" && typeof v.$type === "string") {
    // 实时组件节点
    return {
      label: v.$type + (v.$ID != null ? ` #${v.$ID}` : ""),
      rect: parseRect(v.$rect),
      attrs: v.$attrs || null,
      children: Array.isArray(v.$children) ? v.$children.map((c) => toNode(null, c)) : [],
    };
  }
  if (v && typeof v === "object") {
    // 通用对象（默认目录的组件项 / 嵌套）：$styles 噪声大，折叠为单叶子
    const children = [];
    for (const [k, val] of Object.entries(v)) {
      if (k === "$styles") children.push({ label: "$styles (…)", rect: null, attrs: val, children: [] });
      else children.push(toNode(k, val));
    }
    return { label: key ?? "(object)", rect: null, attrs: v.$attrs || null, children };
  }
  return { label: (key != null ? key + ": " : "") + String(v), rect: null, attrs: null, children: [] };
}

/** 数据 → 根节点数组。 */
export function rootsOf(data) {
  if (data && typeof data === "object" && data.defaultValue && typeof data.defaultValue === "object") {
    return Object.entries(data.defaultValue).map(([k, v]) => toNode(k, v));
  }
  if (Array.isArray(data)) return data.map((v) => toNode(null, v));
  if (data && typeof data === "object" && (data.$type || data.$children)) return [toNode(null, data)];
  return [toNode("root", data)];
}

export class InspectorPanel {
  /**
   * @param {HTMLElement} root
   * @param {{send:(m:object)=>void}} transport
   * @param {{onSelect?:(rect:{x,y,w,h}|null)=>void}} [opts]
   */
  constructor(root, transport, opts = {}) {
    this.transport = transport;
    this.onSelect = opts.onSelect || (() => {});
    const section = document.createElement("div");
    section.className = "panel-section";
    section.innerHTML = `<h3>Inspector 组件树</h3>`;
    this.note = document.createElement("div");
    this.note.className = "inspector-note";
    this.treeEl = document.createElement("div");
    this.treeEl.className = "inspector-tree";
    this.treeEl.textContent = "（点击工具栏 ⛶ Inspector 抓取）";
    section.append(this.note, this.treeEl);
    root.appendChild(section);
    this._triedDefault = false;
    this._selectedRow = null;
  }

  fetch() {
    this._triedDefault = false;
    this.note.textContent = "";
    this.treeEl.textContent = "抓取中…";
    this.onSelect(null); // 清旧高亮
    this.transport.send({ type: "command", command: "inspector", cmdType: "action", args: {} });
  }

  onEvent(ev) {
    if (!ev || (ev.command !== "inspector" && ev.command !== "inspectorDefault")) return false;
    const raw = ev.result;
    if (ev.command === "inspector" && (!raw || raw === "") && !this._triedDefault) {
      this._triedDefault = true;
      this.note.textContent = "实时组件树为空（需 arkts-dap 调试器 attach）。回退默认组件目录…";
      this.transport.send({ type: "command", command: "inspectorDefault", cmdType: "action", args: {} });
      return true;
    }
    this.note.textContent = ev.command === "inspector"
      ? "实时组件树（点节点 → 画面高亮定位）"
      : "默认组件目录（inspectorDefault；无位置信息）";
    let data;
    try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { data = raw; }
    this._render(rootsOf(data));
    return true;
  }

  _render(roots) {
    this.treeEl.innerHTML = "";
    this._selectedRow = null;
    for (const n of roots) this.treeEl.appendChild(this._nodeEl(n, 0));
  }

  _nodeEl(node, depth) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = depth * 14 + "px";

    const hasKids = node.children && node.children.length > 0;
    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = hasKids ? "▸" : "·";
    const label = document.createElement("span");
    label.className = "tree-label" + (node.rect ? " has-rect" : "");
    label.textContent = node.label;
    row.append(toggle, label);
    wrap.appendChild(row);

    let kids = null;
    const expand = () => {
      if (!hasKids) return;
      if (!kids) {
        kids = document.createElement("div");
        for (const c of node.children) kids.appendChild(this._nodeEl(c, depth + 1));
        wrap.appendChild(kids);
      }
      const open = kids.style.display !== "none";
      kids.style.display = open ? "none" : "block";
      toggle.textContent = open ? "▸" : "▾";
    };
    toggle.addEventListener("click", (e) => { e.stopPropagation(); expand(); });
    row.addEventListener("click", () => {
      if (this._selectedRow) this._selectedRow.classList.remove("selected");
      row.classList.add("selected");
      this._selectedRow = row;
      this.onSelect(node.rect); // 有 rect → 画面高亮定位；无 → 清除
    });
    return wrap;
  }
}
