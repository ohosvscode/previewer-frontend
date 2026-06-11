// 自动发现 & 自动选择：SDK previewer 工具（lite Simulator / rich Previewer）+ 按工程构建产物判模型并算参数。
// 纯函数（只依赖 fs/path），便于单测。extension.js 据此免去手填 sim/app/arp/pages…

const fs = require("fs");
const path = require("path");
const os = require("os");

/** 找 SDK 的 previewer 目录（含 common/bin/Previewer 与 liteWearable/bin/Simulator）。 */
function findPreviewerDir(explicit) {
  const cands = [];
  if (explicit) {
    cands.push(explicit);                          // 可能直接是 previewer 目录
    cands.push(path.join(explicit, "previewer"));  // 或 SDK 根
  }
  const home = os.homedir();
  // ~/Library/OpenHarmony/Sdk/<ver>/previewer（取存在的最高版本）
  const sdkRoot = path.join(home, "Library", "OpenHarmony", "Sdk");
  try {
    for (const ver of fs.readdirSync(sdkRoot).sort().reverse()) {
      cands.push(path.join(sdkRoot, ver, "previewer"));
    }
  } catch { /* none */ }
  cands.push("/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/previewer");
  cands.push("/Applications/DevEco-Studio.app/Contents/sdk/default/hms/previewer");
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, "common", "bin", "Previewer"))) return c;
    if (c && fs.existsSync(path.join(c, "liteWearable", "bin", "Simulator"))) return c;
  }
  return null;
}

const EXE = process.platform === "win32" ? ".exe" : "";
function liteSimulator(prevDir) { return path.join(prevDir, "liteWearable", "bin", "Simulator" + EXE); }
function richPreviewer(prevDir) { return path.join(prevDir, "common", "bin", "Previewer" + EXE); }

/** 在工程根下找候选构建中间产物目录 `<module>/build/<mode>/intermediates`（深度受限）。 */
function findIntermediates(root) {
  const out = [];
  const tryDir = (moduleDir) => {
    const buildDir = path.join(moduleDir, "build");
    let modes;
    try { modes = fs.readdirSync(buildDir); } catch { return; }
    for (const mode of modes) {
      const inter = path.join(buildDir, mode, "intermediates");
      if (fs.existsSync(inter)) out.push({ inter, moduleDir });
    }
  };
  // 直接子目录（entry/ 等）+ products/* （多 product 工程，如 sample 的 products/phone）
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
  for (const name of top) {
    if (name.startsWith(".") || name === "node_modules" || name === "oh_modules") continue;
    const md = path.join(root, name);
    tryDir(md);
    if (name === "products") {
      let prods = [];
      try { prods = fs.readdirSync(md, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
      for (const p of prods) tryDir(path.join(md, p));
    }
  }
  return out;
}

function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

/** 读 main_pages.json 的首个路由作为入口 url（取不到则回退）。 */
function firstRoute(pagesJson, fallback) {
  try {
    const j = JSON.parse(fs.readFileSync(pagesJson, "utf8"));
    if (Array.isArray(j.src) && j.src.length) return j.src[0];
  } catch { /* none */ }
  return fallback;
}

/**
 * 探测工程并自动选择 previewer。返回完整启动配置或 null。
 * lite：loader_out_lite/.../js/MainAbility（FA liteWearable）；rich：loader_out/default/ets（Stage）。
 * 多候选取构建产物最新的。
 */
function detectProject(root, prevDir) {
  const cands = [];
  for (const { inter, moduleDir } of findIntermediates(root)) {
    const bundle = path.basename(moduleDir);
    const liteApp = path.join(inter, "loader_out_lite", "default", "js", "MainAbility");
    const richApp = path.join(inter, "loader_out", "default", "ets");
    if (fs.existsSync(path.join(richApp, "modules.abc")) || fs.existsSync(richApp)) {
      const arp = path.join(inter, "res", "default");
      const pages = path.join(arp, "resources", "base", "profile", "main_pages.json");
      const ljpath = path.join(inter, "loader", "default", "loader.json");
      if (fs.existsSync(arp) && fs.existsSync(pages)) {
        cands.push({
          model: "rich", bundle, mtime: mtime(richApp),
          sim: richPreviewer(prevDir), app: richApp,
          device: "phone", shape: "rect", width: 1080, height: 2340,
          projectModel: "Stage", arp, pages,
          ljpath: fs.existsSync(ljpath) ? ljpath : null,
          url: firstRoute(pages, "pages/Index"),
        });
      }
    }
    if (fs.existsSync(path.join(liteApp, "app.js"))) {
      cands.push({
        model: "lite", bundle, mtime: mtime(liteApp),
        sim: liteSimulator(prevDir), app: liteApp,
        device: "liteWearable", shape: "circle", width: 466, height: 466,
        projectModel: "FA", arp: null, pages: null, ljpath: null,
        url: "pages/index/index",
      });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0];
}

/** 把配置（自动探测或手动覆盖）拼成 previewer-host 命令行参数。 */
function buildHostArgs(c, bind) {
  const a = ["--sim", c.sim, "--app", c.app, "--bind", bind,
    "--device", c.device, "--shape", c.shape,
    "--width", String(c.width), "--height", String(c.height),
    "--project-model", c.projectModel, "--url", c.url, "--bundle", c.bundle];
  if (c.arp) a.push("--arp", c.arp);
  if (c.pages) a.push("--pages", c.pages);
  if (c.ljpath) a.push("--ljpath", c.ljpath);
  return a;
}

module.exports = { findPreviewerDir, liteSimulator, richPreviewer, findIntermediates, detectProject, buildHostArgs };
