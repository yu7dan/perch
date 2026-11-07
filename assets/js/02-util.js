"use strict";
/* 02-util.js —— 台面（0.1.1）之前散在旧外壳文件里的公用小件：转义、时间、路径、图标。
   2026-11-08 从 60-shell / 40-chrome / 86-dash 原样搬出来（旧外壳整体退役，这几样留下）。
   本文件在 10-term.js 之前求值：第一个标签是模块求值期建的，它要用到这里的 svg / iconHTML。 */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 会话名 = 用户起的名字 ?? agent 自己写的标题（Orca 的 `customTitle ?? title`）。
// 用户起的名字来自后端（titles.json，键是 sessionId）—— 它是**会话的属性**，
// 不是这一屏标签/面板的属性，所以列表、历史流面板、标签三处都读同一个来源。
function sessionTitle(s) {
  return (STATE && STATE.titles && STATE.titles[s.id]) || s.title || s.id.slice(0, 8);
}

// 极简 markdown。只处理对话流里真正高频的四种：围栏代码、行内代码、粗体、斜体。
//
// 刻意不引第三方库：这是**会话回放**，不是文档编辑器。渲染错一处的代价
// （把 `a * b` 吃成斜体、把路径里的下划线吃成强调）比不渲染大得多，
// 所以规则收得极紧 —— 强调符号内侧不允许有空格，且不跨行。
function mdInline(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(（])\*(?=\S)([^*\n]*?\S)\*/g, "$1<em>$2</em>");
}
function md(src) {
  const text = esc(src);
  // 先按围栏切开，代码块整段跳过行内替换 ——
  // 否则代码里的 `*` 会被当成强调，`a**b` 会被吃成粗体。
  return text.split("```").map((seg, i) => (i % 2
    ? `<pre class="code"><code>${seg.replace(/^[^\n]*\n/, "")}</code></pre>`
    : mdInline(seg))).join("");
}

function rel(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso); // 别叫 t：会遮住 i18n 的 t()
  if (isNaN(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t("rel.now");
  if (s < 3600) return t("rel.minutes", { n: Math.floor(s / 60) });
  if (s < 86400) return t("rel.hours", { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return t("rel.days", { n: Math.floor(s / 86400) });
  return new Date(ms).toLocaleDateString(PERCH_LOCALE === "zh" ? "zh-CN" : "en-US");
}
/* hover 出来的**绝对**时间（相对时间是给它旁边那行的，绝对时间挂在 title 上 ——
   两者都要有：一个回答"多久以前"，一个回答"到底是几点"）。
   ISO 串本身也算绝对，但那是给机器读的；人扫一眼要的是 `10-16 11:45`。 */
function absTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso || "";
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const base = (p) => String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";

// 卡片上只留目录名（最后一级）：240px 的列宽里，「workspace\project」这种
// 两级写法会把同一行的分支和权限 chip 挤出可视区。全路径在 title 里悬停看。
function shortPath(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}


function normPath(p) {
  return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}
// 子目录判定**必须带分隔符**：`D:\w\ab` 不是 `D:\w\a` 的子目录，
// 少了那个 `\` 就会把兄弟目录的会话算进来（Go 侧 projectStats 是同一条规矩，
// 两边写的是同一个判据 —— 一边错就是这个会话"显示在这里、算在那边"）。
function insidePath(child, parent) {
  const c = normPath(child), k = normPath(parent);
  return !!c && !!k && (c === k || c.startsWith(k + "\\"));
}

/* 一组图标 path。**图形与语义都是从 Orca 搬的**，不是我们发明：
     waiting / permission → 同一个问号（AgentStateDot.tsx:142-150）
     unread               → **铃铛**（terminal-tab-activity-status.ts:186
                            「no unread — that's a bell」）
   path 取 Lucide 原文（circle-question-mark / bell / git-fork / file /
   message-square / wrench），24×24 网格原封不动。
   ⚠️ 声明放这么前（而不是和末尾那段处理逻辑挨着）是**必须的**：启动时
   setActive() → renderAgentDot() 就会碰到它们，`const` 在那之前读到就是 TDZ。
   12px 这一档描边用 2.1 —— Lucide 默认的 2 在这个尺寸上会糊
   （Orca 在它 size="md" 那档也是加粗的）。 */
const G_ASK = '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>';
const G_BELL = '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>';
const G_FORK = '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>';
const G_SAY = '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>';
const G_TOOL = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>';
const G_DOT = '<circle cx="12" cy="12" r="5.2" fill="currentColor" stroke="none"/>';

function svg(paths, size, w) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="${w || 2.1}" stroke-linecap="round"
    stroke-linejoin="round">${paths}</svg>`;
}
// 状态点认识的那几个态（格子头的 title/aria 文字在 i18n 的 state.* 里；
// 这里只当"是不是已知状态"的判据用，不存文字 —— 存一份中文就是第二份会漂的措辞）。
const DOT_STATES = new Set(["idle", "working", "off", "ask", "unread", "failed"]);

const LUCIDE_FOLDER_TREE =
  '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>';
// Lucide folder（上游 folder.svg 的原始 path）：项目行要的是“一个文件夹”，
// 不是 folder-tree 的分叉线。分叉线在 15px 行里和状态点叠在一起会显得碎。
const LUCIDE_FOLDER =
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>';
// Lucide message-square（上游原文 path）：模式菜单里的 Chat 选项。
const LUCIDE_MESSAGE_SQUARE =
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>';
const LUCIDE_SQUARE_TERMINAL =
  '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>';
function lucide(paths, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round">${paths}</svg>`;
}
const LUCIDE_CIRCLE_CHECK = '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>';

const PANE_MIN_COLS = 64;            // Claude Code 开场介绍框的硬下限：低于它开场框会折行重叠

/* ⚠️ 写成函数而不是 `const PNG_ICONS = new Set(...)`：第一个标签是在模块
   求值期间同步建的，那时文件后半段的 `const` 还在 TDZ 里 —— 原来这一行会让
   启动时抛 "Cannot access 'PNG_ICONS' before initialization"，整个前端只画一半。 */
function isPngIcon(nm) {
  switch (nm) {
    case "crush": case "zcode": case "alma": case "hanako": case "cindy":
    case "typesafe": case "atomcode": case "snow": case "mlx-serve":
      return true;
  }
  return false;
}
function iconHTML(name, cls) {
  const c = " " + (cls || "");
  const nm = String(name || "").trim();
  if (!nm) return `<span class="ico-mask${c}" aria-hidden="true"></span>`;
  const explicit = /\.(svg|png|webp|ico)$/i.test(nm);
  const png = isPngIcon(nm);
  if (explicit || nm.endsWith("-color") || png) {
    const file = explicit ? nm : nm + (png ? ".png" : ".svg");
    return `<img class="ico-img${c}" src="icons/agents/${encodeURIComponent(file)}" alt="" loading="lazy">`;
  }
  const url = `icons/agents/${encodeURIComponent(nm)}.svg`;
  return `<span class="ico-mask${c}" aria-hidden="true" ` +
    `style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"></span>`;
}
/* 图标文件缺失（例如 magpie 报了一个我们没有的 icon id）时不要留 404 空白。
   img 的 error 事件不冒泡，所以在 document 的捕获阶段接住，换成带底色的「?」。 */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("ico-img")) return;
  const span = document.createElement("span");
  span.className = img.className.replace(/\bico-img\b/, "ico-mask ico-unknown");
  span.textContent = "?";
  span.setAttribute("aria-hidden", "true");
  img.replaceWith(span);
}, true);

/* 状态栏读数的落点。旧外壳底下那一条状态栏随旧外壳退役了，但 10-term 里那几句读数
   （连接 / 渲染后端 / 尺寸 / 字体）还是有用的事实 —— 元素不在就写进一个空壳，不报错。 */
const SBAR_NULL = { textContent: "", title: "", className: "", style: {},
  classList: { toggle() {}, add() {}, remove() {} } };
function sbar(id) { return document.getElementById(id) || SBAR_NULL; }

// 状态变了 → 台面在下一帧跟上（台面没起来之前什么都不做，起来时自己会全画一遍）。
function deskSoon(why) { if (window.DESK && DESK.soon) DESK.soon(why); }
