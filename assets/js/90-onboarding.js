"use strict";
/* First-run setup flow.
 *
 * This is not a launch splash. It starts only when the user tries to add an
 * agent and the agent picker has no installed/launchable options. The project
 * and folder have already been chosen in Workspaces, so the guide only covers
 * the two things that are actually missing: an agent and model access.
 *
 * Every status shown here comes from the live app (catalog, gateway, models);
 * it is not a static checklist that can drift away from reality. Finishing or
 * skipping simply closes the overlay — no forced navigation and no automatic
 * first pane.
 *
 * The flow is resumable. Editing a provider happens in the embedded Gateway
 * page, so "Open Gateway" temporarily hides the overlay and leaves a small
 * "Continue setup" button behind; returning refreshes the same real state.
 */
(function () {
  const KEY = "perch.onboarded.v2";
  const STEPS = ["agent", "models", "done"];
  const box = document.getElementById("onb");
  const progress = document.getElementById("onb-progress");
  const body = document.getElementById("onb-body");
  const actions = document.getElementById("onb-actions");
  const resume = document.getElementById("onb-resume");
  const resumeBtn = document.getElementById("onb-resume-btn");
  if (!box || !progress || !body || !actions) return;

  let step = 0;
  let maxStep = 0;
  let selected = "";
  let skipConfirm = false;
  let paused = false;
  let sig = "";
  let tick = 0;
  let focusKey = "";

  function seen() {
    try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, "1"); } catch (_) {}
  }
  function clampStep(n) {
    return Math.max(0, Math.min(STEPS.length - 1, Number(n) || 0));
  }

  function catalog() {
    const m = (typeof mg === "function") ? mg() : null;
    if (m && Array.isArray(m.catalog)) return m.catalog;
    if (typeof MAGPIE !== "undefined" && MAGPIE && Array.isArray(MAGPIE.catalog)) return MAGPIE.catalog;
    return [];
  }
  function agentOf(id) {
    return catalog().find((a) => a && a.id === id) || null;
  }
  function installed(id) {
    const a = agentOf(id);
    return !!(a && a.installed);
  }
  function launchable(a) {
    if (!a) return false;
    const c = (typeof perchCaps === "function") ? perchCaps(a) : (a.caps || {});
    return !!(c.launch);
  }
  function installedAgents() {
    return catalog().filter((a) => a && a.installed);
  }
  function defaultAgent() {
    const s = (typeof SETTINGS !== "undefined" && SETTINGS) ? String(SETTINGS.defaultAgent || "") : "";
    if (s && installed(s)) return s;
    const first = installedAgents().find((a) => launchable(a)) || installedAgents()[0];
    if (first) return first.id;
    return catalog()[0] ? catalog()[0].id : "";
  }
  function ensureSelected() {
    if (!selected || !agentOf(selected)) selected = defaultAgent();
    if (!selected && catalog()[0]) selected = catalog()[0].id;
  }
  function installState(id) {
    if (typeof INSTALLS === "undefined" || !INSTALLS[id]) return null;
    return INSTALLS[id];
  }
  function gatewayInstalled() {
    if (typeof GW !== "undefined" && GW && (GW.connected || GW.port)) return true;
    if (typeof MAGPIE !== "undefined" && MAGPIE && MAGPIE.state && MAGPIE.state !== "absent") return true;
    if (typeof GW_INSTALL !== "undefined" && GW_INSTALL && GW_INSTALL.state === "done") return true;
    return false;
  }
  function gatewayConnected() {
    return !!(typeof gwOn === "function" && gwOn());
  }
  function gatewayBusy() {
    return !!(typeof GW_INSTALL !== "undefined" && GW_INSTALL && GW_INSTALL.state === "running");
  }
  function models() {
    return (typeof AGENT_MODELS !== "undefined" && Array.isArray(AGENT_MODELS)) ? AGENT_MODELS : [];
  }
  function providers() {
    const set = new Set();
    for (const m of models()) {
      const p = String((m && (m.providerName || m.provider)) || "").trim();
      if (p) set.add(p);
    }
    return [...set];
  }
  function settingsValue(key, fallback) {
    return (typeof SETTINGS !== "undefined" && SETTINGS && SETTINGS[key] !== undefined)
      ? SETTINGS[key] : fallback;
  }

  function kicker(key) { return `<div class="onb-kicker">${esc(t(key))}</div>`; }
  function title(key) { return `<h1 class="onb-title" id="onb-title">${esc(t(key))}</h1>`; }
  function lead(key) { return `<p class="onb-lead">${esc(t(key))}</p>`; }

  function statusRow(label, value, cls) {
    return `<div class="onb-status"><span class="dot ${cls || ""}"></span>` +
      `<span class="lbl">${esc(label)}</span><span class="val" title="${esc(value)}">${esc(value)}</span></div>`;
  }

  function agentStep() {
    const list = catalog();
    if (!list.length) {
      return kicker("onb2.kicker.agent") + title("onb2.agent.title") +
        `<p class="onb-sub">${esc(t("onb2.agent.loading"))}</p>`;
    }
    ensureSelected();
    const cards = list.map((a) => {
      const isSel = a.id === selected;
      const st = installState(a.id);
      let right;
      if (a.installed) {
        right = `<span class="st ok">${esc(t("onb2.installed"))}</span>`;
      } else if (st && st.state === "running") {
        right = `<span class="st">${esc(t("onb2.installing"))}</span>`;
      } else {
        right = `<button type="button" class="mini" data-onb-install="${esc(a.id)}">` +
          `${esc(st && st.state === "failed" ? t("onb2.retry") : t("onb2.install"))}</button>`;
      }
      return `<div class="onb-agent${isSel ? " sel" : ""}" role="button" tabindex="0"` +
        ` data-onb-agent="${esc(a.id)}" aria-pressed="${isSel}">` +
        iconHTML(a.icon) +
        `<span class="who"><span class="nm">${esc(a.name || a.id)}</span>` +
        `<span class="vd">${esc(a.vendor || "")}</span></span>${right}</div>`;
    }).join("");
    const n = installedAgents().length;
    const failed = list.map((a) => ({ a, st: installState(a.id) }))
      .find((x) => x.st && x.st.state === "failed");
    let failure = "";
    if (failed) {
      const err = (typeof msgText === "function" && msgText(failed.st.err)) || t("inst.failed");
      failure = `<div class="onb-note">${esc(failed.a.name || failed.a.id)}: ${esc(err)}</div>`;
    }
    return kicker("onb2.kicker.agent") + title("onb2.agent.title") +
      lead(n ? "onb2.agent.lead" : "onb2.agent.leadNone") +
      `<div class="onb-sec-label"><span>${esc(t(n ? "onb2.agent.choose" : "onb2.agent.chooseAll"))}</span>` +
      `<span class="r">${esc(t("onb2.agent.count", { n }))}</span></div>` +
      `<div class="onb-agent-grid">${cards}</div>` +
      failure +
      (n ? "" : `<div class="onb-note">${esc(t("onb2.agent.none"))}</div>`);
  }

  function modelStep() {
    const nModels = models().length;
    const nProviders = providers().length;
    const nAgents = installedAgents().length;
    const inst = gatewayInstalled();
    const on = gatewayConnected();
    const busy = gatewayBusy();
    const gwValue = busy ? t("onb2.models.installing")
      : on ? t("onb2.models.connected")
        : inst ? t("onb2.models.notConnected") : t("onb2.models.notInstalled");
    const gwCls = on ? "ok" : inst ? "warn" : "";
    let gwAct = "";
    if (!inst && !busy) {
      gwAct = `<button type="button" class="onb-btn sm" data-onb-install-gw>${esc(t("onb2.installGateway"))}</button>`;
    } else if (!on && !busy) {
      gwAct = `<button type="button" class="onb-btn sm" data-onb-open-gw>${esc(t("onb2.openGateway"))}</button>`;
    } else if (on) {
      gwAct = `<button type="button" class="onb-btn sm" data-onb-refresh>${esc(t("onb2.refresh"))}</button>`;
    }
    const provAct = inst ? `<button type="button" class="onb-btn sm" data-onb-open-gw>${esc(t("onb2.openGateway"))}</button>` : "";
    const gwFailed = !!(typeof GW_INSTALL !== "undefined" && GW_INSTALL && GW_INSTALL.state === "failed");
    const gwFailure = gwFailed
      ? `<div class="onb-note">${esc((typeof msgText === "function" && msgText(GW_INSTALL.err)) || t("inst.failed"))}</div>`
      : "";
    return kicker("onb2.kicker.models") + title("onb2.models.title") + lead("onb2.models.lead") +
      `<div class="onb-stat"><div><b>${nAgents}</b><span>${esc(t("onb2.models.agentsUnit", { n: nAgents }))}</span></div>` +
      `<div><b>${nProviders}</b><span>${esc(t("onb2.models.providerUnit", { n: nProviders }))}</span></div>` +
      `<div><b>${nModels}</b><span>${esc(t("onb2.models.modelUnit", { n: nModels }))}</span></div></div>` +
      `<div class="onb-section">` +
      `<div class="onb-status"><span class="dot ${gwCls}"></span><span class="lbl">${esc(t("onb2.models.gateway"))}</span>` +
      `<span class="val">${esc(gwValue)}</span><span class="act">${gwAct}</span></div>` +
      `<div class="onb-status"><span class="dot ${nProviders ? "ok" : ""}"></span><span class="lbl">${esc(t("onb2.models.providers"))}</span>` +
      `<span class="val">${esc(t("onb2.models.providerUnit", { n: nProviders }))}</span><span class="act">${provAct}</span></div>` +
      `<div class="onb-status"><span class="dot ${nModels ? "ok" : ""}"></span><span class="lbl">${esc(t("onb2.models.models"))}</span>` +
      `<span class="val">${esc(t("onb2.models.modelUnit", { n: nModels }))}</span>` +
      `<span class="act">${inst ? `<button type="button" class="onb-btn sm" data-onb-refresh>${esc(t("onb2.refresh"))}</button>` : ""}</span></div>` +
      `</div>` +
      (nModels ? "" : `<div class="onb-note">${esc(t("onb2.models.empty"))}</div>`) +
      (nModels ? "" : `<p class="onb-sub">${esc(t("onb2.models.later"))}</p>`);
  }

  function reviewRow(label, value, ok, jump) {
    return `<div class="onb-review-row">` +
      `<span class="k">${esc(label)}</span>` +
      `<span class="v" title="${esc(value)}">${esc(value)}</span>` +
      `<span class="s ${ok ? "ok" : "warn"}">${esc(t(ok ? "onb2.done.ready" : "onb2.done.notReady"))}</span>` +
      (jump === undefined ? "" : `<button type="button" class="go" data-onb-jump="${jump}">${esc(t("onb2.edit"))}</button>`) +
      `</div>`;
  }

  function setupReady() {
    ensureSelected();
    const a = agentOf(selected);
    return !!(a && a.installed && launchable(a) && gatewayConnected() && models().length > 0);
  }

  function doneStep() {
    ensureSelected();
    const a = agentOf(selected);
    const aReady = !!(a && a.installed && launchable(a));
    const gwReady = gatewayConnected();
    const gwInstalled = gatewayInstalled();
    const nModels = models().length;
    const allReady = setupReady();
    const agentLabel = a ? (a.name || a.id) : t("onb2.done.notReady");
    const gwValue = gwReady ? t("onb2.models.connected")
      : gwInstalled ? t("onb2.models.notConnected") : t("onb2.models.notInstalled");
    const modelValue = nModels ? t("onb2.models.modelUnit", { n: nModels }) : t("onb2.done.notReady");
    return kicker("onb2.kicker.done") + title(allReady ? "onb2.done.title" : "onb2.done.titleAlmost") + lead("onb2.done.lead") +
      `<div class="onb-ready ${allReady ? "ok" : "warn"}">` +
      `<span class="onb-seal" aria-hidden="true">${allReady ? "✓" : "!"}</span>` +
      `<div class="onb-ready-tx"><b>${esc(t(allReady ? "onb2.done.readyTitle" : "onb2.done.almostTitle"))}</b>` +
      `<span>${esc(t(allReady ? "onb2.done.readyBody" : "onb2.done.almostBody", { agent: agentLabel }))}</span></div>` +
      `</div>` +
      `<div class="onb-review">` +
      reviewRow(t("onb2.done.agent"), aReady ? agentLabel : t("onb2.done.notReady"), aReady, 0) +
      reviewRow(t("onb2.done.gateway"), gwValue, gwReady, 1) +
      reviewRow(t("onb2.done.models"), modelValue, nModels > 0, 1) +
      `</div>` +
      `<div class="onb-thanks compact"><div class="tx"><b>${esc(t("onb2.done.credit"))}</b>` +
      `<span>${esc(t("onb2.done.creditBody"))}</span></div>` +
      `<button type="button" class="onb-link" data-onb-magpie title="usemagpie.ai">usemagpie.ai ↗</button></div>`;
  }

  function progressHTML() {
    const segs = STEPS.map((_, i) => {
      const cls = i === step ? "active" : (i < step ? "done" : "");
      const dis = i > maxStep ? " disabled" : "";
      return `<button type="button" class="onb-seg ${cls}" data-onb-step="${i}"${dis}` +
        ` aria-label="${esc(t("onb2.step." + STEPS[i]))}" aria-current="${i === step ? "step" : "false"}"></button>`;
    }).join("");
    return segs + `<span class="n">${step + 1} / ${STEPS.length}</span>`;
  }

  function actionsHTML() {
    if (skipConfirm) {
      return `<button type="button" class="onb-btn quiet" data-onb-act="skip-no">${esc(t("onb2.skipNo"))}</button>` +
        `<div class="sp"></div>` +
        `<button type="button" class="onb-btn primary" data-onb-act="skip-yes">${esc(t("onb2.skipYes"))}</button>`;
    }
    const back = step > 0
      ? `<button type="button" class="onb-btn" data-onb-act="back">${esc(t("onb2.back"))}</button>`
      : `<button type="button" class="onb-btn quiet" data-onb-act="skip">${esc(t("onb2.skip"))}</button>`;
    let primary;
    if (step === STEPS.length - 1) {
      // Completion is deliberately not a launch action: no first pane, no
      // forced route. The user came from Workspaces; closing returns there.
      primary = `<button type="button" class="onb-btn primary" data-onb-act="finish">` +
        `${esc(t("onb2.finish"))}</button>`;
    } else {
      primary = `<button type="button" class="onb-btn primary" data-onb-act="next">` +
        `${esc(t(step === 0 ? "onb2.start" : "onb2.next"))}</button>`;
    }
    return back + `<div class="sp"></div>` + primary;
  }

  function skipBodyHTML() {
    return `<div class="onb-skipconfirm"><b>${esc(t("onb2.skipTitle"))}</b>` +
      `<p>${esc(t("onb2.skipBody"))}</p></div>`;
  }

  function render() {
    if (box.hidden) return;
    ensureSelected();
    progress.innerHTML = progressHTML();
    if (skipConfirm) {
      body.innerHTML = skipBodyHTML();
    } else {
      if (step === 0) body.innerHTML = agentStep();
      else if (step === 1) body.innerHTML = modelStep();
      else body.innerHTML = doneStep();
    }
    actions.innerHTML = actionsHTML();
    sig = signature();
    const key = skipConfirm ? "skip" : String(step);
    if (key !== focusKey) {
      focusKey = key;
      setTimeout(() => {
        const b = body.querySelector("button.onb-btn, button.onb-agent, button.mini") ||
          actions.querySelector("button.primary, button");
        if (b) b.focus();
      }, 40);
    }
  }

  function signature() {
    const cat = catalog().map((a) => `${a.id}:${a.installed ? 1 : 0}`).join(",");
    const inst = (typeof INSTALLS !== "undefined")
      ? Object.keys(INSTALLS).map((id) => `${id}:${INSTALLS[id].state}`).join(",") : "";
    const gwi = (typeof GW_INSTALL !== "undefined" && GW_INSTALL)
      ? `${GW_INSTALL.state}:${(GW_INSTALL.lines || []).length}` : "";
    return [
      step, skipConfirm, selected, cat, inst, gwi,
      models().length, providers().join(","), gatewayInstalled(), gatewayConnected(),
      (typeof PERCH_LOCALE !== "undefined" ? PERCH_LOCALE : ""),
    ].join("|");
  }

  function startTicker() {
    if (tick) return;
    tick = setInterval(() => {
      if (box.hidden) return;
      const s = signature();
      if (s !== sig) render();
    }, 600);
  }
  function stopTicker() {
    if (tick) { clearInterval(tick); tick = 0; }
  }

  function showAt(n) {
    step = clampStep(n);
    maxStep = Math.max(maxStep, step);
    skipConfirm = false;
    paused = false;
    focusKey = "";
    box.hidden = false;
    if (resume) resume.hidden = true;
    if (step === 1 && typeof refreshGatewayConfig === "function") refreshGatewayConfig();
    render();
    startTicker();
    setTimeout(() => {
      const b = body.querySelector("button.onb-btn, button.onb-agent, button.mini") ||
        actions.querySelector("button.primary, button");
      if (b) b.focus();
    }, 50);
  }

  function hideAndRemember() {
    box.hidden = true;
    if (resume) resume.hidden = true;
    paused = false;
    skipConfirm = false;
    stopTicker();
    remember();
  }

  function pauseForGateway() {
    paused = true;
    box.hidden = true;
    stopTicker();
    if (resume) resume.hidden = false;
    if (typeof setNavView === "function") setNavView("dash");
    const tab = document.querySelector('#dash-tabs .opt[data-dtab="gateway"]');
    if (tab) tab.click();
    sendCtrl({ type: "log", msg: "首次设置：打开网关配置（返回后继续）" });
  }

  function resumeSetup() {
    if (!paused) return;
    if (typeof refreshGatewayConfig === "function") refreshGatewayConfig();
    showAt(step);
    sendCtrl({ type: "log", msg: "首次设置：从网关返回，继续" });
  }

  function commitDefaultAgent() {
    const a = agentOf(selected);
    if (!a || !a.installed || !launchable(a)) return;
    if (typeof settingsSend !== "function") return;
    if (String(settingsValue("defaultAgent", "")) === selected) return;
    settingsSend({ defaultAgent: selected }, `首次设置：默认 agent → ${selected}`);
  }

  function finish() {
    commitDefaultAgent();
    hideAndRemember();
    sendCtrl({ type: "log", msg: "首次设置：完成（只关闭，不跳页、不自动建格）" });
  }

  function selectAgent(id) {
    const a = agentOf(id);
    if (!a) return;
    selected = id;
    if (a.installed && launchable(a)) commitDefaultAgent();
    render();
  }

  function installAgent(id) {
    const a = agentOf(id);
    if (!a) return;
    if (typeof instOpen === "function") instOpen(a);
    sendCtrl({ type: "install.agent", id });
    sendCtrl({ type: "log", msg: `首次设置：安装 ${id}` });
    render();
  }

  function installGateway() {
    sendCtrl({ type: "install.magpie" });
    sendCtrl({ type: "log", msg: "首次设置：下载并安装网关" });
    render();
  }

  function chooseGateway() {
    pauseForGateway();
  }

  box.addEventListener("click", (e) => {
    const close = e.target.closest("#onb-skip");
    if (close) { skipConfirm = true; render(); return; }
    const scrim = e.target.classList && e.target.classList.contains("onb-scrim");
    if (scrim) { skipConfirm = true; render(); return; }
    const seg = e.target.closest("[data-onb-step]");
    if (seg) {
      const n = Number(seg.dataset.onbStep);
      if (Number.isInteger(n) && n <= maxStep) {
        step = n;
        skipConfirm = false;
        if (step === 1 && typeof refreshGatewayConfig === "function") refreshGatewayConfig();
        render();
      }
      return;
    }
    const install = e.target.closest("[data-onb-install]");
    if (install) { e.stopPropagation(); installAgent(install.dataset.onbInstall); return; }
    const agent = e.target.closest("[data-onb-agent]");
    if (agent) { selectAgent(agent.dataset.onbAgent); return; }
    const gwInstall = e.target.closest("[data-onb-install-gw]");
    if (gwInstall) { installGateway(); return; }
    const gwOpen = e.target.closest("[data-onb-open-gw]");
    if (gwOpen) { chooseGateway(); return; }
    const refresh = e.target.closest("[data-onb-refresh]");
    if (refresh) {
      if (typeof refreshGatewayConfig === "function") refreshGatewayConfig();
      sendCtrl({ type: "gw.refresh" });
      render();
      return;
    }
    const jump = e.target.closest("[data-onb-jump]");
    if (jump) {
      step = clampStep(jump.dataset.onbJump);
      skipConfirm = false;
      if (step === 1 && typeof refreshGatewayConfig === "function") refreshGatewayConfig();
      render();
      return;
    }
    const magpie = e.target.closest("[data-onb-magpie]");
    if (magpie) { sendCtrl({ type: "open.url", url: "https://usemagpie.ai" }); return; }
    const act = e.target.closest("[data-onb-act]");
    if (!act) return;
    const kind = act.dataset.onbAct;
    if (kind === "skip") { skipConfirm = true; render(); return; }
    if (kind === "skip-no") { skipConfirm = false; render(); return; }
    if (kind === "skip-yes") { hideAndRemember(); return; }
    if (kind === "back") { step = clampStep(step - 1); skipConfirm = false; render(); return; }
    if (kind === "next") {
      if (step === 0) commitDefaultAgent();
      step = clampStep(step + 1);
      maxStep = Math.max(maxStep, step);
      skipConfirm = false;
      render();
      return;
    }
    if (kind === "finish") { finish(); return; }
  });

  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (skipConfirm) { skipConfirm = false; render(); }
      else { skipConfirm = true; render(); }
      return;
    }
    if (e.key === "Enter" && !skipConfirm) {
      const tgt = e.target;
      if (tgt && (tgt.tagName === "BUTTON" || tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (step === STEPS.length - 1) finish();
      else { step = clampStep(step + 1); maxStep = Math.max(maxStep, step); render(); }
    }
  });

  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const a = e.target.closest && e.target.closest("[data-onb-agent]");
    if (!a) return;
    e.preventDefault();
    selectAgent(a.dataset.onbAgent);
  });

  if (resumeBtn) {
    resumeBtn.addEventListener("click", resumeSetup);
    resumeBtn.textContent = t("onb2.resume");
  }

  function showOnboarding() {
    try { localStorage.removeItem(KEY); } catch (_) {}
    maxStep = 0;
    step = 0;
    selected = "";
    showAt(0);
    sendCtrl({ type: "log", msg: "设置 → 重新打开首次使用引导" });
  }
  window.showOnboarding = showOnboarding;

  const again = document.getElementById("set-onboard-again");
  if (again) {
    // 设置页那一行偶发被别的委托吃掉；capture 段是最后一道保险，只绑一次。
    document.addEventListener("click", (e) => {
      const b = e.target && e.target.closest && e.target.closest("#set-onboard-again");
      if (b) showOnboarding();
    }, true);
    sendCtrl({ type: "log", msg: "引导：设置页「重新打开引导」已接线" });
  }
  const site = document.getElementById("set-magpie-site");
  if (site) site.addEventListener("click", () => {
    sendCtrl({ type: "open.url", url: "https://usemagpie.ai" });
  });

  function renderAbout() {
    const v = document.getElementById("set-version");
    if (v) v.textContent = (typeof STATE !== "undefined" && STATE && STATE.version) || "dev";
  }
  window.renderAbout = renderAbout;

  /* Triggered by the new-agent picker when its launchable list is empty.
     Keep the overlay over the current Workspaces surface: the project is
     already chosen, and finishing must not choose another destination. */
  function startAgentSetup(why) {
    if (seen()) return false;
    if (!box.hidden) return true;
    step = 0;
    maxStep = 0;
    selected = "";
    skipConfirm = false;
    paused = false;
    focusKey = "";
    showAt(0);
    sendCtrl({ type: "log", msg: `首次设置：新建 Agent 没有可用选项（${why || ""}）` });
    return true;
  }
  window.perchOnboarding = {
    needed: () => !seen(),
    start: startAgentSetup,
  };
})();
