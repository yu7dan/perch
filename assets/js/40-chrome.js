"use strict";
/* 40-chrome.js —— 自绘标题栏、左栏/右栏宽度、终端收起、启动建格、群组看板。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 3116-4275（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

// ===========================================================================
// 自绘标题栏：窗口按钮 + 双击最大化
// ===========================================================================
// 两条 Windows 惯例，Wails 运行时**都没有**替我们做：
//   1) 双击标题栏 = 最大化/还原。运行时的 drag.ts 里只对 macOS 转发了
//      `wails:drag:doubleclick`（那里是系统偏好决定的"，双击=缩放还是最小化"），
//      Windows 分支没有 —— 得自己接。
//   2) 最大化之后，按钮字形要从"最大化"换成"向下还原"。运行时不会替我们跟踪。
// 剩下三件事（最小化 / 切换最大化 / 关闭）运行时都有现成方法，直接用。
// 字形是两段 SVG（#wc-ico-max / #wc-ico-restore）互斥显示，不再改字符 ——
// 因为字形已经不是一个文字码位了（原因见 .wc-glyph 的注释）。
//
// ⚠️ 用 class 切换，**不要用 `.hidden` 属性**。`hidden` 是 HTMLElement 上的
// IDL 属性，`<svg>` 是 SVGElement —— 赋值 `svgEl.hidden = true` 只是挂了个
// JS 扩展属性，**不会**反映到内容属性上，元素一点不变。（2026-10-15 实测：
// 点击最大化后窗口确实最大化了（日志里 PTY 从 96x49 变成 140x57），
// 但按钮字形纹丝不动，截图里还是一个方框。）内容属性形式的 `hidden` 在
// 初始 HTML 里是生效的，所以这个坑只在动态切换时才露头。
const icoMax = $("wc-ico-max"), icoRestore = $("wc-ico-restore");
function syncMaxButton() {
  Window.IsMaximised().then((m) => {
    icoMax.classList.toggle("off", m);
    icoRestore.classList.toggle("off", !m);
    const btn = $("wc-max");
    btn.title = m ? "向下还原" : "最大化";
    btn.setAttribute("aria-label", m ? "向下还原" : "最大化");
  });
}
$("wc-min").addEventListener("click", () => Window.Minimise());
$("wc-max").addEventListener("click", () => Window.ToggleMaximise().then(syncMaxButton));
$("wc-close").addEventListener("click", () => Window.Close());
// 走系统路径改变最大化状态的情况（Win+↑、拖到屏幕顶、任务栏右键）只有事件知道。
Events.On("windows:WindowMaximise", syncMaxButton);
Events.On("windows:WindowUnMaximise", syncMaxButton);
syncMaxButton();

// 双击标题栏切换最大化 —— 但只在**拖拽区**上生效。标签、按钮那些地方
// 已经显式 no-drag，双击它们不该动窗口。
$("titlebar").addEventListener("dblclick", (e) => {
  if (e.target.closest(".tab, .tab-add, .tabs-right, .window-controls, .icon-btn")) return;
  Window.ToggleMaximise().then(syncMaxButton);
});

// ===========================================================================
// 右栏（C6a）—— 模块切换 + 宽度（可拖、可收起）
// ===========================================================================
/* C9：这里原来还有两个绑定 —— `panesDiv = $("panes")` 和
   `paneA = panesDiv.querySelector(".pane.a")`。收起键改成走 `#app` 上那个类之后
   它们都没有读者了（"一份没有读者的换算就是一份迟早会漂的影子副本"是同一条）。
   连着 C8 留下来的那句 `div.style.display = "none"` 一起别再放回来 —— 它就是把
   `#divider` 弄成"收起一次就永久消失"的那一行。 */
const div = $("divider");

// ---------------------------------------------------------------------------
// PANE_MIN_COLS 只剩一个读者：状态栏那条「N 格 · X 列/格」读数。
//
// C6a 之前它还是**夹取的下界**（用户最多只能把主区拖到"64 列"那一点，
// 因为再窄 Claude Code 的开场介绍框就会折行重叠 —— 见上面 .pane.a 的注释）。
// 现在主区宽度不再由用户拖拽决定（divider 改管右栏了），所以这条夹取连同
// 那整套"列 ↔ 像素"换算（cellWidthPx / paneWidthForCols / colsForPaneWidth /
// clampPaneCols，以及它们的两个魔数 TERMHOST_INSET / FIT_SCROLLBAR_ALLOWANCE）
// 一起退役 —— 一份没有读者的换算就是一份迟早会漂的影子副本。
// 保留 64 是因为**这条判断本身还是对的**：低于 64 列它会折行，那是需要
// 让用户知道的事实，只是现在由读数说出来、由用户自己决定（C4.5 定的策略）。
const PANE_MIN_COLS = 64;            // Claude Code 开场介绍框的硬下限（见上面 .pane.a 注释）
// 右栏宽度的三个数 —— **逐条取自 Orca** components/right-sidebar/right-sidebar-width.ts:1-2
//   RIGHT_SIDEBAR_MIN_WIDTH            = 220   → 下限
//   RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA = 320   → 右侧栏之外至少要留多少
// 它那两个纯函数（computeMaxRightSidebarPanelWidth / clampRightSidebarPanelWidth）
// 也照搬，只多传一个数 —— 见下面 rsbMaxW 的注释。
const RSB_MIN_W = 220;
const RSB_MIN_CENTER = 320;
/* 默认 300（不是下限 220）：220 是"能拖到多窄"，不是"打开时多宽" ——
   拿下限当默认值的后果是每次启动右栏都是最窄的那一档。
   260 → 300 是 2026-10-15 分上下两段时改的：上段（子代理/改动那些卡片行）
   在 260 下折行折得厉害，而下段（对话流）**默认是折叠的**，不吃宽度红利 ——
   所以宽度预算往上段这边挪。仍是我们自己定的数（Orca 的 store 默认值在
   收窄的检出里没取到），只保证落在 220…clampRsbW() 之间。 */
const RSB_DEFAULT_W = 300;
/* ⚠️ 这一个数是 Orca 那边**没有**的：`renderedExtraWidth`。
   Orca 把它当"右侧栏同侧还占着窗口宽度的东西"（它的 40px 侧边活动栏算这个），
   传进去的方式是 computeMaxRightSidebarPanelWidth(windowWidth, extraWidth)。
   我们左侧的**所有**东西都起这个作用。
   ⚠️ 2026-10-16 我一度把它写成 240（那会儿把导航栏删了）—— 两层设计恢复之后
   必须回到 372。这个数错了不会报错，只会表现为"右栏拖到头了还是不够宽"。
   也就是说约束是「窗口 = 左栏 + 中栏（≥320） + 右栏」——
   照 Orca 原式（不减去左栏）会允许右栏把中栏挤到 0，而这个应用的中栏是终端，
   挤到 0 不是"窄"，是"不能用"。
   ⚠️ 2026-10-17：**它不再是常量**。列表那一列现在可拖（--list-w），
   常量会在用户拖完之后立刻变成错的，而且是同一个静默症状。改成**量**：
   见 leftColsPx()。 */
/* ── 左栏（导航栏）的宽度（2026-10-17）────────────────────────────────────
   总览 ↔ 左栏那条缝现在可拖（#rail-divider）。和 --list-w/--rsb-w 同一套：
   像素、夹取、落 localStorage、窗口变窄时重夹。
   下限 110：图标 + 三字标签 + 计数不能折行；上限 320：再宽只是空白。
   ⚠️ 它以前是 CSS 里的字面量 132、JS 里的常量 NAV_W；改成变量后**量**的
   地方（leftColsPx）和**算上限**的地方（listMaxW/rsbMaxW）都必须读当前值，
   写死会静默算错 —— 症状是"右栏拖到头了还是不够宽"。
   ─────────────────────────────────────────────────────────────────────── */
const RAIL_MIN_W = 110, RAIL_MAX_W = 320, RAIL_DEFAULT_W = 132;
let railW = RAIL_DEFAULT_W;
function clampRailW(w) {
  return Math.round(Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, w)));
}
function applyRailW(px) {
  railW = clampRailW(px);
  document.documentElement.style.setProperty("--rail-w", railW + "px");
  // 左栏占宽变了，列表/右栏的上限跟着重算（applyListW 里会再 applyRsbW）。
  // 终端尺寸不在这里手动搬：各格自己的 ResizeObserver 接住。
  applyListW(listW);
}
const RAIL_W_KEY = "railWidth";
function loadRailW() {
  const n = parseInt(localStorage.getItem(RAIL_W_KEY) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveRailW(px) {
  if (!(px > 0)) return;
  try { localStorage.setItem(RAIL_W_KEY, String(px)); } catch (e) {}
}

function leftColsPx() {
  const a = $("rail"), b = $("list");
  const w1 = a ? a.getBoundingClientRect().width : 0;
  const w2 = b ? b.getBoundingClientRect().width : 0;
  // 布局还没出来的时候量到的是 0/NaN —— 那时候估一个（132 + 列表宽），
  // 宁可偏大也不要偏小：偏小会让右栏被允许压到中栏上。
  if (!(w1 > 40) || !(w2 > 40)) return railW + listW;
  return Math.round(w1 + w2);
}

/* ── 列表那一列（左栏的右层）的宽度（2026-10-17）──────────────────────────
   和 --rsb-w 同一套：像素、夹取、落 localStorage、窗口变窄时重夹。
   下限 180：「22分钟前」那一列 + 名字再窄就没法读了。上限取 600 ——
   同时受"中栏 ≥320、右栏 ≥220"约束（见 listMaxW）。
   ⚠️ 132 的导航栏**不可拖**，所以它不在这里，仍是 CSS 里的字面量。 */
const LIST_MIN_W = 180;
const LIST_MAX_W = 600;
const LIST_DEFAULT_W = 240;
let listW = LIST_DEFAULT_W;
function listMaxW() {
  const rsb = rsbOpen ? rsbW : 0;
  return Math.max(LIST_MIN_W, Math.min(
    LIST_MAX_W,
    window.innerWidth - railW - RSB_MIN_CENTER - Math.max(RSB_MIN_W, rsb)
  ));
}
function clampListW(w) {
  return Math.round(Math.min(listMaxW(), Math.max(LIST_MIN_W, w)));
}
function applyListW(px) {
  listW = clampListW(px);
  document.documentElement.style.setProperty("--list-w", listW + "px");
  // 左栏占宽变了，右栏的**上限**跟着变 —— 重夹一次（用户拖过的宽度是他的选择，
  // 窗口/左栏变小只是让它暂时被夹住，和 applyRsbW 那条注释同一个意思）。
  applyRsbW(rsbW);
}
const LIST_W_KEY = "listWidth";
function loadListW() {
  const n = parseInt(localStorage.getItem(LIST_W_KEY) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveListW(px) {
  if (!(px > 0)) return;
  try { localStorage.setItem(LIST_W_KEY, String(px)); } catch (e) {}
}

function rsbMaxW() {
  return Math.max(RSB_MIN_W, window.innerWidth - RSB_MIN_CENTER - leftColsPx());
}
function clampRsbW(w) {
  return Math.round(Math.min(rsbMaxW(), Math.max(RSB_MIN_W, w)));
}

// 右栏的**开/关**和**宽度**是两个状态：收起时宽度记在 memory 里（rsbW），
// DOM 上是 0。这样"收起再展开"能回到原来的宽度，而不是弹回默认值。
let rsbOpen = true;
let rsbW = RSB_DEFAULT_W;

function applyRsbW(px) {
  rsbW = clampRsbW(px);
  // 写在 documentElement 上而不是 #rsb 上：**两处**读它 —— #rsb 这一列，
  // 以及标题栏里那一格切片（.tb-rsb）。写在一处、两处生效。
  document.documentElement.style.setProperty("--rsb-w", (rsbOpen ? rsbW : 0) + "px");
  // 中栏宽度的变化由**各格自己的 ResizeObserver** 接住（见 createTab 里那条
  // observe(host)）—— 不在这里手动 refit：那是"手动搬运尺寸"的老做法，
  // 漏掉哪个格子（比如正在改名的、隐藏的）就出现一格尺寸不对，
  // 而 observe 那条路上每个盒子各量各的，不存在"漏"。
  paintGridStatus();
}
const RSB_W_KEY = "rsbWidth";
function loadRsbW() {
  const n = parseInt(localStorage.getItem(RSB_W_KEY) || "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveRsbW(px) {
  if (!(px > 0)) return;
  try { localStorage.setItem(RSB_W_KEY, String(px)); } catch (e) {}
}

/* 模块条。**五个模块 + 一个当前项**，一次只显示一个 —— 和 Orca 的
   activity bar 是同一套语义（它那边 item 列表里还混着插件面板的 key，
   见 store/right-sidebar-route.ts:25-58 的 normalizeRightSidebarRoute）。

   前四个的主语都是**当前这一格**（需要你 / 子代理 / 改动 / 流水），
   第五个（hist 对话流）的主语是**左栏选中的那个会话**。主语不同却被放在同一列，
   是因为这一列本来就追问两件事："我的手边现在怎么样"（工作台）
   和"我翻开的那个会话讲了什么"（历史）。等 C6b 之后 hist 该搬去「历史」。

   ⚠️ 顺序 = 用户点名的那三个 + 流水，别随手按字母重排：
   需要你排第一是因为它是**唯一会主动找你**的那个。
   对话流（原来第 5 个）2026-10-15 移出这一组、改成下段常驻 —— 见 CSS 里
   #rsb-mods / #rsb-hist 那段注释。旧 localStorage 里存着 "hist" 的由
   showRsbMod 那条兜底降级到第一个模块，不会白屏。 */
const RSB_MODS = ["need", "side", "diff", "flow"];
const RSB_MOD_KEY = "rsbMod";
let rsbMod = RSB_MODS[0];

/* 对话流的滚动位置原来要自己记着（rsbFlowScroll）：它被 hidden 之后
   `scrollHeight` 量出来是 0，浏览器会顺手把 scrollTop 也归零 —— 于是
   "去看一眼子代理再切回来"就落到一篇长对话的顶部。现在它常驻、**不再被隐藏**，
   这条补丁于是整个删掉了：不需要记住一个从不消失的东西的位置。 */

/* 每个格子的实时读数（需要你/子代理/改动/流水 四个模块的唯一数据源），
   由 hook / 会话登记表 / 转录三条腿往里写。
   ⚠️ **声明必须在这里**（启动那一段之前），不能挪到文件末尾那段处理逻辑旁边：
   启动时 setActive() → renderAgentDot() → cellState() 就会读它，
   而 `const` 在初始化之前读到就是 TDZ 报错（这页面没有控制台，看起来就是白屏）。
   类型：tabId → { st, name, at, note, subs, files, acts }，见文件末尾那一段的说明。 */
const LIVE = new Map();
/* C7 子代理三态的绑定（判据、措辞、图形出处的完整说明在 renderSideLive 上面那一段）。
   ⚠️ 和 LIVE 同一个理由**必须声明在启动之前**，而且这一组比 LIVE 更容易踩：
   在模块求值期间就会被叫到的 **cardHTML** 里用到了它们（那一段自己也有同类的
   踩坑记录，见 ICON_PLAY 上面那条注释）。
     · subClosed    我们看着它跑、又看着它那一格被关掉的那些 —— 「已关闭」
                    唯一的**亲眼所见**证据（另外两条是对文件的推断）；
     · subDone      反过来那一半：我们亲眼看见 hook 报了 SubagentStop 的那些。
                    ⚠️ 它存在的理由是一条实测出来的**不对称**（01:01:15 那次）：
                    关掉一格时，hook 模型（LIVE）连着格子一起被删掉，于是"这个
                    子代理早就完成了"这条**亲眼所见**当场蒸发，卡退回去读文件，
                    而文件那条判据是"3 分钟内还在写 → 进行中" —— 一个我们明明
                    看着它收尾的子代理，在库里挂了 3 分钟的「进行中」。
                    既然是"我们看过"，就该和 subClosed 一样**跟着我们自己活**，
                    没道理只留"被关掉"那一半；
     · subStateSeen 上次报过的状态，只在**变化**时报一行日志，免得刷屏；
     · SUB_WORD     状态词；  · SUB_RECENT_MS "还在写"的窗口。
   那几个**函数**（subKey/subStateOf/subChipHTML…）留在文件末尾，靠函数声明的提升
   —— 这正是这一段上面那条注释说的分工：绑定要早，函数不用。 */
const subClosed = new Set();
const subDone = new Set();
const subStateSeen = new Map();
const SUB_WORD = { run: "进行中", done: "已完成", closed: "已关闭", fail: "失败" };
const SUB_RECENT_MS = 3 * 60 * 1000;
/* 渲染闸门与那几个"启动路径上就会碰到"的小东西。
   ⚠️ 这一段的位置不是风格问题，是被**两次实测**（2026-10-15 的开发期日志）
   钉出来的：启动那一段里有 `await createTab()`，它之后立刻就是 `setActive(tab)`，
   而 setActive 会一路走到 ackNote / scheduleLive / renderAgentDot。这些函数是
   函数声明（会提升），但它们读的 `let liveRaf` / `const liveTab` / `LIVE`
   **不提升** —— 声明写在文件末尾就会读到 TDZ，抛
   「Cannot access 'liveRaf' before initialization」。
   后果不是"少个功能"：那次异常把启动那一段**整个打断**了，于是后面所有
   顶层语句（包括末尾那一次 renderLive）全部没跑，页面上一个读数都不会有。
   所以凡是"启动路径能碰到"的绑定，一律声明在启动之前；末尾那一段只放
   **被 RSB_READY 挡住**的渲染函数和消息处理。 */
let RSB_READY = false;
let liveRaf = 0;
const liveTab = (tab) => TAB_LIST.find((x) => x.id === tab) || null;

/* 收起终端面板那一屏（C9）的状态。**和上面几个同一个理由必须声明在这里**：
   启动路径上是 `setActive()` → `renderAgentDot()`，而 renderAgentDot 末尾要
   `scheduleGroup()`，那个函数读 collapsed / groupRaf —— 声明写在收起键那一段
   （4280 附近）的话，启动当场 TDZ 报错
   「Cannot access 'collapsed' before initialization」，而这一页没有控制台，
   看起来就是白屏。 */
let collapsed = false;
/* 左栏那几个"活的数"的刷新闸（左栏那一轮）。
   ⚠️ **必须声明在这里**，和 groupRaf 同一个理由，而且是 2026-10-16 当场又踩
   一次的同一个坑：启动路径是 `setActive(firstTab)` → `renderAgentDot()`，而
   renderAgentDot 末尾会调 scheduleProjLive —— 它读 projLiveRaf。我第一版把它
   写在左栏那一段（文件后段），启动时当场抛
   「Cannot access 'projLiveRaf' before initialization」，**把启动那一段整个打断**：
   后面的顶层语句全没跑，连 shell 流都没建（日志里没有「[perch] 索引 N 字节」，
   也没有任何左栏读数）—— 页面看起来像"只是左栏没内容"，其实整条启动断了。
   凡是启动路径碰得到的绑定，一律声明在启动之前。 */
let projLiveRaf = 0;
/* 收起**之前**右栏是开着还是关着。收起时右栏被我们强制关掉（一屏里同一份数据
   只说一遍），展开时要还回**用户当时的样子**，不是替他打开。
   ⚠️ 必须有这份快照：setRsbOpen(false) 会把 rsbOpen 本身覆盖成 false，
      只读 rsbOpen 的话展开之后右栏永远不会自己回来。 */
let rsbOpenBeforeCollapse = true;
let groupRaf = 0;
const groupSeen = new Map();   // tabId -> 这一行上次画进去的签名（变了才重画）
/* 「需要你」那张卡：**用户亲手点开过**的那几张（按 ask id 记，不按格 —— 一格前后会
   有好几张提问，按格记会让下一张凭空继承上一张的展开态）。缺省 = 让 measureAsk
   按量出来的高度决定摊开还是收起。 */
const askOpen = new Set();

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
const G_FILE = '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>';
const G_SAY = '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>';
const G_TOOL = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>';
const G_DOT = '<circle cx="12" cy="12" r="5.2" fill="currentColor" stroke="none"/>';

function svg(paths, size, w) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="${w || 2.1}" stroke-linecap="round"
    stroke-linejoin="round">${paths}</svg>`;
}
// 状态 → 中文标签（格子头的 title/aria 用）。Orca 的 agentStateLabel 是同一件事。
const DOT_LABEL = { idle: "空闲", working: "工作中", off: "已断开",
                    ask: "在等你", unread: "有新消息", failed: "出错了" };

function renderRsbMods() {
  for (const b of document.querySelectorAll("#rsb-bar .arbtn")) {
    b.classList.toggle("on", b.dataset.mod === rsbMod);
    b.setAttribute("aria-current", b.dataset.mod === rsbMod ? "page" : "false");
  }
  // 只在上段里切 —— 下段（#rsb-hist）不在这组里，它常驻。
  for (const m of document.querySelectorAll("#rsb-mods .rsb-mod")) {
    m.hidden = m.dataset.mod !== rsbMod;
  }
}
// 切模块 = 只切 hidden。**不卸载、不重建** —— 对话流那棵树是 JS 渲染的，
// 重建一次就多一次滚动位置丢失（和收起同一条理由，见 CSS 里 #rsb.off 的注释）。
// 切过去之后要立刻按**这个模块**重画一次：四个格子级模块的数据各自不同，
// 谁显示谁负责画（renderLive 里就是这么分派的）。
function showRsbMod(id) {
  if (!RSB_MODS.includes(id)) id = RSB_MODS[0];   // 存坏了就回第一个
  rsbMod = id;
  try { localStorage.setItem(RSB_MOD_KEY, id); } catch (e) {}
  renderRsbMods();
  if (RSB_READY) renderLive();
  sendCtrl({ type: "log", msg: `右栏切模块 ${id}（宽 ${Math.round(rsbW)}，${rsbOpen ? "展开" : "收起"}）` });
}
function setRsbOpen(open, why) {
  rsbOpen = !!open;
  $("rsb").classList.toggle("off", !rsbOpen);
  $("rsb-open").hidden = rsbOpen;       // 标题栏那颗只在收起时出现
  applyRsbW(rsbW);
  sendCtrl({ type: "log", msg: `右栏${rsbOpen ? "展开" : "收起"}（${why}）宽=${rsbOpen ? Math.round(rsbW) : 0} 模块=${rsbMod}` });
}

// ---------------------------------------------------------------------------
// 拖那条边界 = 改右栏宽度。
//
// 手势没变（按下、跟着指针走、抬手收尾），**变的是它改的那个量**：
// C6a 之前它改的是"中栏里终端占多宽"（--split），现在改右栏。方向也反了
// —— 往左拖是把右栏拉宽，Orca 的 useSidebarResize 用 `deltaSign: -1` 说的
// 就是这一件事（它是右栏，delta 的符号和左栏相反）。
//
// 宽度存的是**像素**（和 C6a 之前"存列数"不同）：列数是终端才有的量，
// 侧栏没有"多少列"这回事，Orca 存 rightSidebarWidth 也是像素。
// 代价是窗口缩放时"我拖的相对位置"会变，所以窗口 resize 时重新夹一次
// （见下面 rsbReclamp）—— 保证它不会把中栏挤到 320 以下。
// ---------------------------------------------------------------------------
div.addEventListener("mousedown", (e) => {
  e.preventDefault();
  div.classList.add("drag");
  if (!rsbOpen) setRsbOpen(true, "拖边界");   // 收起时它被裁掉了，点不到；保险
  const x0 = e.clientX, w0 = rsbW;
  const move = (ev) => applyRsbW(w0 + (x0 - ev.clientX));
  const up = () => {
    div.classList.remove("drag");
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    saveRsbW(rsbW);                 // 抬手才落盘（拖动过程中每帧都写没必要）
    sendCtrl({ type: "log", msg: `右栏宽度=${Math.round(rsbW)}（拖到边界，上限=${Math.round(rsbMaxW())}）` });
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});
// 窗口尺寸变化：重新夹一次（上限跟着窗口宽度走）。**不是**重置成默认值 ——
// 用户拖过的宽度是他的选择，窗口变小只是让它暂时被夹住。
window.addEventListener("resize", () => applyRsbW(rsbW));

// ---------------------------------------------------------------------------
// 拖列表右边界那条缝 = 改列表宽度（2026-10-17）。
//
// 手势、落盘时机（抬手才写）、读数**整套照上面那条**，只有两点不同：
//   ① 它改的是 --list-w；
//   ② 方向相反 —— 往**右**拖是把它拖宽（这条缝的右边才是终端）。
// 为什么这条缝以前不存在：那时左栏是"字面量 240 的固定轨"，谁也不许改它；
// 用户点名要能拖的正是这一条（「贴着终端面板那个分割线」）。
// ---------------------------------------------------------------------------
const listDiv = $("list-divider");
if (listDiv) {
  listDiv.addEventListener("mousedown", (e) => {
    e.preventDefault();
    listDiv.classList.add("drag");
    const x0 = e.clientX, w0 = listW;
    const move = (ev) => applyListW(w0 + (ev.clientX - x0));
    const up = () => {
      listDiv.classList.remove("drag");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      saveListW(listW);
      sendCtrl({ type: "log", msg: `列表宽度=${Math.round(listW)}（上限=${Math.round(listMaxW())}）` });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
window.addEventListener("resize", () => applyListW(listW));

// ---------------------------------------------------------------------------
// 拖总览左沿那条缝 = 改左栏宽度（2026-10-17）。
// 手势/落盘时机照上面 #list-divider，方向也一样：往右拖 = 把左栏拖宽。
// 它只在 #app.dash 下存在（#dash 本身只在总览显示），不抢工作区那侧的列表缝。
// ---------------------------------------------------------------------------
const railDiv = $("rail-divider");
if (railDiv) {
  railDiv.addEventListener("mousedown", (e) => {
    e.preventDefault();
    railDiv.classList.add("drag");
    const x0 = e.clientX, w0 = railW;
    const move = (ev) => applyRailW(w0 + (ev.clientX - x0));
    const up = () => {
      railDiv.classList.remove("drag");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      saveRailW(railW);
      sendCtrl({ type: "log", msg: `总览左栏宽度=${Math.round(railW)}（范围=${RAIL_MIN_W}~${RAIL_MAX_W}）` });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ---------------------------------------------------------------------------
// 拖上段/下段之间那条边界 = 改对话流的高度。
//
// 手势和右栏宽度那条**一模一样**（按下、跟着指针走、抬手落盘），只有两点差别：
//   1. 它改的是 height（下段是"高出来的那一段"，不是撑满的那一段）；
//   2. 拖它**顺带展开** —— 折叠状态下往上拖，意思显然是"我要看它"，
//      而不是"我要把 0 改成一个更小的数"。
// 落盘只在抬手时写（拖动中每帧都写没必要），和宽度同一条理由。
//
// ⚠️ 符号：这条边界是下段的**上沿**，所以它得**跟着指针走**；
// 而指针往上走(clientY 变小)意味着下段**变高**，于是 delta 要取反。
// 我第一版按"往右/往下都是正"的直觉写成了 h0+(clientY-y0)，正好抵消 ——
// 表现是拖上去那段反而缩、像在躲指针。宽度那条的 x0-clientX 是同一件事
// （它也是"边界跟着指针、被改的量朝反方向长"），两处别写岔。
// ---------------------------------------------------------------------------
const RSB_HIST_KEY = "rsbHistH";
const RSB_HIST_OPEN_KEY = "rsbHistOpen";
const RSB_HIST_MIN = 120;      // 展开后的下限：够看到 3~4 行
const RSB_HIST_MIN_TOP = 180;  // 上段至少留这么多，否则上段就没法用了
let rsbHistOpen = false;       // 默认折叠（理由见 CSS 里 Orca 那段原话）
let rsbHistH = 0;              // 展开后的高度；0 = 还没定过 ⇒ 取窗口的 35%

/* 折叠时的高 = **量出来的**头部高，不是一个写死的数：头部高是设计令牌
   （--pane-title-height，现在是 24px），将来它变了这里跟着变 ——
   写死的话折叠起来会多出一条空白，或者把头部切掉一截。 */
function histHeadH() {
  const b = $("rsb-hist").querySelector(".bhead");
  const h = b ? Math.round(b.getBoundingClientRect().height) : 0;
  return h > 0 ? h : 24;
}
/* 上段能留多少，**按盒子量**，不按"减掉头部高"那样的加减法推。
   第一版写的是 clientHeight - histHeadH() - 180，看着对，其实从列的预算里
   扣错了项：列里真正不归下段的是模块条 + 边界那两条，而 histHeadH 是下段
   **内部**的头部（它本来就该算在下段里）。扣少了 ⇒ 上段实际只剩 158px，
   比 180 的地板矮一截 —— 而 180 那条地板存在的唯一理由就是"别把上段挤没"。
   现在改成直接量：#rsb-mods 的顶边到列底之间，扣掉边界自己和 180，
   就是下段的可用上限。（这些量都跟下段当前多高无关，所以在拖动过程中
   读它们不会自我反馈。） */
function rsbHistMaxH() {
  const col = $("rsb").getBoundingClientRect();
  const mods = $("rsb-mods").getBoundingClientRect();
  const split = $("rsb-split").getBoundingClientRect();
  return Math.max(RSB_HIST_MIN,
    Math.round(col.bottom - mods.top - split.height - RSB_HIST_MIN_TOP));
}
function clampHistH(h) {
  return Math.round(Math.min(rsbHistMaxH(), Math.max(RSB_HIST_MIN, h)));
}
// 高度写在 documentElement 上（--rsb-hist-h），和 --rsb-w 同一个路子：
// CSS 只管读数，JS 只管写数，"折叠该是多高"这件事不散在两处。
function applyHistH() {
  const h = rsbHistOpen ? clampHistH(rsbHistH || window.innerHeight * 0.35) : histHeadH();
  document.documentElement.style.setProperty("--rsb-hist-h", h + "px");
  $("rsb-hist").classList.toggle("open", rsbHistOpen);
  const f = $("h-fold");
  if (f) f.setAttribute("aria-expanded", String(rsbHistOpen));
  return h;
}
function saveHist() {
  try {
    localStorage.setItem(RSB_HIST_KEY, String(Math.round(rsbHistH || 0)));
    localStorage.setItem(RSB_HIST_OPEN_KEY, rsbHistOpen ? "1" : "0");
  } catch (e) {}
}
function setHistOpen(open, why) {
  rsbHistOpen = !!open;
  const h = applyHistH();
  if (rsbHistOpen) rsbHistH = h;
  saveHist();
  sendCtrl({ type: "log", msg: `对话流${rsbHistOpen ? "展开" : "折叠"}（${why}）下段=${h}px 上限=${Math.round(rsbHistMaxH())}` });
}
function loadHist() {
  const n = parseInt(localStorage.getItem(RSB_HIST_KEY) || "", 10);
  if (Number.isFinite(n) && n > 0) rsbHistH = n;
  rsbHistOpen = localStorage.getItem(RSB_HIST_OPEN_KEY) === "1";
}

$("h-fold").addEventListener("click", () => setHistOpen(!rsbHistOpen, "点箭头"));
// 双击头部也行 —— 那一条是"箭头"的自然手势延伸（和标签条双击改名同一个意思：
// 一个可见的小按钮 + 一个不用瞄准的手势）。
$("rsb-hist").querySelector(".bhead").addEventListener("dblclick", (e) => {
  if (e.target.closest(".icon-btn")) return;   // 箭头自己的单击已经管了
  setHistOpen(!rsbHistOpen, "双击头部");
});

{
  const div2 = $("rsb-split");
  div2.addEventListener("mousedown", (e) => {
    e.preventDefault();
    div2.classList.add("drag");
    const y0 = e.clientY;
    let y1 = y0;                                     // 最后一个 move 的 y（读数用）
    let h0 = rsbHistOpen ? rsbHistH : histHeadH();   // 起点 = 眼睛现在看到的那个高
    const move = (ev) => {
      const d = y0 - ev.clientY;                     // 指针往上 = 下段变高
      y1 = ev.clientY;
      if (!rsbHistOpen) {
        if (d <= 0) return;                          // 折叠时往下拖 = 还是不要它
        setHistOpen(true, "拖边界");
        h0 = histHeadH();
      }
      rsbHistH = clampHistH(h0 + d);
      applyHistH();
    };
    const up = () => {
      div2.classList.remove("drag");
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      saveHist();
      // 折叠时往下拖是**合法的空操作**。这条日志存在的意义是把
      // "handler 根本没触发"和"触发了但按设计没动"分开 —— 前者要查命中区，
      // 后者是正常的（这次排查就卡在分不清这两者上）。
      // 四个数都报：起点 y0 / 终点 y1 / 期间量到的起点高 h0 / 落点高。
      // 没有这四个数，"拖出来 614 而期望 440"这种账就只能靠猜 z-drive 到底
      // 把指针挪到哪了（它的坐标是 client 相对的，中间还夹着一次 ClientToScreen）。
      sendCtrl({ type: "log", msg: rsbHistOpen
        ? `对话流高度=${Math.round(rsbHistH)}（拖到边界，上限=${Math.round(rsbHistMaxH())} ` +
          `y0=${Math.round(y0)} y1=${Math.round(y1)} 走=${Math.round(y0 - y1)} h0=${Math.round(h0)} ` +
          `视口=${window.innerWidth}x${window.innerHeight}）`
        : `对话流拖边界：仍是折叠（往下拖不展开）` });
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}
// 窗口变小 ⇒ 重新夹一次。和右栏宽度同一条：**夹住，不重置成默认值**。
window.addEventListener("resize", () => applyHistH());

// 模块条：点图标切模块。收起状态下点它也先展开 —— 否则点了没反应。
$("rsb-bar").addEventListener("click", (e) => {
  const b = e.target.closest(".arbtn");
  if (!b) return;
  if (!rsbOpen) setRsbOpen(true, "点模块");
  showRsbMod(b.dataset.mod);
});
$("rsb-close").addEventListener("click", () => setRsbOpen(false, "点收起"));
$("rsb-open").addEventListener("click", () => {
  // 收起终端面板时它是灰的（见 rsbPaintOpen）：右栏被我们强制关着，放它点开
  // 会当场打架。灰而**留位**（不做隐）是为了 .tabs-right 的布局不跳。
  if (collapsed) { sendCtrl({ type: "log", msg: "展开右栏被忽略（终端面板收起着）" }); return; }
  setRsbOpen(true, "点展开");
});
/* Ctrl+Shift+B 收/展右栏（对应 Orca 那条 sidebar.right.toggle 的动作）。
   **capture 阶段是必需的，不是风格选择**：xterm 的 keydown 挂在 window 上
   而且是冒泡阶段，也就是说先跑的是 xterm、后跑的是我们 —— 它会先把 Ctrl+Shift+B
   当作一个按键序列**发给 PTY**，我们这边再 preventDefault 也只来得及阻止
   "下一页"的默认行为，拦不住那次已发出的按键。
   改成 capture（document 上的捕获阶段在整个传播链最前面）之后，语句顺序调转：
   我们 preventDefault → xterm 那个监听器第一行就是
       `if (e.defaultPrevented) return`
   （见 assets/xterm.js 里 registerListeners 的 keydown 分支），于是它整条按键
   都不再处理 —— 这个组合键因此**只**收右栏，终端那边一个字都收不到。
   选 Shift 组合而不用裸 Ctrl+B：裸的那一份是终端的语义（Claude Code 里也是），
   不该被壳层吃掉。 */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    // 收起终端面板时右栏是被**我们**强制关着的（一屏里同一份数据只说一遍），
    // 所以这个组合键此时什么都不做 —— 和那颗灰掉的 #rsb-open 是同一条理由。
    // ⚠️ 仍然要 preventDefault：不拦的话 xterm 会把它当按键序列发给 PTY。
    if (collapsed) { sendCtrl({ type: "log", msg: "右栏快捷键忽略（终端面板收起着）" }); return; }
    setRsbOpen(!rsbOpen, "快捷键");
  }
}, true);

// ---------------------------------------------------------------------------
// 启动：建第一个标签
//
// **位置就是这里的全部要点。** 放在这一行而不是文件开头，是因为 createTab 的
// 第一个 await 之前那段会同步用到一批模块级 const —— `ccImeAnchor` 要看
// `CC_IME_PROMPT`、标签图标要看 `CLAUDE_PATH`、而 `renderTabTitle` 要读
// `tabEditing`。它们全是 `const`/`let`，不是函数声明，**不提升** ——
// 在它们初始化之前调用 createTab 会直接 TDZ 报错
// （而这页面没有控制台，看起来就是"白屏，什么都没发生"）。
//
// 也不能再往后放：下面那几行（右栏宽度、activeTab.refit()）要在一个**已经
// open+fit 完**的终端上跑 —— 这一句 await 之后就是（fit 在 createTab 的第一个
// await **之前**，是同步的）。
//
// 顶层 await 而不是"起了个 async 函数不管它"：后者的意思是"接下来那些代码
// 跑得比终端建好还早"，而我们恰恰需要顺序 —— 再看紧接着那两行。
// （旧版就是这个形状：`await` 直接写在终端那段代码下面。现在那段是工厂
//   函数体、要等调用才跑，所以"调用点"必须自己找个位置安放。）
// ⚠️ 右栏必须在**建第一个标签之前**定下来。
// 这不是风格问题：终端是在 createTab 里立刻 fit 的，如果那一刻中栏还是
// 默认宽度（--rsb-w:300），终端会先按 98 列排一版，等这句启动代码把宽度改成
// 用户拖过的值（比如 400）之后**再重排一次** —— 首帧会看见一次回流，
// 日志里就是 "fit=81x50 host=664 term=98x50" 这种 host 和 term 对不上的行
// （实测过：那一行确实出现过，介绍框检查仍然通过，所以只是白跳一下）。
// 先定宽度、再建终端，就只有一次 fit，而且是对的那一次。
// ⚠️ 下段的**高度**是同一条理由（2026-10-15 分栏时新加）：它一变，上段就变，
// 中栏跟着重排 —— 所以也在建标签之前定下来。没拖过就取窗口的 35%。
rsbW = loadRsbW() ?? RSB_DEFAULT_W;
/* 列表那一列同理（2026-10-17 它可拖了）：宽度必须在建第一个标签**之前**定下来，
   否则终端会先按默认 240 排一版、再按用户拖过的值重排 —— 首帧一次回流，
   和上面右栏那条是同一个病。它同时会重夹一次右栏上限（见 applyListW）。 */
listW = loadListW() ?? LIST_DEFAULT_W;
/* 左栏（导航栏）同一条：总览 ↔ 左栏的缝也可拖了。applyRailW 会顺手把
   列表宽度再 apply 一遍（它内部就是 setProperty + applyListW）。 */
railW = loadRailW() ?? RAIL_DEFAULT_W;
applyRailW(railW);
rsbMod = localStorage.getItem(RSB_MOD_KEY) || RSB_MODS[0];
if (!RSB_MODS.includes(rsbMod)) rsbMod = RSB_MODS[0];
loadHist();
if (!rsbHistH) rsbHistH = Math.round(window.innerHeight * 0.35);
applyHistH();
setRsbOpen(true, "启动");
renderRsbMods();

/* ---------------------------------------------------------------------------
   启动：**先把座位摆出来，再让 PTY 开跑**（冷恢复的步 4）
   ---------------------------------------------------------------------------
   上一版这里是 `await createTab(DEFAULT_SPAWN_SPEC)` 一格到底：于是"重开"永远
   等于"一格全新空会话"，用户既不知道上次做到哪，也接不上。

   为什么一定是 **burst**（先把 N 格一次性摆好，再等它们各自的 PTY）：
   `pushSize()` 在 stream.onopen 就发，而 PTY 的**列数在第一帧就定死了**。
   串行 await 的话，pane1 会在"网格里只有 1 格"时按整宽起 PTY，后面 N-1 格陆续
   进来再 resize → Claude 重画开场框 → 回滚缓冲里留下交错重影
   （正是这个文件花大篇幅消灭的东西）。createTab 的第一个 await 在 rAF 那道，
   同步段（建格子 + renderGrid）一定先跑完，所以 burst 之后每个 onopen
   报的都是**最终**列数。 */
void (async () => {
await fontsReady;
const restoreSeats = await awaitRestorePlan();
const bootPromises = restoreSeats.length
  ? restoreSeats.map((v) => createTab(seatSpecFrom(v)))
  : [createTab(defaultSpawnSpec())];
const bootTabs = await Promise.all(bootPromises);
/* 首格要挑一个**还在 TAB_LIST 里**的：被拒的格子会就地 closeTab（见 createTab ③），
   拿一个已经不在模型里的格子去 setActive 就是空指针那一类毛病。
   最后那个 null 也得容下：N 格全被拒 = 主区空着（这是诚实的结局，
   而不是留一堆幽灵格）。 */
const firstTab = bootTabs.find((t) => TAB_LIST.includes(t)) || null;
if (firstTab) setActive(firstTab);
// 起来之后立刻记一笔：页面白屏时这是**唯一**能区分"根本没建标签"和
// "建了但渲染不出来"的证据（它走 ctl 通道，不依赖任何标签流）。
// 走 bootFact 而不是 sendCtrl：这段现在可能跑在 ctl 连上**之前**（那条通道什么时候
// 起来不由我们定），而页面级 sendCtrl 在没连上时会**静默丢掉**消息。
bootFact(`启动建格：要 ${bootPromises.length} 个、界面留 ${TAB_LIST.length} 个、当前格 tab=${firstTab ? firstTab.id : "无"}` + (firstTab ? ` stream=${firstTab.streamName}` : ""));
// 启动读数走 bootFact：上面那两句（含 setRsbOpen 里的那句）跑在 ctl open 之前，
// 页面级 sendCtrl 会**静默丢掉**（见文件里"两条日志路径"那段）。
// 所以"右栏到底有没有起来"这条证据必须走 bootFact。
/* 那条 10px 的边界命中区有多高、落在哪一行，是**量出来的**不是估出来的：
   我按"头部一行大概在这"估了一次，正好落进头部里（头部只认双击），
   于是"拖了没反应"看起来像 handler 没绑上 —— 其实只是没打中。
   盒子的数字直接写进启动读数，就不用再靠眼睛找那 10px。 */
{
  const s = $("rsb-split").getBoundingClientRect();
  const hb = $("rsb-hist").getBoundingClientRect();
  bootFact(`右栏 模块=${rsbMod} 宽=${Math.round(rsbW)} 上限=${Math.round(rsbMaxW())} 窗口=${window.innerWidth} ` +
         `对话流=${rsbHistOpen ? Math.round(rsbHistH) + "px" : "折叠"} 下段上限=${Math.round(rsbHistMaxH())} ` +
         `边界y=${Math.round(s.top)}..${Math.round(s.bottom)} 下段顶=${Math.round(hb.top)} 视口=${window.innerWidth}x${window.innerHeight}`);
  /* 2026-10-17 新加的两条：都是"这条缝到底能不能抓到"的读数。
     · #list-divider 的左沿必须**落在列表右沿上**（差 1-2px 就是"拖了没反应"）；
     · 右栏最外那 10px 必须**不属于任何滚动条**（那是还给窗口缩放边的），
       所以把右栏里两条滚动区的 clientWidth 也报出来 —— 它和右栏内容宽的差
       就是滚动条槽位，槽位的右沿离窗口右沿应当 ≈ 10px。 */
  const ld = $("list-divider").getBoundingClientRect();
  const lr = $("list").getBoundingClientRect();
  bootFact(`左栏 列表宽=${Math.round(listW)} 上限=${Math.round(listMaxW())} ` +
         `分隔条x=${Math.round(ld.left)}..${Math.round(ld.right)}(宽${Math.round(ld.width)}) 列表右沿=${Math.round(lr.right)} ` +
         `左栏合计=${leftColsPx()}`);
  const rb = Math.round($("rsb").getBoundingClientRect().width);
  // 上段的滚动区：**当前显示的那个模块**才有宽 —— rsbMod 是 flow 时四个模块
  // 全 hidden（它在下段），这里就量不到，如实说"不在上段"，不报 0 当证据。
  const visMod = $("rsb-mods").querySelector(".rsb-mod:not([hidden]) .scroll");
  const hist = $("hist");
  bootFact(`右栏右沿让位 右栏盒=${rb} 窗口=${window.innerWidth} ` +
    (visMod ? `上段 右沿离窗口=${Math.round(window.innerWidth - visMod.getBoundingClientRect().right)} 槽=${visMod.offsetWidth - visMod.clientWidth}` : `上段（${rsbMod} 不在上段，量不到）`) +
    ` 对话流 右沿离窗口=${Math.round(window.innerWidth - hist.getBoundingClientRect().right)} 槽=${hist.offsetWidth - hist.clientWidth}` +
    ` 横条右沿离窗口=${Math.round(window.innerWidth - $("rsb-split").getBoundingClientRect().right)}` +
    `（两项"右沿离窗口"必须 = 让出的 10；"槽"只在内容溢出时非 0，那时它 = 滚动条 10 ——` +
    ` 都对，最外那条带才干净、才归窗口缩放边）`);
}
if (activeTab) activeTab.refit();
})();

// 收起 / 展开终端。C6a 之后它收起时中栏**整体**没了（不再有"历史流独占整宽"
// 那回事 —— 右栏现在是独立的一列，中栏空不空跟它没关系）；再点一下终端回来。
//
// 图标**不自己画**。Orca 整套 UI 用的是 Lucide（见它源码里满地的
// `from 'lucide-react'`，pane 头部的 split/close 就是 SquareSplitVertical / X）。
// 上一版我手绘了一个「上下夹着两个箭头」的图形，13px 下糊成一个 "]"，
// 这正是用户说的「自己画一个上去，质感怎么可能会一样」。
// 这里直接用 Lucide 的 panel-left-close / panel-left-open 两个原始 path ——
// 终端在左边，语义正好，而且它本来就是成对的、状态自明的。
//
// 被藏起来时必须让 FitAddon 停手：它会拿一个 0 宽的容器去算列数，
// 把终端 resize 成 1 列，再展开时列宽就回不来了。
const LUCIDE_PANEL_LEFT_CLOSE =
  '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>';
const LUCIDE_PANEL_LEFT_OPEN =
  '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>';
/* 左栏两行的图标（工作区行 / 会话行）—— **一份不是自己画的**。
   用户反复强调过：图标一律去用现成的高质量图标，不要手画（手画的第一个毛病就是
   比例/笔画不对、小尺寸下发灰 —— 我手画的那版文件夹在 15px 下描边只有 0.93px，
   峰值亮度 25/255，等于没画出来）。
   这两枚连"用哪一枚"都不是我挑的，是照 Orca 自己的用法搬的：
     · folder-tree     —— Orca 侧栏里**分组**用的就是它
                          （sidebar/worktree-list/grouping/group-keys.ts:1）
     · square-terminal —— Orca 侧栏给「会话」这一类用的就是它
                          （sidebar/SidebarFilter.tsx:266，size-3.5 = 14px）
   path 逐字取自 lucide-static v1.58.0（ISC 许可），一个字符没改；
   尺寸/描边走现成的 lucide() 包装（官方 stroke-width=2，24 网格）。 */
const LUCIDE_FOLDER_TREE =
  '<path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/>';
const LUCIDE_SQUARE_TERMINAL =
  '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>';
function lucide(paths, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round">${paths}</svg>`;
}
// 「恢复上次输出」原来在面板尾是个文字按钮；面板尾删掉后它进了 .phead 的
// 浮出按钮组。Orca 那组按钮**全是图标按钮 + tooltip**（chromeless 下文字压在
// 终端上没法看），所以这里也换成图标。用 Lucide 的 rotate-ccw —— 语义就是
// 「把快照回放到这个终端」，和 panel-left-close 同一套笔法。
const LUCIDE_ROTATE_CCW =
  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>';
// 子代理「已完成」那颗对勾。Orca 的 AgentStateDot 在 done 态渲染的就是 lucide 的
// CircleCheck（AgentStateDot.tsx:118-130，原话见 CSS 里 .adot[data-state="done"]）——
// 所以这里也不自己画：直接用它的原始 path。同一套笔法见上面的 panel-left。
const LUCIDE_CIRCLE_CHECK = '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>';
/* 对话流里那条「上下文已压缩」节点的图标（fold-vertical，lucide-static v1.58.0
   原文 path）：上下两条折线朝中间那条线收拢 —— 就是压缩这件事本身在画什么。
   同样**不是自己画的**（用户反复强调过，见 LUCIDE_FOLDER_TREE 上面那段）。 */
const LUCIDE_FOLD_VERTICAL =
  '<path d="M12 22v-6"/><path d="M12 8V2"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/><path d="m15 19-3-3-3 3"/><path d="m15 5-3 3-3-3"/>';
$("restore").innerHTML = lucide(LUCIDE_ROTATE_CCW, 14);

// 点面板上的浮出按钮**不该把焦点从终端上夺走**。实测：点一下「恢复上次输出」，
// xterm 的 helper-textarea 失焦 → 我们开了 focus 上报（`CSI ? 1004 h`），
// Claude Code 于是收到一次 focus-out 并把输入框整套重画了一遍
// （日志里那串 `?2004h` + `[K` + `[94C` 就是它）。更烦的是点完接着打字，
// 字哪都不去。
//
// Orca 的同类意图写在 data-pane-prevent-terminal-focus
// （TerminalPaneHeaderOverlay.tsx:145 + lib/pane-manager/pane-pointer-focus.ts:1-21）：
// 面板自己的控件不参与「这一下该不该把焦点拉回终端」的判定。
// 我们这边不需要那套判定（没有 focus-follows-mouse），直接用更短的一招 ——
// 在 mousedown 上 preventDefault，按住默认行为里那次焦点迁移。
// click 照常派发；Tab 键导航也不受影响（键盘来的焦点不经过 mousedown）。
document.querySelector(".pane.a .phead").addEventListener("mousedown", (e) => {
  if (e.target.closest(".pbtn")) e.preventDefault();
});

// C4：**格子头也是"面板自己的控件"**，同一条规矩。
// 少了这一条，点一下格子头切当前格会走成这样：mousedown 先把终端 textarea 的
// 焦点夺走 → click 才调 setActive → setActive 再 focus() 回来。中间那次失焦是
// 白挨的，而 Claude Code 会**真的收到一次 focus-out 并重画输入框**
// （日志里那串 `?2004h` + `[K` 就是这个）。preventDefault 之后压根没有那次失焦。
// 重命名输入框要放行 —— 那是真输入控件，焦点本来就该进去。
$("termbody").addEventListener("mousedown", (e) => {
  if (e.target.closest(".tab-input")) return;
  if (e.target.closest(".cellhead")) e.preventDefault();
});

// 同一条道理，对象换成侧栏 —— 而且这边的后果更重：**会丢字**。
// 实测（focusin/focusout 上报 activeElement）：点一下会话卡片（它是一个真的
// `<button class="card">`，见 cardHTML()），焦点就搬到那个按钮上；左栏那些行
// （`.proj` / `.arow`，原来还有 `.nav`）都是 `<div>`，点了则把焦点丢给 BODY。
// 两种状态下再敲中文，**输入法根本不组字，一个键都进不来** ——
// 不是"进错了地方"，是完全没有反应。
// 终端类应用里点侧栏导航不该让键盘失联，所以整块 chrome 都按住 mousedown 的默认行为。
//
// 代价写清楚：mousedown 上 preventDefault 会连带压掉"从侧栏里拖选文字"。
// 侧栏不是拿来选字的地方（路径全份在卡片的 title 里，会话 id 在状态栏），
// 但这是个真实的行为变化，写在这儿，别让它变成下次的"诡异现象"。
// 例外只有一个：真输入控件（搜索框 #q）必须照常拿焦点，不能拦。
//
// 边界：**自绘标题栏故意不在名单里** —— 那块是 `app-region: drag`，桌面端拖窗口
// 靠的就是 mousedown 的默认行为，拦了窗口就拖不动了。
for (const id of ["rail", "list", "rsb", "status"]) {
  $(id).addEventListener("mousedown", (e) => {
    if (e.target.closest("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();
  });
}

/* ===========================================================================
   收起键（#p-collapse）：收起 = 中栏**换一块面**（「群组」），不是挖空

   历史：C8 那一轮它被改成"收起 = 换上一个我自己画的用量 Dashboard"，用户否了，
   两个理由都要记住：① 用量属于**网关的配置面**，不该挂在视图切换键上；
   ② 那份 Dashboard 是照着 magpie 重画的，而用户要的是接入它的原生界面。
   这一轮的形态是用户给的：**像群聊一样的报告面** —— 顶部是这一屏开着哪些 agent，
   谁在干活/遇到问题/干完一段就在里面汇报，点一下能进那一格。

   ⚠️ 原来那一版只写 `paneA.style.display`，于是收起后中栏**一片黑**（注释里记着
      的"已知毛病"）—— 空出来的宽度没有任何人接手。现在收起的四件事一次说清，
      见 setTermCollapsed。
   ⚠️ `#divider` 一个字都不动：C8 在这里写过 `div.style.display = "none"`，而
      #divider 住在 #rsb 里 —— 收起一次那条分隔条就**永久消失**（再展开也回不来）。
      右栏现在走 setRsbOpen（宽度归零 + overflow:hidden），divider 是被**宽度**
      藏掉的，展开时自己回来。
   =========================================================================== */
function renderCollapseBtn() {
  // 它住在标签条右侧（.icon-btn，26×26），是 `.tabs-right` 的最后一个孩子 ——
  // 右栏开着时它就顶在中栏右沿上（那条几何见 .window-controls-titlebar-spacer）。
  $("p-collapse").innerHTML = lucide(collapsed ? LUCIDE_PANEL_LEFT_OPEN : LUCIDE_PANEL_LEFT_CLOSE, 15);
  $("p-collapse").title = collapsed ? "展开终端面板" : "收起终端面板";
}
renderCollapseBtn();

/* 收起/展开两态的读数**一次带全**：坐标、"divider 还在不在"、右栏那个宽度，
   都不靠目测。这个文件里"看着像对的"已经错过两次（C8 那个永久消失的 divider，
   和那颗标着 hidden 却画在屏上的 rsb-open）。 */
function collapseFacts() {
  const b = $("p-collapse").getBoundingClientRect();
  const g = $("group").getBoundingClientRect();
  const rsb = $("rsb"), op = $("rsb-open");
  return `收起键中心=${Math.round(b.left + b.width / 2)},${Math.round(b.top + b.height / 2)}` +
    ` 群组盒=${Math.round(g.width)}x${Math.round(g.height)}` +
    ` 标签列表=${getComputedStyle($("tablist")).display}` +
    ` 格数=${TAB_LIST.length} --rsb-w=${getComputedStyle(document.documentElement).getPropertyValue("--rsb-w").trim()}` +
    ` #rsb.class=[${rsb.className}] #rsb-open=${op.hidden ? "hidden" : "显形" + (collapsed ? "(灰)" : "")}` +
    ` #divider=${$("divider") ? "在" : "❌不在了"}`;
}

/* 收起 = 四件事一起切：终端面板藏、群组显、标签条让位、右栏收起。
   **不写内联 style，全走 #app 上那一个类** —— 内联那一版留下了"#divider 被顺手
   一起藏掉"和"divider 再也回不来"两个坑（见上面那段）。 */
function setTermCollapsed(on) {
  on = !!on;
  if (on === collapsed) return;
  collapsed = on;
  $("app").classList.toggle("term-collapsed", on);
  if (on) {
    rsbOpenBeforeCollapse = rsbOpen;
    setRsbOpen(false, "终端面板收起");
    askAllSnapshots("收起进群组");   // 非当前格的历史也要，见 askAllSnapshots
    renderGroup();
  } else {
    groupSeen.clear();
    askOpen.clear();    // "我亲手点开过这张卡"是这一屏里的临时态，不进下一轮看板
    setRsbOpen(rsbOpenBeforeCollapse, "终端面板展开");
    requestAnimationFrame(() => {
      if (!activeTab) return;
      // ⚠️ refit 这一句**是原来就有的**，保留：显示态 0 → N 的尺寸变化按理会被
      //    各格自己的 ResizeObserver 接住，但这条路上"按理"不够 —— 一次多余的
      //    量的代价，远小于"某一格尺寸不对"。
      activeTab.refit();
      // 展开后把焦点交回终端 —— 收起键住在标签条上（不在面板里），点完它面板才
      // 回来；不还给终端的话，用户展开完接着打字，字哪都不去。
      // 等价于 Orca 的 focusPanePreservingOverlays（pane-overlay-focus.ts）。
      activeTab.focus();
    });
  }
  renderCollapseBtn();
  rsbPaintOpen();
  sendCtrl({ type: "log", msg: `终端面板${on ? "收起" : "展开"} ${collapseFacts()}` });
}

/* 收起期间那颗「展开右栏」会被 setRsbOpen 显形，而这时候右栏是被**我们**强制
   关着的 —— 点它会当场打架。按本仓立过的规矩（**不可用的动作做灰、不做禁、
   不做隐**，见 MEMORY）：灰掉 + 说清原因 + 点击 no-op。
   留着它还有个好处：.tabs-right 的布局不动，收起键的位置不跳。 */
function rsbPaintOpen() {
  const b = $("rsb-open");
  if (!b) return;
  b.classList.toggle("mute", collapsed);
  b.title = collapsed ? "展开终端面板后可用" : "展开右栏 (Ctrl+Shift+B)";
}

$("p-collapse").addEventListener("click", () => setTermCollapsed(!collapsed));

/* ── 「群组」：一行一个 agent ────────────────────────────────────────────────
   两条不能破的规矩：
     ① **只挑，不写** —— 行里出现的每个字都来自流水（agent 自己说的原话、
        describeTool 写的那句、或者状态词）。"替它总结一句"会同时伪造内容、
        引入成本和隐私问题，而原话本来就在手上（C2 立过的规矩）。
     ② **只重画变了的那一段** —— 这块面每 400ms 就会收到新东西，整表重建会把
        选中态和滚动位置一起抹掉（展开的那段流就挂在这一行里）。
   ─────────────────────────────────────────────────────────────────────── */

// 一帧一次（和 scheduleLive 同一个套路）。启动路径上 renderAgentDot 就会碰到
// 这里，所以 collapsed / groupRaf 的声明必须在**启动之前**（见那一块）。
function scheduleGroup() {
  if (groupRaf || !collapsed) return;
  groupRaf = requestAnimationFrame(() => { groupRaf = 0; renderGroup(); });
}

/* attention-first 排序（照 Orca activity-thread-grouping.ts:19-32 那张表）：
   要你出手的排最前，闲着没事的排最后。写成**穷举**而不是"认不出就落最后" ——
   多一个态时缺一条会当场看见（undefined 排在最前，很扎眼），而"默认落最后"
   会让一个真需要你出手的态静默沉底。
   数值照抄 Orca（waiting 0 → blocked 1 → permission 2 → failed 3 →
   unconfirmed 4 → working 5 → … → interrupted 7 → done 9 → idle 10），
   我们是它那套的子集 + 一个它没有的态（off）。 */
const GROUP_RANK = {
  ask: 0,          // 在等你答（Orca 的 waiting/permission 是 0/2，我们合一）
  off: 1,          // 这一格的 stream 断了 —— 我们自己的态，Orca 没有
  failed: 2,       // 撞限额/鉴权失败（StopFailure）
  unread: 4,       // 说完了你还没看（Orca 的 unconfirmed）
  working: 5,      // 在干活
  interrupted: 7,  // 下面三态只有子代理那边会出，留着让这张表**是穷举的**
  done: 9,
  idle: 10,
};
const groupRankWarned = new Set();

/* 一行第 ② 行：**只出最新那一条**。
   优先级照 Orca（assistant 预览 → tool 预览 → 状态词），但我们一个字都不生成 ——
   只在已有的流水里**挑**，挑到哪条就显示它自己写的那句话。 */
function groupLatest(v) {
  const acts = (v && v.acts) || [];
  for (let i = acts.length - 1; i >= 0; i--) {
    const a = acts[i];
    if (a.kind === "thinking") continue;   // "思考…"没有信息量
    // 压缩节点也不是"它在干什么"：它是这一页的最后那条，说的却是**很久以前**
    // 那几回合被折起来的事（正文是 2 万字的摘要）。所以跳过去接着往前找 ——
    // 真要说"最新动态"，上一条真活儿比一份摘要准确。
    if (a.kind === "compact") continue;
    if (a.text) return a;
  }
  return null;
}

/* 可以出现在群组里的格：**有 id 的**。
   ⚠️ 建格期间 `T.id` 是 0（id 由 Go 的 tab.ok 发回来，前端不自己编号）——
   那一帧 TAB_LIST 里已经有一个 id=0 的成员。它没有可寻址的目标（点它 jumpToTab
   拿到 undefined，静默不跳），所以既不该占顶部条一枚 chip，也不该占一行。
   另外 spawnTab 超时那条兜底会**故意**把一个没有 PTY 的格留在 TAB_LIST 里
   （见 createTab），那种格更没有可点的地方。 */
function groupTabs() { return TAB_LIST.filter((t) => t.id > 0); }

function groupRows() {
  return groupTabs().map((t) => {
    const v = LIVE.get(t.id);
    const st = cellState(t);
    let rank = GROUP_RANK[st];
    if (rank === undefined) {
      // 多了一个态而忘了补表：**大声说一次**（按模块分键，不刷屏），然后当最低
      // 优先 —— 静默按 0 排到最前会让一整屏的顺序突然翻个个儿，更难查。
      if (!groupRankWarned.has(st)) {
        groupRankWarned.add(st);
        sendCtrl({ type: "log", msg: `⚠️ 群组排序表缺状态 ${st}（新增了态没补 GROUP_RANK？）` });
      }
      rank = 99;
    }
    return { t, v, st, rank, ask: pendingAsk(v), perm: pendingPerm(v), latest: groupLatest(v) };
  }).sort((a, b) => (a.rank - b.rank) || (a.t.id - b.t.id));
}

/* 顶部条：**每个 agent 一枚**（序号 + logo + 状态点）。
   顺序 = TAB_LIST（网格里的座位），**不按 attention 排** —— attention 是下面那份
   列表的活儿；条上这个位置表达的是"谁坐在哪"，跟着状态变来变去反而找不到人。
   点一枚 = 去那一格（和点气泡同一件事，走同一条路）。 */
function renderGroupHead(head) {
  const sig = groupTabs().map((t) => t.id).join(",") + "|" + (activeTab ? activeTab.id : 0);
  if (head.dataset.sig !== sig) {
    head.dataset.sig = sig;
    head.innerHTML = groupTabs().map((t) =>
      `<span class="gchip" data-gtab="${t.id}" title="${esc(currentTabTitle(t))}">` +
        `<span class="seq">${t.id}</span>` +
        `<span class="tab-ico">${agentTabIcon(t.spec.agent, 13)}</span>` +
        dotHTML(cellState(t)) +
      `</span>`).join("") +
      `<button id="group-add" title="新开一个并行 agent" aria-label="新开一个并行 agent">` +
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
        ` stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>` +
      `</button>`;
  } else {
    // 座位没变，只有状态/当前格可能变了 —— 就地换那几个点，别整条重建
    //（重建会把这排的悬停和选中一起抹掉，而它每 400ms 就会收到新东西）。
    for (const el of head.querySelectorAll(".gchip")) {
      const t = liveTab(el.dataset.gtab | 0);
      if (t) paintDot(el.querySelector(".adot"), cellState(t));
    }
  }
  for (const el of head.querySelectorAll(".gchip")) {
    el.classList.toggle("on", liveTab(el.dataset.gtab | 0) === activeTab);
  }
}

/* 一行 = 三行卡（解剖照 Orca activity-thread-row.tsx:93-264）：
   ① 状态点 + 标题 ② 只出最新那一条 ③ 身份 + 时间。
   ⚠️ 三段**各判各的签名、各换各的**，不整行重建 —— 那张待办卡就挂在 g2 与 g3
      之间，整行重建会把它上面的选中态一起抹掉（它是能读、能选中复制的一份清单）。 */
function renderGroupList(list) {
  const rows = groupRows();

  if (!rows.length) {
    if (!list.querySelector(".gempty")) {
      list.innerHTML = `<div class="gempty hist-empty">这个工作区里还没有 agent。</div>`;
    }
    list.dataset.order = "";
    return;
  }
  const em = list.querySelector(".gempty");
  if (em) em.remove();

  // ① 行元素备齐（缺的建；关掉的格留下的行删掉）
  const keep = new Set();
  for (const r of rows) {
    keep.add(String(r.t.id));
    if (!list.querySelector(`.grow[data-gtab="${r.t.id}"]`)) {
      const el = document.createElement("div");
      el.className = "grow";
      el.dataset.gtab = r.t.id;
      el.innerHTML = `<div class="g1"></div><div class="g2"></div><div class="g3"></div>`;
      list.appendChild(el);
    }
  }
  for (const el of [...list.querySelectorAll(".grow")]) if (!keep.has(el.dataset.gtab)) el.remove();

  // ② 顺序（attention 会变）。**只在真的变了的时候搬** —— appendChild 是"搬"，
  //    每帧照搬一遍会让浏览器反复做布局。
  const order = rows.map((r) => r.t.id).join(",");
  if (list.dataset.order !== order) {
    list.dataset.order = order;
    for (const r of rows) list.appendChild(list.querySelector(`.grow[data-gtab="${r.t.id}"]`));
  }

  // ③ 内容
  for (const r of rows) {
    const el = list.querySelector(`.grow[data-gtab="${r.t.id}"]`);
    const t = r.t;
    const nm = realTabTitle(t);
    // 标题为空 → 退化成状态词，**不留空行**（Orca DashboardAgentRow.tsx:143-148 同判据）
    const stWord = DOT_LABEL[r.st] || r.st;
    const name = nm || stWord;

    const g1 = el.querySelector(".g1");
    const s1 = [r.st, name, t === activeTab ? "cur" : ""].join("\u0001");
    if (g1.dataset.sig !== s1) {
      g1.dataset.sig = s1;
      g1.innerHTML = dotHTML(r.st) + `<span class="nm" title="${esc(nm)}">${esc(name)}</span>`;
    }

    /* 第 ② 行：**只出最新那一条行动**。
       有待办/待批的行**没有这一行** —— 那一行最该被看见的一句是"它要你答/批什么"，
       已经由下面那张卡的头一行说了（同一个事实在一行里说两遍，这个文件为它踩过一次：
       「空闲/空闲」）。末级回落是**状态词**：那一级只在"这一格什么都还没说"时才走到
       （"不留空行"，Orca DashboardAgentRow.tsx:143-148 同判据）。 */
    const line2 = (r.ask || r.perm) ? ""
      : (r.latest && r.latest.text) || (r.v && r.v.note && r.v.note.text) || stWord;
    const g2 = el.querySelector(".g2");
    if (g2.dataset.sig !== line2) {
      g2.dataset.sig = line2;
      // 渲染**行内**标记，和右栏那条流同一套（同一份东西两处呈现不能一处渲染
      // 一处直出 —— 实测里它当场吐出了原文的 `**Blue**`）。用 mdInline 不用 md：
      // 这一行是单行省略的摘要，md() 会给围栏代码吐 <pre>，把这一行顶变形。
      // mdInline 收**已转义**的文本，所以 esc 在它外面（和 md() 里的顺序一致）。
      g2.innerHTML = line2 ? mdInline(esc(clamp(line2, 200))) : "";
    }

    const at = (r.ask && r.ask.at) || (r.perm && r.perm.at) ||
      (r.latest && r.latest.at) || (r.v && r.v.at) || "";
    const g3 = el.querySelector(".g3");
    const s3 = [at, t === activeTab ? "cur" : ""].join("\u0001");
    if (g3.dataset.sig !== s3) {
      g3.dataset.sig = s3;
      g3.innerHTML = `<span class="tab-ico">${agentTabIcon(t.spec.agent, 12)}</span><span>格 ${t.id}</span>` +
        // 时间节点带 .tm + data-at：相对时间会随时间长歪，靠下面那个 60s 的定时
        // 刷新按 data-at 重算（和对话流里的时间节点是**同一个**机制，不是两套）。
        (at ? `<span>·</span>` +
          `<span class="tm" data-at="${esc(at)}" title="${esc(absTime(at))}">${esc(rel(at))}</span>`
          : "") +
        `<button class="go" data-go="${t.id}">进入 →</button>`;
    }

    /* ④ 待办卡 —— 这一行**唯一的动作区**（这一行其余的地方都是"进那一格"的落点）。
       它插在 g2 与 g3 之间，按签名增量换：每 400ms 整块重建一次会把这上面的选中态
       抹掉，而它是一份**用来读和选中复制的清单**（Orca 那条"回答后仍可选中原文"）。
       没有待办的行根本没有这张卡 —— 这也是"已答的提问从看板上退场"的实现：
       `pendingAsk` 一返回 null，卡就没了，留下的只有第 ② 行那句新动态。 */
    const slot = el.querySelector(":scope > .gask");
    if (!r.ask) {
      if (slot) slot.remove();
    } else {
      const sig = askBlockSig(r.ask);
      if (!slot || slot.dataset.sig !== sig) {
        const html = askHTML(r.ask, t, askOpen.has(r.ask.id));
        if (slot) slot.outerHTML = html; else g3.insertAdjacentHTML("beforebegin", html);
        const nu = el.querySelector(":scope > .gask");
        // ⚠️ 这一段里抛一个错，整个 renderGroupList 就断在这儿（这一页没有控制台，
        //    看到的现象是"群组不更新了"）—— 所以宁可少画一次也不赌它一定找得到。
        if (nu) nu.dataset.sig = sig;
      }
    }

    /* ④b 待批卡 —— 和待办卡同一个位置（g2 与 g3 之间）、同一条增量规矩。
       ⚠️ 它的可用性**每帧现读屏**（permState）：权限框只在那格终端里，转录里没有；
          屏一变（弹出来 / 被答掉 / 进了 Tab 输入态）按钮的活灰就得跟着变。 */
    const pslot = el.querySelector(":scope > .gperm");
    if (!r.perm) {
      if (pslot) pslot.remove();
    } else {
      const ps = permState(r.perm, t);
      const sig = permBlockSig(r.perm, ps);
      if (!pslot || pslot.dataset.sig !== sig) {
        const html = permHTML(r.perm, t, ps);
        if (pslot) pslot.outerHTML = html; else g3.insertAdjacentHTML("beforebegin", html);
        const nu = el.querySelector(":scope > .gperm");
        if (nu) nu.dataset.sig = sig;
      }
    }
  }
}

/* 待办卡的重画签名。原来是给"整条消息流"做增量对账的，现在只剩这一块要增量 ——
   ⚠️ 只按签名换、**不整块重建**：这张卡每 400ms 就会收到新东西，重建一次就把用户
   正在选的字和滚动位置一起抹掉，而它是一份**能读、能选中复制**的清单。 */
function askBlockSig(a) {
  const qs = a.qs || [];
  /* 多问/多选那几张屏上的进度（哪一问 / 哪几项勾着 / 到没到提交）**转录里没有**，
     只有屏上有 ⇒ 读到的读数必须进签名，否则屏变了这张卡不重画（勾选框不会动）。
     单问单选不加这一段：它答完转录就翻，屏读数对它没有任何用。 */
  const many = qs.length > 1 || !!(qs[0] && qs[0].multi);
  /* ⚠️ `answerPick`/`answerErr` 是**我们自己记的**（answerPick 只记被屏回执证过的、
     answerErr 是"你点了一下没走上"）—— 它们也长在这一块的画面上 ⇒ **必须进签名**。
     少了这一段就会踩到实测里那一幕：屏一变，700ms 那一轮先按"屏读"重画了一次
     （那会儿还没记下你答了什么），紧接着 watchScreenStep 记下答案又叫了一次重画 ——
     两次签名一模一样，增量重画在这里**直接跳过**，于是「（没读到）」一直挂在屏上
     （要等整张提问收尾、转录把 answers 落下来才被顶掉）。这是个"界面在说自己不知道
     一件它知道的事"，比没有这块显示更糟。 */
  return "ask:" + (a.id || "") + ":" + (a.ok == null ? "pending" : "done") +
    ":" + JSON.stringify(a.answers || null) +
    ":" + JSON.stringify(answerPick.get(a.id) || null) +
    ":" + JSON.stringify(answerErr.get(a.id) || null) +
    (many ? ":scr:" + askScreenSig(askScreen.get(a.id)) : "");
}

/* ---------------------------------------------------------------------------
   待办卡**默认收着**（用户 2026-10-16 定的，我第一版默认摊开被否掉）。
   他给的理由是这一屏的存在理由本身："用户应该先确定哪个选择来自哪个 Agent" ——
   看板先要能一眼读完"谁在等你"，摊开的选项会把 agent 身份淹掉；真要答了，
   点一下「作答」就在**这一行里**摊开，不用换地方。

   中间删掉过一版"按量出来的高度决定收放"（短的摊开、长的收）：那是用户的原话，
   但实测之后他改成了一律收起 —— 所以那套阈值机器（ASK_WIN_H / measureAsk /
   量高度重排）跟着删了，别照"短的摊开"那条记忆把它加回来。
   ⚠️ 留下的只有**用户自己点开过**的那份记录：askOpen（按 ask id，不按格 ——
      一格前后会有好几张提问，按格记会让下一张凭空继承上一张的展开态）。
   --------------------------------------------------------------------------- */

