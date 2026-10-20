/* ===========================================================================
   新建工作区（文件夹 + Agent，一张卡片选完）
   ---------------------------------------------------------------------------
   用户 2026-10-19 点名的形态：Orca 在"新建工作区"时能顺手选一个已安装的
   Agent，我们也要。但我们的工作区不是 Orca 的 worktree（不建分支），
   它就是项目池里的一个目录 —— 所以卡片只有两个字段：

     文件夹  已有工作区下拉（跟随项目池） + 「选择其他文件夹…」开系统选择器
     Agent   已安装且能启动的名单，默认预选；也可以选「不启动 Agent」

   ⚠️ 新增文件夹走的是**同一条** `project.add`（系统选择器没有应答帧），
   成功与否靠项目池的全量推送来判断 —— 和总览「新建工作区」原来是同一招。
   差别只有一处：卡片开着时，新路径落到卡片里，**不要**把用户跳去工作区
   （applyPool 先问 newSpacePoolUpdate）。
   =========================================================================== */

let NS = null; // { folder, agent, pickPending, pickAt, base, addedPaths, opener, why }

function nsProjects() { return STATE?.projects || []; }

function nsAgentList(folder) {
  const def = defaultAgentId();
  const remembered = lastAgentFor(folder == null ? (NS && NS.folder) : folder);
  // 排序：这个文件夹上次用的 → 全局默认 → 其余（有状态能力的在前）。
  // 记住项排第一不是为了"替用户选"，而是让它离手指最近 —— 卡片仍然要
  // 用户点「创建」，这里只影响默认焦点落在谁身上。
  const rank = (a) => (a.id === remembered ? 0 : a.id === def ? 1 : 2);
  return opCatalog().filter(opLaunchable).slice().sort((a, b) => {
    const ar = rank(a), br = rank(b);
    if (ar !== br) return ar - br;
    const as = a.caps && a.caps.status ? 0 : 1;
    const bs = b.caps && b.caps.status ? 0 : 1;
    return as - bs;
  });
}
/* 这个文件夹的预选：记忆优先，其次全局默认/自动。stale = 记忆里有、但
   现在不在"可启动"名单里 —— 卡片要把这句话写出来（不静默换人）。 */
function nsPickAgentForFolder(folder) {
  const list = nsAgentList(folder);
  const remembered = lastAgentFor(folder);
  const canRemember = !!remembered && list.some((a) => a.id === remembered);
  const def = defaultAgentId();
  const canDefault = list.some((a) => a.id === def);
  return {
    agent: canRemember ? remembered : (canDefault ? def : ""),
    stale: remembered && !canRemember ? remembered : "",
  };
}

function nsCanCreate() {
  if (!NS || !NS.folder) return false;
  if (NS.agent) return true;
  // 不启动 Agent 时，"创建"只在**这次真的加了一个新文件夹**时有意义；
  // 选一个已经在池子里的目录再点"只添加文件夹"是个空操作。
  return NS.addedPaths.has(NS.folder);
}

function nsAgentRowsHtml() {
  const list = nsAgentList(NS.folder);
  const remembered = lastAgentFor(NS.folder);
  const row = (id, name, sub, icon, on, extra) =>
    `<button type="button" class="ns-agent${on ? " on" : ""}" data-nsagent="${esc(id)}" `
    + `role="option" aria-selected="${on ? "true" : "false"}" title="${esc(name + " · " + sub)}">`
    + `<span class="ns-agico">${icon}</span>`
    + `<span class="ns-agwho"><span class="ns-agnm">${esc(name)}${extra || ""}</span>`
    + `<span class="ns-agsub">${esc(sub)}</span></span>`
    + `<span class="ns-agck" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 24 24" `
    + `fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" `
    + `stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span></button>`;
  let html = row("", t("ns.noAgent"), t("ns.noAgentNote"),
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
    NS.agent === "", "");
  const def = defaultAgentId();
  const pinned = opDefaultPinned();
  for (const a of list) {
    const isDef = a.id === def;
    const isRemembered = a.id === remembered;
    // 两个标签不同时出：记住项优先显示"上次用的"，其余才显示"默认/自动"。
    const pill = isRemembered
      ? `<span class="ns-agpill ns-agpill-last">${esc(t("ns.lastUsed"))}</span>`
      : isDef ? `<span class="ns-agpill">${esc(pinned === a.id
          ? t("pages.pill.default") : t("pages.pill.auto"))}</span>` : "";
    html += row(a.id, a.name, opCapsText(a), opAgentIcon(a.icon), NS.agent === a.id, pill);
  }
  if (!list.length) {
    html += `<div class="ns-agempty">${esc(t("ns.emptyAgents"))}</div>`;
  }
  return html;
}

function renderNewSpace() {
  if (!NS) return;
  const projs = nsProjects();
  // 默认落点跟着当前格；没有当前格就默认工作区。
  if (!NS.folder) {
    NS.folder = currentWorkspacePath()
      || (projs.find((p) => p.synthetic) || projs[0] || {}).path || "";
  }
  const sel = $("ns-folder");
  sel.innerHTML = projs.map((p) =>
    `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
  if (NS.folder && !projs.some((p) => p.path === NS.folder)) {
    // 刚加进来的路径还没出现在这次渲染的池子里（下一条池子推送会补上）——
    // 先把它作为一条临时选项摆着，别让用户看到下拉跳回别的目录。
    sel.insertAdjacentHTML("beforeend",
      `<option value="${esc(NS.folder)}">${esc(shortPath(NS.folder))}</option>`);
  }
  sel.value = NS.folder;
  sel.disabled = !!NS.pickPending;
  // 系统选择器没有"取消"应答帧（见 20-ctl / main.go 的 project.add）：用户按了
  // 取消，前端收不到任何消息。所以等待期间这颗键必须变成"取消等待"，
  // 否则卡片会一直灰着创建键，用户只剩关掉卡片这一条路。
  const pick = $("ns-pick");
  if (pick) pick.textContent = NS.pickPending ? t("ns.pickPending") : t("ns.pick");
  const path = $("ns-path");
  path.textContent = NS.folder || t("ns.noWorkspace");
  path.title = NS.folder || "";
  $("ns-agents").innerHTML = nsAgentRowsHtml();

  const note = $("ns-note");
  if (NS.pickPending) {
    note.textContent = t("ns.notePicking");
  } else if (!NS.folder) {
    note.textContent = t("ns.notePickFirst");
  } else if (NS.staleAgent) {
    // 记忆里有、但现在起不来：把原因摆在预选旁边，**不静默换成别的 Agent**。
    // 用户仍然可以点一个可启动的，或者关掉卡片去装回来。
    note.textContent = t("ns.noteStale", {
      name: opAgentById(NS.staleAgent)?.name || NS.staleAgent,
    });
  } else if (!NS.agent && !nsCanCreate()) {
    note.textContent = t("ns.noteExisting");
  } else if (!NS.agent) {
    note.textContent = t("ns.noteFolderOnly");
  } else {
    note.textContent = t("ns.noteCreate", {
      path: shortPath(NS.folder),
      name: opAgentById(NS.agent)?.name || NS.agent,
    });
  }
  const go = $("ns-create");
  const na = !nsCanCreate();
  go.classList.toggle("na", na);
  go.setAttribute("aria-disabled", na ? "true" : "false");
  go.title = na
    ? (!NS.folder ? t("ns.createNaPickFolder") : t("ns.createNaPickAgent"))
    : "";
  sendCtrl({ type: "log", msg: `新建工作区卡片 渲染 folder=${NS.folder || "?"} ` +
    `agent=${NS.agent || "(只加文件夹)"} 可创建=${!na} 池子=${projs.length}` });
}

function openNewSpace(opts) {
  opts = opts || {};
  const box = $("newspace");
  if (!box) return;
  // 预选：这个文件夹上次明确选的 → 全局默认/自动。没有可启动的 Agent 时
  // 落在「不启动 Agent」而不是一个查不到的名字上（defaultAgentId 的兜底是
  // "claude"，那是老载荷的后路，不是这里的默认）。
  const folder = opts.folder || "";
  const pick = nsPickAgentForFolder(folder);
  NS = {
    folder,
    agent: pick.agent,
    staleAgent: pick.stale,
    pickPending: false,
    pickAt: 0,
    base: new Set(nsProjects().map((p) => p.path)),
    addedPaths: new Set(),
    opener: document.activeElement,
    why: opts.why || "",
  };
  box.hidden = false;
  renderNewSpace();
  // 焦点落在 Agent 的预选行上：这是这张卡里最常改的一栏。
  const selRow = box.querySelector(".ns-agent.on") || box.querySelector(".ns-agent");
  if (selRow) selRow.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建工作区卡片 打开（${NS.why}）folder=${NS.folder || "?"} ` +
    `agent=${NS.agent || "?"} 上次=${NS.staleAgent || "-"} 锚=${opts.opener || ""}` });
}

function closeNewSpace(why) {
  const box = $("newspace");
  if (!box || box.hidden) return;
  const opener = NS && NS.opener;
  box.hidden = true;
  NS = null;
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  sendCtrl({ type: "log", msg: `新建工作区卡片 关闭（${why || ""}）` });
}

/* 项目池全量推送时先问这里：卡片正在等"选择其他文件夹"的结果吗？
   是 → 把结果收进卡片、吃掉这次更新（不跳工作区），返回 true。
   `picked` 是 Go 这次选择器最终指到的目录（main.go 的 poolReplyPicked）——
   没有它的话，"挑了一个已经在池子里的目录"会让 projects 一份都不变，
   卡片永远等不到"快照里多了一条"。 */
function newSpacePoolUpdate(projects, picked, err) {
  if (!NS) return false;
  if (!NS.pickPending) {
    // 卡片开着但没在等选择器（比如用户刚点了「取消等待」，选择器却在稍后
    // 返回了）：把下拉的选项刷新一下，别让刚选中的目录缺席到下次重开卡片。
    renderNewSpace();
    return false;
  }
  if (Date.now() - NS.pickAt > 120000) {
    NS.pickPending = false;
    renderNewSpace();
    return false;
  }
  if (err) {
    // 池子那条路自己会弹「项目池出错了」的 toast（applyPool），这里只把等待收掉。
    NS.pickPending = false;
    renderNewSpace();
    return false;
  }
  const path = String(picked || "");
  if (path) {
    const had = NS.base.has(path);
    NS.pickPending = false;
    NS.folder = path;
    const pickPath = nsPickAgentForFolder(path);
    NS.agent = pickPath.agent;
    NS.staleAgent = pickPath.stale;
    if (had) NS.addedPaths.delete(path);
    else NS.addedPaths.add(path);
    NS.base = new Set((projects || []).map((p) => p.path));
    renderNewSpace();
    if (had) showToast(t("ns.toast.existsTitle"), shortPath(path), "info");
    else showToast(t("ns.toast.addedTitle"), shortPath(path), "ok");
    sendCtrl({ type: "log", msg: `新建工作区卡片 选择器结果 folder=${path} 已在池中=${had}` });
    return true;
  }
  const fresh = (projects || []).find((p) => p && p.path && !NS.base.has(p.path));
  if (!fresh) return false;
  NS.pickPending = false;
  NS.folder = fresh.path;
  const pickFresh = nsPickAgentForFolder(fresh.path);
  NS.agent = pickFresh.agent;
  NS.staleAgent = pickFresh.stale;
  NS.addedPaths.add(fresh.path);
  NS.base = new Set((projects || []).map((p) => p.path));
  renderNewSpace();
  showToast(t("ns.toast.addedTitle"), fresh.name || fresh.path, "ok");
  sendCtrl({ type: "log", msg: `新建工作区卡片 选择器结果 folder=${fresh.path}` });
  return true;
}

$("ns-x").addEventListener("click", () => closeNewSpace("点 ×"));
$("ns-cancel").addEventListener("click", () => closeNewSpace("取消"));
$("ns-folder").addEventListener("change", () => {
  if (!NS) return;
  NS.folder = $("ns-folder").value || "";
  // 换文件夹 = 换上下文：预选跟着那个文件夹的记忆/默认走。用户如果刚手动
  // 点过别的 Agent，这里会被覆盖 —— 这是有意的：卡片回答的是"这个文件夹
  // 用谁"，不是"上一次点的是谁"。
  const pick = nsPickAgentForFolder(NS.folder);
  NS.agent = pick.agent;
  NS.staleAgent = pick.stale;
  renderNewSpace();
  sendCtrl({ type: "log", msg: `新建工作区卡片 选文件夹 folder=${NS.folder || "?"} ` +
    `agent=${NS.agent || "?"} 上次=${NS.staleAgent || "-"}` });
});
$("ns-pick").addEventListener("click", () => {
  if (!NS) return;
  if (NS.pickPending) {
    // 选择器还开着（Go 那边阻塞着）—— 我们收不到它的取消，只能由这里放行。
    NS.pickPending = false;
    renderNewSpace();
    sendCtrl({ type: "log", msg: "新建工作区卡片 用户取消等待选择器" });
    return;
  }
  NS.pickPending = true;
  NS.pickAt = Date.now();
  NS.base = new Set(nsProjects().map((p) => p.path));
  renderNewSpace();
  sendCtrl({ type: "project.add" });
  sendCtrl({ type: "log", msg: "新建工作区卡片 → 开系统文件夹选择器" });
});
$("ns-agents").addEventListener("click", (e) => {
  const b = e.target.closest("[data-nsagent]");
  if (!b || !NS) return;
  NS.agent = b.dataset.nsagent || "";
  renderNewSpace();
  const row = $("ns-agents").querySelector(`[data-nsagent="${NS.agent}"]`);
  if (row) row.focus({ preventScroll: true });
  sendCtrl({ type: "log", msg: `新建工作区卡片 选 Agent=${NS.agent || "(只加文件夹)"}` });
});
$("ns-create").addEventListener("click", () => {
  if (!NS) return;
  if (!nsCanCreate()) {
    // 灰而不禁：点了要说清楚为什么，不能没反应。
    showToast(t("ns.toast.stepTitle"), !NS.folder ? t("ns.toast.pickFolder")
      : t("ns.toast.pickAgent"), "err");
    return;
  }
  const folder = NS.folder;
  const agent = NS.agent;
  const onlyFolder = !agent;
  closeNewSpace("创建");
  setNavView("workspace");
  if (onlyFolder) {
    showToast(t("shell.pool.added"), shortPath(folder), "ok");
    sendCtrl({ type: "log", msg: `新建工作区卡片 只添加文件夹 folder=${folder}` });
    return;
  }
  // 显式选择才写文件夹记忆。快捷添加/新格切换都不写 —— 否则"最开始选的
  // 那个"会被别的手势悄悄改写。写入发生在建格之前：即使这次启动被护栏
  // 拒绝，用户刚刚做出的选择仍然是这个文件夹的偏好。
  rememberLastAgent(folder, agent);
  sendCtrl({ type: "log", msg: `新建工作区卡片 创建 agent=${agent} cwd=${folder}` });
  newTabIn(folder, "新建工作区卡片", agent);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !$("newspace") || $("newspace").hidden) return;
  // 文件预览是更上层：它开着时 Esc 归它。
  if ($("fview") && !$("fview").hidden) return;
  e.preventDefault();
  closeNewSpace("Esc");
}, true);
