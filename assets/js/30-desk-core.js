"use strict";
/* 30-desk-core.js —— 台面（0.1.1）的骨架：块、切格、格子里的真终端、收起成标签、拖拽、Dock、收起成悬浮按钮。

   形态以定稿模拟为准（spec/desk/，用户 2026-11-07 验收），这里是它的真身：
     · 块（zone）= 在桌面空白处圈出来的矩形。种类：agents（一格或多格）/ group / files / web / app / new（还没选）。
     · agents 块里是一棵二叉切分树：leaf = 一格，split = 横切（h：左右）或竖切（v：上下）+ 比例 r。
       切分树始终正好铺满块的内框；块缩放时各格按比例跟着变。块与块默认不重叠。
     · 一格里放的是一个**真的 agent 终端**（10-term.js 的 createTab），格子只是它的落点：
       终端元素建一次就不重建，格子重画只换格头。
     · Dock 可以拖到任何地方；贴左右边时竖排，贴边时台面让出那一条。
   和模拟不一样的只有「数据从哪来」：agent 名单、项目、状态、安装进度都是真的（Go 推来的）。 */

const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => [...r.querySelectorAll(s)];
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

const GAP = 6, PAD = 6, HEAD = 34, MINW = 200, MINH = 132, TOP = 44, SIDE = 20, DOCK_R = 92;
let ZGAP = 14;
const ZMIN_NEW = { w: 260, h: 180 }, ZMIN_GROUP = { w: 340, h: 260 }, ZMIN_FILES = { w: 360, h: 240 };

// 图标一律是 Lucide 原文（03-icons.js，ISC 许可）；不手画。
const ICON = (n, s = 18, sw = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

/* ---------- Agent 名单：Go 的 agentcatalog 探测结果（21-state.js 的 opCatalog） ---------- */
// 产品名单的顺序（用户 2026-10-23 定的那九个）；名单里没写的排在后面。
const AGENT_ORDER = ["claude", "codex", "pi", "opencode", "agy", "dsh", "cursor", "copilot", "qoder"];
const AGENT_SHORT = { "DeepSeek Harness": "DeepSeek", "Copilot CLI": "Copilot", "Antigravity CLI": "Antigravity" };
function agIconFile(icon) {
  const nm = String(icon || "").trim();
  if (!nm) return "";
  return /\.(svg|png|webp)$/i.test(nm) ? nm : nm + (isPngIcon(nm) ? ".png" : ".svg");
}
// 一个 agent 的台面视图：名字、图标、装没装、能不能由 Perch 代装。
function ag(id) {
  const a = opAgentById(id);
  if (!a) return { id, name: id || "Agent", file: "", mono: true, installed: false, canInstall: false };
  const file = agIconFile(a.icon);
  return { id: a.id, name: a.name || a.id, file, mono: !!file && !/-color\./.test(file) && !/\.png$/i.test(file),
    installed: opLaunchable(a), canInstall: !!a.install, raw: a };
}
function agentList() {
  const cat = opCatalog().filter((a) => a && a.id);
  const rank = (a) => { const i = AGENT_ORDER.indexOf(a.id); return i < 0 ? 99 : i; };
  return cat.slice().sort((a, b) => rank(a) - rank(b)).map((a) => ag(a.id));
}
const agShort = (a) => AGENT_SHORT[a.name] || a.name;
const defAgent = () => defaultAgentId();
const logo = (id, cls = "") => {
  const a = ag(id);
  if (!a.file) return `<span class="ag-none ${cls}">${ICON("bot", 14)}</span>`;
  return `<img class="${a.mono ? "mono " : ""}${cls}" src="icons/agents/${encodeURIComponent(a.file)}" alt="" draggable="false">`;
};

/* ---------- Agent 就地下载：没有单独的「安装」页，开工时选到没装的就地装 ----------
   Go 跑官方安装命令（install.agent），推回 start / queued / phase / log / done；装完先推新名单再推 done。
   安装器给不出百分比，所以图标里的液面是**时间换算**的：一直往上涨、越涨越慢、停在九成，
   done 到了才灌满 —— 它说的是「还在装」，不冒充一个精确的进度。 */
const INST = {};   // agentId -> { pct, t0, phase, then: [], last }
const DONE = {};
const instPhase = (s) => !s ? "" : s.phase === "queued" ? "排队中" : s.phase === "scanning" ? "检测" : s.pct < 60 ? "下载" : "安装";
function installAgent(id, then) {
  const a = ag(id);
  if (a.installed) { if (then) then(); return; }
  if (INST[id]) { if (then) INST[id].then.push(then); return; }
  if (!a.canInstall) {
    toast(`${a.name} 还不能由 Perch 代装 —— 照它官网的说明装好以后，重开 Perch 就能用`, "warn");
    return;
  }
  INST[id] = { pct: 2, t0: Date.now(), phase: "preparing", then: then ? [then] : [], last: "" };
  sendCtrl({ type: "install.agent", id });
  toast(`开始下载 ${a.name} —— 装好就能用（只装一次）`);
  paintInstall();
}
// ctl 的 install.* 都落到这里（20-ctl.js 的分发认这个名字）。
function applyInstall(m) {
  const id = m.id;
  if (!id) return;
  let s = INST[id];
  if (m.type === "install.start") {
    if (!s) s = INST[id] = { pct: 2, t0: Date.now(), phase: "preparing", then: [], last: "" };
    s.phase = "running";
  } else if (m.type === "install.queued") {
    if (s) s.phase = "queued";
  } else if (m.type === "install.phase") {
    if (s && m.phase) s.phase = m.phase;
  } else if (m.type === "install.log") {
    if (s && m.line) s.last = String(m.line);
  } else if (m.type === "install.done") {
    if (m.catalog) setCatalog(m.catalog, "安装完成");
    const name = ag(id).name;
    const then = s ? s.then : [];
    delete INST[id];
    if (m.ok) {
      DONE[id] = Date.now();
      toast(`${name} 装好了`);
      for (const f of then) { try { f(); } catch (e) { jserr("install.then", e); } }
    } else {
      toast(`${name} 没装上：${m.err || m.msg || (s && s.last) || "安装命令失败了"}`, "warn");
      for (const { l } of allLeaves()) if (l.installing === id) { l.installing = null; l.v++; }
    }
    buildTray();
    for (const z of Z) { if (z.group) z.group.sv++; for (const l of leaves(z.root)) if (!l.tab) l.v++; }
    render();
  }
  paintInstall();
}
// 液体灌进图标：只改填充高度和那几个数字，不重画（重画会把 hover 的玻璃层闪掉）。
function paintInstall() {
  for (const [id, s] of Object.entries(INST)) {
    for (const el of qsa(`[data-agi="${id}"]`)) { el.classList.add("ing"); el.style.setProperty("--p", s.pct + "%"); }
    for (const el of qsa(`[data-agname="${id}"]`)) el.textContent = Math.round(s.pct) + "%";
    for (const el of qsa(`[data-insttxt="${id}"]`)) el.textContent = `${instPhase(s)} ${Math.round(s.pct)}%`;
  }
}
setInterval(() => {
  let any = false;
  for (const s of Object.values(INST)) {
    any = true;
    if (s.phase === "queued") { s.pct = Math.min(s.pct, 5); continue; }
    const sec = (Date.now() - s.t0) / 1000;
    s.pct = Math.max(s.pct, 2 + 88 * (1 - Math.exp(-sec / 40)));
  }
  if (any) paintInstall();
}, 300);
// 往一格里放 agent：装了就直接开；没装就在这一格里显示下载进度，装好自动开。
function placeAgent(leaf, id) {
  if (ag(id).installed) { assign(leaf, id); return; }
  if (!ag(id).canInstall) { installAgent(id); return; }
  leaf.installing = id; leaf.v++;
  installAgent(id, () => { if (leaf.installing === id) { leaf.installing = null; assign(leaf, id); render(); } });
}
/* agent 图标：没装的是灰的；鼠标移上去盖一层玻璃、浮出下载；点了以后液体从底部灌满图标，就是下载进度。 */
function agiHTML(id) {
  const a = ag(id), s = INST[id];
  const img = a.file ? `<img class="${a.mono ? "mono" : ""}" src="icons/agents/${encodeURIComponent(a.file)}" alt="" draggable="false">` : ICON("bot", 18);
  if (a.installed) return `<span class="agi${DONE[id] && Date.now() - DONE[id] < 1600 ? " done" : ""}" data-agi="${id}">${img}</span>`;
  return `<span class="agi ni${s ? " ing" : ""}" data-agi="${id}" style="--p:${s ? s.pct : 0}%">${img}<span class="agi-fill">${img}</span>`
    + `<span class="agi-liq"><i></i><i></i></span><span class="agi-dl">${ICON("download", 13, 2.2)}</span></span>`;
}
const agLabel = (a, txt) => INST[a.id] ? `<span data-agname="${a.id}">${Math.round(INST[a.id].pct)}%</span>` : `<span data-agname="">${esc(txt)}</span>`;

/* ---------- 项目：项目 = 盘上的一个文件夹（Go 的项目池） ----------
   格子记的是**路径**，不是名字（名字可以重）。没有项目时落在默认工作区（Go 合成的那一份）。 */
const PROJECTS = () => deskProjects().map((p) => ({ name: projectName(p), path: p.path }));
const projName = (path) => projLabel(path);
const defProj = () => {
  const ps = PROJECTS();
  if (CFG.lastProj && ps.some((p) => normPath(p.path) === normPath(CFG.lastProj))) return CFG.lastProj;
  return (ps[0] || {}).path || defaultAreaPath();
};
const isProjPath = (p) => PROJECTS().some((x) => normPath(x.path) === normPath(p));

/* ---------- 台面设置（会记住） ----------
   这一份只管台面自己的外观和摆法；Perch 的权威设置（默认 Agent、字体……）在 Go 的 settings.json。 */
const ACCENTS = ["#8aa4ff", "#7dd3c0", "#f5a3c7", "#f5b454", "#c4b5fd"];
const DEF_CFG = () => ({ bg: "wall", glass: 0.6, blur: 30, acc: "#8aa4ff", clock: true, gap: "comfy", confirmClose: true, overlap: false, lastProj: "", orb: null });
const DEF_DK = () => ({ mode: "edge", edge: "bottom", t: 0.5 });
let CFG = DEF_CFG(), DK = DEF_DK();
try { const s = JSON.parse(localStorage.getItem("perch.desk.v1") || "null"); if (s) { CFG = Object.assign(DEF_CFG(), s.CFG); DK = Object.assign(DEF_DK(), s.DK); } } catch (_) {}
const save = () => { try { localStorage.setItem("perch.desk.v1", JSON.stringify({ CFG, DK })); } catch (_) {} };
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
let WALL_V = Date.now();
function applyCfg() {
  const r = document.documentElement.style;
  r.setProperty("--glass", `rgba(18,19,24,${CFG.glass})`);
  r.setProperty("--blur", CFG.blur + "px");
  r.setProperty("--acc", CFG.acc);
  r.setProperty("--acc-bg", hexA(CFG.acc, 0.16));
  // 桌面壁纸：Go 的资产服务器那条私有路由把当前壁纸原样吐出来；换了壁纸 Go 发 perch:wallpaper。
  r.setProperty("--wall", `url("/__desk/wallpaper?v=${WALL_V}")`);
  document.body.classList.toggle("bg-solid", CFG.bg === "solid");
  document.body.classList.toggle("bg-grad", CFG.bg === "grad");
  document.body.classList.toggle("no-clock", !CFG.clock);
  ZGAP = CFG.gap === "tight" ? 8 : 14;
}

/* ---------- 状态 ---------- */
let Z = [];
let uid = 1;
const nid = () => "n" + uid++;
const emptyLeaf = (proj) => ({ t: "leaf", id: nid(), agent: null, proj: proj || defProj(), tab: null, paneId: 0, state: "idle", v: 1, ask: "" });
let DRAW = null;          // 圈块时预先定好的东西：{ kind, proj, agent }
let LAST_ZONE = null, LAST_REFUSED = 0, DRAG = null, SUPPRESS_CLICK = 0;
let ZTOP = 1;             // 叠放时的前后次序

/* 块的种类表。agents / new 在这个文件里；Bot Group、文件、网页、外部应用各在自己的文件里登记：
   { min, title(z) → [主标题, 副标题], tab(z) → { ic, st, wait }, init(z, opts), render(z, zb), busy(z), close(z) } */
const ZONE_KINDS = {};

function desk() {
  const W = innerWidth, H = innerHeight;
  let x = SIDE, y = TOP, r = W - SIDE, b = H - 24;
  if (DK.mode === "edge") {
    if (DK.edge === "bottom") b = H - DOCK_R - 8;
    else if (DK.edge === "top") y = DOCK_R + 4;
    else if (DK.edge === "left") x = DOCK_R;
    else if (DK.edge === "right") r = W - DOCK_R;
  }
  return { x, y, w: r - x, h: b - y };
}
const fr = (fx, fy, fw, fh) => { const d = desk(); return { x: Math.round(d.x + fx * d.w), y: Math.round(d.y + fy * d.h), w: Math.round(fw * d.w), h: Math.round(fh * d.h) }; };
const inDesk = (r) => { const d = desk(); return r.x >= d.x - 0.5 && r.y >= d.y - 0.5 && r.x + r.w <= d.x + d.w + 0.5 && r.y + r.h <= d.y + d.h + 0.5; };
const hit = (a, b) => !(a.x + a.w + ZGAP <= b.x || b.x + b.w + ZGAP <= a.x || a.y + a.h + ZGAP <= b.y || b.y + b.h + ZGAP <= a.y);
// 占地只算展开着的块（收起成标签的不占地）；except 可以是一个 id，也可以是一组 id
const occupied = (r, except) => Z.find((z) => !z.collapsed && !(except instanceof Set ? except.has(z.id) : z.id === except) && hit(r, z));
// 「允许重叠」打开时谁也不挡谁；找空地（findFree）仍然先找真正空着的地方
const blocker = (r, except) => CFG.overlap ? null : occupied(r, except);
function findFree(sizes) {
  const d = desk();
  for (const [w, h] of sizes) {
    const xs = [d.x, d.x + d.w - w], ys = [d.y, d.y + d.h - h];
    for (const z of Z) { xs.push(z.x + z.w + ZGAP, z.x - w - ZGAP, z.x); ys.push(z.y + z.h + ZGAP, z.y - h - ZGAP, z.y); }
    for (let y = d.y; y + h <= d.y + d.h; y += 16) ys.push(y);
    for (let x = d.x; x + w <= d.x + d.w; x += 16) xs.push(x);
    const cy = [...new Set(ys.map(Math.round))].filter((y) => y >= d.y && y + h <= d.y + d.h).sort((a, b) => a - b);
    const cx = [...new Set(xs.map(Math.round))].filter((x) => x >= d.x && x + w <= d.x + d.w).sort((a, b) => a - b);
    for (const y of cy) for (const x of cx) { const r = { x, y, w, h }; if (!occupied(r)) return r; }
  }
  return null;
}

/* ---------- 切分树 ---------- */
const minW = (n) => n.t === "leaf" ? MINW : n.dir === "h" ? minW(n.a) + GAP + minW(n.b) : Math.max(minW(n.a), minW(n.b));
const minH = (n) => n.t === "leaf" ? MINH : n.dir === "v" ? minH(n.a) + GAP + minH(n.b) : Math.max(minH(n.a), minH(n.b));
const leaves = (n, out = []) => { if (!n) return out; if (n.t === "leaf") out.push(n); else { leaves(n.a, out); leaves(n.b, out); } return out; };
const parentOf = (n, c) => { if (!n || n.t === "leaf") return null; if (n.a === c || n.b === c) return n; return parentOf(n.a, c) || parentOf(n.b, c); };
const bodyRect = (z) => ({ x: 0, y: 0, w: z.w - 2 * PAD - 2, h: z.h - HEAD - PAD - 2 });
function layoutTree(n, rc, tiles, divs) {
  if (n.t === "leaf") { tiles.push({ leaf: n, rc }); return; }
  if (n.dir === "h") {
    const aw = Math.round((rc.w - GAP) * n.r);
    layoutTree(n.a, { x: rc.x, y: rc.y, w: aw, h: rc.h }, tiles, divs);
    layoutTree(n.b, { x: rc.x + aw + GAP, y: rc.y, w: rc.w - aw - GAP, h: rc.h }, tiles, divs);
    divs.push({ sp: n, rc, at: { x: rc.x + aw - 3, y: rc.y, w: GAP + 6, h: rc.h } });
  } else {
    const ah = Math.round((rc.h - GAP) * n.r);
    layoutTree(n.a, { x: rc.x, y: rc.y, w: rc.w, h: ah }, tiles, divs);
    layoutTree(n.b, { x: rc.x, y: rc.y + ah + GAP, w: rc.w, h: rc.h - ah - GAP }, tiles, divs);
    divs.push({ sp: n, rc, at: { x: rc.x, y: rc.y + ah - 3, w: rc.w, h: GAP + 6 } });
  }
}
function zoneLayout(z) { const tiles = [], divs = []; if (z.root) layoutTree(z.root, bodyRect(z), tiles, divs); return { tiles, divs }; }
function zoneMin(z) {
  const k = ZONE_KINDS[z.kind];
  if (k && k.min) return k.min;
  if (z.kind === "agents" && z.root) return { w: Math.max(ZMIN_NEW.w, minW(z.root) + 2 * PAD + 2), h: Math.max(ZMIN_NEW.h, minH(z.root) + HEAD + PAD + 2) };
  return ZMIN_NEW;
}
function replaceNode(z, old, nw) {
  if (z.root === old) { z.root = nw; return; }
  const p = parentOf(z.root, old);
  if (p.a === old) p.a = nw; else p.b = nw;
}
function splitLeaf(z, leaf, side, agentId) {
  const t = zoneLayout(z).tiles.find((x) => x.leaf === leaf);
  if (!t) return null;
  const h = side === "left" || side === "right";
  const half = h ? (t.rc.w - GAP) / 2 : (t.rc.h - GAP) / 2;
  if (half < (h ? MINW : MINH)) {
    LAST_REFUSED = Date.now();
    toast(`这一格再${h ? "左右" : "上下"}切就太小了（每格至少 ${MINW}×${MINH}）—— 先把它拉大一点`, "warn");
    pingEl(TEL.get(leaf.id));
    return null;
  }
  const nl = emptyLeaf(leaf.proj);
  const first = side === "left" || side === "top";
  const sp = { t: "split", id: nid(), dir: h ? "h" : "v", r: 0.5, a: first ? nl : leaf, b: first ? leaf : nl };
  replaceNode(z, leaf, sp);
  z.focus = null;
  render();
  if (agentId) placeAgent(nl, agentId);
  saveLayout();
  return nl;
}
// 关掉一格：× = 关掉运行，不是删掉这个 agent —— 记录留着，之后能按原样接回。
function removeLeaf(z, leaf) {
  if (leaf.tab) closeTab(leaf.tab, { close: true, why: "点格子的 ×" });
  leaf.tab = null;
  if (z.root === leaf) { removeZone(z); return; }
  const p = parentOf(z.root, leaf);
  replaceNode(z, p, p.a === leaf ? p.b : p.a);
  if (z.focus === leaf.id) z.focus = null;
  const el = TEL.get(leaf.id);
  if (el) { el.remove(); TEL.delete(leaf.id); }
  render();
  saveLayout();
}
function allLeaves() { const out = []; for (const z of Z) for (const l of leaves(z.root)) out.push({ z, l }); return out; }
const leafOfTab = (t) => allLeaves().find((x) => x.l.tab === t) || null;

/* ---------- 块 ---------- */
function addZone(r, kind, opts) {
  const z = { id: nid(), x: r.x, y: r.y, w: r.w, h: r.h, kind: "new", root: null, focus: null, group: null, gv: 0, fz: null, fv: 0, zi: ++ZTOP, collapsed: false, tab: null };
  Z.push(z);
  LAST_ZONE = z;
  if (kind) setKind(z, kind, opts);
  render();
  saveLayout();
  return z;
}
function setKind(z, k, opts) {
  opts = opts || {};
  if (k === "par") {
    const b = bodyRect(z);
    const dir = b.w >= b.h ? "h" : "v";
    const fits = dir === "h" ? b.w >= 2 * MINW + GAP : b.h >= 2 * MINH + GAP;
    z.root = fits ? { t: "split", id: nid(), dir, r: 0.5, a: emptyLeaf(opts.proj), b: emptyLeaf(opts.proj) } : emptyLeaf(opts.proj);
    z.kind = "agents";
  } else if (k === "one") {
    z.root = emptyLeaf(opts.proj);
    z.kind = "agents";
    if (opts.agent) { render(); placeAgent(z.root, opts.agent); }
  } else if (ZONE_KINDS[k] && ZONE_KINDS[k].init) {
    z.kind = k;
    ZONE_KINDS[k].init(z, opts);
  } else {
    toast("这种块还在接入中 —— 先用「并行 Agents」或「单个 Agent」", "warn");
    return;
  }
  render();
  saveLayout();
}
function zoneBusy(z) {
  const k = ZONE_KINDS[z.kind];
  if (k && k.busy) return k.busy(z);
  return leaves(z.root).filter((l) => l.tab).length;
}
async function closeZone(z) {
  const n = zoneBusy(z);
  if (CFG.confirmClose && n) {
    const ok = await deskConfirm("关掉这一块？", `里面 ${n} 个 agent 会停下来。记录都留着，之后可以按原样接回。（设置 › 通用 里可以关掉这句提示）`, "关掉");
    if (!ok) return;
  }
  removeZone(z);
}
function removeZone(z) {
  const k = ZONE_KINDS[z.kind];
  if (k && k.close) k.close(z);
  for (const l of leaves(z.root)) { if (l.tab) closeTab(l.tab, { close: true, why: "关掉一块" }); l.tab = null; }
  const el = ZEL.get(z.id);
  Z = Z.filter((x) => x !== z);
  for (const l of leaves(z.root)) TEL.delete(l.id);
  ZEL.delete(z.id);
  if (el) { el.classList.add("out"); setTimeout(() => el.remove(), 260); }
  const tb = TABEL.get(z.id);
  if (tb) { tb.remove(); TABEL.delete(z.id); }
  syncDock();
  saveLayout();
}
// Dock 贴边时台面让出那一条：越界的块先往里挪，挪了会撞到别人就改成往里收。
function fitZones() {
  const d = desk();
  for (const z of Z) if (z.pre && inDesk(z.pre) && !blocker(z.pre, z.id)) { Object.assign(z, z.pre); z.pre = null; }
  for (const z of Z) {
    if (z.collapsed || inDesk(z)) continue;
    if (!z.pre) z.pre = { x: z.x, y: z.y, w: z.w, h: z.h };
    const mn = zoneMin(z);
    const ir = { x: Math.max(z.x, d.x), y: Math.max(z.y, d.y) };
    ir.w = Math.min(z.x + z.w, d.x + d.w) - ir.x; ir.h = Math.min(z.y + z.h, d.y + d.h) - ir.y;
    const sh = { w: Math.min(z.w, d.w), h: Math.min(z.h, d.h) };
    sh.x = clampN(z.x, d.x, d.x + d.w - sh.w); sh.y = clampN(z.y, d.y, d.y + d.h - sh.h);
    if (!blocker(sh, z.id)) Object.assign(z, sh);
    else if (ir.w >= mn.w && ir.h >= mn.h) Object.assign(z, ir);
    else Object.assign(z, sh);
  }
  render();
  saveLayout();
}

/* ---------- 一格里的真 agent ----------
   格子是 agent 终端的**落点**：createTab 建出来的 .cell 挂进格子的 .tterm，之后格子怎么重画都不碰它。
   建格是"先登记再建"（createTab 同步把座位推进 TAB_LIST、同步建好 DOM），所以这里能马上拿到那个标签对象。 */
function assign(leaf, agentId, o) {
  o = o || {};
  leaf.agent = agentId; leaf.state = "idle"; leaf.ask = ""; leaf.peek = false; leaf.v++;
  if (!o.spec) { CFG.lastProj = leaf.proj; save(); }
  render();
  const el = TEL.get(leaf.id);
  const mount = el ? qs(".tterm", el) : null;
  const proj = isProjPath(leaf.proj);
  const spec = Object.assign({}, o.spec || { agent: agentId, cwd: proj ? leaf.proj : "", target: proj ? "project" : "scratch", resume: { kind: "new", id: "" } });
  // 这一格自己选过的模型（格头上那颗按钮）跟着起：重开 / 接回都还是它
  if (leaf.provider) spec.provider = leaf.provider;
  if (leaf.model) spec.model = leaf.model;
  // 没自己选过：记下它起的时候用的是哪套默认（之后设置里改了默认，也不影响这一格格头上说的话）
  leaf.boot = leaf.provider || leaf.model ? null : typeof PROV !== "undefined" && PROV.view ? agentDefaultModel(agentId) : "pending";
  const p = createTab(spec, { fresh: !o.spec, mount: mount || undefined });
  const T = TAB_LIST[TAB_LIST.length - 1];
  leaf.tab = T; T.leaf = leaf;
  p.then((tab) => {
    if (!tab || !TAB_LIST.includes(tab)) {
      // 护栏拒绝了（createTab 已经把原因说过了）：这一格回到「放哪个 Agent」。
      if (leaf.tab === T) { leaf.tab = null; leaf.agent = null; leaf.paneId = 0; leaf.v++; render(); saveLayout(); }
      return;
    }
    if (tab.paneID) leaf.paneId = tab.paneID;
    if (!o.spec) armFreshCell(tab, "台面新开一格");
    if (!o.quiet) setActive(tab);
    leaf.v++; render(); saveLayout();
  }).catch((e) => jserr("assign", e));
  return T;
}
// 格子停了（agent 自己退出了 / 进程没了）：同一个 paneId 接着来 —— 有会话就接回那条，没有就新起一条。
function reseatLeaf(leaf) {
  const T = leaf.tab;
  if (!T) return;
  const sid = T.sessionID || (T.spec && T.spec.resume && T.spec.resume.kind === "exact" ? T.spec.resume.id : "");
  const spec = { agent: leaf.agent, cwd: (T.spec && T.spec.cwd) || leaf.proj, target: "legacy",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" }, paneId: T.paneID || leaf.paneId || undefined };
  closeTab(T, { reseat: true, why: "格子停了，接着来" });
  leaf.tab = null;
  assign(leaf, leaf.agent, { spec });
}
// 接回一个关掉的 agent（记录还在 panes.json）：同一个 paneId + exact 起一格。
function reattach(leaf, r) {
  if (!r) return;
  if (r.closing) { toast("它还在收尾，过一秒再接", "warn"); return; }
  if (closedUnresumable(r)) { toast(closedWhy(r), "warn"); return; }
  const live = r.sessionId ? tabForSession(r.sessionId) : null;
  if (live) { jumpToTab(live, "这条会话已经在跑"); toast("这条会话已经在另一格里跑着，带你过去"); return; }
  CLOSED_PANES.delete(r.paneId | 0);
  leaf.proj = ownerProjectPath(r.cwd) || leaf.proj;
  const agent = r.agent || defAgent();
  assign(leaf, agent, { spec: { agent, cwd: r.cwd || "", target: "legacy",
    resume: r.sessionId ? { kind: "exact", id: r.sessionId } : { kind: "new", id: "" }, paneId: (r.paneId | 0) || undefined } });
}
// 这一格现在是什么状态（格头的点、块的边框、Dock 的铃铛都读它）。判据全在 22-live.js 的 cellState。
function leafState(l) {
  if (!l.tab) return "idle";
  const s = cellState(l.tab);
  return s === "working" ? "work" : s === "ask" ? "wait" : s === "off" ? "off" : s === "unread" ? "done" : s === "failed" ? "fail" : "idle";
}

/* ---------- 渲染 ---------- */
const ZEL = new Map(), TEL = new Map(), TABEL = new Map();
const tabsEl = qs("#tabs");
const zonesEl = qs("#zones");
function front(z) { if (z && z.zi !== ZTOP) { z.zi = ++ZTOP; const el = ZEL.get(z.id); if (el) el.style.zIndex = z.zi; } }
/* ---------- 收起成标签 ---------- */
function tabHTML(z) {
  const [t] = zoneTitle(z);
  let ic = "", st = "", wait = 0;
  const k = ZONE_KINDS[z.kind];
  if (z.kind === "agents") {
    const ls = leaves(z.root).filter((l) => l.agent);
    ic = ls.slice(0, 4).map((l) => `<span class="tl ${leafState(l)}">${logo(l.agent)}</span>`).join("") || `<span class="tl">${ICON("sparkles", 14)}</span>`;
    const w = ls.filter((l) => leafState(l) === "work").length;
    wait = ls.filter((l) => leafState(l) === "wait").length;
    st = (w ? `${w} 在跑` : "空闲") + (wait ? ` · <em>${wait} 等你</em>` : "");
  } else if (k && k.tab) {
    ({ ic, st, wait } = k.tab(z));
  } else { ic = `<span class="tl">${ICON("square-dashed-mouse-pointer", 14)}</span>`; st = "还没选种类"; }
  return { wait, html: `<span class="tic">${ic}</span><b>${esc(t)}</b><span class="tst">${st}</span><button data-zexpand title="展开">${ICON("maximize-2", 13)}</button>` };
}
function renderTab(z) {
  let el = TABEL.get(z.id);
  if (!z.collapsed) { if (el) { el.remove(); TABEL.delete(z.id); } return; }
  if (!el) { el = document.createElement("div"); el.className = "ztab"; el.dataset.ztab = z.id; tabsEl.appendChild(el); TABEL.set(z.id, el); el._k = ""; }
  el.style.left = z.tab.x + "px"; el.style.top = z.tab.y + "px";
  const sm = tabHTML(z);
  el.classList.toggle("wait", sm.wait > 0);
  if (el._k !== sm.html) { el._k = sm.html; el.innerHTML = sm.html; }
}
function collapseZone(z) {
  if (z.collapsed) return;
  z.collapsed = true; z.focus = null;
  z.tab = z.tab || { x: z.x + 6, y: z.y + 2 };
  render();
  saveLayout();
}
// 展开回原位；原位被别的块占了（不允许重叠时）就找块空地，还找不到就留在标签上并说明原因。
function expandZone(z, quiet) {
  if (!z.collapsed) return true;
  const d = desk(), mn = zoneMin(z);
  let r = { x: z.x, y: z.y, w: Math.min(z.w, d.w), h: Math.min(z.h, d.h) };
  r.x = clampN(r.x, d.x, d.x + d.w - r.w); r.y = clampN(r.y, d.y, d.y + d.h - r.h);
  if (blocker(r, z.id)) {
    const sz = [[r.w, r.h], [r.w * 0.85, r.h * 0.85], [r.w * 0.7, r.h * 0.7], [0, 0]].map(([w, h]) => [Math.max(mn.w, Math.round(w)), Math.max(mn.h, Math.round(h))]);
    const alt = findFree(sz);
    if (!alt) {
      if (!quiet) toast("原来的位置被占了，台面上也没空地 —— 先收起别的块，或者打开「允许重叠」", "warn");
      pingEl(TABEL.get(z.id));
      return false;
    }
    r = alt;
    if (!quiet) toast("原来的位置被占了，放到了旁边的空地");
  }
  Object.assign(z, r); z.collapsed = false; z.zi = ++ZTOP; z.pre = null;
  render(); pingEl(ZEL.get(z.id));
  saveLayout();
  return true;
}
// 全部收起：标签沿着 Dock 排开（Dock 在下就排在它上面，在左就竖着排在它右边）
function collapseAll() {
  const open = Z.filter((z) => !z.collapsed);
  if (!open.length) { expandAll(); return; }
  for (const z of open) { z.collapsed = true; z.focus = null; z.tab = z.tab || { x: z.x, y: z.y }; }
  render();
  lineUpTabs(Z.filter((z) => z.collapsed));
  saveLayout();
}
function lineUpTabs(zs) {
  const side = dockSide(), dr = dockEl.getBoundingClientRect(), G = 8;
  const els = zs.map((z) => TABEL.get(z.id));
  if (side === "left" || side === "right") {
    const total = els.reduce((s, e) => s + e.offsetHeight + G, -G);
    let y = clampN(dr.top + dr.height / 2 - total / 2, 12, innerHeight - total - 12);
    zs.forEach((z, i) => { const e = els[i]; z.tab = { x: side === "left" ? dr.right + 14 : dr.left - e.offsetWidth - 14, y }; y += e.offsetHeight + G; });
  } else {
    const maxW = innerWidth - 160, rows = [[]];
    let rw = 0;
    els.forEach((e, i) => { const w = e.offsetWidth + G; if (rw + w > maxW && rows[rows.length - 1].length) { rows.push([]); rw = 0; } rows[rows.length - 1].push(i); rw += w; });
    const h = (els[0] ? els[0].offsetHeight : 40) + G;
    rows.forEach((row, ri) => {
      const total = row.reduce((s, i) => s + els[i].offsetWidth + G, -G);
      let x = innerWidth / 2 - total / 2;
      const y = side === "top" ? dr.bottom + 14 + ri * h : dr.top - 14 - (rows.length - ri) * h + G;
      for (const i of row) { zs[i].tab = { x, y }; x += els[i].offsetWidth + G; }
    });
  }
  render();
}
function expandAll() {
  const cs = Z.filter((z) => z.collapsed).sort((a, b) => a.zi - b.zi);
  let left = 0;
  for (const z of cs) if (!expandZone(z, true)) left++;
  if (left) toast(`还有 ${left} 块放不下，留在标签上了 —— 先收起别的块，或者打开「允许重叠」`, "warn");
}
function startTabDrag(z, x0, y0) {
  const el = TABEL.get(z.id);
  const s = { x: z.tab.x, y: z.tab.y };
  let moved = false;
  return {
    move(x, y) {
      if (!moved && Math.hypot(x - x0, y - y0) < 5) return;
      moved = true; el.classList.add("dragging");
      z.tab.x = clampN(s.x + x - x0, 6, innerWidth - el.offsetWidth - 6);
      z.tab.y = clampN(s.y + y - y0, 6, innerHeight - el.offsetHeight - 6);
      el.style.left = z.tab.x + "px"; el.style.top = z.tab.y + "px";
    },
    up() { el.classList.remove("dragging"); if (!moved) expandZone(z); else saveLayout(); },
  };
}
const soloLeaf = (z) => z.kind === "agents" && z.root && z.root.t === "leaf" && z.root.agent ? z.root : null;
function zoneTitle(z) {
  const k = ZONE_KINDS[z.kind];
  if (k && k.title) return k.title(z);
  if (z.kind === "new") return ["新的一块", "选一下这块拿来干什么"];
  const ls = leaves(z.root);
  const named = ls.filter((l) => l.agent);
  const projs = [...new Set(named.map((l) => projName(l.proj)))].join(" · ");
  if (ls.length === 1) return named.length ? [ag(ls[0].agent).name, projName(ls[0].proj)] : ["单个 Agent", ""];
  return [`并行 · ${ls.length} 格`, projs];
}
function zoneShell(z) {
  const el = document.createElement("div");
  el.className = "zone";
  el.dataset.zone = z.id;
  el.innerHTML = `<div class="zh"><span class="grip">${ICON("grip-horizontal", 14)}</span><b class="zt"></b><span class="zk"></span><span class="sp"></span>`
    + `<span class="zx"></span><button type="button" data-zcollapse title="收起成标签">${ICON("minimize-2", 14)}</button><button type="button" data-zact="close" title="关掉这一块">${ICON("x", 14)}</button></div><div class="zb"></div>`
    + ["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((k) => `<div class="rz" data-rz="${k}"></div>`).join("");
  zonesEl.appendChild(el);
  return el;
}
// 一格的小控件（状态点；模型、碰过的文件在各自的模块里补）：多格时在格头，单格时搬到块头。
const LEAF_CTL = [];   // 其他模块往这里加：(leaf) => html
function leafCtlHTML(l) {
  return LEAF_CTL.map((f) => f(l)).join("") + `<i class="dot ${leafState(l)}" title="${esc(stateWord(l))}"></i>`;
}
function stateWord(l) {
  const s = leafState(l);
  return s === "work" ? "在干活" : s === "wait" ? (l.ask ? "在等你：" + l.ask : "在等你") : s === "done" ? "跑完了一轮，还没看" : s === "off" ? "停了" : s === "fail" ? "出错了" : "空闲";
}
function render() {
  syncLeaves();
  for (const z of Z) {
    let el = ZEL.get(z.id);
    if (!el) { el = zoneShell(z); ZEL.set(z.id, el); }
    el.style.left = z.x + "px"; el.style.top = z.y + "px"; el.style.width = z.w + "px"; el.style.height = z.h + "px";
    el.style.zIndex = z.zi;
    el.classList.toggle("collapsed", !!z.collapsed);
    renderTab(z);
    el.classList.toggle("live", !!z.live);
    const solo = soloLeaf(z);
    el.classList.toggle("solo", !!solo);
    const [t, k] = zoneTitle(z);
    const zt = qs(".zt", el);
    if (zt.textContent !== t && !(document.activeElement && document.activeElement.matches && document.activeElement.matches("[data-gf=name]"))) zt.textContent = t;
    const zk = qs(".zk", el);
    if (zk.textContent !== k) zk.textContent = k;
    const zx = qs(".zx", el);
    const zxKey = solo ? solo.id + ":" + leafKey(solo) : "";
    if (zx._k !== zxKey) { zx._k = zxKey; zx.innerHTML = solo ? leafCtlHTML(solo) : ""; }
    const zb = qs(".zb", el);
    const kind = ZONE_KINDS[z.kind];
    if (z.kind === "new") {
      if (zb.dataset.mode !== "new") {
        zb.dataset.mode = "new";
        zb.innerHTML = `<div class="choose">`
          + `<button class="ch" data-choose="par"><span class="ic">${ICON("layout-dashboard", 22)}</span><b>并行 Agents</b><span>一块里放几个 agent，大小自己切</span></button>`
          + `<button class="ch" data-choose="one"><span class="ic">${ICON("sparkles", 22)}</span><b>单个 Agent</b><span>专心盯一个</span></button>`
          + `<button class="ch" data-choose="group"><span class="ic">${ICON("users-round", 22)}</span><b>Bot Group</b><span>一个目标，一队 Bot 分工</span></button>`
          + `<button class="ch" data-choose="files"><span class="ic">${ICON("folder-tree", 22)}</span><b>文件</b><span>看项目里的文件和 agent 改了什么</span></button></div>`;
      }
    } else if (kind && kind.render) {
      if (zb.dataset.mode !== z.kind) { zb.dataset.mode = z.kind; zb.innerHTML = ""; zb._sk = ""; zb._k = ""; }
      kind.render(z, zb);
    } else {
      if (zb.dataset.mode !== "agents") { zb.dataset.mode = "agents"; zb.innerHTML = ""; }
      renderTiles(z, zb);
    }
  }
  for (const [id, el] of ZEL) if (!Z.some((z) => z.id === id)) { el.remove(); ZEL.delete(id); }
  for (const [id, el] of TABEL) if (!Z.some((z) => z.id === id)) { el.remove(); TABEL.delete(id); }
  document.body.classList.toggle("has-zones", Z.length > 0);
  syncDock();
  for (const f of AFTER_RENDER) f();
}
// 其他模块的面板跟着台面一起刷新（各自按签名判断要不要重画，别每帧整块重建）。
const AFTER_RENDER = [];
// 格子和标签对象对一下账：标签没了（被护栏撤掉 / 关掉）的格子回到空格；paneId 到了记下来。
function syncLeaves() {
  let changed = false;
  for (const { l } of allLeaves()) {
    if (l.tab && !TAB_LIST.includes(l.tab)) { l.tab = null; l.agent = null; l.v++; changed = true; }
    if (l.tab && l.tab.paneID && l.paneId !== l.tab.paneID) { l.paneId = l.tab.paneID; changed = true; }
    if (l.tab) {
      const st = leafState(l);
      const row = st === "wait" ? needModel().rows.find((r) => r.t === l.tab) : null;
      const ask = row ? (row.text || needWhy(row.kind)) : "";
      if (st !== l.state || ask !== l.ask) { l.state = st; l.ask = ask; l.v++; }
    }
  }
  if (changed) saveLayout();
}
// 格头要不要重画的签名：格子的版本 + 标签的名字（agent 自己报的标题会变）。
const leafKey = (l) => l.v + ":" + (l.tab ? currentTabTitle(l.tab) : "") + ":" + LEAF_CTL.length;
function renderTiles(z, zb) {
  const { tiles, divs } = zoneLayout(z);
  const ids = new Set(tiles.map((t) => t.leaf.id));
  for (const el of qsa(".tile", zb)) if (!ids.has(el.dataset.leaf)) el.remove();
  const full = bodyRect(z);
  for (const { leaf, rc } of tiles) {
    let el = TEL.get(leaf.id);
    if (!el) { el = document.createElement("div"); el.className = "tile"; el.dataset.leaf = leaf.id; TEL.set(leaf.id, el); el._v = ""; el._mode = ""; }
    if (el.parentNode !== zb) zb.appendChild(el);
    const r = z.focus ? (z.focus === leaf.id ? full : rc) : rc;
    el.style.left = r.x + "px"; el.style.top = r.y + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px";
    el.classList.toggle("hid", !!z.focus && z.focus !== leaf.id);
    el.classList.toggle("small", r.w < 330 || r.h < 230);
    el.classList.toggle("empty", !leaf.agent);
    el.classList.toggle("st-wait", leaf.state === "wait");
    el.classList.toggle("cur", !!leaf.tab && leaf.tab === activeTab);
    const mode = leaf.tab ? "agent" : "pick";
    if (el._mode !== mode) {
      el._mode = mode; el._v = "";
      // 终端那一层建一次：之后只换格头，.tterm 里的终端元素一个字节都不碰。
      el.innerHTML = mode === "agent"
        ? `<div class="th"></div><div class="tterm"></div><button class="tb-new" data-tbnew hidden>有新内容 ↓</button>`
          + `<div class="tstop" hidden></div>`
          + ["right", "bottom", "left", "top"].map((s) => `<button class="plus" data-plus="${s}" title="往${{ right: "右", bottom: "下", left: "左", top: "上" }[s]}切出一格">${ICON("plus", 11, 2.6)}</button>`).join("")
        : `<div class="tpick"></div>`;
    }
    if (mode === "agent") {
      const host = qs(".tterm", el);
      if (leaf.tab.cellEl && leaf.tab.cellEl.parentNode !== host) host.appendChild(leaf.tab.cellEl);
      hookTerm(leaf);
      const key = leafKey(leaf) + ":" + (z.focus === leaf.id ? 1 : 0);
      if (el._v !== key) {
        el._v = key;
        qs(".th", el).innerHTML = tileHeadHTML(leaf, z.focus === leaf.id);
        const stop = qs(".tstop", el);
        const off = leaf.state === "off";
        stop.hidden = !off;
        if (off) stop.innerHTML = `<span>${esc(ag(leaf.agent).name)} 停了</span><button class="btn pri" data-reseat>${ICON("rotate-ccw", 13)}接着来</button>`;
      }
      const nb = qs(".tb-new", el); if (nb) nb.hidden = !leaf.unseen;
    } else {
      const key = "p:" + leaf.v + ":" + (leaf.installing || "") + ":" + CATALOG_SIG + ":" + projSig();
      if (el._v !== key) { el._v = key; qs(".tpick", el).innerHTML = pickHTML(leaf); }
    }
  }
  for (const d of qsa(".dv", zb)) d.remove();
  if (!z.focus) for (const d of divs) {
    const e = document.createElement("div");
    e.className = "dv " + d.sp.dir;
    e.style.left = d.at.x + "px"; e.style.top = d.at.y + "px"; e.style.width = d.at.w + "px"; e.style.height = d.at.h + "px";
    e._d = d;
    if (z.live && z.dragSplit === d.sp) e.classList.add("on");
    zb.appendChild(e);
  }
}
const projSig = () => PROJECTS().map((p) => p.path).join("|") + "#" + [...CLOSED_PANES.keys()].join(",");
// 会话标题可能是用户第一句话的原文，里面夹着 <bash-input> 这类标签：显示时剥掉，太长就截。
const plainTitle = (s) => { const v = String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); return v.length > 28 ? v.slice(0, 27) + "…" : v; };
function tileHeadHTML(l, focused) {
  const a = ag(l.agent);
  const live = l.tab ? realTabTitle(l.tab) : "";
  // 聚焦（占满整块）时多一颗「回去」：键盘在终端里时 Esc 是 agent 的键，得有个点得到的出口。
  return `${logo(l.agent)}<b>${esc(a.name)}</b><span class="pj" title="${esc(live || l.proj)}">${esc(projName(l.proj))}</span><span class="sp"></span>`
    + leafCtlHTML(l) + (focused ? `<button class="x on" data-unfocus title="回到并排（双击格头也行）">${ICON("shrink", 13)}</button>` : "")
    + `<button class="x" data-tclose title="关掉这一格（记录留着，之后能接回）">${ICON("x", 13)}</button>`;
}
/* 格子里能往上翻看上下文：停在最底下就跟着新内容走；翻上去了就原地不动，提示「有新内容」。
   终端自己会滚，这里只读它的视口：viewportY < baseY = 用户往上翻着。 */
function hookTerm(leaf) {
  const T = leaf.tab;
  if (!T || !T.term || T._deskHooked) return;
  T._deskHooked = true;
  const atBottom = () => { const b = T.term.buffer.active; return b.viewportY >= b.baseY; };
  const pill = () => { const el = TEL.get(leaf.id); const nb = el && qs(".tb-new", el); if (nb) nb.hidden = !leaf.unseen; };
  T.term.onScroll(() => { if (leaf.unseen && atBottom()) { leaf.unseen = false; pill(); } });
  T.term.onWriteParsed(() => { if (!leaf.unseen && !atBottom()) { leaf.unseen = true; pill(); } });
}
function pickHTML(l) {
  if (l.installing) {
    const id = l.installing, s = INST[id];
    return `<div class="pick inst"><span class="inst-ic">${agiHTML(id)}</span><b>正在装 ${esc(ag(id).name)}</b>`
      + `<span class="inst-t" data-insttxt="${id}">${instPhase(s)} ${Math.round(s ? s.pct : 0)}%</span>`
      + `<em>从官方渠道下载安装，装好就在这一格里启动；只装一次，以后哪里都能直接用。</em><button class="btn" data-instcancel>换一个</button></div>`;
  }
  const da = defAgent();
  const ps = PROJECTS();
  const back = closedList().filter((r) => !r.closing && insidePath(r.cwd || defaultAreaPath(), l.proj)).slice(0, 3);
  const someMissing = agentList().some((a) => !a.installed);
  return `<div class="pick"><h4>这一格放哪个 Agent？${someMissing ? `<span class="pk-ni">灰色的还没装：鼠标移上去点一下，就地下载</span>` : ""}</h4><div class="pk-g">`
    + agentList().map((a) => `<button class="pk-a${a.id === da ? " def" : ""}${a.installed ? "" : " ni"}" data-pick="${a.id}" title="${esc(a.name)}${a.installed ? "" : a.canInstall ? "（还没装，点了就地下载）" : "（还没装）"}">${agiHTML(a.id)}${agLabel(a, agShort(a))}</button>`).join("")
    + `</div><div class="pk-p">在${ps.map((p) => `<button data-proj="${esc(p.path)}" class="${normPath(p.path) === normPath(l.proj) ? "on" : ""}" title="${esc(p.path)}">${esc(p.name)}</button>`).join("")}`
    + (ps.length ? "" : `<button class="on" title="${esc(defaultAreaPath())}">默认工作区</button>`)
    + `<button class="add" data-projadd title="加一个文件夹">+ 文件夹</button>里干活</div>`
    + (back.length ? `<div class="pk-back"><span>接回上次关掉的：</span>${back.map((r) => `<button data-reattach="${r.paneId}" title="${esc(r.cwd || "")}">${logo(r.agent)}${esc(plainTitle(closedRowName(r)))}</button>`).join("")}</div>` : "")
    + `</div>`;
}

const zoneOfEl = (el) => Z.find((z) => z.id === (el.closest(".zone") || {}).dataset?.zone);
function leafOfEl(el) {
  const host = el.closest("[data-leaf]");
  if (!host) return null;
  const z = zoneOfEl(host);
  const leaf = z && leaves(z.root).find((l) => l.id === host.dataset.leaf);
  return leaf ? { z, leaf, el: TEL.get(leaf.id) } : null;
}
function pingEl(el) { if (!el) return; el.classList.remove("ping"); void el.offsetWidth; el.classList.add("ping"); }
function bump(z) { const el = z && ZEL.get(z.id); if (!el) return; el.classList.add("bump"); clearTimeout(el._b); el._b = setTimeout(() => el.classList.remove("bump"), 420); }
function armDraw(d, msg) { DRAW = d; document.body.classList.add("drawing"); syncDock(); if (msg) toast(msg); }
// 在某个项目里开一个默认 Agent：台面上找块空地，找不到就让你圈一块。
function openAgentIn(proj, agentId) {
  closePops();
  const a = agentId || defAgent();
  const r = findFree([[520, 340], [420, 280], [ZMIN_NEW.w + 40, ZMIN_NEW.h + 20]]);
  if (r) { const z = addZone(r, "one", { proj, agent: a }); pingEl(ZEL.get(z.id)); return z; }
  armDraw({ kind: "one", proj, agent: a }, `台面上没有空地了：圈一块给 ${projName(proj)} 里的新 agent`);
  return null;
}

/* ---------- 拖拽控制器 ---------- */
const ghost = qs("#ghost"), drop = qs("#drop"), dragi = qs("#dragi"), dockEl = qs("#dock"), snapEl = qs("#snap");
function startDraw(x0, y0) {
  const d = desk();
  x0 = clampN(x0, d.x, d.x + d.w); y0 = clampN(y0, d.y, d.y + d.h);
  let r = { x: x0, y: y0, w: 0, h: 0 }, moved = false;
  return {
    move(x, y) {
      x = clampN(x, d.x, d.x + d.w); y = clampN(y, d.y, d.y + d.h);
      r = { x: Math.min(x0, x), y: Math.min(y0, y), w: Math.abs(x - x0), h: Math.abs(y - y0) };
      if (!moved && r.w + r.h < 8) return;
      moved = true;
      ghost.hidden = false;
      Object.assign(ghost.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
      const small = r.w < ZMIN_NEW.w || r.h < ZMIN_NEW.h;
      ghost.classList.toggle("small", small);
      ghost.classList.toggle("bad", !small && !!blocker(r));
      ghost.firstChild.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    },
    up() {
      ghost.hidden = true;
      if (!moved) return;
      const dr = DRAW;
      if (r.w < ZMIN_NEW.w || r.h < ZMIN_NEW.h) { if (r.w + r.h > 40) toast(`太小了：一块至少 ${ZMIN_NEW.w}×${ZMIN_NEW.h}`, "warn"); return; }
      const b = blocker(r);
      if (b) { bump(b); toast("和别的块叠在一起了 —— 块和块互不干扰，换块空地再圈", "warn"); return; }
      DRAW = null; document.body.classList.remove("drawing"); syncDock();
      addZone(r, dr && dr.kind, dr || {});
    },
  };
}
function startMove(z, x0, y0) {
  const s = { x: z.x, y: z.y };
  // 已经叠着的（关掉重叠之前叠上的）不挡路，好让它挪出来
  const ex = new Set([z.id, ...Z.filter((o) => o !== z && !o.collapsed && hit(z, o)).map((o) => o.id)]);
  z.live = true; front(z);
  return {
    move(x, y) {
      const d = desk();
      const nx = clampN(s.x + x - x0, d.x, d.x + d.w - z.w), ny = clampN(s.y + y - y0, d.y, d.y + d.h - z.h);
      const tries = [{ x: nx, y: ny }, { x: nx, y: z.y }, { x: z.x, y: ny }];
      let ok = null, hitZ = null;
      for (const p of tries) { const b = blocker({ x: p.x, y: p.y, w: z.w, h: z.h }, ex); if (!b) { ok = p; break; } hitZ = hitZ || b; }
      if (ok) { z.x = ok.x; z.y = ok.y; }
      if (hitZ && (!ok || ok.x !== nx || ok.y !== ny)) bump(hitZ);
      render();
    },
    up() { z.live = false; z.pre = null; render(); saveLayout(); },
  };
}
function startResize(z, edge, x0, y0) {
  const s = { x: z.x, y: z.y, w: z.w, h: z.h };
  const mn = zoneMin(z);
  const ex = new Set([z.id, ...Z.filter((o) => o !== z && !o.collapsed && hit(z, o)).map((o) => o.id)]);
  z.live = true; front(z);
  return {
    move(x, y) {
      const dx = x - x0, dy = y - y0;
      let { x: nx, y: ny, w: nw, h: nh } = s;
      if (edge.includes("e")) nw = Math.max(mn.w, s.w + dx);
      if (edge.includes("s")) nh = Math.max(mn.h, s.h + dy);
      if (edge.includes("w")) { nw = Math.max(mn.w, s.w - dx); nx = s.x + s.w - nw; }
      if (edge.includes("n")) { nh = Math.max(mn.h, s.h - dy); ny = s.y + s.h - nh; }
      const r = { x: nx, y: ny, w: nw, h: nh };
      const b = blocker(r, ex);
      if (b) { bump(b); return; }
      if (!inDesk(r)) return;
      Object.assign(z, r);
      render();
    },
    up() { z.live = false; z.pre = null; render(); saveLayout(); },
  };
}
function startDivider(z, d, x0, y0) {
  const zbR = qs(".zb", ZEL.get(z.id)).getBoundingClientRect();
  const { sp, rc } = d;
  z.live = true; z.dragSplit = sp;
  return {
    move(x, y) {
      if (sp.dir === "h") {
        const span = rc.w - GAP;
        sp.r = clampN((x - zbR.left - rc.x - GAP / 2) / span, minW(sp.a) / span, 1 - minW(sp.b) / span);
      } else {
        const span = rc.h - GAP;
        sp.r = clampN((y - zbR.top - rc.y - GAP / 2) / span, minH(sp.a) / span, 1 - minH(sp.b) / span);
      }
      render();
    },
    up() { z.live = false; z.dragSplit = null; render(); saveLayout(); },
  };
}
function trayTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.closest("#dock,#tray,.pop,.ztab")) return null;
  const tile = el.closest(".tile");
  const lf = tile && leafOfEl(tile);
  if (lf && lf.z.kind === "agents") {
    const r = lf.el.getBoundingClientRect();
    if (!lf.leaf.agent) return { kind: "fill", ...lf, box: r };
    const px = (x - r.left) / r.width, py = (y - r.top) / r.height;
    const side = [["left", px], ["right", 1 - px], ["top", py], ["bottom", 1 - py]].sort((a, b) => a[1] - b[1])[0][0];
    const box = side === "left" ? { left: r.left, top: r.top, width: r.width / 2, height: r.height }
      : side === "right" ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
      : side === "top" ? { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
      : { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 };
    return { kind: "split", side, ...lf, box };
  }
  const zEl = el.closest(".zone");
  if (zEl) {
    const z = zoneOfEl(zEl);
    const k = z && ZONE_KINDS[z.kind];
    if (k && k.drop) return { kind: "zone", z, box: qs(".zb", zEl).getBoundingClientRect(), label: k.dropLabel };
    return null;
  }
  const d = desk();
  const w = 520, h = 340;
  const r = { x: clampN(x - w / 2, d.x, d.x + d.w - w), y: clampN(y - h / 2, d.y, d.y + d.h - h), w, h };
  return { kind: "desk", r, bad: !!blocker(r), box: { left: r.x, top: r.y, width: w, height: h } };
}
function startTray(agentId, x0, y0) {
  const a = ag(agentId);
  dragi.src = a.file ? "icons/agents/" + encodeURIComponent(a.file) : "";
  dragi.className = a.mono ? "mono" : "";
  dragi.hidden = false;
  let tg = null;
  const place = (x, y) => {
    dragi.style.left = x + "px"; dragi.style.top = y + "px";
    tg = trayTarget(x, y);
    drop.hidden = !tg;
    if (!tg) return;
    Object.assign(drop.style, { left: tg.box.left + "px", top: tg.box.top + "px", width: tg.box.width + "px", height: tg.box.height + "px" });
    drop.classList.toggle("bad", !!tg.bad);
    drop.firstChild.textContent = tg.kind === "zone" ? (tg.label ? tg.label(a) : "") : tg.kind === "desk" ? "在这里新开一块" : tg.kind === "fill" ? "放进这一格" : "";
  };
  place(x0, y0);
  return {
    move: place,
    up() {
      dragi.hidden = true; drop.hidden = true;
      if (!tg) return;
      if (tg.kind === "fill") { placeAgent(tg.leaf, agentId); render(); }
      else if (tg.kind === "split") splitLeaf(tg.z, tg.leaf, tg.side, agentId);
      else if (tg.kind === "zone") ZONE_KINDS[tg.z.kind].drop(tg.z, agentId);
      else if (tg.kind === "desk") {
        if (tg.bad) { toast("这里放不下一块 —— 换块空地", "warn"); return; }
        addZone(tg.r, "one", { agent: agentId });
      }
    },
  };
}
/* Dock 拖动：离左右边近就竖过来，离上下边近就横着贴边，否则就浮在那里 */
const SNAP_PX = 120;
function snapEdgeAt(x, y) {
  const W = innerWidth, H = innerHeight;
  const c = [["left", x], ["right", W - x], ["top", y], ["bottom", H - y]].sort((a, b) => a[1] - b[1])[0];
  return c[1] < SNAP_PX ? c[0] : null;
}
function startDockDrag(x0, y0) {
  closePops();
  const r0 = dockEl.getBoundingClientRect();
  let fx = (x0 - r0.left) / r0.width, fy = (y0 - r0.top) / r0.height;
  let vert = dockEl.classList.contains("vert");
  dockEl.classList.add("dragging");
  let edge = null, lx = r0.left, ly = r0.top;
  const place = (x, y) => {
    edge = snapEdgeAt(x, y);
    const wantVert = edge === "left" || edge === "right";
    if (wantVert !== vert) { vert = wantVert; dockEl.classList.toggle("vert", vert); buildDock(); [fx, fy] = [fy, fx]; }
    for (const e of ["left", "right", "top", "bottom"]) dockEl.classList.toggle("at-" + e, edge === e);
    const w = dockEl.offsetWidth, h = dockEl.offsetHeight;
    lx = clampN(x - fx * w, 8, innerWidth - w - 8); ly = clampN(y - fy * h, 8, innerHeight - h - 8);
    dockEl.style.left = lx + "px"; dockEl.style.top = ly + "px";
    snapEl.hidden = !edge;
    if (edge) {
      const W = innerWidth, H = innerHeight;
      const s = edge === "left" ? { left: 4, top: H * 0.15, width: 4, height: H * 0.7 } : edge === "right" ? { left: W - 8, top: H * 0.15, width: 4, height: H * 0.7 }
        : edge === "top" ? { left: W * 0.15, top: 4, width: W * 0.7, height: 4 } : { left: W * 0.15, top: H - 8, width: W * 0.7, height: 4 };
      Object.assign(snapEl.style, { left: s.left + "px", top: s.top + "px", width: s.width + "px", height: s.height + "px" });
    }
  };
  place(x0, y0);
  return {
    move: place,
    up(x, y) {
      dockEl.classList.remove("dragging");
      snapEl.hidden = true;
      if (edge) DK = { mode: "edge", edge, t: edge === "left" || edge === "right" ? clampN(y / innerHeight, 0.1, 0.9) : clampN(x / innerWidth, 0.1, 0.9) };
      else DK = { mode: "free", x: lx, y: ly };
      save(); layoutDock(); fitZones();
    },
  };
}

/* ---------- 鼠标 ----------
   ⚠️ 终端是格子里的一等公民：按在终端上的鼠标、键盘一律归终端（选字、滚动、TUI 的鼠标模式）。
   这里只在**终端之外**做台面自己的事 —— 圈块、拖块、拖缝、点按钮。 */
const inTerm = (el) => !!(el && el.closest && el.closest(".tterm"));
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const t = e.target;
  const tr = t.closest("[data-tray]");
  if (tr) { e.preventDefault(); DRAG = startTray(tr.dataset.tray, e.clientX, e.clientY); return; }
  if (t.closest("#dock")) {
    // 按住 Dock 任何地方（包括按钮）拖开 5px 以上 = 搬 Dock；没拖开就是普通点击
    const x0 = e.clientX, y0 = e.clientY;
    let inner = null;
    if (t.closest(".dgrip")) { e.preventDefault(); inner = startDockDrag(x0, y0); }
    DRAG = {
      move(x, y) { if (!inner && Math.hypot(x - x0, y - y0) > 5) inner = startDockDrag(x0, y0); if (inner) inner.move(x, y); },
      up(x, y) { if (inner) { inner.up(x, y); SUPPRESS_CLICK = Date.now(); } },
    };
    return;
  }
  if (t.closest("#tray,.pop,#toast,.sheet-host")) return;
  // 点到格子以外的地方：键盘从终端里退出来（不然 Esc 永远是终端的，台面的 Esc 一次都轮不到）。
  if (!t.closest(".tile") && inTerm(document.activeElement)) document.activeElement.blur();
  closePops();
  if (!t.closest(".peek,[data-tfiles]")) closePeeks();
  const tabEl = t.closest(".ztab");
  if (tabEl) { if (!t.closest("button")) { e.preventDefault(); DRAG = startTabDrag(Z.find((z) => z.id === tabEl.dataset.ztab), e.clientX, e.clientY); } return; }
  const zon = t.closest(".zone");
  if (zon) front(zoneOfEl(zon));
  // 点到哪一格，哪一格就是当前格（键盘归它）。
  const tile = t.closest(".tile");
  if (tile) { const lf = leafOfEl(tile); if (lf && lf.leaf.tab && lf.leaf.tab !== activeTab) setActive(lf.leaf.tab); }
  if (inTerm(t)) return;
  const dv = t.closest(".dv");
  if (dv) { e.preventDefault(); DRAG = startDivider(zoneOfEl(dv), dv._d, e.clientX, e.clientY); return; }
  const rz = t.closest("[data-rz]");
  if (rz) { e.preventDefault(); DRAG = startResize(zoneOfEl(rz), rz.dataset.rz, e.clientX, e.clientY); return; }
  const zh = t.closest(".zh");
  if (zh && !t.closest("button,input")) { e.preventDefault(); DRAG = startMove(zoneOfEl(zh), e.clientX, e.clientY); return; }
  if (t.closest(".zone")) return;
  e.preventDefault();
  DRAG = startDraw(e.clientX, e.clientY);
});
document.addEventListener("pointermove", (e) => { if (DRAG) DRAG.move(e.clientX, e.clientY); });
document.addEventListener("pointerup", (e) => { if (DRAG) { const d = DRAG; DRAG = null; d.up(e.clientX, e.clientY); } });
// 键盘焦点进到哪一格，哪一格就是当前格（Tab 切进去、IME、程序内 focus 都算）。
zonesEl.addEventListener("focusin", (e) => {
  const tile = e.target.closest && e.target.closest(".tile");
  const lf = tile && leafOfEl(tile);
  if (lf && lf.leaf.tab && lf.leaf.tab !== activeTab) setActive(lf.leaf.tab);
});
function closePeeks() { let ch = false; for (const { l } of allLeaves()) if (l.peek) { l.peek = false; l.v++; ch = true; } if (ch) render(); }
// 其他模块（项目面板、设置、总览……）各自接自己那一块的点击；这里先问它们要不要。
const CLICKS = [];   // (target, event) => true 表示接住了
document.addEventListener("click", (e) => {
  const t = e.target;
  if (Date.now() - SUPPRESS_CLICK < 350 && t.closest("#dock")) return;
  for (const f of CLICKS) if (f(t, e)) return;
  if (inTerm(t)) return;
  const zc = t.closest("[data-zcollapse]");
  if (zc) { const z = zoneOfEl(zc); if (z) collapseZone(z); return; }
  const ze = t.closest("[data-zexpand]");
  if (ze) { const z = Z.find((x) => x.id === ze.closest(".ztab").dataset.ztab); if (z) expandZone(z); return; }
  if (t.closest("#cf")) { const b = t.closest("[data-cf]"); if (b || t.classList.contains("back")) cfDone(!!b && b.dataset.cf === "ok"); return; }
  const zact = t.closest("[data-zact]");
  if (zact) { const z = zoneOfEl(zact); if (z) closeZone(z); return; }
  const ch = t.closest("[data-choose]");
  if (ch) { setKind(zoneOfEl(ch), ch.dataset.choose); return; }
  const lf = leafOfEl(t);
  if (lf) {
    const pk = t.closest("[data-pick]");
    if (pk) { placeAgent(lf.leaf, pk.dataset.pick); render(); return; }
    if (t.closest("[data-instcancel]")) { lf.leaf.installing = null; lf.leaf.v++; render(); toast("下载在后台接着跑，装好以后哪一格都能直接选"); return; }
    const pj = t.closest("[data-proj]");
    if (pj) { lf.leaf.proj = pj.dataset.proj; lf.leaf.v++; render(); saveLayout(); return; }
    if (t.closest("[data-projadd]")) {
      if (typeof openPP === "function") { PENDING_LEAF = lf.leaf; openPP("add"); }
      else toast("添加文件夹还在接入中", "warn");
      return;
    }
    const ra = t.closest("[data-reattach]");
    if (ra) { reattach(lf.leaf, CLOSED_PANES.get(+ra.dataset.reattach)); return; }
    if (t.closest("[data-reseat]")) { reseatLeaf(lf.leaf); return; }
    if (t.closest("[data-unfocus]")) { toggleFocus(lf.z, lf.leaf); return; }
    const pl = t.closest("[data-plus]");
    if (pl) { splitLeaf(lf.z, lf.leaf, pl.dataset.plus); return; }
    if (t.closest("[data-tclose]")) { removeLeaf(lf.z, lf.leaf); return; }
    if (t.closest("[data-tbnew]")) {
      const T = lf.leaf.tab;
      if (T && T.term) T.term.scrollToBottom();
      lf.leaf.unseen = false; t.closest("[data-tbnew]").hidden = true;
      if (T) T.focus();
      return;
    }
  }
  const dk = t.closest("[data-dock]");
  if (dk) { dockAct(dk.dataset.dock, dk); return; }
});
// 双击格头（或单格时的块头）= 这一格占满整块；再双击、或 Esc，回来。
document.addEventListener("dblclick", (e) => {
  if (inTerm(e.target)) return;
  const th = e.target.closest(".th");
  if (th && !e.target.closest("button")) { const lf = leafOfEl(th.closest(".tile")); if (lf) toggleFocus(lf.z, lf.leaf); return; }
});
const ESCS = [];   // 其他模块的 Esc：() => true 表示接住了（浮层一层一层往下关）
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.isComposing) return;
  // Esc 在终端里是 agent 自己的键（Claude Code 靠它打断）—— 台面一个都不拦。
  if (inTerm(e.target)) return;
  for (const f of ESCS) if (f(e)) return;
  if (!qs("#cf").hidden) { cfDone(false); return; }
  if (!qs("#tray").hidden || qsa(".pop:not([hidden])").length) { closePops(); return; }
  closePeeks();
  DRAW = null; document.body.classList.remove("drawing"); syncDock();
  for (const z of Z) if (z.focus) z.focus = null;
  render();
});
function toggleFocus(z, leaf) {
  z.focus = z.focus === leaf.id ? null : leaf.id;
  render();
  if (leaf.tab) leaf.tab.focus();
}

/* ---------- Dock ---------- */
const DOCK = [
  { k: "draw", ic: "square-dashed-mouse-pointer", lb: "圈一块（也可以直接在空白处拖）" },
  { k: "agent", ic: "sparkles", lb: "Agent · 拖到格子边上或空白处" },
  { k: "group", ic: "users-round", lb: "Bot Group" },
  { k: "apps", ic: "layout-grid", lb: "应用 · 搜本机的应用和网页" },
  "|",
  { k: "wait", ic: "bell", lb: "等你处理" },
  { k: "ov", ic: "gauge", lb: "总览" },
  { k: "proj", ic: "folder-open", lb: "项目与文件" },
  { k: "set", ic: "settings-2", lb: "设置" },
  "|",
  { k: "overlap", ic: "layers", lb: "允许块叠在一起" },
  { k: "fold", ic: "minimize-2", lb: "全部收起成标签" },
  "|",
  { k: "stow", ic: "eye-off", lb: "收起 Perch，露出桌面" },
];
// 其他模块的 Dock 动作：k → { act(btn), on() }（on = 那个面板开着时按钮亮着）
const DOCK_ACTS = {};
function buildDock() {
  const vert = dockEl.classList.contains("vert");
  dockEl.innerHTML = `<span class="dgrip" title="按住拖动 Dock">${ICON(vert ? "grip-horizontal" : "grip-vertical", 16)}</span>`
    + DOCK.map((d) => d === "|" ? `<span class="dsep"></span>` : `<button class="dk" data-dock="${d.k}">${ICON(d.ic, 21, 1.7)}<span class="lb">${esc(d.lb)}</span></button>`).join("");
  syncDock();
}
const dockSide = () => DK.mode === "edge" ? DK.edge : (DK.y + 30 > innerHeight / 2 ? "bottom" : "top");
function layoutDock() {
  const vert = DK.mode === "edge" && (DK.edge === "left" || DK.edge === "right");
  const was = dockEl.classList.contains("vert");
  dockEl.classList.toggle("vert", vert);
  if (was !== vert || !dockEl.firstChild) buildDock();
  for (const e of ["left", "right", "top", "bottom"]) dockEl.classList.toggle("at-" + e, DK.mode === "edge" && DK.edge === e);
  const W = innerWidth, H = innerHeight, w = dockEl.offsetWidth, h = dockEl.offsetHeight;
  let x, y;
  if (DK.mode === "free") { x = clampN(DK.x, 8, W - w - 8); y = clampN(DK.y, 8, H - h - 8); }
  else if (DK.edge === "bottom") { x = clampN(DK.t * W - w / 2, 12, W - w - 12); y = H - h - 16; }
  else if (DK.edge === "top") { x = clampN(DK.t * W - w / 2, 12, W - w - 12); y = 14; }
  else if (DK.edge === "left") { x = 16; y = clampN(DK.t * H - h / 2, 12, H - h - 12); }
  else { x = W - w - 16; y = clampN(DK.t * H - h / 2, 12, H - h - 12); }
  dockEl.style.left = x + "px"; dockEl.style.top = y + "px";
  qs("#toast").classList.toggle("low", !(DK.mode === "edge" && DK.edge === "bottom"));
}
/* 等你的：格子里的提问 / 批权限 / 登录门，以及跑完一轮还没看的（22-live.js 的 needModel，未读那一组）；
   再加上各模块自己的（群里等你拍板的事）。 */
const WAIT_SRC = [];   // () => [{ z, l, text }]
function waits() {
  const out = [];
  for (const r of needModel().wait) {
    const x = leafOfTab(r.t);
    if (x) out.push({ z: x.z, l: x.l, text: r.text || needWhy(r.kind), kind: r.kind });
  }
  for (const f of WAIT_SRC) out.push(...f());
  return out;
}
function syncDock() {
  const b = qs('[data-dock="wait"]');
  if (!b) return;
  const w = waits().length;
  let bd = qs(".bd", b);
  if (w && !bd) { bd = document.createElement("span"); bd.className = "bd"; b.appendChild(bd); }
  if (bd) { if (w) bd.textContent = w; else bd.remove(); }
  qs('[data-dock="draw"]').classList.toggle("on", document.body.classList.contains("drawing") && !(DRAW && DRAW.kind));
  qs('[data-dock="group"]').classList.toggle("on", !!DRAW && DRAW.kind === "group");
  qs('[data-dock="agent"]').classList.toggle("on", !qs("#tray").hidden);
  for (const [k, a] of Object.entries(DOCK_ACTS)) { const el = qs(`[data-dock="${k}"]`); if (el && a.on) el.classList.toggle("on", !!a.on()); }
  const ov = qs('[data-dock="overlap"]');
  ov.classList.toggle("on", !!CFG.overlap);
  qs(".lb", ov).textContent = CFG.overlap ? "允许重叠：开（再点关掉）" : "允许块叠在一起";
  const fo = qs('[data-dock="fold"]');
  const anyOpen = Z.some((z) => !z.collapsed);
  qs(".lb", fo).textContent = anyOpen || !Z.length ? "全部收起成标签" : "全部展开";
  fo.classList.toggle("on", Z.length > 0 && !anyOpen);
}
// 浮层贴着 Dock 长：Dock 在下就往上长，在左就往右长……
function placeNearDock(el, btn) {
  el.hidden = false;
  const dr = dockEl.getBoundingClientRect(), br = (btn || dockEl).getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight, side = dockSide();
  let x, y;
  if (side === "bottom") { x = br.left + br.width / 2 - w / 2; y = dr.top - h - 12; }
  else if (side === "top") { x = br.left + br.width / 2 - w / 2; y = dr.bottom + 12; }
  else if (side === "left") { x = dr.right + 12; y = br.top + br.height / 2 - h / 2; }
  else { x = dr.left - w - 12; y = br.top + br.height / 2 - h / 2; }
  el.style.left = clampN(x, 12, innerWidth - w - 12) + "px";
  el.style.top = clampN(y, 12, innerHeight - h - 12) + "px";
}
let WAIT_I = 0;
const POPS = ["#tray"];   // 其他模块的浮层也登记进来，点别处一起关
function closePops() { for (const s of POPS) { const el = qs(s); if (el) el.hidden = true; } syncDock(); }
function dockAct(k, btn) {
  const trayWas = !qs("#tray").hidden;
  closePops();
  if (k === "draw") armDraw(null, "在空白处按住拖一下，圈出一块");
  else if (k === "group") {
    if (ZONE_KINDS.group) armDraw({ kind: "group" }, "圈一块给 Bot Group");
    else toast("Bot Group 还在接入中", "warn");
  } else if (k === "agent") {
    if (trayWas) return;
    const tr = qs("#tray");
    buildTray();
    tr.classList.toggle("grid", dockSide() === "left" || dockSide() === "right");
    placeNearDock(tr, btn);
  } else if (k === "wait") {
    const ws = waits();
    if (!ws.length) { toast("现在没有在等你的 agent"); return; }
    const x = ws[WAIT_I++ % ws.length];
    revealLeaf(x.z, x.l);
  } else if (k === "overlap") {
    CFG.overlap = !CFG.overlap; save();
    toast(CFG.overlap ? "已允许重叠：块可以叠在一起，点哪块哪块到最前面" : "已关闭重叠：已经叠着的块保持原样，挪开以后就不能再叠回去");
    if (typeof onCfgChanged === "function") onCfgChanged();
  }
  else if (k === "fold") collapseAll();
  else if (k === "stow") stow();
  else if (DOCK_ACTS[k]) DOCK_ACTS[k].act(btn);
  else toast("这一项还在接入中", "warn");
  syncDock();
}
// 把一格亮出来：收着的块先展开、聚焦着别的格先退出聚焦，然后闪一下、键盘交给它。
function revealLeaf(z, l) {
  if (!z) return;
  if (z.collapsed) expandZone(z, true);
  front(z);
  if (l && z.focus && z.focus !== l.id) { z.focus = null; render(); }
  pingEl(l ? TEL.get(l.id) : ZEL.get(z.id));
  if (l && l.tab) { setActive(l.tab); ackNote(l.tab, "从台面跳过来"); }
  syncDock();
}
function buildTray() {
  qs("#tray").innerHTML = `<div class="row">${agentList().map((a) => `<div class="tr-a${a.installed ? "" : " ni"}" data-tray="${a.id}" title="${a.installed ? "" : a.canInstall ? "还没装：拖出来就开始下载" : "还没装"}">${agiHTML(a.id)}${agLabel(a, agShort(a))}</div>`).join("")}</div>`
    + `<div class="hint">拖到格子的某条边上 = 在那边切一格；拖到空白处 = 新开一块；拖进 Bot Group = 加进群。灰色的还没装，拖出来就地下载</div>`;
}

let PENDING_LEAF = null, PENDING_GROUP = null;   // 「+ 文件夹」加完以后落到哪一格 / 哪个组

/* ---------- 收起：整个 Perch 缩成桌面上一个悬浮按钮（像桌宠，带 Perch 的标） ----------
   悬浮按钮是 Go 那边单独的一个小窗口（总在最前、无边框、透明底、不占任务栏，/orb.html）；
   主窗口藏起来（不是最小化，回来是瞬间的）。两边经 Wails 事件说话，见 cmd/perch/desk.go。
   收着的时候点开的东西一律照平常那样打开（Perch 不接管）—— 主窗口藏着，本来也接不到。 */
let ORB_SEEN = 0, STOWED = false;
const W_EV = (window.__wails && window.__wails.Events) || null;
function orbScreenPos() {
  const sw = screen.availWidth || innerWidth, sh = screen.availHeight || innerHeight;
  const ox = window.screenX || 0, oy = window.screenY || 0;
  const p = CFG.orb || { x: ox + sw - 92 - 10, y: oy + Math.round(sh * 0.62) };
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
function stow() {
  closePops();
  if (!W_EV) { toast("收起要在 Perch 里用（这里没有窗口通道）", "warn"); return; }
  STOWED = true; ORB_PUSHES = 0;
  document.body.classList.add("stowed");
  ORB_SEEN = waits().length;
  W_EV.Emit("perch:stow", orbScreenPos());
  pushOrbState();
  bootFact("台面收起成悬浮按钮");
}
function orbStatus() {
  let run = 0;
  for (const { l } of allLeaves()) if (l.tab && leafState(l) === "work") run++;
  for (const k of Object.values(ZONE_KINDS)) if (k.running) run += k.running();
  return { run, wait: waits().length };
}
function waitText(x) {
  if (x.l) return `${ag(x.l.agent).name} 在等你：${x.text || "看一眼"}`;
  return x.text || "有人在等你";
}
// 收起期间冒出新的「等你」：像桌宠一样冒个气泡，跳一下。气泡的话由这边定，按钮只负责画。
let ORB_PUSHES = 0;
function pushOrbState() {
  if (!STOWED || !W_EV) return;
  if (++ORB_PUSHES === 1 || ORB_PUSHES === 20) sendCtrl({ type: "log", msg: `收起期间第 ${ORB_PUSHES} 次推按钮状态（主窗口藏着，页面还在跑）` });
  const { run, wait } = orbStatus();
  let bub = "";
  if (wait > ORB_SEEN) { const ws = waits(); bub = waitText(ws[ws.length - 1]); }
  ORB_SEEN = wait;
  W_EV.Emit("perch:orb-state", { run, wait, bub });
}
setInterval(pushOrbState, 700);
if (W_EV) {
  W_EV.On("perch:unstowed", (e) => {
    STOWED = false;
    document.body.classList.remove("stowed");
    const d = e && e.data;
    if (d && typeof d.x === "number" && typeof d.y === "number" && (d.x || d.y)) { CFG.orb = { x: d.x, y: d.y }; save(); }
    if (activeTab) activeTab.focus();
  });
  // 桌面壁纸换了（Go 收到 WM_SETTINGCHANGE / SPI_SETDESKWALLPAPER）：换个查询参数重拉一次。
  W_EV.On("perch:wallpaper", () => { WALL_V = Date.now(); applyCfg(); });
}

/* ---------- 确认 / 提示 ---------- */
let CF_RES = null;
function deskConfirm(title, body, ok) {
  const el = qs("#cf");
  el.innerHTML = `<div class="back"></div><div class="cf-c"><b>${esc(title)}</b><p>${esc(body)}</p><div class="row"><button class="btn" data-cf="no">取消</button><button class="btn pri" data-cf="ok">${esc(ok)}</button></div></div>`;
  el.hidden = false;
  if (CF_RES) CF_RES(false);
  return new Promise((r) => { CF_RES = r; });
}
function cfDone(v) { qs("#cf").hidden = true; const r = CF_RES; CF_RES = null; if (r) r(v); }
let toastT = 0;
// act = { label, fn }：提示条上带一个动作按钮（比如「收起 Perch」）
function toast(msg, kind, act) {
  const t = qs("#toast");
  t.textContent = msg; t.classList.remove("warn"); if (kind) t.classList.add(kind); t.hidden = false;
  if (act) { const b = document.createElement("button"); b.className = "btn pri t-act"; b.textContent = act.label; b.onclick = () => { t.hidden = true; act.fn(); }; t.appendChild(b); }
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, act ? 5200 : kind === "warn" ? 4200 : 2800);
}
function clock() { const d = new Date(); qs("#clock").textContent = d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }) + "  " + d.toTimeString().slice(0, 5); }
setInterval(clock, 10000);
addEventListener("resize", () => { layoutDock(); render(); });

/* ---------- 台面的摆法会记住 ----------
   块的位置、大小、切法、每一格放的是哪个 agent（按 paneId 认）。重开时 Go 的冷恢复清单（panes.json）
   说「哪几格要接回来」，这里说「它们各坐在哪儿」：清单里有、这里没座位的，另开一块摆上；
   这里有座位、清单里没有的（上次关掉的），格子留着，变回空格（空格里能一键接回）。 */
const LAYOUT_KEY = "perch.desk.layout.v1";
function layoutJSON() {
  const out = (n) => n.t === "leaf"
    ? { t: "leaf", id: n.id, agent: n.agent || null, proj: n.proj, paneId: (n.tab && n.tab.paneID) || n.paneId || 0, provider: n.provider || "", model: n.model || "" }
    : { t: "split", id: n.id, dir: n.dir, r: n.r, a: out(n.a), b: out(n.b) };
  return { v: 1, uid, zones: Z.map((z) => {
    const k = ZONE_KINDS[z.kind];
    return { id: z.id, x: z.x, y: z.y, w: z.w, h: z.h, kind: z.kind, zi: z.zi, collapsed: !!z.collapsed, tab: z.tab || null,
      root: z.root ? out(z.root) : null, extra: k && k.save ? k.save(z) : null };
  }) };
}
let saveT = 0, BOOTED = false;
function saveLayout() {
  if (!BOOTED) return;   // 启动摆座位那一段别把还没摆完的样子写回去
  clearTimeout(saveT);
  saveT = setTimeout(flushLayout, 250);
}
function flushLayout() {
  clearTimeout(saveT); saveT = 0;
  if (!BOOTED) return;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutJSON())); } catch (_) {}
}
addEventListener("pagehide", flushLayout);
function loadLayout() {
  try { const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null"); return s && Array.isArray(s.zones) ? s : null; } catch (_) { return null; }
}
function restoreZones(lay) {
  const inLeaf = (n) => n.t === "leaf"
    ? { t: "leaf", id: n.id, agent: null, proj: n.proj || defProj(), tab: null, paneId: n.paneId | 0, want: n.agent || null, provider: n.provider || "", model: n.model || "", state: "idle", v: 1, ask: "" }
    : { t: "split", id: n.id, dir: n.dir === "v" ? "v" : "h", r: clampN(+n.r || 0.5, 0.1, 0.9), a: inLeaf(n.a), b: inLeaf(n.b) };
  for (const s of lay.zones) {
    if (!s || !s.kind || s.kind === "new" && false) continue;
    const z = { id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, kind: s.kind, root: s.root ? inLeaf(s.root) : null, focus: null, group: null, gv: 0, fz: null, fv: 0,
      zi: s.zi || ++ZTOP, collapsed: !!s.collapsed, tab: s.tab || null };
    const k = ZONE_KINDS[z.kind];
    if (z.kind !== "agents" && z.kind !== "new" && !(k && k.load)) continue;   // 那种块的模块不在了：不摆
    if (k && k.load) { try { k.load(z, s.extra || {}); } catch (e) { jserr("desk.load", e); continue; } }
    ZTOP = Math.max(ZTOP, z.zi);
    Z.push(z);
  }
  uid = Math.max(uid, lay.uid | 0);
  for (const { l } of allLeaves()) { const n = +String(l.id).slice(1); if (n >= uid) uid = n + 1; }
}
// N 个座位摆成一块：按块的长边对半切，切到每格一个。
function balancedTree(n, rc, proj) {
  if (n <= 1) return emptyLeaf(proj);
  const dir = rc.w >= rc.h ? "h" : "v";
  const na = Math.ceil(n / 2), r = na / n;
  const ra = dir === "h" ? { w: rc.w * r, h: rc.h } : { w: rc.w, h: rc.h * r };
  const rb = dir === "h" ? { w: rc.w * (1 - r), h: rc.h } : { w: rc.w, h: rc.h * (1 - r) };
  return { t: "split", id: nid(), dir, r, a: balancedTree(na, ra, proj), b: balancedTree(n - na, rb, proj) };
}
async function bootDesk() {
  applyCfg(); layoutDock(); buildTray(); clock();
  await fontsReady;
  // 设置 › 通用「启动时恢复上次的台面」关着：台面从空的开始，上次的 agent 不接回（记录照旧留着）。
  const restore = SETTINGS.restoreDesk !== false;
  const seats = restore ? await awaitRestorePlan() : [];
  const lay = restore ? loadLayout() : null;
  if (lay) restoreZones(lay);
  render();
  const byPane = new Map();
  for (const x of allLeaves()) if (x.l.paneId) byPane.set(x.l.paneId, x);
  const homeless = [], seated = new Set();
  for (const v of seats) {
    // Bot Group 的成员格跟着它的组走（那一块的模块认领它）；这里只把它接起来。
    if (v.group) { createTab(seatSpecFrom(v)); continue; }
    const x = byPane.get(v.paneId | 0);
    if (x && !seated.has(x.l)) { seated.add(x.l); x.l.proj = x.l.proj || ownerProjectPath(v.cwd); assign(x.l, v.agent, { spec: seatSpecFrom(v), quiet: true }); }
    else homeless.push(v);
  }
  // 有座位但这一轮不接回的（上次点了 ×）：格子留着、变回空格。
  // paneId 也清掉：Go 会把空出来的号发给下一格，留着旧号会让下次重开认错座位。
  for (const { l } of allLeaves()) if (!seated.has(l) && !l.tab) { l.want = null; l.paneId = 0; l.v++; }
  if (homeless.length) {
    const d = desk();
    const r = findFree([[Math.round(d.w * 0.62), Math.round(d.h * 0.7)], [Math.round(d.w * 0.45), Math.round(d.h * 0.55)], [ZMIN_NEW.w + 140, ZMIN_NEW.h + 100]]) || fr(0, 0, 0.6, 0.7);
    const z = { id: nid(), x: r.x, y: r.y, w: r.w, h: r.h, kind: "agents", root: null, focus: null, group: null, gv: 0, fz: null, fv: 0, zi: ++ZTOP, collapsed: false, tab: null };
    z.root = balancedTree(homeless.length, bodyRect(z), defProj());
    Z.push(z);
    render();
    leaves(z.root).forEach((l, i) => { const v = homeless[i]; l.proj = ownerProjectPath(v.cwd); assign(l, v.agent, { spec: seatSpecFrom(v), quiet: true }); });
  }
  BOOT_SEATED = true;
  BOOTED = true;
  render();
  saveLayout();
  const first = allLeaves().map((x) => x.l.tab).find((t) => t && TAB_LIST.includes(t));
  if (first) setActive(first);
  bootFact(`台面起来了：块 ${Z.length}、格 ${allLeaves().length}、接回 ${seats.length - homeless.length} 格到原座位、另摆 ${homeless.length} 格`);
}

/* ---------- 给别的文件的出口 ---------- */
let SOON = 0;
window.DESK = {
  // 状态变了：下一帧重画一次（一帧里来多少次都只画一次）。
  soon() { if (SOON) return; SOON = requestAnimationFrame(() => { SOON = 0; if (BOOTED || Z.length) render(); }); },
  reveal(t) { const x = leafOfTab(t); if (x) revealLeaf(x.z, x.l); else setActive(t); },
  toast, confirm: deskConfirm,
};

/* 关窗（Alt+F4 / 任务栏关闭）：设置里开着「关闭前确认」时 Go 先拦下来问一句（ctl/closeguard.go）。 */
let CLOSE_ASKING = false;
if (W_EV) W_EV.On("perch:close-request", () => {
  if (CLOSE_ASKING) return;
  CLOSE_ASKING = true;
  const n = TAB_LIST.filter((t) => !t.connDown).length;
  deskConfirm("退出 Perch？", (n ? `在跑的 ${n} 个 agent 会停下来。` : "") + "台面的摆法和每一格的记录都留着，下次打开按原样接回。", "退出").then((ok) => {
    CLOSE_ASKING = false;
    flushLayout();
    sendCtrl({ type: ok ? "window.close" : "window.close.cancel" });
  });
});
