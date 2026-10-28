/* ===========================================================================
   添加项目（只处理文件夹）
   ---------------------------------------------------------------------------
   两次提交，各有明确回执：
     ① project.pick   只返回系统选择器选中的路径，不写项目池
     ② project.add    用户确认名称后才写池子；project.create 建一个空目录再写
   写操作先回 project.result（左栏立即更新），全量 pool 统计随后刷新。
   这张卡不会启动 Agent —— 那是 #newagent 的事。
   =========================================================================== */

let AP = null; // { step, origin, opener, existingPath, existingName, nameDirty,
                //   parent, folderName, busy, req, pickFor, error, existsPath, createdPath }
let PROJECT_REQ = 0;
let DROP_BATCH = null; // 多目录拖放：收集每一条 project.result，最后汇总一张提示卡

function apIsOpen() { return !!(AP && $("add-project") && !$("add-project").hidden); }

function baseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function parentPath(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  if (i <= 0) return "";
  const parent = s.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

function apContextPath() {
  const tab = (typeof activeTab !== "undefined" && activeTab && activeTab.id > 0)
    ? activeTab : wsTabs().find((x) => x.id > 0);
  return tab ? effCwd(tab) : (defaultAreaPath() || defaultWorkspacePath());
}

function apDefaultParent() {
  const cwd = apContextPath();
  const proj = (STATE?.projects || []).find((p) =>
    !p.synthetic && p.path && normPath(p.path) === normPath(cwd));
  // 有当前项目时默认建在它的同级；没有项目时直接落在默认工作区里，
  // 而不是退到 Documents 这种更宽的范围。
  if (proj) return parentPath(proj.path) || defaultAreaPath() || defaultWorkspacePath();
  return defaultAreaPath() || defaultWorkspacePath() || parentPath(cwd);
}

function apNameError(name) {
  const n = String(name || "").trim();
  if (!n) return t("ap.nameRequired");
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) return t("ap.nameInvalid");
  if (/[. ]$/.test(n)) return t("ap.nameInvalidEnd");
  return "";
}

function apCanSubmit() {
  if (!AP || AP.busy) return false;
  if (AP.step === "existing") return !!AP.existingPath;
  if (AP.step === "create") return !!AP.parent && !apNameError(AP.folderName);
  return false;
}

function apErrorText(m) {
  return tMsg(m.errCode, m.errParams, m.err) || t("ap.failed");
}

function openAddProject(opts) {
  opts = opts || {};
  const existing = opts.step === "existing" && opts.path;
  AP = {
    step: opts.step === "create" ? "create" : (existing ? "existing" : "start"),
    origin: opts.origin || "standalone",
    opener: opts.opener || document.activeElement,
    existingPath: existing ? opts.path : "",
    existingName: existing ? (opts.name || baseName(opts.path)) : "",
    nameDirty: !!existing && !!opts.name,
    parent: opts.parent || apDefaultParent(),
    folderName: "",
    busy: false,
    req: 0,
    pickFor: "",
    error: "",
    existsPath: "",
    createdPath: "",
  };
  $("add-project").hidden = false;
  renderAddProject();
  if (AP.step === "existing") {
    const el = $("ap-existing-name");
    if (el) el.focus({ preventScroll: true });
  } else if (AP.step === "create") {
    const el = $("ap-folder-name");
    if (el) el.focus({ preventScroll: true });
  } else {
    const el = $("ap-browse");
    if (el) el.focus({ preventScroll: true });
  }
  sendCtrl({ type: "log", msg: `添加项目 打开（${opts.why || ""}）` +
    ` step=${AP.step} origin=${AP.origin} ${AP.existingPath || AP.parent || ""}` });
  if (opts.pick) apPick("existing");
}

function closeAddProject(why) {
  if (!AP) return;
  if (AP.busy) return; // 正在等选择器/写盘：关掉会让结果无处可去
  const opener = AP.opener;
  $("add-project").hidden = true;
  AP = null;
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  sendCtrl({ type: "log", msg: `添加项目 关闭（${why || ""}）` });
}

function renderAddProject() {
  if (!AP) return;
  const title = AP.step === "create" ? t("ap.createTitle") : t("ap.title");
  $("ap-title").textContent = title;
  $("ap-start").hidden = AP.step !== "start";
  $("ap-existing").hidden = AP.step !== "existing";
  $("ap-create-step").hidden = AP.step !== "create";
  $("ap-back").hidden = AP.step === "start";
  $("ap-submit").hidden = AP.step === "start";
  $("ap-submit").textContent = AP.busy
    ? (AP.step === "create" ? t("ap.creating") : t("ap.adding"))
    : (AP.step === "create" ? t("ap.createAndAdd") : t("ap.add"));
  $("ap-err").textContent = AP.error || "";
  $("ap-use-existing").hidden = !AP.existsPath;

  const nameInput = $("ap-existing-name");
  if (nameInput && document.activeElement !== nameInput) nameInput.value = AP.existingName;
  const folderInput = $("ap-folder-name");
  if (folderInput && document.activeElement !== folderInput) folderInput.value = AP.folderName;
  $("ap-existing-path").textContent = AP.existingPath || t("ap.noFolder");
  $("ap-parent").textContent = AP.parent || t("ap.noLocation");
  $("ap-parent").title = AP.parent || "";
  $("ap-existing-path").title = AP.existingPath || "";
  apUpdatePreview();

  const na = !AP.busy && !apCanSubmit();
  $("ap-submit").classList.toggle("na", na);
  $("ap-submit").setAttribute("aria-disabled", na ? "true" : "false");
  $("ap-submit").title = na
    ? (AP.step === "existing" ? t("ap.needFolder") : t("ap.needName"))
    : "";
  $("ap-browse").disabled = AP.busy;
  $("ap-create").disabled = AP.busy;
  $("ap-existing-change").disabled = AP.busy;
  $("ap-parent-change").disabled = AP.busy;
  $("ap-back").disabled = AP.busy;
  $("ap-cancel").disabled = AP.busy;
  $("ap-x").disabled = AP.busy;
  if (AP.busy) {
    $("ap-browse").setAttribute("aria-busy", "true");
    $("ap-create").setAttribute("aria-busy", "true");
  } else {
    $("ap-browse").removeAttribute("aria-busy");
    $("ap-create").removeAttribute("aria-busy");
  }
}

function apUpdatePreview() {
  if (!AP) return;
  const el = $("ap-preview");
  if (!el) return;
  if (AP.step !== "create") { el.textContent = ""; return; }
  const name = String(AP.folderName || "").trim();
  el.textContent = AP.parent && name
    ? t("ap.preview", { path: AP.parent.replace(/[\\/]+$/, "") + "\\" + name })
    : t("ap.previewEmpty");
}

function apPick(purpose) {
  if (!AP || AP.busy) return;
  AP.busy = true;
  AP.pickFor = purpose;
  AP.req = ++PROJECT_REQ;
  AP.error = "";
  AP.existsPath = "";
  renderAddProject();
  sendCtrl({
    type: "project.pick",
    req: AP.req,
    msg: purpose === "parent" ? t("ap.pickParentTitle") : t("ap.pickTitle"),
  });
  sendCtrl({ type: "log", msg: `添加项目 开系统选择器（${purpose}）req=${AP.req}` });
}

function apBackToStart() {
  if (!AP || AP.busy) return;
  AP.step = "start";
  AP.error = "";
  AP.existsPath = "";
  AP.createdPath = "";
  renderAddProject();
  const el = $("ap-browse");
  if (el) el.focus({ preventScroll: true });
}

function apSubmit() {
  if (!AP || AP.busy) return;
  if (!apCanSubmit()) {
    AP.error = AP.step === "existing" ? t("ap.needFolder") : apNameError(AP.folderName);
    renderAddProject();
    return;
  }
  AP.busy = true;
  AP.error = "";
  AP.req = ++PROJECT_REQ;
  if (AP.step === "existing") {
    sendCtrl({
      type: "project.add",
      req: AP.req,
      path: AP.existingPath,
      name: String(AP.existingName || "").trim(),
    });
    sendCtrl({ type: "log", msg: `添加项目 提交 req=${AP.req} path=${AP.existingPath}` });
  } else {
    sendCtrl({
      type: "project.create",
      req: AP.req,
      path: AP.parent,
      name: String(AP.folderName || "").trim(),
    });
    sendCtrl({ type: "log", msg: `添加项目 新建提交 req=${AP.req} parent=${AP.parent} name=${AP.folderName}` });
  }
  renderAddProject();
}

/* 后端即时回执：选择器是独立一条；项目写操作是 project.result。 */
function projectPickedArrived(m) {
  if (!AP || !m || AP.req === 0 || m.req !== AP.req) return false;
  AP.busy = false;
  AP.req = 0;
  if (m.canceled) {
    renderAddProject();
    const el = AP.pickFor === "parent" ? $("ap-parent-change") : $("ap-browse");
    if (el) el.focus({ preventScroll: true });
    sendCtrl({ type: "log", msg: "添加项目 选择器取消" });
    return true;
  }
  if (m.err) {
    AP.error = apErrorText(m);
    renderAddProject();
    sendCtrl({ type: "log", msg: `添加项目 选择器失败：${m.err}` });
    return true;
  }
  if (AP.pickFor === "parent") {
    AP.parent = m.path || "";
    AP.step = "create";
  } else {
    AP.existingPath = m.path || "";
    if (!AP.nameDirty || !AP.existingName) AP.existingName = baseName(m.path);
    AP.step = "existing";
  }
  AP.pickFor = "";
  AP.error = "";
  AP.existsPath = "";
  renderAddProject();
  const el = AP.step === "create" ? $("ap-folder-name") : $("ap-existing-name");
  if (el) el.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `添加项目 选择器结果 step=${AP.step} path=${m.path || ""}` });
  return true;
}

function applyProjectResultState(m) {
  if (!m || !m.op) return;
  if (m.ok !== false && typeof m.rev === "number") {
    STATE.poolRev = Math.max(STATE.poolRev || 0, m.rev);
  }
  const arr = (STATE.projects || []).slice();
  const k = normPath(m.path || (m.project && m.project.path) || "");
  const idx = k ? arr.findIndex((p) => p && normPath(p.path) === k) : -1;
  const ok = m.ok !== false;
  if (m.op === "remove") {
    if (ok) STATE.projects = arr.filter((p) => !(p && normPath(p.path) === k));
  } else if (m.op === "pin") {
    if (ok && idx >= 0) {
      arr[idx] = Object.assign({}, arr[idx], { pinned: m.pinned === true });
      if (m.name) arr[idx].name = m.name;
    }
    if (ok) STATE.projects = arr;
  } else if (m.op === "rename") {
    if (ok && idx >= 0) {
      arr[idx] = Object.assign({}, arr[idx], { name: m.name || arr[idx].name });
    }
    if (ok) STATE.projects = arr;
  } else if (ok && m.project) {
    const pr = m.project;
    if (idx >= 0) {
      arr[idx] = Object.assign({}, arr[idx], pr, {
        // 轻量回执不带统计；别用 0 覆盖已经算出来的数。
        count: (arr[idx].count == null ? pr.count : arr[idx].count),
        recent: (arr[idx].recent == null ? pr.recent : arr[idx].recent),
      });
      STATE.projects = arr;
    } else {
      STATE.projects = arr.concat([pr]);
    }
    // 用户把默认工作区路径也加成了真项目：合成的最后一行让位给真记录。
    if (pr && pr.path && !pr.synthetic) {
      STATE.projects = (STATE.projects || []).filter((p) =>
        !(p && p.synthetic && normPath(p.path) === k));
    }
  }
  renderLists(searchKey());
  if (typeof NAV_HERE !== "undefined" && NAV_HERE === "dash" &&
      typeof renderDashStatus === "function") renderDashStatus();
  if (typeof NA !== "undefined" && NA && m.op === "remove" &&
      NA.targetKind === "project" && normPath(NA.targetPath) === k &&
      typeof naProjectRemoved === "function") {
    naProjectRemoved(m.path);
  }
}

/* 原生拖放：Go 只转交路径，这里仍走同一条 project.add。一个目录一条请求，
   用令牌收集结果；行由 project.result 立即出现，最后只汇总一张提示卡。 */
function onProjectFilesDropped(ev) {
  if (apIsOpen() || (typeof naIsOpen === "function" && naIsOpen())) return;
  if (DROP_BATCH) return; // 上一批还没收完：不叠第二张汇总卡
  const raw = ev && ev.data && ev.data.files;
  const paths = (Array.isArray(raw) ? raw : [])
    .filter((p) => typeof p === "string" && p.trim());
  if (!paths.length) return;
  DROP_BATCH = {
    total: paths.length, done: 0, added: 0, exists: 0, failed: 0,
    lastAdded: "", reqs: new Set(),
  };
  for (const path of paths) {
    const req = ++PROJECT_REQ;
    DROP_BATCH.reqs.add(req);
    sendCtrl({ type: "project.add", req, path, source: "manual" });
  }
  sendCtrl({ type: "log", msg: `项目区拖放 ${paths.length} 项 → project.add` });
}

function finishDropBatch(b) {
  if (b.added && b.lastAdded) apRevealProject(b.lastAdded);
  if (b.failed === 0 && b.exists === 0) {
    showToast(t("ap.toast.addedTitle"),
      b.added === 1 ? b.lastAdded : t("ap.toast.dropAdded", { n: b.added }), "ok", true);
  } else if (b.added === 0 && b.failed === 0) {
    showToast(t("ap.toast.existsTitle"), t("ap.toast.dropExists", { n: b.exists }), "info");
  } else {
    showToast(t("ap.toast.dropMixedTitle"), t("ap.toast.dropMixed", {
      added: b.added, exists: b.exists, failed: b.failed,
    }), b.failed ? "err" : "info");
  }
}

function bindProjectDrop() {
  const events = window.wails && window.wails.Events;
  if (!events || typeof events.On !== "function") {
    sendCtrl({ type: "log", msg: "拖放未接线：window.wails.Events 不可用" });
    return;
  }
  events.On("perch:files-dropped", onProjectFilesDropped);
  sendCtrl({ type: "log", msg: "拖放已接线：左栏项目区" });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindProjectDrop, { once: true });
} else {
  bindProjectDrop();
}

function projectResultArrived(m) {
  if (!m) return false;
  applyProjectResultState(m);
  // 拖放批次先吃掉自己的应答：不要每一条都弹 toast，也不要把 req 和
  // 添加项目对话框的令牌混在一起。
  if (DROP_BATCH && m.req && DROP_BATCH.reqs.has(m.req)) {
    DROP_BATCH.done++;
    if (m.ok === false) DROP_BATCH.failed++;
    else if (m.added === false) DROP_BATCH.exists++;
    else {
      DROP_BATCH.added++;
      DROP_BATCH.lastAdded = m.path || (m.project && m.project.path) || DROP_BATCH.lastAdded;
    }
    if (DROP_BATCH.done >= DROP_BATCH.total) {
      const batch = DROP_BATCH;
      DROP_BATCH = null;
      finishDropBatch(batch);
    }
    return false;
  }
  if (!AP || !m.req || m.req !== AP.req) {
    if (m.err) {
      showToast(t("shell.pool.errorTitle"), tMsg(m.errCode, m.errParams, m.err), "err");
    }
    return false;
  }
  AP.busy = false;
  AP.req = 0;
  if (m.err) {
    if (m.created === true && m.path) {
      AP.createdPath = m.path;
      AP.existsPath = m.path;
      AP.error = t("ap.createdNotAdded", { path: m.path, err: apErrorText(m) });
    } else {
      AP.error = apErrorText(m);
      if (m.errCode === "project.createExists" && m.path) {
        AP.existsPath = m.path;
        AP.createdPath = m.path;
      }
    }
    renderAddProject();
    sendCtrl({ type: "log", msg: `添加项目 失败 op=${m.op} code=${m.errCode || ""} err=${m.err || ""}` });
    return true;
  }
  const pr = m.project || {};
  const path = pr.path || m.path || "";
  const added = m.added !== false;
  const origin = AP.origin;
  const opener = AP.opener;
  AP.busy = false;
  AP.req = 0;
  $("add-project").hidden = true;
  AP = null;
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  if (origin === "newagent" && typeof naProjectAdded === "function") {
    naProjectAdded(pr, m);
  } else if (path) {
    apRevealProject(path);
  }
  showToast(
    added ? t("ap.toast.addedTitle") : t("ap.toast.existsTitle"),
    added ? path : t("ap.toast.existsNote", { path }),
    added ? "ok" : "info", true);
  sendCtrl({ type: "log", msg: `添加项目 成功 op=${m.op} added=${added} path=${path}` });
  return true;
}

function apRevealProject(path) {
  const q = $("q");
  if (q && q.value) { q.value = ""; renderLists(""); }
  const row = [...document.querySelectorAll("#proj-list .proj")]
    .find((el) => normPath(el.dataset.path) === normPath(path));
  if (!row) return;
  try { row.scrollIntoView({ block: "nearest" }); } catch (e) {}
  row.classList.add("fresh");
  setTimeout(() => row.classList.remove("fresh"), 1700);
}

function apUseExisting() {
  if (!AP || !AP.existsPath || AP.busy) return;
  AP.existingPath = AP.existsPath;
  AP.existingName = baseName(AP.existingPath);
  AP.nameDirty = false;
  AP.step = "existing";
  AP.error = "";
  AP.existsPath = "";
  renderAddProject();
  const el = $("ap-existing-name");
  if (el) el.focus({ preventScroll: true });
}

function projectDialogsRepaint() {
  if (AP) renderAddProject();
  if (typeof NA !== "undefined" && NA && typeof renderNewAgent === "function") {
    renderNewAgent();
    if (typeof naPopOpen === "function" && naPopOpen()) naRenderProjectPop();
  }
}

$("ap-x").addEventListener("click", () => closeAddProject("点 ×"));
$("ap-cancel").addEventListener("click", () => closeAddProject("取消"));
$("ap-back").addEventListener("click", apBackToStart);
$("ap-browse").addEventListener("click", () => apPick("existing"));
$("ap-create").addEventListener("click", () => {
  if (!AP || AP.busy) return;
  AP.step = "create";
  AP.error = "";
  AP.existsPath = "";
  renderAddProject();
  const el = $("ap-folder-name");
  if (el) el.focus({ preventScroll: true });
});
$("ap-existing-change").addEventListener("click", () => apPick("existing"));
$("ap-parent-change").addEventListener("click", () => apPick("parent"));
$("ap-submit").addEventListener("click", apSubmit);
$("ap-use-existing").addEventListener("click", apUseExisting);

$("ap-existing-name").addEventListener("input", () => {
  if (!AP) return;
  AP.existingName = $("ap-existing-name").value;
  AP.nameDirty = true;
  AP.error = "";
  const err = $("ap-err");
  if (err) err.textContent = "";
});
$("ap-folder-name").addEventListener("input", () => {
  if (!AP) return;
  AP.folderName = $("ap-folder-name").value;
  AP.error = "";
  const err = $("ap-err");
  if (err) err.textContent = "";
  apUpdatePreview();
  const na = !AP.busy && !apCanSubmit();
  $("ap-submit").classList.toggle("na", na);
  $("ap-submit").setAttribute("aria-disabled", na ? "true" : "false");
});

for (const id of ["ap-existing-name", "ap-folder-name"]) {
  $(id).addEventListener("keydown", (e) => {
    if (isImeOwnedKey(e)) return;
    if (e.key === "Enter") { e.preventDefault(); apSubmit(); }
    else if (e.key === "Escape") { e.preventDefault(); closeAddProject("Esc"); }
  });
}

$("ap-actions").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = [...$("ap-actions").querySelectorAll(".ap-action")];
  if (!list.length) return;
  const at = list.indexOf(document.activeElement);
  const d = e.key === "ArrowDown" ? 1 : -1;
  e.preventDefault();
  list[(at + d + list.length) % list.length].focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !apIsOpen()) return;
  if ($("fview") && !$("fview").hidden) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  closeAddProject("Esc");
}, true);

document.addEventListener("click", (e) => {
  if (!apIsOpen()) return;
  if (e.target.closest(".ap-card")) return;
  if (AP.busy) return;
  closeAddProject("点了外面");
  // 点的是嵌套 Add Project 的遮罩：只关这一层，别让后面的 New Agent
  // 监听器把宿主对话框也一起关掉。
  e.stopImmediatePropagation();
}, true);
