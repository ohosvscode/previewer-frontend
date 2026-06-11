// 自动发现 & 自动选择：SDK previewer 工具（lite Simulator / rich Previewer）+ 按工程构建产物判模型并算参数。
// 纯函数（只依赖 fs/path），便于单测。extension.js 据此免去手填 sim/app/arp/pages…

const fs = require("fs");
const path = require("path");
const os = require("os");

const EXE = process.platform === "win32" ? ".exe" : "";

/** 一个 previewer 目录是否含有可用工具（rich Previewer 或 lite Simulator）。 */
function hasPreviewer(dir) {
  return !!dir && (
    fs.existsSync(path.join(dir, "common", "bin", "Previewer" + EXE)) ||
    fs.existsSync(path.join(dir, "liteWearable", "bin", "Simulator" + EXE))
  );
}

/** 由一个「基目录」展开候选 previewer 目录：base/previewer、base 本身、base/<ver>/previewer（版本倒序）。 */
function expandSdkBase(base) {
  const out = [base, path.join(base, "previewer")];
  // SDK 根下常是 <ver>/previewer（如 .../Sdk/23/previewer）；也兼容 OpenHarmony/Sdk/HarmonyOS-NEXT/... 命名
  let vers = [];
  try {
    vers = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* none */ }
  // 数字版本优先、倒序；非数字（如 HarmonyOS-NEXT）追加在后
  vers.sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    if (!isNaN(na)) return -1;
    if (!isNaN(nb)) return 1;
    return b.localeCompare(a);
  });
  for (const v of vers) {
    out.push(path.join(base, v, "previewer"));
    out.push(path.join(base, v, "openharmony", "previewer"));
    out.push(path.join(base, v, "hms", "previewer"));
  }
  return out;
}

/** 跨平台找 SDK 的 previewer 目录（含 common/bin/Previewer 与 liteWearable/bin/Simulator）。 */
function findPreviewerDir(explicit) {
  const home = os.homedir();
  const env = process.env;
  const bases = [];
  if (explicit) bases.push(explicit);
  // 环境变量（各 IDE/CI 常用）
  for (const k of ["OHOS_SDK_HOME", "HOS_SDK_HOME", "DEVECO_SDK_HOME", "OHOS_BASE_SDK_HOME", "HARMONYOS_SDK_HOME"]) {
    if (env[k]) bases.push(env[k]);
  }
  if (process.platform === "darwin") {
    bases.push(
      path.join(home, "Library", "OpenHarmony", "Sdk"),
      path.join(home, "Library", "Huawei", "Sdk"),
      "/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony",
      "/Applications/DevEco-Studio.app/Contents/sdk/default/hms",
    );
  } else if (process.platform === "win32") {
    const la = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    bases.push(
      path.join(la, "OpenHarmony", "Sdk"),
      path.join(la, "Huawei", "Sdk"),
      "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony",
      "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\hms",
    );
  } else {
    // linux
    bases.push(
      path.join(home, "OpenHarmony", "Sdk"),
      path.join(home, "Huawei", "Sdk"),
      path.join(home, ".harmonyos", "sdk"),
      "/opt/deveco-studio/sdk/default/openharmony",
      "/opt/deveco-studio/sdk/default/hms",
    );
  }
  for (const base of bases) {
    if (!base) continue;
    for (const dir of expandSdkBase(base)) {
      if (hasPreviewer(dir)) return dir;
    }
  }
  return null;
}
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
