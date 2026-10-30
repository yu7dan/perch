/* 设置 › 模型提供商 / Agents（2026-10-28，取代内嵌 magpie 网关）。
   交互照 Orca 的 Settings › Agents：key 和环境变量的值**只写不读** —— 存过的只显示
   「已保存 · 末四位」，留空 = 不改。提供商这一层（加一次，各 agent 选用）是 Perch
   自己加的：用户点名要的「前者」方案。
   数据都在 Go（internal/providers）：这里只画视图、发改动，回来的永远是不含密钥的快照。 */

const PROV = {
  view: null,          // { providers: [...], agents: {id: {...}} }
  protocols: {},       // agent id → ["anthropic"|"openai", ...]；空 = 只能写环境变量
  efforts: [],
  editing: "",         // "" | "new" | provider id
  err: "",             // 编辑表单的错误
  tests: {},           // provider id → { busy, ok, msg }
  agentErr: {},        // agent id → 错误
  agentDirty: {},      // agent id → true（有没保存的改动）
  req: 0,
  flashAgent: "",      // 从总览跳过来时要闪一下的那一行
};

// 常见提供商的地址（只填地址，key 由用户自己贴）。不在这里写死某一家的偏好顺序。
const PROV_PRESETS = [
  { name: "Anthropic", anthropic: "https://api.anthropic.com", openai: "" },
  { name: "OpenAI", anthropic: "", openai: "https://api.openai.com/v1" },
  { name: "DeepSeek", anthropic: "https://api.deepseek.com/anthropic", openai: "https://api.deepseek.com/v1" },
  { name: "Moonshot", anthropic: "https://api.moonshot.cn/anthropic", openai: "https://api.moonshot.cn/v1" },
  { name: "OpenRouter", anthropic: "", openai: "https://openrouter.ai/api/v1" },
];

function provRequest() { sendCtrl({ type: "providers.get" }); }
function provList() { return (PROV.view && PROV.view.providers) || []; }
function provById(id) { return provList().find((p) => p.id === id) || null; }
function provAgentCfg(id) { return (PROV.view && PROV.view.agents && PROV.view.agents[id]) || {}; }

function applyProviders(m) {
  PROV.view = m.view || { providers: [], agents: {} };
  PROV.protocols = m.protocols || {};
  PROV.efforts = m.efforts || [];
  if (NAV_HERE === "settings") renderProviderSettings();
  if (NAV_HERE === "dash" && typeof renderDashAgents === "function") renderDashAgents();
}
function provResult(m) {
  if (m.op === "provider.save") {
    if (m.ok) { PROV.editing = ""; PROV.err = ""; showToast(t("prov.toast.saved"), "", "info"); }
    else PROV.err = m.err || "";
  } else if (m.op === "provider.delete") {
    if (!m.ok) showToast(t("prov.toast.failed"), m.err || "", "error");
  } else if (m.op === "agent.config.set") {
    if (m.ok) { delete PROV.agentDirty[m.id]; delete PROV.agentErr[m.id]; showToast(t("prov.toast.agentSaved"), "", "info"); }
    else PROV.agentErr[m.id] = m.err || "";
  }
  if (NAV_HERE === "settings") renderProviderSettings();
}
function provTestResult(m) {
  PROV.tests[m.id] = m.ok
    ? { ok: true, msg: t(m.via === "proxy" ? "prov.test.okProxy" : "prov.test.ok", { n: m.models | 0 }) }
    : { ok: false, msg: m.err || t("prov.test.failed") };
  if (NAV_HERE === "settings") renderProviderSettings();
}

/* ---------- 模型提供商 ---------- */
function provEndpointsHTML(p) {
  const bits = [];
  if (p.anthropic) bits.push(`<span class="pv-ep"><i>Anthropic</i>${esc(p.anthropic)}</span>`);
  if (p.openai) bits.push(`<span class="pv-ep"><i>OpenAI</i>${esc(p.openai)}</span>`);
  return bits.join("");
}
function provRowHTML(p) {
  const tst = PROV.tests[p.id];
  const meta = [
    p.hasKey ? t("prov.keySaved", { hint: p.keyHint || "" }) : t("prov.keyNone"),
    p.models && p.models.length ? t("prov.models", { n: p.models.length }) : t("prov.modelsUnknown"),
  ].join(" · ");
  const status = tst
    ? `<span class="pv-test ${tst.busy ? "busy" : tst.ok ? "ok" : "bad"}">${esc(tst.busy ? t("prov.test.busy") : tst.msg)}</span>`
    : "";
  return `<div class="settings-row pv-row" data-prov="${esc(p.id)}">`
    + `<div class="settings-lab"><b>${esc(p.name)}</b>`
    + `<span class="pv-eps">${provEndpointsHTML(p)}</span>`
    + `<span class="pv-meta">${esc(meta)}${status}</span></div>`
    + `<div class="settings-ctl pv-acts">`
    + `<button type="button" class="set-btn" data-pact="test"${p.hasKey ? "" : ` aria-disabled="true"`}>${esc(t("prov.test"))}</button>`
    + `<button type="button" class="set-btn quiet" data-pact="edit">${esc(t("prov.edit"))}</button>`
    + `<button type="button" class="set-btn quiet" data-pact="delete">${esc(t("prov.delete"))}</button>`
    + `</div></div>`;
}
function provEditorHTML() {
  const p = PROV.editing === "new" ? null : provById(PROV.editing);
  const v = p || { name: "", anthropic: "", openai: "" };
  const presets = PROV.editing === "new"
    ? `<div class="pv-presets"><span>${esc(t("prov.presets"))}</span>` +
      PROV_PRESETS.map((x, i) => `<button type="button" class="pv-chip" data-preset="${i}">${esc(x.name)}</button>`).join("") +
      `</div>`
    : "";
  const keyPh = p && p.hasKey ? t("prov.keyKeep", { hint: p.keyHint || "" }) : "sk-…";
  return `<div class="pv-edit" id="pv-edit">`
    + `<div class="pv-edit-h"><b>${esc(p ? t("prov.editTitle", { name: p.name }) : t("prov.newTitle"))}</b></div>`
    + presets
    + `<label class="pv-f"><span>${esc(t("prov.f.name"))}</span><input id="pv-name" class="pv-in" value="${esc(v.name)}" spellcheck="false" autocomplete="off"></label>`
    + `<label class="pv-f"><span>${esc(t("prov.f.anthropic"))}</span><input id="pv-ant" class="pv-in mono" value="${esc(v.anthropic)}" placeholder="https://api.anthropic.com" spellcheck="false" autocomplete="off"><em>${esc(t("prov.f.anthropicHint"))}</em></label>`
    + `<label class="pv-f"><span>${esc(t("prov.f.openai"))}</span><input id="pv-oai" class="pv-in mono" value="${esc(v.openai)}" placeholder="https://api.openai.com/v1" spellcheck="false" autocomplete="off"><em>${esc(t("prov.f.openaiHint"))}</em></label>`
    + `<label class="pv-f"><span>${esc(t("prov.f.key"))}</span><input id="pv-key" class="pv-in mono" type="password" placeholder="${esc(keyPh)}" spellcheck="false" autocomplete="new-password"><em>${esc(t("prov.f.keyHint"))}</em></label>`
    + (PROV.err ? `<div class="set-err pv-err" role="alert">${esc(PROV.err)}</div>` : "")
    + `<div class="pv-edit-acts">`
    + (p && p.hasKey ? `<button type="button" class="set-btn quiet" data-pact="clearkey">${esc(t("prov.clearKey"))}</button>` : "")
    + `<span class="sp"></span>`
    + `<button type="button" class="set-btn quiet" data-pact="cancel">${esc(t("common.cancel"))}</button>`
    + `<button type="button" class="set-btn primary" data-pact="save">${esc(t("prov.save"))}</button>`
    + `</div></div>`;
}
function renderProvidersCard() {
  const host = $("set-providers");
  if (!host) return;
  if (!PROV.view) {
    host.innerHTML = `<div class="settings-row"><div class="settings-lab"><span>${esc(t("prov.loading"))}</span></div></div>`;
    return;
  }
  const list = provList();
  let html = "";
  if (PROV.view.broken) html += `<div class="set-note">${esc(t("prov.broken"))}</div>`;
  if (!list.length && PROV.editing !== "new") {
    html += `<div class="settings-row pv-empty"><div class="settings-lab"><b>${esc(t("prov.emptyTitle"))}</b>`
      + `<span>${esc(t("prov.emptyNote"))}</span></div>`
      + `<div class="settings-ctl"><button type="button" class="set-btn primary" data-pact="new">${esc(t("prov.add"))}</button></div></div>`;
  }
  for (const p of list) html += PROV.editing === p.id ? provEditorHTML() : provRowHTML(p);
  if (PROV.editing === "new") html += provEditorHTML();
  else if (list.length) html += `<div class="settings-row pv-addrow"><button type="button" class="set-btn quiet" data-pact="new">+ ${esc(t("prov.add"))}</button></div>`;
  // 正在打的字不能被重画冲掉：编辑中时只在结构变化时重建表单。
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#pv-edit");
  if (typing && host.dataset.sig === PROV.editing + "|" + PROV.err) return;
  host.dataset.sig = PROV.editing + "|" + PROV.err;
  host.innerHTML = html;
}

function provCollect() {
  return {
    id: PROV.editing === "new" ? "" : PROV.editing,
    name: ($("pv-name") || {}).value || "",
    anthropic: ($("pv-ant") || {}).value || "",
    openai: ($("pv-oai") || {}).value || "",
    key: ($("pv-key") || {}).value || "",
  };
}

/* ---------- Agents ---------- */
function agentsCfgList() {
  const cat = (typeof opCatalog === "function" ? opCatalog() : []).filter((a) => a && a.id);
  // 已安装的在前；没装的也列出来（配置可以先写好，装上就生效）。
  return cat.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
}
function agentRowCfgHTML(a) {
  const id = a.id;
  const cfg = provAgentCfg(id);
  const protos = PROV.protocols[id] || [];
  const opts = [`<option value="">${esc(t("prov.agent.own"))}</option>`].concat(provList().map((p) => {
    const ok = protos.some((x) => (x === "anthropic" && p.anthropic) || (x === "openai" && p.openai));
    const why = protos.length ? (ok ? "" : ` (${t("prov.agent.incompatible")})`) : "";
    return `<option value="${esc(p.id)}"${cfg.provider === p.id ? " selected" : ""}${ok ? "" : " disabled"}>${esc(p.name + why)}</option>`;
  }));
  const prov = cfg.provider ? provById(cfg.provider) : null;
  const models = (prov && prov.models) || [];
  const effort = id === "claude" || id === "codex"
    ? `<label class="ag-f"><span>${esc(t("prov.agent.effort"))}</span><select class="set-select ag-effort">`
      + `<option value="">${esc(t("prov.agent.default"))}</option>`
      + PROV.efforts.map((e) => `<option value="${e}"${cfg.effort === e ? " selected" : ""}>${e}</option>`).join("")
      + `</select></label>`
    : "";
  const envChips = (cfg.envNames || []).map((n) =>
    `<span class="ag-env-chip" title="${esc(t("prov.agent.envSaved"))}"><code>${esc(n)}</code>`
    + `<button type="button" data-envrm="${esc(n)}" aria-label="${esc(t("prov.agent.envRemove", { name: n }))}">×</button></span>`).join("");
  const err = PROV.agentErr[id] ? `<div class="set-err ag-err" role="alert">${esc(PROV.agentErr[id])}</div>` : "";
  const dirty = !!PROV.agentDirty[id];
  return `<div class="ag-cfg-row${PROV.flashAgent === id ? " flash" : ""}" id="set-agent-${esc(id)}" data-agent="${esc(id)}"`
    + ` data-search="${esc([id, a.name || ""].join(" "))}">`
    + `<div class="ag-cfg-h">${iconHTML(a.icon, "sm")}<b>${esc(a.name || id)}</b>`
    + `<span class="ag-cfg-st">${esc(a.installed ? t("prov.agent.installed") : t("prov.agent.notInstalled"))}</span>`
    + (protos.length ? "" : `<span class="ag-cfg-st">${esc(t("prov.agent.envOnly"))}</span>`)
    + `<span class="sp"></span>`
    + `<button type="button" class="set-btn${dirty ? " primary" : ""}" data-aact="save"${dirty ? "" : ` aria-disabled="true"`}>${esc(t("prov.save"))}</button></div>`
    + `<div class="ag-cfg-grid">`
    + (protos.length
        ? `<label class="ag-f"><span>${esc(t("prov.agent.provider"))}</span><select class="set-select ag-prov">${opts.join("")}</select></label>`
          + `<label class="ag-f"><span>${esc(t("prov.agent.model"))}</span><input class="pv-in mono ag-model" list="ag-models-${esc(id)}" value="${esc(cfg.model || "")}" placeholder="${esc(t("prov.agent.modelPh"))}" spellcheck="false" autocomplete="off">`
          + `<datalist id="ag-models-${esc(id)}">${models.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist></label>`
        : "")
    + effort
    + `<label class="ag-f wide"><span>${esc(t("prov.agent.env"))}</span>`
    + (envChips ? `<span class="ag-env-saved">${envChips}</span>` : "")
    + `<textarea class="pv-in mono ag-env" rows="2" placeholder="${esc(t("prov.agent.envPh"))}" spellcheck="false"></textarea></label>`
    + `</div>${err}</div>`;
}
function renderAgentsCard() {
  const host = $("set-agents");
  if (!host) return;
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#set-agents");
  if (typing && host.querySelector(".ag-cfg-row")) {
    // 正在改某一行：只刷新保存按钮的状态，不重建（否则输入框里的字会被冲掉）。
    for (const row of host.querySelectorAll(".ag-cfg-row")) {
      const b = row.querySelector('[data-aact="save"]');
      const dirty = !!PROV.agentDirty[row.dataset.agent];
      if (b) { b.classList.toggle("primary", dirty); b.setAttribute("aria-disabled", dirty ? "false" : "true"); }
    }
    return;
  }
  const list = agentsCfgList();
  host.innerHTML = list.length
    ? list.map(agentRowCfgHTML).join("")
    : `<div class="settings-row"><div class="settings-lab"><span>${esc(t("prov.agent.none"))}</span></div></div>`;
}

/* "KEY=VALUE" 每行一个；# 开头是注释。只写不读：值永远不回显。 */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(t("prov.agent.envBad", { line }));
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

function saveAgentRow(row) {
  const id = row.dataset.agent;
  const cfg = provAgentCfg(id);
  let envSet;
  try { envSet = parseEnvText((row.querySelector(".ag-env") || {}).value || ""); }
  catch (e) { PROV.agentErr[id] = e.message; renderAgentsCard(); return; }
  const config = {
    provider: (row.querySelector(".ag-prov") || { value: cfg.provider || "" }).value,
    model: (row.querySelector(".ag-model") || { value: cfg.model || "" }).value.trim(),
    effort: (row.querySelector(".ag-effort") || { value: cfg.effort || "" }).value,
    envSet, envRemove: [],
  };
  sendCtrl({ type: "agent.config.set", req: ++PROV.req, agentId: id, config });
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function renderProviderSettings() {
  renderProvidersCard();
  renderAgentsCard();
  if (PROV.flashAgent) {
    const el = $("set-agent-" + PROV.flashAgent);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { PROV.flashAgent = ""; const e2 = $("set-agent-" + (el && el.dataset.agent)); if (e2) e2.classList.remove("flash"); }, 1600);
  }
}

/* 总览 Agent CLI 一行 → 设置 › Agents 那一行。 */
function openAgentSettings(id) {
  PROV.flashAgent = id;
  setNavView("settings");
  if (typeof setSettingsPage === "function") setSettingsPage("set-sec-agents");
  renderProviderSettings();
}

{
  const ph = $("set-providers");
  if (ph && !ph.dataset.bound) {
    ph.dataset.bound = "1";
    ph.addEventListener("click", async (e) => {
      const pre = e.target.closest("[data-preset]");
      if (pre) {
        const x = PROV_PRESETS[+pre.dataset.preset];
        if ($("pv-name") && !$("pv-name").value) $("pv-name").value = x.name;
        if ($("pv-ant")) $("pv-ant").value = x.anthropic;
        if ($("pv-oai")) $("pv-oai").value = x.openai;
        if ($("pv-key")) $("pv-key").focus();
        return;
      }
      const b = e.target.closest("[data-pact]");
      if (!b) return;
      const act = b.dataset.pact;
      const row = b.closest("[data-prov]");
      const id = row ? row.dataset.prov : PROV.editing;
      if (act === "new") { PROV.editing = "new"; PROV.err = ""; renderProvidersCard(); if ($("pv-name")) $("pv-name").focus(); }
      else if (act === "edit") { PROV.editing = id; PROV.err = ""; renderProvidersCard(); if ($("pv-name")) $("pv-name").focus(); }
      else if (act === "cancel") { PROV.editing = ""; PROV.err = ""; renderProvidersCard(); }
      else if (act === "save") {
        sendCtrl({ type: "provider.save", req: ++PROV.req, provider: provCollect() });
        if (provCollect().key && PROV.editing !== "new") PROV.tests[PROV.editing] = { busy: true };
      } else if (act === "clearkey") {
        sendCtrl({ type: "provider.save", req: ++PROV.req, provider: Object.assign(provCollect(), { key: "", clearKey: true }) });
      } else if (act === "test") {
        const p = provById(id);
        if (!p || !p.hasKey) { showToast(t("prov.test.needKey"), "", "info"); return; }
        PROV.tests[id] = { busy: true };
        renderProvidersCard();
        sendCtrl({ type: "provider.test", req: ++PROV.req, id });
      } else if (act === "delete") {
        const p = provById(id);
        const ok = await askConfirm({ title: t("prov.deleteTitle", { name: p ? p.name : id }), body: t("prov.deleteBody"), ok: t("prov.delete"), danger: true });
        if (ok) sendCtrl({ type: "provider.delete", req: ++PROV.req, id });
      }
    });
    ph.addEventListener("keydown", (e) => {
      if (!e.target.closest("#pv-edit")) return;
      if (isImeOwnedKey(e)) return;
      if (e.key === "Enter") { e.preventDefault(); sendCtrl({ type: "provider.save", req: ++PROV.req, provider: provCollect() }); }
      else if (e.key === "Escape") { e.preventDefault(); PROV.editing = ""; PROV.err = ""; renderProvidersCard(); }
    });
  }
  const ah = $("set-agents");
  if (ah && !ah.dataset.bound) {
    ah.dataset.bound = "1";
    const mark = (e) => {
      const row = e.target.closest(".ag-cfg-row");
      if (!row) return;
      PROV.agentDirty[row.dataset.agent] = true;
      const b = row.querySelector('[data-aact="save"]');
      if (b) { b.classList.add("primary"); b.setAttribute("aria-disabled", "false"); }
    };
    ah.addEventListener("input", mark);
    ah.addEventListener("change", (e) => {
      mark(e);
      // 换了提供商：模型候选跟着换（重画这一行；别的行不动）。
      if (e.target.classList.contains("ag-prov")) {
        const row = e.target.closest(".ag-cfg-row");
        const dl = row && row.querySelector("datalist");
        const p = provById(e.target.value);
        if (dl) dl.innerHTML = ((p && p.models) || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
      }
    });
    ah.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-envrm]");
      if (rm) {
        const row = rm.closest(".ag-cfg-row");
        const id = row.dataset.agent, cfg = provAgentCfg(id);
        sendCtrl({ type: "agent.config.set", req: ++PROV.req, agentId: id,
          config: { provider: cfg.provider || "", model: cfg.model || "", effort: cfg.effort || "", envSet: {}, envRemove: [rm.dataset.envrm] } });
        return;
      }
      const b = e.target.closest('[data-aact="save"]');
      if (b && b.getAttribute("aria-disabled") !== "true") saveAgentRow(b.closest(".ag-cfg-row"));
    });
  }
}
