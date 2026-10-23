"use strict";
/* First-run welcome card. One card, one decision: start working or open the
   gateway. The magpie credit is part of the card by design; the engine's
   routing mascot keeps the same name. */
(function () {
  const KEY = "perch.onboarded.v1";
  const box = document.getElementById("onb");
  if (!box) return;

  function seen() {
    try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, "1"); } catch (_) {}
  }
  function hide() {
    box.hidden = true;
    remember();
  }
  function openGateway() {
    hide();
    if (typeof setNavView === "function") setNavView("dash");
    const tab = document.querySelector('#dash-tabs .opt[data-dtab="gateway"]');
    if (tab) tab.click();
  }
  function showOnboarding() {
    if (!box.hidden) return;
    try { localStorage.removeItem(KEY); } catch (_) {}
    box.hidden = false;
    sendCtrl({ type: "log", msg: "设置 → 重新打开首次使用引导" });
    setTimeout(() => { if (start) start.focus(); }, 40);
  }
  function renderAbout() {
    const v = document.getElementById("set-version");
    if (v) v.textContent = (typeof STATE !== "undefined" && STATE && STATE.version) || "dev";
  }
  window.showOnboarding = showOnboarding;
  window.renderAbout = renderAbout;

  const again = document.getElementById("set-onboard-again");
  if (again) {
    again.addEventListener("click", showOnboarding);
    // 设置页里这排按钮的点击偶发被别的委托吃掉；capture 段是最后一道保险。
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

  const start = document.getElementById("onb-start");
  const skip = document.getElementById("onb-skip");
  const gateway = document.getElementById("onb-gateway");
  const magpie = document.getElementById("onb-magpie");
  if (start) start.addEventListener("click", hide);
  if (skip) skip.addEventListener("click", hide);
  if (gateway) gateway.addEventListener("click", openGateway);
  if (magpie) magpie.addEventListener("click", () => {
    sendCtrl({ type: "open.url", url: "https://usemagpie.ai" });
  });
  box.addEventListener("click", (e) => {
    if (e.target && e.target.classList.contains("onb-scrim")) hide();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
  });

  if (!seen()) {
    setTimeout(() => {
      if (seen()) return;
      box.hidden = false;
      setTimeout(() => { if (start) start.focus(); }, 40);
    }, 900);
  }
})();
