"use strict";
/* 85-settings.js —— 设置页的交互 + 通用确认框。
   本文件在 80-live.js 之后、86-dash.js 之前求值：setNavView("settings") 要用
   这里的 renderSettings；60-shell.js 的 endAgent 也会在**事件触发时**调
   askConfirm（那时本文件早已求值完）。

   设置的两份事实见 05-prefs.js 文件头：Go 的 settings.json 权威，localStorage
   只是首帧缓存。这里的写路径大多是**乐观**的 —— 先 applySettings 让界面立刻变，
   再发 settings.set；Go 拒绝时会把旧值整份推回来（20-ctl.js 的 settings 分支）。
   例外是默认目录：路径是否有效只有 Go 知道，所以输入框保留草稿、等答复再收口。 */

// ---------------------------------------------------------------------------
// 设置页
// ---------------------------------------------------------------------------

function settingsCurrentPath() {
  // Go 现算的生效目录优先；它还没到时退回本地缓存 / 状态栏那份。
  return SETTINGS_EFFECTIVE_CWD || SETTINGS.defaultCwd || (STATE && STATE.cwd) || "";
}

/* 默认目录输入框的草稿状态。
   · dirty：用户打了字、还没被后端确认 —— 这期间任何 settings 消息都不能把输入框
     冲掉（Go 每次 settings.set 都会推回一整份权威值）。
   · pending：已经发出去、等 Go 回话。Go 的校验（目录存在、转绝对路径）在那边，
     成功会带着规范化的路径回来；失败只推 err + 旧值，错误就显示在输入框下面。
   · skipBlur：点「选择目录…」/「恢复默认」时先触发的是 blur，那颗按钮的意思是
     "丢掉草稿"，不能顺势把它提交一次。 */
let CWD_DRAFT_DIRTY = false;
let CWD_PENDING = false;
let CWD_SKIP_BLUR = false;
/* CWD_ERR 存的是「怎么说」而不是「说出来的那句话」：
   { key } = 前端自己的文案键；{ code, params, text } = 后端 uimsg。
   切语言时只需重画（settingsCwdPaintError），旧语言的那句不会留在屏上。 */
let CWD_ERR = null;
let CWD_PENDING_TIMER = 0;
/* 正在录快捷键时按住的那个键位。null = 没在录。录制器是**一次性的**：
   开始时装一个 capture keydown，结束（录到/取消/失焦）时连 blur 一起摘掉。 */
let SHORTCUT_RECORDER = null;
// Perch 已经吃掉的组合键。录制器拦下它们，免得用户设完才发现两颗键打架。
const SHORTCUT_RESERVED = ["Ctrl+K", "Ctrl+Shift+B", "Ctrl+F"];

const SETTINGS_SIZES = [12, 13, 14, 15, 16, 18];

/* 单选组的「漫游 tabindex」：Tab 只停在当前选中项上，组内用方向键走。
   不可用项（.na）仍保留在方向键的路径里 —— 灰而不禁，键盘也要能走到、
   听到它为什么不可用（aria-disabled + title/aria-label）。 */
function settingsSyncRadioTabStops() {
  for (const group of document.querySelectorAll('#settings [role="radiogroup"]')) {
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    if (!radios.length) continue;
    let active = radios.findIndex(
      (r) => r.getAttribute("aria-checked") === "true" && !r.classList.contains("na"));
    if (active < 0) active = radios.findIndex((r) => !r.classList.contains("na"));
    if (active < 0) active = 0;
    radios.forEach((r, i) => { r.tabIndex = i === active ? 0 : -1; });
  }
}

/* 默认目录那一行的「恢复默认」是灰而不禁的：属性、title、aria 说法一处算。 */
function settingsCwdPaintReset() {
  const reset = $("set-cwd-reset");
  if (!reset) return;
  const custom = !!SETTINGS.defaultCwd;
  const na = !custom && !CWD_DRAFT_DIRTY;
  reset.classList.toggle("na", na);
  reset.setAttribute("aria-disabled", String(na));
  reset.title = custom
    ? t("settings.defaultCwd.resetTitleBuiltIn")
    : CWD_DRAFT_DIRTY
      ? t("settings.defaultCwd.resetTitleDraft")
      : t("settings.defaultCwd.resetTitleNow");
  reset.setAttribute("aria-label", na
    ? t("settings.defaultCwd.resetAriaNa")
    : t("settings.defaultCwd.resetAria"));
}

function settingsDefaultLabel(key) {
  const v = SETTINGS_DEFAULTS[key];
  if (key === "termFontFamily") return v === "jetbrains" ? "JetBrains Mono" : "Cascadia Code";
  if (key === "startView") return v === "workspace" ? t("settings.startView.workspace") : t("settings.startView.dash");
  if (key === "defaultAgent") return t("settings.defaultAgent.autoShort");
  if (key === "newAgentShortcut") return v || t("settings.shortcut.unset");
  if (typeof v === "boolean") return v ? t("settings.switch.on") : t("settings.switch.off");
  return String(v);
}

/* 「默认 Agent」下拉的选项来自**当前探测到的名单**（opCatalog / opLaunchable，
   30-pages.js），不是写死的枚举 —— 换台机器装了别的 Agent，这里跟着变。
   持久值指向一个没装、不能启动的 Agent 时也要把它列出来（标「未安装」）并保持
   选中：否则界面显示「自动」而盘上其实存着别的值，用户会被自己没做过的选择坑到。
   只在选项集合变化时重建 <select>：重建会收起展开中的下拉、也会重置键盘焦点。 */
function syncDefaultAgentSelect() {
  const sel = $("set-agent");
  if (!sel) return;
  let cat = [];
  try { cat = opCatalog(); } catch (_) { cat = []; }
  const avail = cat.filter(opLaunchable);
  const cur = SETTINGS.defaultAgent || "";
  const rows = [{ id: "", name: t("settings.defaultAgent.auto") }]
    .concat(avail.map((a) => ({ id: a.id, name: a.name || a.id })));
  if (cur && !rows.some((r) => r.id === cur)) {
    const a = cat.find((x) => x && x.id === cur);
    rows.push({ id: cur, name: (a && a.name) || cur, missing: true });
  }
  const sig = rows.map((r) => `${r.id}:${r.name}${r.missing ? "!" : ""}`).join("|");
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = rows.map((r) =>
      `<option value="${esc(r.id)}">${esc(r.missing ? t("settings.defaultAgent.missing", { name: r.name }) : r.name)}</option>`)
      .join("");
  }
  sel.value = cur;
}

function cwdErrText() {
  return msgText(CWD_ERR);
}

function settingsCwdPaintError() {
  const err = $("set-cwd-err");
  const line = document.querySelector(".set-cwd-line");
  const text = cwdErrText();
  if (err) {
    err.hidden = !text;
    err.textContent = text;
  }
  if (line) line.classList.toggle("bad", !!text);
}

function settingsCwdSetInput(value) {
  const input = $("set-cwd-input");
  if (input && input.value !== value) input.value = value;
}

/* 丢掉还没提交的草稿，回到权威值（点选择器、按 Esc 时用）。 */
function settingsCwdDiscardDraft() {
  CWD_DRAFT_DIRTY = false;
  CWD_ERR = null;
  settingsCwdSetInput(SETTINGS.defaultCwd || "");
  settingsCwdPaintError();
  settingsCwdPaintReset();
}

/* 提交默认目录。v == null 时读输入框。
   **不做乐观 applySettings**：目录是否存在只有 Go 知道；先让输入框保持用户写的
   样子，等 settings 消息回来再以权威值收口（20-ctl.js 会先调 settingsMessageArrived）。 */
function settingsCwdCommit(v) {
  const input = $("set-cwd-input");
  if (!input) return;
  const value = String(v == null ? input.value : v).trim();
  if (value === SETTINGS.defaultCwd) {
    CWD_DRAFT_DIRTY = false;
    CWD_ERR = null;
    settingsCwdSetInput(SETTINGS.defaultCwd || "");
    settingsCwdPaintError();
    settingsCwdPaintReset();
    return;
  }
  CWD_DRAFT_DIRTY = false;
  CWD_PENDING = true;
  CWD_ERR = null;
  settingsCwdPaintError();
  if (CWD_PENDING_TIMER) clearTimeout(CWD_PENDING_TIMER);
  CWD_PENDING_TIMER = setTimeout(() => {
    if (!CWD_PENDING) return;
    CWD_PENDING = false;
    CWD_DRAFT_DIRTY = true;
    CWD_ERR = { key: "settings.defaultCwd.pendingError" };
    if (NAV_HERE === "settings") { syncSettingsUI(); settingsCwdPaintError(); }
  }, 5000);
  sendCtrl({ type: "settings.set", settings: { defaultCwd: value } });
  sendCtrl({ type: "log", msg: `设置：默认目录改成「${value || "(内置)"}」（等后端校验）` });
}

/* 20-ctl.js 的 settings 分支先调这里。返回 true = 这条错误已经就地显示，
   不要再弹 toast。成功时清掉 pending，让紧接着的 applySettings 同步输入框。 */
function settingsMessageArrived(m) {
  if (!CWD_PENDING) return false;
  const failed = !!m.err;
  const typedSinceSend = CWD_DRAFT_DIRTY;
  CWD_PENDING = false;
  if (CWD_PENDING_TIMER) { clearTimeout(CWD_PENDING_TIMER); CWD_PENDING_TIMER = 0; }
  if (failed) {
    CWD_DRAFT_DIRTY = true;
    CWD_ERR = { code: m.errCode, params: m.errParams, text: m.err };
    sendCtrl({ type: "log", msg: `设置：默认目录没改 —— ${m.err}` });
    return true;
  }
  CWD_ERR = null;
  // 请求发出后用户又改了字：保留新草稿，别被这次回来的旧值冲掉。
  if (!typedSinceSend) CWD_DRAFT_DIRTY = false;
  return false;
}

// 把 SETTINGS 里的值画到静态 DOM 上。只改状态，不重建节点 ——
// 重建会把键盘焦点连同按钮一起摘掉（设置页全是键盘可达的控件）。
function syncSettingsUI() {
  if (!$("settings")) return;
  const path = settingsCurrentPath();
  const custom = !!SETTINGS.defaultCwd;
  const kind = $("set-cwd-kind");
  const input = $("set-cwd-input");
  if (kind) kind.textContent = custom
    ? t("settings.defaultCwd.kind.custom")
    : t("settings.defaultCwd.kind.builtin");
  if (input) {
    // 草稿/在途期间不覆盖用户写的字；其余时候显示"配置值"（空 = 内置）。
    if (!CWD_DRAFT_DIRTY && !CWD_PENDING) input.value = SETTINGS.defaultCwd || "";
    input.title = path || "";
    input.placeholder = SETTINGS_BUILTIN_CWD || t("settings.defaultCwd.placeholder");
  }
  settingsCwdPaintReset();
  settingsCwdPaintError();
  const note = $("set-cwd-note");
  if (note) {
    note.classList.remove("info");
    if (SETTINGS_CWD_MISSING) {
      note.hidden = false;
      note.textContent = SETTINGS_BUILTIN_CWD
        ? t("settings.defaultCwd.noteMissingPath", { path: SETTINGS_BUILTIN_CWD })
        : t("settings.defaultCwd.noteMissing");
    } else if (custom && SETTINGS_BUILTIN_CWD) {
      note.hidden = false;
      note.classList.add("info");
      note.textContent = t("settings.defaultCwd.noteBuiltin", { path: SETTINGS_BUILTIN_CWD });
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }

  // 分段控件 / 字体卡：状态只有一个来源 —— SETTINGS。
  for (const b of document.querySelectorAll("#settings [data-set-size]")) {
    const on = Number(b.dataset.setSize) === SETTINGS.termFontSize;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  for (const b of document.querySelectorAll("#settings [data-set-font]")) {
    const on = b.dataset.setFont === SETTINGS.termFontFamily;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  for (const b of document.querySelectorAll("#settings [data-set-start]")) {
    const on = b.dataset.setStart === SETTINGS.startView;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  // 主题目前只有深色。浅色是灰的、**不是 disabled** —— 点它会给一句解释。
  for (const b of document.querySelectorAll("#settings [data-set-theme]")) {
    const on = b.dataset.setTheme === "dark";
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
  }
  for (const b of document.querySelectorAll("#settings [data-set-flag]")) {
    b.setAttribute("aria-checked", String(!!SETTINGS[b.dataset.setFlag]));
  }

  // 默认值提示、「恢复默认」只在有偏差时出现、标签旁的小圆点同理。
  for (const el of document.querySelectorAll("#settings [data-set-default-hint]")) {
    const key = el.dataset.setDefaultHint;
    if (key && Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) {
      el.textContent = t("settings.defaultHint", { value: settingsDefaultLabel(key) });
    }
  }
  for (const b of document.querySelectorAll("#settings [data-set-reset]")) {
    const key = b.dataset.setReset;
    const known = Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key);
    b.hidden = !known || SETTINGS[key] === SETTINGS_DEFAULTS[key];
  }
  for (const row of document.querySelectorAll("#settings .settings-row[data-set-row]")) {
    const key = row.dataset.setRow;
    const known = Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key);
    row.classList.toggle("modified", known && SETTINGS[key] !== SETTINGS_DEFAULTS[key]);
  }

  // 字号步进：到头的那颗做灰（仍可点，点下去说明原因）。
  const idx = SETTINGS_SIZES.indexOf(SETTINGS.termFontSize);
  for (const b of document.querySelectorAll("#settings [data-set-size-step]")) {
    const d = Number(b.dataset.setSizeStep);
    const atBound = idx < 0 || (d < 0 ? idx === 0 : idx === SETTINGS_SIZES.length - 1);
    const label = d < 0 ? t("settings.fontSize.shrink") : t("settings.fontSize.grow");
    const why = d < 0 ? t("settings.fontSize.min") : t("settings.fontSize.max");
    b.classList.toggle("na", atBound);
    b.setAttribute("aria-disabled", String(atBound));
    b.setAttribute("aria-label", atBound ? `${label} (${why})` : label);
    b.title = atBound ? why : label;
  }

  syncDefaultAgentSelect();
  const langSel = $("set-language");
  if (langSel) langSel.value = SETTINGS.language || "auto";

  // 快捷键按钮：录制中显示提示语；否则显示当前组合键（空 = 未设置）。
  // 这里**不改**录制状态本身 —— 录制器自己管开/关，applySettings 只负责画。
  const keyBtn = $("set-newkey");
  if (keyBtn) {
    if (!SHORTCUT_RECORDING) keyBtn.textContent = SETTINGS.newAgentShortcut || t("settings.shortcut.unset");
    keyBtn.classList.toggle("rec", SHORTCUT_RECORDING);
    keyBtn.title = SHORTCUT_RECORDING
      ? t("settings.shortcut.recordTitle")
      : SETTINGS.newAgentShortcut
        ? t("settings.shortcut.setTitle", { key: SETTINGS.newAgentShortcut })
        : t("settings.shortcut.emptyTitle");
  }

  settingsSyncRadioTabStops();
}

/* ---------------------------------------------------------------------------
   搜索（评分在 84-settings-search.js，这里只负责把 DOM 读成条目 + 显隐）
   ---------------------------------------------------------------------------
   命中规则和 Orca 一致：先看这个区，区内逐行打分；**区标题命中 = 整区都留下**，
   否则只留下命中的行。查询为空时不扫描，全部显示。输入停 150ms 才扫一遍
   （逐字扫会让长页面每敲一下都掉帧）。 */
let SETTINGS_SEARCH_TIMER = 0;
let SETTINGS_SEARCH_LOGGED = "";

function settingsKeywords(el) {
  return String(el.dataset.search || "").split(/\s+/).filter(Boolean);
}

function settingsRowText(row) {
  const span = row.querySelector(".settings-lab span");
  if (!span) return "";
  // 只拼文本节点：默认值提示（<em class="set-def">）不参与搜索，
  // 否则搜「默认」会把每一行都命中。
  let t = "";
  for (const n of span.childNodes) {
    if (n.nodeType === 3) t += n.textContent;
  }
  return t.trim();
}

function settingsRowEntry(row) {
  const b = row.querySelector(".settings-lab b");
  return {
    title: b ? b.textContent.trim() : "",
    description: settingsRowText(row),
    keywords: settingsKeywords(row),
  };
}

function settingsSectionEntry(sec) {
  const h = sec.querySelector(".settings-sec-head h2");
  // 节这一层只认标题和关键词：节的说明写得泛（"字体随应用分发…"），
  // 拿它当命中依据会让搜「字体」把整个「外观」区都留下，行级筛选就失效了。
  return {
    title: h ? h.textContent.trim() : "",
    description: "",
    keywords: settingsKeywords(sec),
  };
}

function settingsSearchInput() {
  return $("set-search");
}

function applySettingsSearch() {
  const input = settingsSearchInput();
  if (!input) return;
  const query = input.value;
  const nq = settingsSearchNorm(query);
  let hits = 0;
  let firstVisible = null;
  const sections = document.querySelectorAll("#settings .settings-sec");
  for (const sec of sections) {
    const secHit = settingsSearchScoreEntry(query, settingsSectionEntry(sec), true) > 0;
    let secVisible = false;
    for (const row of sec.querySelectorAll(".settings-row")) {
      const rowHit = settingsSearchScoreEntry(query, settingsRowEntry(row), false) > 0;
      const show = !nq || secHit || rowHit;
      row.classList.toggle("is-hidden", !show);
      if (show) {
        secVisible = true;
        hits++;
      }
    }
    sec.classList.toggle("is-hidden", !secVisible);
    if (secVisible && !firstVisible) firstVisible = sec;
  }
  for (const sec of sections) {
    sec.classList.toggle("is-first", !!nq && sec === firstVisible);
  }

  const empty = $("set-empty");
  if (empty) empty.hidden = !(nq && hits === 0);
  const emptyQ = $("set-empty-q");
  if (emptyQ) {
    const trimmed = query.trim();
    emptyQ.textContent = trimmed.length > 40 ? trimmed.slice(0, 40) + "…" : trimmed;
  }
  const clear = $("set-search-clear");
  if (clear) clear.hidden = !query;

  if (SETTINGS_SEARCH_LOGGED !== nq) {
    if (nq) {
      sendCtrl({ type: "log", msg: `设置搜索：「${nq}」命中 ${hits} 行` });
    } else if (SETTINGS_SEARCH_LOGGED) {
      sendCtrl({ type: "log", msg: "设置搜索：清空，显示全部" });
    }
    SETTINGS_SEARCH_LOGGED = nq;
  }
}

function scheduleSettingsSearch() {
  if (SETTINGS_SEARCH_TIMER) clearTimeout(SETTINGS_SEARCH_TIMER);
  SETTINGS_SEARCH_TIMER = setTimeout(() => {
    SETTINGS_SEARCH_TIMER = 0;
    applySettingsSearch();
  }, 150);
}

function clearSettingsSearch(keepFocus) {
  const input = settingsSearchInput();
  if (SETTINGS_SEARCH_TIMER) { clearTimeout(SETTINGS_SEARCH_TIMER); SETTINGS_SEARCH_TIMER = 0; }
  if (input) input.value = "";
  applySettingsSearch();
  if (keepFocus && input) input.focus();
}

function focusSettingsSearch(selectAll) {
  const input = settingsSearchInput();
  if (!input) return;
  input.focus();
  if (selectAll) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

function renderSettings(reason) {
  syncSettingsUI();
  if (reason) sendCtrl({ type: "log", msg: `设置页：${reason}` });
}

/* ---- 快捷键录制 -----------------------------------------------------------
   点按钮 → 进入录制；下一次 keydown 被 capture 抓住。60-shell 的全局快捷键
   处理器会先看 SHORTCUT_RECORDING，所以录制期间按什么都不会新建格子。
   · Esc 取消（不改设置）；Backspace/Delete（不带修饰键）清空 = 关闭；
   · 单按 Control/Alt/Shift 不算组合，继续等主键；
   · 主键用 e.code 取物理键位（中文布局下 e.key 可能不是字母）。
   录到的形状与落盘形状都走 05-prefs 的 normalizeShortcutString，不在这边
   另拼一份 —— 两边各拼一份迟早漂移。 */
function beginShortcutRecord(btn) {
  if (!btn) return;
  if (SHORTCUT_RECORDING) { endShortcutRecord(null, "再次点击取消"); return; }
  SHORTCUT_RECORDING = true;
  btn.classList.add("rec");
  btn.textContent = t("settings.shortcut.record");
  btn.title = t("settings.shortcut.cancelTitle");
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      endShortcutRecord(null, "Esc 取消");
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      e.preventDefault(); e.stopPropagation();
      endShortcutRecord("", "清空");
      return;
    }
    if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
      // 只按了修饰键：这不是一个组合，等主键。仍然拦住它，别让 WebView2
      // 把 Alt 拿去开菜单（那会把焦点从这颗按钮上带走）。
      e.preventDefault(); e.stopPropagation();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const chord = shortcutChordFromEvent(e);
    if (!chord) {
      showToast(t("settings.shortcut.invalidTitle"), t("settings.shortcut.invalidNote"), "err");
      return;
    }
    if (SHORTCUT_RESERVED.includes(chord)) {
      showToast(t("settings.shortcut.takenTitle"), t("settings.shortcut.takenNote", { chord }), "err");
      return;
    }
    endShortcutRecord(chord, `录到 ${chord}`);
  };
  const onBlur = () => endShortcutRecord(null, "失焦取消");
  SHORTCUT_RECORDER = { btn, onKey, onBlur };
  document.addEventListener("keydown", onKey, true);
  btn.addEventListener("blur", onBlur, { once: true });
  btn.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: "设置：开始录制新建格快捷键" });
}
function endShortcutRecord(chord, why) {
  if (!SHORTCUT_RECORDING) return;
  SHORTCUT_RECORDING = false;
  const rec = SHORTCUT_RECORDER;
  SHORTCUT_RECORDER = null;
  if (rec) {
    document.removeEventListener("keydown", rec.onKey, true);
    rec.btn.removeEventListener("blur", rec.onBlur);
    rec.btn.classList.remove("rec");
  }
  syncSettingsUI();
  if (chord === null || chord === undefined) {
    sendCtrl({ type: "log", msg: `设置：新建格快捷键录制结束（${why || "取消"}）` });
    return;
  }
  const v = normalizeShortcutString(chord);
  if (v === SETTINGS.newAgentShortcut) {
    sendCtrl({ type: "log", msg: `设置：新建格快捷键没变（${v || "关闭"}）` });
    return;
  }
  settingsSend({ newAgentShortcut: v }, v ? `新建格快捷键 → ${v}` : "新建格快捷键 → 关闭");
}

// 乐观写入：先让界面变，再落盘。Go 拒绝时会把旧值整份推回来（见文件头）。
function settingsSend(patch, why) {
  applySettings(patch);
  sendCtrl({ type: "settings.set", settings: patch });
  sendCtrl({ type: "log", msg: `设置：${why} ${JSON.stringify(patch)}` });
}

function settingsStepSize(delta) {
  const idx = SETTINGS_SIZES.indexOf(SETTINGS.termFontSize);
  const cur = idx < 0 ? SETTINGS_SIZES.indexOf(SETTINGS_DEFAULTS.termFontSize) : idx;
  const next = Math.min(SETTINGS_SIZES.length - 1, Math.max(0, cur + delta));
  if (next === cur) {
    showToast(t("settings.fontSize.toastTitle"),
      delta < 0 ? t("settings.fontSize.toastMin") : t("settings.fontSize.toastMax"), "info");
    return;
  }
  settingsSend({ termFontSize: SETTINGS_SIZES[next] }, "终端字号");
}

// 搜索框：输入防抖 150ms；清空按钮两颗（搜索框内 + 空状态里）。
const SET_SEARCH_INPUT = $("set-search");
if (SET_SEARCH_INPUT) {
  SET_SEARCH_INPUT.addEventListener("input", () => {
    const clear = $("set-search-clear");
    if (clear) clear.hidden = !SET_SEARCH_INPUT.value;
    scheduleSettingsSearch();
  });
}
if ($("set-search-clear")) {
  $("set-search-clear").addEventListener("click", () => clearSettingsSearch(true));
}
if ($("set-empty-clear")) {
  $("set-empty-clear").addEventListener("click", () => clearSettingsSearch(true));
}

// 默认目录输入框：输入 = 草稿；Enter/blur = 提交；Esc = 撤回草稿。
const CWD_INPUT = $("set-cwd-input");
if (CWD_INPUT) {
  CWD_INPUT.addEventListener("input", () => {
    CWD_DRAFT_DIRTY = true;
    if (CWD_ERR) CWD_ERR = null;
    settingsCwdPaintError();
    settingsCwdPaintReset();
  });
  CWD_INPUT.addEventListener("blur", () => {
    // 「选择目录…」/「恢复默认」的 pointerdown 已经声明"草稿作废"，不要再提交。
    if (CWD_SKIP_BLUR) { CWD_SKIP_BLUR = false; return; }
    if (!CWD_DRAFT_DIRTY) return;
    settingsCwdCommit();
  });
  CWD_INPUT.addEventListener("keydown", (e) => {
    // 输入法组字时的回车是选词，不是提交（和 Orca 的 path input 同一条守卫）。
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (CWD_DRAFT_DIRTY) settingsCwdCommit();
      return;
    }
    if (e.key === "Escape") {
      if (!CWD_DRAFT_DIRTY) return; // 干净时交给全局 Esc（清搜索 / 回上一视图）
      e.preventDefault();
      e.stopPropagation();
      settingsCwdDiscardDraft();
    }
  });
}

$("settings").addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const discardsDraft = b.dataset.set === "pick-cwd" || b.dataset.set === "reset-cwd";
  if (discardsDraft && CWD_INPUT && document.activeElement === CWD_INPUT) {
    CWD_SKIP_BLUR = true;
  }
}, true);

$("settings").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;

  if (b.dataset.set === "pick-cwd") {
    // 选择器的结果是权威值，半截草稿没有保留的意义（取消选择也不会误提交）。
    settingsCwdDiscardDraft();
    sendCtrl({ type: "settings.pickDefaultCWD" });
    sendCtrl({ type: "log", msg: "设置：打开系统文件夹选择器选默认目录" });
    return;
  }
  if (b.dataset.set === "reset-cwd") {
    if (!SETTINGS.defaultCwd) {
      if (CWD_DRAFT_DIRTY) {
        settingsCwdDiscardDraft();
        sendCtrl({ type: "log", msg: "设置：丢掉默认目录草稿（本来就用内置目录）" });
        return;
      }
      showToast(t("settings.toast.cwdDefaultTitle"), t("settings.toast.cwdDefaultNote"), "info");
      return;
    }
    // 也走"等后端确认"那条路：目录为空的校验在 Go 那边（它会清掉自定义目录）。
    settingsCwdCommit("");
    return;
  }

  if (b.dataset.set === "record-newkey") {
    beginShortcutRecord(b);
    return;
  }
  if (b.dataset.setReset !== undefined) {
    const key = b.dataset.setReset;
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key)) return;
    if (SETTINGS[key] === SETTINGS_DEFAULTS[key]) return;
    settingsSend({ [key]: SETTINGS_DEFAULTS[key] }, `恢复默认：${key}`);
    return;
  }
  if (b.dataset.setSizeStep !== undefined) {
    settingsStepSize(Number(b.dataset.setSizeStep));
    return;
  }
  if (b.dataset.setSize !== undefined) {
    const n = Number(b.dataset.setSize);
    if (n === SETTINGS.termFontSize) return;
    settingsSend({ termFontSize: n }, "终端字号");
    return;
  }
  if (b.dataset.setFont !== undefined) {
    if (b.dataset.setFont === SETTINGS.termFontFamily) return;
    settingsSend({ termFontFamily: b.dataset.setFont }, "终端字体");
    return;
  }
  if (b.dataset.setTheme !== undefined) {
    if (b.dataset.setTheme === "light") {
      // 界面主题不是终端主题：应用里还有一百多处写死的深色值，
      // 做浅色要整份换令牌，不在这一版的范围（灰着但可点，点一下说明原因）。
      showToast(t("settings.toast.lightTitle"), t("settings.toast.lightNote"), "info");
      sendCtrl({ type: "log", msg: "设置：点了浅色主题（未实现）" });
    }
    return;
  }
  if (b.dataset.setStart !== undefined) {
    if (b.dataset.setStart === SETTINGS.startView) return;
    settingsSend({ startView: b.dataset.setStart }, "启动落点");
    return;
  }
  const flag = b.dataset.setFlag;
  if (flag) {
    settingsSend({ [flag]: !SETTINGS[flag] }, flag);
  }
});

/* 默认 Agent 是 <select>：change 不走上面那个 button 点击出口。 */
$("set-agent").addEventListener("change", (e) => {
  const v = e.target.value || "";
  if (v === SETTINGS.defaultAgent) return;
  settingsSend({ defaultAgent: v }, `默认 Agent → ${v || "自动"}`);
});

/* 语言也是 <select>。走乐观写入：applySettings 里会调 setLocale，
   立刻重画静态 DOM 和这一页；Go 拒绝时会把旧值整份推回来。 */
$("set-language").addEventListener("change", (e) => {
  const v = e.target.value || "auto";
  if (v === SETTINGS.language) return;
  settingsSend({ language: v }, `界面语言 → ${v}`);
});

/* 语言变化后的动态重画入口（01-i18n.js 的 setLocale 调用）。
   静态节点已经由 applyStaticI18n 处理；这里只补 JS 生成的文字。 */
function onLocaleChanged() {
  if (typeof renderNav === "function") renderNav();
  if (typeof renderDashTabs === "function") renderDashTabs();
  // 左栏（项目行、agent 行、已关闭行）是整表现画的：状态词、计数、菜单标题都随语言变。
  if (typeof renderLists === "function") renderLists();
  // 池子错误横幅的文字来自后端 code（60-shell.js 的 poolErrText）。
  if (typeof syncPoolBanner === "function") syncPoolBanner();
  // 格子头：默认标题、关闭键 title、换 Agent 的 aria/title、状态点 aria-label。
  if (typeof TAB_LIST !== "undefined") {
    for (const tab of TAB_LIST) {
      if (typeof renderTabTitle === "function") renderTabTitle(tab);
      if (typeof renderAgentDot === "function") renderAgentDot(tab);
      if (tab.freshBtn) {
        tab.freshBtn.title = tab.fresh
          ? t("term.fresh.changeFresh", { name: freshAgentLabel(tab) })
          : t("term.fresh.changeStarted");
        tab.freshBtn.setAttribute("aria-label", t("term.fresh.label"));
      }
      const x = tab.tabEl && tab.tabEl.querySelector(".x");
      if (x) x.title = t("term.tab.close");
    }
  }
  // 总览的读数、Agent 名单、热力图骨架都是 JS 现画的，静态翻译管不到。
  if (typeof NAV_HERE !== "undefined" && NAV_HERE === "dash" &&
      typeof renderDashboard === "function") {
    renderDashboard("locale");
  }
  if (typeof paintFontStatus === "function") paintFontStatus();
  if (typeof paintRenderStatus === "function") paintRenderStatus();
  if (typeof paintConnStatus === "function" && typeof activeTab !== "undefined" && activeTab) {
    paintConnStatus(!activeTab.connDown);
  }
  // 右栏与文件预览里的文字多是 JS 现画的；切语言时就地重画一次。
  if (typeof renderFiles === "function") renderFiles(true);
  if (typeof renderFeed === "function") renderFeed();
  if (typeof renderNeed === "function") renderNeed();
  if (typeof renderSideLive === "function") renderSideLive();
  // 安装进度台：标题/阶段/日志开关/任务条都是现画的。
  if (typeof INSTALLS !== "undefined" && Object.keys(INSTALLS).length &&
      typeof instPaint === "function") instPaint();
  if (typeof renderFlow === "function") renderFlow("locale");
  if (typeof fvRender === "function" && typeof FV !== "undefined" && FV) fvRender();
  // 添加项目 / 新建 Agent 卡片开着时，标题、note、预选标签都是 JS 现画的。
  if (typeof projectDialogsRepaint === "function") projectDialogsRepaint();
  // 「开一个 agent」面板的按钮/提示/会话行同样是现画的。
  const opPanel = $("openpanel");
  if (typeof renderOpPanel === "function" && opPanel && opPanel.classList.contains("on")) {
    renderOpPanel();
  }
  // 收起终端后的群组看板：行头、待办卡、权限卡都是现画的。整表重建是有意的
  // （语言切换本来就是低频事件；卡片展开态按 ask/act id 记着，不会丢）。
  if (typeof scheduleGroup === "function") scheduleGroup();
  if (typeof STATE !== "undefined" && STATE && $("s-index")) {
    $("s-index").textContent = t("status.index", {
      sessions: STATE.sessions?.length ?? 0,
      projects: (STATE.projects || []).length,
    });
  }
  if (typeof syncSettingsUI === "function" && typeof NAV_HERE !== "undefined" &&
      NAV_HERE === "settings") syncSettingsUI();
}

/* 单选组的方向键（ARIA radio 语义）：←/↑ 上一个，→/↓ 下一个，Home/End 两端。
   焦点移动即选中；不可用项只聚焦、不选中 —— 灰而不禁，键盘也要走得到。 */
$("settings").addEventListener("keydown", (e) => {
  const radio = e.target.closest && e.target.closest('[role="radio"]');
  if (!radio) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key;
  const isArrow = key === "ArrowLeft" || key === "ArrowRight" ||
                  key === "ArrowUp" || key === "ArrowDown";
  if (!isArrow && key !== "Home" && key !== "End") return;
  const group = radio.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = Array.from(group.querySelectorAll('[role="radio"]'));
  if (!radios.length) return;
  e.preventDefault();
  e.stopPropagation();
  if (radios.length < 2) return;
  let i = radios.indexOf(radio);
  if (i < 0) {
    i = radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
    if (i < 0) i = 0;
  }
  if (key === "Home") i = 0;
  else if (key === "End") i = radios.length - 1;
  else {
    const dir = (key === "ArrowRight" || key === "ArrowDown") ? 1 : -1;
    i = (i + dir + radios.length) % radios.length;
  }
  const next = radios[i];
  next.focus();
  if (!next.classList.contains("na") && next.getAttribute("aria-checked") !== "true") {
    next.click();
  }
}, true);

/* 设置页的键盘：
   · Ctrl+F 从任何地方聚焦搜索框（Orca 的 settings.search = Mod+F）；
   · Esc 依次处理：草稿由输入框自己撤回 → 清搜索 → 回上一个非设置视图。
   用 capture，终端/输入框抢键之前先判断；确认框开着时一律让给确认框。 */
document.addEventListener("keydown", (e) => {
  if (CONFIRM.open) return;
  const app = $("app");
  if (!app || !app.classList.contains("settings")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    e.stopPropagation();
    focusSettingsSearch(true);
    return;
  }
  if (e.key !== "Escape") return;
  if (document.activeElement === CWD_INPUT && (CWD_DRAFT_DIRTY || CWD_PENDING)) {
    return; // 输入框自己的 keydown 负责撤回
  }
  const search = settingsSearchInput();
  if (search && search.value.trim()) {
    e.preventDefault();
    e.stopPropagation();
    clearSettingsSearch(document.activeElement === search);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  setNavView((typeof NAV_PREV !== "undefined" && NAV_PREV) || "workspace");
}, true);

/* ---------------------------------------------------------------------------
   确认框
   ---------------------------------------------------------------------------
   单例（#confirm 静态在 index.html 里）。Promise 语义：
     askConfirm(...) → true = 确认，false = 取消 / 已经有一个在问。
   ⚠️ **已经在问的时候不叠加第二个 Promise**：关窗请求可能连发（用户连点 ×），
   叠加会让上一个 Promise 永远不 resolve，发起方（关窗那条路）就一直悬着。
   ------------------------------------------------------------------------- */
const CONFIRM = { open: false, resolve: null, prev: null, danger: false };

function confirmFocusables() {
  return [$("confirm-cancel"), $("confirm-ok")].filter(Boolean);
}

function focusConfirm() {
  const list = confirmFocusables();
  if (!list.length) return;
  const target = CONFIRM.danger ? $("confirm-cancel") : $("confirm-ok");
  (target || list[0]).focus();
}

function askConfirm(opts) {
  const el = $("confirm");
  if (!el) return Promise.resolve(false);
  if (CONFIRM.open) {
    focusConfirm();
    return Promise.resolve(false);
  }
  const o = opts || {};
  CONFIRM.open = true;
  CONFIRM.danger = !!o.danger;
  CONFIRM.prev = document.activeElement;

  $("confirm-title").textContent = o.title || t("common.confirm");
  $("confirm-body").textContent = o.body || "";
  const ico = $("confirm-ico");
  ico.innerHTML = lucide(o.danger ? LUCIDE_TRIANGLE_ALERT : LUCIDE_INFO, 16);
  ico.classList.toggle("warn", !!o.danger);
  const ok = $("confirm-ok");
  ok.textContent = o.ok || t("common.ok");
  ok.classList.toggle("danger", !!o.danger);
  // 破坏性动作默认把焦点放在「取消」上（回车不会顺手把记录删掉）。
  el.hidden = false;
  focusConfirm();
  return new Promise((resolve) => { CONFIRM.resolve = resolve; });
}

function settleConfirm(ok) {
  if (!CONFIRM.open) return;
  const resolve = CONFIRM.resolve;
  const prev = CONFIRM.prev;
  CONFIRM.open = false;
  CONFIRM.resolve = null;
  CONFIRM.prev = null;
  CONFIRM.danger = false;
  $("confirm").hidden = true;
  // 取消/完成后回到原来那个控件（通常是终端）。确认后窗口马上关，无所谓。
  if (prev && prev.isConnected && typeof prev.focus === "function") {
    try { prev.focus(); } catch (_) {}
  }
  if (resolve) resolve(!!ok);
}

$("confirm-cancel").addEventListener("click", () => settleConfirm(false));
$("confirm-ok").addEventListener("click", () => settleConfirm(true));
$("confirm").addEventListener("mousedown", (e) => {
  // 点卡片外面 = 取消。卡片内部的 mousedown 不冒到这里。
  if (e.target === $("confirm")) settleConfirm(false);
});
document.addEventListener("keydown", (e) => {
  if (!CONFIRM.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    settleConfirm(false);
    return;
  }
  if (e.key === "Enter") {
    // 回车 = 当前聚焦的那个按钮；默认焦点在「取消」上时不会误确认。
    e.preventDefault();
    e.stopPropagation();
    settleConfirm(document.activeElement === $("confirm-cancel") ? false : true);
    return;
  }
  if (e.key === "Tab") {
    // 焦点锁在卡片里：两个按钮之间循环。
    const list = confirmFocusables();
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    const next = e.shiftKey
      ? (i <= 0 ? list.length - 1 : i - 1)
      : (i < 0 || i === list.length - 1 ? 0 : i + 1);
    list[next].focus();
  }
}, true);

/* ---------------------------------------------------------------------------
   关窗确认
   ---------------------------------------------------------------------------
   Go 的 WindowClosing hook 会 Cancel 掉原生关闭并 EmitEvent("perch:close-request")，
   这里弹确认框；确认后发 window.close，Go 置 closeConfirmed 再真正关窗。
   取消时发 window.close.cancel，让 Go 把"问过一次"的计时清掉 —— 否则 30 秒内
   再点 ×，它还会以为这次询问还没答复。 */
function onCloseRequest() {
  if (CONFIRM.open) {
    focusConfirm();
    sendCtrl({ type: "log", msg: "关窗确认：确认框已经开着，把焦点送回卡片" });
    return;
  }
  sendCtrl({ type: "log", msg: "关窗确认：收到 Go 的请求，弹确认框" });
  askConfirm({
    title: t("confirm.close.title"),
    body: t("confirm.close.body"),
    ok: t("confirm.close.ok"),
  }).then((ok) => {
    if (ok) {
      sendCtrl({ type: "window.close" });
    } else {
      sendCtrl({ type: "window.close.cancel" });
      sendCtrl({ type: "log", msg: "关窗确认：用户取消，窗口留着" });
    }
  });
}

if (Events && typeof Events.On === "function") {
  Events.On("perch:close-request", onCloseRequest);
}
