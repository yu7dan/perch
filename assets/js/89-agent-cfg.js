"use strict";
/* 89-agent-cfg.js —— 总览 → Agent 名单 → 右侧配置抽屉（2026-10-18）。
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
 * 呈现：名单里点一格 → 右侧抽屉。抽屉只画 magpie 给的字段，不在 Perch 里
 * 另存一份配置 —— 谁是真相源这件事不能含糊。
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

function acOpen(id) {
  if (!id) return;
  if (AC_ID !== id) AC_PREVIEW = null;
  AC_ID = id;
  AC_BUSY = "";
  AC_ERR = null;
  AC_CONFIRM = false;
  renderAgentDrawer();
  // 打开时才问控制面（启动阶段它是被动的，不替用户拉起进程）。
  sendCtrl({ type: "gw.agents" });
  sendCtrl({ type: "gw.agent.preview", id });
  acDriftWatch(true);
  bootFact(`Agent 配置 打开 ${id}`);
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
  acDriftWatch(false);
  AC_ID = "";
  AC_BUSY = "";
  AC_ERR = null;
  AC_PREVIEW = null;
  AC_CONFIRM = false;
  renderAgentDrawer();
}

// ---------------------------------------------------------------------------
// 画
// ---------------------------------------------------------------------------

function renderAgentDrawer() {
  const box = $("agentcfg");
  if (!box) return;
  // 抽屉重画时弹层必须跟着消失：它挂在 body 上，不在这次 innerHTML 里。
  acPickClose(false);
  if (!AC_ID) {
    box.classList.remove("on");
    box.setAttribute("aria-hidden", "true");
    return;
  }
  const a = gwAgentOf(AC_ID);
  const cat = ((mg() && mg().catalog) || []).find((x) => x.id === AC_ID) || null;
  const name = (a && a.name) || (cat && cat.name) || AC_ID;
  const icon = (a && a.icon) || (cat && cat.icon) || "";
  const path = (a && a.path) || (cat && cat.path) || "";
  $("ac-ico").innerHTML = iconHTML(icon, "ac-ico-img");
  $("ac-name").textContent = name;
  $("ac-path").textContent = path;
  $("ac-path").title = path;
  $("ac-body").innerHTML = acBodyHTML(a, name);
  box.classList.add("on");
  box.setAttribute("aria-hidden", "false");
}

/* 七步时间线：不管 magpie 有没有这个 agent，都要能回答“我走到哪、下一步是什么”。
   旧抽屉在没有 magpie 行时直接显示空状态 —— 那正是用户说的“打开之后不知道为什么
   没被录入完整”。 */
function acIntegrationHTML(cat, v) {
  if (!cat || !v) return "";
  const rows = v.steps.map((s) => {
    const mech = s.mechanism ? t("agent.mech." + s.mechanism) : "";
    const note = s.noteKey ? t(s.noteKey, { name: cat.name || "" }) : "";
    const detail = [mech, note].filter(Boolean).join(" · ");
    return `<div class="ac-step ${esc(s.state)}" data-step="${esc(s.key)}">` +
      `<span class="ac-step-dot ${esc(s.state)}" aria-hidden="true"></span>` +
      `<span class="ac-step-k">${esc(t("agent.step." + s.key))}</span>` +
      `<span class="ac-step-v">${esc(t("agent.step.state." + s.state))}</span>` +
      (detail ? `<span class="ac-step-note" title="${esc(detail)}">${esc(detail)}</span>` : "") +
      `</div>`;
  }).join("");
  const complete = v.complete
    ? t(v.completeKind === "gateway" ? "agent.complete.gateway" : "agent.complete.native")
    : t("agent.complete.pending");
  const next = v.primary.step && v.primary.action !== "none" &&
      v.group !== "launch" && v.group !== "nolaunch" && v.group !== "missing"
    ? `<div class="ac-next">${esc(t("ac.integration.next", {
        step: t("agent.step." + v.primary.step),
        action: t("agent.action." + v.primary.action),
      }))}</div>`
    : "";
  return `<div class="ac-sec"><span class="ac-sec-title">${esc(t("ac.integration.title"))}</span>` +
    `<span class="ac-sec-sub">${esc(complete)}</span></div>` +
    `<div class="ac-steps">${rows}</div>` + next;
}

function acBodyHTML(a, name) {
  const cat = ((mg() && mg().catalog) || []).find((x) => x.id === (a ? a.id : AC_ID)) || null;
  const v = cat
    ? agentIntegrationView(cat, gwInfoFor(cat.id), AGENT_STATE[cat.id] || null, dashMagpieState())
    : null;
  const integration = acIntegrationHTML(cat, v);

  if (!a && !GW_AGENTS && !GW_AGENTS_ERR) {
    return (integration ? integration : "") +
      `<div class="ac-loading"><span class="spin"></span>${esc(t("ac.loading"))}</div>`;
  }
  if (!a) {
    return integration + `<div class="ac-empty">` +
      `${esc(t("ac.empty", { name }))}<br>` +
      `<span>${esc(msgText(GW_AGENTS_ERR) || t("ac.empty.count", { n: (GW_AGENTS || []).length }))}</span>` +
      `</div>` + acReloadHTML();
  }

  const busy = !!AC_BUSY;
  const b = (act, label, cls) =>
    `<button type="button" class="ac-btn${cls ? " " + cls : ""}" data-ac="${act}"` +
    `${busy ? " disabled" : ""}>${esc(label)}</button>`;
  const busyText = AC_BUSY === "connect" ? t("ac.busy.connect")
    : AC_BUSY === "disconnect" ? t("ac.busy.disconnect")
    : AC_BUSY === "reapply" ? t("ac.busy.reapply")
    : AC_BUSY === "keep" ? t("ac.busy.keep")
    : AC_BUSY.startsWith("set:") ? t("ac.busy.set") : "";

  let html = integration + `<div class="ac-status">` +
    `<span class="dot${a.wired ? " on" : ""}"></span>` +
    `<b>${esc(a.wired ? t("ac.status.wired") : t("ac.status.unwired"))}</b>` +
    (a.failover ? `<span class="ac-chip">${esc(t("ac.chip.failover"))}</span>` : "") +
    (busyText ? `<span class="ac-busy"><span class="spin"></span>${esc(busyText)}</span>` : "") +
    `<span class="ac-sp"></span>` + b("reload", t("ac.reload"), "quiet") +
    `</div>`;

  if (a.drift) html += acDriftHTML(a, a.drift);
  if (a.stale > 0) {
    html += `<div class="ac-note">` +
      `${esc(t("ac.stale", { n: a.stale, name: a.name }))}</div>`;
  }
  if (GW_AGENTS_NOTICE) {
    html += `<div class="ac-note">${esc(GW_AGENTS_NOTICE)}</div>`;
  }
  if (AC_ERR) html += `<div class="ac-err">${esc(msgText(AC_ERR))}</div>`;

  // 能力边界要说出来，而不是只在「仅启动」两个字上停住：Perch 能开一格，
  // 但没有状态适配器；agy 这种接了网关的，还要靠启动时注入环境变量。
  const caps = (cat && cat.caps) || {};
  if (caps.launch && !caps.status && !caps.title) {
    // 真正没有状态源才说“仅启动”；有标题弱信号的不再套这句旧话。
    html += `<div class="ac-hint">${esc(t("ac.launchOnly"))}</div>`;
    if (a.launch) html += `<div class="ac-hint">${esc(t("ac.launch.viaGateway"))}</div>`;
  } else if (caps.launch && caps.title) {
    html += `<div class="ac-hint">${esc(t("ac.titleOnly"))}</div>`;
    if (a.launch) html += `<div class="ac-hint">${esc(t("ac.launch.viaGateway"))}</div>`;
  } else if (!caps.launch && cat && cat.installed) {
    // 装了但 Perch 还没有为它接入终端启动：把边界说清楚，
    // 不要让抽屉里只剩一个不能点的「接入网关」。
    html += `<div class="ac-hint">${esc(t("ac.noTerminal"))}</div>`;
  }
  if (cat && cat.setup) {
    // 只启动 → 接入状态：入口在总览那一行（data-setup），这里只告诉用户去哪点。
    html += `<div class="ac-hint">${esc(t("ac.setupHint"))}</div>`;
  }

  const gwStep = v ? v.steps.find((s) => s.key === "gateway") : null;
  const gwUnsupported = !!(gwStep && gwStep.state === "unsupported");
  const gwWhy = gwStep && gwStep.noteKey ? t(gwStep.noteKey, { name: a.name || a.id }) : "";

  if (AC_CONFIRM) {
    html += acConfirmHTML(a);
  } else if (gwUnsupported) {
    /* 上游明确不支持（普通 Cursor CLI 就是）：**不 POST**、不给一个点了报 400
       的按钮。按钮照旧占位但做灰（aria-disabled，不是 disabled —— 禁掉的按钮
       title 不弹），原因和原生用法写在下面。 */
    html += `<div class="ac-actions">` +
      `<button type="button" class="ac-btn" aria-disabled="true" data-ac="gw-unavailable"` +
      ` title="${esc(gwWhy)}">${esc(t("ac.action.connect"))}</button>` +
      `</div>`;
    html += `<div class="ac-hint">${esc(gwWhy)}</div>`;
    html += `<div class="ac-hint">${esc(t("ac.gw.nativePath"))}</div>`;
    if (a.id === "cursor") {
      html += `<div class="ac-hint">${esc(t("ac.gw.cursorNative"))}</div>`;
    }
  } else {
    html += `<div class="ac-actions">` +
      (a.wired
        ? b("reapply", t("ac.action.reapply")) + b("disconnect", t("ac.action.disconnect"), "danger")
        : b("connect", t("ac.action.connect"), "primary")) +
      `</div>`;
    if (!a.wired) {
      html += `<div class="ac-hint">${esc(t("ac.hint.unwired"))}</div>`;
      if (gwStep && gwStep.noteKey && gwStep.noteKey !== "agent.note.gatewayAvailable") {
        html += `<div class="ac-hint">${esc(t(gwStep.noteKey, { name: a.name || a.id }))}</div>`;
      }
    }
  }

  html += acFieldsHTML(a, busy);
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
    ? `<div class="ac-drift-acts">` +
      `<button type="button" class="ac-btn" data-ac="keep"${AC_BUSY ? " disabled" : ""}` +
      ` title="${esc(t("ac.keep.title"))}">` +
      `${esc(t("ac.keep"))}</button><span>${esc(t("ac.keep.note"))}</span></div>`
    : "";
  return `<div class="ac-drift"><b>${esc(why)}</b>` +
    (d.detail ? `<span>${esc(d.detail)}</span>` : "") + keep + `</div>`;
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

function acFieldsHTML(a, busy) {
  const fields = Array.isArray(a.fields) ? a.fields : [];
  if (!fields.length) return `<div class="ac-hint">${esc(t("ac.fields.none"))}</div>`;
  let html = `<div class="ac-sec"><span class="ac-sec-title">${esc(t("ac.fields.title"))}</span>` +
    `<span class="ac-sec-sub">${esc(t("ac.fields.sub", { n: fields.length }))}</span></div>` +
    `<div class="ac-fields">` + fields.map((f) => acFieldHTML(a, f, busy)).join("") + `</div>`;
  // OpenCode 的推理档位叫 variant，选在它自己的 TUI 里（默认 Ctrl+T，
  // 实测 1.19.3 的 keybind 就是它）。magpie 接线时只把每个模型的 variants
  // 写进配置，没有把“默认档位”暴露成字段；这里给一条只读说明，不去直写
  // opencode.json —— 配置归 magpie。
  if (a.id === "opencode") {
    // 这一句里有 <kbd>，按受控 HTML 插入（键位是界面元素，不是用户数据）。
    html += `<div class="ac-hint">${t("ac.opencode.hint")}</div>`;
  }
  html += `<div class="ac-hint">${esc(t("ac.fields.footer"))}</div>`;
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

function acSetField(field, value) {
  if (!field || !AC_ID || AC_BUSY) return;
  AC_BUSY = "set:" + field;
  AC_ERR = null;
  AC_CONFIRM = false;
  renderAgentDrawer();
  sendCtrl({ type: "gw.agent.set", id: AC_ID, field, value });
  bootFact(`Agent 配置 写入 ${AC_ID}.${field}`);
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
  const wrap = [...$("ac-body").querySelectorAll("[data-acpick]")]
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

function acPickClose(refocus) {
  if (!AC_PICK) return;
  const wrap = AC_PICK.wrap;
  AC_PICK = null;
  const pop = document.querySelector(".ac-pop");
  if (pop) pop.remove();
  if (!wrap) return;
  wrap.classList.remove("open");
  const b = wrap.querySelector(".ac-pick-btn");
  if (b) {
    b.setAttribute("aria-expanded", "false");
    if (refocus) b.focus();
  }
}

// ---------------------------------------------------------------------------
// 手势
// ---------------------------------------------------------------------------

$("ac-x").addEventListener("click", acClose);

$("ac-body").addEventListener("change", (e) => {
  const sel = e.target.closest("[data-acfield]");
  if (!sel) return;
  acSetField(sel.dataset.acfield, sel.value);
});

$("ac-body").addEventListener("click", (e) => {
  const pick = e.target.closest("[data-acpick] .ac-pick-btn");
  if (pick && !pick.disabled) {
    acPickOpen(pick.closest("[data-acpick]").dataset.acpick);
    return;
  }
  const b = e.target.closest("[data-ac]");
  if (!b || !AC_ID) return;
  const act = b.dataset.ac;
  if (act === "gw-unavailable") {
    // 灰色按钮也要有回应：把“为什么不能接、还能怎么用”再说一遍。
    const cat = ((mg() && mg().catalog) || []).find((x) => x.id === AC_ID) || null;
    const v = cat
      ? agentIntegrationView(cat, gwInfoFor(cat.id), AGENT_STATE[cat.id] || null, dashMagpieState())
      : null;
    const step = v ? v.steps.find((s) => s.key === "gateway") : null;
    const why = step && step.noteKey
      ? t(step.noteKey, { name: (cat && cat.name) || AC_ID })
      : t("msg.gw.agentNotConnectable");
    showToast(t("ac.gw.unsupportedTitle"), why + " " + t("ac.gw.nativePath"), "info");
    return;
  }
  if (act === "reload") {
    AC_ERR = null;
    renderAgentDrawer();
    sendCtrl({ type: "gw.agents" });
    if (AC_ID) sendCtrl({ type: "gw.agent.preview", id: AC_ID });
    return;
  }
  if (act === "disconnect") {
    AC_CONFIRM = true;
    AC_ERR = null;
    if (!AC_PREVIEW) sendCtrl({ type: "gw.agent.preview", id: AC_ID });
    renderAgentDrawer();
    return;
  }
  if (act === "disconnect-cancel") {
    AC_CONFIRM = false;
    renderAgentDrawer();
    return;
  }
  if (act === "disconnect-go") {
    AC_BUSY = "disconnect";
    AC_ERR = null;
    renderAgentDrawer();
    sendCtrl({ type: "gw.agent.disconnect", id: AC_ID });
    bootFact(`Agent 配置 断开 ${AC_ID}`);
    return;
  }
  if (act === "keep") {
    // 不写文件：只是让 magpie 接受现状（见 internal/gateway/agents.go 的 gwAgentAction）。
    AC_BUSY = "keep";
    AC_ERR = null;
    renderAgentDrawer();
    sendCtrl({ type: "gw.agent.keep", id: AC_ID });
    bootFact(`Agent 配置 保留现状 ${AC_ID}`);
    return;
  }
  if (act === "connect" || act === "reapply") {
    AC_BUSY = act;
    AC_ERR = null;
    renderAgentDrawer();
    sendCtrl({ type: "gw.agent." + act, id: AC_ID });
    bootFact(`Agent 配置 ${act === "connect" ? "接入" : "重新应用"} ${AC_ID}`);
  }
});

// 选择器开着时碰抽屉里任何别的东西（另一个字段、按钮）就先收起来：
// 否则原生 select 的菜单和弹层会同时挂在那儿。点自己那颗按钮不算（那是切换）。
$("ac-body").addEventListener("pointerdown", (e) => {
  if (!AC_PICK) return;
  const w = e.target.closest("[data-acpick]");
  if (w && w === AC_PICK.wrap) return;
  acPickClose(false);
}, true);

// 点抽屉外面收起。指着另一行（[data-agentcfg]）时不关：那一下要换成那一行。
document.addEventListener("pointerdown", (e) => {
  if (!AC_ID) return;
  if (e.target.closest("#agentcfg") || e.target.closest("[data-agentcfg]")) return;
  acClose();
});

// Esc：先收选择器，再收抽屉。用捕获，焦点在下拉/终端里时也能生效。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (AC_PICK) {
    acPickClose(true);
    e.stopPropagation();
    return;
  }
  if (!AC_ID) return;
  acClose();
  e.stopPropagation();
}, true);

// 弹层是 fixed 的，抽屉一滚就跟着关（它不再指向原来那一行）。
$("ac-body").addEventListener("scroll", () => acPickClose(false), { passive: true });
window.addEventListener("resize", () => acPickClose(false));
