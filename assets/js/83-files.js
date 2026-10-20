/* ===========================================================================
   右栏「文件」+ 只读预览
   ---------------------------------------------------------------------------
   用户 2026-10-19 的原话：agent 在工作过程中会产出文件/代码，用户想查看就得
   自己点进去翻；如果右栏能直接呈现，就能快速点开查阅。

   两种视图，回答的是两个不同的问题：
     · 碰过的 —— "这一格刚刚动了什么？" 数据来自转录（LIVE.files），
       不经过后端，agent 一动手就能看见。默认停在这里。
     · 全部   —— "这个工作区里有什么？" 懒加载目录树，走 Go 的
       fs.list（护栏、包含性、上限都在 files.go，前端不是安全边界）。

   点击文件 = 就地弹只读预览（#fview）。**不写文件、不把内容送回终端** ——
   这个模块只负责看；写入权在 agent 手里。
   =========================================================================== */

const FILES_UI_KEY = "filesUi";
let FU = { mode: "touched", dot: false, root: "" };
try {
  const o = JSON.parse(localStorage.getItem(FILES_UI_KEY) || "{}") || {};
  if (o.mode === "touched" || o.mode === "all") FU.mode = o.mode;
  FU.dot = o.dot === true;
  FU.root = typeof o.root === "string" ? o.root : "";
} catch (e) {}

function saveFilesUi() {
  try { localStorage.setItem(FILES_UI_KEY, JSON.stringify(FU)); } catch (e) {}
}

/* 运行期状态。children 的 key 是**请求时发给 Go 的目录**（根用前端路径、
   子目录用上一层的 entry.path）；Go 回的 path 已经规范化过 —— 两边只在
   根这一层可能差一个大小写，拿请求键缓存最稳。 */
const FS = {
  open: new Set(),        // 全部视图里展开的目录
  children: new Map(),    // dir -> { entries, truncated, at }
  loading: new Set(),     // 正在请求的 dir
  err: new Map(),         // dir -> 错误文本
  touchedClosed: new Set(), // 碰过的视图里收起的虚拟目录（默认全开）
  reqSeq: 1,
  reqs: new Map(),        // req -> { op, dir, root, path, why }
  timeouts: new Map(),    // req -> timer（ctl 断了也不能让 loading 永远卡住）
  sig: "",
  rootOptSig: "",
  touchSig: "",
  refreshTimer: 0,
  waitTimer: 0,           // ctl 还没连上时，等它一下再发
};

const FILES_PREVIEW_LINES = 5000;

function filesProjects() { return STATE?.projects || []; }

/* 跟随当前格的工作区；没有当前格时退回默认工作区。 */
function filesDefaultRoot() {
  const p = currentWorkspacePath();
  if (p) return p;
  const projs = filesProjects();
  return (projs.find((x) => x.synthetic) || projs[0] || {}).path || "";
}
function filesRootPath() {
  if (FU.root && filesProjects().some((p) => p.path === FU.root)) return FU.root;
  return filesDefaultRoot();
}
/* 一个文件属于哪个允许根（最长前缀）。touched 里的文件可能是别的项目的，
   读的时候要用它自己的根；找不到 = 不在任何工作区里，前端先拒绝，
   省得发一条注定被 Go 拒的请求。 */
function filesRootForPath(path) {
  let best = "", bestLen = -1;
  for (const p of filesProjects()) {
    if (!p.path || !insidePath(path, p.path)) continue;
    const n = normPath(p.path).length;
    if (n > bestLen) { best = p.path; bestLen = n; }
  }
  return best;
}

/* 显示用的相对路径（保留大小写；只用于绘制，不用于安全判断）。 */
function filesRelUnder(path, root) {
  if (!path || !root || !insidePath(path, root)) return null;
  const a = String(path).replace(/\//g, "\\").replace(/\\+$/, "");
  const r = String(root).replace(/\//g, "\\").replace(/\\+$/, "");
  if (normPath(a) === normPath(r)) return "";
  return a.slice(r.length + 1).replace(/\\/g, "/");
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* 目录的 chevron 永远朝右；展开态由 `[aria-expanded="true"]` 的 CSS 转 90°。 */
function filesChev() {
  return svg('<path d="M9 6l6 6-6 6"/>', 12, 2);
}
/* 每层缩进 14px（Orca 是 16px；这一列更窄，收一档）。
   文件行也留一个 12px 的 chevron 空槽，图标才和目录行对齐。 */
const FILES_INDENT = 14;
function filesPad(depth) { return 6 + depth * FILES_INDENT; }

function filesModeBtn() {
  for (const b of document.querySelectorAll("#files-bar .fseg")) {
    const on = b.dataset.fmode === FU.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  const row = $("files-rootrow");
  if (row) row.hidden = FU.mode !== "all";
  const dot = $("files-dot");
  if (dot) {
    // .env 开关只对「全部」树有意义：碰过的视图没有"隐藏点文件"这回事。
    // 不做隐、不占宽度 —— 该视图里根本没有这个控件。
    dot.hidden = FU.mode !== "all";
    dot.classList.toggle("on", FU.dot);
    dot.setAttribute("aria-pressed", FU.dot ? "true" : "false");
  }
}

function filesRootOptions(root) {
  const projs = filesProjects();
  const sig = projs.map((p) => `${p.path}\u0000${p.name}`).join("\u0001") + "\u0002" + FU.root;
  const sel = $("files-root");
  if (!sel) return;
  if (sig !== FS.rootOptSig) {
    FS.rootOptSig = sig;
    sel.innerHTML = `<option value="">跟随当前格</option>` + projs.map((p) =>
      `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join("");
  }
  // 固定的根已经不在池子里时，FU.root 会在 filesRootPath 里被忽略；
  // 下拉显示"跟随当前格"才不会撒一个不存在的值。
  sel.value = (FU.root && projs.some((p) => p.path === FU.root)) ? FU.root : "";
  sel.title = root || "";
}

function filesEnsureRoot(root) {
  if (!root || FS.loading.has(root) || FS.children.has(root)) return;
  filesList(root, root, "首次展开");
}

function filesList(root, dir, why) {
  if (!root || !dir || FS.loading.has(dir)) return;
  // 启动时右栏可能就停在文件模块：这时 ctl 通道不一定开了。sendCtrl 在
  // 未连上时**静默丢消息**，如果这里先把 loading 置上，就再也没有重试了。
  // 等通道开了再发（ctl.onopen 也会叫一次 renderFiles）。
  if (!ctlReady) {
    if (!FS.waitTimer) {
      FS.waitTimer = setTimeout(() => {
        FS.waitTimer = 0;
        FS.sig = "";
        renderFiles(true);
      }, 400);
    }
    return;
  }
  FS.loading.add(dir);
  FS.err.delete(dir);
  const req = FS.reqSeq++;
  FS.reqs.set(req, { op: "list", dir, root, why });
  FS.timeouts.set(req, setTimeout(() => {
    FS.timeouts.delete(req);
    if (!FS.reqs.has(req)) return;
    FS.reqs.delete(req);
    FS.loading.delete(dir);
    FS.err.set(dir, "请求超时（ctl 通道可能断了）");
    renderFiles(true);
  }, 8000));
  sendCtrl({ type: "fs.list", root, path: dir, req });
}

function filesRefresh(why) {
  if (FU.mode !== "all") { renderFiles(true); return; }
  const root = filesRootPath();
  FS.children.clear();
  FS.err.clear();
  filesEnsureRoot(root);
  // 已经把根展开过的，刷新时连同展开层一起重取（只重取还开着的那些）。
  for (const d of FS.open) {
    if (FS.children.has(d) || d === root) continue;
    filesList(root, d, why || "刷新");
  }
  renderFiles(true);
  sendCtrl({ type: "log", msg: `文件 刷新（${why || "手动"}）根=${root} 展开=${FS.open.size}` });
}

function scheduleFilesRefresh(why) {
  if (FS.refreshTimer) return;
  FS.refreshTimer = setTimeout(() => {
    FS.refreshTimer = 0;
    if (FU.mode !== "all" || rsbMod !== "files" || !rsbOpen) return;
    filesRefresh(why);
  }, 800);
}

/* ---- 渲染 ---------------------------------------------------------------- */

function filesTouchedHtml(t, v) {
  const files = (v && v.files) || [];
  if (!t) return `<div class="empty">没有当前格 · 切到一个 agent，就能看到它碰过的文件</div>`;
  if (!files.length) return `<div class="empty">这一格还没碰过文件 · agent 新建 / 修改 / 读取过的文件会出现在这里</div>`;
  const root = filesRootPath();
  const rootNode = { dirs: new Map(), files: [] };
  for (const f of files) {
    const abs = f.path || "";
    let p = f.rel || abs;
    const rel = filesRelUnder(abs, root);
    if (rel != null) p = rel;
    p = String(p || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const segs = p.split("/").filter(Boolean);
    if (!segs.length) continue;
    let node = rootNode;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (!node.dirs.has(s)) node.dirs.set(s, { dirs: new Map(), files: [] });
      node = node.dirs.get(s);
    }
    node.files.push({ name: segs[segs.length - 1], f });
  }
  const countFiles = (n) => n.files.length + [...n.dirs.values()].reduce((a, c) => a + countFiles(c), 0);
  const rows = [];
  const walk = (node, prefix, depth) => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    for (const name of dirNames) {
      const child = node.dirs.get(name);
      const key = prefix ? `${prefix}/${name}` : name;
      const closed = FS.touchedClosed.has(key);
      rows.push(`<button type="button" class="frow fdir" data-ftdir="${esc(key)}" `
        + `aria-expanded="${closed ? "false" : "true"}" title="${esc(key)}" `
        + `style="padding-left:${filesPad(depth)}px">`
        + `<span class="fchev">${filesChev()}</span>`
        + `<span class="fico">${fileDirIconSvg(!closed, 14)}</span>`
        + `<span class="fnm ell">${esc(name)}</span>`
        + `<span class="fcount">${countFiles(child)}</span></button>`);
      if (!closed) walk(child, key, depth + 1);
    }
    const fs = node.files.slice().sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const { name, f } of fs) {
      const op = opOf(f);
      const ops = (f.ops || []).map((o) => OP_NAME[o] || o).join(" + ");
      const d = (f.add || f.del)
        ? `<span class="fdiff"><span class="d-add">+${f.add || 0}</span> <span class="d-del">−${f.del || 0}</span></span>`
        : `<span class="fdiff"></span>`;
      // 最后一次改动被拒绝 / 文件已经不在盘上：行尾给一个短标记。点开预览
      // 仍能看到当时记录下来的 diff（正文在 trace.diff 里，不随列表推送）。
      const bad = f.state === "rejected"
        ? `<span class="fbad rej" title="最后一次改动被拒绝，没有落盘">拒</span>`
        : f.state === "failed"
          ? `<span class="fbad fail" title="最后一次改动失败，没有落盘">错</span>`
          : f.state === "missing"
            ? `<span class="fbad miss" title="文件现在不在盘上">缺</span>`
            : "";
      const badWord = f.state === "rejected" ? "最后一次改动被拒绝"
        : f.state === "failed" ? "最后一次改动失败"
          : f.state === "missing" ? "文件已不在盘上" : "";
      const tip = [f.path, ops, badWord, f.at].filter(Boolean).join("\n");
      rows.push(`<button type="button" class="frow ffile" data-fpath="${esc(f.path || "")}" `
        + `data-froot="${esc(filesRootForPath(f.path || ""))}" data-fname="${esc(name)}" `
        + `title="${esc(tip)}" style="padding-left:${filesPad(depth)}px">`
        + `<span class="fchev"></span>`
        + `<span class="ficoslot">${fileIconSvg(f.path || name, 14)}</span>`
        + `<span class="fnm ell">${esc(name)}</span>`
        + `<span class="fop ${OP_LETTER[op]}">${OP_LETTER[op]}</span>${d}`
        + `<span class="fbad-slot">${bad}</span></button>`);
    }
  };
  walk(rootNode, "", 0);
  return rows.join("") || `<div class="empty">这一格还没碰过文件。</div>`;
}

function filesEntryHtml(root, dir, depth) {
  const rec = FS.children.get(dir);
  const err = FS.err.get(dir);
  const loading = FS.loading.has(dir);
  let html = "";
  if (loading && !rec) html += `<div class="frow fstate">读取中…</div>`;
  if (err) {
    html += `<div class="frow fstate ferr" title="${esc(err)}">读不了：${esc(err)}`
      + `<button type="button" class="flink" data-fretry="${esc(dir)}">重试</button></div>`;
  }
  if (!rec) return html;
  const list = rec.entries.filter((e) => FU.dot || !e.hidden);
  if (!list.length && !loading) return html + `<div class="frow fstate">这个目录是空的。</div>`;
  for (const e of list) {
    const pad = filesPad(depth);
    if (e.dir) {
      const open = FS.open.has(e.path);
      const ext = e.external ? `（指向工作区外，打不开）` : "";
      html += `<button type="button" class="frow fdir${e.external ? " ext" : ""}" `
        + `data-fdir="${esc(e.path)}" aria-expanded="${open ? "true" : "false"}" `
        + `title="${esc(e.path + ext)}" style="padding-left:${pad}px">`
        + `<span class="fchev">${filesChev()}</span>`
        + `<span class="fico">${fileDirIconSvg(open, 14)}</span>`
        + `<span class="fnm ell">${esc(e.name)}</span>`
        + (e.external ? `<span class="fext">外部</span>` : "")
        + `</button>`;
      if (open && !e.external) html += filesEntryHtml(root, e.path, depth + 1);
    } else {
      // 外部链接仍然列出来（静默隐藏更难查），但点它只会说一句为什么。
      html += `<button type="button" class="frow ffile${e.link ? " link" : ""}${e.external ? " ext" : ""}" `
        + `data-fpath="${esc(e.path)}" data-froot="${esc(root)}" data-fname="${esc(e.name)}" `
        + (e.external ? `data-fext="1" ` : "")
        + `title="${esc(e.path + (e.link ? "\n符号链接" : "") + (e.external ? "（指向工作区外）" : ""))}" `
        + `style="padding-left:${pad}px">`
        + `<span class="fchev"></span>`
        + `<span class="ficoslot">${fileIconSvg(e.path, 14)}</span>`
        + `<span class="fnm ell">${esc(e.name)}</span>`
        + (e.external ? `<span class="fext">外部</span>` : "")
        + `</button>`;
    }
  }
  if (rec.truncated) {
    html += `<div class="frow fstate">只显示了前 2000 条 —— 这个目录太大了。</div>`;
  }
  return html;
}

function filesAllHtml(root) {
  if (!root) return `<div class="empty">还没有工作区 · 先在左栏或总览里新建一个工作区</div>`;
  const rec = FS.children.get(root);
  if (!rec) {
    filesEnsureRoot(root);
    return `<div class="frow fstate">读取中…</div>`;
  }
  return filesEntryHtml(root, root, 0)
    || `<div class="empty">这个工作区是空的。</div>`;
}

function renderFiles(force) {
  const host = $("files-tree");
  if (!host) return;
  // 这一列没在显示文件时不画、也不发请求；切回来时 renderLive 会再叫一次。
  if (rsbMod !== "files" || !rsbOpen) { FS.sig = ""; return; }
  // 宿主是空的 = 上一次落进去的内容不在。这时签名闸不能挡：没东西可保留，
  // 必须画一次，否则会停在空白等**下一次**状态推送（空闲时可能永远等不到）。
  // 最常撞见的一条：右栏收起再展开，收起期间没有任何推送。
  if (!force && host.childElementCount === 0) force = true;
  const t = activeTab;
  const v = t ? LIVE.get(t.id) : null;
  const files = (v && v.files) || [];
  const root = filesRootPath();
  const touchSig = files.map((f) =>
    `${f.path}|${(f.ops || []).join(",")}|${f.add || 0}|${f.del || 0}|` +
    `${f.hasDiff ? 1 : 0}|${f.state || ""}`).join("\n");
  const tabChanged = FS.touchSig !== touchSig;
  FS.touchSig = touchSig;

  filesModeBtn();
  filesRootOptions(root);

  if (FU.mode === "all") filesEnsureRoot(root);

  const sig = [
    FU.mode, FU.dot ? 1 : 0, root, t ? t.id : 0,
    FU.mode === "touched" ? touchSig : "",
    FU.mode === "all" ? [...FS.open].sort().join(",") : "",
    [...FS.loading].sort().join(","),
    [...FS.err.keys()].sort().join(","),
    FS.children.size,
  ].join("\u0001");
  if (!force && sig === FS.sig) {
    // 数据没变也要在"碰过的"变化时刷新全部树（文件树跟着 agent 落盘走）。
    if (tabChanged && FU.mode === "all") scheduleFilesRefresh("转录更新");
    return;
  }
  FS.sig = sig;

  let html = "";
  if (FU.mode === "touched") {
    html = filesTouchedHtml(t, v);
    const cnt = $("files-cnt");
    if (cnt) {
      // 模块头的汇总：文件数 + 改动行数。读过的文件也算"碰过"，所以 N 用
      // files.length；±N 只加 edit/write（read 没有行数）。
      let add = 0, del = 0;
      for (const f of files) {
        if ((f.ops || []).some((o) => o !== "read")) {
          add += f.add || 0;
          del += f.del || 0;
        }
      }
      cnt.textContent = files.length
        ? `${files.length} 个文件` + ((add || del) ? ` · +${add} −${del}` : "")
        : "";
      cnt.title = files.length
        ? `这一格碰过 ${files.length} 个文件` + ((add || del) ? `，改动 +${add} / −${del} 行` : "")
        : "";
    }
  } else {
    html = filesAllHtml(root);
    const rec = FS.children.get(root);
    const cnt = $("files-cnt");
    if (cnt) {
      const n = rec ? rec.entries.filter((e) => FU.dot || !e.hidden).length : 0;
      cnt.textContent = rec ? `${n} 个文件` : "";
      cnt.title = "";
    }
  }
  host.innerHTML = html;

  if (tabChanged && FU.mode === "all") scheduleFilesRefresh("转录更新");
}

/* ---- 交互 ---------------------------------------------------------------- */

function setFilesMode(mode) {
  if (mode !== "touched" && mode !== "all") return;
  if (FU.mode === mode) return;
  FU.mode = mode;
  saveFilesUi();
  FS.sig = "";
  if (mode === "all") filesEnsureRoot(filesRootPath());
  renderFiles(true);
  sendCtrl({ type: "log", msg: `文件 视图=${mode} 根=${filesRootPath()}` });
}

$("files-bar").addEventListener("click", (e) => {
  const seg = e.target.closest("[data-fmode]");
  if (seg) { setFilesMode(seg.dataset.fmode); return; }
  if (e.target.closest("#files-dot")) {
    FU.dot = !FU.dot;
    saveFilesUi();
    FS.sig = "";
    renderFiles(true);
    sendCtrl({ type: "log", msg: `文件 ${FU.dot ? "显示" : "隐藏"}点文件` });
  }
});

$("files-refresh").addEventListener("click", () => filesRefresh("按钮"));

$("files-root").addEventListener("change", () => {
  FU.root = $("files-root").value || "";
  saveFilesUi();
  FS.open.clear();
  FS.children.clear();
  FS.err.clear();
  FS.sig = "";
  filesEnsureRoot(filesRootPath());
  renderFiles(true);
  sendCtrl({ type: "log", msg: `文件 根=${FU.root || "跟随当前格"}（实际 ${filesRootPath()}）` });
});

$("files-tree").addEventListener("click", (e) => {
  const retry = e.target.closest("[data-fretry]");
  if (retry) {
    const dir = retry.dataset.fretry || "";
    FS.err.delete(dir);
    FS.children.delete(dir);
    filesList(filesRootPath(), dir, "重试");
    renderFiles(true);
    return;
  }
  const td = e.target.closest("[data-ftdir]");
  if (td) {
    const key = td.dataset.ftdir || "";
    if (FS.touchedClosed.has(key)) FS.touchedClosed.delete(key);
    else FS.touchedClosed.add(key);
    renderFiles(true);
    return;
  }
  const d = e.target.closest("[data-fdir]");
  if (d) {
    const dir = d.dataset.fdir || "";
    // 外部目录是个"看得到、打不开"的条目（护栏在 Go 侧）。点了要说一句为什么，
    // 不能静默 return —— 那和"按钮坏了"在界面上是同一件事。
    if (d.classList.contains("ext")) {
      showToast("打不开这个目录", "它是指向工作区外面的符号链接。", "err");
      return;
    }
    if (FS.open.has(dir)) FS.open.delete(dir);
    else {
      FS.open.add(dir);
      if (!FS.children.has(dir)) filesList(filesRootPath(), dir, "展开");
    }
    renderFiles(true);
    return;
  }
  const f = e.target.closest("[data-fpath]");
  if (!f) return;
  if (f.dataset.fext === "1") {
    showToast("打不开这个文件", "它是一个指向工作区外面的符号链接。", "err");
    return;
  }
  // ⚠️ froot 空串要保留成空串：那表示"这个文件不归任何工作区"，
  // 让 openFileView 说清楚为什么打不开；退成当前根只会发一条注定被拒的请求。
  openFileView(f.dataset.fpath || "", f.dataset.froot || "", f.dataset.fname || "");
});

/* ---- 预览（只读） -------------------------------------------------------- */

/* FV = 一张预览的全部状态。**改动和正文各自有请求/错误**，因为它们回答的是
   两个不同的问题（转录里记了什么 / 盘上现在是什么），任何一边失败都不能把
   另一边已经拿到的内容抹掉。
     { path, root, name, req, opener, tab,
       tabMode:"diff"|"code", tabPicked, hasDiff,
       diff, diffReq, diffLoading, diffErr,
       read, readLoading, readErr, readNotes, readNoteKind } */
let FV = null;

function fvSetNote(text, kind) {
  const n = $("fv-note");
  if (!n) return;
  n.hidden = !text;
  n.textContent = text || "";
  n.className = "fv-note" + (kind ? " " + kind : "");
}

function fvSamePath(a, b) {
  return String(a || "").replace(/\\/g, "/").toLowerCase() ===
         String(b || "").replace(/\\/g, "/").toLowerCase();
}

// 当前格台账里这个文件的轻标记（hasDiff / state）。找不到 = 这一格没碰过它，
// 但「全部」树里点进来的文件仍会走 trace.diff 问一次 —— 转录可能比列表更全。
function fvTouchOf(path) {
  const t = activeTab;
  const v = t ? LIVE.get(t.id) : null;
  const files = (v && v.files) || [];
  return files.find((f) => fvSamePath(f.path, path)) || null;
}

function fvTabsShown() {
  return !!(FV && (FV.hasDiff || (FV.diff && (FV.diff.changes || []).length)));
}

function fvSyncTabs() {
  const bar = $("fv-tabs");
  if (!bar) return;
  const show = fvTabsShown();
  bar.hidden = !show;
  if (!show) {
    const sum = $("fv-sum");
    if (sum) sum.textContent = "";
    return;
  }
  const mode = FV.tabMode === "diff" ? "diff" : "code";
  for (const b of bar.querySelectorAll("[data-fvtab]")) {
    const on = b.dataset.fvtab === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  const sum = $("fv-sum");
  if (!sum) return;
  const d = FV.diff;
  if (FV.diffLoading) {
    sum.textContent = "取改动…";
  } else if (d && (d.changes || []).length) {
    sum.innerHTML = `<span class="d-add">+${d.add || 0}</span> ` +
      `<span class="d-del">−${d.del || 0}</span>` +
      `<span class="fv-nchg">${(d.changes || []).length} 次</span>`;
  } else {
    sum.textContent = "";
  }
}

function fvSetTab(mode, why) {
  if (!FV || (mode !== "diff" && mode !== "code")) return;
  if (mode === "diff" && !fvTabsShown()) return;
  FV.tabMode = mode;
  FV.tabPicked = true;
  fvSyncTabs();
  fvRender();
  sendCtrl({ type: "log", msg: `文件预览 切页=${mode} path=${FV.path}（${why || ""}）` });
}

function fvError(text) {
  if (FV) {
    FV.readLoading = false;
    FV.readErr = text || "读取失败";
    FV.read = null;
  }
  fvRender();
}

function openFileView(path, root, name) {
  if (!path) return;
  const box = $("fview");
  if (!box) return;
  const t = activeTab;
  const touch = fvTouchOf(path);
  const hasDiff = !!(touch && touch.hasDiff);
  FV = {
    path, root: root || filesRootForPath(path), name: name || base(path),
    req: 0, opener: document.activeElement,
    tab: t ? t.id : 0,
    tabMode: hasDiff ? "diff" : "code",
    tabPicked: false,
    hasDiff,
    diff: null, diffReq: 0, diffLoading: !!(t && t.id), diffErr: "",
    read: null, readLoading: true, readErr: "", readNotes: [], readNoteKind: "",
  };
  $("fv-name").textContent = FV.name;
  $("fv-path").textContent = path;
  $("fv-path").title = path;
  $("fv-meta").textContent = "";
  fvSetNote("", "");
  fvSyncTabs();
  fvRender();
  box.hidden = false;
  const x = $("fv-x");
  if (x) x.focus({ preventScroll: true });
  // 改动正文按需取：文件和「改动」两条腿互不阻塞，先到先画。
  if (FV.tab > 0) {
    const dreq = FS.reqSeq++;
    FV.diffReq = dreq;
    FS.reqs.set(dreq, { op: "diff", path, tab: FV.tab });
    FS.timeouts.set(dreq, setTimeout(() => {
      FS.timeouts.delete(dreq);
      FS.reqs.delete(dreq);
      if (FV && FV.diffReq === dreq) {
        FV.diffLoading = false;
        FV.diffErr = "请求超时（转录跟随器没有应答）";
        fvSyncTabs();
        fvRender();
      }
    }, 5000));
    sendCtrl({ type: "trace.diff", tab: FV.tab, path, req: dreq });
    sendCtrl({ type: "log", msg: `文件预览 请求改动 tab=${FV.tab} path=${path} req=${dreq}` });
  } else {
    FV.diffLoading = false;
    fvSyncTabs();
  }
  if (!FV.root) {
    fvError("这个文件不在任何工作区里。Perch 只预览项目池目录下的文件（护栏在 Go 侧）。");
    sendCtrl({ type: "log", msg: `文件预览 拒绝（不在工作区里）path=${path}` });
    return;
  }
  const req = FS.reqSeq++;
  FV.req = req;
  FS.reqs.set(req, { op: "read", path, root: FV.root });
  FS.timeouts.set(req, setTimeout(() => {
    FS.timeouts.delete(req);
    FS.reqs.delete(req);
    if (FV && FV.req === req) fvError("请求超时（ctl 通道可能断了）");
  }, 8000));
  sendCtrl({ type: "fs.read", root: FV.root, path, req });
  sendCtrl({ type: "log", msg: `文件预览 请求 path=${path} 根=${FV.root} req=${req}` });
}

function closeFileView(why) {
  const box = $("fview");
  if (!box || box.hidden) return;
  const opener = FV && FV.opener;
  box.hidden = true;
  if (FV) {
    for (const r of [FV.req, FV.diffReq]) {
      if (!r) continue;
      FS.reqs.delete(r);
      clearTimeout(FS.timeouts.get(r));
      FS.timeouts.delete(r);
    }
  }
  const p = FV ? FV.path : "";
  FV = null;
  $("fv-body").innerHTML = `<div class="fv-loading">读取中…</div>`;
  const tabs = $("fv-tabs");
  if (tabs) tabs.hidden = true;
  const sum = $("fv-sum");
  if (sum) sum.textContent = "";
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  sendCtrl({ type: "log", msg: `文件预览 关闭（${why || ""}）path=${p}` });
}

function fvCodeHtml(text) {
  const lines = String(text ?? "").split("\n");
  const shown = lines.slice(0, FILES_PREVIEW_LINES);
  if (!text) return `<div class="fv-loading">这个文件是空的。</div>`;
  let html = shown.map((line, i) =>
    `<div class="fl"><span class="ln">${i + 1}</span><span class="lc">${esc(line) || " "}</span></div>`).join("");
  if (lines.length > FILES_PREVIEW_LINES) {
    html += `<div class="fv-cut">只显示前 ${FILES_PREVIEW_LINES} 行（共 ${lines.length} 行）</div>`;
  }
  return html;
}

/* ---- 改动页：unified diff + 整份写入 ------------------------------------- */

function fvClock(at) {
  const s = String(at || "");
  const i = s.indexOf("T");
  return i >= 0 ? s.slice(i + 1, i + 9) : "";
}

function fvDiffRow(kind, oldNo, newNo, text) {
  const sig = kind === "add" ? "+" : kind === "del" ? "-" : " ";
  return `<div class="df ${kind}">` +
    `<span class="dln">${oldNo || ""}</span>` +
    `<span class="dln">${newNo || ""}</span>` +
    `<span class="dsig">${sig}</span>` +
    `<span class="dc">${esc(text) || " "}</span></div>`;
}

function fvPatchHtml(h) {
  let oldNo = h.oldStart | 0, newNo = h.newStart | 0;
  let html = `<div class="dfh">@@ -${h.oldStart | 0},${h.oldLines | 0} ` +
    `+${h.newStart | 0},${h.newLines | 0} @@</div>`;
  for (const line of h.lines || []) {
    const c = line ? line[0] : " ";
    if (c === "+") html += fvDiffRow("add", "", newNo++, line.slice(1));
    else if (c === "-") html += fvDiffRow("del", oldNo++, "", line.slice(1));
    else if (c === "\\") html += fvDiffRow("meta", "", "", line);
    else html += fvDiffRow("ctx", oldNo++, newNo++, line ? line.slice(1) : "");
  }
  return html;
}

function fvWholeTextHtml(text, kind, label) {
  const lines = String(text ?? "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, FILES_PREVIEW_LINES);
  let html = label ? `<div class="dfsec">${esc(label)}</div>` : "";
  html += shown.map((line, i) =>
    kind === "add" ? fvDiffRow("add", "", i + 1, line)
                   : fvDiffRow("del", i + 1, "", line)).join("");
  if (lines.length > FILES_PREVIEW_LINES) {
    html += `<div class="fv-cut">只显示前 ${FILES_PREVIEW_LINES} 行（共 ${lines.length} 行）</div>`;
  }
  return html;
}

function fvChangeHtml(ch) {
  const tool = ch.tool || "改动";
  const when = fvClock(ch.at);
  const sum = (ch.add || ch.del)
    ? `<span class="dfsum"><span class="d-add">+${ch.add || 0}</span> ` +
      `<span class="d-del">−${ch.del || 0}</span></span>`
    : "";
  const failed = ch.ok === false;
  const bad = failed
    ? `<span class="dfbad${ch.denied ? "" : " fail"}">` +
      (ch.denied ? "被拒绝，未落盘" : "失败，未落盘") + `</span>`
    : "";
  let html = `<div class="dfchg${failed ? " rej" : ""}">` +
    `<div class="dfhead"><span class="dftool">${esc(tool)}</span>` +
    (when ? `<span class="dfwhen" title="${esc(ch.at || "")}">${esc(when)}</span>` : "") +
    `<span class="dfsp"></span>${sum}${bad}</div>`;

  if (ch.patch && ch.patch.length) {
    html += ch.patch.map(fvPatchHtml).join("");
  } else if (ch.content) {
    html += fvWholeTextHtml(ch.content, "add",
      ch.ok === false ? "尝试写入的内容（未落盘）" : "整份写入");
  } else if (ch.old || ch.new) {
    if (ch.old) html += fvWholeTextHtml(ch.old, "del", "原内容（调用参数）");
    if (ch.new) html += fvWholeTextHtml(ch.new, "add", "新内容（调用参数）");
  } else {
    html += `<div class="dfempty">这次改动没有可展示的正文。</div>`;
  }
  if (ch.truncated) {
    html += `<div class="fv-cut">改动内容过长，只显示了前一部分（完整内容仍在转录里）。</div>`;
  }
  // 失败/被拒绝的通用标记已经在右上角，正文里只补错误原因，避免同一句话说两遍。
  let note = ch.note || "";
  if (failed) {
    for (const p of ["被拒绝，未落盘", "失败，未落盘"]) {
      if (note.startsWith(p)) {
        note = note.slice(p.length).replace(/^\s*·\s*/, "");
        break;
      }
    }
  }
  if (note) html += `<div class="dfnote">${esc(note)}</div>`;
  return html + `</div>`;
}

function fvDiffHtml(d) {
  const list = (d && d.changes) || [];
  if (!list.length) return `<div class="fv-loading">没有可显示的改动。</div>`;
  return list.map(fvChangeHtml).join("");
}

/* ---- 预览的统一重画：两条腿各自 loading/error，谁也不覆盖谁 -------------- */

function fvRender() {
  if (!FV) return;
  const body = $("fv-body");
  if (!body) return;
  if (FV.tabMode === "diff") {
    if (FV.diffLoading) {
      fvSetNote("", "");
      body.innerHTML = `<div class="fv-loading">读取改动…</div>`;
      return;
    }
    if (FV.diffErr) {
      fvSetNote("改动记录取不到；可以切到「文件」看当前正文。", "warn");
      body.innerHTML = `<div class="fv-loading fv-err">${esc(FV.diffErr)}</div>`;
      return;
    }
    const d = FV.diff;
    const changes = (d && d.changes) || [];
    const notes = [];
    let kind = "";
    if (d && d.missing) {
      notes.push("这个文件现在不在盘上；下面是当时记录的改动。");
      kind = "warn";
    }
    if (!d || !d.found) {
      notes.push("这次会话的转录里没有这个文件的改动记录。");
      kind = kind || "warn";
    }
    fvSetNote(notes.join(" "), kind);
    if (!changes.length) {
      body.innerHTML = `<div class="fv-loading">没有可显示的改动。</div>`;
      return;
    }
    body.innerHTML = fvDiffHtml(d);
    return;
  }

  // 「文件」页
  if (FV.readLoading) {
    fvSetNote("", "");
    body.innerHTML = `<div class="fv-loading">读取中…</div>`;
    return;
  }
  if (FV.readErr) {
    fvSetNote(FV.hasDiff ? "文件读不了；可以切到「改动」看这次会话记录的改动。" : "",
      FV.hasDiff ? "warn" : "");
    body.innerHTML = `<div class="fv-loading fv-err">${esc(FV.readErr)}</div>`;
    return;
  }
  const m = FV.read;
  const notes = FV.readNotes || [];
  fvSetNote(notes.join(" "), FV.readNoteKind || "");
  if (m && (m.binary || m.encoding === "non-utf8")) {
    body.innerHTML = `<div class="fv-loading">${esc(notes[notes.length - 1] || "不预览正文")}</div>`;
  } else {
    body.innerHTML = fvCodeHtml((m && m.text) || "");
  }
}

function applyFsRead(m) {
  const w = FS.reqs.get(m.req);
  if (!w || w.op !== "read") return;
  FS.reqs.delete(m.req);
  clearTimeout(FS.timeouts.get(m.req));
  FS.timeouts.delete(m.req);
  if (!FV || FV.req !== m.req) return; // 预览已经关了 / 换成别的文件了
  const meta = $("fv-meta");
  if (meta) meta.textContent = fmtSize(m.size) + (m.encoding && m.encoding !== "utf-8" ? ` · ${m.encoding}` : "");
  FV.read = m;
  FV.readLoading = false;
  FV.readErr = "";
  FV.readNotes = [];
  FV.readNoteKind = "";
  if (m.truncated) FV.readNotes.push("文件大于 512 KiB，只显示前 512 KiB。");
  if (m.binary) FV.readNotes.push("这是二进制文件，不预览正文；可以复制路径或在文件夹中显示。");
  else if (m.encoding === "non-utf8") FV.readNotes.push("这不是 UTF-8 文本（可能是 GBK 等编码），不预览正文。");
  if (m.binary || m.encoding === "non-utf8") FV.readNoteKind = "warn";
  fvRender();
  sendCtrl({ type: "log", msg: `文件预览 到达 path=${m.path} size=${m.size} ` +
    `text=${(m.text || "").length} truncated=${m.truncated} binary=${m.binary} enc=${m.encoding}` });
}

// trace.diff 的应答：只有「改动」这一条腿，不碰 read 的状态。
function applyTraceDiff(m) {
  const w = FS.reqs.get(m.req);
  if (!w || w.op !== "diff") return;
  FS.reqs.delete(m.req);
  clearTimeout(FS.timeouts.get(m.req));
  FS.timeouts.delete(m.req);
  if (!FV || FV.diffReq !== m.req) return;
  FV.diffLoading = false;
  if (m.err) {
    FV.diffErr = m.err;
    FV.diff = null;
  } else {
    FV.diffErr = "";
    FV.diff = m;
    FV.hasDiff = !!(m.found && (m.changes || []).length);
    // 用户还没亲手切过页时，有改动就落在「改动」；否则尊重用户的选择。
    if (FV.hasDiff && !FV.tabPicked) FV.tabMode = "diff";
    else if (!FV.hasDiff && FV.tabMode === "diff") FV.tabMode = "code";
  }
  fvSyncTabs();
  fvRender();
  sendCtrl({ type: "log", msg: `文件预览 改动到达 path=${m.path} found=${m.found} ` +
    `条=${(m.changes || []).length} 缺=${m.missing === true}` });
}

function applyFsList(m) {
  const w = FS.reqs.get(m.req);
  if (!w || w.op !== "list") return;
  FS.reqs.delete(m.req);
  clearTimeout(FS.timeouts.get(m.req));
  FS.timeouts.delete(m.req);
  FS.loading.delete(w.dir);
  FS.err.delete(w.dir);
  FS.children.set(w.dir, {
    entries: Array.isArray(m.entries) ? m.entries : [],
    truncated: m.truncated === true,
    at: Date.now(),
  });
  renderFiles(true);
  sendCtrl({ type: "log", msg: `文件 目录到达 dir=${w.dir} 条目=${(m.entries || []).length}` +
    ` 截断=${m.truncated === true}` });
}

function applyFsErr(m) {
  const w = FS.reqs.get(m.req);
  if (!w) return;
  FS.reqs.delete(m.req);
  clearTimeout(FS.timeouts.get(m.req));
  FS.timeouts.delete(m.req);
  if (w.op === "list") {
    FS.loading.delete(w.dir);
    FS.err.set(w.dir, m.err || "读取失败");
    renderFiles(true);
  } else if (w.op === "read" && FV && FV.req === m.req) {
    FV.readLoading = false;
    FV.readErr = m.err || "读取失败";
    FV.read = null;
    // 文件没了也不把已记录的改动藏起来：有 diff 就落到「改动」页
    // （用户亲手切过页的话仍尊重他的选择）。
    if (FV.hasDiff && !FV.tabPicked && FV.tabMode !== "diff") FV.tabMode = "diff";
    fvSyncTabs();
    fvRender();
  } else if (w.op === "diff" && FV && FV.diffReq === m.req) {
    FV.diffLoading = false;
    FV.diffErr = m.err || "读取改动失败";
    FV.diff = null;
    fvSyncTabs();
    fvRender();
  }
  sendCtrl({ type: "log", msg: `文件 错误 op=${w.op} path=${m.path || w.path || w.dir}` +
    ` err=${m.err || "?"}` });
}

$("fv-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fvtab]");
  if (b) fvSetTab(b.dataset.fvtab, "点标签");
});
$("fv-x").addEventListener("click", () => closeFileView("点 ×"));
$("fv-close").addEventListener("click", () => closeFileView("点关闭"));
$("fv-copy").addEventListener("click", () => {
  if (!FV) return;
  copyText(FV.path).then((ok) => {
    if (ok) showToast("已复制路径", FV ? FV.path : "", "ok", true);
  });
});
$("fv-reveal").addEventListener("click", () => {
  if (FV) sendCtrl({ type: "open", mode: "reveal", path: FV.path });
});
$("fv-open").addEventListener("click", () => {
  if (FV) sendCtrl({ type: "open", mode: "open", path: FV.path });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("fview") && !$("fview").hidden) {
    e.preventDefault();
    closeFileView("Esc");
  }
}, true);

// 窗口重新获得焦点时刷一次全部树：agent 在别的窗口里改了文件，切回来能看见。
window.addEventListener("focus", () => {
  if (FU.mode === "all" && rsbMod === "files") scheduleFilesRefresh("窗口重新获得焦点");
});

// 首次绘制（启动时右栏可能停在文件模块）。
filesModeBtn();
