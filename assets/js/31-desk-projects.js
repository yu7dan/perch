"use strict";
/* 31-desk-projects.js —— 项目面板（Dock「项目与文件」）+ 选文件夹 / 新建文件夹窗口。
   项目 = 盘上的一个文件夹（Go 的项目池，projects.json）。这里只管看和改池子；
   agent 在哪个文件夹里开就归哪个项目，那条归属是 Go 算的。外观和话照定稿模拟（spec/desk 的 PP / FPK 两段）。 */

const PP = { view: "list", flash: null };
let PP_REQ = 0;
const ppPending = new Map();   // req → { op, path, name }
// 这个项目里现在在跑的 agent（格子里的 + 各模块报上来的，比如 Bot Group 的成员）。
const RUNNING_IN = [];   // (path) => [agentId]
function runningIn(path) {
  const ags = allLeaves().filter((x) => x.l.tab && !x.l.tab.connDown && insidePath(effCwd(x.l.tab), path)).map((x) => x.l.agent);
  for (const f of RUNNING_IN) ags.push(...f(path));
  return ags;
}
function projRowHTML(p, actions) {
  const ags = runningIn(p.path);
  return `<div class="pr${PP.flash && normPath(PP.flash) === normPath(p.path) ? " flash" : ""}"><span class="ic">${ICON("folder", 16)}</span><div class="pm"><b>${esc(p.name)}</b><span title="${esc(p.path)}">${esc(p.path)}</span></div>`
    + `<span class="pl">${[...new Set(ags)].slice(0, 4).map((a) => logo(a)).join("")}${ags.length ? `<em>${ags.length} 个在跑</em>` : ""}</span>`
    + `<div class="pa">${actions ? `<button data-pp="files" data-p="${esc(p.path)}" title="在台面上看它的文件">${ICON("folder-tree", 15)}</button>`
    + `<button data-pp="agent" data-p="${esc(p.path)}" title="在这里开一个 Agent">${ICON("sparkles", 15)}</button>` : ""}`
    + `<button data-pp="rm" data-p="${esc(p.path)}" title="从 Perch 里移除（文件夹不动）">${ICON("trash-2", 15)}</button></div></div>`;
}
// 最近用过的：agent 跑过、但还不是项目的文件夹（会话库里的 cwd，按最近活动排）。
function recentDirs() {
  const seen = new Set(PROJECTS().map((p) => normPath(p.path)));
  const def = normPath(defaultAreaPath());
  const out = [];
  const ss = (STATE?.sessions || []).filter((s) => s && s.cwd && !s.sidechain).slice().sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  for (const s of ss) {
    const k = normPath(s.cwd);
    if (seen.has(k) || k === def || PROJECTS().some((p) => insidePath(s.cwd, p.path))) continue;
    seen.add(k);
    out.push({ name: base(s.cwd) || s.cwd, path: s.cwd });
    if (out.length >= 3) break;
  }
  return out;
}
function ppAddHTML(inSettings) {
  const recent = recentDirs();
  return (inSettings ? "" : `<div class="pp-h"><button class="back" data-pp="back" title="返回">${ICON("arrow-left", 15)}</button><b>添加文件夹</b></div>`)
    + `<div class="pp-two"><button class="pre" data-pp="browse"><span class="ic">${ICON("folder-open", 18)}</span><b>选一个已有的文件夹…</b><span>在盘上任意位置挑</span></button>`
    + `<button class="pre" data-pp="create"><span class="ic">${ICON("folder-plus", 18)}</span><b>新建一个文件夹…</b><span>自己定建在哪、叫什么</span></button></div>`
    + (recent.length ? `<div class="pp-sec">最近用过的</div>` + recent.map((d) => `<div class="pr" data-pp="pick" data-path="${esc(d.path)}" data-name="${esc(d.name)}" style="cursor:pointer"><span class="ic">${ICON("folder", 16)}</span><div class="pm"><b>${esc(d.name)}</b><span>${esc(d.path)}</span></div></div>`).join("") : "");
}
function renderPP() {
  const el = qs("#pp");
  if (PP.view === "add") el.innerHTML = ppAddHTML(false);
  else {
    const ps = PROJECTS();
    el.innerHTML = `<div class="pp-h"><b>项目</b><span class="sp"></span><button class="btn" data-pp="add">${ICON("folder-plus", 14)}添加文件夹</button></div>`
      + (ps.length ? ps.map((p) => projRowHTML(p, true)).join("") : `<div class="pp-note">还没有项目。加一个文件夹进来，agent 就能在里面干活。</div>`)
      + `<div class="pp-note">项目 = 盘上的一个文件夹。agent 在哪个文件夹里开，就归哪个项目；它碰过的文件在「文件」块里看。</div>`;
  }
}
function openPP(view) {
  PP.view = view || "list";
  renderPP();
  placeNearDock(qs("#pp"), qs('[data-dock="proj"]'));
  syncDock();
}
function rerenderProjects() {
  if (!qs("#pp").hidden) { renderPP(); placeNearDock(qs("#pp"), qs('[data-dock="proj"]')); }
  if (typeof onProjectsChanged === "function") onProjectsChanged();
  for (const { l } of allLeaves()) if (!l.tab) l.v++;
  render();
}
function addProject(path, name) {
  if (!path) return;
  if (isProjPath(path)) { toast("这个文件夹已经是项目了", "warn"); return; }
  const req = ++PP_REQ;
  ppPending.set(req, { op: "add", path, name });
  sendCtrl({ type: "project.add", req, path, name: name || "", source: "manual" });
}
function createFolder(parent, name) {
  const req = ++PP_REQ;
  ppPending.set(req, { op: "create", path: parent, name });
  sendCtrl({ type: "project.create", req, path: parent, name });
}
async function removeProject(path) {
  const n = runningIn(path).length;
  const name = projName(path);
  if (n) {
    const ok = await deskConfirm(`从 Perch 移除「${name}」？`, `里面还有 ${n} 个 agent 在跑，它们会接着跑。移除只是不在 Perch 里显示这个文件夹，盘上的文件一个都不动。`, "移除");
    if (!ok) return;
  }
  const req = ++PP_REQ;
  ppPending.set(req, { op: "remove", path, name });
  sendCtrl({ type: "project.remove", req, path });
}
// Go 的轻量回执（project.result）：池子先在这里改好，全量的 pool 快照稍后补。
function projectResultArrived(m) {
  const want = ppPending.get(m.req) || {};
  ppPending.delete(m.req);
  STATE = STATE || {};
  const projects = Array.isArray(STATE.projects) ? STATE.projects : (STATE.projects = []);
  if (!m.ok) {
    const why = tMsg(m.errCode, m.errParams, m.err || "");
    if (m.op === "create" && m.created) toast(`文件夹建好了，但没加进项目：${why}`, "warn");
    else toast((m.op === "remove" ? "移除没成：" : "没加上：") + why, "warn");
    return;
  }
  if (typeof m.rev === "number") STATE.poolRev = m.rev;
  if (m.op === "add" || m.op === "create") {
    const p = m.project;
    if (p && !projects.some((x) => normPath(x.path) === normPath(p.path))) projects.push(p);
    const path = (p && p.path) || m.path;
    PP.flash = path; PP.view = "list";
    if (PENDING_LEAF) { PENDING_LEAF.proj = path; PENDING_LEAF.v++; PENDING_LEAF = null; saveLayout(); }
    if (PENDING_GROUP && PENDING_GROUP.group) { PENDING_GROUP.group.proj = path; PENDING_GROUP.group.sv++; PENDING_GROUP = null; }
    toast(m.op === "create" ? `已新建并添加：${projName(path)}（${path}）` : `已添加：${projName(path)}`);
    setTimeout(() => { PP.flash = null; }, 1500);
  } else if (m.op === "remove") {
    STATE.projects = projects.filter((x) => normPath(x.path) !== normPath(m.path));
    toast(`已移除：${want.name || base(m.path)}（文件夹没动）`);
  }
  rerenderProjects();
}
// 系统自带的选文件夹窗口（选文件夹窗口里的一个出口）。
function projectPickedArrived(m) {
  if (m.canceled || !m.path) return;
  if (FPK.forWork) { setDefaultCwd(m.path); return; }
  addProject(m.path);
}
function setDefaultCwd(path) {
  sendCtrl({ type: "settings.set", settings: { defaultCwd: path } });
  toast(`默认工作区：${path}`);
}
function ppAct(k, b) {
  if (k === "add") { openPP("add"); return; }
  if (k === "back") { openPP("list"); return; }
  if (k === "pick") { addProject(b.dataset.path, b.dataset.name); return; }
  if (k === "browse") { openPicker("pick"); return; }
  if (k === "create") { openPicker("create"); return; }
  if (k === "workdir") { openPicker("pick", { forWork: true, start: defaultAreaPath() }); return; }
  if (k === "files") { closePops(); if (typeof openFilesFor === "function") openFilesFor(b.dataset.p); return; }
  if (k === "agent") { openAgentIn(b.dataset.p); return; }
  if (k === "rm") { removeProject(b.dataset.p); return; }
}

/* ---------- 选文件夹 / 新建文件夹（真磁盘，Go 的 dir.browse 只回子文件夹） ---------- */
const FPK = { mode: "pick", path: "", sel: null, forWork: false, name: "", dirs: [], places: [], err: "", loading: false, req: 0 };
function browse(path) {
  FPK.req = ++PP_REQ;
  FPK.loading = true;
  sendCtrl({ type: "dir.browse", req: FPK.req, path: path || "" });
}
function applyDirBrowse(m) {
  if (m.req !== FPK.req) return;   // 点得快的时候，只认最后一次
  FPK.loading = false;
  FPK.path = m.path || "";
  FPK.dirs = m.dirs || [];
  FPK.places = m.places || FPK.places;
  FPK.err = m.err || "";
  if (!qs("#fpk").hidden) renderPicker();
}
function openPicker(mode, opts) {
  opts = opts || {};
  FPK.mode = mode; FPK.forWork = !!opts.forWork; FPK.sel = null; FPK.name = ""; FPK.dirs = []; FPK.err = "";
  const start = opts.start || (mode === "create" ? defaultAreaPath() : "");
  FPK.path = start;
  closePops();
  qs("#fpk").hidden = false;
  browse(start);
  renderPicker();
  if (mode === "create") setTimeout(() => { const i = qs("#fpk-name"); if (i) i.focus(); }, 40);
}
function closePicker() { qs("#fpk").hidden = true; }
// 面包屑：C:\ › Users › …
function crumbsOf(p) {
  if (!p) return [];
  const parts = String(p).split("\\").filter(Boolean);
  const out = [];
  let acc = "";
  parts.forEach((s, i) => { acc = i === 0 ? s + "\\" : acc.replace(/\\?$/, "\\") + s; out.push({ name: i === 0 ? s : s, path: acc }); });
  return out;
}
const joinPath = (a, b) => a.replace(/\\+$/, "") + "\\" + b;
function renderPicker() {
  const el = qs("#fpk"), cur = FPK.path;
  const crumbs = [`<button data-fpgo="">此电脑</button>`].concat(crumbsOf(cur).map((c) => `<button data-fpgo="${esc(c.path)}">${esc(c.name)}</button>`)).join(`<span>›</span>`);
  const places = FPK.places.map((p) => [p.name, p.path, "folder"]).concat([["默认工作区", defaultAreaPath(), "folder"], ["此电脑", "", "monitor"]]);
  const rows = FPK.loading && !FPK.dirs.length ? `<div class="fz-empty">正在读…</div>`
    : FPK.err ? `<div class="fz-empty">打不开这个文件夹：${esc(FPK.err)}</div>`
    : FPK.dirs.length ? FPK.dirs.map((d) => `<div class="fpr${FPK.sel === d.path ? " on" : ""}" data-fpsel="${esc(d.path)}"><span class="ic">${ICON(cur ? "folder" : "monitor", 16)}</span>`
      + `<b>${esc(cur ? d.name : d.name.replace("\\", "") + " 盘")}</b>${isProjPath(d.path) ? `<span class="tag">已是项目</span>` : ""}<span class="sp"></span>`
      + `<button class="fpin" data-fpin="${esc(d.path)}" title="进去">${ICON("chevron-right", 15)}</button></div>`).join("")
    : `<div class="fz-empty">这里没有子文件夹。${FPK.mode === "create" ? "新文件夹会建在这里。" : ""}</div>`;
  const target = FPK.sel || cur;
  const foot = FPK.mode === "pick" || FPK.forWork
    ? `<span class="fpk-path">${target ? esc(target) : "先选一个文件夹"}</span><button class="btn pri${target ? "" : " na"}" data-fpok>${ICON("check", 14)}${FPK.forWork ? "设为默认工作区" : "选这个文件夹"}</button>`
    : `<span class="fpk-path">建在 ${cur ? esc(cur.replace(/\\?$/, "\\")) : "（先进到一个盘或文件夹）"}</span>`
      + `<input id="fpk-name" class="inp" placeholder="新文件夹的名字" value="${esc(FPK.name || "")}" spellcheck="false" autocomplete="off"><button class="btn pri${cur ? "" : " na"}" data-fpok>${ICON("folder-plus", 14)}新建并添加</button>`;
  const nm = qs("#fpk-name"); const hadFocus = nm && document.activeElement === nm;
  // 选中一行会重画整个窗口：同一个文件夹里，列表的滚动位置要留着（不然点下面那行，列表跳回顶上，第二下点到了别处）
  const ol = qs(".fpk-list", el), keepTop = ol && el._path === cur ? ol.scrollTop : 0;
  el._path = cur;
  el.innerHTML = `<div class="back"></div><div class="fpk-c">`
    + `<div class="fpk-h"><b>${FPK.forWork ? "选默认工作区" : FPK.mode === "pick" ? "选一个已有的文件夹" : "新建一个文件夹"}</b>`
    + (FPK.forWork ? "" : `<div class="seg"><button data-fpmode="pick" class="${FPK.mode === "pick" ? "on" : ""}">选已有的</button><button data-fpmode="create" class="${FPK.mode === "create" ? "on" : ""}">新建一个</button></div>`)
    + `<span class="sp"></span><button class="s-x" data-fpx title="关掉（Esc）">${ICON("x", 16)}</button></div>`
    + `<div class="fpk-m"><nav class="fpk-side">${places.map(([t, p, ic]) => `<button data-fpplace="${esc(p)}">${ICON(ic, 15)}${esc(t)}</button>`).join("")}</nav>`
    + `<div class="fpk-main"><div class="crumb">${crumbs}</div><div class="fpk-list">${rows}</div></div></div>`
    + `<div class="fpk-f">${foot}</div>`
    + `<div class="fpk-note">${FPK.mode === "create" && !FPK.forWork ? "进到哪个文件夹，新文件夹就建在哪。" : "点一下选中，双击或点 › 进去。"}`
    + ` 也可以用 <button class="lnk" data-fpsys>Windows 自带的选文件夹窗口</button>。</div></div>`;
  if (keepTop) qs(".fpk-list", el).scrollTop = keepTop;
  if (hadFocus) { const i = qs("#fpk-name"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}
function pickerClick(t, e) {
  if (t.classList.contains("back") || t.closest("[data-fpx]")) { closePicker(); return; }
  const b = t.closest("[data-fpgo],[data-fpsel],[data-fpin],[data-fpplace],[data-fpmode],[data-fpok],[data-fpsys]");
  if (!b) return;
  const d = b.dataset;
  const nm = qs("#fpk-name"); if (nm) FPK.name = nm.value;
  if (d.fpin !== undefined) { FPK.sel = null; browse(d.fpin); }
  else if (d.fpgo !== undefined) { FPK.sel = null; browse(d.fpgo); }
  // 双击进去：按点击次数判（第一下点完会重画列表，dblclick 事件落到的已经不是那一行了）
  else if (d.fpsel !== undefined) { if (e && e.detail >= 2) { FPK.sel = null; browse(d.fpsel); } else FPK.sel = d.fpsel; }
  else if (d.fpplace !== undefined) { FPK.sel = null; browse(d.fpplace); }
  else if (d.fpmode) { FPK.mode = d.fpmode; FPK.sel = null; }
  else if (b.hasAttribute("data-fpsys")) { sendCtrl({ type: "project.pick", req: ++PP_REQ, msg: FPK.forWork ? "选默认工作区" : "选一个文件夹" }); closePicker(); return; }
  else if (b.hasAttribute("data-fpok")) { pickerOk(); return; }
  renderPicker();
}
function pickerOk() {
  if (FPK.mode === "pick" || FPK.forWork) {
    const target = FPK.sel || FPK.path;
    if (!target) { toast("先选一个文件夹", "warn"); return; }
    if (FPK.forWork) { closePicker(); setDefaultCwd(target); return; }
    if (isProjPath(target)) { toast("这个文件夹已经是项目了", "warn"); return; }
    closePicker();
    addProject(target);
    return;
  }
  const i = qs("#fpk-name"), name = ((i && i.value) || "").trim();
  if (!FPK.path) { toast("先进到一个盘或文件夹里", "warn"); return; }
  if (!name) { toast("给新文件夹起个名字", "warn"); if (i) i.focus(); return; }
  if (/[\\/:*?"<>|]/.test(name)) { toast("名字里不能有 \\ / : * ? \" < > |", "warn"); return; }
  if (FPK.dirs.some((d) => d.name.toLowerCase() === name.toLowerCase())) { toast(`这里已经有一个叫 ${name} 的文件夹了`, "warn"); return; }
  closePicker();
  createFolder(FPK.path, name);
}

/* ---------- 接进台面 ---------- */
// 项目池 / 在跑的 agent 变了，开着的项目面板跟上（只在内容真的变了才重画）。
let PP_SIG = "";
AFTER_RENDER.push(() => {
  if (qs("#pp").hidden || PP.view !== "list") { PP_SIG = ""; return; }
  const sig = PROJECTS().map((p) => p.path + ":" + runningIn(p.path).join(",")).join("|");
  if (sig === PP_SIG) return;
  PP_SIG = sig; renderPP(); placeNearDock(qs("#pp"), qs("[data-dock=\"proj\"]"));
});
POPS.push("#pp");
DOCK_ACTS.proj = { act() { if (qs("#pp").hidden) openPP("list"); else closePops(); }, on: () => !qs("#pp").hidden };
CLICKS.push((t, ev) => {
  if (t.closest("#fpk")) { pickerClick(t, ev); return true; }
  const pp = t.closest("[data-pp]");
  if (pp) { ppAct(pp.dataset.pp, pp); return true; }
  return false;
});
ESCS.push(() => { if (!qs("#fpk").hidden) { closePicker(); return true; } return false; });
document.addEventListener("keydown", (e) => {
  if (qs("#fpk").hidden || e.isComposing) return;
  if (e.key === "Enter" && e.target.id === "fpk-name") { e.preventDefault(); pickerOk(); }
});
