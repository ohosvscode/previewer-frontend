// OpenHarmony Previewer —— VSCode relay shim（见 ../../../docs/adr/0003-host-in-rust.md §5.3）。
//
// 职责（薄）：
//   1. spawn previewer-host（Rust 二进制，零运行时依赖）。
//   2. 开 webview，加载同一份 UI（ui/ 目录，asWebviewUri）。
//   3. 作为 WS client 连 host gateway 的 /ws，在 WS 与 webview postMessage 间转发。
// UI 与 Rust core/二进制相对浏览器版【零改动】——只多了这层转发 + VsCodeTransport。

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");

/** 取 Node 全局或 ws 包的 WebSocket 实现。*/
function getWebSocketCtor() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket; // Node 22+
  try { return require("ws"); } catch { return null; }
}

function resolveHostBin(context) {
  const cfg = vscode.workspace.getConfiguration("ohPreviewer");
  const explicit = cfg.get("hostBin");
  if (explicit) return explicit;
  const hostRoot = path.resolve(context.extensionPath, "..", "..");
  const exe = process.platform === "win32" ? "previewer-host.exe" : "previewer-host";
  for (const prof of ["release", "debug"]) {
    const p = path.join(hostRoot, "target", prof, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("ohPreviewer.open", () => openPreview(context))
  );
}

async function openPreview(context) {
  const cfg = vscode.workspace.getConfiguration("ohPreviewer");
  const bind = cfg.get("bind") || "127.0.0.1:9000";
  const hostBin = resolveHostBin(context);
  if (!hostBin) {
    vscode.window.showErrorMessage("未找到 previewer-host，请先 `cargo build` 或配置 ohPreviewer.hostBin");
    return;
  }

  // 1. spawn host
  const args = ["--bind", bind];
  if (cfg.get("sim")) args.push("--sim", cfg.get("sim"));
  if (cfg.get("app")) args.push("--app", cfg.get("app"));
  const host = cp.spawn(hostBin, args, { stdio: "pipe" });
  const onOut = (d) => console.log("[host]", d.toString());
  host.stdout.on("data", onOut);
  host.stderr.on("data", onOut);
  host.on("error", (e) => vscode.window.showErrorMessage(`previewer-host 启动失败: ${e.message}`)); // finding #25

  // 2. webview
  const uiRoot = vscode.Uri.file(path.resolve(context.extensionPath, "..", "..", "..", "ui"));
  const panel = vscode.window.createWebviewPanel(
    "ohPreviewer",
    "OpenHarmony Previewer",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [uiRoot] }
  );
  panel.webview.html = renderHtml(panel.webview, uiRoot);
  host.on("exit", () => panel.webview.postMessage({ channel: "state", state: "closed" })); // finding #25

  // 3. relay：WS client ↔ webview postMessage
  const WS = getWebSocketCtor();
  if (!WS) {
    vscode.window.showErrorMessage("缺少 WebSocket（需 VSCode 内置 Node 22+ 或在扩展内打包 'ws'）");
    return;
  }
  const url = `ws://${bind}/ws`;
  let ws = null;
  let tries = 0;
  let disposed = false;

  // connect() 是 handler 的唯一来源；自行决定“重试 vs 报错”（finding #23）
  const connect = () => {
    if (disposed) return;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    const sock = new WS(url);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => { tries = 0; panel.webview.postMessage({ channel: "state", state: "open" }); };
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let payload; try { payload = JSON.parse(ev.data); } catch { return; }
        panel.webview.postMessage({ channel: "event", payload });
      } else {
        const bytes = ev.data instanceof ArrayBuffer ? ev.data : Buffer.from(ev.data);
        panel.webview.postMessage({ channel: "frame", bytes });
      }
    };
    const retry = () => {
      if (disposed || sock !== ws) return;
      if (++tries < 40) setTimeout(connect, Math.min(300 * tries, 3000));
      else panel.webview.postMessage({ channel: "state", state: "error" });
    };
    sock.onerror = retry;
    sock.onclose = () => { panel.webview.postMessage({ channel: "state", state: "closed" }); retry(); };
  };

  // webview → host：仅在 webview 'ready' 后才连 WS，避免帧/hello 抢跑（finding #1）
  panel.webview.onDidReceiveMessage((m) => {
    if (!m) return;
    switch (m.channel) {
      case "ready":
        if (!ws) connect();
        break;
      case "reconnect": // finding #6：UI ⟲ 重连
        tries = 0;
        connect();
        break;
      case "command":
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(m.msg));
        break;
      case "close": // finding #24
        try { ws && ws.close(); } catch {}
        break;
    }
  });

  panel.onDidDispose(() => {
    disposed = true;
    try { ws && (ws.onclose = null, ws.close()); } catch {}
    try { host.kill(); } catch {}
  });
}

function renderHtml(webview, uiRoot) {
  const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, ...p));
  const appUri = uri("src", "app.js");
  const styleUri = uri("src", "style.css");
  const csp = [
    `default-src 'none'`,
    `script-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} blob: data:`,
    `connect-src 'none'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OpenHarmony Previewer</title>
</head>
<body>
  <div class="app">
    <header class="toolbar" id="toolbar"></header>
    <div class="main">
      <section class="stage">
        <div class="device device--circle" id="device">
          <canvas id="screen" width="466" height="466"></canvas>
        </div>
        <div class="status" id="status">连接中…</div>
      </section>
      <aside class="panel" id="panel"></aside>
    </div>
  </div>
  <script type="module" src="${appUri}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
