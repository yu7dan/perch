"use strict";
/* Perch 沉浸台面 · 形态模拟（第二版：Dock 可拖、项目与文件、设置贯通）
   块（zone）= 在桌面空白处圈出来的矩形。种类：agents（一格或多格）/ group（Bot Group）/ files（项目文件）/ new（还没选）。
   agents 块里是一棵二叉切分树：leaf = 一格，split = 横切（h：左右）或竖切（v：上下）+ 比例 r。
   切分树始终正好铺满块的内框；块缩放时各格按比例跟着变。块与块不重叠。
   Dock 可以拖到任何地方；贴左右边时竖排，贴边时台面让出那一条。 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const GAP = 6, PAD = 6, HEAD = 34, MINW = 200, MINH = 132, TOP = 44, SIDE = 20, DOCK_R = 92;
let ZGAP = 14;
const ZMIN_NEW = { w: 260, h: 180 }, ZMIN_GROUP = { w: 340, h: 260 }, ZMIN_FILES = { w: 360, h: 240 };

const ICON = (n, s = 18, sw = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ""}</svg>`;

/* ---------- 数据 ---------- */
const AGENTS = [
  { id: "claude", name: "Claude Code", icon: "claudecode-color.svg", model: "Opus 5.5" },
  { id: "codex", name: "Codex", icon: "codex-color.svg", model: "gpt-5.5-codex" },
  { id: "pi", name: "Pi", icon: "pi.svg", mono: true, model: "deepseek-v4-pro" },
  { id: "opencode", name: "OpenCode", icon: "opencode.svg", mono: true, model: "Sonnet 5.5" },
  { id: "antigravity", name: "Antigravity", icon: "antigravity-color.svg", model: "gemini-3.5-pro" },
  { id: "cursor", name: "Cursor", icon: "cursor.svg", mono: true, model: "composer-2" },
  { id: "copilot", name: "Copilot CLI", icon: "githubcopilot.svg", mono: true, model: "gpt-5.5" },
  { id: "qoder", name: "Qoder", icon: "qoder.svg", mono: true, model: "qoder-max" },
  { id: "deepseek", name: "DeepSeek Harness", icon: "deepseek-color.svg", model: "deepseek-v4-flash" },
];
const AG = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
/* ---------- Agent 就地下载：不再有单独的「安装」页，开工时选到没装的就地装 ---------- */
const NOT_INSTALLED = ["antigravity", "cursor", "copilot", "qoder", "deepseek"];
const resetInstalled = () => { for (const a of AGENTS) a.installed = !NOT_INSTALLED.includes(a.id); };
resetInstalled();
let INST = {};   // agentId -> { pct, then: [] }
const instPhase = (p) => p < 60 ? "下载" : p < 90 ? "安装" : "检测";
function installAgent(id, then) {
  if (AG[id].installed) { if (then) then(); return; }
  if (INST[id]) { if (then) INST[id].then.push(then); return; }
  INST[id] = { pct: 0, then: then ? [then] : [] };
  toast(`开始下载 ${AG[id].name} —— 装好就能用（只装一次）`);
}
setInterval(() => {
  for (const [id, s] of Object.entries(INST)) {
    s.pct = Math.min(100, s.pct + 2 + Math.random() * 3);
    // 液体灌进图标：只改填充高度，不重画
    for (const el of $$(`[data-agi="${id}"]`)) { el.classList.add("ing"); el.style.setProperty("--p", s.pct + "%"); }
    for (const el of $$(`[data-agname="${id}"]`)) el.textContent = Math.round(s.pct) + "%";
    for (const el of $$(`[data-insttxt="${id}"]`)) el.textContent = `${instPhase(s.pct)} ${Math.round(s.pct)}%`;
    if (s.pct >= 100) {
      delete INST[id];
      AG[id].installed = true;
      DONE[id] = Date.now();
      toast(`${AG[id].name} 装好了`);
      for (const f of s.then) f();
      buildTray();
      for (const z of Z) { if (z.group) z.group.sv++; for (const l of leaves(z.root)) if (!l.agent) l.v++; }
      render();
    }
  }
}, 150);
// 往一格里放 agent：装了就直接开；没装就在这一格里显示下载进度，装好自动开
function placeAgent(leaf, id) {
  if (AG[id].installed) { assign(leaf, id); return; }
  leaf.installing = id; leaf.v++;
  installAgent(id, () => { if (leaf.installing === id) { leaf.installing = null; assign(leaf, id); render(); } });
}
/* agent 图标：没装的是灰的；鼠标移上去盖一层玻璃、浮出下载；点了以后液体从底部灌满图标，就是下载进度 */
const DONE = {};
function agiHTML(id) {
  const a = AG[id], s = INST[id];
  const img = `<img class="${a.mono ? "mono" : ""}" src="agents/${a.icon}" alt="" draggable="false">`;
  if (a.installed) return `<span class="agi${DONE[id] && Date.now() - DONE[id] < 1600 ? " done" : ""}" data-agi="${id}">${img}</span>`;
  return `<span class="agi ni${s ? " ing" : ""}" data-agi="${id}" style="--p:${s ? s.pct : 0}%">${img}<span class="agi-fill">${img}</span>`
    + `<span class="agi-liq"><i></i><i></i></span><span class="agi-dl">${ICON("download", 13, 2.2)}</span></span>`;
}
const agLabel = (a, txt) => INST[a.id] ? `<span data-agname="${a.id}">${Math.round(INST[a.id].pct)}%</span>` : `<span data-agname="">${esc(txt)}</span>`;
const logo = (id, cls = "") => { const a = AG[id] || AGENTS[0]; return `<img class="${a.mono ? "mono " : ""}${cls}" src="agents/${a.icon}" alt="">`; };
const OWN_MODELS = { claude: ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"], codex: ["gpt-5.5-codex", "gpt-5.5"], antigravity: ["gemini-3.5-pro"],
  cursor: ["composer-2"], copilot: ["gpt-5.5"], qoder: ["qoder-max"], deepseek: ["deepseek-v4-flash"] };
const BASE_PROVIDERS = () => [
  { id: "zero", name: "零词元", kind: "中转站", proto: ["Anthropic", "OpenAI", "Responses"], key: "··8f2a", models: ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "gpt-5.5"] },
  { id: "ds", name: "DeepSeek", kind: "官方", proto: ["Anthropic", "OpenAI"], key: "··41c0", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
];
let PROVIDERS = BASE_PROVIDERS();
const PRESETS = [
  { id: "openrouter", name: "OpenRouter", kind: "中转站", proto: ["OpenAI", "Responses"], models: ["anthropic/claude-opus-5.5", "google/gemini-3.5-pro", "qwen/qwen3.5-coder"] },
  { id: "silicon", name: "硅基流动", kind: "中转站", proto: ["OpenAI"], models: ["Qwen3.5-Coder", "GLM-5", "DeepSeek-V4"] },
  { id: "moonshot", name: "Moonshot", kind: "官方", proto: ["Anthropic", "OpenAI"], models: ["kimi-k3"] },
  { id: "zhipu", name: "智谱", kind: "官方", proto: ["Anthropic", "OpenAI"], models: ["glm-5", "glm-5-air"] },
  { id: "custom", name: "自定义", kind: "自定义", proto: ["Anthropic", "OpenAI"], models: ["my-model"], custom: true },
];
const BASE_PROJECTS = () => [
  { name: "Perch", path: "D:\\AIAgents\\perch", files: ["assets/index.html", "assets/js/01-i18n.js", "assets/js/85b-providers.js", "assets/js/85c-models.js", "assets/css/55-models.css",
    "cmd/perch/main.go", "internal/ctl/payload.go", "internal/history/scan.go", "internal/project/project.go", "go.mod", "README.md"] },
  { name: "perch-site", path: "D:\\AIAgents\\workspace\\perch-site", files: ["site/index.html", "site/changelog.md", "site/docs/getting-started.md", "package.json", "vercel.json"] },
  { name: "Tracer", path: "C:\\Users\\Administrator\\Desktop\\Tracer", files: ["README.md", "research/notes.md", "src/index.ts", "package.json"] },
];
let PROJECTS = BASE_PROJECTS();
const RECENT_DIRS = [
  { name: "ai工作台", path: "D:\\AIAgents\\workspace\\ai工作台" },
  { name: "2cut", path: "C:\\Users\\Administrator\\Desktop\\2cut" },
  { name: "notes", path: "D:\\Projects\\notes" },
];
const projByName = (n) => PROJECTS.find((p) => p.name === n);
// 模拟的磁盘：选文件夹 / 新建文件夹都在这棵树上走
const FS = {
  "C:\\": { Users: { Administrator: { Desktop: { "2cut": {}, Tracer: {}, "截图": {} }, Documents: { Perch: { Chat: {} }, "设计稿": {} }, Downloads: {} } }, "Program Files": {}, Windows: {} },
  "D:\\": { AIAgents: { perch: { assets: {}, cmd: {}, internal: {} }, workspace: { "ai工作台": {}, "perch-site": {} }, _tools: {} }, Perch: { workspace: {} }, Projects: { notes: {}, "my-app": {} } },
};
const parsePath = (s) => { const p = String(s || "").split("\\").filter(Boolean); return p.length ? [p[0] + "\\", ...p.slice(1)] : []; };
const pstr = (a) => a.length ? a[0] + a.slice(1).join("\\") : "此电脑";
function fsNode(a) { if (!a.length) return FS; let n = FS[a[0]]; for (const k of a.slice(1)) { if (!n || !n[k]) return null; n = n[k]; } return n || null; }

const SCRIPTS = {
  claude: [["me", "把中转站预设补全，带上各家文档链接"], ["say", "先看现有的 46 家预设。"], ["act", "读取 assets/js/85b-providers.js", "assets/js/85b-providers.js", "read"],
    ["act", "编辑 PROV_PRESETS  +12 −3", "assets/js/85b-providers.js", "edit"], ["act", "编辑 assets/js/01-i18n.js  +24", "assets/js/01-i18n.js", "edit"],
    ["say", "补了零词元、OpenRouter、硅基流动，链接都指向它们自己的文档。"], ["act", "运行 i18n-check → 通过"]],
  codex: [["me", "给 project 包补单测"], ["act", "读取 internal/project/project.go", "internal/project/project.go", "read"], ["say", "Remove 之后的 Hidden 列表没被测到，补两条用例。"],
    ["act", "新建 hidden_test.go  +48", "internal/project/hidden_test.go", "new"], ["act", "go test ./internal/project → ok 0.41s"], ["say", "都过了。"]],
  pi: [["me", "看看启动为什么要 20 秒"], ["act", "读取 internal/ctl/payload.go", "internal/ctl/payload.go", "read"], ["say", "大头在 history.Scan：239 个会话逐个解析。"],
    ["act", "读取 internal/history/scan.go", "internal/history/scan.go", "read"], ["say", "建议先推项目池，会话库随后补。"], ["act", "试了一下：池子 0.3s 就能到"]],
  opencode: [["me", "官网 changelog 加上 beta.6"], ["act", "读取 site/changelog.md", "site/changelog.md", "read"], ["act", "编辑 changelog.md  +14", "site/changelog.md", "edit"], ["say", "加好了：三条修复、一条新功能。"]],
  def: [["me", "看一下这个目录是干什么的"], ["act", "列出文件  23 个"], ["say", "入口在 README.md，先读一下。"], ["act", "读取 README.md", "README.md", "read"], ["say", "要我先跑起来看看吗？"]],
};
const ASKS = ["要我把这 3 处改动提交吗？", "这一步要删 2 个文件，可以吗？", "要联网装一个依赖（pnpm add zod），可以吗？"];
const GROUP_FEED = [
  ["Manager", "claude", "目标收到：给 Perch 加「中转站预设」。我拆成三件事。"],
  ["Manager", "claude", "@开发 写预设和检测；@审阅 盯接口；@测试 跑一遍导入。"],
  ["开发", "codex", "开工。先列出中转站类的 12 家。"],
  ["审阅", "claude", "注意：Codex 只吃 Responses，没有的那家要做灰。"],
  ["开发", "codex", "预设写完了，交给审阅。"],
  ["测试", "pi", "导入零词元：Anthropic ✓ Chat ✓ Responses ✓"],
  ["Manager", "claude", "都过了。等你看一眼再合并。"],
];
const FILE_TEXT = {
  "assets/js/85b-providers.js": `/* 模型提供商：预设 + 自定义 */
const PROV_PRESETS = [
  { id: "anthropic", name: "Anthropic", kind: "vendor" },
  { id: "deepseek", name: "DeepSeek", kind: "vendor" },
  { id: "zero", name: "零词元", kind: "relay",
    anthropic: "https://zzq.si", openai: "https://zzq.si/v1",
    site: "https://zzq.si", keys: "https://zzq.si/console/token" },
  { id: "openrouter", name: "OpenRouter", kind: "relay",
    openai: "https://openrouter.ai/api/v1", site: "https://openrouter.ai" },
  { id: "silicon", name: "硅基流动", kind: "relay",
    openai: "https://api.siliconflow.cn/v1" },
];

function provFitsAgent(p, agentId) {
  if (agentId === "codex" && p.responses === false) return { ok: false };
  return { ok: true };
}`,
  "internal/project/hidden_test.go": `package project

import "testing"

func TestRemoveHidesFolder(t *testing.T) {
	s := newTestStore(t)
	s.Add("D:/work/a")
	s.Remove("D:/work/a")
	if !s.IsHidden("D:/work/a") {
		t.Fatal("removed folder should be hidden")
	}
}

func TestAddUnhides(t *testing.T) {
	s := newTestStore(t)
	s.Remove("D:/work/b")
	s.Add("D:/work/b")
	if s.IsHidden("D:/work/b") {
		t.Fatal("re-added folder must not stay hidden")
	}
}`,
  "site/changelog.md": `# Changelog

## 0.1.0-beta.6
- 修复：移除项目后它还留在工作区
- 修复：添加提供商后 Agents 页整页消失
- 修复：每格的 Claude 设置文件改为私有、用完即删
- 新增：模型提供商预设

## 0.1.0-beta.5
- 自带 ConPTY，全屏 TUI 不再丢鼠标`,
};
const ADDED = { "assets/js/85b-providers.js": [4, 5, 6, 7, 8, 9, 10, 11, 12], "assets/js/01-i18n.js": [3, 4, 5, 6], "internal/project/hidden_test.go": "all", "site/changelog.md": [3, 4, 5, 6, 7, 8] };
function fileText(path) {
  if (FILE_TEXT[path]) return FILE_TEXT[path];
  const ext = path.split(".").pop();
  if (ext === "go") return `package ${path.split("/").slice(-2, -1)[0] || "main"}\n\n// ${path}\n// （模拟内容）\n\nfunc init() {\n\t// …\n}`;
  if (ext === "md") return `# ${path.split("/").pop().replace(".md", "")}\n\n（模拟内容）这里是文档正文。`;
  if (ext === "json") return `{\n  "name": "demo",\n  "private": true\n}`;
  return `// ${path}\n// （模拟内容）\n\nexport function main() {\n  return 0;\n}`;
}

/* ---------- 设置（会记住） ---------- */
const ACCENTS = ["#8aa4ff", "#7dd3c0", "#f5a3c7", "#f5b454", "#c4b5fd"];
const DEF_CFG = () => ({ bg: "wall", icons: "hide", glass: 0.6, blur: 30, acc: "#8aa4ff", clock: true, gap: "comfy", autostart: false, restore: true, confirmClose: true, overlap: false,
  hotkey: "Ctrl+Alt+Space", defAgent: "claude", workdir: "D:\\Perch\\workspace",
  agentModel: { claude: "Opus 5.5", codex: "gpt-5.5-codex", pi: "deepseek-v4-pro", opencode: "Sonnet 5.5" },
  agentProv: { claude: "零词元", codex: "Codex 自己的登录", pi: "DeepSeek", opencode: "零词元" },
  effort: { claude: "high", codex: "medium", pi: "high", opencode: "medium" } });
const DEF_DK = () => ({ mode: "edge", edge: "bottom", t: 0.5 });
let CFG = DEF_CFG(), DK = DEF_DK();
try { const s = JSON.parse(localStorage.getItem("perch.desk.v2") || "null"); if (s) { CFG = Object.assign(DEF_CFG(), s.CFG); DK = Object.assign(DEF_DK(), s.DK); } } catch (_) {}
const save = () => { try { localStorage.setItem("perch.desk.v2", JSON.stringify({ CFG, DK })); } catch (_) {} };
function hexA(h, a) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function applyCfg() {
  const r = document.documentElement.style;
  r.setProperty("--glass", `rgba(18,19,24,${CFG.glass})`);
  r.setProperty("--blur", CFG.blur + "px");
  r.setProperty("--acc", CFG.acc);
  r.setProperty("--acc-bg", hexA(CFG.acc, 0.16));
  document.body.classList.toggle("bg-solid", CFG.bg === "solid");
  document.body.classList.toggle("bg-grad", CFG.bg === "grad");
  CFG.icons = "hide";   // 桌面图标一律盖住：台面就是一整张盖住桌面的面板
  const was = document.body.classList.contains("show-icons");
  document.body.classList.toggle("show-icons", CFG.bg === "wall" && CFG.icons === "show");
  if (was !== document.body.classList.contains("show-icons") && typeof fitZones === "function" && Z.length) fitZones();
  document.body.classList.toggle("no-clock", !CFG.clock);
  ZGAP = CFG.gap === "tight" ? 8 : 14;
}

/* ---------- 状态 ---------- */
let Z = [];
let uid = 1;
const nid = () => "n" + uid++;
const emptyLeaf = (proj) => ({ t: "leaf", id: nid(), agent: null, proj: proj || (PROJECTS[0] || {}).name || "默认工作区", state: "idle", lines: [], si: 0, v: 1, ask: null, fresh: false });
let DRAW = null;          // 圈块时预先定好的东西：{ kind, proj, agent }
let LAST_ZONE = null, LAST_REFUSED = 0, DRAG = null, SUPPRESS_CLICK = 0;
let TOUCH = {}, TV = 0;   // 每个项目里 agent 碰过的文件
let ZTOP = 1;             // 叠放时的前后次序

function desk() {
  const W = innerWidth, H = innerHeight;
  let x = SIDE, y = TOP, r = W - SIDE, b = H - 24;
  if (DK.mode === "edge") {
    if (DK.edge === "bottom") b = H - DOCK_R - 8;
    else if (DK.edge === "top") y = DOCK_R + 4;
    else if (DK.edge === "left") x = DOCK_R;
    else if (DK.edge === "right") r = W - DOCK_R;
  }
  // 露出桌面图标时，台面把图标那几列让出来，图标才点得到
  if (document.body.classList.contains("show-icons")) x = Math.max(x, 14 + iconCols() * 86 + 10);
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
  if (z.kind === "group") return ZMIN_GROUP;
  if (z.kind === "files") return ZMIN_FILES;
  if (z.kind === "web") return { w: 360, h: 260 };
  if (z.kind === "app") return { w: 320, h: 240 };
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
  if (agentId) placeAgent(nl, agentId);
  z.focus = null;
  render();
  return nl;
}
function removeLeaf(z, leaf) {
  if (z.root === leaf) { removeZone(z); return; }
  const p = parentOf(z.root, leaf);
  replaceNode(z, p, p.a === leaf ? p.b : p.a);
  if (z.focus === leaf.id) z.focus = null;
  const el = TEL.get(leaf.id);
  if (el) { el.remove(); TEL.delete(leaf.id); }
  render();
}
function allLeaves() { const out = []; for (const z of Z) for (const l of leaves(z.root)) out.push({ z, l }); return out; }

/* ---------- 块 ---------- */
function addZone(r, kind, opts) {
  const z = { id: nid(), x: r.x, y: r.y, w: r.w, h: r.h, kind: "new", root: null, focus: null, group: null, gv: 0, fz: null, fv: 0, zi: ++ZTOP, collapsed: false, tab: null };
  Z.push(z);
  LAST_ZONE = z;
  if (kind) setKind(z, kind, opts);
  render();
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
    if (opts.agent) placeAgent(z.root, opts.agent);
  } else if (k === "group") {
    z.kind = "group";
    z.group = newGroup(opts);
  } else if (k === "web") {
    z.kind = "web";
    const app = APPS.find((a) => a.id === opts.app);
    const url = opts.url || (app && app.url) || "https://www.bing.com";
    z.web = { app: app ? app.id : null, url, hist: [url], hi: 0, n: 0 };
    z.wv = 0;
  } else if (k === "app") {
    z.kind = "app";
    z.appz = { id: opts.app, playing: false, t: 0, song: 2, like: false };
    z.av = 0;
  } else if (k === "files") {
    z.kind = "files";
    z.fz = { proj: opts.proj || (PROJECTS[0] || {}).name, tab: "touched", open: new Set(), sel: opts.sel || null };
    if (z.fz.sel) openDirsFor(z.fz, z.fz.sel);
  }
  render();
}
async function closeZone(z) {
  const busy = z.kind === "group" ? z.group.stage === "run" : leaves(z.root).some((l) => l.agent);
  if (CFG.confirmClose && busy) {
    const n = z.kind === "group" ? z.group.members.length : leaves(z.root).filter((l) => l.agent).length;
    const ok = await askConfirm("关掉这一块？", `里面 ${n} 个 agent 会停下来。记录都留着，之后可以按原样接回。（设置 › 通用 里可以关掉这句提示）`, "关掉");
    if (!ok) return;
  }
  removeZone(z);
}
function removeZone(z) {
  const el = ZEL.get(z.id);
  Z = Z.filter((x) => x !== z);
  for (const l of leaves(z.root)) TEL.delete(l.id);
  ZEL.delete(z.id);
  if (el) { el.classList.add("out"); setTimeout(() => el.remove(), 260); }
  syncDock();
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
    sh.x = clamp(z.x, d.x, d.x + d.w - sh.w); sh.y = clamp(z.y, d.y, d.y + d.h - sh.h);
    if (!blocker(sh, z.id)) Object.assign(z, sh);
    else if (ir.w >= mn.w && ir.h >= mn.h) Object.assign(z, ir);
    else Object.assign(z, sh);
  }
  render();
}

/* ---------- agent 模拟 ---------- */
function assign(leaf, agentId) {
  leaf.agent = agentId; leaf.sk = null; leaf.state = "work"; leaf.si = 0; leaf.lines = []; leaf.ask = null; leaf.pend = null; leaf.peek = false;
  leaf.model = CFG.agentModel[agentId] || AG[agentId].model;
  advance(leaf);
}
function touch(leaf, path, kind) {
  const arr = TOUCH[leaf.proj] || (TOUCH[leaf.proj] = []);
  const rank = { read: 1, edit: 2, new: 3 };
  let e = arr.find((x) => x.path === path);
  if (e) { arr.splice(arr.indexOf(e), 1); if (rank[kind] > rank[e.kind]) e.kind = kind; }
  else e = { path, kind, agents: new Set(), leaves: new Set() };
  e.agents.add(leaf.agent); e.leaves.add(leaf.id); e.t = Date.now();
  arr.unshift(e);
  const p = projByName(leaf.proj);
  if (p && !p.files.includes(path)) p.files.push(path);
  TV++;
}
const touchedBy = (leaf) => (TOUCH[leaf.proj] || []).filter((e) => e.leaves.has(leaf.id));
function advance(leaf) {
  if (leaf.pend && leaf.state === "work") {
    leaf.model = leaf.pend; leaf.pend = null;
    leaf.lines.push({ k: "sys", t: `这一轮起用 ${leaf.model}` });
  }
  const s = SCRIPTS[leaf.sk || leaf.agent] || SCRIPTS.def;
  if (leaf.si < s.length) {
    const [k, t, f, fk] = s[leaf.si];
    leaf.lines.push({ k, t });
    if (f) touch(leaf, f, fk);
    leaf.si++; leaf.fresh = true;
  } else if (leaf.state === "work") {
    leaf.state = Math.random() < 0.3 ? "wait" : "idle";
    if (leaf.state === "wait") leaf.ask = ASKS[Math.floor(Math.random() * ASKS.length)];
  }
  while (leaf.lines.length > 200) leaf.lines.shift();
  leaf.v++;
}
function setWait(leaf) { leaf.state = "wait"; leaf.ask = ASKS[0]; leaf.v++; render(); }
function answer(leaf, yes) {
  leaf.ask = null; leaf.state = "work";
  leaf.lines.push({ k: "act", t: yes ? "git commit -m \"presets: relay providers\"  → 3 files" : "好，先不提交。" });
  leaf.fresh = true; leaf.v++;
  render();
}
function setLeafModel(leaf, m) {
  if (m === leaf.model && !leaf.pend) return;
  if (leaf.state === "work") { leaf.pend = m; toast(`下一轮起用 ${m} —— 不用重启，对话接着走`); }
  else { leaf.model = m; leaf.pend = null; leaf.lines.push({ k: "sys", t: `换成了 ${m}` }); leaf.fresh = true; toast(`已换成 ${m}`); }
  leaf.v++; render();
}
/* ---------- Bot Group：建组 → 开工 → 群聊 / 单聊 → 加人 → 拍板 ---------- */
const ROLE_PRESETS = ["开发", "审阅", "测试", "文档", "维护", "宣发"];
const ROLE_COLORS = ["#8aa4ff", "#7dd3c0", "#f5a3c7", "#f5b454", "#c4b5fd", "#93c5fd", "#fca5a5"];
const BG_MAX = 6;
const ROLE_TASK = { 开发: "动手改代码", 审阅: "盯每一处改动", 测试: "跑一遍、对截图", 文档: "把文档补齐", 维护: "看构建和依赖", 宣发: "准备发布文案" };
const ROLE_WORK = {
  开发: [["act", "读取 site/index.html"], ["act", "编辑 site/index.html  +36 −12"], ["say", "首页换成台面的截图了，交给审阅。"]],
  审阅: [["act", "读取 git diff（开发的工作副本）"], ["say", "两处小问题：图片没压缩、alt 缺了，已经回给开发。"]],
  测试: [["act", "打开 http://localhost:4321"], ["act", "截图对比 3 张 → 1 处差异"], ["say", "移动端首屏被截断了，报给开发了。"]],
  文档: [["act", "新建 site/docs/bot-group.md"], ["act", "编辑 bot-group.md  +80"], ["say", "Bot Group 的文档初稿写好了。"]],
  维护: [["act", "运行 pnpm build → 通过"], ["say", "依赖都是最新的，构建 41 秒。"]],
  宣发: [["say", "发布文案写了三版，等你挑。"]],
  def: [["act", "读取 README.md"], ["say", "项目看完了，等 Manager 安排。"]],
};
const gm = (g, id) => g.members.find((m) => m.id === id);
/* 人设与岗位：每个成员一份；建组时在 Bot 那一行写，开工后在成员详情里改，改了下一轮生效。
   真产品里它会写进这个成员工作副本里的岗位说明（AGENTS.md 里 Perch 管的那一段）。 */
const ROLE_PERSONA = {
  Manager: { duty: "把目标拆成能交付的小活，派给合适的 Bot；盯进度、汇总结果；要你拍板的事整理好再来问。", style: "简洁、条理清楚；每次汇报只讲结论和需要你决定的事。", scope: "（不直接改代码）", done: "目标达成，或者讲清楚卡在哪、需要你做什么" },
  开发: { duty: "按 Manager 派的活改代码；动手前先说计划，改完写清楚改了哪几处、为什么。", style: "务实，先给结论再讲细节；拿不准就问，不瞎猜。", scope: "src/**, site/**", done: "能跑、自测过、改动说明写清楚" },
  审阅: { duty: "逐条看其他 Bot 的改动：对不对、边界情况、有没有误改别的文件。", style: "严格但具体：每条意见都指到文件和行。", scope: "（只读）", done: "每处改动都有结论：通过，或者要改哪里" },
  测试: { duty: "跑起来看效果、对截图、找回归；发现问题直接报给负责的 Bot。", style: "拿证据说话：截图、日志、复现步骤。", scope: "tests/**", done: "关键页面都对过截图，问题都有复现步骤" },
  文档: { duty: "把改动写成用户看得懂的文档和更新日志。", style: "短句、少术语，先讲怎么用。", scope: "docs/**, site/docs/**", done: "新功能都有文档，链接都点得开" },
  维护: { duty: "管构建、依赖和 CI；别人卡在环境问题上时出手。", style: "稳妥，能不升级就不升级。", scope: "package.json, .github/**", done: "构建通过，依赖没有已知漏洞" },
  宣发: { duty: "写发布文案、更新官网介绍。", style: "口语、有画面感，不夸大。", scope: "site/**", done: "给出 3 版文案让你挑" },
};
function personaFor(role) {
  const b = ROLE_PERSONA[role] || { duty: "", style: "", scope: "", done: "" };
  return { duty: b.duty, style: b.style, scope: b.scope, done: b.done,
    forbid: { main: true, del: true, deps: false, net: false }, ask: { merge: true, del: true, deps: true, cost: 50 }, direct: false };
}
const clonePersona = (p) => JSON.parse(JSON.stringify(p));
let PERSONA_TPL = [];   // 你自己存的模板：{ name, role, persona }
const pget = (p, k) => k.split(".").reduce((o, x) => o && o[x], p);
const pset = (p, k, v) => { const ks = k.split("."); const last = ks.pop(); ks.reduce((o, x) => o[x], p)[last] = v; };
function personaFormHTML(p, ctx, title) {
  const chip = (k, t) => `<button class="pf-c${pget(p, k) ? " on" : ""}" data-pfx="${k}">${ICON(pget(p, k) ? "check" : "plus", 12, 2.2)}${t}</button>`;
  return `<div class="pf" data-pctx="${ctx}">`
    + (title !== undefined ? `<label class="gl">角色名</label><input class="inp" data-pf="title" value="${esc(title)}" spellcheck="false" autocomplete="off">` : "")
    + `<label class="gl">岗位职责 <em>它具体负责什么</em></label><textarea class="inp pf-ta" data-pf="duty" spellcheck="false">${esc(p.duty)}</textarea>`
    + `<label class="gl">人设与风格 <em>怎么说话、怎么做事</em></label><textarea class="inp pf-ta" data-pf="style" spellcheck="false">${esc(p.style)}</textarea>`
    + `<label class="gl">能动哪些地方 <em>目录，逗号隔开；别的地方只能读</em></label><input class="inp" data-pf="scope" value="${esc(p.scope)}" spellcheck="false">`
    + `<label class="gl">不能做的事</label><div class="pf-chips">${chip("forbid.main", "不直接改 main")}${chip("forbid.del", "不删文件")}${chip("forbid.deps", "不装新依赖")}${chip("forbid.net", "不联网")}</div>`
    + `<label class="gl">什么时候找你拍板</label><div class="pf-chips">${chip("ask.merge", "合进 main 之前")}${chip("ask.del", "要删文件时")}${chip("ask.deps", "要装依赖时")}</div>`
    + `<div class="pf-cost">单次花费超过 <input class="inp" data-pf="ask.cost" value="${esc(p.ask.cost)}" spellcheck="false"> k tokens 也先问你</div>`
    + `<label class="gl">交付标准 <em>做到什么程度才算完</em></label><textarea class="inp pf-ta" data-pf="done" spellcheck="false">${esc(p.done)}</textarea>`
    + `<label class="gl">汇报</label><div class="pf-chips">${chip("direct", "可以绕过 Manager 直接找你")}</div></div>`;
}
// 表单里的输入落到哪份人设上：s0..= 建组时第几个 Bot，m = 建组时的 Manager，d = 开工后正在改的草稿
function personaTarget(el) {
  const box = el.closest("[data-pctx]"), z = box && zoneOfEl(box), g = z && z.group;
  if (!g) return null;
  const c = box.dataset.pctx;
  return c === "d" ? g.pdraft : c === "m" ? g.mgrPersona : c[0] === "s" ? (g.bots[+c.slice(1)] || {}).persona : null;
}
function newGroup(opts) {
  opts = opts || {};
  return {
    stage: "setup", step: 1, sv: 0, err: "",
    name: "", goal: "", proj: opts.proj || (PROJECTS[0] || {}).name, budget: 500,
    manager: CFG.defAgent, mgrPersona: personaFor("Manager"), editBot: null, edit: false, pdraft: null,
    bots: [{ id: nid(), role: "开发", agent: CFG.defAgent, persona: personaFor("开发") }],
    members: [], feed: [], plan: [], used: 0, sel: null, adding: false, add: { role: "", agent: CFG.defAgent },
    ask: null, paused: false, draft: "",
  };
}
function groupValid(g, step) {
  if (step >= 1) {
    if (!g.name.trim()) return "给这个组起个名字";
    if (!g.proj) return "选一个项目（文件夹）";
  }
  if (step >= 2) {
    if (!g.bots.length) return "至少要有一个 Bot";
    if (g.bots.some((b) => !b.role.trim())) return "每个 Bot 都要有个角色名";
    const pend = [...new Set([g.manager, ...g.bots.map((b) => b.agent)])].filter((a) => !AG[a].installed);
    if (pend.length) { for (const a of pend) installAgent(a); return `还在装 ${pend.map((a) => AG[a].name).join("、")}，装好就能开工`; }
    const seen = new Set();
    for (const b of g.bots) { if (seen.has(b.role.trim())) return `角色「${b.role.trim()}」重复了`; seen.add(b.role.trim()); }
  }
  return "";
}
function startGroup(z) {
  const g = z.group;
  const err = groupValid(g, 2);
  if (err) { g.err = err; g.sv++; render(); return false; }
  g.stage = "run"; g.err = "";
  g.members = [{ id: "mgr", role: "Manager", agent: g.manager, st: "work", lines: [], model: CFG.agentModel[g.manager] || AG[g.manager].model, color: "#ececf1", persona: g.mgrPersona || personaFor("Manager") }]
    .concat(g.bots.map((b, i) => ({ id: b.id, role: b.role.trim(), agent: b.agent, st: "idle", lines: [], model: CFG.agentModel[b.agent] || AG[b.agent].model, color: ROLE_COLORS[i % ROLE_COLORS.length], persona: b.persona || personaFor(b.role.trim()) })));
  g.editBot = null;
  const bots = g.members.slice(1);
  g.feed.push({ sys: true, t: `Perch 在 ${g.proj} 里给 ${g.members.length} 个成员各开了一个工作副本（git worktree），互不踩脚`, fresh: true });
  g.plan = [
    { who: "mgr", t: g.goal.trim() ? `目标收到：${g.goal.trim()}。我拆成 ${bots.length} 件事。` : `开工。我先把活拆成 ${bots.length} 件。` },
    { who: "mgr", t: bots.map((b) => `@${b.role} ${ROLE_TASK[b.role] || "先熟悉一下项目"}`).join("；") },
  ];
  for (const b of bots) g.plan.push({ who: b.id, t: "收到，开工。" });
  for (const b of bots) for (const [k, t] of ROLE_WORK[b.role] || ROLE_WORK.def) g.plan.push(k === "act" ? { act: b.id, t } : { who: b.id, t });
  if (bots[0]) g.plan.push({ ask: bots[0].id, t: "改动都过了审阅和测试，要我合进 main 吗？" });
  g.plan.push({ who: "mgr", t: "这一轮都齐了。有新活直接在群里说，或者 @ 某个 Bot。" });
  z.gv++; g.sv++; render();
  return true;
}
// 给「形态」章、快捷布局用：直接填好一个在跑的组
function quickGroup(z) {
  const g = z.group;
  Object.assign(g, { name: "Perch 产品团队", goal: "给 Perch 加「中转站预设」：能检测接口、导入现有配置", proj: "Perch", manager: "claude",
    bots: [{ id: nid(), role: "开发", agent: "codex", persona: personaFor("开发") }, { id: nid(), role: "审阅", agent: "claude", persona: personaFor("审阅") }, { id: nid(), role: "测试", agent: "pi", persona: personaFor("测试") }] });
  startGroup(z);
}
function groupStep(z) {
  const g = z.group;
  if (g.stage !== "run" || g.paused || g.ask) return;
  const ev = g.plan.shift();
  if (!ev) { let ch = false; for (const m of g.members) if (m.st === "work") { m.st = "idle"; ch = true; } if (ch) z.gv++; return; }
  if (ev.sys) g.feed.push({ sys: true, t: ev.t, fresh: true });
  const id = ev.who || ev.act || ev.ask;
  const m = id && gm(g, id);
  if (m) {
    for (const o of g.members) if (o.st !== "wait") o.st = "idle";
    m.st = ev.ask ? "wait" : "work";
    if (ev.act) m.lines.push({ k: "act", t: ev.t });
    else { m.lines.push({ k: "say", t: ev.t }); g.feed.push({ mid: m.id, t: ev.t, ask: !!ev.ask, fresh: true }); }
    if (ev.ask) g.ask = { mid: m.id, t: ev.t };
    m.fresh = true;
  }
  g.used += 6 + Math.floor(Math.random() * 14);
  while (g.feed.length > 120) g.feed.shift();
  z.gv++;
}
function groupAnswer(z, yes) {
  const g = z.group, m = g.ask && gm(g, g.ask.mid);
  if (!m) return;
  g.feed.push({ mid: "you", t: yes ? "可以，合吧。" : "先别合，我再看看。", fresh: true });
  g.plan.unshift(yes ? { who: m.id, t: "合好了：main 上 3 个提交。" } : { who: m.id, t: "好，先放着，等你看完。" });
  m.st = "work"; g.ask = null; z.gv++; render();
}
function sendGroup(z, text) {
  const g = z.group;
  text = (text || "").trim();
  if (!text) return;
  g.feed.push({ mid: "you", t: text, fresh: true });
  g.draft = ""; g.gpinForce = true;
  const at = g.members.find((m) => m.id !== "mgr" && text.includes("@" + m.role));
  // 回应排在开工那一轮「收到，开工」之后，不然会出现先答话、后报到
  let k = 0; g.plan.forEach((e, i) => { if (e.who && e.t === "收到，开工。") k = i + 1; });
  const ins = (...evs) => g.plan.splice(k, 0, ...evs);
  if (at) ins({ who: at.id, t: "好，这就弄。" }, { act: at.id, t: "处理你刚说的：" + text.replace("@" + at.role, "").trim().slice(0, 30) }, { who: at.id, t: "弄好了，你看一眼。" });
  else {
    const b = g.members[1 + Math.floor(Math.random() * Math.max(1, g.members.length - 1))] || g.members[0];
    ins({ who: "mgr", t: `收到。这件交给 @${b.role}。` }, { who: b.id, t: "好，这就弄。" });
  }
  g.paused = false;
  z.gv++; render();
}
function sendPrivate(z, m, text) {
  text = (text || "").trim();
  if (!text) return;
  m.lines.push({ k: "me", t: text }); m.draft = "";
  m.fresh = true; z.gv++; render();
  setTimeout(() => { m.lines.push({ k: "say", t: "好，记下了。手上这件做完就弄。" }); m.st = "work"; m.fresh = true; z.gv++; render(); }, 1100);
}
function addBotToGroup(z) {
  const g = z.group, role = g.add.role.trim();
  if (!role) { g.err = "给新 Bot 起个角色名"; g.sv++; render(); return; }
  if (g.members.some((m) => m.role === role)) { g.err = `已经有「${role}」了`; g.sv++; render(); return; }
  if (g.members.length - 1 >= BG_MAX) { g.err = `一个组最多 ${BG_MAX} 个 Bot`; g.sv++; render(); return; }
  if (!AG[g.add.agent].installed) { ensureInstalled(g.add.agent, z); g.err = `还在装 ${AG[g.add.agent].name}，装好再加`; g.sv++; render(); return; }
  const tpl = PERSONA_TPL.find((x) => x.role === role);
  const m = { id: nid(), role, agent: g.add.agent, st: "idle", lines: [], model: CFG.agentModel[g.add.agent] || AG[g.add.agent].model, color: ROLE_COLORS[(g.members.length - 1) % ROLE_COLORS.length],
    persona: tpl ? clonePersona(tpl.persona) : personaFor(role) };
  g.members.push(m);
  g.feed.push({ sys: true, t: `${role}（${AG[m.agent].name}）加入了群 —— 也在 ${g.proj} 里有了自己的工作副本`, fresh: true });
  g.plan.unshift({ who: "mgr", t: `欢迎 @${role}。你来${ROLE_TASK[role] || "帮把手"}。` }, { who: m.id, t: "收到，开工。" },
    ...(ROLE_WORK[role] || ROLE_WORK.def).map(([k, t]) => k === "act" ? { act: m.id, t } : { who: m.id, t }));
  g.adding = false; g.err = ""; g.add = { role: "", agent: CFG.defAgent };
  g.sv++; z.gv++; render();
}
let TICKS = 0;
function tick() {
  const live = allLeaves().filter((x) => x.l.agent && x.l.state === "work");
  if (live.length) advance(live[Math.floor(Math.random() * live.length)].l);
  for (const { l } of allLeaves()) if (l.agent && l.state === "idle" && Math.random() < 0.025) {
    const ks = Object.keys(SCRIPTS).filter((k) => k !== (l.sk || l.agent));
    l.sk = ks[Math.floor(Math.random() * ks.length)]; l.state = "work"; l.si = 0; advance(l);
  }
  TICKS++;
  if (TICKS % 2 === 0) for (const z of Z) if (z.kind === "group") groupStep(z);
  for (const z of Z) if (z.kind === "app" && z.appz.playing) { z.appz.t += 1.3; if (z.appz.t > 210) { z.appz.song = (z.appz.song + 1) % SONGS.length; z.appz.t = 0; z.av++; } }
  render();
}
setInterval(tick, 1300);

/* ---------- 渲染 ---------- */
const ZEL = new Map(), TEL = new Map(), TABEL = new Map();
const tabsEl = $("#tabs");
function front(z) { if (z && z.zi !== ZTOP) { z.zi = ++ZTOP; const el = ZEL.get(z.id); if (el) el.style.zIndex = z.zi; } }
/* ---------- 收起成标签 ---------- */
function tabHTML(z) {
  const [t] = zoneTitle(z);
  let ic = "", st = "", wait = 0;
  if (z.kind === "agents") {
    const ls = leaves(z.root).filter((l) => l.agent);
    ic = ls.slice(0, 4).map((l) => `<span class="tl ${l.state}">${logo(l.agent)}</span>`).join("") || `<span class="tl">${ICON("sparkles", 14)}</span>`;
    const w = ls.filter((l) => l.state === "work").length;
    wait = ls.filter((l) => l.state === "wait").length;
    st = (w ? `${w} 在跑` : "空闲") + (wait ? ` · <em>${wait} 等你</em>` : "");
  } else if (z.kind === "group") {
    const g = z.group;
    ic = g.stage === "run" ? g.members.slice(0, 4).map((m) => `<span class="tl ${m.st}">${logo(m.agent)}</span>`).join("") : `<span class="tl">${ICON("users-round", 14)}</span>`;
    const sp = g.members.find((m) => m.st === "work");
    wait = g.ask ? 1 : 0;
    st = g.stage !== "run" ? "还在建组" : g.ask ? `<em>${esc(gm(g, g.ask.mid).role)} 等你拍板</em>` : sp ? `${esc(sp.role)} 在干活` : `${g.members.length} 个成员 · 空闲`;
  } else if (z.kind === "web" || z.kind === "app") {
    const a = APPS.find((x) => x.id === (z.web ? z.web.app : z.appz.id));
    ic = `<span class="tl">${appIcon(a, 14)}</span>`;
    st = z.kind === "web" ? esc(hostOf(z.web.url)) : z.appz.id === "music" ? (z.appz.playing ? "正在播放 · " + esc(SONGS[z.appz.song][0]) : "暂停中") : "外部应用";
  } else if (z.kind === "files") {
    ic = `<span class="tl">${ICON("folder-tree", 14)}</span>`;
    st = `${esc(z.fz.proj)} · ${(TOUCH[z.fz.proj] || []).length} 个碰过的`;
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
}
// 展开回原位；原位被别的块占了（不允许重叠时）就找块空地，还找不到就留在标签上并说明原因。
function expandZone(z, quiet) {
  if (!z.collapsed) return true;
  const d = desk(), mn = zoneMin(z);
  let r = { x: z.x, y: z.y, w: Math.min(z.w, d.w), h: Math.min(z.h, d.h) };
  r.x = clamp(r.x, d.x, d.x + d.w - r.w); r.y = clamp(r.y, d.y, d.y + d.h - r.h);
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
  return true;
}
// 全部收起：标签沿着 Dock 排开（Dock 在下就排在它上面，在左就竖着排在它右边）
function collapseAll() {
  const open = Z.filter((z) => !z.collapsed);
  if (!open.length) { expandAll(); return; }
  for (const z of open) { z.collapsed = true; z.focus = null; z.tab = z.tab || { x: z.x, y: z.y }; }
  render();
  lineUpTabs(Z.filter((z) => z.collapsed));
}
function lineUpTabs(zs) {
  const side = dockSide(), dr = dockEl.getBoundingClientRect(), G = 8;
  const els = zs.map((z) => TABEL.get(z.id));
  if (side === "left" || side === "right") {
    const total = els.reduce((s, e) => s + e.offsetHeight + G, -G);
    let y = clamp(dr.top + dr.height / 2 - total / 2, 12, innerHeight - total - 12);
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
      z.tab.x = clamp(s.x + x - x0, 6, innerWidth - el.offsetWidth - 6);
      z.tab.y = clamp(s.y + y - y0, 6, innerHeight - el.offsetHeight - 6);
      el.style.left = z.tab.x + "px"; el.style.top = z.tab.y + "px";
    },
    up() { el.classList.remove("dragging"); if (!moved) expandZone(z); },
  };
}
const zonesEl = $("#zones");
const soloLeaf = (z) => z.kind === "agents" && z.root && z.root.t === "leaf" && z.root.agent ? z.root : null;
function zoneTitle(z) {
  if (z.kind === "group") return z.group.stage === "run" ? [z.group.name, `Bot Group · ${z.group.members.length} 个成员 · ${z.group.proj}`] : [z.group.name.trim() || "新的 Bot Group", "Bot Group · 建组中"];
  if (z.kind === "files") return ["文件", `${z.fz.proj} · ${(TOUCH[z.fz.proj] || []).length} 个碰过的`];
  if (z.kind === "web") {
    if (z.web.url.includes("/search?q=")) return ["搜索：" + decodeURIComponent(z.web.url.split("q=")[1] || ""), "网页 · " + hostOf(z.web.url)];
    const a = APPS.find((x) => x.id === z.web.app);
    return [a && hostOf(a.url) === hostOf(z.web.url) ? a.name : hostOf(z.web.url), "网页 · " + z.web.url];
  }
  if (z.kind === "app") { const a = APPS.find((x) => x.id === z.appz.id) || {}; return [a.name || "应用", "外部应用 · 它自己的窗口吸附在这一块"]; }
  if (z.kind === "new") return ["新的一块", "选一下这块拿来干什么"];
  const ls = leaves(z.root);
  const named = ls.filter((l) => l.agent);
  const projs = [...new Set(named.map((l) => l.proj))].join(" · ");
  if (ls.length === 1) return named.length ? [AG[ls[0].agent].name, ls[0].proj] : ["单个 Agent", ""];
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
// 一格的小控件（碰过的文件数、模型、状态点）：多格时在格头，单格时搬到块头。
function leafCtlHTML(l) {
  const n = touchedBy(l).length;
  return (n ? `<button class="tf${l.peek ? " on" : ""}" data-tfiles data-leaf="${l.id}" title="它碰过的文件">${ICON("files", 13)}<em>${n}</em></button>` : "")
    + `<button class="md${l.pend ? " pend" : ""}" data-tmodel data-leaf="${l.id}" title="换模型：不用重启">${esc(l.pend ? "→ " + l.pend : l.model)}</button>`
    + `<i class="dot ${l.state}"></i>`;
}
function render() {
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
    $(".zt", el).textContent = t;
    $(".zk", el).textContent = k;
    const zx = $(".zx", el);
    const zxKey = solo ? solo.id + ":" + solo.v + ":" + touchedBy(solo).length : "";
    if (zx._k !== zxKey) { zx._k = zxKey; zx.innerHTML = solo ? leafCtlHTML(solo) : ""; }
    const zb = $(".zb", el);
    if (z.kind === "new") {
      if (zb.dataset.mode !== "new") {
        zb.dataset.mode = "new";
        zb.innerHTML = `<div class="choose">`
          + `<button class="ch" data-choose="par"><span class="ic">${ICON("layout-dashboard", 22)}</span><b>并行 Agents</b><span>一块里放几个 agent，大小自己切</span></button>`
          + `<button class="ch" data-choose="one"><span class="ic">${ICON("sparkles", 22)}</span><b>单个 Agent</b><span>专心盯一个</span></button>`
          + `<button class="ch" data-choose="group"><span class="ic">${ICON("users-round", 22)}</span><b>Bot Group</b><span>一个目标，一队 Bot 分工</span></button>`
          + `<button class="ch" data-choose="files"><span class="ic">${ICON("folder-tree", 22)}</span><b>文件</b><span>看项目里的文件和 agent 改了什么</span></button></div>`;
      }
    } else if (z.kind === "group") {
      if (zb.dataset.mode !== "group") { zb.dataset.mode = "group"; zb.innerHTML = ""; zb._sk = ""; }
      renderGroup(z, zb);
    } else if (z.kind === "web") {
      if (zb.dataset.mode !== "web") { zb.dataset.mode = "web"; zb._wv = -1; }
      if (zb._wv !== z.wv) { zb._wv = z.wv; zb.innerHTML = webHTML(z); }
    } else if (z.kind === "app") {
      if (zb.dataset.mode !== "app") { zb.dataset.mode = "app"; zb._av = -1; }
      if (zb._av !== z.av) { zb._av = z.av; zb.innerHTML = appHTML(z); }
      const pr = $(".am-prog i", zb); if (pr) pr.style.width = Math.min(100, z.appz.t / 2.1) + "%";
    } else if (z.kind === "files") {
      if (zb.dataset.mode !== "files") { zb.dataset.mode = "files"; zb.innerHTML = ""; zb._fk = ""; }
      const narrow = bodyRect(z).w < 540;
      const key = z.fv + ":" + TV + ":" + narrow;
      if (zb._fk !== key) {
        zb._fk = key;
        const sc = $(".fz-list", zb), st = sc ? sc.scrollTop : 0;
        zb.innerHTML = filesHTML(z, narrow);
        const sc2 = $(".fz-list", zb); if (sc2) sc2.scrollTop = st;
      }
    } else {
      if (zb.dataset.mode !== "agents") { zb.dataset.mode = "agents"; zb.innerHTML = ""; }
      renderTiles(z, zb);
    }
  }
  for (const [id, el] of ZEL) if (!Z.some((z) => z.id === id)) { el.remove(); ZEL.delete(id); }
  for (const [id, el] of TABEL) if (!Z.some((z) => z.id === id)) { el.remove(); TABEL.delete(id); }
  syncDock();
}
function renderTiles(z, zb) {
  const { tiles, divs } = zoneLayout(z);
  const ids = new Set(tiles.map((t) => t.leaf.id));
  for (const el of $$(".tile", zb)) if (!ids.has(el.dataset.leaf)) el.remove();
  const full = bodyRect(z);
  for (const { leaf, rc } of tiles) {
    let el = TEL.get(leaf.id);
    if (!el) { el = document.createElement("div"); el.className = "tile"; el.dataset.leaf = leaf.id; TEL.set(leaf.id, el); el._v = -1; }
    if (el.parentNode !== zb) zb.appendChild(el);
    const r = z.focus ? (z.focus === leaf.id ? full : rc) : rc;
    el.style.left = r.x + "px"; el.style.top = r.y + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px";
    el.classList.toggle("hid", !!z.focus && z.focus !== leaf.id);
    el.classList.toggle("small", r.w < 330 || r.h < 230);
    el.classList.toggle("empty", !leaf.agent);
    el.classList.toggle("st-wait", leaf.state === "wait");
    const key = leaf.v + ":" + touchedBy(leaf).length;
    if (el._v !== key) {
      el._v = key;
      // 格子里能往上翻看上下文：停在最底下就跟着新内容走；翻上去了就原地不动，提示「有新内容」
      // 「贴底」只由用户自己的滚动改；格子被拖小、被重排都不算翻上去
      const tb = $(".tb", el), st = tb ? tb.scrollTop : 0, pinned = leaf.pin !== false;
      const grew = leaf.fresh;
      el.innerHTML = leaf.agent ? tileHTML(leaf) : pickHTML(leaf); leaf.fresh = false;
      const tb2 = $(".tb", el);
      if (tb2) { if (pinned) tb2.scrollTop = tb2.scrollHeight; else { tb2.scrollTop = st; if (grew) leaf.unseen = true; } }
      const nb = $(".tb-new", el); if (nb) nb.hidden = !leaf.unseen;
    } else if (leaf.pin !== false) {
      const tb = $(".tb", el);
      if (tb && tb.scrollHeight - tb.scrollTop - tb.clientHeight > 2) tb.scrollTop = tb.scrollHeight;
    }
  }
  for (const d of $$(".dv", zb)) d.remove();
  if (!z.focus) for (const d of divs) {
    const e = document.createElement("div");
    e.className = "dv " + d.sp.dir;
    e.style.left = d.at.x + "px"; e.style.top = d.at.y + "px"; e.style.width = d.at.w + "px"; e.style.height = d.at.h + "px";
    e._d = d;
    if (z.live && z.dragSplit === d.sp) e.classList.add("on");
    zb.appendChild(e);
  }
}
const KIND_TXT = { edit: "改", new: "新", read: "读" };
function peekHTML(l) {
  const fs = touchedBy(l).slice(0, 10);
  return `<div class="peek"><h5>${esc(AG[l.agent].name)} 在 ${esc(l.proj)} 里碰过的文件</h5>`
    + fs.map((e) => `<button class="fr" data-peekf="${esc(e.path)}" data-leaf="${l.id}"><span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span><b>${esc(e.path.split("/").pop())}</b><span class="fd">${esc(e.path.split("/").slice(0, -1).join("/"))}</span></button>`).join("")
    + `</div>`;
}
function tileHTML(l) {
  const a = AG[l.agent];
  const n = l.lines.length;
  const lines = l.lines.map((x, i) => `<div class="ln ${x.k}${l.fresh && i === n - 1 ? " new" : ""}">${esc(x.t)}</div>`).join("");
  const ask = l.ask ? `<div class="ask"><span>${esc(l.ask)}</span><button class="y" data-ans="yes">允许</button><button data-ans="no">先别</button></div>` : "";
  return `<div class="th">${logo(l.agent)}<b>${esc(a.name)}</b><span class="pj">${esc(l.proj)}</span><span class="sp"></span>`
    + leafCtlHTML(l) + `<button class="x" data-tclose title="关掉这一格">${ICON("x", 13)}</button></div>`
    + `<div class="tb">${lines}${ask}</div><button class="tb-new" data-tbnew hidden>有新内容 ↓</button>`
    + `<div class="ti"><span>跟它说…</span><span class="sp"></span><i>${ICON("arrow-up", 13, 2)}</i></div>`
    + (l.peek ? peekHTML(l) : "")
    + ["right", "bottom", "left", "top"].map((s) => `<button class="plus" data-plus="${s}" title="往${{ right: "右", bottom: "下", left: "左", top: "上" }[s]}切出一格">${ICON("plus", 11, 2.6)}</button>`).join("");
}
function pickHTML(l) {
  if (l.installing) {
    const id = l.installing, s = INST[id] || { pct: 0 };
    return `<div class="pick inst"><span class="inst-ic">${agiHTML(id)}</span><b>正在装 ${esc(AG[id].name)}</b>`
      + `<span class="inst-t" data-insttxt="${id}">${instPhase(s.pct)} ${Math.round(s.pct)}%</span>`
      + `<em>从官方渠道下载安装，装好就在这一格里启动；只装一次，以后哪里都能直接用。</em><button class="btn" data-instcancel>换一个</button></div>`;
  }
  return `<div class="pick"><h4>这一格放哪个 Agent？<span class="pk-ni">灰色的还没装：鼠标移上去点一下，就地下载</span></h4><div class="pk-g">`
    + AGENTS.map((a) => `<button class="pk-a${a.id === CFG.defAgent ? " def" : ""}${a.installed ? "" : " ni"}" data-pick="${a.id}" title="${esc(a.name)}${a.installed ? "" : "（还没装，点了就地下载）"}">${agiHTML(a.id)}${agLabel(a, a.name)}</button>`).join("")
    + `</div><div class="pk-p">在${PROJECTS.map((p) => `<button data-proj="${esc(p.name)}" class="${p.name === l.proj ? "on" : ""}">${esc(p.name)}</button>`).join("")}`
    + `<button class="add" data-projadd title="加一个文件夹">+ 文件夹</button>里干活</div></div>`;
}
/* Bot Group 的块：建组时是三步向导（都在块里，不弹窗）；开工后是群聊 + 成员 + 成员详情抽屉。
   骨架（有输入框的部分）只在结构变了才重画；群消息、成员状态这些常变的部分单独刷新，
   这样你在输入框里打字、用输入法组字时，不会被每 2.6 秒一次的新消息打断。 */
function agentPick(attr, cur, compact) {
  return `<div class="g-ags${compact ? " compact" : ""}">${AGENTS.map((a) => `<button class="g-ag${a.id === cur ? " on" : ""}${a.installed ? "" : " ni"}" ${attr}="${a.id}" title="${esc(a.name)}${a.installed ? "" : "（还没装，选了就在后台下载）"}">${agiHTML(a.id)}${compact ? "" : agLabel(a, a.name.replace(" Harness", "").replace(" CLI", ""))}</button>`).join("")}</div>`;
}
// 建组 / 加 Bot 时选到没装的 agent：后台下载，装好刷新这一块
const ensureInstalled = (id, z) => { if (!AG[id].installed) installAgent(id, () => { if (z.group) z.group.sv++; render(); }); };
function groupSetupHTML(z) {
  const g = z.group, s = g.step;
  const steps = ["目标与项目", "成员", "开工"].map((t, i) => `<span class="${i + 1 === s ? "on" : i + 1 < s ? "done" : ""}"><em>${i + 1 < s ? "✓" : i + 1}</em>${t}</span>`).join("<i></i>");
  let body = "";
  if (s === 1) {
    const p = projByName(g.proj);
    body = `<label class="gl">名字</label><input class="inp" data-gf="name" value="${esc(g.name)}" placeholder="比如：官网改版小队" spellcheck="false" autocomplete="off">`
      + `<label class="gl">目标 <em>Manager 会照这个拆活</em></label><textarea class="inp gs-ta" data-gf="goal" placeholder="这个组要做成什么？" spellcheck="false">${esc(g.goal)}</textarea>`
      + `<label class="gl">在哪个项目里干</label><div class="pk-p gs-pj">${PROJECTS.map((x) => `<button data-gproj="${esc(x.name)}" class="${x.name === g.proj ? "on" : ""}">${esc(x.name)}</button>`).join("")}<button class="add" data-gprojadd>+ 文件夹</button></div>`
      + (p ? `<div class="gs-path">${esc(p.path)}</div>` : "")
      + `<label class="gl">预算上限 <em>花到了会先停下问你</em></label><div class="seg">${[[200, "200k"], [500, "500k"], [1000, "1M"], [0, "不限"]].map(([v, t]) => `<button data-gbud="${v}" class="${g.budget === v ? "on" : ""}">${t} tokens</button>`).join("")}</div>`;
  } else if (s === 2) {
    body = `<label class="gl">Manager <em>负责拆活、派活、汇总，有事找你拍板</em><button class="gb-pe${g.editBot === "m" ? " on" : ""}" data-gbedit="m">${ICON("id-card", 13)}人设与岗位</button></label>${agentPick("data-gmgr", g.manager)}`
      + (g.editBot === "m" ? `<div class="gb-pf">${personaFormHTML(g.mgrPersona, "m")}</div>` : "")
      + `<label class="gl">Bot（${g.bots.length} / ${BG_MAX}）<em>一个角色配一个 agent；「人设」里写清它具体干什么</em></label>`
      + g.bots.map((b, i) => `<div class="gb-row" style="--c:${ROLE_COLORS[i % ROLE_COLORS.length]}"><i class="gb-dot"></i>`
        + `<input class="inp" data-gbrole="${i}" value="${esc(b.role)}" placeholder="角色，比如 开发" spellcheck="false" autocomplete="off">`
        + agentPick(`data-gbag="${i}" data-gba`, b.agent, true)
        + `<button class="gb-pe${g.editBot === i ? " on" : ""}" data-gbedit="${i}" title="人设与岗位">${ICON("id-card", 13)}人设</button>`
        + `<button class="gb-x" data-gbdel="${i}" title="去掉这个 Bot">${ICON("x", 13)}</button></div>`
        + (g.editBot === i ? `<div class="gb-pf">${personaFormHTML(b.persona, "s" + i)}</div>` : "")).join("")
      + `<div class="gb-pre">${ROLE_PRESETS.filter((r) => !g.bots.some((b) => b.role.trim() === r)).map((r) => `<button data-gbpre="${r}">+ ${r}</button>`).join("")}`
      + PERSONA_TPL.map((t, i) => `<button data-gbtpl="${i}" class="tpl">+ ${esc(t.name)}</button>`).join("")
      + `<button data-gbpre="">+ 自定义</button></div>`;
  } else {
    const p = projByName(g.proj);
    body = `<div class="gs-sum"><div class="gs-sum-h"><b>${esc(g.name)}</b><span>${esc(g.proj)} · ${esc(p ? p.path : "")}</span></div>`
      + (g.goal.trim() ? `<p>${esc(g.goal)}</p>` : `<p class="dim">（没写目标：开工后直接在群里跟 Manager 说）</p>`)
      + `<div class="gs-mem"><span class="gm-c">${logo(g.manager)}Manager · ${esc(AG[g.manager].name)}</span>`
      + g.bots.map((b, i) => `<span class="gm-c" style="--c:${ROLE_COLORS[i % ROLE_COLORS.length]}"><i class="gb-dot"></i>${logo(b.agent)}${esc(b.role)} · ${esc(AG[b.agent].name)}</span>`).join("") + `</div>`
      + `<div class="gs-note">开工后：Perch 在 ${esc(g.proj)} 里给每个成员各开一个工作副本（git worktree），互不踩脚。Manager 先拆活派活；要你拍板的事会在群里问你，Dock 的铃铛也会亮。预算 ${g.budget ? g.budget + "k tokens" : "不限"}。</div></div>`;
  }
  const err = g.err ? `<span class="gs-err">${esc(g.err)}</span>` : `<span></span>`;
  const foot = `${err}<span class="sp"></span>${s > 1 ? `<button class="btn" data-gprev>上一步</button>` : ""}`
    + (s < 3 ? `<button class="btn pri" data-gnext>下一步</button>` : `<button class="btn pri" data-gstart>${ICON("sparkles", 14)}开工</button>`);
  return `<div class="gs"><div class="gs-steps">${steps}</div><div class="gs-body">${body}</div><div class="gs-foot">${foot}</div></div>`;
}
function groupRunSkeleton(z) {
  const g = z.group;
  const add = g.adding ? `<div class="g-add"><b>加一个 Bot</b><div class="gb-pre">${ROLE_PRESETS.filter((r) => !g.members.some((m) => m.role === r)).map((r) => `<button data-gaddpre="${r}" class="${g.add.role === r ? "on" : ""}">${r}</button>`).join("")}</div>`
    + `<input class="inp" data-gaddrole value="${esc(g.add.role)}" placeholder="角色名" spellcheck="false" autocomplete="off">${agentPick("data-gaddag", g.add.agent, true)}`
    + `<div class="g-add-f">${g.err ? `<span class="gs-err">${esc(g.err)}</span>` : ""}<span class="sp"></span><button class="btn" data-gaddcancel>取消</button><button class="btn pri" data-gaddok>加进来</button></div></div>` : "";
  const m = g.sel && gm(g, g.sel);
  const drawer = !m ? "" : g.edit
    ? `<div class="g-drawer"><div class="gd-h2">${logo(m.agent)}<b>${esc(m.role)} 的人设与岗位</b><span class="sp"></span><button class="gd-x" data-gpecancel title="不改了">${ICON("x", 13)}</button></div>`
      + `<div class="gd-pf">${personaFormHTML(g.pdraft, "d", m.id === "mgr" ? undefined : g.pdraft.title)}</div>`
      + `<div class="gd-f"><span class="pf-note">保存后写进它的岗位说明，下一轮起按新的来，不用重启</span><span class="sp"></span><button class="btn" data-gpetpl>存成模板</button><button class="btn pri" data-gpesave>保存</button></div></div>`
    : `<div class="g-drawer"><div class="gd-h"></div><div class="gd-duty"></div><div class="tb gd-lines"></div>`
      + `<div class="ti gd-ti"><input class="g-in gd-in" data-gdin placeholder="单聊 ${esc(m.role)}：只有它看得到" spellcheck="false" autocomplete="off"><button data-gpsend title="发送">${ICON("arrow-up", 13, 2)}</button></div>`
      + `<div class="gd-f"><button class="btn" data-gpedit>${ICON("id-card", 13)}人设与岗位</button><span class="sp"></span>${m.id !== "mgr" ? `<button class="btn" data-gkick>${ICON("trash-2", 13)}移出群</button>` : ""}</div></div>`;
  return `<div class="grp"><div class="g-top"></div><div class="g-mem"></div>${add}`
    + `<div class="g-main${m ? " has-d" : ""}"><div class="g-feed"></div>${drawer}</div>`
    + `<div class="ti g-ti"><input class="g-in" data-gin placeholder="在群里说… 用 @角色 点名某个 Bot" value="${esc(g.draft || "")}" spellcheck="false" autocomplete="off"><button data-gsend title="发送">${ICON("arrow-up", 13, 2)}</button></div></div>`;
}
function feedMsgHTML(g, x, last) {
  const cls = `gmsg${x.fresh && last ? " new" : ""}`;
  if (x.sys) return `<div class="gmsg sys${x.fresh && last ? " new" : ""}">${esc(x.t)}</div>`;
  if (x.mid === "you") return `<div class="${cls} you"><div><b>你</b>${esc(x.t)}</div></div>`;
  const m = gm(g, x.mid) || { role: "?", agent: "claude", color: "#fff" };
  const ask = x.ask && g.ask && g.ask.mid === x.mid ? `<div class="ask"><span>等你拍板</span><button class="y" data-gans="yes">允许</button><button data-gans="no">先别</button></div>` : "";
  return `<div class="${cls}" style="--c:${m.color}">${logo(m.agent)}<div><b>${esc(m.role)}<em>${esc(AG[m.agent].name)}</em></b>${esc(x.t)}${ask}</div></div>`;
}
function renderGroup(z, zb) {
  const g = z.group;
  const sk = g.stage + ":" + g.sv + ":" + (g.stage === "run" ? (g.sel || "") + ":" + (g.adding ? 1 : 0) + ":" + (g.edit ? 1 : 0) : g.step);
  if (zb._sk !== sk) {
    zb._sk = sk; zb._gv = -1;
    zb.innerHTML = g.stage === "run" ? groupRunSkeleton(z) : groupSetupHTML(z);
    if (g.stage === "run" && g.adding) setTimeout(() => { const i = $("[data-gaddrole]", zb); if (i && !g.add.role) i.focus(); }, 30);
  }
  if (g.stage !== "run" || zb._gv === z.gv) return;
  zb._gv = z.gv;
  const used = g.budget ? Math.min(100, Math.round(g.used / g.budget * 100)) : 0;
  $(".g-top", zb).innerHTML = `<div class="g-goal"><span>目标</span>${esc(g.goal || "（还没写）")}</div><span class="sp"></span>`
    + `<span class="g-bud" title="已经花掉的 / 预算上限"><i style="width:${used}%"></i><em>${g.used}k / ${g.budget ? g.budget + "k" : "不限"}</em></span>`
    + `<button class="btn" data-gpause>${g.paused ? "继续" : "全部暂停"}</button>`;
  $(".g-mem", zb).innerHTML = g.members.map((m) => `<button class="gm-c ${m.st}${g.sel === m.id ? " on" : ""}" data-gmem="${m.id}" style="--c:${m.color}">${m.id !== "mgr" ? `<i class="gb-dot"></i>` : ""}${logo(m.agent)}${esc(m.role)}<i class="dot ${m.st}"></i></button>`).join("")
    + (g.members.length - 1 < BG_MAX ? `<button class="gm-c add" data-gadd>${ICON("plus", 12, 2.2)}加 Bot</button>` : "");
  const f = $(".g-feed", zb), st = f.scrollTop, pinned = z.gpin !== false || g.gpinForce;
  const n = g.feed.length;
  f.innerHTML = g.feed.map((x, i) => feedMsgHTML(g, x, i === n - 1)).join("");
  for (const x of g.feed) x.fresh = false;
  f.scrollTop = pinned ? f.scrollHeight : st;
  if (g.gpinForce) { g.gpinForce = false; z.gpin = true; }
  const m = g.sel && gm(g, g.sel);
  if (m) {
    const gdh = $(".gd-h", zb); if (gdh) gdh.innerHTML = `${logo(m.agent)}<b>${esc(m.role)}</b><span class="dim">${esc(AG[m.agent].name)}</span><span class="sp"></span>`
      + `<button class="md" data-gmodel title="换模型：不用重启">${esc(m.model)}</button><i class="dot ${m.st}"></i><button class="gd-x" data-gdclose title="收起">${ICON("x", 13)}</button>`;
    const L = $(".gd-lines", zb);
    if (L) {
      const lst = L.scrollTop, lp = L.scrollHeight - L.scrollTop - L.clientHeight < 12 || m.fresh;
      L.innerHTML = m.lines.length ? m.lines.map((x) => `<div class="ln ${x.k}">${esc(x.t)}</div>`).join("") : `<div class="ln sys">还没开始干活</div>`;
      L.scrollTop = lp ? L.scrollHeight : lst;
      m.fresh = false;
      const du = $(".gd-duty", zb);
      if (du) du.innerHTML = m.persona && m.persona.duty ? `<span>职责</span>${esc(m.persona.duty)}` : `<span>职责</span>还没写 —— 点下面「人设与岗位」写清楚它干什么`;
    }
  }
}
/* ---------- 应用：启动台 + 网页块 + 外部应用块 ---------- */
const APPS = [
  { id: "music", name: "网易云音乐", kind: "app", ic: "music", color: "#e60026" },
  { id: "wechat", name: "微信", kind: "app", ic: "message-circle", color: "#07c160" },
  { id: "edge", name: "Microsoft Edge", kind: "web", url: "https://www.bing.com", ic: "globe", color: "#1f8fd6" },
  { id: "douyin", name: "抖音", kind: "web", url: "https://www.douyin.com", ic: "video", color: "#161823" },
  { id: "x", name: "X", kind: "web", url: "https://x.com", letter: "𝕏", color: "#000" },
  { id: "bili", name: "哔哩哔哩", kind: "web", url: "https://www.bilibili.com", ic: "video", color: "#fb7299" },
  { id: "notion", name: "Notion", kind: "web", url: "https://www.notion.so", letter: "N", color: "#f4f4f2", fg: "#111" },
  { id: "figma", name: "Figma", kind: "web", url: "https://www.figma.com", ic: "image", color: "#a259ff" },
  { id: "vscode", name: "Visual Studio Code", kind: "app", ic: "file-text", color: "#0a7acc" },
  { id: "notepad", name: "记事本", kind: "app", ic: "notebook-pen", color: "#2f6fde" },
  { id: "calc", name: "计算器", kind: "app", ic: "calculator", color: "#4b5563" },
  { id: "steam", name: "Steam", kind: "game", ic: "gamepad-2", color: "#1b2838" },
];
const SONGS = [["清晨的咖啡", "Lo-fi 工作歌单"], ["雨天写代码", "Lo-fi 工作歌单"], ["深夜构建", "Lo-fi 工作歌单"], ["慢慢来", "Lo-fi 工作歌单"], ["窗外的风", "Lo-fi 工作歌单"], ["回车键", "Lo-fi 工作歌单"]];
const DOUYIN = [["#工作间隙 #解压 看猫把纸箱拆了", "#ff5e8a", "#5b2bff", "12.4w"], ["#程序员 一分钟讲清楚 git worktree", "#1fd1a5", "#0b3d91", "3.1w"], ["#桌面布局 我的极简工作台", "#f7b733", "#fc4a1a", "8.7w"]];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
const appIcon = (a, s) => !a ? ICON("app-window", s) : a.letter ? `<b class="ai-l" style="color:${a.fg || "#fff"}">${a.letter}</b>` : ICON(a.ic, s);
function webHTML(z) {
  const w = z.web, h = hostOf(w.url);
  let page = "";
  if (h === "douyin.com") {
    const [cap, c1, c2, likes] = DOUYIN[w.n % DOUYIN.length];
    page = `<div class="pg-dy"><div class="dy-v" style="background:linear-gradient(160deg,${c1},${c2})"><span class="dy-play">${ICON("play", 34, 1.6)}</span><div class="dy-cap">@工作间隙研究所<br>${esc(cap)}</div></div>`
      + `<div class="dy-side"><span>${ICON("heart", 22)}<em>${likes}</em></span><span>${ICON("message-circle", 22)}<em>2,318</em></span><button data-wnext title="下一个">${ICON("chevron-down", 22)}</button></div></div>`;
  } else if (h === "x.com") {
    const posts = [["Perch", "@perch_app", "台面形态预览：圈一块地方、往里放 agent，像一张纸一样切分。"], ["Ada", "@ada_dev", "把 5 个 agent 并排摆着跑，比切 tab 舒服太多了"], ["Lin", "@lin_ui", "glass + 真壁纸，这个质感对了"], ["Bot Group 爱好者", "@bg_fan", "Manager 派活、Bot 各干各的、有事才找我，这才是协作"]];
    page = `<div class="pg-x">${posts.map(([n, u, t]) => `<div class="x-post"><i>${n[0]}</i><div><b>${esc(n)} <em>${u}</em></b><p>${esc(t)}</p><span>${ICON("message-circle", 13)} 12　${ICON("repeat", 13)} 48　${ICON("heart", 13)} 316</span></div></div>`).join("")}</div>`;
  } else if (h === "bilibili.com") {
    const vs = [["一小时 Lo-fi 编程音乐", "#7f5af0"], ["Windows 桌面美化合集", "#2cb67d"], ["从零写一个 TUI", "#ef4565"], ["AI agent 协作实测", "#3da9fc"], ["机械键盘开箱", "#ff8906"], ["极简工作台布置", "#e53170"]];
    page = `<div class="pg-bili">${vs.map(([t, c], i) => `<div class="bv"><div class="bv-t" style="background:linear-gradient(135deg,${c},#111)">${ICON("play", 22, 1.6)}</div><b>${esc(t)}</b><span>${(i + 2) * 7}.${i}w 播放</span></div>`).join("")}</div>`;
  } else if (h === "bing.com" && w.url.includes("/search?q=")) {
    const q = decodeURIComponent(w.url.split("q=")[1] || "");
    page = `<div class="pg-sr"><div class="sr-q">${ICON("search", 15)}<input class="inp" data-wq value="${esc(q)}" spellcheck="false"></div>`
      + [1, 2, 3, 4, 5].map((i) => `<div class="sr-r"><span>example${i}.com › ${esc(q).slice(0, 12)}</span><b>${esc(q)} —— 第 ${i} 条结果</b><p>（模拟搜索结果）这里是摘要：和「${esc(q)}」有关的内容……</p></div>`).join("") + `</div>`;
  } else if (h === "bing.com") {
    page = `<div class="pg-home"><b>搜点什么</b><div class="sr-q big">${ICON("search", 17)}<input class="inp" data-wq placeholder="输入关键词，回车" spellcheck="false"></div><span>（模拟的起始页）</span></div>`;
  } else {
    page = `<div class="pg-gen"><b>${esc(h)}</b><p>（模拟页面）真产品里这里就是这个网站本身，用 Perch 内置的浏览器内核打开，登录状态会记住。</p><div class="gen-blk"></div><div class="gen-blk s"></div><div class="gen-blk"></div></div>`;
  }
  return `<div class="wb"><div class="wb-bar"><button data-wback title="后退"${w.hi > 0 ? "" : " class=\"na\""}>${ICON("chevron-left", 16)}</button><button data-wreload title="刷新">${ICON("rotate-cw", 14)}</button>`
    + `<input class="inp wb-url" data-wurl value="${esc(w.url)}" spellcheck="false" autocomplete="off"><button data-wext title="在外部浏览器打开">${ICON("external-link", 14)}</button></div>`
    + `<div class="wb-page">${page}</div><div class="wb-note">网页 · Perch 内置的浏览器内核（WebView2），登录状态会记住 · 模拟页面</div></div>`;
}
function webGo(z, raw) {
  let u = String(raw || "").trim();
  if (!u) return;
  if (!/^https?:\/\//.test(u)) u = /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(u) ? "https://" + u : "https://www.bing.com/search?q=" + encodeURIComponent(u);
  const w = z.web;
  w.hist = w.hist.slice(0, w.hi + 1).concat([u]); w.hi = w.hist.length - 1; w.url = u;
  z.wv++; render();
}
function appHTML(z) {
  const s = z.appz, a = APPS.find((x) => x.id === s.id) || {};
  const bar = `<div class="ap-bar">${appIcon(a, 13)}<span>外部应用 · ${esc(a.name)} 自己的窗口吸附在这一块，跟着块移动、缩放</span><span class="sp"></span><button class="btn" data-apop>弹出成普通窗口</button></div>`;
  let body;
  if (s.id === "music") {
    const [t, al] = SONGS[s.song];
    body = `<div class="am"><div class="am-art"><span>${ICON("music", 40, 1.4)}</span></div><div class="am-info"><em>${esc(al)}</em><b>${esc(t)}</b><span>第 ${s.song + 1} 首 · 共 ${SONGS.length} 首</span>`
      + `<div class="am-prog"><i></i></div><div class="am-ctl"><button data-amprev>${ICON("skip-back", 18)}</button><button class="pl" data-amplay>${ICON(s.playing ? "pause" : "play", 22)}</button><button data-amnext>${ICON("skip-forward", 18)}</button><button data-amlike class="${s.like ? "on" : ""}">${ICON("heart", 17)}</button></div></div>`
      + `<div class="am-list">${SONGS.map(([n], i) => `<button data-amsong="${i}" class="${i === s.song ? "on" : ""}"><em>${i + 1}</em>${esc(n)}</button>`).join("")}</div></div>`;
  } else if (s.id === "wechat") {
    body = `<div class="wx"><div class="wx-l">${[["文件传输助手", "截图.png"], ["Perch 内测群", "[3 条] 新版台面太好看了"], ["家人", "晚上回来吃饭吗"], ["设计讨论", "Dock 竖着放也挺好"]].map(([n, m], i) => `<div class="wx-c${i === 1 ? " on" : ""}"><i>${n[0]}</i><div><b>${esc(n)}</b><span>${esc(m)}</span></div></div>`).join("")}</div>`
      + `<div class="wx-r"><div class="wx-m"><i>A</i><p>新版台面太好看了</p></div><div class="wx-m"><i>L</i><p>Bot Group 那个建组流程顺</p></div><div class="wx-m me"><p>还在改，下周给你们发</p></div></div></div>`;
  } else {
    body = `<div class="ap-gen"><span class="ap-ic" style="background:${a.color || "#444"}">${appIcon(a, 30)}</span><b>${esc(a.name || "应用")}</b><p>（模拟）这里是「${esc(a.name || "")}」自己的窗口：Perch 把它贴在这一块上，块挪到哪它跟到哪、块多大它多大。</p></div>`;
  }
  return `<div class="ap">${bar}<div class="ap-body">${body}</div></div>`;
}
function openApp(a, extra) {
  closeLauncher();
  if (a.kind === "game") { toast(`「${a.name}」放不进台面（全屏游戏 / 管理员权限的程序）—— 先把 Perch 收起来，在外面打开它`, "warn", { label: "收起 Perch", fn: stow }); return null; }
  const kind = a.kind === "web" ? "web" : "app";
  const opts = Object.assign({ app: a.id }, extra || {});
  const r = findFree(kind === "web" ? [[820, 560], [640, 440], [480, 330], [360, 260]] : a.id === "music" ? [[760, 440], [600, 360], [440, 300], [320, 240]] : [[640, 440], [480, 330], [320, 240]]);
  if (r) { const z = addZone(r, kind, opts); pingEl(ZEL.get(z.id)); return z; }
  armDraw(Object.assign({ kind }, opts), `台面上没有空地了：圈一块放「${a.name}」`);
  return null;
}
function openSearch(q) {
  closeLauncher();
  const r = findFree([[820, 560], [640, 440], [480, 330], [360, 260]]);
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(q);
  if (r) { const z = addZone(r, "web", { url }); pingEl(ZEL.get(z.id)); return z; }
  armDraw({ kind: "web", url }, "台面上没有空地了：圈一块放搜索页");
  return null;
}
const LP = { q: "" };
function openLauncher() {
  closePops();
  LP.q = "";
  const el = $("#lp");
  el.innerHTML = `<div class="lp-c"><div class="lp-q">${ICON("search", 18)}<input id="lp-q" placeholder="搜应用，或者输入网址 / 关键词回车" spellcheck="false" autocomplete="off"></div><div class="lp-list"></div>`
    + `<div class="lp-note">列的是这台电脑「开始菜单」里装的应用（模拟）。网页类开在台面的块里；普通桌面应用把它自己的窗口吸附到块上；全屏游戏、管理员权限的程序只能在外面开。图标是占位，真产品里用每个应用自己的图标。</div></div>`;
  el.hidden = false;
  renderLauncherList();
  setTimeout(() => { const i = $("#lp-q"); if (i) i.focus(); }, 40);
  syncDock();
}
function closeLauncher() { const el = $("#lp"); if (el) el.hidden = true; syncDock(); }
function renderLauncherList() {
  const q = LP.q.trim().toLowerCase();
  const list = APPS.filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q));
  const web = q ? `<div class="lp-sec">网页</div><div class="lp-web"><button data-lpsearch="${esc(LP.q.trim())}">${ICON("search", 16)}在台面上搜索「${esc(LP.q.trim())}」</button>`
    + (/^[\w-]+(\.[\w-]+)+/.test(q) ? `<button data-lpurl="${esc(LP.q.trim())}">${ICON("globe", 16)}打开 ${esc(LP.q.trim())}</button>` : "") + `</div>` : "";
  $("#lp .lp-list").innerHTML = (list.length ? `<div class="lp-sec">应用</div><div class="lp-grid">${list.map((a) => `<button class="lp-app" data-lpapp="${a.id}"><span class="lp-ic" style="background:${a.color}">${appIcon(a, 26)}</span><b>${esc(a.name)}</b><em>${a.kind === "web" ? "网页" : a.kind === "game" ? "在外面打开" : "桌面应用"}</em></button>`).join("")}</div>` : `<div class="lp-none">没找到叫「${esc(LP.q)}」的应用</div>`) + web;
}
/* 桌面图标：背景选「桌面壁纸 · 露出图标」时显示（真产品里就是桌面上真实的图标，点得到） */
const DESK_ICONS = [["此电脑", "monitor", "#3b82f6"], ["回收站", "trash-2", "#64748b"], ["网易云音乐", "music", "#e60026", "music"], ["微信", "message-circle", "#07c160", "wechat"],
  ["Microsoft Edge", "globe", "#1f8fd6", "edge"], ["项目资料", "folder", "#e8b53a"], ["截图", "image", "#e8b53a"], ["Steam", "gamepad-2", "#1b2838", "steam"]];
// 图标照 Windows 的排法：从左上往下排，排满一列换下一列
const iconsPerCol = () => Math.max(1, Math.floor((innerHeight - 52 - 110) / 96));
const iconCols = () => Math.ceil(DESK_ICONS.length / iconsPerCol());
function layoutIcons() {
  const per = iconsPerCol();
  $("#deskicons").innerHTML = DESK_ICONS.map(([n, ic, c, app], i) => `<div class="dicon" data-dicon="${esc(n)}"${app ? ` data-dapp="${app}"` : ""} style="left:${14 + Math.floor(i / per) * 86}px;top:${52 + (i % per) * 96}px"><span class="dii" style="background:${c}">${ICON(ic, 24)}</span><span class="dil">${esc(n)}</span></div>`).join("");
}
layoutIcons();
/* 文件块 */
function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { dirs: new Map(), files: [] });
      n = n.dirs.get(parts[i]);
    }
    n.files.push(p);
  }
  return root;
}
function openDirsFor(fz, path) { const parts = path.split("/"); for (let i = 1; i < parts.length; i++) fz.open.add(parts.slice(0, i).join("/")); }
function filesHTML(z, narrow) {
  const fz = z.fz;
  const touched = TOUCH[fz.proj] || [];
  const p = projByName(fz.proj);
  const projBtns = PROJECTS.map((x) => `<button data-fproj="${esc(x.name)}" class="${x.name === fz.proj ? "on" : ""}">${esc(x.name)}</button>`).join("");
  let list = "";
  if (fz.tab === "touched") {
    list = touched.length ? touched.map((e) => `<button class="fr${fz.sel === e.path ? " on" : ""}" data-fopen="${esc(e.path)}"><span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span>`
      + `<b>${esc(e.path.split("/").pop())}</b><span class="fd">${esc(e.path.split("/").slice(0, -1).join("/"))}</span><span class="sp"></span>${[...e.agents].map((a) => logo(a)).join("")}</button>`).join("")
      : `<div class="fz-empty">${esc(fz.proj)} 里还没有 agent 碰过文件。agent 读过、改过、新建的文件都会出现在这里。</div>`;
  } else {
    const rows = [];
    const walk = (n, base, depth) => {
      for (const [name, sub] of [...n.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const dp = base ? base + "/" + name : name;
        const open = fz.open.has(dp);
        rows.push(`<button class="fr" data-fdir="${esc(dp)}" style="padding-left:${8 + depth * 16}px"><span class="fi">${ICON(open ? "chevron-down" : "chevron-right", 13)}</span><span class="fi">${ICON("folder", 14)}</span><b>${esc(name)}</b></button>`);
        if (open) walk(sub, dp, depth + 1);
      }
      for (const f of n.files.slice().sort()) {
        const e = touched.find((x) => x.path === f);
        rows.push(`<button class="fr${fz.sel === f ? " on" : ""}" data-fopen="${esc(f)}" style="padding-left:${8 + depth * 16 + 19}px"><span class="fi">${ICON("file", 14)}</span><b>${esc(f.split("/").pop())}</b><span class="sp"></span>${e ? `<span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span>` : ""}</button>`);
      }
    };
    walk(buildTree(p ? p.files : []), "", 0);
    list = rows.join("") || `<div class="fz-empty">这个项目已经从 Perch 里移除了。</div>`;
  }
  const prev = fz.sel ? previewHTML(fz.proj, fz.sel, narrow) : `<div class="fp-none">选一个文件，在这里看内容</div>`;
  return `<div class="fz"><div class="fz-top"><div class="fz-proj">${projBtns}</div><span class="sp"></span>`
    + `<div class="seg"><button data-ftab="touched" class="${fz.tab === "touched" ? "on" : ""}">碰过的 ${touched.length}</button><button data-ftab="all" class="${fz.tab === "all" ? "on" : ""}">全部</button></div></div>`
    + `<div class="fz-main${narrow ? " narrow" : ""}${fz.sel ? " has-sel" : ""}"><div class="fz-list">${list}</div><div class="fz-prev">${prev}</div></div></div>`;
}
function previewHTML(proj, path, back) {
  const e = (TOUCH[proj] || []).find((x) => x.path === path);
  const add = ADDED[path];
  const lines = fileText(path).split("\n");
  const body = lines.map((s, i) => {
    const isAdd = e && e.kind !== "read" && add && (add === "all" || add.includes(i + 1));
    return `<div class="${isAdd ? "add" : ""}"><i>${i + 1}</i>${esc(s) || " "}</div>`;
  }).join("");
  return `<div class="fp-h">${back ? `<button data-fback title="回到列表">${ICON("arrow-left", 14)}</button>` : ""}<b>${esc(path.split("/").pop())}</b><span class="fd">${esc(path.split("/").slice(0, -1).join("/"))}</span><span class="sp"></span>`
    + (e ? `<span class="fk k-${e.kind}">${KIND_TXT[e.kind]}</span>${[...e.agents].map((a) => logo(a)).join("")}` : "") + `</div><pre class="fp-c">${body}</pre>`;
}
const zoneOfEl = (el) => Z.find((z) => z.id === el.closest(".zone")?.dataset.zone);
function leafOfEl(el) {
  const host = el.closest("[data-leaf]");
  if (!host) return null;
  const z = zoneOfEl(host);
  const leaf = z && leaves(z.root).find((l) => l.id === host.dataset.leaf);
  return leaf ? { z, leaf, el: TEL.get(leaf.id) } : null;
}
function pingEl(el) { if (!el) return; el.classList.remove("ping"); void el.offsetWidth; el.classList.add("ping"); }
function bump(z) { const el = z && ZEL.get(z.id); if (!el) return; el.classList.add("bump"); clearTimeout(el._b); el._b = setTimeout(() => el.classList.remove("bump"), 420); }
function openFile(proj, path) {
  const z = Z.find((x) => x.kind === "files" && x.fz.proj === proj) || Z.find((x) => x.kind === "files");
  if (z) {
    z.fz.proj = proj; z.fz.sel = path; z.fz.tab = (TOUCH[proj] || []).some((e) => e.path === path) ? "touched" : "all";
    openDirsFor(z.fz, path); z.fv++; render(); pingEl(ZEL.get(z.id));
    return;
  }
  openQuickLook(proj, path);
}
function openFilesFor(proj, sel) {
  closePops();
  const ex = Z.find((x) => x.kind === "files");
  if (ex) { ex.fz.proj = proj; if (sel) { ex.fz.sel = sel; openDirsFor(ex.fz, sel); } ex.fz.tab = "touched"; ex.fv++; render(); pingEl(ZEL.get(ex.id)); return ex; }
  const r = findFree([[720, 440], [600, 380], [480, 300], [ZMIN_FILES.w, ZMIN_FILES.h]]);
  if (r) { const z = addZone(r, "files", { proj, sel }); pingEl(ZEL.get(z.id)); return z; }
  armDraw({ kind: "files", proj }, "台面上没有空地了：圈一块放「文件」");
  return null;
}
function openAgentIn(proj) {
  closePops();
  const r = findFree([[520, 340], [420, 280], [ZMIN_NEW.w + 40, ZMIN_NEW.h + 20]]);
  if (r) { const z = addZone(r, "one", { proj, agent: CFG.defAgent }); pingEl(ZEL.get(z.id)); toast(`在 ${proj} 里开了一个 ${AG[CFG.defAgent].name}（默认 Agent，设置 › 通用 里改）`); return z; }
  armDraw({ kind: "one", proj, agent: CFG.defAgent }, `台面上没有空地了：圈一块给 ${proj} 里的新 agent`);
  return null;
}
function armDraw(d, msg) { DRAW = d; document.body.classList.add("drawing"); syncDock(); if (msg) toast(msg); }

/* ---------- 拖拽控制器（鼠标和导览共用） ---------- */
const ghost = $("#ghost"), drop = $("#drop"), dragi = $("#dragi"), dockEl = $("#dock"), snapEl = $("#snap");
function startDraw(x0, y0) {
  const d = desk();
  x0 = clamp(x0, d.x, d.x + d.w); y0 = clamp(y0, d.y, d.y + d.h);
  let r = { x: x0, y: y0, w: 0, h: 0 }, moved = false;
  return {
    move(x, y) {
      x = clamp(x, d.x, d.x + d.w); y = clamp(y, d.y, d.y + d.h);
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
      const nx = clamp(s.x + x - x0, d.x, d.x + d.w - z.w), ny = clamp(s.y + y - y0, d.y, d.y + d.h - z.h);
      const tries = [{ x: nx, y: ny }, { x: nx, y: z.y }, { x: z.x, y: ny }];
      let ok = null, hitZ = null;
      for (const p of tries) { const b = blocker({ x: p.x, y: p.y, w: z.w, h: z.h }, ex); if (!b) { ok = p; break; } hitZ = hitZ || b; }
      if (ok) { z.x = ok.x; z.y = ok.y; }
      if (hitZ && (!ok || ok.x !== nx || ok.y !== ny)) bump(hitZ);
      render();
    },
    up() { z.live = false; z.pre = null; render(); },
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
    up() { z.live = false; z.pre = null; render(); },
  };
}
function startDivider(z, d, x0, y0) {
  const zbR = $(".zb", ZEL.get(z.id)).getBoundingClientRect();
  const { sp, rc } = d;
  z.live = true; z.dragSplit = sp;
  return {
    move(x, y) {
      if (sp.dir === "h") {
        const span = rc.w - GAP;
        sp.r = clamp((x - zbR.left - rc.x - GAP / 2) / span, minW(sp.a) / span, 1 - minW(sp.b) / span);
      } else {
        const span = rc.h - GAP;
        sp.r = clamp((y - zbR.top - rc.y - GAP / 2) / span, minH(sp.a) / span, 1 - minH(sp.b) / span);
      }
      render();
    },
    up() { z.live = false; z.dragSplit = null; render(); },
  };
}
function trayTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  if (el.closest("#dock,#tray,#cap,.pop,.ztab")) return null;
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
    if (z && z.kind === "group") return { kind: "group", z, box: $(".zb", zEl).getBoundingClientRect() };
    return null;
  }
  const d = desk();
  const w = 520, h = 340;
  const r = { x: clamp(x - w / 2, d.x, d.x + d.w - w), y: clamp(y - h / 2, d.y, d.y + d.h - h), w, h };
  return { kind: "desk", r, bad: !!blocker(r), box: { left: r.x, top: r.y, width: w, height: h } };
}
function startTray(agentId, x0, y0) {
  const a = AG[agentId];
  dragi.src = "agents/" + a.icon;
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
    drop.firstChild.textContent = tg.kind === "group" ? `把 ${a.name} 加进这个群` : tg.kind === "desk" ? "在这里新开一块" : tg.kind === "fill" ? "放进这一格" : "";
  };
  place(x0, y0);
  return {
    move: place,
    up() {
      dragi.hidden = true; drop.hidden = true;
      if (!tg) return;
      if (tg.kind === "fill") { placeAgent(tg.leaf, agentId); render(); }
      else if (tg.kind === "split") splitLeaf(tg.z, tg.leaf, tg.side, agentId);
      else if (tg.kind === "group") {
        // 拖进群 = 打开「加一个 Bot」，agent 已经选好，只差起个角色名
        const g = tg.z.group;
        if (g.stage === "run") { g.adding = true; g.add = { role: "", agent: agentId }; g.err = ""; g.sv++; render(); }
        else { g.bots.push({ id: nid(), role: "", agent: agentId }); g.step = 2; g.sv++; render(); }
      } else if (tg.kind === "desk") {
        if (tg.bad) { toast("这里放不下一块 —— 换块空地", "warn"); return; }
        addZone(tg.r, "one", { agent: agentId });
      }
    },
  };
}
/* Dock 拖动：离左右边近就竖过来，离上下边近就横着贴边，否则就浮在那里 */
const SNAP = 120;
function snapEdgeAt(x, y) {
  const W = innerWidth, H = innerHeight;
  const c = [["left", x], ["right", W - x], ["top", y], ["bottom", H - y]].sort((a, b) => a[1] - b[1])[0];
  return c[1] < SNAP ? c[0] : null;
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
    lx = clamp(x - fx * w, 8, innerWidth - w - 8); ly = clamp(y - fy * h, 8, innerHeight - h - 8);
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
      if (edge) DK = { mode: "edge", edge, t: edge === "left" || edge === "right" ? clamp(y / innerHeight, 0.1, 0.9) : clamp(x / innerWidth, 0.1, 0.9) };
      else DK = { mode: "free", x: lx, y: ly };
      save(); layoutDock(); fitZones();
    },
  };
}

/* ---------- 鼠标 ---------- */
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
  if (t.closest("#cap,#tray,.pop,#stow,#toast,#set,#ql,#cf,#fpk,#lp,#ov")) return;
  const di = t.closest(".dicon");
  if (di) { closePops(); for (const x of $$(".dicon.sel")) x.classList.remove("sel"); di.classList.add("sel"); return; }
  for (const x of $$(".dicon.sel")) x.classList.remove("sel");
  closePops();
  if (!t.closest(".peek,[data-tfiles]")) closePeeks();
  const tabEl = t.closest(".ztab");
  if (tabEl) { if (!t.closest("button")) { e.preventDefault(); DRAG = startTabDrag(Z.find((z) => z.id === tabEl.dataset.ztab), e.clientX, e.clientY); } return; }
  const zon = t.closest(".zone");
  if (zon) front(zoneOfEl(zon));
  const dv = t.closest(".dv");
  if (dv) { e.preventDefault(); DRAG = startDivider(zoneOfEl(dv), dv._d, e.clientX, e.clientY); return; }
  const rz = t.closest("[data-rz]");
  if (rz) { e.preventDefault(); DRAG = startResize(zoneOfEl(rz), rz.dataset.rz, e.clientX, e.clientY); return; }
  const zh = t.closest(".zh");
  if (zh && !t.closest("button")) { e.preventDefault(); DRAG = startMove(zoneOfEl(zh), e.clientX, e.clientY); return; }
  if (t.closest(".zone")) return;
  e.preventDefault();
  DRAG = startDraw(e.clientX, e.clientY);
});
document.addEventListener("pointermove", (e) => { if (DRAG) DRAG.move(e.clientX, e.clientY); });
document.addEventListener("pointerup", (e) => { if (DRAG) { const d = DRAG; DRAG = null; d.up(e.clientX, e.clientY); } });
function closePeeks() { let ch = false; for (const { l } of allLeaves()) if (l.peek) { l.peek = false; l.v++; ch = true; } if (ch) render(); }
document.addEventListener("click", (e) => {
  const t = e.target;
  if (Date.now() - SUPPRESS_CLICK < 350 && t.closest("#dock")) return;
  if (t.closest("#fpk")) { pickerClick(t); return; }
  if (t.closest("#ov")) {
    const b = t.closest("[data-ovgo],[data-ovm],[data-ovx]");
    if (b && b.dataset.ovm) { OV.metric = b.dataset.ovm; renderOverview(); }
    else if (b && b.dataset.ovgo) ovJump(b.dataset.ovgo, b.dataset.ovz);
    else if ((b && b.hasAttribute("data-ovx")) || t.classList.contains("back")) closeOverview();
    return;
  }
  if (t.closest("#lp")) {
    const a = t.closest("[data-lpapp]"), s = t.closest("[data-lpsearch]"), u = t.closest("[data-lpurl]");
    if (a) openApp(APPS.find((x) => x.id === a.dataset.lpapp));
    else if (s) openSearch(s.dataset.lpsearch);
    else if (u) { closeLauncher(); const z = openApp(APPS.find((x) => x.id === "edge")); if (z) webGo(z, u.dataset.lpurl); }
    else if (!t.closest(".lp-c")) closeLauncher();
    return;
  }
  const wz = t.closest(".wb,.ap") && zoneOfEl(t);
  if (wz) {
    const b = t.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (wz.kind === "web") {
      const w = wz.web;
      if (b.hasAttribute("data-wback") && w.hi > 0) { w.hi--; w.url = w.hist[w.hi]; wz.wv++; render(); }
      else if (b.hasAttribute("data-wreload")) { wz.wv++; render(); toast("刷新了"); }
      else if (b.hasAttribute("data-wext")) toast("真产品里：用你的默认浏览器打开这个网址");
      else if (b.hasAttribute("data-wnext")) { w.n++; wz.wv++; render(); }
    } else {
      const s = wz.appz;
      if (b.hasAttribute("data-apop")) { toast("真产品里：它变回一个普通窗口，这一块就收掉"); removeZone(wz); return; }
      if (b.hasAttribute("data-amplay")) s.playing = !s.playing;
      else if (b.hasAttribute("data-amnext")) { s.song = (s.song + 1) % SONGS.length; s.t = 0; }
      else if (b.hasAttribute("data-amprev")) { s.song = (s.song + SONGS.length - 1) % SONGS.length; s.t = 0; }
      else if (b.hasAttribute("data-amlike")) s.like = !s.like;
      else if (d.amsong !== undefined) { s.song = +d.amsong; s.t = 0; s.playing = true; }
      wz.av++; render();
    }
    return;
  }
  const zc = t.closest("[data-zcollapse]");
  if (zc) { const z = zoneOfEl(zc); if (z) collapseZone(z); return; }
  const ze = t.closest("[data-zexpand]");
  if (ze) { const z = Z.find((x) => x.id === ze.closest(".ztab").dataset.ztab); if (z) expandZone(z); return; }
  if (t.closest("#set")) { if (t.closest("#mp")) return; setClick(t); return; }
  if (t.closest("#cf")) { const b = t.closest("[data-cf]"); if (b || t.classList.contains("back")) cfDone(!!b && b.dataset.cf === "ok"); return; }
  if (t.closest("#ql")) { const b = t.closest("[data-ql]"); if (b) { const q = QL; closeQuickLook(); if (b.dataset.ql === "open" && q) openFilesFor(q.proj, q.path); } else if (t.classList.contains("back")) closeQuickLook(); return; }
  const mp = t.closest("[data-mpick]");
  if (mp) { if (mp.dataset.na) { toast(mp.dataset.na, "warn"); return; } const cb = MP_CB; $("#mp").hidden = true; MP_CB = null; if (cb) cb(mp.dataset.mpick, mp.dataset.mprov); return; }
  const pp = t.closest("[data-pp]");
  if (pp) { ppAct(pp.dataset.pp, pp); return; }
  const zact = t.closest("[data-zact]");
  if (zact) { const z = zoneOfEl(zact); if (z) closeZone(z); return; }
  const ch = t.closest("[data-choose]");
  if (ch) { setKind(zoneOfEl(ch), ch.dataset.choose); return; }
  const gz = t.closest(".gs,.grp") && zoneOfEl(t);
  if (gz && gz.kind === "group") { groupClick(gz, t); return; }
  // 文件块
  const fzone = t.closest(".fz") && zoneOfEl(t);
  if (fzone) {
    const fz = fzone.fz;
    const b = t.closest("[data-fproj],[data-ftab],[data-fdir],[data-fopen],[data-fback]");
    if (b) {
      if (b.dataset.fproj) { fz.proj = b.dataset.fproj; fz.sel = null; }
      else if (b.dataset.ftab) fz.tab = b.dataset.ftab;
      else if (b.dataset.fdir) { if (fz.open.has(b.dataset.fdir)) fz.open.delete(b.dataset.fdir); else fz.open.add(b.dataset.fdir); }
      else if (b.dataset.fopen) fz.sel = b.dataset.fopen;
      else if (b.hasAttribute("data-fback")) fz.sel = null;
      fzone.fv++; render();
    }
    return;
  }
  const lf = leafOfEl(t);
  if (lf) {
    const pk = t.closest("[data-pick]");
    if (pk) { placeAgent(lf.leaf, pk.dataset.pick); render(); return; }
    if (t.closest("[data-instcancel]")) { lf.leaf.installing = null; lf.leaf.v++; render(); toast("下载在后台接着跑，装好以后哪一格都能直接选"); return; }
    const pj = t.closest("[data-proj]");
    if (pj) { lf.leaf.proj = pj.dataset.proj; lf.leaf.v++; render(); return; }
    if (t.closest("[data-projadd]")) { PENDING_LEAF = lf.leaf; openPP("add"); return; }
    const pl = t.closest("[data-plus]");
    if (pl) { splitLeaf(lf.z, lf.leaf, pl.dataset.plus); return; }
    if (t.closest("[data-tclose]")) { removeLeaf(lf.z, lf.leaf); return; }
    if (t.closest("[data-tbnew]")) { const tb = $(".tb", lf.el); tb.scrollTo({ top: tb.scrollHeight, behavior: "smooth" }); lf.leaf.pin = true; lf.leaf.unseen = false; t.closest("[data-tbnew]").hidden = true; return; }
    const an = t.closest("[data-ans]");
    if (an) { answer(lf.leaf, an.dataset.ans === "yes"); return; }
    if (t.closest("[data-tfiles]")) { const on = !lf.leaf.peek; closePeeks(); lf.leaf.peek = on; lf.leaf.v++; render(); return; }
    const pf = t.closest("[data-peekf]");
    if (pf) { lf.leaf.peek = false; lf.leaf.v++; render(); openFile(lf.leaf.proj, pf.dataset.peekf); return; }
    const tm = t.closest("[data-tmodel]");
    if (tm) { const L = lf.leaf; openModelPicker(tm, L.agent, L.pend || L.model, (m) => setLeafModel(L, m)); return; }
  }
  const dk = t.closest("[data-dock]");
  if (dk) { dockAct(dk.dataset.dock, dk); return; }
  if (t.closest("#stow")) { unstow(); return; }
});
document.addEventListener("scroll", (e) => {
  const tb = e.target;
  if (!(tb instanceof Element)) return;
  const near = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 12;
  if (tb.classList.contains("g-feed")) { const z = zoneOfEl(tb); if (z) z.gpin = near; return; }
  if (!tb.classList.contains("tb")) return;
  const lf = leafOfEl(tb);
  if (!lf) return;
  lf.leaf.pin = near;
  if (near && lf.leaf.unseen) { lf.leaf.unseen = false; const nb = $(".tb-new", lf.el); if (nb) nb.hidden = true; }
}, true);
function groupClick(z, t) {
  const g = z.group;
  const b = t.closest("button,[data-gmem]");
  if (!b) return;
  const d = b.dataset;
  const re = () => { g.sv++; render(); };
  // 建组向导
  if (d.gproj) { g.proj = d.gproj; g.err = ""; return re(); }
  if (b.hasAttribute("data-gprojadd")) { PENDING_GROUP = z; openPicker("pick"); return; }
  if (d.gbud !== undefined) { g.budget = +d.gbud; return re(); }
  if (d.gmgr) { g.manager = d.gmgr; ensureInstalled(d.gmgr, z); return re(); }
  if (d.gbdel !== undefined) { g.bots.splice(+d.gbdel, 1); return re(); }
  if (d.gbpre !== undefined) {
    if (g.bots.length >= BG_MAX) { g.err = `一个组最多 ${BG_MAX} 个 Bot`; return re(); }
    g.bots.push({ id: nid(), role: d.gbpre, agent: CFG.defAgent, persona: personaFor(d.gbpre) }); g.err = ""; re();
    if (!d.gbpre) setTimeout(() => { const ins = $$("[data-gbrole]", ZEL.get(z.id)); if (ins.length) ins[ins.length - 1].focus(); }, 30);
    return;
  }
  if (b.hasAttribute("data-gnext")) { const err = groupValid(g, g.step); if (err) { g.err = err; return re(); } g.err = ""; g.step++; return re(); }
  if (b.hasAttribute("data-gprev")) { g.err = ""; g.step--; return re(); }
  if (b.hasAttribute("data-gstart")) { startGroup(z); return; }
  // 开工以后
  if (d.gans) { groupAnswer(z, d.gans === "yes"); return; }
  if (d.gmem) { g.sel = g.sel === d.gmem ? null : d.gmem; g.adding = false; z.gv++; return re(); }
  if (b.hasAttribute("data-gdclose")) { g.sel = null; return re(); }
  if (b.hasAttribute("data-gadd")) { g.adding = !g.adding; g.err = ""; g.add = { role: "", agent: CFG.defAgent }; z.gv++; return re(); }
  if (d.gaddpre) { g.add.role = d.gaddpre; const i = $("[data-gaddrole]", ZEL.get(z.id)); if (i) i.value = d.gaddpre; for (const x of $$("[data-gaddpre]", ZEL.get(z.id))) x.classList.toggle("on", x === b); return; }
  if (d.gaddag) { g.add.agent = d.gaddag; ensureInstalled(d.gaddag, z); for (const x of $$("[data-gaddag]", ZEL.get(z.id))) x.classList.toggle("on", x === b); return; }
  if (b.hasAttribute("data-gaddcancel")) { g.adding = false; g.err = ""; z.gv++; return re(); }
  if (b.hasAttribute("data-gaddok")) { addBotToGroup(z); return; }
  if (b.hasAttribute("data-gsend")) { const i = $("[data-gin]", ZEL.get(z.id)); sendGroup(z, i && i.value); if (i) i.value = ""; return; }
  if (b.hasAttribute("data-gpsend")) { const i = $("[data-gdin]", ZEL.get(z.id)); sendPrivate(z, gm(g, g.sel), i && i.value); if (i) i.value = ""; return; }
  if (b.hasAttribute("data-gpause")) { g.paused = !g.paused; g.feed.push({ sys: true, t: g.paused ? "你把全组暂停了：手上这一步做完就停" : "继续干活", fresh: true }); if (g.paused) for (const m of g.members) if (m.st === "work") m.st = "idle"; z.gv++; render(); return; }
  if (b.hasAttribute("data-gmodel")) { const m = gm(g, g.sel); openModelPicker(b, m.agent, m.model, (x) => { m.model = x; z.gv++; render(); toast(`${m.role} 下一轮起用 ${x} —— 不用重启`); }); return; }
  // 人设与岗位
  if (d.pfx) { const p = personaTarget(b); if (p) { const v = !pget(p, d.pfx); pset(p, d.pfx, v); b.classList.toggle("on", v); b.innerHTML = ICON(v ? "check" : "plus", 12, 2.2) + b.textContent; } return; }
  if (d.gbedit !== undefined) { const k = d.gbedit === "m" ? "m" : +d.gbedit; g.editBot = g.editBot === k ? null : k; return re(); }
  if (d.gbtpl !== undefined) {
    const t = PERSONA_TPL[+d.gbtpl];
    if (g.bots.length >= BG_MAX) { g.err = `一个组最多 ${BG_MAX} 个 Bot`; return re(); }
    g.bots.push({ id: nid(), role: t.role, agent: CFG.defAgent, persona: clonePersona(t.persona) }); return re();
  }
  if (b.hasAttribute("data-gpedit")) { const m = gm(g, g.sel); g.pdraft = clonePersona(m.persona || personaFor(m.role)); g.pdraft.title = m.role; g.edit = true; return re(); }
  if (b.hasAttribute("data-gpecancel")) { g.edit = false; g.pdraft = null; return re(); }
  if (b.hasAttribute("data-gpetpl")) {
    const m = gm(g, g.sel), name = ((g.pdraft.title || m.role).trim() || m.role) + "（我的模板）";
    const p = clonePersona(g.pdraft); delete p.title;
    PERSONA_TPL = PERSONA_TPL.filter((x) => x.name !== name).concat([{ name, role: (g.pdraft.title || m.role).trim(), persona: p }]);
    toast(`存成模板了：「${name}」—— 下次建组、加 Bot 时直接选`);
    return;
  }
  if (b.hasAttribute("data-gpesave")) {
    const m = gm(g, g.sel), p = clonePersona(g.pdraft), title = (p.title || "").trim();
    delete p.title;
    if (m.id !== "mgr" && title && title !== m.role) {
      if (g.members.some((x) => x !== m && x.role === title)) { toast(`已经有「${title}」了`, "warn"); return; }
      g.feed.push({ sys: true, t: `「${m.role}」改名叫「${title}」`, fresh: true }); m.role = title;
    }
    m.persona = p; g.edit = false; g.pdraft = null;
    g.feed.push({ sys: true, t: `你更新了「${m.role}」的人设与岗位 —— 下一轮起按新的来（不用重启）`, fresh: true });
    m.lines.push({ k: "sys", t: "岗位说明更新了：" + (p.duty || "").slice(0, 40) + (p.duty.length > 40 ? "…" : "") }); m.fresh = true;
    z.gv++; re(); toast(`「${m.role}」的人设与岗位已保存`);
    return;
  }
  if (b.hasAttribute("data-gkick")) {
    const m = gm(g, g.sel);
    askConfirm(`把「${m.role}」移出群？`, "它手上的改动留在它的工作副本里，不会丢；之后可以再加回来。", "移出").then((ok) => {
      if (!ok) return;
      g.members = g.members.filter((x) => x !== m); g.sel = null;
      g.feed.push({ sys: true, t: `${m.role} 离开了群`, fresh: true }); g.plan = g.plan.filter((e) => (e.who || e.act || e.ask) !== m.id);
      if (g.ask && g.ask.mid === m.id) g.ask = null;
      z.gv++; re();
    });
  }
}
// 每个 Bot 那一行里选 agent（compact 的 logo 按钮）
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-gba]");
  if (!b) return;
  const z = zoneOfEl(b);
  if (!z || !z.group) return;
  e.stopPropagation();
  z.group.bots[+b.dataset.gbag].agent = b.dataset.gba; ensureInstalled(b.dataset.gba, z); z.group.sv++; render();
}, true);
document.addEventListener("dblclick", (e) => {
  const di = e.target.closest(".dicon");
  if (di) {
    // Perch 收起时，桌面上点开的东西一律照平常那样打开，不往台面里塞（哪怕它本来能在台面里开）
    toast(`「${di.dataset.dicon}」照平常那样打开了（在 Perch 外面，它自己的窗口）—— Perch 收着时不接管`);
    return;
  }
  const fr2 = e.target.closest("#fpk [data-fpsel]");
  if (fr2) { FPK.path = [...FPK.path, fr2.dataset.fpsel]; FPK.sel = null; renderPicker(); return; }
  const th = e.target.closest(".th");
  if (!th || e.target.closest("button")) return;
  const lf = leafOfEl(th.closest(".tile"));
  if (lf) toggleFocus(lf.z, lf.leaf);
});
document.addEventListener("keydown", (e) => {
  if (SET.rec) { recordHotkey(e); return; }
  if (!$("#lp").hidden) {
    if (e.key === "Escape") { closeLauncher(); return; }
    if (e.key === "Enter" && !e.isComposing && e.target.id === "lp-q") {
      const q = e.target.value.trim(); if (!q) return;
      const hits = APPS.filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));
      if (hits.length === 1) openApp(hits[0]); else openSearch(q);
    }
    return;
  }
  if (e.key === "Enter" && !e.isComposing && e.target.matches && e.target.matches("[data-wurl],[data-wq]")) {
    const z = zoneOfEl(e.target); if (z && z.web) { e.preventDefault(); webGo(z, e.target.value); }
    return;
  }
  if (e.key === "Enter" && !e.isComposing && e.target.matches && e.target.matches("[data-gin],[data-gdin],[data-gaddrole]")) {
    const z = zoneOfEl(e.target);
    if (z && z.group) {
      e.preventDefault();
      if (e.target.matches("[data-gin]")) { sendGroup(z, e.target.value); e.target.value = ""; }
      else if (e.target.matches("[data-gdin]")) { sendPrivate(z, gm(z.group, z.group.sel), e.target.value); e.target.value = ""; }
      else addBotToGroup(z);
    }
    return;
  }
  if (!$("#fpk").hidden) {
    if (e.key === "Escape") closePicker();
    else if (e.key === "Enter" && e.target.id === "fpk-name" && !e.isComposing) pickerOk();
    return;
  }
  if (e.key !== "Escape") return;
  if (!$("#cf").hidden) { cfDone(false); return; }
  if (!$("#ov").hidden) { closeOverview(); return; }
  if (!$("#ql").hidden) { closeQuickLook(); return; }
  if (!$("#mp").hidden) { $("#mp").hidden = true; return; }
  if (!$("#set").hidden) { closeSettings(); return; }
  if (!$("#pp").hidden || !$("#tray").hidden) { closePops(); return; }
  closePeeks();
  DRAW = null; document.body.classList.remove("drawing"); syncDock();
  for (const z of Z) if (z.focus) z.focus = null;
  render();
});
function toggleFocus(z, leaf) { z.focus = z.focus === leaf.id ? null : leaf.id; render(); }

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
  if (DK.mode === "free") { x = clamp(DK.x, 8, W - w - 8); y = clamp(DK.y, 8, H - h - 8); }
  else if (DK.edge === "bottom") { x = clamp(DK.t * W - w / 2, 12, W - w - 12); y = H - h - 16; }
  else if (DK.edge === "top") { x = clamp(DK.t * W - w / 2, 12, W - w - 12); y = 14; }
  else if (DK.edge === "left") { x = 16; y = clamp(DK.t * H - h / 2, 12, H - h - 12); }
  else { x = W - w - 16; y = clamp(DK.t * H - h / 2, 12, H - h - 12); }
  dockEl.style.left = x + "px"; dockEl.style.top = y + "px";
  $("#cap").classList.toggle("low", DK.mode === "edge" && DK.edge === "top");
  $("#toast").classList.toggle("low", !(DK.mode === "edge" && DK.edge === "bottom"));
}
// 等你的：格子里的提问 + 群里等你拍板的事
const waits = () => allLeaves().filter((x) => x.l.state === "wait").concat(Z.filter((z) => z.kind === "group" && z.group.ask).map((z) => ({ z, l: null })));
function syncDock() {
  const b = $('[data-dock="wait"]');
  if (!b) return;
  const w = waits().length;
  let bd = $(".bd", b);
  if (w && !bd) { bd = document.createElement("span"); bd.className = "bd"; b.appendChild(bd); }
  if (bd) { if (w) bd.textContent = w; else bd.remove(); }
  $('[data-dock="draw"]').classList.toggle("on", document.body.classList.contains("drawing") && !(DRAW && DRAW.kind));
  $('[data-dock="group"]').classList.toggle("on", !!DRAW && DRAW.kind === "group");
  $('[data-dock="agent"]').classList.toggle("on", !$("#tray").hidden);
  $('[data-dock="proj"]').classList.toggle("on", !$("#pp").hidden);
  $('[data-dock="set"]').classList.toggle("on", !$("#set").hidden);
  $('[data-dock="apps"]').classList.toggle("on", !$("#lp").hidden);
  $('[data-dock="ov"]').classList.toggle("on", !$("#ov").hidden);
  const ov = $('[data-dock="overlap"]');
  ov.classList.toggle("on", !!CFG.overlap);
  $(".lb", ov).textContent = CFG.overlap ? "允许重叠：开（再点关掉）" : "允许块叠在一起";
  const fo = $('[data-dock="fold"]');
  const anyOpen = Z.some((z) => !z.collapsed);
  $(".lb", fo).textContent = anyOpen || !Z.length ? "全部收起成标签" : "全部展开";
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
  el.style.left = clamp(x, 12, innerWidth - w - 12) + "px";
  el.style.top = clamp(y, 12, innerHeight - h - 12) + "px";
}
let WAIT_I = 0;
function closePops() { $("#pp").hidden = true; $("#tray").hidden = true; $("#mp").hidden = true; syncDock(); }
function dockAct(k, btn) {
  const trayWas = !$("#tray").hidden, ppWas = !$("#pp").hidden;
  closePops();
  if (k === "draw") armDraw(null, "在空白处按住拖一下，圈出一块");
  else if (k === "group") armDraw({ kind: "group" }, "圈一块给 Bot Group");
  else if (k === "agent") {
    if (trayWas) return;
    const tr = $("#tray");
    tr.classList.toggle("grid", dockSide() === "left" || dockSide() === "right");
    placeNearDock(tr, btn);
  } else if (k === "wait") {
    const ws = waits();
    if (!ws.length) { toast("现在没有在等你的 agent"); return; }
    const { z, l } = ws[WAIT_I++ % ws.length];
    if (z.collapsed) expandZone(z, true);
    front(z);
    if (!l) { pingEl(ZEL.get(z.id)); syncDock(); return; }
    if (z.focus && z.focus !== l.id) { z.focus = null; render(); }
    pingEl(TEL.get(l.id));
  } else if (k === "proj") { if (!ppWas) openPP("list"); }
  else if (k === "set") openSettings();
  else if (k === "overlap") {
    CFG.overlap = !CFG.overlap; save();
    toast(CFG.overlap ? "已允许重叠：块可以叠在一起，点哪块哪块到最前面" : "已关闭重叠：已经叠着的块保持原样，挪开以后就不能再叠回去");
    if (!$("#set").hidden) renderSettings();
  }
  else if (k === "fold") collapseAll();
  else if (k === "ov") { if ($("#ov").hidden) openOverview(); else closeOverview(); }
  else if (k === "apps") { if ($("#lp").hidden) openLauncher(); else closeLauncher(); }
  else if (k === "stow") stow();
  syncDock();
}
/* ---------- 收起：整个 Perch 缩成桌面上一个悬浮按钮（像桌宠，带 Perch 的标） ----------
   真产品里它是一个单独的小窗口：总在最前、无边框、透明底；主窗口藏起来（不是最小化），点它再回来。 */
const orb = $("#orb");
let ORB_SEEN = 0, ORB_DRAGGED = false, ORB_BUB = 0;
function orbPos() {
  const p = CFG.orb || { x: innerWidth - 92, y: Math.round(innerHeight * 0.62) };
  return { x: clamp(p.x, 12, innerWidth - 76), y: clamp(p.y, 12, innerHeight - 76) };
}
function placeOrb() { const p = orbPos(); orb.style.left = p.x + "px"; orb.style.top = p.y + "px"; orb.classList.toggle("on-left", p.x < innerWidth / 2); }
function stow() {
  closePops(); closeLauncher();
  document.body.classList.add("stowed");
  placeOrb(); orb.hidden = false;
  orb.classList.remove("orb-in"); void orb.offsetWidth; orb.classList.add("orb-in");
  ORB_SEEN = waits().length;
  syncOrb();
}
function unstow() { document.body.classList.remove("stowed"); orb.hidden = true; $(".orb-bub", orb).hidden = true; }
function orbStatus() {
  let run = 0;
  for (const { l } of allLeaves()) if (l.agent && l.state === "work") run++;
  for (const z of Z) if (z.kind === "group" && z.group.stage === "run") run += z.group.members.filter((m) => m.st === "work").length;
  return { run, wait: waits().length };
}
function waitText(x) {
  if (x.l) return `${AG[x.l.agent].name} 在等你：${x.l.ask || "看一眼"}`;
  const g = x.z.group, m = g.ask && gm(g, g.ask.mid);
  return `${g.name}：${m ? m.role : "有人"} 等你拍板`;
}
function syncOrb() {
  if (orb.hidden) return;
  const { run, wait } = orbStatus();
  orb.classList.toggle("busy", run > 0);
  orb.classList.toggle("waiting", wait > 0);
  const bd = $(".orb-bd", orb); bd.hidden = !wait; bd.textContent = wait;
  $(".orb-tip", orb).innerHTML = `<b>Perch</b><span>${run ? `${run} 个在跑` : "都空闲"}${wait ? ` · <em>${wait} 个等你</em>` : ""}</span><span class="dim">点一下回到台面 · 按住能拖</span>`;
  // 收起期间冒出新的「等你」：像桌宠一样冒个气泡，跳一下
  if (wait > ORB_SEEN) {
    const ws = waits();
    const b = $(".orb-bub", orb);
    b.textContent = waitText(ws[ws.length - 1]); b.hidden = false;
    orb.classList.remove("hop"); void orb.offsetWidth; orb.classList.add("hop");
    clearTimeout(ORB_BUB); ORB_BUB = setTimeout(() => { b.hidden = true; }, 5000);
  }
  ORB_SEEN = wait;
}
setInterval(syncOrb, 700);
function startOrbDrag(x0, y0) {
  const p0 = orbPos();
  ORB_DRAGGED = false;
  return {
    move(x, y) {
      if (!ORB_DRAGGED && Math.hypot(x - x0, y - y0) < 5) return;
      ORB_DRAGGED = true; orb.classList.add("dragging");
      orb.style.left = clamp(p0.x + x - x0, 6, innerWidth - 70) + "px"; orb.style.top = clamp(p0.y + y - y0, 6, innerHeight - 70) + "px";
    },
    up() {
      orb.classList.remove("dragging");
      if (!ORB_DRAGGED) return;
      setTimeout(() => { ORB_DRAGGED = false; }, 60);   // 拖完紧跟着的那次 click 不算点击
      // 松手贴到最近的左右边
      const x = parseFloat(orb.style.left), y = parseFloat(orb.style.top);
      CFG.orb = { x: x + 32 < innerWidth / 2 ? 18 : innerWidth - 82, y }; save(); placeOrb();
    },
  };
}
orb.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); DRAG = startOrbDrag(e.clientX, e.clientY); });
orb.addEventListener("click", () => { if (ORB_DRAGGED) { ORB_DRAGGED = false; return; } unstow(); });

/* ---------- 项目面板 ---------- */
const PP = { view: "list", flash: null };
let PENDING_LEAF = null, PENDING_GROUP = null;
const runningIn = (name) => {
  const ags = allLeaves().filter((x) => x.l.agent && x.l.proj === name).map((x) => x.l.agent);
  for (const z of Z) if (z.kind === "group" && z.group.stage === "run" && z.group.proj === name) for (const m of z.group.members) ags.push(m.agent);
  return ags;
};
function projRowHTML(p, actions) {
  const ags = runningIn(p.name);
  return `<div class="pr${PP.flash === p.name ? " flash" : ""}"><span class="ic">${ICON("folder", 16)}</span><div class="pm"><b>${esc(p.name)}</b><span>${esc(p.path)}</span></div>`
    + `<span class="pl">${[...new Set(ags)].slice(0, 4).map((a) => logo(a)).join("")}${ags.length ? `<em>${ags.length} 个在跑</em>` : ""}</span>`
    + `<div class="pa">${actions ? `<button data-pp="files" data-p="${esc(p.name)}" title="在台面上看它的文件">${ICON("folder-tree", 15)}</button>`
    + `<button data-pp="agent" data-p="${esc(p.name)}" title="在这里开一个 Agent">${ICON("sparkles", 15)}</button>` : ""}`
    + `<button data-pp="rm" data-p="${esc(p.name)}" title="从 Perch 里移除（文件夹不动）">${ICON("trash-2", 15)}</button></div></div>`;
}
function ppAddHTML(inSettings) {
  const have = new Set(PROJECTS.map((p) => p.path));
  const recent = RECENT_DIRS.filter((d) => !have.has(d.path));
  return (inSettings ? "" : `<div class="pp-h"><button class="back" data-pp="back" title="返回">${ICON("arrow-left", 15)}</button><b>添加文件夹</b></div>`)
    + `<div class="pp-two"><button class="pre" data-pp="browse"><span class="ic">${ICON("folder-open", 18)}</span><b>选一个已有的文件夹…</b><span>在盘上任意位置挑</span></button>`
    + `<button class="pre" data-pp="create"><span class="ic">${ICON("folder-plus", 18)}</span><b>新建一个文件夹…</b><span>自己定建在哪、叫什么</span></button></div>`
    + (recent.length ? `<div class="pp-sec">最近用过的</div>` + recent.map((d) => `<div class="pr" data-pp="pick" data-path="${esc(d.path)}" data-name="${esc(d.name)}" style="cursor:pointer"><span class="ic">${ICON("folder", 16)}</span><div class="pm"><b>${esc(d.name)}</b><span>${esc(d.path)}</span></div></div>`).join("") : "");
}
function renderPP() {
  const el = $("#pp");
  if (PP.view === "add") el.innerHTML = ppAddHTML(false);
  else el.innerHTML = `<div class="pp-h"><b>项目</b><span class="sp"></span><button class="btn" data-pp="add">${ICON("folder-plus", 14)}添加文件夹</button></div>`
    + PROJECTS.map((p) => projRowHTML(p, true)).join("")
    + `<div class="pp-note">项目 = 盘上的一个文件夹。agent 在哪个文件夹里开，就归哪个项目；它碰过的文件在「文件」块里看。</div>`;
}
function openPP(view) {
  PP.view = view || "list";
  renderPP();
  placeNearDock($("#pp"), $('[data-dock="proj"]'));
  syncDock();
  if (view === "add") setTimeout(() => { const i = $("#pp-new"); if (i) i.focus(); }, 50);
}
function addProject(name, path) {
  if (!name) return;
  if (PROJECTS.some((p) => p.name === name)) { toast(`已经有一个叫 ${name} 的项目了`, "warn"); return; }
  PROJECTS.push({ name, path, files: ["README.md", "src/main.ts", "package.json"] });
  PP.flash = name; PP.view = "list";
  if (PENDING_LEAF) { PENDING_LEAF.proj = name; PENDING_LEAF.v++; PENDING_LEAF = null; }
  if (PENDING_GROUP) { PENDING_GROUP.group.proj = name; PENDING_GROUP.group.sv++; PENDING_GROUP = null; }
  toast(`已添加：${name}`);
  rerenderProjects();
  setTimeout(() => { PP.flash = null; }, 1500);
}
async function removeProject(name) {
  const n = runningIn(name).length;
  if (n) {
    const ok = await askConfirm(`从 Perch 移除「${name}」？`, `里面还有 ${n} 个 agent 在跑，它们会接着跑。移除只是不在 Perch 里显示这个文件夹，盘上的文件一个都不动。`, "移除");
    if (!ok) return;
  }
  PROJECTS = PROJECTS.filter((p) => p.name !== name);
  toast(`已移除：${name}（文件夹没动）`);
  rerenderProjects();
}
function rerenderProjects() {
  if (!$("#pp").hidden) { renderPP(); placeNearDock($("#pp"), $('[data-dock="proj"]')); }
  if (!$("#set").hidden) renderSettings();
  for (const { l } of allLeaves()) if (!l.agent) l.v++;
  for (const z of Z) if (z.kind === "files") z.fv++;
  render();
}
function ppAct(k, b) {
  if (k === "add") { openPP("add"); return; }
  if (k === "back") { openPP("list"); return; }
  if (k === "pick") { addProject(b.dataset.name, b.dataset.path); return; }
  if (k === "mk") {
    const i = b.closest(".pp-mk").querySelector("input");
    const n = (i && i.value || "").trim();
    if (!n) { toast("先起个名字", "warn"); if (i) i.focus(); return; }
    addProject(n, CFG.workdir + "\\" + n);
    return;
  }
  if (k === "browse") { openPicker("pick"); return; }
  if (k === "create") { openPicker("create"); return; }
  if (k === "workdir") { openPicker("pick", { forWork: true, start: CFG.workdir }); return; }
  if (k === "files") { openFilesFor(b.dataset.p); return; }
  if (k === "agent") { openAgentIn(b.dataset.p); return; }
  if (k === "rm") { removeProject(b.dataset.p); return; }
}

/* ---------- 模型选择器 ---------- */
let MP_CB = null;
function modelGroups(agentId) {
  const out = [];
  if (OWN_MODELS[agentId]) out.push({ name: `${AG[agentId].name} 自己的登录`, models: OWN_MODELS[agentId] });
  for (const p of PROVIDERS) {
    const ok = agentId !== "codex" || p.proto.includes("Responses");
    out.push({ name: p.name, models: p.models, why: ok ? "" : "Codex 只认 OpenAI Responses，这家没有" });
  }
  return out;
}
function openModelPicker(anchor, agentId, cur, cb) {
  const mp = $("#mp");
  mp.innerHTML = modelGroups(agentId).map((g) => `<div class="grp-h">${esc(g.name)}${g.why ? `<em>· ${esc(g.why)}</em>` : ""}</div>`
    + g.models.map((m) => `<button class="mi${m === cur ? " on" : ""}${g.why ? " na" : ""}" data-mpick="${esc(m)}" data-mprov="${esc(g.name)}"${g.why ? ` data-na="${esc(g.why)}"` : ""}>${esc(m)}${m === cur ? `<span class="ic">${ICON("check", 14)}</span>` : ""}</button>`).join("")).join("");
  MP_CB = cb;
  mp.hidden = false;
  const r = anchor.getBoundingClientRect(), w = mp.offsetWidth, h = mp.offsetHeight;
  const below = r.bottom + 6 + h < innerHeight - 12;
  mp.style.left = clamp(r.right - w, 12, innerWidth - w - 12) + "px";
  mp.style.top = (below ? r.bottom + 6 : Math.max(12, r.top - h - 6)) + "px";
}

/* ---------- 设置 ---------- */
const SET = { sec: "general", addPre: null, busy: false, rec: false, flash: null };
const SECS = [["general", "通用", "sliders-horizontal"], ["desk", "台面", "monitor"], ["proj", "项目", "folder"], ["models", "模型", "cpu"], ["agents", "Agents", "bot"], ["about", "关于", "info"]];
const tg = (key) => `<button class="tg${CFG[key] ? " on" : ""}" data-cfg="${key}"></button>`;
const seg = (key, opts) => `<div class="seg">${opts.map(([v, t]) => `<button data-cfgseg="${key}" data-v="${v}" class="${CFG[key] === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
const row = (b, s, ctl) => `<div class="srow"><div class="sl"><b>${b}</b>${s ? `<span>${s}</span>` : ""}</div>${ctl}</div>`;
function secHTML() {
  switch (SET.sec) {
    case "general": return `<h2>通用</h2><p class="sub">Perch 自己怎么启动、怎么呼出。</p>`
      + row("开机自动启动", "登录 Windows 后直接铺满台面", tg("autostart"))
      + row("启动时恢复上次的台面", "块的位置、大小、里面的 agent 都按上次摆好；关掉的 agent 按原记录接回", tg("restore"))
      + row("呼出 / 收起 Perch", "全局快捷键：在别的软件里按一下就回到台面", `<button class="kbd${SET.rec ? " rec" : ""}" data-hotkey>${SET.rec ? "按下新的组合键…" : esc(CFG.hotkey)}</button>`)
      + row("关掉一块前先问一句", "块里有在跑的 agent 时才问", tg("confirmClose"))
      + row("默认 Agent", "项目面板里「在这开一个 Agent」直接用它；空格子里它排在显眼位置",
        `<div class="seg">${["claude", "codex", "pi", "opencode"].map((a) => `<button data-cfgdef="${a}" class="${CFG.defAgent === a ? "on" : ""}">${logo(a)}${esc(AG[a].name)}</button>`).join("")}</div>`);
    case "desk": return `<h2>台面</h2><p class="sub">背景、玻璃、颜色和 Dock。改了马上生效。</p>`
      + row("背景", "桌面壁纸：用你的桌面壁纸铺满整屏，把桌面上的图标和窗口都盖住，换了壁纸 Perch 跟着换；也可以换成渐变或纯色", seg("bg", [["wall", "桌面壁纸"], ["grad", "渐变"], ["solid", "纯色"]]))
      + row("玻璃浓度", "越高越不透，越低桌面透得越多", `<input type="range" min="0.3" max="0.9" step="0.02" value="${CFG.glass}" data-cfgr="glass">`)
      + row("模糊", "玻璃后面的桌面糊到什么程度", `<input type="range" min="0" max="48" step="1" value="${CFG.blur}" data-cfgr="blur">`)
      + row("强调色", "", `<div class="sw">${ACCENTS.map((c) => `<button data-acc="${c}" class="${CFG.acc === c ? "on" : ""}" style="background:${c};color:${c}"></button>`).join("")}</div>`)
      + row("Dock 的位置", "也可以直接按住 Dock 拖到任何地方；贴左右边时会竖过来", `<div class="seg">${[["bottom", "下"], ["top", "上"], ["left", "左"], ["right", "右"]].map(([v, t]) => `<button data-dockpos="${v}" class="${DK.mode === "edge" && DK.edge === v ? "on" : ""}">${t}</button>`).join("")}${DK.mode === "free" ? `<button class="on">自由</button>` : ""}</div>`)
      + row("允许块叠在一起", "关着时块和块互不重叠，挤到别人会有红框提醒；打开后可以叠着放，点哪块哪块到最前面。Dock 上也有这个开关", tg("overlap"))
      + row("块之间的间距", "", seg("gap", [["tight", "紧凑"], ["comfy", "舒适"]]))
      + row("右上角显示时间", "全屏会盖住任务栏的时钟", tg("clock"));
    case "proj": return `<h2>项目</h2><p class="sub">项目就是盘上的文件夹。这里和 Dock 里「项目与文件」是同一份。</p>`
      + row("默认工作区", "新建文件夹时默认从这里开始挑位置；不挑项目开的 agent 也在这里干活", `<span class="kbd">${esc(CFG.workdir)}</span><button class="btn" data-pp="workdir">更改…</button>`)
      + `<div class="pp-sec" style="padding-left:0">项目（${PROJECTS.length}）</div>` + PROJECTS.map((p) => projRowHTML(p, false)).join("")
      + `<div class="pp-sec" style="padding-left:0;margin-top:10px">添加文件夹</div>` + ppAddHTML(true);
    case "models": {
      const pre = SET.addPre && PRESETS.find((p) => p.id === SET.addPre);
      return `<h2>模型</h2><p class="sub">加一次提供商（官方、中转站、本地都行），每个 agent 都能选。key 只存在本机。</p>`
        + PROVIDERS.map((p) => `<div class="prov${SET.flash === p.id ? " srow flash" : ""}"><div class="pm"><b>${esc(p.name)} <span class="tag">${esc(p.kind)}</span></b><span>${p.proto.map((x) => `<span class="tag k">${x}</span>`).join("")} key ${esc(p.key)} · ${p.models.length} 个模型</span></div>`
          + `<button class="btn" data-provrm="${esc(p.id)}">${ICON("trash-2", 13)}删除</button></div>`).join("")
        + (pre ? `<div class="pform"><b style="font-size:12.5px;white-space:nowrap">${esc(pre.name)}</b>${pre.custom ? `<input id="pf-url" class="inp" placeholder="地址：照它文档里写的粘进来" spellcheck="false">` : ""}`
          + `<input id="pf-key" class="inp" placeholder="API key" spellcheck="false" autocomplete="off"><button class="btn pri" data-provsave>${SET.busy ? "检测中…" : "检测并保存"}</button><button class="btn" data-provcancel>取消</button></div>`
          : `<div class="pp-sec" style="padding-left:0;margin-top:14px">添加提供商</div><div class="pre-g">${PRESETS.filter((p) => !PROVIDERS.some((x) => x.id === p.id)).map((p) => `<button class="pre" data-pre="${p.id}"><b>${esc(p.name)}</b><span>${esc(p.kind)} · ${p.proto.join(" / ")}</span></button>`).join("")}</div>`);
    }
    case "agents": return `<h2>Agents</h2><p class="sub">新开一格时默认用哪个模型、推理多强。已经在跑的格子，点它右上角的模型随时换，不用重启。这里只列装好的；别的 agent 在开格子时选到就能就地下载。</p>`
      + ["claude", "codex", "pi", "opencode"].map((a) => `<div class="arow${SET.flash === "ag-" + a ? " srow flash" : ""}">${logo(a)}<b>${esc(AG[a].name)}</b>`
        + `<button class="mbtn" data-amodel="${a}">${esc(CFG.agentModel[a])}<em>${esc(CFG.agentProv[a] || "")}</em><span class="ic">${ICON("chevron-down", 14)}</span></button><span class="sp"></span>`
        + `<div class="seg">${["low", "medium", "high", "max"].map((v) => `<button data-effort="${a}" data-v="${v}" class="${CFG.effort[a] === v ? "on" : ""}">${v}</button>`).join("")}</div></div>`).join("");
    case "about": return `<h2>关于</h2><p class="sub">Perch 0.2.0 · 台面形态预览（模拟，后端是假的；设置会记在这个浏览器里）</p>`;
  }
  return "";
}
function renderSettings() {
  const el = $("#set");
  const old = $(".s-body", el);
  const scroll = old ? old.scrollTop : 0;
  el.innerHTML = `<div class="back"></div><div class="sheet"><button class="s-x" data-sx title="关掉（Esc）">${ICON("x", 16)}</button>`
    + `<nav class="s-nav"><h3>设置</h3>${SECS.map(([k, t, ic]) => `<button data-snav="${k}" class="${SET.sec === k ? "on" : ""}">${ICON(ic, 16)}${t}</button>`).join("")}</nav>`
    + `<div class="s-body">${secHTML()}</div></div>`;
  $(".s-body", el).scrollTop = scroll;
}
function openSettings(sec) { if (sec) SET.sec = sec; $("#set").hidden = false; renderSettings(); syncDock(); }
function closeSettings() { $("#set").hidden = true; SET.rec = false; SET.addPre = null; $("#mp").hidden = true; syncDock(); }
function cfgChanged() { applyCfg(); save(); render(); }
function setClick(t) {
  if (t.classList.contains("back") || t.closest("[data-sx]")) { closeSettings(); return; }
  const b = t.closest("[data-snav],[data-cfg],[data-cfgseg],[data-acc],[data-dockpos],[data-cfgdef],[data-hotkey],[data-pre],[data-provsave],[data-provcancel],[data-provrm],[data-amodel],[data-effort],[data-pp]");
  if (!b) return;
  const d = b.dataset;
  if (d.snav) { SET.sec = d.snav; SET.addPre = null; $("#mp").hidden = true; renderSettings(); return; }
  if (d.pp) { ppAct(d.pp, b); return; }
  if (d.cfg) { CFG[d.cfg] = !CFG[d.cfg]; cfgChanged(); renderSettings(); return; }
  if (d.cfgseg) { CFG[d.cfgseg] = d.v; cfgChanged(); renderSettings(); return; }
  if (d.acc) { CFG.acc = d.acc; cfgChanged(); renderSettings(); return; }
  if (d.cfgdef) { CFG.defAgent = d.cfgdef; cfgChanged(); for (const { l } of allLeaves()) if (!l.agent) l.v++; render(); renderSettings(); return; }
  if (d.dockpos) { DK = { mode: "edge", edge: d.dockpos, t: 0.5 }; save(); layoutDock(); fitZones(); renderSettings(); return; }
  if (b.hasAttribute("data-hotkey")) { SET.rec = true; renderSettings(); return; }
  if (d.pre) { SET.addPre = d.pre; renderSettings(); setTimeout(() => { const i = $("#pf-url") || $("#pf-key"); if (i) i.focus(); }, 30); return; }
  if (b.hasAttribute("data-provcancel")) { SET.addPre = null; renderSettings(); return; }
  if (b.hasAttribute("data-provsave")) { saveProvider(); return; }
  if (d.provrm) { PROVIDERS = PROVIDERS.filter((p) => p.id !== d.provrm); toast("已删除提供商"); renderSettings(); return; }
  if (d.amodel) {
    const a = d.amodel;
    openModelPicker(b, a, CFG.agentModel[a], (m, prov) => {
      CFG.agentModel[a] = m; CFG.agentProv[a] = prov; save(); SET.flash = "ag-" + a; renderSettings();
      setTimeout(() => { SET.flash = null; }, 1500);
      toast(`${AG[a].name} 新开的格子默认用 ${m}`);
    });
    return;
  }
  if (d.effort) { CFG.effort[d.effort] = d.v; save(); renderSettings(); return; }
}
function saveProvider() {
  if (SET.busy) return;
  const pre = PRESETS.find((p) => p.id === SET.addPre);
  const key = ($("#pf-key") || {}).value || "";
  const url = (($("#pf-url") || {}).value || "").trim();
  if (pre.custom && !url) { toast("先把地址粘进来", "warn"); return; }
  if (!key.trim()) { toast("先填 API key", "warn"); $("#pf-key").focus(); return; }
  SET.busy = true; renderSettings();
  setTimeout(() => {
    SET.busy = false;
    const id = pre.custom ? "c" + Date.now().toString(36) : pre.id;
    const name = pre.custom ? url.replace(/^https?:\/\//, "").split(/[/:]/)[0] : pre.name;
    PROVIDERS.push({ id, name, kind: pre.kind, proto: pre.proto.slice(), key: "··" + key.slice(-4), models: pre.models.slice() });
    SET.addPre = null; SET.flash = id;
    renderSettings();
    toast(`已添加 ${name}：${["Anthropic", "OpenAI", "Responses"].map((x) => x + (pre.proto.includes(x) ? " ✓" : " ✗")).join(" · ")}，${pre.models.length} 个模型`);
    setTimeout(() => { SET.flash = null; }, 1500);
  }, 1100);
}
function recordHotkey(e) {
  e.preventDefault();
  if (e.key === "Escape") { SET.rec = false; renderSettings(); return; }
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
  const k = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);
  if (!k.length) { toast("要带上 Ctrl / Alt / Shift 里的至少一个", "warn"); return; }
  k.push(e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key);
  CFG.hotkey = k.join("+"); SET.rec = false; save(); renderSettings();
}
document.addEventListener("input", (e) => {
  const pfi = e.target.closest("[data-pf]");
  if (pfi) {
    const p = personaTarget(pfi);
    if (p) { const k = pfi.dataset.pf; pset(p, k, k === "ask.cost" ? Math.max(0, parseInt(pfi.value, 10) || 0) : pfi.value); }
    return;
  }
  const wu = e.target.closest("[data-wurl],[data-wq]");
  if (wu) return;
  const lq = e.target.closest("#lp-q");
  if (lq) { LP.q = lq.value; renderLauncherList(); return; }
  const gi = e.target.closest("[data-gf],[data-gbrole],[data-gaddrole],[data-gin]");
  if (gi) {
    const z = zoneOfEl(gi), g = z && z.group;
    if (!g) return;
    if (gi.dataset.gf) g[gi.dataset.gf] = gi.value;
    else if (gi.dataset.gbrole !== undefined) g.bots[+gi.dataset.gbrole].role = gi.value;
    else if (gi.hasAttribute("data-gaddrole")) g.add.role = gi.value;
    else g.draft = gi.value;
    if (gi.dataset.gf === "name") { const el = ZEL.get(z.id); if (el) $(".zt", el).textContent = gi.value.trim() || "新的 Bot Group"; }
    return;
  }
  const r = e.target.closest("[data-cfgr]");
  if (r) { CFG[r.dataset.cfgr] = +r.value; applyCfg(); save(); }
});
document.addEventListener("change", (e) => {
  const t = e.target.closest("[data-cfgt]");
  if (t) { CFG[t.dataset.cfgt] = t.value.trim() || CFG[t.dataset.cfgt]; save(); toast("默认工作区已更新"); }
});

/* ---------- 选文件夹 / 新建文件夹 ---------- */
const FPK = { mode: "pick", path: [], sel: null, forWork: false, name: "" };
const isProjPath = (p) => PROJECTS.some((x) => x.path.toLowerCase() === p.toLowerCase());
function openPicker(mode, opts) {
  opts = opts || {};
  FPK.mode = mode; FPK.forWork = !!opts.forWork; FPK.sel = null; FPK.name = "";
  FPK.path = parsePath(opts.start || (mode === "create" ? CFG.workdir : "D:\\"));
  if (!fsNode(FPK.path)) FPK.path = [];
  closePops();
  $("#fpk").hidden = false;
  renderPicker();
  if (mode === "create") setTimeout(() => { const i = $("#fpk-name"); if (i) i.focus(); }, 40);
}
function closePicker() { $("#fpk").hidden = true; }
function renderPicker() {
  const el = $("#fpk"), cur = FPK.path, node = fsNode(cur) || {};
  const names = Object.keys(node).sort((a, b) => a.localeCompare(b));
  const crumbs = [`<button data-fpgo="-1">此电脑</button>`].concat(cur.map((s, i) => `<button data-fpgo="${i}">${esc(i === 0 ? s.replace("\\", "") : s)}</button>`)).join(`<span>›</span>`);
  const places = [["桌面", "C:\\Users\\Administrator\\Desktop", "folder"], ["文档", "C:\\Users\\Administrator\\Documents", "folder"], ["默认工作区", CFG.workdir, "folder"], ["C 盘", "C:\\", "monitor"], ["D 盘", "D:\\", "monitor"]];
  const rows = names.length ? names.map((n) => {
    const full = pstr([...cur, n]);
    return `<div class="fpr${FPK.sel === n ? " on" : ""}" data-fpsel="${esc(n)}"><span class="ic">${ICON(cur.length ? "folder" : "monitor", 16)}</span>`
      + `<b>${esc(cur.length ? n : n.replace("\\", "") + " 盘")}</b>${isProjPath(full) ? `<span class="tag">已是项目</span>` : ""}<span class="sp"></span>`
      + `<button class="fpin" data-fpin="${esc(n)}" title="进去">${ICON("chevron-right", 15)}</button></div>`;
  }).join("") : `<div class="fz-empty">这里没有子文件夹。${FPK.mode === "create" ? "新文件夹会建在这里。" : ""}</div>`;
  const target = FPK.sel ? [...cur, FPK.sel] : cur;
  const foot = FPK.mode === "pick" || FPK.forWork
    ? `<span class="fpk-path">${target.length ? esc(pstr(target)) : "先选一个文件夹"}</span><button class="btn pri${target.length ? "" : " na"}" data-fpok>${ICON("check", 14)}${FPK.forWork ? "设为默认工作区" : "选这个文件夹"}</button>`
    : `<span class="fpk-path">建在 ${cur.length ? esc(pstr(cur) + (cur.length > 1 ? "\\" : "")) : "（先进到一个盘或文件夹）"}</span>`
      + `<input id="fpk-name" class="inp" placeholder="新文件夹的名字" value="${esc(FPK.name || "")}" spellcheck="false" autocomplete="off"><button class="btn pri${cur.length ? "" : " na"}" data-fpok>${ICON("folder-plus", 14)}新建并添加</button>`;
  el.innerHTML = `<div class="back"></div><div class="fpk-c">`
    + `<div class="fpk-h"><b>${FPK.forWork ? "选默认工作区" : FPK.mode === "pick" ? "选一个已有的文件夹" : "新建一个文件夹"}</b>`
    + (FPK.forWork ? "" : `<div class="seg"><button data-fpmode="pick" class="${FPK.mode === "pick" ? "on" : ""}">选已有的</button><button data-fpmode="create" class="${FPK.mode === "create" ? "on" : ""}">新建一个</button></div>`)
    + `<span class="sp"></span><button class="s-x" data-fpx title="关掉（Esc）">${ICON("x", 16)}</button></div>`
    + `<div class="fpk-m"><nav class="fpk-side">${places.map(([t, p, ic]) => `<button data-fpplace="${esc(p)}">${ICON(ic, 15)}${esc(t)}</button>`).join("")}</nav>`
    + `<div class="fpk-main"><div class="crumb">${crumbs}</div><div class="fpk-list">${rows}</div></div></div>`
    + `<div class="fpk-f">${foot}</div>`
    + `<div class="fpk-note">${FPK.mode === "create" && !FPK.forWork ? "进到哪个文件夹，新文件夹就建在哪。" : "点一下选中，双击或点 › 进去。"}真产品里也可以换成 Windows 自带的选文件夹窗口。</div></div>`;
}
function pickerClick(t) {
  if (t.classList.contains("back") || t.closest("[data-fpx]")) { closePicker(); return; }
  const b = t.closest("[data-fpgo],[data-fpsel],[data-fpin],[data-fpplace],[data-fpmode],[data-fpok]");
  if (!b) return;
  const d = b.dataset;
  const nm = $("#fpk-name"); if (nm) FPK.name = nm.value;
  if (d.fpin !== undefined) { FPK.path = [...FPK.path, d.fpin]; FPK.sel = null; }
  else if (d.fpgo !== undefined) { FPK.path = FPK.path.slice(0, +d.fpgo + 1); FPK.sel = null; }
  else if (d.fpsel !== undefined) { FPK.sel = FPK.sel === d.fpsel ? null : d.fpsel; }
  else if (d.fpplace) { FPK.path = parsePath(d.fpplace); if (!fsNode(FPK.path)) FPK.path = []; FPK.sel = null; }
  else if (d.fpmode) { FPK.mode = d.fpmode; FPK.sel = null; }
  else if (b.hasAttribute("data-fpok")) { pickerOk(); return; }
  renderPicker();
}
function pickerOk() {
  if (FPK.mode === "pick" || FPK.forWork) {
    const target = FPK.sel ? [...FPK.path, FPK.sel] : FPK.path;
    if (!target.length) { toast("先选一个文件夹", "warn"); return; }
    const p = pstr(target);
    if (FPK.forWork) { CFG.workdir = p; save(); closePicker(); toast(`默认工作区：${p}`); if (!$("#set").hidden) renderSettings(); return; }
    if (isProjPath(p)) { toast("这个文件夹已经是项目了", "warn"); return; }
    closePicker();
    addProject(target.length > 1 ? target[target.length - 1] : target[0].replace("\\", "") + " 盘", p);
    return;
  }
  const i = $("#fpk-name"), name = ((i && i.value) || "").trim();
  if (!FPK.path.length) { toast("先进到一个盘或文件夹里", "warn"); return; }
  if (!name) { toast("给新文件夹起个名字", "warn"); if (i) i.focus(); return; }
  if (/[\\/:*?"<>|]/.test(name)) { toast("名字里不能有 \\ / : * ? \" < > |", "warn"); return; }
  const node = fsNode(FPK.path);
  if (node[name]) { toast(`这里已经有一个叫 ${name} 的文件夹了`, "warn"); return; }
  node[name] = {};
  const p = pstr([...FPK.path, name]);
  closePicker();
  addProject(name, p);
  toast(`已新建并添加：${name}（${p}）`);
}

/* ---------- 总览：Dock 打开的面板（不放 Agent 下载） ---------- */
const OV = { metric: "turns" };
// 模拟的历史：26 周 × 7 天，工作日多、周末少
const HEAT = (() => { let s = 7; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280; const out = [];
  for (let i = 0; i < 26 * 7; i++) { const wd = i % 7, busy = wd < 5 ? 1 : 0.35, recent = 0.4 + 0.6 * (i / 182); out.push(r() < 0.12 ? 0 : Math.round(r() * 160 * busy * recent)); } return out; })();
const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
function ovData() {
  const run = [], wait = [];
  for (const z of Z) {
    for (const l of leaves(z.root)) if (l.agent) {
      const it = { id: l.id, z: z.id, agent: l.agent, name: AG[l.agent].name, proj: l.proj, model: l.model, st: l.state, block: zoneTitle(z)[0] };
      if (l.state === "wait") wait.push(Object.assign({ t: l.ask }, it)); else run.push(it);
    }
    if (z.kind === "group" && z.group.stage === "run" && z.group.ask) { const m = gm(z.group, z.group.ask.mid); wait.push({ id: "", z: z.id, agent: m.agent, name: `${z.group.name} · ${m.role}`, proj: z.group.proj, t: z.group.ask.t, st: "wait", block: z.group.name }); }
  }
  const groups = Z.filter((z) => z.kind === "group" && z.group.stage === "run").map((z) => z.group);
  const today = HEAT[HEAT.length - 1] + allLeaves().reduce((s, x) => s + x.l.lines.filter((ln) => ln.k === "me").length, 0) + 40;
  return { run, wait, groups, today, week: HEAT.slice(-7).reduce((a, b) => a + b, 0) + today, days: HEAT.slice(-7).filter((v) => v > 0).length };
}
function overviewHTML() {
  const d = ovData();
  const toks = d.today * 23000, inp = Math.round(toks * 0.68), outp = toks - inp;
  const kpi = (t, v, s) => `<div class="ov-k"><span>${t}</span><b>${v}</b><em>${s}</em></div>`;
  const max = Math.max(...HEAT, d.today);
  const cells = HEAT.slice(0, -1).concat([d.today]).map((v, i) => {
    const val = OV.metric === "turns" ? v : v * 23000;
    const lv = v === 0 ? 0 : Math.min(4, 1 + Math.floor((v / max) * 4));
    return `<i class="l${lv}" title="${OV.metric === "turns" ? `${v} 轮` : `${fmtK(val)} token`}"></i>`;
  }).join("");
  const mix = [["Opus 5.5", "零词元", 46], ["gpt-5.5-codex", "Codex 自己的登录", 22], ["deepseek-v4-pro", "DeepSeek", 18], ["Sonnet 5.5", "零词元", 9], ["其他", "", 5]];
  const row = (x) => `<button class="ov-r" data-ovgo="${x.id || "z"}" data-ovz="${x.z}">${logo(x.agent)}<div><b>${esc(x.name)}</b><span>${esc(x.t || `${x.st === "work" ? "干活中" : "空闲"} · ${x.proj} · ${x.model || ""}`)}</span></div><span class="sp"></span><em class="ov-b">${esc(x.block)}</em><i class="dot ${x.st}"></i></button>`;
  return `<div class="back"></div><div class="ov-c"><button class="s-x" data-ovx title="关掉（Esc）">${ICON("x", 16)}</button>`
    + `<div class="ov-h"><b>总览</b><span>${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span></div>`
    + `<div class="ov-kpis">${kpi("在干活", `${d.run.filter((x) => x.st === "work").length} 格`, `开着 ${d.run.length + d.wait.length} 格 · 在等你 ${d.wait.length}`)}`
    + kpi("今日轮次", d.today, `近 7 天 ${d.week} · 7 天里活跃 ${d.days} 天`)
    + kpi("今日 token", fmtK(toks), `输入 ${fmtK(inp)} · 输出 ${fmtK(outp)}`)
    + kpi("缓存命中", "82%", `缓存读 ${fmtK(Math.round(inp * 0.82))}`)
    + kpi("项目", PROJECTS.length, `在跑的分布在 ${new Set(d.run.concat(d.wait).map((x) => x.proj)).size} 个项目`) + `</div>`
    + `<div class="ov-mid"><div class="ov-card"><div class="ov-ch"><b>每日活动</b><div class="seg"><button data-ovm="turns" class="${OV.metric === "turns" ? "on" : ""}">轮次</button><button data-ovm="tok" class="${OV.metric === "tok" ? "on" : ""}">token</button></div></div>`
    + `<div class="ov-heat">${cells}</div><div class="ov-leg"><span>${OV.metric === "turns" ? `累计 ${HEAT.reduce((a, b) => a + b, 0) + d.today} 轮` : `累计 ${fmtK((HEAT.reduce((a, b) => a + b, 0) + d.today) * 23000)} token`} · 含子代理</span><span class="sp"></span>少<i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</div></div>`
    + `<div class="ov-card"><div class="ov-ch"><b>今日 token · 按模型</b></div>${mix.map(([m, p, v]) => `<div class="ov-mx"><div><b>${m}</b><span>${p}</span></div><div class="ov-bar"><i style="width:${v}%"></i></div><em>${v}%</em></div>`).join("")}</div></div>`
    + `<div class="ov-low"><div class="ov-card"><div class="ov-ch"><b>在等你</b><em>${d.wait.length}</em></div>${d.wait.length ? d.wait.map(row).join("") : `<div class="ov-none">现在没有在等你的。跑完一轮、挂着提问、要你拍板，都会出现在这里。</div>`}</div>`
    + `<div class="ov-card"><div class="ov-ch"><b>开着的</b><em>${d.run.length}</em></div>${d.run.length ? d.run.map(row).join("") : `<div class="ov-none">台面上还没有 agent。</div>`}</div>`
    + `<div class="ov-card"><div class="ov-ch"><b>Bot Group</b><em>${d.groups.length}</em></div>${d.groups.length ? d.groups.map((g) => `<div class="ov-g"><b>${esc(g.name)}</b><span>${g.members.length} 个成员 · ${esc(g.proj)}${g.ask ? " · <em>等你拍板</em>" : ""}</span><div class="g-bud"><i style="width:${g.budget ? Math.min(100, Math.round(g.used / g.budget * 100)) : 0}%"></i><em>${g.used}k / ${g.budget ? g.budget + "k" : "不限"}</em></div></div>`).join("") : `<div class="ov-none">还没有 Bot Group。</div>`}</div></div></div>`;
}
// 只在打开时搭一次外壳（带入场动画）；之后定时刷新只换里面的内容，而且内容没变就不动 —— 不然每 1.3 秒入场动画重放一次，就是一闪一闪
function renderOverview() {
  const el = $("#ov");
  if (!$(".ov-c", el)) el.innerHTML = `<div class="back"></div><div class="ov-c"></div>`;
  const html = overviewHTML().replace(/^<div class="back"><\/div><div class="ov-c">/, "").replace(/<\/div>$/, "");
  const c = $(".ov-c", el);
  if (c._h === html) return;
  const st = c.scrollTop; c._h = html; c.innerHTML = html; c.scrollTop = st;
}
function openOverview() { closePops(); $("#ov").innerHTML = ""; $("#ov").hidden = false; renderOverview(); syncDock(); }
function closeOverview() { const el = $("#ov"); if (el) el.hidden = true; if (typeof syncDock === "function" && $('[data-dock="ov"]')) syncDock(); }
setInterval(() => { if (!$("#ov").hidden) renderOverview(); }, 1300);
// 从总览点一项 = 跳到那一格（收着的块先展开）
function ovJump(leafId, zid) {
  closeOverview();
  const z = Z.find((x) => x.id === zid);
  if (!z) return;
  if (z.collapsed) expandZone(z, true);
  front(z);
  if (z.focus && z.focus !== leafId) { z.focus = null; render(); }
  const el = leafId !== "z" ? TEL.get(leafId) : null;
  pingEl(el || ZEL.get(z.id));
}

/* ---------- 确认 / 速览 ---------- */
let CF_RES = null;
function askConfirm(title, body, ok) {
  const el = $("#cf");
  el.innerHTML = `<div class="back"></div><div class="cf-c"><b>${esc(title)}</b><p>${esc(body)}</p><div class="row"><button class="btn" data-cf="no">取消</button><button class="btn pri" data-cf="ok">${esc(ok)}</button></div></div>`;
  el.hidden = false;
  return new Promise((r) => { CF_RES = r; });
}
function cfDone(v) { $("#cf").hidden = true; const r = CF_RES; CF_RES = null; if (r) r(v); }
let QL = null;
function openQuickLook(proj, path) {
  QL = { proj, path };
  const el = $("#ql");
  el.innerHTML = `<div class="back"></div><div class="ql-c">${previewHTML(proj, path, false)}<div class="ql-f"><span style="flex:1;font-size:11.5px;color:var(--faint);align-self:center">台面上还没有「文件」块，先在这里看一眼</span>`
    + `<button class="btn" data-ql="open">${ICON("folder-tree", 14)}在台面上开一个「文件」块</button><button class="btn" data-ql="close">关闭</button></div></div>`;
  el.hidden = false;
}
function closeQuickLook() { $("#ql").hidden = true; QL = null; }

/* ---------- 杂项 ---------- */
let toastT = 0;
// act = { label, fn }：提示条上带一个动作按钮（比如「收起 Perch」）
function toast(msg, kind, act) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("warn"); if (kind) t.classList.add(kind); t.hidden = false;
  if (act) { const b = document.createElement("button"); b.className = "btn pri t-act"; b.textContent = act.label; b.onclick = () => { t.hidden = true; act.fn(); }; t.appendChild(b); }
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, act ? 5200 : 2800);
}
function clock() { const d = new Date(); $("#clock").textContent = d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }) + "  " + d.toTimeString().slice(0, 5); }
clock(); setInterval(clock, 10000);
addEventListener("resize", () => { layoutDock(); layoutIcons(); render(); });
function buildTray() {
  $("#tray").innerHTML = `<div class="row">${AGENTS.map((a) => `<div class="tr-a${a.installed ? "" : " ni"}" data-tray="${a.id}" title="${a.installed ? "" : "还没装：拖出来就开始下载"}">${agiHTML(a.id)}${agLabel(a, a.name.replace(" Harness", "").replace(" CLI", ""))}</div>`).join("")}</div>`
    + `<div class="hint">拖到格子的某条边上 = 在那边切一格；拖到空白处 = 新开一块；拖进 Bot Group = 加进群。灰色的还没装，拖出来就地下载</div>`;
}
buildTray();

/* ---------- 导览（分章） ---------- */
const cur = $("#cur");
const TOUR = { tok: 0, run: false, ctl: null, lx: 0, ly: 0, ch: null };
const FREE = "现在你自己玩：空白处按住拖一下 = 圈一块 · 格子边上 + = 切格 · 拖缝调大小 · 按住 Dock 拖到哪都行";
const CHAPTERS = [["shape", "形态"], ["fold", "收起与重叠"], ["group", "Bot Group"], ["persona", "人设与岗位"], ["dock", "Dock"], ["files", "项目与文件"], ["apps", "应用与桌面"], ["ov", "总览与下载"], ["set", "设置"]];
function say(t, k, n) { $("#cap-t").textContent = t; $("#cap-k").textContent = k ? `${k} / ${n}` : ""; }
function capUI() {
  $("#cap-b").textContent = TOUR.run ? "停下" : "从头看全部";
  $("#cap-ch").innerHTML = CHAPTERS.map(([k, t]) => `<button data-chap="${k}" class="${TOUR.run && TOUR.ch === k ? "on" : ""}">${t}</button>`).join("");
}
$("#cap-b").addEventListener("click", () => { if (TOUR.run) stopTour(); else tour("all"); });
$("#cap-ch").addEventListener("click", (e) => { const b = e.target.closest("[data-chap]"); if (b) tour(b.dataset.chap); });
document.addEventListener("pointerdown", (e) => {
  if (!e.isTrusted || !TOUR.run || e.target.closest("#cap")) return;
  stopTour();
}, true);
function stopTour() {
  TOUR.tok++; TOUR.run = false; TOUR.ch = null;
  if (TOUR.ctl) { const c = TOUR.ctl; TOUR.ctl = null; c.up(TOUR.lx, TOUR.ly); }
  cur.style.opacity = 0;
  for (const el of $$(".thov")) el.classList.remove("thov");
  say("导览停了。" + FREE, 0);
  capUI();
}
function resetDesk() {
  Z = []; for (const el of ZEL.values()) el.remove(); ZEL.clear(); TEL.clear();
  for (const el of TABEL.values()) el.remove(); TABEL.clear(); closePicker(); closeLauncher(); closeOverview();
  resetInstalled(); INST = {}; buildTray();
  TOUCH = {}; TV++; DRAW = null; document.body.classList.remove("drawing");
  closePops(); closeSettings(); closeQuickLook(); if (!$("#cf").hidden) cfDone(false); unstow();
  PROJECTS = BASE_PROJECTS(); PROVIDERS = BASE_PROVIDERS();
  CFG = DEF_CFG(); DK = DEF_DK(); applyCfg(); save(); layoutDock();
  orb.hidden = true;
  render();
}
// 直接摆出「形态」那一章结束时的样子，给后面几章单独看用。
function quickLayout() {
  resetDesk();
  const zA = addZone(fr(0, 0, 0.56, 0.6), "par");
  const [la, lb] = leaves(zA.root);
  assign(la, "claude"); assign(lb, "codex");
  const lc = splitLeaf(zA, lb, "bottom", "pi");
  zA.root.r = 0.6;
  const zB = addZone(fr(0.585, 0, 0.415, 0.52), "group");
  quickGroup(zB);
  const zC = addZone(fr(0, 0.66, 0.3, 0.34), "one", { agent: "opencode" });
  for (let i = 0; i < 5; i++) for (const l of [la, lb, lc, zC.root]) advance(l);
  for (const l of [la, lb, lc, zC.root]) { l.state = "work"; l.ask = null; }
  for (let i = 0; i < 4; i++) groupStep(zB);
  render();
}
async function tour(which) {
  const tok = ++TOUR.tok;
  if (TOUR.ctl) { const c = TOUR.ctl; TOUR.ctl = null; c.up(TOUR.lx, TOUR.ly); }
  TOUR.run = true;
  const w = async (ms) => { await sleep(ms); if (tok !== TOUR.tok) throw new Error("stop"); };
  const go = async (x, y, ms = 650) => {
    cur.style.transition = `opacity .25s, left ${ms}ms cubic-bezier(.3,.7,.2,1), top ${ms}ms cubic-bezier(.3,.7,.2,1)`;
    cur.style.opacity = 1; cur.style.left = x + "px"; cur.style.top = y + "px";
    TOUR.lx = x; TOUR.ly = y;
    await w(ms + 60);
  };
  const ctr = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const goEl = async (el, ms) => { const [x, y] = ctr(el); await go(x, y, ms); };
  const press = async () => { cur.classList.remove("down"); void cur.offsetWidth; cur.classList.add("down"); await w(160); };
  // 格子每 1.3s 会重画内容：目标给成函数，按下前再取一次，免得点到已经换掉的旧节点
  const click = async (sel, ms) => {
    const get = typeof sel === "function" ? sel : () => sel;
    let el = get();
    if (!el) { (window.__miss = window.__miss || []).push($("#cap-t").textContent); return; }
    el.classList.add("thov"); await goEl(el, ms); await press(); el.classList.remove("thov");
    el = el.isConnected ? el : get(); if (el) el.click();
    await w(260);
  };
  const drag = async (mk, x0, y0, x1, y1, ms = 1000) => {
    await go(x0, y0);
    await press();
    const c = mk(x0, y0); TOUR.ctl = c;
    cur.style.transition = "opacity .25s";
    const t0 = performance.now();
    for (;;) {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e;
      cur.style.left = x + "px"; cur.style.top = y + "px"; TOUR.lx = x; TOUR.ly = y;
      c.move(x, y);
      if (k >= 1) break;
      await w(16);
    }
    TOUR.ctl = null; c.up(x1, y1);
    await w(220);
  };
  const type = async (el, text) => {
    if (typeof el === "function") el = el();
    if (!el) { (window.__miss = window.__miss || []).push($("#cap-t").textContent); return; }
    await goEl(el, 400); el.focus();
    for (const ch of text) { el.value += ch; el.dispatchEvent(new Event("input", { bubbles: true })); await w(45); }
  };
  const tileOf = (leaf) => TEL.get(leaf.id);
  const zEl = (z) => ZEL.get(z.id);
  const find = () => {
    const zA = Z.find((z) => z.kind === "agents" && leaves(z.root).length > 1);
    const ls = zA ? leaves(zA.root) : [];
    return { zA, la: ls.find((l) => l.agent === "claude"), lb: ls.find((l) => l.agent === "codex"), zB: Z.find((z) => z.kind === "group") };
  };
  const H = { w, go, goEl, press, click, drag, type, ctr, tileOf, zEl, find };
  const order = which === "all" ? CHAPTERS.map((c) => c[0]) : [which];
  try {
    if (order[0] === "shape") resetDesk(); else quickLayout();
    for (const ch of order) { TOUR.ch = ch; capUI(); await CH[ch](H); }
    TOUR.run = false; TOUR.ch = null; cur.style.opacity = 0;
    say("导览结束。" + FREE, 0);
    capUI();
  } catch (e) {
    if (e.message !== "stop") { console.error(e); (window.__errs = window.__errs || []).push(String(e && e.stack || e)); }
  }
}
const CH = {
  async shape(h) {
    const { w, go, goEl, click, drag, ctr, tileOf, zEl } = h;
    let K = 0;
    const N = 17, s = (t) => say(t, ++K, N);
    s("这就是 Perch：铺满整屏，背景就是你自己的桌面；功能都收在 Dock 里", 1);
    await go(innerWidth / 2, innerHeight / 2, 10);
    for (const k of ["draw", "agent", "group", "wait"]) { const b = $(`[data-dock="${k}"]`); b.classList.add("thov"); await goEl(b, 420); await w(520); b.classList.remove("thov"); }
    await w(400);
    s("在空白处按住拖一下 = 圈出一块地方", 2);
    const A = fr(0, 0, 0.56, 0.6);
    await drag(startDraw, A.x, A.y, A.x + A.w, A.y + A.h, 1300);
    const zA = LAST_ZONE;
    await w(700);
    s("这块拿来并行：选「并行 Agents」（还能选单个 Agent、Bot Group、文件）", 3);
    await click($('[data-choose="par"]', zEl(zA)));
    await w(500);
    s("每一格挑一个 Agent（格子里长什么样只是占位，Agent 界面后面单独设计）", 4);
    const [la, lb] = leaves(zA.root);
    await click($('[data-pick="claude"]', tileOf(la)));
    await click($('[data-pick="codex"]', tileOf(lb)));
    await w(900);
    s("想再多一格：鼠标停到格子边上点 +，往哪边切你说了算", 5);
    tileOf(lb).classList.add("thov");
    await goEl(tileOf(lb), 600); await w(500);
    await click(() => $('[data-plus="bottom"]', tileOf(lb)));
    tileOf(lb).classList.remove("thov");
    const lc = leaves(zA.root)[2];
    await w(300);
    await click($('[data-pick="pi"]', tileOf(lc)));
    await w(900);
    s("拖格子之间的缝 = 调大小；不管怎么拖，这一块始终正好铺满", 6);
    const dvRoot = $$(".dv.h", zEl(zA))[0];
    let [dx, dy] = ctr(dvRoot);
    await drag((x, y) => startDivider(zA, dvRoot._d, x, y), dx, dy, dx + 130, dy, 900);
    const dvR = $$(".dv.v", zEl(zA))[0];
    [dx, dy] = ctr(dvR);
    await drag((x, y) => startDivider(zA, dvR._d, x, y), dx, dy, dx, dy - 70, 700);
    await w(600);
    s("再圈一块，这回放 Bot Group：一个目标，一队 Bot", 7);
    const B = fr(0.585, 0, 0.415, 0.52);
    await drag(startDraw, B.x, B.y, B.x + B.w, B.y + B.h, 1100);
    const zB = LAST_ZONE;
    await w(400);
    await click($('[data-choose="group"]', zEl(zB)));
    await w(900);
    s("（建组这一步在「Bot Group」那一章里细看，这里先直接开工）");
    quickGroup(zB);
    await w(1800);
    s("再圈一小块：只盯一个 Agent", 8);
    const C = fr(0.64, 0.66, 0.3, 0.34);
    await drag(startDraw, C.x, C.y, C.x + C.w, C.y + C.h, 900);
    const zC = LAST_ZONE;
    await w(300);
    await click($('[data-choose="one"]', zEl(zC)));
    await w(300);
    await click($('[data-pick="opencode"]', tileOf(zC.root)));
    await w(1000);
    s("块可以随便挪……", 9);
    let [hx, hy] = ctr($(".zh .zt", zEl(zC)));
    const d = desk();
    await drag((x, y) => startMove(zC, x, y), hx, hy, hx - (zC.x - d.x), hy, 1300);
    await w(400);
    s("……但不会压到别人身上：顶到了就停", 10);
    [hx, hy] = ctr($(".zh .zt", zEl(zC)));
    await drag((x, y) => startMove(zC, x, y), hx, hy, hx + 40, hy - 260, 1000);
    await w(700);
    s("拉大拉小一块，里面的格子按比例跟着变", 11);
    let cx = zA.x + zA.w, cy = zA.y + zA.h;
    await drag((x, y) => startResize(zA, "se", x, y), cx - 2, cy - 2, cx - 150, cy - 90, 900);
    cx = zA.x + zA.w; cy = zA.y + zA.h;
    await drag((x, y) => startResize(zA, "se", x, y), cx - 2, cy - 2, cx + 160, cy + 120, 1000);
    await w(600);
    s("双击格子的标题 = 聚焦它，占满整块；Esc 回来", 12);
    const thA = $(".th", tileOf(la));
    await goEl(thA, 600); await h.press(); await w(90); await h.press();
    toggleFocus(zA, la);
    await w(2400);
    zA.focus = null; render();
    await w(1000);
    s("框里的内容能往上翻；翻上去的时候来了新内容，会提示「有新内容 ↓」");
    {
      const old = [["me", "先把 README 里的安装说明更新一下"], ["act", "读取 README.md"], ["say", "安装说明还停在 beta.3，我按 beta.6 的单文件安装包重写。"],
        ["act", "编辑 README.md  +9 −14"], ["say", "好了。另外 Windows 版要求 WebView2，我在开头加了一句。"], ["me", "再顺手看一下 go vet"], ["act", "go vet ./... → 没问题"],
        ["me", "把 changelog 也对一下"], ["act", "读取 site/changelog.md"], ["say", "beta.6 少写了一条：设置页搜索 Agents 时整页消失的修复。"], ["act", "编辑 site/changelog.md  +1"],
        ["me", "跑一遍前端的语法检查"], ["act", "node --check assets/js/*.js → 31 个文件都过"], ["say", "都过了。i18n 也对齐了：en 1544 条，zh 1544 条。"],
        ["me", "最后看看 git status"], ["act", "git status --porcelain → 6 个改动"], ["say", "6 个改动都是这次的，没有误碰别的文件。"]];
      la.lines.unshift(...old.map(([k, t]) => ({ k, t })));
      la.v++; render();
      const tb0 = $(".tb", tileOf(la)); tb0.scrollTop = tb0.scrollHeight;
      await goEl(tb0, 500);
      const top0 = tb0.scrollTop;
      for (let i = 1; i <= 32; i++) { const t2 = $(".tb", tileOf(la)); if (t2) t2.scrollTop = Math.max(0, top0 - i * 14); await w(28); }
      await w(700);
      la.state = "work"; la.ask = null;
      la.lines.push({ k: "say", t: "go vet 也过了。要不要顺手把 CI 里的 Go 版本升到 1.26？" }); la.fresh = true; la.v++; render();
      await w(1700);
      await click(() => { const b = $(".tb-new", tileOf(la)); return b && !b.hidden ? b : null; });
      await w(1000);
    }
    s("有 agent 在等你：那一格会亮，Dock 上的铃铛有数字，点一下就跳过去", 13);
    setWait(lb);
    await w(900);
    await click($('[data-dock="wait"]'));
    await w(1100);
    await click(() => $('[data-ans="yes"]', tileOf(lb)));
    await w(900);
    s("格子太小了就不让再切，免得挤成一条缝", 14);
    for (let i = 0; i < 4; i++) {
      const narrow = zoneLayout(zA).tiles.filter((t) => t.leaf.agent).sort((a, b) => a.rc.w - b.rc.w)[0];
      const el = tileOf(narrow.leaf);
      el.classList.add("thov");
      await goEl(el, 500);
      const before = LAST_REFUSED;
      await click(() => $('[data-plus="right"]', tileOf(narrow.leaf)));
      el.classList.remove("thov");
      if (LAST_REFUSED !== before) break;
      const nl = leaves(zA.root).find((l) => !l.agent);
      if (nl) await click($('[data-pick="deepseek"]', tileOf(nl)));
    }
    await w(1800);
    s("也可以从 Dock 拿一个 Agent，直接拖到格子的某条边上", 15);
    await click($('[data-dock="agent"]'));
    await w(500);
    const [sx, sy] = ctr($('[data-tray="cursor"]'));
    const tr = tileOf(la).getBoundingClientRect();
    await drag(startTray.bind(null, "cursor"), sx, sy, tr.left + tr.width * 0.5, tr.top + tr.height * 0.86, 1300);
    closePops();
    await w(1300);
    s("暂时不用：Dock 最右边「收起」—— Perch 缩成桌面上一个带标的悬浮按钮，点一下就回来", 16);
    await click($('[data-dock="stow"]'));
    await w(2600);
    await click($("#orb"));
    await w(900);
  },
  async fold(h) {
    const { w, go, goEl, click, drag, ctr, find, zEl } = h;
    let K = 0;
    const N = 7, s = (t) => say(t, ++K, N);
    const zC = Z.find((z) => z.kind === "agents" && z.root && z.root.t === "leaf") || Z[Z.length - 1];
    s("每一块都能收起成一个标签：块头上的「收起」");
    await goEl($(".zh", zEl(zC)), 500);
    await click(() => $("[data-zcollapse]", zEl(zC)));
    await w(1400);
    s("标签可以拖到任何地方；上面一眼看到这块里谁在跑、谁在等你");
    let [tx, ty] = ctr($("b", TABEL.get(zC.id)));
    await drag((x, y) => startTabDrag(zC, x, y), tx, ty, innerWidth * 0.7, innerHeight * 0.74, 1100);
    await w(1300);
    s("点一下标签，就展开回原来的位置");
    [tx, ty] = ctr($("b", TABEL.get(zC.id)));
    await go(tx, ty); await h.press();
    expandZone(zC);
    await w(1700);
    s("开得多了：Dock 上「全部收起」，所有块排成一排标签，整个台面一目了然");
    await click($('[data-dock="fold"]'));
    await w(3400);
    s("再点一下，全部展开回去");
    await click($('[data-dock="fold"]'));
    await w(1700);
    s("想叠着放：打开「允许重叠」（Dock 上，或者设置 › 台面）；点哪块，哪块到最前面");
    await click($('[data-dock="overlap"]'));
    await w(900);
    const { zA } = find();
    let [hx, hy] = ctr($(".zh .zt", zEl(zC)));
    const sx = hx, sy = hy;
    await drag((x, y) => startMove(zC, x, y), hx, hy, hx + 260, hy - 300, 1300);
    await w(1200);
    [hx, hy] = ctr($(".zh .zt", zEl(zA)));
    await go(hx, hy); await h.press(); front(zA);
    await w(1400);
    const cr = zEl(zC).getBoundingClientRect();
    await go(cr.left + cr.width / 2, cr.bottom - 14); await h.press(); front(zC);
    await w(1200);
    s("关掉「允许重叠」：已经叠着的块保持原样，挪开以后就不能再叠回去");
    await click($('[data-dock="overlap"]'));
    await w(900);
    [hx, hy] = ctr($(".zh .zt", zEl(zC)));
    await drag((x, y) => startMove(zC, x, y), hx, hy, sx, sy, 1200);
    await w(1300);
  },
  async group(h) {
    const { w, go, goEl, click, drag, type, zEl } = h;
    let K = 0;
    const N = 11, s = (t) => say(t, ++K, N);
    // 这一章要一大块空地：左边留两块，右边整片给 Bot Group
    resetDesk();
    const zA = addZone(fr(0, 0, 0.4, 0.62), "par");
    const [a1, a2] = leaves(zA.root); assign(a1, "claude"); assign(a2, "codex");
    const zC = addZone(fr(0, 0.66, 0.4, 0.34), "one", { agent: "opencode" });
    for (let i = 0; i < 4; i++) for (const l of [a1, a2, zC.root]) advance(l);
    render();
    await w(600);
    s("建一个 Bot Group：Dock 上点「Bot Group」，在空地圈一块");
    await click($('[data-dock="group"]'));
    await w(500);
    const R = fr(0.425, 0, 0.575, 1);
    await drag(startDraw, R.x, R.y, R.x + R.w, R.y + R.h, 1200);
    const zG = LAST_ZONE;
    const gEl = () => ZEL.get(zG.id);
    await w(900);
    s("第一步：名字、目标、在哪个项目里干、预算上限 —— 都在这块里填，不弹窗");
    await type(() => $('[data-gf="name"]', gEl()), "官网改版小队");
    await type(() => $('[data-gf="goal"]', gEl()), "把官网首页换成新的台面截图，再补一页 Bot Group 的文档");
    await click(() => $('[data-gproj="perch-site"]', gEl()));
    await w(400);
    await click(() => $('[data-gbud="500"]', gEl()));
    await w(500);
    await click(() => $("[data-gnext]", gEl()));
    await w(900);
    s("第二步：Manager 负责拆活派活；每个 Bot 是一个角色配一个 agent，预设角色点一下就加");
    await click(() => $$('[data-gmgr]', gEl()).find((b) => b.dataset.gmgr === "claude"));
    await w(400);
    await click(() => $$('[data-gbag="0"]', gEl())[1]);
    await w(500);
    await click(() => $('[data-gbpre="审阅"]', gEl()));
    await w(500);
    await click(() => $('[data-gbpre="测试"]', gEl()));
    await w(500);
    await click(() => $$('[data-gbag="2"]', gEl())[2]);
    await w(900);
    s("角色名太笼统？每个 Bot 那一行点「人设」：写清它的职责、风格、能动哪里、什么时候找你拍板");
    await click(() => $('[data-gbedit="1"]', gEl()));
    await w(2600);
    await click(() => $('[data-gbedit="1"]', gEl()));
    await w(500);
    await click(() => $("[data-gnext]", gEl()));
    await w(900);
    s("第三步：看一眼，开工 —— 每个成员在项目里各有一个工作副本，互不踩脚");
    await w(1800);
    await click(() => $("[data-gstart]", gEl()));
    await w(700);
    s("开工了：Manager 先拆活、派给各个 Bot；上面能看到花了多少预算，随时可以全部暂停");
    await w(7000);
    s("在群里直接说话；用 @角色 点名某个 Bot");
    await type(() => $("[data-gin]", gEl()), "@测试 先对一下移动端的首页截图");
    await w(300);
    { const i = $("[data-gin]", gEl()); sendGroup(zG, i.value); i.value = ""; }
    await w(4200);
    s("点一个成员：看它具体在干什么、换它的模型，也能单聊（只有它看得到）");
    await click(() => $$("[data-gmem]", gEl()).find((b) => b.textContent.includes("开发")));
    await w(1500);
    await type(() => $("[data-gdin]", gEl()), "顺手把 404 页也换成新样式");
    await click(() => $("[data-gpsend]", gEl()));
    await w(2600);
    await click(() => $("[data-gdclose]", gEl()));
    await w(600);
    s("活多了随时加人：「+ 加 Bot」挑角色和 agent（也可以从 Dock 把 agent 直接拖进群）");
    await click(() => $("[data-gadd]", gEl()));
    await w(700);
    await click(() => $('[data-gaddpre="文档"]', gEl()));
    await w(400);
    await click(() => $$("[data-gaddag]", gEl()).find((b) => b.dataset.gaddag === "opencode"));
    await w(500);
    await click(() => $("[data-gaddok]", gEl()));
    await w(4500);
    s("要你拍板的事会在群里问你，标签和 Dock 的铃铛也会亮；点「允许」它就接着干");
    if (!zG.group.ask) { const b = zG.group.members[1]; zG.group.plan.unshift({ ask: b.id, t: "改动都过了审阅和测试，要我合进 main 吗？" }); }
    for (let i = 0; i < 20 && !zG.group.ask; i++) { groupStep(zG); render(); await w(200); }
    await w(1200);
    await click(() => $('[data-gans="yes"]', gEl()));
    await w(2500);
  },
  async persona(h) {
    const { w, click, type, zEl } = h;
    let K = 0;
    const N = 5, s = (t) => say(t, ++K, N);
    const zB = Z.find((z) => z.kind === "group");
    if (zB.collapsed) expandZone(zB, true);
    { const tall = fr(0.585, 0, 0.415, 1); if (!blocker(tall, zB.id)) { Object.assign(zB, tall); render(); await w(500); } }
    const gEl = () => ZEL.get(zB.id);
    s("开工以后也能改：点一个成员，下面就有「人设与岗位」");
    await click(() => $$("[data-gmem]", gEl()).find((b) => b.textContent.includes("开发")));
    await w(1200);
    await click(() => $("[data-gpedit]", gEl()));
    await w(1200);
    s("职责、风格、能动哪些目录、不能做的事、什么时候找你拍板、交付标准 —— 一项项写清楚");
    await type(() => $('[data-pf="duty"]', gEl()), " 首页的改动先给审阅看过再合。");
    await w(400);
    await click(() => $('[data-pfx="forbid.deps"]', gEl()));
    await w(500);
    { const c = $('[data-pf="ask.cost"]', gEl()); if (c) { c.value = ""; await type(c, "30"); } }
    await w(800);
    s("常用的人设可以存成模板，下次建组、加 Bot 时直接选");
    await click(() => $("[data-gpetpl]", gEl()));
    await w(1600);
    s("保存：写进它的岗位说明，下一轮起按新的来，不用重启；群里会留一句记录");
    await click(() => $("[data-gpesave]", gEl()));
    await w(2600);
    s("Manager 也有自己的一份：怎么拆活、多久汇报一次、什么事要先问你");
    await click(() => $$("[data-gmem]", gEl()).find((b) => b.textContent.includes("Manager")));
    await w(800);
    await click(() => $("[data-gpedit]", gEl()));
    await w(2600);
    await click(() => $("[data-gpecancel]", gEl()));
    await w(800);
  },
  async apps(h) {
    const { w, click, type } = h;
    let K = 0;
    const N = 8, s = (t) => say(t, ++K, N);
    resetDesk();
    const zA = addZone(fr(0, 0, 0.45, 0.6), "par");
    const [a1, a2] = leaves(zA.root); assign(a1, "claude"); assign(a2, "codex");
    for (let i = 0; i < 3; i++) { advance(a1); advance(a2); }
    render();
    await w(600);
    s("Dock 上「应用」：像启动台一样，搜这台电脑装的应用，也能直接搜网页");
    await click($('[data-dock="apps"]'));
    await w(1200);
    await type(() => $("#lp-q"), "网易");
    await w(700);
    await click(() => $('[data-lpapp="music"]'));
    await w(1000);
    s("普通桌面应用（网易云音乐、微信…）：把它自己的窗口吸附在一块上，跟着块走 —— 工作时听歌");
    const zM = Z.find((z) => z.kind === "app");
    if (zM) await click(() => $("[data-amplay]", ZEL.get(zM.id)));
    await w(2600);
    s("网页类的（抖音、X、B 站、Notion…）用 Perch 内置的浏览器内核开在块里，登录状态会记住");
    await click($('[data-dock="apps"]'));
    await w(700);
    await click(() => $('[data-lpapp="douyin"]'));
    await w(1500);
    const zD = Z.find((z) => z.kind === "web");
    if (zD) await click(() => $("[data-wnext]", ZEL.get(zD.id)));
    await w(1800);
    s("也能直接搜：输入关键词回车 = 在台面上开一个搜索页");
    await click($('[data-dock="apps"]'));
    await w(600);
    await type(() => $("#lp-q"), "极简 桌面 布局 灵感");
    await w(500);
    await click(() => $("[data-lpsearch]"));
    await w(2200);
    s("放不进台面的（全屏游戏、管理员权限的程序）会提醒你：先把 Perch 收起来，自己在外面打开");
    await click($('[data-dock="apps"]'));
    await w(600);
    await click(() => $('[data-lpapp="steam"]'));
    await w(1800);
    await click(() => $("#toast .t-act"));
    await w(1200);
    s("收起后 Perch 就是桌面上一个带标的悬浮按钮：看得到几个在跑、几个等你；按住能拖，松手贴边");
    { const r = $("#orb").getBoundingClientRect(); await h.drag(startOrbDrag, r.left + 32, r.top + 32, innerWidth - 120, innerHeight * 0.3, 1200); }
    await w(1400);
    s("收着的时候，你在桌面上打开任何东西（哪怕是网易云音乐这种台面里也能开的），都照平常那样开在外面");
    { const ic = $('.dicon[data-dicon="网易云音乐"]'); if (ic) { await h.goEl(ic, 600); await h.press(); await w(80); await h.press(); ic.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); } }
    await w(3000);
    s("有 agent 等你时，它会冒个气泡、跳一下；点一下回到台面");
    { const l = Z.flatMap((z) => leaves(z.root)).find((x) => x.agent && x.state !== "wait"); if (l) setWait(l); }
    await w(3600);
    await click($("#orb"));
    await w(1200);
  },
  async dock(h) {
    const { w, goEl, click, drag, ctr } = h;
    const N = 5, s = (t, k) => say(t, k, N);
    s("Dock 不是钉死的：按住它（或左边的把手）拖到哪儿都行", 1);
    let [gx, gy] = ctr($(".dgrip"));
    await drag(startDockDrag, gx, gy, innerWidth * 0.62, innerHeight * 0.74, 1100);
    await w(1200);
    s("贴到左边或右边，它会竖过来；台面给它让出一条，块自动往里收", 2);
    [gx, gy] = ctr($(".dgrip"));
    await drag(startDockDrag, gx, gy, 40, innerHeight * 0.5, 1200);
    await w(700);
    for (const k of ["agent", "proj"]) { const b = $(`[data-dock="${k}"]`); b.classList.add("thov"); await goEl(b, 420); await w(700); b.classList.remove("thov"); }
    s("竖着也一样用：托盘、面板都从它旁边长出来", 3);
    await click($('[data-dock="agent"]'));
    await w(1800);
    closePops();
    await click($('[data-dock="proj"]'));
    await w(1800);
    closePops();
    s("放到顶上也行", 4);
    [gx, gy] = ctr($(".dgrip"));
    await drag(startDockDrag, gx, gy, innerWidth * 0.5, 30, 1200);
    await w(1500);
    s("放回下面。位置会记住，下次打开还在这", 5);
    [gx, gy] = ctr($(".dgrip"));
    await drag(startDockDrag, gx, gy, innerWidth * 0.5, innerHeight - 30, 1200);
    await w(1200);
  },
  async files(h) {
    const { w, goEl, click, type, tileOf, find } = h;
    let K = 0;
    const N = 8, s = (t) => say(t, ++K, N);
    s("项目就是盘上的文件夹：Dock 里「项目与文件」管着它们，谁在哪个项目里跑一眼就看到", 1);
    await click($('[data-dock="proj"]'));
    await w(2200);
    s("加一个文件夹：在盘上任意位置挑一个已有的 —— 点一下选中，双击或点 › 进去");
    await click($('[data-pp="add"]'));
    await w(700);
    await click($('[data-pp="browse"]'));
    await w(900);
    await click(() => $$("#fpk [data-fpplace]").find((b) => b.textContent.includes("桌面")));
    await w(700);
    await click(() => $('#fpk [data-fpsel="2cut"]'));
    await w(900);
    await click(() => $("#fpk [data-fpok]"));
    await w(1500);
    s("也可以新建：自己定建在哪 —— 进到哪个文件夹就建在哪，再起个名字");
    await click($('[data-dock="proj"]'));
    await w(600);
    await click($('[data-pp="add"]'));
    await w(500);
    await click($('[data-pp="create"]'));
    await w(900);
    await click(() => $$("#fpk .crumb [data-fpgo]")[1]);
    await w(700);
    await click(() => $('#fpk [data-fpin="Projects"]'));
    await w(700);
    await type($("#fpk-name"), "demo-app");
    await w(300);
    await click(() => $("#fpk [data-fpok]"));
    await w(1800);
    s("看文件：项目那一行点「文件」，台面上找块空地多出一块「文件」");
    await click($('[data-dock="proj"]'));
    await w(800);
    const row = $$("#pp .pr").find((r) => r.textContent.includes("Perch"));
    if (row) {
      row.classList.add("thov");
      await goEl(row, 500); await w(500);
      await click($('[data-pp="files"]', row));
      row.classList.remove("thov");
    }
    await w(1400);
    const fzone = Z.find((z) => z.kind === "files");
    s("「碰过的」= agent 读过、改过、新建的文件，谁动的、怎么动的都标着；点开就看内容，改过的行是绿的", 4);
    if (fzone) {
      await click(() => $(".fz-list [data-fopen]", ZEL.get(fzone.id)));
      await w(2600);
      s("「全部」= 整个文件夹的树", 5);
      await click(() => $('[data-ftab="all"]', ZEL.get(fzone.id)));
      await w(700);
      await click(() => $('[data-fdir="internal"]', ZEL.get(fzone.id)));
      await w(500);
      await click(() => $('[data-fdir="internal/project"]', ZEL.get(fzone.id)));
      await w(500);
      await click(() => $('[data-fopen="internal/project/hidden_test.go"]', ZEL.get(fzone.id)));
      await w(2200);
    }
    s("从格子里也能直接看：点格子右上角的文件数，挑一个就在「文件」块里打开", 6);
    const { la } = find();
    await click(() => $("[data-tfiles]", tileOf(la)));
    await w(1400);
    await click(() => $("[data-peekf]", tileOf(la)));
    await w(2200);
    s("在新加的文件夹里开 agent：Perch 找块空地放下（没空地就让你圈一块）", 7);
    await click($('[data-dock="proj"]'));
    await w(700);
    const r2 = $$("#pp .pr").find((r) => r.textContent.includes("2cut"));
    if (r2) {
      r2.classList.add("thov");
      await goEl(r2, 500); await w(400);
      await click($('[data-pp="agent"]', r2));
      r2.classList.remove("thov");
    }
    await w(800);
    if (document.body.classList.contains("drawing")) {
      const r = findFree([[ZMIN_NEW.w + 20, ZMIN_NEW.h + 20]]);
      if (r) await h.drag(startDraw, r.x, r.y, r.x + r.w, r.y + r.h, 900);
    }
    await w(2200);
  },
  async ov(h) {
    const { w, goEl, click, find, tileOf } = h;
    let K = 0;
    const N = 5, s = (t) => say(t, ++K, N);
    const { la, lb } = find();
    if (lb && lb.state !== "wait") setWait(lb);
    s("Dock 上「总览」：一张面板看全局 —— 在跑几格、今天跑了多少轮、花了多少 token、谁在等你");
    await click($('[data-dock="ov"]'));
    await w(2600);
    s("每日活动：轮次、token 两种口径；按模型看今天的 token 花在哪");
    await click(() => $('[data-ovm="tok"]'));
    await w(1800);
    await click(() => $('[data-ovm="turns"]'));
    await w(900);
    s("在等你的、在跑的、Bot Group 的预算都在这；点一项就跳到那一格");
    await click(() => $("#ov .ov-low .ov-card [data-ovgo]"));
    await w(2200);
    s("Agent 不再单独装：没装的图标是灰的；鼠标移上去浮出一层玻璃下载，点一下，液体从底部把图标灌满就是装好了");
    if (la) {
      const el = tileOf(la);
      el.classList.add("thov"); await goEl(el, 500);
      await click(() => $('[data-plus="right"]', tileOf(la)));
      el.classList.remove("thov");
      const nl = Z.flatMap((z) => leaves(z.root)).find((l) => !l.agent && !l.installing);
      if (nl) {
        const b = () => $('[data-pick="cursor"]', tileOf(nl));
        if (b()) { b().classList.add("thov"); await goEl(b(), 500); await w(1300); }
        await click(b);
      }
      await w(5200);
    }
    s("Dock 的 Agent 托盘、Bot Group 建组时也一样：没装的是灰的，选了就在后台装，图标里看得到进度");
    await click($('[data-dock="agent"]'));
    await w(2600);
    closePops();
    await w(600);
  },
  async set(h) {
    const { w, goEl, click, type, tileOf, find } = h;
    const N = 7, s = (t, k) => say(t, k, N);
    s("设置也在 Dock 里：一张浮在台面上的面板，改了马上生效、会记住", 1);
    await click($('[data-dock="set"]'));
    await w(1800);
    s("台面：背景、玻璃、强调色、Dock 位置", 2);
    await click($('[data-snav="desk"]'));
    await w(700);
    await click($('[data-acc="#7dd3c0"]'));
    await w(900);
    await click($('[data-cfgseg="bg"][data-v="grad"]'));
    await w(1500);
    await click($('[data-cfgseg="bg"][data-v="wall"]'));
    await w(900);
    const rg = $('[data-cfgr="glass"]');
    await goEl(rg, 500);
    for (let v = 0.6; v >= 0.38; v -= 0.02) { rg.value = v; CFG.glass = v; applyCfg(); await w(40); }
    await w(900);
    for (let v = 0.38; v <= 0.61; v += 0.02) { rg.value = v; CFG.glass = v; applyCfg(); await w(30); }
    save();
    s("项目：默认工作区和项目列表，跟 Dock 里那份是同一份", 3);
    await click($('[data-snav="proj"]'));
    await w(2200);
    s("模型：加一个提供商 —— 挑预设、填 key、检测完就能在 agent 里选", 4);
    await click($('[data-snav="models"]'));
    await w(800);
    await click($('[data-pre="openrouter"]'));
    await w(400);
    await type($("#pf-key"), "sk-or-v1-9c2e");
    await click($("[data-provsave]"));
    await w(2200);
    s("Agents：每个 agent 新开时默认用哪个模型、推理多强", 5);
    await click($('[data-snav="agents"]'));
    await w(700);
    await click($('[data-amodel="claude"]'));
    await w(700);
    await click(() => $$("#mp [data-mpick]").find((b) => b.dataset.mpick === "Sonnet 5.5" && b.dataset.mprov === "零词元"));
    await w(700);
    await click($('[data-effort="claude"][data-v="max"]'));
    await w(1200);
    s("已经在跑的格子：点它右上角的模型，随时换，不用重启 —— 正在干活就从下一轮起换", 6);
    await click($("[data-sx]"));
    await w(600);
    const { la } = find();
    await click(() => $("[data-tmodel]", tileOf(la)));
    await w(700);
    await click(() => $$("#mp [data-mpick]").find((b) => b.dataset.mpick === "Haiku 5.5"));
    await w(2600);
    s("关一块之前会先问一句（设置 › 通用 里能关）", 7);
    const zX = find().zB || Z.find((z) => z.kind === "agents" && leaves(z.root).some((l) => l.agent));
    await click(() => zX && $('[data-zact="close"]', ZEL.get(zX.id)));
    await w(1800);
    await click($('#cf [data-cf="no"]'));
    await w(1000);
  },
};
window.addEventListener("error", (e) => { (window.__errs = window.__errs || []).push(String(e.message)); });

applyCfg();
layoutDock();
render();
capUI();
say(FREE, 0);
setTimeout(() => tour((location.hash.match(/ch=(\w+)/) || [])[1] || "all"), 900);
