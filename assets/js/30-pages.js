"use strict";
/* 30-pages.js —— 并行网格与独立页（C5）、标签拖拽、关格、新格、选会话面板、IME 锚点。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 2247-3115（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

// ===========================================================================
// C5：独立页 —— 把一个 agent 从并行网格里"拎"到标签条上
// ---------------------------------------------------------------------------
// 语义（产品形态，用户定的）：
//   · 标签条 = **页面**。「并行」是第一张页、写死在 HTML 里、不可关；
//   · 把一个格子头往上拖到标签条 = 把这个 agent 拎成一张独立页；
//   · 关掉那张页 = 把这个 agent **还给网格** —— 不是杀掉它。
//   ∴ 页面标签上的 × 是"关页面"，网格里格子头上的 × 才是"结束这个 agent"。
//
// ⚠️ 拎出去**不是把 agent 从网格里摘走**：TAB_LIST 不动、PTY 不动、stream 不动，
//    动的只有 #termbody 上的一个类（机制见 CSS 里那段，出处是 Orca 的
//    expand-collapse.ts）。所以"还给网格"不需要任何恢复动作 —— 它本来就在那儿。
// ===========================================================================

// 一张页 = 一个标签元素，外观和「并行」同一套（所以 #tablist .tab 那几条直接
// 生效）。元素挂在标签对象上，和格子头一样**建一次就不重建**（重命名会把 .nm
// 换成输入框，重建等于把用户正在打的字连输入框一起删掉）。
function makePageEl(t) {
  if (t.pageEl) return t.pageEl;
  const el = document.createElement("div");
  el.className = "tab";
  el.innerHTML =
    `<span class="adot" data-state="idle" role="img" aria-label="空闲"></span>` +
    `<span class="tab-ico"></span>` +
    `<span class="nm ell"></span>` +
    `<span class="x" title="关闭页面（agent 回到网格，不会结束它）">×</span>`;
  t.pageEl = el;
  t.pageDotEl = el.querySelector(".adot");
  t.pageIcoEl = el.querySelector(".tab-ico");
  t.pageNmEl = el.querySelector(".nm");
  t.pageIcoEl.innerHTML = agentTabIcon(t.spec.agent, 12);
  // 名字和状态点**直接跟格子头同源**（同一对渲染函数，见它们的双写那段）——
  // 界面上同一个 agent 的两个落点必须永远说同一句话。
  renderTabTitle(t);
  renderAgentDot(t);
  $("tablist").appendChild(el);
  return el;
}
function removePageEl(t) {
  if (!t || !t.pageEl) return;
  t.pageEl.remove();
  t.pageEl = null; t.pageDotEl = null; t.pageIcoEl = null; t.pageNmEl = null;
}
// 激活标记：**同一时刻只有一个落点是真的激活** —— soloTab 存在时是那张页，
// 否则是「并行」。写成两处独立开关迟早会出现"两个都亮"。
function renderPageTabs() {
  const par = $("tab-parallel");
  if (par) par.classList.toggle("on", !soloTab);
  for (const t of TAB_LIST) if (t.pageEl) t.pageEl.classList.toggle("on", t === soloTab);
}

// 拎成独立页（点已存在的那张页也走这里 = 切过去）。
function showPage(t) {
  if (!t || soloTab === t) return;
  /* N=1 不给拎 —— 判据照抄 Orca `expand-collapse.ts:50` 的
     `if (panes.length <= 1) return false`：只有一个 agent 时"独立页"和网格
     是同一个东西，拎出去只是让标签条多一张纸，还多一处要维护的状态。 */
  if (TAB_LIST.length <= 1) {
    // 兜底：手势那条已经挡过一次（见 pointermove 里那段），这里是第二道闸 ——
    // 别的入口将来要是绕过手势直接调它，也不该能拎出去。
    sendCtrl({ type: "log", msg: `拒绝拎出 tab=${t.id}：并行里只有 1 格（Orca 同判据 panes.length<=1）` });
    return;
  }
  soloTab = t;
  makePageEl(t);
  renderPageTabs();
  renderGrid();
  setActive(t);
  // rAF 之后再量 —— Orca 的 refreshPaneSizes（expand-collapse.ts:133-148，
  // 原注释：同步改了行内 display/flex，所以要等布局落地再让 FitAddon 量）。
  // 我们的 refit() 本身就是"排到 rAF 上、等两帧稳定再推"（见 settle），
  // 所以这一句就等于它那条。其余各格的 ResizeObserver 也会各自醒一次，而
  // settle() 头一行会把 0 宽的盒子直接挡掉（藏起来的格子不会推假尺寸）。
  t.refit();
  sendCtrl({ type: "log", msg: `拎出页面 tab=${t.id} 网格剩 ${TAB_LIST.length - 1} 格已隐藏 PTY未动 主区宽未改` });
}

// 回网格（点「并行」，或关掉那张页）。
function backToGrid() {
  const t = soloTab;
  if (!t) return;
  soloTab = null;
  renderPageTabs();
  // 回网格这一句会**把主区宽度按 N 折回来**（renderGrid 里那条
  // `!soloTab` 的分支）—— 拎出去时特意不碰的宽度，在这里还回去。
  renderGrid();
  if (activeTab) activeTab.refit();
  sendCtrl({ type: "log", msg: `回到网格 N=${TAB_LIST.length}（tab=${t.id} 自始至终都在网格里）` });
}

// 关页面 **≠** 关 agent。
function closePage(t) {
  if (!t || soloTab !== t) return;
  soloTab = null;
  removePageEl(t);
  renderPageTabs();
  renderGrid();
  sendCtrl({ type: "log", msg: `关页面 tab=${t.id} 回到网格（agent 没死：它一直在 TAB_LIST 里，stream 未关）` });
}

// ── 拎页的手势：在格子头上按下 → 往上拖到标签条 → 松手 ──────────────────────
//
// 用 pointer 事件而不是 HTML5 drag-and-drop。两条理由：
//   ① dragstart 没法从合成输入稳定驱动（本项目的验收全靠真手势驱动）；
//   ② pointer 这条路上，那个"跟着指针走的幽灵片"是我们自己画的（DnD 那个
//      系统自带的拖影在 WebView2 里样式不受控，质感必然对不上）。
// 判据是"**往上、且纵向为主**、位移超过 6px"：往下拖今天没有语义（留给以后
// 换格子顺序），横向拖是选字 —— 两个都不能被这里吃掉。
const DRAG_MIN = 6;
let dragState = null;
let dragEndedAt = 0;
// 拖拽尾巴上那一下 click 不算"点了一下页"（否则松手会顺手把页切成刚拎的那张，
// 看起来像"刚松手它就自己跳了一下"）。
function dragJustEnded() { return performance.now() - dragEndedAt < 250; }

// 幽灵片**复用标签的外观**（同一个 12px 图标、同一个 .nm 省略号、同一个圆角）：
// 它要回答"我松手会得到什么"，形状不一样就答不上来。
function makeGhost(t) {
  const g = document.createElement("div");
  g.className = "drag-ghost";
  g.innerHTML =
    `<span class="adot" data-state="idle" role="img"></span>` +
    `<span class="tab-ico"></span><span class="nm ell"></span>`;
  g.querySelector(".nm").textContent = currentTabTitle(t);
  g.querySelector(".tab-ico").innerHTML = agentTabIcon(t.spec.agent, 12);
  g.querySelector(".adot").dataset.state = t.connDown ? "off" : t.agentState || "idle";
  document.body.appendChild(g);
  return g;
}
function ghostAt(g, x, y) {
  // 落在指针右下方一点：既不盖住指针，也不盖住"我要放的那个位置"。
  g.style.left = Math.round(x + 14) + "px";
  g.style.top = Math.round(y + 12) + "px";
}
function overTabs(x, y) {
  const r = $("tabs").getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

$("termbody").addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || dragState) return;
  // 关闭按钮和重命名输入框是它们自己的控件，不参与拎页。
  if (e.target.closest(".x") || e.target.closest(".tab-input")) return;
  const el = e.target.closest(".cellhead");
  if (!el) return;
  const t = TAB_LIST.find((x) => x.tabEl === el);
  if (!t) return;
  // 正在给这一格改名时不拎：改名的输入框长在这个头里面，被拎出去的头会
  // display:none，输入框跟着被藏起来，blur 还会往一个看不见的框上提交。
  // （点在输入框本身上面那条已经挡掉了，这条挡的是头两侧的空白。）
  if (tabEditing && renameTab === t) return;
  dragState = { t, x0: e.clientX, y0: e.clientY, on: false, ghost: null, head: el };
  // 捕获：指针拖到标签条上之后（早就不在这一格头顶了），move/up 仍然送回这里 ——
  // 少了这一条，抬手事件会落到别的元素上，拖拽永远收不了尾。
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
});
$("termbody").addEventListener("pointermove", (e) => {
  const d = dragState;
  if (!d) return;
  const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
  if (!d.on) {
    if (dy > -DRAG_MIN || Math.abs(dy) <= Math.abs(dx)) return;
    /* 只有一格时**连幽灵片都不给**。给一个"拖得动、放得下"的假象，再在松手时
       说"不行"，那是在骗人 —— 拿掉了 d.on 的启动，就等于这个手势在这里压根
       不存在（和拖不动的东西手感一致）。判据见 showPage：Orca 同一条。 */
    if (TAB_LIST.length <= 1) {
      sendCtrl({ type: "log", msg: `拒绝拎出 tab=${d.t.id}：并行里只有 1 格（Orca 同判据 panes.length<=1），手势不启动` });
      dragState = null;      // 撤掉本次手势；pointerup 会看到 null 直接收手
      return;
    }
    d.on = true;
    d.ghost = makeGhost(d.t);
    d.head.classList.add("dragging");
    // 探针：拖拽是**纯手势**，日志里没有它的话，"页面是怎么来的"就只剩结果了。
    sendCtrl({ type: "log", msg: `拎页拖拽中 tab=${d.t.id} 起于格子头(${Math.round(d.x0)},${Math.round(d.y0)})` });
  }
  ghostAt(d.ghost, e.clientX, e.clientY);
  $("tabs").classList.toggle("drop", overTabs(e.clientX, e.clientY));
});
function endDrag(e, commit) {
  const d = dragState;
  dragState = null;
  if (!d) return;
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) {}
  if (!d.on) return;                      // 只是点了一下格子头：交给 click 那条路
  d.ghost.remove();
  d.head.classList.remove("dragging");
  $("tabs").classList.remove("drop");
  dragEndedAt = performance.now();
  if (commit && overTabs(e.clientX, e.clientY)) {
    showPage(d.t);                        // 探针在 showPage 里
  } else {
    sendCtrl({ type: "log", msg: `拎页取消 tab=${d.t.id}（没落在标签条上，落点=(${Math.round(e.clientX)},${Math.round(e.clientY)})）` });
  }
}
$("termbody").addEventListener("pointerup", (e) => endDrag(e, true));
$("termbody").addEventListener("pointercancel", (e) => endDrag(e, false));
/* 兜底（C5 收尾那一条）：pointerup 丢了的时候把状态收掉。
   什么时候会丢：拖到一半 Alt+Tab、被别的窗口抢走指针、或者指针离开了窗口 ——
   那时 `dragState` 会**一直是非空**，而 pointerdown 的第一行就是
   `if (dragState) return`，于是**之后所有拎页手势静默失效**。
   静默是关键：界面上没有任何东西坏掉，只是"拖不动了"，这种故障最难被归因。
   窗口失焦是"这一轮输入不会再回来"的可靠信号，就在这儿收尾。
   按**取消**处理（不是提交）：失焦那一刻不知道用户想不想放，猜错就等于
   替他做了决定 —— 而"什么都没发生"永远可以重试。 */
window.addEventListener("blur", () => {
  const d = dragState;
  if (!d) return;
  dragState = null;
  if (!d.on) return;                  // 只是按下去还没拖起来，不用管
  d.ghost.remove();
  d.head.classList.remove("dragging");
  $("tabs").classList.remove("drop");
  sendCtrl({ type: "log", msg: `拎页取消 tab=${d.t.id}（窗口失焦，手势没收尾）` });
});

// 点「并行」= 回网格。点某张页 = 切过去；点它的 × = 关页面（agent 回网格）。
$("tab-parallel").addEventListener("click", () => backToGrid());
$("tablist").addEventListener("click", (e) => {
  const el = e.target.closest(".tab");
  if (!el || el.id === "tab-parallel") return;    // 上面那条管它
  const t = TAB_LIST.find((x) => x.pageEl === el);
  if (!t) return;
  if (dragJustEnded()) return;
  if (e.target.closest(".x")) { closePage(t); return; }
  showPage(t);
});

// 切换"当前格"。**唯一给模块级 `term` 赋值的地方。**
//
// 网格里所有格子**同时可见**，所以这里不再有"藏起来/显出来"这回事 ——
// 它只剩三件事：把 #termhost 这个 id 挪过来（文件里按 id 找宿主的代码要），
// 标记哪一格是当前格（左边那条竖条），以及把焦点交给它。
function setActive(t) {
  /* ⚠️ 第二个判据不是洁癖：`activeTab` 已经是它，**不代表这一格已经接上了**。
     座位是"先登记再建"的（见 createTab 开头）—— 它可能在终端还没建好时就被认成了
     当前格（closeTab 挑下一个当前格时会挑到它），那一次调用是靠 T 上那几个空实现
     撑过去的，模块级的 `term` 还留在 null 上。这时再调一次必须**真的跑**，
     判据就是"当前终端还没接上"。不放宽的话这一格永远不活：用户点它 → 走这句话 →
     直接返回（activeTab 还是它），于是焦点/尺寸/term 一样都补不上，
     往里打字是打给 null 的。 */
  if (!t || (activeTab === t && term === t.term)) return;
  if (activeTab) {
    activeTab.host.removeAttribute("id");   // #termhost 永远只属于当前格
    activeTab.cellEl.classList.remove("cur");
    activeTab.tabEl.classList.remove("on");
  }
  activeTab = t;
  t.host.id = "termhost";
  t.cellEl.classList.add("cur");
  t.tabEl.classList.add("on");
  term = t.term;                            // ← 页面级那几十处读到的就是它
  renderAgentDot(t);
  renderTabTitle(t);
  paintConnStatus(t.ready);
  paintRenderStatus();
  if (t.lastSizeSent) $("s-dims").textContent = t.lastSizeSent.replace("x", "×");
  t.refit();
  t.focus();
  // 切到它 = 看过它（Orca 的 unread 就是"看过即销"）：把它那条「需要你」
  // 降级成「空闲」，并重画右栏那四个模块 —— 它们的主语是当前格，
  // 当前格换了，改动/流水/子代理三栏的内容整批跟着换。
  ackNote(t, "切格");
  // 切到一格就顺手把它的流水快照补齐（页面刷新后每格都是空的，见 askActsSnapshot）
  askActsSnapshot("成为当前格");
  scheduleLive();
  // 探针：**模型和布局是两件事**。像素只能告诉你"谁盖住了谁"，量不出格子有多大，
  // 所以格子的真实几何回传到日志。C4 验的就是"N 格同屏、各自拿到自己的尺寸"。
  const tb = $("termbody");
  sendCtrl({ type: "log", msg: `setActive tab=${t.id} 模型=${TAB_LIST.length} 列=${tb.style.getPropertyValue("--gcols")} 格=${[...tb.children].map((e) => Math.round(e.offsetWidth) + "x" + Math.round(e.offsetHeight)).join(",")}` });
}

// 关掉一个格子：关掉它的 stream，Go 那边 Receive 失败就 return，
// defer 里会把 PTY 收掉、把 handler 从表里删掉（main.go handleTab）。
/* 两种"用户点名"的关闭，语义**不同**（用户 2026-10-17 定的）：
     `opts.close`   点格子头的 × = 关掉运行、**留着这个 agent**（发 `pane.close`，
                     记录打 closed；重启不自动拉起，左栏列成「已关闭」）；
     `opts.forget`  左栏「结束这个 agent」= 不要它了（发 `pane.forget`，唯一删记录的路）。
   —— 见 main.go 的 tabs.drop 那段：流断了、进程挂了、窗口关了都**不许动记录**，
   那些只说明"它现在不在跑"，不说明"我不要它了"。
   ⚠️ 另一条走到这里的路是 createTab ③ 的收尾（护栏拒绝 → 撤格），那次不算用户点名：
   格子没建出来不等于座位不要了。 */
function closeTab(t, opts) {
  if (!t) return;
  const i = TAB_LIST.indexOf(t);
  if (i < 0) return;
  if (opts && opts.forget && t.paneID) {
    sendCtrl({ type: "pane.forget", pane: t.paneID });
    bootFact(`关格忘掉座位：pane=${t.paneID}（${(opts && opts.why) || "用户显式关格"}）`);
  } else if (opts && opts.close && t.paneID) {
    /* × = **关掉运行**，不是删掉这个 agent（用户 2026-10-17 定的）。
       Go 把记录打上 closed；这里留一份薄快照，让左栏工作区里继续有一行
       「已关闭」，点一下在原座位接上。 */
    rememberClosedPane(t);
    sendCtrl({ type: "pane.close", pane: t.paneID });
    bootFact(`关格保留记录：pane=${t.paneID}（${(opts && opts.why) || "用户关格"}）`);
  }
  // 正在被重命名的是它：先把编辑收掉，否则输入框会连着一整格 DOM 被摘下来，
  // blur 还会往一个已经不存在的标签上提交。
  if (tabEditing && renameTab === t) cancelRename();
  let closed = false;
  try { if (t.stream) { t.stream.close(); closed = true; } } catch (e) {}
  // 关格子是**唯一**会让 Go 那边销毁 PTY 的动作，而它在界面上留下的痕迹只有
  // "少了一格" —— 连"到底关没关成"都看不见。所以结果明确回传：这条 stream
  // 关掉了没有（关掉 = Go 的 Receive 会失败 = PTY 会被收走）。
  sendCtrl({ type: "log", msg: `关格子 tab=${t.id} 关闭后模型=${TAB_LIST.length - 1} stream已关=${closed}` });
  // 它占着的那个 WebGL 槽位要还回去，否则关掉几个之后新格子会因为"名额满了"
  // 一律退回 DOM 渲染器（见 attachWebgl 的上限那段）。
  if (t.gfx && t.gfx.on) webglLive--;
  /* C7：这一格里**还在跑**的子代理，是我们"看着它被关掉"的 —— 「已关闭」只有这一条
     是亲眼所见（另外两条是对文件的推断，见 subStateOf）。
     只记没收到 Stop 的那些：关掉一个已经跑完的格子，不是"关闭了里面的子代理"。
     ⚠️ 另一半也要记：hook 报过 Stop 的那些，**趁 LIVE 还在**记进 subDone ——
     下面几行就把这一格的 hook 模型删了，不记的话"我们看着它完成"这条当场蒸发，
     卡会退回去读文件、在库里挂 3 分钟的「进行中」（01:01:15 实测到的那一次）。
     两边的措辞都在 cardSubWhy，那里也按可信度分了三种说法。 */
  const lv = LIVE.get(t.id);
  if (lv && lv.subs) for (const sb of lv.subs) {
    if (sb.done) subDone.add(subKey(sb.id));
    else subClosed.add(subKey(sb.id));
  }
  TAB_LIST.splice(i, 1);
  // 它那一份实时读数跟着走。**不只是省内存**：不删的话，同一个 tab id 下次
  // 被复用时（Go 那边 id 是递增的，但那是 Go 的事，前端不该依赖）会读到一个
  // 关掉的格子的流水，表现是"新格子一开就有别人留下的改动"。
  LIVE.delete(t.id);
  t.cellEl.remove();
  /* C5：它要是正被拎成一张独立页，那张页必须跟着走 —— 否则标签条上留下一个
     点不动的空壳（它的标签对象已经不在模型里了）。
     ⚠️ 顺序：先清 soloTab 再 renderGrid，否则 renderGrid 会去摸一格已经不
     在 TAB_LIST 里的格子（.solo 类会留在被摘下来的 DOM 上，视图出不来）。 */
  if (soloTab === t) soloTab = null;
  removePageEl(t);
  /* C5：格数掉到 ≤1 时自动收回独立页 —— 判据照 Orca
     `expand-collapse.ts:150-168 syncExpandedLayout`（`if (panes.length <= 1 …)
     { setExpandedPane(null); restoreExpandedLayout(); }`）。
     只剩一格时"页面视图"和"网格视图"是同一个东西，留着那张页只是多一张永远
     点不掉、也点不出差别的标签。 */
  if (soloTab && TAB_LIST.length <= 1) {
    const st = soloTab;
    soloTab = null;
    removePageEl(st);
    sendCtrl({ type: "log", msg: `自动收回独立页 tab=${st.id}：并行里只剩 ${TAB_LIST.length} 格（Orca 同判据）` });
  }
  renderPageTabs();
  if (activeTab === t) {
    activeTab = null; term = null;
    setActive(TAB_LIST[Math.min(i, TAB_LIST.length - 1)] || null);
  }
  renderGrid();     // 格数变了 → 重排列数、重算主区宽度
  // 左栏的行就是 agent：这一格没了，那一行也得跟着没（2026-10-17 起左栏
  // 唯一的实体是 agent，见 projRowHTML 上面那一大段）。
  armRailRebuild();
  /* C7：上面往 subClosed 里记了账，但**列表不会自己重画** —— 会话库那份
     STATE 是启动时推一次的（main.go handleShell）。两件事得分开做：

       ① 就地改签：把已经在屏幕上的卡按新状态重算一遍（不重画列表，
          免得把用户正在读的那张列表冲掉）。它管的是"这一格里的子代理
          我们眼看着关了"这件事**立刻**看得见。
       ② 让 Go 重扫一遍库：因为这一格里的子代理是 boot **之后**才落盘的，
          库里根本没有它的卡 —— 光改签什么也改不到（实测：00:53 那次
          "已关闭"一条都没出现，就是这个原因，见 main.go 的 lib.reload）。
          重扫回来会带着它的卡、状态已经是"已关闭"。

     ① 在 ② 到达之前先把已知的账画出来；ctl 没连上时（ctlReady=false）
     ② 发不出去，那时就只有 ① —— 所以两个都要留着，不能只留 ②。 */
  if (lv && lv.subs && lv.subs.some((sb) => !sb.done)) refreshSubChips();
  /* ⚠️ **复接（reseat）时不发**：那一次关格之后紧接着就要用同一个 paneId 建同一格，
     而 Go 的 `lib.reload` 是同步重扫整个会话库（实测 131 个会话、186KB、2.5s），
     它和随后的 `tab.new` 排在同一根 ctl 流上 —— 实测（开发期日志
     14:06:57 → 14:07:00）建格应答被它顶掉 2.5 秒，前端判超时又重发一次
     （靠令牌去重兜住了，日志里多一条假超时）。复接不是"这一格没了"：
     下一秒它还是同一条会话，重扫没有意义。 */
  if (!(opts && opts.reseat)) sendCtrl({ type: "lib.reload" });
}
// 点格子 = 认这个格子为"当前格"。委托在 #termbody 上（格子是动态建的），
// 判据仍然是"元素 → 标签对象"（跟标签条那时一样），不是靠 id 或顺序。
$("termbody").addEventListener("click", (e) => {
  const el = e.target.closest(".cell");
  if (!el) return;
  const t = TAB_LIST.find((x) => x.cellEl === el);
  if (!t) return;
  if (e.target.closest(".x")) { closeTab(t, { close: true, why: "点格子头的 ×" }); return; }
  // **点它 = 我看了它**：「需要你」那条（未读的铃铛）就在这里销掉。
  // 这一句必须在 setActive 之前/之外：setActive 在"点的就是当前格"时会直接
  // 返回，而"当前格刚跑完、我点它一下"恰恰是最常见的销账动作。
  setActive(t);
  ackNote(t, "点格");
  // 点格 = "我要看这一格现在在干什么"，所以下段也跟着回到这一格。
  // （在库模式下点格，不回来说不过去 —— 左栏那张卡还亮着，但下段讲的是
  //   你刚点的这一格；来源签会同时变成「当前格」，写得出来就不算歧义。）
  flowToLive("点格");
  scheduleLive();
});

// 键盘焦点进到哪一格，哪一格就是"当前格"。
// 少了这一条，用鼠标点进终端打字时，状态栏/面板头显示的仍然是上一个格子 ——
// 而 #termhost 这个 id（"谁是当前格"）也会留在别人身上。
$("termbody").addEventListener("focusin", (e) => {
  const el = e.target.closest(".cell");
  if (!el) return;
  const t = TAB_LIST.find((x) => x.cellEl === el);
  if (t) setActive(t);
});

// 点「+」= 并行区里**再加一个全新的 agent**（claude + 默认工作目录），
// 网格自动重排。不是"复制当前格" —— 续接已有会话是另一条路（「开一个 agent」
// 面板的「接上已有」，或者左栏「已关闭」那一行）。
//
// ⚠️ 2026-10-17 起**只有群组那一屏**的 + 还直接走这里：标签条那颗 + 改成打开
// 选择面板（见 openAgentPanel），因为"在哪开、开什么"不该由一个一按就动的键
// 替用户决定。它留着具名函数是因为：收起后的群组里没有地方挂浮层，那里那颗 +
// 仍然直接起格；两处各写一遍，"回网格"和"切到新格"里漏一句的后果是看着点了
// 没反应（新格子藏在别的视图里），而这种漏很难在截图里看出来。
async function newParallelTab(why) {
  // C5：正在看某张独立页时点「+」—— 视图先回网格。新 agent 是加进**并行**里的
  // （这就是这个按钮的标题："新开一个并行 agent"），留在页面上会让人点了没反应
  // （新格子藏在 display:none 里）。回网格那一下顺手把主区宽度按新 N 折回来。
  if (soloTab) backToGrid();
  // 群组那排 +（收起时没有地方挂选择面板）：用设置里的默认 agent，和左栏一键新开一致。
  const spec = defaultSpawnSpec();
  const t = await createTab(spec);
  // 建格失败那条路（护栏拒绝）里 createTab 已经把这一格撤了（closeTab）——
  // 它照样返回了 T，别拿着一个不在 TAB_LIST 里的格去 setActive。
  if (!TAB_LIST.includes(t)) return;
  renderGroup();
  sendCtrl({ type: "log", msg: `新开并行 agent tab=${t.id} agent=${spec.agent} ` +
    `（${why || "点 +"}）现在 ${TAB_LIST.length} 格` });
  /* ⚠️ 从**群组**里点 + （此时是收起的）必须**进去**那一格，不能只 setActive：
     新格的 PTY 还没起 —— 前端的首帧尺寸就是 PTY 的启动闸（Go 侧 awaitInitialSize），
     而收起的群组里那一格是 0×0，报不出尺寸（实测：点完 + 过了 45s 日志里都没有
     `已启动`，展开的那一下 PTY 才起来）。不进去的话，屏上会出现一个"有行、没有
     PTY"的 agent，而用户点 + 本来就是要接着给它派活 —— 那必须有终端。
     展开着的格子（标签条那个 +）本来就有尺寸，照旧 setActive，不闪、不夺焦点。 */
  if (collapsed) goToTab(t, why || "群组那排 +");
  else setActive(t);
}
/* ---------------------------------------------------------------------------
   「开一个 agent」选择面板（2026-10-17）
   标签条那颗 + 原来一按就起一个**默认工作区**的 claude（newParallelTab），
   用户定的新形态是「先问再开」：+ 弹面板，两个页签 ——
     · 新会话：在选中的工作区里起一个全新的 agent；
     · 接上已有：列历史会话，默认**只看当前工作区**，可切「全部工作区」。
   三处语义要点：
     · 「当前工作区」= 当前格生效 cwd 所属的工作区（嵌套项目取路径最深的）；
       没有格就退回默认工作区。左栏没有"选中项"，cwd 是唯一现成的事实。
     · 会话行三种状态：能接（点击 = exact resume）/ 已经在跑（点击 = 跳到那
       一格 —— 绝不第二条 claude 写同一份 jsonl）/ 接不上（灰着，点击和 title
       都给原因，复用 resumeWhy，和左栏、卡片是同一套判据）。
     · 子代理会话（sidechain）**不进列表**：它的 id 不是独立会话，列出来只是
       一排永远接不上的行。
   ⚠️ 群组那排末尾的 + 仍然直接调 newParallelTab（收起状态下没有地方挂浮层）。
--------------------------------------------------------------------------- */
let opTab = "new";
let opAllWs = false;
let opWSPath = "";
// 面板里当前选中的 agent。打开面板时回到默认（用户定的形态：默认预选，不记 recents）。
let opAgent = "";

/* ---------------------------------------------------------------------------
   默认 Agent 的解析（2026-10-19，选择面板 + 左栏一键新开共用）
   ---------------------------------------------------------------------------
   三条事实分开：
     · 设置里显式选的（Go 的 settings.defaultAgent，随 panes.list / shell 下来）；
     · 这台机器**已安装且能启动**的（Go 探测，catalog 的 installed + caps.launch）；
     · 自动时的偏好：优先能给出忙/闲的那一层（总览里看得到状态的那些）。
   显式选的如果没装/不能启动，回落到自动 —— 不静默换人，但也不能拿一个
   起不来的 id 去建格。 */
/* 名单完全没送到（ctl 超时 / 老载荷）时的退路。只在**两份来源都空**时用：
   总览的 catalog 和 panes.list 的快照是同一份 Go 探测，两个都空才说明是载荷问题，
   不是“这台机器什么都没装”。 */
const OP_FALLBACK_AGENT = {
  id: "claude", name: "Claude Code", icon: "claudecode-color", installed: true,
  caps: { launch: true, status: true, resume: true, waiting: true, actions: true,
          mechanism: "hook" },
};
let OP_CATALOG_MISSING = false;
function opCatalog() {
  let list = [];
  try {
    // MAGPIE 是 85-dash 里的 let；这个函数只在启动闸之后调用（面板打开/建格），
    // 那时它已经初始化。try 兜住"有人把调用挪到求值期"的情况（TDZ 里 typeof 也会抛）。
    if (MAGPIE && Array.isArray(MAGPIE.catalog)) list = MAGPIE.catalog;
  } catch (_) { list = []; }
  if (!list.length && Array.isArray(BOOT_AGENTS)) list = BOOT_AGENTS;
  if (!Array.isArray(list)) list = [];
  OP_CATALOG_MISSING = !list.length;
  if (OP_CATALOG_MISSING) list = [OP_FALLBACK_AGENT];
  return list;
}
function opLaunchable(a) {
  return !!a && a.installed === true && !!(a.caps && a.caps.launch);
}
function opAgentById(id) {
  return opCatalog().find((a) => a && a.id === id) || null;
}
function opDefaultPinned() {
  return String((SETTINGS && SETTINGS.defaultAgent) || BOOT_DEFAULT_AGENT || "");
}
function defaultAgentId() {
  const cat = opCatalog();
  const want = opDefaultPinned();
  if (want && opLaunchable(cat.find((a) => a && a.id === want))) return want;
  // 自动：先要有状态的（用户能看见它在干什么），再退到第一个可启动的。
  const smart = cat.find((a) => opLaunchable(a) && a.caps && a.caps.status);
  if (smart) return smart.id;
  const any = cat.find(opLaunchable);
  if (any) return any.id;
  // 名单完全没到（老载荷 / 探测失败）：保持旧行为，至少能开一格。
  return "claude";
}
// “新开一格”的完整 spec：默认 agent + DEFAULT_SPAWN_SPEC 的其余部分。
// 单独抽出来是为了让启动兜底（40-chrome）和群组 +（newParallelTab）用**同一份**，
// 而不是两处各自拼一个 agent 字段。
function defaultSpawnSpec() {
  return Object.assign({}, DEFAULT_SPAWN_SPEC, { agent: defaultAgentId() });
}
function opCapsText(a) {
  const c = (a && a.caps) || {};
  const parts = [];
  if (c.status) parts.push("状态");
  if (c.resume) parts.push("续接");
  if (c.actions) parts.push("动作");
  return parts.length ? parts.join(" · ") : "仅启动";
}
function opMechTitle(a) {
  const m = ((a && a.caps && a.caps.mechanism) || "").trim();
  return m && m !== "terminal" ? `状态来源：${m}` : "只启动，没有状态接入";
}
function opAgentIcon(name) {
  // iconHTML 在 85-dash（和总览共用同一套图标规则）。运行期已求值；
  // 万一不可用就留空，不影响行本身。
  return typeof iconHTML === "function" ? iconHTML(name || "", " op-ag-icon") : "";
}

function paintOpAgentSelection() {
  const listEl = $("op-aglist");
  if (listEl) {
    for (const b of listEl.querySelectorAll(".op-agent")) {
      const on = b.dataset.agent === opAgent;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
  }
  // 必须是**可启动**的：catalog 里可能有这一位但没装/不能开（总览里灰着的那类），
  // 不能因为“查得到”就把按钮点亮。
  const a0 = opAgentById(opAgent);
  const a = opLaunchable(a0) ? a0 : null;
  const go = $("op-go");
  if (go) {
    go.textContent = a ? `+ 新开一个 ${a.name}` : "+ 新开一个 agent";
    // 灰而不禁（用户定的规矩：禁用后 title 不弹）：点击时说清楚为什么。
    const na = !a;
    go.classList.toggle("na", na);
    go.setAttribute("aria-disabled", na ? "true" : "false");
    go.title = na ? "没有检测到已安装、能启动的 Agent —— 去总览 → Agent 安装" : "";
  }
  const defBtn = $("op-agdef");
  if (defBtn) {
    const pinned = opDefaultPinned();
    const na = !a || pinned === opAgent;
    defBtn.classList.toggle("na", na);
    defBtn.setAttribute("aria-disabled", na ? "true" : "false");
    defBtn.title = !a ? "先选一个 Agent"
      : pinned === opAgent ? "这一位已经是默认 Agent"
        : `把 ${a.name} 设为新建格子的默认 Agent`;
  }
  const tip = $("op-agtip");
  if (tip) {
    const def0 = opAgentById(defaultAgentId());
    const def = opLaunchable(def0) ? def0 : null;
    tip.textContent = def
      ? `默认：${def.name}${opDefaultPinned() === def.id ? "" : "（自动）"}`
      : "没有可启动的 Agent";
    tip.title = tip.textContent;
  }
}

function renderOpAgents() {
  const listEl = $("op-aglist");
  if (!listEl) return;
  const cat = opCatalog();
  const catalogMissing = OP_CATALOG_MISSING;
  const list0 = cat.filter(opLaunchable);
  const def = defaultAgentId();
  if (!list0.some((a) => a.id === opAgent)) opAgent = def;
  const pinned = opDefaultPinned();
  // 默认项置顶；其余有状态的在前；同组保持目录顺序（sort 稳定）。
  const list = list0.slice().sort((a, b) => {
    const ad = a.id === def ? 0 : 1, bd = b.id === def ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const as = a.caps && a.caps.status ? 0 : 1;
    const bs = b.caps && b.caps.status ? 0 : 1;
    return as - bs;
  });
  if (!list.length) {
    listEl.innerHTML = `<div class="op-agempty">没有检测到已安装、能启动的 Agent。<br>` +
      `去总览 → Agent 安装后再回来。</div>`;
  } else {
    listEl.innerHTML = list.map((a) => {
      const on = a.id === opAgent;
      const isDef = a.id === def;
      return `<button type="button" class="op-agent${on ? " on" : ""}" ` +
        `data-agent="${esc(a.id)}" role="option" aria-selected="${on ? "true" : "false"}" ` +
        `title="${esc(a.name + " · " + opMechTitle(a))}">` +
        `<span class="op-agico">${opAgentIcon(a.icon)}</span>` +
        `<span class="op-agwho"><span class="op-agnm">${esc(a.name)}` +
          (isDef ? `<span class="op-agpill">${pinned === a.id ? "默认" : "自动"}</span>` : "") +
        `</span><span class="op-agsub">${esc(opCapsText(a))}</span></span>` +
        `<span class="op-agck" aria-hidden="true">` +
          `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
          `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
          `<path d="M20 6 9 17l-5-5"/></svg></span>` +
        `</button>`;
    }).join("");
  }
  paintOpAgentSelection();
  if (catalogMissing) {
    const tip = $("op-agtip");
    if (tip) { tip.textContent = "Agent 名单没送到，暂用 Claude Code"; tip.title = tip.textContent; }
  }
}

function selectOpAgent(id) {
  const a = opAgentById(id);
  if (!opLaunchable(a) || opAgent === id) return;
  opAgent = id;
  paintOpAgentSelection();
  sendCtrl({ type: "log", msg: `选择面板 选 Agent=${id}（${a.name}）` });
}

function opSetDefaultAgent() {
  const a = opAgentById(opAgent);
  if (!opLaunchable(a)) {
    sendCtrl({ type: "log", msg: "选择面板 设为默认：没有选中可启动的 Agent，不动" });
    return;
  }
  if (opDefaultPinned() === a.id) {
    sendCtrl({ type: "log", msg: `选择面板 设为默认：${a.id} 已经是默认，不动` });
    return;
  }
  // settingsSend 在 84-settings（运行期已求值）：乐观写缓存 + settings.set；
  // Go 拒绝时会推回旧值（见 05-prefs / 84-settings 的文件头）。
  settingsSend({ defaultAgent: a.id }, `默认 Agent → ${a.id}`);
  renderOpAgents();
  showToast(`默认 Agent 已设为 ${a.name}`, "以后新建的格子默认用它。", "ok");
}

function currentWorkspacePath() {
  const projs = STATE?.projects || [];
  if (!projs.length) return "";
  const t = (activeTab && activeTab.id > 0) ? activeTab
    : (TAB_LIST || []).find((x) => x.id > 0);
  const cwd = t ? effCwd(t) : "";
  if (cwd) {
    let best = null, bestLen = -1;
    for (const p of projs) {
      const n = normPath(p.path).length;
      if (insidePath(cwd, p.path) && n > bestLen) { best = p; bestLen = n; }
    }
    if (best) return best.path;
  }
  return (projs.find((p) => p.synthetic) || projs[0]).path || "";
}

function renderOpWs() {
  const projs = STATE?.projects || [];
  if (opWSPath && projs.length && !projs.some((p) => p.path === opWSPath)) {
    opWSPath = projs[0].path;
  }
  $("op-ws").innerHTML = projs.map((p) =>
    `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
  $("op-ws").value = opWSPath;
  $("op-ws").disabled = opAllWs;
  $("op-newpath").textContent = opWSPath || "（默认工作目录）";
}

function opSessionCount() {
  const all = (STATE?.sessions || []).filter((s) => !s.sidechain);
  return (opAllWs || !opWSPath) ? all.length
    : all.filter((s) => insidePath(s.cwd, opWSPath)).length;
}

function opRowsHTML() {
  const all = (STATE?.sessions || []).filter((s) => !s.sidechain);
  const scope = (opAllWs || !opWSPath) ? all
    : all.filter((s) => insidePath(s.cwd, opWSPath));
  const key = ($("op-search").value || "").trim().toLowerCase();
  const hit = key ? scope.filter((s) =>
    `${sessionTitle(s)} ${s.preview || ""} ${s.slug || ""} ${s.cwd || ""}`
      .toLowerCase().includes(key)) : scope;
  const list = hit.slice().sort((a, b) =>
    (Date.parse(b.updated || "") || 0) - (Date.parse(a.updated || "") || 0));
  if (!list.length) {
    return `<div class="op-empty">${key ? "没找到匹配的会话"
      : opAllWs ? "还没有历史会话" : "这个工作区里还没有历史会话"}</div>`;
  }
  return list.map((s) => {
    const why = resumeWhy(s);
    const live = why ? null : tabForSession(s.id);
    const tag = live ? `<span class="op-tag">在第 ${live.id} 格</span>` : "";
    const turn = s.turns ? `${s.turns} 轮` : "没存下往来";
    return `<button class="op-row${why ? " na" : ""}" data-sid="${esc(s.id)}"
      title="${esc(why || sessionTitle(s))}">
      <div class="op-row1"><span class="op-rowtitle">${esc(sessionTitle(s))}</span>${tag}</div>
      <div class="op-row2"><span>${esc(rel(s.updated))}</span><span>·</span><span>${esc(turn)}</span>${
        opAllWs && s.cwd ? `<span>·</span><span class="dir">${esc(shortPath(s.cwd))}</span>` : ""}</div>
    </button>`;
  }).join("");
}

function renderOpPanel() {
  document.querySelectorAll("#openpanel .op-tab").forEach((b) => {
    const on = b.dataset.optab === opTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  const resume = opTab === "resume";
  $("op-new").classList.toggle("hide", resume);
  $("op-resume").classList.toggle("hide", !resume);
  const allBtn = $("op-all");
  allBtn.hidden = !resume;
  allBtn.classList.toggle("on", opAllWs);
  renderOpWs();
  if (resume) $("op-list").innerHTML = opRowsHTML();
  else renderOpAgents();
}

function closeAgentPanel(why) {
  const panel = $("openpanel");
  if (!panel || !panel.classList.contains("on")) return;
  panel.classList.remove("on");
  if (why) sendCtrl({ type: "log", msg: `选择面板 关闭（${why}）` });
}

function openAgentPanel(why) {
  const panel = $("openpanel");
  if (panel.classList.contains("on")) { closeAgentPanel("再点一次 +"); return; }
  opTab = "new";
  opAllWs = false;
  opWSPath = currentWorkspacePath();
  // 默认预选（用户定的形态）：每次打开都回到默认，不记上一次选过谁。
  opAgent = defaultAgentId();
  $("op-search").value = "";
  renderOpPanel();
  // 先填内容再显示再量：显示前量到的是上一帧的尺寸，面板会先闪在错的位置
  // （showMenuAt 那条注释里记过同样的坑）。
  panel.classList.add("on");
  const r = panel.getBoundingClientRect();
  const a = $("tab-add").getBoundingClientRect();
  let left = a.left - 8;
  left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
  let top = a.bottom + 8;
  if (top + r.height > window.innerHeight - 6) top = Math.max(6, a.top - r.height - 8);
  panel.style.left = Math.round(left) + "px";
  panel.style.top = Math.round(top) + "px";
  sendCtrl({ type: "log", msg: `选择面板 打开（${why || ""}）` +
    ` 锚=${Math.round(a.left)},${Math.round(a.bottom)} ` +
    `落=${Math.round(left)},${Math.round(top)} ${Math.round(r.width)}x${Math.round(r.height)} ` +
    `页签=${opTab} 工作区=${opWSPath || "(默认)"} 历史=${opSessionCount()} 条 ` +
    `Agent=${opAgent || "(无)"}（设置默认=${opDefaultPinned() || "自动"}）` });
}

async function opNewAgent() {
  const a = opAgentById(opAgent);
  if (!opLaunchable(a)) {
    showToast("先选一个 Agent", "没有检测到已安装、能启动的 Agent。去总览 → Agent 安装。", "err");
    sendCtrl({ type: "log", msg:
      `选择面板 新会话：没有可启动的 Agent（opAgent=${opAgent || "空"}），不发建格` });
    return;
  }
  const dir = opWSPath;
  closeAgentPanel("新会话");
  sendCtrl({ type: "log", msg: `选择面板 新会话 agent=${a.id} cwd=${dir || "(默认)"}` });
  await newTabIn(dir, "选择面板 新会话", a.id);
}

async function opPick(s) {
  if (!s) return;
  const why = resumeWhy(s);
  if (why) {
    showToast("接不上这条会话", why, "err");
    sendCtrl({ type: "log", msg: `选择面板 接不上会话 id=${s.id}（${why}）` });
    return;
  }
  const live = tabForSession(s.id);
  closeAgentPanel(live ? "接着那一格" : "接上会话");
  if (live) {
    jumpToTab(live, "选择面板里已经在跑");
    showToast("它已经开着了", `在第 ${live.id} 格，已经跳过去。`, "ok");
    sendCtrl({ type: "log", msg: `选择面板 会话已在跑 id=${s.id} → 跳到 tab=${live.id}` });
    return;
  }
  sendCtrl({ type: "log", msg: `选择面板 接上会话 id=${s.id} ` +
    `（范围=${opAllWs ? "全部工作区" : (opWSPath || "默认")}）` });
  await connectSession(s, "exact");
}

$("tab-add").addEventListener("click", () => openAgentPanel("点标签条 +"));
$("op-x").addEventListener("click", () => closeAgentPanel("点了 ×"));
document.querySelectorAll("#openpanel .op-tab").forEach((b) => {
  b.addEventListener("click", () => {
    if (opTab === b.dataset.optab) return;
    opTab = b.dataset.optab;
    renderOpPanel();
    if (opTab === "resume") $("op-search").focus();
    sendCtrl({ type: "log", msg: `选择面板 页签=${opTab} 历史=${opSessionCount()} 条` });
  });
});
$("op-ws").addEventListener("change", () => {
  opWSPath = $("op-ws").value;
  renderOpPanel();
  sendCtrl({ type: "log", msg: `选择面板 工作区=${opWSPath} 历史=${opSessionCount()} 条` });
});
$("op-all").addEventListener("click", () => {
  opAllWs = !opAllWs;
  renderOpPanel();
  sendCtrl({ type: "log", msg: `选择面板 全部工作区=${opAllWs} 历史=${opSessionCount()} 条` });
});
$("op-search").addEventListener("input", () => { $("op-list").innerHTML = opRowsHTML(); });
$("op-aglist").addEventListener("click", (e) => {
  const row = e.target.closest(".op-agent");
  if (row) selectOpAgent(row.dataset.agent);
});
// 方向键在名单里走（行是按钮，Tab 也能到；方向键只是更快）。
$("op-aglist").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const rows = [...$("op-aglist").querySelectorAll(".op-agent")];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement);
  const n = e.key === "ArrowDown"
    ? Math.min(rows.length - 1, i + 1)
    : Math.max(0, i - 1);
  const row = rows[n];
  if (!row) return;
  selectOpAgent(row.dataset.agent);
  row.focus();
});
$("op-agdef").addEventListener("click", () => { opSetDefaultAgent(); });
$("op-go").addEventListener("click", () => { opNewAgent(); });
$("op-list").addEventListener("click", (e) => {
  const row = e.target.closest(".op-row");
  if (row) opPick(findSess(row.dataset.sid));
});

// C7（2026-10-16）：这里原来是「原生对比」的监听 ——
//   $("wt").addEventListener("click", () => activeTab.ctrl({ type: "open-wt" }))
// 那颗按钮删了（去向见 HTML 标签条右侧那段注释），监听跟着删。
// ⚠️ Go 那条腿**留着**（ctl 的 "open-wt" → main.go 的 openInWindowsTerminal），
// 要接回来只需要在格子头的 ⋯ 里加一项、发同一个 ctl。

// 说明：曾经这里有 overflowProbe（找"主区左边一条被裁掉的竖排字符"）。
// 结论是那些像素属于 **DWM 的不可见缩放宽边框**，是桌面透过窗口边缘露出来的，
// 不是我们的 DOM —— 用 PrintWindow 抓窗口自身内容时那条就消失了。
// 探针随之删除（只抓窗口自身内容时那条就消失了）。

// ---------------------------------------------------------------------------
// 「开场介绍框被画了几次」探针
//
// 用户报的现象：**往上滚的时候能看到两个吉祥物**。
// 首屏看不出来（第二个被顶进回滚缓冲了），所以必须直接数缓冲里的行 ——
// 这正是"截图看不见但确实存在"的那类问题。
//
// 判据用 "API Usage Billing"：它是介绍框里最有辨识度、又不会出现在别处的字符串。
//
// 出现 2 次有两个已知成因，都要防：
//   - CLI 真的把开场界面画了两遍 —— 多发了一次 resize（见 pushSize 的去重）；
//   - 字节流被破坏，同一段内容在屏幕上出现两次 —— Wails 的 Send 是**排队不拷贝**，
//     而读循环复用了 buf（见 main.go 里那段说明）。这个是 2026-10-15 找到的真因。
function countBanners(tag, t) {
  t = t || activeTab;
  if (!t) return;
  const b = t.term.buffer.active;
  let hits = 0;
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line && line.translateToString(true).includes("API Usage Billing")) hits++;
  }
  sendCtrl({
    type: "log",
    msg: `介绍框检查[${tag}]: 回滚缓冲共 ${b.length} 行，开场介绍框出现 ${hits} 次（应为 1）`,
  });
}
setTimeout(() => countBanners("9s", activeTab), 9000);

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
// 自下而上找输入框（转录在上、输入框在它下面，所以最低的那个才是）。
// 找不到就返回 null —— 此时**不干预**，维持 xterm 自己的行为，不比现在差。
function ccImeAnchor(buf, term) {
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buf.getLine(buf.baseY + row);
    if (!line) continue;
    const start = ccImeInputStartColumn(line, term.cols);
    if (start === null) continue;
    const rest = line.translateToString(true, start, term.cols);
    if (!rest.trim()) return { row, column: Math.min(start, term.cols - 1) };
    const end = ccImeLineEndColumn(line, start, term.cols);
    return { row, column: Math.min(end ?? start, term.cols - 1) };
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
      put(compView, "top", top);
      put(compView, "left", `${rawLeft}px`);
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

// ---------------------------------------------------------------------------
// 已删除的探针（2026-10-15 收尾，结论都记在这儿，别重新发明一遍）
//
// 1) 逐格 dump（cellRuns / dumpCells）
//    用来把「吉祥物形状不对」定位到**列**。当时看到的是「头」在列 4..10、
//    「肩」在列 0..8、列 1 多一个孤立的 `▐`，据此误判成「两帧叠加」。
//    真因不在这儿 —— 见 3）。
//
// 2) 宽度探针（probeWidths）
//    怀疑方块元素 U+2580–259F（East Asian Width = Ambiguous）被当 2 格。
//    **实测全是 1 格**（`中`=2），假设推翻。xterm 的 unicode11 也没改这些。
//
// 3) 隔离复现（replayTest）—— 这个才是分水岭，值得记住方法
//    把 CLI 行 0 的原始字节喂给一个**全新的、干净的** xterm 实例：
//      <ESC>[38;2;215;119;87m␣▐  <ESC>[48;2;0;0;0m▛███▛█  <ESC>[m<ESC>[1m<ESC>[3C Claude
//    干净实例落格**完全正确**（列 1..7 是 `▐▛███▛█`，`Claude` 在列 11），
//    而实时实例同一串字节每次跑出来的位置都不一样 —— 于是判定：
//    **不是解析问题，是字节在到达 xterm 之前就被改了。**
//    顺着这条线找到 Go 读循环把复用的 buf 交给 Wails 的 Send（排队不拷贝），
//    下一次 Read 就地覆盖 —— 全部解释得通。
//
// 探针本身删掉了；保留这个**方法**：题面看不清时，用同一份输入喂一个干净实例，
// 就能把「库的问题」和「我们的问题」一刀切开。
//
// 4) IME 候选框探针（imeProbe，2026-10-15 修"候选框不跟光标"时用的）
//    在 compositionstart / compositionupdate 上回传：textarea 的屏幕矩形、
//    「按 buffer 光标算它本该在哪」、`.xterm-helpers` 的 computed left、
//    光标行文本、提示符所在行列。三条结论（都写进 ccIme* 的注释了）：
//      a. `.xterm-helpers` 的 computed left **恒为 0px** —— Orca 那条
//         `.xterm-helpers{left:0}` 的 CSS 修法在我们这儿**不适用**（它的注释
//         针对的是 Electron/Blink 下 `left:auto` 会解析成非 0）。别照抄。
//      b. Claude Code **从不把终端光标放进输入框**：它把光标留在自己画的状态行
//         末尾（实测 (75,8)，那行是 "  ⏵⏵ auto mode on … ● high · /effort"），
//         而输入框在 (0,6)。这才是候选框偏 584px 的真因。
//      c. 输入框提示符 `❯` 后面那一格是 **U+00A0 不换行空格（code 160）**，
//         不是普通空格。只认 `getChars() === " "` 会**静默失效**。
//    另外：Win11 的候选框由 TextInputHost.exe 合成，**不是顶层窗口** ——
//    枚举窗口 diff 抓不到它，只能全屏截图看像素。
//
// 5) 追"候选框跳到屏幕右上角"时的两个探针（2026-10-15）
//    a. imeScreenProbe：在 compositionstart/end 上回传 window.screenX/screenY、
//       `.xterm-screen` 与 textarea 的 rect、**textarea 的屏幕绝对坐标**、
//       ccImeAnchor 的结果、document.activeElement。
//    b. installFocusProbe：focusin/focusout（捕获相）上报 activeElement + relatedTarget。
//       加它的理由值得记：**如果 composition 压根没发生在我们元素上**，a 会一条都不打，
//       于是"没有日志"就同时可能是"没复现" —— 焦点探针把这个歧义消掉。
//    结论（三组 A/B，同一串合成输入）：
//      - 焦点在终端 textarea → 候选框贴输入行下方（候选框 y≈232 / 输入行 y≈202）✓
//      - 焦点在侧栏卡片 `<button class="card">` → 屏幕上**没有任何候选框**
//      - 焦点在 BODY（点了侧栏非按钮处）→ 同上，一个都没有
//    ⇒ **输入法只在"有可编辑焦点"时才组字。** 所以"候选框跑到屏幕角落"和
//      "根本没有候选框"是两种不同状态，别把后者当后者去修。用户报的"右上角"
//      这一幕**没能复现**，也给不出站得住的机制 —— 别为它发明解释。
//    副产品（真 bug，已修）：点侧栏卡片会把焦点从终端拿走，之后敲中文一个键都进不来。
//      修法见下面 .card/.nav 那段 mousedown preventDefault。
//    开发期用的两种工具：全屏 GDI 抓帧、逐帧差分哨兵。
//    哨兵值得记：候选框不是顶层窗口，枚举窗口 diff 抓不到它；差分哨兵 = 全屏抓帧 +
//    只统计"目标窗口矩形之外"的变化像素，命中就存整屏帧，**不用跟人约时间**。
//    这次它证明了一件事：用户那次敲字全程 0 命中 ⇒ 候选框一次都没出过应用窗口。
//    校准值（实测出来的，复用时直接用）：watchXmin=应用左边界（左边的窗口动画每帧
//    400~600 像素，纯噪音）、minCount=1500（相邻帧动画）～4000（长时间挂机）。

