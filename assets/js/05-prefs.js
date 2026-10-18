"use strict";
/* 05-prefs.js —— Perch 自己的偏好：缓存、终端外观、默认目录。
   本文件在 10-term.js **之前**求值（xterm 建的时候要读字号/字体栈），
   在 84-settings.js 之前提供 SETTINGS / applySettings 这两样东西。

   两份事实的分工：
     · Go 的 %APPDATA%\Perch\settings.json 是**权威**（见 settings.go）；
     · localStorage 这份只是**首帧缓存** —— 启动落点（#app 要不要先带 dash）
       必须在第一个 defer 脚本之前就知道，等不到 shell 载荷。
   所以：本地改动先乐观写缓存，Go 的 settings 消息一到就以 Go 为准
   （fromGo=true 时整份替换，避免"盘上少一个字段、前端还留着旧值"）。

   ⚠️ 这里**不碰** agent 自己的配置。模型/网关/权限是 magpie 和 agent 配置抽屉
   的事；两份状态搅在一起是上一轮明确避开的那类错。 */

const SETTINGS_DEFAULTS = Object.freeze({
  defaultCwd: "",              // 空 = 内置 <用户主目录>\Documents\Perch
  termFontSize: 14,
  termFontFamily: "cascadia",  // "cascadia" | "jetbrains"
  startView: "dash",           // "dash" | "workspace"
  confirmClose: true,
  confirmEndAgent: true,
});
const SETTINGS_CACHE_KEY = "perch.settings.v1";

let SETTINGS = loadSettingsCache();
// Go 现算的三样：生效目录 / 内置目录 / 用户选的目录此刻在不在盘上。
// 它们不落 localStorage —— 盘上的事实要每次问 Go。
let SETTINGS_EFFECTIVE_CWD = "";
let SETTINGS_BUILTIN_CWD = "";
let SETTINGS_CWD_MISSING = false;
// 10-term.js 末尾会置 true。在此之前 applySettings 只改缓存，不碰终端。
let PERCH_TERM_READY = false;

function normalizeSettings(raw) {
  const d = SETTINGS_DEFAULTS;
  const s = Object.assign({}, d, raw || {});
  s.defaultCwd = typeof s.defaultCwd === "string" ? s.defaultCwd.trim() : "";
  const size = Math.round(Number(s.termFontSize));
  s.termFontSize = Number.isFinite(size)
    ? Math.min(18, Math.max(12, size))
    : d.termFontSize;
  s.termFontFamily = String(s.termFontFamily || "").toLowerCase() === "jetbrains"
    ? "jetbrains"
    : "cascadia";
  s.startView = String(s.startView || "").toLowerCase() === "workspace"
    ? "workspace"
    : "dash";
  s.confirmClose = s.confirmClose !== false;
  s.confirmEndAgent = s.confirmEndAgent !== false;
  return s;
}

function loadSettingsCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_CACHE_KEY) || "null");
    return normalizeSettings(raw || {});
  } catch (_) {
    return normalizeSettings({});
  }
}

function saveSettingsCache() {
  try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(SETTINGS)); }
  catch (_) { /* 存不了就只在这一次生效；Go 那份仍然是权威 */ }
}

// 终端字体栈。和 CSS 的 --mono 同一组字体，只把首选换位置 ——
// 两套字体都随应用分发（@font-face），不依赖系统装没装。
const TERM_FONT_CASCADIA =
  '"Cascadia Code WB", "JetBrains Mono WB", Consolas, "Microsoft YaHei", monospace';
const TERM_FONT_JETBRAINS =
  '"JetBrains Mono WB", "Cascadia Code WB", Consolas, "Microsoft YaHei", monospace';
function termFontStack() {
  return SETTINGS.termFontFamily === "jetbrains" ? TERM_FONT_JETBRAINS : TERM_FONT_CASCADIA;
}
function termFontFamilyLabel() {
  return SETTINGS.termFontFamily === "jetbrains" ? "JetBrains Mono" : "Cascadia Code";
}

/* 应用一份设置。
   meta.fromGo = true：Go 发来的权威整份（缺的字段用默认补，不继承本地旧值）。
   meta.effectiveCwd / builtinCwd / defaultCwdMissing：Go 现算的三样。 */
function applySettings(next, meta) {
  const m = meta || {};
  const base = m.fromGo ? SETTINGS_DEFAULTS : SETTINGS;
  SETTINGS = normalizeSettings(Object.assign({}, base, next || {}));
  saveSettingsCache();

  if (typeof m.effectiveCwd === "string" && m.effectiveCwd) {
    SETTINGS_EFFECTIVE_CWD = m.effectiveCwd;
    // 状态栏那一行「工作目录」读 STATE.cwd（见 renderShell）。权威值到了就换，
    // 不重跑 renderShell（那会把启动探针和列表一起重报一遍）。
    if (typeof STATE !== "undefined" && STATE) STATE.cwd = m.effectiveCwd;
    const sc = document.getElementById("s-cwd");
    if (sc) { sc.textContent = m.effectiveCwd; sc.title = m.effectiveCwd; }
  }
  if (typeof m.builtinCwd === "string") SETTINGS_BUILTIN_CWD = m.builtinCwd;
  if (typeof m.defaultCwdMissing === "boolean") SETTINGS_CWD_MISSING = m.defaultCwdMissing;

  // 本地刚改了默认目录：先按用户选的那条乐观显示；Go 若拒绝，会推回旧值。
  if (!m.fromGo && next && Object.prototype.hasOwnProperty.call(next, "defaultCwd")) {
    SETTINGS_CWD_MISSING = false;
    SETTINGS_EFFECTIVE_CWD = SETTINGS.defaultCwd || SETTINGS_BUILTIN_CWD || "";
  }

  applyTermAppearance();
  if (typeof syncSettingsUI === "function" && typeof NAV_HERE !== "undefined" &&
      NAV_HERE === "settings") syncSettingsUI();
}

// 把外观改到**所有**已经存在的格子上。xterm 的字体/字号必须在运行时改
// term.options，再清一遍 WebGL 字形图集（旧图集是按旧字体度量的），
// 最后 refit —— 单元格宽高变了，PTY 的列/行也得跟着重算。
function applyTermAppearance() {
  if (!PERCH_TERM_READY) return;
  try {
    for (const t of TAB_LIST) {
      if (t && typeof t.applyAppearance === "function") t.applyAppearance();
    }
    if (typeof paintFontStatus === "function") paintFontStatus();
  } catch (e) {
    if (typeof jserr === "function") jserr("applyTermAppearance", e);
  }
}
