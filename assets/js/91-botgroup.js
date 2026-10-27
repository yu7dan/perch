/* Bot Group —— 一个目标下的 Bot 团队工作台（顶层模式之一，见 60-shell.js 的 MODE_ITEMS）。
   形态参照用户给的参考视频：左 = Bot Group / Bot 列表；中上 = 每条车道的交接链；
   中 = 过程流（聚焦一条车道 / 全部车道）；右 = 工作树 · 泳道 + 图例。

   ⚠️ 阶段 A（2026-10-28）：只有视觉骨架。数据是写死的示例（BG_DEMO），
   不接后端、不起 agent。数据模型 / 创建入口 / 编排是后面的阶段。
   页面重点是「谁在做什么、谁交给了谁、哪里需要人」，终端只是次要入口。 */

/* ---------- 示例数据 ---------- */
// 车道 = 一个 Bot 的方向。色只用来区分车道，不表达状态（状态有自己的符号）。
const BG_LANE_COLORS = { manager: "#a1a1aa", maint: "#22c55e", ver: "#3b82f6", review: "#a855f7", promo: "#ec4899", script: "#3b82f6", cut: "#f59e0b", voice: "#22c55e", scan: "#a855f7", sum: "#3b82f6" };

const BG_DEMO = [
  {
    id: "perch-team", name: "Perch 产品团队", project: "perch",
    source: { kind: "derived", agent: "claudecode-color", from: "Claude Code · Perch beta.4 主线" },
    goal: "beta.4 已发布；维护、下一版、审阅、宣发分头推进，发版和外发都要你点头。",
    budget: { used: 41, cap: 120 },
    lanes: [
      { id: "maint", role: "维护", bot: "Codex", icon: "codex-color", model: "gpt-5.6-sol", task: "IME 候选窗跟 caret", wt: "wt/loop-ime", state: "working", done: 6, total: 9, note: "重试 #2",
        chain: [{ who: "Manager", icon: "claudecode-color", ok: true }, { who: "Codex", icon: "codex-color", cur: true }, { who: "审阅", icon: "opencode", dim: true }] },
      { id: "ver", role: "版本", bot: "Claude Code", icon: "claudecode-color", model: "opus-5.5", task: "beta.5 · 新建 Agent 预选项目", wt: "wt/beta5-picker", state: "waiting", done: 11, total: 12, note: "等你确认推送",
        chain: [{ who: "Manager", icon: "claudecode-color", ok: true }, { who: "Claude", icon: "claudecode-color", ok: true }, { who: "审阅", icon: "opencode", ok: true }, { who: "你", you: true, cur: true }] },
      { id: "review", role: "审阅", bot: "OpenCode", icon: "opencode", model: "sonnet-5.5", task: "审 beta.5 diff + PR #3", wt: "wt/review", state: "done", done: 4, total: 4, note: "审查通过",
        chain: [{ who: "版本", icon: "claudecode-color", ok: true }, { who: "OpenCode", icon: "opencode", ok: true }] },
      { id: "promo", role: "宣发", bot: "Pi", icon: "pi", model: "kimi-k3", task: "changelog + 社交草稿", wt: "wt/promo", state: "working", done: 3, total: 6, note: "只出草稿",
        chain: [{ who: "Manager", icon: "claudecode-color", ok: true }, { who: "Pi", icon: "pi", cur: true }, { who: "你", you: true, dim: true }] },
    ],
    manager: { bot: "Claude Code", icon: "claudecode-color", model: "opus-5.5", state: "working", task: "拆任务、对齐共享记忆" },
    // 过程流事件（时间正序）。kind 决定符号；lane 决定车道色和右栏落在哪一列。
    events: [
      { t: "20:02:10", lane: "manager", kind: "msg", who: "Manager", icon: "claudecode-color", text: "beta.4 已经发出去了。我把后面拆成四条线：维护接着跑 loop，版本做 beta.5，审阅盯 diff 和 PR，宣发先出 changelog 草稿。" },
      { t: "20:02:31", lane: "manager", kind: "memory", title: "记忆更新 · beta.5 范围", meta: "shared/brief.md · +14 行", hash: "m-31a" },
      { t: "20:02:40", lane: "maint", kind: "handoff", title: "交接 → Codex", meta: "12.4k → 12.4k ✓", steps: "1 步 · 2s", hash: "h-8c1" },
      { t: "20:02:44", lane: "ver", kind: "handoff", title: "交接 → Claude", meta: "9.8k → 9.8k ✓", steps: "1 步 · 1s", hash: "h-2fe" },
      { t: "20:02:52", lane: "promo", kind: "handoff", title: "交接 → Pi", meta: "4.1k → 4.1k ✓", steps: "1 步 · 1s", hash: "h-77a" },
      { t: "20:04:05", lane: "maint", kind: "msg", who: "Codex", icon: "codex-color", text: "复现了：多行输入时候选窗停在第一行末尾。xterm 的 helper textarea 没跟着 caret 走，我先加探针看坐标。" },
      { t: "20:05:12", lane: "maint", kind: "artifact", title: "产物 · ime-probe.png", steps: "3 步 · 12s", hash: "a-4d0" },
      { t: "20:06:30", lane: "ver", kind: "commit", title: "提交 · 81b-new-agent.js", meta: "预选当前项目", steps: "5 步 · 28s", hash: "a3f9c21",
        sub: [["思考了 6 秒", ""], ["读取", "assets/js/81b-new-agent.js", "1s"], ["编辑", "naOpen() 预选 PROJ_HERE", "4s"], ["运行", "node --check", "1s"], ["编辑", "perch-files-test.mjs", "2s"]] },
      { t: "20:07:02", lane: "maint", kind: "fail", title: "测试 2 失败", meta: "ime-anchor.test", steps: "3 步 · 13s", hash: "t-91b" },
      { t: "20:07:40", lane: "maint", kind: "retry", title: "重试 #1", steps: "1 步 · 5s", hash: "r-1" },
      { t: "20:08:15", lane: "ver", kind: "test", title: "测试 48/48", steps: "1 步 · 4s", hash: "t-48" },
      { t: "20:08:20", lane: "ver", kind: "handoff", title: "交接 → 审阅", meta: "22.4k → 22.4k ✓", steps: "1 步 · 2s", hash: "h-c0d", to: "review" },
      { t: "20:09:02", lane: "promo", kind: "artifact", title: "产物 · changelog-beta5.md", meta: "草稿", steps: "3 步 · 12s", hash: "a-cl5" },
      { t: "20:09:40", lane: "review", kind: "msg", who: "OpenCode", icon: "opencode", text: "diff 看完了：预选逻辑只在单项目时生效，多项目时保持空选，这个边界是对的。PR #3 只改文案，可以合。" },
      { t: "20:09:58", lane: "review", kind: "review", title: "审查通过 · beta.5 + PR #3", steps: "2 步 · 9s", hash: "v-ok" },
      { t: "20:10:10", lane: "review", kind: "handoff", title: "交接 → 版本", meta: "6.2k → 6.2k ✓", steps: "1 步 · 1s", hash: "h-5e2", to: "ver" },
      { t: "20:10:31", lane: "ver", kind: "approval", title: "等你确认 · 推送 beta.5", meta: "push main + tag + Release", steps: "1 步 · 4s", hash: "w-push",
        options: ["推送并发版", "只推代码", "先不推"] },
      { t: "20:10:45", lane: "promo", kind: "msg", who: "Pi", icon: "pi", text: "社交草稿出了三版，等 beta.5 推送后再定稿。按规矩只出草稿，不会自己发。" },
      { t: "20:11:02", lane: "maint", kind: "running", title: "正在处理 · 重试 #2", meta: "Codex 工作中", hash: "r-2" },
    ],
  },
  {
    id: "promo-video", name: "宣传片 v2", project: "perch-promo",
    source: { kind: "standalone" },
    goal: "45 秒宣传片第二版：新故事板、新配音。",
    budget: { used: 8, cap: 40 },
    lanes: [
      { id: "script", role: "编剧", bot: "Claude Code", icon: "claudecode-color", model: "opus-5.5", task: "故事板 v2", wt: "wt/storyboard", state: "done", done: 5, total: 5, note: "完成", chain: [] },
      { id: "cut", role: "剪辑", bot: "Codex", icon: "codex-color", model: "gpt-5.6-sol", task: "镜头 3-6 重渲染", wt: "wt/render", state: "working", done: 2, total: 6, note: "渲染中", chain: [] },
      { id: "voice", role: "配音", bot: "Pi", icon: "pi", model: "kimi-k3", task: "旁白定稿", wt: "wt/vo", state: "idle", done: 0, total: 3, note: "等剪辑", chain: [] },
    ],
    manager: { bot: "Claude Code", icon: "claudecode-color", model: "opus-5.5", state: "idle", task: "" },
    events: [],
  },
  {
    id: "research", name: "竞品调研", project: "perch",
    source: { kind: "derived", agent: "codex-color", from: "Codex · Orca 对照" },
    goal: "整理 Orca / Lancer 的协作形态。",
    budget: { used: 19, cap: 30 },
    lanes: [
      { id: "scan", role: "收集", bot: "Codex", icon: "codex-color", model: "gpt-5.6-sol", task: "16 条参考", wt: "wt/collect", state: "done", done: 4, total: 4, note: "完成", chain: [] },
      { id: "sum", role: "归纳", bot: "Claude Code", icon: "claudecode-color", model: "sonnet-5.5", task: "digest.md", wt: "wt/digest", state: "paused", done: 2, total: 3, note: "已暂停", chain: [] },
    ],
    manager: { bot: "Claude Code", icon: "claudecode-color", model: "opus-5.5", state: "paused", task: "" },
    events: [],
  },
];

/* ---------- 状态 ---------- */
const BG = {
  group: "perch-team",
  focus: "all",          // "all" | lane id
  open: new Set(["a3f9c21", "w-push"]), // 默认展开的事件行（提交明细 + 审批选项）
};

function bgGroup() { return BG_DEMO.find((g) => g.id === BG.group) || BG_DEMO[0]; }
function bgLane(g, id) { return g.lanes.find((l) => l.id === id); }
function bgColor(id) { return BG_LANE_COLORS[id] || "#a1a1aa"; }

const BG_STATE_KEY = { working: "bg.state.working", waiting: "bg.state.waiting", done: "bg.state.done", idle: "bg.state.idle", paused: "bg.state.paused" };

/* ---------- 图标 ---------- */
const BG_I = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  term: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  send: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  chev: '<path d="m9 18 6-6-6-6"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
};
function bgIco(name, size) { return lucide(BG_I[name], size || 14); }

/* 事件符号：和右栏图例同一套。圆 = 提交，菱形 = 交接，方块 = 产物，
   双圈 = 检查点/审查，虚线圈 = 等待，红叉 = 失败，绿勾 = 测试通过。 */
function bgGlyph(kind, color) {
  const c = color || "currentColor";
  switch (kind) {
    case "commit": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="${c}"/></svg>`;
    case "handoff": return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="${c}"/></svg>`;
    case "artifact": return `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "memory": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="6" cy="6" r="1.4" fill="${c}"/></svg>`;
    case "review": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--bg-ok)"/><path d="m3.6 6.1 1.6 1.6 3.2-3.3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "test": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--bg-ok)"/><path d="m3.6 6.1 1.6 1.6 3.2-3.3" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "fail": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="var(--bg-bad)"/><path d="m4.2 4.2 3.6 3.6M7.8 4.2 4.2 7.8" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>`;
    case "retry": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--bg-bad)" stroke-width="1.4"/><path d="M6 3.6v2.6l1.6 1" fill="none" stroke="var(--bg-bad)" stroke-width="1.2" stroke-linecap="round"/></svg>`;
    case "approval": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="var(--bg-ask)" stroke-width="1.8"/></svg>`;
    case "running": return `<svg class="bg-spin" width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/><path d="M6 1.6a4.4 4.4 0 0 1 4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    case "wait": return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/></svg>`;
    default: return `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="2" fill="${c}"/></svg>`;
  }
}

function bgDot(state) { return `<span class="bg-dot" data-state="${esc(state)}"></span>`; }
function bgLaneName(g, id) {
  if (id === "manager") return "Manager";
  const l = bgLane(g, id);
  return l ? l.role : id;
}
function bgBadge(g, id) {
  return `<span class="bg-badge" style="--lane:${bgColor(id)}">${esc(bgLaneName(g, id))}</span>`;
}

/* ---------- 左栏：Bot Group 列表 ---------- */
function bgListHTML() {
  const groups = BG_DEMO.map((g) => {
    const on = g.id === BG.group;
    const active = g.lanes.filter((l) => l.state === "working" || l.state === "waiting").length;
    const src = g.source.kind === "derived"
      ? `<span class="bg-src" title="${esc(t("bg.list.derivedFrom"))} ${esc(g.source.from)}">${iconHTML(g.source.agent, "sm")}<span class="ell">${esc(g.source.from)}</span></span>`
      : `<span class="bg-src">${esc(t("bg.list.standalone"))}</span>`;
    const mgr = `<div class="bg-row bg-mgr${on && BG.focus === "manager" ? " sel" : ""}" data-bg-group="${esc(g.id)}" data-bg-focus="manager">`
      + `<span class="bg-ri">${iconHTML(g.manager.icon, "sm")}</span>`
      + `<span class="bg-rmain"><span class="bg-rt ell"><b>Manager</b> · ${esc(g.manager.task || t("bg.state.idle"))}</span>`
      + `<span class="bg-rs ell">${esc(g.manager.bot)} · ${esc(g.manager.model)}</span></span>${bgDot(g.manager.state)}</div>`;
    const rows = g.lanes.map((l) => {
      const sel = on && BG.focus === l.id;
      return `<div class="bg-row${sel ? " sel" : ""}" data-bg-group="${esc(g.id)}" data-bg-focus="${esc(l.id)}" style="--lane:${bgColor(l.id)}">`
        + `<span class="bg-ri">${iconHTML(l.icon, "sm")}</span>`
        + `<span class="bg-rmain"><span class="bg-rt ell"><b>${esc(l.role)}</b> · ${esc(l.task)}</span>`
        + `<span class="bg-rs ell">${esc(l.bot)} · ${esc(l.wt)}</span></span>${bgDot(l.state)}</div>`;
    }).join("");
    return `<section class="bg-grp${on ? " on" : ""}">`
      + `<div class="bg-gh" data-bg-group="${esc(g.id)}"><span class="bg-gn ell">${esc(g.name)}</span>`
      + `<span class="bg-gc">${active}/${g.lanes.length}</span></div>`
      + `<div class="bg-gsrc">${src}</div>`
      + mgr + rows + `</section>`;
  }).join("");
  const bots = BG_DEMO.reduce((n, g) => n + g.lanes.filter((l) => l.state === "working").length, 0);
  const waiting = BG_DEMO.reduce((n, g) => n + g.lanes.filter((l) => l.state === "waiting").length, 0);
  return `<div class="bg-lhead"><h1>${esc(t("chrome.mode.botgroup"))}</h1>`
    + `<button class="icon-btn" type="button" title="${esc(t("bg.list.new"))}" data-bg-act="new">${bgIco("plus", 15)}</button></div>`
    + `<label class="search bg-search">${bgIco("search", 13)}<input placeholder="${esc(t("bg.list.search"))}" spellcheck="false"><span class="kbd">Ctrl K</span></label>`
    + `<div class="bg-lscroll">${groups}</div>`
    + `<div class="bg-lfoot"><span>${esc(t("bg.list.running", { n: bots }))}</span>`
    + `<span class="bg-ask-t">${esc(t("bg.list.waiting", { n: waiting }))}</span></div>`;
}

/* ---------- 中上：交接链 ---------- */
function bgChip(c, laneId) {
  const cls = "bg-chip" + (c.cur ? " cur" : "") + (c.dim ? " dim" : "") + (c.you ? " you" : "");
  const ico = c.you ? `<span class="bg-ci">${bgIco("user", 12)}</span>` : `<span class="bg-ci">${iconHTML(c.icon, "sm")}</span>`;
  const ok = c.ok ? `<span class="bg-ok">✓</span>` : "";
  return `<span class="${cls}" style="--lane:${bgColor(laneId)}">${ico}<span>${esc(c.who)}</span>${ok}</span>`;
}
function bgChainHTML(g) {
  const rows = g.lanes.filter((l) => l.chain && l.chain.length).map((l) => {
    const sel = BG.focus === l.id;
    const chips = l.chain.map((c) => bgChip(c, l.id)).join(`<span class="bg-arrow">→</span>`);
    return `<div class="bg-chain-row${sel ? " sel" : ""}${BG.focus !== "all" && !sel ? " mute" : ""}" data-bg-focus="${esc(l.id)}">`
      + `<span class="bg-lane-l" style="--lane:${bgColor(l.id)}"><i></i>${esc(l.role)}</span>`
      + `<span class="bg-chips">${chips}</span></div>`;
  }).join("");
  return rows;
}

/* ---------- 中：过程流 ---------- */
function bgEventRow(g, e, showBadge) {
  const open = BG.open.has(e.hash);
  const color = bgColor(e.lane);
  const cls = "bg-ev" + (e.kind === "approval" ? " ask" : "") + (e.kind === "fail" ? " bad" : "") + (e.kind === "running" ? " run" : "") + (open ? " open" : "");
  const caret = (e.sub || e.options) ? `<span class="bg-caret">${bgIco("chev", 11)}</span>` : `<span class="bg-caret blank"></span>`;
  const meta = e.meta ? `<span class="bg-ev-meta">${esc(e.meta)}</span>` : "";
  const right = e.steps ? `<span class="bg-ev-r">${esc(e.steps)}</span>` : "";
  let body = "";
  if (open && e.sub) {
    body = `<div class="bg-ev-body"><div class="bg-ev-sum">${esc(t("bg.feed.stepsDone", { n: e.sub.length }))}</div>`
      + e.sub.map((s) => `<div class="bg-step"><span class="bg-caret">${bgIco("chev", 10)}</span><span class="bg-step-k">${esc(s[0])}</span><span class="bg-step-v ell">${esc(s[1] || "")}</span><span class="bg-ev-r">${esc(s[2] || "")}</span></div>`).join("")
      + `</div>`;
  }
  if (open && e.options) {
    body = `<div class="bg-ev-body"><div class="bg-gate">${bgIco("shield", 13)}<span>${esc(t("bg.feed.gate"))}</span></div>`
      + `<div class="bg-opts">${e.options.map((o, i) => `<button type="button" class="bg-opt${i === 0 ? " primary" : ""}">${esc(o)}</button>`).join("")}</div></div>`;
  }
  return `<div class="${cls}" data-bg-ev="${esc(e.hash)}" style="--lane:${color}">`
    + `<div class="bg-ev-h">${caret}<span class="bg-ev-g">${bgGlyph(e.kind, color)}</span>`
    + (showBadge ? bgBadge(g, e.lane) : "")
    + `<span class="bg-ev-t ell">${esc(e.title)}</span>${meta}${right}</div>${body}</div>`;
}
function bgMsgHTML(g, e, showBadge) {
  return `<div class="bg-msg" style="--lane:${bgColor(e.lane)}">`
    + `<div class="bg-msg-h">${iconHTML(e.icon, "sm")}<b>${esc(e.who)}</b>`
    + (showBadge && e.lane !== "manager" ? bgBadge(g, e.lane) : "")
    + `<span class="bg-msg-t">${esc(e.t.slice(0, 5))}</span></div>`
    + `<div class="bg-msg-b">${esc(e.text)}</div></div>`;
}
function bgFeedHTML(g) {
  const all = BG.focus === "all";
  const evs = g.events.filter((e) => all || e.lane === BG.focus || e.to === BG.focus);
  if (!evs.length) return `<div class="bg-empty">${esc(t("bg.feed.empty"))}</div>`;
  return evs.map((e) => e.kind === "msg" ? bgMsgHTML(g, e, all) : bgEventRow(g, e, all)).join("");
}
function bgFeedHeadHTML(g) {
  if (BG.focus === "all") {
    return `<span class="bg-fh-t"><b>${esc(t("bg.feed.allLanes"))}</b><span class="bg-fh-s">${esc(t("bg.feed.allSub", { n: g.lanes.length }))}</span></span>`
      + `<span class="bg-fh-r">${esc(t("bg.feed.clickHint"))}</span>`;
  }
  if (BG.focus === "manager") {
    return `<span class="bg-fh-t">${bgBadge(g, "manager")}<b>${esc(g.manager.bot)} · ${esc(g.manager.task)}</b></span><span class="bg-fh-r mono">shared/brief.md</span>`;
  }
  const l = bgLane(g, BG.focus);
  return `<span class="bg-fh-t">${bgBadge(g, l.id)}<b>${esc(l.bot)} · ${esc(l.task)}</b></span>`
    + `<span class="bg-fh-r mono">${esc(l.wt)}</span>`
    + `<button type="button" class="bg-ghost" title="${esc(t("bg.feed.openTermTitle"))}">${bgIco("term", 13)}<span>${esc(t("bg.feed.openTerm"))}</span></button>`;
}

/* ---------- 右：工作树 · 泳道 ---------- */
function bgLaneTabsHTML(g) {
  return g.lanes.map((l) => {
    const sel = BG.focus === l.id;
    const pct = l.total ? Math.round(100 * l.done / l.total) : 0;
    return `<button type="button" class="bg-lt${sel ? " sel" : ""}" data-bg-focus="${esc(l.id)}" style="--lane:${bgColor(l.id)}">`
      + `<span class="bg-lt-n"><i></i>${esc(l.role)}</span>`
      + `<span class="bg-lt-a">${iconHTML(l.icon, "sm")}<span class="ell">${esc(l.bot)}</span></span>`
      + `<span class="bg-lt-bar"><span style="width:${pct}%"></span></span>`
      + `<span class="bg-lt-s ell" data-state="${esc(l.state)}">${l.done}/${l.total} · ${esc(l.note)}</span></button>`;
  }).join("");
}

/* 泳道图：每条车道一列竖线，事件按时间往下排（不同车道的事件共享同一条
   时间轴，所以同一时刻发生的事在同一高度上）。交接跨车道时画一条曲线。 */
function bgTreeSVG(g, width) {
  const lanes = g.lanes;
  const evs = g.events.filter((e) => e.kind !== "msg" && e.lane !== "manager");
  const colW = Math.max(70, Math.floor((width - 16) / lanes.length));
  const x0 = 14;
  const xOf = (id) => {
    const i = lanes.findIndex((l) => l.id === id);
    return x0 + (i < 0 ? 0 : i) * colW;
  };
  const rowH = 34, top = 18;
  const ys = evs.map((_, i) => top + i * rowH);
  const H = top + evs.length * rowH + 40;
  const focus = BG.focus;
  const parts = [];
  // 竖线：从这条车道第一个事件画到最后一个，再往下虚线延到底（还在继续）
  lanes.forEach((l) => {
    const idx = evs.map((e, i) => (e.lane === l.id ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const x = xOf(l.id), y1 = ys[idx[0]], y2 = ys[idx[idx.length - 1]];
    const op = focus === "all" || focus === l.id ? 1 : 0.28;
    parts.push(`<g opacity="${op}"><line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${bgColor(l.id)}" stroke-width="2"/>`);
    if (l.state === "working" || l.state === "waiting") {
      parts.push(`<line x1="${x}" y1="${y2}" x2="${x}" y2="${H - 22}" stroke="${bgColor(l.id)}" stroke-width="1.4" stroke-dasharray="3 3" opacity=".55"/>`);
    }
    parts.push(`</g>`);
  });
  // 跨车道交接
  evs.forEach((e, i) => {
    if (!e.to) return;
    const j = evs.findIndex((f, k) => k > i && f.lane === e.to);
    if (j < 0) return;
    const xa = xOf(e.lane), ya = ys[i], xb = xOf(e.to), yb = ys[j];
    const op = focus === "all" || focus === e.lane || focus === e.to ? 0.7 : 0.18;
    parts.push(`<path d="M${xa} ${ya} C ${xa} ${(ya + yb) / 2}, ${xb} ${(ya + yb) / 2}, ${xb} ${yb}" fill="none" stroke="${bgColor(e.lane)}" stroke-width="1.3" stroke-dasharray="3 2.5" opacity="${op}"/>`);
  });
  // 节点 + 标签
  evs.forEach((e, i) => {
    const x = xOf(e.lane), y = ys[i], c = bgColor(e.lane);
    const op = focus === "all" || focus === e.lane || focus === e.to ? 1 : 0.28;
    let node;
    switch (e.kind) {
      case "commit": node = `<circle cx="${x}" cy="${y}" r="4.5" fill="${c}"/>`; break;
      case "handoff": node = `<path d="M${x} ${y - 5.5} L${x + 5.5} ${y} L${x} ${y + 5.5} L${x - 5.5} ${y} Z" fill="${c}"/>`; break;
      case "artifact": node = `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.6"/>`; break;
      case "test": case "review": node = `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-ok)"/><path d="M${x - 2.6} ${y} l1.8 1.8 l3.4 -3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`; break;
      case "fail": node = `<circle cx="${x}" cy="${y}" r="6" fill="var(--bg-bad)"/><path d="M${x - 2.2} ${y - 2.2} l4.4 4.4 M${x + 2.2} ${y - 2.2} l-4.4 4.4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/>`; break;
      case "retry": node = `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg-panel)" stroke="var(--bg-bad)" stroke-width="1.5"/>`; break;
      case "approval": node = `<circle cx="${x}" cy="${y}" r="6.5" fill="var(--bg-panel)" stroke="var(--bg-ask)" stroke-width="2.2"/><circle cx="${x}" cy="${y}" r="2.2" fill="var(--bg-ask)"/>`; break;
      case "running": node = `<circle cx="${x}" cy="${y}" r="5" fill="var(--bg-panel)" stroke="${c}" stroke-width="1.4" stroke-dasharray="2.4 2"/>`; break;
      default: node = `<circle cx="${x}" cy="${y}" r="3" fill="${c}"/>`;
    }
    const sub = e.kind === "approval" ? "等你" : (bgLane(g, e.lane) || {}).bot || "";
    const room = width - x - 14;
    const label = e.title.replace(/^(提交|产物|交接|等你确认) · /, "").replace(/^交接 → /, "→ ");
    const strong = e.kind === "approval" ? ` class="ask"` : (e.kind === "fail" ? ` class="bad"` : "");
    parts.push(`<g opacity="${op}" data-bg-ev="${esc(e.hash)}">${node}`
      + `<text x="${x + 10}" y="${y - 1}"${strong}>${esc(bgFit(label, room))}</text>`
      + `<text x="${x + 10}" y="${y + 10}" class="sub">${esc(sub)} · ${esc(e.hash)}</text></g>`);
  });
  return `<svg class="bg-tree-svg" width="${width}" height="${H}" viewBox="0 0 ${width} ${H}">${parts.join("")}</svg>`;
}

/* 等宽 10.5px：ASCII ≈ 6.3px，CJK ≈ 10.5px。按可用宽度截断，免得最后一列压出边。 */
function bgFit(s, room) {
  let w = 0, out = "";
  for (const ch of String(s)) {
    const cw = ch.codePointAt(0) > 0x2e80 ? 10.5 : 6.3;
    if (w + cw > room - 7) return out + "…";
    w += cw; out += ch;
  }
  return out;
}

const BG_LEGEND = [
  ["commit", "bg.legend.commit"], ["handoff", "bg.legend.handoff"], ["memory", "bg.legend.checkpoint"], ["test", "bg.legend.test"],
  ["fail", "bg.legend.fail"], ["review", "bg.legend.review"], ["artifact", "bg.legend.artifact"], ["retry", "bg.legend.retry"],
  ["approval", "bg.legend.waitYou"], ["running", "bg.legend.running"], ["wait", "bg.legend.crossRef"], ["dot", "bg.legend.tool"],
];
function bgLegendHTML() {
  return BG_LEGEND.map(([k, key]) => `<span class="bg-lg">${bgGlyph(k, "var(--bg-fg2)")}<span>${esc(t(key))}</span></span>`).join("");
}

/* ---------- 整页 ---------- */
function renderBotGroup(why) {
  const root = $("bg");
  if (!root) return;
  const g = bgGroup();
  const waiting = g.lanes.filter((l) => l.state === "waiting").length;
  const srcLine = g.source.kind === "derived"
    ? `<span class="bg-from">${bgIco("split", 12)}${esc(t("bg.head.derived"))} ${iconHTML(g.source.agent, "sm")}<b>${esc(g.source.from)}</b></span>`
    : `<span class="bg-from">${esc(t("bg.head.standalone"))}</span>`;
  const light = document.documentElement.classList.contains("theme-light");
  root.innerHTML =
    `<aside class="bg-list">${bgListHTML()}</aside>`
    + `<section class="bg-center">`
    +   `<header class="bg-head">`
    +     `<div class="bg-title"><h2>${esc(g.name)}</h2><span class="bg-proj mono">${esc(g.project)}</span></div>`
    +     `<div class="bg-acts">`
    +       `<span class="bg-budget" title="${esc(t("bg.head.budgetTitle"))}">${esc(t("bg.head.budget", { used: g.budget.used, cap: g.budget.cap }))}<span class="bg-bbar"><span style="width:${Math.round(100 * g.budget.used / g.budget.cap)}%"></span></span></span>`
    +       (waiting ? `<button type="button" class="bg-needbtn">${bgDot("waiting")}${esc(t("bg.head.needYou", { n: waiting }))}</button>` : "")
    +       `<button type="button" class="bg-btn">${bgIco("pause", 12)}<span>${esc(t("bg.head.pauseAll"))}</span></button>`
    +       `<button type="button" class="bg-btn primary">${bgIco("plus", 12)}<span>${esc(t("bg.head.addBot"))}</span></button>`
    +       `<button type="button" class="icon-btn bg-theme" data-bg-act="theme" title="${esc(t(light ? "bg.head.toDark" : "bg.head.toLight"))}">${bgIco(light ? "moon" : "sun", 14)}</button>`
    +     `</div>`
    +   `</header>`
    +   `<div class="bg-goal">${srcLine}<span class="bg-sep">·</span><span class="bg-goal-k">${esc(t("bg.head.goal"))}</span><span class="ell">${esc(g.goal)}</span></div>`
    +   `<div class="bg-chain">${bgChainHTML(g) || `<div class="bg-empty sm">${esc(t("bg.chain.empty"))}</div>`}</div>`
    +   `<div class="bg-fh">${bgFeedHeadHTML(g)}</div>`
    +   `<div class="bg-feed">${bgFeedHTML(g)}</div>`
    +   `<div class="bg-composer"><div class="bg-cbox"><div class="bg-cin">${esc(t("bg.composer.ph"))}</div>`
    +     `<div class="bg-cfoot"><span>${esc(t("bg.composer.hint"))}</span><button type="button" class="bg-send" aria-label="send">${bgIco("send", 13)}</button></div></div></div>`
    + `</section>`
    + `<aside class="bg-tree">`
    +   `<div class="bg-th"><b>${esc(t("bg.tree.title"))}</b><span>${esc(t("bg.tree.sub", { n: g.lanes.length, w: waiting }))}</span></div>`
    +   `<div class="bg-lts" style="--n:${g.lanes.length}">${bgLaneTabsHTML(g)}</div>`
    +   `<div class="bg-tseg"><span class="segs-mini"><button type="button" class="${BG.focus === "all" ? "" : "on"}" data-bg-act="focus-cur">${esc(t("bg.tree.focus"))}</button>`
    +     `<button type="button" class="${BG.focus === "all" ? "on" : ""}" data-bg-focus="all">${esc(t("bg.tree.all"))}</button></span><span class="mono bg-now">20:11:24</span></div>`
    +   `<div class="bg-tscroll" id="bg-tscroll"></div>`
    +   `<div class="bg-legend"><div class="bg-lg-h">${esc(t("bg.legend.title"))}</div><div class="bg-lg-grid">${bgLegendHTML()}</div></div>`
    + `</aside>`;
  const ts = $("bg-tscroll");
  if (ts) ts.innerHTML = g.events.length ? bgTreeSVG(g, Math.max(260, ts.clientWidth || 340)) : `<div class="bg-empty sm">${esc(t("bg.tree.empty"))}</div>`;
  if (why) sendCtrl({ type: "log", msg: `Bot Group 渲染（${why}）group=${g.id} focus=${BG.focus} theme=${light ? "light" : "dark"}` });
}

{
  const root = $("bg");
  if (root && !root.dataset.bound) {
    root.dataset.bound = "1";
    root.addEventListener("click", (e) => {
      const act = e.target.closest("[data-bg-act]");
      if (act) {
        const a = act.dataset.bgAct;
        if (a === "theme") {
          // 页头这颗是全局主题的快捷开关（和设置 › 外观是同一份设置）。
          const next = document.documentElement.classList.contains("theme-light") ? "dark" : "light";
          SETTINGS.theme = next;
          saveSettingsCache();
          applyTheme("Bot Group 页头");
          sendCtrl({ type: "settings.set", settings: { theme: next } });
        } else if (a === "focus-cur") {
          if (BG.focus === "all") { BG.focus = (bgGroup().lanes.find((l) => l.state === "waiting") || bgGroup().lanes[0]).id; renderBotGroup("聚焦"); }
        }
        return;
      }
      const ev = e.target.closest(".bg-ev-h");
      if (ev) {
        const h = ev.parentElement.dataset.bgEv;
        if (BG.open.has(h)) BG.open.delete(h); else BG.open.add(h);
        renderBotGroup();
        return;
      }
      const f = e.target.closest("[data-bg-focus]");
      if (f) {
        const gid = f.dataset.bgGroup;
        if (gid) BG.group = gid;
        BG.focus = BG.focus === f.dataset.bgFocus && f.dataset.bgFocus !== "all" ? "all" : f.dataset.bgFocus;
        renderBotGroup("选车道");
        return;
      }
      const gh = e.target.closest(".bg-gh");
      if (gh) {
        BG.group = gh.dataset.bgGroup;
        BG.focus = "all";
        renderBotGroup("选组");
      }
    });
    window.addEventListener("resize", () => {
      if (document.body.classList.contains("botgroup")) renderBotGroup();
    });
  }
  if (SETTINGS.topMode === "botgroup") renderBotGroup("启动");
}
