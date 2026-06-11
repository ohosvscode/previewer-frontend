// discover.js 纯单元测试（无 VSCode/SDK 依赖）：用临时目录造工程/SDK 结构，验证自动发现与自动选择。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../../discover');

function mkfile(p, content = '') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ohprev-disc-'));
}

/** 造一个假的 previewer 目录（common/bin/Previewer + liteWearable/bin/Simulator）。 */
function fakePreviewer() {
  const dir = tmp();
  mkfile(path.join(dir, 'common', 'bin', 'Previewer'), 'x');
  mkfile(path.join(dir, 'liteWearable', 'bin', 'Simulator'), 'x');
  return dir;
}

describe('discover.findPreviewerDir', () => {
  it('显式目录含工具 → 返回它', () => {
    const dir = fakePreviewer();
    assert.strictEqual(d.findPreviewerDir(dir), dir);
  });
  it('显式 SDK 根（其下 previewer/）也能找到', () => {
    const sdk = tmp();
    const prev = path.join(sdk, 'previewer');
    mkfile(path.join(prev, 'common', 'bin', 'Previewer'), 'x');
    assert.strictEqual(d.findPreviewerDir(sdk), prev);
  });
});

describe('discover.detectProject', () => {
  const prev = fakePreviewer();

  it('Stage 工程（loader_out + res）→ rich', () => {
    const root = tmp();
    const inter = path.join(root, 'entry', 'build', 'default', 'intermediates');
    mkfile(path.join(inter, 'loader_out', 'default', 'ets', 'modules.abc'), 'x');
    mkfile(path.join(inter, 'res', 'default', 'resources', 'base', 'profile', 'main_pages.json'),
      JSON.stringify({ src: ['pages/Home', 'pages/Other'] }));
    mkfile(path.join(inter, 'loader', 'default', 'loader.json'), '{}');

    const det = d.detectProject(root, prev);
    assert.ok(det, '应检测到');
    assert.strictEqual(det.model, 'rich');
    assert.strictEqual(det.bundle, 'entry');
    assert.strictEqual(det.projectModel, 'Stage');
    assert.strictEqual(det.url, 'pages/Home', '应取 main_pages.json 首个路由');
    assert.ok(det.sim.endsWith(path.join('common', 'bin', 'Previewer')), 'sim 应为 rich Previewer');
    assert.ok(det.arp && det.pages && det.ljpath, 'rich 应含 arp/pages/ljpath');

    const args = d.buildHostArgs(det, '127.0.0.1:0');
    assert.ok(args.includes('--project-model') && args[args.indexOf('--project-model') + 1] === 'Stage');
    assert.ok(args.includes('--arp') && args.includes('--pages') && args.includes('--ljpath'));
  });

  it('FA-lite 工程（loader_out_lite + app.js）→ lite', () => {
    const root = tmp();
    const inter = path.join(root, 'entry', 'build', 'default', 'intermediates');
    mkfile(path.join(inter, 'loader_out_lite', 'default', 'js', 'MainAbility', 'app.js'), 'x');

    const det = d.detectProject(root, prev);
    assert.ok(det, '应检测到');
    assert.strictEqual(det.model, 'lite');
    assert.strictEqual(det.device, 'liteWearable');
    assert.strictEqual(det.projectModel, 'FA');
    assert.ok(det.sim.endsWith(path.join('liteWearable', 'bin', 'Simulator')), 'sim 应为 lite Simulator');
    assert.ok(!det.arp && !det.pages, 'lite 不含 arp/pages');
  });

  it('products/<p> 多 product 工程也能探测', () => {
    const root = tmp();
    const inter = path.join(root, 'products', 'phone', 'build', 'default', 'intermediates');
    mkfile(path.join(inter, 'loader_out', 'default', 'ets', 'modules.abc'), 'x');
    mkfile(path.join(inter, 'res', 'default', 'resources', 'base', 'profile', 'main_pages.json'),
      JSON.stringify({ src: ['page/Splash'] }));
    const det = d.detectProject(root, prev);
    assert.ok(det && det.model === 'rich' && det.bundle === 'phone');
  });

  it('无构建产物 → null', () => {
    assert.strictEqual(d.detectProject(tmp(), prev), null);
  });
});
