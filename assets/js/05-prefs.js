"use strict";
/* 05-prefs.js —— Perch 自己的偏好：缓存、终端外观、默认目录。
   本文件在 10-term.js **之前**求值（xterm 建的时候要读字号/字体栈），
   在 85-settings.js 之前提供 SETTINGS / applySettings 这两样东西。

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
  startView: "workspace",      // "workspace" | "dash"
  language: "auto",            // "auto"（跟随系统）| "en" | "zh"
  uiMode: "classic",           // 当前只有 Classic；Clean 是之后加在终端面板上的皮套
  topMode: "workspaces",       // "workspaces" | "chat"（Chat 1.0 才启用）
  defaultAgent: "",            // 空 = 自动（优先有状态能力的已安装 agent）
  // 新建格快捷键：**应用内**、有焦点时生效。Ctrl/Alt 至少带一个，主键只认
  // A-Z / 0-9 / F1-F12；空串 = 关闭。这里存的是规范形状（Ctrl+Alt+N），
  // 录制器和匹配器都走 normalizeShortcutString 这一处，不在两边各拼一遍。
  newAgentShortcut: "Ctrl+Alt+N",
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
/* 设置页正在录制快捷键。**必须放在这个文件**（05 最先求值）：60-shell 的全局
   keydown 和 85-settings 的录制器都要读它，放在 85 里会留下一段 TDZ 窗口
   （`typeof` 一个还没初始化的 let 也会抛，见 60-shell.js:462 那条教训）。 */
let SHORTCUT_RECORDING = false;

/* ---- 快捷键的规范形状 ----------------------------------------------------
   规范：修饰键按 Ctrl → Alt → Shift 排，主键大写；必须带 Ctrl 或 Alt。
   · 录制、匹配、落盘、Go 侧校验都用同一套规则；空串 = 关闭。
   · 为什么主键用 e.code 而不是 e.key：中文/非 US 布局下 e.key 可能不是
     字母（Shift+1 还会变成 "!"），录进去的键和按出来的键就对不上。
     e.code 是**物理键位**（KeyN / Digit1 / F5），显示成 N / 1 / F5。 */
function normalizeShortcutString(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  const parts = s.split("+").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const key = parts.pop().toUpperCase();
  if (!/^[A-Z0-9]$/.test(key) && !/^F([1-9]|1[0-2])$/.test(key)) return "";
  const mods = new Set();
  for (const p of parts) {
    const low = p.toLowerCase();
    const m = low === "ctrl" ? "Ctrl" : low === "alt" ? "Alt" : low === "shift" ? "Shift" : "";
    if (!m || mods.has(m)) return "";
    mods.add(m);
  }
  if (!mods.has("Ctrl") && !mods.has("Alt")) return "";
  return ["Ctrl", "Alt", "Shift"].filter((m) => mods.has(m)).concat(key).join("+");
}
function shortcutKeyFromEvent(e) {
  const code = String((e && e.code) || "");
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return "";
}
function shortcutChordFromEvent(e) {
  const key = shortcutKeyFromEvent(e);
  if (!key) return "";
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (!mods.includes("Ctrl") && !mods.includes("Alt")) return "";
  return mods.concat(key).join("+");
}
function shortcutMatches(e, chord) {
  const want = normalizeShortcutString(chord);
  if (!want || !e) return false;
  const parts = want.split("+");
  const key = parts.pop();
  const mods = new Set(parts);
  if (!!e.ctrlKey !== mods.has("Ctrl")) return false;
  if (!!e.altKey !== mods.has("Alt")) return false;
  if (!!e.shiftKey !== mods.has("Shift")) return false;
  if (e.metaKey) return false;
  return shortcutKeyFromEvent(e) === key;
}

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
  // 启动落点默认工作区。只有用户明确存过 "dash" 才先画总览；
  // 空/旧缓存/手改坏的值都回到工作区，不再默认落在总览。
  s.startView = String(s.startView || "").toLowerCase() === "dash"
    ? "dash"
    : "workspace";
  const lang = String(s.language || "").toLowerCase();
  s.language = (lang === "en" || lang === "zh") ? lang : "auto";
  // Beta.3 当前这套降噪外观就是 Classic。旧缓存把它叫 clean 的也归到 classic；
  // 真正的 Clean（终端面板皮套）等这一轮验收后再讨论。
  s.uiMode = "classic";
  s.topMode = String(s.topMode || "").toLowerCase() === "chat" ? "chat" : "workspaces";
  // agent id 只做去空白；能不能用由 30-pages 的 defaultAgentId() 对着
  // **当前探测到的名单**判（设置里写着、但这台机器没装 = 回落到自动）。
  s.defaultAgent = typeof s.defaultAgent === "string" ? s.defaultAgent.trim().toLowerCase() : "";
  // 手改坏的值落回**关闭**而不是默认键：一个看不懂的字符串不该悄悄变成
  // 一个会吃掉终端按键的组合键。缺字段时 Object.assign 已给了默认值。
  s.newAgentShortcut = normalizeShortcutString(s.newAgentShortcut);
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

/* Beta.3 只有 Classic 这一层外观；真正的 Clean 是之后加在终端面板上的皮套，
   不在这里冒充。类名放在 #app/body 上，首帧内联脚本也会先加一次。 */
function applyUIMode() {
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.add("ui-classic");
  app.classList.remove("ui-clean");
  if (document.body) {
    document.body.classList.add("ui-classic");
    document.body.classList.remove("ui-clean");
  }
}

/* 应用一份设置。
   meta.fromGo = true：Go 发来的权威整份（缺的字段用默认补，不继承本地旧值）。
   meta.effectiveCwd / builtinCwd / defaultCwdMissing：Go 现算的三样。 */
function applySettings(next, meta) {
  const m = meta || {};
  const base = m.fromGo ? SETTINGS_DEFAULTS : SETTINGS;
  SETTINGS = normalizeSettings(Object.assign({}, base, next || {}));
  saveSettingsCache();
  if (typeof setLocale === "function") setLocale(SETTINGS.language);
  applyUIMode();
  if (typeof renderTopMode === "function") renderTopMode();

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
