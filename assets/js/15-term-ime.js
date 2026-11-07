"use strict";
/* 15-term-ime.js —— 每一格终端的输入法候选框锚定 + 终端外层被卷开的兜底。
   2026-11-08 从 30-pages.js 原样搬出（旧外壳退役，这两样是终端本身的事，留下）。 */

// ---------------------------------------------------------------------------
// IME 候选框锚定：让它跟着 **Claude Code 的输入框**，而不是 xterm 的光标
//
// 【为什么需要】实测（2026-10-15，探针把缓冲区打出来了）：
//   操作系统在 `compositionstart` 那一刻读聚焦 textarea 的屏幕矩形，据此摆候选框。
//   xterm 把 textarea 摆在自己的 buffer 光标上 —— 而 Claude Code **把终端光标
//   停在自己画的状态行末尾**，不是输入框：
//       buffer 光标 = (75, 8)  行内容 "  ⏵⏵ auto mode on … ● high · /effort"
//       真正的输入框 = ( 0, 6)  行内容 "❯  "
//   → 候选框（连同预编辑串）横向偏 (75-2)×8 = 584px。这就是"偏差很大"。
//
// 【已排除的一条】Orca 的 terminal.css:56-59 把 `.xterm-helpers{left:0}` 当作
//   IME 偏移的修法，理由是 Blink 下 `left:auto` 会解析成非 0。**在我们这儿不成立**：
//   探针实测 computed left 恒为 `0px`。别再加那条。
//
// 【做法】骨架照搬 Orca 的 lib/pane-manager/terminal-ime-candidate-anchor.ts（MIT）：
//   在 compositionstart / compositionupdate 上，**在 xterm 自己的处理器之后**
//   （xterm 监听在 textarea 上，我们监听在 term.element 上，冒泡保证顺序）
//   把 textarea 与 .composition-view 重写到位。
//   与 Orca 的差异只有"输入框在哪"这一段 —— 它认 Cursor 的 `→ `，Claude Code 认 `❯ `。
// ---------------------------------------------------------------------------
const CC_IME_PROMPT = "❯";   // U+276F，Claude Code 输入框的提示符

// 「这个格子算不算空白」—— **别用 `getChars() === " "` 判**。
//
// 实测（探针把 col0..col3 原样打了出来）：Claude Code 的输入行是
//     col0 = "❯"  code=10095
//     col1 = " "  code=160     ← **U+00A0 不换行空格（NBSP），不是普通空格**
//     col2 = " "  code=32      ← 这个才是普通空格
// 它显然是用 NBSP 来保证空输入时提示符后面那个可见间隙不被终端裁掉。
// 只认 `" "` 的话这一格永远判不过，整段识别**静默失效、不报错** ——
// 这个坑花了两轮才挖出来，别退回去。
// 用 `String.trim()` 判：按 ECMAScript 规范它连 NBSP 一起吃掉。
function ccImeIsBlankCell(c) {
  if (!c || c.getWidth() === 0) return true;
  const ch = c.getChars();
  if (ch === "") return true;      // 空串 = 没写过字的空格格
  return ch.trim() === "";
}
// 提示符所在列 → 输入内容的起始列。**要求提示符后面跟一个空白格**，
// 与 Orca 判 `→ ` 同理：转录正文里偶发的同样字符不该被当成输入框。
function ccImeInputStartColumn(line, cols) {
  for (let col = 0; col < cols - 1; col++) {
    const c = line.getCell(col);
    if (!c || c.getWidth() <= 0) continue;
    if ((c.getChars() || " ") !== CC_IME_PROMPT) continue;
    const next = col + Math.max(c.getWidth(), 1);
    const nc = next < cols ? line.getCell(next) : undefined;
    if (nc && ccImeIsBlankCell(nc)) return next + Math.max(nc.getWidth(), 1);
  }
  return null;
}
// 一行里最后一个非空白格的末端列（用于"已经打了一些字"时贴到字后面）。
function ccImeLineEndColumn(line, start, cols) {
  for (let col = cols - 1; col >= start; col--) {
    const c = line.getCell(col);
    if (ccImeIsBlankCell(c)) continue;
    return col + Math.max(c.getWidth(), 1);
  }
  return null;
}
// 输入框的边框 / 状态行：走续行时遇到它们就停。
function ccImeStopLine(txt) {
  const t = txt.trim();
  return /^[─━═╌┄]{3,}/.test(t) || t.includes("⏵") || /for shortcuts|esc to /i.test(t);
}
// 自下而上找输入框（转录在上、输入框在它下面，所以最低的那个才是）。
// 返回 null = **不干预**，维持 xterm 自己的行为（摆在它的光标上）：
//   ① 没认出输入框；② xterm 的光标本来就落在输入框里（新版 Claude Code / 别的 agent
//   把光标放对了，就信它 —— Orca terminal-ime-candidate-anchor.ts 也是先信光标）。
// 2026-10-29 修：原来只锚在 ❯ 那一行的行尾。输入折到第二行时续行上没有 ❯，候选框和
// 预编辑串就被钉在第一行最右边（用户看到的「打到第二行就不聚焦、错位」）。现在顺着续行
// 往下走到最后一行，贴在那一行的字后面；正好写满一行就落到下一行的起始列。
function ccImeAnchor(buf, term) {
  const cols = term.cols;
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buf.getLine(buf.baseY + row);
    if (!line) continue;
    const start = ccImeInputStartColumn(line, cols);
    if (start === null) continue;
    let last = row;
    for (let r = row + 1; r < term.rows; r++) {
      const l = buf.getLine(buf.baseY + r);
      if (!l) break;
      const txt = l.translateToString(true);
      if (!txt.trim() || ccImeStopLine(txt)) break;
      if (txt.slice(0, start).trim() !== "") break;   // 续行的缩进和输入起始列对齐
      last = r;
    }
    const cy = buf.cursorY, cx = buf.cursorX;
    if (cy >= row && cy <= last && (cy > row || cx >= start)) return null;
    const ln = last === row ? line : buf.getLine(buf.baseY + last);
    const rest = ln.translateToString(true, start, cols);
    if (!rest.trim()) return { row: last, column: Math.min(start, cols - 1) };
    const end = ccImeLineEndColumn(ln, start, cols) ?? start;
    if (end >= cols && last + 1 < term.rows) return { row: last + 1, column: Math.min(start, cols - 1) };
    return { row: last, column: Math.min(end, cols - 1) };
  }
  return null;
}

// 每个标签**各装一份**。原来这是个 IIFE、在模块顶层跑一次 —— 那是在"只有一个
// 终端"的前提下才成立的：那时 `term` 一定已经存在。现在模块顶层跑的时候一个
// 标签都还没有，IIFE 会直接撞上 `if (!el …) return` 静默不装（而且不报错）。
// 所以它变成 createTab 里的一个调用：终端刚 open 完，元素齐全。
function installImeAnchor(t) {
  const term = t.term;                       // ← 遮蔽模块级那个视图：装的是**这个**标签
  const el = term.element;
  const screen = el && el.querySelector(".xterm-screen");
  const ta = term.textarea;
  if (!el || !screen || !ta) return;   // 终端还没 open 完：不装，也比装错强
  const compView = el.querySelector(".composition-view");

  let metrics = null;
  let deferred = null;

  const measure = () => {
    const r = screen.getBoundingClientRect();
    const cw = r.width / term.cols, ch = r.height / term.rows;
    if (!(cw > 0) || !(ch > 0)) return null;
    return { cw, ch, cols: term.cols, rows: term.rows };
  };
  // 只在值真的变了才写：xterm 每次事件都会重写这些内联样式，
  // 无脑写会平白让布局失效一次（Orca 的 writeStyle 同理）。
  const put = (node, prop, val) => { if (node && node.style[prop] !== val) node.style[prop] = val; };

  const apply = (anchor, m) => {
    const top = `${anchor.row * m.ch}px`;
    const rawLeft = anchor.column * m.cw;
    // 和设备宽度收口一致：xterm 在预编辑过长时会把框拉回屏内，
    // 我们按同样的规则夹一下，免得下一次它又拉回去、两边打架。
    const w = Number.parseFloat(ta.style.width);
    const left = Number.isFinite(w)
      ? Math.max(0, Math.min(rawLeft, m.cols * m.cw - w))
      : rawLeft;
    put(ta, "top", top);
    put(ta, "left", `${left}px`);
    // 预编辑的可见overlay也得跟着走，否则只有候选框对、画面上的拼音还在原处
    if (compView) {
      // 预编辑串也夹在屏内（原来用的是没夹过的 rawLeft，贴近右边缘时会溢出，
      // 溢出就会让 Chromium 去卷动外层容器 —— 「打字时画面偏移」的嫌疑之一）。
      const cvw = compView.getBoundingClientRect().width || 0;
      const cvLeft = Math.max(0, Math.min(rawLeft, m.cols * m.cw - cvw));
      put(compView, "top", top);
      put(compView, "left", `${cvLeft}px`);
      put(compView, "height", `${m.ch}px`);
      put(compView, "lineHeight", `${m.ch}px`);
    }
  };

  const handler = () => {
    if (!ta.isConnected) return;
    if (!metrics || metrics.cols !== term.cols || metrics.rows !== term.rows) metrics = measure();
    if (!metrics) return;
    const anchor = ccImeAnchor(term.buffer.active, term);
    if (!anchor) return;    // 没认出来就完全不干预，保持 xterm 原有行为
    apply(anchor, metrics);
    // xterm 在每个 compositionupdate 之后还会用 setTimeout(0) 自己摆一次 textarea，
    // 所以补一次更晚的重写；一次组字里只保留一个待执行（Orca 的 deferredApply 同理）。
    if (deferred !== null) window.clearTimeout(deferred);
    deferred = window.setTimeout(() => {
      deferred = null;
      if (!ta.isConnected) return;
      if (!metrics) metrics = measure();
      if (!metrics) return;
      const a = ccImeAnchor(term.buffer.active, term);
      if (a) apply(a, metrics);
    }, 0);
  };

  el.addEventListener("compositionstart", handler);
  el.addEventListener("compositionupdate", handler);
}

// 终端格外层被卷开的兜底与取证（2026-10-29）。.cell/.cellbody/.termhost 已改成 overflow:clip，
// 卷不动了；但格子外面还有几层（网格、页面）。任何一层**本不该滚**的盒子被浏览器卷开（为了把
// 输入法 textarea 滚进视野），整格就会平移。这里在捕获阶段接住 scroll：目标在终端区里、又不是
// xterm 自己的滚动区，就立刻归零，并记一笔是谁、卷了多少 —— 下次「画面偏移」有证据可查。
const TERM_SCROLL_LOGGED = new Set();
document.addEventListener("scroll", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.closest(".xterm-viewport, .xterm-scrollable-element") || el.classList.contains("xterm-viewport")) return;
  if (!el.querySelector(".xterm") && !el.closest(".xterm")) return;
  const ov = getComputedStyle(el);
  if (/(auto|scroll)/.test(ov.overflowX + ov.overflowY)) return;   // 本来就是滚动区
  if (!el.scrollTop && !el.scrollLeft) return;
  const key = (el.id || el.className || el.tagName) + "";
  if (!TERM_SCROLL_LOGGED.has(key)) {
    TERM_SCROLL_LOGGED.add(key);
    sendCtrl({ type: "log", msg: `终端外层被卷开 ${key} scrollTop=${el.scrollTop} scrollLeft=${el.scrollLeft}（已归零）` });
  }
  el.scrollTop = 0; el.scrollLeft = 0;
}, true);
