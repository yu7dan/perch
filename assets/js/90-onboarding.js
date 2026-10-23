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
