"use strict";
/* 84b-settings-nav.js —— 设置页左侧导航（2026-10-28，照 Orca 的 SettingsSidebar）。
   右边仍是一整页滚动（Orca 也是：settings-page-renderer 把所有分区排成一列，
   侧栏点一项 = scrollToSection）。这里只做三件事：
     · 按 SET_NAV 画分组导航；
     · 点一项滚到那一节（scroll-margin 留出呼吸）；
     · 滚动时高亮当前节（最后一个顶边越过视口上沿 + 余量的那一节）。
   搜索仍由 85-settings.js 管：被搜索收起的节在导航里**做灰不做隐**（还能点，点了
   会先清空搜索再跳过去 —— 灰的意思是"这次搜索里它没有命中"）。 */

const SET_NAV = [
  { group: "settings.nav.general", items: [
    { id: "set-sec-workspace", key: "settings.section.workspace", icon: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>' },
    { id: "set-sec-behavior", key: "settings.section.behavior", icon: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>' },
  ] },
  { group: "settings.nav.models", items: [
    { id: "set-sec-providers", key: "settings.section.providers", icon: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>' },
    { id: "set-sec-agents", key: "settings.section.agents", icon: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>' },
  ] },
  { group: "settings.nav.interface", items: [
    { id: "set-sec-appearance", key: "settings.section.appearance", icon: '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>' },
  ] },
  { group: "settings.nav.perch", items: [
    { id: "set-sec-about", key: "settings.section.about", icon: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' },
  ] },
];
let SET_NAV_ON = "";

function renderSetNav() {
  const host = $("set-nav-list");
  if (!host) return;
  host.innerHTML = SET_NAV.map((g) =>
    `<div class="set-nav-grp"><p>${esc(t(g.group))}</p>` +
    g.items.map((it) => {
      const sec = $(it.id);
      const dim = sec && sec.classList.contains("is-hidden");
      return `<button type="button" class="set-nav-it${it.id === SET_NAV_ON ? " on" : ""}${dim ? " dim" : ""}" data-setnav="${it.id}"` +
        `${it.id === SET_NAV_ON ? ' aria-current="true"' : ""}>${lucide(it.icon, 15)}<span>${esc(t(it.key))}</span></button>`;
    }).join("") + `</div>`).join("");
}

function setNavSync() {
  const sc = $("set-scroll");
  if (!sc) return;
  const top = sc.getBoundingClientRect().top;
  let on = "";
  for (const g of SET_NAV) for (const it of g.items) {
    const sec = $(it.id);
    if (!sec || sec.classList.contains("is-hidden")) continue;
    if (!on) on = it.id;                         // 第一节兜底（滚到顶时）
    if (sec.getBoundingClientRect().top - top <= 96) on = it.id;
  }
  // 滚到底时最后一节可能永远越不过上沿 —— 到底就算最后一节。
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
    const vis = SET_NAV.flatMap((g) => g.items).filter((it) => { const s = $(it.id); return s && !s.classList.contains("is-hidden"); });
    if (vis.length) on = vis[vis.length - 1].id;
  }
  if (on === SET_NAV_ON) return;
  SET_NAV_ON = on;
  for (const b of document.querySelectorAll("#set-nav-list .set-nav-it")) {
    const yes = b.dataset.setnav === on;
    b.classList.toggle("on", yes);
    if (yes) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  }
}

function setNavGo(id) {
  const sec = $(id);
  if (!sec) return;
  if (sec.classList.contains("is-hidden") && typeof clearSettingsSearch === "function") clearSettingsSearch(false);
  SET_NAV_ON = id;
  renderSetNav();
  sec.scrollIntoView({ block: "start", behavior: "smooth" });
}

{
  const host = $("set-nav-list");
  if (host && !host.dataset.bound) {
    host.dataset.bound = "1";
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-setnav]");
      if (b) setNavGo(b.dataset.setnav);
    });
    const sc = $("set-scroll");
    if (sc) sc.addEventListener("scroll", () => requestAnimationFrame(setNavSync), { passive: true });
    // 搜索改变了哪些节可见：导航的灰态跟着刷新。
    const search = $("set-search");
    if (search) search.addEventListener("input", () => requestAnimationFrame(() => { renderSetNav(); setNavSync(); }));
  }
  renderSetNav();
}
