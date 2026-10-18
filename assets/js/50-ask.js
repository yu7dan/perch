"use strict";
/* 50-ask.js —— AskUserQuestion：读选择器、点选项作答、按题跳转、提交屏。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 4276-5122（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

// ===========================================================================
// 「点一下选项就答掉」（①）
//
// 转录里那条 AskUserQuestion 是**只读产出物** —— 没有回填答案的通路，所以"点一个
// 方案"只能换算成**往那一格的 PTY 写一个按键**（`t.stream.send`，不需要焦点、
// 不需要回车）。按键语义 2026-10-16 实测过（见记忆 claude-code-ask-picker-keys）：
//
//   · **数字键直选**：高亮在真实选项行上时按 k 立刻作答，与高亮在第几项无关
//     （实测 `3` → 答案是 Gamma，`busy → idle`）
//   · ⚠️ 高亮压在 `Type something.` 上时那一行是个**输入框** —— 送数字会被它当
//     打字吃掉（实测变成 `4. 2`），所以送键前必须读屏确认高亮不在合成行上；
//     挪开用 ↑（实测：从合成行往上一定落到真实选项行）
//   · 这个 CLI **不把 UI 画在屏幕底部** ⇒ 读屏要先找页脚、再往上取那一段
//   · **多问**：屏上一次只问一问（多一条步骤条 `← ☐ Color ☐ Size ✔ Submit →`），
//     页脚变成 `Tab/Arrow keys to navigate`，编号**每问内重新从 1 开始**；答完一问
//     **自动跳到下一问**，最后一问答完自动落到提交屏（那一屏**没有页脚**：
//     `Review your answers` + `❯ 1. Submit answers / 2. Cancel`）
//   · **多选**：选项带勾选框 `[ ]`/`[✔]`，数字键只**切勾选**（不前进、不提交），
//     列表里多一项没有编号的 `Submit`（夹在 Type 与 Chat 之间），走上去按回车才进提交屏
//   · **换问 = `←`/`→`**（页脚那句 `Tab/Arrow keys to navigate` 里的 Arrow keys）：
//     两向都**非破坏**（不碰任何答案，只把高亮带回第 1 项）；回到一个已答的问时，
//     屏上被选过的那一行后面带一个 `✔`（再答一次 = **覆盖**）。这是"进度条可点着跳问"
//     的依据（jumpToQuestion）—— ⚠️ 但高亮压在 `Type something.` 上时 `←`/`→` 是
//     **移动文本光标**，所以出发前先照上面那条把高亮挪回真实选项行
//
// 多问/多选带进来两件事，都必须处理：
//   ① **"现在问的是哪一问"只在屏上**（转录要等整张提问结束才落结果）⇒ 你点第 2 问的
//      一项时，屏上若正问第 1 问，那个数字会**答到第 1 问上去** —— 静默答错。
//   ② **提交屏上的 `1./2.` 是"提交/取消"**（实测按 `1` 就提交了）⇒ 那一屏上任何选项
//      都不许点；提交也不靠数字键（挪高亮 + 读屏确认 + 回车，见 pressSubmit）。
//
// 为什么这么小心：往活着的 agent 里写错键 = 静默做错事（选了用户没点的东西，把数字
// 打进输入框，或者把答案丢弃），比"不实现"坏得多。所以闸一条不省，任何一条不过就
// **什么都不送**，只在你点的那一行下面落一句实话。
// ===========================================================================

// askId → {k, text}：只留最近一条。既用来当场写进 DOM，也用来让"下一帧重画"
// 之后那句话还在（群组流是按签名重画的，那一行会整块重建）。
const answerErr = new Map();

// askId → 屏上读数（多问/多选才需要，见 syncAskScreens）。它进了 askBlockSig，
// 所以屏一变那一行就重画。
const askScreen = new Map();

/* askId → {第几问: 选中的 label}：**我们自己按过的**（单问单选那一类）。
   为什么要自己记：多问是"一问一屏"，按完一问屏就翻到下一问，那答案要等**整张提问**
   收尾才进转录 —— 中间这段时间"第 1 问选了 Gamma"在任何数据源里都查不到，而用户正要
   看着它往下答。只记**被屏回执证过**的那些（见 watchScreenStep），所以它不会凭猜测写。 */
const answerPick = new Map();

/* tabId → 正在跳向第几问（0 基）。**一次只许跳一个**：跳问是"发一个键、等屏确认、
   再发下一个"的一串动作，两串叠在一起就数不清屏上那一下是谁弄的（见 jumpToQuestion）。
   它只影响观感（进度条上那一格画成 jmp），不参与任何闸。 */
const jumpBusy = new Map();

/* 读那一格**屏上**的选择器现在长什么样 —— 这是"往它里面写键"唯一能依据的现场。
   页脚 `Enter to select` 是随选择器一起画的（比猜图形硬），拿它当锚；`N. 文本` 的 N
   与转录 options[] 的下标+1 一一对应（实测）。三种形状都要读得出来：
     · 单问单选（页脚 + 编号选项）
     · 多问（多一条步骤条；一问一屏，所以还要读出"现在问的是哪一问"）
     · 多选（选项带 `[ ]`/`[✔]`；列表里多一项没有编号的 `Submit`）
     · 提交屏（**没有页脚**，靠 `Review your answers`/`Submit answers` 认） */
function readPicker(t) {
  const b = t && t.term && t.term.buffer.active;
  if (!b) return null;
  const R = t.term.rows || 50;
  const lo0 = Math.max(0, b.viewportY), hi0 = Math.min(b.length - 1, lo0 + R - 1);
  const at = (i) => { const ln = b.getLine(i); return ln ? ln.translateToString(true).replace(/\s+$/, "") : ""; };

  let foot = -1, review = -1;
  for (let i = lo0; i <= hi0; i++) {
    const s = at(i);
    if (foot < 0 && s.indexOf("Enter to select") >= 0) foot = i;
    if (review < 0 && /Submit answers|Review your answers/.test(s)) review = i;
  }
  const submitScreen = review >= 0;
  if (!submitScreen && foot < 0) return null;         // 既不是选择器、也不是提交屏
  const to = submitScreen ? hi0 : foot;               // 提交屏一直取到屏底（那两行在下面）
  const from = Math.max(lo0, (submitScreen ? review : foot) - 20);

  const opts = {}, checks = {}, picked = {}, seen = {};
  let hi = 0, hiNum = 0, hiText = "", hiSubmit = false, hasSubmitRow = false;
  let steps = null, q = "", firstOpt = -1;
  for (let i = from; i <= to; i++) {
    const s = at(i);
    if (!s) continue;
    if (!steps) {                                     // 步骤条：≥2 格才算（一问一屏那种）
      // ⚠️ 标记（☐ 没问 / ☒ 答过 / ✔ 提交）要一起留下：群组那边**只画当前一问**，
      // "已经答了几问"全靠这条进度条说，光有 label 说不出来。
      const st = [], re = /([☐☒✔])\s*([^\s☐☒✔→←]+)/g;
      let m; while ((m = re.exec(s))) st.push({ m: m[1], label: m[2] });
      if (st.length >= 2 && /[←→]/.test(s)) steps = st;
    }
    if (/^(❯\s*)?\s*Submit\s*$/.test(s)) {             // 多选那个没有编号的 Submit 行
      hasSubmitRow = true;
      if (s.indexOf("❯") >= 0) { hiSubmit = true; hiNum = 0; hiText = "Submit"; }
      continue;
    }
    const m = s.match(/^\s*(❯\s*)?(\d+)\.\s+(\S.*)$/);
    if (!m) continue;
    const n = +m[2];
    if (firstOpt < 0) firstOpt = i;
    // 同一号只认**第一次**出现的那一行：选项的 description 画在它下一行，万一那句
    // 以 "2. " 开头，也不能把选项本身覆盖掉。
    if (!(n in seen)) {
      seen[n] = 1;
      let txt = m[3].trim();
      const cb = txt.match(/^\[( |✔)\]\s*(.*)$/);      // 多选：选项前面是勾选框
      if (cb) { checks[n] = cb[1] === "✔"; txt = cb[2].trim(); }
      // 已答的那一问回看时，被选中的那一行后面跟一个 `✔`（实测：从第 2 问按 ← 回到
      // 第 1 问，屏上是 `❯ 1. Alpha ✔`）—— 不剥掉它，label 比对就会差一个字符而全部
      // 对不上。剥下来的这个标记**有用**：它比我们自己记的那份更真（见 askHTML）。
      const pk = txt.match(/^(.*?)\s*✔\s*$/);
      if (pk) { txt = pk[1].trim(); picked[n] = true; }
      opts[n] = txt;
    }
    if (m[1]) { hi = n; hiNum = n; hiText = opts[n] || ""; hiSubmit = false; }
  }
  // 屏上**正在问的那一问**：编号选项上方最近的一行（跳过空行和步骤条）。
  // 多问时这就是"数字键此刻会答到哪一问去"的答案，见 answerFromGroup 的闸⑤。
  for (let i = firstOpt - 1; i >= Math.max(lo0, firstOpt - 6); i--) {
    const s = at(i);
    if (!s || (steps && steps.some((w) => s.indexOf(w.label) >= 0))) continue;
    q = s.trim(); break;
  }
  const nums = Object.keys(opts).map(Number);
  return {
    from, to, submitScreen, steps, q, hasSubmitRow, opts, checks, picked,
    hi, hiNum, hiText, hiSubmit,
    max: nums.length ? Math.max.apply(null, nums) : 0,
  };
}

// 屏上那一行文字与转录里那个 label 是不是同一项。两边都会截断（屏上是单行、
// 转录那边 Go 侧也截过），所以按"前 12 个非空白字符"比 —— 它挡的是"屏上和转录
// 是两个问题"这种彻底对不上的情况，不是逐字节校对。
const normLabel = (s) => String(s || "").replace(/\s+/g, "").slice(0, 12);
const labelSame = (a, b) => normLabel(a) === normLabel(b);

/* 多问/多选把"只有屏上才知道"的中间态带进来了（现在问的是哪一问 / 哪几项勾着 /
   是不是已经停在提交屏）。转录那条腿要等**整张提问**结束才落结果，中间态它一概没有
   ⇒ 只能读屏。⚠️ 只在"多问或多选"时读：单问单选那条老路不需要（答完转录就翻），
   所以这个表不给最常见的那条路加任何东西。 */
function screenModel(p) {
  if (!p) return null;
  // steps 压成 [["☐","Color"],…]：进度条上"答了几问"变了，那一行就得重画
  return { q: p.q, checks: p.checks || {}, picked: p.picked || {},
           submitRow: !!p.hasSubmitRow, review: !!p.submitScreen,
           steps: (p.steps || []).map((s) => [s.m, s.label]) };
}
const askScreenSig = (m) =>
  (m ? JSON.stringify([m.q, m.checks, m.picked, m.submitRow, m.review, m.steps]) : "");

/* 按 ~700ms 把那种提问的屏读一遍，变了就让那一行重画（这个签名进了 askBlockSig）。
   只在**群组开着**时跑 —— 群组没开时那一行根本不存在。 */
function syncAskScreens() {
  if (!collapsed) return;
  for (const t of TAB_LIST) {
    const v = LIVE.get(t.id);
    const a = v && (v.acts || []).find((x) => x.kind === "tool" && x.tool === "AskUserQuestion" && x.ok == null);
    const qs = (a && a.qs) || [];
    if (!(a && (qs.length > 1 || (qs[0] && qs[0].multi)))) continue;   // 只伺候多问/多选
    const m = screenModel(readPicker(t));
    if (askScreenSig(m) !== askScreenSig(askScreen.get(a.id))) {
      askScreen.set(a.id, m);
      // 这条日志是"多问/多选"这一层的自证读数：它同时说明了"屏读到的是哪一问、
      // 哪几项勾着、有没有到提交那一步"（转录里都没有这些）。
      sendCtrl({ type: "log", msg: `答题 屏读 tab=${t.id} 问=「${String((m && m.q) || "").slice(0, 20)}」` +
        ` 进度=${(m && m.steps || []).map((x) => x.join("")).join(" ") || "无"} 勾=${JSON.stringify((m && m.checks) || {})}` +
        ` 提交行=${!!(m && m.submitRow)} 提交屏=${!!(m && m.review)}` });
      scheduleGroup();
    }
  }
  // 那条提问不再挂着了 ⇒ 读数清掉（不清的话下次会带着旧勾选/旧进度画出来）
  if (askScreen.size || answerPick.size) {
    const live = new Set();
    for (const t of TAB_LIST) {
      const v = LIVE.get(t.id);
      for (const x of (v && v.acts) || []) if (x.tool === "AskUserQuestion" && x.ok == null) live.add(x.id);
    }
    for (const id of Array.from(askScreen.keys())) if (!live.has(id)) askScreen.delete(id);
    for (const id of Array.from(answerPick.keys())) if (!live.has(id)) answerPick.delete(id);
  }
}
setInterval(syncAskScreens, 700);

// 把"没按成 / 结果不明"写在你点的那一行下面（同一格上只留最近一条）。
// qi = 第几问（多问才用得上）；错了的那一句**必须落得下去**：贴到某个选项行上
// 对得上就贴那一行，对不上（比如"提交"那一步没过闸）就贴到页脚上方。
function answerNote(el, askId, k, text, qi) {
  if (askId) answerErr.set(askId, { k, qi: qi | 0, text });
  const box = el.closest ? el.closest(".gask") : null;
  if (box) for (const old of Array.from(box.querySelectorAll(".qerr"))) old.remove();
  const inOpt = !!(el.classList && el.classList.contains("gopt"));
  const host = inOpt ? el : (box && box.querySelector(".gf")) || el;
  host.insertAdjacentHTML(inOpt ? "beforeend" : "beforebegin", `<div class="qerr">${esc(text)}</div>`);
}

/* 高亮挪到真实选项行上（只在它压在合成行上时才需要动）。
   `done("")` = 可以按了；`done(why)` = 没动成、别按。 */
function stepHighlight(t, k, n, tries, done) {
  const p = readPicker(t);
  if (!p) return done("选择器不见了，没按");
  const txt = p.opts[p.hi] || "";
  // 只有"确认高亮落在 1..N 的真实选项行上"才算安全。合成行（N+1 `Type something.`
  // 是输入框、N+2 `Chat about this`）和"❯ 根本读不到"都算没确认。
  const safe = p.hi >= 1 && p.hi <= n && !/^(Type something\.|Chat about this)$/.test(txt);
  if (safe) return done("");
  if (tries >= 3) return done(`高亮挪不开（停在第 ${p.hi} 行「${txt.slice(0, 16)}」），没敢按`);
  t.stream.send(enc.encode("\x1b[A"));       // ↑
  // 这一步要留痕：它是"本该打进去的字没被打进去"的唯一证据（没这条日志时，
  // 一次成功的作答分不出"高亮本来就在真实选项行上"和"挪开了才成功"）。
  sendCtrl({ type: "log", msg: `答题 高亮挪开 tab=${t.id} 原在第${p.hi}行「${txt.slice(0, 16)}」` });
  setTimeout(() => stepHighlight(t, k, n, tries + 1, done), 160);
}

/* 按下去之后**等回声**：转录里那条 tool_use 拿到结果才算成。
   ⚠️ 等不到就**只说不重试** —— 重试可能重复作答（一次点击变成两票）。
   单问单选走这条（一击作答，转录当场翻）。多问/多选**不走这条**：转录要等整张
   提问收尾才落结果，中间那几步它在屏上，见 watchScreenStep。 */
function watchAnswerEcho(t, askId, el, k, qi) {
  const t0 = Date.now();
  const tick = () => {
    const v = LIVE.get(t.id);
    const it = v && (v.acts || []).find((x) => x.id === askId);
    if (it && it.ok != null) {
      sendCtrl({ type: "log", msg: `答题 回声 tab=${t.id} 按=${k} 有结果 用时=${Date.now() - t0}ms` });
      return;
    }
    if (Date.now() - t0 < 2500) return void setTimeout(tick, 250);
    answerNote(el, askId, k, `已经替你在这一格里按下 ${k}，但 2.5 秒里没等到结果 → 去这一格看看`, qi);
    sendCtrl({ type: "log", msg: `答题 回声 tab=${t.id} 按=${k} 没等到结果（未重试）` });
  };
  setTimeout(tick, 300);
}

/* 多问/多选按下去之后**等屏变**（转录那条腿在这几步上还没结果，见上面那段）：
   判据取"这次读到的屏 ≠ 按之前读到的屏" —— 问答完自动跳到下一问（问的那一行变）、
   多选切了勾（勾选态变）、进了提交屏（多了 review）三种都算数。屏一变就把读数写进
   askScreen 并立刻重画那一行（不等那 700ms 那一轮）。
   ⚠️ 同样**只说不重试**。屏没变还有一种可能是"这一步本来就没有屏变化"（比如数字落在
   已经勾上的那一项上），所以那句话写的是"屏上没变化"，不写成"没按成"。 */
function watchScreenStep(t, askId, el, k, before, qi, info) {
  const b0 = askScreenSig(before);
  const t0 = Date.now();
  const tick = () => {
    const v = LIVE.get(t.id);
    const it = v && (v.acts || []).find((x) => x.id === askId);
    if (it && it.ok != null) {          // 整张提问当场收尾了（最后一问/提交）也算成
      sendCtrl({ type: "log", msg: `答题 屏回执 tab=${t.id} 按=${k} 提问已收尾 用时=${Date.now() - t0}ms` });
      return;
    }
    const m = screenModel(readPicker(t));
    if (askScreenSig(m) !== b0) {
      askScreen.set(askId, m);
      /* 屏变 = 这一下确实落到了那一格上 ⇒ 把"这一问答的是什么"记下来（只记单问单选：
         多选的勾还能被点掉，它的现状要看屏上的勾选态，不记）。⛔ 没看到屏变就**不记** ——
         记了就是在替界面编一个它没看见的答案。 */
      if (info && !info.multi && info.label) {
        const pk = answerPick.get(askId) || {};
        pk[qi | 0] = info.label;
        answerPick.set(askId, pk);
      }
      scheduleGroup();
      sendCtrl({ type: "log", msg: `答题 屏回执 tab=${t.id} 按=${k} 变=问「${String((m && m.q) || "").slice(0, 16)}」` +
        ` 进度=${(m && m.steps || []).map((x) => x.join("")).join(" ") || "无"}` +
        ` 勾=${JSON.stringify((m && m.checks) || {})} 提交行=${!!(m && m.submitRow)} 提交屏=${!!(m && m.review)}` +
        ` 用时=${Date.now() - t0}ms` });
      return;
    }
    if (Date.now() - t0 < 2000) return void setTimeout(tick, 250);
    answerNote(el, askId, k, `已经替你在这一格里按下 ${k}，但那一格的屏上没变化 → 去这一格看看`, qi);
    sendCtrl({ type: "log", msg: `答题 屏回执 tab=${t.id} 按=${k} 屏上没变化（未重试）` });
  };
  setTimeout(tick, 250);
}

/* 「跳到这一问」—— 用户点了进度条上的一格。终端里换问的键实测是 `←`/`→`：
   两向都**非破坏**（不碰任何答案，只把高亮带回第 1 项），回看一个已答的问时屏上还会
   给那一行画个 `✔`（再答一次 = 覆盖）。所以这条路比"作答"安全得多 —— 最坏情况是
   高亮挪了一格，挪回来就行，不会静默做错事。

   规矩还是那两条（和作答同一套）：
     · **一步一步走，每一步都读屏**：每发一个键只准走到**相邻那一问**（导航是顺序的），
       预期结果就是"屏上那句问题变成转录里下一问的原文" —— 这一步是可验证的，比"发 N 个
       键然后祈祷"硬得多。走到别的问上、或者屏压根没变 = 立刻停手说实话。
     · **只说不重试**：停了就是停了，绝不接着补键（补一个键 = 多跳一问，跳到哪儿说不准）。

   出发前先把高亮从合成行上挪开：`Type something.` 那一行是输入框，`←`/`→` 在它上面是
   **移动文本光标**而不是换问（复用 stepHighlight 那套 —— 它只在压在合成行上时才动）。 */
function jumpToQuestion(t, el) {
  const qi = el.dataset.jstep | 0;
  const box = el.closest ? el.closest(".gask") : null;
  const askId = (box && box.dataset.ai) || "";
  const v = LIVE.get(t.id);
  const it = v && (v.acts || []).find((x) => x.id === askId);
  // 闸①：那条提问还挂着（和作答同一道门）—— 它一有结果，"现在问第几问"就不存在了
  if (!it || it.ok != null) return answerNote(el, askId, 0, "这条提问已经有结果了，没跳", 0);
  if (!t.stream || !t.ready) return answerNote(el, askId, 0, "那一格的终端没连着，没跳", 0);
  if (jumpBusy.has(t.id)) return;                     // 正在跳，忽略这一下
  const qs = it.qs || [];
  if (qs.length < 2 || !qs[qi]) return answerNote(el, askId, 0, "这一问已经不在转录里了，没跳", 0);
  const p = readPicker(t);
  if (!p) return answerNote(el, askId, 0, "那一格屏上没有选择器了，没跳", 0);
  // 闸②：提交屏上没有"问"可跳（那一屏只剩提交/取消两行）
  if (p.submitScreen) return answerNote(el, askId, 0, "那一格已经走到提交那一步了，没跳", 0);
  /* 闸③：屏上正问的是哪一问 —— 跳问要靠它算方向。认不出来就**不猜**：
     宁可一个字节都不送，也不按"我以为在第 1 问"这个假设去走。 */
  const cur = qs.findIndex((q) => labelSame(p.q, q.q));
  if (cur < 0)
    return answerNote(el, askId, 0,
      `认不出那一格现在问的是哪一问（屏上「${String(p.q || "").slice(0, 16)}」），没跳`, 0);
  if (cur === qi) return;                             // 就是这一问 —— 它本来也没有动作
  jumpBusy.set(t.id, qi);
  scheduleGroup();                                    // 先把那一格画成 jmp（观感）
  const n = (qs[cur].opts || []).length;
  // 这条日志是这一整块的现场读数：方向、几格、屏上原话、高亮在第几行。
  // `应用光标态`也带上 —— ←/→ 的字节序列在两种模式下不一样（见 walkToQuestion）
  sendCtrl({ type: "log", msg: `答题 跳问 tab=${t.id} 从第${cur + 1}问→第${qi + 1}问` +
    `（${qi > cur ? "→" : "←"}×${Math.abs(qi - cur)}）屏上「${String(p.q || "").slice(0, 16)}」` +
    ` 高亮第${p.hiNum || p.hi}行 应用光标态=${!!(t.term.modes && t.term.modes.applicationCursorKeysMode)}` });
  stepHighlight(t, 0, n, 0, (why) => {
    if (why) { jumpBusy.delete(t.id); scheduleGroup(); return answerNote(el, askId, 0, why, 0); }
    walkToQuestion(t, askId, el, qs, cur, qi, 0, Date.now());
  });
}

/* 一步一步走过去：发一个 `←`/`→`、等屏上那句问题变成**下一问的原文**，再走下一步。
   三种情况都停手：走到别的问上（导航不是顺序的 —— 我没量过那种情况，所以不猜）、
   屏在 1.5 秒里没变（键没进去 / 那一格不在听）、屏上读不到选择器了。 */
function walkToQuestion(t, askId, el, qs, cur, target, sent, t0) {
  const dir = target > cur ? 1 : -1;
  const next = cur + dir;
  const want = qs[next] || {};
  const p = readPicker(t);
  const stop = (text, log) => {
    jumpBusy.delete(t.id); scheduleGroup();
    if (log) sendCtrl({ type: "log", msg: log });
    answerNote(el, askId, 0, text, 0);
  };
  if (!p || p.submitScreen)
    return stop("那一格的屏读不到选择器了（可能已经到提交那一步），没往下走", "");
  if (labelSame(p.q, want.q))                        // 上一个键已经把它送到了（读得晚了一拍）
    return walkArrived(t, askId, el, qs, next, target, sent, t0);
  if (!labelSame(p.q, (qs[cur] || {}).q))
    return stop(`跳到这一问没走上（那一格现在问的是「${String(p.q || "").slice(0, 16)}」）→ 去这一格看看`,
      `答题 跳问 tab=${t.id} 停手：屏上是「${String(p.q || "").slice(0, 16)}」` +
      `，既不是出发那一问也不是下一问（走了 ${sent} 步）`);
  if (sent > qs.length + 1)                          // 理论上到不了（步数比问数还多）
    return stop("跳到这一问没走上（走了太多步）→ 去这一格看看", "");
  /* ⚠️ `\x1b[C`/`\x1b[D` 是**普通光标模式**下的 ←/→。这一格若是应用光标模式（DECCKM）
     就得换成 `\x1bOC`/`\x1bOD` —— 上一行日志里的"应用光标态"就是在说这件事。
     不在下面凭记忆写两个分支：本项目里送 ↑/↓ 用的也是普通序列（`\x1b[A`/`\x1b[B`），
     实测生效过，说明这一屏不是应用光标模式。 */
  t.stream.send(enc.encode(dir > 0 ? "\x1b[C" : "\x1b[D"));
  sendCtrl({ type: "log", msg: `答题 跳问 tab=${t.id} 第${sent + 1}步 ${dir > 0 ? "→" : "←"}` +
    ` 现第${cur + 1}问 预期变「${String(want.q || "").slice(0, 16)}」` });
  const t1 = Date.now();
  const tick = () => {
    const q = readPicker(t);
    if (q && !q.submitScreen && labelSame(q.q, want.q))
      return walkArrived(t, askId, el, qs, next, target, sent + 1, t0);
    if (Date.now() - t1 < 1500) return void setTimeout(tick, 120);
    /* 屏没变 ⇒ 停手，**不重试**：再送一个键就是跳两格。唯一实测过的"←/→ 不换问"的
       情况是高亮压在 `Type something.` 上（那时它是移动文本光标），那一步已经被
       stepHighlight 挡在出发之前了。 */
    stop("跳到这一问没走上（那一格的屏在 1.5 秒里没变）→ 去这一格看看",
      `答题 跳问 tab=${t.id} 停手：第${sent + 1}步按下去了，屏上没变化` +
      `（现「${String((q && q.q) || "").slice(0, 16)}」）用时=${Date.now() - t0}ms`);
  };
  setTimeout(tick, 150);
}

// 走完一步之后：到目标了就收工，没到就接着走（目标可能隔了好几问）
function walkArrived(t, askId, el, qs, at, target, sent, t0) {
  if (at !== target) return walkToQuestion(t, askId, el, qs, at, target, sent, t0);
  const m = screenModel(readPicker(t));
  if (m) askScreen.set(askId, m);      // 刚认过的屏立刻用上，不等那 700ms 那一轮
  jumpBusy.delete(t.id);
  scheduleGroup();
  sendCtrl({ type: "log", msg: `答题 跳问 tab=${t.id} 到了第${target + 1}问 走=${sent}步` +
    ` 屏上「${String((m && m.q) || "").slice(0, 16)}」` +
    ` 进度=${(m && m.steps || []).map((x) => x.join("")).join(" ") || "无"} 用时=${Date.now() - t0}ms` });
}

/* 点了一个选项。闸全过才写那一个字符（多问/多选各多一道，见闸⑤⑥）。 */
function answerFromGroup(t, el) {
  const k = el.dataset.aopt | 0;
  const qi = el.dataset.qidx | 0;              // 第几问（0 基）—— 单问恒为 0
  const box = el.closest(".gask");
  if (!k || !box) return;
  const askId = box.dataset.ai || "";
  const v = LIVE.get(t.id);
  const it = v && (v.acts || []).find((x) => x.id === askId);
  /* 闸①：那条提问**还挂着**（转录说它还没结果）—— 结构化判据，比屏幕硬。
     这一条同时把"换了会话"覆盖掉：tracer 换代（/clear、resume）时 acts 是
     `replace` 整份换掉的，这条 ask 会跟着消失，所以不需要另记一份 sessionId 来比。
     ⚠️ 它管不到"这张提问里的**哪一问**" —— 那件事转录里没有，只在屏上（见闸⑤）。 */
  if (!it || it.ok != null) return answerNote(el, askId, k, "这条提问已经有结果了，没按", qi);
  const qs = it.qs || [];
  const q = qs[qi];
  if (!q) return answerNote(el, askId, k, "这一问已经不在转录里了，没按", qi);
  const multi = !!q.multi, many = qs.length > 1 || multi;
  const want = (q.opts || [])[k - 1];
  if (!want || !want.label) return answerNote(el, askId, k, "这一项已经不在转录里了，没按", qi);
  // 闸②：那一格还活着、PTY 还连着（写进去没地方去，就是白写）
  if (!t.stream || !t.ready) return answerNote(el, askId, k, "那一格的终端没连着，没按", qi);
  /* 闸③：**屏上确实是这个问题**。转录与屏上是两个来源，只信一个就可能把键写到
     别的地方去（比如那一格已经走到下一个问题了）。判据取"不容易碰巧成立"的两样：
     屏上选项数（减掉合成的两项）与转录一致，且第 k 行文字与转录那个 label 对得上。 */
  const p = readPicker(t);
  if (!p) return answerNote(el, askId, k, "那一格屏上没有选择器了，没按", qi);
  /* 闸⑥：**提交屏上没有选项可点**。那一屏只剩两行（`1. Submit answers` / `2. Cancel`），
     数字在那儿是"提交/取消"，送一个选项编号过去 = 丢掉整张答案或者取消掉。 */
  if (many && p.submitScreen)
    return answerNote(el, askId, k, "那一格已经走到提交那一步了 —— 这一屏上的数字是「提交/取消」，点不动选项，按行里的「提交」", qi);
  /* 闸⑤（多问）：屏上现在问的必须是**这一问**。多问是一问一屏、编号每问从 1 重来 ——
     你点第 2 问的第 3 项时屏上若正问第 1 问，那个 `3` 会**答到第 1 问上去**，静默答错。
     单问（含"只有一问的多选"）没有这层歧义，不设这道闸。 */
  if (qs.length > 1) {
    const sm = askScreen.get(askId);
    if (!sm || !labelSame(sm.q, q.q))
      return answerNote(el, askId, k,
        sm ? `那一格现在问的是「${String(sm.q || "").slice(0, 16)}」，不是这一问，没按`
           : "还没读到那一格的屏，没按", qi);
  }
  const n = (q.opts || []).length;
  if (p.max !== n + 2)
    return answerNote(el, askId, k, `屏上选项数对不上（屏上 ${Math.max(0, p.max - 2)} 项 / 转录 ${n} 项），没按`, qi);
  if (!labelSame(p.opts[k], want.label))
    return answerNote(el, askId, k, `屏上第 ${k} 行与转录对不上（屏上「${(p.opts[k] || "").slice(0, 16)}」），没按`, qi);
  // 闸④：高亮别压在合成行上（见文件头那段：那一行是输入框，会把数字当打字吃掉）
  stepHighlight(t, k, n, 0, (why) => {
    if (why) return answerNote(el, askId, k, why, qi);
    // 多问/多选按下去之后屏会变，判据换成"屏变没变"（见 watchScreenStep），
    // 所以先把按之前那一屏读下来。
    const before = many ? screenModel(readPicker(t)) : null;
    t.stream.send(enc.encode(String(k)));
    sendCtrl({ type: "log", msg: `答题 按=${k} tab=${t.id}「${want.label.slice(0, 24)}」问=「${String(q.q || "").slice(0, 24)}」` +
      (multi ? "（多选：只切勾选，不前进）" : "") });
    if (many) watchScreenStep(t, askId, el, k, before, qi, { label: want.label, multi });
    else watchAnswerEcho(t, askId, el, k, qi);
  });
}

/* 多问/多选那一步「提交」—— 用户点了行里那颗键。三条：
     · 已经在提交屏上（多问答完自动停在那一屏 / 多选刚回车进来）⇒ 直接按
     · 多选、屏上还有那一项没编号的 `Submit` ⇒ 高亮走过去、回车进提交屏，再按
     · 多问、还没到提交屏 ⇒ **一个字节都不送**（那几问没答完，提交这一步还不存在） */
function submitFromGroup(t, el) {
  const box = el.closest(".gask");
  const askId = (box && box.dataset.ai) || "";
  const v = LIVE.get(t.id);
  const it = v && (v.acts || []).find((x) => x.id === askId);
  if (!it || it.ok != null) return answerNote(el, askId, 0, "这条提问已经有结果了，没按", 0);
  if (!t.stream || !t.ready) return answerNote(el, askId, 0, "那一格的终端没连着，没按", 0);
  const qs = it.qs || [];
  const multi = qs.some((x) => x && x.multi);
  const p = readPicker(t);
  if (!p) return answerNote(el, askId, 0, "那一格屏上没有选择器了，没按", 0);
  if (p.submitScreen) return pressSubmit(t, askId, el, p);
  if (!multi) return answerNote(el, askId, 0, "这一屏上还没有提交那一步（把这几问答完，它自己会停在提交那一步）", 0);
  gotoSubmitRow(t, askId, el, 0);
}

/* 多选：把高亮走到那一项**没有编号的 `Submit`** 上，再回车进提交屏（实测的走法
   `1→2→…→Type something→Submit→Chat about this`，所以一路 ↓ 会先撞上 Submit）。
   ⚠️ ↓ 到最下面会**夹住**，那时改按 ↑ 换条路找 —— ↑/↓ 只是移动，按错也不会作答。 */
function gotoSubmitRow(t, askId, el, tries) {
  const p = readPicker(t);
  if (!p) return answerNote(el, askId, 0, "那一格的屏读不到了，没按", 0);
  if (p.submitScreen) return pressSubmit(t, askId, el, p);
  if (p.hiSubmit) {
    t.stream.send(enc.encode("\r"));         // 回车 = 进提交屏
    sendCtrl({ type: "log", msg: `答题 提交 tab=${t.id} 高亮已在 Submit 行，送回車` });
    return waitSubmitScreen(t, askId, el, 0);
  }
  if (tries >= 8) return answerNote(el, askId, 0, `高亮走不到「Submit」那一行（停在第 ${p.hi} 行），没按`, 0);
  // 每一步都要留痕：这一路是往活着的 agent 里敲的键，事后必须能数出来敲了哪几下
  // （没有这条日志时，"高亮本来就在 Submit 上"和"走了四步才到"读起来一模一样）
  sendCtrl({ type: "log", msg: `答题 提交 tab=${t.id} 挪高亮 第${tries + 1}步 现第${p.hi}行` +
    `（${p.hi >= p.max ? "已在末行，↑" : "↓"}）` });
  t.stream.send(enc.encode(p.hi >= p.max ? "\x1b[A" : "\x1b[B"));
  setTimeout(() => gotoSubmitRow(t, askId, el, tries + 1), 180);
}

/* 回车之后等提交屏出现。那一屏是**屏上的事实**（`Review your answers`），读一眼就知道；
   读不到就停在这儿说实话，绝不往下猜着送键。 */
function waitSubmitScreen(t, askId, el, tries) {
  const p = readPicker(t);
  if (p && p.submitScreen) return pressSubmit(t, askId, el, p);
  if (tries >= 10) return answerNote(el, askId, 0, "回车之后那一格没走到提交屏 → 去这一格看看", 0);
  setTimeout(() => waitSubmitScreen(t, askId, el, tries + 1), 200);
}

/* 按提交。**每一步都先读屏**：认得出"第 1 行是提交"才送那一个 `1`（实测数字键在提交屏
   上是直接生效的）；认不出来就什么都不送 —— 那一屏只剩"提交/取消"两行，送错一个数字
   就是丢掉整张答案或者把手填的答案取消掉。 */
function pressSubmit(t, askId, el, p) {
  p = p || readPicker(t);
  if (!p || !p.submitScreen) return answerNote(el, askId, 0, "那一格已经不在提交屏上了，没按", 0);
  const sub = Object.keys(p.opts).map(Number).find((x) => /^Submit/.test(p.opts[x] || ""));
  if (sub !== 1)
    return answerNote(el, askId, 0, `提交屏上没认出一行是「提交」（第 1 行是「${(p.opts[1] || "").slice(0, 16)}」），没按`, 0);
  t.stream.send(enc.encode("1"));
  sendCtrl({ type: "log", msg: `答题 提交 tab=${t.id} 提交屏第1行「${(p.opts[1] || "").slice(0, 20)}」送=1` });
  watchAnswerEcho(t, askId, el, 1, 0);      // 这一步的判据回到转录：整张提问当场收尾
}

/* 转录里落下来的答案长什么样：单选是那一项 label 原样，多选是 `"Red, Blue"`
   （逗号+空格连起来，实测格式）。已答之后要照它把标记画回去，所以在这里拆开。 */
function answerLabels(v, multi) {
  const s = String(v == null ? "" : v);
  const out = new Set();
  if (!s) return out;
  if (multi) { for (const p of s.split(/,\s*/)) if (p) out.add(p); }
  else out.add(s);
  return out;
}

/* 能点吗？—— 这是**渲染那一刻**就判得出来的部分（剩下那些闸要读屏，见上面）。
   多问/多选现在也做了，但"哪一问此刻是活的、到没到提交那一步"只在屏上，这一层答不了
   ⇒ 这里只管"这一块能不能有活的东西"，逐行的死活交给 askHTML 的 `cur`/`atReview`。 */
function askClickable(a, t) {
  const qs = a.qs || [];
  if (a.ok != null) return { on: false, why: "" };         // 已回答：什么都不必说
  if (!qs.length) return { on: false, why: "" };           // 没有结构化选项，只有原文
  if (!t || !t.stream || !t.ready) return { on: false, why: "那一格的终端没连着" };
  return { on: true, why: "" };
}

/* 「它在等你答」——两态同一行（照 Orca 的 AwaitingInputRow）：等待态和已答态长在
   同一个位置，答完之后那句话还在，还能选中复制（不是答完就消失）。

   **多问/多选也是一次只画一屏**（照终端：它也一次只问一屏，屏上那条
   `← ☐ Color ☒ Size ✔ Submit →` 就是进度）。几问几选一次性全摊开是不行的 ——
   问题一多、选项一多、preview 一多，这一行会长到没法读（用户 2026-10-16 指出的），
   而终端那边本来就是一问一屏。所以这里：**进度条 + 只画屏上正问的那一问**。
   已答之后（`done`）：一问一行「问 → 答」（要看的是结果不是选项），原文与选项收进
   一个 <details> —— 仍在、仍能选中复制，只是不再占高度。

   多选在选项前画勾选框（**勾选态按屏同步**，见 syncAskScreens）；行尾那颗「提交」
   的"能不能按"由**屏上的进度**定，不由转录定。

   `open` = 用户亲手点开过这一张（见 askOpen）。**默认收着**（`.hd`，只出表头那一行
   `在等你答 · 问题原文` + 一颗「作答」），他点开过的那张才摊开（`.usr`，正身可见）。 */
function askHTML(a, t, open) {
  const qs = a.qs || [];
  const done = a.ok != null;
  const ans = a.answers || {};
  const clk = askClickable(a, t);
  const many = qs.length > 1 || !!(qs[0] && qs[0].multi);
  const multi = qs.some((q) => q && q.multi);
  // 屏上读数（正问哪一问 / 哪几项勾着 / 进度条 / 到没到提交）—— 转录里这些一概没有
  const sm = many ? (askScreen.get(a.id) || null) : null;
  const atReview = !!(sm && sm.review);
  const picks = answerPick.get(a.id) || {};   // 我替它按过的（单问单选），只用来显示
  const err = answerErr.get(a.id) || null;
  let shown = false;              // 那句话落进某个选项行了没（没落就落到块尾，见下）
  const valOf = (q, qi) => (done ? ans[q.q] : picks[qi]);

  /* 一问的正文：问题 + 选项。mode 三种 ——
       "cur"   此刻点得动（带 data-aopt，真正的闸在 answerFromGroup）
       "off"   点不动：做灰 + title 说为什么（⛔ 不做禁：禁了 title 不弹）
       "plain" 只读的原文（已答之后展开看用：**不着灰**，那是记录不是清单） */
  const qBlock = (q, qi, mode, why) => {
    const picked = done ? answerLabels(ans[q.q], !!q.multi) : null;
    /* 屏上正问的**是这一问**时，用屏上那个 `✔` 当准（终端里回看已答的一问就画它）——
       它比我们自己记的那份更真：用户在终端里回去改过答案，我们的记录就旧了。 */
    const smN = (sm && sm.q && labelSame(sm.q, q.q))
      ? Object.keys(sm.picked || {}).map(Number).find((n) => sm.picked[n]) : undefined;
    let h = `<div class="qt${mode === "off" ? " off" : ""}">${md(q.q || "")}</div>`;
    (q.opts || []).forEach((o, i) => {
      // 你选的那一项：加一个实心标记（不用色块 —— 一个色只讲一件事）
      const mark = done ? picked.has(o.label || "")
        : (q.multi ? !!(sm && sm.checks[i + 1])
          : (smN ? smN === i + 1 : !!(valOf(q, qi) && valOf(q, qi) === o.label)));
      const cls = "gopt" + (q.multi ? " multi" : "") + (mark ? " picked" : "") +
        (mode === "cur" ? " act" : (mode === "off" ? " off" : ""));
      // 点得动的那一行才带 data-aopt（"按第几个键"）+ data-qidx（"第几问"）；
      // 灰的那一行把为什么写在 title 上（本仓库的规矩：不可用的动作做灰、不做禁 ——
      // 禁了 title 不弹）。
      const attrs = mode === "cur"
        ? ` data-aopt="${i + 1}" data-qidx="${qi}" title="替你按 ${i + 1}（在这一格里等同选这一项${q.multi ? "，多选：点上/点掉" : ""}）"`
        : (mode === "off" && why ? ` title="${esc(why)}"` : "");
      const hit = !!err && err.k === i + 1 && (err.qi | 0) === qi;
      if (hit) shown = true;
      h += `<div class="${cls}"${attrs}>` +
        // 勾选框画在 label **里面**（.lb 是块级，放外面会另起一行）
        `<div class="lb">${q.multi ? `<span class="gcb">${mark ? "✔" : ""}</span>` : ""}${esc(o.label || "")}</div>` +
        (o.desc ? `<div class="ds">${esc(o.desc)}</div>` : "") +
        // preview 是**多行**的预排块（✓/✗ 对齐列表），所以用 <pre> 原样吐 ——
        // 它在 Go 那边是 cutRunes 截的（保留换行），这里再用 pre 保住版面。
        (o.prev ? `<pre>${esc(o.prev)}</pre>` : "") +
        (hit ? `<div class="qerr">${esc(err.text)}</div>` : "") +
      `</div>`;
    });
    return h;
  };

  /* 终端里那一问的清单其实有 **N+2 项**：转录给的 N 个真选项之外，还有两项**合成的** ——
     `N+1. Type something.`（自己写，那一行在终端里是个输入框）和 `N+2. Chat about this.`
     （接一句话给 agent）。它们**不在转录的 options[] 里**，但用户在终端里看得见 ——
     群里不画它们就是"界面替你删掉了两个可选项"（用户 2026-10-16 指出的）。
     ⚠️ 它们在这一格里**点不成**：送 `N+1` 这个编号的语义没实测过（高亮压在 Type 上时
     那一行会把字符当打字吃掉），所以不猜。做灰 + 点它 = 进那一格自己写
     （不可用的动作做灰、不做禁、不做隐）。 */
  const SYNTH = [["自己写一个答案", "Type something."], ["顺便说一句", "Chat about this."]];
  const synthHTML = (qi) => SYNTH.map(([t, en], j) => {
    const n = ((qs[qi] || {}).opts || []).length + 1 + j;
    return `<div class="gopt syn" data-go="1" title="终端里这一问还有第 ${n} 项：${en}` +
      ` —— 它只能在那格上敲（自己写答案 / 接一句话），点这里进那一格">` +
      `<div class="lb">${esc(t)}<span class="en">${esc(en)}</span>` +
      `<span class="hint">→ 去这一格写</span></div></div>`;
  }).join("");

  // 屏上正问的是第几问（读不到屏，或屏上那句对不上，就退成"第一个还没答的"，再退成第一问）
  const curIdx = () => {
    if (sm && sm.q) {
      const i = qs.findIndex((q) => labelSame(sm.q, q.q));
      if (i >= 0) return i;
    }
    const j = qs.findIndex((q, qi) => !valOf(q, qi));
    return j >= 0 ? j : 0;
  };
  const curQ = curIdx(), cur = qs[curQ] || null;
  const curWhy = clk.why ||
    (atReview ? "那一格已经走到提交那一步了（这一屏上的数字是「提交/取消」）" : "");
  const canClick = !done && clk.on && !atReview;
  /* "有结果"和"答上了"是两件事（实测）：在提交屏上选「2. Cancel」= 拒答并**打断整个
     回合**，转录里落的是 `toolUseResult:"User rejected tool use"` + 一条
     `[Request interrupted by user for tool use]`，**一个答案都没有**。那时写"已回答"
     就是界面在撒谎（同"答了 No 不算完成"那条产品规则）。 */
  const declined = done && !Object.keys(ans).length;
  const dNote = declined
    ? `<div class="gnote">它没被答掉 —— 那一轮被打断了（或者是在那一格里拒绝作答）</div>` : "";
  // 一问一行的「问 → 答」
  /* 「（没答）」和「（没读到）」是两件事：进度条上那一格的标记说了这一问答过没有
     （☐ 没答 / ☒ 答过）—— **分得出来就不能混着说**。实测里在提交屏上就见过这个形状：
     只答了第 3 问，屏上明写 `☐Color ☐Size ☒Speed`，前两问却在写"没读到"。
     进度条读不到时才退回「（没读到）」—— 那才是"我不知道"。 */
  const notAsked = (qi) => {
    const st = sm && sm.steps && sm.steps[qi];
    return !!st && st[0] === "☐";
  };
  const qaRows = () => qs.map((q, qi) => {
    const v = valOf(q, qi);
    /* 已答（done）时那一格的答案**来自转录**：`answers` 是按问题原文做键的，而 Go 侧
       对 question 不截断（transcript.go:829 只 TrimSpace）⇒ 转录里没有这一问的键 =
       它**没被答**，不是"我们没读到"。两句话混用就是在替界面认一个它并不缺的知识
       （实测就是：只答了第 3 问，前两问明明没答，却在写"没读到"）。 */
    const miss = (done || notAsked(qi)) ? "（没答）" : "（没读到）";
    return `<div class="qa"><span class="qi">${esc(q.q || "")}</span>` +
      `<span class="qv">${v ? md(v) : miss}</span></div>`;
  }).join("");

  let body = "";
  if (done && many) {
    // 多问答完：一问一行「问 → 答」（要看的是结果），原文与选项收进 <details>
    body = dNote + qaRows() +
      `<details class="grec"><summary>看原文与选项（${qs.length} 问）</summary>` +
      qs.map((q, qi) => qBlock(q, qi, "plain", "")).join("") + `</details>`;
  } else if (done) {
    // 一问答完：块本来就小，就照旧（问题 + 选项，选中的那项带 ✓）—— 收起来反而要把
    // "当时还有哪些别的选项"藏掉
    body = (cur ? qBlock(cur, 0, "plain", "") : "") + dNote;
  } else if (many) {
    /* 进度条：照屏上那条 `← ☐ Color ☒ Size ✔ Submit →`。每一格还能**点着跳问** ——
       终端里换问的键实测是 `←`/`→`（两向都非破坏），见 jumpToQuestion。 */
    const steps = (sm && sm.steps) || null;
    // 正在跳向哪一问（跳的过程中那一格画成 jmp）—— 只影响观感，闸在 jumpToQuestion 里
    const jmpTo = jumpBusy.get(t.id);
    if (steps && steps.length) {
      // Submit 那一格是**动作**，行尾那颗「提交」已经在说它了，不在这儿重复一遍
      const items = steps.filter(([, label]) => !/^(Submit|提交)$/.test(label));
      /* ⚠️ 进度条上写的是**表头**（`Color`），不是问题原文（`Pick one color`）——
         拿它跟屏上那句问题对不上。顺序是一一对应的（几个问题就几格，Submit 在最后
         已被滤掉），所以"现在问到第几问"直接用下标，不按文字比。 */
      body += `<div class="gsteps">` + items.map(([m, label], i) => {
        const isCur = i === curQ;
        const v = picks[i];
        /* 当前那一问没有动作可做（它就是屏上那一屏）⇒ 不给 data-jstep；
           其余每一格挂 data-jstep="第几问"（0 基），点它 = 在终端里按 ←/→ 走过去。 */
        const jump = canClick && !isCur;
        return `<span class="gstep${isCur ? " cur" : ""}${m !== "☐" ? " ok" : ""}` +
          `${jump ? " go" : ""}${jmpTo === i ? " jmp" : ""}"` +
          (jump ? ` data-jstep="${i}"` : "") + ` title="` +
          esc(isCur ? "正在问这一问"
            : (jump ? `跳到这一问（在那一格里按 ←/→ 走过去${v ? `；它已经答过：${v}，走过去可以让它重答` : ""}）`
                    : v ? `已经答过：${v}` : m !== "☐" ? "已经答过" : "还没问到这里")) +
          `">${esc(m)} ${esc(label)}</span>`;
      }).join("") + `</div>`;
    } else {
      body += `<div class="gnote">还没读到那一格的屏（它一问一屏，这里跟着那一格刷新）</div>`;
    }
    body += atReview
      ? `<div class="qt">已经在提交那一步了</div>` + qaRows()
      // 提交屏上没有那两项合成项（那儿只有"提交/取消"两行），别在那儿画
      : (cur ? qBlock(cur, curQ, canClick ? "cur" : "off", curWhy) + synthHTML(curQ) : "");
  } else {
    body = cur ? qBlock(cur, 0, canClick ? "cur" : "off", curWhy) + synthHTML(0)
               : `<div class="qt">${esc(a.text || "它有一件事要问你")}</div>`;
  }
  if (!body) body = `<div class="qt">${esc(a.text || "它有一件事要问你")}</div>`;
  // 行尾那颗「提交」：多问/多选才有这一步。能不能按由**屏上的进度**定 ——
  // 到提交屏了（多问答完自己停在那儿 / 多选刚回车进来）就能按；不能按就做灰 + title。
  let subBtn = "";
  if (!done && many) {
    const usable = !!sm && (atReview || (multi && sm.submitRow));
    const why = usable ? "" :
      !sm ? "还没读到那一格的屏（多问/多选要跟着屏上的进度走）"
        : multi ? "那一屏上还没有「Submit」那一行"
        : "这几问还没答完（答完它自己会停在提交那一步）";
    subBtn = `<button class="go sub${usable ? "" : " mute"}"` +
      (usable ? ` data-submit-ask="${esc(a.id || "")}"` : (why ? ` title="${esc(why)}"` : "")) +
      `>提交</button>`;
  }
  /* 收起来的那一态（`.hd`）：表头必须**带着问题原文** —— 否则整张卡只剩
     "在等你答"一行，看不出它在问什么。取屏上正问的那一问（读不到就退成第一问）。 */
  const hodQ = (cur && cur.q) || (qs[0] && qs[0].q) || a.text || "";
  return `<div class="gask${done ? " done" : ""}${open ? " usr" : " hd"}" data-ai="${esc(a.id || "")}">` +
    `<div class="qh"><span>${done ? (declined ? "没被答掉" : "已回答") : "在等你答"}</span>` +
      (many ? `<span>· ${qs.length} 问${multi ? "，多选" : ""}</span>` : "") +
      // 摊开的时候问题在正身里（.qt），收起来的时候搬到这儿 —— 同一个事实只画一处
      `<span class="hdq">· ${esc(clamp(hodQ, 90))}</span>` +
      /* 「作答 ▾」/「收起 ▴」：**纯本地**的一颗键（不碰终端），所以不守"有选中文本
         时不动作"那条（那条是给"往活着的 agent 里写键"用的）。CSS 决定它什么时候
         露面：收着（.hd）或用户自己摊开的（.usr）才露。 */
      (!done ? `<button class="open" data-ask-open="${esc(a.id || "")}"` +
        ` title="这一块摊开来有点高，先收着 —— 点它摊开（不碰终端）">` +
        `<span class="t-exp">作答 ▾</span><span class="t-col">收起 ▴</span></button>` : "") +
    `</div>` +
    `<div class="qb">${body}</div>` +
    // 对不上任何选项行的那句话（比如"提交"那一步没过闸）落到**块尾** —— 不落的话
    // 它根本不会出现（页面重画后也读不回来）。
    (err && !shown ? `<div class="qerr">${esc(err.text)}</div>` : "") +
    `<div class="gf"><span>${esc(rel(a.at))}</span>` +
      // 这颗键**两态都在**（那件事"去那一格"始终有效），只是换一句话说它为什么
      // 值得去 —— 答完之后还写着"去回答"就是界面在撒谎。
      subBtn +
      `<button class="go" data-go-ask="${esc(a.id || "")}">` +
        (done ? "去这一格 →" : "去这一格回答 →") +
      `</button>` +
    `</div></div>`;
}

/* 「作答 ▾ / 收起 ▴」：就地摊开/收起那一张待办卡。
   ⚠️ 这一颗键**不碰终端**（它只是把已经画好的那一块亮出来），所以不守"有选中文本
      时不动作"那条 —— 那条是给"往活着的 agent 里写键"用的（见 answerFromGroup）。
   展开态**按 ask id 记**（`askOpen`），不按格：一格前后会有好几张提问，按格记会让
   下一张凭空继承上一张的展开态。 */
function toggleAskOpen(t, card) {
  if (!card) return;
  const id = card.dataset.ai || "";
  const wantOpen = card.classList.contains("hd");    // 现在是收着的 ⇒ 点它 = 摊开
  card.classList.toggle("hd", !wantOpen);
  card.classList.toggle("usr", wantOpen);
  if (wantOpen) askOpen.add(id); else askOpen.delete(id);
  uiFact("group", groupFacts());
  sendCtrl({ type: "log", msg: `群组 待办卡${wantOpen ? "摊开" : "收起"}（用户点的）` +
    ` 格=${t.id} ask=${id}` });
}

/* 「去那一格」= 收起展开 + 回网格（在看独立页时）+ 切到它 + 闪两下。
   ⚠️ 顺序不能反：先 setTermCollapsed(false) 再 jumpToTab —— 在 display:none 的
      盒子上 focus() 不生效（setActive 会把焦点交给终端）。 */
function goToTab(t, why) {
  if (!t) return;
  sendCtrl({ type: "log", msg: `群组 → 进格 ${t.id}（${why}）` });
  setTermCollapsed(false);
  jumpToTab(t, why);   // 它自己会处理 soloTab，并闪两下
}

function renderGroup() {
  if (!collapsed) return;
  const head = $("group-head"), list = $("group-list");
  if (!head || !list) return;
  renderGroupHead(head);
  renderGroupList(list);
  uiFact("group", groupFacts());
}

// 群组那一屏的读数（只在变了的时候进日志，见 uiFact）
function groupFacts() {
  const rows = groupRows();
  const first = rows[0];
  const asked = rows.filter((r) => r.ask).length;
  const hd = $("group-list") ? $("group-list").querySelectorAll(".gask.hd").length : 0;
  return `行=${rows.length}` +
    (first ? ` 排首=格${first.t.id}/${first.st}${first.ask ? "(挂着问题)" : ""}` : "") +
    // 待办卡是这一屏**唯一**会长高的东西 ⇒ 它几张、几张收着，是这块面最重要的读数
    ` 待办=${asked}收着=${hd} 口开=${askOpen.size}` +
    ` 格宽=${Math.round($("group").getBoundingClientRect().width)}`;
}

// 三处点击：顶部条一枚 = 去那一格；待办卡里那些动作 = 就地做；行本身 = 去那一格。
$("group").addEventListener("click", (e) => {
  const chip = e.target.closest(".gchip");
  if (chip) { goToTab(liveTab(chip.dataset.gtab | 0), "点顶部条"); return; }
  if (e.target.closest("#group-add")) { newParallelTab("群组那排 +"); return; }
  const row = e.target.closest(".grow");
  if (!row) return;
  const t = liveTab(row.dataset.gtab | 0);
  if (!t) return;
  // 「进入 →」和「去这一格回答 →」都是同一个动作
  if (e.target.closest("[data-go],[data-go-ask]")) { goToTab(t, "点动作"); return; }
  /* 「点选项作答」：点的是选项行本身 ⇒ 往那一格的 PTY 写一个键（见 answerFromGroup）。
     ⚠️ 和下面点气泡同一条规矩：**有选中文本时不动作** —— 这份清单是用来读和选字
        复制的（Orca 那条"回答之后仍能选中原文"），一点就替人作答等于把"读"变成"改"。 */
  const opt = e.target.closest(".gopt");
  if (opt) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    answerFromGroup(t, opt);
    return;
  }
  /* 多问/多选那一步「提交」（见 submitFromGroup）。同一条规矩：**有选中文本时不动作**。 */
  const sub = e.target.closest("[data-submit-ask]");
  if (sub) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    submitFromGroup(t, sub);
    return;
  }
  /* 进度条上的一格 = 跳到那一问（见 jumpToQuestion）。终端里换问的键实测是 ←/→，
     两向都非破坏；这一步和"作答"一样是**往活着的 agent 里写键**，所以也守
     "有选中文本时不动作"这条（进度条本身也是能选中复制的）。 */
  const st = e.target.closest("[data-jstep]");
  if (st) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    jumpToQuestion(t, st);
    return;
  }
  /* 「作答 ▾ / 收起 ▴」= 就地摊开这张卡（见 toggleAskOpen）。
     ⚠️ 它**不碰终端**，所以上面那三条"有选中文本时不动作"对它不适用。 */
  if (e.target.closest("[data-ask-open]")) { toggleAskOpen(t, e.target.closest(".gask")); return; }
  /* 卡里的其余落点（表头、问题原文、选项说明、时间）= **什么都不做**。
     这张卡是"读 + 动手"的地方：点它一下不该跳到别的格（清单要能选字复制，一点就
     跳走等于"读不了"），而卡里真正的动作各自带 data-*，已经在上面接住了。 */
  if (e.target.closest(".gask")) return;
  /* 剩下的落点（行头那三行本身）= **进那一格**。这一屏是看板：点一行就是"看这一格"
     （用户的原话："点击气泡进入具体 agent 的终端面板"）—— 原来那句"就地展开一段流"
     已经没有了（见 #group-list 上面那段）。 */
  goToTab(t, "点这一行");
});

