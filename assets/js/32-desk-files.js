"use strict";
/* 32-desk-files.js —— 「文件」块 + 格子里「它碰过的文件」+ 速览。
   两种看法回答两个问题（照定稿模拟 spec/desk 的文件块）：
     · 碰过的 —— agent 在这个项目里读过 / 改过 / 新建的文件（转录推来的 LIVE.files，不经过磁盘）；
     · 全部   —— 项目文件夹里有什么（Go 的 fs.list，只读、护栏在 Go：根必须是项目池里的目录）。
   预览走 fs.read；「改过的行标绿」是这一格记到的最近那次改动（trace.diff）在新文件里落的行号。 */

const KIND_TXT = { edit: "改", new: "新", read: "读" };
const RANK = { read: 1, edit: 2, new: 3 };
const SKIP_DIRS = new Set([".git", "node_modules", ".perch", "__pycache__", ".venv", "dist", ".next"]);
// 一格碰过的文件 → 它在磁盘上的绝对路径、它算「读 / 改 / 新」
function touchKind(f) {
  const ops = f.ops || [];
  return ops.includes("write") ? "new" : ops.includes("edit") ? "edit" : "read";
}
function relOf(path, root) {
  const p = String(path || ""), r = String(root || "").replace(/[\\/]+$/, "");
  return insidePath(p, r) ? p.slice(r.length).replace(/^[\\/]+/, "").replace(/\\/g, "/") : p.replace(/\\/g, "/");
}
// 这个项目里碰过的文件：同一个文件被几格碰过就合成一行（谁动的都列出来）。
function touched(proj) {
  const map = new Map();
  for (const T of TAB_LIST) {
    const v = LIVE.get(T.id);
    if (!v || !v.files || !v.files.length) continue;
    for (const f of v.files) {
      if (!f.path || !insidePath(f.path, proj)) continue;
      const k = normPath(f.path);
      let e = map.get(k);
      if (!e) { e = { path: f.path, rel: relOf(f.path, proj), kind: "read", agents: new Set(), tabs: [], at: "" }; map.set(k, e); }
      const kd = touchKind(f);
      if (RANK[kd] > RANK[e.kind]) e.kind = kd;
      e.agents.add(T.spec.agent);
      e.tabs.push({ t: T, at: f.at || "", diff: !!f.hasDiff });
      if ((f.at || "") > e.at) e.at = f.at || "";
    }
  }
  return [...map.values()].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}
const touchedSig = (proj) => touched(proj).map((e) => e.path + e.kind + e.agents.size).join("|");
// 一格碰过的（格头那颗按钮的数字 + 弹出清单）
function touchedByLeaf(l) {
  if (!l.tab) return [];
  const v = LIVE.get(l.tab.id);
  const root = effCwd(l.tab);
  return ((v && v.files) || []).map((f) => ({ path: f.path, rel: relOf(f.path, root), kind: touchKind(f), at: f.at || "" }))
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
}

/* ---------- 读盘：fs.list / fs.read / trace.diff 的请求与应答 ---------- */
let FS_REQ = 0;
const fsWait = new Map();   // req → callback
const TREE = new Map();     // root|dir → { entries, loading, err }
const READS = new Map();    // path → { text, binary, truncated, err, loading, added:Set }
function fsCall(msg, cb) { const req = ++FS_REQ; fsWait.set(req, cb); sendCtrl(Object.assign({ req }, msg)); }
function applyFsList(m) { const cb = fsWait.get(m.req); fsWait.delete(m.req); if (cb) cb(m); }
function applyFsRead(m) { const cb = fsWait.get(m.req); fsWait.delete(m.req); if (cb) cb(m); }
function applyFsErr(m) { const cb = fsWait.get(m.req); fsWait.delete(m.req); if (cb) cb(m); }
function applyTraceDiff(m) { const cb = fsWait.get(m.req); fsWait.delete(m.req); if (cb) cb(m); }
let FV = 0;
const bumpFiles = () => { FV++; deskSoon("文件"); };
const keepDirs = (es) => (es || []).filter((e) => !e.hidden && !(e.dir && SKIP_DIRS.has(e.name)))
  .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
function listDir(root, dir) {
  if (!root) return { err: "先选一个项目" };
  const k = normPath(root) + "|" + normPath(dir);
  let n = TREE.get(k);
  // 读过的（含读失败的）先用着：失败的 5 秒内不重试，不然每画一帧就再问一次
  if (n && n.entries && !n.loading && Date.now() - n.at > 8000) {
    // 盘上会变（agent 在写）：旧的先照画，后台再问一次，回来了再重画
    n.loading = true; n.at = Date.now();
    fsCall({ type: "fs.list", root, path: dir }, (m) => { n.loading = false; if (m.type !== "fs.err") { n.entries = keepDirs(m.entries); bumpFiles(); } });
    return n;
  }
  if (n && (n.entries || n.loading || Date.now() - n.at < 5000)) return n;
  n = { entries: null, loading: true, err: "", at: Date.now() };
  TREE.set(k, n);
  fsCall({ type: "fs.list", root, path: dir }, (m) => {
    n.loading = false;
    if (m.type === "fs.err") n.err = tMsg(m.errCode, m.errParams, m.err || "读不了");
    else n.entries = keepDirs(m.entries);
    bumpFiles();
  });
  return n;
}
function readFile(root, path) {
  const k = normPath(path);
  let r = READS.get(k);
  if (!root || !path) return { err: "没有选项目", added: new Set() };
  if (r && (r.loading || Date.now() - r.at < 4000)) return r;
  r = Object.assign(r || { added: new Set() }, { loading: true, at: Date.now() });
  READS.set(k, r);
  fsCall({ type: "fs.read", root, path }, (m) => {
    r.loading = false;
    if (m.type === "fs.err") { r.err = tMsg(m.errCode, m.errParams, m.err || "读不了"); r.text = ""; }
    else Object.assign(r, { err: "", text: m.text || "", binary: !!m.binary, truncated: !!m.truncated, size: m.size || 0 });
    bumpFiles();
  });
  // 改过的行：找最近一次改动它、而且有 diff 的那一格，问它要 diff，算出新文件里加了哪几行
  const e = touched(ownerProjectPath(path)).find((x) => normPath(x.path) === k);
  const src = e && e.tabs.filter((x) => x.diff).sort((a, b) => (b.at || "").localeCompare(a.at || ""))[0];
  if (src) fsCall({ type: "trace.diff", tab: src.t.id, path }, (m) => {
    const added = new Set();
    const ch = (m.changes || []).filter((c) => c.ok !== false).pop();
    if (ch && ch.patch) for (const h of ch.patch) {
      let n = h.newStart || 1;
      for (const ln of h.lines || []) {
        if (ln.startsWith("+")) { added.add(n); n++; } else if (ln.startsWith("-")) { /* 删掉的行不占新文件的行号 */ } else n++;
      }
    } else if (ch && ch.tool === "Write" && ch.content) {
      const cnt = ch.content.split("\n").length;
      for (let i = 1; i <= cnt; i++) added.add(i);
    }
    r.added = added;
    bumpFiles();
  });
  return r;
}

/* ---------- 「文件」块 ---------- */
function filesHTML(z, narrow) {
  const fz = z.fz;
  const list = touched(fz.proj);
  const ps = PROJECTS();
  const projBtns = ps.map((x) => `<button data-fproj="${esc(x.path)}" class="${normPath(x.path) === normPath(fz.proj) ? "on" : ""}" title="${esc(x.path)}">${esc(x.name)}</button>`).join("")
    || `<button class="on">${esc(projName(fz.proj))}</button>`;
  let rows = "";
  if (fz.tab === "touched") {
    rows = list.length ? list.map((e) => `<button class="fr${fz.sel && normPath(fz.sel) === normPath(e.path) ? " on" : ""}" data-fopen="${esc(e.path)}"><span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span>`
      + `<b>${esc(e.rel.split("/").pop())}</b><span class="fd">${esc(e.rel.split("/").slice(0, -1).join("/"))}</span><span class="sp"></span>${[...e.agents].map((a) => logo(a)).join("")}</button>`).join("")
      : `<div class="fz-empty">${esc(projName(fz.proj))} 里还没有 agent 碰过文件。agent 读过、改过、新建的文件都会出现在这里。</div>`;
  } else {
    const out = [];
    const tk = new Map(list.map((e) => [normPath(e.path), e]));
    const walk = (dir, depth) => {
      const n = listDir(fz.proj, dir);
      if (n.loading && !n.entries) { out.push(`<div class="fz-empty" style="padding-left:${8 + depth * 16}px">正在读…</div>`); return; }
      if (n.err) { out.push(`<div class="fz-empty" style="padding-left:${8 + depth * 16}px">${esc(n.err)}</div>`); return; }
      for (const e of n.entries || []) {
        if (e.dir) {
          const open = fz.open.has(normPath(e.path));
          out.push(`<button class="fr" data-fdir="${esc(e.path)}" style="padding-left:${8 + depth * 16}px"><span class="fi">${ICON(open ? "chevron-down" : "chevron-right", 13)}</span><span class="fi">${ICON("folder", 14)}</span><b>${esc(e.name)}</b></button>`);
          if (open) walk(e.path, depth + 1);
        } else {
          const t = tk.get(normPath(e.path));
          out.push(`<button class="fr${fz.sel && normPath(fz.sel) === normPath(e.path) ? " on" : ""}" data-fopen="${esc(e.path)}" style="padding-left:${8 + depth * 16 + 19}px"><span class="fi">${ICON("file", 14)}</span><b>${esc(e.name)}</b><span class="sp"></span>${t ? `<span class="fk k-${t.kind}">${KIND_TXT[t.kind]}</span>` : ""}</button>`);
        }
      }
    };
    walk(fz.proj, 0);
    rows = out.join("") || `<div class="fz-empty">这个文件夹是空的。</div>`;
  }
  const prev = fz.sel ? previewHTML(fz.proj, fz.sel, narrow) : `<div class="fp-none">选一个文件，在这里看内容</div>`;
  return `<div class="fz"><div class="fz-top"><div class="fz-proj">${projBtns}</div><span class="sp"></span>`
    + `<div class="seg"><button data-ftab="touched" class="${fz.tab === "touched" ? "on" : ""}">碰过的 ${list.length}</button><button data-ftab="all" class="${fz.tab === "all" ? "on" : ""}">全部</button></div></div>`
    + `<div class="fz-main${narrow ? " narrow" : ""}${fz.sel ? " has-sel" : ""}"><div class="fz-list">${rows}</div><div class="fz-prev">${prev}</div></div></div>`;
}
function previewHTML(proj, path, back) {
  const e = touched(proj).find((x) => normPath(x.path) === normPath(path));
  const r = readFile(proj, path);
  const rel = relOf(path, proj);
  let body;
  if (r.loading && r.text === undefined) body = `<div class="fp-none">正在读…</div>`;
  else if (r.err) body = `<div class="fp-none">${esc(r.err)}</div>`;
  else if (r.binary) body = `<div class="fp-none">这是个二进制文件，不在这里显示内容。</div>`;
  else {
    const added = (e && e.kind !== "read" && r.added) || new Set();
    body = `<pre class="fp-c">${(r.text || "").split("\n").map((s, i) => `<div class="${added.has(i + 1) ? "add" : ""}"><i>${i + 1}</i>${esc(s) || " "}</div>`).join("")}`
      + (r.truncated ? `<div class="add-note"><i></i>（文件太大，只显示了开头一段）</div>` : "") + `</pre>`;
  }
  return `<div class="fp-h">${back ? `<button data-fback title="回到列表">${ICON("arrow-left", 14)}</button>` : ""}<b>${esc(rel.split("/").pop())}</b><span class="fd">${esc(rel.split("/").slice(0, -1).join("/"))}</span><span class="sp"></span>`
    + (e ? `<span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span>${[...e.agents].map((a) => logo(a)).join("")}` : "") + `</div>${body}`;
}
function openDirsFor(fz, path) {
  let p = String(path || "");
  for (;;) {
    const parent = p.replace(/[\\/][^\\/]*$/, "");
    if (!parent || parent === p || !insidePath(parent, fz.proj) || normPath(parent) === normPath(fz.proj)) break;
    fz.open.add(normPath(parent)); p = parent;
  }
}
ZONE_KINDS.files = {
  min: ZMIN_FILES,
  init(z, opts) { z.fz = { proj: opts.proj || defProj(), tab: "touched", open: new Set(), sel: opts.sel || null }; if (z.fz.sel) openDirsFor(z.fz, z.fz.sel); },
  title(z) { return ["文件", `${projName(z.fz.proj)} · ${touched(z.fz.proj).length} 个碰过的`]; },
  tab(z) { return { ic: `<span class="tl">${ICON("folder-tree", 14)}</span>`, st: `${esc(projName(z.fz.proj))} · ${touched(z.fz.proj).length} 个碰过的`, wait: 0 }; },
  render(z, zb) {
    if (!z.fz.proj) z.fz.proj = defProj();   // 圈块时项目名单还没到：到了就补上
    const narrow = bodyRect(z).w < 540;
    const sel = z.fz.sel ? READS.get(normPath(z.fz.sel)) : null;
    const key = z.fv + ":" + FV + ":" + narrow + ":" + touchedSig(z.fz.proj) + ":" + (sel ? (sel.loading ? 1 : 0) + ":" + (sel.added ? sel.added.size : 0) : "");
    if (zb._fk === key) return;
    zb._fk = key;
    const sc = qs(".fz-list", zb), st = sc ? sc.scrollTop : 0;
    const pc = qs(".fp-c", zb), pt = pc ? pc.scrollTop : 0;
    zb.innerHTML = filesHTML(z, narrow);
    const sc2 = qs(".fz-list", zb); if (sc2) sc2.scrollTop = st;
    const pc2 = qs(".fp-c", zb); if (pc2 && zb._sel === z.fz.sel) pc2.scrollTop = pt;
    zb._sel = z.fz.sel;
  },
  save(z) { return { proj: z.fz.proj, tab: z.fz.tab, sel: z.fz.sel, open: [...z.fz.open] }; },
  load(z, x) { z.fz = { proj: x.proj || defProj(), tab: x.tab === "all" ? "all" : "touched", open: new Set(x.open || []), sel: x.sel || null }; },
  busy() { return 0; },
};
function openFile(proj, path) {
  const z = Z.find((x) => x.kind === "files" && normPath(x.fz.proj) === normPath(proj)) || Z.find((x) => x.kind === "files");
  if (z) {
    z.fz.proj = proj; z.fz.sel = path; z.fz.tab = touched(proj).some((e) => normPath(e.path) === normPath(path)) ? "touched" : "all";
    openDirsFor(z.fz, path); z.fv++;
    if (z.collapsed) expandZone(z, true);
    front(z); render(); pingEl(ZEL.get(z.id));
    return;
  }
  openQuickLook(proj, path);
}
function openFilesFor(proj, sel) {
  closePops();
  const ex = Z.find((x) => x.kind === "files");
  if (ex) {
    ex.fz.proj = proj; if (sel) { ex.fz.sel = sel; openDirsFor(ex.fz, sel); } ex.fz.tab = "touched"; ex.fv++;
    if (ex.collapsed) expandZone(ex, true);
    front(ex); render(); pingEl(ZEL.get(ex.id)); saveLayout(); return ex;
  }
  const r = findFree([[720, 440], [600, 380], [480, 300], [ZMIN_FILES.w, ZMIN_FILES.h]]);
  if (r) { const z = addZone(r, "files", { proj, sel }); pingEl(ZEL.get(z.id)); return z; }
  armDraw({ kind: "files", proj }, "台面上没有空地了：圈一块放「文件」");
  return null;
}

/* ---------- 速览（台面上还没有「文件」块时，先在这里看一眼） ---------- */
let QL = null;
function openQuickLook(proj, path) {
  QL = { proj, path };
  paintQuickLook();
  qs("#ql").hidden = false;
}
function paintQuickLook() {
  if (!QL) return;
  qs("#ql").innerHTML = `<div class="back"></div><div class="ql-c">${previewHTML(QL.proj, QL.path, false)}<div class="ql-f"><span style="flex:1;font-size:11.5px;color:var(--faint);align-self:center">台面上还没有「文件」块，先在这里看一眼</span>`
    + `<button class="btn" data-ql="open">${ICON("folder-tree", 14)}在台面上开一个「文件」块</button><button class="btn" data-ql="close">关闭</button></div></div>`;
}
function closeQuickLook() { qs("#ql").hidden = true; QL = null; }

/* ---------- 格头：它碰过的文件 ---------- */
LEAF_CTL.unshift((l) => {
  const n = touchedByLeaf(l).length;
  return n ? `<button class="tf${l.peek ? " on" : ""}" data-tfiles data-leaf="${l.id}" title="它碰过的文件">${ICON("files", 13)}<em>${n}</em></button>` : "";
});
function peekHTML(l) {
  const fs = touchedByLeaf(l).slice(0, 10);
  return `<h5>${esc(ag(l.agent).name)} 在 ${esc(projName(l.proj))} 里碰过的文件</h5>`
    + fs.map((e) => `<button class="fr" data-peekf="${esc(e.path)}" data-leaf="${l.id}"><span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span><b>${esc(e.rel.split("/").pop())}</b><span class="fd">${esc(e.rel.split("/").slice(0, -1).join("/"))}</span></button>`).join("");
}
// 格子的格头签名里要带上碰过的文件数（数字变了格头要重画），弹出清单挂在格子上
const leafTouchSig = (l) => touchedByLeaf(l).length;
AFTER_RENDER.push(() => {
  for (const { z, l } of allLeaves()) {
    const el = TEL.get(l.id);
    if (!el) continue;
    const n = leafTouchSig(l);
    if (el._tn !== n) { el._tn = n; el._v = ""; const zx = qs(".zx", ZEL.get(z.id)); if (zx) zx._k = ""; DESK.soon(); }
    let pk = qs(":scope > .peek", el);
    if (l.peek && l.tab) {
      if (!pk) { pk = document.createElement("div"); pk.className = "peek"; el.appendChild(pk); }
      const h = peekHTML(l);
      if (pk._h !== h) { pk._h = h; pk.innerHTML = h; }
    } else if (pk) pk.remove();
  }
  if (QL && !qs("#ql").hidden) { const k = FV; if (paintQuickLook._k !== k) { paintQuickLook._k = k; paintQuickLook(); } }
});

/* ---------- 点击 ---------- */
CLICKS.push((t) => {
  if (t.closest("#ql")) {
    const b = t.closest("[data-ql]");
    if (b) { const q = QL; closeQuickLook(); if (b.dataset.ql === "open" && q) openFilesFor(q.proj, q.path); }
    else if (t.classList.contains("back")) closeQuickLook();
    return true;
  }
  const tf = t.closest("[data-tfiles]");
  if (tf) {
    const x = allLeaves().find((y) => y.l.id === tf.dataset.leaf);
    if (x) { const on = !x.l.peek; closePeeks(); x.l.peek = on; x.l.v++; render(); }
    return true;
  }
  const pf = t.closest("[data-peekf]");
  if (pf) {
    const x = allLeaves().find((y) => y.l.id === pf.dataset.leaf);
    if (x) { x.l.peek = false; x.l.v++; render(); openFile(ownerProjectPath(pf.dataset.peekf) || x.l.proj, pf.dataset.peekf); }
    return true;
  }
  const fzone = t.closest(".fz") && zoneOfEl(t);
  if (fzone && fzone.kind === "files") {
    const fz = fzone.fz;
    const b = t.closest("[data-fproj],[data-ftab],[data-fdir],[data-fopen],[data-fback]");
    if (b) {
      if (b.dataset.fproj) { fz.proj = b.dataset.fproj; fz.sel = null; }
      else if (b.dataset.ftab) fz.tab = b.dataset.ftab;
      else if (b.dataset.fdir) { const k = normPath(b.dataset.fdir); if (fz.open.has(k)) fz.open.delete(k); else fz.open.add(k); }
      else if (b.dataset.fopen) fz.sel = b.dataset.fopen;
      else if (b.hasAttribute("data-fback")) fz.sel = null;
      fzone.fv++; render(); saveLayout();
    }
    return true;
  }
  return false;
});
ESCS.push(() => { if (!qs("#ql").hidden) { closeQuickLook(); return true; } return false; });
