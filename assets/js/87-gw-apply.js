"use strict";
/* 87-gw-apply.js —— 网关/控制面推送的落点（applyGw / applyMagpie）。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 10841-10889（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

/* 控制面整份读数到达。网关页现在内嵌 magpie 自己的界面（iframe），
   Perch 只需要知道「连上没有 / 端口是多少」来决定是否设 iframe 的 src；
   供应商、账号、路由、用量、插件的数据都由那个页面自己取。 */
function applyGw(g) {
  if (!g || typeof g !== "object") return;
  GW = g;
  GW_BUSY = "";
  if (!g.connected) {
    if (NAV_HERE === "dash" && dashTab === "gateway") renderGateway();
    return;
  }
  // 接上了就把自动接入的尝试次数清零：以后进程真掉了，还有三次自动恢复的机会。
  gwAutoTries = 0;
  if (NAV_HERE === "dash" && dashTab === "gateway") renderGateway();
}

/* 断开预览的落点（agent_cfg.go → {type:"gw.agent.preview"}）。
   只接受当前抽屉那个 agent 的答案；晚到的旧预览不能覆盖新打开的那个。 */
function applyGwPreview(m) {
  if (!m || !AC_ID || m.id !== AC_ID) return;
  AC_PREVIEW = m.preview || null;
  renderAgentDrawer();
}

/* Agent 接线状态的落点（agent_cfg.go → {type:"gw.agents"}）。
   只做三件事：把 agents 放进 GW_AGENTS、清掉这次动作的忙碌标记、重画名单
   和抽屉。具体画成什么样在 85（名单）与 88（抽屉）。 */
function applyGwAgents(m) {
  if (!m || typeof m !== "object") return;
  // 预览失败不是错误：非 native agent（配置在 home 之外）本来就给不出 dry run，
  // 断开照样成立。把它记进 AC_PREVIEW，抽屉里用通用说明兜底。
  if (m.op === "preview") {
    if (AC_ID && m.id === AC_ID) {
      AC_PREVIEW = m.err ? { changes: null, error: m.err } : (m.preview || null);
      renderAgentDrawer();
    }
    return;
  }
  GW_AGENTS_NOTICE = m.notice || "";
  if (Array.isArray(m.agents)) GW_AGENTS = m.agents;
  // 任何一次动作（读/写/接入/断开/重应用）回来都结束了忙碌态。
  AC_BUSY = "";
  if (m.err) {
    GW_AGENTS_ERR = m.err;
    if (AC_ID && (!m.id || m.id === AC_ID)) AC_ERR = m.err;
  } else {
    GW_AGENTS_ERR = "";
    AC_ERR = "";
  }
  renderDashAgents();
  renderAgentDrawer();
}

/* 漂移轮询的落点（agent_cfg.go → {type:"gw.agents.drift"}）。
   /api/drift 只给"现在漂着的"：不在映射里的 agent 要把旧 drift 清掉。
   只有真的变了才重画；抽屉正在写字段或开着选择器时先不重画（会把操作打断），
   下一次动作回来的整份 state 会补上。 */
function applyGwAgentsDrift(m) {
  if (!m || typeof m !== "object" || !Array.isArray(GW_AGENTS)) return;
  const d = m.drift && typeof m.drift === "object" ? m.drift : {};
  let changed = false;
  for (const a of GW_AGENTS) {
    const next = d[a.id] || null;
    if (JSON.stringify(next) !== JSON.stringify(a.drift || null)) {
      if (next) a.drift = next;
      else delete a.drift;
      changed = true;
    }
  }
  if (!changed) return;
  renderDashAgents();
  if (!AC_PICK && !AC_BUSY) renderAgentDrawer();
}

/* magpie 快照到达（shell 首帧 + 每 2.5s 的推送都走这里）。
   只重画「变了的那几块」：状态条/读数/实时是秒级；热力图只在序列变了时重画
   （371 个格子每 2.5s 重排一次没有意义，还会打断 hover）；名单只在安装状态
   或今日流量变了时重画。网关页可见时整页重画 —— 它的数据本来就来自这份快照。 */
function applyMagpie(s) {
  if (!s || typeof s !== "object") return;
  MAGPIE = s;
  const sig = JSON.stringify([s.state, (s.series || []).length,
    (s.series || []).reduce((n, x) => n + (x.calls | 0), 0), (s.today || {}).calls]);
  const catSig = JSON.stringify((s.catalog || []).map((a) => [a.id, !!a.installed, a.calls | 0]));
  const seriesChanged = sig !== MG_SIG;
  const catChanged = catSig !== MG_CAT_SIG;
  MG_SIG = sig;
  MG_CAT_SIG = catSig;

  if (NAV_HERE !== "dash") return;
  renderDashStatus();
  renderDashKpis();
  renderDashLiveFeed();
  renderDashMix();
  renderDashLat();
  if (seriesChanged) renderHeat();
  if (catChanged) renderDashAgents();
  // 网关页只在「未接入」时才需要重画那张卡；接上之后 iframe 不归这里管。
  if (dashTab === "gateway") renderGateway();
  dashProbe(`magpie=${s.state}`, 0);
}
