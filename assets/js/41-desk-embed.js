"use strict";
/* 41-desk-embed.js —— 沉浸 / 嵌入（用户 2026-11-09 第三轮定）。
   沉浸（打开时默认）：台面盖住整块屏，空白处归 Perch（按住拖一下圈一块），别的窗口收到任务栏。
   嵌入：只有块、Dock、浮层这些归 Perch，其余地方归桌面 —— 能点桌面图标、开文件，新开的程序浮在块上面；
   背景只能是透出桌面（铺了底就看不到桌面了）。Dock 上的按钮随时切，不记住，每次打开都是沉浸。

   做法：页面每帧量一下「归 Perch 的地方」报给 Go（perch:hit，变了才报），Go 看鼠标在哪儿，
   把台面窗口切成点得穿 / 点不穿（cmd/perch/desk_embed.go）。要整块屏的时候（圈块、设置这类整屏的面板）报 full。 */

const HIT_SEL = ".zone, .ztab, #dock, #tray:not([hidden]), .pop:not([hidden]), .peek, #toast:not([hidden])";
let HIT_SIG = "";
function hitFull() {
  if (document.body.classList.contains("drawing")) return true;
  return [...document.querySelectorAll(".sheet-host")].some((el) => !el.hidden);
}
function hitItems() {
  const out = [];
  const push = (x, y, w, h) => { if (w >= 2 && h >= 2) out.push({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(w), h: Math.ceil(h) }); };
  for (const el of document.querySelectorAll(HIT_SEL)) {
    if (el.hidden || el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect();
    // 块的阴影、缩放手柄会伸出去一点：外扩几像素，免得边缘一碰就点到后面的桌面
    push(r.left - 6, r.top - 6, r.width + 12, r.height + 12);
  }
  // 最上沿一条细缝留给「靠上去滑出 Perch 标和时间」；滑出来以后那一整条都归 Perch
  push(0, 0, innerWidth, document.body.classList.contains("topbar") ? 56 : 4);
  return out;
}
function hitTick() {
  requestAnimationFrame(hitTick);
  if (!EMBED || STOWED || document.hidden) return;
  const full = hitFull();
  const items = full ? [] : hitItems();
  const sig = devicePixelRatio + "|" + full + "|" + JSON.stringify(items);
  if (sig === HIT_SIG) return;
  HIT_SIG = sig;
  W_EV.Emit("perch:hit", { dpr: devicePixelRatio, full, items });
}

function setEmbed(on) {
  if (!W_EV) { toast("嵌入要在 Perch 里用（这里没有窗口通道）", "warn"); return; }
  if (window.screenX < -1000) { toast("屏幕外的测试窗口不能嵌入桌面", "warn"); return; }
  EMBED = !!on;
  HIT_SIG = "";
  applyCfg();
  W_EV.Emit("perch:embed", { on: EMBED });
  const b = qs('[data-dock="embed"] .lb');
  if (b) b.textContent = EMBED ? "嵌入桌面：开（再点回到沉浸）" : "嵌入桌面 · 空白处能点到桌面图标和文件";
  toast(EMBED ? "已嵌入桌面：块和 Dock 之外的地方归桌面，能点图标、开文件" : "回到沉浸：台面盖住整块屏");
}
DOCK_ACTS.embed = { act() { setEmbed(!EMBED); }, on: () => EMBED };
if (W_EV) {
  requestAnimationFrame(hitTick);
  W_EV.On("perch:unstowed", () => { HIT_SIG = ""; });
}
