"use strict";
/* 37-desk-apps.js —— 应用：启动台、网页块、应用块（照定稿模拟 spec/desk「应用与桌面」那一段）。
   · 启动台（Dock 上的「应用」）：这台电脑开始菜单里的应用（Go 扫 shell:AppsFolder，带每个应用自己的图标，缓存着）+ 搜索 + 网页搜索 / 网址。
   · 网页块：Perch 自己的 WebView2 窗口贴在块的身体上（登录状态会记住）；地址栏、后退、刷新是这里画的。
   · 应用块：那个程序**自己的窗口**贴在块的身体上，跟着块挪、跟着块缩放；「弹出成普通窗口」= 不再贴着。
     贴不上（管理员权限、全屏游戏、认不出窗口）就提示收起 Perch 后单独打开。收起状态下 Perch 不接管任何东西 —— 一律照平常那样在外面开。
   真窗口压在网页之上，所以：块收起成标签、被别的块盖着、或者浮层（设置 / 启动台 / 总览 / 托盘 / 确认框……）打开时，它们让位（desk_native.go）。 */

const LPS = { q: "", apps: null, loading: false, asked: false, recent: lsGet("perch.desk.appsRecent", {}) };
const APP_ICON = (a, s) => a && a.icon ? `<img src="/__desk/appicon/${encodeURIComponent(a.icon)}" alt="" draggable="false" style="width:${s}px;height:${s}px">` : ICON("app-window", s);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
const SEARCH_URL = "https://www.bing.com/search?q=";
function normUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(u) ? "https://" + u : SEARCH_URL + encodeURIComponent(u);
}

/* ---------- Go 推来的 ---------- */
if (W_EV) {
  W_EV.On("perch:apps", (e) => {
    const d = (e && e.data) || {};
    if (Array.isArray(d.apps)) LPS.apps = d.apps;
    LPS.loading = !!d.loading && !LPS.apps;
    if (!qs("#lp").hidden) renderLauncherList();
  });
  W_EV.On("perch:web-url", (e) => {
    const d = (e && e.data) || {};
    const z = Z.find((x) => x.id === d.id && x.kind === "web");
    if (!z || !d.url || d.url === "about:blank") return;
    if (z.web.url !== d.url || z.web.title !== (d.title || "")) { z.web.url = d.url; z.web.title = d.title || ""; z.web.ready = true; z.wv = (z.wv || 0) + 1; render(); saveLayout(); }
  });
  // 程序自己有最小尺寸：块长到装得下它（块的外框比身体宽 16、高 78）
  W_EV.On("perch:app-minsize", (e) => {
    const d = (e && e.data) || {};
    const z = Z.find((x) => x.id === d.id && x.kind === "app");
    if (!z) return;
    const el = qs(`[data-native="${z.id}"]`, ZEL.get(z.id));
    const r = el && el.getBoundingClientRect();
    const padW = r ? z.w - r.width : 16, padH = r ? z.h - r.height : 78;
    z.appz.minW = Math.ceil(d.w + padW); z.appz.minH = Math.ceil(d.h + padH);
    if (z.w >= z.appz.minW && z.h >= z.appz.minH) return;
    const dk = desk();
    const w = Math.min(dk.w, Math.max(z.w, z.appz.minW)), h = Math.min(dk.h, Math.max(z.h, z.appz.minH));
    z.x = clampN(z.x, dk.x, dk.x + dk.w - w); z.y = clampN(z.y, dk.y, dk.y + dk.h - h); z.w = w; z.h = h;
    render(); saveLayout();
  });
  W_EV.On("perch:app-state", (e) => {
    const d = (e && e.data) || {};
    const z = Z.find((x) => x.id === d.id && x.kind === "app");
    if (!z) return;
    const name = z.appz.name;
    if (d.gone) { removeZone(z); toast(`「${name}」关了，这一块也收起来了`); return; }
    if (d.ok) { z.appz.st = "glued"; z.appz.title = d.title || ""; z.appz.hwnd = d.hwnd || 0; z.wv = (z.wv || 0) + 1; render(); return; }
    removeZone(z);
    toast(`目前不支持在产品内打开「${name}」，可以收起 Perch 后单独打开（收起不影响正在跑的工作）`, "warn", { label: "收起 Perch", fn: stow });
  });
}

/* ---------- 启动台 ---------- */
function openLauncher() {
  closePops();
  LPS.q = "";
  const el = qs("#lp");
  el.innerHTML = `<div class="lp-c"><div class="lp-q">${ICON("search", 18)}<input id="lp-q" placeholder="搜应用，或者输入网址 / 关键词回车" spellcheck="false" autocomplete="off"></div><div class="lp-list"></div>`
    + `<div class="lp-note">列的是这台电脑「开始菜单」里的应用。网页开在台面的块里；桌面应用把它自己的窗口贴到块上；全屏游戏、管理员权限的程序只能在外面开。</div></div>`;
  el.hidden = false;
  if (W_EV && !LPS.asked) { LPS.asked = true; LPS.loading = !LPS.apps; W_EV.Emit("perch:apps-get", {}); }
  renderLauncherList();
  setTimeout(() => { const i = qs("#lp-q"); if (i) i.focus(); }, 40);
  syncDock();
}
function closeLauncher() { const el = qs("#lp"); if (el && !el.hidden) { el.hidden = true; syncDock(); } }
function launcherHits() {
  const q = LPS.q.trim().toLowerCase();
  const all = (LPS.apps || []).slice();
  const used = (a) => LPS.recent[a.id] || 0;
  all.sort((a, b) => (used(b) - used(a)) || a.name.localeCompare(b.name, "zh-Hans-CN"));
  return q ? all.filter((a) => a.name.toLowerCase().includes(q) || (a.exe || "").toLowerCase().includes(q)) : all;
}
function renderLauncherList() {
  const box = qs("#lp .lp-list");
  if (!box) return;
  const q = LPS.q.trim();
  const list = launcherHits();
  const web = q ? `<div class="lp-sec">网页</div><div class="lp-web"><button data-lpsearch="${esc(q)}">${ICON("search", 16)}在台面上搜索「${esc(q)}」</button>`
    + (/^[\w-]+(\.[\w-]+)+/.test(q) || /^https?:\/\//i.test(q) ? `<button data-lpurl="${esc(q)}">${ICON("globe", 16)}打开 ${esc(q)}</button>` : "") + `</div>` : "";
  let apps;
  if (!LPS.apps) apps = `<div class="lp-none">${LPS.loading || !W_EV ? (W_EV ? "正在读开始菜单里的应用…（第一次要几秒）" : "这里没有窗口通道（要在 Perch 里用）") : "没读到应用"}</div>`;
  else if (!list.length) apps = `<div class="lp-none">没找到叫「${esc(q)}」的应用</div>`;
  else apps = `<div class="lp-sec">应用</div><div class="lp-grid">${list.slice(0, q ? 60 : 400).map((a) => `<button class="lp-app" data-lpapp="${esc(a.id)}" title="${esc(a.name)}"><span class="lp-ic img">${APP_ICON(a, 40)}</span><b>${esc(a.name)}</b></button>`).join("")}</div>`;
  box.innerHTML = apps + web;
}
function openApp(a) {
  closeLauncher();
  LPS.recent[a.id] = Date.now();
  lsSet("perch.desk.appsRecent", LPS.recent);
  const r = findFree([[640, 440], [480, 330], [360, 260]]);
  const opts = { app: a };
  if (r) { const z = addZone(r, "app", opts); pingEl(ZEL.get(z.id)); return z; }
  armDraw(Object.assign({ kind: "app" }, opts), `台面上没有空地了：圈一块放「${a.name}」`);
  return null;
}
function openWeb(url) {
  closeLauncher();
  url = normUrl(url);
  if (!url) return null;
  const r = findFree([[820, 560], [640, 440], [480, 330], [360, 260]]);
  if (r) { const z = addZone(r, "web", { url }); pingEl(ZEL.get(z.id)); return z; }
  armDraw({ kind: "web", url }, "台面上没有空地了：圈一块放网页");
  return null;
}
DOCK_ACTS.apps = { act() { if (qs("#lp").hidden) openLauncher(); else closeLauncher(); }, on: () => !qs("#lp").hidden };
CLICKS.push((t) => {
  if (!t.closest("#lp")) return false;
  const b = t.closest("[data-lpapp],[data-lpsearch],[data-lpurl]");
  if (b && b.dataset.lpapp) { const a = (LPS.apps || []).find((x) => x.id === b.dataset.lpapp); if (a) openApp(a); }
  else if (b && b.dataset.lpsearch !== undefined) openWeb(SEARCH_URL + encodeURIComponent(b.dataset.lpsearch));
  else if (b && b.dataset.lpurl) openWeb(b.dataset.lpurl);
  else if (t.id === "lp") closeLauncher();
  return true;
});
document.addEventListener("input", (e) => { if (e.target.id === "lp-q") { LPS.q = e.target.value; renderLauncherList(); } });
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || !e.target.matches) return;
  if (e.target.id === "lp-q" && e.key === "Enter") {
    const q = e.target.value.trim();
    if (!q) return;
    const hits = launcherHits();
    if (hits.length === 1) openApp(hits[0]);
    else if (/^https?:\/\//i.test(q) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(q)) openWeb(q);
    else if (hits.length && hits[0].name.toLowerCase() === q.toLowerCase()) openApp(hits[0]);
    else openWeb(SEARCH_URL + encodeURIComponent(q));
    return;
  }
  if (e.key === "Enter" && e.target.matches("[data-wurl]")) {
    const z = zoneOfEl(e.target);
    if (z && z.web) { e.preventDefault(); webGo(z, e.target.value); e.target.blur(); }
  }
});
ESCS.push(() => { if (!qs("#lp").hidden) { closeLauncher(); return true; } return false; });

/* ---------- 网页块 ---------- */
function webGo(z, raw) {
  const u = normUrl(raw);
  if (!u) return;
  z.web.url = u; z.web.title = ""; z.wv = (z.wv || 0) + 1;
  if (W_EV) W_EV.Emit("perch:web-nav", { id: z.id, op: "go", url: u });
  render(); saveLayout();
}
function webOpenNative(z) {
  if (!W_EV || z.web.opened) return;
  z.web.opened = true;
  W_EV.Emit("perch:web-open", { id: z.id, url: z.web.url });
}
ZONE_KINDS.web = {
  min: { w: 360, h: 260 },
  init(z, opts) { z.web = { url: normUrl(opts.url) || "https://www.bing.com", title: "", opened: false }; z.wv = 0; },
  title(z) { return [z.web.title || hostOf(z.web.url), "网页 · " + z.web.url]; },
  tab(z) { return { ic: `<span class="tl">${ICON("globe", 14)}</span>`, st: esc(hostOf(z.web.url)), wait: 0 }; },
  render(z, zb) {
    webOpenNative(z);
    if (zb._sk !== "web") {
      zb._sk = "web";
      zb.innerHTML = `<div class="wb"><div class="wb-bar"><button data-wback title="后退">${ICON("chevron-left", 16)}</button><button data-wreload title="刷新">${ICON("rotate-cw", 14)}</button>`
        + `<input class="inp wb-url" data-wurl spellcheck="false" autocomplete="off"><button data-wext title="在外部浏览器打开">${ICON("external-link", 14)}</button></div>`
        + `<div class="wb-page" data-native="${z.id}"><div class="nat-wait">${ICON("globe", 22)}<span></span></div></div>`
        + `<div class="wb-note">网页 · Perch 内置的浏览器内核（WebView2），登录状态会记住</div></div>`;
    }
    const inp = qs("[data-wurl]", zb);
    if (inp && document.activeElement !== inp && inp.value !== z.web.url) inp.value = z.web.url;
    const w = qs(".nat-wait span", zb);
    if (w) w.textContent = z.web.ready ? "（浮层打开着，网页先让开）" : "正在打开 " + hostOf(z.web.url) + " …";
  },
  close(z) { if (W_EV) W_EV.Emit("perch:native-close", { id: z.id }); },
  busy() { return 0; },
  save(z) { return { url: z.web.url }; },
  load(z, x) { z.web = { url: normUrl(x.url) || "https://www.bing.com", title: "", opened: false }; z.wv = 0; },
};

/* ---------- 应用块 ---------- */
ZONE_KINDS.app = {
  min: (z) => ({ w: Math.max(320, (z.appz && z.appz.minW) || 0), h: Math.max(240, (z.appz && z.appz.minH) || 0) }),
  init(z, opts) {
    const a = opts.app || {};
    z.appz = { id: a.id, name: a.name || "应用", icon: a.icon || "", exe: a.exe || "", st: "opening" };
    z.wv = 0;
    if (W_EV) W_EV.Emit("perch:app-launch", { id: z.id, app: a.id, exe: a.exe || "", name: a.name || "" });
    else { z.appz.st = "gone"; }
  },
  title(z) { return [z.appz.name, "外部应用 · 它自己的窗口贴在这一块"]; },
  tab(z) { return { ic: `<span class="tl">${APP_ICON(z.appz, 14)}</span>`, st: z.appz.st === "glued" ? "外部应用" : z.appz.st === "opening" ? "正在打开…" : "没接回来", wait: 0 }; },
  render(z, zb) {
    const s = z.appz, k = "app:" + s.st;
    if (zb._sk === k) return;
    zb._sk = k;
    const body = s.st === "opening" ? `<div class="nat-wait">${APP_ICON(s, 30)}<span>正在打开「${esc(s.name)}」…</span></div>`
      : s.st === "glued" ? `<div class="nat-wait">${APP_ICON(s, 30)}<span>「${esc(s.name)}」的窗口在这里（浮层打开着，它先让开）</span></div>`
      : `<div class="nat-wait">${APP_ICON(s, 30)}<span>上次贴在这里的「${esc(s.name)}」没有接回来 —— Perch 重开以后认不出它的窗口</span><div class="nat-act"><button class="btn pri" data-apreopen>重新打开</button></div></div>`;
    zb.innerHTML = `<div class="ap"><div class="ap-bar">${APP_ICON(s, 14)}<span>外部应用 · ${esc(s.name)} 自己的窗口贴在这一块，跟着块移动、缩放</span><span class="sp"></span>${s.st === "glued" ? `<button class="btn" data-apop>弹出成普通窗口</button>` : ""}</div><div class="ap-body" data-native="${z.id}">${body}</div></div>`;
  },
  close(z) { if (W_EV && z.appz.st === "glued") W_EV.Emit("perch:native-close", { id: z.id }); },
  busy(z) { return z.appz.st === "glued" ? 1 : 0; },
  closeText(z) { return `「${z.appz.name}」会被请求关闭（有没保存的，它自己会问你）。想留着它，点块头下面的「弹出成普通窗口」。`; },
  save(z) { return { id: z.appz.id, name: z.appz.name, icon: z.appz.icon, exe: z.appz.exe }; },
  // 重开 Perch 以后认不出原来那个窗口（启动时拿不到进程号）：块留着，说清楚，一键重新打开
  load(z, x) { z.appz = { id: x.id, name: x.name || "应用", icon: x.icon || "", exe: x.exe || "", st: "gone" }; z.wv = 0; },
};
CLICKS.push((t) => {
  const zEl = t.closest(".zone .zb");
  const z = zEl && zoneOfEl(zEl);
  if (!z || (z.kind !== "web" && z.kind !== "app")) return false;
  const b = t.closest("button");
  if (!b) return false;
  const d = b.dataset;
  if (z.kind === "web") {
    if (b.hasAttribute("data-wback") && W_EV) W_EV.Emit("perch:web-nav", { id: z.id, op: "back" });
    else if (b.hasAttribute("data-wreload") && W_EV) W_EV.Emit("perch:web-nav", { id: z.id, op: "reload" });
    else if (b.hasAttribute("data-wext")) sendCtrl({ type: "open.url", url: z.web.url });
    else return false;
    return true;
  }
  if (b.hasAttribute("data-apop")) {
    if (W_EV) W_EV.Emit("perch:app-pop", { id: z.id });
    z.appz.st = "popped";
    removeZone(z);
    toast(`「${z.appz.name}」成了普通窗口，不再贴在台面上`);
    return true;
  }
  if (b.hasAttribute("data-apreopen")) {
    z.appz.st = "opening"; z.wv++;
    if (W_EV) W_EV.Emit("perch:app-launch", { id: z.id, app: z.appz.id, exe: z.appz.exe, name: z.appz.name });
    render();
    return true;
  }
  void d;
  return false;
});

/* ---------- 贴着的窗口跟着块走 ----------
   每一帧量一下这些块身体的位置（CSS 像素，相对主窗口客户区）和该不该露出来，变了才报给 Go。
   不露：块收着、被更靠前的块盖着、或者有浮层开着（真窗口压在网页之上，浮层会被它挡住）。 */
let NATIVE_SIG = "", NATIVE_RAF = 0;
const OVERLAYS = ".sheet-host,.pop,#tray,#cf";
function nativeCovered(z) {
  return Z.some((o) => o !== z && !o.collapsed && o.zi > z.zi && !(o.x >= z.x + z.w || z.x >= o.x + o.w || o.y >= z.y + z.h || z.y >= o.y + o.h));
}
function nativeTick() {
  NATIVE_RAF = 0;
  if (!W_EV) return;
  const nat = Z.filter((z) => z.kind === "web" || (z.kind === "app" && z.appz.st === "glued"));
  const overlay = [...document.querySelectorAll(OVERLAYS)].some((e) => !e.hidden && getComputedStyle(e).display !== "none");
  const items = [];
  for (const z of nat) {
    const el = !z.collapsed && qs(`[data-native="${z.id}"]`, ZEL.get(z.id));
    const r = el ? el.getBoundingClientRect() : null;
    const show = !!r && r.width > 20 && r.height > 20 && !overlay && !nativeCovered(z) && !STOWED && !document.body.classList.contains("drawing");
    items.push(r ? { id: z.id, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), show } : { id: z.id, x: 0, y: 0, w: 0, h: 0, show: false });
  }
  const sig = devicePixelRatio + "|" + JSON.stringify(items);
  if (sig !== NATIVE_SIG) { NATIVE_SIG = sig; W_EV.Emit("perch:native-place", { dpr: devicePixelRatio, items }); }
  if (nat.length) NATIVE_RAF = requestAnimationFrame(nativeTick);
}
AFTER_RENDER.push(() => { if (!NATIVE_RAF && (Z.some((z) => z.kind === "web" || z.kind === "app") || NATIVE_SIG !== "")) NATIVE_RAF = requestAnimationFrame(nativeTick); });
// 回到台面：Go 先按上一次摆回去，这里再量一次
// 主窗口显示、拿焦点要过一会儿才落定，期间它又会被提到最前面：分几次再报（Go 每次都会把贴着的窗口压回台面之上）
if (W_EV) W_EV.On("perch:unstowed", () => { for (const ms of [0, 300, 1000]) setTimeout(() => { NATIVE_SIG = ""; if (!NATIVE_RAF) NATIVE_RAF = requestAnimationFrame(nativeTick); }, ms); });
