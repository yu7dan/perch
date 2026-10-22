"use strict";
/* 89-agent-cfg.js —— 总览 Agent 工作台的行内详情（2026-10-18，2026-10-22
 * 从右侧抽屉改成行内展开）。
 *
 * 用户的要求：总览下面的 Agent 配置要做到 magpie 的 Agents 页那套事 ——
 * 接进网关、模型 / 推理强度 / 分档 / 子代理 / 登录方式，一次把 14 个字段全做。
 * 数据与写操作都走 magpie 控制面（Go 侧 internal/gateway/agents.go）：
 *
 *   GET  /api/state                → {type:"gw.agents", agents, notice}
 *   POST /api/set                  → 同上（值空串 = 回到 agent 自己的默认）
 *   POST /api/agents/{act}/{id}    → 同上
 *   GET  /api/agents/preview/{id}  → {type:"gw.agent.preview", preview}
 *
 * 呈现：名单里点一行 → 该行下面展开 `.ag-detail`。详情只画 magpie 给的字段，
 * 不在 Perch 里另存一份配置 —— 谁是真相源这件事不能含糊。
 *
 * 安全：预览里的配置行可能带 magpie 写的 key，落进 DOM 前先把值打码；
 * 日志只记 agent / 字段名，不记值。
 *
 * 本文件是 index.html 里按序 defer 的一段 classic script；共享全局词法作用域。 */

/* GW_AGENTS：最近一次 /api/state 的 agents（null = 还没读到）。
   GW_AGENTS_NOTICE：magpie 随 state 回来的一句话（接入/断开的结果）。
   AC_*：抽屉自己的状态；AC_BUSY 空串 = 空闲。 */
let GW_AGENTS = null;
let GW_AGENTS_ERR = null;
let GW_AGENTS_NOTICE = "";
let AC_ID = "";
let AC_BUSY = "";
let AC_ERR = null;
let AC_PREVIEW = null;
let AC_CONFIRM = false;
/* 打开中的长列表选择器（模型字段）：{field, wrap}。弹层挂在 body 上（fixed），
   这样不会被抽屉的滚动容器裁掉。 */
let AC_PICK = null;
/* 主模型选择：用户在模型弹层里选中的值（还没写入）；空 = 还没选。
   只有点“接入并使用此模型/应用”才发 gw.agent.set，选的时候不写配置。 */
let AC_MODEL_SEL = "";
let AC_MODEL_POP = null;
/* 抽屉开着时的漂移轮询（15s，和 magpie 自己的窗口一样）。0 = 没在跑。 */
let AC_DRIFT_TIMER = 0;

/* 字段名 → i18n key。magpie 的 label 是英文（"opus effort"），这里只翻译
   Claude Code 这套（见 magpie internal/agent/claude.go），别的 agent 的
   字段照 magpie 的 label 原样显示 —— 不猜。 */
const AC_FIELD_KEYS = {
  model: "ac.field.model", effort: "ac.field.effort", thinking: "ac.field.thinking",
  ultracode: "ac.field.ultracode",
  opus: "ac.field.opus", sonnet: "ac.field.sonnet", haiku: "ac.field.haiku",
  fable: "ac.field.fable",
  subagent: "ac.field.subagent", subagent_model: "ac.field.subagent_model",
  opus_effort: "ac.field.opus_effort", sonnet_effort: "ac.field.sonnet_effort",
  haiku_effort: "ac.field.haiku_effort", fable_effort: "ac.field.fable_effort",
  subagent_effort: "ac.field.subagent_effort",
  login: "ac.field.login", small: "ac.field.small", large: "ac.field.large",
  executor: "ac.field.executor", planner: "ac.field.planner", tiers: "ac.field.tiers",
  memories: "ac.field.memories", slow: "ac.field.slow", smol: "ac.field.smol",
};
/* magpie 的推理强度是裸值（low/high/xhigh…），没有 label。 */
const AC_EFFORT_KEYS = {
  off: "ac.effort.off", none: "ac.effort.none", minimal: "ac.effort.minimal",
  low: "ac.effort.low", medium: "ac.effort.medium", high: "ac.effort.high",
  xhigh: "ac.effort.xhigh", max: "ac.effort.max",
};
/* 选项 label 的本地化（magpie 的 sign-in 选项）。 */
const AC_OPT_KEYS = { "magpie's key": "ac.opt.magpieKey" };
/* 选项 group 的本地化。 */
const AC_GROUP_KEYS = { "Routing groups": "ac.group.routing" };
/* 这些字段值空 = 跟随主模型（magpie 的 Field.Follows 不进 /api/state，
   所以按 key 认；Claude Code 的分档与子代理就是这个语义）。 */
const AC_FOLLOWS = { opus: "model", sonnet: "model", haiku: "model", fable: "model", subagent: "model" };

function gwAgentOf(id) {
  if (!GW_AGENTS) return null;
  return GW_AGENTS.find((a) => a.id === id) || null;
}

/* 已知的 magpie 上游边界：普通 Cursor CLI 不能被路由。
   实测 400 `Cursor CLI can't be connected to magpie`；magpie 的 cursor agent
   只有 model=auto 一个字段，connect() 找不到可写的 provider 选项。这是上游
   事实，不是猜的 —— 但仍然只标**这一件事**：其他 agent 不预设不可接，
   没读到 connectable 就是“未知”，不是“可以”。
   Phase 2 会由 Go 的 preflight 提供同一份判断；届时删掉这张静态表。 */
const GW_NOT_CONNECTABLE = {
  cursor: "agent.note.cursorCliNotConnectable",
};

/* 一行的网关信息 = magpie 的原始行 + 已知的“不可 connect”标注。
   模型只读这个形状；它不直接读 GW_AGENTS。 */
function gwInfoFor(id) {
  const a = gwAgentOf(id);
  if (!a) return null;
  // 上游（magpie / Perch 的 Go preflight）给了就听它的 —— 将来 magpie 支持
  // Cursor 之后，这里不需要改一行前端。
  if (typeof a.connectable === "boolean") {
    return a.connectable ? a
      : Object.assign({}, a, { reasonKey: GW_NOT_CONNECTABLE[id] || "agent.note.gatewayNotConnectable" });
  }
  const reasonKey = GW_NOT_CONNECTABLE[id];
  if (!reasonKey) return a;
  return Object.assign({}, a, { connectable: false, reasonKey });
}

/* 进总览时预取一次接线状态，让名单上的网关绿点在"打开抽屉之前"就是准的。
   后端（gwAgentPrefetch）只在用户以前用过网关时才碰控制面，所以这里不用再
   判断 GW.connected。最多试 3 次（进入总览会重画）：控制面没起来时不让它
   每 20 秒刷一条失败日志；抽屉打开时还会再显式读一次，不影响使用。 */
let GW_AGENTS_TRIES = 0;
function gwAgentsPrefetch() {
  if (GW_AGENTS || GW_AGENTS_TRIES >= 3) return;
  GW_AGENTS_TRIES++;
  sendCtrl({ type: "gw.agents.prefetch" });
}

function acFieldLabel(f) {
  const k = AC_FIELD_KEYS[f.key];
  return k ? t(k) : (f.label || f.key);
}

function acOptName(f, o) {
  if (o.label) {
    const k = AC_OPT_KEYS[o.label];
    return k ? t(k) : o.label;
  }
  if (AC_EFFORT_KEYS[o.value]) return t(AC_EFFORT_KEYS[o.value]);
  if (f.key === "ultracode" && o.value === "on") return t("ac.opt.on");
  if (o.note) return o.note;
  return o.value || t("ac.opt.default");
}

function acOptionName(f, value) {
  const o = (f.options || []).find((x) => x.value === value);
  return o ? acOptName(f, o) : value;
}

// 空值的说法：分档 / 子代理 = 跟随主模型，推理强度 = 跟随会话，其余 = agent 默认。
function acDefaultLabel(a, f) {
  if (f.key === "ultracode") return t("ac.effort.off");
  const follow = AC_FOLLOWS[f.key];
  if (follow) {
    const m = (a.fields || []).find((x) => x.key === follow);
    return m && m.value
      ? t("ac.default.followModelWith", { model: acOptionName(m, m.value) })
      : t("ac.default.followModel");
  }
  if (/_effort$/.test(f.key)) return t("ac.default.followEffort");
  return t("ac.default.agent");
}

/* 预览里的配置行可能带 magpie 写进去的 token/key；打码后再进 DOM。
   只留键名，值一律变成 ••••。 */
function acMaskLine(s) {
  return String(s || "").replace(
    /("?[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Za-z0-9_]*"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s}]+)/gi,
    (all, k, v) => k + (v.charAt(0) === '"' ? '"••••"' : "••••"));
}

// ---------------------------------------------------------------------------
// 抽屉的开关
// ---------------------------------------------------------------------------

function acRender() {
  if (typeof renderDashAgents === "function") renderDashAgents();
}

function acOpen(id, force) {
  if (!id) return;
  if (AC_ID === id && !force) { acClose(); return; }
  if (AC_ID !== id) AC_PREVIEW = null;
  AC_ID = id;
  AC_BUSY = "";
  AC_ERR = null;
  AC_CONFIRM = false;
  AC_MODEL_SEL = "";
  acModelPopClose(false);
  acRender();
  // 打开时才问控制面（启动阶段它是被动的，不替用户拉起进程）。
  sendCtrl({ type: "gw.agents" });
  sendCtrl({ type: "gw.agent.preview", id });
  acDriftWatch(true);
  requestAnimationFrame(() => {
    const row = document.querySelector(`#dash-agent-list [data-agrow="${CSS.escape(id)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  });
  bootFact(`Agent 详情 打开 ${id}`);
}

/* 漂移是"配置文件在 Perch 之外被改了"：读一次 state 不够，抽屉开着时要
   时不时再问。15s 与 magpie 的窗口一致；窗口藏起来时不问，选择器开着时
   也不问 —— 那一下重画会把用户正在挑的东西关掉。 */
function acDriftWatch(on) {
  if (on) {
    if (AC_DRIFT_TIMER) return;
    AC_DRIFT_TIMER = setInterval(() => {
      if (!AC_ID) { acDriftWatch(false); return; }
      if (document.hidden || AC_PICK || AC_BUSY) return;
      sendCtrl({ type: "gw.agents.drift" });
    }, 15000);
  } else if (AC_DRIFT_TIMER) {
    clearInterval(AC_DRIFT_TIMER);
    AC_DRIFT_TIMER = 0;
  }
}

function acClose() {
  if (!AC_ID) return;
  acPickClose(false);
  acModelPopClose(false);
  acDriftWatch(false);
  AC_ID = "";
  AC_BUSY = "";
  AC_ERR = null;
  AC_PREVIEW = null;
  AC_CONFIRM = false;
  AC_MODEL_SEL = "";
  acRender();
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

/* 兼容旧调用点：现在没有独立抽屉，详情是总览行内的 .ag-detail。 */
function renderAgentDrawer() {
  acRender();
}

/* 详情里如果有输入控件获得焦点，推送型重画要推迟，别把用户正在改的值冲掉。 */
function acDetailEditing() {
  const el = document.activeElement;
  if (!el || !el.closest) return false;
  return !!el.closest("#dash-agent-list .ag-detail") &&
    /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
}

/* 行内详情。模型主字段在行上，这里只放路由、漂移、动作和高级字段。 */
function acDetailHTML(a, card, v) {
  const name = (a && a.name) || (card && card.name) || AC_ID;
  if (!a && !GW_AGENTS && !GW_AGENTS_ERR) {
    return `<div class="ac-loading"><span class="spin"></span>${esc(t("ac.loading"))}</div>` +
      (acCatCanOpen(card)
        ? `<div class="ac-actions"><button type="button" class="ac-btn" data-ac="open-local">` +
          `${esc(t("ac.model.nativeOpen"))}</button></div>`
        : "");
  }
  if (!a) {
    let html = `<div class="ac-empty">${esc(t("ac.localOnly", { name }))}<br>` +
      `<span>${esc(msgText(GW_AGENTS_ERR) || t("ac.empty.count", { n: (GW_AGENTS || []).length }))}</span></div>`;
    if (acCatCanOpen(card)) {
      html += `<div class="ac-actions"><button type="button" class="ac-btn primary" data-ac="open-local">` +
        `${esc(t("ac.model.nativeOpen"))}</button></div>`;
    } else if (card && card.installed) {
      html += `<div class="ac-hint">${esc(t("ac.noTerminal"))}</div>`;
    }
    return html + acReloadHTML();
  }

  const busy = !!AC_BUSY;
  let html = acRouteLine(a, v);
  if (v && v.route === "unknown") {
    html += `<div class="ac-hint">${esc(t("ac.route.unknownNote"))}</div>`;
  }
  if (v && !v.hasGatewayModels) {
    html += `<div class="ac-hint">${esc(t("ac.model.noSource"))} ` +
      `<button type="button" class="ac-btn quiet" data-ac="add-models">${esc(t("ac.model.addModels"))}</button></div>`;
  }
  if (busy) {
    const word = AC_BUSY.startsWith("set:") ? t("ac.busy.set")
      : t("ac.busy." + AC_BUSY);
    html += `<div class="ac-hint ac-busy"><span class="spin"></span>${esc(word)}</div>`;
  }
  try {
    const live = (typeof liveTabsForAgent === "function" && v && v.wired)
      ? liveTabsForAgent(a.id) : [];
    const setup = live.filter((x) => typeof paneSetupKind === "function" && paneSetupKind(x));
    const stale = live.filter((x) => typeof paneModelStale === "function" && paneModelStale(x, v));
    if (setup.length) {
      html += `<div class="ac-note">${esc(t("ac.model.firstRunPanes"))}</div>` +
        `<div class="ac-actions"><button type="button" class="ac-btn" data-ac="reopen-panes">` +
        `${esc(t("ac.model.reopenPanes"))}</button></div>`;
    } else if (stale.length) {
      html += `<div class="ac-note">${esc(t("ac.model.staleRun", { n: stale.length }))}</div>` +
        `<div class="ac-actions"><button type="button" class="ac-btn" data-ac="reopen-panes">` +
        `${esc(t("ac.model.reopenPanes"))}</button></div>`;
    }
  } catch (e) {}
  if (a.failover) html += `<div class="ac-note">${esc(t("ac.chip.failover"))}</div>`;
  if (a.drift) html += acDriftHTML(a, a.drift);
  if (a.stale > 0) html += `<div class="ac-note">${esc(t("ac.stale", { n: a.stale, name: a.name }))}</div>`;
  if (GW_AGENTS_NOTICE) html += `<div class="ac-note">${esc(GW_AGENTS_NOTICE)}</div>`;
  if (AC_ERR) html += `<div class="ac-err">${esc(msgText(AC_ERR))}</div>`;
  if (AC_CONFIRM) {
    html += acConfirmHTML(a);
  } else if (a.wired) {
    html += `<div class="ac-actions"><button type="button" class="ac-btn danger" data-ac="disconnect">` +
      `${esc(t("ac.action.disconnect"))}</button></div>`;
  } else if (acCatCanOpen(card)) {
    html += `<div class="ac-actions"><button type="button" class="ac-btn" data-ac="open-local">` +
      `${esc(t("ac.model.nativeOpen"))}</button></div>`;
  } else {
    html += `<div class="ac-hint">${esc(t("ac.noTerminal"))}</div>`;
  }
  html += acFieldsHTML(a, busy, v ? v.modelFieldKey : "");
  return html;
}

/* 路由一行：网关 · 模型 / 本机 / 未配置。没有七步。 */
function acRouteLine(a, v) {
  if (!v) return "";
  const label = t(v.labelKey);
  let sub = v.modelLabel || "";
  if (!sub && v.route === "gateway") sub = t("ac.route.joined");
  return `<div class="ac-route-line">` +
    `<span class="ag-route ${esc(v.route)}">${esc(label)}</span>` +
    (sub ? `<span class="ac-route-model" title="${esc(sub)}">${esc(sub)}</span>` : "") +
    `</div>`;
}


/* 抽屉的主任务：选一个网关模型，或者明确地用本机配置打开。
   点模型按钮只展开列表；选中不写入；点“接入并使用此模型/应用”才写。 */
function acModelSectionHTML(a, v, busy) {
  if (!a || !v) return "";
  const ga = typeof gwInfoFor === "function" ? gwInfoFor(a.id) : null;
  const field = v.modelField;
  const current = field ? String(field.value || "") : "";
  const selected = AC_MODEL_SEL || "";
  const needApply = !!selected && (!a.wired || selected !== current);
  let html = `<div class="ac-model-sec"><span class="ac-sec-title">${esc(t("ac.model.title"))}</span>`;

  // menu agent（ZCode / Cursor Private Inference）没有“一个主模型”可写：
  // 它的模型列表就是它自己的菜单。即使 state 里某个字段带了网关选项，
  // 也不替用户挑一个。
  if (a.menu || !v.hasGatewayModels) {
    const explicitNo = !!(ga && ga.connectable === false);
    html += `<div class="ac-hint">${esc(t("ac.model.noModels"))}</div>`;
    if (a.menu) {
      html += `<div class="ac-hint">${esc(t("agent.model.ownMenu"))}</div>`;
    } else {
      html += `<div class="ac-hint">${esc(t(explicitNo ? "ac.model.notConnectable" : "ac.model.noSource"))}</div>`;
    }
    // Cursor 的普通 CLI 是已知上游边界：把“想继续用怎么办”直接写出来。
    if (a.id === "cursor") html += `<div class="ac-hint">${esc(t("ac.gw.cursorNative"))}</div>`;
    html += `<div class="ac-actions">` +
      `<button type="button" class="ac-btn" data-ac="add-models">${esc(t("ac.model.addModels"))}</button>` +
      (v.canOpen && !a.wired
        ? `<button type="button" class="ac-btn" data-ac="open-local">${esc(t("ac.model.nativeOpen"))}</button>`
        : "") +
      `</div></div>`;
    return html;
  }

  // 未接入时这颗按钮就是用户口中的「接入网关」：点开只展开模型列表，
  // 不会自己挑一个；选了模型之后它才变成模型名，下面才出现「接入并使用」。
  const label = selected ? agentModelLabel(field, selected)
    : (a.wired && v.modelLabel ? v.modelLabel
      : t(a.wired ? "ac.model.choose" : "ac.model.connectGateway"));
  html += `<div class="ac-model-row">` +
    `<button type="button" class="ac-btn ac-model-btn" data-acmodel="${esc(a.id)}"` +
    `${busy ? " disabled" : ""} title="${esc(t(a.wired ? "ac.model.changeHint" : "ac.model.pickHint"))}">` +
    `<span>${esc(label)}</span><i aria-hidden="true">▾</i></button>` +
    `<span class="ac-model-state">${esc(a.wired ? t("ac.model.connected") : t("ac.model.notConnected"))}</span>` +
    `</div>`;

  if (needApply) {
    const hasLive = typeof liveAgentTab === "function" && !!liveAgentTab(a.id);
    html += `<div class="ac-actions">` +
      `<button type="button" class="ac-btn primary" data-ac="model-apply"` +
      `${busy ? " disabled" : ""}>${esc(t(a.wired ? "ac.model.applyReopen" : "ac.model.connectOpen"))}</button>` +
      // 没有活格时给一条“只接入”的退路：不替用户开格子。
      (hasLive ? "" :
        `<button type="button" class="ac-btn" data-ac="model-apply-only"` +
        `${busy ? " disabled" : ""}>${esc(t("ac.model.applyOnly"))}</button>`) +
      `</div>`;
  } else if (!a.wired) {
    html += `<div class="ac-actions">` +
      `<button type="button" class="ac-btn" aria-disabled="true" data-ac="model-disabled"` +
      ` title="${esc(t("ac.model.pickFirst"))}">${esc(t("ac.model.connectOpen"))}</button>` +
      `</div>`;
  }

  // 已接入时主行动就是下面那颗「打开」（它会用网关配置启动）；这里不再摆
  // 一颗同样写着「打开」的按钮。未接入时「用本机配置打开」是退路，一直在。
  html += `<div class="ac-actions">` +
    (!a.wired && v.canOpen
      ? `<button type="button" class="ac-btn" data-ac="open-local">${esc(t("ac.model.nativeOpen"))}</button>`
      : "") +
    (a.wired ? `<button type="button" class="ac-btn danger" data-ac="disconnect">${esc(t("ac.action.disconnect"))}</button>` : "") +
    `</div>`;
  html += `<div class="ac-hint">${esc(t(a.wired ? "ac.model.hintWired" : "ac.model.hintConnect"))}</div>`;
  return html + `</div>`;
}

function acBodyHTML(a, name) {
  const cat = ((mg() && mg().catalog) || []).find((x) => x.id === (a ? a.id : AC_ID)) || null;
  const v = cat ? agentRouteView(cat, gwInfoFor(cat.id), dashMagpieState()) : null;

  if (!a && !GW_AGENTS && !GW_AGENTS_ERR) {
    // 读网关状态慢/没起来时也要能先把 agent 用本机配置打开 —— 打开不依赖
    // 网关，不能拿一个转圈把用户挡在外面。
    return `<div class="ac-loading"><span class="spin"></span>${esc(t("ac.loading"))}</div>` +
      (acCatCanOpen(cat)
        ? `<div class="ac-actions">` +
          `<button type="button" class="ac-btn" data-ac="open-local">${esc(t("ac.model.nativeOpen"))}</button>` +
          `</div>`
        : "");
  }
  if (!a) {
    let html = `<div class="ac-empty">` +
      `${esc(t("ac.localOnly", { name }))}<br>` +
      `<span>${esc(msgText(GW_AGENTS_ERR) || t("ac.empty.count", { n: (GW_AGENTS || []).length }))}</span>` +
      `</div>`;
    if (acCatCanOpen(cat)) {
      html += `<div class="ac-actions">` +
        `<button type="button" class="ac-btn primary" data-ac="open-local">${esc(t("ac.model.nativeOpen"))}</button>` +
        `</div>`;
    } else if (cat && cat.installed) {
      html += `<div class="ac-hint">${esc(t("ac.noTerminal"))}</div>`;
    }
    return html + acReloadHTML();
  }

  const busy = !!AC_BUSY;
  let html = acRouteLine(a, v);
  if (v && v.route === "unknown") {
    html += `<div class="ac-hint">${esc(t("ac.route.unknownNote"))}</div>`;
  }
  if (busy) {
    const word = AC_BUSY.startsWith("set:") ? t("ac.busy.set")
      : t("ac.busy." + AC_BUSY);
    html += `<div class="ac-hint ac-busy"><span class="spin"></span>${esc(word)}</div>`;
  }
  html += acModelSectionHTML(a, v, busy);

  // 配置与运行进程不一致时，抽屉里也要说清楚，并给一个直接重开的动作。
  // 这正是用户看到的“明明已接入，格子却还在要 key/登录”的那个缝。
  try {
    const live = (typeof liveTabsForAgent === "function" && v && v.wired)
      ? liveTabsForAgent(a.id) : [];
    const setup = live.filter((x) => typeof paneSetupKind === "function" && paneSetupKind(x));
    const stale = live.filter((x) => typeof paneModelStale === "function" && paneModelStale(x, v));
    if (setup.length) {
      html += `<div class="ac-note">${esc(t("ac.model.firstRunPanes"))}</div>` +
        `<div class="ac-actions">` +
        `<button type="button" class="ac-btn" data-ac="reopen-panes">${esc(t("ac.model.reopenPanes"))}</button>` +
        `</div>`;
    } else if (stale.length) {
      html += `<div class="ac-note">${esc(t("ac.model.staleRun", { n: stale.length }))}</div>` +
        `<div class="ac-actions">` +
        `<button type="button" class="ac-btn" data-ac="reopen-panes">${esc(t("ac.model.reopenPanes"))}</button>` +
        `</div>`;
    }
  } catch (e) {}

  if (a.failover) html += `<div class="ac-note">${esc(t("ac.chip.failover"))}</div>`;
  if (a.drift) html += acDriftHTML(a, a.drift);
  if (a.stale > 0) {
    html += `<div class="ac-note">${esc(t("ac.stale", { n: a.stale, name: a.name }))}</div>`;
  }
  if (GW_AGENTS_NOTICE) html += `<div class="ac-note">${esc(GW_AGENTS_NOTICE)}</div>`;
  if (AC_ERR) html += `<div class="ac-err">${esc(msgText(AC_ERR))}</div>`;

  if (AC_CONFIRM) {
    html += acConfirmHTML(a);
  } else if (acCatCanOpen(cat)) {
    html += `<div class="ac-actions ac-open-row">` +
      `<button type="button" class="ac-btn primary" data-ac="open"` +
      `${busy ? " disabled" : ""}>${esc(t("ac.model.open"))}</button>` +
      `</div>`;
  } else {
    html += `<div class="ac-hint">${esc(t("ac.noTerminal"))}</div>`;
  }

  html += acFieldsHTML(a, busy, v ? v.modelFieldKey : "");
  return html;
}

function acReloadHTML() {
  return `<div class="ac-actions"><button type="button" class="ac-btn" data-ac="reload"` +
    `${AC_BUSY ? " disabled" : ""}>${esc(t("ac.retry"))}</button></div>`;
}

function acDriftHTML(a, d) {
  // 文案取自 magpie 自己的 DRIFT_WHY（i18n.js 中文）。
  const who = a.name || a.id;
  // d.want 是原始值（deepseek/deepseek-flash）；能映射到字段选项时用同一个
  // 显示名（DeepSeek-V4.1-Flash），和上面的模型行对得上 —— magpie 的
  // driftFix 也是这么做的。
  const df = (a.fields || []).find((x) => x.key === d.field);
  const want = df && d.want ? acOptionName(df, d.want) : (d.want || t("ac.field.model"));
  const whyKey = {
    unwired: "ac.drift.unwired",
    replaced: "ac.drift.replaced",
    bypassed: "ac.drift.bypassed",
    unreachable: "ac.drift.unreachable",
    proxied: "ac.drift.proxied",
  }[d.kind] || "ac.drift.generic";
  const why = t(whyKey, { who, want });
  // 「保留现状」只在 replaced 时给（和 magpie 的行菜单一样）：意思是
  // "这份配置是我有意改的"，magpie 把 applied 记录删掉、漂移随之消失。
  // 其余几种（没接上 / 绕过 / 地址不通）保留现状等于把问题藏起来，不给。
  const keep = d.kind === "replaced"
    ? `<button type="button" class="ac-btn" data-ac="keep"${AC_BUSY ? " disabled" : ""}` +
      ` title="${esc(t("ac.keep.title"))}">` +
      `${esc(t("ac.keep"))}</button><span>${esc(t("ac.keep.note"))}</span>`
    : "";
  // 「重新应用」是漂移的主行动：把 magpie 该写的值再写一遍。之前只处理了
  // 消息、没有按钮，等于漂移只能看不能修。
  const acts = `<div class="ac-drift-acts">` +
    `<button type="button" class="ac-btn" data-ac="reapply"${AC_BUSY ? " disabled" : ""}` +
    `>${esc(t("ac.action.reapply"))}</button>` + keep + `</div>`;
  return `<div class="ac-drift"><b>${esc(why)}</b>` +
    (d.detail ? `<span>${esc(d.detail)}</span>` : "") + acts + `</div>`;
}

function acConfirmHTML(a) {
  const name = a.name || a.id;
  return `<div class="ac-confirm">` +
    `<b>${esc(t("ac.confirm.title", { name }))}</b>` +
    `<p>${esc(t("ac.confirm.body", { name }))}</p>` +
    acChangesHTML(AC_PREVIEW) +
    `<div class="ac-actions">` +
      `<button type="button" class="ac-btn" data-ac="disconnect-cancel"` +
        `${AC_BUSY ? " disabled" : ""}>${esc(t("common.cancel"))}</button>` +
      `<button type="button" class="ac-btn danger" data-ac="disconnect-go"` +
        `${AC_BUSY ? " disabled" : ""}>${esc(t("ac.action.disconnect"))}</button>` +
    `</div>` +
    `</div>`;
}

function acChangesHTML(p) {
  if (!p) {
    return `<div class="ac-hint">${esc(t("ac.changes.loading"))}</div>`;
  }
  const list = Array.isArray(p.changes) ? p.changes : [];
  const err = msgText(p.error);
  if (!list.length) {
    return `<div class="ac-hint">` +
      esc(err ? t("ac.changes.err", { err }) : t("ac.changes.plain")) +
      `</div>`;
  }
  let html = `<div class="ac-hint">${esc(t("ac.changes.heading"))}</div><div class="ac-diff">`;
  for (const c of list) {
    html += `<div class="ac-diff-file"><div class="ac-diff-path">` +
      `<span>${esc(c.path || "")}</span>` +
      (c.removed ? `<span class="ac-tag del">${esc(t("ac.changes.removed"))}</span>` : "") +
      (c.created ? `<span class="ac-tag">${esc(t("ac.changes.created"))}</span>` : "") +
      `</div>`;
    const lines = Array.isArray(c.lines) ? c.lines : [];
    for (const l of lines.slice(0, 6)) {
      html += `<div class="ac-diff-line ${l.op === "-" ? "del" : "back"}">` +
        `<span class="op">${l.op === "-" ? "−" : "↺"}</span>` +
        `<code>${esc(acMaskLine(l.text))}</code></div>`;
    }
    if (lines.length > 6) {
      html += `<div class="ac-hint">${esc(t("ac.changes.more", { n: lines.length - 6 }))}</div>`;
    }
    html += `</div>`;
  }
  return html + `</div>`;
}

function acFieldsHTML(a, busy, excludeKey) {
  const fields = (Array.isArray(a.fields) ? a.fields : [])
    .filter((f) => f && f.key !== excludeKey);
  if (!fields.length) return "";
  // 高级字段默认收起：行内详情首先回答“走哪条路由、用哪个模型、下一步点哪”，
  // 十几项分档字段展开会把整页撑成一张表单。展开后行为不变。
  let html = `<details class="ac-adv"><summary>${esc(t("ac.adv.title"))}</summary>` +
    `<div class="ac-fields">` + fields.map((f) => acFieldHTML(a, f, busy)).join("") + `</div>`;
  // OpenCode 的推理档位叫 variant，选在它自己的 TUI 里（默认 Ctrl+T，
  // 实测 1.19.3 的 keybind 就是它）。magpie 接线时只把每个模型的 variants
  // 写进配置，没有把“默认档位”暴露成字段；这里给一条只读说明，不去直写
  // opencode.json —— 配置归 magpie。
  if (a.id === "opencode") {
    // 这一句里有 <kbd>，按受控 HTML 插入（键位是界面元素，不是用户数据）。
    html += `<div class="ac-hint">${t("ac.opencode.hint")}</div>`;
  }
  html += `<div class="ac-hint">${esc(t("ac.fields.footer"))}</div></details>`;
  return html;
}

function acFieldHTML(a, f, busy) {
  const opts = Array.isArray(f.options) ? f.options : [];
  const hasEmpty = opts.some((o) => o.value === "");
  const known = opts.some((o) => o.value === f.value);
  const defLabel = acDefaultLabel(a, f);
  let inner = "";
  // 空值是一个真正的选项（magpie 的 Field.Set("")）：分档 = 跟随主模型，
  // 其余 = agent 默认。login 的选项里自带一个空值（"magpie 的密钥"），不重复加。
  if (!hasEmpty) {
    inner += `<option value=""${f.value ? "" : " selected"}${opts.length ? "" : " disabled"}>` +
      `${esc(defLabel)}</option>`;
  }
  const groups = [];
  for (const o of opts) {
    const g = o.group || "";
    let grp = groups.find((x) => x.g === g);
    if (!grp) { grp = { g, items: [] }; groups.push(grp); }
    grp.items.push(o);
  }
  for (const grp of groups) {
    const items = grp.items.map((o) => {
      const title = o.label && o.note ? ` title="${esc(o.note)}"` : "";
      return `<option value="${esc(o.value)}"${o.value === f.value ? " selected" : ""}${title}>` +
        `${esc(acOptName(f, o))}</option>`;
    }).join("");
    inner += grp.g
      ? `<optgroup label="${esc(AC_GROUP_KEYS[grp.g] ? t(AC_GROUP_KEYS[grp.g]) : grp.g)}">${items}</optgroup>`
      : items;
  }
  // 当前值不在选项里（magpie 新版本、或配置里是手写的值）：也让它显示出来，
  // 而不是让下拉静默跳回第一项。
  if (f.value && !known) {
    inner += `<option value="${esc(f.value)}" selected>${esc(f.value)}</option>`;
  }
  const title = opts.length ? "" : ` title="${esc(t("ac.field.noOptions"))}"`;
  // 长列表（模型类字段）换成可搜索的弹层：原生 select 几十项只能滚，
  // magpie 自己的选择器就是带搜索的。短列表仍用原生 select，行为最稳。
  const long = opts.length >= 12;
  const control = long
    ? `<div class="ac-pick" data-acpick="${esc(f.key)}">` +
      `<button type="button" class="ac-pick-btn" aria-haspopup="listbox" aria-expanded="false"` +
      ` aria-label="${esc(acFieldLabel(f))}"${busy ? " disabled" : ""}${title}>` +
      `<span>${esc(f.value ? acOptionName(f, f.value) : defLabel)}</span><i>▾</i></button></div>`
    : `<select data-acfield="${esc(f.key)}" aria-label="${esc(acFieldLabel(f))}"` +
      `${busy ? " disabled" : ""}${title}>${inner}</select>`;
  // 长列表用 div：button 不该被 label 再转发一次点击。
  const tag = long ? "div" : "label";
  return `<${tag} class="ac-field">` +
    `<span class="ac-k">${esc(acFieldLabel(f))}</span>` + control +
    `</${tag}>`;
}

// ---------------------------------------------------------------------------
// 长列表选择器（模型字段，带搜索）
// ---------------------------------------------------------------------------

function acSetFieldFor(id, field, value, isModel, openIntent) {
  if (!id || !field) return;
  if (isModel) {
    AGENT_MODEL_PENDING = { id, field, value };
    AGENT_MODEL_OPEN_INTENT = openIntent !== false;
  }
  GW_AGENT_BUSY = id;
  if (AC_ID === id) {
    AC_BUSY = "set:" + field;
    AC_ERR = null;
    AC_CONFIRM = false;
  }
  acRender();
  sendCtrl({ type: "gw.agent.set", id, field, value });
  bootFact(`Agent 配置 写入 ${id}.${field}${isModel ? "（模型）" : ""}`);
}

function acSetField(field, value, isModel) {
  if (!field || !AC_ID || AC_BUSY) return;
  acSetFieldFor(AC_ID, field, value, isModel, true);
}

/* 等一格的首帧/流。开了新格之后要先让它真正起来，再写网关配置。 */
function waitTabReady(tab, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!tab || !TAB_LIST.includes(tab)) return resolve(false);
      if (tab.ready && tab.stream) return resolve(true);
      if (Date.now() - t0 >= (ms || 12000)) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* dsh 的 profile 是它启动时自己建的：先 connect 后首次打开时，magpie 可能
   写的是 legacy config.yaml。等 Go 的 Cards 带上 profileReady 再写，避免
   “写进去了但 dsh 读不到”。其他 agent 只等一个很短的 settle。 */
function waitAgentBootstrap(id, ms) {
  return new Promise((resolve) => {
    if (id !== "dsh") return setTimeout(() => resolve(true), 350);
    const t0 = Date.now();
    const tick = () => {
      const card = ((typeof mg === "function" && mg() && mg().catalog) || [])
        .find((x) => x && x.id === id);
      if (card && card.profileReady) return resolve(true);
      if (Date.now() - t0 >= (ms || 10000)) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/* 抽屉主行动：没有活格 → 先替用户打开一格（让 agent 建自己的 profile/配置），
   等首帧/bootstrap 后再写网关。写成功后 afterAgentModelSet 按这一格的状态
   决定“自动重开 / 等这一轮结束”。 */
async function acApplyModel(field, value) {
  if (!AC_ID || !field || !value) return;
  const id = AC_ID;
  const cat = ((typeof mg === "function" && mg() && mg().catalog) || [])
    .find((x) => x && x.id === id);
  // 没有终端承载形态的 agent 只能“只接入”，不能替用户开一格。
  if (!acCatCanOpen(cat)) {
    acSetFieldFor(id, field.key, value, true, false);
    showToast(t("term.model.saved"), t("term.model.savedNext"), "ok");
    return;
  }
  const live = typeof liveAgentTab === "function" ? liveAgentTab(id) : null;
  if (live) { acSetFieldFor(id, field.key, value, true, true); return; }
  acClose();
  const nt = (typeof launchAgent === "function") ? await launchAgent(id) : null;
  if (!nt) {
    showToast(t("ac.model.openFailed"), "", "err");
    return;
  }
  // 这一格是“为了接入而开”的：允许接线成功后在首启/启动画面上强制重开。
  nt.wiringBootstrap = true;
  await waitTabReady(nt, 12000);
  if (!TAB_LIST.includes(nt)) {
    showToast(t("ac.model.openClosed"), "", "info");
    return;
  }
  // dsh 的首帧可能还是空屏，等启动画面/引导页画出来再写；afterAgentModelSet
  // 靠屏上的标记判断“这一格可以安全重开”。
  if (id === "dsh") await new Promise((r) => setTimeout(r, 1000));
  await waitAgentBootstrap(id, 10000);
  if (!TAB_LIST.includes(nt)) {
    showToast(t("ac.model.openClosed"), "", "info");
    return;
  }
  acSetFieldFor(id, field.key, value, true, true);
}

/* 抽屉里的「重开运行中的格子」：和接线成功后的收尾同一张判定表 ——
   首启/空闲/已停止重开；真正在干活的跳过并保留提示。 */
async function acReopenAgentPanes(id) {
  if (!id || typeof liveTabsForAgent !== "function") return;
  const tabs = liveTabsForAgent(id);
  if (!tabs.length) return;
  acClose();
  let reopened = 0, fresh = 0, deferred = 0;
  for (const tab of tabs) {
    if (!TAB_LIST.includes(tab)) continue;
    const setup = typeof paneSetupKind === "function" ? paneSetupKind(tab) : "";
    const st = typeof cellState === "function" ? cellState(tab) : "idle";
    const d = (typeof agentReopenDecision === "function")
      ? agentReopenDecision({ hasTab: true, setup, state: st, openIntent: true })
      : "defer";
    if (d !== "reopen") { deferred++; continue; }
    const r = await reopenAgentForModel(tab, { setup: !!setup, quiet: true });
    if (r) { reopened++; if (!r.resumed) fresh++; }
  }
  if (reopened) {
    showToast(t("term.model.reopened"),
      t(fresh ? "term.model.reopenedNewNote" : "term.model.reopenedNote"), "ok");
  }
  if (deferred) showToast(t("term.model.savedBusy"), t("term.model.restartLater"), "info");
}

function acPickItemHTML(value, name, group, on, title) {
  return `<button type="button" class="ac-pop-opt${on ? " on" : ""}" role="option"` +
    ` aria-selected="${!!on}" data-val="${esc(value)}"${title ? ` title="${esc(title)}"` : ""}>` +
    `<span class="tick">${on ? "✓" : ""}</span><span class="nm">${esc(name)}</span>` +
    (group ? `<span class="grp">${esc(group)}</span>` : "") + `</button>`;
}

function acPickListHTML(a, f) {
  const opts = Array.isArray(f.options) ? f.options : [];
  const known = opts.some((o) => o.value === f.value);
  let html = "";
  if (!opts.some((o) => o.value === "")) {
    html += acPickItemHTML("", acDefaultLabel(a, f), "", !f.value, "");
  }
  let grp = null;
  for (const o of opts) {
    const g = o.group || "";
    if (g !== grp && g) {
      html += `<div class="ac-pop-grp">${esc(AC_GROUP_KEYS[g] ? t(AC_GROUP_KEYS[g]) : g)}</div>`;
    }
    grp = g;
    html += acPickItemHTML(o.value, acOptName(f, o), "", o.value === f.value, o.label && o.note ? o.note : "");
  }
  if (f.value && !known) {
    html += acPickItemHTML(f.value, f.value, "", true, t("ac.pick.keepCurrent"));
  }
  return html;
}

function acPickFilter(pop, q) {
  q = String(q || "").trim().toLowerCase();
  const list = pop.querySelector(".ac-pop-list");
  if (!list) return;
  for (const el of list.querySelectorAll(".ac-pop-opt")) {
    const name = (el.querySelector(".nm") || el).textContent.toLowerCase();
    el.hidden = !!q && !name.includes(q) && !String(el.dataset.val || "").toLowerCase().includes(q);
  }
  // 组标题跟着它下面那一节一起藏。
  const kids = [...list.children];
  for (let i = 0; i < kids.length; i++) {
    if (!kids[i].classList.contains("ac-pop-grp")) continue;
    let vis = false;
    for (let j = i + 1; j < kids.length && !kids[j].classList.contains("ac-pop-grp"); j++) {
      if (kids[j].classList.contains("ac-pop-opt") && !kids[j].hidden) { vis = true; break; }
    }
    kids[i].hidden = !vis;
  }
  if (document.activeElement && document.activeElement.hidden) {
    const inp = pop.querySelector(".ac-pop-find");
    if (inp) inp.focus();
  }
}

function acPickOpen(field) {
  if (!AC_ID) return;
  if (AC_PICK && AC_PICK.field === field) { acPickClose(true); return; }
  acPickClose(false);
  const a = gwAgentOf(AC_ID);
  if (!a) return;
  const f = (a.fields || []).find((x) => x.key === field);
  if (!f) return;
  const wrap = [...$("dash-agent-list").querySelectorAll("[data-acpick]")]
    .find((w) => w.dataset.acpick === field);
  if (!wrap) return;
  AC_PICK = { field, wrap };
  wrap.classList.add("open");
  const btn = wrap.querySelector(".ac-pick-btn");
  if (btn) btn.setAttribute("aria-expanded", "true");

  const pop = document.createElement("div");
  pop.className = "ac-pop";
  const find = t("ac.pick.search", { field: acFieldLabel(f) });
  pop.innerHTML = `<input class="ac-pop-find" type="search" autocomplete="off"` +
    ` placeholder="${esc(find)}" aria-label="${esc(find)}">` +
    `<div class="ac-pop-list" role="listbox">${acPickListHTML(a, f)}</div>`;
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);

  // 当前值可能在几十项之后：一打开就把它带进视野（只在看不见时挪，不闪）。
  const list0 = pop.querySelector(".ac-pop-list");
  const on0 = list0 && list0.querySelector(".ac-pop-opt.on");
  if (list0 && on0) {
    const lb = list0.getBoundingClientRect(), ob = on0.getBoundingClientRect();
    if (ob.top < lb.top || ob.bottom > lb.bottom) {
      list0.scrollTop = Math.max(0,
        list0.scrollTop + (ob.top - lb.top) - (list0.clientHeight - on0.offsetHeight) / 2);
    }
  }

  // 放得下就向下，放不下就向上；左右夹在视口里。
  const r = wrap.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  const h = pop.offsetHeight || 300;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "";

  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("input", (e) => {
    if (e.target.classList.contains("ac-pop-find")) acPickFilter(pop, e.target.value);
  });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest(".ac-pop-opt");
    if (!b) return;
    const field0 = AC_PICK && AC_PICK.field;
    acPickClose(false);
    if (field0) acSetField(field0, b.dataset.val);
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      acPickClose(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...pop.querySelectorAll(".ac-pop-opt")].filter((o) => !o.hidden);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    const i = e.key === "ArrowDown"
      ? (cur < 0 ? 0 : Math.min(items.length - 1, cur + 1))
      : (cur < 0 ? items.length - 1 : Math.max(0, cur - 1));
    items[i].focus();
  });
  const inp = pop.querySelector(".ac-pop-find");
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const items = [...pop.querySelectorAll(".ac-pop-opt")].filter((o) => !o.hidden);
    if (items.length === 1) {
      e.preventDefault();
      const field0 = AC_PICK && AC_PICK.field;
      acPickClose(false);
      if (field0) acSetField(field0, items[0].dataset.val);
    }
  });
  inp.focus();
}

function acFlushSoon() {
  queueMicrotask(() => {
    if (typeof dashFlushAgentRender === "function" && !AC_PICK && !AC_MODEL_POP) {
      dashFlushAgentRender();
    }
  });
}

function acPickClose(refocus) {
  if (!AC_PICK) { acFlushSoon(); return; }
  const wrap = AC_PICK.wrap;
  AC_PICK = null;
  const pop = document.querySelector(".ac-pop");
  if (pop) pop.remove();
  if (wrap) {
    wrap.classList.remove("open");
    const b = wrap.querySelector(".ac-pick-btn");
    if (b) {
      b.setAttribute("aria-expanded", "false");
      if (refocus) b.focus();
    }
  }
  acFlushSoon();
}

// ---------------------------------------------------------------------------
// 主模型选择器（抽屉和终端格子头的 chip 共用）
// ---------------------------------------------------------------------------

function acModelPopClose(refocus) {
  if (!AC_MODEL_POP) { acFlushSoon(); return; }
  const { pop, anchor } = AC_MODEL_POP;
  AC_MODEL_POP = null;
  if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    if (refocus && anchor.focus) anchor.focus();
  }
  acFlushSoon();
}

/* 打开模型列表。selected 只用来打勾；不写入。
   onPick(value) 由调用方决定是“先选中再确认”还是“立即应用”。
   opts.applyLabel：给出应用按钮。此时点选项只改选中态，再点应用才调 onPick
   —— 终端格子头走这条（选模型和写配置分开，避免误点一下就把 agent 换了模型）。
   不给 applyLabel 时保持抽屉的老行为：点选项即回调（抽屉还要再点一次“应用”）。 */
function acModelPickOpen(anchor, agentId, field, selected, onPick, opts) {
  if (!anchor || !field || typeof onPick !== "function") return false;
  const gateways = agentGatewayOptions(field);
  if (!gateways.length) return false;
  acPickClose(false);
  acModelPopClose(false);
  const applyLabel = opts && opts.applyLabel ? String(opts.applyLabel) : "";
  // 应用按钮只接受列表里的网关模型：agent 当前可能用着它自己的模型
  // （Cursor 的 auto、Claude 的 sonnet…），那不是这一列里的可选项。
  const selectedInList = gateways.some((o) => o.value === selected);
  let picked = applyLabel ? (selectedInList ? selected : "") : (selected || "");

  const pop = document.createElement("div");
  pop.className = "ac-pop ac-model-pop";
  const find = t("ac.model.search");
  let list = "";
  let grp = null;
  for (const o of gateways) {
    const g = o.group || "";
    if (g !== grp && g) {
      list += `<div class="ac-pop-grp">${esc(AC_GROUP_KEYS[g] ? t(AC_GROUP_KEYS[g]) : g)}</div>`;
    }
    grp = g;
    list += acPickItemHTML(o.value, o.label || o.value, "", o.value === selected,
      o.note || "");
  }
  const foot = applyLabel
    ? `<div class="ac-pop-foot"><span class="ac-pop-pick">${esc(picked
        ? agentModelLabel(field, picked) : t("ac.model.pickFirst"))}</span>` +
      `<button type="button" class="ac-pop-apply${picked ? "" : " off"}" data-popapply` +
      `${picked ? "" : ' aria-disabled="true"'}>` +
      `${esc(applyLabel)}</button></div>`
    : "";
  pop.innerHTML = `<input class="ac-pop-find" type="search" autocomplete="off"` +
    ` placeholder="${esc(find)}" aria-label="${esc(find)}">` +
    `<div class="ac-pop-list" role="listbox">${list}</div>${foot}`;
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);

  const list0 = pop.querySelector(".ac-pop-list");
  const on0 = list0 && list0.querySelector(".ac-pop-opt.on");
  if (list0 && on0) {
    const lb = list0.getBoundingClientRect(), ob = on0.getBoundingClientRect();
    if (ob.top < lb.top || ob.bottom > lb.bottom) {
      list0.scrollTop = Math.max(0,
        list0.scrollTop + (ob.top - lb.top) - (list0.clientHeight - on0.offsetHeight) / 2);
    }
  }

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 340;
  const h = pop.offsetHeight || 320;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "";

  AC_MODEL_POP = { pop, anchor };
  anchor.setAttribute("aria-expanded", "true");
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("input", (e) => {
    if (e.target.classList.contains("ac-pop-find")) acPickFilter(pop, e.target.value);
  });
  pop.addEventListener("click", (e) => {
    if (applyLabel) {
      const ap = e.target.closest("[data-popapply]");
      if (ap) {
        if (ap.disabled || !picked) return;
        const value = picked;
        acModelPopClose(true);
        onPick(value);
        return;
      }
    }
    const b = e.target.closest(".ac-pop-opt");
    if (!b) return;
    const value = b.dataset.val;
    if (applyLabel) {
      // 只改选中态；写配置留给“应用”那一下。
      picked = value;
      for (const o of pop.querySelectorAll(".ac-pop-opt")) {
        const on = o === b;
        o.classList.toggle("on", on);
        o.setAttribute("aria-selected", on ? "true" : "false");
        const tick = o.querySelector(".tick");
        if (tick) tick.textContent = on ? "✓" : "";
      }
      const lab = pop.querySelector(".ac-pop-pick");
      if (lab) lab.textContent = agentModelLabel(field, value);
      const ap = pop.querySelector("[data-popapply]");
      if (ap) { ap.classList.remove("off"); ap.removeAttribute("aria-disabled"); }
      return;
    }
    acModelPopClose(false);
    onPick(value);
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      acModelPopClose(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...pop.querySelectorAll(".ac-pop-opt")].filter((o) => !o.hidden);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    const i = e.key === "ArrowDown"
      ? (cur < 0 ? 0 : Math.min(items.length - 1, cur + 1))
      : (cur < 0 ? items.length - 1 : Math.max(0, cur - 1));
    items[i].focus();
  });
  const inp = pop.querySelector(".ac-pop-find");
  inp.focus();
  return true;
}

// ---------------------------------------------------------------------------
// 手势
// ---------------------------------------------------------------------------

$("dash-agent-list").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-acfield]");
  if (!sel) return;
  acSetField(sel.dataset.acfield, sel.value);
});

function acOpenAgent() {
  if (!AC_ID) return;
  const id = AC_ID;
  acClose();
  if (typeof launchAgent === "function") launchAgent(id);
}

/* 这颗“打开”只在 Perch 真能为它起一格时出现。没有终端适配的 agent 仍然能
   在抽屉里配置/look，但不能给一个点了必然失败的按钮。 */
function acCatCanOpen(cat) {
  return !!(cat && cat.installed && cat.caps && cat.caps.launch);
}

$("dash-agent-list").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-acpick] .ac-pick-btn");
  if (pick && !pick.disabled) {
    acPickOpen(pick.closest("[data-acpick]").dataset.acpick);
    return;
  }

  const modelBtn = e.target.closest("[data-acmodel]");
  if (modelBtn && AC_ID && !AC_BUSY) {
    const cat = ((mg() && mg().catalog) || []).find((x) => x.id === AC_ID) || null;
    const v = cat ? agentRouteView(cat, gwInfoFor(cat.id), dashMagpieState()) : null;
    const field = v && v.modelField;
    if (field) {
      const selected = AC_MODEL_SEL || (v.wired ? v.currentModel : "");
      const ok = acModelPickOpen(modelBtn, AC_ID, field, selected, (value) => {
        AC_MODEL_SEL = value;
        acRender();
      });
      if (!ok) {
        showToast(t("ac.model.noModels"), t("ac.model.noSource"), "info");
      }
    }
    return;
  }

  const b = e.target.closest("[data-ac]");
  if (!b || !AC_ID) return;
  const act = b.dataset.ac;
  if (act === "model-disabled") {
    showToast(t("ac.model.pickFirst"), t("ac.model.hintConnect"), "info");
    return;
  }
  if (act === "model-apply" || act === "model-apply-only") {
    const cat = ((mg() && mg().catalog) || []).find((x) => x.id === AC_ID) || null;
    const v = cat ? agentRouteView(cat, gwInfoFor(cat.id), dashMagpieState()) : null;
    const field = v && v.modelField;
    if (!field || !AC_MODEL_SEL) return;
    if (act === "model-apply") {
      acApplyModel(field, AC_MODEL_SEL);
    } else {
      acSetFieldFor(AC_ID, field.key, AC_MODEL_SEL, true, false);
    }
    return;
  }
  if (act === "reopen-panes") {
    acReopenAgentPanes(AC_ID);
    return;
  }
  if (act === "open" || act === "open-local") {
    acOpenAgent();
    return;
  }
  if (act === "add-models") {
    // 去网关页加供应商/模型；抽屉固定在右侧，先收起来。
    acClose();
    if (typeof gwOpenProviders === "function") gwOpenProviders();
    return;
  }
  if (act === "reload") {
    AC_ERR = null;
    acRender();
    sendCtrl({ type: "gw.agents" });
    if (AC_ID) sendCtrl({ type: "gw.agent.preview", id: AC_ID });
    return;
  }
  if (act === "disconnect") {
    AC_CONFIRM = true;
    AC_ERR = null;
    if (!AC_PREVIEW) sendCtrl({ type: "gw.agent.preview", id: AC_ID });
    acRender();
    return;
  }
  if (act === "disconnect-cancel") {
    AC_CONFIRM = false;
    acRender();
    return;
  }
  if (act === "disconnect-go") {
    AC_BUSY = "disconnect";
    AC_ERR = null;
    acRender();
    sendCtrl({ type: "gw.agent.disconnect", id: AC_ID });
    bootFact(`Agent 配置 断开 ${AC_ID}`);
    return;
  }
  if (act === "keep") {
    // 不写文件：只是让 magpie 接受现状（见 internal/gateway/agents.go 的 gwAgentAction）。
    AC_BUSY = "keep";
    AC_ERR = null;
    acRender();
    sendCtrl({ type: "gw.agent.keep", id: AC_ID });
    bootFact(`Agent 配置 保留现状 ${AC_ID}`);
    return;
  }
  if (act === "reapply") {
    AC_BUSY = act;
    AC_ERR = null;
    acRender();
    sendCtrl({ type: "gw.agent.reapply", id: AC_ID });
    bootFact(`Agent 配置 重新应用 ${AC_ID}`);
  }
});

// 选择器开着时碰详情里任何别的东西（另一个字段、按钮）就先收起来：
// 否则原生 select 的菜单和弹层会同时挂在那儿。点自己那颗按钮不算（那是切换）。
$("dash-agent-list").addEventListener("pointerdown", (e) => {
  if (AC_MODEL_POP) {
    const w = e.target.closest("[data-agentmodel]");
    if (!(w && w === AC_MODEL_POP.anchor)) acModelPopClose(false);
  }
  if (!AC_PICK) return;
  const w = e.target.closest("[data-acpick]");
  if (w && w === AC_PICK.wrap) return;
  acPickClose(false);
}, true);

// 点页面别处不再收起详情：详情是总览的一部分，不是浮层。
// 模型弹层仍然点外面关闭；行点击会切换到另一行。
document.addEventListener("pointerdown", (e) => {
  if (AC_MODEL_POP) {
    const anchor = AC_MODEL_POP.anchor;
    if (!(e.target.closest(".ac-model-pop") || (anchor && anchor.contains(e.target)))) {
      acModelPopClose(false);
    }
  }
});

// Esc：先收选择器，再收抽屉。用捕获，焦点在下拉/终端里时也能生效。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (AC_MODEL_POP) {
    acModelPopClose(true);
    e.stopPropagation();
    return;
  }
  if (AC_PICK) {
    acPickClose(true);
    e.stopPropagation();
    return;
  }
  if (!AC_ID) return;
  acClose();
  e.stopPropagation();
}, true);

// 弹层是 fixed 的，总览一滚就跟着关（它不再指向原来那一行）。
document.querySelector(".dash-scroll").addEventListener("scroll", () => {
  acPickClose(false);
  acModelPopClose(false);
}, { passive: true });
window.addEventListener("resize", () => {
  acPickClose(false);
  acModelPopClose(false);
});
