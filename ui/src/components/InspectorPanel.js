// InspectorPanel —— DevEco 式 ArkUI 检查器：组件树（可展开/搜索）+ 选中节点的属性/事件面板。
// 数据源（rich action 命令，回包 {command, result:<JSON 字符串>}）：
//   - inspector：实时组件树（节点含 $type/$ID/$rect/$attrs/$children），$rect 用于定位。
//     ⚠ standalone 预编译 Previewer 仅返回 root（StageManager 无 LastPage，见调研）；
//        完整树需重编译 Previewer 或走真机 device 路径（ConnectServer ArkUI domain）。
//   - inspectorDefault：默认组件目录（version/deviceType/defaultValue{...}），无实例/位置，仅供浏览。
// fetch() 先取 inspector，为空回退 inspectorDefault。
// 节点带 $attrs/$rect 时，右侧属性面板按 Spacing/Size/Border/Background/Effect/All Attributes 分区展示。

/** 解析 ArkUI $rect："[l,t],[r,b]" → {x,y,w,h}（设备/渲染分辨率坐标）。取不到返回 null。 */
export function parseRect(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\s*,\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/);
  if (!m) return null;
  const [l, t, r, b] = m.slice(1).map(Number);
  if ([l, t, r, b].some((n) => Number.isNaN(n))) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * 把任意 inspector 数据归一成树节点。兼容实时树与默认目录。
 * 节点：{type, id, label, rect, attrs, styles, children[]}，label 为 DevEco 风格 `Type(id)`。
 */
export function toNode(key, v) {
  if (v && typeof v === "object" && typeof v.$type === "string") {
    // 实时组件节点
    const id = v.$ID != null ? v.$ID : null;
    return {
      type: v.$type,
      id,
      label: v.$type + (id != null ? `(${id})` : ""),
      rect: parseRect(v.$rect),
      attrs: v.$attrs || null,
      styles: v.$styles || null,
      children: Array.isArray(v.$children) ? v.$children.map((c) => toNode(null, c)) : [],
    };
  }
  if (v && typeof v === "object") {
    // 通用对象（默认目录的组件项 / 嵌套）：$styles 噪声大，折叠为单叶子
    const children = [];
    for (const [k, val] of Object.entries(v)) {
      if (k === "$styles") children.push({ type: null, id: null, label: "$styles (…)", rect: null, attrs: val, styles: val, children: [] });
      else children.push(toNode(k, val));
    }
    return { type: key, id: null, label: key ?? "(object)", rect: null, attrs: v.$attrs || null, styles: v.$styles || null, children };
  }
  return { type: null, id: null, label: (key != null ? key + ": " : "") + String(v), rect: null, attrs: null, styles: null, children: [] };
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

// ───────────────────────── 属性提取 ─────────────────────────

/** 在 attrs/styles 里按候选键取首个非空值（ArkUI $attrs 值多为字符串）。 */
function pick(src, ...keys) {
  if (!src) return null;
  for (const k of keys) {
    const v = src[k];
    if (v != null && v !== "") return v;
  }
  return null;
}

/** 把 margin/padding 值（"12.00vp" 或 {top,right,bottom,left} 或 数字）归一成四边数组 [t,r,b,l] 的字符串。 */
function edges(v) {
  if (v == null || v === "") return ["0", "0", "0", "0"];
  if (typeof v === "object") {
    const g = (k) => (v[k] != null ? String(v[k]) : "0");
    return [g("top"), g("right"), g("bottom"), g("left")];
  }
  const s = String(v);
  return [s, s, s, s];
}

// ───────────────────────── 组件 ─────────────────────────

export class InspectorPanel {
  /**
   * @param {HTMLElement} root
   * @param {{send:(m:object)=>void}} transport
   * @param {{onSelect?:(rect:{x,y,w,h}|null)=>void}} [opts]
   */
  constructor(root, transport, opts = {}) {
    this.transport = transport;
    this.onSelect = opts.onSelect || (() => {});
    this._triedDefault = false;
    this._selectedRow = null;
    this._roots = [];

    const section = document.createElement("div");
    section.className = "panel-section inspector";

    // 树工具栏：标题 + 展开/折叠全部
    const head = document.createElement("div");
    head.className = "insp-head";
    head.innerHTML = `<h3>组件树</h3>`;
    const tools = document.createElement("div");
    tools.className = "insp-tools";
    const btnExpand = this._toolBtn("⊞", "展开全部", () => this._setAllExpanded(true));
    const btnCollapse = this._toolBtn("⊟", "折叠全部", () => this._setAllExpanded(false));
    tools.append(btnExpand, btnCollapse);
    head.appendChild(tools);

    // 搜索框
    this.search = document.createElement("input");
    this.search.className = "insp-search";
    this.search.type = "search";
    this.search.placeholder = "搜索组件（类型 / id）";
    this.search.addEventListener("input", () => this._applyFilter(this.search.value.trim()));

    this.note = document.createElement("div");
    this.note.className = "inspector-note";

    this.treeEl = document.createElement("div");
    this.treeEl.className = "inspector-tree";
    this.treeEl.textContent = "（点击工具栏 ⛶ Inspector 抓取）";

    // 属性/事件面板
    this.attrEl = document.createElement("div");
    this.attrEl.className = "insp-attrs";
    this.attrEl.style.display = "none";

    section.append(head, this.search, this.note, this.treeEl, this.attrEl);
    root.appendChild(section);
  }

  _toolBtn(text, title, onClick) {
    const b = document.createElement("button");
    b.className = "insp-tbtn";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  fetch() {
    this._triedDefault = false;
    this.note.textContent = "";
    this.treeEl.textContent = "抓取中…";
    this.attrEl.style.display = "none";
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
    let data;
    try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { data = raw; }
    this._roots = rootsOf(data);
    // 仅 root 且无子（预编译 Previewer 的已知限制）→ 明确提示
    const rootOnly = ev.command === "inspector" && this._roots.length === 1 && this._roots[0].children.length === 0;
    this.note.textContent = ev.command === "inspector"
      ? (rootOnly
        ? "⚠ 仅返回 root 节点（预编译 Previewer 的 GetInspector 限制；完整树需重编译或走真机）"
        : "实时组件树（点节点 → 画面高亮定位 + 右侧属性）")
      : "默认组件目录（inspectorDefault；无位置/属性）";
    this._render(this._roots);
    return true;
  }

  _render(roots) {
    this.treeEl.innerHTML = "";
    this._selectedRow = null;
    this.attrEl.style.display = "none";
    for (const n of roots) this.treeEl.appendChild(this._nodeEl(n, 0));
  }

  _nodeEl(node, depth) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    node._wrap = wrap;
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
    const ensureKids = () => {
      if (hasKids && !kids) {
        kids = document.createElement("div");
        kids.className = "tree-kids";
        for (const c of node.children) kids.appendChild(this._nodeEl(c, depth + 1));
        wrap.appendChild(kids);
      }
      return kids;
    };
    const setOpen = (open) => {
      if (!hasKids) return;
      ensureKids();
      kids.style.display = open ? "block" : "none";
      toggle.textContent = open ? "▾" : "▸";
    };
    node._setOpen = setOpen;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setOpen(!kids || kids.style.display === "none");
    });
    row.addEventListener("click", () => {
      if (this._selectedRow) this._selectedRow.classList.remove("selected");
      row.classList.add("selected");
      this._selectedRow = row;
      this.onSelect(node.rect);      // 有 rect → 画面高亮定位；无 → 清除
      this._showAttrs(node);          // 右侧属性/事件
    });
    return wrap;
  }

  _setAllExpanded(open) {
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.children && n.children.length) { n._setOpen && n._setOpen(open); walk(n.children); }
      }
    };
    walk(this._roots);
  }

  _applyFilter(q) {
    const ql = q.toLowerCase();
    const match = (n) => !ql || (n.label || "").toLowerCase().includes(ql);
    // 标记命中（含祖先），并据此显示/隐藏 + 自动展开命中路径
    const mark = (n) => {
      let hit = match(n);
      for (const c of n.children || []) hit = mark(c) || hit;
      n._hit = hit;
      return hit;
    };
    for (const r of this._roots) mark(r);
    const apply = (nodes) => {
      for (const n of nodes) {
        if (n._wrap) n._wrap.style.display = n._hit ? "" : "none";
        if (n.children && n.children.length) {
          if (ql && n._hit) n._setOpen && n._setOpen(true);
          apply(n.children);
        }
      }
    };
    apply(this._roots);
  }

  // ─────────────── 属性 / 事件面板 ───────────────

  _showAttrs(node) {
    const a = node.attrs || {};
    const s = node.styles || {};
    const get = (...keys) => pick(a, ...keys) ?? pick(s, ...keys);

    this.attrEl.innerHTML = "";
    this.attrEl.style.display = "block";

    // 头部：Type(id) + x/y
    const header = document.createElement("div");
    header.className = "insp-attr-head";
    const pos = node.rect ? `x: ${node.rect.x.toFixed(2)}px  y: ${node.rect.y.toFixed(2)}px` : "";
    header.innerHTML = `<span class="insp-attr-title">${node.label}</span><span class="insp-attr-pos">${pos}</span>`;

    // 标签页：属性 / 事件
    const tabs = document.createElement("div");
    tabs.className = "insp-tabs";
    const body = document.createElement("div");
    body.className = "insp-tab-body";
    const tabAttr = document.createElement("button");
    tabAttr.className = "insp-tab active";
    tabAttr.textContent = "属性";
    const tabEvt = document.createElement("button");
    tabEvt.className = "insp-tab";
    tabEvt.textContent = "事件";
    tabs.append(tabAttr, tabEvt);
    tabAttr.addEventListener("click", () => { tabAttr.classList.add("active"); tabEvt.classList.remove("active"); this._renderAttrTab(body, node, get); });
    tabEvt.addEventListener("click", () => { tabEvt.classList.add("active"); tabAttr.classList.remove("active"); this._renderEvtTab(body, a); });

    this.attrEl.append(header, tabs, body);
    this._renderAttrTab(body, node, get);
  }

  _renderAttrTab(body, node, get) {
    body.innerHTML = "";
    const a = node.attrs || {};
    const hasAny = Object.keys(a).length > 0 || node.rect;
    if (!hasAny) {
      body.innerHTML = `<div class="insp-empty">该节点无属性（实例节点带 $attrs 时此处展示）</div>`;
      return;
    }

    // Spacing：margin → border → padding 盒模型
    body.appendChild(this._spacingBox(
      edges(get("margin")),
      get("borderWidth") || "0",
      edges(get("padding")),
      node.rect ? `${node.rect.w.toFixed(0)} × ${node.rect.h.toFixed(0)}` : "—"
    ));

    // Size
    body.appendChild(this._sect("Size", [
      ["Width", get("width") ?? (node.rect ? node.rect.w.toFixed(2) + "px" : "—")],
      ["Height", get("height") ?? (node.rect ? node.rect.h.toFixed(2) + "px" : "—")],
      ["AspectRatio", get("aspectRatio") ?? "—"],
    ]));

    // Border
    body.appendChild(this._sect("Border", [
      ["Color", get("borderColor")],
      ["Style", get("borderStyle")],
      ["Width", get("borderWidth")],
      ["Radius", get("borderRadius")],
    ]));

    // Background
    body.appendChild(this._sect("Background", [
      ["Color", get("backgroundColor", "backgroundcolor")],
      ["Image", get("backgroundImage") ?? "NONE"],
      ["Size", get("backgroundImageSize") ?? "Auto"],
      ["Position x", get("backgroundImagePositionX") ?? "0"],
      ["Position y", get("backgroundImagePositionY") ?? "0"],
    ]));

    // Effect
    body.appendChild(this._sect("Effect", [
      ["Opacity", get("opacity")],
      ["Visibility", get("visibility")],
      ["Enabled", get("enabled")],
      ["Blur", get("blur", "backdropBlur")],
      ["Brightness", get("brightness")],
      ["Contrast", get("contrast")],
      ["Grayscale", get("grayscale")],
    ]));

    // All Attributes
    const all = Object.entries(a);
    if (all.length) {
      body.appendChild(this._sect("All Attributes", all.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])));
    }
  }

  _renderEvtTab(body, attrs) {
    body.innerHTML = "";
    const evts = Object.entries(attrs || {}).filter(([k]) => /^on[A-Z]/.test(k) || /gesture|click|touch/i.test(k));
    if (!evts.length) {
      body.innerHTML = `<div class="insp-empty">无事件绑定信息</div>`;
      return;
    }
    body.appendChild(this._sect("Events", evts.map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])));
  }

  /** 一个标题分区，rows = [[name, value], …]；value 为 null/undefined 显示占位。 */
  _sect(title, rows) {
    const sec = document.createElement("div");
    sec.className = "insp-sect";
    const h = document.createElement("div");
    h.className = "insp-sect-h";
    h.textContent = title;
    sec.appendChild(h);
    for (const [name, value] of rows) {
      const r = document.createElement("div");
      r.className = "insp-sect-row";
      const n = document.createElement("span");
      n.className = "insp-k";
      n.textContent = name;
      const val = document.createElement("span");
      val.className = "insp-v";
      val.textContent = value == null || value === "" ? "—" : value;
      r.append(n, val);
      sec.appendChild(r);
    }
    return sec;
  }

  /** margin → border → padding 同心盒模型（DevEco Spacing 风格）。 */
  _spacingBox(m, borderW, p, contentSize) {
    const sec = document.createElement("div");
    sec.className = "insp-sect";
    const h = document.createElement("div");
    h.className = "insp-sect-h";
    h.textContent = "Spacing";
    sec.appendChild(h);

    const box = (cls, labelText, t, r, b, l, inner) => {
      const el = document.createElement("div");
      el.className = "sp-box " + cls;
      el.innerHTML =
        `<span class="sp-tag">${labelText}</span>` +
        `<span class="sp-e sp-t">${t}</span>` +
        `<span class="sp-e sp-r">${r}</span>` +
        `<span class="sp-e sp-b">${b}</span>` +
        `<span class="sp-e sp-l">${l}</span>`;
      el.appendChild(inner);
      return el;
    };
    const content = document.createElement("div");
    content.className = "sp-content";
    content.textContent = contentSize;

    const padding = box("sp-padding", "padding", p[0], p[1], p[2], p[3], content);
    const border = box("sp-border", "border", borderW, borderW, borderW, borderW, padding);
    const margin = box("sp-margin", "margin", m[0], m[1], m[2], m[3], border);
    sec.appendChild(margin);
    return sec;
  }
}
