// InspectorPanel —— 触发 inspector，渲染返回的组件树。
// inspector/inspectorDefault 是 rich(action) 命令，回包为同步 result
// （{command:"inspector"|"inspectorDefault", result:"<json字符串>"}），经 Host gateway 转发到 UI。
// 见 ../../docs/protocol.md §3.5。
//
// 标准前端（无 DevEco 调试器）下：
//   - inspector（实时应用组件树, GetJSONTree）需 ArkTS 调试器连到 -p 调试端口，standalone 返回空；
//   - inspectorDefault（GetDefaultJSONTree, 组件目录）standalone 即可返回完整树。
// 故 fetch() 先取 inspector，为空自动回退 inspectorDefault。

export class InspectorPanel {
  /**
   * @param {HTMLElement} root
   * @param {{send:(m:object)=>void}} transport
   */
  constructor(root, transport) {
    this.transport = transport;
    const section = document.createElement("div");
    section.className = "panel-section";
    section.innerHTML = `<h3>Inspector 组件树</h3>`;
    this.note = document.createElement("div");
    this.note.className = "inspector-note";
    this.tree = document.createElement("pre");
    this.tree.className = "inspector-tree";
    this.tree.textContent = "（点击工具栏 ⛶ Inspector 抓取）";
    section.append(this.note, this.tree);
    root.appendChild(section);
    this._triedDefault = false;
  }

  /** 工具栏触发：先取实时组件树。*/
  fetch() {
    this._triedDefault = false;
    this.note.textContent = "";
    this.tree.textContent = "抓取中…";
    this.transport.send({ type: "command", command: "inspector", cmdType: "action", args: {} });
  }

  /** 收到命令通道事件时调用；匹配 inspector/inspectorDefault 回包则渲染。返回是否已处理。*/
  onEvent(ev) {
    if (!ev || (ev.command !== "inspector" && ev.command !== "inspectorDefault")) return false;
    const raw = ev.result;

    // 实时树为空 → 自动回退到默认组件树（standalone 可用）
    if (ev.command === "inspector" && (!raw || raw === "") && !this._triedDefault) {
      this._triedDefault = true;
      this.note.textContent = "实时组件树为空（需 ArkTS 调试器）。回退展示默认组件目录…";
      this.transport.send({ type: "command", command: "inspectorDefault", cmdType: "action", args: {} });
      return true;
    }

    if (ev.command === "inspector" && raw) {
      this.note.textContent = "实时组件树";
    } else if (ev.command === "inspectorDefault") {
      this.note.textContent = "默认组件目录（inspectorDefault）";
    }

    try {
      const tree = typeof raw === "string" ? JSON.parse(raw) : raw;
      this.tree.textContent = JSON.stringify(tree, null, 2);
    } catch {
      this.tree.textContent = String(raw || "(空)");
    }
    return true;
  }
}
