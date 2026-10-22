"use strict";
/* 87-gateway.js —— Perch 自己的网关页（2026-10-22，第二轮重做）。
 *
 * 形态：这一页只回答“模型从哪里来”。
 *   顶部状态条（引擎 / 版本 / 地址 / 启动 / 重启）
 *   供应商页头（标题 + 说明 + 搜索）
 *   已添加的供应商（行）
 *   供应商目录（按 vendor / relay / local 分组的 tiles）
 *   自定义供应商
 *
 * Agent 的安装、打开、选模型、接入都在总览（86-dash.js / 89-agent-cfg.js）。
 * 用量也在总览（86-dash.js 的网关用量卡）。这里不再有 Agents / Usage 标签。
 *
 * 数据流：
 *   GW          控制面连接状态（gw 消息）
 *   MAGPIE      引擎读数快照（magpie 消息，2.5s；这里只读版本/目录/模型数）
 *   GW_PROVIDERS 已添加供应商（gw.providers）
 *   GW_PRESETS   供应商模板（同一条 gw.providers）
 *   GW_AGENTS    /api/state 的 agents（gw.agents；声明在 89-agent-cfg.js）
 *
 * 安全：密钥只从表单 → ctl → Go → 引擎，单向；页面只展示 keyConfigured /
 * keyMasked / keyStatus。日志不记 key，DOM 里也不回填。
 *
 * 本文件是 index.html 里按序 defer 的一段 classic script；共享全局词法作用域。 */

let GW = null;
let GW_BUSY = "";                // 引擎动作进行中：start / restart
let GW_PROVIDERS = null;         // null = 还没读到
let GW_PRESETS = null;           // null = 还没读到
let GW_PROVIDERS_ERR = null;
let GW_PROVIDERS_LOADING = false;
let GW_PROVIDER_TESTING = "";    // provider id
let GW_AGENTS_LOADING = false;   // 总览的「重新扫描」按钮也用它
let GW_PRESET_QUERY = "";
// 编辑器是独立 DOM（#gw-edit），所以 #gw-body 可以随时重画，不需要 dirty 闸。
let GW_EDITOR = null;
let GW_EDITOR_ERR = "";
let GW_EDITOR_SAVING = false;
let GW_EDITOR_DIRTY = false;
let GW_EDITOR_FOCUS = false;

function gwOn() { return !!(GW && GW.connected); }

function gwErrText(m) {
  if (!m) return "";
  return tMsg(m.errCode, m.errParams, m.err || "");
}

function gwVersion() {
  const m = mg();
  return (m && m.version) || "";
}

function gwSwap(id, html) {
  const el = $(id);
  if (!el) return;
  if (el.__gwHTML === html) return;
  el.__gwHTML = html;
  const top = el.scrollTop;
  el.innerHTML = html;
  el.scrollTop = top;
}

function gwHost(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  try { return new URL(s).host; } catch { return s.replace(/^https?:\/\//, "").split(/[/?#]/)[0]; }
}

function gwSafeURL(url) {
  const s = String(url || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

// ---------------------------------------------------------------------------
// 入口与加载
// ---------------------------------------------------------------------------

function gwOpenProviders() {
  if (typeof setNavView === "function" && NAV_HERE !== "dash") setNavView("dash");
  const b = document.querySelector('#dash-tabs [data-dtab="gateway"]');
  if (b && typeof dashTab !== "undefined" && dashTab !== "gateway") b.click();
  renderGateway();
  gwLoadProviders(false);
}

/* 供应商行上的 agent 小图标：切回总览并展开那一行。 */
function gwOpenAgent(id) {
  if (!id) return;
  if (typeof setNavView === "function" && NAV_HERE !== "dash") setNavView("dash");
  const b = document.querySelector('#dash-tabs [data-dtab="overview"]');
  if (b && typeof dashTab !== "undefined" && dashTab !== "overview") b.click();
  requestAnimationFrame(() => {
    if (typeof renderDashboard === "function") renderDashboard("供应商 → Agent");
    if (typeof acOpen === "function") acOpen(id, true);
  });
}

function gwLoadProviders(force) {
  if (!gwOn() || GW_PROVIDERS_LOADING) return;
  if (!force && GW_PROVIDERS !== null && GW_PRESETS !== null) return;
  GW_PROVIDERS_LOADING = true;
  sendCtrl({ type: "gw.providers" });
}

// ---------------------------------------------------------------------------
// 画：状态条 / 页壳 / 主体
// ---------------------------------------------------------------------------

function renderGateway() {
  if (typeof NAV_HERE === "undefined" || NAV_HERE !== "dash") return;
  if (typeof dashTab === "undefined" || dashTab !== "gateway") return;
  if (!$("gw-status")) return;
  gwSwap("gw-status", gwStatusHTML());
  gwEnsureShell();
  const search = $("gw-search");
  if (search) search.disabled = !gwOn();
  gwRenderBody();
}

function gwStatusHTML() {
  const on = gwOn();
  const err = GW ? gwErrText(GW) : "";
  const state = GW_BUSY ? t("gw.engine.starting")
    : on ? t("gw.engine.running")
      : err ? t("gw.engine.errTitle")
        : t("gw.engine.stopped");
  const dot = on ? "on" : err ? "bad" : "warn";
  const ver = gwVersion();
  let html = `<span class="gw-dot ${dot}"></span>` +
    `<b>${esc(t("gw.engine.title"))}</b><span>${esc(state)}</span>`;
  if (ver) html += `<span class="sep">·</span><span>${esc(t("gw.engine.version", { v: ver }))}</span>`;
  if (on && GW.gateway) {
    html += `<span class="sep">·</span>` +
      `<span class="addr" title="${esc(t("gw.engine.address"))}">${esc(GW.gateway)}</span>`;
  }
  if (err) html += `<span class="sep">·</span><span class="err" title="${esc(err)}">${esc(err)}</span>`;
  html += `<span class="fsp"></span><span class="gw-actions">`;
  if (!on) {
    html += `<button type="button" class="gw-btn primary sm" data-gwact="start"` +
      `${GW_BUSY ? " disabled" : ""}>${esc(t("gw.engine.start"))}</button>`;
  } else {
    html += `<button type="button" class="gw-btn sm" data-gwact="restart"` +
      `${GW_BUSY ? " disabled" : ""}>${esc(t("gw.engine.restart"))}</button>`;
  }
  html += `</span>`;
  return html;
}

function gwEnsureShell() {
  const view = $("gw-view");
  if (!view) return;
  if (view.dataset.shell === PERCH_LOCALE && $("gw-body")) return;
  view.dataset.shell = PERCH_LOCALE;
  view.innerHTML =
    `<div class="gw-page">` +
      `<div class="gw-head"><div class="gw-id">` +
        `<h2>${esc(t("gw.providers.title"))}</h2>` +
        `<p>${esc(t("gw.providers.note"))}</p>` +
      `</div>` +
      `<label class="gw-search"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"` +
        ` stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">` +
        `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>` +
        `<input id="gw-search" type="search" autocomplete="off" spellcheck="false"` +
        ` value="${esc(GW_PRESET_QUERY)}" placeholder="${esc(t("gw.catalog.search"))}"` +
        ` aria-label="${esc(t("gw.catalog.search"))}"></label>` +
      `</div>` +
      `<div id="gw-body"></div>` +
    `</div>`;
}

function gwRenderBody() {
  if (!$("gw-body")) return;
  gwSwap("gw-body", gwBodyHTML());
}

function gwEngineDownHTML() {
  const missing = !!(GW && GW.errCode === "gw.engineMissing");
  const err = GW ? gwErrText(GW) : "";
  return `<div class="gw-down">` +
    `<div class="gw-down-id"><b>${esc(missing ? t("gw.engine.missing") : t("gw.engine.stopped"))}</b>` +
    `<span>${esc(missing ? t("gw.engine.missingBody") : (err || t("gw.engine.missingBody")))}</span></div>` +
    (missing ? "" : `<button type="button" class="gw-btn primary" data-gwact="start"` +
      `${GW_BUSY ? " disabled" : ""}>${esc(t("gw.engine.start"))}</button>`) +
    `</div>`;
}

function gwQuery() {
  return String(GW_PRESET_QUERY || "").trim().toLowerCase();
}

function gwProviderMatch(p) {
  const q = gwQuery();
  if (!q) return true;
  const hay = [p.name, p.id, p.host, p.baseUrl, p.preset,
    ...(p.models || []).map((m) => `${m.id} ${m.label || ""}`),
    ...(p.agents || []).map((a) => a.name || a.id)].join(" ").toLowerCase();
  return hay.includes(q);
}

function gwPresetMatch(p) {
  const q = gwQuery();
  if (!q) return true;
  const hay = [p.name, p.short, p.id, p.note, p.chat, p.responses, p.anthropic,
    p.website, p.keysUrl, gwHost(p.chat || p.responses || p.anthropic)]
    .join(" ").toLowerCase();
  return hay.includes(q);
}

function gwBodyHTML() {
  if (!gwOn()) return gwEngineDownHTML();
  if (GW_PROVIDERS_ERR) {
    return `<div class="gw-error"><span>${esc(msgText(GW_PROVIDERS_ERR))}</span>` +
      `<button type="button" class="gw-btn sm" data-gwretry>${esc(t("gw.providers.retry"))}</button></div>`;
  }
  if (GW_PROVIDERS === null) {
    return `<div class="gw-loading"><span class="spin"></span>${esc(t("gw.provider.loading"))}</div>`;
  }
  return gwAddedHTML() + gwCatalogHTML();
}

function gwAddedHTML() {
  const all = GW_PROVIDERS || [];
  const list = all.filter(gwProviderMatch);
  if (!all.length) return "";
  if (!list.length && gwQuery()) return "";
  return `<section class="gw-added">` +
    `<div class="gw-sec-head"><b>${esc(t("gw.providers.added"))}</b>` +
    `<span>${esc(t("gw.providers.addedHint", { n: all.length }))}</span></div>` +
    `<div class="gw-list">${list.map(gwProviderRowHTML).join("")}</div>` +
    `</section>`;
}

function gwKeyPillHTML(p) {
  let status = p.keyStatus;
  let label = t("gw.providers.key.missing");
  let cls = "plain";
  if (p.keyOptional && !p.keyConfigured) {
    label = t("gw.providers.key.free");
    cls = "plain";
  } else if (status === "ok") {
    label = t("gw.providers.key.ok");
    cls = "ok";
  } else if (status === "untested") {
    label = t("gw.providers.key.untested");
    cls = "warn";
  }
  const title = p.keyMasked
    ? t("gw.providers.keyMasked", { masked: p.keyMasked })
    : (p.keyOptional ? t("gw.providers.keyOptional") : t("gw.providers.keyMissing"));
  return `<span class="gw-key ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

function gwProviderUsesHTML(p) {
  const uses = (p.agents || []).filter((a) => a.current);
  if (!uses.length) return `<span class="gw-uses"></span>`;
  const shown = uses.slice(0, 4).map((a) =>
    `<button type="button" class="gw-use" data-gwopenagent="${esc(a.id)}"` +
    ` title="${esc(t("gw.providers.usedBy", { name: a.name || a.id, model: a.model || "" }))}">` +
    `${iconHTML(a.icon || "")}</button>`).join("");
  const more = uses.length > 4 ? `<span class="gw-use-more">+${uses.length - 4}</span>` : "";
  return `<span class="gw-uses">${shown}${more}</span>`;
}

function gwProviderRowHTML(p) {
  const onModels = (p.models || []).filter((m) => m.on).length;
  const models = onModels
    ? tCount("gw.providers.models", onModels, { n: onModels })
    : (p.models || []).length ? t("gw.providers.vendorList") : t("gw.providers.nomodels");
  const host = p.host || gwHost(p.baseUrl);
  const icon = p.icon ? iconHTML(p.icon) : `<span class="gw-letter">${esc((p.name || p.id || "?").charAt(0).toUpperCase())}</span>`;
  return `<div class="gw-prow" data-gwedit="${esc(p.id)}" role="button" tabindex="0">` +
    `<span class="gw-pico">${icon}</span>` +
    `<span class="gw-pmain"><b>${esc(p.name || p.id)}</b>` +
    `<small>${esc(host)}${host ? " · " : ""}${esc(models)}</small></span>` +
    gwProviderUsesHTML(p) + gwKeyPillHTML(p) +
    `<span class="gw-chev" aria-hidden="true">›</span></div>`;
}

function gwIsCnVariant(p) {
  return p.id.endsWith("-cn") && (GW_PRESETS || []).some((x) => x.id === p.id.slice(0, -3));
}

function gwPresetPair(pr) {
  if (!pr) return null;
  const all = GW_PRESETS || [];
  if (pr.id.endsWith("-cn")) {
    const base = all.find((x) => x.id === pr.id.slice(0, -3));
    return base ? [base, pr] : null;
  }
  const cn = all.find((x) => x.id === pr.id + "-cn");
  return cn ? [pr, cn] : null;
}

function gwPresetAdded(pr) {
  const pair = gwPresetPair(pr);
  return pair ? pair.some((x) => x.added) : !!pr.added;
}

function gwTileHTML(pr) {
  const name = pr.short || pr.name;
  const added = gwPresetAdded(pr);
  const host = gwHost(pr.chat || pr.responses || pr.anthropic);
  const title = [pr.name, pr.note, host].filter(Boolean).join(" · ");
  return `<button type="button" class="gw-tile${added ? " added" : ""}"` +
    ` data-gwpreset="${esc(pr.id)}" title="${esc(title)}">` +
    `${iconHTML(pr.icon || "")}<span class="nm">${esc(name)}</span>` +
    (added ? `<span class="have" aria-hidden="true"></span>` : "") +
    `</button>`;
}

function gwCatalogHTML() {
  const all = GW_PRESETS || [];
  const q = gwQuery();
  const groups = [
    ["vendor", "gw.catalog.vendors", "gw.catalog.vendorsHint"],
    ["relay", "gw.catalog.relays", "gw.catalog.relaysHint"],
    ["local", "gw.catalog.local", "gw.catalog.localHint"],
  ];
  let body = "";
  let any = false;
  for (const [kind, labelKey, hintKey] of groups) {
    const rows = all.filter((p) => p.kind === kind && !gwIsCnVariant(p))
      .filter((p) => {
        if (!q) return true;
        const pair = gwPresetPair(p);
        return gwPresetMatch(p) || (pair && pair.some(gwPresetMatch));
      });
    if (!rows.length) continue;
    any = true;
    body += `<div class="gw-cat-group">` +
      `<div class="gw-cat-title"><b>${esc(t(labelKey))}</b><span>${esc(t(hintKey))}</span></div>` +
      `<div class="gw-tiles">${rows.map(gwTileHTML).join("")}</div></div>`;
  }
  if (!body) {
    body = `<div class="gw-none">${esc(t("gw.catalog.none", { q: GW_PRESET_QUERY.trim() }))}</div>`;
  }
  const custom = !q || !any
    ? `<div class="gw-custom"><button type="button" class="gw-custom-btn" data-gwcustom>` +
      `<span class="plus" aria-hidden="true">+</span>${esc(t("gw.catalog.custom"))}</button>` +
      `<span>${esc(t("gw.catalog.customHint"))}</span></div>` : "";
  return `<section class="gw-catalog">` +
    `<div class="gw-sec-head"><b>${esc(t("gw.catalog.title"))}</b>` +
    `<span>${esc(t("gw.catalog.hint"))}</span></div>` +
    body + custom + `</section>`;
}

function gwPresetByID(id) {
  return (GW_PRESETS || []).find((p) => p.id === id) || null;
}
function gwProviderByPreset(id) {
  const ps = GW_PROVIDERS || [];
  return ps.find((p) => p.preset === id) || ps.find((p) => p.id === id) || null;
}

function gwPresetTileClick(id) {
  const pr = gwPresetByID(id);
  if (!pr) return;
  const pair = gwPresetPair(pr);
  if (pair) {
    const have = pair.map((x) => gwProviderByPreset(x.id)).filter(Boolean);
    if (have.length) { gwEditorSwap(() => gwEditorOpenProvider(have[0])); return; }
    gwEditorSwap(() => gwEditorOpenPreset(pair[0]));
    return;
  }
  const p = gwProviderByPreset(id);
  if (p) gwEditorSwap(() => gwEditorOpenProvider(p));
  else gwEditorSwap(() => gwEditorOpenPreset(pr));
}

// ---------------------------------------------------------------------------
// 供应商编辑器（右侧 sheet）
// ---------------------------------------------------------------------------

function gwEditorBasePreset(pr) {
  return {
    mode: pr ? "preset" : "custom",
    id: "",
    preset: pr ? pr.id : "",
    presetInfo: pr || null,
    provider: null,
    name: pr ? (pr.name || "") : "",
    protocol: "openai",
    baseUrl: "",
    key: "",
    modelsText: "",
    models: new Set(),
    modelQuery: "",
    endpoints: {},
    region: "",
    regionChanged: false,
    endpoint: "",
    endpointChanged: false,
  };
}

async function gwEditorSwap(open) {
  if (GW_EDITOR && GW_EDITOR_DIRTY) {
    const ok = await askConfirm({
      title: t("gw.editor.discardTitle"),
      body: t("gw.editor.discardBody"),
      ok: t("gw.editor.discard"),
      danger: true,
    });
    if (!ok) return;
  }
  open();
}

function gwEditorOpenPreset(pr) {
  if (!pr) return;
  GW_EDITOR = gwEditorBasePreset(pr);
  if (pr.regions && pr.regions.length) {
    GW_EDITOR.region = pr.regions[0].id;
  }
  GW_EDITOR_DIRTY = false;
  GW_EDITOR_ERR = "";
  GW_EDITOR_SAVING = false;
  GW_EDITOR_FOCUS = true;
  renderGwEditor();
}

function gwEditorOpenProvider(p) {
  const pr = p && p.preset ? gwPresetByID(p.preset) : null;
  if (pr) {
    GW_EDITOR = gwEditorBasePreset(pr);
    GW_EDITOR.id = p.id;
    GW_EDITOR.provider = p;
    GW_EDITOR.name = p.name || pr.name;
    GW_EDITOR.models = new Set((p.models || []).filter((m) => m.on).map((m) => m.id));
    if (pr.endpoint) {
      GW_EDITOR.endpoint = p.baseUrl || p.chat || p.responses || "";
    }
    if (pr.regions && pr.regions.length) {
      const at = pr.regions.find((r) =>
        (r.chat && r.chat === p.chat) || (r.responses && r.responses === p.responses) ||
        (r.anthropic && r.anthropic === p.anthropic));
      if (at) GW_EDITOR.region = at.id;
    }
  } else {
    GW_EDITOR = gwEditorBasePreset(null);
    GW_EDITOR.id = p.id;
    GW_EDITOR.provider = p;
    GW_EDITOR.name = p.name || p.id;
    GW_EDITOR.protocol = p.protocol || "openai";
    GW_EDITOR.baseUrl = p.baseUrl || "";
    GW_EDITOR.modelsText = (p.models || []).map((m) => m.id).join("\n");
  }
  GW_EDITOR_DIRTY = false;
  GW_EDITOR_ERR = "";
  GW_EDITOR_SAVING = false;
  GW_EDITOR_FOCUS = true;
  renderGwEditor();
}

function gwEditorOpenCustom() {
  GW_EDITOR = gwEditorBasePreset(null);
  GW_EDITOR_DIRTY = false;
  GW_EDITOR_ERR = "";
  GW_EDITOR_SAVING = false;
  GW_EDITOR_FOCUS = true;
  renderGwEditor();
}

async function gwEditorClose(force) {
  if (!GW_EDITOR) return;
  if (!force && GW_EDITOR_DIRTY) {
    const ok = await askConfirm({
      title: t("gw.editor.discardTitle"),
      body: t("gw.editor.discardBody"),
      ok: t("gw.editor.discard"),
      danger: true,
    });
    if (!ok) return;
  }
  GW_EDITOR = null;
  GW_EDITOR_ERR = "";
  GW_EDITOR_SAVING = false;
  GW_EDITOR_DIRTY = false;
  renderGwEditor();
}

function gwEditorRegionAt(pr, ed) {
  return (pr && pr.regions || []).find((r) => r.id === ed.region) || null;
}

function gwEditorSite(pr, p) {
  const ed = GW_EDITOR || {};
  const r = pr ? gwEditorRegionAt(pr, ed) : null;
  const url = (r && r.website) || (pr && pr.website) || (p && p.website) || "";
  if (gwSafeURL(url)) return url;
  const host = (p && p.host) || gwHost(pr && (pr.chat || pr.responses || pr.anthropic));
  return host ? "https://" + host : "";
}

function gwEditorKeysURL(pr, p) {
  const ed = GW_EDITOR || {};
  const r = pr ? gwEditorRegionAt(pr, ed) : null;
  const url = (r && r.keysUrl) || (pr && pr.keysUrl) || (p && p.website) || "";
  return gwSafeURL(url);
}

function gwSegHTML(items, current, attr) {
  return `<div class="gwe-seg">` + items.map(([v, label]) =>
    `<button type="button" class="gwe-opt${v === current ? " on" : ""}"` +
    ` data-${attr}="${esc(v)}">${esc(label)}</button>`).join("") + `</div>`;
}

function gwFieldHTML(label, control, hint) {
  return `<div class="gwe-row"><span class="gwe-k">${esc(label)}</span>` +
    `<span class="gwe-c">${control}` +
    (hint ? `<span class="gwe-hint">${esc(hint)}</span>` : "") + `</span></div>`;
}

function gwKeyFieldHTML(pr, p) {
  const ed = GW_EDITOR;
  const hint = pr
    ? (p && p.keyConfigured
      ? t("gw.provider.keyKeep")
      : (pr.keyHint || (pr.noKey ? t("gw.provider.keyOptional") : t("gw.provider.keyHint"))))
    : (p && p.keyConfigured ? t("gw.provider.keyKeep") : t("gw.provider.keyHint"));
  const placeholder = p && p.keyConfigured
    ? `${p.keyMasked || "••••"} · ${t("gw.provider.keyKeepShort")}`
    : (pr && pr.keyHint ? pr.keyHint : (pr && pr.noKey ? t("gw.provider.keyOptional") : t("gw.provider.keyPlaceholder")));
  // 本机服务本来就不需要 key：不要再摆一条「获取 key」把人引去注册。
  const keysURL = pr && pr.noKey ? "" : gwEditorKeysURL(pr, p);
  return gwFieldHTML(t("gw.provider.key"),
    `<input class="gwe-input" id="gwe-key" type="password" autocomplete="off" spellcheck="false"` +
    ` placeholder="${esc(placeholder)}" value="${esc(ed.key || "")}" aria-label="${esc(t("gw.provider.key"))}">` +
    `<span class="gwe-links">` +
    (keysURL ? `<button type="button" class="gwe-link" data-gweurl="${esc(keysURL)}">${esc(t("gw.provider.getKey"))} ↗</button>` : "") +
    (p && p.keyConfigured ? `<span class="gw-key ${p.keyStatus === "ok" ? "ok" : "warn"}">` +
      `${esc(p.keyStatus === "ok" ? t("gw.providers.key.ok") : t("gw.providers.key.untested"))}</span>` : "") +
    `</span>`, hint);
}

function gwModelsHTML(pr, p) {
  if (!p) {
    return `<div class="gwe-note">${esc(t("gw.editor.modelsAfterSave"))}</div>`;
  }
  const models = p.models || [];
  const q = (GW_EDITOR.modelQuery || "").trim().toLowerCase();
  const shown = q ? models.filter((m) => `${m.id} ${m.label || ""}`.toLowerCase().includes(q)) : models;
  const chips = shown.slice(0, 80).map((m) => {
    const on = GW_EDITOR.models.has(m.id);
    return `<button type="button" class="mchip${on ? " on" : ""}" data-gwemodel="${esc(m.id)}"` +
      ` title="${esc(m.id)}">${esc(m.label && m.label !== m.id ? m.label : m.id)}</button>`;
  }).join("");
  const search = models.length > 24
    ? `<input class="gwe-input gwe-model-find" id="gwe-model-search" type="search" autocomplete="off"` +
      ` placeholder="${esc(t("gw.editor.findModel"))}" value="${esc(GW_EDITOR.modelQuery || "")}">`
    : "";
  const hint = !models.length
    ? t("gw.editor.noModelsYet")
    : (GW_EDITOR.models.size
      ? t("gw.editor.modelsPicked", { n: GW_EDITOR.models.size })
      : t("gw.editor.modelsVendorList"));
  return `<div class="gwe-row"><span class="gwe-k">${esc(t("gw.provider.models"))}</span>` +
    `<span class="gwe-c">${search}<div class="mchips gwe-chips">${chips || ""}</div>` +
    `<span class="gwe-hint">${esc(hint)}</span></span></div>`;
}

function gwPresetEditorBody(pr, p) {
  let html = "";
  const pair = gwPresetPair(pr);
  if (pair && !p) {
    const items = pair.map((x, i) => [x.id, i === 0 ? t("gw.region.global") : t("gw.region.china")]);
    html += gwFieldHTML(t("gw.region.label"), gwSegHTML(items, GW_EDITOR.preset, "gwepreset"));
  } else if (pr.regions && pr.regions.length) {
    html += gwFieldHTML(pr.regionLabel || t("gw.region.label"),
      gwSegHTML(pr.regions.map((r) => [r.id, r.name]), GW_EDITOR.region, "gweregion"));
  }
  if (pr.endpoint) {
    html += gwFieldHTML(t("gw.provider.endpoint"),
      `<input class="gwe-input" id="gwe-endpoint" type="text" spellcheck="false"` +
      ` placeholder="${esc(pr.endpoint)}" value="${esc(GW_EDITOR.endpoint || "")}">`,
      pr.endpointHint || t("gw.provider.endpointHint"));
  }
  html += gwKeyFieldHTML(pr, p);
  if (p) {
    html += gwModelsHTML(pr, p);
    const eps = [p.baseUrl, p.chat, p.responses, p.anthropic].filter(Boolean);
    if (eps.length) {
      html += `<details class="gwe-more"><summary>${esc(t("gw.editor.endpoints"))}</summary>` +
        `<div class="gwe-eps">${[...new Set(eps)].map((u) =>
          `<span title="${esc(u)}">${esc(gwHost(u) || u)}</span>`).join("")}</div></details>`;
    }
  }
  return html;
}

function gwCustomEditorBody(p) {
  const protocols = [["openai", "OpenAI"], ["responses", "Responses"],
    ["anthropic", "Anthropic"], ["gemini", "Gemini"]];
  let html = "";
  html += gwFieldHTML(t("gw.provider.name"),
    `<input class="gwe-input" id="gwe-name" type="text" spellcheck="false"` +
    ` value="${esc(GW_EDITOR.name || "")}">`);
  html += gwFieldHTML(t("gw.provider.protocol"),
    gwSegHTML(protocols.map(([v, l]) => [v, l]), GW_EDITOR.protocol, "gweproto"));
  html += gwFieldHTML(t("gw.provider.baseUrl"),
    `<input class="gwe-input" id="gwe-base" type="text" spellcheck="false"` +
    ` placeholder="${esc(defaultGwBase(GW_EDITOR.protocol))}" value="${esc(GW_EDITOR.baseUrl || "")}">`,
    t("gw.provider.baseHint"));
  html += gwKeyFieldHTML(null, p);
  html += gwFieldHTML(t("gw.provider.models"),
    `<textarea class="gwe-area" id="gwe-models" spellcheck="false"` +
    ` placeholder="gpt-5.1&#10;gpt-5.1-mini">${esc(GW_EDITOR.modelsText || "")}</textarea>`,
    t("gw.provider.modelsHint"));
  return html;
}

function gwEditorHTML() {
  const ed = GW_EDITOR;
  if (!ed) return "";
  const pr = ed.presetInfo;
  const p = ed.provider;
  const custom = ed.mode === "custom";
  const icon = custom ? (p && p.icon ? p.icon : "") : (pr && pr.icon ? pr.icon : "");
  const name = ed.name || (pr && pr.name) || (p && p.name) || t("gw.catalog.custom");
  const note = pr ? pr.note : t("gw.catalog.customHint");
  const site = gwEditorSite(pr, p);
  const title = custom && p ? t("gw.provider.editTitle") : (p ? t("gw.provider.editTitle") : t("gw.provider.new"));
  // 自定义供应商没有品牌图标：用首字母方块（和已添加行同一枚符号），
  // 不要留一个空白方块 —— iconHTML("") 画的是空 mask，看着像丢图。
  const iconBox = icon ? iconHTML(icon)
    : `<span class="gw-letter">${esc((name || "+").charAt(0).toUpperCase())}</span>`;
  let html = `<div class="gwe-head">` +
    `<span class="gwe-ico">${iconBox}</span>` +
    `<span class="gwe-id"><b>${esc(name)}</b><span>${esc(note || "")}</span></span>` +
    (site ? `<button type="button" class="gwe-site" data-gweurl="${esc(site)}">` +
      `${esc(gwHost(site))} ↗</button>` : "") +
    `<button type="button" class="gwe-x" data-gweclose title="${esc(t("common.close"))}"` +
    ` aria-label="${esc(t("common.close"))}">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>` +
    `</div>`;
  html += `<div class="gwe-body">` +
    `<div class="gwe-kind">${esc(title)}</div>` +
    (custom ? gwCustomEditorBody(p) : gwPresetEditorBody(pr, p)) +
    (GW_EDITOR_ERR ? `<div class="gwe-err">${esc(GW_EDITOR_ERR)}</div>` : "") +
    `</div>`;
  const testing = GW_PROVIDER_TESTING === (p && p.id);
  html += `<div class="gwe-foot">` +
    (p ? `<button type="button" class="gwe-danger" data-gwedelete>${esc(t("gw.providers.delete"))}</button>` : "") +
    `<span class="fsp"></span>` +
    (p ? `<button type="button" class="gw-btn sm" data-gwetest${testing || GW_EDITOR_SAVING ? " disabled" : ""}` +
      ` title="${esc(ed.key ? t("gw.editor.saveBeforeTest") : t("gw.providers.test"))}">` +
      `${esc(testing ? t("gw.providers.testing") : t("gw.providers.test"))}</button>` : "") +
    `<button type="button" class="gw-btn primary sm" data-gwesave${GW_EDITOR_SAVING ? " disabled" : ""}>` +
    `${esc(GW_EDITOR_SAVING ? t("gw.provider.saving") : (p ? t("gw.provider.save") : t("gw.provider.add")))}</button>` +
    `</div>`;
  return html;
}

function renderGwEditor() {
  const host = $("gw-edit");
  if (!host) return;
  if (!GW_EDITOR) {
    host.classList.remove("on");
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = "";
    return;
  }
  host.innerHTML = gwEditorHTML();
  host.classList.add("on");
  host.setAttribute("aria-hidden", "false");
  if (GW_EDITOR_FOCUS) {
    GW_EDITOR_FOCUS = false;
    const field = GW_EDITOR.mode === "custom" ? $("gwe-name") : $("gwe-key");
    if (field) field.focus();
  }
}

function defaultGwBase(protocol) {
  if (protocol === "anthropic") return "https://api.anthropic.com";
  if (protocol === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  return "https://api.openai.com/v1";
}

function gwEditorSetRegion(id) {
  const ed = GW_EDITOR;
  const pr = ed && ed.presetInfo;
  if (!pr) return;
  const r = (pr.regions || []).find((x) => x.id === id);
  if (!r) return;
  ed.region = id;
  ed.regionChanged = true;
  ed.endpoints = {};
  for (const k of ["chat", "responses", "anthropic"]) {
    if (r[k]) ed.endpoints[k] = r[k];
  }
  GW_EDITOR_DIRTY = true;
  renderGwEditor();
}

function gwEditorSetPreset(id) {
  const ed = GW_EDITOR;
  if (!ed) return;
  const pr = gwPresetByID(id);
  if (!pr) return;
  const key = ed.key;
  GW_EDITOR = gwEditorBasePreset(pr);
  GW_EDITOR.key = key;
  GW_EDITOR_DIRTY = true;
  if (pr.regions && pr.regions.length) GW_EDITOR.region = pr.regions[0].id;
  GW_EDITOR_FOCUS = true;
  renderGwEditor();
}

function gwEditorSave() {
  const ed = GW_EDITOR;
  if (!ed || GW_EDITOR_SAVING) return;
  GW_EDITOR_ERR = "";
  const pr = ed.presetInfo;
  if (ed.mode === "custom") {
    if (!ed.name.trim()) { GW_EDITOR_ERR = t("gw.provider.requiredName"); renderGwEditor(); return; }
    const base = ed.baseUrl.trim();
    if (base && !/^https?:\/\//i.test(base)) {
      GW_EDITOR_ERR = t("gw.provider.baseBad"); renderGwEditor(); return;
    }
  } else {
    if (!ed.id && !pr.noKey && !ed.key.trim()) {
      GW_EDITOR_ERR = t("gw.provider.keyRequired"); renderGwEditor(); return;
    }
    if (pr.endpoint && !gwSafeURL(ed.endpoint)) {
      GW_EDITOR_ERR = pr.endpointNeeded || t("gw.provider.endpointRequired"); renderGwEditor(); return;
    }
  }
  GW_EDITOR_SAVING = true;
  renderGwEditor();
  const msg = {
    type: "gw.provider.save",
    providerId: ed.id || "",
    name: ed.name.trim(),
    key: ed.key,
  };
  if (ed.mode === "preset") {
    msg.preset = ed.preset;
    msg.protocol = "";
    msg.baseUrl = "";
    if (ed.id) {
      msg.models = [...ed.models];
      if (ed.regionChanged || ed.endpointChanged) msg.endpoints = { ...ed.endpoints };
    } else {
      if (Object.keys(ed.endpoints).length) msg.endpoints = { ...ed.endpoints };
      if (pr.noList && pr.models && pr.models.length && Object.keys(ed.endpoints).length) {
        msg.models = pr.models;
      }
    }
  } else {
    msg.protocol = ed.protocol;
    msg.baseUrl = ed.baseUrl.trim();
    const models = String(ed.modelsText || "").split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (models.length) msg.models = models;
  }
  sendCtrl(msg);
}

function gwEditorTest() {
  const ed = GW_EDITOR;
  if (!ed || !ed.id) return;
  if (ed.key) {
    showToast(t("gw.editor.saveBeforeTest"), "", "info");
    return;
  }
  GW_PROVIDER_TESTING = ed.id;
  sendCtrl({ type: "gw.credential.test", providerId: ed.id });
  renderGwEditor();
}

async function gwProviderDelete(id) {
  const p = (GW_PROVIDERS || []).find((x) => x.id === id);
  const name = p ? (p.name || p.id) : id;
  const ok = await askConfirm({
    title: t("gw.providers.deleteTitle"),
    body: t("gw.providers.deleteBody", { name }),
    ok: t("gw.providers.delete"),
    danger: true,
  });
  if (!ok) return;
  sendCtrl({ type: "gw.provider.delete", providerId: id });
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

$("gw-status").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gwact]");
  if (!b) return;
  const act = b.dataset.gwact;
  if (act === "start") {
    GW_BUSY = "start";
    sendCtrl({ type: "gw.engine.start" });
    renderGateway();
  } else if (act === "restart") {
    GW_BUSY = "restart";
    sendCtrl({ type: "gw.engine.restart" });
    renderGateway();
  }
});

$("gw-view").addEventListener("click", (e) => {
  const act = e.target.closest("[data-gwact]");
  if (act && act.dataset.gwact === "start") {
    GW_BUSY = "start";
    sendCtrl({ type: "gw.engine.start" });
    renderGateway();
    return;
  }
  if (e.target.closest("[data-gwretry]")) { gwLoadProviders(true); return; }
  const agent = e.target.closest("[data-gwopenagent]");
  if (agent) {
    e.preventDefault();
    e.stopPropagation();
    gwOpenAgent(agent.dataset.gwopenagent);
    return;
  }
  const preset = e.target.closest("[data-gwpreset]");
  if (preset) { gwPresetTileClick(preset.dataset.gwpreset); return; }
  const custom = e.target.closest("[data-gwcustom]");
  if (custom) { gwEditorSwap(gwEditorOpenCustom); return; }
  const row = e.target.closest("[data-gwedit]");
  if (row) {
    const p = (GW_PROVIDERS || []).find((x) => x.id === row.dataset.gwedit);
    if (p) gwEditorSwap(() => gwEditorOpenProvider(p));
  }
});

$("gw-view").addEventListener("input", (e) => {
  if (e.target.id !== "gw-search") return;
  GW_PRESET_QUERY = e.target.value;
  gwRenderBody();
});

$("gw-view").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("[data-gwedit]")) {
    e.preventDefault();
    const id = e.target.dataset.gwedit;
    const p = (GW_PROVIDERS || []).find((x) => x.id === id);
    if (p) gwEditorSwap(() => gwEditorOpenProvider(p));
    return;
  }
  if (e.target.id !== "gw-search" || e.key !== "Escape") return;
  if (GW_PRESET_QUERY) {
    e.preventDefault();
    GW_PRESET_QUERY = "";
    e.target.value = "";
    gwRenderBody();
  }
});

$("gw-edit").addEventListener("click", (e) => {
  const ed = GW_EDITOR;
  if (!ed) return;
  if (e.target.closest("[data-gweclose]")) { gwEditorClose(); return; }
  if (e.target.closest("[data-gwesave]")) { gwEditorSave(); return; }
  if (e.target.closest("[data-gwedelete]") && ed.id) { gwProviderDelete(ed.id); return; }
  if (e.target.closest("[data-gwetest]")) { gwEditorTest(); return; }
  const url = e.target.closest("[data-gweurl]");
  if (url) {
    const u = gwSafeURL(url.dataset.gweurl);
    if (u) sendCtrl({ type: "open.url", url: u });
    return;
  }
  const preset = e.target.closest("[data-gwepreset]");
  if (preset) { gwEditorSetPreset(preset.dataset.gwepreset); return; }
  const region = e.target.closest("[data-gweregion]");
  if (region) { gwEditorSetRegion(region.dataset.gweregion); return; }
  const proto = e.target.closest("[data-gweproto]");
  if (proto) {
    ed.protocol = proto.dataset.gweproto;
    GW_EDITOR_DIRTY = true;
    renderGwEditor();
    return;
  }
  const model = e.target.closest("[data-gwemodel]");
  if (model) {
    const id = model.dataset.gwemodel;
    if (ed.models.has(id)) ed.models.delete(id);
    else ed.models.add(id);
    GW_EDITOR_DIRTY = true;
    renderGwEditor();
  }
});

$("gw-edit").addEventListener("input", (e) => {
  const ed = GW_EDITOR;
  if (!ed) return;
  const id = e.target.id;
  if (id === "gwe-name") { ed.name = e.target.value; GW_EDITOR_DIRTY = true; return; }
  if (id === "gwe-key") { ed.key = e.target.value; GW_EDITOR_DIRTY = true; return; }
  if (id === "gwe-base") { ed.baseUrl = e.target.value; GW_EDITOR_DIRTY = true; return; }
  if (id === "gwe-models") { ed.modelsText = e.target.value; GW_EDITOR_DIRTY = true; return; }
  if (id === "gwe-endpoint") {
    ed.endpoint = e.target.value;
    ed.endpointChanged = true;
    const v = gwSafeURL(e.target.value);
    ed.endpoints = {};
    if (v) { ed.endpoints.chat = v; ed.endpoints.responses = v; }
    GW_EDITOR_DIRTY = true;
    return;
  }
  if (id === "gwe-model-search") {
    ed.modelQuery = e.target.value;
    renderGwEditor();
    const s = $("gwe-model-search");
    if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
  }
});

// 编辑器是右侧 sheet：点页面别处收起；点正在打开它的 tile/行不算。
// `isConnected` 守卫：点保存/模型 chip 时，处理函数会先 renderGwEditor() 换掉 DOM，
// 冒泡到 document 的 e.target 已经脱离文档 —— 它的 closest("#gw-edit") 是 null。
// 少了这一条，编辑器会在每次保存/选模型后把自己当成“点了页面别处”而关掉
// （未保存时还弹一次放弃修改，实测 2026-10-22）。
document.addEventListener("click", (e) => {
  if (!GW_EDITOR) return;
  if (!e.target.isConnected) return;
  if (e.target.closest("#gw-edit") || e.target.closest("[data-gwpreset], [data-gwedit], [data-gwcustom]")) return;
  gwEditorClose();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (GW_EDITOR) {
    gwEditorClose();
    e.stopPropagation();
  }
}, true);

// ---------------------------------------------------------------------------
// 推送落点
// ---------------------------------------------------------------------------

function applyGw(g) {
  if (!g || typeof g !== "object") return;
  const busy = GW_BUSY;
  const wasOn = gwOn();
  if (!g.connected && busy && !g.err) {
    GW = g;
    renderGateway();
    return;
  }
  GW = g;
  GW_BUSY = "";
  if (g.connected) {
    if (busy) showToast(t("gw.toast.engineStarted"), "", "ok");
    if (GW_PROVIDERS === null || GW_PRESETS === null) gwLoadProviders(true);
  } else if (busy) {
    showToast(t("gw.toast.engineFailed"), gwErrText(g), "err");
  }
  const cameUp = wasOn !== gwOn() && gwOn();
  if (wasOn !== gwOn()) {
    GW_PROVIDERS = null;
    GW_PRESETS = null;
    GW_PROVIDER_TESTING = "";
    if (typeof GW_USAGE !== "undefined") {
      GW_USAGE = Object.create(null);
      if (typeof GW_USAGE_LOADING !== "undefined") GW_USAGE_LOADING = "";
    }
  }
  renderGateway();
  if (typeof renderDashAgents === "function") renderDashAgents();
  // 总览先画出来时引擎可能还没连上，用量卡会停在「网关未启动」。
  // 连接状态一变（或旧的本地下线提示还在）就把非 today 的读数重新拉一次，
  // 否则用户得手动点重试才会看到 7 天数据。
  if (typeof renderDashUsage === "function") {
    const period = DASH_USAGE_PERIOD;
    const localDown = GW_USAGE_ERR && GW_USAGE_ERR.key === "dash.usage.down";
    if (gwOn() && period !== "today" && !dashUsageCurrent() &&
        GW_USAGE_LOADING !== period && (cameUp || localDown)) {
      GW_USAGE_ERR = null;
      dashLoadUsage(period, true);
    }
    renderDashUsage();
  }
}

function applyGwProviders(m) {
  if (!m || typeof m !== "object") return;
  GW_PROVIDERS_LOADING = false;
  if (m.err) {
    GW_PROVIDERS_ERR = errMsgOf(m);
    GW_PROVIDERS = [];
    GW_PRESETS = [];
  } else {
    GW_PROVIDERS_ERR = null;
    GW_PROVIDERS = Array.isArray(m.providers) ? m.providers : [];
    GW_PRESETS = Array.isArray(m.presets) ? m.presets : [];
  }
  renderGateway();
  if (typeof renderDashAgents === "function" && NAV_HERE === "dash") renderDashAgents();
}

function applyGwProviderSaved(m) {
  if (!m || typeof m !== "object" || m.err) return;
  GW_EDITOR_SAVING = false;
  const p = m.provider;
  if (p && GW_EDITOR) {
    const pr = p.preset ? gwPresetByID(p.preset) : null;
    GW_EDITOR.id = p.id;
    GW_EDITOR.provider = p;
    GW_EDITOR.name = p.name || GW_EDITOR.name;
    GW_EDITOR.key = "";
    GW_EDITOR.mode = pr ? "preset" : "custom";
    GW_EDITOR.preset = p.preset || "";
    GW_EDITOR.presetInfo = pr;
    GW_EDITOR.models = new Set((p.models || []).filter((x) => x.on).map((x) => x.id));
    GW_EDITOR.endpoints = {};
    GW_EDITOR.regionChanged = false;
    GW_EDITOR.endpointChanged = false;
    GW_EDITOR.endpoint = "";
    GW_EDITOR_DIRTY = false;
    GW_EDITOR_ERR = "";
    renderGwEditor();
  }
  showToast(t("gw.provider.saved"), p ? (p.name || p.id) : "", "ok");
  renderGateway();
  sendCtrl({ type: "gw.agents" });
}

function applyGwProviderDeleted(m) {
  if (!m || typeof m !== "object" || m.err) return;
  const id = m.providerId || "";
  if (GW_EDITOR && GW_EDITOR.id === id) {
    GW_EDITOR = null;
    GW_EDITOR_ERR = "";
    GW_EDITOR_SAVING = false;
    GW_EDITOR_DIRTY = false;
    renderGwEditor();
  }
  showToast(t("gw.provider.deleted"), id, "ok");
  renderGateway();
  sendCtrl({ type: "gw.agents" });
}

function applyGwCredentialTest(m) {
  if (!m || typeof m !== "object") return;
  GW_PROVIDER_TESTING = "";
  const r = m.result || {};
  const id = m.providerId || "";
  const p = (GW_PROVIDERS || []).find((x) => x.id === id);
  if (p) p.keyStatus = r.ok ? "ok" : (p.keyConfigured ? "untested" : "missing");
  if (GW_EDITOR && GW_EDITOR.provider && GW_EDITOR.provider.id === id) {
    GW_EDITOR.provider.keyStatus = p ? p.keyStatus : GW_EDITOR.provider.keyStatus;
    renderGwEditor();
  }
  if (r.ok) showToast(t("gw.provider.testOk"), p ? (p.name || p.id) : id, "ok");
  else showToast(t("gw.provider.testFail"), tMsg(r.code, r.params, r.error), "err");
  renderGateway();
}

function applyGwProviderError(m) {
  if (!m || typeof m !== "object") return;
  GW_EDITOR_SAVING = false;
  GW_PROVIDER_TESTING = "";
  const text = msgText(errMsgOf(m));
  if (GW_EDITOR) {
    GW_EDITOR_ERR = text;
    renderGwEditor();
  } else {
    showToast(t("gw.provider.loadFailed"), text, "err");
  }
  renderGateway();
}

function applyGwPreview(m) {
  if (!m || !AC_ID || m.id !== AC_ID) return;
  AC_PREVIEW = m.preview || null;
  if (typeof renderDashAgents === "function") renderDashAgents();
}

function applyGwAgents(m) {
  if (!m || typeof m !== "object") return;
  GW_AGENTS_LOADING = false;
  if (m.op === "preview") {
    if (AC_ID && m.id === AC_ID) {
      AC_PREVIEW = m.err ? { changes: null, error: errMsgOf(m) } : (m.preview || null);
      if (typeof renderDashAgents === "function") renderDashAgents();
    }
    return;
  }
  const paneWait = (typeof PANE_MODEL_WAIT !== "undefined") && PANE_MODEL_WAIT;
  if (paneWait) PANE_MODEL_WAIT = false;
  GW_AGENTS_NOTICE = m.notice || "";
  if (Array.isArray(m.agents)) GW_AGENTS = m.agents;
  AC_BUSY = "";
  GW_AGENT_BUSY = "";
  const modelApplied = !!(m.op === "set" && m.id && AGENT_MODEL_PENDING &&
    AGENT_MODEL_PENDING.id === m.id);
  const modelOpenIntent = AGENT_MODEL_OPEN_INTENT;
  if (m.op === "set") {
    sendCtrl({
      type: "log", msg:
        `gw.agents set id=${m.id || "-"} err=${m.err ? 1 : 0} applied=${modelApplied ? 1 : 0} ` +
        `pending=${AGENT_MODEL_PENDING ? AGENT_MODEL_PENDING.id : "-"} open=${modelOpenIntent}`,
    });
  }
  if (modelApplied) {
    AGENT_MODEL_PENDING = null;
    AGENT_MODEL_OPEN_INTENT = true;
  }
  if (!modelApplied && AGENT_MODEL_PENDING && AC_ID === AGENT_MODEL_PENDING.id) {
    AC_BUSY = "set:" + AGENT_MODEL_PENDING.field;
  }
  if (m.err) {
    GW_AGENTS_ERR = errMsgOf(m);
    if (AC_ID && (!m.id || m.id === AC_ID)) AC_ERR = errMsgOf(m);
    if (modelApplied) showToast(t("term.model.saveFailed"), msgText(errMsgOf(m)), "err");
  } else {
    GW_AGENTS_ERR = null;
    AC_ERR = null;
    if (m.op === "disconnect") AC_CONFIRM = false;
    if (modelApplied) {
      AC_MODEL_SEL = "";
      if (typeof afterAgentModelSet === "function") {
        try {
          const p = afterAgentModelSet(m.id, modelOpenIntent);
          if (p && p.catch) p.catch((e) => jserr("afterAgentModelSet", e));
        } catch (e) { jserr("afterAgentModelSet/sync", e); }
      }
    }
  }
  if (typeof renderDashAgents === "function") renderDashAgents();
  if (typeof renderPaneModel === "function") renderPaneModel();
  if (paneWait) {
    if (m.err) {
      showToast(t("term.model.loadFailed"), msgText(errMsgOf(m)), "err");
    } else if (typeof paneModelPick === "function" && activeTab) {
      paneModelPick(activeTab, true);
    }
  }
}

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
  if (!AC_PICK && !AC_BUSY && !AC_MODEL_POP) {
    if (typeof renderDashAgents === "function") renderDashAgents();
  }
}

/* 引擎快照到达（shell 首帧 + 每 2.5s）。只做两件事：
   名单身份变了 → 重画 Agent 工作台；今日用量变了 → 重画用量卡。
   今日 calls 不再进 MG_CAT_SIG（否则名单每 2.5s 重画，行内选择器会被冲掉）。 */
function applyMagpie(s) {
  if (!s || typeof s !== "object") return;
  MAGPIE = s;
  const catSig = JSON.stringify((s.catalog || []).map((a) => [
    a.id, !!a.installed, a.icon || "", a.name || "", a.path || "",
    a.install || "", a.url || "", !!(a.caps && a.caps.launch),
  ]));
  const catChanged = catSig !== MG_CAT_SIG;
  MG_CAT_SIG = catSig;
  const usage = s.todayUsage || null;
  const usageSig = usage ? JSON.stringify([
    usage.totals, (usage.agents || []).map((a) => [a.id, a.calls, a.input, a.output, a.cost]),
    (usage.models || []).map((m) => [m.id, m.calls, m.input, m.output, m.cost]),
  ]) : "";
  const usageChanged = usageSig !== MG_USAGE_SIG;
  MG_USAGE_SIG = usageSig;
  // 表头写「N 个供应商 · M 个模型」，数字来自 MAGPIE + GW_PROVIDERS；
  // 模型列表变了但安装身份没变时，catChanged 是 false，若不单独看这一枚指纹，
  // 表头会一直停在旧数字（2026-10-22 实测：保存供应商后显示 0 个模型）。
  const gwSig = JSON.stringify([
    (s.providers || []).map((p) => p.id || p.name),
    (s.models || []).map((m) => m.id),
    (typeof GW_PROVIDERS !== "undefined" && GW_PROVIDERS ? GW_PROVIDERS.map((p) => p.id) : null),
  ]);
  const gwChanged = gwSig !== MG_GW_SIG;
  MG_GW_SIG = gwSig;
  if (catChanged && typeof renderPaneModel === "function") renderPaneModel();
  if (NAV_HERE !== "dash") return;
  if (catChanged && typeof renderDashAgents === "function") renderDashAgents();
  else if (gwChanged && typeof renderDashAgentGw === "function") renderDashAgentGw();
  if (usageChanged && DASH_USAGE_PERIOD === "today" && typeof renderDashUsage === "function") {
    renderDashUsage();
  }
  if (dashTab === "gateway") renderGateway();
  dashProbe(`magpie=${s.state}`, 0);
}
