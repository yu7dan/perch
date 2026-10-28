"use strict";
/* 84b-settings-nav.js —— 设置页左侧导航（2026-10-28，形态照 Orca 的 SettingsSidebar）。
   用户定的：**每个模块一页**，不做一整页滚动 + 定位锚点（模块一多会乱）。
     · 导航选哪一项，右边就只显示那一节（其余 .is-offpage）；记住上次停在哪一页。
     · 搜索时例外：结果跨模块列出（否则搜不到别页的东西），清空搜索回到当前页。
     · 被搜索收起的节在导航里**做灰不做隐**（灰 = 这次搜索里它没有命中）。 */

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
let SET_PAGE = (() => {
  try { return localStorage.getItem("perch.settingsPage") || ""; } catch (_) { return ""; }
})();
function setPageIds() { return SET_NAV.flatMap((g) => g.items.map((it) => it.id)); }
function setPageCur() {
  const ids = setPageIds();
  return ids.includes(SET_PAGE) && $(SET_PAGE) ? SET_PAGE : ids[0];
}
function setSearching() {
  const q = $("set-search");
  return !!(q && q.value.trim());
}

/* 把「当前页」落到 DOM 上：非当前页的节收起（搜索时不收）。 */
function applySetPage() {
  const cur = setPageCur();
  const searching = setSearching();
  for (const id of setPageIds()) {
    const sec = $(id);
    if (sec) sec.classList.toggle("is-offpage", !searching && id !== cur);
  }
  const root = $("settings");
  if (root) root.classList.toggle("set-searching", searching);
}

function renderSetNav() {
  const host = $("set-nav-list");
  if (!host) return;
  const cur = setPageCur();
  const searching = setSearching();
  host.innerHTML = SET_NAV.map((g) =>
    `<div class="set-nav-grp"><p>${esc(t(g.group))}</p>` +
    g.items.map((it) => {
      const sec = $(it.id);
      const dim = searching && sec && sec.classList.contains("is-hidden");
      const on = it.id === cur;
      return `<button type="button" class="set-nav-it${on ? " on" : ""}${dim ? " dim" : ""}" data-setnav="${it.id}"` +
        `${on ? ' aria-current="page"' : ""}>${lucide(it.icon, 15)}<span>${esc(t(it.key))}</span></button>`;
    }).join("") + `</div>`).join("");
  applySetPage();
}

/* 切到某一页（导航点击 / 总览 Agent 行 / 引导「管理提供商」都走这里）。 */
function setSettingsPage(id) {
  if (!$(id)) return;
  SET_PAGE = id;
  try { localStorage.setItem("perch.settingsPage", id); } catch (_) {}
  if (setSearching() && typeof clearSettingsSearch === "function") clearSettingsSearch(false);
  renderSetNav();
  const sc = $("set-scroll");
  if (sc) sc.scrollTop = 0;
}
// 旧名字留着：别处（85b / 90）可能还在调。
function setNavGo(id) { setSettingsPage(id); }
function setNavSync() { applySetPage(); }

{
  const host = $("set-nav-list");
  if (host && !host.dataset.bound) {
    host.dataset.bound = "1";
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-setnav]");
      if (b) setSettingsPage(b.dataset.setnav);
    });
    // 搜索改变了哪些节可见：导航的灰态和分页跟着刷新。
    const search = $("set-search");
    if (search) search.addEventListener("input", () => requestAnimationFrame(renderSetNav));
  }
  renderSetNav();
}
