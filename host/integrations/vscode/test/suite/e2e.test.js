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
// 自动发现/自动选择用例：以 sample（Stage）作工作区，扩展应自动选 rich Previewer。
const SAMPLE = process.env.OHPREV_WS || '/Users/sanchuan/Documents/sample_in_harmonyos';
const RICH = `${HOME}/Library/OpenHarmony/Sdk/23/previewer/common/bin/Previewer`;
const SAMPLE_RICH_APP = `${SAMPLE}/products/phone/build/default/intermediates/loader_out/default/ets`;

/** 跨平台杀掉残留的 host + Previewer/Simulator 进程。 */
function killHosts() {
  const cmds = process.platform === 'win32'
    ? ['taskkill /F /T /IM previewer-host.exe', 'taskkill /F /T /IM Previewer.exe', 'taskkill /F /T /IM Simulator.exe']
    : ['pkill -f previewer-host', 'pkill -f common/bin/Previewer', 'pkill -f liteWearable/bin/Simulator'];
  for (const c of cmds) { try { cp.execSync(c, { stdio: 'ignore' }); } catch { /* none */ } }
}

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
    killHosts();
  });

  afterEach(async () => {
    killHosts();
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

  it('webview 真渲染了画面（动态端口；完整画面环 Simulator→host→扩展→webview→canvas）', async () => {
    const api = await vscode.extensions.getExtension(EXT_ID).activate();
    assert.ok(api && typeof api.lastRenderedCount === 'function', '扩展应导出 lastRenderedCount（测试观测口）');
    api.resetRendered();

    const cfg = vscode.workspace.getConfiguration('ohPreviewer');
    const G = vscode.ConfigurationTarget.Global;
    await cfg.update('hostBin', hostBin(), G);
    await cfg.update('bind', '', G); // 空 → 动态端口（OS 分配）；扩展解析 host 输出拿真实端口再连
    await cfg.update('sim', SIM, G);
    await cfg.update('app', APP, G);

    await vscode.commands.executeCommand('ohPreviewer.open');

    // 轮询：webview 每画一帧回发 rendered；> 0 即「画面」确实绘到 canvas 上了。
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && api.lastRenderedCount() === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(api.lastRenderedCount() > 0,
      `webview 应至少渲染一帧（实际 ${api.lastRenderedCount()}）——完整画面环未跑通`);
  });

  it('自动发现/自动选择：sample(Stage) → rich Previewer 并渲染', async function () {
    if (!fs.existsSync(RICH)) { console.log('[ohprev-e2e] 跳过 rich：无 ' + RICH); this.skip(); }
    if (!fs.existsSync(SAMPLE_RICH_APP)) { console.log('[ohprev-e2e] 跳过 rich：sample 未构建 ' + SAMPLE_RICH_APP); this.skip(); }

    const api = await vscode.extensions.getExtension(EXT_ID).activate();
    assert.ok(api && typeof api.lastPicked === 'function', '扩展应导出 lastPicked');
    api.resetRendered();

    const cfg = vscode.workspace.getConfiguration('ohPreviewer');
    const G = vscode.ConfigurationTarget.Global;
    await cfg.update('hostBin', hostBin(), G);
    // 清空手动覆盖 → 走自动发现/自动选择（工作区即 sample，见 .vscode-test.mjs workspaceFolder）
    await cfg.update('sim', undefined, G);
    await cfg.update('app', undefined, G);
    await cfg.update('sdk', undefined, G);
    await cfg.update('bind', '', G); // 动态端口

    await vscode.commands.executeCommand('ohPreviewer.open');

    // 等自动选择落定 + 画面渲染
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && api.lastRenderedCount() === 0) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const picked = api.lastPicked();
    assert.ok(picked, '应自动选择到一个 previewer 配置');
    assert.strictEqual(picked.model, 'rich', `Stage 工程应自动选 rich，实际 ${picked.model}`);
    assert.strictEqual(picked.bundle, 'phone', `应识别模块 phone，实际 ${picked.bundle}`);
    assert.ok(/common\/bin\/Previewer/.test(picked.sim), 'sim 应为 rich Previewer');
    assert.ok(api.lastRenderedCount() > 0, `sample 应渲染出帧（实际 ${api.lastRenderedCount()}）`);
  });
});
