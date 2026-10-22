"use strict";
/* 60-shell.js —— 壳层数据、导航、左栏项目/agent/已关闭行、菜单、重命名、卡片与动作。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 5123-6702（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

// ===========================================================================
// 壳层数据
// ===========================================================================
let STATE = null;
let selected = null;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 会话名 = 用户起的名字 ?? agent 自己写的标题（Orca 的 `customTitle ?? title`）。
// 用户起的名字来自后端（titles.json，键是 sessionId）—— 它是**会话的属性**，
// 不是这一屏标签/面板的属性，所以列表、历史流面板、标签三处都读同一个来源。
function sessionTitle(s) {
  const custom = STATE && STATE.titles && STATE.titles[s.id];
  if (custom) return custom;
  const title = String(s.title || "").trim();
  // A terminal's own name ("Perch", "Windows PowerShell") is not a session
  // identity. Codex 0.163 writes TERM_PROGRAM into its OSC title, which used
  // to leave "Perch" in the rail and in the waiting list; fall back to the
  // agent's name instead. `isGenericShellTitle` lives in 10-term.js (loaded
  // before this file).
  if (title && typeof isGenericShellTitle === "function" && isGenericShellTitle(title)) {
    return s.agentName || s.agent || s.id.slice(0, 8);
  }
  return title || s.id.slice(0, 8);
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

/* ===========================================================================
   左栏这一轮（2026-10-16）：项目池 → 工作区行 → 缩进的会话行

   这一块只认三份事实，别再引入第四份：

     ① `STATE.projects` —— Go 给的池子，**已经排好序**（置顶区在前，其余按组内
        最近活动倒序）。前端**不重排**：同一条规则写两遍，迟早不一致。
     ② `STATE.assign`   —— 会话 id → 项目路径（cwd 最长前缀匹配，Go 算的）。
        **不在表里 = 未归类** —— 那是一个真实的分组，不是"字段缺失"。
     ③ `TAB_LIST` / `LIVE` —— 现在谁真的在跑。读它只为了画那个状态点和"N 在跑"：
        池子说的是"我有哪些项目"，格子说的是"现在谁在跑"，两者不能互相冒充
        （一个刚加进来、还没跑过的项目不该显示成"有 agent 在工作"）。

   **没有手工归类动作** —— 归属是算出来的（用户原话的意思是："它属于哪个工作区
   就是哪个工作区；创建的时候它是怎么样的，它就应该是怎么样的"）。
   动作落点见 plan `quiet-perching-twig.md` §5。
   =========================================================================== */

const ICON_PLUS = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
const ICON_PIN = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
const ICON_PENCIL = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const ICON_TRASH = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
/* 行图标（工作区行 / 会话行用）。字形在 LUCIDE_FOLDER_TREE / LUCIDE_SQUARE_TERMINAL
   那两行（来源和理由都写在它们的注释里 —— 一句话：抄现成的，不手画）。
   分开命名是为了让"这一枚画在哪儿"在代码里看得见：行里的图标是**缩进层级的锚点**，
   栏里的图标是**区**的标记。 */
const LIST_ICON = {
  folder: LUCIDE_FOLDER_TREE,
  chat: LUCIDE_SQUARE_TERMINAL,
  // 2026-10-17：左栏的缩进行从「会话」换成了「agent」，名字跟着换（`chat` 这个名字
  // 留着给导航栏那两处用；字形本来就是方形终端，不是对话气泡）。
  term: LUCIDE_SQUARE_TERMINAL,
};
const NAV_ICON = {
  folder: LUCIDE_FOLDER_TREE,
  chat: LUCIDE_SQUARE_TERMINAL,
  // Lucide 的 layout-dashboard 原始 path（抄现成的，不手画）：
  // 四块面板，正好是"总览 = 多块读数拼成一页"的字形。
  dash: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>',
};

/* 导航项是**一份清单**，不是写死的 HTML —— 加一项/删一项都不用动 DOM。
   ⚠️ 2026-10-16：原来这里有第二项「全部会话」，它和右边那个平铺视图
   （#sess-view / renderSessionsView）一起退役了：会话行已经缩在工作区行下面，
   同一份数据说两遍。⚠️ 但**整条栏留着** —— 我一度连栏一起删了，用户纠正
   「两层设计是要的」：左层管"去哪一区"，右层管"这一区里有什么"。
   「设置」曾经是灰项；2026-10-18 设置页落地后，三项都是真区。以后再有
   没做完的项，仍按「做灰不做隐」处理：灰态 + title 说原因。 */
const NAV_ITEMS = [
  /* 2026-10-17 用户定的：左栏 = **总览 / 工作区 / 设置**。
     总览置顶、最显眼，而且默认启动就落在它上面 —— 用户要的是"一进来先看全局状态"。
     总览**不是一个格子**，是一整块主区视图（见 CSS 1b 段）。
     2026-10-18：设置页有了（默认目录 / 外观 / 行为），不再是灰项。 */
  { view: "dash", labelKey: "nav.overview", icon: "dash" },
  { view: "workspace", labelKey: "nav.workspace", icon: "folder", cnt: "nav-cnt-ws" },
  { view: "settings", labelKey: "nav.settings", icon: "gear", bottom: true },
];

/* 哪一项亮着。从"只有一个区"变成了真的三项（工作区 / 总览 / 设置）——
   所以它不再是常量，而是 setNavView 写的当前值。
   初始值读设置里的启动落点（05-prefs.js 的缓存；Go 的权威值到了也不会
   把人从当前视图拽走 —— "启动落点"只对下一次启动生效）。
   ⚠️ HTML 那个提前跑的脚本已经把 #app.dash 摘掉了（startView=workspace 时），
   这里只负责让导航高亮和类名一致。 */
let NAV_HERE = SETTINGS.startView === "workspace" ? "workspace" : "dash";
// 设置页按 Esc 要回到"来之前那个视图"；只在离开非设置视图时记录。
let NAV_PREV = NAV_HERE;
$("app").classList.toggle("dash", NAV_HERE === "dash");

function renderNav() {
  const rail = $("rail");
  if (!rail) return;
  const one = (n) => {
    const cls = "nav" + (n.view === NAV_HERE ? " on" : "") + (n.soon ? " soon" : "");
    const extra = n.soon ? ` data-soon="1" title="${esc(t(n.whyKey || ""))}"` : "";
    const cnt = n.cnt ? `<span class="cnt" id="${n.cnt}">0</span>` : "";
    const label = t(n.labelKey);
    return `<div class="${cls}" data-nav="${esc(n.view || "")}" data-view="${esc(n.view || "")}"${extra}>`
      + svg(NAV_ICON[n.icon], 15, 1.7) + `<span>${esc(label)}</span>${cnt}</div>`;
  };
  rail.innerHTML =
    NAV_ITEMS.filter((n) => !n.bottom).map(one).join("") +
    `<div class="rail-spacer"></div>` +
    NAV_ITEMS.filter((n) => n.bottom).map(one).join("");
  syncCounts();
}

/* 左栏的计数只有这一处：导航栏「工作区」那一项右边那枚数（池子里有几个工作区）。
   值一律从 STATE.projects 现算 —— 加项目/删项目之后靠重画同步。
   （`g-proj` 那个 id 是列表标题上那枚数的旧落点，现在没有那个元素了 ——
   元素在就写、不在就算了，所以这里仍然两个 id 都写一遍。） */
function syncCounts() {
  const n = (STATE?.projects || []).length;
  for (const id of ["nav-cnt-ws", "g-proj"]) {
    const el = $(id);
    if (el) el.textContent = n;
  }
}

/* 左栏形态的**自证读数**（计划的验证第 4 条）：行序、展开态、行高、未归类。
   这些东西在截图上只能目测"像不像"，而"到底哪几行、多高、第几行缩进"是字节级的
   事实 —— 量出来，别目测（分割条那次就是目测错的那一下）。

   ⚠️ 「行数」报的是**总数**：改成一列之后最容易犯的错正好是数漏（会话都缩在
   工作区行下面，`#proj-list .proj` 只数得到目录行）—— 所以这里分别报目录行、
   会话行和两者的和，一个自证读数数错自己的行数比不报还坏。
   `view=` 这个字段是旧读数留下的（那时能切两个视图）：现在恒为 list，留着是为了
   让历史日志对得上——**旧的 `view=workspace/sessions` 从此不会再出现**，日志里
   再看到它们就说明跑的是旧代码（改了 assets 忘了重新 build）。 */
function viewProbe(why) {
  const projs = [...document.querySelectorAll("#proj-list .proj")];
  const agents = [...document.querySelectorAll("#proj-list .arow[data-tab], #un-view .arow[data-tab]")];
  /* 「已关闭」的行不是格子（没有 data-tab），但它们是左栏的**正经行** ——
     单独数一遍，否则"模型里 1 格、DOM 里 1 行"会把那条已关闭的行漏掉，
     自证读数反而变成一句误导（同"行数要分别报目录行和会话行"那条）。 */
  const closedRows = [...document.querySelectorAll(
    "#proj-list .arow.closed[data-pane], #un-view .arow.closed[data-pane]")];
  const rows = projs.slice(0, 3);
  const h = rows.map((el) => `${Math.round(el.getBoundingClientRect().height)}px`).join("/");
  const line = rows.map((el) => (el.querySelector(".nm") || {}).textContent || "?").join(" · ");
  const un = [...document.querySelectorAll("#un-view .proj")];
  /* **左栏的唯一不变量**（2026-10-17 起）：行 = agent。
     模型里有几个格、DOM 里就画几行。2026-10-20 起收起的组**也画**（折叠成
     0 高 + inert），所以 DOM 数不再只等于"展开的那些" —— 另报一个"可见"
     （展开组里的），两个数都对得上才算没漏行。 */
  const model = TAB_LIST.filter((t) => t.id > 0);
  const withPane = model.filter((t) => (t.paneID | 0) > 0).length;
  const stopped = model.filter((t) => t.connDown).length;
  const agentsShown = agents.filter((el) => {
    const g = el.closest(".agroup");
    return !g || g.classList.contains("open");
  }).length;
  // 导航栏那一列也要报：栏是两层设计的左层，"哪一项亮着、一共几项"在截图上
  // 只能目测，而这两件事正是"栏还在不在"的判据（我删掉它那一次就是这么被逮住的）。
  const nav = [...document.querySelectorAll("#rail .nav")]
    .map((el) => `${el.dataset.nav}${el.classList.contains("on") ? "*" : ""}`).join(",");
  // 用 bootFact 而不是 sendCtrl：启动那一次是在 shell 载荷到达时跑的，而 ctl
  // 通道**可能还没建好**（两条流是各开各的）—— 在模块求值/启动路径上直接
  // sendCtrl 会静默把这条读数吞掉（那个教训见 bootFact 的注释）。
  bootFact(`左栏形态 view=agents（${why}）工作区行=${projs.length}` +
    ` agent行(DOM)=${agents.length} 可见=${agentsShown} 已关闭行(DOM)=${closedRows.length}` +
    ` 格子=${model.length} 有paneId=${withPane} 已停止=${stopped}` +
    ` 已关闭=${CLOSED_PANES.size}` +
    ` 前三行=${line || "（空）"}` +
    ` 行高=${h || "-"} 未归类目录=${un.length}` +
    ` 展开=${[...document.querySelectorAll("#proj-list .proj.open")].length}` +
    // 展开态落盘了没有 —— 这一条只能从存储里读出来才算数（重启之后还在，
    // 才是计划里那条"重开还原"）。键名和内容一起报，免得"看着存上了"其实存的是别的键。
    ` 展开态键=${PROJ_OPEN_KEY}:${JSON.stringify(projOpenMap)}` +
    // 导航栏那一列：**"栏还在不在"的字节判据**。我删掉它那次，日志里本来就该
    // 有一条"导航=[工作区*]"消失的记录 —— 那时这条读数还没加，靠截图才看出来。
    ` 导航=[${nav}]`);
}

function searchKey() { return ($("q")?.value || "").trim().toLowerCase(); }

// ---------------------------------------------------------------------------
// 归属与"在跑"：两条判据都只有一处
// ---------------------------------------------------------------------------

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
function tabsInProject(p) {
  const path = typeof p === "string" ? p : (p && p.path);
  /* ⚠️ 格的 `spec.cwd` 可能是**空串**（= "没指定目录"），而那种格实际落在
     **默认工作区**里（Go 那边只有一处答案，见 defaultCWD）。
     所以空串要在这里映射成默认工作区的路径 —— 不映射的话，默认工作区那一行
     会永远写着"0 会话 / 没有格在跑"，而格子明明就在它里面跑
     （它自己的会话行又会出现在别处，看着像两件事，其实是同一件）。 */
  const defPath = (STATE?.projects || []).find((x) => x.synthetic)?.path || "";
  return TAB_LIST.filter((t) => t.id > 0 && insidePath((t.spec && t.spec.cwd) || defPath, path));
}
// 一组格子里**最该被看见的那个态**（attention-first，表用群组那一张 —— 同一份
// 排序不能在两处各写一遍）。
function worstState(tabs) {
  let best = null, bestRank = Infinity;
  for (const t of tabs) {
    const st = cellState(t);
    const r = GROUP_RANK[st];
    const rr = r === undefined ? 99 : r;
    if (rr < bestRank) { bestRank = rr; best = st; }
  }
  return best;
}
/* 工作区行那颗点 = 「这里**正在发生**什么」，停了的不算数。
   `worstState` 那张表是 attention 次序（`off` 排 1，比 working/unread 都靠前），
   那是为"一格一卡"的看板写的；搬到工作区上就错了 —— 一个停了的 agent 会让整个
   工作区永远挂一颗最醒目的点，哪怕旁边那格正在等你答。所以只拿在跑的算，
   全停了才落到 off（"这一片现在没人干活"本身是值得说的）。 */
function projDotState(tabs) {
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.connDown);
  return live.length ? worstState(live) : "off";
}
/* 这条会话**现在**是不是某一格在跑。不认 cwd —— 同一个目录里可以有好几条会话，
   按 cwd 找会指错人。两条判据都是**事实**，缺一个就有一段时间答不上来：

   ① `t.sessionID` —— hook 事件里带的 session_id（见 applyHook 里那段）。这是
      第一手来源，比登记表还早（Go 侧 bindSession 的注释）。
   ② `t.spec.resume.kind === "exact"` —— 这一格本来就是拿 `--resume <id>` 起的
      （冷恢复和左栏「接上」都是）。它在**①到达之前**就已经是事实了。
      **fork 不算**：fork 写的是新会话，这一格跑的不是旧那条。

   为什么非要有②：冷恢复刚建完格那一两秒里 hook 还没来（SessionStart 由 claude
   自己发，快则几百毫秒），而那正是用户看着左栏点下去的时刻。少了它，点击一条
   正跑在自己格子里的会话 → 走"接上" → 撞护栏 → 红字报错。实测 00:06:44 那次
   点 tab2/tab7 里那两条会话就是这个症状。

   `connDown` 一票否决：stream 断了 = 这一格的 PTY 已经没了（格内 /exit 也算），
   那条会话此刻**没有**任何人在写，点它就该安安静静走「接上」。 */
function tabForSession(sid) {
  if (!sid) return null;
  return TAB_LIST.find((t) => t.id > 0 && !t.connDown
    && (t.sessionID === sid
     || (t.spec?.resume?.kind === "exact" && t.spec.resume.id === sid))) || null;
}
function projObjByPath(path) {
  return (STATE?.projects || []).find((p) => p.path === path) || null;
}
function findSess(id) { return (STATE?.sessions || []).find((s) => s.id === id) || null; }

// 展开态的持久化。**默认展开**（不在表里 = 展开）：左栏要回答的正是"每个项目里
// 有什么"，一进来全是收起的一排名字，等于把这句话咽回去了。用户收起过的才记。
const PROJ_OPEN_KEY = "projOpen";
let projOpenMap = null;
try { projOpenMap = JSON.parse(localStorage.getItem(PROJ_OPEN_KEY) || "{}") || {}; }
catch (e) { projOpenMap = {}; }
if (typeof projOpenMap !== "object") projOpenMap = {};
function projOpen(path) { return projOpenMap[path] !== false; }
function setProjOpen(path, on) {
  projOpenMap[path] = on;
  try { localStorage.setItem(PROJ_OPEN_KEY, JSON.stringify(projOpenMap)); }
  catch (e) { jserr("存左栏展开态", e); }
}
/* 「已关闭」的 disclosure（2026-10-19 装修左栏时加的）：一个工作区里关掉的
   agent 不应该和正在干活的行抢同一段高度，但它们**也不是垃圾**（关格 ≠ 删）。
   所以默认收起成一行「已关闭 N」，用户点开才铺出那些行。按工作区记住。 */
const PROJ_CLOSED_KEY = "projClosed";
let projClosedMap = null;
try { projClosedMap = JSON.parse(localStorage.getItem(PROJ_CLOSED_KEY) || "{}") || {}; }
catch (e) { projClosedMap = {}; }
if (typeof projClosedMap !== "object") projClosedMap = {};
function closedOpen(path) { return projClosedMap[path] === true; }
function setClosedOpen(path, on) {
  projClosedMap[path] = on;
  try { localStorage.setItem(PROJ_CLOSED_KEY, JSON.stringify(projClosedMap)); }
  catch (e) { jserr("存已关闭展开态", e); }
}
/* ---- 文件夹记住的 Agent（2026-10-20）------------------------------------
   用户在新建卡片里**明确选过**谁，就记住这个文件夹用谁；快捷键下一次直接
   用它。只有卡片里的显式选择写这里 —— 快捷键、没开始的新格换 Agent 都不写，
   否则"最开始选的那个"会被悄悄改写。
   键 = normPath(文件夹路径)。默认工作区也是真实路径（STATE.projects 里
   synthetic 那一行），所以不会和空串分叉。 */
const LAST_AGENT_KEY = "lastAgentByPath";
let lastAgentMap = null;
try { lastAgentMap = JSON.parse(localStorage.getItem(LAST_AGENT_KEY) || "{}") || {}; }
catch (e) { lastAgentMap = {}; }
if (typeof lastAgentMap !== "object" || Array.isArray(lastAgentMap)) lastAgentMap = {};
function lastAgentFor(dir) {
  const id = lastAgentMap[normPath(dir || "")];
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}
function rememberLastAgent(dir, agent) {
  const id = String(agent || "").trim().toLowerCase();
  if (!id) return;
  const key = normPath(dir || "");
  if (lastAgentMap[key] === id) return;
  lastAgentMap[key] = id;
  try { localStorage.setItem(LAST_AGENT_KEY, JSON.stringify(lastAgentMap)); }
  catch (e) { jserr("存文件夹默认 Agent", e); }
  sendCtrl({ type: "log", msg: `记住文件夹 Agent key=${key || "(默认)"} agent=${id}` });
}
/* 「+」的 title / 菜单 hint 里那半句：快捷键存在时才说，否则别占地方。 */
function newAgentShortcutTip() {
  const k = SETTINGS.newAgentShortcut;
  return k ? t("shell.shortcutTip", { key: k }) : "";
}
// ---------------------------------------------------------------------------
// 行的 HTML
//
// 2026-10-17 用户定的模型（这一节整个照它重写）：
//
//   工作区（盘上一个目录）⊃ **agent**（持久身份 = panes.json 里的 paneId）
//     └ 一份持续增长的对话（jsonl；上下文压缩发生在它内部）
//
// **左栏没有「会话」这个实体**，也没有「历史会话」那一层 —— 以前那些行是
// "起一次进程"留下的断面（通道被关、程序被杀），产品该做的是把那个 agent
// 接回来，而不是把断面列成一张表。一个 agent 代表这件事的全部；它干过什么
// 在**右栏的对话流**里看（点它 = 对话流切到它身上）。
//
// 所以：一行 = 一个 agent。它属于哪个工作区由 `spec.cwd` 决定（空 = 默认工作区，
// 见 tabsInProject）。agent 停了（stream 断了 / 进程退出）行**不消失** ——
// 它还是那个 agent，只是没在跑；点一下在原座位接上。
// ---------------------------------------------------------------------------

// kind: "proj"（池子里的项目）| "adopt"（未归类里的一个目录）| "bare"（连默认目录都没有）
// ⚠️ 「默认工作区」走的是 kind="proj"（它就是 STATE.projects 里的一条，只是由
//    Go 合成、带 `synthetic:true`）—— 它的差异只有动作区那一点点，不值得再开一种行。
/* 工作区行第二行只放"这是哪个目录"的短提示：240px 的列宽里，全路径会把
   「N agent」挤到看不见。最后两级足够区分同名目录，全路径在 title 里。 */
function projPathHint(p) {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length <= 2) return parts.join("\\");
  return "…\\" + parts.slice(-2).join("\\");
}

function projRowHTML(p, tabs, kind, total, closed, forceOpen) {
  // forceOpen = 搜索中命中的工作区强制摊开：否则命中的行藏在收起的工作区里，
  // 搜索结果看起来"什么都没找到"。存储里的展开态不动 —— 清掉搜索词就回去。
  const open = forceOpen || projOpen(p.path);
  const st = projDotState(tabs);
  // 行尾读数只说在场的东西：一个 agent 都没有就写 0 —— 空着会让人以为
  // "这一行不数东西"。它数的是**agent**，不是已经被抽屉收起来的会话。
  // `total` = 这个工作区里一共几个（搜索时 `tabs` 只是命中的那几条）——
  // 搜索期间这个数**不跟着缩水**，否则"这一行到底有几个 agent"会随搜索词跳。
  // 2026-10-17：「已关闭」的 agent 也算这个工作区的东西（关格 ≠ 删），所以
  // total 由调用方把两边加起来；这里兜底时也把 closed 算上。
  const nAll = (total == null) ? tabs.length + (closed ? closed.length : 0) : total;
  const sum = tCount("shell.proj.sum", nAll);
  const syn = kind === "proj" && !!p.synthetic;
  let acts = "";
  if (kind === "proj" || syn) {
    acts = `<span class="pg"><button class="cardbtn" data-pact="new" title="${esc(t("shell.proj.newTitle", {
      name: projectName(p), tip: newAgentShortcutTip(),
    }))}">${ICON_PLUS}</button></span>`
         + `<button class="cardbtn" data-pact="menu" title="${esc(t("shell.proj.more"))}">${ICON_DOTS}</button>`;
  } else if (kind === "adopt") {
    acts = `<span class="pg"><button class="cardbtn" data-pact="adopt" title="${esc(t("shell.proj.adoptTitle", {
      path: p.path || "",
    }))}">${ICON_PLUS}</button></span>`
         + `<button class="cardbtn" data-pact="menu" title="${esc(t("shell.proj.more"))}">${ICON_DOTS}</button>`;
  }
  let tip = p.path;
  if (kind === "adopt") tip = t("shell.proj.unclassifiedTip", { path: p.path || "" });
  else if (syn) tip = t("shell.proj.defaultTip", { path: p.path || "" });
  // 「无工作目录」那一组没有可折叠的东西（它不是目录，没有 path 可记展开态），
  // 所以它不画那颗箭头 —— 画了就是一颗点了没反应的东西。
  // ⚠️ 永远画**同一个** chevron-right：展开态由 `.proj.open .tw svg` 转 90°。
  // 换字形是硬切，转过去才有"往哪边开"的动作感（Orca 的 chevron 也是这么做的）。
  const chev = kind === "bare" ? "" : svg('<path d="M9 6l6 6-6 6"/>', 12, 2);
  /* 文件夹图标**带角标**：角标就是原来那颗状态点，从"名字前面单占一格"挪到
     文件夹图标的右下角。为什么这么挪（两个好处，都不是审美）：
       · 240px 的列里，名字前面同时排着"箭头 + 状态点 + 图标"三样，光装饰就吃掉
         45px，长标题剩不下几个字；三者合成"箭头 + 带角标的文件夹"只占 34px。
       · 角标紧贴着目录图标，"这个目录里有人在等你"这句话就落在**目录**这个主语上
         —— 原来它飘在名字前面，读起来像是修饰名字的。
     槽**永远留着**（没有点也有图标）：不然有 agent 在跑的行和没有的行字都错开
     一格，"哪些项目有人干活"这件事反而要靠来回扫才知道。 */
  return `<div class="proj${open ? " open" : ""}" data-path="${esc(p.path)}"`
    + (syn ? ` data-syn="1"` : "")
    + ` data-kind="${kind}"`
    + ` data-n="${nAll}" ` +
    (kind === "bare" ? `role="group"` : `role="button" tabindex="0"`) +
    ` title="${esc(tip)}">`
    + `<span class="tw">${chev}</span>`
    + `<span class="ricon">${lucide(LIST_ICON.folder, 15)}`
    + `<span class="adot-slot">${st ? dotHTML(st) : ""}</span></span>`
    // 两行（2026-10-19 用户说"拥挤、难以描述"）：第一行只放名字，
    // 第二行放目录提示 + agent 数。名字不再和行尾动作抢同一段宽度。
    + `<span class="pbody">`
    + `<span class="nml">`
    + `<span class="nm ell">${esc(projectName(p))}</span>`
    + (kind === "proj" && p.pinned && !syn ? `<span class="pin" title="${esc(t("shell.pinned"))}">${ICON_PIN}</span>` : "")
    + `</span>`
    + `<span class="meta">`
    + (p.path ? `<span class="path ell" title="${esc(p.path)}">${esc(projPathHint(p.path))}</span>` : "")
    + `<span class="sum">${esc(sum)}</span>`
    + `</span></span>`
    + `<span class="pacts">${acts}</span>`
    + `</div>`
    // 展开的那一组 agent 行**包在一个容器里**：`renderProjLive` 就地点更新时要
    // 能一次拿到"属于这个工作区的行"，而平铺成一片就得靠 data-path 反查
    // （`.proj` 后面的行属于谁，没有别的记账方式了）。
    // ⚠️ 2026-10-20：收起时**也画**（不再从 HTML 里省掉）—— 高度用 grid
    // 0fr↔1fr 过渡，收起组用 inert 挡住点击和 Tab。这样展开/收起是动画，
    // 不是"整表重建后突然出现"。
    + agentRowsHTML(tabs, p.path, kind, closed, open);
}

function agentRowsHTML(tabs, path, kind, closed, open) {
  const crows = closed || [];
  const copen = closedOpen(path);
  /* 「已关闭」的行排在活的行**后面**，而且默认收成一行「已关闭 N」：
     它们在场的意义是"这个 agent 还在，只是收起来了"，不该和正在干活的
     行抢同一段高度（2026-10-19 用户说左栏拥挤）。点开才铺出来。 */
  const closedBlock = crows.length
    ? `<button type="button" class="closed-toggle${copen ? " open" : ""}" data-ctoggle="1" `
      + `aria-expanded="${copen ? "true" : "false"}" `
      + `title="${esc(copen
          ? t("shell.closed.toggleCollapse")
          : t("shell.closed.toggleExpand", { n: crows.length }))}">`
      + `<span class="fchev">${svg('<path d="M9 6l6 6-6 6"/>', 10, 2)}</span>`
      + `<span class="ctlabel">${esc(t("shell.closed.label"))}</span><span class="ctcount">${crows.length}</span></button>`
      + `<div class="agroup closed-list" data-path="${esc(path)}" data-kind="${kind}"`
      + `${copen ? "" : " hidden"}>`
      + crows.map(closedRowHTML).join("") + `</div>`
    : "";
  // `.agwrap` 是 0fr↔1fr 折叠的"量高度的那一层"（见 CSS）：grid 的一行只能
  // 装一个子项，所以所有行必须先包进同一个 wrapper。
  // 收起时加 inert：行还在 DOM 里（renderProjLive 照常就地更新），但点不到、
  // Tab 也进不去 —— 这和"从 HTML 里省掉"对用户是同一件事，对动画不是。
  return `<div class="agroup${open ? " open" : ""}" data-path="${esc(path)}" data-kind="${kind}"`
    + ` data-ids="${tabs.map((t) => t.id).join(",")}"${open ? "" : " inert"}>`
    + `<div class="agwrap">`
    + tabs.map(agentRowHTML).join("")
    + closedBlock
    + `</div></div>`;
}

/* 「已关闭」的 agent 行（点过 ×、记录还在）。
   和 agentRowHTML 的区别只有三处：没有 data-tab（没有运行期格子）、
   尾巴写「已关闭」而不是状态词、data-pane 是它的**跨重启身份**。
   主手势和"已停止"的行一样：点一下 = 在原座位接上（resumeClosedPane）。 */
function closedRowHTML(r) {
  const nm = closedRowName(r);
  const at = r.lastSeenAt || "";
  const dir = r.cwd || defaultWorkspacePath();
  const typ = r.agent || "claude";
  /* 接不上的那一条：行尾先说「接不上」，title 里把**为什么**说全。
     不做成 disabled —— 点它照样有回应（弹一张解释卡），只是不假装能接上。 */
  const dead = closedUnresumable(r);
  const stateWord = dead ? t("shell.closed.deadShort") : t("shell.closed.state");
  const tip = [nm, `${stateWord} · ${typ}`, dir].filter(Boolean).join("\n")
    + (dead ? "\n" + closedWhy(r) : t("shell.closed.tipResume"));
  return `<div class="arow closed${dead ? " dead" : ""}" data-pane="${r.paneId | 0}"`
    + ` data-sid="${esc(r.sessionId || "")}" role="button" tabindex="0" title="${esc(tip)}">`
    + `<span class="ricon">${lucide(AGENT_GLYPH[typ] || LIST_ICON.term, 14)}</span>`
    + `<span class="nm ell">${esc(nm)}</span>`
    + `<span class="sw">${esc(stateWord)}</span>`
    + (at ? `<span class="tm" data-at="${esc(at)}" title="${esc(absTime(at))}">${esc(rel(at))}</span>` : "")
    + `<span class="sacts">`
    + `<span class="pg"><button class="cardbtn" data-aact="resume"`
    + ` title="${esc(dead ? t("shell.closed.tipDead") : t("shell.closed.tipResumeTitle"))}">${ICON_PLAY}</button></span>`
    + `<button class="cardbtn" data-aact="menu" title="${esc(t("shell.proj.more"))}">${ICON_DOTS}</button>`
    + `</span>`
    + `</div>`;
}

/* agent 的名字：用户起的 > agent 自己报的（OSC 标题，通常就是当前任务）> 兜底。
   ⚠️ 兜底**不能**用 `runtimeTabTitle`：它末尾补的是产品名，一列 agent 全写着
   同一个产品名是假话。一个还没说话的新格就叫「新 agent」。 */
function agentRowName(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  const live = realTabTitle(tab);
  if (live) return live;
  // agent 报了一个**只有终端自己名字**的标题（Codex 0.163 的 `ok | Perch`）：
  // 标签已经因此落回产品名（defaultTabTitle），左栏要和标签说同一个名字。
  // 只在这条窄路上用产品名；标题为空（还没说话 / 退出时清空）仍走下面的兜底，
  // 免得一列还没开始干活的格全顶着同一个产品名。
  const raw = stripLeadingAgentTitleDecoration(tab.agentTitleRaw);
  if (raw && isGenericShellTitle(raw) && tab.spec && tab.spec.agent) {
    return defaultTabTitle(tab);
  }
  // 进程会把标题清空（claude 退出前发一条 OSC 0 空标题），还没报过标题的新格
  // 也是空的。这一格的身份**不该跟着进程一起消失** —— 用盘上那条会话的标题
  // 兜底，于是「已停止」的 agent 仍然叫它上次的名字，而不是「新 agent」。
  const s = tab.sessionID ? findSess(tab.sessionID) : null;
  if (s) return sessionTitle(s);
  return tab.connDown ? t("shell.agent.stoppedLabel") : t("shell.agent.newLabel");
}

/* 项目显示名：Go 合成的「默认工作区」只有一份兜底名字（落盘外的合成条目），
   它必须跟着界面语言走；用户自己加的项目一律用他起的名字。 */
function projectName(p) {
  if (!p) return "";
  return p.synthetic ? t("project.defaultName") : (p.name || "");
}

/* 这个 agent 在哪个工作区 —— 对话流头上那一行用（它取代了原来的「格 N」）。
   判据和 `tabsInProject` 是**同一处**（insidePath，方向相反），不另写一套路径比较。 */
function workspaceNameFor(t) {
  const cwd = effCwd(t);
  const p = (STATE?.projects || []).find((x) => x.path && insidePath(cwd, x.path));
  if (p) return projectName(p);
  return cwd ? (cwd.split(/[\\/]/).filter(Boolean).pop() || "") : "";
}
/* 行尾那个状态词。空闲不出词（一列「空闲 · 昨天」比只写时间更吵）；停了必须出
   —— 那是这一行和"在跑的 agent"最要紧的区别。 */
function agentStateWord(st) {
  if (st === "off") return t("state.off");
  if (!st || st === "idle") return "";
  return DOT_STATES.has(st) ? t("state." + st) : st;
}
/* 这一格"最近一次有动静"是什么时候。三元式照群组看板 g3 那一处（:5910）——
   两条面说的是同一件事，不能一处取 ask、一处取别的。`v.at` 都没有时退到
   会话库里的 updated（格子停了、内存里那份实时读数又不在的场合）。 */
function tabActivityAt(t) {
  // ⚠️ 不写 `typeof LIVE` 那道守卫：`LIVE` 是 const，TDZ 里 `typeof` 也会抛
  // （ReferenceError），守卫反而是个假保险。调用点全在 RSB_READY 之后。
  const v = LIVE.get(t.id);
  const at = (v && v.ask && v.ask.at) || (v && v.at) || "";
  if (at) return at;
  const s = t.sessionID ? findSess(t.sessionID) : null;
  return (s && s.updated) || "";
}
/* 这一格的**生效 cwd**：空串 = 没指定目录 = 落默认工作区（和 tabsInProject
   里那条映射同一份答案，见那边 :7032 的注释）。 */
function effCwd(t) {
  const defPath = (STATE?.projects || []).find((x) => x.synthetic)?.path || "";
  return (t.spec && t.spec.cwd) || defPath;
}
function tabMatch(t, key) {
  if (!key) return true;
  return `${agentRowName(t)} ${(t.spec && t.spec.agent) || ""} ${effCwd(t)}`
    .toLowerCase().includes(key);
}

/* **agent 行** = 一行：终端图标（带角标）+ 名字 + 状态词 · 相对时间 + 行尾动作。
   —— 为什么不是会话行：见上面那一大段（用户 2026-10-17 定的模型）。
   —— 图标用**方形终端**而不是对话气泡：文件夹 = 工作区、终端 = agent、气泡只留给
      右栏的子代理；三层一眼可分，不靠读字。
   —— 时间必须 .tm + data-at（60s 刷新按它重算），状态词单独一个 .sw：
      两样挤在一个元素里会被时间顶掉。
   —— 在跑的 agent 只有 ⋯；**停了的 append 一颗 ▶**（主手势 = 在原座位接上）。
      点行本身也是同一个动作，▶ 只是让"这一行可以点来继续"这件事看得见。 */
/* 行图标按 agent 类型分（**类型槽**）。现在只有一个后端，表里就一行 —— 但判据
   收在这一处：再加一个后端（pi 等）时只在这里加一条，行、菜单、状态栏都不用各写。
   缺项退回方形终端（"有终端在跑"，不去猜）。 */
const AGENT_GLYPH = {
  claude: LIST_ICON.term,
};
function agentGlyph(t) {
  return AGENT_GLYPH[(t.spec && t.spec.agent) || "claude"] || LIST_ICON.term;
}
function agentRowHTML(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  const st = cellState(tab);
  const stopped = st === "off";
  const nm = agentRowName(tab);
  const at = tabActivityAt(tab);
  const w = agentStateWord(st);
  const typ = (tab.spec && tab.spec.agent) || "claude";
  const tip = [nm, [agentStateWord(st) || (stopped ? t("state.off") : t("state.idle")), typ].join(" · "), effCwd(tab)]
    .filter(Boolean).join("\n")
    + (stopped ? t("shell.agent.tipResume") : t("shell.agent.tipOpen", { id: tab.id }));
  return `<div class="arow${tab === activeTab ? " sel" : ""}" data-tab="${tab.id}"`
    + ` data-sid="${esc(tab.sessionID || "")}" data-stopped="${stopped ? 1 : 0}"`
    + ` role="button" tabindex="0" title="${esc(tip)}">`
    + `<span class="ricon">${lucide(agentGlyph(t), 14)}`
    + `<span class="adot-slot">${dotHTML(st)}</span></span>`
    + `<span class="nm ell">${esc(nm)}</span>`
    + `<span class="sw">${esc(w)}</span>`
    + (at ? `<span class="tm" data-at="${esc(at)}" title="${esc(absTime(at))}">${esc(rel(at))}</span>` : "")
    + `<span class="sacts">`
    + (stopped ? `<span class="pg"><button class="cardbtn" data-aact="resume"`
        + ` title="${esc(t("shell.closed.tipResumeTitle"))}">${ICON_PLAY}</button></span>` : "")
    + `<button class="cardbtn" data-aact="menu" title="${esc(t("shell.proj.more"))}">${ICON_DOTS}</button>`
    + `</span>`
    + `</div>`;
}

/* 2026-10-17 退役（左栏不再有会话实体）：`sessRowsHTML` / `sessRowHTML` /
   `PROJ_CAP` / `projShowAll` / `openSessRow` 一起删掉了。
   ⚠️ `sessMatch` 留着 —— 右栏「子代理」那一组还在用它过滤卡片；
      `connectSession` 也留着 —— 卡片上的「接上这条会话」还在走它。 */

// 池子空着：一条说明 + 一颗键。**不做整屏 Landing** —— 我们中栏是终端网格，
// 没项目也能开终端，一整屏落地页会把能干的事挡掉（Orca 需要它是因为它空着的
// 时候主区真的没内容）。
function poolEmptyHTML(key) {
  if (key) return `<div class="empty">${esc(t("shell.projects.emptyMatch"))}</div>`;
  return `<div class="empty">${esc(t("shell.projects.empty"))}`
    + `<div><button class="btn" data-pact="add">${ICON_PLUS}<span>${esc(t("shell.projects.add"))}</span></button></div>`
    + `<div style="margin-top:8px">${esc(t("shell.projects.note"))}</div></div>`;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

// 过滤：主会话和子代理共用一条（搜索要能命中用户起的名字，否则"我明明给它起过
// 名字"搜不到，很伤）。
function sessMatch(s, key) {
  if (!key) return true;
  return `${sessionTitle(s)} ${s.title} ${s.cwd} ${s.preview} ${s.slug} ${s.agentName}`
    .toLowerCase().includes(key);
}

/* 左栏的内容 = **agent**（一行一格），按 `spec.cwd` 归属到工作区。
   ⚠️ 这里**不再读 `STATE.sessions` / `STATE.assign`**：会话不再是界面实体
   （见上面"行的 HTML"那一大段）。归属判定只有 `tabsInProject` 一处，
   Go 那边数的是会话库 —— 两条不再是同一条不变量，别再拿它们往一起对。 */
function renderWorkspaceView(key) {
  const projs = STATE?.projects || [];
  const used = new Set();
  const usedClosed = new Set();
  const rows = [];
  for (const p of projs) {
    const mine = tabsInProject(p.path);
    const cmine = closedInProject(p.path);
    // `used` 收的是**归属已定**的格（哪怕搜索把它藏起来了）—— 否则搜索时
    // 它们会作为"未归类"漏到下面那一段，同一个 agent 在一屏上出现两次。
    // 「已关闭」那几条同理（它们没有 tab id，按 paneId 记账）。
    mine.forEach((t) => used.add(t.id));
    cmine.forEach((r) => usedClosed.add(r.paneId));
    const selfHit = !!key &&
      `${projectName(p)} ${p.name} ${p.path}`.toLowerCase().includes(key);
    const shown = (key && !selfHit) ? mine.filter((t) => tabMatch(t, key)) : mine;
    const shownClosed = (key && !selfHit) ? cmine.filter((r) => closedMatch(r, key)) : cmine;
    if (key && !selfHit && !shown.length && !shownClosed.length) continue;
    // 第 4 个参数是**这个工作区一共几个**（搜索时行尾那个数不跟着缩水）；
    // 已关闭的 agent 也算（关格 ≠ 删，它们仍然是这个工作区的 agent）。
    rows.push(projRowHTML(p, shown, "proj", mine.length + cmine.length, shownClosed, !!key));
  }
  /* ⚠️ 空态**不能**再用"行数 == 0"判：默认工作区是 Go 合成的、永远在，
     所以池子空着的时候也有一行 —— 那颗「添加项目」会再也不出现（首启的
     第一屏就会变成"只有一行默认工作区"）。判据改成"有没有用户自己的项目"：
     一个都没有就把那段说明和那颗键放在默认工作区**上面**。 */
  const anyReal = projs.some((p) => !p.synthetic);
  const rowsHTML = rows.join("");
  const empty = rowsHTML ? (anyReal ? "" : poolEmptyHTML("")) : poolEmptyHTML(key);
  $("proj-list").innerHTML = empty + rowsHTML;

  // 未归类：**不在任何项目目录里的 agent**，按生效 cwd 分组（和 tabsInProject
  // 同一套判据：空串 = 默认工作区，那里已经归过一遍了）。
  const unAll = TAB_LIST.filter((t) => t.id > 0 && !used.has(t.id));
  const unClosed = closedList().filter((r) => !usedClosed.has(r.paneId));
  const groups = new Map();   // 生效 cwd → {tabs:[], closed:[]}
  const bucket = (c) => {
    if (!groups.has(c)) groups.set(c, { tabs: [], closed: [] });
    return groups.get(c);
  };
  for (const t of unAll) bucket(effCwd(t) || "").tabs.push(t);
  for (const r of unClosed) bucket(r.cwd || defaultWorkspacePath()).closed.push(r);
  const ug = [...groups.entries()]
    .map(([cwd, g]) => {
      const selfHit = !!key && cwd.toLowerCase().includes(key);
      return {
        cwd,
        shown: selfHit ? g.tabs : g.tabs.filter((t) => tabMatch(t, key)),
        shownClosed: selfHit ? g.closed : g.closed.filter((r) => closedMatch(r, key)),
        total: g.tabs.length + g.closed.length,
      };
    })
    .filter((g) => !key || g.shown.length || g.shownClosed.length)
    .sort((a, b) => b.total - a.total);
  if (!ug.length) { $("un-view").innerHTML = ""; return; }
  let uh = `<div class="grp">${esc(t("shell.projects.unclassified"))}<span class="b">${unAll.length + unClosed.length}</span></div>`;
  for (const { cwd, shown, shownClosed, total } of ug) {
    if (!cwd) {
      // 连生效 cwd 都没有（项目池还没到）：池子里放的是目录，它没有可收编的东西 ——
      // 不给动作键（不是"灰着点不动"，是这里根本没有那个动作）。
      uh += projRowHTML({ path: "", name: t("shell.projects.noCwd"), pinned: false }, shown, "bare", total, shownClosed, !!key);
      continue;
    }
    uh += projRowHTML({ path: cwd, name: shortPath(cwd), pinned: false }, shown, "adopt", total, shownClosed, !!key);
  }
  $("un-view").innerHTML = uh;
}

// 左栏**只有这一块**了（「全部会话」那个平铺视图 2026-10-16 退役，见墓碑注释）——
// 于是这里不再有分派，只剩"重画左栏 + 重画左栏外面那几块"。
// ⚠️ `cardHTML` 本身**没退役**：右栏的「子代理」模块还在用它（renderSideList），
//    所以在下面看到 `.card` 的监听不要以为是死代码。
function renderLists(key) {
  /* ⚠️ 正在给**左栏/右栏**里的一条会话改名时，整表不许重画：这两块列表是
     `innerHTML` 整份重建的，重画一次编辑框连草稿一起消失 —— 而用户那边看起来
     只是"字不见了"（没有任何报错，也没有任何一条日志）。
     挡的是"编辑那一两秒里正常来了一条 shell 载荷 / 状态推送"这种事：列表晚一拍，
     编辑框活着。改完之后那次重画由 closeRename 自己发起。
     不挡标签那条改名：标签头是**各自**建的（`renderTabTitle` 有它自己那条
     `tabEditing && t === renameTab` 守卫），重画左栏动不了它。 */
  if (renameSess) return;
  const all = STATE?.sessions || [];
  const side = all.filter((s) => s.sidechain && sessMatch(s, key));
  renderSideList(side);

  renderWorkspaceView(key);
  syncCounts();

  // 勾选态和点击：**两个列表一起**（主会话在左栏、子代理在右栏）。
  // 用全局 `.card` 而不是 `#scroll .card`：卡片分居两处，写死容器名的话
  // 加一处新列表就静默漏一处。
  document.querySelectorAll(".card").forEach((el) => {
    el.addEventListener("click", () => selectSession(el.dataset.id));
    // ⚠️ 卡片是个 `role="button"` 的 div，浏览器**不会**替它把 Enter/Space 转成
    // click（那是真 <button> 才有的待遇）。少了这一段，键盘就用不了卡片。
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();          // 空格默认会滚一屏
        selectSession(el.dataset.id);
      }
    });
    el.classList.toggle("sel", el.dataset.id === selected?.id);
  });
}

/* 右栏那个「子代理」模块。C7 起它是排序过的（进行中的排最前，照 Orca 的
   attention-first），组内顺序不动。 */
function renderSideList(side) {
  const sideSt = new Map(side.map((x) => [x.id, subStateOf(x)]));
  side.sort((a, b) => (sideSt.get(a.id) === "run" ? 0 : 1) - (sideSt.get(b.id) === "run" ? 0 : 1));
  const sideRun = Array.from(sideSt.values()).filter((v) => v === "run").length;
  const cap = $("side-cap");
  if (cap) cap.textContent = t("shell.side.cap", { n: side.length }) +
    (sideRun ? t("shell.side.running", { n: sideRun }) : "");
  const list = $("side-list");
  if (list) list.innerHTML = side.map(cardHTML).join("");
}

/* 只补"活的那几个数"：状态点、N 在跑、"这条会话是不是正在被跑"。
   ⚠️ **绝不整表重建** —— 重建会把展开态、滚动位置、还有正在编辑的名字输入框
   一起抹掉，而这条函数是被每格的状态变化（每 400–700ms 都可能）叫醒的。
   签名对不上才走整表那条路（项目增删/改名走的是 Go 的 pool 消息，那条会全量重画）。
   ⚠️ `projLiveRaf` 声明在**启动那一段之前**（和 RSB_READY / groupRaf 一起）——
   这条函数在启动路径上就会被叫到，理由见那一段的注释。 */
function scheduleProjLive() {
  if (projLiveRaf) return;
  projLiveRaf = requestAnimationFrame(() => {
    projLiveRaf = 0;
    // 和 scheduleLive 同一道闸：启动那一段里有 await，消息可能落在"脚本还没
    // 求值完"的缝里 —— 那时下面要用的那些 const（GROUP_RANK 等）还在 TDZ 里。
    if (RSB_READY) renderProjLive();
  });
}
function renderProjLive() {
  // ① 工作区行：状态点 + 「N agent」
  for (const el of document.querySelectorAll("#proj-list .proj, #un-view .proj")) {
    const kind = el.dataset.kind || "proj";
    const path = el.dataset.path || "";
    // "bare"（连生效 cwd 都没有）那一组不数东西；其余照 tabsInProject 那**一处**归属
    const tabs = kind === "bare" ? [] : tabsInProject(path);
    const st = projDotState(tabs);
    const slot = el.querySelector(".adot-slot");
    if (slot) {
      const cur = slot.firstElementChild;
      if (st && !cur) slot.innerHTML = dotHTML(st);
      else if (!st && cur) slot.innerHTML = "";
      else if (st && cur) paintDot(cur, st);
    }
    // "bare"（连生效 cwd 都没有）那一组的行是**渲染时点出来的**，没有可现算的
    // 目录 → 数它当初写下的那个数（`data-n`），别把它写成 0。
    // 「已关闭」的 agent 也算这个工作区的东西（关格 ≠ 删）。
    const n = kind === "bare" ? Number(el.dataset.n || 0)
      : tabs.length + closedInProject(path).length;
    const sum = el.querySelector(".sum");
    if (sum) sum.textContent = `${n} agent`;
    el.dataset.n = String(n);
  }
  // ② agent 行：**就地补**（每 400–700ms 就可能来一次，整表重建会杀 hover、
  //    滚动位置和正在编辑的名字框）。只有"行的形状"变了才整行换一次 ——
  //    停/跑切换会多出/收回那颗 ▶，时间从无到有会多出一个 `.tm`。
  for (const el of document.querySelectorAll("#proj-list .arow[data-tab], #un-view .arow[data-tab]")) {
    const t = liveTab(el.dataset.tab | 0);
    if (!t) continue;
    const st = cellState(t);
    const at = tabActivityAt(t);
    const stopped = st === "off";
    if ((el.dataset.stopped === "1") !== stopped || (!at) !== !el.querySelector(".tm")) {
      // 正在改这一行的名：输入框就挂在行里，换一行等于连草稿一起删掉
      if (renameSess && t.sessionID === renameSess) continue;
      el.outerHTML = agentRowHTML(t);
      continue;
    }
    el.classList.toggle("sel", t === activeTab);
    const slot = el.querySelector(".adot-slot");
    if (slot) {
      const cur = slot.firstElementChild;
      if (!cur) slot.innerHTML = dotHTML(st);
      else paintDot(cur, st);
    }
    const nm = el.querySelector(".nm");
    const name = agentRowName(t);
    if (nm && nm.textContent !== name) nm.textContent = name;
    const sw = el.querySelector(".sw");
    const word = agentStateWord(st);
    if (sw && sw.textContent !== word) sw.textContent = word;
    const tm = el.querySelector(".tm");
    if (tm) {
      if (tm.dataset.at !== at) tm.dataset.at = at;
      const r = rel(at);
      if (tm.textContent !== r) tm.textContent = r;
    }
  }
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

function poolSend(obj) { sendCtrl(obj); }

// 「在这个目录新开一格」。走的是**同一条**建格路（createTab + 默认启动意图）——
// 不另开一条"按 cwd 建格"的路：那条路一旦和主路分叉，护栏、拒绝收尾、PTY 首帧
// 尺寸这些东西就得各维护一份。
async function newTabIn(dir, why, agent) {
  if (soloTab) backToGrid();
  // 第三参是选择面板选中的 agent；左栏/项目的一键入口不传，走设置里的默认。
  const pick = agent || defaultAgentId();
  const t = await createTab({ agent: pick, cwd: dir || "",
    resume: { kind: "new", id: "" } }, { fresh: true });
  if (!t || !TAB_LIST.includes(t)) return;
  // 新格在**开始干活之前**可以换 Agent（见 10-term 的 armFreshCell）。
  // 只标用户明确新开的格子：接上已有、冷恢复、启动默认格都不带这个 opts。
  armFreshCell(t, why || "新开一格");
  if (collapsed) goToTab(t, why || "左栏 +");
  else setActive(t);
  sendCtrl({ type: "log", msg: `左栏新开一格 agent=${pick} cwd=${dir || "(默认)"} ` +
    `→ tab=${t.id}（${why || "+"}）` });
}

/* ---- 新格的 Agent 切换（2026-10-20）--------------------------------------
   用户定的形态：新开的一格在**开始干活之前**可以换 Agent；一旦打了字或来了
   任何非 SessionStart 的 hook，这一格就定下来了（见 10-term 的 freshCellStarted）。
   换法**不是原地改 spec**：这一格已经起了一条 PTY、可能还占着一条 pane 记录。
   正确做法是：
     ① 等 paneId（tab.ok 的应答）—— pane.forget 只认这个身份，不认 tab id；
     ② pane.forget 丢掉刚起的空座位（新格不该在左栏留下一条「已关闭」幽灵）；
     ③ 关流、用**同一个 cwd、新的 Agent、不带旧 paneId** 再建一格；
     ④ 插回原来的座位序，跳进去。
   ⚠️ 不写文件夹记忆：记忆只由新建卡片里的**明确选择**写（见 ns-create）。
   ⚠️ 绝不原地切一个已经干活的会话 —— 那会把它的上下文和记录一起弄丢。
     以后要做 Orca 那种 "Hand Off"，是**另起一格**，不是改这一格。
   ⚠️ 新格可能还没拿到 paneId（tab.ok 在 2s 超时那条路上没回来）。这里等一小段，
     拿不到就明说"换不了"，不要拿着 pane=0 去 forget（Go 会回"盘上没有"，
     而格子已经被关掉，用户没有第二次机会）。 */
async function waitFreshPane(t, timeoutMs) {
  const until = Date.now() + (timeoutMs || 5000);
  while (Date.now() < until) {
    if (!t || !TAB_LIST.includes(t)) return 0;
    const p = t.paneID | 0;
    if (p > 0) return p;
    if (t.resumeRefused) return 0;   // 已经明确被拒：没有可忘掉的座位
    await new Promise((r) => setTimeout(r, 80));
  }
  return (t && (t.paneID | 0)) || 0;
}

async function switchFreshAgent(tab, agentId) { // 参数别叫 t：会遮住 i18n 的 t()
  if (!tab || !TAB_LIST.includes(tab) || !tab.fresh || tab.freshSwitching) return;
  const a = opAgentById(agentId);
  if (!opLaunchable(a)) {
    showToast(t("shell.toast.switchUnavailableTitle"),
      t("shell.toast.switchUnavailableNote", { name: (a && a.name) || agentId }), "err");
    sendCtrl({ type: "log", msg: `新格换 Agent 拒绝：${agentId} 不可启动 tab=${tab.id || 0}` });
    return;
  }
  const cur = (tab.spec && tab.spec.agent) || "";
  if (cur === agentId) {
    sendCtrl({ type: "log", msg: `新格换 Agent：已经是 ${agentId}，不动 tab=${tab.id}` });
    return;
  }
  tab.freshSwitching = true;
  // 正常情况下 newTabIn 是在 tab.ok 之后才 arm 的，paneId 已经在；这里防的是
  // "tab.ok 超时但格子留着"那条路（见 spawnTab 的兜底注释）。
  const pane = (tab.paneID | 0) || await waitFreshPane(tab, 5000);
  // 等待期间用户可能打了字（门已关），也可能把格子关了 —— 两种都不许再动手。
  if (!TAB_LIST.includes(tab) || !tab.fresh) {
    sendCtrl({ type: "log", msg:
      `新格换 Agent 放弃 tab=${tab.id || 0}：等待期间已开始工作或被关掉` });
    return;
  }
  if (!pane) {
    tab.freshSwitching = false;
    showToast(t("shell.toast.switchPendingTitle"), t("shell.toast.switchPendingNote"), "err");
    sendCtrl({ type: "log", msg: `新格换 Agent 放弃 tab=${tab.id || 0}：没有 paneId` });
    return;
  }
  const at = TAB_LIST.indexOf(tab);
  const cwd = (tab.spec && tab.spec.cwd) || "";
  sendCtrl({ type: "log", msg: `新格换 Agent tab=${tab.id} pane=${pane} ` +
    `${cur} → ${agentId} cwd=${cwd || "(默认)"} 座位序=${at}` });
  /* forget = 删掉刚起的空座位；reseat = 别发 lib.reload（那是一次同步重扫，
     会把紧接着的 tab.new 顶掉两秒多，见 closeTab 末尾那段实测）。 */
  closeTab(tab, { forget: true, reseat: true, why: `新格换 Agent → ${agentId}` });
  const nt = await createTab({ agent: agentId, cwd,
    resume: { kind: "new", id: "" } }, { fresh: true });
  if (!nt || !TAB_LIST.includes(nt)) {
    // 旧格已经关了，这一步失败没有退路 —— 必须说出来，不能静默丢一格。
    showToast(t("shell.toast.switchFailedTitle"), t("shell.toast.switchFailedNote"), "err");
    sendCtrl({ type: "log", msg: `新格换 Agent 失败：旧 tab=${tab.id} 已关，新格没起来（agent=${agentId}）` });
    return;
  }
  // 插回原来的座位序（网格的列序就是 TAB_LIST 序；关掉之后原下标正好是新插入点）。
  if (at >= 0) {
    const i = TAB_LIST.indexOf(nt);
    if (i >= 0) {
      TAB_LIST.splice(i, 1);
      TAB_LIST.splice(Math.min(at, TAB_LIST.length), 0, nt);
    }
    renderGrid();
  }
  armFreshCell(nt, `从 ${cur || "?"} 换过来`);
  jumpInto(nt, "换 Agent");
  armRailRebuild();
  sendCtrl({ type: "log", msg: `新格换 Agent 完成 tab=${nt.id} pane=${nt.paneID || 0} ` +
    `agent=${agentId} 座位序=${TAB_LIST.indexOf(nt)}` });
}

/* ---- 新建格快捷键（2026-10-20）------------------------------------------
   快捷键是**唯一**不走选择卡片的添加路径：它明确地说"用这个文件夹上次的
   Agent"。落在当前格所在的文件夹（currentWorkspacePath 已经把 cwd 归到
   最近的项目行）；没有格就落在默认工作区。
   解析顺序：文件夹记忆 → 全局默认/自动。
   · 记忆里有、但现在起不来：打开卡片说明，不静默换人（用户 2026-10-20 选 A）。
   · 没有记忆：用全局默认；这是正常的默认路径，不弹卡片。
   · 快捷键**不写记忆** —— 只有卡片里的明确选择写。
   · 捕获阶段 preventDefault：xterm 的 keydown 在冒泡阶段，不拦的话组合键
     会先被发给 PTY（同 Ctrl+Shift+B 那条注释）。 */
function shortcutTargetFolder() {
  return (typeof currentWorkspacePath === "function" && currentWorkspacePath()) || "";
}
function runNewAgentShortcut() {
  const cwd = shortcutTargetFolder();
  const remembered = lastAgentFor(cwd);
  const cat = opCatalog();
  const avail = cat.filter(opLaunchable);
  const nameOf = (id) => (cat.find((a) => a && a.id === id) || {}).name || id;
  if (remembered && !avail.some((a) => a.id === remembered)) {
    sendCtrl({ type: "log", msg: `快捷键：文件夹记忆 ${remembered} 不可用 → 打开选择卡片 cwd=${cwd || "(默认)"}` });
    showToast(t("shell.toast.lastUnavailableTitle"),
      t("shell.toast.lastUnavailableNote", { name: nameOf(remembered) }), "err");
    openNewSpace({ folder: cwd, why: "快捷键（上次的 Agent 不可用）" });
    return;
  }
  const agent = remembered || defaultAgentId();
  if (!avail.some((a) => a.id === agent)) {
    sendCtrl({ type: "log", msg: `快捷键：没有可启动的 Agent（尝试 ${agent}）→ 打开选择卡片` });
    showToast(t("shell.toast.noAgentTitle"), t("shell.toast.noAgentNote"), "err");
    openNewSpace({ folder: cwd, why: "快捷键（没有可启动的 Agent）" });
    return;
  }
  sendCtrl({ type: "log", msg: `快捷键新开一格 agent=${agent} cwd=${cwd || "(默认)"} ` +
    `来源=${remembered ? "文件夹记忆" : "默认"}` });
  newTabIn(cwd, "快捷键", agent);
}
/* 输入框/下拉里不抢键；但 xterm 的隐藏 textarea 是终端输入，必须放行。 */
function shortcutTypingTarget(t) {
  const el = t && t.closest ? t.closest("input, textarea, select, [contenteditable='true']") : null;
  if (!el) return false;
  if (el.classList && el.classList.contains("xterm-helper-textarea")) return false;
  return true;
}
function shortcutOverlayOpen() {
  for (const id of ["newspace", "fview", "confirm"]) {
    const el = document.getElementById(id);
    if (el && !el.hidden) return true;
  }
  const menu = document.getElementById("cardmenu");
  return !!(menu && menu.classList.contains("on"));
}
document.addEventListener("keydown", (e) => {
  if (SHORTCUT_RECORDING) return;
  if (e.repeat || e.metaKey) return;
  if (!shortcutMatches(e, SETTINGS.newAgentShortcut)) return;
  if (shortcutTypingTarget(e.target)) return;
  if (shortcutOverlayOpen()) return;
  // 只 preventDefault（不 stopPropagation）：xterm 的监听器第一行查
  // defaultPrevented，看到就整条跳过 —— 和 Ctrl+Shift+B 同一条路。
  e.preventDefault();
  runNewAgentShortcut();
}, true);

/* 进入一个 agent：先把"群组看板"那一屏切回网格，再把右栏对话流的主语交回
   实时格（用户 2026-10-17 的原话：点一个 agent，右栏呈现的就是它的对话流）。
   ⚠️ `flowToLive` 必须在 `jumpToTab` 之外显式叫：那条路只切当前格，不换
   对话流的主语 —— 如果用户刚才在看某个子代理（flowSub.kind="lib"），
   不叫这一句，点完 agent 右栏还停在那张子代理卡上。 */
function jumpInto(t, why) {
  if (!t) return;
  setTermCollapsed(false);
  flowToLive(why || "进格");
  jumpToTab(t, why || "进格");
  sendCtrl({ type: "log", msg: `左栏 → 进格 tab=${t.id}（${why || ""}）` });
}

/* 「接上这个 agent」：**在原座位**继续它上次的对话。
   做法是把那个停了的格子收掉（不带 forget —— 记录是证据，不许动），再用
   **同一个 paneId** + `resume: exact` 建一格，然后把它挪回原来的座位序。
   paneId 由前端原样回传、Go 那边 claim（panes.go:236）—— 所以对用户来说
   还是同一个 agent，只是终端又活了。

   ⚠️ 为什么不是"新开一格、旧格留着"：那会在网格里留下一个死壳，而 agent
   模型里"座位"是它的位置，不是一次性的容器（用户 2026-10-17 定）。 */
async function resumeAgentInSeat(t) {
  if (!t) return;
  if (!t.connDown) { jumpInto(t, "它还在跑"); return; }
  const at = TAB_LIST.indexOf(t);
  const pane = t.paneID | 0;
  const sid = t.sessionID || "";
  const spec = {
    agent: (t.spec && t.spec.agent) || DEFAULT_SPAWN_SPEC.agent,
    cwd: (t.spec && t.spec.cwd) || "",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    // 同一个身份：Go 那边认领旧记录，不换 paneId（见 panes.go 的 claim）
    paneId: pane || undefined,
  };
  sendCtrl({ type: "log", msg: `接上 agent tab=${t.id} pane=${pane} sid=${sid ? sid.slice(0, 8) : "(无)"} 座位序=${at}` });
  // ⚠️ 不带 forget（记录是证据）；reseat = 别发 lib.reload（见 closeTab 末尾那段：
  //    它同步重扫会话库，会把紧接着的 tab.new 顶掉两秒多）。
  closeTab(t, { reseat: true });
  const nt = await createTab(spec);
  if (!nt || !TAB_LIST.includes(nt)) return;
  // 插回原来的座位序（网格的列序就是 TAB_LIST 序）。关掉之后数组短了一格，
  // 原来的下标正好是新的插入点。
  if (at >= 0) {
    const i = TAB_LIST.indexOf(nt);
    if (i >= 0) {
      TAB_LIST.splice(i, 1);
      TAB_LIST.splice(Math.min(at, TAB_LIST.length), 0, nt);
    }
    renderGrid();
  }
  jumpInto(nt, "接上 agent");
  armRailRebuild();
}

/* 让一格**自己退**，并等到它的流真的断了。和 stopAgent 同一个手势（写
   `/exit`，再单独一次回车，见那里为什么拆成两次），但它是“等结果”的版本：
   重开必须等旧进程写完会话文件，否则就是在它背后另起一个写者。 */
async function stopAgentAndWait(tab, ms) {
  if (!tab) return false;
  if (tab.connDown) return true;
  if (!tab.ready || !tab.stream) return false;
  try { tab.stream.send(enc.encode("/exit")); } catch (e) {
    jserr("stopAgentAndWait", e);
    return false;
  }
  setTimeout(() => {
    try { if (!tab.connDown && tab.stream) tab.stream.send(enc.encode("\r")); }
    catch (e) { jserr("stopAgentAndWait/enter", e); }
  }, 300);
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 8000)) {
    if (tab.connDown) return true;
    if (!TAB_LIST.includes(tab)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return !!tab.connDown;
}

/* 等这一格的流真的断。stopSetupAgent 用。 */
async function waitTabDown(tab, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!TAB_LIST.includes(tab) || tab.connDown) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return !TAB_LIST.includes(tab) || !!tab.connDown;
}

/* 首启/登录页的停止：/exit 在引导页里可能被当成普通字符，所以要再试 Ctrl+C。
   调用方只在「确认不是 working」时才会走强制关闭；这里返回是否已经停了。 */
async function stopSetupAgent(tab) {
  if (!tab) return true;
  if (tab.connDown) return true;
  if (!tab.ready || !tab.stream) return false;
  // ⚠️ agy 的首启/登录页是菜单（↑/↓ + Enter）。往菜单里写 `/exit` + Enter 不是
  // 退出，而是选中高亮项 —— 实测会去点 Google OAuth。所以 agy 只发 Ctrl+C；
  // 退不掉就交给 reopenAgentForModel 的首启页关 PTY 兜底。
  const menu = tab.spec && tab.spec.agent === "agy";
  if (!menu) {
    try { tab.stream.send(enc.encode("/exit")); } catch (e) { jserr("stopSetupAgent/exit", e); }
    setTimeout(() => {
      try { if (!tab.connDown && tab.stream) tab.stream.send(enc.encode("\r")); }
      catch (e) { jserr("stopSetupAgent/enter", e); }
    }, 250);
    if (await waitTabDown(tab, 1400)) return true;
  }
  for (let i = 0; i < (menu ? 3 : 2) && !tab.connDown; i++) {
    try { if (tab.stream) tab.stream.send(enc.encode("\x03")); }
    catch (e) { jserr("stopSetupAgent/ctrlc", e); }
    if (await waitTabDown(tab, 900)) break;
  }
  // dsh 的 Ctrl+C 是“跳过引导”而不是退出；跳进聊天后再走一次 /exit。
  if (!menu && !tab.connDown) {
    try {
      if (tab.stream) {
        tab.stream.send(enc.encode("/exit"));
        setTimeout(() => { try { if (!tab.connDown && tab.stream) tab.stream.send(enc.encode("\r")); } catch (e) {} }, 220);
      }
    } catch (e) { jserr("stopSetupAgent/exit2", e); }
    await waitTabDown(tab, 1200);
  }
  return !TAB_LIST.includes(tab) || !!tab.connDown;
}

/* 「换模型 → 重开并续接」：模型是 agent 级配置，PTY 里已经跑起来的进程不会
   热换，所以按用户确认重开这一格。先让旧进程**自己退**（不 TerminateProcess：
   那会截断正在写的会话文件），等它真的停了，再按 resumeAgentInSeat 的同一条
   路接回来 —— 同一个 paneId + exact 会话、记录不删、座位序不变。
   opts.setup：这一格停在首启/登录页，可以走 Ctrl+C/关 PTY 的兜底；
   opts.quiet：批量重开时由调用方统一提示，不逐格 toast。 */
async function reopenAgentForModel(tab, opts) {
  opts = opts || {};
  if (!tab || !TAB_LIST.includes(tab)) return;
  const at = TAB_LIST.indexOf(tab);
  const pane = tab.paneID | 0;
  const sid = tab.sessionID || "";
  const spec = {
    agent: (tab.spec && tab.spec.agent) || DEFAULT_SPAWN_SPEC.agent,
    cwd: (tab.spec && tab.spec.cwd) || "",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    paneId: pane || undefined,
  };
  let forced = false;
  if (!tab.connDown) {
    const stopped = opts.setup ? await stopSetupAgent(tab) : await stopAgentAndWait(tab, 8000);
    if (!stopped) {
      // 首启页不响应 /exit 和 Ctrl+C：确认屏上仍是首启页（或已经回到空闲），
      // 就关掉 PTY。若用户已经打字、agent 正在干活，就不动它。
      // 这不是“杀一个正在工作的会话”——setup 页里没有正在写的任务；
      // 会话记录和 paneId 都还在，下面按原座位重开。
      const stillSetup = paneSetupKind(tab) !== "";
      const st = cellState(tab);
      if (opts.setup && (stillSetup || st === "idle" || st === "off")) {
        forced = true;
        sendCtrl({ type: "log", msg:
          `首启页停止兜底：关 PTY tab=${tab.id} pane=${pane} setup=${stillSetup ? "yes" : "no"} state=${st}` });
        closeTab(tab, { reseat: true });
      } else {
        showToast(t("term.model.stopFailed"), t("term.model.stopFailedNote"), "err");
        return;
      }
    }
    if (!forced && !TAB_LIST.includes(tab)) return;   // 等待期间用户自己关掉了
  }
  sendCtrl({
    type: "log",
    msg: `换模型重开 tab=${tab.id} pane=${pane} sid=${sid ? sid.slice(0, 8) : "(无)"} ` +
      `座位序=${at} setup=${opts.setup ? "yes" : "no"} forced=${forced ? "yes" : "no"}`,
  });
  // 不带 forget（记录是证据）；reseat 挡掉 lib.reload，见 closeTab 末尾那段。
  if (!forced) closeTab(tab, { reseat: true });
  const nt = await createTab(spec);
  if (!nt || !TAB_LIST.includes(nt)) return null;
  if (at >= 0) {
    const i = TAB_LIST.indexOf(nt);
    if (i >= 0) {
      TAB_LIST.splice(i, 1);
      TAB_LIST.splice(Math.min(at, TAB_LIST.length), 0, nt);
    }
    renderGrid();
  }
  if (typeof watchFirstRun === "function") watchFirstRun(nt);
  jumpInto(nt, "换模型后重开");
  armRailRebuild();
  // resumed=false = 没有会话 id，开的是新会话。调用方不能再说“同一条对话”。
  const resumed = !!sid;
  if (!opts.quiet) {
    showToast(t("term.model.reopened"),
      t(resumed ? "term.model.reopenedNote" : "term.model.reopenedNewNote"), "ok");
  }
  return { tab: nt, resumed };
}

/* 「停止这个 agent」= 让它自己退，**不是杀进程**。
   手法和用户自己动手一模一样：往它的 PTY 写 `/exit\r`（claude 自己的退出路径，
   会写完会话、打印 resume 提示）。不用 TerminateProcess：那会把正在写的 jsonl
   拦腰截断，而磁盘上那份对话正是这个产品的持久化本体。
   退出之后由 Go 的进程监看关流（见 main.go handleTab 里那段），前端 onclose →
   connDown → 行翻「已停止」+ ▶。这里**不自己改状态**：状态的唯一来源是流。 */
function stopAgent(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  if (!tab || tab.connDown) return;
  if (!tab.ready || !tab.stream) {
    showToast(t("shell.toast.cannotStopTitle"), t("shell.toast.cannotStopNote"), "err");
    return;
  }
  /* ⚠️ 文字和回车**分两次写**。实测（Codex 0.163.0 TUI，2026-10-19）：同一次写入
     里到达的 `/exit\r` 只被当成"输入 /exit，再换一行" —— composer 里留下一个
     多行草稿，命令根本不提交；单独一次 Enter 才真的退出。Claude 两种写法都认，
     所以统一按人的手势拆开，不在通用路径里按 agent 分叉。
     300ms 是 live 测试里验证过能稳定提交的间隔（文字与回车分开写那一段）。 */
  const st = tab.stream;
  try { st.send(enc.encode("/exit")); }
  catch (e) {
    jserr("stopAgent", e);
    showToast(t("shell.toast.stopFailedTitle"), t("shell.toast.stopFailedNote"), "err");
    return;
  }
  setTimeout(() => {
    try { st.send(enc.encode("\r")); }
    catch (e) { jserr("stopAgent", e); }
  }, 300);
  showToast(t("shell.toast.stopSentTitle"), t("shell.toast.stopSentNote"), "ok");
  sendCtrl({ type: "log", msg: `停止 agent tab=${tab.id} pane=${tab.paneID || 0}（发 /exit）` });
}

/* 「结束这个 agent」= 用户明确不要它了：**座位和记录一起删**（forget）。
   磁盘上的对话文件一个字节都不动 —— 这句话要同时出现在菜单的 title 里和
   结果提示里（动手前说一次、动完之后再说一次，理由同 removeProj）。 */
async function endAgent(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  if (!tab) return;
  if (SETTINGS.confirmEndAgent) {
    const ok = await askConfirm({
      title: t("shell.end.title"),
      body: t("shell.end.paneBody", { name: currentTabTitle(tab) }),
      ok: t("shell.end.ok"),
      danger: true,
    });
    if (!ok) {
      sendCtrl({ type: "log", msg: `结束 agent tab=${tab.id}：用户在确认框里取消了` });
      return;
    }
  }
  const pane = tab.paneID | 0;
  closeTab(tab, { forget: true, why: "左栏「结束这个 agent」" });
  armRailRebuild();
  showToast(t("shell.end.donePane"), t("shell.end.donePaneNote"), "ok");
  sendCtrl({ type: "log", msg: `结束 agent tab=${tab.id} pane=${pane}（记录已摘，会话文件未动）` });
}

/* 「接上这个已关闭的 agent」：用户点 × 只是收起来，记录还在（paneId + 会话 id）。
   用**同一个 paneId** + exact 起一格 —— Go 的 claim 会把 Closed 撤掉、写回盘，
   对用户来说还是同一个 agent，只是终端又活了。
   ⚠️ 和 resumeAgentInSeat 的区别只有一个：那条路手里有一个**停着的格子**
   （要先把壳收掉），这条路连壳都没有 —— 关格那一刻就收掉了。 */
async function resumeClosedPane(r) {
  if (!r || r.busy) return;
  /* 已经知道接不上（盘上没有会话文件）：**别装作试一下**，直接把原因和出路
     说清楚。用户最容易困惑的正是这一下 —— "点了没反应/报个看不懂的错"。 */
  if (closedUnresumable(r)) {
    showToast(t("shell.closed.resumeFailTitle"), closedWhy(r), "err");
    sendCtrl({ type: "log", msg: `已关闭的 agent 接不上 pane=${r.paneId}（盘上没有会话文件，未发起接上）` });
    return;
  }
  /* 同一条会话已经有一格在跑：绝不再建第二格（两个写者写同一份 jsonl 是
     这个项目唯一不可逆的失败）。直接跳过去，并说出来。 */
  const lv = r.sessionId ? tabForSession(r.sessionId) : null;
  if (lv) {
    jumpInto(lv, "这条会话已经在跑");
    showToast(t("shell.closed.alreadyRunningTitle"),
      t("shell.closed.alreadyRunningNote", { id: lv.id }), "info");
    return;
  }
  r.busy = true;
  const pane = r.paneId | 0;
  const sid = r.sessionId || "";
  const spec = {
    agent: r.agent || DEFAULT_SPAWN_SPEC.agent,
    cwd: r.cwd || "",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    paneId: pane || undefined,   // 同一个身份（Go 那边认领旧记录，不换 paneId）
    /* 前端标记（Go 的 spawnSpec 不认识这个字段，JSON 会忽略它）：这一次是
       "接上一个已关闭的 agent"。拒绝时 createTab 不弹那句通用报错 ——
       这里要说的比它多（为什么接不上、记录还在哪、还能做什么）。 */
    closedResume: true,
  };
  sendCtrl({ type: "log", msg: `接上已关闭的 agent pane=${pane} sid=${sid ? sid.slice(0, 8) : "(无)"} cwd=${r.cwd || "(默认)"}` });
  const nt = await createTab(spec);
  /* 拒绝/没起来：**记录和这一行都留着**，并把原因说给用户听（见 closedWhy）。
     删掉它就等于"接不上 = 悄悄丢失"，而这正是这一轮要修的那类事。
     ⚠️ 成功判据要**连 streamName 一起看**：没等到 tab.ok 时格子还在 TAB_LIST 里，
     但那个格子根本没有 PTY —— 把它当成"接上了"会把这一行删掉。 */
  if (!nt || !TAB_LIST.includes(nt) || !nt.streamName) {
    r.busy = false;
    const ref = nt && nt.resumeRefused;
    const refMsg = ref
      ? tMsg(ref.msgCode, ref.msgParams, ref.msg || ref.code) : "";
    if (ref && ref.code === "unavailable") {
      // 盘上已经没有那条会话了：把这一行翻成「接不上」，下一次点它先说原因。
      r.onDisk = false;
      armRailRebuild();
      showToast(t("shell.closed.resumeFailTitle"), closedWhy(r), "err");
      sendCtrl({ type: "log", msg: `已关闭的 agent 接不上 pane=${pane}：${refMsg}` });
    } else if (ref) {
      showToast(t("shell.closed.resumeFailTitle"),
        t("shell.closed.resumeFailNote", { msg: refMsg }), "err");
    }
    return;
  }
  CLOSED_PANES.delete(pane);
  if (collapsed) goToTab(nt, "接上已关闭的 agent");
  else jumpInto(nt, "接上已关闭的 agent");
  armRailRebuild();
}

/* 「结束这个 agent」（已关闭那一行）= 真正不要它了：发 forget，记录和行一起没。
   和 endAgent 分开写，因为这里没有格子可关 —— 只有那份薄快照。 */
async function endClosedPane(r) {
  if (!r) return;
  if (SETTINGS.confirmEndAgent) {
    const ok = await askConfirm({
      title: t("shell.end.title"),
      body: t("shell.end.closedBody", { name: closedRowName(r) }),
      ok: t("shell.end.ok"),
      danger: true,
    });
    if (!ok) {
      sendCtrl({ type: "log", msg: `结束已关闭的 agent pane=${r.paneId}：用户在确认框里取消了` });
      return;
    }
  }
  CLOSED_PANES.delete(r.paneId | 0);
  sendCtrl({ type: "pane.forget", pane: r.paneId | 0 });
  armRailRebuild();
  showToast(t("shell.end.donePane"), t("shell.end.doneClosedNote"), "ok");
  sendCtrl({ type: "log", msg: `结束已关闭的 agent pane=${r.paneId}（记录已摘，会话文件未动）` });
}

/* 建格/关格之后让左栏跟上。**必须在这一刻做**：左栏的行是 agent，而 agent
   的出现/消失就是 TAB_LIST 的增删 —— 等下一次状态推送才画的话，新 agent
   会有一两秒"看不见"，而关掉的 agent 会留在原地。
   ⚠️ 启动期间 RSB_READY 还是 false（那一批 const 还在 TDZ 里，见那一段的注释），
   不能画；改名期间整表不画（见 renderLists 顶上那条闸）。 */
function armRailRebuild() {
  if (!RSB_READY) return;
  if (renameSess) return;
  renderLists(searchKey());
}

function adoptDir(path) {
  if (!path) return;
  poolSend({ type: "project.add", path, source: "adopted" });
  sendCtrl({ type: "log", msg: `收编目录 ${path}（未归类 → 项目池）` });
}

/* 从列表移除。**只从池子里摘掉**，磁盘上一个字节都不动 —— 这句话必须说出来，
   而且要**说两次**：菜单项的 title 里（动手之前）、结果提示里（动完之后）。
   Orca 的原话是同一件事：RemoveFolderDialog.tsx:101-104
   "This only removes X from Orca. It is still on your disk."
   ⚠️ 不弹确认框：它不是破坏性动作（真删磁盘是另一个动作、另一条确认），
   而"加回来"就是再点一次添加项目。提示是**乐观**发的 —— Go 那边只会在
   路径/写盘出问题时才报错；那一刻会再起一张错误卡，两张叠着，不互相顶掉。 */
function removeProj(p) {
  poolSend({ type: "project.remove", path: p.path });
  showToast(t("shell.toast.removedTitle"), t("shell.toast.removedNote", { name: projectName(p) }), "ok");
}

// ---------------------------------------------------------------------------
// 项目菜单：复用那一枚 #cardmenu（一份数据、三个出口是它立过的形制）
// ---------------------------------------------------------------------------

function projMenuItems(p, inPool) {
  /* 默认工作区（Go 合成的，见 projects.go 的 wireProjects）。它**能开格、能开目录、
     能复制路径**，唯独不能改名/置顶/移除 —— 它不是用户攒出来的一条记录，它是
     "还没归到任何项目里的东西"的落点。
     ⚠️ 「从列表移除」这一项**做灰不做隐**（不可用的动作做灰、不做禁、不做隐 ——
     禁了 title 不弹，隐了用户以为功能没了）。它在这里出现的作用是把
     "为什么没有这个动作"说出来，像 Claude / Codex 桌面端对它们那个默认项目一样。 */
  const newHere = () => ({
    act: "new", icon: ICON_PLAY, label: t("shell.menu.newHere"),
    hint: t("shell.menu.newHereHint", { path: p.path || "", tip: newAgentShortcutTip() }),
  });
  if (p && p.synthetic) {
    return [
      newHere(),
      { sep: true },
      { act: "opendir", icon: ICON_DIR, label: t("shell.menu.openDir"), hint: p.path },
      { act: "reveal", icon: ICON_DIR, label: t("shell.menu.reveal"), hint: p.path },
      { act: "copy", icon: ICON_COPY, label: t("shell.menu.copyPath"), hint: p.path },
      { sep: true },
      { act: "remove", icon: ICON_TRASH, label: t("shell.menu.remove"), cls: " na",
        hint: t("shell.menu.defaultRemoveHint") },
    ];
  }
  if (!inPool) {
    return [
      { act: "adopt", icon: ICON_PLUS, label: t("shell.menu.adopt"),
        hint: t("shell.menu.adoptHint", { path: p.path || "" }) },
      { sep: true },
      newHere(),
      { sep: true },
      { act: "opendir", icon: ICON_DIR, label: t("shell.menu.openDir"), hint: p.path },
      { act: "reveal", icon: ICON_DIR, label: t("shell.menu.reveal"), hint: p.path },
      { act: "copy", icon: ICON_COPY, label: t("shell.menu.copyPath"), hint: p.path },
    ];
  }
  return [
    { act: "pin", icon: ICON_PIN,
      label: p.pinned ? t("shell.menu.unpin") : t("shell.menu.pin"),
      hint: p.pinned ? t("shell.menu.unpinHint") : t("shell.menu.pinHint") },
    { act: "rename", icon: ICON_PENCIL, label: t("live.menu.rename"),
      hint: t("shell.menu.renameDirHint", { path: p.path || "" }) },
    { sep: true },
    newHere(),
    { sep: true },
    { act: "opendir", icon: ICON_DIR, label: t("shell.menu.openDir"), hint: p.path },
    { act: "reveal", icon: ICON_DIR, label: t("shell.menu.reveal"), hint: p.path },
    { act: "copy", icon: ICON_COPY, label: t("shell.menu.copyPath"), hint: p.path },
    { sep: true },
    { act: "remove", icon: ICON_TRASH, label: t("shell.menu.remove"),
      hint: t("shell.menu.removeHint") },
  ];
}

function openProjMenu(row, anchor, alignRight) {
  const path = row?.dataset.path || "";
  const inPool = !!projObjByPath(path);
  const p = inPool ? projObjByPath(path)
    : { path, name: row?.querySelector(".nm")?.textContent || "", pinned: false };
  const r = anchor || row.querySelector('[data-pact="menu"]')?.getBoundingClientRect()
    || row.getBoundingClientRect();
  cardMenuCard = null;
  cardMenuAgent = null;              // 同一个 #cardmenu，身份只能有一个
  cardMenuClosed = null;
  cardMenuRowEl = null;
  cardMenuProj = { path, name: projectName(p), pinned: !!p.pinned, inPool, synthetic: !!p.synthetic };
  const head = `<div class="mhead" title="${esc(p.path || t("shell.projects.noCwd"))}">`
    + `${esc(projectName(p))}</div>`;
  showMenuAt(head, projMenuItems(p, inPool), r, alignRight !== false,
    `项目 ${p.name} 路径=${p.path}`);
}

/* ---- agent 行的菜单（2026-10-17）--------------------------------------------
   和项目菜单同一个出口（#cardmenu / showMenuAt），靠"讲的是谁"分流：
   `cardMenuAgent` 里有格对象时就是这一份。菜单项**不许**再出现"会话"这个词：
   用户定的模型里，agent 代表这件事的全部，右栏对话流就是它的记录。 */
function agentMenuItems(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  const stopped = !!tab.connDown;
  const sid = tab.sessionID || "";
  const dir = effCwd(tab);
  // 改名的主语是会话 id（titles.json 的键）。还没报出身份 = 没有可写的键 ——
  // 做灰并把原因说出来（同"不可用做灰不做隐"）。
  const canRename = !!sid;
  return [
    { act: "go", icon: ICON_PLAY,
      label: stopped ? t("shell.menu.goResume") : t("shell.menu.goOpen"),
      hint: stopped ? t("shell.menu.goResumeHint") : t("shell.menu.goOpenHint", { id: tab.id }) },
    // 在跑的才有「停止」；停了的这条由上面的「接上」顶上（同一颗按钮位置）。
    ...(stopped ? [] : [{ act: "stop", icon: ICON_STOP, label: t("shell.menu.stop"),
      hint: t("shell.menu.stopHint") }]),
    { act: "rename", icon: ICON_PENCIL, label: t("live.menu.rename"), cls: canRename ? "" : " na",
      hint: canRename
        ? (STATE?.titles?.[sid]
            ? t("live.menu.renameNow", { name: STATE.titles[sid] })
            : t("shell.menu.renameNoneAgent"))
          + "\n" + t("shell.menu.renameHint")
        : t("shell.menu.renameNoId") },
    { sep: true },
    { act: "new", icon: ICON_PLUS, label: t("shell.menu.newHereWs"),
      hint: t("shell.menu.newHereWsHint", { dir: dir || t("shell.menu.defaultDir") })
          + newAgentShortcutTip() },
    { sep: true },
    { act: "opendir", icon: ICON_DIR, label: t("live.menu.openCwd"), cls: dir ? "" : " na",
      hint: dir || t("shell.menu.noDir") },
    { act: "copy", icon: ICON_COPY, label: t("shell.menu.copyDir"), cls: dir ? "" : " na",
      hint: dir || t("shell.menu.noDir") },
    { sep: true },
    /* 「结束」= 用户明确不要这个 agent 了。**文件不删、记录删** —— 这两句话
       必须在 title 里说全，否则看起来像"删掉我的工作"。 */
    { act: "end", icon: ICON_TRASH, label: t("shell.menu.end"),
      hint: t("shell.menu.endHint") },
  ];
}

function openAgentMenu(t, anchor, alignRight, rowEl) {
  if (!t) return;
  const r = anchor || (rowEl && rowEl.getBoundingClientRect());
  if (!r) return;
  cardMenuCard = null;
  cardMenuProj = null;
  cardMenuClosed = null;
  cardMenuAgent = t;
  /* 重命名要在**这一行**里把标题换成输入框，而菜单项是点在 #cardmenu 里的，
     从那儿 closest() 爬不回这一行 —— 开菜单时把行元素记住（同 openCardMenu）。 */
  cardMenuRowEl = rowEl || null;
  const nm = agentRowName(t);
  showMenuAt(`<div class="mhead" title="${esc(nm)}">${esc(nm)}</div>`,
    agentMenuItems(t), r, alignRight !== false, `agent tab=${t.id} pane=${t.paneID || 0}`);
}

function doAgentAct(act, el, tab, rowEl) { // 参数别叫 t：会遮住 i18n 的 t()
  if (el && el.classList.contains("na")) {
    showToast(miLabel(el) || t("shell.toast.cantNow"), el.title, "err"); return;
  }
  if (!tab) return;
  switch (act) {
    case "go":
      if (tab.connDown) resumeAgentInSeat(tab);
      else jumpInto(tab, "左栏 agent 菜单");
      break;
    case "stop": stopAgent(tab); break;
    case "rename": {
      const sid = tab.sessionID || "";
      const nm = liveNmEl(sid, rowEl && rowEl.querySelector(".nm"));
      if (!sid || !nm) {
        showToast(t("shell.toast.renameFailedTitle"), t("shell.toast.renameFailedNoId"), "err");
        return;
      }
      openSessionRename({ id: sid }, nm);
      break;
    }
    case "new": openNewSpace({ folder: effCwd(tab), why: "左栏 agent 菜单" }); break;
    case "opendir": {
      const d = effCwd(tab);
      if (d) sendCtrl({ type: "open", mode: "open", path: d });
      break;
    }
    case "copy": {
      const d = effCwd(tab);
      if (d) copyText(d).then((ok) => {
        if (ok) showToast(t("shell.toast.copiedCwd"), d, "ok", true);
      });
      break;
    }
    case "end": endAgent(tab); break;
  }
}

/* ---- 「已关闭」那一行的菜单 ------------------------------------------------
   和 agentMenuItems 几乎是同一份，少掉的正好是"运行"那几项（停止 / 进格），
   多出来的是**这件事的说明**：它只是被关掉了，不是被删了（title 里说清楚）。
   菜单项仍然不许出现"会话"这个词（用户定的模型：agent 代表全部）。 */
function closedMenuItems(r) {
  const sid = r.sessionId || "";
  const dir = r.cwd || defaultWorkspacePath();
  const canRename = !!sid;
  const dead = closedUnresumable(r);
  return [
    /* 接不上的那条**做灰不做隐**（同"不可用的动作做灰"那条例）：点它会把原因
       说出来（见 doClosedAct），而不是从菜单里悄悄消失、让用户以为功能坏了。 */
    { act: "go", icon: ICON_PLAY,
      label: dead ? t("shell.closed.deadMenuLabel") : t("shell.menu.goResume"),
      cls: dead ? " na" : "",
      hint: dead ? closedWhy(r) : t("shell.menu.resumeClosedHint") },
    { act: "rename", icon: ICON_PENCIL, label: t("live.menu.rename"), cls: canRename ? "" : " na",
      hint: canRename
        ? (STATE?.titles?.[sid]
            ? t("live.menu.renameNow", { name: STATE.titles[sid] })
            : t("shell.menu.renameNoneAgent"))
          + "\n" + t("shell.menu.renameHint")
        : t("shell.menu.renameNoIdClosed") },
    { sep: true },
    { act: "new", icon: ICON_PLUS, label: t("shell.menu.newHereWs"),
      hint: t("shell.menu.newHereWsHint", { dir: dir || t("shell.menu.defaultDir") })
          + newAgentShortcutTip() },
    { sep: true },
    { act: "opendir", icon: ICON_DIR, label: t("live.menu.openCwd"), cls: dir ? "" : " na",
      hint: dir || t("shell.menu.noDirClosed") },
    { act: "copy", icon: ICON_COPY, label: t("shell.menu.copyDir"), cls: dir ? "" : " na",
      hint: dir || t("shell.menu.noDirClosed") },
    { sep: true },
    { act: "end", icon: ICON_TRASH, label: t("shell.menu.end"),
      hint: t("shell.menu.endClosedHint") },
  ];
}

function openClosedMenu(r, anchor, alignRight, rowEl) {
  if (!r) return;
  const rc = anchor || (rowEl && rowEl.getBoundingClientRect());
  if (!rc) return;
  cardMenuCard = null;
  cardMenuProj = null;
  cardMenuAgent = null;
  cardMenuClosed = r;
  cardMenuRowEl = rowEl || null;
  const nm = closedRowName(r);
  showMenuAt(`<div class="mhead" title="${esc(nm)}">${esc(nm)}</div>`,
    closedMenuItems(r), rc, alignRight !== false, `已关闭 agent pane=${r.paneId}`);
}

function doClosedAct(act, el, r, rowEl) {
  if (!r) return;
  // 「接不上」那一项是灰的，但**可点**：点一下把原因原样说出来（不是静默不动）。
  if (act === "go" && closedUnresumable(r)) {
    showToast(t("shell.closed.resumeFailTitle"), closedWhy(r), "err"); return;
  }
  if (el && el.classList.contains("na")) {
    showToast(miLabel(el) || t("shell.toast.cantNow"), el.title, "err"); return;
  }
  switch (act) {
    case "go": resumeClosedPane(r); break;
    case "rename": {
      const sid = r.sessionId || "";
      const nm = liveNmEl(sid, rowEl && rowEl.querySelector(".nm"));
      if (!sid || !nm) {
        showToast(t("shell.toast.renameFailedTitle"),
          t("shell.toast.renameFailedNoIdClosed"), "err");
        return;
      }
      openSessionRename({ id: sid }, nm);
      break;
    }
    case "new": openNewSpace({ folder: r.cwd || defaultWorkspacePath(), why: "已关闭 agent 菜单" }); break;
    case "opendir": {
      const d = r.cwd || defaultWorkspacePath();
      if (d) sendCtrl({ type: "open", mode: "open", path: d });
      break;
    }
    case "copy": {
      const d = r.cwd || defaultWorkspacePath();
      if (d) copyText(d).then((ok) => {
        if (ok) showToast(t("shell.toast.copiedCwd"), d, "ok", true);
      });
      break;
    }
    case "end": endClosedPane(r); break;
  }
}

/* `p` 必须**从外面传进来**（或者在这里先取一份），不能读 cardMenuProj：
   点菜单项的出口是"先 closeCardMenu 再执行"（菜单留在屏上会显得卡住），
   而 closeCardMenu 会把 cardMenuProj 清成 null —— 读它就永远是"没有项目"、
   整个动作静默什么都不做。第一次实测就是这么点的：日志里只有"菜单 关闭（选了
   菜单项）"，Go 那边一条都没有。卡片那条路没这个问题，因为它在关菜单**之前**
   就把 s 取在手里了。 */
function doProjAct(act, el, p) {
  // 灰的项**可点**：点一下把 title 里那句原因原样说出来（同 doCardAct，理由见那儿）。
  if (el && el.classList.contains("na")) {
    showToast(miLabel(el) || t("shell.toast.cantNow"), el.title, "err"); return;
  }
  p = p || cardMenuProj;
  if (!p) return;
  switch (act) {
    case "pin":     poolSend({ type: "project.pin", path: p.path, on: !p.pinned }); break;
    case "rename":  beginProjRename(p.path); break;
    case "adopt":   adoptDir(p.path); break;
    case "new":     openNewSpace({ folder: p.path, why: "项目菜单「新建 agent」" }); break;
    case "opendir": sendCtrl({ type: "open", mode: "open", path: p.path }); break;
    case "reveal":  sendCtrl({ type: "open", mode: "reveal", path: p.path }); break;
    case "copy":    copyText(p.path).then((ok) => {
      if (ok) showToast(t("shell.toast.copiedPath"), p.path, "ok", true);
    }); break;
    // 默认工作区那条是灰的，点它走的是上面那句 na 分支（把原因说出来）；这一行是
    // 兜底：万一哪天真给它挂上一颗不灰的移除键，也只是提示、不真删。
    case "remove":  if (p.synthetic) {
                      showToast(t("shell.toast.defaultRemoveTitle"),
                        t("shell.toast.defaultRemoveNote"), "err"); break;
                    }
                    removeProj(p); break;
  }
}

/* 显示名就地改。**规则整套照标签重命名那一套**（Orca use-sortable-tab-rename.ts
   的三条闸，见 openRename 的注释）：开编辑那一帧不许失焦提交、第二帧确认输入框
   真的拿到焦点才开闸、提交只发生一次（blur 在输入框被卸载时还会再来一次）。
   这里只把"谁在编辑"和"往哪儿写"换成项目，其余一个字不改 —— 那三条闸少一条，
   症状就是"改完名字自己又提交了一次/永远提交不了"，很难查。 */
let projRenaming = null;      // 正在编辑的项目 path
let projRenameSeq = 0;
let projRenameDone = false;
let projRenameBlurOk = false;
let projRenameInput = null;

function beginProjRename(path) {
  if (projRenaming) return;
  const row = [...document.querySelectorAll("#proj-list .proj, #un-view .proj")]
    .find((el) => el.dataset.path === path);
  const nm = row?.querySelector(".nm");
  if (!nm) return;
  const p = projObjByPath(path);
  projRenaming = path;
  projRenameSeq++;
  projRenameDone = false;
  projRenameBlurOk = false;   // 开编辑这一帧的失焦不是用户的意思
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-input";
  input.placeholder = t("shell.rename.placeholder");
  input.setAttribute("aria-label", t("shell.rename.aria"));
  input.value = p ? projectName(p) : nm.textContent;
  input.addEventListener("keydown", (e) => {
    // ⚠️ 中文输入法确认候选词的那个 Enter 不是"提交"（同标签重命名）。
    if (isImeOwnedKey(e)) return;
    if (e.key === "Enter") { e.preventDefault(); commitProjRename(); }
    else if (e.key === "Tab") { e.preventDefault(); commitProjRename(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelProjRename(); }
  });
  input.addEventListener("blur", () => {
    if (!projRenameBlurOk || projRenameDone) return;
    commitProjRename();
  });
  input.addEventListener("mousedown", (e) => e.stopPropagation());  // 别被行的点击抢走
  input.addEventListener("input", () => { input.dataset.dirty = "1"; });
  nm.replaceWith(input);
  projRenameInput = input;
  const seq = projRenameSeq;
  requestAnimationFrame(() => {
    input.focus(); input.select();
    requestAnimationFrame(() => {
      if (projRenameSeq === seq && projRenaming === path && document.activeElement === projRenameInput) {
        projRenameBlurOk = true;
      }
    });
  });
}

function endProjRename() {
  projRenameSeq++;
  projRenameBlurOk = true;
  projRenaming = null;
  projRenameInput = null;
}

function commitProjRename() {
  if (!projRenaming || projRenameDone) return;
  projRenameDone = true;
  const path = projRenaming;
  const v = (projRenameInput?.value || "").trim();
  endProjRename();
  // 空名字 = 交回目录名（Go 那边就是这样做的，见 projectPool.rename）——
  // 于是"改回去"不需要用户自己记得原来那个目录名。
  poolSend({ type: "project.rename", path, name: v });
  sendCtrl({ type: "log", msg: `改名 项目 ${path} → ${JSON.stringify(v)}（空 = 回到目录名）` });
}

function cancelProjRename() {
  endProjRename();
  renderLists(searchKey());   // 整表重画一次，输入框换成原来的 span
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/* 展开/收起一个工作区。⚠️ 不再整表重画 —— 组一直都在 DOM 里，只切
   `.open` / `inert`，高度交给 CSS 的 0fr↔1fr 过渡（220ms）。
   整表重画会把展开动作变成"内容突然出现"，还会杀掉 hover 和滚动位置。 */
function toggleProj(row) {
  if (!row || !row.dataset) return;
  const path = row.dataset.path || "";
  if (!path) return;
  const on = !projOpen(path);
  setProjOpen(path, on);
  row.classList.toggle("open", on);
  // 组是行的**兄弟**（.proj 和 .agroup 平级），不能 closest。
  const grp = row.nextElementSibling;
  if (grp && grp.classList.contains("agroup") && !grp.classList.contains("closed-list")) {
    grp.classList.toggle("open", on);
    if (on) grp.removeAttribute("inert");
    else grp.setAttribute("inert", "");
  }
  sendCtrl({ type: "log", msg: `左栏 ${on ? "展开" : "收起"} 项目 ${path}` });
}

function onLeftClick(e) {
  /* 「已关闭 N」的 disclosure：只改这一组的展开态，不碰 agent 本身。 */
  const ct = e.target.closest("[data-ctoggle]");
  if (ct) {
    e.stopPropagation(); e.preventDefault();
    // toggle 在展开后的 .agroup 里（是 .proj 的**兄弟**，不是子节点）——
    // 路径要从 group 上读，别去 closest(".proj")（那会永远拿到空串）。
    const grp = ct.closest(".agroup");
    const path = grp?.dataset.path || "";
    const on = !closedOpen(path);
    setClosedOpen(path, on);
    ct.classList.toggle("open", on);
    ct.setAttribute("aria-expanded", on ? "true" : "false");
    const n = ct.querySelector(".ctcount")?.textContent || "";
    ct.title = on ? t("shell.closed.toggleCollapse") : t("shell.closed.toggleExpand", { n });
    // 也在原地切，不重画 —— 和 toggleProj 同一条理由。
    const list = ct.nextElementSibling;
    if (list && list.classList.contains("closed-list")) list.hidden = !on;
    sendCtrl({ type: "log", msg: `左栏 ${on ? "展开" : "收起"}已关闭 agent 项目=${path || "(无目录)"}` });
    return;
  }
  const act = e.target.closest("[data-pact]");
  if (act) {
    e.stopPropagation(); e.preventDefault();
    const row = act.closest(".proj");
    const what = act.dataset.pact;
    if (what === "menu") openProjMenu(row);
    else if (what === "add") openNewSpace({ why: "空态「添加项目」" });
    else if (what === "adopt") adoptDir(row?.dataset.path || "");
    else if (what === "new") openNewSpace({ folder: row?.dataset.path || "", why: "左栏项目 +" });
    return;
  }
  /* agent 行行尾的两颗（停了才有的 ▶ / 常驻 ⋯，2026-10-17）。
     ⚠️ 锚点**必须给**（项目行那条的老教训：三处调用、三处都得给同一形状的锚点，
     少一处就是 showMenuAt 头一句 `anchor.left` 抛 TypeError —— 菜单的 `on`
     已经加上、落点整段没跑，看起来正是"点了没反应"）。 */
  const aact = e.target.closest("[data-aact]");
  if (aact) {
    e.stopPropagation(); e.preventDefault();
    const row = aact.closest(".arow");
    /* 「已关闭」的行没有运行期格子（data-pane 就是它的身份）—— 单独走一条。 */
    if (row && row.classList.contains("closed")) {
      const r = CLOSED_PANES.get(row.dataset.pane | 0);
      if (!r) return;
      if (aact.dataset.aact === "menu") {
        const rc = aact.getBoundingClientRect();
        openClosedMenu(r, { left: rc.left, top: rc.top, right: rc.right, bottom: rc.bottom }, true, row);
        return;
      }
      resumeClosedPane(r);
      return;
    }
    const t = row ? liveTab(row.dataset.tab | 0) : null;
    if (!t) return;
    if (aact.dataset.aact === "menu") {
      const r = aact.getBoundingClientRect();
      openAgentMenu(t, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, true, row);
      return;
    }
    // ▶ = 在原座位接上（它只在"停了"的行上出现；真在跑也只会跳过去）
    resumeAgentInSeat(t);
    return;
  }
  // 「已关闭」的行：点一下 = 接上（它没有"进格"这个动作 —— 根本没有格）。
  const crow = e.target.closest(".arow.closed[data-pane]");
  if (crow) {
    const r = CLOSED_PANES.get(crow.dataset.pane | 0);
    if (r) resumeClosedPane(r);
    return;
  }
  // 点 agent 行本身：在跑 → 进那一格；停了 → 在原座位接上。**这是左栏唯一的主手势**。
  const arow = e.target.closest(".arow[data-tab]");
  if (arow) {
    const t = liveTab(arow.dataset.tab | 0);
    if (!t) return;
    if (t.connDown) resumeAgentInSeat(t);
    else jumpInto(t, "点左栏 agent 行");
    return;
  }
  const row = e.target.closest(".proj");
  if (row) toggleProj(row);
}

function onLeftKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest?.(".proj, .arow");
  if (!el || e.target.closest("input")) return;
  // 行尾那两颗是真 `<button>`：浏览器自己会把 Enter/Space 变成 click。
  // 不在这里让路的话，Space 会被下面那句 preventDefault 吃掉（按钮的 click 默认动作
  // 正好也是 Space 触发的），于是"键盘选中 ▶ 再按空格"变成"点这一行 = 接上"，
  // 用户明明指着 ⋯ 却执行了接上。
  if (e.target.closest("button")) return;
  e.preventDefault();
  const crow = el.closest(".arow.closed[data-pane]");
  if (crow) {
    const r = CLOSED_PANES.get(crow.dataset.pane | 0);
    if (r) resumeClosedPane(r);
    return;
  }
  const arow = el.closest(".arow[data-tab]");
  if (arow) {
    const t = liveTab(arow.dataset.tab | 0);
    if (!t) return;
    if (t.connDown) resumeAgentInSeat(t);
    else jumpInto(t, "键盘进 agent");
    return;
  }
  toggleProj(el.closest(".proj"));
}

/* 导航栏的点击。三个真区（总览 / 工作区 / 设置）走 setNavView；以后若有还没做的项，
   把原因说出来。⚠️ 不做"点了没反应" —— 那正是原来那四项死按钮的毛病。
   重复点「总览」不是空操作：重画一次 = 手动刷新（热力图/读数都是现算的）。 */
$("rail").addEventListener("click", (e) => {
  const el = e.target.closest(".nav");
  if (!el) return;
  if (el.dataset.soon) {
    /* title 的写法是「还没做的面板（后面会有什么）」—— 正好拆成标题和正文。
       括号前那半句是"是什么"，括号里是"还会有什么"，一卡两行，别让标题只剩「还没做」。 */
    const ti = el.title || "";
    const i = ti.search(/[（(]/);
    showToast(i > 0 ? ti.slice(0, i) : (ti || t("nav.soon")),
      i > 0 ? ti.slice(i + 1).replace(/[）)]\s*$/, "") : "", "info");
    return;
  }
  const v = el.dataset.view;
  if (v === "workspace" || v === "dash" || v === "settings") {
    // 同一区：工作区重画列表，总览重画读数（= 手动刷新），
    // 设置重读一次权威值。
    if (v === NAV_HERE) {
      if (v === "dash") renderDashboard("重复点总览");
      else if (v === "settings") {
        renderSettings("重复点设置");
        sendCtrl({ type: "settings.get" });
      } else renderLists(searchKey());
      return;
    }
    setNavView(v);
    sendCtrl({ type: "log", msg: `左栏 切到「${el.dataset.nav}」` });
    return;
  }
  renderLists(searchKey());
  viewProbe("点了导航项");
  sendCtrl({ type: "log", msg: `左栏 点了导航项「${el.dataset.nav}」` });
});
for (const id of ["proj-list", "un-view"]) {
  $(id).addEventListener("click", onLeftClick);
  $(id).addEventListener("keydown", onLeftKey);
}
$("add-proj").addEventListener("click", () => {
  // 2026-10-19：不再直接开选择器 —— 先进「文件夹 + Agent」卡片，
  // 用户可以在同一处选 Agent（只加文件夹也仍然可以）。
  openNewSpace({ why: "左栏「添加项目」" });
});

// 池子变了（Go 推回来的全量）：**整表重画** —— 增删改都会动排序，而排序是
// Go 算的，前端没有"哪些行要挪"的局部信息。这条消息只在池子动作时来（低频）。
function applyPool(m) {
  if (!m) return;
  if (m.err) showToast(t("shell.pool.errorTitle"), tMsg(m.errCode, m.errParams, m.err), "err");
  if (Array.isArray(m.projects)) STATE.projects = m.projects;
  if (m.assign && typeof m.assign === "object") STATE.assign = m.assign;
  // 原文与 code 分开存：切语言时 poolErrText() 要按新语言重算，
  // 不能把上一次渲染好的那句话留在 STATE 里。
  STATE.poolErr = m.err || "";
  STATE.poolErrCode = m.errCode || "";
  STATE.poolErrParams = m.errParams || null;
  // 新建工作区卡片正在等"选择其他文件夹"的结果时，先让它吃掉这次更新
  // （新路径落到卡片里，不把用户跳去工作区）。函数在 81-newspace.js 里；
  // 可能还没求值完（defer 顺序），只认它在不在。
  const nsTook = (typeof newSpacePoolUpdate === "function")
    ? newSpacePoolUpdate(m.projects || [], m.picked || "", m.err || "") : false;
  // 总览「新建工作区」：选择器成功时 Go 会推一份带新路径的池子；取消时**什么都不推**，
  // 所以靠"快照里没有的路径"来判断成功，并在两分钟后作废（见 86-dash）。
  if (!nsTook && newWsPending && typeof newWsPending === "object") {
    if (m.err || Date.now() - newWsPendingAt > 120000) {
      // 池子报错 = 这次没加成（包括"选择器打不开"）；作废，别等下一次池子变动。
      newWsPending = null;
    } else {
      const fresh = (m.projects || []).find((p) => p && p.path && !newWsPending.has(p.path));
      if (fresh) {
        newWsPending = null;
        showToast(t("shell.pool.added"), fresh.name || fresh.path, "ok");
        setNavView("workspace");
      }
    }
  }
  syncPoolBanner();
  renderLists(searchKey());
  viewProbe("项目池变了");
  sendCtrl({ type: "log", msg: `项目池已更新 项目=${(STATE.projects || []).length}` +
    ` 归属=${Object.keys(STATE.assign || {}).length} err=${m.err || "无"}` });
}

function poolErrText() {
  if (STATE?.poolErr) return tMsg(STATE.poolErrCode, STATE.poolErrParams, STATE.poolErr);
  if (!Array.isArray(STATE?.projects)) return t("shell.pool.missing");
  return "";
}
function syncPoolBanner() {
  const slot = $("pool-err-slot");
  if (!slot) return;
  const err = poolErrText(); // 别叫 t：会遮住 i18n 的 t()
  slot.innerHTML = err
    ? `<div class="poolerr">${esc(t("shell.pool.error", { err }))}</div>` : "";
}

function renderShell() {
  if (!STATE) return;
  $("s-store").textContent = STATE.stateDir || "";
  $("s-store").title = STATE.stateDir || "";
  // cwd 从后端来，不再在 HTML 里写死 —— 那个字符串原来写死在 Go 侧
  // 和 HTML（#p-path 的初始文本）各有一份，而 HTML 那份从来没被更新过。
  $("s-cwd").textContent = STATE.cwd || "";
  $("s-cwd").title = STATE.cwd || "";

  // 导航栏按 NAV_ITEMS 画一次（**两层设计的左层**，见 HTML 那一节的注释）；
  // 之后只有"哪一项亮着"会变（NAV_HERE + setNavView）。
  renderNav();
  syncPoolBanner();
  renderLists(searchKey());
  // 载荷到得比用户点「总览」晚的时候（冷启动、会话库重扫），这一页要跟着补上。
  if (NAV_HERE === "dash") renderDashboard("壳层就绪");
  // 设置页开着时，载荷里的 cwd/settings 到了也要把路径那一块同步一下。
  if (NAV_HERE === "settings" && typeof syncSettingsUI === "function") syncSettingsUI();
  viewProbe("壳层就绪");

  // ⚠️ 这里**不再**自动选中第一个会话。以前启动时下段必须有个主语，所以只好
  // 挑一张卡片点亮；现在下段默认跟着当前格实时走，挑一张卡片反而是错的 ——
  // 那会让左栏一开始就亮着一张卡，而下段讲的是那一格的**静态历史**，
  // 用户看到的"实时"从第一秒起就是假的。
  //
  // 左栏那几个落点的命中区：要验证"点哪一行会发生什么"就得知道它落在哪。
  // 那个位置是**搜索框 + 分组标题 + 展开的会话**一路堆出来的，估没有意义
  // （分割条那次的教训：我在 y=567 拖，真实的边界在 552..562，落进了头部）。
  {
    const box = (el) => {
      if (!el) return "无";
      const b = el.getBoundingClientRect();
      return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)} 中心=${Math.round(b.left + b.width / 2)},${Math.round(b.top + b.height / 2)}`;
    };
    bootFact(`左栏 头部两颗键 加=${box($("add-proj"))} 刷=${box($("reload"))}`);
    const p0 = document.querySelector("#proj-list .proj");
    bootFact(p0
      ? `左栏首项目行 ${box(p0)} 名=${JSON.stringify((p0.querySelector(".nm") || {}).textContent || "")}` +
        ` 动作区=[${[...p0.querySelectorAll("[data-pact]")].map((b) => `${b.dataset.pact}@${Math.round(b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2)}`).join(" ")}]`
      : "左栏没有项目行（池子是空的 —— 这是首启的正常形态）");
    const s0 = document.querySelector("#proj-list .arow");
    bootFact(s0 ? `左栏首个 agent 行 ${box(s0)}` : "左栏项目行下面没有 agent 行");
    /* 行首图标 + 角标的**实测几何**。这一条是给"角标压到图标"那类错留的探针：
       三版角标我都是靠截图的糊团猜的，而"槽多大、点在槽里的哪一块、伪元素多宽"
       全都是能直接问出来的数（`getComputedStyle(el,'::before')`）——
       像素比眼睛诚实，**读数比像素还诚实**。 */
    {
      const r0 = p0?.querySelector(".ricon");
      const b0 = r0?.querySelector(".adot-slot");
      const a0 = b0?.firstElementChild;
      const pre = a0 ? getComputedStyle(a0, "::before") : null;
      bootFact(`左栏首行图标 图标=${box(r0)} 字形=${box(r0?.querySelector("svg"))}` +
        ` 角标槽=${box(b0)} 点=${box(a0)}` +
        (pre ? ` 点伪元素=${pre.width}×${pre.height} 底色=${pre.backgroundColor}` : " 点=无"));
    }
    // 未归类那一组：位置是"搜索框 + 空态那几行"堆出来的，估没有意义。
    // ⋯ 是这一组唯一的**常驻**落点（`+ 收编`要 hover 才浮出，自动点它点不到）。
    const u0 = document.querySelector("#un-view .proj");
    bootFact(u0
      ? `左栏首个未归类目录行 ${box(u0)} 名=${JSON.stringify((u0.querySelector(".nm") || {}).textContent || "")}` +
        ` ⋯=${box(u0.querySelector('[data-pact="menu"]'))} +收编=${box(u0.querySelector('[data-pact="adopt"]'))}`
      : "左栏没有未归类目录行（agent 全都归到项目里了）");
  }
  // C3 验收要驱动标签栏（新开一格 / 关掉一格），这两处的命中区同理 —— **量**出来的。
  // 关闭键 `.tab .x` 尤其不能目测：它平时是 `color:transparent`（看不见），
  // 但它**在布局里**、16x16 固定尺寸，所以位置是确定的、只是从截图上看不见。
  {
    const box = (el) => {
      if (!el) return "无";
      const b = el.getBoundingClientRect();
      return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)} 中心=${Math.round(b.left + b.width / 2)},${Math.round(b.top + b.height / 2)}`;
    };
    // 这里只报**标签条**上的两个落点（它不随网格重排动）。网格里每格的 × 坐标
    // 由 renderGrid 那条布局日志逐格报 —— ⚠️ 别在这写 `.cellhead .x`：
    // 它在 N=1 和 N=2 时位置完全不同，一个"启动时量的数"只会骗到后面的人。
    // （我第一次还探成了 `#tablist .tab` = 「并行」那张页标签，它根本没有 ×，
    //   报回来是 `关=无`。格子头上的 × 才是"结束这个 agent"，见 :2963 那段。）
    bootFact(`标签条 加号=${box($("tab-add"))} 并行页=${box($("tab-parallel"))}`);
    /* 顶栏模块切换的**命中读数**（2026-10-17 搬进窗口顶栏时加）：这个控件在
       标题栏的拖拽区里，位置/尺寸/命中元素/继承到的 --wails-draggable 全都是
       "截图看着对、点了没反应"时唯一能说清问题的字节证据。 */
    {
      const seg = $("dash-tabs");
      const r = seg.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      const cs = hit ? getComputedStyle(hit) : null;
      const on = seg.querySelector(".on");
      bootFact(`顶栏切换 ${box(seg)} 中心命中=${hit ? hit.tagName + (hit.id ? "#" + hit.id : "") : "无"}` +
        ` drag=${cs ? JSON.stringify(cs.getPropertyValue("--wails-draggable").trim()) : "?"}` +
        ` 活动项=${on ? on.textContent : "无"} 白片=${box(seg.querySelector(":scope > .thumb"))}`);
    }
    /* C7：工作区顶部那一组按钮的**实测几何**。这一组的位置就是那次改动的主题
       （用户原话"现在这个位置肯定不合适"），而"靠没靠右、离右栏边界多远"在截图里
       只能目测 —— 上一版那颗「原生对比」胶囊就是目测不出它偏了、也看不出它有多响。
       报的是每个子元素的 id（或 title）+ 盒子的左右边 + 有没有被 hidden 挡住。 */
    const tr = document.querySelector(".tabs-right");
    if (tr) {
      const b = tr.getBoundingClientRect();
      const kids = Array.from(tr.children).map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.id || el.title || el.tagName}(${Math.round(r.width)} @${Math.round(r.left)}-${Math.round(r.right)}${el.hidden ? " hidden" : ""})`;
      }).join(" ");
      bootFact(`顶部按钮组 左=${Math.round(b.left)} 右=${Math.round(b.right)} 宽=${Math.round(b.width)} 子=${kids || "无"}`);
    }
  }
  renderFlow("启动");
  // 这里才是"页面真的要开始画了"那一刻：主动把当前格的完整流水要过来。
  // （setActive 那一次可能因为模块求值顺序被跳过，见 askActsSnapshot 的注释。）
  askActsSnapshot("壳层就绪");
}

// （原来的 renderLists 在左栏那一轮被搬到了上面；它当时按 VIEW 分派到
//   「工作区」和「全部会话」两块 —— 现在只剩一块了，见它的注释。
//   右栏那个子代理模块搬进了 renderSideList。）

