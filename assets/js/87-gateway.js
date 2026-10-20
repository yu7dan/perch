"use strict";
/* 87-gateway.js —— 网关页 = magpie 自己的界面（同源反代，见 internal/gateway/ui.go）。
 *
 * 用户 2026-10-18 的结论：供应商的陈列/添加（含订阅）/配置页、路由、用量、
 * 插件、拖动排序，全都有现成实现，**不该由 Perch 再写一份**。只搬网关自己的
 * 那几页：Agents / Sessions / Library 与 Perch 的总览、Agent 重复，由
 * internal/gateway/ui.go 的 gwUIEmbed 从 magpie 的导航里拿掉，并把导航摆回顶部（用户明确
 * 不要 magpie 的左侧栏）。所以本文件不再渲染任何业务页面，只做四件事：
 *   1. 控制面自动接入（沿用原来的节奏：最多 3 次、间隔 15 秒）；
 *   2. 接上之后把 iframe 指到 /gwui/?view=providers（地址里没有 key）；
 *   3. 没接上时盖一张安装/接入卡（这是 Perch 的壳，不是 magpie 的页面）；
 *   4. iframe 只建一次，切页只显示/隐藏 —— 它内部的编辑状态必须保住。
 *
 * 本文件是 index.html 里按序 defer 的一段 classic script；共享全局词法作用域。 */

/* GW：控制面整份读数，由本文件后半段的 applyGw 落进来。
   GW_INSTALL：magpie 本体的行内安装器状态，由 88-install.js 更新。 */
let GW = null;
let GW_INSTALL = null;
let GW_BUSY = "";
let gwAutoAt = 0, gwAutoTries = 0;
/* 已加载的连接标记（端口 + 是否 Perch 拉起）。变了才重新设 src；
   断开时清空，重连后自然重载一次，避免看到断线期间的半截页面。 */
let GW_FRAME_AT = "";
/* 安装卡内容的指纹：magpie 快照 2.5s 推一次，不能每次都重建 DOM
   （会把按钮的 hover 和安装日志的滚动位置冲掉）。 */
let GW_COVER_SIG = "";

/* 控制面的版本 / 更新（来自 magpie 自己的 GET /api/update）。
   GW_UPD = null 表示还没读到；GW_UPD_BUSY 非空表示一条更新链路在跑
   （checking / downloading / restarting）。 */
let GW_UPD = null;
let GW_UPD_BUSY = "";
let GW_UPD_ERR = null;
let GW_UPD_TRIES = 0;
let GW_VER_SIG = "";

function gwOn() {
  return !!(GW && GW.connected);
}

function gwErrText() {
  return GW && GW.err ? tMsg(GW.errCode, GW.errParams, GW.err) : "";
}

/* embed=1 是稳定的标记，也让地址和旧缓存区分开（internal/gateway/ui.go 只在这个地址上裁剪
   页面）；view=providers 是每轮启动进来的那一页。 */
function gwFrameURL() {
  return "/gwui/?view=providers&embed=1";
}

function renderGateway() {
  if (NAV_HERE !== "dash" || dashTab !== "gateway") return;
  const frame = $("gw-frame"), cover = $("gw-cover"), ver = $("gw-ver");
  if (!frame || !cover) return;
  const m = mg();
  if (gwOn()) {
    const tag = (GW.port || 0) + ":" + (GW.ours ? "ours" : "ext");
    if (GW_FRAME_AT !== tag) {
      GW_FRAME_AT = tag;
      // 设 src 就是加载；断开时 GW_FRAME_AT 已清空，重连会重来一次。
      frame.src = gwFrameURL();
    }
    frame.hidden = false;
    cover.hidden = true;
    if (GW_COVER_SIG) { cover.innerHTML = ""; GW_COVER_SIG = ""; }
    if (ver) {
      const html = gwUpdateHTML();
      ver.hidden = !html;
      if (html !== GW_VER_SIG) { GW_VER_SIG = html; ver.innerHTML = html; }
    }
    // 版本状态只在打开网关页后问一两次：控制面没应答时别每帧重试。
    if (!GW_UPD && !GW_UPD_BUSY && GW_UPD_TRIES < 2) {
      GW_UPD_TRIES++;
      sendCtrl({ type: "magpie.update.get" });
    }
  } else {
    GW_FRAME_AT = "";
    frame.hidden = true;
    cover.hidden = false;
    if (ver) { ver.hidden = true; if (GW_VER_SIG) { ver.innerHTML = ""; GW_VER_SIG = ""; } }
    const html = gwCoverHTML(m);
    if (html !== GW_COVER_SIG) {
      GW_COVER_SIG = html;
      cover.innerHTML = html;
      const log = $("gw-inst-log");
      if (log) log.scrollTop = log.scrollHeight;
    }
    gwAutoAttach();
  }
}

/* 控制面自动接入。打开网关页就自己接（必要时拉起 `magpie web`）：
   · 没装 magpie → 什么都不做（卡片显示下载）；
   · 已连接 / 正在连 → 什么都不做；
   · 失败后最多重试 3 次、间隔 15 秒；之后留一个「重试接入」。 */
function gwAutoAttach() {
  if (NAV_HERE !== "dash" || dashTab !== "gateway") return;
  if (gwOn() || GW_BUSY === "connect") return;
  const m = mg();
  if (!m || m.state === "absent") return;
  if (gwAutoTries >= 3) return;
  if (Date.now() - gwAutoAt < 15000) return;
  gwAutoAt = Date.now();
  gwAutoTries++;
  GW_BUSY = "connect";
  sendCtrl({ type: "gw.connect" });
  bootFact(`网关 自动接入控制面（第 ${gwAutoTries} 次）`);
}

/* ---- 未接入时的那张卡 ------------------------------------------------- */

function gwCoverHTML(m) {
  const st = GW_INSTALL;
  const running = !!(st && st.state === "running");
  const installed = !!(m && m.state !== "absent");
  const version = (GW && GW.version) || (m && m.version) || "";
  const state = !m ? t("gw.state.reading")
    : !installed ? t("gw.state.absent")
    : GW_BUSY === "connect" ? t("gw.state.connecting")
    : t("gw.state.installed");
  const dot = running ? " warn" : installed ? " warn" : "";
  return `<div class="console-bar">` +
      `<span class="brand">${magpieLogo()}<b>magpie</b></span>` +
      (version ? `<span>${esc(version)}</span><span class="sep">·</span>` : "") +
      `<span class="dot${dot}"></span><span>${esc(state)}</span>` +
      `<span class="right gw-actions">` +
        `<button type="button" class="gw-btn sm" data-gw-act="refresh">${esc(t("gw.refresh"))}</button>` +
      `</span>` +
    `</div>` +
    gwInstallCard(m) +
    (gwErrText() ? `<div class="gw-msg bad">${esc(gwErrText())}</div>` : "");
}

/* 两条用户定的规则：
   · 没装 → 在 Perch 里**真的下载安装**官方 release（不跳浏览器）；
   · 已装 → 自动接入，不出现「连接 magpie」这个手动动作。
   安装日志原样摊出来，不藏进度、不假装成功。 */
function gwInstallCard(m) {
  const st = GW_INSTALL;
  const running = !!(st && st.state === "running");
  const absent = !m || m.state === "absent";
  const failed = !!(st && st.state === "failed");
  if (!absent && !running) {
    return `<div class="gw-connect">` +
      `<b>${esc(GW_BUSY === "connect" ? t("gw.connecting.title") : t("gw.installedOff.title"))}</b>` +
      `<p>${GW_BUSY === "connect"
        ? t("gw.connecting.body")
        : esc(t("gw.installedOff.body"))}</p>` +
      `<div class="row"><button type="button" class="gw-btn" data-gw-act="retry">${esc(t("gw.retry"))}</button></div>` +
      (gwErrText() ? `<p style="color:var(--red)">${esc(gwErrText())}</p>` : ``) +
      `</div>`;
  }
  return `<div class="gw-connect">` +
    `<b>${esc(running ? t("gw.installing.title") : failed ? t("gw.installFailed.title")
      : t("gw.notInstalled.title"))}</b>` +
    `<p>${running
      ? t("gw.installing.body")
      : esc(t("gw.notInstalled.body"))}</p>` +
    `<div class="row">` +
      (running
        ? `<button type="button" class="gw-btn" data-gw-act="install-magpie-cancel">${esc(t("common.cancel"))}</button>`
        : `<button type="button" class="gw-btn primary" data-gw-act="install-magpie">` +
          esc(failed ? t("gw.install.redownload") : t("gw.install.download")) + `</button>`) +
    `</div>` +
    (gwErrText() && !GW_INSTALL ? `<p style="color:var(--red)">${esc(gwErrText())}</p>` : ``) +
    (st && st.lines && st.lines.length
      ? `<pre class="gw-inst-log" id="gw-inst-log">${esc(st.lines.join("\n"))}</pre>` : ``) +
    (failed ? `<p style="color:var(--red)">${esc(msgText(st.err) || t("gw.install.failed"))}</p>` : ``) +
    `</div>`;
}

/* ---- 版本 / 更新条 ----------------------------------------------------
   magpie 自己负责更新（/api/update）；这里只显示 current / latest，并把
   用户那一下点击转成 magpie.update.install。进度由 Go 侧推回来。 */

function gwUpdateHTML() {
  const u = GW_UPD;
  if (GW_UPD_ERR) {
    return `<span class="err">${esc(t("gw.update.readErr", { err: msgText(GW_UPD_ERR) }))}</span>`;
  }
  if (!u) return "";
  const cur = u.current || "";
  const latest = u.latest || "";
  const upd = !!latest && latest !== cur;
  const pct = u.total > 0 ? Math.min(99, Math.floor((u.done | 0) * 100 / u.total)) : 0;
  if (GW_UPD_BUSY) {
    const what = GW_UPD_BUSY === "restarting" ? t("gw.update.restarting")
      : GW_UPD_BUSY === "downloading"
        ? (u.total > 0 ? t("gw.update.downloadingPct", { pct }) : t("gw.update.downloading"))
        : t("gw.update.checking");
    return `<span>magpie${cur ? " " + esc(cur) : ""}</span>` +
      `<span class="sep">·</span><span class="upd">${esc(what)}</span>`;
  }
  if (!cur) return "";
  let html = `<span>magpie ${esc(cur)}</span>`;
  if (upd) {
    html += `<span class="sep">·</span><span class="upd">${esc(t("gw.update.available", { v: latest }))}</span>` +
      `<button type="button" class="gw-btn sm" data-gw-act="update-magpie">${esc(t("gw.update.button"))}</button>`;
  } else if (latest) {
    html += `<span class="sep">·</span><span>${esc(t("gw.update.latest"))}</span>`;
  }
  return html;
}

/* 更新状态的落点（magpie_update.go → {type:"magpie.update"}）。
   updated=true 时控制面已经 re-exec 过：清掉 iframe 的地址标记并重接，
   否则页面还停在旧进程加载的那一份。 */
function applyGwUpdate(m) {
  if (!m || typeof m !== "object") return;
  if (m.update && typeof m.update === "object") GW_UPD = m.update;
  GW_UPD_BUSY = typeof m.busy === "string" ? m.busy : "";
  GW_UPD_ERR = errMsgOf(m);
  if (GW_UPD || m.err) GW_UPD_TRIES = 2; // 问过就不再自动问
  if (m.updated) {
    GW_FRAME_AT = "";
    sendCtrl({ type: "gw.connect" });
    sendCtrl({ type: "magpie.refresh" });
  }
  renderGateway();
}

$("gw-ver").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gw-act]");
  if (!b || b.dataset.gwAct !== "update-magpie") return;
  GW_UPD_BUSY = "checking";
  GW_UPD_ERR = null;
  bootFact("网关 更新 magpie");
  sendCtrl({ type: "magpie.update.install" });
  renderGateway();
});

/* 卡片上的动作。只服务网关页自己的壳；provider/group/plugin 的写操作
   全部由 magpie 的界面直接打它自己的 /api/*，Perch 不再中转。 */
$("gw-cover").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gw-act]");
  if (!b) return;
  const act = b.dataset.gwAct;
  if (act === "retry") {
    gwAutoTries = 0; gwAutoAt = 0;
    GW_BUSY = "connect";
    sendCtrl({ type: "gw.connect" });
    renderGateway();
    return;
  }
  if (act === "refresh") {
    sendCtrl({ type: "gw.refresh" });
    sendCtrl({ type: "magpie.refresh" });
    return;
  }
  if (act === "install-magpie") {
    GW_INSTALL = { state: "running", lines: [], err: "" };
    sendCtrl({ type: "install.magpie" });
    bootFact("网关 下载并安装 magpie");
    renderGateway();
    return;
  }
  if (act === "install-magpie-cancel") {
    if (GW_INSTALL) GW_INSTALL.state = "cancelling";
    sendCtrl({ type: "install.cancel", id: "magpie" });
    renderGateway();
  }
});

/* iframe 加载失败（Wails 的自定义 scheme 下同源反代没通）不会抛错，
   只会是一张空白页；这里留一条事实，验证时先看日志再看像素。 */
$("gw-frame").addEventListener("load", () => {
  const f = $("gw-frame");
  if (f && !f.hidden) bootFact("网关 内嵌界面已加载");
});

/* ===========================================================================
   推送落点（原 87-gw-apply.js）：网关/控制面消息到达后落到 GW / 抽屉 / 总览。
   与上面的网关壳同属一域，所以合在一个文件里，按 section 分开。
   =========================================================================== */

/* 控制面整份读数到达。网关页现在内嵌 magpie 自己的界面（iframe），
   Perch 只需要知道「连上没有 / 端口是多少」来决定是否设 iframe 的 src；
   供应商、账号、路由、用量、插件的数据都由那个页面自己取。 */
/* magpie 自己的 lang 已经写成这个值（gateway/language.go）。清掉加载标记，
   renderGateway 会重新设 iframe 的 src —— 新页面在 boot.js 里拿到的就是新语言。 */
function applyGwLang(m) {
  if (!m || !m.lang) return;
  if (GW_FRAME_AT) GW_FRAME_AT = "";
  renderGateway();
}

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

/* 断开预览的落点（internal/gateway/agents.go → {type:"gw.agent.preview"}）。
   只接受当前抽屉那个 agent 的答案；晚到的旧预览不能覆盖新打开的那个。 */
function applyGwPreview(m) {
  if (!m || !AC_ID || m.id !== AC_ID) return;
  AC_PREVIEW = m.preview || null;
  renderAgentDrawer();
}

/* Agent 接线状态的落点（internal/gateway/agents.go → {type:"gw.agents"}）。
   只做三件事：把 agents 放进 GW_AGENTS、清掉这次动作的忙碌标记、重画名单
   和抽屉。具体画成什么样在 86（名单）与 89（抽屉）。 */
function applyGwAgents(m) {
  if (!m || typeof m !== "object") return;
  // 预览失败不是错误：非 native agent（配置在 home 之外）本来就给不出 dry run，
  // 断开照样成立。把它记进 AC_PREVIEW，抽屉里用通用说明兜底。
  if (m.op === "preview") {
    if (AC_ID && m.id === AC_ID) {
      AC_PREVIEW = m.err ? { changes: null, error: errMsgOf(m) } : (m.preview || null);
      renderAgentDrawer();
    }
    return;
  }
  GW_AGENTS_NOTICE = m.notice || "";
  if (Array.isArray(m.agents)) GW_AGENTS = m.agents;
  // 任何一次动作（读/写/接入/断开/重应用）回来都结束了忙碌态。
  AC_BUSY = "";
  if (m.err) {
    // 存结构而不是渲染好的句子：切语言时 89-agent-cfg 会重画。
    GW_AGENTS_ERR = errMsgOf(m);
    if (AC_ID && (!m.id || m.id === AC_ID)) AC_ERR = errMsgOf(m);
  } else {
    GW_AGENTS_ERR = null;
    AC_ERR = null;
  }
  renderDashAgents();
  renderAgentDrawer();
}

/* 漂移轮询的落点（internal/gateway/agents.go → {type:"gw.agents.drift"}）。
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
