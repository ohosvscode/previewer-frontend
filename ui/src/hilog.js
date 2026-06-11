// HiLog 日志控制台（真机）—— 接收扩展流式 hdc hilog 行，前端过滤/级别着色/暂停/清空/自动滚动。
// 行格式：`MM-DD HH:MM:SS.mmm  PID  TID L DOMAIN/TAG: message`，L ∈ D/I/W/E/F。

const vscode = acquireVsCodeApi();
const listEl = document.getElementById("list");
const fltEl = document.getElementById("flt");
const levelEl = document.getElementById("level");
const pauseBtn = document.getElementById("pause");
const clearBtn = document.getElementById("clear");
const countEl = document.getElementById("count");

const MAX_KEEP = 8000; // 原始行上限
const MAX_ROWS = 3000; // DOM 行上限
const LV = { D: 0, I: 1, W: 2, E: 3, F: 4 };
const LV_RE = /\d{4,}\s+\d{4,}\s+([DIWEFidwef])\s/;

let all = []; // 原始行
let paused = false;

function levelOf(line) {
  const m = LV_RE.exec(line);
  return m ? m[1].toUpperCase() : "I";
}

// 过滤：空格分词，全部命中（AND）；`!` 前缀为排除。级别 >= 选定下限。
function buildMatcher() {
  const q = fltEl.value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const inc = terms.filter((t) => !t.startsWith("!"));
  const exc = terms.filter((t) => t.startsWith("!")).map((t) => t.slice(1)).filter(Boolean);
  const minLv = LV[levelEl.value] ?? -1;
  return (line) => {
    if (minLv >= 0 && (LV[levelOf(line)] ?? 1) < minLv) return false;
    const low = line.toLowerCase();
    for (const t of inc) if (!low.includes(t)) return false;
    for (const t of exc) if (low.includes(t)) return false;
    return true;
  };
}

function rowEl(line) {
  const div = document.createElement("div");
  div.className = "lg-row lv-" + levelOf(line);
  div.textContent = line;
  return div;
}

function atBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
}

function appendRows(lines, match) {
  const stick = !paused && atBottom();
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const line of lines) {
    if (!line || !match(line)) continue;
    frag.appendChild(rowEl(line));
    added++;
  }
  if (added) {
    listEl.appendChild(frag);
    // 限制 DOM 行数
    while (listEl.childElementCount > MAX_ROWS) listEl.removeChild(listEl.firstChild);
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }
  countEl.textContent = `${all.length} 行`;
}

function rerender() {
  const match = buildMatcher();
  listEl.innerHTML = "";
  const start = Math.max(0, all.length - MAX_ROWS * 3);
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (let i = start; i < all.length; i++) {
    if (!match(all[i])) continue;
    frag.appendChild(rowEl(all[i]));
    if (++shown > MAX_ROWS) frag.removeChild(frag.firstChild);
  }
  listEl.appendChild(frag);
  countEl.textContent = `${all.length} 行`;
  if (!paused) window.scrollTo(0, document.body.scrollHeight);
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m) return;
  if (m.channel === "log") {
    all.push(...m.lines);
    if (all.length > MAX_KEEP) all = all.slice(all.length - MAX_KEEP);
    if (!paused) appendRows(m.lines, buildMatcher());
    else countEl.textContent = `${all.length} 行（已暂停）`;
  } else if (m.channel === "logErr") {
    listEl.appendChild(Object.assign(document.createElement("div"), { className: "lg-row lv-E", textContent: "⚠ " + m.message }));
  } else if (m.channel === "logEnd") {
    listEl.appendChild(Object.assign(document.createElement("div"), { className: "lg-row lg-meta", textContent: `— hilog 进程结束 (code ${m.code}) —` }));
  }
});

fltEl.addEventListener("input", rerender);
levelEl.addEventListener("change", rerender);
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.classList.toggle("active", paused);
  pauseBtn.textContent = paused ? "▶ 继续" : "⏸ 暂停";
  if (!paused) rerender();
});
clearBtn.addEventListener("click", () => { all = []; listEl.innerHTML = ""; countEl.textContent = "0 行"; });

vscode.postMessage({ channel: "ready" });
