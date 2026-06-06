// InspectorPanel —— 触发 inspector，渲染返回的组件树。
// inspector 是 action 命令，回包为同步 result（{command:"inspector", result:"<json字符串>"}），
// 经 Host gateway 作为文本事件转发到 UI。见 ../../docs/protocol.md §3.5。

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
    this.tree = document.createElement("pre");
    this.tree.className = "inspector-tree";
    this.tree.textContent = "（点击工具栏 ⛶ Inspector 抓取）";
    section.appendChild(this.tree);
    root.appendChild(section);
  }

  /** 工具栏触发：发送 inspector action。*/
  fetch() {
    this.tree.textContent = "抓取中…";
    this.transport.send({ type: "command", command: "inspector", cmdType: "action", args: {} });
  }

  /** 收到命令通道事件时调用；匹配 inspector 回包则渲染。*/
  onEvent(ev) {
    if (!ev || ev.command !== "inspector") return false;
    let tree = ev.result;
    try {
      if (typeof tree === "string") tree = JSON.parse(tree);
      this.tree.textContent = JSON.stringify(tree, null, 2);
    } catch {
      this.tree.textContent = String(ev.result);
    }
    return true;
  }
}
