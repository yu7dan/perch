/* ===========================================================================
   新建 Agent（目标 + Agent）
   ---------------------------------------------------------------------------
   目标只有三种，全部显式：
     project   项目池里的一个真实项目，cwd = 项目目录
     directory 当前目录/未归类目录，cwd = 这个目录（不悄悄改成默认）
     scratch   无项目，cwd 空；Go 侧落到默认工作区根目录
   没有“空着 = 默认”的第四条路；没有“不启动 Agent”的混合提交。
   =========================================================================== */

let NA = null; // { targetKind, targetPath, targetName, agent, staleAgent, agentDirty,
               //   opener, why, popOpen, query, active, busy, error }
let NA_OPTS = [];

const NA_ICON_FOLDER = lucide(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', 16);
const NA_ICON_TERM = lucide(
  '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>', 16);

function naRealProjects() {
  return (STATE?.projects || []).filter((p) => p && p.path && !p.synthetic);
}

function naRealProjectByPath(path) {
  const k = normPath(path);
  return k ? naRealProjects().find((p) => normPath(p.path) === k) || null : null;
}

function naProjectOwning(path) {
  const c = String(path || "");
  if (!c) return null;
  let best = null, bestLen = -1;
  for (const p of naRealProjects()) {
    if (!insidePath(c, p.path)) continue;
    const n = normPath(p.path).length;
    if (n > bestLen) { best = p; bestLen = n; }
  }
  return best;
}

function naDefaultPath() { return defaultAreaPath() || defaultWorkspacePath(); }

function naNoneTarget() {
  return { kind: "none", path: "", name: "" };
}

function naTargetFromCwd(cwd) {
  const p = naProjectOwning(cwd);
  if (p) return { kind: "project", path: p.path, name: projectName(p) };
  // Workspaces 的新 Agent 必须落在一个真实 Project 里。默认区留给 Chat；
  // 这里不再提供 "默认项目/未归类目录" 的新建旁路。
  return naNoneTarget();
}

function naTargetFromProjectPath(path) {
  const p = naRealProjectByPath(path);
  if (p) return { kind: "project", path: p.path, name: projectName(p) };
  return naNoneTarget();
}

function naDefaultTarget() {
  const tab = (typeof activeTab !== "undefined" && activeTab && activeTab.id > 0)
    ? activeTab : (TAB_LIST || []).find((x) => x.id > 0);
  if (tab) return naTargetFromCwd(effCwd(tab));
  return naNoneTarget();
}

function naAgentList(path) {
  const def = defaultAgentId();
  const remembered = lastAgentFor(path || naDefaultPath());
  const rank = (a) => (a.id === remembered ? 0 : a.id === def ? 1 : 2);
  return opCatalog().filter(opLaunchable).slice().sort((a, b) => {
    const ar = rank(a), br = rank(b);
    if (ar !== br) return ar - br;
    const as = a.caps && a.caps.status ? 0 : 1;
    const bs = b.caps && b.caps.status ? 0 : 1;
    return as - bs;
  });
}

function naPickAgentForPath(path) {
  const list = naAgentList(path);
  const remembered = lastAgentFor(path || naDefaultPath());
  const canRemember = !!remembered && list.some((a) => a.id === remembered);
  const def = defaultAgentId();
  const canDefault = list.some((a) => a.id === def);
  return {
    agent: canRemember ? remembered : (canDefault ? def : ""),
    stale: remembered && !canRemember ? remembered : "",
  };
}

function naTargetPathDisplay() {
  if (!NA || NA.targetKind !== "project") return "";
  return NA.targetPath || "";
}

function naIsOpen() { return !!(NA && $("newagent") && !$("newagent").hidden); }
function naPopOpen() { return !!(NA && NA.popOpen); }

/* The first-run guide belongs to this moment: the user has a real Project and
   opened "new agent", but the picker has nothing installable/launchable to
   offer. It must not fire on project creation or while the catalog is still
   missing/loading. */
function naAgentSetupNeeded() {
  if (!NA || NA.busy) return false;
  if (NA.targetKind !== "project" || !NA.targetPath) return false;
  const list = naAgentList(NA.targetPath);
  if (list.length) return false;
  if (OP_CATALOG_MISSING) return false;
  return !!(window.perchOnboarding && window.perchOnboarding.needed &&
    window.perchOnboarding.needed());
}

function naMaybeStartAgentSetup(why) {
  if (!naAgentSetupNeeded()) return false;
  const onb = window.perchOnboarding;
  closeNewAgent(why || "没有可用 Agent → 首次设置", true);
  onb.start(why || "");
  return true;
}

/* Catalog pushes arrive while the picker may already be open. Re-evaluate the
   empty list here so a slow first catalog doesn't miss the guide. */
function naCatalogChanged(why) {
  if (!naIsOpen()) return;
  renderNewAgent();
  naMaybeStartAgentSetup(why || "Agent 名单更新");
}

function openNewAgent(opts) {
  opts = opts || {};
  let target;
  if (opts.targetKind && opts.targetKind !== "auto") {
    // old callers may still say scratch/directory; Workspaces no longer has that lane.
    target = opts.targetKind === "project" && opts.targetPath
      ? { kind: "project", path: opts.targetPath, name: opts.targetName || "" }
      : naNoneTarget();
  } else if (opts.projectPath) {
    target = naTargetFromProjectPath(opts.projectPath);
  } else if (opts.cwd) {
    target = naTargetFromCwd(opts.cwd);
  } else {
    target = naDefaultTarget();
  }
  const pick = opts.agent
    ? { agent: opts.agent, stale: "" }
    : naPickAgentForPath(naTargetPathFor(target));
  NA = {
    targetKind: target.kind,
    targetPath: naTargetPathFor(target),
    targetName: target.name || "",
    agent: pick.agent,
    staleAgent: pick.stale,
    agentDirty: false,
    opener: document.activeElement,
    why: opts.why || "",
    popOpen: false,
    query: "",
    active: 0,
    busy: false,
    error: "",
  };
  $("newagent").hidden = false;
  renderNewAgent();
  if (naMaybeStartAgentSetup(opts.why || "打开新建 Agent")) return;
  const row = $("na-agents").querySelector(".na-agent.on") || $("na-agents").querySelector(".na-agent");
  if (row) row.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建 Agent 打开（${NA.why}）` +
    ` target=${NA.targetKind}:${naTargetPathDisplay()} agent=${NA.agent || "(无)"}` });
}

function naTargetPathFor(target) {
  if (!target || target.kind !== "project") return "";
  return target.path || "";
}

function closeNewAgent(why, force) {
  if (!NA) return;
  if (NA.busy && !force) return;
  naCloseProjPop(false);
  const opener = NA.opener;
  $("newagent").hidden = true;
  NA = null;
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  sendCtrl({ type: "log", msg: `新建 Agent 关闭（${why || ""}）` });
}

function naAgentRowsHtml() {
  const list = naAgentList(NA.targetPath);
  const remembered = lastAgentFor(NA.targetPath || naDefaultPath());
  const row = (a) => {
    const on = NA.agent === a.id;
    const def = defaultAgentId();
    const pill = a.id === remembered
      ? `<span class="na-agpill">${esc(t("na.lastUsed"))}</span>`
      : a.id === def ? `<span class="na-agpill">${esc(opDefaultPinned() === a.id
          ? t("pages.pill.default") : t("pages.pill.auto"))}</span>` : "";
    return `<button type="button" class="na-agent${on ? " on" : ""}" data-naagent="${esc(a.id)}" `
      + `role="option" aria-selected="${on ? "true" : "false"}" title="${esc(a.name + " · " + opCapsText(a))}">`
      + `<span class="na-agico">${opAgentIcon(a.icon)}</span>`
      + `<span class="na-agwho"><span class="na-agnm">${esc(a.name)}${pill}</span>`
      + `<span class="na-agsub">${esc(opCapsText(a))}</span></span>`
      + `<span class="na-agck" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" `
      + `fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="M20 6 9 17l-5-5"/></svg></span></button>`;
  };
  let html = list.map(row).join("");
  if (!list.length) {
    html = `<div class="na-agempty">${esc(t("na.noAgents"))}`
      + `<button type="button" data-na-goto-agents>${esc(t("na.goAgents"))}</button></div>`;
  }
  return html;
}

function naTargetNote() {
  const a = opAgentById(NA.agent);
  const name = a ? a.name : "";
  if (NA.staleAgent) {
    return t("na.noteStale", { name: opAgentById(NA.staleAgent)?.name || NA.staleAgent });
  }
  if (!a) return t("na.noteNoAgent");
  if (NA.targetKind !== "project" || !NA.targetPath) {
    return t("na.noteNeedProject", { name });
  }
  return t("na.noteProject", { name, path: NA.targetPath });
}

function naPaintProjectField() {
  const nameEl = $("na-proj-name");
  const pathEl = $("na-proj-path");
  const iconEl = $("na-proj-ico");
  if (!nameEl || !pathEl || !iconEl) return;
  if (NA.targetKind !== "project" || !NA.targetPath) {
    nameEl.textContent = t("na.chooseProject");
    pathEl.textContent = t("na.needProjectHint");
    iconEl.innerHTML = NA_ICON_FOLDER;
  } else {
    nameEl.textContent = NA.targetName || baseName(NA.targetPath);
    pathEl.textContent = NA.targetPath || "";
    iconEl.innerHTML = NA_ICON_FOLDER;
  }
}

function renderNewAgent() {
  if (!NA) return;
  naPaintProjectField();
  const projBtn = $("na-proj");
  if (projBtn) {
    projBtn.title = NA.targetKind === "project" ? (NA.targetPath || "") : t("na.chooseProject");
  }
  $("na-agents").innerHTML = naAgentRowsHtml();
  const note = $("na-note");
  note.textContent = NA.error || naTargetNote();
  note.classList.toggle("err", !!NA.error);
  const path = naTargetPathDisplay();
  $("na-target").innerHTML = NA.targetKind === "project"
    ? `<span class="k">${esc(t("na.targetLabel"))}</span> ${esc(path)}`
    : `<span class="k">${esc(t("na.targetLabel"))}</span> ${esc(t("na.chooseProject"))}`;
  const can = !!NA.agent && NA.targetKind === "project" && !!NA.targetPath;
  const go = $("na-create");
  go.textContent = NA.busy ? t("na.starting") : t("na.create");
  go.classList.toggle("na", !NA.busy && !can);
  go.setAttribute("aria-disabled", can ? "false" : "true");
  go.title = NA.busy ? "" : (!NA.agent ? t("na.pickAgentFirst") : t("na.pickTargetFirst"));
}

function naCloseProjPop(focusField) {
  if (!NA) return;
  NA.popOpen = false;
  NA.active = 0;
  $("na-projpop").hidden = true;
  $("na-proj").setAttribute("aria-expanded", "false");
  if (focusField) {
    const el = $("na-proj");
    if (el) el.focus({ preventScroll: true });
  }
}

function naPlaceProjPop() {
  if (!naPopOpen()) return;
  const anchor = $("na-proj");
  const pop = $("na-projpop");
  if (!anchor || !pop) return;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(320, Math.min(r.width, window.innerWidth - 16));
  pop.style.width = Math.round(w) + "px";
  pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + "px";
  const h = pop.offsetHeight || 320;
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  pop.style.top = Math.round(top) + "px";
}

function naOptions() {
  const q = String(NA.query || "").trim().toLowerCase();
  const out = [];
  // 目标只有真实 Project；默认目录留给 Chat，不再出现在 Workspaces 的新建目标里。
  for (const p of naRealProjects()) {
    const name = projectName(p);
    if (q && !(`${name} ${p.name || ""} ${p.path}`.toLowerCase().includes(q))) continue;
    out.push({ kind: "project", path: p.path, name, detail: p.path, pinned: !!p.pinned });
  }
  return out;
}

function naRenderProjectPop() {
  if (!NA || !NA.popOpen) return;
  NA_OPTS = naOptions();
  if (NA.active >= NA_OPTS.length) NA.active = Math.max(0, NA_OPTS.length - 1);
  const input = $("na-proj-search");
  if (input && document.activeElement !== input) input.value = NA.query;
  let html = "";
  if (!NA_OPTS.length) {
    html = `<div class="na-empty">${esc(t(NA.query ? "na.noMatch" : "na.noProjects"))}</div>`;
  } else {
    let lastKind = "";
    NA_OPTS.forEach((opt, i) => {
      const sep = lastKind && lastKind !== opt.kind &&
        !(lastKind === "directory" && opt.kind === "project");
      if (sep) html += `<div class="na-div"></div>`;
      lastKind = opt.kind;
      const on = opt.kind === NA.targetKind &&
        normPath(opt.path) === normPath(NA.targetPath);
      const icon = NA_ICON_FOLDER;
      html += `<button type="button" class="na-opt${on ? " on" : ""}${i === NA.active ? " active" : ""}" `
        + `data-naopt="${i}" id="na-opt-${i}" role="option" aria-selected="${on ? "true" : "false"}">`
        + `<span class="ico">${icon}</span>`
        + `<span class="who"><span class="nm">${esc(opt.name)}${opt.pinned ? " · " + esc(t("shell.pinned")) : ""}</span>`
        + `<span class="pa">${esc(opt.detail || "")}</span></span>`
        + `<span class="ck" aria-hidden="true">${on ? "✓" : ""}</span></button>`;
    });
  }
  $("na-proj-list").innerHTML = html;
  if (input && NA_OPTS.length) {
    input.setAttribute("aria-activedescendant", `na-opt-${NA.active}`);
  } else if (input) {
    input.removeAttribute("aria-activedescendant");
  }
  naPlaceProjPop();
}

function naSetActive(i) {
  if (!NA || !NA.popOpen || !NA_OPTS.length) return;
  NA.active = (i + NA_OPTS.length) % NA_OPTS.length;
  document.querySelectorAll("#na-proj-list .na-opt").forEach((el, n) => {
    el.classList.toggle("active", n === NA.active);
  });
  const el = document.getElementById(`na-opt-${NA.active}`);
  if (el) el.scrollIntoView({ block: "nearest" });
  const input = $("na-proj-search");
  if (input) input.setAttribute("aria-activedescendant", `na-opt-${NA.active}`);
}

function naOpenProjPop() {
  if (!NA || NA.busy || apIsOpen()) return;
  NA.popOpen = true;
  NA.query = "";
  NA.active = 0;
  $("na-projpop").hidden = false;
  $("na-proj").setAttribute("aria-expanded", "true");
  naRenderProjectPop();
  const selectedIdx = NA_OPTS.findIndex((opt) => opt.kind === NA.targetKind &&
    normPath(opt.path) === normPath(NA.targetPath));
  if (selectedIdx >= 0) naSetActive(selectedIdx);
  const input = $("na-proj-search");
  if (input) {
    input.value = "";
    input.focus({ preventScroll: true });
  }
}

function naSelectTarget(opt, manual) {
  if (!NA || !opt) return;
  NA.targetKind = opt.kind;
  NA.targetPath = opt.path || "";
  NA.targetName = opt.name || "";
  NA.error = "";
  if (manual) {
    const pick = naPickAgentForPath(NA.targetPath);
    NA.agent = pick.agent;
    NA.staleAgent = pick.stale;
    NA.agentDirty = false;
  }
  naCloseProjPop(false);
  renderNewAgent();
  if (naMaybeStartAgentSetup("选择项目后没有可用 Agent")) return;
  const row = $("na-agents").querySelector(".na-agent.on") || $("na-agents").querySelector(".na-agent");
  if (row) row.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建 Agent 目标=${NA.targetKind}:${naTargetPathDisplay()} agent=${NA.agent || "(无)"}` });
}

function naAddProject() {
  if (!NA || NA.busy) return;
  naCloseProjPop(false);
  const directAdd = NA.targetKind === "directory" &&
    !naRealProjectByPath(NA.targetPath) &&
    normPath(NA.targetPath) !== normPath(naDefaultPath());
  const parent = NA.targetKind === "project"
    ? (parentPath(NA.targetPath) || naDefaultPath())
    : naDefaultPath();
  openAddProject({
    origin: "newagent",
    step: directAdd ? "existing" : "start",
    path: directAdd ? NA.targetPath : "",
    name: directAdd ? baseName(NA.targetPath) : "",
    parent,
    opener: $("na-addproj"),
    why: "新建 Agent → 添加项目",
  });
}

/* 由添加项目成功路径调用：项目已写进 STATE，这里只负责换选中目标，不关 Agent 卡。 */
function naProjectAdded(pr) {
  if (!NA || !pr || !pr.path) return;
  NA.targetKind = "project";
  NA.targetPath = pr.path;
  NA.targetName = pr.name || baseName(pr.path);
  NA.error = "";
  if (!NA.agent) {
    const pick = naPickAgentForPath(NA.targetPath);
    NA.agent = pick.agent;
    NA.staleAgent = pick.stale;
  } else {
    NA.staleAgent = "";
  }
  renderNewAgent();
  if (naMaybeStartAgentSetup("添加项目后没有可用 Agent")) return;
  const row = $("na-agents").querySelector(".na-agent.on") || $("na-agents").querySelector(".na-agent");
  if (row) row.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建 Agent 已选中新项目 path=${pr.path} agent=${NA.agent || "(无)"}` });
}

function naProjectRemoved(path) {
  if (!NA || NA.targetKind !== "project" || normPath(NA.targetPath) !== normPath(path)) return;
  NA.targetKind = "none";
  NA.targetPath = "";
  NA.targetName = "";
  NA.error = t("na.projectGone");
  const pick = naPickAgentForPath(naDefaultPath());
  NA.agent = pick.agent;
  NA.staleAgent = pick.stale;
  renderNewAgent();
}

function naCreate() {
  if (!NA || NA.busy) return;
  if (!NA.agent) {
    NA.error = t("na.pickAgentFirst");
    renderNewAgent();
    showToast(t("na.toast.stepTitle"), t("na.toast.pickAgent"), "err");
    return;
  }
  const spawnPath = NA.targetPath;
  if (NA.targetKind !== "project" || !spawnPath) {
    NA.error = t("na.pickTargetFirst");
    renderNewAgent();
    showToast(t("na.toast.stepTitle"), t("na.pickTargetFirst"), "err");
    return;
  }
  NA.busy = true;
  NA.error = "";
  renderNewAgent();
  rememberLastAgent(NA.targetPath || naDefaultPath(), NA.agent);
  sendCtrl({ type: "log", msg: `新建 Agent 提交 target=${NA.targetKind}:${spawnPath || "(默认)"} ` +
    `agent=${NA.agent}` });
  Promise.resolve()
    .then(() => newTabIn(spawnPath, "新建 Agent 卡片", NA.agent, "project", { quiet: true }))
    .then((res) => {
      if (res && res.ok) {
        closeNewAgent("创建", true);
        return;
      }
      if (!NA) return;
      NA.busy = false;
      const ref = res && res.refusal;
      NA.error = ref
        ? (tMsg(ref.msgCode, ref.msgParams, ref.msg) || t("na.createFailed"))
        : t("na.createFailed");
      renderNewAgent();
      sendCtrl({ type: "log", msg: `新建 Agent 失败：${NA.error}` });
    })
    .catch((e) => {
      if (!NA) return;
      NA.busy = false;
      NA.error = t("na.createFailed");
      renderNewAgent();
      jserr("newAgent.create", e);
    });
}

$("na-x").addEventListener("click", () => closeNewAgent("点 ×"));
$("na-cancel").addEventListener("click", () => closeNewAgent("取消"));
$("na-create").addEventListener("click", naCreate);
$("na-proj").addEventListener("click", () => {
  if (NA && NA.popOpen) naCloseProjPop(true);
  else naOpenProjPop();
});
$("na-proj").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
    e.preventDefault(); naOpenProjPop();
  } else if (e.key === "Escape" && NA && NA.popOpen) {
    e.preventDefault(); naCloseProjPop(true);
  }
});
$("na-addproj").addEventListener("click", naAddProject);
$("na-proj-add").addEventListener("click", naAddProject);
$("na-proj-add").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); naAddProject(); }
});
$("na-proj-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-naopt]");
  if (!b) return;
  naSelectTarget(NA_OPTS[+b.dataset.naopt], true);
});
$("na-proj-search").addEventListener("input", () => {
  if (!NA) return;
  NA.query = $("na-proj-search").value || "";
  NA.active = 0;
  naRenderProjectPop();
});
$("na-proj-search").addEventListener("keydown", (e) => {
  if (!NA || !NA.popOpen) return;
  if (isImeOwnedKey(e)) return;
  if (e.key === "ArrowDown") { e.preventDefault(); naSetActive(NA.active + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); naSetActive(NA.active - 1); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const opt = NA_OPTS[NA.active];
    if (opt) naSelectTarget(opt, true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    naCloseProjPop(true);
  }
});
$("na-agents").addEventListener("click", (e) => {
  if (e.target.closest("[data-na-goto-agents]")) {
    closeNewAgent("去安装 Agent");
    setNavView("dash");
    return;
  }
  const b = e.target.closest("[data-naagent]");
  if (!b || !NA || NA.busy) return;
  NA.agent = b.dataset.naagent || "";
  NA.agentDirty = true;
  NA.staleAgent = "";
  NA.error = "";
  renderNewAgent();
  const row = $("na-agents").querySelector(`[data-naagent="${NA.agent}"]`);
  if (row) row.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建 Agent 选 Agent=${NA.agent || "(无)"}` });
});
$("na-agents").addEventListener("keydown", (e) => {
  if (NA && NA.busy) return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...$("na-agents").querySelectorAll(".na-agent")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement);
  const d = e.key === "ArrowDown" ? 1 : -1;
  e.preventDefault();
  rows[(at + d + rows.length) % rows.length].focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !naIsOpen()) return;
  if (typeof AP !== "undefined" && AP) return;
  if ($("fview") && !$("fview").hidden) return;
  if (NA.popOpen) {
    e.preventDefault();
    e.stopImmediatePropagation();
    naCloseProjPop(true);
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  closeNewAgent("Esc");
}, true);

document.addEventListener("click", (e) => {
  if (typeof AP !== "undefined" && AP) return;
  if (!naIsOpen()) return;
  if (NA.popOpen) {
    if (e.target.closest("#na-projpop") || e.target.closest("#na-proj")) return;
    naCloseProjPop(false);
    return;
  }
  if (e.target.closest(".na-card")) return;
  closeNewAgent("点了外面");
}, true);

window.addEventListener("resize", () => { if (naPopOpen()) naPlaceProjPop(); });
window.addEventListener("scroll", () => { if (naPopOpen()) naPlaceProjPop(); }, true);
