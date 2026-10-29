"use strict";
/* 10-term.js —— 终端工厂（createTab）、流、尺寸、标题/状态点、图标。整个应用的地基。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 1-1607（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

/* 本文件只放终端工厂与它直接依赖的状态；壳层、总览、网关分别在 40/60/86 等文件。 */
// Window / Events 是 Wails 运行时带的前端 API。窗口按钮能走它就别自己绕后端 ——
// 这两个在运行时里是直接调平台层（`internal/runtime/desktop/@wailsio/runtime/src/window.ts`），
// 我们只需要接上"什么时候该换字形"。
"use strict";
// Wails 运行时是 ESM，只在这里导出一次（index.html 里那个小 module shim 先跑），
// 之后所有 classic script 共享同一份 —— 这样按域拆文件时不需要每个文件都 import。
const { Stream, JSONStream, Window, Events } = window.__wails || {};

// ---------------------------------------------------------------------------
// 页面里没有控制台可看，未捕获的错误必须自己送出来。
// 送法有两种，**主通道是 stream 的 log 控制帧**（直接落到应用日志里，
// 和 [web] 那几行并排，排查时一个 Get-Content 就看到了）。
//
// ⚠️ 另一条曾经以为可行的通道是「写 document.title，外面用
// (Get-Process perch).MainWindowTitle 读」—— **实测无效**：Wails v3 不把
// document.title 传到原生窗口标题，标题始终是应用名。写它只是留个保险，
// 别再把排查希望寄托在它上面。
function jserr(what, e) {
  const msg = t("term.jsError", { what, err: (e && (e.message || e.reason || e)) || "?" });
  try { document.title = msg; } catch {}
  try { window.__bootErr.push(msg); } catch (_) {}
  try { sendCtrl({ type: "log", msg }); } catch {}
}
window.addEventListener("error", (e) => jserr("error", e));
window.addEventListener("unhandledrejection", (e) => jserr("rejection", e));

// 焦点归属探针。终端应用里「焦点现在在谁身上」是核心不变量，但它在画面上
// **看不见** —— 只能把事实回传到日志里看。有界：只报前 12 次，不留噪音。
// 用途（2026-10-15）：验证面板头上那排浮出按钮会不会把焦点从终端上抢走。
let focusProbeLeft = 12;
function focusProbe(where) {
  if (focusProbeLeft-- <= 0) return;
  const a = document.activeElement;
  sendCtrl({ type: "log", msg: `focus ${where} -> ${a ? a.tagName + (a.id ? "#" + a.id : "") + (a.className ? "." + String(a.className).split(" ")[0] : "") : "null"}` });
}
window.addEventListener("focusin", () => focusProbe("in"), true);
window.addEventListener("focusout", () => focusProbe("out"), true);

// 顺序跟 CSS 的 --mono 必须一致。**Cascadia 放第一**，不是审美问题：
// Claude Code 的开场横幅是拿 U+2580–259F 方块元素拼的像素图，只有
// 等宽终端字体才把它们画成对齐的实心块；拿 CJK 字体兜底会得到全角宽度，
// 方块之间被撑开、图案糊成一团白。Cascadia 是 Windows Terminal 的字体，
// Orca 的字体栈里写的也是它。
// ⚠️ 它必须留在**全局**：createTab（下面）要用它建 xterm。
const MONO = '"Cascadia Code WB", "JetBrains Mono WB", Consolas, "Microsoft YaHei", monospace';

// ligatures 只发 ESM，只能当 module 引；拿不到就退化成无连字，不影响可用性
// （原来是 top-level await；改成 classic script 后收进 fontsReady，
//   由启动段在**建第一个标签之前** await —— 和原来的时序完全一样。）
let LigaturesAddon = null;
const fontsReady = (async () => {
try {
  const m = await import("/vendor/addon-ligatures.esm.js");
  LigaturesAddon = m.LigaturesAddon ?? m.default?.LigaturesAddon ?? null;
} catch (e) { console.warn("[perch] ligatures 未加载:", e); }

// 字体必须在**建终端之前**就绪。
// xterm 是按字体的实际度量去算单元格宽高的，字体还没加载就 open()，
// 算出来的是回退字体的格子 —— 之后再换字体会留下歪掉的列宽和光标位置。
// 这是 webfont 终端最经典的坑。
try {
  await Promise.all([
    document.fonts.load('400 14px "Cascadia Code WB"'),
    document.fonts.load('700 14px "Cascadia Code WB"'),
    document.fonts.load('italic 400 14px "Cascadia Code WB"'),
    document.fonts.load('400 14px "JetBrains Mono WB"'),
    document.fonts.load('700 14px "JetBrains Mono WB"'),
  ]);
  await document.fonts.ready;
} catch (e) { console.warn("[perch] 字体加载异常:", e); }
})();

const CTRL = 0xFF;
const enc = new TextEncoder();

const $ = (id) => document.getElementById(id);

// ===========================================================================
// 终端 —— **一个标签一份**
//
// 这一段原来是一个只有一份的全局终端：`const term = new Terminal(…)` 写在模块
// 顶层，`fit` / `serialize` / `ready` / `stream` / `agentTitleRaw` 全是模块级
// 变量。加第二个标签**不是"再 new 一个 Terminal"就行** —— 那些变量天然只能有
// 一个主人，必须整体变成每个标签各自一份，否则两个会话的输出会写进同一块
// 缓冲、两个 PTY 会收到同一串键盘字节。
//
// 做法是**把它们收进 createTab() 的函数作用域**：函数体里 `const term` 就地
// 遮蔽模块级的 `term`，于是下面这一大段（选项、addon、WebGL 挂载顺序、尺寸
// 停稳、OSC 标题、状态点）**一行都不用改**，闭包自动把它绑到"这一个标签"。
// 比把每处引用改写成 `tab.xxx` 安全得多：那些注释记的都是"为什么"，改引用
// 等于把它们全搬一遍，搬错一处就是一处静默的行为差异（比如两个标签共用
// 一份 lastSizeSent，第二个标签的 resize 就永远发不出去）。
//
// 模块级只留三样：
//   term       —— **当前激活标签**的 xterm。文件后面（IME 锚定、状态栏读数、
//                 焦点恢复）几十处读的都是它，所以它是"视图"而不是"某一份"。
//                 只由 setActive() 赋值，别在别处写。
//   activeTab  —— 当前激活的标签对象。
//   TAB_LIST   —— 标签模型，按创建顺序；标签条按它渲染。
// 其余曾经是模块级的（ready / connDown / agentTitleRaw / liveTitle /
// lastSizeSent / raf…）现在全都是标签自己的状态。
// ===========================================================================
let activeTab = null;
/* C5：被"拎成一张独立页"的那一格；null = 看的是并行网格。
   ⚠️ 它只是一个**视图**开关，不是模型成员 —— TAB_LIST 里那格照样在、PTY 照跑
   （这正是"关掉页面就把 agent 还给网格"能成立的原因：agent 从来没离开过网格）。
   声明放在这里而不是页面那段代码旁边：createTab 在**模块求值期间**同步调
   renderGrid()，而 renderGrid 要读它 —— 放到后面就是 TDZ
   （`Cannot access 'soloTab' before initialization`，本文件已经栽过一次，见
   createTab 里 `let ready` 那段）。 */
let soloTab = null;
let term = null;                 // 激活标签的 xterm（视图，见上）
const TAB_LIST = [];             // 标签模型，按创建顺序
/* Workspaces 看得见的格子：Bot Group 的成员格（t.group）不算。网格、页签、左栏、总览的
   计数都用它；needModel / 状态点 / 会话守卫这类「每一格都要管」的仍然遍历 TAB_LIST。 */
function wsTabs() { return TAB_LIST.filter((t) => !t.group); }
/* Bot 格的挂载点：Bot Group 的格子坞（index.html 里常驻、永远有尺寸）。 */
function botDockBody() { return document.getElementById("bg-dock-body") || $("termbody"); }
// 正在用 WebGL 的格子数。**网格把"一个上下文"变成了"每格一个上下文"**：
// Chromium 对同时存在的 WebGL 上下文有硬上限（约 16），超了会**静默丢掉最早
// 那些**，表现是从某个格子开始整片变糊 —— 像是渲染坏了，其实是名额用光了。
// 所以到上限就主动退回 DOM 渲染器（那条路本来就在：gfx.on=false）。
/* ⚠️ 2026-10-15 实测把上限从 8 提到 12，依据是两条量出来的事实：
   ① **10 格全是 WebGL，而且清晰**（每格 canvas=2、webgl=true，截图放大看字形
      是锐的 —— 超上限的表现是"整片变糊"，而糊是**静默**的，所以这一条必须
      看像素，不能看日志）；
   ② 那个 8 是**我们自己拍的**，不是平台的墙。试过 Orca 那条路
      （`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--max-active-webgl-contexts=32`，
      它自己是把上限抬到 128 的，见 terminal-webgl-hidden-retention.ts:4）——
      **抬不抬都一样**：不带那个环境变量时 10 格照样全是 WebGL。
      也就是说 WebView2 的默认天花板本来就够，没必要给整个 WebView2 进程
      塞一个全局启动参数。
   12 = 实测过的 10 + 余量，同时离平台那个 ~16 还留 4 个位置；超过才退 DOM。 */
let webglLive = 0;
const WEBGL_MAX_CELLS = 12;

// 新标签的默认启动意图。cwd 留空 = 交给 Go 侧的默认工作目录。
const DEFAULT_SPAWN_SPEC = { agent: "claude", cwd: "", target: "scratch",
  resume: { kind: "new", id: "" } };

/* ===========================================================================
   格内横幅（冷恢复步 6）—— 把"这一格为什么不是上次那条会话"摆在**这一格**里
   ---------------------------------------------------------------------------
   没有它的时候：冷恢复被降级了、或者记录里那条会话在盘上没了，界面上**一个字
   都不说** —— 只有一行 bootFact 日志。用户看到的是"我上次明明开着 4 格，这次
   有一格是空的"，而"为什么"只存在于那份日志里。这正是 Orca 那条规矩的反面：
   **接不上要出声，而且要在那一格上出声**（它把这种话放在 pane chrome 里，
   不放 PTY —— 恢复出来的 TUI 会立刻重画，写在 PTY 里的话会被自己擦掉）。

   四种来源（**全都是已经知道的事实**，一处也不猜）：
     no_id / ok        —— 不需要横幅（没事发生）
     no_session        —— 盘上找不到那条会话（冷恢复判定，见 panes.go 的 restorePlan）。
                          ⚠️ 只在 `spoke` 为真时出（那一栏上次**真的说过话**）——
                          没说过话的格子盘上本来就没有 jsonl，那是常态，不是事故。
     unavailable 类    —— 护栏**终局**拒绝（文件不在 / id 形状不对 / 意图不认识）
     conflict          —— 护栏瞬时拒绝、重试两次之后还是被占着（`agent_session_conflict`）
     这两种是 Go 给的拒绝码，落在 T.restoreDegraded 上（见 createTab ②）。
     mismatch          —— Go 在**运行中**发现的："请求的 id 和实际起来的对不上"
                          （判据见 main.go 的 judgeResume），走 pane.mismatch 那条消息。

   ⚠️ 这张横幅**不自动消失**：它就是那条"你不知道就永远不知道"的事实。
   点它（或那颗 ×）收掉 —— 收掉的只是屏幕上的这一条，记录一个字没动，
   下次重开照样按记录去接。
   =========================================================================== */

/* Lucide triangle-alert（lucide-static v1.58.0 原文 path，ISC 许可，一个字符没改；
   和上面 panel-left / fold-vertical 那几枚同一套笔法）。
   ⚠️ 它必须**定义在 createTab 之前**：启动那次 burst 是**模块求值期间**跑的，
   而文件后半那批 LUCIDE_* 常量到那一刻还没执行到 —— 在函数体里引用它们就是
   TDZ 的 ReferenceError（表现是"第一格建不出来"，和图标本身毫无关系）。 */
/* 滚动条一带的颜色（照 Orca terminal-appearance.ts 的 composeActiveTerminalTheme）：
   我们设了 scrollbar.width，xterm 6 就会开概览标尺，它左边那道 1px 边框默认是亮色 ——
   多格并排时每格右侧一根白线，和格子头的分隔线差 7px 对不齐。边框透明；
   滑块调亮（xterm 默认约 0.2 的透明度在深底上几乎看不见）。 */
const TERM_THEME_SCROLL = Object.freeze({
  overviewRulerBorder: "transparent",
  scrollbarSliderBackground: "rgba(180, 180, 185, 0.4)",
  scrollbarSliderHoverBackground: "rgba(180, 180, 185, 0.6)",
  scrollbarSliderActiveBackground: "rgba(180, 180, 185, 0.8)",
});
/* xterm 主题。深色：ANSI 16 色逐字取自 Orca 的默认暗色主题 "Ghostty Default Style Dark"，
   只有 background / cursorAccent 跟着画布 #0a0a0a 走（理由见 00-base.css 顶部）。
   浅色（2026-10-28）：ANSI 逐字取自 Orca 的 "Builtin Tango Light"
   （src/shared/terminal-themes/defaults.ts:31-56 —— 它把 Tango 原版近白的 yellow/white
   压深过，浅底上 agent 的强调色才读得清），底色换成我们的内容面 #fbfbfc（壳层方向 A）。
   ⚠️ 底色 / 前景改了要同步 osc_color.go 的 light/dark 常量和 00-base.css 的 --term-*。 */
const TERM_THEME_DARK = Object.freeze({
  ...TERM_THEME_SCROLL,
  background: "#0a0a0a", foreground: "#ffffff",
  cursor: "#ffffff", cursorAccent: "#0a0a0a",
  selectionBackground: "#5a7898", selectionForeground: "#ffffff",
  black: "#1d1f21", red: "#cc6666", green: "#b5bd68", yellow: "#f0c674",
  blue: "#81a2be", magenta: "#b294bb", cyan: "#8abeb7", white: "#c5c8c6",
  brightBlack: "#666666", brightRed: "#d54e53", brightGreen: "#b9ca4a",
  brightYellow: "#e7c547", brightBlue: "#7aa6da", brightMagenta: "#c397d8",
  brightCyan: "#70c0b1", brightWhite: "#eaeaea",
});
const TERM_THEME_LIGHT = Object.freeze({
  ...TERM_THEME_SCROLL,
  background: "#fbfbfc", foreground: "#2e3434",
  cursor: "#2e3434", cursorAccent: "#fbfbfc",
  selectionBackground: "#accef7", selectionForeground: "#2e3434",
  black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#8e7700",
  blue: "#3465a4", magenta: "#75507b", cyan: "#05727e", white: "#6a6a6a",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#1b7a1b",
  brightYellow: "#6d5a00", brightBlue: "#204a87", brightMagenta: "#ad7fa8",
  brightCyan: "#034b50", brightWhite: "#3d3d3d",
});
function termThemeNow() {
  return document.documentElement.classList.contains("theme-light") ? TERM_THEME_LIGHT : TERM_THEME_DARK;
}
// Orca 按底色亮度分档（terminal-contrast-correction.ts）：亮底 4.5（WCAG-AA 正文），暗底 3。
function termContrastNow() {
  return document.documentElement.classList.contains("theme-light") ? 4.5 : 3;
}

const LUCIDE_TRIANGLE_ALERT =
  '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
  '<path d="M12 9v4"/><path d="M12 17h.01"/>';

/* Lucide chevron-down（lucide-static 原文 path）—— 格子头上那颗常驻的
   「换 Agent」下拉。用户 2026-10-20 定下的形态：箭头一直在 logo/名字后面，
   未开始时亮蓝、开始后转灰（菜单项一起灰）；不再用格内横幅。
   ⚠️ 不能在这个文件里调 40-chrome 的 lucide()：**第一个标签是模块求值期建的**，
   那时 40-chrome 还没求值，函数根本不存在（10-term 头部那条 TDZ 教训）。
   所以这里先把整段 SVG 拼成一个常量，建格时只用常量。 */
const LUCIDE_CHEVRON_DOWN = '<path d="m6 9 6 6 6-6"/>';
const AGENT_SWAP_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  LUCIDE_CHEVRON_DOWN + '</svg>';

// Go 的拒绝码 → 横幅（文案在这里，判据在 Go：码是它给的，我们只转述）
function bannerForRefusal(r) {
  if (!r) return null;
  const conflict = r.code === "agent_session_conflict";
  return {
    kind: conflict ? "conflict" : "unavailable",
    text: conflict
      ? t("term.banner.conflict")
      : t("term.banner.unavailable"),
    // sub 直接用 Go 那句话：它本来就是写给人看的（同一句话在左边栏点「接上」
    // 被拒时是那条 toast）。**不另写一份** —— 两份说法迟早会不一致。
    sub: r.msg || ("（" + r.code + "）"),
  };
}

/* 把一条横幅挂到某一格上。**幂等**：同一种 kind 已经挂着就什么都不做
   （mismatch 可能被 Go 连着推两次：hook 和登记表两条路都可能先到）。
   返回是否真的改动过 —— 调用方靠它决定要不要落一条事实。 */
function showCellBanner(tab, info) {
  if (!tab || !tab.cellBody || !info || !info.kind) return false;
  const old = tab.cellBody.querySelector(".cellbanner");
  if (old && old.dataset.kind === info.kind) return false;
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "cellbanner k-" + info.kind;
  el.dataset.kind = info.kind;
  el.title = (info.sub ? info.sub + "\n" : "") + t("term.banner.dismissHint");
  el.innerHTML =
    `<span class="ic">${lucide(LUCIDE_TRIANGLE_ALERT, 12)}</span>` +
    `<span class="tx"></span>` +
    `<button class="x" title="${esc(t("term.banner.dismiss"))}">×</button>`;
  // ⚠️ 走 textContent 不走 innerHTML：text 里可能有 Go 给的原话（含会话 id、路径），
  // 那是**数据**不是标记。细节（sub）只进 title —— 一行放不下，见 CSS 那条。
  el.querySelector(".tx").textContent = info.text;
  el.addEventListener("click", (e) => { e.stopPropagation(); el.remove(); });
  // ⚠️ 必须插在 .cellbody 里（它是 position:relative），**不能**插成 .termhost 的
  // 兄弟 —— 理由见 CSS 里那条（会改布局 → 触发 refit → 恢复出来的 TUI 立刻重画）。
  tab.cellBody.appendChild(el);
  bootFact(`格内横幅 tab=${tab.id} pane=${(tab.spec && tab.spec.paneId) || 0} kind=${info.kind}：${info.text}`);
  return true;
}

/* ===========================================================================
   新格还没开始干活 → 可以换 Agent（用户 2026-10-20 定的形态）
   ---------------------------------------------------------------------------
   「还没开始」只有两个第一手判据，别的一律不算：
     · 用户真的按键/粘贴/IME 提交（term.onKey / textarea paste /
       compositionend）—— 焦点/滚动/复制/终端自动应答都不算；
     · 除 SessionStart 外的任何 hook（用户离开子代理、工具调用、提问、Stop…）。
   SessionStart 是新进程本身的开场白，不代表用户派了活，所以不算。
   一触发就永久收灰：换 Agent 是**开局前**的选择，不是运行中改配置。
   ⚠️ 入口是格子头上那颗**常驻**的下拉箭头（logo + Agent 名字后面）：
   未开始 = accent 蓝，开始后 = faint 灰，菜单项一起灰并说明原因。
   2026-10-20 拆掉了格内那条 24px 横幅（用户："上面标签栏下面马上又出现
   一条切换栏，质感差"）——状态还在，只是不再多占一行。
   ⚠️ 真正的切换在 60-shell 的 switchFreshAgent —— 它必须丢掉刚起的空会话
   （pane.forget）再起新的一格，绝不能原地改一个已经连着 PTY 的 spec。
   =========================================================================== */

function freshAgentLabel(t) {
  const id = (t && t.spec && t.spec.agent) || "";
  const a = typeof opAgentById === "function" ? opAgentById(id) : null;
  return (a && a.name) || id || "Agent";
}

/* 这一格开始干活了：头上的换人箭头由蓝转灰。返回是否真的改过（日志判据）。 */
function freshCellStarted(tab, why) {
  if (!tab || !tab.fresh) return false;
  tab.fresh = false;
  tab.freshStartedBy = why || "";
  if (tab.freshBtn) {
    tab.freshBtn.classList.remove("live");
    tab.freshBtn.title = t("term.fresh.changeStarted");
  }
  if (tab.cellEl) tab.cellEl.classList.remove("fresh");
  bootFact(`新格开始干活 tab=${tab.id || 0} agent=${(tab.spec && tab.spec.agent) || "?"} ` +
    `触发=${why || "?"} → 换 Agent 箭头转灰`);
  return true;
}

/* 把"未开始"的状态挂到格子头上那颗下拉箭头上。
   ⚠️ 只由**用户明确新开一格**的那几条路调用（newTabIn / newParallelTab /
   总览启动），不跟冷恢复、接上已有、初始默认格混在一起 —— 那些不是"我刚点的
   新格"，给它们一条换人提示只会变成噪音。
   ⚠️ 不再建任何格内 DOM：2026-10-20 用户否掉了那条 24px 横幅。
   状态只在标签对象上（t.fresh）+ 格子头的 class 上（.cell.fresh）。 */
function armFreshCell(tab, why) {
  if (!tab || !tab.freshEligible || !TAB_LIST.includes(tab)) return;
  if (tab.fresh || tab.freshStartedBy || !tab.id) return;
  tab.fresh = true;
  if (tab.cellEl) tab.cellEl.classList.add("fresh");
  if (tab.freshBtn) {
    tab.freshBtn.classList.add("live");
    tab.freshBtn.title = t("term.fresh.changeFresh", { name: freshAgentLabel(tab) });
  }
  sendCtrl({ type: "log", msg: `新格提示 tab=${tab.id || 0} pane=${tab.paneID || 0} ` +
    `agent=${(tab.spec && tab.spec.agent) || "?"} 未开始，可换 Agent（${why || "新开"}）` });
}

// createTab：建一个标签。**它是 async，但在第一个 await 之前就把终端建好、
// 而且 fit 过一次了** —— 这条不能破：启动那段（模块顶层，等不了一个 await）
// 拿到的必须是**已经 fit 过**的终端，否则第一个标签的尺寸要等下一帧才对。
// （C6a 之前这里还有一条更硬的理由：cellWidthPx() 要等 xterm 量出格子宽，
//   而分栏宽度的启动恢复依赖它。那套换算退役后，只剩上面这条"首帧就得是对的"。）
//
// 顺序：先建 DOM/xterm（同步）→ 再问 Go 要一条 stream（异步）→ 接上 PTY。
// stream 为什么必须晚于终端：Go 那边的 stream handler 是**按标签在运行期注册**
// 的（main.go tabManager.create），名字由 Go 发（term:<id>），前端不自己编 ——
// 自己编的话，一旦前端连的时候 Go 还没注册，服务端会直接 404
// （stream_server.go:247-256 在**连接建立时**才按名字查 handler）。
async function createTab(spec, opts) {
  const T = {
    spec: spec || DEFAULT_SPAWN_SPEC,
    id: 0, streamName: "", stream: null,
    ready: false, connDown: false,
    // —— 新格还没开始：提示条/换 Agent 键的状态。opts.fresh 是**用户新开一格**
    //    的标记（见 armFreshCell 上面那段），冷恢复/接上/初始默认格都不带它。
    freshEligible: !!(opts && opts.fresh),
    fresh: false,
    freshStartedBy: "",
    freshBtn: null,
    freshSwitching: false,
    // —— 标题与状态点：都要跟着**这个标签**走，切换标签时不能串
    agentTitleRaw: "", agentState: null,
    // dsh 的迟到 hook 收尾计时器（见下面的 armDshLateSettle）
    dshSettleTimer: 0,
    liveTitle: "",
    // —— 尺寸：这是"吉祥物出现两次"那套去重的全部状态，每个标签必须各有一份
    lastSizeSent: "", resizeCount: 0,
    seenKey: "", tries: 0, rejectLogged: false, settleAt: 0, raf: 0,
    // C2：Go 护栏拒绝这次启动时，原因记在这儿（见 ctl 的 tab.ok 处理）。
    resumeRefused: null,
    // 冷恢复出来的格子：重连第一帧（evidence=resync）里的 waiting 可能来自
    // 重启前的旧状态。**照常显示，但先不算未读**（Orca 的 restoredUnconfirmed）；
    // 任何活证据到了就确认，见 80-live.js 的 confirmRestored / needModel。
    restoredUnconfirmed: !!(spec && spec.restored),
    waitUnconfirmed: false,
    // —— WebGL：装在一个**容器**里而不是两个散变量。上下文丢失时 addon 会被
    //    置回 null，那份改动必须被外面（状态栏那格读数）看见。
    gfx: { addon: null, on: false },
    term: null, fit: null, serialize: null,
    host: null, cellEl: null, cellBody: null, tabEl: null, nmEl: null, dotEl: null, icoEl: null,
  };
  // ⚠️ **先登记再建**：下面 `await spawnTab(T)` 期间 Go 就会把 tab.ok 发回来，
  // 而应答是靠"在 TAB_LIST 里找一个还等着应答的标签"来配对的。等到函数末尾
  // 才 push，那条应答就永远配不上，标签会一直挂在那儿等超时。
  //
  // ⚠️ 既是"先登记再建"，登记进去的那个座位就**随时可能被当标签用** ——
  //    closeTab 挑"下一个当前格"挑到它、右栏/页面级的 resize 那几处摸到它，
  //    都发生在真身装好（下面 T.refit = refit 那几行，在终端建好之后）**之前**。
  //    所以这三个"外面会调到"的接口先给空实现，真身装好后覆盖（见下面那段）。
  //    缺了它们的后果是**硬错误**，不是降级：2026-10-17 实测 ——
  //    "点 + 建第 6 格"还没建完时关掉第 1 格，setActive 在 `t.refit()` 那一行
  //    抛 `TypeError: t.refit is not a function`，**后半程整段没跑**
  //    （焦点、ackNote、快照、尺寸探针全丢），`term` 还被留在 null 上。
  T.refit = () => {};   // 终端还没建：没有尺寸可推
  T.focus = () => {};   // 同上（焦点由 setActive 负责，见文件末尾那段注释）
  T.ctrl  = () => {};   // 流还没开：消息丢掉（和上面 `ready` 那条闸同一个语义）
  TAB_LIST.push(T);
  // Bot Group 成员格（2026-10-28）：照样是真实的 agent 格，只是挂在 Bot Group 的格子坞里，
  // 不进 Workspaces 的网格 / 列表 / 页签（那些地方都用 wsTabs() 取格子）。
  T.group = (T.spec && T.spec.group) || "";
  T.bot = (T.spec && T.spec.bot) || "";

  /* ⚠️ `ready` 必须**在这里**声明，不能留到 stream 建好那段（原位置）——
     它的原位置在 `await spawnTab(T)`（下面）之后，而 createTab 在这个 await
     处会让出主线程：让出期间任何一帧回调只要碰到它（`attachWebgl` 里那个
     `requestAnimationFrame(() => { fit.fit(); pushSize(); })`、以及
     `checkCanvasDpr` 那几处日志），就会读到尚未初始化的 `ready`，
     抛 **ReferenceError: Cannot access 'ready' before initialization**。
     后果不是"报个错"这么轻：T 早就 push 进 TAB_LIST 了（先登记再建），
     于是网格里多出一个 **id=0、没有 stream** 的幽灵格，关它的时候日志是
     `关格子 tab=0 stream已关=false`（2026-10-15 实测逮到）。
     声明提到这里之后，`sendCtrl` 那个 `if (!ready) return;` 就回到它本来
     该有的语义：stream 还没开，消息丢掉。 */
  let ready = false;

  // —— 网格里那一格，**三层固定结构**：
  //      .cell ─┬─ .cellhead   ← 这个标签的 .tab 元素本体
  //             └─ .cellbody   ← .termhost 的父，boxOk() 的断言基准
  //    头为什么**复用 .tab 而不是新造一个**：重命名、状态点、agent 图标那套
  //    判据全都挂在"标签对象"上（T.nmEl / T.dotEl / T.icoEl），换个爹照旧能用；
  //    新造一个等于把那套逻辑再抄一遍，而它里面全是踩过的坑（见重命名那段）。
  T.cellEl = document.createElement("div");
  T.cellEl.className = "cell";
  T.cellBody = document.createElement("div");
  T.cellBody.className = "cellbody";
  T.host = document.createElement("div");
  T.host.className = "termhost";
  // 第一个标签（还没有 activeTab）先认领 #termhost —— setActive() 之前就有代码
  // 按这个 id 找宿主（历史上是 cellWidthPx 量格子宽用的；现在没有读者了，
  // 但"谁是当前格"这条约定留着，见 .termhost 那段 CSS 注释）。
  // 之后这个 id 跟着"当前格"走，见 setActive。
  if (!activeTab && !T.group) T.host.id = "termhost";
  T.cellBody.appendChild(T.host);

  // —— 格子的头（**建一次就不重建**：重命名会把 .nm 换成输入框，
  //    重建等于把用户正在打的字连输入框一起删掉）。元素挂在标签对象上，
  //    所以 renderTabTitle / renderAgentDot 认的永远是"标签对象"而不是 id。
  T.tabEl = document.createElement("div");
  T.tabEl.className = "tab cellhead";
  T.tabEl.innerHTML =
    `<span class="adot" data-state="idle" role="img" aria-label="${esc(t("state.idle"))}"></span>` +
    `<span class="tab-ico"></span>` +
    `<span class="nm ell"></span>` +
    // **常驻**的下拉箭头（用户 2026-10-20 确认：未开始蓝、开始后灰）：
    // 它就是"换 Agent"的入口，不再另起一条横幅。放在 × 左边 ——
    // 它是"改这一格"，不是"关这一格"，两个动作不能挨着读错。
    `<button class="aswap" type="button" aria-label="${esc(t("term.fresh.label"))}" ` +
      `title="${esc(t("term.fresh.label"))}">${AGENT_SWAP_SVG}</button>` +
    `<span class="x" title="${esc(t("term.tab.close"))}">×</span>`;
  T.dotEl = T.tabEl.querySelector(".adot");
  T.icoEl = T.tabEl.querySelector(".tab-ico");
  T.nmEl  = T.tabEl.querySelector(".nm");
  T.freshBtn = T.tabEl.querySelector(".aswap");
  T.icoEl.innerHTML = agentTabIcon(T.spec.agent); // agent 图标只在格子头这一个落点（见 P5 那段注释）
  renderTabTitle(T);
  T.freshBtn.addEventListener("click", (e) => {
    // 不能冒泡到 #termbody 的 click：那一条会把 .x 当关闭、还会顺手切格；
    // 换 Agent 是这一格自己的事，由它自己处理。
    // ⚠️ 不要求 T.fresh：开始后菜单也要能打开（项是灰的、点了会说明为什么）。
    e.preventDefault();
    e.stopPropagation();
    if (typeof openFreshAgentMenu === "function") {
      openFreshAgentMenu(T, T.freshBtn);
    }
  });

  T.cellEl.appendChild(T.tabEl);
  T.cellEl.appendChild(T.cellBody);
  (T.group ? botDockBody() : $("termbody")).appendChild(T.cellEl);
  renderGrid();

  // 下面整段原来直接写 $("termhost")（按 id 找唯一宿主）。现在宿主是每个标签
  // 自己一个，所以这里只认**自己的**那一个 —— 另一个格子的 PTY 推 resize 时
  // 绝不能拿这一格的盒子去量。
  const host = T.host;

const term = new Terminal({
  // 必须是**具体字体名**：xterm.js 把这一串原样交给 canvas 的 font，
  // 不经过 CSS 引擎 —— 写 var(--code) 会让整串解析失败并静默掉回默认字体。
  // 首选字体来自设置页（05-prefs.js 的 termFontStack）；后面只是兜底。
  fontFamily: termFontStack(),
  // 字号来自设置页，默认 14。**不是按格数算出来的**：格子多了就是格子变小，
  // 字号不动（2026-10-17 试过一版"先改摆法、超限降字号"，用户看过实际效果后否了）。
  // 设置页改了之后走 applyAppearance 在运行时改 term.options（见下面 T 上那个方法）。
  fontSize: SETTINGS.termFontSize,
  lineHeight: 1,                    // Orca 不设，xterm 默认就是 1
  // Orca 用 300/500（它默认字体是 macOS 的 SF Mono，有细体）。
  // 我们只带了 JetBrains Mono 的 400/700 —— 硬套 300 会被浏览器**合成**出假细体，
  // 而且中文回退字体也会跟着被合成，比老实用 400 更难看。
  fontWeight: 400,
  fontWeightBold: 700,
  cursorBlink: true,
  cursorStyle: "block",             // Orca 默认块状光标，不是竖线
  cursorInactiveStyle: "outline",
  scrollback: 5000,                 // Orca 桌面默认 5000 行
  // ConPTY 的版本告诉 xterm（Orca windows-pty-compatibility.ts）：它按这个决定重排和折行标记怎么处理。
  // 版本号从 Go 来（settings 推送里的 osBuild），首帧用上次记下的。
  ...(OS_BUILD ? { windowsPty: { backend: "conpty", buildNumber: OS_BUILD } } : {}),
  scrollSensitivity: 1.15,
  fastScrollSensitivity: 5,
  allowProposedApi: true,           // unicode11 与 serialize 需要
  allowTransparency: false,
  // Orca 是按**背景亮度**分档的，不是按应用明暗模式
  // （terminal-contrast-correction.ts）：亮底 4.5（WCAG-AA 正文），
  // 暗底 3（WCAG-AA 大字）。它把 4.5 用在暗底上会"把鲜艳的 ANSI 色
  // 过度提亮"（原注释点名的 bug #7934）。我们的底是 #0a0a0a（近黑），取 3。
  minimumContrastRatio: termContrastNow(),
  drawBoldTextInBrightColors: true,
  scrollbar: { width: 7 },          // 细滚动条；FitAddon 会把它算成一条 gutter，代价约 1 列
  // macOS 上非美式键盘要靠 Option 组合出 @ 和 € 这类字符。
  // 我们在 Windows 上跑，但这是 Orca 的默认值，留着以免以后移植时漏掉。
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
  // kitty 键盘协议：本机 Windows ConPTY 下**不声明**（照 Orca terminal-keyboard-protocol.ts：
  // 有的 CLI 会开 KKP 却不认 CSI-u 的导航键，#2434）。2026-10-29 之前我们写的是 true，
  // 但那时的 xterm 6.0 根本不认这个选项、等于没开；换成 Orca 打过补丁的 6.1 之后它才真正生效，
  // 所以这里必须按 Orca 关掉。Shift+Enter 之类改由按键策略按 agent 发对的编码。
  vtExtensions: { kittyKeyboard: false },
  // ANSI 16 色（black…brightWhite）逐字取自 Orca 的默认暗色主题
  // "Ghostty Default Style Dark"，**不动** —— 它们与底色无绑定关系。
  // 只有 background / cursorAccent 跟着 --term-bg 走了我们的画布色，理由见文件顶部。
  theme: termThemeNow(),
});
// 格宽只取决于盒子、不取决于当前列数（Orca StableCellFitAddon，11-term-output.js）
const fit = new StableCellFitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
try { term.loadAddon(new ImageAddon.ImageAddon()); }
catch (e) { console.warn("[perch] image addon 未加载:", e); }

// Unicode 11 宽度表：中文、盒线字符按 2 列算。不加载的话宽度全按 1 列，
// 中文和边框会整体错位。
term.loadAddon(new Unicode11Addon.Unicode11Addon());
termActivateUnicode(term);   // unicode11 + ZWJ 合并（Orca 同款，11-term-output.js）

let serialize = null;
try { serialize = new SerializeAddon.SerializeAddon(); term.loadAddon(serialize); }
catch (e) { console.warn("[perch] serialize addon 未加载:", e); }

term.open(host);
// 全屏 TUI 的滚轮按 Orca 的规则换算成多次鼠标上报（attachTuiWheel，文件尾）
attachTuiWheel(term);
// 输出管线照 Orca：同步帧整帧写、中途的光标显示挪到帧尾、写完补刷新（11-term-output.js）
const termOut = createTermOutput(term);
T.termOut = termOut;
// 按键策略照 Orca：Shift+Enter 换行不提交、选中时 Ctrl+C 复制、Ctrl+Backspace 删词（12-term-keys.js）
attachTermKeys(term, T, termOut);

// ---------------------------------------------------------------------------
// WebGL 的挂载顺序 —— 这一段是**照 Orca 的 pane-webgl-renderer.ts 搬的**，
// 不是自己排的。原文件里有句注释点破了关键：
//
//   "the grid this pane is running was measured under DOM cell metrics …
//    Keeping that grid leaves an unpainted right gutter and a
//    **PTY narrower than the pane**. Refit on the next frame."
//
// 也就是说：DOM 渲染器和 WebGL 渲染器的**单元格度量不一样**
// （WebGL 会把设备像素下的格子宽度取整）。如果先 fit、后挂 WebGL，
// 那个列宽是按 DOM 度量算出来的 —— PTY 拿到的列数和 WebGL 实际画出来的
// 格子宽度**对不上**，终端里所有按列定位的字符都会落在错误的位置上。
//
// 我们之前就是 open() → fit() → 挂 WebGL，正好是这个顺序。
//
// Orca 的解法是 attachWebglAndRefit()：挂载和重排**成对出现**，
// 而且挂完要 refresh 一帧（新 canvas 是空的，不重绘会看起来卡住）。
// ---------------------------------------------------------------------------
const gfx = { addon: null, on: false, lostAt: [], disabledAfterLoss: false };
// 释放 WebGL 时主动丢掉上下文、把画布清零（Orca pane-webgl-renderer.ts disposeWebgl）：
// 不这么做，驱动那边的上下文会多活一会儿，连续切格时撞上 Chromium 的上下文名额（#6874）。
function releaseWebgl() {
  const a = gfx.addon;
  if (!a) return;
  try {
    const r = a._renderer;
    const ext = r && r._gl && r._gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
    if (r && r._canvas) { r._canvas.width = 0; r._canvas.height = 0; }
  } catch (_) {}
  try { a.dispose(); } catch (_) {}
  gfx.addon = null;
}
T.releaseWebgl = releaseWebgl;
function attachWebgl() {
  // Bot 格平时藏在格子坞里，WebGL 名额（12）留给 Workspaces 里看得见的格子。
  if (T.group) return false;
  // 名额满了就用 DOM 渲染器起来。**不是降级失败** —— xterm 的 DOM 渲染器
  // 画出来的字是对的，只是慢一档；而超上限的后果是"最早那些上下文被静默丢掉"，
  // 那是随机的、会连累已经正常的格子，比慢一档糟得多。
  if (webglLive >= WEBGL_MAX_CELLS) {
    // ⚠️ bootFact 而不是 sendCtrl：这个函数跑在 `await spawnTab(T)` **之前**，
    // 那时标签自己的流还没开（ready=false），工厂内那个 sendCtrl 会**静默丢掉**
    // 这条消息 —— 第一次实测第 9 格时它就是这么消失的：格子确实退成了 DOM
    // 渲染器（webgl=false canvas=0），但"为什么退"一个字都没留下。
    bootFact(`WebGL 名额已满（${webglLive}/${WEBGL_MAX_CELLS}），这一格用 DOM 渲染器`);
    return false;
  }
  try {
    gfx.addon = new WebglAddon.WebglAddon();
    gfx.addon.onContextLoss(() => {
      // 上下文丢失意味着字形图集被清空，必须整个退回 DOM 渲染器，
      // 并且**重排** —— 见上面：度量变了不重排，列宽就是错的。
      console.warn("[perch] WebGL 上下文丢失，退回 DOM 渲染器");
      // Orca pane-webgl-context-loss-policy.ts：60 秒内丢了不到 3 次，就在下次回到前台时再试
      const now = Date.now();
      gfx.lostAt = gfx.lostAt.filter((x) => x > now - 60000).concat(now);
      gfx.disabledAfterLoss = true;
      releaseWebgl();
      gfx.on = false;                       // 状态栏那格读数要跟着变
      webglLive--;                          // 名额还回去，别的格子能捡到
      requestAnimationFrame(() => { try { fit.fit(); pushSize(); } catch (e) {} });
      if (activeTab === T) paintRenderStatus();
    });
    term.loadAddon(gfx.addon);
    webglLive++;
    // 新挂上的 canvas 是空白的：立刻重绘一次，否则要等新输出才看得见东西。
    term.refresh(0, term.rows - 1);
    return true;
  } catch (e) {
    console.warn("[perch] WebGL 不可用，退回 DOM 渲染:", e);
    try { gfx.addon && gfx.addon.dispose(); } catch (e2) {}
    gfx.addon = null;
    return false;
  }
}

gfx.on = attachWebgl();
// 上下文丢失后的重试：回到前台 / 窗口重新拿到焦点时再挂（Orca："until the next resume or settled reveal"）
function retryWebglAfterLoss() {
  if (!gfx.disabledAfterLoss || gfx.addon || document.hidden) return;
  const now = Date.now();
  gfx.lostAt = gfx.lostAt.filter((x) => x > now - 60000);
  if (gfx.lostAt.length >= 3) return;   // 不稳定的上下文不再重试
  gfx.disabledAfterLoss = false;
  gfx.on = attachWebgl();
  requestAnimationFrame(() => { try { fit.fit(); pushSize(); } catch (_) {} });
  if (activeTab === T) paintRenderStatus();
}
document.addEventListener("visibilitychange", retryWebglAfterLoss);
window.addEventListener("focus", retryWebglAfterLoss);
// 挂完渲染器才 fit —— 顺序反了列宽就是错的。
fit.fit();
// 再排一帧：字体/渲染器都就位后，格子度量才算稳定。
await new Promise((r) => requestAnimationFrame(r));
fit.fit();

// 快速 TUI 重绘会在**没有上下文丢失事件**的情况下把 xterm 的字形图集搅坏
// （Orca 的 clearTextureAtlas 就是为这个存在的，原注释：rapid TUI redraws
// can corrupt xterm's WebGL glyph atlas without a context-loss event）。
// Claude Code 正是高频重绘的 TUI，所以给它一个显式出口。
function resetGlyphAtlas() {
  if (!gfx.addon) return;
  try {
    gfx.addon.clearTextureAtlas();
    term.refresh(0, term.rows - 1);
    sendCtrl({ type: "log", msg: "已重置 WebGL 字形图集" });
  } catch (e) {}
}

// canvas 后备存储的 dpr 与当前 dpr 不一致时，整屏会发虚/错位。
// Orca 有专门的 terminal-canvas-dpr-repair.ts；这里先只做检测并回报，
// 因为在我们这个容器里还没观察到过一次 —— 不猜它一定存在。
function checkCanvasDpr() {
  const c = host.querySelector("canvas");
  if (!c) { sendCtrl({ type: "log", msg: "canvas 不存在（DOM 渲染器）" }); return; }
  const want = Math.round(c.clientWidth * devicePixelRatio);
  if (Math.abs(c.width - want) > 1) {
    sendCtrl({ type: "log", msg: `canvas dpr 不匹配: width=${c.width} 期望≈${want} dpr=${devicePixelRatio}` });
    requestAnimationFrame(() => { fit.fit(); pushSize(); });
  } else {
    sendCtrl({ type: "log", msg: `canvas dpr 正常: ${c.width}x${c.height} dpr=${devicePixelRatio}` });
  }
}

if (LigaturesAddon) {
  try { term.loadAddon(new LigaturesAddon()); }
  catch (e) { console.warn("[perch] ligatures 挂载失败:", e); }
}

  // 页面级代码要读的那几样，在这里就挂到标签对象上 —— **必须早于下面的
  // installImeAnchor**：它第一个动作就是 `t.term.element`，晚一行就是
  // "Cannot read properties of null (reading 'element')"。
  T.term = term; T.fit = fit; T.serialize = serialize; T.gfx = gfx;

// IME 候选框锚定：**每个标签各装一份**（原来是个模块级 IIFE，见下面那段注释 ——
// 在"只有一个终端"的前提下它才成立）。这里终端刚 open 完、元素齐全，
// 也正是它需要的时机。
installImeAnchor(T);

  // ---- 终端（含 WebGL）已经就位，现在去 Go 那边认领一条 stream ----
  // 必须在下面的 onopen/onmessage **之前**：那些赋值要一个真对象。
  // 名字由 Go 给（term:<id>），前端不自己编 —— 理由见 createTab 上面那段。
  let streamName = await spawnTab(T);
  /* ① 瞬时拒绝：同一格、同一 paneId **再试**（判据由 Go 给，见 resume.go 的
     refusal.retryable）。冷启动正是占用判据最不可靠的时刻 —— 上一轮的 claude
     由 KILL_ON_JOB_CLOSE 异步收掉、登记表残留不自清、pid 还可能被复用，
     于是"刚关掉就重开"会撞上一个假的冲突。等 800/1600ms 再问一次就过了。
     ⚠️ 重试**必须住在 createTab 里面**：DOM 和 stream 都归它管，换到外面重来一遍
     就是又建一格（座位、paneId、WebGL 名额全重来）。 */
  for (let i = 0; !streamName && T.resumeRefused && T.resumeRefused.retryable && i < RESUME_RETRY_MS.length; i++) {
    const wait = RESUME_RETRY_MS[i];
    bootFact(`接上被拒 code=${T.resumeRefused.code}（瞬时，可以再试）→ ${wait}ms 后第 ${i + 1} 次重试 pane=${(T.spec && T.spec.paneId) || 0}`);
    T.resumeRefused = null;
    await new Promise((r) => setTimeout(r, wait));
    if (!TAB_LIST.includes(T)) return T;   // 等待期间用户把它关掉了：就地收手
    streamName = await spawnTab(T);
  }
  /* ② 降级：**冷恢复的座位不许撤**。座位序是用户摆的，撤一格后面每一格都要换位置
     （验收里那条"格数与座位序与上次一致"就靠它）。所以原地换一条新会话 ——
     同一个 paneId、同一个格子，只是不接旧会话了；被拒的原因留在 T.restoreDegraded
     上，步 6 的横幅读它。
     为什么只对冷恢复这么做：从左边栏点「接上」是**用户点名**要那一条会话，
     接不上就该把这一格收掉并说清楚（下面那个分支），而不是偷偷给他一条新的。 */
  if (!streamName && T.resumeRefused && T.spec && T.spec.restored) {
    T.restoreDegraded = T.resumeRefused;
    T.resumeRefused = null;
    /* 降级是**知情地换目标**：记录必须跟着走到新会话（否则下次重开它会一直去接
       一条我们早就放弃了的会话）。但"原本要接的是哪条"也要留一笔 —— 横幅点一下
       就收掉了，收掉之后从盘上再也看不出这一格原本属于另一条会话。
       所以把旧 id 搭在这一次 tabs.create 上一块儿送回去（见 Go 的 markDegraded：
       它只留证，不参与任何判定）。⚠️ 旧 id 必须在改写 spec **之前**取。 */
    const wasIntending = (T.spec.resume && T.spec.resume.id) || "";
    T.spec = Object.assign({}, T.spec, {
      resume: { kind: "new", id: "" },
      degradedFrom: wasIntending,
    });
    bootFact(`冷恢复降级：pane=${T.spec.paneId} 拒绝=${T.restoreDegraded.code} ` +
      `（原本要接 ${wasIntending.slice(0, 8) || "(没有 id)"}）→ 座位留着，改起一条新会话`);
    streamName = await spawnTab(T);
  }
  /* ③ 到此为止还是空名字 + 有明确拒绝 = **这条启动没成**（护栏拒绝了它）。
     不能走到下面去：下面那句 `Stream(streamName)` 收的是空名字，会连一条不存在的
     流，然后 T.stream 也照样被设上 —— 那一格从此是个"看着在跑、其实没有 PTY"的幽灵。
     所以这里就地收尾：撤格 + 把原因说出来。
     ✅ 判据只认 `T.resumeRefused`，**不认"没有 streamName"**：后者还包括
     "2s 没等到应答"，那种情况必须保持原样（格子留着、界面交出去，见 spawnTab
     里那条兜底注释）—— 启动时第一个格子走的正是那条路，撤了就是白屏。 */
  if (!streamName && T.resumeRefused) {
    // ⚠️ 这里必须用 bootFact，**不能用 sendCtrl** —— createTab 这一层里
    // `sendCtrl` 指的是下面那个本格版本（故意遮蔽模块级的那个），而它开头就是
    // `if (!ready) return`：流还没开，消息**静默丢掉**。这条日志就这么消失过一次
    // （2026-10-15：拒绝路径跑通了、日志里却只有 closeTab 和 toast 那两行）。
    bootFact(`接上被拒（收尾）code=${T.resumeRefused.code} → 撤格、不建流`);
    closeTab(T);
    /* 接「已关闭」agent 那条路自己会解释（它知道这条记录还在左栏、还知道用户
       下一步能做什么，见 resumeClosedPane）—— 这里别再叠一张更含糊的卡。
       quietRefusal 只给「新建 Agent」表单：原因要放回表单里，不走 toast。 */
    const quiet = !!(opts && opts.quietRefusal);
    if (!(T.spec && T.spec.closedResume) && !quiet) {
      showToast({
        agent_session_conflict: t("term.resume.conflict"),
        unavailable: t("term.resume.unavailable"),
        bad_id: t("term.resume.badId"),
      }[T.resumeRefused.code] || t("term.resume.failed"),
        T.resumeRefused.msg
          ? tMsg(T.resumeRefused.msgCode, T.resumeRefused.msgParams, T.resumeRefused.msg)
          : t("term.resume.refusedCode", { code: T.resumeRefused.code }), "err");
    }
    return T;
  }
  T.streamName = streamName;

  /* ---- 步 6：把"这一格为什么不是上次那条会话"说出来 ----
     ⚠️ 落点必须在 ③（撤格那条）**之后**：被拒且非冷恢复的格子会就地收掉，
     给它挂一条横幅只是白挂一帧。走到这儿的格子都已经拿到 stream 了。
     三种来源全在这里落定，第四种（mismatch）是 Go 在运行中发现的，走 ctl 的
     `pane.mismatch` 那条消息 —— 它到得比 SessionStart 还晚，那时这一格早建好了。 */
  if (T.restoreDegraded) {
    // 冷恢复被降级：Go 的拒绝理由就是横幅的正文（见 bannerForRefusal）
    showCellBanner(T, bannerForRefusal(T.restoreDegraded));
  } else if (T.spec && T.spec.verdict === "no_session" && T.spec.spoke) {
    // 盘上那条会话没了，而它上次**真的说过话** —— 那是真丢了东西，要说出来。
    // （没说过话的格子不出横幅：它盘上本来就没有 jsonl，见 panes.Pane.Spoke。）
    showCellBanner(T, {
      kind: "unavailable",
      text: t("term.banner.missingSession"),
      sub: t("term.banner.missingSessionSub"),
    });
  }

  // `ready` 已在函数开头声明（TDZ 那段注释），这里不再重新声明。
  const stream = Stream(streamName);
  // ⚠️ **必须挂到标签对象上**：closeTab 要靠它关掉这条连接，而 Go 那边是
  // "Receive 失败 → handler return → defer 收 PTY" 这条链。
  // 少了这一行，关格子只是把 DOM 和模型删掉 —— **PTY、claude.exe、Go 里的
  // stream handler 全部原地留着**，而且不留任何痕迹（这正是它一直没被发现的原因：
  // 关掉一个非当前格连日志都不产生）。
  T.stream = stream;

  // 标签自己的控制帧出口。**故意遮蔽**模块级的 sendCtrl：模块级那个发往 ctl
  // 通道（页面级的事实，比如"新建标签"），这一个发往本标签的字节流。于是
  // 下面整段里所有 sendCtrl({type:"resize"|"rename"|"open-wt"|"log"})
  // 自动落到正确的标签上 —— 一处调用点都不用改。
  function sendCtrl(obj) {
    if (!ready) return;
    const j = enc.encode(JSON.stringify(obj));
    const f = new Uint8Array(j.length + 1);
    f[0] = CTRL; f.set(j, 1);
    try { stream.send(f); } catch (e) { jserr("sendCtrl", e); }
  }

  stream.onopen = () => {
    ready = true; T.ready = true;
    T.connDown = false; renderAgentDot(T);
    scheduleProjLive();
    if (activeTab === T) paintConnStatus(true);
    pushSize();
    fontProbe(); checkCanvasDpr();
  };

// 探针：量出方块/制表符这类字符**到底是哪个字体供的**。
// 机制是宽度 —— 等宽字体供的半格字符宽度 = 1 个字符宽；中文字体供的是**全角**，
// 宽度翻倍，相邻格子就会互相重叠，像素风 logo 的负空间被填死，糊成一块砖。
function fontProbe() {
  const c = document.createElement("canvas").getContext("2d");
  const w = (fam, ch) => { c.font = `14px ${fam}`; return c.measureText(ch).width.toFixed(1); };
  const probe = { "█": "U+2588", "▀": "U+2580", "─": "U+2500", "中": "CJK" };
  const parts = [];
  for (const [ch, name] of Object.entries(probe)) {
    parts.push(`${name}:主栈${w(MONO, ch)}/JBM${w('"JetBrains Mono WB"', ch)}/Cascadia${w('"Cascadia Code"', ch)}/MS Gothic${w('"MS Gothic"', ch)}`);
  }
  sendCtrl({ type: "log", msg: "fontprobe " + parts.join("  ") });
  sendCtrl({ type: "log", msg: `cascadia-avail=${document.fonts.check('14px "Cascadia Code"')} jbm-avail=${document.fonts.check('14px "JetBrains Mono WB"')}` });
}
stream.onclose = () => {
  ready = false; T.ready = false;
  T.connDown = true; renderAgentDot(T);
  // 左栏那一行也要立刻翻成「已停止」+ ▶（renderProjLive 是就地补，形状变了
  // 才整行换一次）。少了这一句，行要等到下一次有别的活才更新 —— 用户刚在格内
  // /exit，左栏却还写着"刚刚在跑"。
  scheduleProjLive();
  if (activeTab === T) paintConnStatus(false);
};
stream.onerror = () => {
  T.connDown = true; renderAgentDot(T);
  scheduleProjLive();
  if (activeTab === T) { $("s-dot").className = "dot off"; $("s-st").textContent = t("status.connectionError"); }
};
stream.onmessage = (ev) => {
  const d = ev.data;
  if (d instanceof ArrayBuffer)   termOut.pushBytes(new Uint8Array(d));
  else if (ArrayBuffer.isView(d)) termOut.pushBytes(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  else                            termOut.pushText(String(d));
};
/* 「未开始」的门只认**用户动作**，不能用 term.onData 判 ——
   ⚠️ 2026-10-20 真机验收逮到的 bug：xterm 对终端查询的**自动应答**也走 onData
   （焦点上报 `ESC[I`、DA/DSR 等）。Claude 一启动就发 `?9001h` / `?1004h`，
   xterm 回的应答被当成"终端输入"，于是 `新格提示 ... 未开始` 的下一行立刻是
   `新格开始干活 ... 触发=终端输入`，用户根本没碰键盘，⇄ 换 Agent 就没了。
   现在只认三种真的由用户发起的动作：按键（onKey）、粘贴、输入法提交。
   onData 只负责把字节送给 PTY（自动应答也必须送，否则终端会等应答）。 */
term.onKey(() => { termOut.noteInput(); freshCellStarted(T, "终端按键"); });
if (term.textarea) {
  term.textarea.addEventListener("paste", () => { termOut.noteInput(); freshCellStarted(T, "粘贴"); });
  term.textarea.addEventListener("compositionend", () => { termOut.noteInput(); freshCellStarted(T, "输入法提交"); });
}
term.onData((d) => { if (ready) stream.send(enc.encode(d)); });

// 每次 xterm 改变列宽都会**折行重排**已有内容，而 xterm 会在这一步把上一帧的
// 残留顶进回滚缓冲 —— 用户看到的"滚动时好几个吉祥物"就是这么来的。
// 所以要知道**到底发生了几次 resize、都在什么时候**：
// 一次拖拽该只推一次（见下面 settle 的 SETTLE_MS），这条日志就是判据。
let resizeCount = 0;
term.onResize(({ cols, rows }) => {
  resizeCount++;
  sendCtrl({ type: "log", msg: `term.resize #${resizeCount} -> ${cols}x${rows} @${Math.round(performance.now())}ms` });
});
// 这一个 chunk 里有没有 OSC 标题（下面 stale 计时器的分支判据，Orca handleChunk），
// 以及那个计时器的句柄。**都是每个标签一份**：两个会话各自在干活/空闲，
// 共用一个计时器会让先静下来的那个把另一个的 working 环灭掉。
let titleInThisChunk = false;
let staleTimer = 0;

// ---------------------------------------------------------------------------
// OSC 标题的**唯一落点**是标签（终端给的名字 = 这个标签的名字，这也是
// Windows Terminal 的约定）。以前这里同时写 #tab-nm 和 #p-title，
// 于是同一个 "Claude Code" 在中间列顶上并排出现两次（见上面 .phead 那段注释）。
term.onTitleChange((t) => {
  T.agentTitleRaw = t;
  titleInThisChunk = true;
  applyAgentTitleStatus(T, t);   // 状态点跟着标题走（下面「状态点」一节）
  renderTabTitle(T);
});

term.onWriteParsed(() => {
  const hadTitle = titleInThisChunk;
  titleInThisChunk = false;
  if (hadTitle) return;
  if (!T.agentTitleRaw || detectAgentStatusFromTitle(T.agentTitleRaw) !== "working") return;
  /* dsh-tui 只在终端有焦点时才换标题里的转圈帧（后台格子的字形是静止的）。
     照这条“3 秒没标题变化就当成停了”的兜底，后台 dsh 只要模型停顿一下就会
     被误判 idle；dsh 的标题 ✦ 已经是明确的结束证据，不走这个猜测。 */
  if (isDshTitle(T.agentTitleRaw)) return;
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    staleTimer = 0;
    const cleared = clearWorkingIndicators(T.agentTitleRaw);
    T.agentTitleRaw = cleared;
    // 走**同一个**渲染点：这里原来自己写一遍 #tab-nm，于是"3 秒静默"一触发
    // 就会把用户起的名字顶掉 —— 名字的优先级只该有一处（见 renderTabTitle）。
    renderTabTitle(T);
    T.agentState = "idle";
    clearDshHookBusy(T);
    renderAgentDot(T);
  }, STALE_WORKING_TITLE_TIMEOUT_MS);
});

// lastSizeSent：**尺寸没变就绝不往 PTY 发 resize**。
//
// 这一条是用户报的「滚动时吉祥物出现两次」的根因。
// 对 PTY 来说，一次 resize 就是「终端窗口被改变了」这个事件；CLI 收到它会
// **重画自己的开场界面**。而 pushSize() 在 onopen、ResizeObserver 初次观测、
// 窗口变化、拖拽分隔条时都会跑 —— 哪怕算出来的列宽行数和上次一模一样。
// 于是 Claude Code 画了两遍介绍框，第一份被顶进回滚缓冲，
// 往上滚就能看到两个吉祥物。
//
// 顺带：反复发同样的 resize 还会让 ConPTY 反复重排屏缓冲，
// 是那种"没什么事但一直微微闪"的来源。
let lastSizeSent = "";
function pushSize() {
  const h = host;
  // 和 settle() 同一条理由：隐藏标签（后台标签刚建出来还没激活）的盒子是
  // 0 宽，proposeDimensions 在那里会给出"2 列"这种**看起来成立**的尺寸。
  // 推给 PTY 就是让那个刚起来的会话白重画一屏 —— 正好是我们要消灭的那类
  // 多余 resize。激活时 setActive() → refit() 会补上真实尺寸。
  if (!h.clientWidth || !h.clientHeight) return;
  const p = fit.proposeDimensions();
  // 详细读数只回传日志；状态栏上留一格够用的就行。
  const amActive = activeTab === T;
  if (amActive) $("s-render").textContent = gfx.on ? "· WebGL" : "· DOM";
  // webgl=true 只说明 addon 挂上了，不代表它没被回收 —— 真在用的渲染器
  // 会往容器里插 canvas，所以这个读数要和 canvas 数量一起看（状态栏那格给不出
  // 这么多信息，只在日志里留）。
  // canvas 数量**光看个数判断不了**：xterm 一开始就有不止一个（还有测字宽用的），
  // 所以把每个的尺寸和 class 一起报出来 —— 「多出来的那一个是哪来的」只能这么问。
  const cvs = [...h.querySelectorAll("canvas")].map((c) => `${Math.round(c.clientWidth)}x${Math.round(c.clientHeight)}${c.className ? "." + c.className : ""}@${c.parentElement ? c.parentElement.tagName + "." + c.parentElement.className : "无父"}`).join(" ");
  sendCtrl({ type: "log", msg: `tab=${T.id} fit=${p ? p.cols + "x" + p.rows : "nil"} host=${h.clientWidth}x${h.clientHeight} term=${term.cols}x${term.rows} dpr=${devicePixelRatio} webgl=${gfx.on} wpty=${JSON.stringify(term.options.windowsPty || null)} canvas=${h.querySelectorAll("canvas").length} [${cvs}]` });
  if (!p || !p.cols || !p.rows) return;
  if (amActive) $("s-dims").textContent = `${p.cols}×${p.rows}`;
  const key = `${p.cols}x${p.rows}`;
  if (key === lastSizeSent) return;   // ← 就是这一行
  lastSizeSent = key;
  sendCtrl({ type: "resize", cols: p.cols, rows: p.rows });
}
// ⚠️ 「原生对比」按钮的监听**不在**这里。放在这里的话每建一个标签就会往
// 同一个按钮上再挂一个监听 —— 点一下 N 个标签一起开 Windows Terminal。
// 它是页面级（当前标签级）动作，见下面 P5 那段。

// ---------------------------------------------------------------------------
// 终端尺寸：**布局停稳之前，一个字节都不推给 PTY**
//
// 这是「吉祥物反复出现」的修法。对 PTY 来说一次 resize 就是「终端窗口变了」，
// CLI（Claude Code）收到就会整帧重画 —— 包括它的开场介绍框。所以推过去的尺寸
// 必须是真的、稳定的几何。以前这里是 `setTimeout(..., 50)`，布局还在动的时候
// 照样会跑，日志里留下了两个**根本不存在**的尺寸：
//   · fit=140x57 host=1142x920  —— 盒子量成了整个窗口，不是面板
//   · host=569x860              —— 918 高的窗口里，面板内高最大只有 834
// 这两次 CLI 都照着不存在的画布重画了一帧，介绍框就多一份。
//
// 做法照 Orca（src/renderer/src/constants/terminal.ts:19-28）：瞬时变化要让终端
// 和新布局落在同一帧，连续拖拽才走 ResizeObserver；共同点是**不拿一个还在动的
// 盒子去量**。这里落成两条：
//   1) 连续两帧量到同一个尺寸，才算"停稳"；
//   2) 停稳后还要过 boxOk()：宿主必须正好是它容器内缩 4px 的结果 —— 量到整窗
//      尺寸或不成立的高度时直接拒绝，宁可这帧不推。
let raf = 0, seenKey = "", tries = 0, rejectLogged = false, settleAt = 0;
// SETTLE_MS：尺寸停住多久才算"稳"。Orca 的全局 fit 去抖就是 150ms
// （src/renderer/src/constants/terminal.ts:20 "the 150ms debounced global fit"）。
// 没有这道时间闸，一次 1.4 秒的拖拽会推 3 次 resize（实测 #8/#9/#10）；
// 有它，中间只要还在动就一直不算稳，最后只推一次。
const SETTLE_MS = 150;
function boxOk(h) {
  // 基准从 .pbody 下沉到了 .cellbody（C4 的网格层）——**这条断言本身一个字没改**：
  // 它问的还是"宿主是不是正好等于它容器内缩 4px 的结果"。原来拿整个面板当基准，
  // 现在拿自己那一格，量到"整窗尺寸""另一格尺寸"照样被拒。
  const b = h.parentElement;   // .cellbody
  return h.clientWidth === b.clientWidth - 4 && h.clientHeight === b.clientHeight - 4;
}
function settle() {
  raf = 0;
  const h = host;
  // 隐藏标签（display:none）不量也不推 —— FitAddon 在一个 0 宽的盒子上会算出
  // "2 列"这种**看起来成立**的尺寸，推给 PTY 就是让后台那个会话白重画一屏。
  // 切回前台时 setActive() 会 refit()，那时才量。
  if (!h.clientWidth || !h.clientHeight) return;
  const p = fit.proposeDimensions();          // 只量，不动 xterm
  if (!p || !p.cols || !p.rows) return;
  const key = `${p.cols}x${p.rows}|${h.clientWidth}x${h.clientHeight}`;
  const now = performance.now();
  if (key !== seenKey) { seenKey = key; settleAt = now; }   // 还在动：重新开始计时
  const over = ++tries > 240;                 // 兜底：一直不稳就别死等（240 帧≈4s）
  const stable = now - settleAt >= SETTLE_MS;
  if ((!stable || !boxOk(h)) && !over) {
    if (!stable) { raf = requestAnimationFrame(settle); return; }
    if (!rejectLogged) {
      rejectLogged = true;
      sendCtrl({ type: "log", msg: `拒绝一个不成立的尺寸 host=${h.clientWidth}x${h.clientHeight} 容器=${h.parentElement.clientWidth}x${h.parentElement.clientHeight}` });
    }
    raf = requestAnimationFrame(settle); return;
  }
  rejectLogged = false;
  // 行列数没变就不动 xterm（Orca pane-fit.ts:121-125：亚像素的分隔条移动不该触发重排）。
  const same = p.cols === term.cols && p.rows === term.rows;
  // fit 会让 xterm 重排缓冲：先记下「你在看哪儿」，fit 完再还原 —— 在底部就继续跟着输出，
  // 往上翻着的就钉在原来那一行（照 Orca pane-scroll.ts 的 captureScrollState / restore）。
  const scroll = same ? null : termCaptureScroll(term);
  if (!same) fit.fit();                       // 到这一步才动 xterm
  if (scroll) termRestoreScroll(term, scroll);
  pushSize();
  // 这一格的真实列数到这一刻才成立（fit 之前 term.cols 还是旧值）——
  // 「N 格 · X 列/格」那个读数要在这里刷，渲染格数变化时它还是计划值。
  paintGridStatus();
  // ⚠️ 2026-10-29 删掉了这里原来的「尺寸一变就发两次 ESC[3J 清回滚」。当初是为了不让重排把
  // Claude Code 的开场介绍框一份份顶进回滚（往上滚看到一串吉祥物）；代价是右栏开合、拖分隔条、
  // 格数变化都会把历史清光 —— 用户用下来就是「终端锁死、不能往上翻」。Orca 保留 5000 行回滚、
  // 从不清（shared/terminal-scrollback-policy.ts），宁可偶尔多一份介绍框。我们跟它。
}
function refit() { if (!raf) { tries = 0; raf = requestAnimationFrame(settle); } }
new ResizeObserver(refit).observe(host);
window.addEventListener("resize", refit);

  // -------------------------------------------------------------------------
  // 建完了：把页面级代码要用的几样挂到标签对象上，登记进模型，返回。
  //
  // ⚠️ 初始焦点**不在这里** —— 建标签时它还不是激活标签，这里 focus() 会把
  // 焦点抢给一个看不见的终端。焦点由 setActive() 负责。
  // -------------------------------------------------------------------------
  T.refit = refit;
  T.pushSize = pushSize;
  T.focus = () => term.focus();
  T.ctrl = sendCtrl;                  // 往本标签的字节流发控制帧（页面级按钮要用）
  T.resetGlyphAtlas = resetGlyphAtlas;
  /* 设置页改了字体/字号：**每个格子**都要改，不只是当前格。
     ⚠️ 顺序不能省：先改 options → 清 WebGL 字形图集（旧图集按旧字体度量，
     不清会留下错位的字形）→ refit（单元格宽高变了，PTY 的列/行要重算）。
     漏掉 refit 的表现是"字变了，但换行位置还按旧字号算"。 */
  T.applyAppearance = () => {
    try {
      const th = termThemeNow();
      if (term.options.theme !== th) term.options.theme = th;
      term.options.minimumContrastRatio = termContrastNow();
      const stack = termFontStack();
      const size = SETTINGS.termFontSize;
      if (term.options.fontFamily !== stack) term.options.fontFamily = stack;
      if (term.options.fontSize !== size) term.options.fontSize = size;
      resetGlyphAtlas();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch (e) {
      jserr("applyAppearance", e);
    }
    refit();
  };
  /* ⚠️ 上面那三个空实现到此为止（refit / focus / ctrl 换成了真身）。但还有一件事
     要补：这个座位可能在真身装好之前就已经被认成了"当前格"（见文件开头 T.refit
     那三行下面的注释）—— 那一遍 setActive 是靠空实现撑过去的，`term`/尺寸/焦点
     三样都还没到位。
     ⚠️ 这里**只能回头调 setActive(T)**，不能把 setActive 那几行抄一遍：
     createTab 里有一个 `const term`（上面建终端那行）**遮蔽**了模块级那个
     `term`（"当前格的终端视图"），所以"把 term 接上"这件事在这个作用域里做不到 ——
     写 `term = T.term` 是往一个 const 赋值，抛 `TypeError: Assignment to constant
     variable`（2026-10-17 实测踩到，代价：整个 createTab 的 promise 被拒绝，
     这一格再也没连上 PTY）。所以交给外面那个作用域做，判据也已经放宽到
     "当前格但 term 还没接上"（见 setActive 开头）。 */
  /* 两种"半截"都要覆盖，所以是**两条**：
     ① setActive 的判据已放宽到"当前格但 term 还没接上"，它救的是"激活发生在
        `T.term = term` 之前（那个 rAF await 之后、2612 行之前）"这一种 ——
        那一次激活会把模块级 term 写成 undefined，只有再跑一遍 setActive 才对得上；
     ② 而 `T.term` 早就装好、只是 refit/focus 还落在空实现上的另一种，setActive
        会因为"term 已经一样"提前返回 —— 这两样就地补（重复调用无害：refit 本来
        就合并到一帧，focus 只是把焦点给它）。 */
  if (activeTab === T) { setActive(T); T.refit(); T.focus(); }
  // 网格重排已经在上面的 DOM 构造处做过了（renderGrid）——那里才是"格数变了"
  // 的那一刻，晚到这里做的话中间那几十行（挂 addon、fit）都在旧列数下量的。
  return T;
}

// --- 字体/渲染自检：静默回退是这类问题最难查的地方，直接摆出来 ---
// 而且不能写死名字 —— 上一版就把 "JetBrains Mono" 硬编码在这里，
// 后来字体栈改成 Cascadia 优先，标签还在说 JetBrains Mono，
// 等于自检工具自己撒谎。改成**按当前设置里字体栈的顺序逐个试**，
// 报第一个真正可用的，和 CSS 的解析规则一致。
const FONT_ORDER = {
  cascadia: [
    ["Cascadia Code WB", "Cascadia Code"],
    ["JetBrains Mono WB", "JetBrains Mono"],
    ["Consolas", "Consolas"],
  ],
  jetbrains: [
    ["JetBrains Mono WB", "JetBrains Mono"],
    ["Cascadia Code WB", "Cascadia Code"],
    ["Consolas", "Consolas"],
  ],
};
/* 设置页改了字体之后要重画这一格：它报的是**实际**可用字体，
   不是设置里选了哪个（两者在字体加载失败时会不一样 —— 那正是它存在的意义）。 */
function paintFontStatus() {
  const order = FONT_ORDER[SETTINGS.termFontFamily] || FONT_ORDER.cascadia;
  let usingFont = null;
  for (const [label, probe] of order) {
    if (document.fonts.check(`14px "${probe}"`)) { usingFont = label; break; }
  }
  $("s-font").textContent = usingFont ? usingFont : t("status.fontFallback");
  $("s-font").style.color = usingFont ? "" : "var(--red)";
  $("s-font").title = t("status.fontTitle");
  $("s-lig").textContent = (LigaturesAddon && usingFont) ? t("status.ligatures") : "";
}
paintFontStatus();
$("s-render").title = t("status.renderTitle");
// 从这里起，applySettings 可以安全地改所有已存在格子的外观了。
PERCH_TERM_READY = true;

// 渲染后端这一格**跟着激活标签走**：每个标签自己可能不是同一个后端
// （一个 WebGL 起来了一个没有），而状态栏只有一格。所以它是个函数，
// 切换标签、以及 WebGL 上下文丢失时都要重画一次。
function paintRenderStatus() {
  const tab = activeTab; // 不要叫 t：那会遮住 i18n 的 t()
  if (!tab) { $("s-render").textContent = ""; return; }
  $("s-render").textContent = tab.gfx.on ? "· WebGL" : t("status.renderDom");
}

// 并行格的读数（C4.5）—— 「N 格 · X 列/格」。
//
// 为什么这个数必须出现在界面上，而不是只躺在日志里：**"开得越多越小"这件事
// 用户看不见**。他能感觉到"怎么糊了/怎么老折行"，但不会有"是因为我开了 4 格、
// 每格只剩 40 列"这个因果。Orca 里不存在这个问题（它的分屏是手工的，切多小
// 是他自己拖的），我们自动成网格，就得把这个账**摆在明面上**。
//
// 65 是 Claude Code 开场介绍框的硬下限（见 PANE_MIN_COLS 那段注释），
// 低于它就开始折行重叠 —— 那不是"我们的渲染坏了"，是没给够地方画。
function paintGridStatus() {
  const el = $("s-grid");
  if (!el) return;
  /* C5：独立页视图下这一格报的是**那张页**（不是网格）。报的是它自己 term.cols
     —— 拎出去之后它拿到的是整块主区宽度，跟"每格多少"已经不是一回事了；
     这里继续按格报会给出一个屏幕上不存在的数（35 格列），那是撒谎。
     也**不能**把藏起来那几格的旧 cols 一起取 min：它们没在屏幕上。 */
  if (soloTab) {
    const c = soloTab.term && soloTab.term.cols > 0 ? soloTab.term.cols : 0;
    el.textContent = c > 0 ? t("term.grid.soloCols", { c }) : t("term.grid.solo");
    el.classList.toggle("warn", c > 0 && c < PANE_MIN_COLS);
    el.title = c > 0 && c < PANE_MIN_COLS
      ? t("term.grid.soloNarrow", { c, min: PANE_MIN_COLS })
      : tCount("term.grid.soloWide", wsTabs().length - 1);
    return;
  }
  const n = wsTabs().length;
  if (n <= 1) { el.textContent = ""; el.classList.remove("warn"); return; }
  // **只报实测**：每格 xterm 自己报的 cols。还没 fit 完的那些格子跳过。
  // C6a 之前这里有一个退回值（"主区总列数 ÷ 格数"），它读的是那句已被删掉的
  // 用户偏好。现在退回值是**没有**：一个都没量到时只报"N 格"，
  // 不拿一个算出来的数冒充量出来的数 —— 状态栏上这条读数的全部意义
  // 就是"屏幕上是多少"，不是"本来应该是多少"。
  const measured = wsTabs().map((t) => (t.term && t.term.cols > 0 ? t.term.cols : 0)).filter((c) => c > 0);
  if (!measured.length) {
    el.textContent = tCount("term.grid.panes", n);
    el.classList.remove("warn");
    return;
  }
  const perCell = Math.min(...measured);
  el.textContent = tCount("term.grid.perCell", n, { cols: perCell });
  el.classList.toggle("warn", perCell < PANE_MIN_COLS);
  el.title = perCell < PANE_MIN_COLS
    ? t("term.grid.narrow", { cols: perCell, min: PANE_MIN_COLS })
    : tCount("term.grid.wide", n, { cols: perCell });
}

// 连接状态那一格同理 —— 每个标签一条 stream，各自可能连上/断开。
function paintConnStatus(up) {
  $("s-dot").className = up ? "dot on" : "dot off";
  $("s-st").textContent = up ? t("status.connected") : t("status.disconnected");
  // C7：「原生对比」那颗（#wt）删了，所以这里不再有"断连就禁用它"这件事 ——
  // 它原来守的是"没有活标签时别点"，见 HTML 标签条右侧那段注释的去向记录。
}

// --- 快照：serialize 让回滚缓冲能跨进程重启活下来。手动触发，不偷偷恢复 ---
const SNAP = "perch.scrollback.v1";
$("restore").addEventListener("click", () => {
  const s = localStorage.getItem(SNAP);
  if (!s) {
    // 页面里没有控制台可看，而且它现在是个只有图标的浮出按钮 ——
    // "无快照"这件事走日志通道留痕，界面上用 title 临时说一句。
    sendCtrl({ type: "log", msg: "restore: 无快照" });
    $("restore").title = t("term.restore.noSnap");
    setTimeout(() => { $("restore").title = t("term.restore.title"); }, 2000);
    return;
  }
  const tab = activeTab;
  if (!tab) return;
  tab.term.write("\r\n\x1b[90m" + t("term.restore.done") + "\x1b[0m\r\n");
  tab.term.write(s, () => tab.term.scrollToBottom());
});
setInterval(() => {
  // 快照是**页面级**的一份：一个 localStorage 键放不下 N 个标签的回滚缓冲。
  // 存的是当前激活标签的（C1 的取舍，页面级快照按钮同理 —— 见计划书）。
  const t = activeTab;
  if (!t || !t.serialize) return;
  try { localStorage.setItem(SNAP, t.serialize.serialize({ scrollback: 400 })); } catch (e) {}
}, 5000);


// 终端标题走的是 OSC 转义序列（`ESC ] 0 ; <标题> BEL`）—— 真终端里
// "窗口标题"就是程序自己报的。Claude Code 会用它报告当前在干什么。
// 接上它，pane 头部和标签条就不再是我们硬编码的死字符串，
// 而是 agent 实时报上来的状态 —— 这正是"像真终端"的一部分。
//
// 但原始标题**不能直接用**：agent 会在标题前面顶一个状态符号
// （Claude 的 `✳`、Gemini 的 `✦⏲◇✋`、Qoder 的 `▲`、转圈的盲文/四分之一圆）。
// 标签条上已经有 agent 图标了，前缀符号就成了多余的第二个图标，所以显示前剥掉。
//
// ⚠️ 这串正则**必须逐字用 Orca 的**（shared/agent-title-decoration.ts:6-8）。
// 上一版是"看着差不多"手抄的，抄错了三处：把 `⏲`(U+23F2) 抄成了 `Ⲳ`(U+2CB2, Coptic)、
// 漏了 Qoder 的 `▲`、注释还把 `✳` 说成"正在干活"（**正好反了，✳ 是 idle**）。
// 手抄的字符类肉眼几乎看不出差别，但漏一个码位就是"某个 agent 的标题永远剥不掉"。
const LEADING_AGENT_TITLE_DECORATION_RE =
  /^(?:[✳✦⏲◇✋▲⠀-⣿◐-◓]+|[.*]\s)\s*/;

function stripLeadingAgentTitleDecorationOrEmpty(title) {
  return (title || "").replace(LEADING_AGENT_TITLE_DECORATION_RE, "").trimStart();
}
function stripLeadingAgentTitleDecoration(title) {
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(title);
  // Why: 绝不返回空串 —— 整个标题只有一个状态符号时保留原文，
  // 免得标签变成一个空白标签。（Orca 原文注释，语义照搬。）
  return stripped.length > 0 ? stripped : title;
}

// ⚠️ 判定状态要用**原始标题**，显示才用剥过的 —— 见 Orca
// main/runtime/terminal/output/terminal-title-observation.ts:79：状态从 raw 标题判，
// 因为"在不在干活"这件事的全部证据就是那个前缀符号本身。剥完再判就永远判不出来。
//
// ⚠️ **原始标题和"这个 chunk 里有没有标题"都是标签自己的状态**（T.agentTitleRaw /
// 标签内的 titleInThisChunk），不再是模块级变量 —— 两个会话各自在干活/空闲，
// 共享一份就会互相顶掉（A 的标题把 B 的状态判据覆盖掉）。

// ===========================================================================
// 会话命名（标签内联重命名）
//
// 三个来源**逐条搬**，不是"照着感觉写一个输入框"——里面每一条都是它踩过的坑：
//
//   1. components/tab-bar/use-sortable-tab-rename.ts —— 打开 / 提交 / 取消。
//      两条最容易漏的：打开时**快照**当前标题（编辑期间 agent 还在改 OSC 标题，
//      草稿不能被它顶掉）、以及"只提交一次"的闸（blur 在输入框卸载时也会触发，
//      不设闸就会把**已经取消的**编辑又重新提交上去）。
//   2. components/terminal-pane/use-terminal-pane-context-actions.ts:53-112 ——
//      提交语义（trim；空 = 删掉名字）和失焦的三态：**只有"用户自己要的失焦"
//      才提交**（点到输入框外面、或按 Tab），其余失焦一律把焦点抢回来。
//   3. lib/ime-composition-keyboard-event.ts —— 中文输入法守卫。
//      中日韩输入法在**确认候选词**时也会发一个 Enter，那个 Enter 不是提交，
//      否则会在半截候选词上提交。
//
// 与 Orca 的**一处有意差异**：Orca 的名字挂在标签（customTitle）和面板
// （paneTitles）这类**内存态**上、随工作区走；我们的名字主语是**会话**，
// 由后端按 pid→sessionId 落盘到 titles.json（理由见 Go 侧的 titles.go）。
// ===========================================================================
/* 没有标题时的默认名：**这个 agent 的产品名**。
   ⚠️ 2026-10-17 之前这里是写死的 `"claude · ai工作台"`（开发占位符）——
   Codex 启动失败、还没来得及发 OSC 标题，格子头就顶着 Claude 的名字，
   用户看到的是"Codex 的图标 + Claude 的字"。默认名只能由 spec.agent 推。 */
function defaultTabTitle(tab) {
  const id = (tab && tab.spec && tab.spec.agent) || "";
  const cat = (typeof CATALOG !== "undefined" && Array.isArray(CATALOG)) ? CATALOG : [];
  const a = cat.find((x) => x.id === id);
  if (a && a.name) return a.name;
  return id || t("term.defaultTitle");
}

// 用户给会话起的名字（`T.liveTitle`，空 = 用 agent 自己写的）**挂在标签上**，
// 因为它必须跟着会话走：切到另一个标签再切回来，名字不能丢、也不能串。
//
// 下面这一组 rename* 变量仍然是模块级的 —— 它们描述的是"现在有一个编辑框
// 开着"这个**单例**事实（同一时刻只可能编辑一个标签），不需要每个标签一份。
// renameTab 记的就是"正在编辑谁"。
let renameTab = null;
let tabEditing = false;
let renameValue = "";
let renameInputEl = null;
let renameRefocusFrame = null;
/* 编辑框的**第二个主语**：左栏（右栏子代理卡）里的一条会话。
   它是一个 sessionId，不是"哪个 DOM 元素" —— 元素在提交之前可能已经被重画掉了，
   而名字该落到会话上，不该落到某个节点上。
   ⚠️ 不写第二份状态机：下面那三条闸（提交一次 / 失焦三态 / IME 守卫）每一条都是
   实测出来的坑，抄一份就是等它们分叉（这个文件里"两份实现迟早会分叉"那句）。
   这里只多这一个变量，`tabEditing` 仍是"有一个编辑框开着"的唯一判据。 */
let renameSess = null;
// 三个闸，语义见上面 (1)(2)：
let renameSubmitted = false;         // Orca renameSubmittedRef
let renameBlurCommitEnabled = false; // Orca renameBlurCommitEnabledRef
let renameUserWantsBlur = false;     // Orca renameUserRequestedBlurCommitRef
let renameSeq = 0;                   // Orca renameSessionIdRef：作废上一轮遗留的延迟帧

// Orca isImeOwnedKeyboardEvent（ime-composition-keyboard-event.ts:11-20）：
// isComposing 覆盖大多数浏览器，keyCode 229 是给"不移交 isComposing"的输入法兜底。
function isImeOwnedKey(e) {
  return e.isComposing === true || e.keyCode === 229 ||
         (e.nativeEvent && (e.nativeEvent.isComposing === true || e.nativeEvent.keyCode === 229));
}

/* 「这一格**有**一个真标题吗」—— 用户起的名字 > agent 自己发的 OSC 标题，
   都没有 = 空串。和 runtimeTabTitle 是同一份优先级的两截：那个在末尾补产品名兜底，
   而这句判断**不能**用它的返回值（它永远非空）。
   群组那份列表要的就是这句：标题为空时退化成状态词，而不是写一遍产品名 ——
   这个网关里跑的不一定是 Claude Code（以后还有别的 agent），拿产品名兜底就是假话。 */
/* Codex 启动时把自己的 OSC 标题设成 codex.exe 的**完整路径**（Windows Terminal
   里也这样）。那是窗口标题，不是这个 agent 的名字 —— 直接拿来显示，格子头和
   左栏就变成一长串 `C:\Users\...\codex.exe`，产品名反而轮不到。
   只认"盘符/UNC 开头、以 .exe 结尾"这一种形状，别把普通的路径标题一起吃掉。 */
function isExePathTitle(s) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*\.exe$/i.test((s || "").trim());
}
/* 还有一些 launch-only CLI 会把 OSC 标题设成**当前 shell 的名字**：
   dsh 实测在启动后发 `Windows PowerShell`。那不是这一格的身份，拿来当标签名，
   左栏和格子头就变成 "Windows PowerShell"，agent 的产品名反而轮不到。
   只挡这几种固定的 shell 标题；真正的任务标题、路径不挡（上一段那个 exe
   路径例外仍是单独一条，别合并成宽泛的"看起来像路径就丢"）。 */
function isGenericShellTitle(s) {
  const v = (s || "").trim().toLowerCase();
  return /^(administrator:\s*)?(windows powershell|command prompt|powershell|pwsh|cmd|cmd\.exe|conhost|terminal)$/.test(v);
}
/* DSH-TUI 的 OSC 标题是 `<状态符> 🐋 <会话名>`（Orca dsh-terminal-title.ts）。
   鲸鱼是唯一不会被别的 agent 发出的字符 —— DSH 的 idle 符 ✦ 正好是 Gemini
   的 working 符，所以要先认鲸鱼，再认状态符。
   ⚠️ 状态判定用**原始标题**，这里只负责显示：把状态符和鲸鱼剥掉，留下会话名。
   只剩一个鲸鱼时返回空串，交给 defaultTabTitle 显示产品名。 */
const DSH_WHALE = "\u{1F40B}";
function isDshTitle(s) { return (s || "").includes(DSH_WHALE); }
function stripDshTitleWhale(s) {
  return (s || "").replace(/^[\s\u{1F40B}]+/u, "").trim();
}
function realTabTitle(t) {
  if (t.liveTitle) return t.liveTitle;   // 用户起的名字永远压过 agent 报的
  let v = stripLeadingAgentTitleDecoration(t.agentTitleRaw);
  if (isDshTitle(v)) return stripDshTitleWhale(v);
  return (isExePathTitle(v) || isGenericShellTitle(v)) ? "" : v;
}
function runtimeTabTitle(t) {
  return realTabTitle(t) || defaultTabTitle(t);
}
// Orca SortableTab.tsx:189 的 `tabTitle = tab.customTitle ?? tab.title`：
// 用户起的名字压过 agent 自己写的。
function currentTabTitle(t) { return t.liveTitle || runtimeTabTitle(t); }

// **标签标题的唯一渲染点。** 以前 OSC 处理器和"3 秒静默"那个兜底各写一遍
// #tab-nm，两处都不认识用户起的名字 —— 于是重命名之后只要 agent 再发一次标题
// 就会被顶掉。现在两边都走这里，优先级只有一处。
//
// 参数是**标签对象**而不是"当前标签"：OSC 标题来自后台标签时，改的必须是
// 它自己那一格，不能借着 activeTab 写到别人的标签上。
function renderTabTitle(t) {
  if (!t) return;
  // 编辑中标签里是输入框，别去动它。⚠️ 只挡**正在编辑的那一个**：别的标签
  // 报了新标题照样要渲染 —— 写成 `if (tabEditing) return` 的话，A 开着编辑框时
  // B 拿到的标题就永远不显示，看起来像"后台会话没反应"。
  //
  // ⚠️ C5 起这个名字有**两个落点**（格子头 + 独立页的那张页），两个都要写：
  // 同一个 agent 在同一屏上说的是两句话，是用户已经否过一次的事。
  // 编辑期间整段不动（格子头里是输入框，草稿在 renameValue 里）—— 页上保留
  // 上一次定的名字，提交时这一句会再跑一次、两边一起更新。**故意不显示草稿**：
  // 草稿可能被 Esc 丢掉，而"页上跟着跳"会让人以为已经改成了。
  if (tabEditing && t === renameTab) return;
  const nm = currentTabTitle(t);
  // 悬停提示也只给"真的标题"：dsh 会发 Windows PowerShell，那不是身份，
  // 让它从 tooltip 里也消失；没有真标题就不挂提示，别拿兜底名冒充。
  const tip = t.liveTitle || realTabTitle(t) || "";
  t.nmEl.textContent = nm;
  t.nmEl.title = tip;
  if (t.pageNmEl) { t.pageNmEl.textContent = nm; t.pageNmEl.title = tip; }
}

/* 把「名字是**会话**的属性」这句兑现到格子头上（名字表 → 标签）。
   `t.liveTitle` 只是 `STATE.titles` 在某个标签上的那份拷贝，而在这之前这份拷贝
   **只在这一进程里改过名**才被写（commitRename 的会话那条路，见上面那一段）——
   于是重开一次，左栏写着「哈哈哈哈」、格子头还是 agent 自己写的「Ok」：
   同一件东西说了两句话，正是这个文件反复在防的病。
   ⚠️ 两个时刻都要播种：**会话身份到达**（hook 绑上那一格）和**名字表到达**
   （payload 推来 titles.json）—— 谁后到都得对得上，只补一处就还有一半的窗口。
   空名字要照写（`liveTitle = ""` = 回到 agent 自己写的标题），所以是赋值不是跳过。 */
function seedTabTitles() {
  const table = (STATE && STATE.titles) || {};
  const bound = TAB_LIST.filter((t) => t.sessionID);
  let hit = 0;
  for (const t of bound) {
    const nm = table[t.sessionID] || "";
    if (nm) hit++;
    if (t.liveTitle !== nm) { t.liveTitle = nm; renderTabTitle(t); }
  }
  // 播种属于"界面上说不清为什么长这样"的那一类，所以三个数必须落进日志：
  // 几格有身份 / 名字表几条 / 命中几个。下次"左栏改了名、格子头没跟"一眼看得出断在哪一步
  // —— 顺带把两边的 key 长度也报出来（8 位截断的 id 对上全量 UUID 是这类错配的常见形状）。
  const k = Object.keys(table);
  sendCtrl({ type: "log", msg: `名字播种：有身份的格 ${bound.length}、名字表 ${k.length} 条、命中 ${hit}` +
    ((bound.length || k.length) ? `（格 id 长 ${bound.length ? String(bound[0].sessionID).length : "-"}，表 key 长 ${k.length ? k[0].length : "-"}）` : "") });
}

/* 把输入框挂到**某个标题元素**上，并接好那几个闸 —— 主语无关的一段。
   参数只有一个"要被换掉的那个 span"和初值；谁在被编辑由外面的 renameTab /
   renameSess 记着，那两件事决定提交时名字落到哪里。 */
function mountRenameInput(el, initial, ariaLabel) {
  /* ⚠️ **元素不在文档里就别挂**。`replaceWith` 到一个已经不在文档里的节点上，
     换出来的输入框也**不在文档里** —— 于是：focus() 是空操作（用户看不见它、
     打进去的字哪儿都不去）、`document.activeElement` 永远不是它（第二帧那道闸
     永远不开 ⇒ 点别处也永远不提交），而 tabEditing 会停在 true 上把**之后每一
     次**改名都在 `if (tabEditing) return` 上吃掉 —— 要刷新页面才能再改名。
     2026-10-17 实测：这一步是"第二次重命名没反应"的全部原因（提交自己触发的那次
     列表重画就够引爆它，见 liveNmEl）。所以宁可当场说"没开成"，让调用方把状态退
     回去 —— 返回值就是"到底开没开"。 */
  if (!el || !el.isConnected) {
    sendCtrl({ type: "log", msg: `重命名 没挂上：${el ? "目标标题元素已不在文档里（列表刚重画过）" : "找不到标题元素"} —— 编辑状态没进` });
    return false;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-input";
  input.placeholder = t("term.rename.placeholder");
  input.setAttribute("aria-label", ariaLabel);
  input.value = initial;
  input.addEventListener("input", () => { renameValue = input.value; });
  input.addEventListener("keydown", (e) => {
    // ⚠️ 必须放在最前面：中文输入法确认候选词的那个 Enter 不是"提交"。
    if (isImeOwnedKey(e)) return;
    if (e.key === "Enter") { e.preventDefault(); commitRename(); }
    // Tab 也提交。Orca 的注释：别指望浏览器把焦点移开触发 blur ——
    // 无窗口焦点的环境（xvfb / 某些 SSH）里焦点不一定会移开，那样就永远提交不了。
    else if (e.key === "Tab") { e.preventDefault(); commitRename(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  });
  input.addEventListener("blur", onRenameBlur);
  // 输入框里的按下不能被标签/标题栏的拖拽接手（Orca 在编辑期间会摘掉 drag 监听）。
  // 这一句对左栏同样必要：行的 click 是"接上/切主语"，按键的那一下不该被它吃掉。
  input.addEventListener("mousedown", (e) => e.stopPropagation());
  // 左栏那条路还要挡 click：行是 role="button"，不挡的话点输入框就会顺手把
  // 这一行当成"点了这条会话"（切右栏主语）。标签那条路没有这个需求（标签的 click
  // 在冒泡段，本来就被下面那句 stopPropagation 挡着）。
  input.addEventListener("click", (e) => e.stopPropagation());

  el.replaceWith(input);
  renameInputEl = input;
  // 「开成了」这条**只有在这里**才成立（挂上 + 还在文档里）。上面 doCardAct 那句
  // 「点了菜单项」只是"用户点了"，不是"编辑器开了" —— 两者不许混着看。
  sendCtrl({ type: "log", msg: `重命名 输入框挂上了（${ariaLabel}）在文档里=${input.isConnected}` });
  // 下一帧再 focus+select：这一帧标签条刚重排完，立刻 focus 会被布局抖动吃掉。
  const seq = renameSeq;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
    // ⚠️ **第二帧**，Orca 的 use-terminal-pane-context-actions.ts:136-146：
    // 只有"输入框确实拿到了焦点"才打开失焦提交的闸（document.activeElement===input）。
    // 我第一版漏了这一帧 —— 后果很具体：闸永远不开，用户紧接着点到别处时那次 blur
    // 会被当成"意外失焦"，于是焦点被抢回来、**永远提交不了**。
    // 实测就是卡在这里（日志里只有 focus out/in 没有 rename）。
    requestAnimationFrame(() => {
      if (renameSeq !== seq || !tabEditing) return;
      if (document.activeElement === renameInputEl) { renameBlurCommitEnabled = true; return; }
      /* 焦点没落上也要留一句：这条闸不开的时候，用户看到的是"点了别处没反应"，
         而画面上没有任何东西能说明为什么（输入框可能压根不在文档里 —— 那种情况
         上面那道 isConnected 已经拦掉了，这里是漏网的情形）。 */
      const a = document.activeElement;
      sendCtrl({ type: "log", msg: `重命名 输入框在文档里=${input.isConnected} 但没拿到焦点` +
        `（现在在 ${a ? a.tagName + (a.className ? "." + String(a.className).split(" ")[0] : "") : "null"}）—— 失焦提交的那道闸不开` });
    });
  });
  return true;
}

function openRename(tab) {
  if (tabEditing || !tab) return;
  renameTab = tab;
  renameSess = null;
  renameSeq++;
  renameSubmitted = false;
  // 开编辑这一帧**不许**失焦提交：标签刚重排完、焦点还在抖，
  // 这一下 blur 不是用户的意思（Orca 的 renameBlurCommitEnabledRef）。
  renameBlurCommitEnabled = false;
  renameUserWantsBlur = false;
  renameValue = tab.liveTitle;   // 快照，编辑期间 OSC 的标题变化不许覆盖草稿
  tabEditing = true;
  // 挂不上（比如这一格刚被关掉，格子头的元素已经摘下来了）⇒ 这一次编辑**没开始**，
  // 把状态整个退回去 —— 留在"看起来在编辑"的空上就会变成幽灵编辑器，
  // 理由见 mountRenameInput 开头那段。
  if (!mountRenameInput(tab.nmEl, renameValue, t("term.rename.ariaTab"))) closeRename();
}

/* 「这条会话**现在**在界面上是哪一行的标题元素」。
   ⚠️ 必须在说的那一刻去文档里找，不能只用"开菜单时攥下来的那一份"：
   `renderLists()` 是**整表 innerHTML 重画**，菜单开着的那一两秒里只要发生过一次
   重画（会话库刷新、名字表被 Go 纠正、**以及这次改名自己提交时触发的那次**），
   开菜单时记下的那个元素就成了一具尸体。往尸体的 `.nm` 里挂输入框 = 挂出一个
   不在文档里的输入框：focus() 空转、点别处永远不提交、tabEditing 卡在 true 上
   —— 2026-10-17 实测就是这么把"第二次改名"变成"点了没反应"的。
   优先用调用方手里那个（它一定就是用户点的那一行），但**只在它还活着的时候**；
   活不了才按 id 在文档里重新找一个（两种行都认：左栏的 `.arow`、右栏的 `.card`）。 */
function liveNmEl(id, prefer) {
  if (prefer && prefer.isConnected) return prefer;
  /* 两个落点：右栏的子代理卡（`.card[data-id]`）和左栏的 **agent 行**
     （`.arow[data-sid]` —— 2026-10-17 起左栏不再有会话行；agent 行的身份是
     tab，挂在行上的是会话 id，见 agentRowHTML）。 */
  const rows = document.querySelectorAll(
    `.card[data-id="${CSS.escape(id)}"], .arow[data-sid="${CSS.escape(id)}"]`);
  for (const row of rows) {
    const nm = row.querySelector(".nm");
    if (nm && nm.isConnected) return nm;
  }
  return null;
}

/* 左栏（以及右栏子代理卡）里的一条会话改名 —— 同一个编辑框的**第二个主语**。

   和标签那条路只有三处不同，其余（三条闸、第二帧开闸、IME 守卫）全部共用：
     ① 草稿的快照取的是"用户给它起过的名字"，没起过就是空的（输入框里是占位符）。
        **不复述 agent 自己写的标题**：那样"我想给它起个名"会变成"我得先把别人的
        字删掉"，而起名的意思本来就是"压过 agent 那个标题"（见 currentTabTitle）。
     ② 被换掉的是这一行的标题元素：会话行是 `.nm`，卡片是 `.t` 里的那个 `.nm`。
     ③ 提交落到 titles.json，**直接带 sessionId**（不用像标签那样反查 pid，
        见 Go 的 title.set）。
   ⚠️ 不复用 `openRename(t)`：那个的主语必须是标签对象（它要 t.nmEl / t.liveTitle /
   t.ctrl 三样），这里一个都没有 —— 硬套就得往标签对象上挂假字段。 */
function openSessionRename(s, el) {
  if (tabEditing || !s || !el) return;
  renameTab = null;
  renameSess = s.id;
  renameSeq++;
  renameSubmitted = false;
  renameBlurCommitEnabled = false;   // 同上：开编辑这一帧的 blur 不是用户的意思
  renameUserWantsBlur = false;
  renameValue = (STATE && STATE.titles && STATE.titles[s.id]) || "";
  tabEditing = true;
  // 同上：挂不上就把状态退回去，别留一个"看不见、却在吃掉后面每一次改名"的空。
  if (!mountRenameInput(el, renameValue, t("term.rename.ariaRow"))) closeRename();
}

function closeRename() {
  renameSeq++;
  renameBlurCommitEnabled = true;   // Orca closeRenameSession()：复位，别把禁用态留给下一次
  renameUserWantsBlur = false;
  tabEditing = false;
  const t = renameTab;
  const sid = renameSess;
  const input = renameInputEl;
  renameInputEl = null;
  renameTab = null;
  renameSess = null;
  if (input && input.parentNode) {
    // 用一个**新的** span 换回输入框（输入框是 replaceWith 上去的，没得还原）。
    // 不给它 id —— 现在每个标签自己一格，id 只会有一个"主人"，找不到才是对的；
    // 元素重新挂进标签对象（t.nmEl），renderTabTitle 走的永远是标签对象。
    const nm = document.createElement("span");
    nm.className = "nm ell";
    input.replaceWith(nm);
    if (t) t.nmEl = nm;
  }
  if (t) { renderTabTitle(t); return; }
  /* 会话行/卡片那条：**整表重画一次**。那一行的标题、时间、状态点都在同一次
     重画里对齐，而名字从 STATE.titles 读（提交时已经写进去了，见 commitRename）。
     ⚠️ 这一句必须在 `renameSess = null` **之后**：renderLists 顶上那条闸
     （改名期间不重画列表）认的就是它，没清就等于调用了一次什么都不做的重画。 */
  if (sid) renderLists(searchKey());
}

function commitRename() {
  // 提交一次的闸（Orca use-sortable-tab-rename.ts:25,34-42）。blur 会在输入框
  // 卸载时也触发一次 —— 没有这个闸，Escape 取消之后那次 blur 会把编辑**又提交上去**。
  if (!tabEditing || renameSubmitted) return;
  renameSubmitted = true;
  const t = renameTab;
  const sid = renameSess;
  if (!t && !sid) { closeRename(); return; }
  /* ⚠️ 兜底：手里这个输入框已经**不在文档里**了 ⇒ renameValue 是一份幽灵草稿
     （用户看不见它也改不了它，见 mountRenameInput 开头那段）。这时候提交等于
     凭空改一个名字 —— 直接收掉编辑、一个字都不写。
     这是幽灵编辑器的最后一层保险：真出现了，用户点一下别处就能脱身，
     不至于卡到"只有刷新页面才能再改名"。 */
  if (renameInputEl && !renameInputEl.isConnected) {
    sendCtrl({ type: "log", msg: `重命名 放弃提交：输入框已不在文档里（草稿=${JSON.stringify(renameValue)}）—— 编辑状态收掉，名字不动` });
    closeRename();
    return;
  }
  const trimmed = renameValue.trim();

  // ---- 主语是**会话**（左栏/卡片那条路）----
  if (sid) {
    const had = !!(STATE && STATE.titles && STATE.titles[sid]);
    // 清空 = 删掉名字，回到 agent 自己写的标题。本来就没名字就什么都不做 ——
    // 和标签那条 `if (!t.liveTitle)` 是同一个判断，两条路的语义必须一样，
    // 否则"在左栏清掉"和"在标签上清掉"会得到两个不同的结果。
    if (!trimmed && !had) { closeRename(); return; }
    // 先在本地落定，再落盘：列表重画是从 STATE.titles 读的（closeRename 里那句），
    // 所以状态必须先写。
    if (trimmed) {
      STATE.titles = STATE.titles || {};
      STATE.titles[sid] = trimmed;
    } else if (STATE.titles) {
      delete STATE.titles[sid];
    }
    /* 这条会话正跑在某一格里时，格子头的名字也要跟着改 —— "左栏改了、格子上
       还是旧名"是同一件东西说了两句话（这个文件反复在防的病）。
       ⚠️ 2026-10-17：**停了的那一格也要改**。`tabForSession` 对 connDown 一票
       否决（那是给"接上"判据用的，见它那段注释）—— 拿它当改名的判据，继电
       停了的 agent 之后就只剩旧名（左栏从 `t.liveTitle` 读，而那份没改）。
       所以再按 sessionID 直接找一遍，含停掉的格。 */
    const tab = tabForSession(sid)
      || TAB_LIST.find((x) => x.id > 0 && x.sessionID === sid) || null;
    if (tab) { tab.liveTitle = trimmed; renderTabTitle(tab); }
    closeRename();
    // 落盘走 ctl（这条路上手里就是 sessionId，不用像标签那样让后端反查 pid）。
    // 写盘失败由 Go 那边把**权威的那份表**推回来纠正这里（见 main.go 的 title.set）——
    // 所以这里可以放心先乐观更新。
    sendCtrl({ type: "title.set", id: sid, name: trimmed });
    sendCtrl({ type: "log", msg: `rename(左栏)：会话 ${sid.slice(0, 8)} → ${JSON.stringify(trimmed)}（空 = 回到 agent 自己写的标题）` });
    return;
  }

  // ---- 主语是**标签**（原路，一个字没动）----
  if (!trimmed) {
    // 清空 = 删掉名字，回到 agent 自己写的标题（Orca 的 onSetCustomTitle(…, null)）。
    if (!t.liveTitle) { closeRename(); return; }
    t.liveTitle = "";
  } else {
    t.liveTitle = trimmed;
  }
  closeRename();
  // 落盘：名字的主语是会话，后端按 pid→sessionId 反查（见 titles.go）。
  // 发到**这个标签自己的**字节流上 —— 后端要靠这条流上的 pty 查出 pid，
  // 发到 ctl 通道它就不知道说的是哪个会话了。
  t.ctrl({ type: "rename", msg: t.liveTitle });
  t.ctrl({ type: "log", msg: `rename: 会话名=${JSON.stringify(t.liveTitle)}（空 = 回到 agent 自己写的标题）` });
}

function cancelRename() {
  // 取消也占住这个闸：否则紧随其后的那次 blur 会把取消了的编辑提交上去。
  renameSubmitted = true;
  closeRename();
}

function onRenameBlur() {
  if (renameSubmitted) return;
  /* 只有"用户自己要求的失焦"才提交（点到输入框外面，或按了 Tab）——
     判据是 `renameUserWantsBlur`，它由 document 捕获段的 pointerdown/keydown 置上，
     是**正面证据**。
     ⚠️ 第二帧那道闸（renameBlurCommitEnabled）**不再参与判定**了（2026-10-17 改）。
     它本来的用途是挡"挂载那一瞬间被布局抖动抢走焦点"那一下 —— 而那个时候
     不可能有"落在输入框外面的 pointerdown"（开编辑的这一下 pointerdown 发生在
     输入框还不存在的时候，那时 tabEditing 还是 false，压根不置这个标记）。
     把它当必要条件就多出一条死路：闸因为任何原因没开（焦点没落上、输入框挂在
     了一个不在文档里的节点上），用户点别处不但不提交，还会被下面那条"抢回焦点"
     吃掉 —— 编辑器既不提交也不结束，接着吞掉用户后面打的每一个字。 */
  if (renameUserWantsBlur) { commitRename(); return; }
  if (!tabEditing || renameRefocusFrame !== null) return;
  // 其余失焦（被程序抢走、窗口切换）一律把焦点**抢回来**：用户没打算结束编辑，
  // 就不该结束（Orca 原逻辑，见上面 (2) 与 :84-112）。
  const seq = renameSeq;
  renameRefocusFrame = requestAnimationFrame(() => {
    renameRefocusFrame = null;
    if (renameSeq !== seq || !tabEditing) return;
    const input = renameInputEl;
    if (input) { input.focus(); input.select(); }
    renameBlurCommitEnabled = true;   // 抢回来之后，下一次失焦才算数
  });
}

// Orca use-terminal-pane-title-effects.ts:231-255 —— 编辑期间在 document 上
// **捕获**监听，标记"这次失焦是用户自己要的"：
//   pointerdown 落在输入框外面 → 是（他要去点别的东西了）
//   keydown Tab               → 是
document.addEventListener("pointerdown", (e) => {
  if (!tabEditing) return;
  const input = renameInputEl;
  if (input && e.target instanceof Node && input.contains(e.target)) return;
  renameUserWantsBlur = true;
}, true);
document.addEventListener("keydown", (e) => {
  if (tabEditing && e.key === "Tab") renameUserWantsBlur = true;
}, true);

// 入口 = **双击格子头**。这是 Orca 的真实入口，不是我们发明的：
//   components/tab-bar/SortableTab.tsx:204-210  onDoubleClick → handleRenameOpen()
// Orca 在"还没有标题"时也进得来（那时它没有面板栏，入口就只剩这里和右键菜单）。
// 标签栏整体双击 = 最大化窗口，所以 .tab 本来就被排除在那条规则之外（见下面）。
//
// ⚠️ 用**委托**而不是逐个 .cellhead 挂监听：格子是运行期增删的，逐个挂就得在
// 每个建/关格子的地方记得挂一次/摘一次 —— 那正是"新格子双击重命名没反应"
// 这类 bug 的温床。挂在容器上，格子怎么来都算数。
//
// C4 起这个容器从 #tablist 换成 #termbody：格子头现在长在网格里。
// 元素仍然靠 `.tab` 这个类来找（格子头就是标签的 .tab 元素本体）。
$("termbody").addEventListener("dblclick", (e) => {
  if (e.target.closest(".x")) return;   // 双击关闭按钮不是重命名
  const el = e.target.closest(".tab");
  if (!el) return;
  const t = TAB_LIST.find((x) => x.tabEl === el);
  if (!t) return;
  e.stopPropagation();
  openRename(t);
});

// ===========================================================================
// Agent 状态点 —— 状态从**标题的字形**推出来
//
// ⚠️ 这里曾经计划写成「OSC 133 → 四态点」，**那个前提是错的**。Orca 不走
// OSC 133 的 A/B/C/D：OSC 133 它只用 `;C`（命令开始）/ `;D`（命令结束+退出码），
// 喂的是"前台进程变了"这类事实（shared/terminal-output-side-effects.ts:118-125）。
// **状态本身来自 OSC 0/1/2 标题的前缀字形**：
//   shared/agent-title-status.ts:195-291  detectAgentStatusFromTitle()
//   js 侧判据只有两条（agent-title-status.ts:245 与 :257）：
//     - 标题以 `✳ `（CLAUDE_IDLE，U+2733）开头 → idle
//     - 标题里含转圈字形（盲文 U+2800–28FF 或四分之一圆 U+25D0–25D3）→ working
// Claude Code 干活时会把标题的转圈字形换帧，所以这两条就够。
// Orca 那 10 个 agent 的名字/关键字阶梯（Gemini/Pi/Qoder/Droid/Hermes…）我们不搬 ——
// 我们只跑 Claude，抄进来只会引入判不准的分支。
//
// 我们**已经在收** OSC 标题（上面的 onTitleChange），所以这一项不需要 shell
// integration，比原计划便宜一大截。
const CLAUDE_IDLE = "✳";                                   // ✳
const BRAILLE_SPINNER_RE = /[⠀-⣿]/g;                  // 换行用，非 test
const QUARTER_CIRCLE_SPINNER_RE = /[◐-◓]/g;
// 用手写字符扫描而不是正则 .test()：带 /g 的正则有 lastIndex 状态，
// 在 .test() 里复用会隔一次真隔一次假。Orca 也是这么分的（agent-title-glyphs.ts）。
function containsBrailleSpinner(t) {
  for (const ch of t || "") {
    const c = ch.codePointAt(0);
    if (c >= 0x2800 && c <= 0x28ff) return true;
  }
  return false;
}
function containsQuarterCircleSpinner(t) {
  for (const ch of t || "") {
    const c = ch.codePointAt(0);
    if (c >= 0x25d0 && c <= 0x25d3) return true;
  }
  return false;
}
function containsAgentSpinnerGlyph(t) {
  return containsBrailleSpinner(t) || containsQuarterCircleSpinner(t);
}
function detectAgentStatusFromTitle(title) {
  if (!title) return null;
  /* DSH 必须**先于**通用字形判断：它的 idle 前缀 ✦ 正好是 Gemini 的 working
     符，而 working 帧是 Claude 通用的 braille（⠂/⠐）。认鲸鱼之后：
       ✦ 🐋 …      → idle
       ⠂/⠐ 🐋 …   → working
     其它不带鲸鱼的标题不归 DSH 管。
     ⚠️ Orca 的 resting 返回 null（它的 hook 状态优先于标题）；Perch 的
     cellState 把“标题 working”和“hook busy”取或，所以必须给出 idle，才能把
     上一轮留下的 braille working 熄灭 —— 否则一轮结束、标题回到 ✦ 之后，
     格子还会一直转圈。 */
  if (isDshTitle(title)) {
    if (title.trimStart().startsWith("✦")) return "idle";
    if (containsAgentSpinnerGlyph(title)) return "working";
    return null;
  }
  // 顺序照 Orca：idle 那一支在 working 前面（agent-title-status.ts:245 vs :257）。
  if (title.startsWith(CLAUDE_IDLE + " ") || title === CLAUDE_IDLE) return "idle";
  if (containsAgentSpinnerGlyph(title)) return "working";
  return null;   // 既没 idle 符也没转圈符 → 判断不了，别硬塞一个状态
}

// Orca terminal-output-side-effects.ts:29
const STALE_WORKING_TITLE_TIMEOUT_MS = 3000;

// 状态本身（agentState / connDown / staleTitleTimer）**是每个标签一份**：
//   T.agentState   'working' | 'idle' | null（还不知道 / 判不出来）
//   T.connDown     这条 stream 断了 —— Orca 没这个态，见下面 .adot 注释
//   T.staleTimer   见下（在 createTab 里，随标签走）
// 所以下面两个渲染函数都收**标签对象**参数 —— 后台标签报了标题，点亮的必须
// 是它自己那一格。

// 有字形的态（等你 = 问号、有新消息 = 铃铛、出错 = 红点）由 JS 填 SVG，点态
// （空闲/工作中/断开）交给 CSS 的 ::before 画 —— 两者互斥，靠 .glyph 切。
// **字形与措辞只在这里判一次**：格子头、独立页、群组那一屏（顶部条 + 列表行）
// 四个落点都读它，各判一遍必然有一天不一致（Orca 的 AgentStateDot.tsx:11-20
// 把 who 和 state 拆成两个字形也是同一条理由）。
function dotGlyph(s) { return s === "ask" ? G_ASK : s === "unread" ? G_BELL : s === "failed" ? G_DOT : ""; }

// 把一个状态画进**已经存在**的 .adot 元素。
function paintDot(el, s) {
  if (!el) return;
  const label = DOT_STATES.has(s) ? t("state." + s) : s;
  const glyph = dotGlyph(s);
  el.dataset.state = s;
  el.classList.toggle("glyph", !!glyph);
  if (glyph) el.innerHTML = svg(glyph, 12);
  else if (el.firstChild) el.innerHTML = "";   // 别把上一次的字形留在点态上
  el.setAttribute("aria-label", label);
  el.title = label;
}

// 同一个东西的**字符串版**（给 innerHTML 拼列表用）：群组那一屏的行是一整块
// HTML 拼出来的，没有"已经存在的元素"可以 paintDot。两版都从上面那两点取，
// 所以不会出现"列表里是问号、格子上是实心点"。
function dotHTML(s) {
  const label = DOT_STATES.has(s) ? t("state." + s) : s;
  const glyph = dotGlyph(s);
  return `<span class="adot${glyph ? " glyph" : ""}" data-state="${esc(s)}" role="img"` +
    ` aria-label="${esc(label)}" title="${esc(label)}"` +
    (glyph ? `>${svg(glyph, 12)}</span>` : `></span>`);
}

function renderAgentDot(t) {
  if (!t || !t.dotEl) return;
  // 状态判定整个搬进 cellState()：它要读三条腿（标题字形 / 会话登记表 / hook
  // 与转录推来的「需要你」），而这里只负责把它画出来 —— 判定和画法混在一起
  // 就会出现"两处各判一次、判得不一样"（那个 bug 在 Orca 里对应的是
  // resolveWorktreeStatus 与各 pane 自己画点的关系，它专门抽了一层来避免）。
  const s = cellState(t);
  // 两个落点同源（格子头 + 独立页）—— 见 renderTabTitle 里那段说明。
  for (const el of [t.dotEl, t.pageDotEl]) paintDot(el, s);
  // Bot 的状态跃迁记进 Bot Group 的过程流（91-botgroup.js）。
  if (t.group && typeof botStateChanged === "function") botStateChanged(t, s);
  // 群组那一屏里两个同源的点（顶部条一枚、列表行一枚）跟着一起走。它是
  // "一帧一次"的（scheduleGroup 自己挡），所以这里跟着每格调一遍不亏。
  scheduleGroup();
  // 左栏那几个"活的数"（项目行的状态点与 N 在跑、会话行是不是当前格）同理。
  // ⚠️ 它是**就地补**的（只换点和数字，不重建行），因为这条函数每 400–700ms
  // 就可能被叫醒一次 —— 整表重建会把展开态、滚动位置、正在编辑的名字一起抹掉。
  scheduleProjLive();
}
function applyAgentTitleStatus(t, rawTitle) {
  if (!t) return;
  clearTimeout(t.staleTimer); t.staleTimer = 0;
  const next = detectAgentStatusFromTitle(rawTitle);
  // null 不清状态：Orca 的 tracker 只在判出非 null 时写 lastStatus
  // （agent-title-status.ts:107-109），否则一个只有 "Claude Code" 的标题
  // 会把 working 抹掉。
  if (next !== null) {
    t.agentState = next;
    /* dsh 没有登记表，hook 的 busy 是纯事件推来的；一轮以错误收尾时官方桥
       不会发 Stop（实测 0.2.1-rc.2：turn error 没有 Stop）。标题回到 ✦ 🐋
       是这一刻最硬的“已经停了”证据。不把 hook 的 busy 一起销掉的话，
       cellState 里 `v.st === "busy"` 会继续赢，格子永远转圈。 */
    if (next === "idle") {
      cancelDshLateSettle(t);
      clearDshHookBusy(t);
    } else if (next === "working") {
      // 又转起来了：迟到的收尾计时器必须撤销，否则会把新一轮熄掉。
      cancelDshLateSettle(t);
    }
  }
  renderAgentDot(t);
}

// DSH 的标题回到 idle 时，把它自己留下的 hook busy 一起销掉。
// 只对 dsh 生效：Claude/Codex 有登记表，标题 idle 不该抢在它们前面改状态。
function clearDshHookBusy(t) {
  if (!t || !t.spec || t.spec.agent !== "dsh" || typeof liveOf !== "function") return;
  const v = liveOf(t.id);
  if (v && v.st === "busy") {
    v.st = "idle";
    v.state = "done";
    v.evidence = "title";
    v.wait = null;
  }
}

// UserPromptSubmit 的 hook 要经过约 300ms 的文件轮询；很快的一轮里标题可能
// 先回到 ✦，迟到的 hook 再把格子推成 busy —— 之后不会再有标题变化来销账。
// 标题已经是 idle 时补一个短计时器，到点仍是 idle 就按同样的“标题收尾”处理；
// 期间标题转回 working（真的又开了一轮）则取消。
function armDshLateSettle(t) {
  if (!t || !t.spec || t.spec.agent !== "dsh") return;
  cancelDshLateSettle(t);
  t.dshSettleTimer = setTimeout(() => {
    t.dshSettleTimer = 0;
    if (t.agentState !== "idle") return;
    clearDshHookBusy(t);
    sendCtrl({ type: "log", msg: `dsh 标题迟收尾 tab=${t.id}` });
    renderAgentDot(t);
    if (typeof scheduleLive === "function") scheduleLive();
  }, 1200);
}

function cancelDshLateSettle(t) {
  if (!t || !t.dshSettleTimer) return;
  clearTimeout(t.dshSettleTimer);
  t.dshSettleTimer = 0;
}
// clearWorkingIndicators（agent-title-status.ts:43-66）的 Claude 子集：
// 把转圈字形从标题里抹掉。Orca 还要处理 Gemini/Pi/Grok 的记号，我们不需要。
function clearWorkingIndicators(title) {
  let cleaned = (title || "")
    .replace(BRAILLE_SPINNER_RE, "")
    .replace(QUARTER_CIRCLE_SPINNER_RE, "");
  if (cleaned.startsWith(". ")) cleaned = cleaned.slice(2);
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  return cleaned || title;
}
// 「一直是 working 但其实早停了」的兜底。Orca: terminal-output-side-effects.ts:195-217 ——
// **只在不带标题的 chunk 上 arm**（带标题的 chunk 走另一支，会把计时器清掉），
// 所以它是"最后一段没有标题的输出过去 3 秒"就触发。我们照这个分支写。
// 触发后 Orca 认为 agent 已经退出（confirmPtyAgentExit）；我们还没有"退出"这套管道，
// 落到 idle（灰点）—— 至少不会把 working 黄环永远挂在那儿。
// ---------------------------------------------------------------------------
// Agent 图标：用**官方** SVG，不自己画。
// 这个路径取自 Orca 源码 src/renderer/src/components/status-bar/icons.tsx 的
// ClaudeIcon（viewBox 0 0 24 24，单一 path，填充 #D97757）。Orca 在标签条上
// 按 12px 渲染它。我们这里头部 14、标签 12，尺寸跟 Orca 一致。
// 之前我们用自绘的 `>_` 字形 —— 那正是"质感不对"的典型：形状是自己的，
// 视觉重心、笔画曲率、品牌色全都是错的。
const CLAUDE_PATH = "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";
function claudeIcon(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-label="Claude"><path d="${CLAUDE_PATH}" fill="#D97757"/></svg>`;
}
/* 会话身份图标（用户 2026-10-17 定的规则）：
     · 终端格子头 / 页面标签 / 并行组头 / 已关闭行 = **品牌 mark**：
       Claude 用星芒（claudeIcon），其他 agent 用各自的彩色官方图标；
     · 总览/网关的**目录/清单**才用产品图标（Claude Code 的橙色 mark）。
   前一条曾经有两套实现：格子头走这张表（→ 橙色产品图标），页面标签/组头/
   已关闭行却写死 claudeIcon() —— 于是同一个 Claude 在两个落点是两张脸，
   而且 Codex 格子也会长 Claude 的星芒。现在**只有这一个入口**。
   ⚠️ 只查静态表：第一个标签是在模块求值期间同步建的，那时 MAGPIE 还没初始化
   （`let` 的 TDZ 会让 `mg()` 直接抛 ReferenceError —— 整个前端只画出一半）。 */
const AGENT_ICON_FALLBACK = {
  codex: "codex-color", pi: "pi", opencode: "opencode",
  agy: "antigravity-color", dsh: "deepseek-color", cursor: "cursor",
  codebuddy: "codebuddy-color", kimi: "kimi", muse: "meta-color", zcode: "zcode",
  gemini: "geminicli-color", copilot: "githubcopilot", qwen: "qwen-color", crush: "crush",
};
// 不认识的 agent：画一枚中性终端字形，**不再**默认长 Claude 的脸。
function genericPaneIcon(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"` +
    ` fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"` +
    ` stroke-linejoin="round"><path d="M4 6l4 4-4 4M11 16h9"/></svg>`;
}
function agentTabIcon(id, size) {
  size = size || 12;
  if (id === "claude") return claudeIcon(size);
  const nm = AGENT_ICON_FALLBACK[id] || "";
  return nm ? iconHTML(nm, "xs") : genericPaneIcon(size);
}
/* ⚠️ 2026-10-15：原来这里还有一行 $("p-ico").innerHTML = claudeIcon(14) ——
   面板头上也插一份 Claude logo，于是同一个 agent 在**同一列里上下各一个 logo**
   （标签上一个、面板头一个）。删掉面板头那份，logo 只留标签这一个落点。
   这正是 Orca 的做法：图标只在标签条的 TerminalTabLeadingIcon 里
   （SortableTab.tsx:243），pane 标题栏只有 .pane-title-text 纯文字，没有任何图标。
   顺带一条 —— SortableTab.tsx:131-132 的注释是同一个问题的另一面：
   「有 provider 图标时，剥掉标题里 agent 自己的前导字形，免得一个 agent
   显示两个图标」；我们上一轮换掉的那条 LEADING_AGENT_TITLE_DECORATION_RE
   正则正是在做这件事。 */
/* ⚠️ 2026-10-15：这里原来是 `$("tab-ico").innerHTML = claudeIcon(12)` 一行 ——
   全局只有一个标签，所以图标插一次就够了。现在每个标签自己一格（T.icoEl），
   这件事挪进了 createTab。留在这一段的是**页面级**的东西：ctl 通道、标签条的
   渲染/切换/关闭、以及怎么建出第一个标签。 */

// ---------------------------------------------------------------------------
// 控制通道（ctl）—— 前端唯一的**页面级**控制面
//
// 分工干净：ctl 通道**双向都是 JSON**（建标签、没有标签归属的日志），每条标签流
// **双向都是字节**（键盘原始输入 + PTY 原始输出），互不掺和。
//
// 为什么不用 Wails 的绑定（Call.ByName）：绑定在服务端按「<包路径>.<结构体>.<方法>」
// 查名字，而那些名字要跑 codegen 生成带对象 id 的 JS 调用桩 —— 我们的构建现在是
// 纯 `go build`，不想为此引入构建步骤。这条流复用已有的控制帧形状，零新 API 面。
//
// ⚠️ 建标签是**请求/应答**，不是单向通知 —— 这是这套设计里最容易搞反的一处：
// Go 在运行期注册 `term:<id>` 这个 stream handler，而服务端是**在连接建立时**
// 才按名字查 handler，查不到直接 404（stream_server.go:247-256）。所以必须等 Go
// 把 id 和名字发回来，前端才能去连。顺序由这条应答保证，不靠时序运气。

// fit 前后的滚动位置（照 Orca lib/pane-manager/pane-scroll.ts + terminal-reflow-scroll-anchor.ts，MIT；
// 去掉了 WebGL 拆装重试和 SSH 那些我们没有的分支）。
// 在底部 → fit 完继续贴底跟输出；往上翻着 → 用 marker 钉住「看到的第一行所在的那一整条逻辑行」，
// 再按格数偏移回到同一处（重排会把折行重新编号，裸行号会漂）。
function termCaptureScroll(term) {
  const buf = term.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;
  if (wasAtBottom || buf.type !== "normal") return { wasAtBottom, type: buf.type };
  let lineY = buf.viewportY;
  while (lineY > 0 && buf.getLine(lineY) && buf.getLine(lineY).isWrapped) lineY--;
  let marker = null;
  try { marker = term.registerMarker(lineY - (buf.baseY + buf.cursorY)); } catch (_) { marker = null; }
  return { wasAtBottom, type: buf.type, viewportY: buf.viewportY, marker,
    cellOffset: (buf.viewportY - lineY) * Math.max(term.cols, 1) };
}
function termRestoreScroll(term, s) {
  try {
    const buf = term.buffer.active;
    if (!s || s.type !== buf.type || s.type === "alternate") return;
    if (s.wasAtBottom) { term.scrollToBottom(); return; }
    let line = s.marker && !s.marker.isDisposed && s.marker.line >= 0 ? s.marker.line : s.viewportY;
    let remain = s.cellOffset || 0;
    const cols = Math.max(term.cols, 1);
    while (line < buf.baseY && remain >= cols && buf.getLine(line + 1) && buf.getLine(line + 1).isWrapped) {
      remain -= cols; line++;
    }
    term.scrollToLine(Math.min(line, buf.baseY));
    // xterm 6 在 ydisp 没变时滚动条滑块会停在旧位置：上下抖一行，强制它对齐（Orca terminal-viewport-scrollbar-sync.ts）
    const b2 = term.buffer.active;
    if (b2.viewportY < b2.baseY) {
      if (b2.viewportY > 0) { term.scrollLines(-1); term.scrollLines(1); } else { term.scrollLines(1); term.scrollLines(-1); }
    }
  } catch (_) {
    // 渲染器正在拆装（WebGL 回收）时量不到尺寸：这一次不还原，不能把 settle 打断
  } finally {
    if (s && s.marker) s.marker.dispose();
  }
}

// Windows 内部版本号（xterm 的 windowsPty 要它）。Go 在 settings 推送里带来；记一份给下次首帧用。
let OS_BUILD = +(localStorage.getItem("perch.osBuild") || 0);
function setOsBuild(n) {
  n = n | 0;
  if (!n || n === OS_BUILD) return;
  OS_BUILD = n;
  try { localStorage.setItem("perch.osBuild", String(n)); } catch (_) {}
  if (typeof bootFact === "function") bootFact(`xterm windowsPty = conpty / build ${n}`);
  for (const t of (typeof TAB_LIST !== "undefined" ? TAB_LIST : [])) {
    try { if (t.term) t.term.options.windowsPty = { backend: "conpty", buildNumber: n }; } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// 全屏 TUI（开了鼠标模式的那种，如 Pi 1.4 的 fullscreen）里的滚轮：
// 原样搬自 Orca lib/pane-manager/pane-terminal-mouse-wheel.ts + pane-terminal-tui-wheel-reports.ts（MIT）。
// xterm 自己对「开了鼠标上报」的程序只按像素粗算、小幅滚动会被吞掉，快速连滚也只报一次 ——
// 实测 Pi 里滚 8 格只动 1 行。这里按 Orca 的规则把一次滚轮换算成 N 次「上 / 下一行」的鼠标上报：
// 普通滚轮一格 ≈ 1 + log2(行数) 行（有上限），快速连滚加速，触控板按像素带余数累计。
// 没开鼠标模式（Claude Code 这类普通屏）时完全不管，交给 xterm 自己滚回滚缓冲。
// ---------------------------------------------------------------------------
const TUI_WHEEL = {
  DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2,
  LEGACY_MIN: 100, LEGACY_UNIT: 120, CONT_IDLE_MS: 300, CONT_RATIOS: [3, 1], CONT_TOL: 3,
  CELL_H: 16, GAIN: 1.6, BURST_FULL_MS: 16, BURST_MAX_MS: 45, BURST_BONUS: 3, BURST_RAMP: 4,
  TAIL_DECAY: 0.85, COMPRESSED_MAX: 6, BURST_MAX_ROWS: 9,
};
const REPLAYED_WHEEL = "__perchReplayedWheel";
function tuiWheelDistanceState() {
  return { continuousGestureAt: null, fastStreak: 0, lastDistanceRows: null, lastInputAt: null, pendingDirection: 0, pendingRows: 0 };
}
function tuiWheelLegacyDelta(e) {
  if (typeof e.wheelDeltaY === "number" && Number.isFinite(e.wheelDeltaY)) return e.wheelDeltaY;
  if (typeof e.wheelDelta === "number" && Number.isFinite(e.wheelDelta)) return e.wheelDelta;
  return null;
}
function tuiWheelTime(e) { return typeof e.timeStamp === "number" && Number.isFinite(e.timeStamp) ? e.timeStamp : null; }
function tuiWheelContinuous(e, st) {
  if ((e.deltaMode ?? TUI_WHEEL.DOM_DELTA_PIXEL) !== TUI_WHEEL.DOM_DELTA_PIXEL) { st.continuousGestureAt = null; return false; }
  const at = tuiWheelTime(e), legacy = tuiWheelLegacyDelta(e);
  const ratioOk = legacy !== null && TUI_WHEEL.CONT_RATIOS.some((r) => Math.abs(Math.abs(e.deltaY) * r - Math.abs(legacy)) <= TUI_WHEEL.CONT_TOL);
  const continuous = legacy === null || Math.abs(legacy) < TUI_WHEEL.LEGACY_MIN ||
    (at !== null && st.continuousGestureAt !== null && at >= st.continuousGestureAt &&
     at - st.continuousGestureAt <= TUI_WHEEL.CONT_IDLE_MS && ratioOk);
  st.continuousGestureAt = continuous ? at : null;
  return continuous;
}
function tuiWheelRows(e, m, continuous) {
  const mode = e.deltaMode ?? TUI_WHEEL.DOM_DELTA_PIXEL, dy = Math.abs(e.deltaY);
  const cell = m.cellHeight > 0 && Number.isFinite(m.cellHeight) ? m.cellHeight : TUI_WHEEL.CELL_H;
  const fromDelta = mode === TUI_WHEEL.DOM_DELTA_LINE ? dy : mode === TUI_WHEEL.DOM_DELTA_PAGE ? dy * Math.max(1, m.rows || 1) : dy / cell;
  if (continuous) return fromDelta;
  const legacy = tuiWheelLegacyDelta(e);
  return Math.max(1, fromDelta, legacy === null ? 0 : Math.abs(legacy) / TUI_WHEEL.LEGACY_UNIT);
}
function tuiWheelCompress(rows) {
  return rows <= 1 ? rows : Math.min(TUI_WHEEL.COMPRESSED_MAX, 1 + Math.log2(rows) * TUI_WHEEL.GAIN);
}
function tuiWheelBurst(e, st, rows) {
  const at = tuiWheelTime(e);
  if (at === null) { st.fastStreak = 0; st.lastDistanceRows = null; st.lastInputAt = null; return 0; }
  const elapsed = st.lastInputAt === null ? null : at - st.lastInputAt;
  const tail = st.lastDistanceRows !== null && rows < st.lastDistanceRows * TUI_WHEEL.TAIL_DECAY;
  st.lastDistanceRows = rows; st.lastInputAt = at;
  if (tail || elapsed === null || elapsed < 0 || elapsed > TUI_WHEEL.BURST_MAX_MS) { st.fastStreak = 0; return 0; }
  const cadence = elapsed <= TUI_WHEEL.BURST_FULL_MS ? 1 : (TUI_WHEEL.BURST_MAX_MS - elapsed) / (TUI_WHEEL.BURST_MAX_MS - TUI_WHEEL.BURST_FULL_MS);
  st.fastStreak = Math.min(TUI_WHEEL.BURST_RAMP, st.fastStreak + 1);
  return TUI_WHEEL.BURST_BONUS * cadence * (st.fastStreak / TUI_WHEEL.BURST_RAMP);
}
function tuiWheelReportCount(e, st, m) {
  const dir = e.deltaY < 0 ? -1 : 1;
  if (st.pendingDirection !== 0 && st.pendingDirection !== dir) {
    st.fastStreak = 0; st.lastDistanceRows = null; st.lastInputAt = null; st.pendingRows = 0;
  }
  st.pendingDirection = dir;
  const continuous = tuiWheelContinuous(e, st);
  const rows = tuiWheelRows(e, m, continuous);
  let total;
  if (continuous) {
    st.fastStreak = 0; st.lastDistanceRows = null; st.lastInputAt = null;
    total = st.pendingRows + rows;
  } else {
    total = st.pendingRows + Math.min(TUI_WHEEL.BURST_MAX_ROWS, tuiWheelCompress(rows) + tuiWheelBurst(e, st, rows));
  }
  const reports = Math.trunc(total);
  st.pendingRows = total - reports;
  return reports;
}
function attachTuiWheel(term) {
  const replay = { distance: tuiWheelDistanceState(), drainScheduled: false, pendingDirection: 0, pendingEvent: null, pendingReports: 0, pendingTarget: null };
  const reset = () => { replay.pendingReports = 0; replay.drainScheduled = false; replay.pendingDirection = 0; replay.pendingEvent = null; replay.pendingTarget = null; };
  const clone = (e) => {
    const c = new WheelEvent(e.type, {
      bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed, view: e.view, detail: e.detail,
      screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
      ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
      button: e.button, buttons: e.buttons, relatedTarget: e.relatedTarget,
      deltaX: 0, deltaY: e.deltaY < 0 ? -1 : 1, deltaZ: 0, deltaMode: TUI_WHEEL.DOM_DELTA_LINE,
    });
    Object.defineProperty(c, REPLAYED_WHEEL, { configurable: true, value: true });
    return c;
  };
  const drain = () => {
    const target = replay.pendingTarget, e = replay.pendingEvent;
    if (!target || !e || replay.pendingReports <= 0 || term.modes.mouseTrackingMode === "none") { reset(); return; }
    const n = replay.pendingReports;
    for (let i = 0; i < n; i++) target.dispatchEvent(clone(e));
    reset();
  };
  term.attachCustomWheelEventHandler((e) => {
    if (term.modes.mouseTrackingMode === "none" || e[REPLAYED_WHEEL] === true || e.deltaY === 0 || e.shiftKey ||
        !term.element || !term.element.classList.contains("enable-mouse-events")) return true;
    const target = e.currentTarget instanceof EventTarget ? e.currentTarget : term.element;
    if (!target) return true;
    const screen = term.element.querySelector(".xterm-screen");
    const r = screen && screen.getBoundingClientRect();
    const cellHeight = r && r.height > 0 && term.rows > 0 ? r.height / term.rows : undefined;
    const n = tuiWheelReportCount(e, replay.distance, { cellHeight, rows: term.rows });
    if (n > 0) {
      const dir = e.deltaY < 0 ? -1 : 1;
      if (replay.pendingDirection !== 0 && replay.pendingDirection !== dir) replay.pendingReports = 0;
      replay.pendingDirection = dir; replay.pendingEvent = e; replay.pendingTarget = target; replay.pendingReports += n;
      if (!replay.drainScheduled) { replay.drainScheduled = true; queueMicrotask(drain); }
    }
    return false;
  });
}
