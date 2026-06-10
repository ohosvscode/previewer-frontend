// Toolbar —— 顶部操作。按设备能力自适应：
// rich 设备才有 重载/返回/深色/Inspector（lite 后端不支持这些命令，见 protocol.md §3.5）。

export class Toolbar {
  /**
   * @param {HTMLElement} root
   * @param {{send:(m:object)=>void}} transport
   * @param {{isLite:boolean, device:string, url:string, onInspect:()=>void, onReconnect:()=>void}} opts
   */
  constructor(root, transport, opts = {}) {
    this.transport = transport;
    this.url = opts.url || "pages/index/index";
    root.innerHTML = "";

    const label = document.createElement("span");
    label.className = "tb-label";
    label.textContent = `${opts.device || "device"}${opts.isLite ? " · lite" : ""}`;
    root.appendChild(label);

    // 调试徽章：与 arkts-dap/VSCode 共用同一 Previewer（CDP 端口）
    if (opts.debug) {
        const badge = document.createElement("span");
        badge.className = "tb-debug";
        badge.textContent = `🐞 调试 :${opts.cdpPort}`;
        badge.title = `attach: arkts-dap --cdp-port ${opts.cdpPort}`;
        root.appendChild(badge);
    }

    const mk = (text, onClick, title) => {
      const b = document.createElement("button");
      b.className = "tb-btn";
      b.textContent = text;
      if (title) b.title = title;
      b.addEventListener("click", onClick);
      root.appendChild(b);
      return b;
    };

    if (opts.onReconnect) mk("⟲ 重连", opts.onReconnect, "重连 Host");

    if (!opts.isLite) {
      // rich-only 命令
      mk("⟳ 重载", () => this._cmd("ReloadRuntimePage", "set", { ReloadRuntimePage: this.url }), "ReloadRuntimePage");
      mk("← 返回", () => this._cmd("BackClicked", "action", {}), "BackClicked");
      let dark = false;
      const cm = mk("◐ 深色", () => {
        dark = !dark;
        cm.textContent = dark ? "◑ 浅色" : "◐ 深色";
        this._cmd("ColorMode", "set", { ColorMode: dark ? "dark" : "light" });
      }, "ColorMode");
      if (opts.onInspect) mk("⛶ Inspector", opts.onInspect, "inspector 组件树");
    } else {
      const note = document.createElement("span");
      note.className = "tb-note";
      note.textContent = "lite：触摸/表冠/传感器可用；重载·Inspector·深色为 rich 专属";
      root.appendChild(note);
    }
  }

  _cmd(command, cmdType, args) {
    this.transport.send({ type: "command", command, cmdType, args });
  }
}
