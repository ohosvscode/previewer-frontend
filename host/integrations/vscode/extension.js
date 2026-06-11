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
const discover = require("./discover");

// 「画面已渲染」观测：webview 每画一帧回发 {channel:"rendered"}，这里计数 + 广播，供集成测试断言整条画面环。
let renderedCount = 0;
const renderedEmitter = new vscode.EventEmitter();
// 最近一次自动选择的配置（model/bundle/device…），供集成测试断言「自动发现/自动选择」结果。
let lastPicked = null;

/** 取 Node 全局或 ws 包的 WebSocket 实现。*/
function getWebSocketCtor() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket; // Node 22+
  try { return require("ws"); } catch { return null; }
}

function resolveHostBin(context) {
  const cfg = vscode.workspace.getConfiguration("ohPreviewer");
  const explicit = cfg.get("hostBin");
  if (explicit) return explicit;
  const exe = process.platform === "win32" ? "previewer-host.exe" : "previewer-host";
  // 1) 打进 vsix 的 bin/（安装后开箱即用，见 npm run bundle-host）
  const bundled = path.join(context.extensionPath, "bin", exe);
  if (fs.existsSync(bundled)) {
    try { fs.chmodSync(bundled, 0o755); } catch { /* none */ }
    return bundled;
  }
  // 2) 开发态：仓库 host/target/{release,debug}
  const hostRoot = path.resolve(context.extensionPath, "..", "..");
  for (const prof of ["release", "debug"]) {
    const p = path.join(hostRoot, "target", prof, exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// UI 静态资源根：优先打进 vsix 的 ./ui（安装后），否则回退仓库 ui/（F5 扩展开发宿主 / 测试）。
function resolveUiRoot(context) {
  const bundled = path.join(context.extensionPath, "ui");
  if (fs.existsSync(path.join(bundled, "src", "app.js"))) {
    return vscode.Uri.file(bundled);
  }
  return vscode.Uri.file(path.resolve(context.extensionPath, "..", "..", "..", "ui"));
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("ohPreviewer.open", () => openPreview(context)),
    vscode.commands.registerCommand("ohPreviewer.arkuiInspector", () => openArkuiInspector(context)),
    renderedEmitter
  );
  // 暴露给集成测试：观测 webview 是否真的渲染了帧（画面环 E2E）。
  return {
    onRendered: renderedEmitter.event,
    lastRenderedCount: () => renderedCount,
    resetRendered: () => { renderedCount = 0; lastPicked = null; },
    lastPicked: () => lastPicked,
  };
}

async function openPreview(context) {
  const cfg = vscode.workspace.getConfiguration("ohPreviewer");
  // bind 默认空 → 用 127.0.0.1:0 让 OS 动态分配端口（避免写死 9000 被占/多开冲突）；
  // 真实端口从 host 打印的 "[gateway] UI 服务: http://<addr>" 解析（见 onOut）。
  const bind = cfg.get("bind") || "127.0.0.1:0";
  const hostBin = resolveHostBin(context);
  if (!hostBin) {
    vscode.window.showErrorMessage("未找到 previewer-host，请先 `cargo build` 或配置 ohPreviewer.hostBin");
    return;
  }

  // gatewayAddr：host 实际监听地址（动态端口时由 stdout 解析得到）；webviewReady：UI 已就绪。
  // 两者齐备才连 relay WS（避免帧/hello 抢跑，且动态端口需先知道真实端口）。
  let gatewayAddr = null;
  let webviewReady = false;

  // 1. 解析启动参数：手填 sim+app 则尊重；否则**自动发现工具 + 按工程自动选择** lite/rich。
  let args;
  const explicitSim = cfg.get("sim");
  const explicitApp = cfg.get("app");
  if (explicitSim && explicitApp) {
    args = ["--sim", explicitSim, "--app", explicitApp, "--bind", bind];
  } else {
    const prevDir = discover.findPreviewerDir(cfg.get("sdk"));
    if (!prevDir) {
      vscode.window.showErrorMessage("未发现 SDK previewer 工具（liteWearable/Simulator 或 common/Previewer），请设置 ohPreviewer.sdk 指向 SDK。");
      return;
    }
    const root = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0])
      ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
    const det = root ? discover.detectProject(root, prevDir) : null;
    if (!det) {
      vscode.window.showErrorMessage("未在当前工程发现可预览的构建产物（先构建工程，或手动设 ohPreviewer.sim/app）。");
      return;
    }
    args = discover.buildHostArgs(det, bind);
    lastPicked = det;
    vscode.window.showInformationMessage(
      `Previewer 自动选择：${det.model === "rich" ? "rich Previewer（Stage·" + det.device + "）" : "liteWearable Simulator（FA）"} · 模块 ${det.bundle}`
    );
  }

  // 1b. spawn host
  const host = cp.spawn(hostBin, args, { stdio: "pipe" });
  const onOut = (d) => {
    const s = d.toString();
    console.log("[host]", s);
    if (!gatewayAddr) {
      const mm = s.match(/UI 服务: http:\/\/(\d{1,3}(?:\.\d{1,3}){3}:\d+)/);
      if (mm) { gatewayAddr = mm[1]; maybeConnect(); }
    }
  };
  host.stdout.on("data", onOut);
  host.stderr.on("data", onOut);
  host.on("error", (e) => vscode.window.showErrorMessage(`previewer-host 启动失败: ${e.message}`)); // finding #25

  // 2. webview
  const uiRoot = resolveUiRoot(context);
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
  let ws = null;
  let tries = 0;
  let disposed = false;

  // 仅当 webview 就绪 且 已知 host 真实端口时才连（动态端口下端口由 host 输出解析）。
  const maybeConnect = () => {
    if (!disposed && webviewReady && gatewayAddr && !ws) connect();
  };

  // connect() 是 handler 的唯一来源；自行决定“重试 vs 报错”（finding #23）
  const connect = () => {
    if (disposed || !gatewayAddr) return;
    if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
    const sock = new WS(`ws://${gatewayAddr}/ws`);
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
        webviewReady = true;
        maybeConnect(); // 端口已知则连，否则等 host 输出解析到端口（onOut）后连
        break;
      case "reconnect": // finding #6：UI ⟲ 重连
        tries = 0;
        if (gatewayAddr) connect();
        break;
      case "command":
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(m.msg));
        break;
      case "close": // finding #24
        try { ws && ws.close(); } catch {}
        break;
      case "rendered": // webview 画完一帧的回执（画面环可观测）
        renderedCount = typeof m.count === "number" ? m.count : renderedCount + 1;
        renderedEmitter.fire(renderedCount);
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

// ───────────────── 独立「ArkUI 组件树检查器（真机）」 ─────────────────
// 数据源 = 活跃的 arkts-dap 真机调试会话：经 VSCode debug API 的 customRequest 取完整树。
// 两扩展不直连，只在 vscode.debug.activeDebugSession 上碰头（软依赖：无会话则优雅提示）。
async function openArkuiInspector(context) {
  const uiRoot = resolveUiRoot(context);
  const panel = vscode.window.createWebviewPanel(
    "ohArkuiInspector",
    "ArkUI 组件树检查器（真机）",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [uiRoot] }
  );
  panel.webview.html = renderInspectorHtml(panel.webview, uiRoot);

  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m) return;
    // 3D 逐组件渲染图（ArkUI.tree.3D）——较慢，单独按需取。
    if (m.channel === "fetch3dLayers") {
      const sess = vscode.debug.activeDebugSession;
      if (!sess || sess.type !== "arkts") {
        panel.webview.postMessage({ channel: "layers3d", layers: [], complete: false, err: "无活跃 arkts 会话" });
        return;
      }
      try {
        const r = await sess.customRequest("getArkUI3DLayers", {});
        panel.webview.postMessage({ channel: "layers3d", layers: (r && r.layers) || [], complete: !!(r && r.complete) });
      } catch (e) {
        panel.webview.postMessage({ channel: "layers3d", layers: [], complete: false, err: (e && e.message) ? e.message : String(e) });
      }
      return;
    }
    if (m.channel !== "fetchDeviceTree") return;
    const postStatus = (t) => panel.webview.postMessage({ channel: "deviceStatus", message: t });
    try {
      // 活跃 arkts 会话优先；没有则自动启动（不必手动先开调试）。
      let sess = vscode.debug.activeDebugSession;
      if (!sess || sess.type !== "arkts") {
        postStatus("未发现活跃 arkts 会话，正在自动启动真机调试…");
        sess = await autoStartArktsSession(postStatus);
      }
      if (!sess) {
        panel.webview.postMessage({
          channel: "deviceError",
          message: "无活跃 arkts 会话，且未找到可自动启动的配置（launch.json 无 type=arkts，工程也未识别到 bundle）。请配置 arkts 真机调试后重试。",
        });
        return;
      }
      // 自动启动后需几秒建 ConnectServer + 渲染；重试 getArkUITree 直到成功（未传 windowId → arkts-dap 经 hidumper 自动发现）。
      postStatus("会话就绪，正在抓取组件树…");
      let res = null, lastErr = "";
      for (let i = 0; i < 15; i++) {
        try {
          const r = await sess.customRequest("getArkUITree", {});
          if (r && r.tree && r.tree.tree) { res = r; break; }
        } catch (e) { lastErr = e && e.message ? e.message : String(e); }
        await sleep(1000);
        postStatus(`等待 ConnectServer / 渲染…（${i + 1}/15）`);
      }
      if (!res) {
        panel.webview.postMessage({ channel: "deviceError", message: "getArkUITree 未成功：" + (lastErr || "超时（设备无响应/窗口不对/app 未渲染）") });
        return;
      }
      const norm = res.tree; // {windowId,vsyncId,processId,tree}
      panel.webview.postMessage({
        channel: "deviceTree",
        tree: norm.tree,
        snapshot: res.snapshot || null, // {base64,width,height,...}：设备截图，供叠加高亮
        meta: { windowId: norm.windowId, vsyncId: norm.vsyncId, processId: norm.processId },
      });
    } catch (e) {
      panel.webview.postMessage({ channel: "deviceError", message: "getArkUITree 失败：" + (e && e.message ? e.message : String(e)) });
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 无活跃 arkts 会话时自动启动一个：优先 launch.json 的 arkts 配置，否则从工程合成。
// 返回就绪的 arkts 调试会话；失败返回 null（调用方提示）。会重启目标 app（launch -D）。
async function autoStartArktsSession(postStatus) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  let cfg = null;
  try {
    const cfgs = vscode.workspace.getConfiguration("launch", folder && folder.uri).get("configurations") || [];
    cfg = cfgs.find((c) => c && c.type === "arkts");
  } catch { /* 无 launch.json */ }
  if (!cfg) cfg = discoverArktsConfig(folder); // 从 AppScope/app.json5 + module.json5 合成
  if (!cfg) return null;
  postStatus(`自动启动 arkts 调试「${cfg.name || cfg.device}」…（会重启目标 app）`);
  let ok = false;
  try { ok = await vscode.debug.startDebugging(folder, cfg); } catch { ok = false; }
  if (!ok) return null;
  for (let i = 0; i < 30; i++) { // 等会话出现（最多 15s）
    const s = vscode.debug.activeDebugSession;
    if (s && s.type === "arkts") return s;
    await sleep(500);
  }
  return null;
}

// 宽松读 JSON5（去注释 + 尾逗号）→ JSON.parse。失败返回 null。
function readJson5(file) {
  try {
    let s = fs.readFileSync(file, "utf8");
    s = s.replace(/\/\*[\s\S]*?\*\//g, "");      // 块注释
    s = s.replace(/(^|[^:])\/\/[^\n]*/g, "$1");   // 行注释（避开 URL 的 ://）
    s = s.replace(/,(\s*[}\]])/g, "$1");           // 尾逗号
    return JSON.parse(s);
  } catch { return null; }
}

// 从工程合成 arkts launch 配置：AppScope/app.json5 取 bundleName，entry module.json5 取入口 ability。
function discoverArktsConfig(folder) {
  if (!folder) return null;
  const root = folder.uri.fsPath;
  const app = readJson5(path.join(root, "AppScope", "app.json5"));
  const bundle = app && app.app && app.app.bundleName;
  if (!bundle) return null;
  const mod = readJson5(path.join(root, "entry", "src", "main", "module.json5"));
  const mm = mod && mod.module;
  const ability = (mm && Array.isArray(mm.abilities) && mm.abilities[0] && mm.abilities[0].name) || "EntryAbility";
  const moduleName = (mm && mm.name) || "entry";
  return { type: "arkts", request: "launch", name: "ArkUI Inspector (auto)", device: bundle, ability, module: moduleName };
}

function renderInspectorHtml(webview, uiRoot) {
  const uri = (...p) => webview.asWebviewUri(vscode.Uri.joinPath(uiRoot, ...p));
  const entryUri = uri("src", "arkui-inspector.js");
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
  <title>ArkUI 组件树检查器</title>
  <style>
    body { margin: 0; }
    .ai-bar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--panel-bg); position: sticky; top: 0; z-index: 2; }
    .ai-btn { background: var(--btn-bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; cursor: pointer; font-size: 13px; }
    .ai-btn:hover { border-color: var(--accent); }
    .ai-btn.active { background: var(--accent); color: var(--vscode-button-foreground, #fff); border-color: var(--accent); }
    .ai-status { color: var(--muted); font-size: 12px; }
    .ai-status.ok { color: var(--good); }
    .ai-status.error { color: var(--bad); }
    /* DevEco 式三栏：设备截图（左） | 组件树 + 属性（右）。点节点 → 截图上高亮。 */
    .ai-body { display: flex; align-items: flex-start; gap: 0; }
    .ai-screen { flex: 0 0 auto; padding: 12px 14px; position: sticky; top: 49px; }
    .ai-screen-wrap { position: relative; display: inline-block; background: #000; border-radius: 8px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
    #shot { display: block; max-height: 70vh; width: auto; cursor: crosshair; }
    #shot-hint { color: var(--muted); font-size: 11px; padding: 30px 10px; text-align: center; }
    #hl { position: absolute; display: none; pointer-events: none; border: 2px solid var(--accent, #4ea1ff); background: rgba(78,161,255,.18); box-shadow: 0 0 0 1px rgba(0,0,0,.4); z-index: 3; }
    #panel { flex: 1 1 auto; min-width: 0; padding: 8px 14px 24px; }
    /* 3D 分层视图：每个节点按 $rect 定位、按树深度沿 Z 轴拉开，透视旋转，拖拽可转。 */
    .ai-3d { perspective: 2000px; width: 560px; height: 72vh; overflow: hidden; cursor: grab; user-select: none; }
    .ai-3d.grabbing { cursor: grabbing; }
    .ai-3d-stage { position: absolute; left: 50%; top: 50%; transform-style: preserve-3d; }
    .layer3d { position: absolute; box-sizing: border-box; border: 1px solid rgba(120,170,255,.45); background: rgba(120,170,255,.06); opacity: .72; transition: border-color .1s; }
    .layer3d:hover { border-color: var(--accent); opacity: 1; }
    .layer3d.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); opacity: 1; z-index: 1; }
    .layer3d-top { opacity: 1; border-color: rgba(120,170,255,.7); }
    /* 独立视图：树/属性面板放开高度限制 */
    .inspector-tree { max-height: none; }
    .insp-tab-body { max-height: none; }
  </style>
</head>
<body>
  <div class="ai-bar">
    <button id="refresh" class="ai-btn">⟳ 刷新</button>
    <button id="mode3d" class="ai-btn" title="2D 截图 / 3D 分层视图切换">🧊 3D</button>
    <span id="status" class="ai-status"></span>
  </div>
  <div class="ai-body">
    <div class="ai-screen">
      <div class="ai-screen-wrap" id="wrap2d">
        <img id="shot" alt="设备截图" style="display:none" />
        <div id="shot-hint">（抓取后显示设备截图<br/>点组件树节点 → 此处高亮定位）</div>
        <div id="hl"></div>
      </div>
      <div class="ai-3d" id="scene3d" style="display:none"><div class="ai-3d-stage" id="stage3d"></div></div>
    </div>
    <div id="panel"></div>
  </div>
  <script type="module" src="${entryUri}"></script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
