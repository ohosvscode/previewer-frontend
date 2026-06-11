// OpenHarmony Previewer —— VSCode 扩展 E2E（gated）。
// 在真实 VSCode 扩展宿主里：激活扩展、执行「打开预览」→ 扩展 spawn previewer-host（驱动真 Simulator+app）
// 并开 webview；测试侧独立连 host gateway 的 /ws，断言收到 hello 事件 + 二进制帧（Simulator→host 全链路）。
// 无 host 二进制 / 无 Simulator / 无 app → 整组 skip（不污染 CI）。

const assert = require('assert');
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const WS = require('ws');

const EXT_ID = 'openharmony-previewer-frontend.oh-previewer';
const PORT = 9077;
const BIND = `127.0.0.1:${PORT}`;
const HOME = process.env.HOME || '';
const SIM = process.env.OHPREV_SIM || `${HOME}/Library/OpenHarmony/Sdk/23/previewer/liteWearable/bin/Simulator`;
const APP = process.env.OHPREV_APP || `${HOME}/DevEcoStudioProjects/claude/entry/build/default/intermediates/loader_out_lite/default/js/MainAbility`;

function extDir() {
  return vscode.extensions.getExtension(EXT_ID).extensionPath;
}
function hostBin() {
  const exe = process.platform === 'win32' ? 'previewer-host.exe' : 'previewer-host';
  for (const prof of ['release', 'debug']) {
    const p = path.resolve(extDir(), '..', '..', 'target', prof, exe);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(extDir(), '..', '..', 'target', 'debug', exe);
}

/** 重试连接 gateway /ws，直到收到二进制帧或超时。 */
async function waitForFrame(url, totalMs) {
  const deadline = Date.now() + totalMs;
  let sawHello = false;
  while (Date.now() < deadline) {
    const r = await new Promise((resolve) => {
      const ws = new WS(url);
      const got = { hello: false, frame: false };
      const fin = () => { try { ws.terminate(); } catch { /* ignore */ } resolve(got); };
      const t = setTimeout(fin, 4000);
      ws.on('message', (data, isBinary) => {
        if (isBinary) { got.frame = true; clearTimeout(t); fin(); }
        else { got.hello = true; }
      });
      ws.on('error', () => { clearTimeout(t); resolve(got); });
      ws.on('close', () => { clearTimeout(t); resolve(got); });
    });
    sawHello = sawHello || r.hello;
    if (r.frame) return { hello: sawHello || r.hello, frame: true };
    await new Promise((res) => setTimeout(res, 500));
  }
  return { hello: sawHello, frame: false };
}

describe('OpenHarmony Previewer E2E（gated）', function () {
  this.timeout(90000);

  before(function () {
    const reasons = [];
    if (!fs.existsSync(hostBin())) reasons.push(`host 未构建（${hostBin()}）`);
    if (!fs.existsSync(SIM)) reasons.push(`无 Simulator（${SIM}）`);
    if (!fs.existsSync(APP)) reasons.push(`无 app 目录（${APP}）`);
    if (reasons.length) {
      console.log('[ohprev-e2e] 跳过：' + reasons.join('；'));
      this.skip();
    }
    try { cp.execSync('pkill -f previewer-host'); } catch { /* none */ }
  });

  afterEach(async () => {
    try { cp.execSync('pkill -f previewer-host'); } catch { /* none */ }
    await new Promise((r) => setTimeout(r, 500));
  });

  it('扩展激活 + 命令注册', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `未找到扩展 ${EXT_ID}`);
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('ohPreviewer.open'), '应注册 ohPreviewer.open 命令');
  });

  it('打开预览 → spawn host + gateway 出帧（Simulator→host 全链路）+ webview 面板', async () => {
    await vscode.extensions.getExtension(EXT_ID).activate();
    const cfg = vscode.workspace.getConfiguration('ohPreviewer');
    const G = vscode.ConfigurationTarget.Global;
    await cfg.update('hostBin', hostBin(), G);
    await cfg.update('bind', BIND, G);
    await cfg.update('sim', SIM, G);
    await cfg.update('app', APP, G);

    await vscode.commands.executeCommand('ohPreviewer.open');

    const r = await waitForFrame(`ws://${BIND}/ws`, 45000);
    assert.ok(r.hello, 'gateway 应下发 hello 事件');
    assert.ok(r.frame, 'gateway 应推送二进制帧（host 驱动真 Simulator+app 的全链路）');

    // 扩展确实开了 webview 面板（标签含 Previewer）
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => /Previewer/i.test(t.label)), '应创建 Previewer webview 面板');
  });
});
