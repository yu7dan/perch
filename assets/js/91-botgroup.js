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

/* ---------- 状态跃迁 → 过程流 ----------
   renderAgentDot 每 400–700ms 就可能叫一次，这里只在**折过之后的状态**变了才动。
   working ↔ idle 在一轮里会抖（标题字形、hook 先后），稳 1.2s 才记；
   「等你」立刻记（那是这页最要紧的一件事）。
   刚上线的第一个 idle 不记（「上线」那条已经说了）。 */
const BG_EV_OF = { working: "working", ask: "waiting", idle: "idle", unread: "idle", off: "stopped", failed: "fail" };
function botStateChanged(tab, s) {
  const k = BG_EV_OF[s] || "idle";
  if (!tab.bgBorn) tab.bgBorn = Date.now();
  if (tab.botShown !== k) {
    tab.botShown = k;
    tab.bgIdleSince = k === "idle" ? Date.now() : 0;
    if (k === "working" && tab.bgRoute) tab.bgRoute.sawWork = true;
    bgSchedule();
  }
  if (tab.botLast === undefined) {
    tab.botLast = k === "idle" ? "idle" : "";
    if (k === "idle") return;
  }
  if (k === tab.botPend && tab.botTimer) return;
  tab.botPend = k;
  clearTimeout(tab.botTimer);
  const commit = () => {
    tab.botTimer = 0;
    if (tab.botPend === tab.botLast || !tab.group || !TAB_LIST.includes(tab)) return;
    tab.botLast = tab.botPend;
    sendCtrl({ type: "botgroup.event", id: tab.group, event: { bot: tab.bot, kind: tab.botPend, title: "" } });
  };
  if (k === "waiting") commit();
  else tab.botTimer = setTimeout(commit, 1200);
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
    cwd: g.project,
    target: sid ? "legacy" : "directory",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    paneId: bot.paneId || undefined,
    group: g.id, bot: bot.id,
  };
  sendCtrl({ type: "log", msg: `Bot Group：起格 ${g.id}/${bot.id} agent=${spec.agent} pane=${bot.paneId || 0} resume=${spec.resume.kind}（${why || ""}）` });
  const nt = await createTab(spec);
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
  const sel = on && BG.focus === b.id;
  const docked = BG.dock && bgTabOf(b) === BG.dock;
  const sub = b.manager
    ? (g.source && g.source.kind === "derived" ? t("bg.list.derivedMgr") : bgAgentName(b.agent))
    : (b.task || bgAgentName(b.agent));
  return `<div class="bg-row${b.manager ? " bg-mgr" : ""}${sel ? " sel" : ""}${docked ? " docked" : ""}" data-bg-group="${esc(g.id)}" data-bg-focus="${esc(b.id)}" style="--lane:${bgColor(g, b.id)}">`
    + `<span class="bg-ri">${bgAgentIco(b.agent)}</span>`
    + `<span class="bg-rmain"><span class="bg-rt ell"><b>${esc(b.role)}</b> · ${esc(t(BG_STATE_KEY[st]))}</span>`
    + `<span class="bg-rs ell">${esc(sub)}</span></span>`
    + `<button type="button" class="bg-rterm" data-bg-term="${esc(b.id)}" data-bg-group="${esc(g.id)}" title="${esc(t(st === "pending" || st === "off" ? "bg.feed.startTitle" : "bg.feed.openTermTitle"))}">${bgIco(st === "pending" || st === "off" ? "play" : "term", 12)}</button>`
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
    + `<label class="search bg-search">${bgIco("search", 13)}<input id="bg-q" placeholder="${esc(t("bg.list.search"))}" spellcheck="false" value="${esc(BG.query || "")}"></label>`
    + `<div class="bg-lscroll">${groups}${empty}</div>`
    + `<div class="bg-lfoot"><span>${esc(t("bg.list.running", { n: working }))}</span>`
    + `<span class="${waiting ? "bg-ask-t" : ""}">${esc(t("bg.list.waiting", { n: waiting }))}</span></div>`;
}

/* ---------- 中上：交接链 ----------
   阶段 B 还没有交接：每条车道就是「Manager → 这个 Bot」（组的分工本身）。
   阶段 C 的 handoff 事件会接在后面。 */
function bgChip(g, b, cur) {
  const you = !b;
  const cls = "bg-chip" + (cur ? " cur" : "") + (you ? " you" : "");
  const ico = you ? `<span class="bg-ci">${bgIco("user", 12)}</span>` : `<span class="bg-ci">${bgAgentIco(b.agent)}</span>`;
  const who = you ? t("bg.chain.you") : (b.manager ? "Manager" : bgAgentName(b.agent));
  return `<span class="${cls}" style="--lane:${bgColor(g, b ? b.id : "")}">${ico}<span>${esc(who)}</span></span>`;
}
function bgChainHTML(g) {
  const mgr = bgManager(g);
  return bgLanes(g).map((b) => {
    const sel = BG.focus === b.id;
    const st = bgBotState(b);
    const chips = [bgChip(g, mgr, false), bgChip(g, b, st === "working")];
    if (st === "waiting") chips.push(bgChip(g, null, true));
    return `<div class="bg-chain-row${sel ? " sel" : ""}${BG.focus !== "all" && !sel ? " mute" : ""}" data-bg-focus="${esc(b.id)}">`
      + `<span class="bg-lane-l" style="--lane:${bgColor(g, b.id)}"><i></i><span class="ell">${esc(b.role)}</span></span>`
      + `<span class="bg-chips">${chips.join(`<span class="bg-arrow">→</span>`)}</span></div>`;
  }).join("");
}

/* ---------- 中：过程流（= 群聊）/ 单聊 ----------
   版式就是定稿的那一套（用户 2026-10-28 明确要求还原，别另起一套聊天皮）：
     · 发言 = .bg-msg（图标 + 名字 + 车道标 + 时间，下面正文）；
     · 事件 = .bg-ev 行（符号 + 车道标 + 标题 + 时间）；
     · 正在处理 = .bg-ev.run；等你确认 = .bg-ev.ask 展开态（盾牌一行 + .bg-opt 选项）。
   全部车道 = 群聊：组的过程流（你说的、成员回的、状态事件）按时间交错。
   聚焦一个成员 = 和它单聊：那一格自己的对话（LIVE.acts；没在跑就退回盘上记录）。 */
function bgEventRow(g, e, showBadge) {
  const key = g.id + ":" + e.id;
  const open = BG.open.has(key);
  const lane = bgEvLane(e);
  const color = bgColor(g, lane);
  const cls = "bg-ev" + (e.kind === "waiting" || e.kind === "approval" ? " ask" : "")
    + (e.kind === "fail" ? " bad" : "") + (open ? " open" : "") + (e.text ? " has-body" : "");
  const caret = e.text ? `<span class="bg-caret">${bgIco("chev", 11)}</span>` : `<span class="bg-caret blank"></span>`;
  const body = open && e.text ? `<div class="bg-ev-body"><div class="bg-ev-sum">${esc(e.text)}</div></div>` : "";
  return `<div class="${cls}" data-bg-ev="${esc(key)}" style="--lane:${color}">`
    + `<div class="bg-ev-h">${caret}<span class="bg-ev-g">${bgGlyph(e.kind, color)}</span>`
    + (showBadge ? bgBadge(g, lane) : "")
    + `<span class="bg-ev-t ell">${esc(bgEvTitle(g, e))}</span>`
    + `<span class="bg-ev-r">${esc(bgTime(e.ts))}</span></div>${body}</div>`;
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
  const evs = bgEvents(g);
  if (!evs.length) return `<div class="bg-empty">${esc(t("bg.feed.empty"))}</div>`;
  return evs.map((e) => e.kind === "msg" ? bgMsgHTML(g, e, true) : bgEventRow(g, e, true)).join("");
}

/* 单聊：那一格的对话。工具调用是一行 .bg-ev（图例里的「工具调用」小点），thinking 不出。
   第一条消息前面那段身份说明（bgWrite 加的）是给 agent 看的，这里不显示。 */
function bgConvHTML(g, b) {
  const tab = bgTabOf(b);
  const v = tab ? LIVE.get(tab.id) : null;
  const acts = (v && v.acts) || [];
  const color = bgColor(g, b.id);
  const who = b.manager ? "Manager" : bgAgentName(b.agent);
  const ico = bgAgentIco(b.agent);
  const you = (text, at) => {
    let s = text || "";
    if (/^\[Perch Bot Group/.test(s)) { const cut = s.indexOf("\n\n"); s = cut >= 0 ? s.slice(cut + 2) : ""; }
    return s.trim() ? bgMsgRow({ you: true, who: t("bg.chain.you"), icon: bgYouIco(), color: "var(--bg-muted)", time: bgTime(at).slice(0, 5), text: s }) : "";
  };
  const rows = [];
  if (acts.length) {
    for (const a of acts) {
      if (a.kind === "prompt") rows.push(you(a.text, a.at));
      else if (a.kind === "text") rows.push(bgMsgRow({ who, icon: ico, color, time: bgTime(a.at).slice(0, 5), text: a.text }));
      else if (a.kind === "tool") {
        const k = a.ok === false ? "fail" : a.ok == null ? "running" : "dot";
        rows.push(`<div class="bg-ev${a.ok === false ? " bad" : ""}${a.ok == null ? " run" : ""}" style="--lane:${color}"><div class="bg-ev-h">`
          + `<span class="bg-caret blank"></span><span class="bg-ev-g">${bgGlyph(k, color)}</span>`
          + `<span class="bg-ev-t">${esc(a.tool || "tool")}</span><span class="bg-ev-meta ell">${esc(a.rel || a.text || "")}</span>`
          + `<span class="bg-ev-r">${esc(bgTime(a.at))}</span></div></div>`);
      }
    }
  } else {
    const hist = (tab && tab.sessionID && STATE && STATE.history && STATE.history[tab.sessionID]) || [];
    for (const it of hist) {
      rows.push(it.role === "user" ? you(it.text, it.at)
        : bgMsgRow({ who, icon: ico, color, time: bgTime(it.at).slice(0, 5), text: it.text }));
    }
  }
  const html = rows.join("");
  return html || `<div class="bg-empty">${esc(t("bg.feed.empty"))}</div>`;
}

/* 正在发生：排队中 / 正在启动 / 正在回复（定稿里的 .bg-ev.run 那一行）。 */
function bgLiveHTML(g, members) {
  return members.map((b) => {
    const tab = bgTabOf(b);
    const q = BG_Q.get(g.id + "/" + b.id) || [];
    const st = bgBotState(b);
    const route = tab && tab.bgRoute && tab.bgRoute.gid === g.id ? tab.bgRoute : null;
    let line = "";
    if (q.length) line = t(st === "pending" || st === "off" ? "bg.chat.starting" : "bg.chat.queued", { n: q.length });
    else if ((route || BG.focus === b.id) && st === "working") line = t("bg.chat.typing");
    if (!line) return "";
    let meta = "";
    if (st === "working" && tab) {
      const since = route ? route.at - 1500 : (tab.bgSentAt || 0) - 1500;
      const acts = (LIVE.get(tab.id) || {}).acts || [];
      for (let i = acts.length - 1; i >= 0; i--) {
        const a = acts[i];
        if (Date.parse(a.at) < since) break;
        if (a.kind === "tool") { meta = (a.tool || "") + " · " + (a.rel || a.text || ""); break; }
        if (a.kind === "text" && a.text) { meta = a.text; break; }
      }
    }
    return `<div class="bg-ev run" style="--lane:${bgColor(g, b.id)}"><div class="bg-ev-h"><span class="bg-caret blank"></span>`
      + `<span class="bg-ev-g">${bgGlyph(st === "working" ? "running" : "wait")}</span>${bgBadge(g, b.id)}`
      + `<span class="bg-ev-t">${esc(line)}</span>`
      + (meta ? `<span class="bg-ev-meta ell">${esc(meta.replace(/\s+/g, " ").slice(0, 120))}</span>` : "")
      + `</div></div>`;
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
  return `<div class="bg-ev ask open" data-bg-tab="${tab.id}" style="--lane:${color}">`
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

function bgTermBtn(b) {
  const st = bgBotState(b);
  const start = st === "pending" || st === "off";
  return `<button type="button" class="bg-ghost" data-bg-term="${esc(b.id)}" title="${esc(t(start ? "bg.feed.startTitle" : "bg.feed.openTermTitle"))}">`
    + `${bgIco(start ? "play" : "term", 13)}<span>${esc(t(start ? (st === "off" ? "bg.feed.resume" : "bg.feed.start") : "bg.feed.openTerm"))}</span></button>`;
}
function bgFeedHeadHTML(g) {
  if (BG.focus === "all") {
    return `<span class="bg-fh-t"><b>${esc(t("bg.feed.allLanes"))}</b><span class="bg-fh-s">${esc(t("bg.feed.allSub", { n: (g.bots || []).length }))}</span></span>`
      + `<span class="bg-fh-r">${esc(t("bg.feed.clickHint"))}</span>`;
  }
  const b = bgBot(g, BG.focus);
  if (!b) return "";
  return `<span class="bg-fh-t">${bgBadge(g, b.id)}<b>${esc(bgAgentName(b.agent))}${b.task ? " · " + esc(b.task) : ""}</b></span>`
    + bgTermBtn(b);
}

/* ---------- 右：工作树 · 泳道 ---------- */
function bgLaneTabsHTML(g) {
  const evs = bgEvents(g);
  return bgLanes(g).map((b) => {
    const sel = BG.focus === b.id;
    const st = bgBotState(b);
    let last = null;
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].bot === b.id) { last = evs[i]; break; }
    return `<button type="button" class="bg-lt${sel ? " sel" : ""}" data-bg-focus="${esc(b.id)}" style="--lane:${bgColor(g, b.id)}">`
      + `<span class="bg-lt-n"><i></i><span class="ell">${esc(b.role)}</span></span>`
      + `<span class="bg-lt-a">${bgAgentIco(b.agent)}<span class="ell">${esc(bgAgentName(b.agent))}</span></span>`
      + `<span class="bg-lt-s ell" data-state="${esc(st)}">${esc(t(BG_STATE_KEY[st]))}${last ? " · " + esc(bgAgo(last.ts)) : ""}</span></button>`;
  }).join("");
}

/* 泳道图：每条车道一列竖线，事件按时间往下排（所有车道共享一条时间轴，
   同一时刻发生的事在同一高度上）。Manager 的事件和对话不进图（它在过程流里）。
   只画最近 60 条：再往前的在过程流里翻。 */
function bgTreeSVG(g, width) {
  const lanes = bgLanes(g);
  const evs = bgEvents(g).filter((e) => e.kind !== "msg" && e.bot && e.bot !== "manager" && lanes.some((b) => b.id === e.bot)).slice(-60);
  if (!lanes.length || !evs.length) return "";
  const colW = Math.max(70, Math.floor((width - 16) / lanes.length));
  const x0 = 14;
  const xOf = (id) => { const i = lanes.findIndex((b) => b.id === id); return x0 + (i < 0 ? 0 : i) * colW; };
  const rowH = 34, top = 18;
  const ys = evs.map((_, i) => top + i * rowH);
  const H = top + evs.length * rowH + 40;
  const focus = BG.focus;
  const parts = [];
  lanes.forEach((b) => {
    const idx = evs.map((e, i) => (e.bot === b.id ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const x = xOf(b.id), y1 = ys[idx[0]], y2 = ys[idx[idx.length - 1]], c = bgColor(g, b.id);
    const op = focus === "all" || focus === b.id ? 1 : 0.28;
    const st = bgBotState(b);
    parts.push(`<g opacity="${op}"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${c}" stroke-width="2"/>`);
    if (st === "working" || st === "waiting") {
      parts.push(`<line x1="${x}" y1="${y2}" x2="${x}" y2="${H - 22}" stroke="${c}" stroke-width="1.4" stroke-dasharray="3 3" opacity=".55"/>`);
    }
    parts.push(`</g>`);
  });
  evs.forEach((e, i) => {
    const x = xOf(e.bot), y = ys[i], c = bgColor(g, e.bot);
    const op = focus === "all" || focus === e.bot ? 1 : 0.28;
    let node;
    switch (e.kind) {
      case "commit": node = `<circle cx="${x}" cy="${y}" r="4.5" fill="${c}"/>`; break;
      case "handoff": node = `<path d="M${x} ${y - 5.5} L${x + 5.5} ${y} L${x} ${y + 5.5} L${x - 5.5} ${y} Z" fill="${c}"/>`; break;
      case "artifact": node = `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.6"/>`; break;
      case "test": case "review": node = `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-ok)"/><path d="M${x - 2.6} ${y} l1.8 1.8 l3.4 -3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`; break;
      case "fail": node = `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-bad)"/><path d="M${x - 2.2} ${y - 2.2} l4.4 4.4 M${x + 2.2} ${y - 2.2} l-4.4 4.4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`; break;
      case "approval": case "waiting": node = `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--bg-panel)" stroke="var(--bg-ask)" stroke-width="2.2"/><circle cx="${x}" cy="${y}" r="2.2" fill="var(--bg-ask)"/>`; break;
      case "started": node = `<path d="M${x - 3.5} ${y - 5} L${x + 5} ${y} L${x - 3.5} ${y + 5} Z" fill="${c}"/>`; break;
      case "working": node = `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.5"/><path d="M${x} ${y - 5} a5 5 0 0 1 0 10 Z" fill="${c}"/>`; break;
      case "idle": node = `<circle cx="${x}" cy="${y}" r="4" fill="var(--bg-panel)" stroke="var(--bg-faint)" stroke-width="1.4"/>`; break;
      case "stopped": node = `<rect x="${x - 3.5}" y="${y - 3.5}" width="7" height="7" rx="1" fill="var(--bg-faint)"/>`; break;
      default: node = `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
    }
    const room = width - x - 14;
    const strong = e.kind === "waiting" || e.kind === "approval" ? ` class="ask"` : (e.kind === "fail" ? ` class="bad"` : "");
    parts.push(`<g opacity="${op}" data-bg-ev="${esc(g.id + ":" + e.id)}">${node}`
      + `<text x="${x + 10}" y="${y - 1}"${strong}>${esc(bgFit(bgEvTitle(g, e), room))}</text>`
      + `<text x="${x + 10}" y="${y + 10}" class="sub">${esc(bgTime(e.ts))} · #${e.id}</text></g>`);
  });
  return `<svg class="bg-tree-svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join("")}</svg>`;
}

/* 等宽 10.5px：ASCII ≈ 6.3px，CJK ≈ 10.5px。按可用宽度截断，免得最后一列压出边。 */
function bgFit(s, room) {
  let w = 0, out = "";
  for (const ch of String(s)) {
    const cw = ch.codePointAt(0) > 0x2e80 ? 10.5 : 6.3;
    if (w + cw > room - 7) return out + "…";
    w += cw; out += ch;
  }
  return out;
}

const BG_LEGEND = [
  ["started", "bg.legend.started"], ["working", "bg.legend.working"], ["waiting", "bg.legend.waitYou"], ["idle", "bg.legend.idle"],
  ["stopped", "bg.legend.stopped"], ["fail", "bg.legend.fail"], ["handoff", "bg.legend.handoff"], ["commit", "bg.legend.commit"],
  ["artifact", "bg.legend.artifact"], ["test", "bg.legend.test"], ["memory", "bg.legend.checkpoint"], ["created", "bg.legend.created"],
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
function bgTopHTML(g, waiting) {
  const light = document.documentElement.classList.contains("theme-light");
  const srcLine = g.source && g.source.kind === "derived"
    ? `<span class="bg-from">${bgIco("split", 12)}${esc(t("bg.head.derived"))} ${bgAgentIco(g.source.agent)}<b>${esc(g.source.title || bgAgentName(g.source.agent))}</b></span>`
    : `<span class="bg-from">${esc(t("bg.head.standalone"))}</span>`;
  return `<header class="bg-head">`
    +   `<div class="bg-title"><h2 class="ell">${esc(g.name)}</h2><span class="bg-proj mono ell" title="${esc(g.project)}">${esc(g.project)}</span></div>`
    +   `<div class="bg-acts">`
    +     (waiting ? `<button type="button" class="bg-needbtn" data-bg-act="need">${bgDot("waiting")}${esc(t("bg.head.needYou", { n: waiting }))}</button>` : "")
    +     (g.brief ? `<button type="button" class="bg-btn" data-bg-act="brief" title="${esc(g.brief)}">${bgIco("file", 12)}<span>${esc(t("bg.head.brief"))}</span></button>` : "")
    +     `<button type="button" class="bg-btn na" data-bg-act="na" title="${esc(t("bg.head.laterC"))}">${bgIco("pause", 12)}<span>${esc(t("bg.head.pauseAll"))}</span></button>`
    +     `<button type="button" class="bg-btn na" data-bg-act="na" title="${esc(t("bg.head.laterC"))}">${bgIco("plus", 12)}<span>${esc(t("bg.head.addBot"))}</span></button>`
    +     `<button type="button" class="icon-btn" data-bg-act="delete" title="${esc(t("bg.head.delete"))}" aria-label="${esc(t("bg.head.delete"))}">${bgIco("trash", 14)}</button>`
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
    + `<div class="bg-tseg"><span class="segs-mini"><button type="button" class="${BG.focus === "all" ? "" : "on"}" data-bg-act="focus-cur">${esc(t("bg.tree.focus"))}</button>`
    +   `<button type="button" class="${BG.focus === "all" ? "on" : ""}" data-bg-focus="all">${esc(t("bg.tree.all"))}</button></span><span class="mono bg-now">${esc(bgTime(new Date().toISOString()).slice(0, 5))}</span></div>`
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
  }
  BG_STICK = false;
  if (why) sendCtrl({ type: "log", msg: `Bot Group 渲染（${why}）组=${BOTGROUPS.length} 当前=${g ? g.id : "-"} focus=${BG.focus} theme=${light ? "light" : "dark"}` });
}

function bgPickGroup(gid) {
  BG.group = gid || "";
  try { localStorage.setItem("perch.bg.group", BG.group); } catch (_) {}
}

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
  BGC = {
    source: src,
    name: src ? currentTabTitle(src) : "",
    goal: "",
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
  requestAnimationFrame(() => { const n = $("bgc-name"); if (n) { n.focus(); n.select(); } });
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
  if (!BGC.name.trim()) return t("bg.c.needName");
  if (!BGC.project) return t("bg.c.needProject");
  if (!BGC.source && !BGC.manager) return t("bg.c.needManager");
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
  const bots = BGC.bots.map((b, i) =>
    `<div class="bgc-bot" style="--lane:${BG_LANE_PALETTE[i % BG_LANE_PALETTE.length]}">`
    + `<div class="bgc-bot-h"><i></i><input class="ap-input bgc-role" data-bot="${i}" value="${esc(b.role)}" placeholder="${esc(t("bg.c.rolePh"))}" spellcheck="false" maxlength="24">`
    + `<button type="button" class="ap-x" data-bgc-del="${i}" title="${esc(t("bg.c.removeBot"))}" aria-label="${esc(t("bg.c.removeBot"))}">${bgIco("x", 12)}</button></div>`
    + bgAgentPicker("bot:" + i, b.agent) + `</div>`).join("");
  const full = BGC.bots.length >= BG_MAX_BOTS;
  const invalid = bgCreateInvalid();
  el.innerHTML = `<div class="ap-card bgc-card" role="document">`
    + `<div class="ap-head"><span class="ap-title">${esc(src ? t("bg.c.titleDerive") : t("bg.c.title"))}</span>`
    + `<button class="ap-x" data-bgc="close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${bgIco("x", 12)}</button></div>`
    + `<div class="ap-body">`
    +   `<p class="ap-lead">${esc(t(src ? "bg.c.leadDerive" : "bg.c.lead"))}</p>`
    +   `<div class="ap-lab">${esc(t("bg.c.name"))}</div><input class="ap-input" id="bgc-name" value="${esc(BGC.name)}" spellcheck="false" maxlength="60" placeholder="${esc(t("bg.c.namePh"))}">`
    +   `<div class="ap-lab">${esc(t("bg.c.goal"))}</div><textarea class="ap-input bgc-goal" id="bgc-goal" rows="2" spellcheck="false" placeholder="${esc(t("bg.c.goalPh"))}">${esc(BGC.goal)}</textarea>`
    +   `<div class="ap-lab">${esc(t("bg.c.project"))}</div>${projHTML}`
    +   `<div class="ap-lab">Manager</div>${mgrHTML}`
    +   `<div class="ap-lab bgc-lab">${esc(t("bg.c.bots", { n: BGC.bots.length, max: BG_MAX_BOTS }))}</div>`
    +   `<div class="bgc-bots">${bots}</div>`
    +   `<div class="bgc-add">`
    +     `<button type="button" class="ap-change${full ? " na" : ""}" data-bgc="add" title="${esc(full ? t("bg.c.full", { max: BG_MAX_BOTS }) : "")}">${bgIco("plus", 11)} ${esc(t("bg.c.addBot"))}</button>`
    +     BG_ROLE_PRESETS.map((k) => `<button type="button" class="bgc-preset${full ? " na" : ""}" data-bgc-preset="${esc(k)}">${esc(t(k))}</button>`).join("")
    +   `</div>`
    +   `<div class="ap-err">${esc(BGC.err || "")}</div>`
    + `</div>`
    + `<div class="ap-foot"><span class="bgc-note">${esc(t("bg.c.note"))}</span><span class="ap-sp"></span>`
    +   `<button type="button" data-bgc="close">${esc(t("common.cancel"))}</button>`
    +   `<button type="button" class="primary${invalid || BGC.busy ? " na" : ""}" data-bgc="create" title="${esc(invalid)}">${esc(t(BGC.busy ? "bg.c.creating" : "bg.c.create"))}</button>`
    + `</div></div>`;
}
function bgBindCreate(el) {
  el.addEventListener("input", (e) => {
    if (!BGC) return;
    const x = e.target;
    if (x.id === "bgc-name") BGC.name = x.value;
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
      if (BGC.bots.length >= BG_MAX_BOTS) { showToast(t("bg.c.full", { max: BG_MAX_BOTS }), "", "err"); return; }
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
  const input = {
    name: BGC.name.trim(), goal: BGC.goal.trim(), project: BGC.project,
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
      team: bgMembers(g).map((x) => (x.manager ? "Manager" : x.role) + "(" + bgAgentName(x.agent) + ")").join("、") }) + "\n\n" + body;
  }
  const bp = !!(tab.term && tab.term.modes && tab.term.modes.bracketedPasteMode);
  const payload = bp ? "\x1b[200~" + body.replace(/\r?\n/g, "\r") + "\x1b[201~" : body.replace(/\s*\r?\n\s*/g, " ");
  tab.stream.send(enc.encode(payload));
  // 粘贴和回车分开送：同一包里的 \r 会被一些 TUI 当成粘贴内容里的换行。
  setTimeout(() => { try { if (tab.stream) tab.stream.send(enc.encode("\r")); } catch (_) {} }, 160);
  tab.bgSentAt = Date.now();
  if (item.origin === "group") tab.bgRoute = { gid: g.id, bot: b.id, at: Date.now(), sawWork: false };
  sendCtrl({ type: "log", msg: `Bot Group：送达 ${g.id}/${b.id} tab=${tab.id} ${bp ? "bracketed" : "单行"} ${body.length} 字（${item.origin}）` });
  bgSchedule(true);
}

/* 群里派出去的那一轮收尾了没：稳定空闲 1.5s，且确实干过活（或者送出去已经 8s 了 ——
   很快的回答可能一次 working 都没被看见）。 */
function bgSettleAll() {
  const now = Date.now();
  for (const tab of TAB_LIST) {
    const r = tab.bgRoute;
    if (!r || !tab.group) continue;
    if (tab.botShown !== "idle" || !tab.bgIdleSince || now - tab.bgIdleSince < 1500) continue;
    if (!r.sawWork && now - r.at < 8000) continue;
    tab.bgRoute = null;
    const acts = (LIVE.get(tab.id) || {}).acts || [];
    const texts = acts.filter((a) => a.kind === "text" && a.text && Date.parse(a.at) >= r.at - 1500).map((a) => a.text.trim());
    let text = texts.join("\n\n");
    if (text.length > 12000) text = text.slice(0, 12000) + "\n\n…";
    if (text) sendCtrl({ type: "botgroup.event", id: r.gid, event: { bot: r.bot, kind: "msg", title: "", text } });
    sendCtrl({ type: "log", msg: `Bot Group：${r.gid}/${r.bot} 这一轮收尾，回群 ${texts.length} 段 ${text.length} 字` });
    bgSchedule(true);
  }
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
  bgSettleAll();
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
