"use strict";
/* First-run setup flow.
 *
 * This is not a launch splash. It starts only when the user tries to add an
 * agent and the agent picker has no installed/launchable options. The project
 * and folder have already been chosen in Workspaces, so the guide only covers
 * the two things that are actually missing: an agent and model access.
 *
 * Every status shown here comes from the live app (catalog, model providers);
 * it is not a static checklist that can drift away from reality. Finishing or
 * skipping simply closes the overlay — no forced navigation and no automatic
 * first pane.
 *
 * Model access is optional: an agent with no provider uses its own sign-in.
 * Adding a provider happens in Settings › Model providers, so "Open settings"
 * temporarily hides the overlay and leaves a small "Continue setup" button
 * behind; returning refreshes the same real state.
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
    if (typeof CATALOG !== "undefined" && Array.isArray(CATALOG) && CATALOG.length) return CATALOG;
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
    const c = a.caps || {};
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
  // 模型提供商（设置 › 模型提供商，85b-providers.js 的 PROV）。没配 = agent 用自己的登录。
  function providerList() {
    return (typeof PROV !== "undefined" && PROV && PROV.view && Array.isArray(PROV.view.providers))
      ? PROV.view.providers : [];
  }
  function agentProvider(id) {
    const cfg = (typeof provAgentCfg === "function") ? provAgentCfg(id) : {};
    const p = cfg.provider ? providerList().find((x) => x.id === cfg.provider) : null;
    return { cfg, p };
  }
  function providersLoaded() {
    return !!(typeof PROV !== "undefined" && PROV && PROV.view);
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
    ensureSelected();
    const a = agentOf(selected);
    const list = providerList();
    const withKey = list.filter((p) => p.hasKey).length;
    const { cfg, p } = agentProvider(selected);
    const usesValue = p ? (cfg.model ? `${p.name} · ${cfg.model}` : p.name) : t("onb2.models.ownLogin");
    const rows = list.slice(0, 4).map((x) =>
      `<div class="onb-status"><span class="dot ${x.hasKey ? "ok" : "warn"}"></span>` +
      `<span class="lbl">${esc(x.name)}</span>` +
      `<span class="val">${esc(x.hasKey ? t("onb2.models.keyOk", { n: (x.models || []).length }) : t("onb2.models.keyMissing"))}</span></div>`).join("");
    return kicker("onb2.kicker.models") + title("onb2.models.title") + lead("onb2.models.lead") +
      `<div class="onb-section">` +
      `<div class="onb-status"><span class="dot ${list.length ? "ok" : ""}"></span><span class="lbl">${esc(t("onb2.models.providers"))}</span>` +
      `<span class="val">${esc(providersLoaded() ? t("onb2.models.providerUnit", { n: list.length }) : t("onb2.models.reading"))}</span>` +
      `<span class="act"><button type="button" class="onb-btn sm" data-onb-open-prov>${esc(t(list.length ? "onb2.models.manage" : "onb2.models.add"))}</button></span></div>` +
      rows +
      (a ? `<div class="onb-status"><span class="dot ok"></span><span class="lbl">${esc(t("onb2.models.uses", { agent: a.name || a.id }))}</span>` +
        `<span class="val">${esc(usesValue)}</span></div>` : "") +
      `</div>` +
      `<p class="onb-sub">${esc(t(withKey ? "onb2.models.pickLater" : "onb2.models.optional"))}</p>`;
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
    return !!(a && a.installed && launchable(a));
  }

  function doneStep() {
    ensureSelected();
    const a = agentOf(selected);
    const aReady = !!(a && a.installed && launchable(a));
    const allReady = setupReady();
    const agentLabel = a ? (a.name || a.id) : t("onb2.done.notReady");
    const { cfg, p } = agentProvider(selected);
    const provValue = p ? (cfg.model ? `${p.name} · ${cfg.model}` : p.name) : t("onb2.models.ownLogin");
    return kicker("onb2.kicker.done") + title(allReady ? "onb2.done.title" : "onb2.done.titleAlmost") + lead("onb2.done.lead") +
      `<div class="onb-ready ${allReady ? "ok" : "warn"}">` +
      `<span class="onb-seal" aria-hidden="true">${allReady ? "✓" : "!"}</span>` +
      `<div class="onb-ready-tx"><b>${esc(t(allReady ? "onb2.done.readyTitle" : "onb2.done.almostTitle"))}</b>` +
      `<span>${esc(t(allReady ? "onb2.done.readyBody" : "onb2.done.almostBody", { agent: agentLabel }))}</span></div>` +
      `</div>` +
      `<div class="onb-review">` +
      reviewRow(t("onb2.done.agent"), aReady ? agentLabel : t("onb2.done.notReady"), aReady, 0) +
      reviewRow(t("onb2.done.provider"), provValue, true, 1) +
      `</div>`;
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
    const prov = providerList().map((p) => `${p.id}:${p.hasKey ? 1 : 0}:${(p.models || []).length}`).join(",");
    const own = JSON.stringify(agentProvider(selected).cfg || {});
    return [
      step, skipConfirm, selected, cat, inst, prov, own, providersLoaded(),
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
    if (step === 1 && typeof provRequest === "function") provRequest();
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

  function pauseForSettings() {
    paused = true;
    box.hidden = true;
    stopTicker();
    if (resume) resume.hidden = false;
    if (typeof setNavView === "function") setNavView("settings");
    if (typeof setSettingsPage === "function") setSettingsPage("set-sec-providers");
    sendCtrl({ type: "log", msg: "首次设置：打开设置 › 模型提供商（返回后继续）" });
  }

  function resumeSetup() {
    if (!paused) return;
    if (typeof provRequest === "function") provRequest();
    showAt(step);
    sendCtrl({ type: "log", msg: "首次设置：从设置返回，继续" });
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
        if (step === 1 && typeof provRequest === "function") provRequest();
        render();
      }
      return;
    }
    const install = e.target.closest("[data-onb-install]");
    if (install) { e.stopPropagation(); installAgent(install.dataset.onbInstall); return; }
    const agent = e.target.closest("[data-onb-agent]");
    if (agent) { selectAgent(agent.dataset.onbAgent); return; }
    const provOpen = e.target.closest("[data-onb-open-prov]");
    if (provOpen) { pauseForSettings(); return; }
    const jump = e.target.closest("[data-onb-jump]");
    if (jump) {
      step = clampStep(jump.dataset.onbJump);
      skipConfirm = false;
      if (step === 1 && typeof provRequest === "function") provRequest();
      render();
      return;
    }
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
