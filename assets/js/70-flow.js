"use strict";
/* 70-flow.js —— 会话卡片 HTML、右下段对话流（live/历史）、跟随与折叠。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 6703-7410（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

// 卡片行尾那两颗图标。内联 SVG 而不是字符：▶ 和 ⋯ 的字宽/基线随字体变，
// 落在网格里会歪；项目里其它图标也都是这么来的。
// ⚠️ 声明放在 cardHTML **上面**：const 是 TDZ 的，万一哪天有人在模块求值期间
// 就叫到 cardHTML（这里踩过一次同类的坑，见 createTab 里 `ready` 那段），
// 它会抛 ReferenceError 而不是画一张少了图标的卡。
const ICON_PLAY = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.2v13.6L19 12z"/></svg>`;
// lucide square（停止）。和 ICON_PLAY 同一个尺寸/笔法 —— 它们并排出现的机会很多。
const ICON_STOP = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>`;
const ICON_DOTS = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>`;

function cardHTML(s) {
  const perm = s.permission === "auto" ? `<span class="chip">auto</span>`
    : s.permission ? `<span class="chip warn">${esc(s.permission)}</span>` : "";
  const branch = s.branch ? `<span class="chip br" title="${esc(t("flow.gitBranch"))}">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7M18 6a6 6 0 0 1-6 6"/><circle cx="18" cy="6" r="2.5"/></svg>
      <span class="x">${esc(s.branch)}</span></span>` : "";
  const repo = s.cwd ? `<span class="chip" title="${esc(s.cwd)}"><span class="x">${esc(shortPath(s.cwd))}</span></span>` : "";
  const atype = s.agentType ? `<span class="chip" title="${esc(t("flow.agentType"))}"><span class="x">${esc(s.agentType)}</span></span>` : "";
  const agents = s.agents ? `<span class="pill b" title="${esc(t("flow.subagentSession"))}">◈ ${s.agents}</span>` : "";
  const turns = s.turns ? `<span class="pill" title="${esc(t("flow.turnsTitle"))}">${esc(tCount("flow.turnsPill", s.turns))}</span>` : "";
  const size = s.bytes ? `<span class="pill" title="${esc(t("flow.fileSize"))}">${(s.bytes / 1048576).toFixed(1)}M</span>` : "";
  // 子代理卡：图标换成绿色分支点、加一枚「子代理」标记，和主会话一眼可分
  const icon = s.sidechain
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.9" style="flex:none"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--claude)" stroke-width="1.9" style="flex:none"><path d="M5 6l5 6-5 6M13 18h6"/></svg>`;
  const sideTag = s.sidechain ? `<span class="pill g">${esc(t("flow.subagent"))}</span>` : "";
  /* C7：子代理卡的第二行从「类型 + 分支」换成「类型 + **来自哪条会话**」。
     分支对子代理没有信息量 —— 它是从主会话兜过来的（store.go:209-211）；
     而"这条子代理是谁派出来的"，正是用户说的"根本不知道有什么区别"里最缺的那条。
     （Orca 那边区分兄弟子代理靠的是 label + parentId + 重名时补一个序号，
      native-chat-types.ts:142-154。) */
  const parent = (s.sidechain && s.parent)
    ? (STATE?.sessions || []).find((v) => v.id === s.parent) : null;
  const fromFull = (parent && sessionTitle(parent)) || String(s.parent || "?");
  const fromShort = (parent && sessionTitle(parent)) || fromFull.slice(0, 8);
  const fromChip = s.sidechain
    ? `<span class="chip" title="${esc(t("flow.fromTitle", { name: fromFull }))}"><span class="x">${esc(t("flow.from", { name: fromShort }))}</span></span>`
    : "";
  /* C7：状态签。st === "" 表示**判不出来**（判据见 subStateOf）—— 那时候什么都不画，
     而不是猜一个"已完成"：会话库里几十张老卡，猜错一次就是"我以为它跑完了"。
     why 单独抽成 cardSubWhy 是因为它还得被 refreshSubChips 用（状态会过期，见那儿）。 */
  const subst = s.sidechain ? subStateOf(s) : "";
  /* 行尾两颗（照 Orca 的"常驻预算"）：⋯ 永远在，「接上」在 hover/聚焦时浮出。
     ⚠️ 接不上时**做灰不做隐**（Orca 的 resumeDisabled 就是这个意思）：藏起来用户
     只会觉得"这个功能没有"，做灰 + title 才说得清"为什么这条接不上"。
     判据全是本地能确定的（见 resumeWhy）——"正被别的格子跑着"那条前端判不了，
     由 Go 拒绝 + toast 说明，这里不猜。 */
  const why = resumeWhy(s);
  const resumeBtn = `<button class="cardbtn${why ? " na" : ""}" data-act="resume"
    title="${esc(why || t("flow.resumeCard"))}">${ICON_PLAY}</button>`;
  return `<div class="card${s.sidechain ? " side" : ""}" role="button" tabindex="0"
    data-id="${esc(s.id)}" title="${esc(sessionTitle(s))}\n${esc(s.cwd || "")}">
    <span class="t">
      ${icon}
      <span class="nm ell">${esc(sessionTitle(s))}</span>
      <span class="cardacts">
        <span class="hgroup">${resumeBtn}</span>
        <button class="cardbtn" data-act="menu" title="${esc(t("shell.proj.more"))}">${ICON_DOTS}</button>
      </span>
    </span>
    <span class="r2">${s.sidechain ? atype + fromChip : repo + branch + perm}</span>
    ${s.preview ? `<span class="p ell2" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(s.preview)}</span>` : ""}
    <span class="r3">${rel(s.updated)}<span class="t2" style="display:flex;gap:5px;align-items:center">${subChipHTML(subst, s.id, cardSubWhy(s, subst), s.id)}${sideTag}${turns}${agents}${size}</span></span>
  </div>`;
}

/* 这条会话"现在能不能接"的**本地**判据，返回 null = 能。
   只有两种，都是这张卡片自己身上就看得出来的事实：

   · sidechain（子代理会话）：它的 id 不是一条独立会话（文件在
     <主会话>\subagents\agent-<hex>.jsonl），`--resume` 拿它起不来。
     这也正是 Go 那边 sessionFileExists 会拒掉的那一类 —— 两侧判据一致，
     只是这里能提前做灰。
   · turns == 0：这条会话没存下往来。Orca 对同一件事有专门一态：
     "Conversation not saved" / "This session has no saved conversation and
     cannot be resumed."（AiVaultSessionUnsavedNotice.tsx:28-43）。

   ⚠️ 第三种"正被别的格子跑着"**故意不在这里判**：权威的「谁占着谁」表在 Go 的
   tabManager.bySession 里，前端手上没有会话 id。硬猜会得到第二个、偶尔和 Go
   矛盾的答案源 —— 那比没有更糟。 */
function resumeWhy(s) {
  if (!s) return t("flow.whyNoSession");
  if (s.sidechain) return t("flow.whySubagent");
  if (!s.turns) return t("flow.whyNoTurns");
  return null;
}

/* ===========================================================================
   下段「对话流」：主语 + 跟随状态机 + 只追加的渲染

   这三件事缺一件，就有一个"看着像 bug"的行为：

   1. **主语有两种**：当前格（实时，默认）和会话库（你点了哪张卡片）。两者长得
      一模一样，所以头上必须有一枚小签写出来 —— 否则你没法知道这段对话是谁的，
      而"这格怎么在说我没说过的话"是这类界面里最贵的一类误解。
   2. **跟随是一个状态机，不是"离底多少就归位"的一次性判断**（这套照 Orca 的
      `native-chat-autoscroll.ts` 搬）。默认跟着走；**只有读者手势**（滚轮/触摸/
      按键/拖滚动条）能脱离底部 —— 内容变化、程序写入、布局变化都不算；
      回到尾部只有一个条件：距离在**缩小** 且 已经进到 4px 以内。
   3. **两个阈值管两件事**：48px 只决定"跳回最新"那颗按钮显不显示，4px 才是重新
      吸底的线。混用这两个数的症状是"往上滚一点就被拽回去"，那种界面没法读。
   =========================================================================== */
const FLOW_BOTTOM_PX = 48;
const FLOW_REARM_PX = 4;
// 进对话流的四种：你说的 / agent 说的 / 系统条目（子代理回报、跨会话消息…）/
// **上下文压缩节点**（会话内部的一页折叠，既不是你也不是 agent 说的话，见
// compactRowHTML）。
// 工具调用和"思考…"**不进** —— 那是「流水」的活儿。同一栏里两处都画同一件事，
// 那一栏就没有存在的必要了（子代理模块那条同理，见 renderSideLive）。
const FLOW_ROLE = { prompt: "user", text: "agent", system: "sys", compact: "compact" };
const FLOW_TAG = { user: "你", agent: "agent", sys: "系统", compact: "上下文已压缩" };
const FLOW_ICON = {
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.6-3.6 4-5.4 7-5.4s5.4 1.8 7 5.4"/>',
  agent: '<path d="M12 3l2.2 6.1L20.5 11l-6.3 1.9L12 19l-2.2-6.1L3.5 11l6.3-1.9z"/>',
  sys: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>',
};

let flowSub = { kind: "live" };  // {kind:"live"} | {kind:"lib", id}
let flowStamp = "";              // "主语 + 换代"标识：一变就整表重建
/* ⚠️ 追加游标**不能是一个条数**（我第一版就是 `flowDrawn = n`，两处会当场出错）：
   ① Go 那边流水超过 300 条会**从头砍**，砍完之后条数可能比游标还小 ——
      光比条数会得出"没有新内容"，屏上就停在旧内容上；
   ② 同一条消息正文是**边写边长**的（同一个 id 反复覆盖），条数完全不变，
      比条数永远发现不了它该重画。
   所以锚点记 **最后画出的那条的 id**（Orca 的 `Map<id,index>` 是同一件事：
   按 id 定位，而不是按位置）。找不到锚点 = 它被砍了或被换掉了，整表重建。 */
let flowLastId = "";
let flowTexts = new Map();       // id -> 上次画进去的正文（判"这一条变了没有"）
let flowFollowing = true;        // 跟随状态机
let flowPrevDist = 0;            // 上一次量到的离底距离（判"距离在缩小"）
let flowLeaveWhy = "";           // 刚脱离底部的原因（等 scroll 停了再把读数打全）
let flowLeaveTimer = 0;          // 那次"停稳了再记"的定时器
/* 一条正文多长算"太长"（用户 2026-10-16 定的形态：这一栏是监视面，不是阅读面 ——
   一条长报告灌进来，整栏就只剩它一条了）。预算 = 4 行（12.5px × 1.6 = 20px 一行）。
   ⚠️ 这类"多长算长"的数**必须用真实读数标定**（见 [[threshold-defaults-need-calibration]]）：
   "该收的没收"在界面上看不出来（行高不同而已），所以判据和阈值都要进日志。
   ⚠️ 预算只有这一个来源：CSS 变量从它写出去，CSS 里不许再写第二个数。 */
const FLOW_CLAMP_PX = 80;
document.documentElement.style.setProperty("--flow-clamp", FLOW_CLAMP_PX + "px");
const flowOpen = new Set();      // **用户亲手摊开**的那几条（按 id）
const flowFit = new Map();       // id -> {t, fold}：这条在这个宽度下收没收 + 量的是哪一版正文
let flowFoldSig = "";            // 上一次那条读数（变了才回日志，不刷屏）
let flowFoldRaf = 0;             // 尺寸变化时合帧用

function flowHost() { return $("hist"); }
function flowDist() {
  const h = flowHost();
  return h ? Math.max(0, h.scrollHeight - h.clientHeight - h.scrollTop) : 0;
}
function flowStick() {
  const h = flowHost();
  if (h) h.scrollTop = h.scrollHeight;
}
// 主语 → 条目。两种主语的形状在这**归一**成 {role,text,at}，下游只认这一种。
function flowSource() {
  if (flowSub.kind === "lib") {
    const s = (STATE?.sessions || []).find((x) => x.id === flowSub.id);
    const hist = (STATE?.history || {})[flowSub.id] || [];
    /* C7：主语是**子代理会话**时，下段头上要多两件事：它是子代理、现在什么状态。
       这不是装饰 —— 一头扎进某个子代理、却看不出"我在看谁"，是这个模块最容易
       让人读错的地方（子代理的对话流和主会话长得一模一样）。
       状态用 s 上现成的字段现算（subStateOf），**不在这里报日志**：renderFlow
       每次都跑；观察腿在 cardHTML 那一条（每张卡一条，且只在变化时报）。 */
    const st = s && s.sidechain ? subStateOf(s) : "";
    const par = (s && s.sidechain && s.parent)
      ? (STATE?.sessions || []).find((v) => v.id === s.parent) : null;
    return {
      stamp: "lib:" + flowSub.id,
      title: s ? sessionTitle(s) : String(flowSub.id).slice(0, 8),
      from: (s && s.sidechain) ? ((par && sessionTitle(par)) || String(s.parent || "").slice(0, 8)) : "",
      foot: s ? [s.sidechain ? t("flow.subagent") : "", st ? t("sub." + st) : "",
                 `${s.turns || 0}`, `${(s.bytes / 1048576).toFixed(1)}MB`].filter(Boolean).join(" · ") : "",
      items: hist.map((it, i) => ({ id: "lib:" + i, role: it.role === "user" ? "user" : "agent", text: it.text, at: it.at })),
      empty: t("flow.emptyLib"),
    };
  }
  const tab = activeTab; // 别叫 t：会遮住 i18n 的 t()
  const v = tab ? LIVE.get(tab.id) : null;
  const acts = (v && v.acts) || [];
  /* 2026-10-17（用户点名的一条）：右栏这条流**就是 agent 的记录** —— 点一个
     agent，这里呈现的就是它干过什么。所以"实时流水是空的"不能让这一栏说谎：
       · agent 停了（stream 断了）、或者刚重启还在等 tracer 第一帧时，内存里
         这份 acts 可能是空的；
       · 而盘上最后 30 轮已经在 `STATE.history[sessionId]` 里（store.go 的
         tailHistory，启动时扫好的）。
     有实时就用实时（更全、会长），没有就用盘上那一份，并如实标出来源。 */
  const sid = tab && tab.sessionID;
  const lib = (!acts.length && sid) ? ((STATE?.history || {})[sid] || []) : [];
  const items = acts.length
    ? acts.filter((a) => FLOW_ROLE[a.kind]).map((a) => ({
        id: String(a.id || ""), role: FLOW_ROLE[a.kind], text: a.text, at: a.at,
        fullLen: a.fullLen | 0, turn: a.turn | 0, swallowed: a.swallowed | 0,
      }))
    : lib.map((it, i) => ({
        id: "hist:" + i, role: it.role === "user" ? "user" : "agent",
        text: it.text, at: it.at, fullLen: 0, turn: 0, swallowed: 0,
      }));
  return {
    // actsGen 是 Go 那次"整份替换"的代际号（见 applyActs）：它变了就说明这一格
    // 换了会话/页面补发了快照，列表要整表重建而不是接着追加。
    // 末尾那一位是**来源**：实时 ↔ 盘上记录切换时必须重建（两套 id 空间）。
    stamp: `live:${tab ? tab.id : 0}:${((v && v.actsGen) | 0) || 0}:${acts.length ? "l" : "h"}`,
    // 主语是 **agent**，不是格子：头像行叫什么，这里就叫什么（同名来源 = agentRowName）。
    title: tab ? agentRowName(tab) : t("flow.noAgent"),
    /* 行尾读数只放**短**的两样：哪种 agent、这份是不是盘上补的。
       ⚠️ 别把工作区名也塞进来：`.bhead .sub` 是唯一的弹性元素（见它的 CSS 注释），
       行尾一长，第一个被挤成 0 宽的就是**名字** —— 2026-10-17 实测：写成
       「claude · 默认工作区」之后，头上只剩「当前 agent  claude · 默认工作区」，
       agent 叫什么一个字都看不见了。工作区去 h-sub 的 title 里说。 */
    foot: tab ? [(tab.spec && tab.spec.agent) || "claude",
      acts.length ? "" : (lib.length ? t("flow.diskRecord") : "")].filter(Boolean).join(" · ") : "",
    // turn/swallowed 是压缩节点独有的（Go 那边只有 kind=compact 会带，见
    // transcript.go 的 consumeCompact）：第几回合 / 距上次压缩几个回合。
    // 别的条目没有 ⇒ 0，compactRowHTML 见到 0 就不写那截 —— 转录里没有的数不编。
    items,
    empty: (tab && tab.connDown)
      ? t("flow.emptyStopped")
      : t("flow.emptyActive"),
  };
}
/* 正文被截断时**明说**（`fullLen` = 原文总字数，Go 的 msgText 带过来的）。
   只留一个没头没尾的 `…` 是不够的：读的人分不清那是作者写的还是我们砍的
   （实测里就是这么被读错的）。显示前多少字按**手上这条**算，不写死那个上限 ——
   写死就等于让前端去猜 Go 的常量。 */
const truncNote = (it) => (it.fullLen
  ? `<div class="trunc">${esc(t("flow.truncated", {
      full: it.fullLen, shown: (it.text || "").length,
    }))}</div>`
  : "");
/* 压缩节点。它**不是一条发言** —— 是这一栏里的一条极淡分隔线（照 Orca 的
   `Context compacted`：它连正文都不画）。我们比它多一件事：**正文我们手上有**
   （转录里就是那 17–26KB 的摘要字符串），所以它**可展开**；但收起时一个字的
   正文都不出、一行都不占 —— 一屏 2 万字的"用户发言"正是这一轮要修的东西。

   ⚠️ 那两个数（第几回合 / 距上次几个回合）是转录里**真有**的（turnPosition）；
   token 数在转录里**根本不存在**（实测 42 条压缩行，compact_metadata 一次都
   没出现）—— 所以这行永远不写"98k → 21k"，那不是我们量出来的东西。
   缺字段就不写那截，写"上下文已压缩"这五个字也成立。 */
function compactRowHTML(it, open) {
  const meta = [];
  if (it.turn > 0) meta.push(t("flow.turn", { n: it.turn }));
  if (it.swallowed > 0) meta.push(t("flow.sinceCompact", { n: it.swallowed }));
  return `<div class="hit compact${open ? " open" : ""}"${it.id ? ` data-fid="${esc(it.id)}"` : ""}>
    <div class="fh" title="${esc(t("flow.compactTitle"))}">
      <span class="ln"></span>
      <span class="who"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${LUCIDE_FOLD_VERTICAL}</svg></span>
      <span class="rl">${esc(t("flow.tag.compact"))}</span>
      ${meta.length ? `<span class="cm">${esc(meta.join(" · "))}</span>` : ""}
      <span class="ln"></span>
      <span class="tm" data-at="${esc(it.at || "")}">${rel(it.at)}</span>
      <span class="cv" aria-hidden="true"></span>
    </div>
    <div class="tx"><div>${md(it.text || "")}</div></div>
    ${it.fullLen ? `<div class="trunc">${esc(t("flow.compactTruncated", {
      full: it.fullLen, shown: (it.text || "").length,
    }))}</div>` : ""}
  </div>`;
}
function flowRowHTML(it) {
  const r = it.role;
  // 角色的图标**不带色**（单色纪律，见 CSS 里那段）：stroke 走 currentColor，
  // 颜色由 .fh .who 那一处定。三套角色色是原来"丑"的一部分 —— 它和正文抢注意力。
  // 时间戳带 data-at：它是**相对时间**，会随时间走样（见下面的定时刷新）。
  // `open` = 用户亲手摊开过这一条（重建之后还在，见 flowOpen）。
  const open = flowOpen.has(String(it.id || ""));
  if (r === "compact") return compactRowHTML(it, open);
  return `<div class="hit ${r}${open ? " open" : ""}"${it.id ? ` data-fid="${esc(it.id)}"` : ""}>
    <div class="fh">
      <span class="who"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">${FLOW_ICON[r] || FLOW_ICON.agent}</svg></span>
      <span class="rl">${esc(FLOW_TAG[r] ? t("flow.tag." + r) : r)}</span>
      <span class="tm" data-at="${esc(it.at || "")}">${rel(it.at)}</span>
    </div>
    <div class="tx"><div>${md(it.text || "")}</div></div>
    ${truncNote(it)}
    <div class="more"><button type="button" class="mo" data-flow-more="${esc(it.id || "")}" aria-expanded="${open ? "true" : "false"}">${esc(open ? t("flow.collapse") : t("flow.expandDots"))}</button></div>
  </div>`;
}
// 单独一条重画（正文变长了）：只换里那个 div，**不换整行** ——
// 换整行会把时间节点也一起重置，而且正落在这里的鼠标选中会丢。
function flowRedraw(it) {
  const host = flowHost();
  if (!host || !it.id) return;
  const row = host.querySelector(`[data-fid="${CSS.escape(it.id)}"]`);
  if (!row) return;
  const body = row.querySelector(".tx > div");
  if (body) body.innerHTML = md(it.text || "");
  row.querySelector(".tm").dataset.at = it.at || "";
}
/* 那颗「… 其余 N 行 ▾ / 收起 ▴」的按钮。留了多少行是**算出来的**
   （收掉的高度 ÷ 一行高），所以只有在量过之后它才说得准。 */
function flowMoreLabel(el, open, overPx) {
  const b = el.querySelector(":scope > .more .mo");
  if (!b) return;
  const n = Math.max(1, Math.round((overPx || 0) / 20));
  b.textContent = open ? t("flow.collapse") : t("flow.expandRest", { n });
  b.title = open ? t("flow.collapseTitle") : t("flow.expandTitle");
  b.setAttribute("aria-expanded", String(!!open));
}
/* 量一遍"哪几条正文超出了预算"，把结论写进类名（`.fold`）。
   ⚠️ 三个读数是这一块唯一的证据：收着几条 / 面板多大多小 / 最多的溢出多少。
   界面上"该收的没收"和"不该收的收了"长得一模一样（都只是行高不同），
   只有把判据和阈值打进日志才分得清（见 [[threshold-defaults-need-calibration]]）。 */
function flowFoldPass(why) {
  const host = flowHost();
  // ⚠️ 下段折叠着（0 高）的时候**一条都别量**：那时没有可视高度，
  // 量出来全是"溢出"，一展开就是满屏收着态的错样子。
  if (!host || !host.clientHeight) return;
  let folded = 0, opened = 0, seen = 0, maxOver = 0, compacts = 0;
  for (const el of host.children) {
    const id = el.dataset.fid || "";
    if (!id) continue;                       // 空态那一条（.hist-empty）
    /* 压缩节点**不参与这套量法**：它不是"正文太长所以要收起来"，而是
       "默认整页都不出"（收起时是 0 高）。让它进来，量的结果永远是"溢出满满"，
       日志里那个"收着=N 条"就成了一句假话（这一块最容易出的错就是读数说谎）。
       它只报个数 —— 顺手把"这一栏里有几个压缩点"变成读数。 */
    if (el.classList.contains("compact")) { if (el.classList.contains("open")) opened++; compacts++; continue; }
    const tx = el.querySelector(":scope > .tx");
    if (!tx) continue;
    const t = flowTexts.get(id);
    // ⚠️ 摊开的那几条**单算**，不算进"收着"里：日志把二者混成一个数，
    // 就等于在说一件它自己知道不对的事（这一块最容易出的错就是读数说谎）。
    if (el.classList.contains("open")) { opened++; flowFit.set(id, { t: t, fold: true }); continue; }
    const c = flowFit.get(id);
    // 正文没变过就别再量（300 条全量 scrollHeight = 每帧一次布局抖动）
    if (c && c.t === t) { if (c.fold) folded++; continue; }
    seen++;
    const over = tx.scrollHeight - tx.clientHeight;   // max-height 生效 ⇒ 这差就是被收掉的高度
    const fold = over > 2;
    el.classList.toggle("fold", fold);
    flowMoreLabel(el, false, over);
    flowFit.set(id, { t: t, fold: fold });
    if (fold) { folded++; if (over > maxOver) maxOver = over; }
  }
  const sig = [host.clientWidth, host.clientHeight, host.children.length, folded, opened, compacts, FLOW_CLAMP_PX, Math.round(maxOver)].join("|");
  if (sig !== flowFoldSig) {
    flowFoldSig = sig;
    sendCtrl({
      type: "log",
      msg: `对话流 收着=${folded} 摊开=${opened} 压缩点=${compacts} /共${host.children.length} 条（预算=${FLOW_CLAMP_PX}px≈${Math.round(FLOW_CLAMP_PX / 20)}行` +
           ` 面板=${host.clientWidth}x${host.clientHeight} 本轮量=${seen} 最多少=${Math.round(maxOver)}px，${why}）`,
    });
  }
}
/* 摊开 / 收起一条。**只动 DOM，不碰终端**（也不换主语）——
   所以它是"就地看全文"最省事的那条路：不跳格、不换栏、滚动位置不动。
   ⚠️ 摊开算**读者手势** ⇒ 当场停止吸底：不然接着来的新内容会把刚摊开这一条
   从眼前拽走（点开一段长报告、一秒钟后被顶到底部，是这一栏最容易让人放弃的体验）。 */
function setFlowOpen(el, open, why) {
  const id = el.dataset.fid || "";
  el.classList.toggle("open", open);
  if (open) flowOpen.add(id); else flowOpen.delete(id);
  flowFit.delete(id);                       // 高度变了，下一条要重新量
  flowMoreLabel(el, open, 0);
  const tx = el.querySelector(":scope > .tx");
  if (open) {
    flowLeave("摊开一条");
    // 上面那句已经把"为什么离开底部"记进 flowLeaveWhy 了，而那个读数由 scroll
    // 处理器在**下一次滚动**时补。摊开未必发生滚动 ⇒ 那行会挂到很久以后的某次
    // 滚动上，说的不是当时的事。所以这里清掉，由下面这行自己把话说清。
    flowLeaveWhy = "";
    // 就地摊开：只在"这一条的起点已经被顶出视野"时才挪屏（最短滚动量）。
    el.scrollIntoView({ block: "nearest" });
    sendCtrl({ type: "log", msg: `对话流 摊开一条 id=${id}（${why}）全文=${((flowTexts.get(id) || "") + "").length} 字 屏上=${tx ? Math.round(tx.scrollHeight) : 0}px` });
  } else {
    const over = tx ? tx.scrollHeight - tx.clientHeight : 0;
    el.classList.toggle("fold", over > 2);
    flowMoreLabel(el, false, over);
    flowFit.set(id, { t: flowTexts.get(id), fold: over > 2 });
    sendCtrl({ type: "log", msg: `对话流 收起一条 id=${id}（${why}）收掉=${Math.round(over)}px` });
  }
  paintJump();
}
// 「跳回最新」：常挂载 + 淡入淡出，"隐藏"用 inert + aria-hidden 而不是 display:none
// （display:none 会当场掐掉过渡）。inert 让它在隐藏时既点不到也 Tab 不到。
function setJump(on) {
  const b = $("h-jump");
  if (!b) return;
  const was = b.classList.contains("on");
  b.classList.toggle("on", on);
  b.inert = !on;
  if (on) b.removeAttribute("aria-hidden");
  else b.setAttribute("aria-hidden", "true");
  // 出现的那一刻把自己的盒子报一次（只在 false→true 那一次，不会刷屏）。
  // 理由和当初给分割条加几何读数是同一条：要"点它"就得知道它在哪，
  // 而这个位置是**布局算出来的**（底 10px + 居中 + 下段高度可拖），估必定偏。
  if (on && !was) {
    const r = b.getBoundingClientRect();
    sendCtrl({
      type: "log",
      msg: `跳回最新按钮出现 ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    });
  }
}
// 出现条件照 Orca 的 shouldShowJumpToLatest：**没在吸底**且离底超过 48px。
// 注意它和"回到尾部"用的是两个不同的数（4px），这里刻意不共用。
function paintJump() {
  setJump(!flowFollowing && flowDist() > FLOW_BOTTOM_PX);
}

/* 量一次下段到底有没有横向溢出、是谁撑的。
   ⚠️ 这不是"顺手加的调试"：横向滚动条是**能被缩略图骗过**的那类现象
   （内容被裁在右边界之外，截图里只能看到它被裁）。所以先让页面报宽度和
   最宽的那几条，再决定改哪条 CSS —— 而不是先猜"大概是长 token"。
   每次换主语/换会话各报一次，不刷屏。 */
function flowWidthProbe(why) {
  const h = flowHost();
  if (!h) return;
  const kids = Array.from(h.children)
    .map((el) => ({ w: Math.round(el.scrollWidth), t: (el.textContent || "").replace(/\s+/g, " ").slice(0, 36) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 3);
  // 代码块单独报：它是**故意**横向滚动的那个（保留缩进 = white-space:pre），
  // 所以"它自己滚动"和"它把整栏撑宽"是两件事，只看容器那个数分不出来。
  // 判据：`pre.scrollWidth > pre.clientWidth`（它在自己里面滚）**且**
  //       容器 `scrollWidth == clientWidth`（没有把外面撑开）。
  const pres = Array.from(h.querySelectorAll(".tx pre.code"));
  const code = pres.length
    ? ` 代码块${pres.length}个 最宽=${Math.max(...pres.map((p) => p.scrollWidth))}/${Math.max(...pres.map((p) => p.clientWidth))}`
    : "";
  sendCtrl({
    type: "log",
    msg: `对话流 宽=${h.clientWidth} 内容=${h.scrollWidth}（${why}）最宽=${kids.map((k) => k.w).join("/")}${code} 首条="${kids[0] ? kids[0].t : ""}"`,
  });
}

function renderFlow(why) {
  const host = flowHost();
  if (!host) return;
  const src = flowSource();
  const stale = src.stamp !== flowStamp;
  // ⚠️ 吸底判定必须在**动 DOM 之前**：动完再量，量到的是动完之后的位置。
  const distBefore = flowDist();
  const topBefore = host.scrollTop;
  // 锚点在不在，也是一次"要不要整表重建"的判据（被砍掉了/换了会话）。
  /* ⚠️ 第三种情形是**兜底**，而且是踩出来的：条目没有 id 时（Go 那边第一版
     只给工具调用发 id）`flowLastId` 是空串，锚点判据静默失效、`from` 从 0 起，
     于是每来一条新内容整个列表**重画一遍** —— 日志里是 `流水 +1 条` 而前端写着
     `追加5 条 共5 条`。所以"锚不住"一律当重建：重建只是白画一次，重复追加
     是屏上真的多出一份对话。 */
  const anchor = (!stale && flowLastId) ? src.items.findIndex((x) => x.id === flowLastId) : -1;
  const fresh = stale || (src.items.length > 0 && (anchor < 0 || !flowLastId));

  if (fresh) {
    flowStamp = src.stamp;
    flowLastId = "";
    flowTexts.clear();
    // 换主语/换代 = 整表重建：**摊开状态跟着一起清**。不清会串台 ——
    // 库模式的 id 是 `lib:<序号>`，两个会话里第 4 条叫同一个名字。
    flowOpen.clear();
    flowFit.clear();
    host.innerHTML = "";
    flowFollowing = true;      // 换主语 / 换代 = 回到"跟着走"
    flowPrevDist = 0;
    setJump(false);
  }

  let added = 0, changed = 0;
  if (!src.items.length) {
    if (!host.querySelector(".hist-empty")) host.innerHTML = `<div class="hist-empty">${esc(src.empty)}</div>`;
  } else {
    const em = host.querySelector(".hist-empty");
    if (em) em.remove();       // 空态是占位：第一条真内容到了就下台
    const from = fresh ? 0 : anchor + 1;
    if (from < src.items.length) {
      const add = src.items.slice(from);
      host.insertAdjacentHTML("beforeend", add.map(flowRowHTML).join(""));
      flowLastId = add[add.length - 1].id || "";
      added = add.length;
    }
    // 已画过的那几条：正文变长了就**就地重画那一条**。不做这一步，
    // 流式输出在对话流里会停在第一帧 —— 而这正是"实时"最容易露馅的地方。
    // fresh 时 from=0，这个循环自然一次都不跑（刚 append 的那些没有"变没变"）——
    // 这不是巧合，是刻意的：重建之后没有"已画过"的行。
    for (let i = 0; i < from; i++) {
      const it = src.items[i];
      if (flowTexts.get(it.id) === it.text) continue;
      flowRedraw(it);
      changed++;
    }
  }
  for (const it of src.items) flowTexts.set(it.id, it.text);

  /* 只留模型窗口那么多行。Go 那边封顶 300 条，而**前端这份只追加、从不从顶上删** ——
     于是它一直在 300 之上慢慢涨。实测：内容一条一条来的时候模型停在 300，
     屏上行数 300→301→302…，每来一条 +1，永不回收（一条会话跑一小时就是几千个
     行）。以前不是问题，因为这块是"一屏快照"（最多 30 条），现在是活的。

     ⚠️ 砍头**必须补偿 scrollTop**：删掉的行在上方，DOM 一删，正在读的那一段会
     整体上移同样高度（浏览器自带的 scroll anchoring 被我们关掉了，见 #hist 那条
     注释 —— 所以这份补偿得自己做）。判据很硬：删掉多少高度，scrollTop 就减多少，
     "屏幕上那一行还是那一行"。 */
  if (src.items.length && host.children.length > src.items.length) {
    const drop = host.children.length - src.items.length;
    const h0 = host.scrollHeight, top0 = host.scrollTop;
    for (let i = 0; i < drop; i++) {
      const el = host.firstElementChild;
      if (el.dataset.fid) flowTexts.delete(el.dataset.fid);  // 别让这张表跟着涨
      if (el.dataset.fid) flowFit.delete(el.dataset.fid);    // 这张同理（少了它 = 每次砍头都留下量过期的记录）
      // 摊开状态也一起删：这条已经被砍掉了，留着它的 id 就是留了个雷 ——
      // 万一以后哪条消息拿到同一个 id，它会**无缘无故自己摊开**。
      if (el.dataset.fid) flowOpen.delete(el.dataset.fid);
      host.removeChild(el);
    }
    const dh = h0 - host.scrollHeight;
    if (dh > 0) host.scrollTop = Math.max(0, top0 - dh);
    sendCtrl({
      type: "log",
      msg: `对话流 顶上收回 ${drop} 行（−${dh}px，位=${Math.round(top0)}→${Math.round(host.scrollTop)}，` +
           `应等于 ${Math.round(top0 - dh)}）`,
    });
  }

  /* 收/不收**必须在 DOM 写完、且在量宽度之后**：判据是 scrollHeight 对 clientHeight，
     早一步量到的是上一次的排版（同 flowWidthProbe 那条注释里的坑）。 */
  flowFoldPass(fresh ? "换主语" : (added || changed) ? "新内容" : "复查");

  /* ⚠️ 量横向溢出必须**在写完 DOM 之后**。第一版把它放在 fresh 分支开头（"先量后写"），
     量到的是上一次的内容 —— 换主语那一刻恰好是空列表，于是每次都报
     `宽=397 内容=397`，看起来"没有横向滚动条"，而那时屏上一条都还没画。
     这类"读数总是对的、对象却不存在"的错，正是这个项目里最容易被信以为真的那类
     （徽标那条测法与这里同源）。 */
  if (fresh) flowWidthProbe(why || "换主语");

  $("h-sub").textContent = src.title;
  // 子代理主语时，悬停里补上"谁派出来的"（标题是**人写的任务描述**，
  // 而同一个描述在多条会话里完全可能重复出现）。
  $("h-sub").title = flowSub.kind === "lib"
    ? (src.title + (src.from ? t("flow.fromInline", { name: src.from }) : "") + t("flow.subLibSuffix"))
    // 工作区名字放在悬停里（行尾见 flowSource 的 foot 那条：放不下，会被挤没）
    : (src.title + (activeTab ? ` · ${workspaceNameFor(activeTab)}` : "") + t("flow.subCurrentSuffix"));
  $("h-foot").textContent = src.foot;
  $("h-cnt").textContent = String(src.items.length);
  const chip = $("h-src");
  // 这一栏的主语是 agent（2026-10-17 用户定的模型）：「当前格」是运行时那一层的说法，
  // 而用户点的、左栏列的都是 agent —— 标签跟着叫，两处才指同一件东西。
  chip.textContent = flowSub.kind === "lib" ? t("flow.source.lib") : t("flow.source.current");
  chip.classList.toggle("lib", flowSub.kind === "lib");
  chip.title = flowSub.kind === "lib" ? t("flow.source.libTitle") : t("flow.source.currentTitle");

  if (flowFollowing) flowStick();
  paintJump();

  // 只在"真的动了"的时候回日志（每次 scheduleLive 都回会把日志淹掉）。
  // 报的是**滚动位置的前后两个数**（不是离底距离）：新内容是加在**下面**的，
  // 所以离底距离本来就该变大 —— 那不能拿来判"有没有打扰你"。真正该相等的是
  // scrollTop：它就是"你正看着的那一行还在原处"。吸底时两数都该是 0。
  if (fresh || added || changed) {
    sendCtrl({
      type: "log",
      msg: `对话流 ${fresh ? "换主语" : added ? "追加" + added + " 条" : "续写" + changed + " 条"} 共${src.items.length} 条` +
           `（主语=${flowSub.kind === "lib" ? "库 " + String(flowSub.id).slice(0, 8) : "格" + (activeTab ? activeTab.id : "?")}` +
           `${fresh ? "，" + (why || "") : ""}，吸底=${flowFollowing ? "是" : "否"}，` +
           `位=${Math.round(topBefore)}→${Math.round(host.scrollTop)} 离底=${Math.round(distBefore)}→${Math.round(flowDist())}px` +
           // 屏上的行数 vs 模型里的条数：**这两个数会分家**（Go 那边砍到 300 条，
           // 前端是只追加、从不从顶上删），分家多少一眼看得出来。
           ` 行=${host.children.length}）`,
    });
  }
}

// 脱离底部：**只由读者手势调用**。内容变化、程序写入、布局变化都不许调它 ——
// 这是整套状态机的分界线（Orca 原话：Following stops only on a reader gesture
// or a row jump, never on layout or an application write）。
function flowLeave(why) {
  if (!flowFollowing) return;
  flowFollowing = false;
  /* ⚠️ **读数不在这里打**。wheel / mousedown 是"用户要滚了"的**前兆**，
     那一刻浏览器还没挪 scrollTop —— 当场量必然是 `位=1402 离底=0`，
     看起来像"刚从底部离开"，而这既不真也没用。
     我试过推到 requestAnimationFrame 里再量：**还是早**（Chromium 里
     scroll 事件排在那一帧的 rAF 之后），实测依旧读到滚之前的值。
     真正知道结果的是下面的 scroll 处理器 —— 所以这里只留个"为什么"，
     由那边把数字补上（一次脱离只打一行）。 */
  flowLeaveWhy = why;
  paintJump();
}
function flowToLib(id, why) {
  flowSub = { kind: "lib", id: id };
  renderFlow(why);
}
function flowToLive(why) {
  if (flowSub.kind === "live") return;
  flowSub = { kind: "live" };
  sendCtrl({ type: "log", msg: `对话流 主语回到当前格（${why}）` });
  renderFlow(why);
}

$("hist").addEventListener("wheel", () => flowLeave("滚轮"), { passive: true });
$("hist").addEventListener("touchmove", () => flowLeave("触摸"), { passive: true });
$("hist").addEventListener("keydown", (e) => {
  // 只有"往尾部反方向"的那几个键算脱离；PageDown/End/ArrowDown 是朝尾部去的。
  if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") flowLeave("按键 " + e.key);
});
$("hist").addEventListener("mousedown", (e) => {
  const h = flowHost();
  // 点在滚动条那条带上（选区之外 = clientWidth/clientHeight 之外）也是"读者在手拖"。
  if (h && (e.offsetX > h.clientWidth || e.offsetY > h.clientHeight)) flowLeave("拖滚动条");
});
/* 点这一条 = **就地摊开它的全文**（用户 2026-10-16 定的；另外两个候选
   "跳到那一格的终端 / 拎成一页"都没要：这一栏就在眼前，跳走再跳回来会把你
   "刚才在看第几条"丢掉）。
   ⚠️ 摊开着的时候点正文**不动作** —— 那时的点击几乎都是为了选字；
   要收起来请点那颗「收起」按钮。收起来的那些**整块可点**（光标也是 pointer）。 */
$("hist").addEventListener("click", (e) => {
  const el = e.target.closest(".hit");
  if (!el || !el.dataset.fid) return;
  const open = el.classList.contains("open");
  if (e.target.closest("[data-flow-more]")) { setFlowOpen(el, !open, "点按钮"); return; }
  /* 压缩节点：收起时**整行就是开关**（它没有那颗「… 其余 N 行 ▾」，也不需要：
     收起时它只有一行字，点哪儿都是"看这份摘要"）；摊开后**只有头行是收起** ——
     和别的条目同一条规矩（那时的点击几乎都是为了选字）。
     ⚠️ 它不走下面那条 `if (!el.classList.contains("fold")) return`：那个 `.fold`
     是量出来的，而压缩节点压根不参与那套量法（见 flowFoldPass）。 */
  if (el.classList.contains("compact")) {
    if (open && !e.target.closest(".fh")) return;
    if (!open && String(window.getSelection() || "")) return;   // 有选中文本时不动作
    setFlowOpen(el, !open, open ? "点头行" : "点压缩节点");
    return;
  }
  if (open) {
    // 摊开着的时候点**头行** = 收起。那颗「收起」按钮在这一条的末尾，
    // 一条 850px 的长文摊开后它在视野之外 —— 而你的眼睛在开头。
    // ⚠️ 点正文仍然**不动作**：那时的点击几乎都是为了选字。
    if (e.target.closest(".fh")) setFlowOpen(el, false, "点头行");
    return;
  }
  if (!el.classList.contains("fold")) return;
  if (String(window.getSelection() || "")) return;   // 有选中文本时不动作
  setFlowOpen(el, true, "点正文");
});
/* 面板宽度一变，换行就变了 ⇒ "溢出多少"整份作废，得重量一遍（拖分割条、
   折叠/展开下段、拉窗口都走这条）。用 rAF 合帧：拖动途中每个像素都量一次没意义。 */
new ResizeObserver(() => {
  if (flowFoldRaf) return;
  flowFoldRaf = requestAnimationFrame(() => {
    flowFoldRaf = 0;
    flowFit.clear();
    flowFoldPass("面板尺寸变了");
  });
}).observe($("hist"));
$("hist").addEventListener("scroll", () => {
  const d = flowDist();
  if (flowFollowing) { flowPrevDist = d; return; }
  // 重新吸底：距离**在缩小** 且 已经进到 4px 以内。少了"在缩小"这一半，
  // 往上滚的过程中就会在半路被拽回去。
  if (d < flowPrevDist && d <= FLOW_REARM_PX) {
    flowFollowing = true;
    flowLeaveWhy = "";
    clearTimeout(flowLeaveTimer);
    sendCtrl({ type: "log", msg: `对话流 回到尾部（离底=${Math.round(d)}px，上一帧=${Math.round(flowPrevDist)}px）` });
  } else if (flowLeaveWhy) {
    // ⚠️ 一次滚轮会连出好几个 scroll 事件，**第一个只挪 1px**（Chromium 的平滑滚动
    // 分帧落地）。所以"停在哪儿"要等这一串停稳（150ms）再记 —— 否则日志里
    // 永远写着 `位=1608 离底=1px`，看着像"滚轮没生效"。
    clearTimeout(flowLeaveTimer);
    flowLeaveTimer = setTimeout(() => {
      sendCtrl({
        type: "log",
        msg: `对话流 脱离底部（${flowLeaveWhy}）位=${Math.round(flowHost().scrollTop)} 离底=${Math.round(flowDist())}px`,
      });
      flowLeaveWhy = "";
    }, 150);
  }
  flowPrevDist = d;
  paintJump();
});
// 按钮自己别把焦点抢走 —— 键盘焦点在终端里，点它只是为了回尾部，不该顺带打断打字。
$("h-jump").addEventListener("mousedown", (e) => e.preventDefault());
$("h-jump").addEventListener("click", () => {
  flowFollowing = true;
  flowStick();
  setJump(false);
  sendCtrl({ type: "log", msg: "对话流 跳回最新（点按钮）" });
});
// 点来源签 = 回到当前格（在库模式时它才是可点的，样式见 CSS 的 #h-src.lib）
$("h-src").addEventListener("click", () => flowToLive("点来源签"));

/* 相对时间会**永久停在渲染那一刻**：快照时代看不出来（页面本来就只画一次），
   实时之后新的条目不断进来，老的那几条就永远写着"刚刚"。所以每 60s 只把
   .tm 的文本按 data-at 重算一遍 —— 不重画任何一行，只动时间节点
   （Orca 那边干脆用绝对 HH:MM 绕开了这件事；我们保留相对时间，代价就是这一条）。
   ⚠️ 选择器**不限定在 #hist 里**：这条规矩（"带 data-at 的时间节点都得按时重算"）
   说的是这件事本身，不是右栏那一份 —— 群组的行里也有时间节点，漏掉它就会出现
   一片"刚刚"（那种错看着完全正常，只是说的不是真的）。 */
setInterval(() => {
  document.querySelectorAll(".tm[data-at]").forEach((el) => {
    const t = rel(el.dataset.at);
    if (el.textContent !== t) el.textContent = t;
  });
  // C7：状态签和相对时间是同一类东西 —— 都是"算出来的、会过期的一小段文字"。
  // 区别是时间过期只是不精确，状态过期是**说假话**（见 refreshSubChips）。
  refreshSubChips();
}, 60000);

/* 点左栏那张卡片 = 把下段**切成"看这个会话"**（静态历史，不走实时）。
   它不再直接往 #hist 里写 —— 渲染只有一个出口（renderFlow），否则两种写法
   迟早分叉：live 那边追加、这边整表重写，一交替就是"内容重复/丢字"。

   ⚠️ `selected`（卡片高亮）和 `flowSub`（下段主语）现在是**两件事**：
   selected 只说"左栏高亮了谁"，flowSub 才说"下段在讲谁"。以前它们恒等，
   所以合并成一个变量没人看得出来；改成实时之后，用户点一下格（现实时）
   而左栏还亮着某张卡，两者就必须能分开。 */
function selectSession(id) {
  const s = (STATE?.sessions || []).find((x) => x.id === id);
  if (!s) return;
  selected = s;
  document.querySelectorAll(".card").forEach((el) =>
    el.classList.toggle("sel", el.dataset.id === id));
  flowToLib(id, "点左栏卡片");
}

