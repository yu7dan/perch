"use strict";
/* 40-desk-glass.js —— 告诉 Go 哪些地方要垫真毛玻璃（cmd/perch/desk_glass.go）。
   台面窗口是透明的，网页里的 backdrop-filter 糊不到后面的桌面；凡是本来就带磨砂的东西（块、Dock、收起的标签、
   浮层、设置那种整屏的暗底……），Go 在它正下方垫一扇系统磨砂小窗。这里每一帧量一下它们在哪、圆角多大，变了才报。 */

const GLASS_SEL = ".zone:not(.collapsed), #dock, .ztab, .pop, #tray, .sheet-host:not([hidden]) > *, #lp:not([hidden]), .peek, #toast:not([hidden])";
const GLASS_HAS = new WeakMap();   // 元素 → 有没有 backdrop-filter（量一次就记住）
let GLASS_SIG = "";
function glassItems() {
  const out = [];
  for (const el of document.querySelectorAll(GLASS_SEL)) {
    if (el.hidden || el.closest("[hidden]")) continue;
    let has = GLASS_HAS.get(el);
    if (has === undefined) {
      const cs = getComputedStyle(el);
      has = (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none");
      GLASS_HAS.set(el, has);
    }
    if (!has) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || +cs.opacity < 0.05 || cs.display === "none") continue;
    out.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(parseFloat(cs.borderTopLeftRadius) || 0) });
  }
  return out;
}
function glassTick() {
  requestAnimationFrame(glassTick);
  if (!W_EV || document.hidden || STOWED) return;
  // 渐变 / 纯色时页面自己铺了底，窗口后面的桌面看不见：不用垫
  const wall = document.body.classList.contains("bg-wall");
  const items = wall ? glassItems() : [];
  // 整屏那层（41-desk-embed.js 的 deskLayer）：垫在最底下，不圆角
  if (wall && typeof deskLayer === "function" && deskLayer()) items.unshift({ x: 0, y: 0, w: innerWidth, h: innerHeight, r: 0 });
  const light = typeof themeEffective === "function" && themeEffective() === "light";
  const sig = devicePixelRatio + "|" + light + "|" + JSON.stringify(items);
  if (sig === GLASS_SIG) return;
  GLASS_SIG = sig;
  W_EV.Emit("perch:glass", { dpr: devicePixelRatio, light, items });
}
// 屏幕外的测试实例：窗口不透明，不垫（Go 那边也会拦）
if (W_EV && window.screenX > -1000) requestAnimationFrame(glassTick);
if (W_EV) W_EV.On("perch:unstowed", () => { GLASS_SIG = ""; });
