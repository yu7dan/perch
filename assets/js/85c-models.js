"use strict";
/* 85c-models.js —— 模型的统一选择器、格子头的模型标签、新建卡上的「将使用」一行（2026-10-31）。

   形态照 magpie 的 Agents 页（internal/gui/assets/app.js openPicker）：
     · 一个列表装下所有提供商的模型，按提供商分组；左边一条提供商导航（全部 / ★ 收藏 / 各家）。
     · 顶上过滤框；打一个列表里没有的 id 也能「按输入的用」。
     · 这个 agent 接不上的提供商整组做灰并写明原因（做灰不做隐，见 unavailable-action-grey-not-hidden）。
   Perch 没有网关，所以「接不上」是真的接不上（协议不对），不是 magpie 那种「网关替你转」。

   三个落点共用同一个选择器：
     设置 › Agents 的主模型 / 各档位、格子头的模型标签（随时换，不重启）、Bot 角色设置。 */

/* ---------- 模型名 ---------- */
// claude-opus-5-5 → Opus 5.5；claude-haiku-4-5-20251001 → Haiku 4.5；别的原样（deepseek-v4-pro）。
function modelLabel(id) {
  const s = String(id || "");
  const m = s.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
  if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + (m[3] ? "." + m[3] : "");
  return s;
}
// 这个 agent 能不能接这个提供商（协议对不对）。理由用于做灰时的说明。
function provFitsAgent(p, agentId) {
  const protos = (PROV.protocols && PROV.protocols[agentId]) || [];
  if (!protos.length) return { ok: false, why: t("mp.why.envOnly") };
  for (const x of protos) {
    if (x === "anthropic" && p.anthropic) return { ok: true };
    if (x === "openai" && p.openai && (agentId !== "codex" || p.responses !== false)) return { ok: true };
  }
  if (agentId === "codex" && p.openai) return { ok: false, why: t("mp.why.codexResponses") };
  if (protos.length === 1 && protos[0] === "anthropic") return { ok: false, why: t("mp.why.needAnthropic") };
  return { ok: false, why: t("mp.why.needOpenai") };
}
// 当前选择的说明：「零词元 · Opus 5.5」/「自己的配置 · zzq.si · claude-opus-5-5」
function choiceText(agentId, provider, model) {
  if (provider) {
    const p = provById(provider);
    return (p ? p.name : provider) + (model ? " · " + modelLabel(model) : "");
  }
  const own = PROV.own && PROV.own[agentId];
  if (own && (own.base || own.model)) {
    return t("mp.own") + " · " + [own.base ? own.base.replace(/^https?:\/\//, "") : "", own.model ? modelLabel(own.model) : ""].filter(Boolean).join(" · ");
  }
  return t("mp.ownLogin");
}

/* ---------- 收藏（只存本机，照 magpie） ---------- */
const MP_FAV_KEY = "perch.modelFav.v1";
function mpFavs() { try { return new Set(JSON.parse(localStorage.getItem(MP_FAV_KEY) || "[]")); } catch (_) { return new Set(); } }
function mpToggleFav(k) {
  const s = mpFavs();
  if (s.has(k)) s.delete(k); else s.add(k);
  try { localStorage.setItem(MP_FAV_KEY, JSON.stringify([...s])); } catch (_) {}
}

/* ---------- 选择器 ---------- */
const MP = { el: null, opts: null, rail: "all", q: "", sel: -1, items: [] };

function mpEnsure() {
  if (MP.el) return MP.el;
  const el = document.createElement("div");
  el.id = "mpick";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<div class="mp-rail"></div><div class="mp-main"><div class="mp-top">`
    + `<input class="mp-q" type="text" spellcheck="false" autocomplete="off"></div>`
    + `<div class="mp-list" role="listbox"></div><div class="mp-foot"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => {
    const r = e.target.closest("[data-mp-rail]");
    if (r) { MP.rail = r.dataset.mpRail; mpRender(); el.querySelector(".mp-q").focus(); return; }
    const f = e.target.closest("[data-mp-fav]");
    if (f) { e.stopPropagation(); mpToggleFav(f.dataset.mpFav); mpRender(); return; }
    const it = e.target.closest("[data-mp-i]");
    if (it) { mpPick(+it.dataset.mpI); return; }
    if (e.target.closest("[data-mp-typed]")) mpPickTyped();
  });
  el.querySelector(".mp-q").addEventListener("input", (e) => { MP.q = e.target.value; MP.sel = -1; mpRender(); });
  el.querySelector(".mp-q").addEventListener("keydown", (e) => {
    if (isImeOwnedKey(e)) return;
    const live = MP.items.filter((x) => !x.na);
    if (e.key === "Escape") { e.preventDefault(); closeModelPicker(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!live.length) return;
      const cur = live.findIndex((x) => x.i === MP.sel);
      const nx = e.key === "ArrowDown" ? (cur + 1) % live.length : (cur - 1 + live.length) % live.length;
      MP.sel = live[nx].i; mpRender(true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (MP.sel >= 0) mpPick(MP.sel);
      else if (live.length === 1) mpPick(live[0].i);
      else if (MP.q.trim()) mpPickTyped();
    }
  });
  document.addEventListener("mousedown", () => { if (MP.el && MP.el.classList.contains("on")) closeModelPicker(); });
  window.addEventListener("blur", () => { if (MP.el && MP.el.classList.contains("on")) closeModelPicker(); });
  MP.el = el;
  return el;
}

/* opts: { agent, current: {provider, model}, allowOwn, followLabel, onPick({provider, model, own, follow}) } */
function openModelPicker(anchor, opts) {
  const el = mpEnsure();
  MP.opts = opts || {};
  MP.q = ""; MP.sel = -1;
  const cur = MP.opts.current || {};
  // 一律从「全部」开：换模型多半是要换到别家去（停在当前那家，别家就看不见了）
  MP.rail = "all";
  el.querySelector(".mp-q").value = "";
  el.querySelector(".mp-q").placeholder = t("mp.filterPh");
  mpRender();
  el.classList.add("on");
  // 落点：锚点下方左对齐；放不下就往上翻、往左收（见 unavailable-action-grey-not-hidden 的浮层规则）
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = Math.min(r.left, window.innerWidth - w - 8);
  let y = r.bottom + 6;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
  el.style.left = Math.max(8, x) + "px";
  el.style.top = y + "px";
  setTimeout(() => el.querySelector(".mp-q").focus(), 0);
}
function closeModelPicker() {
  if (!MP.el) return;
  MP.el.classList.remove("on");
  MP.opts = null;
}

function mpRender(keepScroll) {
  const el = MP.el, o = MP.opts || {};
  const agent = o.agent || "";
  const cur = o.current || {};
  const favs = mpFavs();
  const q = MP.q.trim().toLowerCase();
  const provs = provList();
  // 导航条：全部 / ★ / 每家一格（接不上的也列，做灰）
  el.querySelector(".mp-rail").innerHTML =
    `<button type="button" class="mp-r${MP.rail === "all" ? " on" : ""}" data-mp-rail="all" title="${esc(t("mp.rail.all"))}">${esc(t("mp.rail.allShort"))}</button>`
    + `<button type="button" class="mp-r${MP.rail === "fav" ? " on" : ""}" data-mp-rail="fav" title="${esc(t("mp.rail.fav"))}">★</button>`
    + provs.map((p) => {
      const fit = provFitsAgent(p, agent);
      return `<button type="button" class="mp-r${MP.rail === p.id ? " on" : ""}${fit.ok ? "" : " na"}" data-mp-rail="${esc(p.id)}" title="${esc(p.name + (fit.ok ? "" : " · " + fit.why))}">${esc(provInitial(p))}</button>`;
    }).join("");
  const items = [];
  let html = "";
  const add = (it, rowHtml) => { it.i = items.length; items.push(it); return rowHtml(it.i); };
  // 「跟主模型」（档位用）/「Agent 自己的配置」（默认用）
  if (!q && MP.rail === "all") {
    if (o.followLabel) {
      html += add({ follow: true }, (i) => `<div class="mp-it special${cur.follow ? " cur" : ""}${MP.sel === i ? " sel" : ""}" data-mp-i="${i}"><b>${esc(o.followLabel)}</b></div>`);
    }
    if (o.allowOwn) {
      const own = PROV.own && PROV.own[agent];
      const sub = own && (own.base || own.model) ? [own.base ? own.base.replace(/^https?:\/\//, "") : "", own.model || ""].filter(Boolean).join(" · ") : t("mp.ownLoginNote");
      html += add({ own: true }, (i) => `<div class="mp-it special${!cur.provider && !cur.follow ? " cur" : ""}${MP.sel === i ? " sel" : ""}" data-mp-i="${i}"><b>${esc(t("mp.own"))}</b><code>${esc(sub)}</code></div>`);
    }
  }
  for (const p of provs) {
    if (MP.rail !== "all" && MP.rail !== "fav" && MP.rail !== p.id) continue;
    const fit = provFitsAgent(p, agent);
    let models = (p.models || []).slice();
    if (MP.rail === "fav") models = models.filter((m) => favs.has(p.id + "/" + m));
    if (q) models = models.filter((m) => m.toLowerCase().includes(q) || modelLabel(m).toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (!models.length) continue;
    html += `<div class="mp-g${fit.ok ? "" : " na"}"><span>${esc(p.name)}</span>${fit.ok ? "" : `<em>${esc(fit.why)}</em>`}</div>`;
    for (const m of models) {
      const k = p.id + "/" + m;
      const on = cur.provider === p.id && cur.model === m;
      html += add({ provider: p.id, model: m, na: !fit.ok, why: fit.why }, (i) =>
        `<div class="mp-it${on ? " cur" : ""}${fit.ok ? "" : " na"}${MP.sel === i ? " sel" : ""}" data-mp-i="${i}" role="option"${fit.ok ? "" : ` title="${esc(fit.why)}"`}>`
        + `<b>${esc(modelLabel(m))}</b>${modelLabel(m) !== m ? `<code>${esc(m)}</code>` : ""}`
        + `<span class="sp"></span>${on ? `<i class="mp-cur">${esc(t("mp.current"))}</i>` : ""}`
        + `<button type="button" class="mp-fav${favs.has(k) ? " on" : ""}" data-mp-fav="${esc(k)}" aria-label="${esc(t("mp.fav"))}">★</button></div>`);
    }
  }
  if (!items.length) html += `<div class="mp-empty">${esc(provs.length ? t("mp.noMatch") : t("mp.noProviders"))}</div>`;
  MP.items = items;
  const list = el.querySelector(".mp-list");
  const st = list.scrollTop;
  list.innerHTML = html;
  if (keepScroll) list.scrollTop = st;
  const selEl = list.querySelector(".mp-it.sel") || (!keepScroll && list.querySelector(".mp-it.cur"));
  if (selEl) selEl.scrollIntoView({ block: "nearest" });
  // 打了列表里没有的 id：给一行「按输入的用」（落到当前导航里那家，或第一个接得上的）
  const typedProv = mpTypedProvider();
  el.querySelector(".mp-foot").innerHTML = q && typedProv && !items.some((x) => x.model === MP.q.trim())
    ? `<button type="button" class="mp-typed" data-mp-typed="1">${esc(t("mp.useTyped", { id: MP.q.trim(), prov: typedProv.name }))}</button>`
    : `<span>${esc(t("mp.hint"))}</span>`;
}
function provInitial(p) {
  const n = String(p.name || p.id || "?").trim();
  return /^[\x00-\x7f]/.test(n) ? n.slice(0, 2) : n.slice(0, 1);
}
function mpTypedProvider() {
  const agent = (MP.opts && MP.opts.agent) || "";
  const provs = provList();
  const inRail = provs.find((p) => p.id === MP.rail && provFitsAgent(p, agent).ok);
  return inRail || provs.find((p) => provFitsAgent(p, agent).ok) || null;
}
function mpPick(i) {
  const it = MP.items[i];
  if (!it) return;
  if (it.na) { showToast(t("mp.cant"), it.why || "", "err"); return; }
  const f = MP.opts && MP.opts.onPick;
  closeModelPicker();
  if (f) f(it.follow ? { follow: true } : it.own ? { own: true } : { provider: it.provider, model: it.model });
}
function mpPickTyped() {
  const p = mpTypedProvider();
  const id = MP.q.trim();
  if (!p || !id) return;
  const f = MP.opts && MP.opts.onPick;
  closeModelPicker();
  if (f) f({ provider: p.id, model: id });
}

/* ---------- 格子头上的模型标签：随时换模型，不重启 ----------
   T.model = { provider, model, state: "" | "pending" | "switching" | "err", err }
   Go 收到 pane.model.set 后：空闲就立刻改这一格的转发目标（下一轮生效）；正在回答就等这一轮结束再改。
   回执 pane.model { tab, provider, model, state } —— 前端只照着画。 */
function installPaneModelChip(T) {
  if (!T || !T.tabEl || T.modelChip) return;
  if (!(PROV.protocols && (PROV.protocols[T.spec && T.spec.agent] || []).length)) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mchip";
  T.modelChip = b;
  T.tabEl.insertBefore(b, T.freshBtn || T.tabEl.querySelector(".x"));
  b.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const agent = T.spec.agent;
    const cur = T.model || {};
    openModelPicker(b, {
      agent, current: { provider: cur.provider || "", model: cur.model || "" }, allowOwn: true,
      onPick: (c) => {
        const next = c.own ? { provider: "", model: "" } : { provider: c.provider, model: c.model };
        if ((next.provider || "") === (cur.provider || "") && (next.model || "") === (cur.model || "")) return;
        T.model = Object.assign({}, cur, next, { state: "switching" });
        renderPaneModelChip(T);
        sendCtrl({ type: "pane.model.set", tab: T.id, paneId: T.paneID || 0, provider: next.provider, model: next.model });
      },
    });
  });
  renderPaneModelChip(T);
}
function renderPaneModelChip(T) {
  const b = T && T.modelChip;
  if (!b) return;
  const m = T.model || {};
  const agent = T.spec && T.spec.agent;
  const p = m.provider ? provById(m.provider) : null;
  const own = !m.provider ? (PROV.own && PROV.own[agent]) : null;
  const name = m.model ? modelLabel(m.model) : own && own.model ? modelLabel(own.model) : t("mp.ownShort");
  const sub = p ? p.name : own && own.base ? own.base.replace(/^https?:\/\//, "") : "";
  b.dataset.state = m.state || "";
  b.innerHTML = `<span class="mc-nm">${esc(name)}</span>${sub ? `<span class="mc-sub">${esc(sub)}</span>` : ""}`
    + (m.state === "pending" ? `<span class="mc-st">${esc(t("mp.chip.pending"))}</span>` : "")
    + (m.state === "switching" ? `<span class="mc-spin" aria-hidden="true"></span>` : "")
    + `<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  b.title = m.state === "pending" ? t("mp.chip.pendingTip") : m.state === "err" ? (m.err || "") : t("mp.chip.tip");
}
/* Go 的回执 */
function applyPaneModel(m) {
  const T = TAB_LIST.find((x) => x.id === m.tab || (m.paneId && (x.paneID | 0) === m.paneId));
  if (!T) return;
  const was = T.model || {};
  T.model = { provider: m.provider || "", model: m.model || "", state: m.state || "", err: m.err || "" };
  renderPaneModelChip(T);
  if (m.state === "err") showToast(t("mp.toast.failTitle"), m.err || "", "err");
  else if (!m.state && was.state) {
    showToast(t("mp.toast.doneTitle"), t("mp.toast.doneNote", { what: choiceText(T.spec.agent, m.provider, m.model) }), "ok");
  }
}
function renderAllPaneModelChips() {
  for (const T of (typeof TAB_LIST !== "undefined" ? TAB_LIST : [])) {
    if (!T.modelChip) installPaneModelChip(T); else renderPaneModelChip(T);
  }
}

/* ---------- 新建 Agent 卡：「将使用：零词元 · Opus 5.5」 ---------- */
function naModelLineHTML(agentId) {
  if (!(PROV.protocols && (PROV.protocols[agentId] || []).length)) return "";
  const cfg = provAgentCfg(agentId);
  return `<div class="na-model"><span>${esc(t("mp.willUse"))}</span><b>${esc(choiceText(agentId, cfg.provider, cfg.model))}</b>`
    + `<button type="button" class="na-model-go" data-na-model="${esc(agentId)}">${esc(t("mp.changeDefault"))}</button></div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-na-model]");
  if (!b) return;
  e.preventDefault();
  if (typeof closeAgentPanel === "function") closeAgentPanel("改默认模型");
  openAgentSettings(b.dataset.naModel);
});
