/* Bot Group —— 一个目标下的 Bot 团队工作台（顶层模式之一，见 60-shell.js 的 MODE_ITEMS）。
   形态参照用户给的参考视频：左 = Bot Group / Bot 列表；中上 = 每条车道的交接链；
   中 = 过程流（聚焦一条车道 / 全部车道）；右 = 工作树 · 泳道 + 图例。
   页面重点是「谁在做什么、谁交给了谁、哪里需要人」，终端只是次要入口。

   阶段 B（2026-10-28，数据与创建）：
     · 数据来自 Go（internal/botgroup）：botgroups 推送 = 全部组 + 每组最近的过程流；
       botgroup.event 推送 = 新的一条。事件 id 在组内单调递增，前端按 id 追加。
     · Bot 是**真实的 agent 格**（spec.group / spec.bot），挂在 #bg-dock 里（不进
       Workspaces 的网格/列表/页签，见 10-term 的 wsTabs）。坞平时 visibility:hidden
       但有尺寸 —— PTY 的启动闸是首帧尺寸（见 pty-starts-only-when-the-pane-has-a-size）。
     · 终端从页面右侧滑出（抽屉）；关抽屉不关格子。
     · 两个入口：从一个 Agent 衍生（原 Agent 直接当 Manager，格子搬进坞里）/ 独立新建。
     · 状态跃迁（开始干活 / 等你 / 空闲 / 停了）由 renderAgentDot → botStateChanged 记进过程流。
   交互参照 Grok Bot（用户 2026-10-28 定的，笔记在 _ref\grokbot\NOTES.md）：
     · **在群里直接聊**：中间是群聊。不 @ 的消息交给 Manager；@某个 Bot 交给它；@全员 发给所有人。
     · **也能单聊**：左栏点某个成员 = 切到和它的 1:1（它自己的完整对话），输入框直接发给它。
     · 送达 = 把这句话写进那一格的终端并回车（空闲才送，忙着就排队；没起来就先起）。
       从群里发出的那一轮，回复收尾后贴回群里；单聊的留在单聊。
     · 「等你」（批权限 / 提问）在群里和单聊里都能直接点 —— 复用 Workspaces 群组看板那套卡片与闸。
     · 终端退为次要：抽屉里旁观 / 接管。
   Bot 之间互相交接、Manager 自动调度是阶段 C：对应的按钮先做灰（不做禁、不做隐）。 */

/* ---------- 车道色 ----------
   色只用来区分车道（身份），不表达状态 —— 状态有自己的符号和点。
   固定顺序分配、绕开状态色（绿 = 在干、橙 = 等你、红 = 失败）。 */
const BG_LANE_PALETTE = ["#3b82f6", "#a855f7", "#14b8a6", "#ec4899", "#eab308", "#6366f1"];
const BG_MANAGER_COLOR = "#a1a1aa";
const BG_MAX_BOTS = BG_LANE_PALETTE.length;

/* ---------- 数据（Go 推来的） ---------- */
let BOTGROUPS = [];
const BG_EVENTS = new Map();   // gid → [event]（id 升序）
let BG_LOADED = false;

const BG = {
  group: (() => { try { return localStorage.getItem("perch.bg.group") || ""; } catch (_) { return ""; } })(),
  focus: "all",          // "all" | bot id
  open: new Set(),       // 展开的事件行（gid:id）
  dock: null,            // 抽屉里正开着的那一格
};

function bgGroup() { return BOTGROUPS.find((g) => g.id === BG.group) || BOTGROUPS[0] || null; }
function bgBot(g, id) { return g ? (g.bots || []).find((b) => b.id === id) || null : null; }
function bgLanes(g) { return g ? (g.bots || []).filter((b) => !b.manager) : []; }
function bgManager(g) { return g ? (g.bots || []).find((b) => b.manager) || null : null; }
function bgColor(g, id) {
  if (!id || id === "manager") return BG_MANAGER_COLOR;
  const i = bgLanes(g).findIndex((b) => b.id === id);
  return BG_LANE_PALETTE[(i < 0 ? 0 : i) % BG_LANE_PALETTE.length];
}
function bgAgentName(id) {
  const a = typeof opAgentById === "function" ? opAgentById(id) : null;
  return (a && a.name) || id || "Agent";
}
function bgAgentIco(id) { return agentTabIcon(id || "", 14); }
function bgEvents(g) { return (g && BG_EVENTS.get(g.id)) || []; }
function bgRoleName(g, id) {
  if (!id || id === "manager") return "Manager";
  const b = bgBot(g, id);
  return b ? b.role : id;
}

/* ---------- Bot ↔ 格子 ---------- */
function bgTabOf(bot) {
  if (!bot || !bot.paneId) return null;
  return TAB_LIST.find((x) => (x.paneID | 0) === bot.paneId) || null;
}
/* 车道状态 = 那一格的状态（cellState，和 Workspaces 同一套判据）折成五种。
   pending = 还没起过格子；off = 起过、现在不在跑（进程退了 / 被关掉）。 */
function bgBotState(bot) {
  const tab = bgTabOf(bot);
  if (!tab) return bot && bot.paneId ? "off" : "pending";
  const s = cellState(tab);
  if (s === "working") return "working";
  if (s === "ask") return "waiting";
  if (s === "failed") return "failed";
  if (s === "off") return "off";
  return "idle";
}
const BG_STATE_KEY = {
  working: "bg.state.working", waiting: "bg.state.waiting", idle: "bg.state.idle",
  off: "bg.state.off", pending: "bg.state.pending", failed: "bg.state.failed",
};

/* ---------- Go 推送 ---------- */
function applyBotGroups(m) {
  BOTGROUPS = Array.isArray(m.groups) ? m.groups : [];
  BG_EVENTS.clear();
  const ev = m.events || {};
  for (const g of BOTGROUPS) BG_EVENTS.set(g.id, Array.isArray(ev[g.id]) ? ev[g.id] : []);
  BG_LOADED = true;
  if (!BOTGROUPS.some((g) => g.id === BG.group)) {
    BG.group = BOTGROUPS.length ? BOTGROUPS[0].id : "";
    BG.focus = "all";
  }
  bgSyncTabs("botgroups 推送");
  // 单聊页要每个 Bot 的完整对话：页面刚加载时只有当前格补过快照，Bot 格一格都没有。
  if (typeof askAllSnapshots === "function") askAllSnapshots("Bot Group");
  bgSchedule();
}
function applyBotGroupEvent(m) {
  const list = BG_EVENTS.get(m.group);
  if (!list || !m.event) return;
  const last = list.length ? list[list.length - 1].id : 0;
  if (m.event.id <= last) return;   // 按 id 追加：重复/乱序的那条不再画一遍
  list.push(m.event);
  if (list.length > 600) list.splice(0, list.length - 400);
  bgSchedule(true);
}
const BG_PENDING = new Map();   // req → resolve
let BG_REQ = 0;
function bgRequest(msg) {
  const req = ++BG_REQ;
  return new Promise((resolve) => {
    BG_PENDING.set(req, resolve);
    sendCtrl(Object.assign({ req }, msg));
    setTimeout(() => {
      if (BG_PENDING.has(req)) { BG_PENDING.delete(req); resolve({ ok: false, err: t("bg.err.timeout") }); }
    }, 8000);
  });
}
function botGroupResult(m) {
  const r = BG_PENDING.get(m.req);
  if (!r) return;
  BG_PENDING.delete(m.req);
  r(m);
}

/* 格子和组对齐：组里登记了 paneId、但格子还挂在 Workspaces 的（衍生出来的 Manager）
   搬进坞里；格子说自己属于一个已经不存在的组的（组被删了），放回 Workspaces。 */
function bgSyncTabs(why) {
  if (!BG_LOADED) return;
  const want = new Map();
  for (const g of BOTGROUPS) for (const b of g.bots || []) if (b.paneId) want.set(b.paneId, [g.id, b.id]);
  for (const tab of TAB_LIST.slice()) {
    const w = want.get(tab.paneID | 0);
    if (w && (tab.group !== w[0] || tab.bot !== w[1])) bgAdoptTab(tab, w[0], w[1], why);
    else if (!w && tab.group && tab.paneID) bgReleaseTab(tab, why);
  }
}
function bgAdoptTab(tab, gid, bot, why) {
  tab.group = gid; tab.bot = bot;
  if (tab.spec) { tab.spec.group = gid; tab.spec.bot = bot; }
  if (tab.host && tab.host.id === "termhost") tab.host.removeAttribute("id");
  if (typeof soloTab !== "undefined" && soloTab === tab) soloTab = null;
  if (typeof removePageEl === "function") removePageEl(tab);
  botDockBody().appendChild(tab.cellEl);
  tab.cellEl.classList.remove("cur");
  if (activeTab === tab) {
    activeTab = null; term = null;
    setActive(wsTabs()[0] || null);
  }
  if (typeof renderPageTabs === "function") renderPageTabs();
  renderGrid();
  armRailRebuild();
  sendCtrl({ type: "log", msg: `Bot Group：格子 tab=${tab.id} pane=${tab.paneID} 搬进坞（${gid}/${bot}，${why || ""}）` });
}
function bgReleaseTab(tab, why) {
  if (BG.dock === tab) bgCloseDock();
  tab.group = ""; tab.bot = ""; tab.botLast = undefined;
  if (tab.spec) { tab.spec.group = ""; tab.spec.bot = ""; }
  tab.cellEl.classList.remove("bot-on");
  $("termbody").appendChild(tab.cellEl);
  renderGrid();
  armRailRebuild();
  if (!activeTab) setActive(tab);
  sendCtrl({ type: "log", msg: `Bot Group：格子 tab=${tab.id} pane=${tab.paneID} 回到 Workspaces（${why || ""}）` });
}

/* ---------- 状态跃迁 ----------
   renderAgentDot 每 400–700ms 就可能叫一次，这里只在**折过之后的状态**变了才重画。
   生命周期（开始干活 / 空闲 / 停了）**不再落进过程流**：定稿的过程流和工作树画的是工作，
   这些只体现在成员行的状态点、车道页签和「正在处理」那一行上。 */
const BG_EV_OF = { working: "working", ask: "waiting", idle: "idle", unread: "idle", off: "stopped", failed: "fail" };
function botStateChanged(tab, s) {
  const k = BG_EV_OF[s] || "idle";
  if (!tab.bgBorn) tab.bgBorn = Date.now();
  if (!tab.bgCfg && typeof bgdNoteLaunch === "function") {
    const g = BOTGROUPS.find((x) => x.id === tab.group);
    const b = bgBot(g, tab.bot);
    if (g && b) bgdNoteLaunch(tab, g, b);
  }
  if (tab.botShown === k) return;
  tab.botShown = k;
  bgSchedule();
}

/* ---------- 抽屉（Bot 的终端） ---------- */
function botOpenTerminal(tab) {
  if (!tab || !tab.cellEl) return;
  if (SETTINGS.topMode !== "botgroup" && typeof topModePick === "function") topModePick("botgroup");
  else if (typeof NAV_HERE !== "undefined" && NAV_HERE !== "workspace" && typeof setNavView === "function") setNavView("workspace");
  for (const x of TAB_LIST) if (x.cellEl && x.group) x.cellEl.classList.toggle("bot-on", x === tab);
  BG.dock = tab;
  const g = BOTGROUPS.find((x) => x.id === tab.group);
  if (g && BG.group !== g.id) { BG.group = g.id; BG.focus = "all"; }
  $("bg-dock").classList.add("open");
  bgDockHead();
  if (typeof ackNote === "function") ackNote(tab, "打开 Bot 终端");
  requestAnimationFrame(() => { tab.refit(); tab.focus(); });
  bgSchedule();
  sendCtrl({ type: "log", msg: `Bot Group：打开终端 tab=${tab.id} pane=${tab.paneID} ${tab.group}/${tab.bot}` });
}
function bgCloseDock() {
  const dock = $("bg-dock");
  if (dock) dock.classList.remove("open");
  BG.dock = null;
  bgSchedule();
}
function bgDockHead() {
  const head = $("bg-dock-head");
  const tab = BG.dock;
  if (!head || !tab) return;
  const g = BOTGROUPS.find((x) => x.id === tab.group);
  const bot = bgBot(g, tab.bot);
  const st = bot ? bgBotState(bot) : "idle";
  const agent = (tab.spec && tab.spec.agent) || (bot && bot.agent) || "";
  head.style.setProperty("--lane", bgColor(g, tab.bot));
  head.innerHTML =
    `<span class="bgd-lane"><i></i>${esc(bgRoleName(g, tab.bot))}</span>` +
    `<span class="bgd-agent">${bgAgentIco(agent)}<span class="ell">${esc(bgAgentName(agent))}</span></span>` +
    `<span class="bgd-st" data-state="${esc(st)}">${bgDot(st)}${esc(t(BG_STATE_KEY[st]))}</span>` +
    `<span class="bgd-cwd mono ell" title="${esc(effCwd(tab))}">${esc(effCwd(tab))}</span>` +
    (tab.connDown ? `<button type="button" class="bg-btn" data-bgd="resume">${esc(t("bg.dock.resume"))}</button>` : "") +
    `<button type="button" class="icon-btn" data-bgd="close" title="${esc(t("bg.dock.close"))}" aria-label="${esc(t("bg.dock.close"))}">` +
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;
}

/* 起 / 接上一个 Bot 的格子。三种情况：
     · 格子在、在跑 → 打开抽屉；
     · 格子在、停了 → 原座位接上（resumeAgentInSeat，带着组身份）；
     · 没有格子 → 按登记的 paneId 认领旧记录（盘上有会话就 exact 接上），否则新起一格。 */
async function bgStartBot(g, bot, why) {
  if (!g || !bot) return null;
  const tab = bgTabOf(bot);
  if (tab && !tab.connDown) { botOpenTerminal(tab); return tab; }
  if (tab && tab.connDown) { await resumeAgentInSeat(tab); const nt = bgTabOf(bot); if (nt) botOpenTerminal(nt); return nt; }
  const rec = bot.paneId && typeof RESTORE !== "undefined"
    ? (RESTORE.panes || []).find((p) => (p.paneId | 0) === bot.paneId) : null;
  const sid = rec && rec.sessionId && rec.onDisk ? rec.sessionId : "";
  const spec = {
    agent: bot.agent || (rec && rec.agent) || defaultAgentId(),
    cwd: bot.folder || g.project,
    target: sid ? "legacy" : "directory",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    paneId: bot.paneId || undefined,
    group: g.id, bot: bot.id,
  };
  sendCtrl({ type: "log", msg: `Bot Group：起格 ${g.id}/${bot.id} agent=${spec.agent} pane=${bot.paneId || 0} resume=${spec.resume.kind}（${why || ""}）` });
  const nt = await createTab(spec);
  if (nt && TAB_LIST.includes(nt) && typeof bgdLaunchCfg === "function") nt.bgCfg = bgdLaunchCfg(g, bot);
  if (!nt || !TAB_LIST.includes(nt)) {
    const r = nt && nt.resumeRefused;
    showToast(t("bg.toast.startFailed", { role: bot.role }), (r && r.msg) || t("bg.toast.startFailedNote"), "err");
    return null;
  }
  return nt;
}

/* ---------- 图标 ---------- */
const BG_I = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  term: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  play: '<path d="M6 4.5v15l13-7.5z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
};
function bgIco(name, size) { return lucide(BG_I[name], size || 14); }

/* 事件符号：和右栏图例同一套。圆 = 提交，菱形 = 交接，方块 = 产物，
   双圈 = 检查点/审查，橙圈 = 等你，红叉 = 失败，绿勾 = 测试通过；
   阶段 B 的生命周期：三角 = 上线，半圆 = 开始干活，空心圈 = 空闲，小方块 = 停了。 */
function bgGlyph(kind, color) {
  const c = color || "currentColor";
  switch (kind) {
    case "commit": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="${c}"/></svg>`;
    case "handoff": return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="${c}"/></svg>`;
    case "created": return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="none" stroke="${c}" stroke-width="1.4"/></svg>`;
    case "artifact": return `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "memory": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="6" cy="6" r="1.4" fill="${c}"/></svg>`;
    case "review":
    case "test": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--bg-ok)"/><path d="m3.6 6.1 1.6 1.6 3.2-3.3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "fail": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--bg-bad)"/><path d="m4.2 4.2 3.6 3.6M7.8 4.2 4.2 7.8" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    case "retry": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--bg-bad)" stroke-width="1.4"/><path d="M6 3.6v2.6l1.6 1" fill="none" stroke="var(--bg-bad)" stroke-width="1.2" stroke-linecap="round"/></svg>`;
    case "approval":
    case "waiting": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--bg-ask)" stroke-width="1.8"/></svg>`;
    case "running": return `<svg class="bg-spin" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/><path d="M6 1.6a4.4 4.4 0 0 1 4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    case "wait": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/></svg>`;
    case "started": return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3.5 2.2v7.6L10 6Z" fill="${c}"/></svg>`;
    case "working": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="none" stroke="${c}" stroke-width="1.3"/><path d="M6 1.8a4.2 4.2 0 0 1 0 8.4Z" fill="${c}"/></svg>`;
    case "idle": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.6" fill="none" stroke="var(--bg-faint)" stroke-width="1.3"/></svg>`;
    case "fork": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="4" cy="3" r="1.6" fill="none" stroke="${c}" stroke-width="1.3"/><circle cx="4" cy="9.4" r="1.6" fill="none" stroke="${c}" stroke-width="1.3"/><circle cx="9" cy="5" r="1.6" fill="none" stroke="${c}" stroke-width="1.3"/><path d="M4 4.6v3.2M9 6.6c0 1.6-1.4 2.2-3.4 2.6" fill="none" stroke="${c}" stroke-width="1.3"/></svg>`;
    case "compact": return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2 6 4.6 9.5 2M2.5 10 6 7.4 9.5 10" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "stopped": return `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx="1" fill="var(--bg-faint)"/></svg>`;
    default: return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="2" fill="${c}"/></svg>`;
  }
}

function bgDot(state) { return `<span class="bg-dot" data-state="${esc(state)}"></span>`; }
function bgBadge(g, id) {
  return `<span class="bg-badge" style="--lane:${bgColor(g, id)}">${esc(bgRoleName(g, id))}</span>`;
}
function bgTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function bgAgo(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return t("bg.ago.now");
  if (s < 3600) return t("bg.ago.min", { n: Math.floor(s / 60) });
  if (s < 86400) return t("bg.ago.hour", { n: Math.floor(s / 3600) });
  return t("bg.ago.day", { n: Math.floor(s / 86400) });
}
/* 事件的显示标题：生命周期类按当前语言现拼（盘上只存 kind），其余用记下的标题。 */
function bgEvTitle(g, e) {
  const who = bgRoleName(g, e.bot);
  switch (e.kind) {
    case "created":
      return g.source && g.source.kind === "derived"
        ? t("bg.ev.derived", { name: g.name, from: g.source.title || bgAgentName(g.source.agent) })
        : t("bg.ev.created", { name: g.name });
    case "started": {
      const b = bgBot(g, e.bot);
      return t("bg.ev.started", { who, agent: bgAgentName(b && b.agent) });
    }
    case "working": case "waiting": case "idle": case "stopped":
      return t("bg.ev." + e.kind, { who });
    case "fail": return e.title || t("bg.ev.fail", { who });
    default: return e.title || e.kind;
  }
}
function bgEvLane(e) { return e.bot || "manager"; }

/* ---------- 左栏：Bot Group 列表 ---------- */
function bgRowHTML(g, b, on) {
  const st = bgBotState(b);
  const docked = BG.dock && bgTabOf(b) === BG.dock;
  const task = bgTaskOf(g, b) || t(BG_STATE_KEY[st]);
  return `<div class="bg-row${b.manager ? " bg-mgr" : ""}${docked ? " docked" : ""}" data-bg-group="${esc(g.id)}" data-bg-focus="${esc(b.id)}" style="--lane:${bgColor(g, b.id)}">`
    + `<span class="bg-ri">${bgAgentIco(b.agent)}</span>`
    + `<span class="bg-rmain"><span class="bg-rt ell"><b>${esc(b.manager ? "Manager" : b.role)}</b> · ${esc(task)}</span>`
    + `<span class="bg-rs ell">${esc(bgAgentName(b.agent))} · ${esc(bgModelShort(bgDerive(g, b).model) || bgWhere(g, b))}</span></span>`
    + `<button type="button" class="bg-rterm" data-bg-cfg="${esc(b.id)}" data-bg-group="${esc(g.id)}" title="${esc(t("bg.d.openTitle", { name: b.manager ? "Manager" : b.role }))}">${bgIco("sliders", 12)}</button>`
    + `${bgDot(st)}</div>`;
}
function bgListHTML() {
  const q = (BG.query || "").trim().toLowerCase();
  const hit = (g) => !q || [g.name, g.goal, ...(g.bots || []).map((b) => b.role + " " + bgAgentName(b.agent))]
    .some((s) => String(s || "").toLowerCase().includes(q));
  const shown = BOTGROUPS.filter(hit);
  const groups = shown.map((g) => {
    const on = g.id === (bgGroup() || {}).id;
    const lanes = bgLanes(g);
    const active = lanes.filter((b) => { const s = bgBotState(b); return s === "working" || s === "waiting"; }).length;
    const src = g.source && g.source.kind === "derived"
      ? `<span class="bg-src" title="${esc(t("bg.list.derivedFrom"))} ${esc(g.source.title || "")}">${bgAgentIco(g.source.agent)}<span class="ell">${esc(g.source.title || bgAgentName(g.source.agent))}</span></span>`
      : `<span class="bg-src">${esc(t("bg.list.standalone"))}</span>`;
    const mgr = bgManager(g);
    return `<section class="bg-grp${on ? " on" : ""}">`
      + `<div class="bg-gh" data-bg-group="${esc(g.id)}"><span class="bg-gn ell">${esc(g.name)}</span>`
      + `<button type="button" class="bg-gmore" data-bg-gmenu="${esc(g.id)}" title="${esc(t("bg.list.more"))}" aria-label="${esc(t("bg.list.more"))}">${bgIco("dots", 13)}</button>`
      + `<span class="bg-gc">${active}/${lanes.length}</span></div>`
      + `<div class="bg-gsrc">${src}</div>`
      + (mgr ? bgRowHTML(g, mgr, on) : "") + lanes.map((b) => bgRowHTML(g, b, on)).join("")
      + `</section>`;
  }).join("");
  let working = 0, waiting = 0;
  for (const g of BOTGROUPS) for (const b of g.bots || []) {
    const s = bgBotState(b);
    if (s === "working") working++;
    else if (s === "waiting") waiting++;
  }
  const empty = !BOTGROUPS.length
    ? `<div class="bg-empty sm bg-lempty">${esc(t(BG_LOADED ? "bg.list.none" : "bg.list.loading"))}</div>`
    : (!shown.length ? `<div class="bg-empty sm bg-lempty">${esc(t("bg.list.noMatch"))}</div>` : "");
  return `<div class="bg-lhead"><h1>${esc(t("chrome.mode.botgroup"))}</h1>`
    + `<button class="icon-btn" type="button" title="${esc(t("bg.list.new"))}" data-bg-act="new">${bgIco("plus", 15)}</button></div>`
    + `<label class="search bg-search">${bgIco("search", 13)}<input id="bg-q" placeholder="${esc(t("bg.list.search"))}" spellcheck="false" value="${esc(BG.query || "")}"><span class="kbd">Ctrl K</span></label>`
    + `<div class="bg-lscroll">${groups}${empty}</div>`
    + `<div class="bg-lfoot"><span>${esc(t("bg.list.running", { n: working }))}</span>`
    + `<span class="${waiting ? "bg-ask-t" : ""}">${esc(t("bg.list.waiting", { n: waiting }))}</span></div>`;
}

/* ---------- 中上：交接链 ----------
   阶段 B 还没有交接：每条车道就是「Manager → 这个 Bot」（组的分工本身）。
   阶段 C 的 handoff 事件会接在后面。 */
function bgChip(c, laneColor) {
  const cls = "bg-chip" + (c.cur ? " cur" : "") + (c.dim ? " dim" : "") + (c.you ? " you" : "");
  const ico = c.you ? `<span class="bg-ci">${bgIco("user", 12)}</span>` : `<span class="bg-ci">${bgAgentIco(c.agent)}</span>`;
  return `<span class="${cls}" style="--lane:${laneColor}">${ico}<span>${esc(c.who)}</span>${c.ok ? `<span class="bg-ok">✓</span>` : ""}</span>`;
}
/* 每条车道的交接链：Manager 把活交给这个 Bot；它卡在等你时链尾是「你」。
   ✓ = 这一段做完了；描边高亮 = 当前在谁手上；虚线 = 还没轮到。 */
function bgChainHTML(g) {
  const mgr = bgManager(g);
  return bgLanes(g).map((b) => {
    const sel = BG.focus === b.id;
    const st = bgBotState(b);
    const color = bgColor(g, b.id);
    const did = bgDerive(g, b).items.some((x) => x.type === "proc" || x.type === "text");
    const chips = [];
    const fromYou = bgDerive(g, b).items.some((x) => x.type === "prompt");
    if (fromYou) chips.push(bgChip({ who: t("bg.chain.you"), you: true, ok: true }, color));
    else if (mgr) chips.push(bgChip({ who: "Manager", agent: mgr.agent, ok: true }, color));
    chips.push(bgChip({ who: bgAgentName(b.agent), agent: b.agent, cur: st === "working", ok: did && st !== "working" && st !== "waiting", dim: st === "pending" }, color));
    if (st === "waiting") chips.push(bgChip({ who: t("bg.chain.you"), you: true, cur: true }, color));
    return `<div class="bg-chain-row" data-bg-focus="${esc(b.id)}">`
      + `<span class="bg-lane-l" style="--lane:${color}"><i></i>${esc(b.role)}</span>`
      + `<span class="bg-chips">${chips.join(`<span class="bg-arrow">→</span>`)}</span></div>`;
  }).join("");
}
/* ---------- 从每个 Bot 的对话里归纳「过程」 ----------
   定稿的过程流和工作树画的是**工作**：产物、提交/保存、测试 ✓✗、重试、上下文压缩、
   分叉出去的子代理、等你确认 —— 不是「上线 / 空闲」这种生命周期。
   这些全都在每个 Bot 自己的转录里（LIVE.acts，和右栏对话流同一个来源），这里归纳：
     · 一段连续的工具调用（夹在两段说话之间）= 一行过程，标题按里面最要紧的那一步定，
       展开是逐步明细（读取 / 编辑 / 运行 …），右边是「N 步 · 用时」；
     · Task / Agent 子代理 = 分叉（工作树上画一条支线，子代理做完合回来）；
     · 跑测试（npm test / go test / pytest …）= 测试 ✓/✗，失败后再跑 = 重试 #n；
     · git commit = 提交，git push = 推送，Write 新文件 = 产物，Edit = 提交/保存；
     · compact = 上下文压缩；TodoWrite = 车道进度（不单独成行）。
   只归纳、不落盘：转录本身就是持久的（重启后 acts.snapshot 会把最近的补回来）。 */
const BG_TEST_RE = /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|go\s+test\b|pytest\b|vitest\b|jest\b|cargo\s+test\b|node\s+--test\b|mocha\b|dotnet\s+test\b)/i;
const BG_STEP_KEY = {
  Read: "bg.step.read", Edit: "bg.step.edit", MultiEdit: "bg.step.edit", NotebookEdit: "bg.step.edit",
  Write: "bg.step.write", Bash: "bg.step.run", PowerShell: "bg.step.run", Grep: "bg.step.search",
  Glob: "bg.step.search", Task: "bg.step.fork", Agent: "bg.step.fork", WebFetch: "bg.step.web", WebSearch: "bg.step.web",
};
function bgBlockEnd(tools) {
  let m = 0;
  for (const a of tools) { const d = Date.parse(a.done || ""); if (!isNaN(d) && d > m) m = d; }
  return m;
}
const BG_MEMORY_RE = /[\\/]\.perch[\\/]botgroups[\\/]|(^|[\\/])brief\.md$/i;
function bgBase(p) { return String(p || "").split(/[\\/]/).filter(Boolean).pop() || ""; }
function bgDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function bgSize(text) {
  const n = String(text || "").length;
  return n >= 1000 ? t("bg.p.chars", { n: (n / 1000).toFixed(1) + "k" }) : t("bg.p.chars", { n });
}
function bgAtMs(a) { const t = Date.parse(a && a.at); return isNaN(t) ? 0 : t; }

/* 工作树上的短标签（A 定稿的写法）：类型由节点形状说，标签只写对象 ——
   「ime-probe.png」「81b-new-agent.js」「测试 2 失败」「→ Codex」。 */
function bgShort(kind, title, retry, isTest) {
  const obj = String(title || "").replace(/^[^·]*·\s*/, "");
  if (kind === "test") return retry ? t("bg.s.retry", { n: retry }) + " ✓" : t("bg.s.testOk");
  if (kind === "fail") return isTest ? (retry ? t("bg.s.retry", { n: retry }) + " ✗" : t("bg.s.testFail")) : title;
  if (kind === "memory") return t("bg.s.memory");
  if (kind === "compact") return t("bg.p.compact");
  if (kind === "dot") return "";
  return obj || title;
}
/* 一段工具调用 → 一行过程。返回 null = 这段里没有值得成行的东西。 */
function bgBlock(b, acts, prevTestFailed, endAt) {
  const tools = acts.filter((a) => a.kind === "tool" && a.tool !== "TodoWrite" && a.tool !== "AskUserQuestion");
  if (!tools.length) return null;
  const cmd = (a) => a.cmd || "";
  const first = acts[0], last = acts[acts.length - 1];
  const forks = tools.filter((a) => a.tool === "Task" || a.tool === "Agent");
  const tests = tools.filter((a) => BG_TEST_RE.test(cmd(a)));
  const commits = tools.filter((a) => /\bgit\s+commit\b/.test(cmd(a)));
  const pushes = tools.filter((a) => /\bgit\s+push\b/.test(cmd(a)));
  const writes = tools.filter((a) => a.tool === "Write");
  const edits = tools.filter((a) => /^(Edit|MultiEdit|NotebookEdit)$/.test(a.tool));
  const fails = tools.filter((a) => a.ok === false);
  const files = (list) => {
    const names = [...new Set(list.map((a) => bgBase(a.rel || a.path)).filter(Boolean))];
    return names.length > 1 ? `${names[0]} ×${names.length}` : (names[0] || "");
  };
  let kind, title, meta = "", retry = 0, look = false;
  if (forks.length) {
    kind = "fork";
    title = t("bg.p.fork", { x: forks.map((a) => a.agent || a.text.replace(/^子代理：/, "")).join("、") });
  } else if (tests.length) {
    const tl = tests[tests.length - 1];
    kind = tl.ok === false ? "fail" : tl.ok == null ? "running" : "test";
    title = t(kind === "fail" ? "bg.p.testFail" : "bg.p.test", { x: clamp(cmd(tl), 48) });
    if (prevTestFailed) retry = prevTestFailed;
  } else if (pushes.length) {
    kind = "commit"; title = t("bg.p.push", { x: clamp(cmd(pushes[0]).replace(/^.*git\s+push\s*/, ""), 40) });
  } else if (commits.length) {
    const m = /-m\s+["']([^"']+)/.exec(cmd(commits[0]));
    kind = "commit"; title = t("bg.p.commit", { x: m ? clamp(m[1], 48) : "" });
  } else if ([...writes, ...edits].some((a) => BG_MEMORY_RE.test(a.path || a.rel || ""))) {
    // 改的是这个组的共享记忆（.perch/botgroups/<gid>/brief.md）= 记忆更新（定稿里那一行）
    const mem = [...writes, ...edits].filter((a) => BG_MEMORY_RE.test(a.path || a.rel || ""));
    kind = "memory"; title = t("bg.p.memory", { x: files(mem) });
  } else if (writes.length) {
    kind = "artifact"; title = t("bg.p.artifact", { x: files(writes) });
  } else if (edits.length) {
    kind = "commit"; title = t("bg.p.save", { x: files(edits) });
  } else if (fails.length) {
    kind = "fail"; title = t("bg.p.error", { x: fails[0].tool || "" });
  } else {
    // 剩下的：跑了命令就是「运行 · 它说要干什么」，只读 / 只搜才是「查看」。
    const run = tools.find((a) => a.tool === "Bash" || a.tool === "PowerShell");
    look = !run;
    kind = "dot";
    title = run ? t("bg.p.run", { x: clamp(run.text || run.cmd || "", 48) })
      : t("bg.p.look", { x: clamp(tools[0].rel || tools[0].text || tools[0].tool, 48) });
  }
  const add = tools.reduce((n, a) => n + (a.add | 0), 0), del = tools.reduce((n, a) => n + (a.del | 0), 0);
  if (add || del) meta = `+${add} −${del}`;
  if (retry) meta = (meta ? meta + " · " : "") + t("bg.p.retry", { n: retry });
  const sub = acts.filter((a) => a.kind === "tool" || a.kind === "thinking").map((a, i, arr) => {
    const next = arr[i + 1] || null;
    // 工具用它自己的结果时刻（转录里真有的 done）；思考用到下一步开始。没有就不写。
    const done = Date.parse(a.done || "");
    const took = a.kind === "tool" ? (isNaN(done) ? 0 : done - bgAtMs(a)) : (next ? bgAtMs(next) - bgAtMs(a) : 0);
    if (a.kind === "thinking") return [t("bg.step.think"), "", took > 900 ? bgDur(took) : "", null];
    return [t(BG_STEP_KEY[a.tool] || "bg.step.tool", { x: a.tool }), a.rel || a.cmd || a.text || "", took > 900 ? bgDur(took) : "", a.ok];
  });
  const running = tools.some((a) => a.ok == null);
  return {
    type: "proc", id: first.id || (b.id + ":" + bgAtMs(first)), at: first.at, end: last.at, lane: b.id,
    kind: running && kind !== "fork" ? "running" : kind, title, meta, sub, running,
    // 用时 = 从这段第一步开始到最后一个工具的结果回来（转录里的 done）；没有结果时刻就不写用时。
    steps: tools.length, dur: bgBlockEnd(tools) ? Math.max(0, bgBlockEnd(tools) - bgAtMs(first)) : -1,
    fork: forks.length ? { done: forks.every((a) => a.ok != null) } : null,
    testFailed: kind === "fail" && tests.length > 0,
    look,
    short: bgShort(kind, title, retry, tests.length > 0),
  };
}

/* 一段连续的工具调用再按「要紧的那一步」切开：分叉、写出产物、跑测试、提交 / 推送、
   出错各自成一行（参考视频里就是一件事一行）。读 / 搜跟着它后面那件事走；
   编辑攒在一起，碰到下一件要紧的事之前先收成一行「提交/保存」。 */
function bgSplit(block) {
  const segs = [];
  let cur = [];
  const isEdit = (a) => a.kind === "tool" && /^(Edit|MultiEdit|NotebookEdit)$/.test(a.tool);
  const isFork = (a) => a.kind === "tool" && (a.tool === "Task" || a.tool === "Agent");
  const isSig = (a) => a.kind === "tool" && (isFork(a) || a.tool === "Write" || a.ok === false
    || BG_TEST_RE.test(a.cmd || "") || /gits+(commit|push)/.test(a.cmd || ""));
  for (const x of block) {
    if (isSig(x) && x.tool !== "Write" && cur.some(isEdit)) { segs.push(cur); cur = []; }
    if (isFork(x) && cur.some((y) => y.kind === "tool")) { segs.push(cur); cur = []; }
    cur.push(x);
    if (isSig(x)) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  return segs;
}
/* 群里发给某个 Bot 的那几句话（用来认出它对话里哪几轮是「从群里来的」）。 */
function bgGroupAsks(g, b) {
  const out = [];
  for (const e of bgEvents(g)) {
    if (e.bot !== "you" || e.kind !== "msg") continue;
    const to = String(e.title || "");
    const all = /@(全员|everyone|all)\b/i.test(to);
    const name = "@" + (b.manager ? "Manager" : b.role);
    if (all || to.split(/\s+/).includes(name)) out.push(String(e.text || "").trim());
  }
  return out;
}
function bgStripIntro(s) {
  s = String(s || "");
  if (/^\[Perch Bot Group/.test(s)) { const cut = s.indexOf("\n\n"); s = cut >= 0 ? s.slice(cut + 2) : ""; }
  return s;
}

/* 一个 Bot 的完整归纳：[prompt | text | proc | compact]，带缓存（acts 没变就不重算）。 */
const BG_DERIVED = new WeakMap();
function bgDerive(g, b) {
  const tab = bgTabOf(b);
  const v = tab ? LIVE.get(tab.id) : null;
  const acts = (v && v.acts) || [];
  const lastA = acts[acts.length - 1];
  const asks = bgGroupAsks(g, b);
  const st = bgBotState(b);
  const key = [(v && v.actsGen) | 0, acts.length, lastA ? lastA.id + "|" + lastA.ok + "|" + (lastA.text || "").length : "", asks.length, st].join(":");
  const hit = tab && BG_DERIVED.get(tab);
  if (hit && hit.key === key) return hit.out;
  const items = [];
  let todo = null, block = [], groupTurn = false, prevTestFailed = 0;
  const flush = (nextAt) => {
    if (!block.length) return;
    const segs = bgSplit(block);
    block = [];
    let carry = [];
    segs.forEach((seg0, si) => {
      // 只是读 / 搜的那一段不单独成行：并进它后面那件事的步骤里（定稿里没有「查看」行）
      const seg = carry.concat(seg0);
      carry = [];
      const end = si + 1 < segs.length ? bgAtMs(segs[si + 1][0]) : nextAt;
      const p = bgBlock(b, seg, prevTestFailed, end);
      if (!p) return;
      if (p.look && si + 1 < segs.length) { carry = seg; return; }
      if (p.testFailed) prevTestFailed++;
      else if (p.kind === "test") prevTestFailed = 0;
      p.groupTurn = groupTurn;
      items.push(p);
    });
  };
  let model = "", cum = 0;
  for (const a of acts) {
    if (a.model) model = a.model;
    if (a.cum > cum) cum = a.cum;
    if (a.kind === "tool" || a.kind === "thinking") {
      if (a.tool === "TodoWrite" && a.todo) todo = a.todo;
      block.push(a);
      continue;
    }
    flush(bgAtMs(a));
    if (a.kind === "prompt") {
      const text = bgStripIntro(a.text).trim();
      groupTurn = !!text && asks.some((q) => q && (text === q || text.endsWith(q)));
      if (text) {
        items.push({ type: "prompt", id: a.id, at: a.at, text, lane: b.id, groupTurn });
        // 每交给它一件事 = 一次交接（定稿里的「交接 → Codex」）：车道从这里开始。
        const who = b.manager ? "Manager" : bgAgentName(b.agent);
        items.push({ type: "proc", kind: "handoff", id: a.id + ":h", at: a.at, end: a.at, lane: b.id,
          title: t("bg.p.handoff", { x: who }), short: "→ " + who, meta: bgSize(text), sub: [], steps: 0, dur: 0,
          from: groupTurn ? "group" : "you", groupTurn });
      }
    } else if (a.kind === "text") {
      items.push({ type: "text", id: a.id, at: a.at, text: a.text, lane: b.id, groupTurn });
    } else if (a.kind === "compact") {
      items.push({ type: "proc", id: a.id, at: a.at, end: a.at, lane: b.id, kind: "compact", title: t("bg.p.compact"),
        meta: a.turn ? t("flow.turn", { n: a.turn }) : "", sub: [], steps: 0, dur: 0, groupTurn });
    }
  }
  flush(Date.now());
  // 每一轮里它最后说的那段话 = 这一轮的结论；这一轮做完了（不是正在干 / 正在等你）就标「阶段完成」。
  let lastText = null;
  for (const it of items) {
    if (it.type === "prompt") { if (lastText) lastText.turnEnd = true; lastText = null; }
    else if (it.type === "text") lastText = it;
  }
  if (lastText && st !== "working" && st !== "waiting") lastText.turnEnd = true;
  const out = { items, todo, hasActs: acts.length > 0, model, cum };
  if (tab) BG_DERIVED.set(tab, { key, out });
  return out;
}
/* 这个 Bot 眼下在做的那一件（车道页签、左栏、正在处理行都用它）。 */
function bgCurrent(g, b) {
  const d = bgDerive(g, b);
  for (let i = d.items.length - 1; i >= 0; i--) if (d.items[i].type === "proc") return d.items[i];
  return null;
}

/* ---------- 中：过程流 ----------
   版式就是 A 阶段定稿的那一套（用户 2026-10-28 两次明确：回到定稿，用真实数据填满）：
     · 发言 = .bg-msg（图标 + 名字 + 车道标 + 时间，下面正文）；
     · 过程 = .bg-ev 行（▸ 符号 + 车道标 + 标题 + 附注 + 「N 步 · 用时」），点开是逐步明细；
     · 正在处理 = .bg-ev.run；等你确认 = .bg-ev.ask 展开态（盾牌一行 + .bg-opt 选项）。
   全部车道：你在群里说的话、各 Bot 对群里那几轮的回答、所有车道的过程，按时间交错。
   聚焦一个 Bot：和它单聊 —— 它自己的完整对话（说的话 + 过程）。 */
function bgEventRow(g, e, showBadge) {
  const key = g.id + ":" + e.id;
  const open = BG.open.has(key);
  const lane = bgEvLane(e);
  const color = bgColor(g, lane);
  const cls = "bg-ev" + (e.kind === "approval" ? " ask" : "") + (e.kind === "fail" ? " bad" : "") + (open ? " open" : "");
  const caret = e.text ? `<span class="bg-caret">${bgIco("chev", 11)}</span>` : `<span class="bg-caret blank"></span>`;
  const body = open && e.text ? `<div class="bg-ev-body"><div class="bg-ev-sum">${esc(e.text)}</div></div>` : "";
  return `<div class="${cls}" data-bg-ev="${esc(key)}" style="--lane:${color}">`
    + `<div class="bg-ev-h">${caret}<span class="bg-ev-g">${bgGlyph(e.kind, color)}</span>`
    + (showBadge ? bgBadge(g, lane) : "")
    + `<span class="bg-ev-t ell">${esc(bgEvTitle(g, e))}</span>`
    + `<span class="bg-ev-r">${esc(bgTime(e.ts).slice(0, 5))}</span></div>${body}</div>`;
}
/* 一行过程（定稿里的 .bg-ev）：点开 = 「已完成 N 个步骤 · 用时」+ 逐步明细。 */
function bgProcRow(g, p, showBadge) {
  const key = g.id + ":" + p.lane + ":" + p.id;
  const open = BG.open.has(key);
  const color = bgColor(g, p.lane);
  const glyphKind = p.kind === "compact" ? "compact" : p.kind;
  const expandable = p.sub && p.sub.length > 0;
  const cls = "bg-ev" + (expandable ? " has-body" : "") + (p.kind === "fail" ? " bad" : "") + (open && expandable ? " open" : "");
  const right = !p.steps ? bgTime(p.at).slice(0, 5)
    : p.dur >= 0 ? t("bg.feed.steps", { n: p.steps, d: bgDur(p.dur) }) : t("bg.feed.stepsOnly", { n: p.steps });
  let body = "";
  if (open) {
    body = `<div class="bg-ev-body"><div class="bg-ev-sum">${esc(p.sub.length ? t("bg.feed.stepsDone", { n: p.sub.length }) + (p.dur >= 0 ? " · " + bgDur(p.dur) : "") : bgTime(p.at))}</div>`
      + p.sub.map((s) => `<div class="bg-step${s[3] === false ? " bad" : ""}"><span class="bg-caret">${bgIco("chev", 10)}</span>`
        + `<span class="bg-step-k">${esc(s[0])}</span><span class="bg-step-v ell" title="${esc(s[1])}">${esc(s[1])}</span>`
        + `<span class="bg-ev-r">${esc(s[2])}</span></div>`).join("")
      + `</div>`;
  }
  return `<div class="${cls}" data-bg-ev="${esc(key)}" style="--lane:${color}">`
    + `<div class="bg-ev-h">${expandable ? `<span class="bg-caret">${bgIco("chev", 11)}</span>` : `<span class="bg-caret blank"></span>`}<span class="bg-ev-g">${bgGlyph(glyphKind, color)}</span>`
    + (showBadge ? bgBadge(g, p.lane) : "")
    + `<span class="bg-ev-t ell">${esc(p.title)}</span>`
    + (p.meta ? `<span class="bg-ev-meta">${esc(p.meta)}</span>` : "")
    + `<span class="bg-ev-r">${esc(right)}</span></div>${body}</div>`;
}

/* 聊天正文的 markdown：比对话流那份 md() 多认块级结构（段落、列表、标题、引用、表格）——
   群里的回复多半是"结论 + 清单"，挤成一段读不了。仍然先转义、只认最常见的写法。 */
function bgMd(src) {
  const out = [];
  const parts = String(src || "").replace(/\r\n?/g, "\n").split(/^```[^\n]*\n?/m);
  parts.forEach((seg, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(seg.replace(/\n$/, ""))}</code></pre>`); return; }
    let para = [], list = null, quote = [], table = [];
    const inl = (x) => mdInline(esc(x));
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inl).join("<br>")}</p>`); para = []; };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inl(x)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.map(inl).join("<br>")}</blockquote>`); quote = []; };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
        .map((r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|"));
      out.push(`<table>${rows.map((r, ri) => `<tr>${r.map((c) => ri
        ? `<td>${inl(c.trim())}</td>` : `<th>${inl(c.trim())}</th>`).join("")}</tr>`).join("")}</table>`);
      table = [];
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };
    const startList = (tag) => {
      flushPara(); flushQuote(); flushTable();
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
    };
    for (const ln of seg.split("\n")) {
      let m;
      if (!ln.trim()) { flushAll(); continue; }
      if ((m = /^\s*#{1,4}\s+(.*)$/.exec(ln))) { flushAll(); out.push(`<h4>${inl(m[1])}</h4>`); continue; }
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(ln))) { startList("ul"); list.items.push(m[1]); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(ln))) { startList("ol"); list.items.push(m[1]); continue; }
      if ((m = /^\s*>\s?(.*)$/.exec(ln))) { flushPara(); flushList(); flushTable(); quote.push(m[1]); continue; }
      if (/^\s*\|.*\|\s*$/.test(ln)) { flushPara(); flushList(); flushQuote(); table.push(ln); continue; }
      if (list && /^\s{2,}\S/.test(ln)) { list.items[list.items.length - 1] += " " + ln.trim(); continue; }
      flushList(); flushQuote(); flushTable();
      para.push(ln);
    }
    flushAll();
  });
  return out.join("");
}
/* 一条发言（定稿的 .bg-msg）。you = 我说的：纯文本保留换行；成员说的走 bgMd。 */
function bgMsgRow(o) {
  return `<div class="bg-msg" style="--lane:${o.color}">`
    + `<div class="bg-msg-h">${o.icon}<b>${esc(o.who)}</b>${o.badge || ""}`
    + (o.to ? `<span class="bg-ev-meta">${esc(o.to)}</span>` : "")
    + `<span class="bg-msg-t">${esc(o.time || "")}</span></div>`
    + (o.you ? `<div class="bg-msg-b you">${esc(o.text || "")}</div>` : `<div class="bg-msg-b">${bgMd(o.text)}</div>`)
    + (o.stage ? `<div class="bg-stage">${bgIco("check", 11)}<span>${esc(t("bg.feed.stageDone"))}</span></div>` : "")
    + `</div>`;
}
const bgYouIco = () => bgIco("user", 14);
function bgMsgHTML(g, e, showBadge) {
  if (e.bot === "you") {
    return bgMsgRow({ you: true, who: t("bg.chain.you"), icon: bgYouIco(), color: "var(--bg-muted)",
      to: e.title ? "→ " + e.title : "", time: bgTime(e.ts).slice(0, 5), text: e.text });
  }
  const lane = bgEvLane(e);
  const b = bgBot(g, lane);
  return bgMsgRow({ who: lane === "manager" ? "Manager" : bgAgentName(b && b.agent), icon: bgAgentIco(b && b.agent),
    color: bgColor(g, lane), badge: showBadge && lane !== "manager" ? bgBadge(g, lane) : "",
    time: bgTime(e.ts).slice(0, 5), text: e.text });
}
function bgGroupFeedHTML(g) {
  const rows = [];
  // 落了盘的：你在群里说的话、建组、交接 / 审批（阶段 C）。生命周期（上线 / 空闲 / 开始干活）不进流。
  for (const e of bgEvents(g)) {
    if (e.kind === "msg") {
      // 早先版本把回复也落过盘；现在回复从转录里来，这种旧记录只在那个 Bot 一条对话都没有时才显示。
      if (e.bot !== "you") { const b = bgBot(g, bgEvLane(e)); if (b && bgDerive(g, b).hasActs) continue; }
      rows.push({ at: e.ts, html: bgMsgHTML(g, e, true) });
    } else if (e.kind === "created" || e.kind === "handoff" || e.kind === "approval" || e.kind === "artifact" || e.kind === "review") {
      rows.push({ at: e.ts, html: bgEventRow(g, e, true) });
    }
  }
  // 从转录归纳的：群里派的那几轮里它说的话 + 所有车道的过程。
  for (const b of bgMembers(g)) {
    for (const it of bgDerive(g, b).items) {
      if (it.type === "proc") { if (!it.running) rows.push({ at: it.at, html: bgProcRow(g, it, true) }); }
      else if (it.type === "text" && it.groupTurn) rows.push({ at: it.at, html: bgSaidHTML(g, b, it, true) });
    }
  }
  if (!rows.length) return `<div class="bg-empty">${esc(t("bg.feed.empty"))}</div>`;
  rows.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return rows.map((r) => r.html).join("");
}
/* 单聊：那一格的对话。工具调用是一行 .bg-ev（图例里的「工具调用」小点），thinking 不出。
   第一条消息前面那段身份说明（bgWrite 加的）是给 agent 看的，这里不显示。 */
function bgConvHTML(g, b) {
  const d = bgDerive(g, b);
  const rows = [];
  if (d.items.length) {
    for (const it of d.items) {
      if (it.type === "prompt") rows.push(bgMsgRow({ you: true, who: t("bg.chain.you"), icon: bgYouIco(), color: "var(--bg-muted)", time: bgTime(it.at).slice(0, 5), text: it.text }));
      else if (it.type === "text") rows.push(bgSaidHTML(g, b, it, false));
      else if (it.type === "proc" && !it.running) rows.push(bgProcRow(g, it, false));
    }
  } else {
    // 没在跑（还没起过 / 停了）：退回盘上那份最近的对话记录。
    const tab = bgTabOf(b);
    const hist = (tab && tab.sessionID && STATE && STATE.history && STATE.history[tab.sessionID]) || [];
    for (const it of hist) {
      const text = it.role === "user" ? bgStripIntro(it.text).trim() : it.text;
      if (!text) continue;
      rows.push(it.role === "user"
        ? bgMsgRow({ you: true, who: t("bg.chain.you"), icon: bgYouIco(), color: "var(--bg-muted)", time: bgTime(it.at).slice(0, 5), text })
        : bgSaidHTML(g, b, { at: it.at, text }, false));
    }
  }
  return rows.join("") || `<div class="bg-empty">${esc(t("bg.feed.empty"))}</div>`;
}
/* 正在发生：排队中 / 正在启动 / 正在回复（定稿里的 .bg-ev.run 那一行）。 */
/* 某个 Bot 说的一段话（定稿的 .bg-msg）。 */
function bgSaidHTML(g, b, it, showBadge) {
  return bgMsgRow({ who: b.manager ? "Manager" : bgAgentName(b.agent), icon: bgAgentIco(b.agent), color: bgColor(g, b.id),
    badge: showBadge && !b.manager ? bgBadge(g, b.id) : "", time: bgTime(it.at).slice(0, 5), text: it.text, stage: !!it.turnEnd });
}
/* 「它在做什么」：建组时写的分工任务 > 待办清单里正在做的那一项 > 最近一行过程。 */
function bgTaskOf(g, b) {
  if (b.task) return b.task;
  const d = bgDerive(g, b);
  if (d.todo && d.todo.cur) return d.todo.cur;
  const cur = bgCurrent(g, b);
  return cur ? cur.title : "";
}
/* 它在哪儿干活：会话记录里的 git 分支，没有就是项目文件夹名（定稿里那一栏是 wt/xxx）。 */
/* 「claude-opus-5-5」→「opus-5.5」（A 定稿里成员第二行就是这么写的）。 */
function bgModelShort(m) {
  return String(m || "").replace(/^claude-/, "").replace(/-(\d+)-(\d+)(?=$|-)/, "-$1.$2");
}
function bgWhere(g, b) {
  const tab = bgTabOf(b);
  const s = tab && tab.sessionID && STATE && Array.isArray(STATE.sessions) ? STATE.sessions.find((x) => x.id === tab.sessionID) : null;
  const br = s && s.branch && s.branch !== "HEAD" ? s.branch : "";   // 不是 git 仓库时会报 HEAD
  return br || bgBase(g.project);
}
/* 正在发生（定稿里的 .bg-ev.run）：正在处理 · 它眼下那一步　　<Agent> 工作中；排队 / 启动中也是这一行。 */
function bgLiveHTML(g, members) {
  return members.map((b) => {
    const q = BG_Q.get(g.id + "/" + b.id) || [];
    const st = bgBotState(b);
    let title = "";
    if (q.length) title = t(st === "pending" || st === "off" ? "bg.chat.starting" : "bg.chat.queued", { n: q.length });
    else if (st === "working") {
      const cur = bgCurrent(g, b);
      title = t("bg.feed.running", { x: cur && cur.running ? cur.title : t("bg.feed.thinking") });
    }
    if (!title) return "";
    const right = st === "working" ? t("bg.feed.workingAs", { who: bgAgentName(b.agent) }) : "";
    return `<div class="bg-ev run" data-bg-ev="${esc(g.id + ":" + b.id + ":tail")}" style="--lane:${bgColor(g, b.id)}"><div class="bg-ev-h"><span class="bg-caret blank"></span>`
      + `<span class="bg-ev-g">${bgGlyph(st === "working" ? "running" : "wait")}</span>${BG.focus === "all" ? bgBadge(g, b.id) : ""}`
      + `<span class="bg-ev-t ell">${esc(title)}</span><span class="bg-ev-r">${esc(right)}</span></div></div>`;
  }).join("");
}
/* 等你确认（定稿里 .bg-ev.ask 的展开态：盾牌一行 + 一排 .bg-opt）。
   作答走 Workspaces 群组看板那几条函数和它们的闸（55-perm / 50-ask）：外面包一层
   .gperm / .gask 只是让那几条函数认得出是哪一件事。屏上对不上就做灰（不做禁）。 */
function bgAskRowHTML(g, b, tab, perm, ask) {
  const color = bgColor(g, b.id);
  let title, gate, opts = "", note = "";
  if (perm) {
    const ps = permState(perm, tab) || {};
    const ok = !!ps.ok && !ps.busy;
    const why = ps.busy ? t("perm.why.busy") : (ps.why || "");
    title = t("bg.card.perm", { x: clamp(perm.text || perm.tool || "", 60) });
    gate = ps.q || perm.text || perm.tool || "";
    const btn = (cls, attrs, label, on, tip) => `<button type="button" class="bg-opt${cls}${on ? "" : " na"}" ${attrs} title="${esc(on ? tip : (why || t("perm.cantNow")))}">${esc(label)}</button>`;
    opts = btn(" primary", `data-perm="allow"`, t("perm.allow"), ok && !!ps.yesN, t("perm.yes.title", { n: ps.yesN }))
      + (ps.opts || []).filter((o) => o.label !== "Yes" && o.label !== "No").map((o) =>
        btn("", `data-perm="opt" data-n="${o.n}" data-h="${permHash(o.label)}"`, permLabel(o.label), ok, o.label)).join("")
      + btn("", `data-perm="deny"`, t("perm.deny"), !!ps.deny && !ps.busy, t("perm.deny.title"));
    opts = `<div class="gperm" data-pi="${esc(perm.id || "")}"><div class="bg-opts">${opts}</div></div>`;
    const err = permErr.get(perm.id);
    if (err) note = err.text;
  } else {
    const q = (ask.qs || [])[0] || {};
    title = t("bg.card.ask", { x: clamp(q.q || "", 60) });
    gate = q.q || "";
    const simple = (ask.qs || []).length === 1 && !q.multi;
    opts = simple
      ? `<div class="gask" data-ai="${esc(ask.id || "")}"><div class="bg-opts">` + (q.opts || []).map((o, i) =>
        `<button type="button" class="bg-opt gopt${i === 0 ? " primary" : ""}" data-aopt="${i + 1}" data-qidx="0" title="${esc(o.description || o.label || "")}">${esc(o.label || "")}</button>`).join("") + `</div></div>`
      : `<div class="bg-opts"><button type="button" class="bg-opt primary" data-go="${tab.id}">${esc(t("bg.card.goTerm"))}</button></div>`;
    const err = typeof answerErr !== "undefined" ? answerErr.get(ask.id) : null;
    if (err) note = err.text;
  }
  const a = perm || ask;
  return `<div class="bg-ev ask open" data-bg-tab="${tab.id}" data-bg-ev="${esc(g.id + ":" + b.id + ":tail")}" style="--lane:${color}">`
    + `<div class="bg-ev-h"><span class="bg-caret">${bgIco("chev", 11)}</span><span class="bg-ev-g">${bgGlyph("approval", color)}</span>`
    + bgBadge(g, b.id) + `<span class="bg-ev-t ell">${esc(title)}</span><span class="bg-ev-r">${esc(bgTime(a.at))}</span></div>`
    + `<div class="bg-ev-body"><div class="bg-gate">${bgIco("shield", 13)}<span>${esc(clamp(gate, 240))}</span></div>${opts}`
    + (note ? `<div class="bg-ev-note">${esc(note)}</div>` : "") + `</div></div>`;
}
function bgCardsHTML(g, members) {
  return members.map((b) => {
    const tab = bgTabOf(b);
    const v = tab ? LIVE.get(tab.id) : null;
    if (!v) return "";
    const perm = pendingPerm(v), ask = perm ? null : pendingAsk(v);
    return perm || ask ? bgAskRowHTML(g, b, tab, perm, ask) : "";
  }).join("");
}

/* 聚焦一个 Bot 时页头右边那颗：打开它的角色配置抽屉（终端收进了抽屉顶上）。 */
function bgTermBtn(b) {
  return `<button type="button" class="bg-ghost" data-bg-cfg="${esc(b.id)}" title="${esc(t("bg.d.openTitle", { name: b.manager ? "Manager" : b.role }))}">`
    + `${bgIco("sliders", 13)}<span>${esc(t("bg.d.config"))}</span></button>`;
}
function bgFeedHeadHTML(g) {
  if (BG.focus === "all") {
    return `<span class="bg-fh-t"><b>${esc(t("bg.feed.allLanes"))}</b><span class="bg-fh-s">${esc(t("bg.feed.allSub", { n: (g.bots || []).length }))}</span></span>`
      + `<span class="bg-fh-r">${esc(t("bg.feed.clickHint"))}</span>`;
  }
  const b = bgBot(g, BG.focus);
  if (!b) return "";
  const task = bgTaskOf(g, b);
  return `<span class="bg-fh-t">${bgBadge(g, b.id)}<b>${esc(bgAgentName(b.agent))}${task ? " · " + esc(task) : ""}</b></span>`
    + `<span class="bg-fh-r mono">${esc(bgWhere(g, b))}</span>`
    + bgTermBtn(b);
}
/* ---------- 右：工作树 · 泳道 ---------- */
function bgLaneTabsHTML(g) {
  return bgLanes(g).map((b) => {
    const st = bgBotState(b);
    const d = bgDerive(g, b);
    const cur = bgCurrent(g, b);
    const pct = d.todo && d.todo.total ? Math.round(100 * d.todo.done / d.todo.total) : 0;
    const head = d.todo && d.todo.total ? `${d.todo.done}/${d.todo.total}` : t(BG_STATE_KEY[st]);
    const note = st === "waiting" ? t("bg.state.waiting") : (cur ? cur.title : "");
    return `<button type="button" class="bg-lt" data-bg-focus="${esc(b.id)}" style="--lane:${bgColor(g, b.id)}">`
      + `<span class="bg-lt-n"><i></i>${esc(b.role)}</span>`
      + `<span class="bg-lt-a">${bgAgentIco(b.agent)}<span class="ell">${esc(bgAgentName(b.agent))}</span></span>`
      + `<span class="bg-lt-bar"><span style="width:${pct}%"></span></span>`
      + `<span class="bg-lt-s ell" data-state="${esc(st)}">${esc(head)}${note ? " · " + esc(note) : ""}</span></button>`;
  }).join("");
}
/* 泳道图（A 定稿 + 参考视频的画法）：
     · 每条车道一列，所有车道从顶部一起开始、并行往下 —— 车道之间不再共用"一事一行"的全局时间轴
       （那样会排成一条斜着往下的台阶，看起来是一行一行的陈列）；
     · 每条车道里，节点按它自己的先后紧凑排；只是读 / 搜 / 跑命令的步骤画成竖线上的小点，不带标签；
     · 标签只写对象（类型由节点形状说），第二行「agent · 时间」，都只在本列宽度里，超了截断；
     · 分叉（子代理）：在本车道里往右拐出一根平行支线，子代理做完在下一个节点处合回来（双圈）；
     · 还在干活 / 在等你：接着最后一个节点虚线往下，末尾一个「正在处理 / 等你确认」节点。
   每条车道只画最近 40 个节点：再往前的在过程流里翻。 */
function bgTreeSVG(g, width) {
  const lanes = bgLanes(g);
  if (!lanes.length) return "";
  const colW = Math.max(80, Math.floor((width - 16) / lanes.length));
  const x0 = 14, top = 22, rowH = 34, dotH = 12;
  const parts = [];
  let H = top + 20;
  const nodeSVG = (kind, x, y, c) => {
    switch (kind) {
      case "commit": return `<circle cx="${x}" cy="${y}" r="4.5" fill="${c}"/>`;
      case "handoff": return `<path d="M${x} ${y - 5.5} L${x + 5.5} ${y} L${x} ${y + 5.5} L${x - 5.5} ${y} Z" fill="${c}"/>`;
      case "artifact": return `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.6"/>`;
      case "memory": return `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.6"/><circle cx="${x}" cy="${y}" r="1.8" fill="${c}"/>`;
      case "test": case "review": return `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-ok)"/><path d="M${x - 2.6} ${y} l1.8 1.8 l3.4 -3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
      case "fail": return `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-bad)"/><path d="M${x - 2.2} ${y - 2.2} l4.4 4.4 M${x + 2.2} ${y - 2.2} l-4.4 4.4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`;
      case "approval": return `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--bg-panel)" stroke="var(--bg-ask)" stroke-width="2.2"/><circle cx="${x}" cy="${y}" r="2.2" fill="var(--bg-ask)"/>`;
      case "running": return `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.4" stroke-dasharray="2.4 2"/>`;
      case "idle": return `<circle cx="${x}" cy="${y}" r="4.5" fill="var(--bg-panel)" stroke="var(--bg-faint)" stroke-width="1.3" stroke-dasharray="2.2 2"/>`;
      case "fork": return `<circle cx="${x}" cy="${y}" r="4.6" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.6"/><circle cx="${x}" cy="${y}" r="1.6" fill="${c}"/>`;
      case "compact": return `<path d="M${x - 4} ${y - 4.5} L${x} ${y - 1} L${x + 4} ${y - 4.5} M${x - 4} ${y + 4.5} L${x} ${y + 1} L${x + 4} ${y + 4.5}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`;
      default: return `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
    }
  };
  lanes.forEach((b, li) => {
    const x = x0 + li * colW, c = bgColor(g, b.id);
    const right = li === lanes.length - 1 ? width - 4 : x + colW - 6;
    const st = bgBotState(b);
    const agent = bgAgentName(b.agent);
    // 这条车道的元素：节点 / 小点（连着的小点并成一个）
    const els = [];
    for (const it of bgDerive(g, b).items) {
      if (it.type !== "proc" || it.running) continue;
      if (it.kind === "dot") { if (!els.length || els[els.length - 1].dot !== true) els.push({ dot: true, it }); continue; }
      els.push({ dot: false, it });
    }
    const shown = els.slice(-40);
    let cur = top - 10;
    for (const e of shown) {
      if (e.dot) { e.cy = cur + 4; cur += dotH; } else { e.cy = cur + 10; cur += rowH; }
    }
    let tail = null;
    if (st === "working" || st === "waiting") {
      const cr = bgCurrent(g, b);
      tail = { kind: st === "waiting" ? "approval" : "running",
        title: st === "waiting" ? t("bg.tree.waitYou") : t("bg.feed.running", { x: cr && cr.running ? (cr.short || cr.title) : t("bg.feed.thinking") }) };
    } else if (!shown.length) tail = { kind: "idle", title: t("bg.tree.standby") };
    if (tail) { tail.cy = cur + (shown.length ? 14 : 10); cur = tail.cy + rowH - 10; }
    H = Math.max(H, cur + 24);
    // 竖线：实线贯穿已发生的部分，末尾那段（正在处理 / 等你）是虚线
    const y1 = shown.length ? shown[0].cy : (tail ? tail.cy : top);
    const y2 = shown.length ? shown[shown.length - 1].cy : y1;
    parts.push(`<g data-lane="${esc(b.id)}">`);
    if (shown.length > 1) parts.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${c}" stroke-width="2"/>`);
    if (tail && shown.length) parts.push(`<line x1="${x}" y1="${y2}" x2="${x}" y2="${tail.cy}" stroke="${c}" stroke-width="1.4" stroke-dasharray="3 3" opacity=".6"/>`);
    // 分叉：本车道里往右拐出一根平行支线
    const inBranch = new Set();
    shown.forEach((e, i) => {
      if (e.dot || e.it.kind !== "fork") return;
      const bx = x + 11, yf = e.cy;
      let j = -1;
      if (e.it.fork && e.it.fork.done) j = shown.findIndex((f, k) => k > i && !f.dot);
      const yEnd = j >= 0 ? shown[j].cy : (tail ? tail.cy : yf + rowH);
      for (let k = i + 1; k < shown.length && shown[k].cy <= yEnd; k++) inBranch.add(k);
      const dashed = j < 0;
      parts.push(`<path d="M${x} ${yf} C ${x} ${yf + 7}, ${bx} ${yf + 4}, ${bx} ${yf + 13} L ${bx} ${Math.max(yf + 13, yEnd - 13)}`
        + (j >= 0 ? ` C ${bx} ${yEnd - 4}, ${x} ${yEnd - 7}, ${x} ${yEnd}` : "")
        + `" fill="none" stroke="${c}" stroke-width="1.6"${dashed ? ` stroke-dasharray="3 2.5"` : ""} opacity=".9"/>`);
      if (j >= 0) shown[j].merged = true;
    });
    parts.push(`</g>`);
    shown.forEach((e, i) => {
      const key = esc(g.id + ":" + b.id + ":" + e.it.id);
      if (e.dot) {
        parts.push(`<g data-lane="${esc(b.id)}" data-bg-node="${key}"><circle class="bg-node-ring" cx="${x}" cy="${e.cy}" r="7" stroke="${c}"/>`
          + `<circle cx="${x}" cy="${e.cy}" r="2.2" fill="${c}"/></g>`);
        return;
      }
      const lx = x + (inBranch.has(i) ? 21 : 10);
      const room = right - lx;
      const label = e.it.short || e.it.title;
      parts.push(`<g data-lane="${esc(b.id)}" data-bg-node="${key}"><circle class="bg-node-ring" cx="${x}" cy="${e.cy}" r="10" stroke="${c}"/>`
        + nodeSVG(e.it.kind, x, e.cy, c)
        + (e.merged ? `<circle cx="${x}" cy="${e.cy}" r="8.5" fill="none" stroke="${c}" stroke-width="1.4"/>` : "")
        + `<text x="${lx}" y="${e.cy - 1}"${e.it.kind === "fail" ? ` class="bad"` : ""}>${esc(bgFit(label, room))}</text>`
        + `<text x="${lx}" y="${e.cy + 10}" class="sub">${esc(bgFit(agent + " · " + bgTime(e.it.at).slice(0, 5), room))}</text></g>`);
    });
    if (tail) {
      const room = right - (x + 10);
      parts.push(`<g data-lane="${esc(b.id)}" data-bg-node="${esc(g.id + ":" + b.id + ":tail")}"><circle class="bg-node-ring" cx="${x}" cy="${tail.cy}" r="10" stroke="${c}"/>`
        + nodeSVG(tail.kind, x, tail.cy, c)
        + `<text x="${x + 10}" y="${tail.cy - 1}"${tail.kind === "approval" ? ` class="ask"` : ""}>${esc(bgFit(tail.title, room))}</text>`
        + `<text x="${x + 10}" y="${tail.cy + 10}" class="sub">${esc(bgFit(agent, room))}</text></g>`);
    }
  });
  return `<svg class="bg-tree-svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join("")}</svg>`;
}

/* 等宽 10.5px：ASCII ≈ 6.3px，CJK ≈ 10.5px。按可用宽度截断，免得最后一列压出边。 */
function bgFit(s, room) {
  let w = 0, out = "";
  for (const ch of String(s)) {
    const cw = ch.codePointAt(0) > 0x2e80 ? 10.5 : 6.3;
    if (w + cw > room - 3) return out + "…";
    w += cw; out += ch;
  }
  return out;
}

const BG_LEGEND = [
  ["commit", "bg.legend.commit"], ["handoff", "bg.legend.handoff"], ["memory", "bg.legend.checkpoint"], ["test", "bg.legend.test"],
  ["fail", "bg.legend.fail"], ["review", "bg.legend.review"], ["artifact", "bg.legend.artifact"], ["fork", "bg.legend.fork"],
  ["approval", "bg.legend.waitYou"], ["running", "bg.legend.running"], ["compact", "bg.legend.compact"], ["dot", "bg.legend.tool"],
];
function bgLegendHTML() {
  return BG_LEGEND.map(([k, key]) => `<span class="bg-lg">${bgGlyph(k, "var(--bg-fg2)")}<span>${esc(t(key))}</span></span>`).join("");
}

/* ---------- 空态 ---------- */
function bgEmptyMainHTML() {
  return `<div class="bg-hero-in">`
    +   `<div class="bg-hero-ico">${bgIco("bot", 22)}</div>`
    +   `<h2>${esc(t(BG_LOADED ? "bg.empty.title" : "bg.list.loading"))}</h2>`
    +   (BG_LOADED ? `<p>${esc(t("bg.empty.lead"))}</p>`
    +   `<div class="bg-hero-acts">`
    +     `<button type="button" class="bg-btn primary" data-bg-act="new">${bgIco("plus", 12)}<span>${esc(t("bg.empty.new"))}</span></button>`
    +   `</div>`
    +   `<p class="bg-hero-hint">${esc(t("bg.empty.deriveHint"))}</p>` : "")
    + `</div>`;
}

/* ---------- 整页 ----------
   骨架只建一次（有组 / 没组两种），之后按区域换内容，而且**内容没变就不碰 DOM**：
     · 输入框是常驻的 —— 整页重画会把正在打的字、输入法的组字、光标一起抹掉；
     · 卡片上的按钮在 mousedown 和 click 之间被换掉，这一下点击就丢了；
     · 流式回复每帧都在变，只换「正在发生」那一小块，别的不动（选中的字也不丢）。 */
let BG_RAF = 0, BG_STICK = false, BG_LAST = 0;
function bgSchedule(stick) {
  if (stick) BG_STICK = true;
  if (BG_RAF) return;
  // 流式回复时一秒十几次 acts：合到 ~8 帧/秒就够了。
  const wait = Math.max(0, 120 - (performance.now() - BG_LAST));
  BG_RAF = setTimeout(() => requestAnimationFrame(() => {
    BG_RAF = 0;
    BG_LAST = performance.now();
    if (document.body.classList.contains("botgroup")) renderBotGroup();
    if (BG.dock) bgDockHead();
  }), wait);
}
function bgSet(el, html) {
  if (!el || el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}
function bgSkeleton(root, has) {
  if (!has) {
    root.innerHTML = `<aside class="bg-list" id="bg-list"></aside><section class="bg-center bg-hero" id="bg-hero"></section><aside class="bg-tree"></aside>`;
    return;
  }
  root.innerHTML = `<aside class="bg-list" id="bg-list"></aside>`
    + `<section class="bg-center">`
    +   `<div id="bg-top"></div>`
    +   `<div class="bg-fh" id="bg-fh"></div>`
    +   `<div class="bg-feed" id="bg-feed"><div id="bg-feed-list"></div><div id="bg-live"></div><div id="bg-cards"></div></div>`
    +   `<div class="bg-composer"><div class="bg-mention" id="bg-mention" role="listbox" hidden></div>`
    +     `<div class="bg-cbox" id="bg-cbox"><textarea class="bg-cin" id="bg-input" rows="1" spellcheck="false"></textarea>`
    +     `<div class="bg-cfoot"><span id="bg-chint"></span><button type="button" class="bg-send" id="bg-send" aria-label="send">${bgIco("send", 13)}</button></div></div>`
    +   `</div>`
    + `</section>`
    + `<aside class="bg-tree" id="bg-tree"></aside>`;
  bgBindComposer();
}
/* 页头的「预算 已用/上限」（A 定稿）：已用 = 各 Bot 会话真实的 token 累计（输入 + 输出 + 写缓存，
   转录里有），上限是建组时填的（k tokens，默认 500）。 */
function bgUsedK(g) {
  let n = 0;
  for (const b of bgMembers(g)) n += bgDerive(g, b).cum || 0;
  return Math.round(n / 1000);
}
function bgBudgetHTML(g) {
  const used = bgUsedK(g), cap = g.budget || 500;
  const pct = Math.min(100, Math.round(100 * used / cap));
  return `<span class="bg-budget${pct >= 90 ? " hot" : ""}" title="${esc(t("bg.head.budgetTitle"))}">${esc(t("bg.head.budget", { used, cap }))}`
    + `<span class="bg-bbar"><span style="width:${pct}%"></span></span></span>`;
}
function bgTopHTML(g, waiting) {
  const light = document.documentElement.classList.contains("theme-light");
  const srcLine = g.source && g.source.kind === "derived"
    ? `<span class="bg-from">${bgIco("split", 12)}${esc(t("bg.head.derived"))} ${bgAgentIco(g.source.agent)}<b>${esc(g.source.title || bgAgentName(g.source.agent))}</b></span>`
    : `<span class="bg-from">${esc(t("bg.head.standalone"))}</span>`;
  return `<header class="bg-head">`
    +   `<div class="bg-title"><h2>${esc(g.name)}</h2><span class="bg-proj mono ell" title="${esc(g.project)}">${esc(bgBase(g.project))}</span></div>`
    +   `<div class="bg-acts">`
    +     bgBudgetHTML(g)
    +     (waiting ? `<button type="button" class="bg-needbtn" data-bg-act="need">${bgDot("waiting")}${esc(t("bg.head.needYou", { n: waiting }))}</button>` : "")
    +     `<button type="button" class="bg-btn" data-bg-act="na" title="${esc(t("bg.head.laterC"))}">${bgIco("pause", 12)}<span>${esc(t("bg.head.pauseAll"))}</span></button>`
    +     `<button type="button" class="bg-btn primary" data-bg-act="addbot">${bgIco("plus", 12)}<span>${esc(t("bg.head.addBot"))}</span></button>`
    +     `<button type="button" class="icon-btn bg-theme" data-bg-act="theme" title="${esc(t(light ? "bg.head.toDark" : "bg.head.toLight"))}">${bgIco(light ? "moon" : "sun", 14)}</button>`
    +   `</div>`
    + `</header>`
    + `<div class="bg-goal">${srcLine}${g.goal ? `<span class="bg-sep">·</span><span class="bg-goal-k">${esc(t("bg.head.goal"))}</span><span class="ell">${esc(g.goal)}</span>` : ""}</div>`
    + `<div class="bg-chain">${bgChainHTML(g) || `<div class="bg-empty sm">${esc(t("bg.chain.noBots"))}</div>`}</div>`;
}
function bgTreeHTML(g, waiting) {
  const lanes = bgLanes(g);
  return `<div class="bg-th"><b>${esc(t("bg.tree.title"))}</b><span>${esc(t("bg.tree.sub", { n: lanes.length, w: waiting }))}</span></div>`
    + (lanes.length ? `<div class="bg-lts" style="--n:${lanes.length}">${bgLaneTabsHTML(g)}</div>` : "")
    + `<div class="bg-tseg"><span class="segs-mini"><button type="button" data-bg-act="focus-cur">${esc(t("bg.tree.focus"))}</button>`
    +   `<button type="button" data-bg-focus="all">${esc(t("bg.tree.all"))}</button></span><span class="mono bg-now">${esc(bgTime(new Date().toISOString()).slice(0, 5))}</span></div>`
    + `<div class="bg-tscroll" id="bg-tscroll"></div>`
    + `<div class="bg-legend"><div class="bg-lg-h">${esc(t("bg.legend.title"))}</div><div class="bg-lg-grid">${bgLegendHTML()}</div></div>`;
}
function renderBotGroup(why) {
  const root = $("bg");
  if (!root) return;
  const g = bgGroup();
  const light = document.documentElement.classList.contains("theme-light");
  const key = (g ? "g" : "e") + "|" + PERCH_LOCALE;
  if (root.dataset.sk !== key) { bgSkeleton(root, !!g); root.dataset.sk = key; }
  // 左栏的搜索框也在被换的那块里：焦点和光标自己留住。
  const qEl = document.activeElement && document.activeElement.id === "bg-q" ? document.activeElement : null;
  const qSel = qEl ? qEl.selectionStart : 0;
  const ls = root.querySelector(".bg-lscroll");
  const lsTop = ls ? ls.scrollTop : 0;
  if (bgSet($("bg-list"), bgListHTML())) {
    const nls = root.querySelector(".bg-lscroll");
    if (nls) nls.scrollTop = lsTop;
    if (qEl) { const q = $("bg-q"); if (q) { q.focus(); q.setSelectionRange(qSel, qSel); } }
  }
  if (!g) {
    bgSet($("bg-hero"), bgEmptyMainHTML());
  } else {
    if (BG.focus !== "all" && !bgBot(g, BG.focus)) BG.focus = "all";
    const waiting = (g.bots || []).filter((b) => bgBotState(b) === "waiting").length;
    bgSet($("bg-top"), bgTopHTML(g, waiting));
    bgSet($("bg-fh"), bgFeedHeadHTML(g));
    const feed = $("bg-feed");
    const atEnd = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40;
    const focusKey = g.id + "|" + BG.focus;
    const switched = feed.dataset.fk !== focusKey;
    feed.dataset.fk = focusKey;
    const members = BG.focus === "all" ? (g.bots || []) : [bgBot(g, BG.focus)];
    const a = bgSet($("bg-feed-list"), BG.focus === "all" ? bgGroupFeedHTML(g) : bgConvHTML(g, members[0]));
    const b = bgSet($("bg-live"), bgLiveHTML(g, members));
    const c = bgSet($("bg-cards"), bgCardsHTML(g, members));
    // 在看最新的（贴着底）就继续贴底；往上翻着看历史时不抢滚动条。切了会话一律到底。
    if (switched || ((a || b || c) && (atEnd || BG_STICK))) feed.scrollTop = feed.scrollHeight;
    const ts0 = $("bg-tscroll");
    const tsTop = ts0 ? ts0.scrollTop : 0;
    bgSet($("bg-tree"), bgTreeHTML(g, waiting));
    const ts = $("bg-tscroll");
    if (bgSet(ts, bgTreeSVG(g, Math.max(260, ts.clientWidth || 340)) || `<div class="bg-empty sm">${esc(t("bg.tree.empty"))}</div>`)) ts.scrollTop = tsTop;
    bgComposerSync(g);
    bgApplyFocus(g, switched);
    bgMotionAfterRender(g, switched);
  }
  BG_STICK = false;
  if (typeof bgDrawerSync === "function") bgDrawerSync();
  if (why) sendCtrl({ type: "log", msg: `Bot Group 渲染（${why}）组=${BOTGROUPS.length} 当前=${g ? g.id : "-"} focus=${BG.focus} theme=${light ? "light" : "dark"}` });
}

function bgPickGroup(gid) {
  BG.group = gid || "";
  try { localStorage.setItem("perch.bg.group", BG.group); } catch (_) {}
}

/* ---------- 动效（第 2 步，2026-10-28；效果以桌面参考视频为准，节点长出的手感参考 LayerFS） ----------
   1. 聚焦：选中 / 变淡只切类，不重画 —— 元素还是那几个，CSS 过渡才动得起来
      （以前聚焦一换就整块 innerHTML，变淡是"啪"一下）。
   2. 连线：鼠标停在过程流的一行上（或者刚展开一行），从这一行拉一条曲线到工作树里对应的节点，
      节点套一圈环；反过来停在节点上也一样。「正在处理 / 等你确认」那一行连到车道末尾的节点。
      曲线是描出来的（stroke-dashoffset），不是一下子出现。
   3. 节点长出：工作树里新出现的节点从 0 弹到 1（带一点过冲），标签随后淡入；第一次画不弹。
   4. 行进场：过程流里新出现的行轻轻上浮淡入；第一次画、切会话时不逐行进场（整块淡入）。 */
const BG_SEEN = new Map();      // gid → Set(工作树节点 key)
const BG_ROWS_SEEN = new Map(); // gid|focus → Set(过程流行 key)
const BGL = { hover: "", open: "", drawn: "" };

function bgApplyFocus(g, switched) {
  const root = $("bg");
  if (!root) return;
  const f = BG.focus;
  root.querySelectorAll(".bg-chain-row").forEach((el) => {
    const on = el.dataset.bgFocus === f;
    el.classList.toggle("sel", on);
    el.classList.toggle("mute", f !== "all" && !on);
  });
  root.querySelectorAll(".bg-lt").forEach((el) => el.classList.toggle("sel", el.dataset.bgFocus === f));
  root.querySelectorAll(".bg-row[data-bg-focus]").forEach((el) =>
    el.classList.toggle("sel", el.dataset.bgGroup === g.id && el.dataset.bgFocus === f));
  root.querySelectorAll("#bg-tscroll g[data-lane]").forEach((el) => el.classList.toggle("mute", f !== "all" && el.dataset.lane !== f));
  const fc = root.querySelector('[data-bg-act="focus-cur"]'), fa = root.querySelector('.bg-tseg [data-bg-focus="all"]');
  if (fc) fc.classList.toggle("on", f !== "all");
  if (fa) fa.classList.toggle("on", f === "all");
  if (switched) {
    const list = $("bg-feed-list");
    if (list) { list.classList.remove("bg-swap"); void list.offsetWidth; list.classList.add("bg-swap"); }
  }
}

function bgMotionAfterRender(g, switched) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 节点长出
  const seen = BG_SEEN.get(g.id);
  const nodes = [...document.querySelectorAll("#bg-tscroll g[data-bg-node]")];
  if (!seen) BG_SEEN.set(g.id, new Set(nodes.map((n) => n.dataset.bgNode)));
  else {
    for (const n of nodes) {
      const k = n.dataset.bgNode;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!reduce) n.classList.add("pop");
    }
  }
  // 行进场
  const rk = g.id + "|" + BG.focus;
  const rows = [...document.querySelectorAll("#bg-feed-list > [data-bg-ev], #bg-live > [data-bg-ev]")];
  const rs = BG_ROWS_SEEN.get(rk);
  if (!rs || switched) BG_ROWS_SEEN.set(rk, new Set(rows.map((r) => r.dataset.bgEv)));
  else {
    for (const r of rows) {
      const k = r.dataset.bgEv;
      if (rs.has(k)) continue;
      rs.add(k);
      if (!reduce) r.classList.add("enter");
    }
  }
  bgLinkDraw(false);
}

/* 连线：目标 = 鼠标停着的那一行 / 节点，没有就用最近展开的那一行。 */
function bgLinkKey() { return BGL.hover || BGL.open || ""; }
function bgLinkLayer() {
  let svg = $("bg-link");
  const root = $("bg");
  if (!svg && root) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.id = "bg-link";
    svg.setAttribute("aria-hidden", "true");
    root.appendChild(svg);
  }
  return svg;
}
function bgLinkClear() {
  const svg = $("bg-link");
  if (svg) svg.innerHTML = "";
  document.querySelectorAll("#bg .bg-ev.linked").forEach((el) => el.classList.remove("linked"));
  document.querySelectorAll("#bg-tscroll g.hl").forEach((el) => el.classList.remove("hl"));
  BGL.drawn = "";
}
function bgLinkDraw(animate) {
  const key = bgLinkKey();
  const root = $("bg");
  if (!root || !document.body.classList.contains("botgroup")) return;
  if (!key) { bgLinkClear(); return; }
  const row = root.querySelector(`#bg-feed [data-bg-ev="${CSS.escape(key)}"]`);
  const node = root.querySelector(`#bg-tscroll g[data-bg-node="${CSS.escape(key)}"]`);
  document.querySelectorAll("#bg .bg-ev.linked").forEach((el) => { if (el !== row) el.classList.remove("linked"); });
  document.querySelectorAll("#bg-tscroll g.hl").forEach((el) => { if (el !== node) el.classList.remove("hl"); });
  if (row) row.classList.add("linked");
  if (node) node.classList.add("hl");
  const svg = bgLinkLayer();
  if (!svg) return;
  if (!row || !node) { svg.innerHTML = ""; BGL.drawn = ""; return; }
  const base = root.getBoundingClientRect();
  const feed = $("bg-feed").getBoundingClientRect(), ts = $("bg-tscroll").getBoundingClientRect();
  const h = (row.querySelector(".bg-ev-h") || row).getBoundingClientRect();
  const shape = node.querySelector(":scope > :not(.bg-node-ring)") || node;
  const n = shape.getBoundingClientRect();
  const y1 = h.top + h.height / 2, y2 = n.top + n.height / 2;
  // 两头都要在各自的可视区里，否则不画（行被滚走 / 节点被滚走时不拉一条穿出去的线）
  if (y1 < feed.top || y1 > feed.bottom || y2 < ts.top || y2 > ts.bottom) { svg.innerHTML = ""; BGL.drawn = ""; return; }
  const x1 = h.right - base.left - 6, x2 = n.left - base.left + n.width / 2;
  const a = y1 - base.top, b = y2 - base.top, dx = Math.max(60, (x2 - x1) * 0.5);
  const color = getComputedStyle(row).getPropertyValue("--lane").trim() || "var(--bg-muted)";
  const d = `M${x1.toFixed(1)} ${a.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${a.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${b.toFixed(1)}, ${x2.toFixed(1)} ${b.toFixed(1)}`;
  const fresh = BGL.drawn !== key;
  svg.innerHTML = `<path class="bg-link-path" d="${d}" stroke="${color}"/><circle class="bg-link-dot" cx="${x1.toFixed(1)}" cy="${a.toFixed(1)}" r="2.6" fill="${color}"/>`;
  const p = svg.firstChild;
  if (fresh && animate !== false && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len} ${len}`;
    p.style.strokeDashoffset = String(len);
    p.getBoundingClientRect();
    p.style.transition = "stroke-dashoffset 420ms cubic-bezier(.2,.8,.2,1)";
    p.style.strokeDashoffset = "0";
  }
  BGL.drawn = key;
}
/* 展开一行时把工作树滚到它的节点（平滑），滚完再画线。 */
function bgRevealNode(key) {
  const node = document.querySelector(`#bg-tscroll g[data-bg-node="${CSS.escape(key)}"]`);
  const ts = $("bg-tscroll");
  if (!node || !ts) return;
  const n = node.getBoundingClientRect(), r = ts.getBoundingClientRect();
  if (n.top >= r.top + 20 && n.bottom <= r.bottom - 20) return;
  ts.scrollTo({ top: ts.scrollTop + (n.top - r.top) - r.height / 2, behavior: "smooth" });
}
{
  const root = $("bg");
  if (root && !root.dataset.motion) {
    root.dataset.motion = "1";
    root.addEventListener("mouseover", (e) => {
      const el = e.target.closest("#bg-feed [data-bg-ev], #bg-tscroll g[data-bg-node]");
      const k = el ? (el.dataset.bgEv || el.dataset.bgNode) : "";
      if (k === BGL.hover) return;
      BGL.hover = k;
      bgLinkDraw(true);
    });
    root.addEventListener("mouseleave", () => { if (BGL.hover) { BGL.hover = ""; bgLinkDraw(true); } });
    // 展开 / 收起一行：记成「最近展开的」，并把工作树滚到它的节点
    root.addEventListener("click", (e) => {
      const h = e.target.closest(".bg-ev.has-body > .bg-ev-h");
      if (!h) return;
      const k = h.parentElement.dataset.bgEv;
      requestAnimationFrame(() => {
        BGL.open = BG.open.has(k) ? k : (BGL.open === k ? "" : BGL.open);
        if (BGL.open) bgRevealNode(BGL.open);
        bgLinkDraw(true);
      });
    }, true);
    let raf = 0;
    const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; bgLinkDraw(false); }); };
    root.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw);
  }
}

/* ---------- 组名旁的 ⋯：共享记忆 / 删除（A 定稿的页头里没有这两颗，收到这里） ---------- */
function bgGroupMenu(gid, anchor) {
  const g = BOTGROUPS.find((x) => x.id === gid);
  if (!g) return;
  let pop = $("bg-gpop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "bg-gpop";
    pop.setAttribute("role", "menu");
    document.body.appendChild(pop);
    pop.addEventListener("click", (e) => {
      const it = e.target.closest("[data-gact]");
      if (!it) return;
      const grp = BOTGROUPS.find((x) => x.id === pop.dataset.gid);
      bgGroupMenuClose();
      if (!grp) return;
      if (it.dataset.gact === "brief" && grp.brief) sendCtrl({ type: "open", mode: "open", path: grp.brief });
      else if (it.dataset.gact === "delete") bgDeleteGroup(grp);
    });
    document.addEventListener("mousedown", (e) => { if (!e.target.closest("#bg-gpop,[data-bg-gmenu]")) bgGroupMenuClose(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") bgGroupMenuClose(); });
  }
  pop.dataset.gid = gid;
  pop.innerHTML = (g.brief ? `<button type="button" class="bg-gi" data-gact="brief">${bgIco("file", 13)}<span>${esc(t("bg.head.brief"))}</span></button>` : "")
    + `<button type="button" class="bg-gi danger" data-gact="delete">${bgIco("trash", 13)}<span>${esc(t("bg.head.delete"))}</span></button>`;
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.round(r.right - 168) + "px";
  pop.style.top = Math.round(r.bottom + 4) + "px";
  pop.hidden = false;
}
function bgGroupMenuClose() { const p = $("bg-gpop"); if (p) p.hidden = true; }
document.addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("botgroup") || !(e.ctrlKey && (e.key === "k" || e.key === "K"))) return;
  const q = $("bg-q");
  if (!q) return;
  e.preventDefault();
  q.focus();
  q.select();
}, true);

/* ---------- 删除 ----------
   Bot 的格子随组一起关掉并忘掉（它们只为这个组而生）；衍生来的 Manager
   是用户原来的 Agent —— 放回 Workspaces，接着用。 */
async function bgDeleteGroup(g) {
  if (!g) return;
  const derived = g.source && g.source.kind === "derived";
  const ok = await askConfirm({
    title: t("bg.del.title", { name: g.name }),
    body: t(derived ? "bg.del.bodyDerived" : "bg.del.body", { n: bgLanes(g).length }),
    ok: t("bg.del.ok"),
    danger: true,
  });
  if (!ok) return;
  for (const b of g.bots || []) {
    const tab = bgTabOf(b);
    if (!tab) continue;
    if (b.manager && derived) continue;   // 放回去由 bgSyncTabs 在组消失后做
    if (BG.dock === tab) bgCloseDock();
    closeTab(tab, { forget: true, reseat: true, why: `删除 Bot Group ${g.id}` });
  }
  const r = await bgRequest({ type: "botgroup.delete", id: g.id });
  if (!r.ok) { showToast(t("bg.toast.deleteFailed"), r.err || "", "err"); return; }
  showToast(t("bg.toast.deleted", { name: g.name }), derived ? t("bg.toast.deletedDerived") : "", "ok");
}

/* ---------- 新建 / 衍生 ---------- */
const BG_ROLE_PRESETS = ["bg.role.dev", "bg.role.review", "bg.role.test", "bg.role.docs", "bg.role.maint", "bg.role.promo"];
let BGC = null;   // 对话框状态：{ source(tab|null), name, goal, project, manager, bots:[{role,agent}], busy, err }

function bgLaunchable() { return opCatalog().filter(opLaunchable); }
function bgOpenCreate(opts) {
  opts = opts || {};
  const src = opts.source || null;
  const def = defaultAgentId();
  let project = "";
  if (src) {
    const p = naProjectOwning(effCwd(src));
    project = p ? p.path : effCwd(src);
  } else {
    const cur = (typeof activeTab !== "undefined" && activeTab) ? naProjectOwning(effCwd(activeTab)) : null;
    project = cur ? cur.path : ((naRealProjects()[0] || {}).path || "");
  }
  const add = opts.addTo || null;   // 「加 Bot」：往已有的组里加（只填 Bot 那一段）
  BGC = {
    add, source: src,
    name: src ? currentTabTitle(src) : "",
    goal: "",
    budget: 500,
    project,
    manager: src ? ((src.spec && src.spec.agent) || def) : def,
    bots: [{ role: t("bg.role.dev"), agent: def }],
    busy: false, err: "",
  };
  let el = $("bg-create");
  if (!el) {
    el = document.createElement("div");
    el.id = "bg-create";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    document.body.appendChild(el);
    bgBindCreate(el);
  }
  el.hidden = false;
  bgRenderCreate();
  requestAnimationFrame(() => { const n = $(add ? "bgc-role0" : "bgc-name") || document.querySelector(".bgc-role"); if (n) { n.focus(); n.select(); } });
  sendCtrl({ type: "log", msg: `Bot Group：打开${src ? `衍生（tab=${src.id} pane=${src.paneID}）` : "新建"}对话框` });
}
function bgCloseCreate() {
  const el = $("bg-create");
  if (el) el.hidden = true;
  BGC = null;
}
function bgAgentPicker(name, cur) {
  return `<div class="bgc-agents" data-bgc-pick="${esc(name)}">` + bgLaunchable().map((a) =>
    `<button type="button" class="bgc-ag${a.id === cur ? " on" : ""}" data-agent="${esc(a.id)}" title="${esc(a.name || a.id)}" aria-pressed="${a.id === cur}">`
    + `${bgAgentIco(a.id)}<span>${esc(a.name || a.id)}</span></button>`).join("") + `</div>`;
}
function bgCreateInvalid() {
  if (!BGC) return "x";
  if (!BGC.add && !BGC.name.trim()) return t("bg.c.needName");
  if (!BGC.add && !BGC.project) return t("bg.c.needProject");
  if (!BGC.add && !BGC.source && !BGC.manager) return t("bg.c.needManager");
  if (!BGC.bots.length) return t("bg.c.needBot");
  if (BGC.bots.some((b) => !b.role.trim() || !b.agent)) return t("bg.c.needRole");
  return "";
}
function bgRenderCreate() {
  const el = $("bg-create");
  if (!el || !BGC) return;
  const src = BGC.source;
  const projects = naRealProjects();
  const projHTML = src
    ? `<div class="ap-pathbox">${esc(BGC.project)}</div>`
    : (projects.length
      ? `<div class="bgc-projs">` + projects.map((p) =>
        `<button type="button" class="bgc-proj${normPath(p.path) === normPath(BGC.project) ? " on" : ""}" data-proj="${esc(p.path)}" title="${esc(p.path)}">`
        + `${NA_ICON_FOLDER}<span class="ell">${esc(projectName(p))}</span></button>`).join("") + `</div>`
      : `<div class="ap-err">${esc(t("bg.c.noProjects"))}</div>`);
  const mgrHTML = src
    ? `<div class="bgc-src">${bgAgentIco(src.spec && src.spec.agent)}<b class="ell">${esc(currentTabTitle(src))}</b><span>${esc(t("bg.c.srcNote"))}</span></div>`
    : bgAgentPicker("manager", BGC.manager);
  // 加 Bot：已有几条车道，新行的车道色就从第几个往下接；上限也扣掉已有的。
  const addG = BGC.add ? BOTGROUPS.find((x) => x.id === BGC.add) : null;
  const have = addG ? bgLanes(addG).length : 0;
  const cap = BG_MAX_BOTS - have;
  const bots = BGC.bots.map((b, i) =>
    `<div class="bgc-bot" style="--lane:${BG_LANE_PALETTE[(have + i) % BG_LANE_PALETTE.length]}">`
    + `<div class="bgc-bot-h"><i></i><input class="ap-input bgc-role" data-bot="${i}" value="${esc(b.role)}" placeholder="${esc(t("bg.c.rolePh"))}" spellcheck="false" maxlength="24">`
    + `<button type="button" class="ap-x" data-bgc-del="${i}" title="${esc(t("bg.c.removeBot"))}" aria-label="${esc(t("bg.c.removeBot"))}">${bgIco("x", 12)}</button></div>`
    + bgAgentPicker("bot:" + i, b.agent) + `</div>`).join("");
  const full = BGC.bots.length >= cap;
  const invalid = bgCreateInvalid();
  el.innerHTML = `<div class="ap-card bgc-card" role="document">`
    + `<div class="ap-head"><span class="ap-title">${esc(addG ? t("bg.c.titleAdd", { name: addG.name }) : src ? t("bg.c.titleDerive") : t("bg.c.title"))}</span>`
    + `<button class="ap-x" data-bgc="close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${bgIco("x", 12)}</button></div>`
    + `<div class="ap-body">`
    +   `<p class="ap-lead">${esc(t(addG ? "bg.c.leadAdd" : src ? "bg.c.leadDerive" : "bg.c.lead"))}</p>`
    +   (addG ? "" : `<div class="ap-lab">${esc(t("bg.c.name"))}</div><input class="ap-input" id="bgc-name" value="${esc(BGC.name)}" spellcheck="false" maxlength="60" placeholder="${esc(t("bg.c.namePh"))}">`
    +   `<div class="ap-lab">${esc(t("bg.c.goal"))}</div><textarea class="ap-input bgc-goal" id="bgc-goal" rows="2" spellcheck="false" placeholder="${esc(t("bg.c.goalPh"))}">${esc(BGC.goal)}</textarea>`
    +   `<div class="ap-lab">${esc(t("bg.c.project"))}</div>${projHTML}`
    +   `<div class="ap-lab">Manager</div>${mgrHTML}`
    +   `<div class="ap-lab">${esc(t("bg.c.budget"))}</div><input class="ap-input bgc-budget" id="bgc-budget" type="number" min="10" step="10" value="${esc(String(BGC.budget))}">`)
    +   `<div class="ap-lab bgc-lab">${esc(t("bg.c.bots", { n: BGC.bots.length, max: cap }))}</div>`
    +   `<div class="bgc-bots">${bots}</div>`
    +   `<div class="bgc-add">`
    +     `<button type="button" class="ap-change${full ? " na" : ""}" data-bgc="add" title="${esc(full ? t("bg.c.full", { max: BG_MAX_BOTS }) : "")}">${bgIco("plus", 11)} ${esc(t("bg.c.addBot"))}</button>`
    +     BG_ROLE_PRESETS.map((k) => `<button type="button" class="bgc-preset${full ? " na" : ""}" data-bgc-preset="${esc(k)}">${esc(t(k))}</button>`).join("")
    +   `</div>`
    +   `<div class="ap-err">${esc(BGC.err || "")}</div>`
    + `</div>`
    + `<div class="ap-foot"><span class="bgc-note">${esc(t("bg.c.note"))}</span><span class="ap-sp"></span>`
    +   `<button type="button" data-bgc="close">${esc(t("common.cancel"))}</button>`
    +   `<button type="button" class="primary${invalid || BGC.busy ? " na" : ""}" data-bgc="create" title="${esc(invalid)}">${esc(t(BGC.busy ? "bg.c.creating" : addG ? "bg.c.addConfirm" : "bg.c.create"))}</button>`
    + `</div></div>`;
}
function bgBindCreate(el) {
  el.addEventListener("input", (e) => {
    if (!BGC) return;
    const x = e.target;
    if (x.id === "bgc-name") BGC.name = x.value;
    else if (x.id === "bgc-budget") BGC.budget = Math.max(0, parseInt(x.value, 10) || 0);
    else if (x.id === "bgc-goal") BGC.goal = x.value;
    else if (x.classList.contains("bgc-role")) BGC.bots[+x.dataset.bot].role = x.value;
    // 只刷新「创建」那颗的灰态：整卡重画会把正在打的字连输入框一起换掉。
    const btn = el.querySelector('[data-bgc="create"]');
    if (btn) { const inv = bgCreateInvalid(); btn.classList.toggle("na", !!inv || BGC.busy); btn.title = inv; }
  });
  el.addEventListener("click", (e) => {
    if (!BGC) return;
    if (e.target === el) { bgCloseCreate(); return; }
    const ag = e.target.closest(".bgc-ag");
    if (ag) {
      const who = ag.closest("[data-bgc-pick]").dataset.bgcPick;
      if (who === "manager") BGC.manager = ag.dataset.agent;
      else BGC.bots[+who.slice(4)].agent = ag.dataset.agent;
      bgRenderCreate();
      return;
    }
    const pj = e.target.closest(".bgc-proj");
    if (pj) { BGC.project = pj.dataset.proj; bgRenderCreate(); return; }
    const del = e.target.closest("[data-bgc-del]");
    if (del) { BGC.bots.splice(+del.dataset.bgcDel, 1); bgRenderCreate(); return; }
    const pre = e.target.closest("[data-bgc-preset]");
    const act = e.target.closest("[data-bgc]");
    if (pre || (act && act.dataset.bgc === "add")) {
      if (BGC.bots.length >= BG_MAX_BOTS - (BGC.add ? bgLanes(BOTGROUPS.find((x) => x.id === BGC.add)).length : 0)) { showToast(t("bg.c.full", { max: BG_MAX_BOTS }), "", "err"); return; }
      BGC.bots.push({ role: pre ? t(pre.dataset.bgcPreset) : "", agent: defaultAgentId() });
      bgRenderCreate();
      const roles = el.querySelectorAll(".bgc-role");
      if (!pre && roles.length) roles[roles.length - 1].focus();
      return;
    }
    if (!act) return;
    if (act.dataset.bgc === "close") bgCloseCreate();
    else if (act.dataset.bgc === "create") bgSubmitCreate();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); bgCloseCreate(); }
    else if (e.key === "Enter" && e.target.tagName === "INPUT" && !e.isComposing) { e.preventDefault(); bgSubmitCreate(); }
  });
}
async function bgSubmitCreate() {
  if (!BGC || BGC.busy) return;
  const inv = bgCreateInvalid();
  if (inv) { BGC.err = inv; bgRenderCreate(); return; }
  const src = BGC.source;
  if (src && !(src.paneID | 0)) { BGC.err = t("bg.c.noPane"); bgRenderCreate(); return; }
  BGC.busy = true; BGC.err = "";
  bgRenderCreate();
  if (BGC.add) {
    // 加 Bot：逐个记进组里（回执里带着新 Bot），再逐个起格。
    const gid = BGC.add;
    const added = [];
    for (const b of BGC.bots) {
      const r = await bgRequest({ type: "botgroup.addbot", id: gid, botgroup: { bots: [{ role: b.role.trim(), agent: b.agent }] } });
      if (!BGC) return;
      if (!r.ok || !r.bot) { BGC.busy = false; BGC.err = r.err || t("bg.err.create"); bgRenderCreate(); return; }
      added.push(r.bot);
    }
    bgCloseCreate();
    const g = BOTGROUPS.find((x) => x.id === gid);
    for (const nb of added) {
      if (g && !bgBot(g, nb.id)) g.bots.push(nb);
      await bgStartBot(g, nb, "加 Bot");
    }
    sendCtrl({ type: "log", msg: `Bot Group：${gid} 加了 ${added.length} 个 Bot（${added.map((x) => x.id).join(",")}）` });
    bgSchedule();
    return;
  }
  const input = {
    name: BGC.name.trim(), goal: BGC.goal.trim(), project: BGC.project, budget: BGC.budget || 0,
    bots: BGC.bots.map((b) => ({ role: b.role.trim(), agent: b.agent })),
  };
  if (src) Object.assign(input, { sourcePane: src.paneID | 0, sourceAgent: (src.spec && src.spec.agent) || "", sourceTitle: currentTabTitle(src) });
  else input.managerAgent = BGC.manager;
  const r = await bgRequest({ type: "botgroup.create", botgroup: input });
  if (!BGC) return;
  if (!r.ok || !r.group) {
    BGC.busy = false; BGC.err = r.err || t("bg.err.create");
    bgRenderCreate();
    return;
  }
  const g = r.group;
  bgCloseCreate();
  bgPickGroup(g.id);
  BG.focus = "all";
  // 组清单的推送和回执几乎同时到；先把这份放进去，免得下面起格时找不到组。
  if (!BOTGROUPS.some((x) => x.id === g.id)) { BOTGROUPS.push(g); BG_EVENTS.set(g.id, []); }
  if (src) bgAdoptTab(src, g.id, "manager", "衍生 Bot Group");
  if (SETTINGS.topMode !== "botgroup" && typeof topModePick === "function") topModePick("botgroup");
  else if (typeof NAV_HERE !== "undefined" && NAV_HERE !== "workspace") setNavView("workspace");
  bgSchedule();
  // 逐个起格（同时发一串 tab.new 会互相顶，见 ctl-stream-must-not-block-on-reload）。
  for (const b of g.bots || []) {
    if (b.manager && src) continue;
    await bgStartBot(g, b, "建组");
  }
  sendCtrl({ type: "log", msg: `Bot Group：建组完成 ${g.id}「${g.name}」${src ? "衍生" : "独立"}，${(g.bots || []).length} 个成员` });
  bgSchedule();
}

/* ---------- 聊天：发给谁、怎么送、回复怎么回来 ----------
   发给谁：群聊里不 @ = Manager；@某个成员 = 它；@全员 = 所有成员。单聊 = 那一个。
   怎么送：把这句话写进那一格的终端并回车（bracketed paste，多行也是一条消息）。
     · 只在它**空闲**时送：正在干活 / 等你批的时候插一句进去，会被当成对当前问题的回答；
     · 它没起来就先起（bgStartBot），起来稳一会儿再送（TUI 刚画出来时输入框还没就绪）；
     · 第一次给这一格发话时带一句身份说明（组名、它的分工、目标）——
       团队规则的完整注入是阶段 C 的事，这里先让它知道自己是谁。
   回复怎么回来：从群里发出的那一轮，等它**稳定空闲**后，把这一轮里它说的话（transcript 的
     text）收成一条，贴回群里（记进过程流，重启还在）。单聊的不贴群：那是你们俩的事。 */
const BG_Q = new Map();            // "gid/bot" → [{text, origin}]
const BG_STARTING = new Set();     // "gid/bot"：正在起格，别重复起
const BG_ALL_RE = /@(全员|all|everyone)(?=\s|$)/i;

function bgMembers(g) { return g ? (g.bots || []) : []; }
/* 群聊里这条消息发给谁。按分工名从长到短匹配，免得「开发」吃掉「开发二」的前缀。 */
function bgTargets(g, text) {
  const all = bgMembers(g);
  if (BG_ALL_RE.test(text)) return { targets: all, all: true };
  const hit = [];
  const names = all.map((b) => ({ b, names: [b.role, b.manager ? "Manager" : ""].filter(Boolean) }))
    .flatMap((x) => x.names.map((n) => ({ b: x.b, n }))).sort((a, b) => b.n.length - a.n.length);
  let rest = text;
  for (const { b, n } of names) {
    const re = new RegExp("@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$|[，,。.:：!！?？])", "i");
    if (re.test(rest)) { if (!hit.includes(b)) hit.push(b); rest = rest.replace(re, " "); }
  }
  if (hit.length) return { targets: hit, all: false };
  const mgr = bgManager(g);
  return { targets: mgr ? [mgr] : [], all: false, dflt: true };
}
function bgTargetLabel(g, r) {
  if (r.all) return "@" + t("bg.chat.everyone");
  return r.targets.map((b) => "@" + (b.manager ? "Manager" : b.role)).join(" ");
}

function bgSend(g, text, why) {
  if (!g || !text.trim()) return false;
  const direct = BG.focus !== "all" ? bgBot(g, BG.focus) : null;
  const r = direct ? { targets: [direct] } : bgTargets(g, text);
  if (!r.targets.length) { showToast(t("bg.chat.noTarget"), "", "err"); return false; }
  const origin = direct ? "direct" : "group";
  if (origin === "group") {
    sendCtrl({ type: "botgroup.event", id: g.id, event: { bot: "you", kind: "msg", title: bgTargetLabel(g, r), text } });
  }
  for (const b of r.targets) {
    const k = g.id + "/" + b.id;
    if (!BG_Q.has(k)) BG_Q.set(k, []);
    BG_Q.get(k).push({ text, origin });
  }
  sendCtrl({ type: "log", msg: `Bot Group：${origin === "group" ? "群聊" : "单聊"}发给 ${r.targets.map((b) => b.id).join(",")}（${text.length} 字，${why || ""}）` });
  bgPumpAll();
  bgSchedule(true);
  return true;
}

function bgPumpAll() {
  for (const [k, q] of BG_Q) {
    if (!q.length) { BG_Q.delete(k); continue; }
    const [gid, bid] = k.split("/");
    const g = BOTGROUPS.find((x) => x.id === gid);
    const b = bgBot(g, bid);
    if (!g || !b) { BG_Q.delete(k); continue; }
    const tab = bgTabOf(b);
    if (!tab || tab.connDown) {
      if (!BG_STARTING.has(k)) {
        BG_STARTING.add(k);
        bgStartBot(g, b, "有消息要送").finally(() => BG_STARTING.delete(k));
      }
      continue;
    }
    if (!tab.ready || !tab.stream || Date.now() - (tab.bgBorn || Date.now()) < 3000) continue;
    if (bgBotState(b) !== "idle") continue;
    if (tab.bgSentAt && Date.now() - tab.bgSentAt < 1500) continue;
    bgWrite(g, b, tab, q.shift());
  }
}

function bgWrite(g, b, tab, item) {
  let body = item.text;
  if (!tab.bgIntro) {
    tab.bgIntro = true;
    body = t("bg.chat.intro", { group: g.name, role: b.manager ? "Manager" : b.role, goal: g.goal || "—",
      team: bgMembers(g).map((x) => (x.manager ? "Manager" : x.role) + "(" + bgAgentName(x.agent) + ")").join("、") })
      + (b.instructions ? "\n" + t("bg.chat.introAbout", { text: b.instructions }) : "") + "\n\n" + body;
  }
  const bp = !!(tab.term && tab.term.modes && tab.term.modes.bracketedPasteMode);
  const payload = bp ? "\x1b[200~" + body.replace(/\r?\n/g, "\r") + "\x1b[201~" : body.replace(/\s*\r?\n\s*/g, " ");
  tab.stream.send(enc.encode(payload));
  // 粘贴和回车分开送：同一包里的 \r 会被一些 TUI 当成粘贴内容里的换行。
  setTimeout(() => { try { if (tab.stream) tab.stream.send(enc.encode("\r")); } catch (_) {} }, 160);
  tab.bgSentAt = Date.now();
  sendCtrl({ type: "log", msg: `Bot Group：送达 ${g.id}/${b.id} tab=${tab.id} ${bp ? "bracketed" : "单行"} ${body.length} 字（${item.origin}）` });
  bgSchedule(true);
}

/* ---------- 输入框 ---------- */
function bgComposerSync(g) {
  const ta = $("bg-input");
  if (!ta) return;
  const direct = BG.focus !== "all" ? bgBot(g, BG.focus) : null;
  const ph = direct ? t("bg.composer.phDirect", { role: direct.manager ? "Manager" : direct.role }) : t("bg.composer.ph");
  if (ta.placeholder !== ph) ta.placeholder = ph;
  bgComposerTo(g);
}
// 脚注那一行：原来的提示字。
function bgComposerTo(g) {
  const hint = $("bg-chint");
  if (!hint) return;
  const h = BG.focus !== "all" ? t("bg.chat.hintDirect") : t("bg.composer.hint");
  if (hint.textContent !== h) hint.textContent = h;
}
function bgAutosize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(168, Math.max(22, ta.scrollHeight)) + "px";
}
/* @ 提及：光标前是「@xxx」时弹出成员表（群聊里才有）。 */
const BGM = { open: false, items: [], idx: 0, start: 0 };
function bgMentionUpdate() {
  const ta = $("bg-input"), box = $("bg-mention");
  const g = bgGroup();
  if (!ta || !box || !g || BG.focus !== "all") { bgMentionClose(); return; }
  const pre = ta.value.slice(0, ta.selectionStart);
  const m = /(^|\s)@([^\s@]*)$/.exec(pre);
  if (!m) { bgMentionClose(); return; }
  const q = m[2].toLowerCase();
  const items = [...bgMembers(g).map((b) => ({ b, name: b.manager ? "Manager" : b.role })), { all: true, name: t("bg.chat.everyone") }]
    .filter((it) => !q || it.name.toLowerCase().includes(q) || (it.b && bgAgentName(it.b.agent).toLowerCase().includes(q)));
  if (!items.length) { bgMentionClose(); return; }
  BGM.open = true; BGM.items = items; BGM.start = pre.length - m[2].length - 1;
  BGM.idx = Math.min(BGM.idx, items.length - 1);
  box.hidden = false;
  box.innerHTML = items.map((it, i) => {
    const st = it.b ? bgBotState(it.b) : "";
    return `<div class="bg-mi${i === BGM.idx ? " on" : ""}" role="option" data-mi="${i}" style="--lane:${it.b ? bgColor(g, it.b.id) : "var(--bg-muted)"}">`
      + `<span class="bg-ri">${it.b ? bgAgentIco(it.b.agent) : bgIco("user", 12)}</span><b>${esc(it.name)}</b>`
      + `<span class="bg-mi-s">${esc(it.b ? bgAgentName(it.b.agent) + " · " + t(BG_STATE_KEY[st]) : t("bg.chat.everyoneSub"))}</span></div>`;
  }).join("");
}
function bgMentionClose() {
  BGM.open = false; BGM.idx = 0;
  const box = $("bg-mention");
  if (box && !box.hidden) { box.hidden = true; box.innerHTML = ""; }
}
function bgMentionPick(i) {
  const ta = $("bg-input");
  const it = BGM.items[i];
  if (!ta || !it) return;
  const caret = ta.selectionStart;
  const ins = "@" + it.name + " ";
  ta.value = ta.value.slice(0, BGM.start) + ins + ta.value.slice(caret);
  const p = BGM.start + ins.length;
  ta.setSelectionRange(p, p);
  bgMentionClose();
  bgAutosize(ta);
  bgComposerTo(bgGroup());
  ta.focus();
}
function bgSubmit(why) {
  const ta = $("bg-input");
  const g = bgGroup();
  if (!ta || !g) return;
  if (bgSend(g, ta.value.trim(), why)) {
    ta.value = "";
    bgAutosize(ta);
    bgComposerTo(g);
  }
}
function bgBindComposer() {
  const ta = $("bg-input");
  if (!ta) return;
  ta.addEventListener("input", () => { bgAutosize(ta); bgMentionUpdate(); bgComposerTo(bgGroup()); });
  ta.addEventListener("click", bgMentionUpdate);
  ta.addEventListener("blur", () => setTimeout(bgMentionClose, 120));
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;   // 输入法组字中：回车是选词，不是发送
    if (BGM.open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        BGM.idx = (BGM.idx + (e.key === "ArrowDown" ? 1 : -1) + BGM.items.length) % BGM.items.length;
        bgMentionUpdate();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); bgMentionPick(BGM.idx); return; }
      if (e.key === "Escape") { e.preventDefault(); bgMentionClose(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); bgSubmit("回车"); }
  });
  $("bg-mention").addEventListener("mousedown", (e) => {
    const it = e.target.closest("[data-mi]");
    if (it) { e.preventDefault(); bgMentionPick(+it.dataset.mi); }
  });
  $("bg-send").addEventListener("click", () => bgSubmit("发送键"));
  $("bg-cbox").addEventListener("mousedown", (e) => {
    if (e.target === ta || e.target.closest("button")) return;
    e.preventDefault();
    ta.focus();
  });
}
setInterval(() => {
  if (BG_Q.size) bgPumpAll();
  // 「等你」卡的可点与否来自读屏，屏变了不会有事件：页面开着且有人在等时每秒重画一次。
  if (document.body.classList.contains("botgroup")) {
    const g = bgGroup();
    if (g && bgMembers(g).some((b) => { const s = bgBotState(b); return s === "waiting" || s === "working"; })) bgSchedule();
  }
}, 700);

/* ---------- 交互 ---------- */
/* 「等你」卡里的动作：和 Workspaces 群组看板（50-ask.js 末尾那段）同一套落点与闸，
   只是「去那一格」换成打开这个 Bot 的终端抽屉。有选中文本时不动作（卡要能读、能复制）。 */
function bgCardClick(e) {
  const wrap = e.target.closest("[data-bg-tab]");
  if (!wrap) return false;
  const tab = TAB_LIST.find((x) => x.id === (wrap.dataset.bgTab | 0));
  if (!tab) return true;
  const selected = () => { const s = window.getSelection(); return !!(s && !s.isCollapsed && s.toString().trim()); };
  if (e.target.closest("[data-go],[data-go-ask]")) { botOpenTerminal(tab); return true; }
  const pm = e.target.closest("[data-perm-more]");
  if (pm) { if (!selected()) { togglePermOpen(pm.dataset.permMore || ""); bgSchedule(); } return true; }
  const pb = e.target.closest("[data-perm]");
  if (pb) { if (!selected()) { permFromGroup(tab, pb); bgSchedule(); } return true; }
  const opt = e.target.closest(".gopt");
  if (opt) { if (!selected()) { answerFromGroup(tab, opt); bgSchedule(); } return true; }
  const sub = e.target.closest("[data-submit-ask]");
  if (sub) { if (!selected()) { submitFromGroup(tab, sub); bgSchedule(); } return true; }
  const st = e.target.closest("[data-jstep]");
  if (st) { if (!selected()) jumpToQuestion(tab, st); return true; }
  if (e.target.closest("[data-ask-open]")) { toggleAskOpen(tab, e.target.closest(".gask")); return true; }
  return true;
}
function bgFocus(gid, focus, why) {
  if (gid && gid !== BG.group) bgPickGroup(gid);
  BG.focus = focus || "all";
  bgMentionClose();
  renderBotGroup(why);
  const ta = $("bg-input");
  if (ta) ta.focus({ preventScroll: true });
}
{
  const root = $("bg");
  if (root && !root.dataset.bound) {
    root.dataset.bound = "1";
    root.addEventListener("input", (e) => {
      if (e.target.id === "bg-q") { BG.query = e.target.value; renderBotGroup(); }
    });
    root.addEventListener("click", (e) => {
      if (bgCardClick(e)) return;
      const more = e.target.closest("[data-bg-more]");
      if (more) {
        const k = more.dataset.bgMore;
        if (BG.open.has(k)) BG.open.delete(k); else BG.open.add(k);
        renderBotGroup();
        return;
      }
      const cfgBtn = e.target.closest("[data-bg-cfg]");
      if (cfgBtn) {
        const g = BOTGROUPS.find((x) => x.id === (cfgBtn.dataset.bgGroup || BG.group)) || bgGroup();
        if (g && g.id !== BG.group) { bgPickGroup(g.id); BG.focus = "all"; renderBotGroup("选组"); }
        if (g) bgOpenDrawer(g.id, cfgBtn.dataset.bgCfg);
        return;
      }
      const termBtn = e.target.closest("[data-bg-term]");
      if (termBtn) {
        const g = BOTGROUPS.find((x) => x.id === (termBtn.dataset.bgGroup || BG.group)) || bgGroup();
        const b = bgBot(g, termBtn.dataset.bgTerm);
        if (b) bgStartBot(g, b, "页面按钮").then((tab) => { if (tab) botOpenTerminal(tab); });
        return;
      }
      const act = e.target.closest("[data-bg-act]");
      if (act) {
        const a = act.dataset.bgAct;
        const g = bgGroup();
        if (a === "theme") {
          // 页头这颗是全局主题的快捷开关（和设置 › 外观是同一份设置）。
          const next = document.documentElement.classList.contains("theme-light") ? "dark" : "light";
          SETTINGS.theme = next;
          saveSettingsCache();
          applyTheme("Bot Group 页头");
          sendCtrl({ type: "settings.set", settings: { theme: next } });
        } else if (a === "addbot") {
          if (g) bgOpenCreate({ addTo: g.id });
        } else if (a === "new") {
          bgOpenCreate({});
        } else if (a === "delete") {
          bgDeleteGroup(g);
        } else if (a === "brief") {
          if (g && g.brief) sendCtrl({ type: "open", mode: "open", path: g.brief });
        } else if (a === "na") {
          showToast(act.textContent.trim(), act.title, "err");
        } else if (a === "need" || a === "focus-cur") {
          if (g && (a === "need" || BG.focus === "all")) {
            const w = (g.bots || []).find((b) => bgBotState(b) === "waiting") || bgLanes(g)[0];
            if (w) bgFocus(g.id, w.id, "聚焦");
          }
        }
        return;
      }
      const ev = e.target.closest(".bg-ev.has-body > .bg-ev-h");
      if (ev) {
        const k = ev.parentElement.dataset.bgEv;
        if (BG.open.has(k)) BG.open.delete(k); else BG.open.add(k);
        renderBotGroup();
        return;
      }
      // 左栏点成员 = 聚焦它（和它单聊）；再点一次 = 回到全部车道（定稿的交互）。
      const f = e.target.closest("[data-bg-focus]");
      if (f) {
        const want = f.dataset.bgFocus;
        const same = BG.focus === want && want !== "all" && (!f.dataset.bgGroup || f.dataset.bgGroup === BG.group);
        bgFocus(f.dataset.bgGroup || BG.group, same ? "all" : want, "选车道");
        return;
      }
      const gm = e.target.closest("[data-bg-gmenu]");
      if (gm) { bgGroupMenu(gm.dataset.bgGmenu, gm); return; }
      const gh = e.target.closest(".bg-gh");
      if (gh) bgFocus(gh.dataset.bgGroup, "all", "选组");
    });
    window.addEventListener("resize", () => {
      if (document.body.classList.contains("botgroup")) { const ts = $("bg-tscroll"); if (ts) ts.__html = ""; renderBotGroup(); }
    });
  }
  const head = $("bg-dock-head");
  if (head && !head.dataset.bound) {
    head.dataset.bound = "1";
    head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-bgd]");
      if (!b) return;
      if (b.dataset.bgd === "close") bgCloseDock();
      else if (b.dataset.bgd === "resume" && BG.dock) {
        const tab = BG.dock;
        resumeAgentInSeat(tab).then(() => {
          const nt = TAB_LIST.find((x) => x.group === tab.group && x.bot === tab.bot && !x.connDown);
          if (nt) botOpenTerminal(nt);
        });
      }
    });
  }
  // 状态读数的「几分钟前」要自己走：没有事件时页面不会重画。
  setInterval(() => { if (document.body.classList.contains("botgroup")) bgSchedule(); }, 30000);
  if (SETTINGS.topMode === "botgroup") renderBotGroup("启动");
}
