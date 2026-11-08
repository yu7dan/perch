"use strict";
/* 36-desk-group.js —— Bot Group 块（照定稿模拟 spec/desk 的 Bot Group 那一段）。
   块里三步建组（目标与项目 → 成员 → 开工）；开工以后：群聊、@、成员详情（在干什么、换模型、单聊、
   人设与岗位、移出）、中途加 Bot、拍板卡、预算条、全部暂停。

   数据全是真的：
     · 组 / 成员 / 过程流 / 任务账本在 Go（internal/botgroup；协调器 coord.go：agent 之间从不直接对话，
       经 perch-bg → Bot Bus → 协调器派活、交回、过守卫、记账）。这里只画、只执行投递。
     · 每个成员是一格真 agent（spec.group / spec.bot）。终端住在 #termpark（有尺寸、看不见 ——
       PTY 的启动闸是首帧尺寸）；成员详情里点「终端」才搬进抽屉，收起抽屉搬回去。
     · 送达 = 把这句话粘贴进那一格的终端再回车，只在它**空闲**时送（忙着插一句会被当成对当前问题的回答）。
       Go 推来的投递（任务包 / 交回的结果）也走这一条，送完回执 bg.delivered。
     · 群里看到的话：你说的（Go 记进过程流）、交接 / 交回 / 被拦这些（协调器记的）、
       各成员回答群里那几轮的最后一段话（从它的转录里取，不另存）。单聊的只在成员详情里。
   人设与岗位：结构化的那份存在本机（下次打开还是那几个勾）；写成一段文字的那份交给 Go 存成成员的
   instructions —— 开场说明里带着它（第一条消息前面），改了以后附在送给它的下一条消息前面（不用重启、不多跑一轮）。 */

const ROLE_PRESETS = ["开发", "审阅", "测试", "文档", "维护", "宣发"];
// 界面是英文时，预设的角色名和人设也是英文（角色名会进 @ 和 Go 的记录，所以是真改名字，不是只换显示）
const ROLE_PRESETS_EN = ["Dev", "Review", "Test", "Docs", "Maintenance", "Promo"];
const rolePresets = () => PERCH_LOCALE === "en" ? ROLE_PRESETS_EN : ROLE_PRESETS;
const ROLE_COLORS = ["#8aa4ff", "#7dd3c0", "#f5a3c7", "#f5b454", "#c4b5fd", "#93c5fd", "#fca5a5"];
const MGR_COLOR = "#ececf1";
const BG_MAX = 6;   // 和 Go 的 botgroup.MaxBots 一样
const BUDGETS = [[200, "200k"], [500, "500k"], [1000, "1M"], [-1, "不限"]];
const ROLE_PERSONA = {
  Manager: { duty: "把目标拆成能交付的小活，派给合适的 Bot；盯进度、汇总结果；要你拍板的事整理好再来问。", style: "简洁、条理清楚；每次汇报只讲结论和需要你决定的事。", scope: "（不直接改代码）", done: "目标达成，或者讲清楚卡在哪、需要你做什么" },
  开发: { duty: "按 Manager 派的活改代码；动手前先说计划，改完写清楚改了哪几处、为什么。", style: "务实，先给结论再讲细节；拿不准就问，不瞎猜。", scope: "src/**, site/**", done: "能跑、自测过、改动说明写清楚" },
  审阅: { duty: "逐条看其他 Bot 的改动：对不对、边界情况、有没有误改别的文件。", style: "严格但具体：每条意见都指到文件和行。", scope: "（只读）", done: "每处改动都有结论：通过，或者要改哪里" },
  测试: { duty: "跑起来看效果、对截图、找回归；发现问题直接报给负责的 Bot。", style: "拿证据说话：截图、日志、复现步骤。", scope: "tests/**", done: "关键页面都对过截图，问题都有复现步骤" },
  文档: { duty: "把改动写成用户看得懂的文档和更新日志。", style: "短句、少术语，先讲怎么用。", scope: "docs/**, site/docs/**", done: "新功能都有文档，链接都点得开" },
  维护: { duty: "管构建、依赖和 CI；别人卡在环境问题上时出手。", style: "稳妥，能不升级就不升级。", scope: "package.json, .github/**", done: "构建通过，依赖没有已知漏洞" },
  宣发: { duty: "写发布文案、更新官网介绍。", style: "口语、有画面感，不夸大。", scope: "site/**", done: "给出 3 版文案让你挑" },
};
const ROLE_PERSONA_EN = {
  Manager: { duty: "Split the goal into deliverable tasks and assign them to the right bots; track progress and sum up results; bring decisions to the user with the options laid out.", style: "Concise and organized; each report gives only conclusions and what needs your decision.", scope: "（no direct code changes）", done: "The goal is met, or it's clear where things are stuck and what the user needs to do" },
  Dev: { duty: "Change code as the Manager assigns; state the plan first, then explain which places changed and why.", style: "Practical: conclusion first, details after; ask when unsure instead of guessing.", scope: "src/**, site/**", done: "It runs, it's self-tested, and the change notes are clear" },
  Review: { duty: "Review every change from other bots: correctness, edge cases, and accidental edits to other files.", style: "Strict but specific: every comment points at a file and line.", scope: "（read-only）", done: "Every change has a verdict: approved, or what to fix" },
  Test: { duty: "Run it, compare screenshots, hunt regressions; report problems straight to the responsible bot.", style: "Evidence first: screenshots, logs, reproduction steps.", scope: "tests/**", done: "Key pages are checked against screenshots and every problem has repro steps" },
  Docs: { duty: "Turn changes into user-friendly docs and changelog entries.", style: "Short sentences, little jargon, how-to first.", scope: "docs/**, site/docs/**", done: "Every new feature is documented and every link works" },
  Maintenance: { duty: "Own the build, dependencies and CI; step in when others get stuck on environment issues.", style: "Careful: don't upgrade unless needed.", scope: "package.json, .github/**", done: "The build passes and dependencies have no known vulnerabilities" },
  Promo: { duty: "Write release notes and update the website copy.", style: "Conversational and vivid, no hype.", scope: "site/**", done: "Three versions of the copy for the user to choose from" },
};
function personaFor(role) {
  const en = PERCH_LOCALE === "en";
  const b = (role === "Manager" ? (en ? ROLE_PERSONA_EN.Manager : ROLE_PERSONA.Manager) : (ROLE_PERSONA[role] || ROLE_PERSONA_EN[role])) || { duty: "", style: "", scope: "", done: "" };
  return { duty: b.duty, style: b.style, scope: b.scope, done: b.done,
    forbid: { main: true, del: true, deps: false, net: false }, ask: { merge: true, del: true, deps: true, cost: 50 }, direct: false };
}
const clonePersona = (p) => JSON.parse(JSON.stringify(p));
const pget = (p, k) => k.split(".").reduce((o, x) => o && o[x], p);
const pset = (p, k, v) => { const ks = k.split("."); const last = ks.pop(); ks.reduce((o, x) => o[x], p)[last] = v; };
// 人设写成交给 agent 的那段话（Go 存成成员的 instructions，开场说明里「你的分工：」后面就是它）。
function personaText(p) {
  if (!p) return "";
  if (PERCH_LOCALE === "en") return personaTextEn(p);
  const L = [];
  if (p.duty) L.push("岗位职责：" + p.duty.trim());
  if (p.style) L.push("人设与风格：" + p.style.trim());
  const sc = String(p.scope || "").trim();
  if (sc) L.push(/^（.*）$/.test(sc) ? "能动哪些地方：" + sc.slice(1, -1) : `能动哪些地方：${sc}（别的地方只读）`);
  const fb = [["main", "不直接改 main"], ["del", "不删文件"], ["deps", "不装新依赖"], ["net", "不联网"]].filter(([k]) => p.forbid && p.forbid[k]).map((x) => x[1]);
  if (fb.length) L.push("不能做的事：" + fb.join("、"));
  const ak = [["merge", "合进 main 之前"], ["del", "要删文件时"], ["deps", "要装依赖时"]].filter(([k]) => p.ask && p.ask[k]).map((x) => x[1]);
  if (p.ask && +p.ask.cost > 0) ak.push(`单次花费超过 ${+p.ask.cost}k tokens 时`);
  if (ak.length) L.push("这些时候先停下来找用户拍板：" + ak.join("、"));
  if (p.done) L.push("交付标准：" + p.done.trim());
  L.push(p.direct ? "汇报：可以绕过 Manager 直接找用户" : "汇报：向 Manager 汇报");
  return L.join("\n");
}

function personaTextEn(p) {
  const L = [];
  if (p.duty) L.push("Duties: " + p.duty.trim());
  if (p.style) L.push("Persona & style: " + p.style.trim());
  const sc = String(p.scope || "").trim();
  if (sc) L.push(/^（.*）$/.test(sc) ? "Where you may write: " + sc.slice(1, -1) : `Where you may write: ${sc} (everything else is read-only)`);
  const fb = [["main", "don't change main directly"], ["del", "don't delete files"], ["deps", "don't add dependencies"], ["net", "no network access"]].filter(([k]) => p.forbid && p.forbid[k]).map((x) => x[1]);
  if (fb.length) L.push("Not allowed: " + fb.join(", "));
  const ak = [["merge", "before merging into main"], ["del", "before deleting files"], ["deps", "before adding dependencies"]].filter(([k]) => p.ask && p.ask[k]).map((x) => x[1]);
  if (p.ask && +p.ask.cost > 0) ak.push(`when one task would cost more than ${+p.ask.cost}k tokens`);
  if (ak.length) L.push("Stop and ask the user: " + ak.join(", "));
  if (p.done) L.push("Done means: " + p.done.trim());
  L.push(p.direct ? "Reporting: you may go straight to the user" : "Reporting: report to the Manager");
  return L.join("\n");
}

/* ---------- 本机记着的几样（都是小份，localStorage） ---------- */
function lsGet(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (_) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
const PERSONAS = lsGet("perch.bg.persona", {});      // "gid/bid" → 人设（结构化的那份）
let PERSONA_TPL = lsGet("perch.bg.personaTpl", []);   // 你自己存的模板：{ name, role, persona }
const BG_MODEL = lsGet("perch.bg.model", {});         // "gid/bid" → { provider, model }（成员详情里换过的）
const BG_DM = lsGet("perch.bg.dm", {});               // "gid/bid" → [单聊发过的话]（认出它对话里哪几轮是单聊）
const ROLE_PENDING = lsGet("perch.bg.rolePending", {}); // "gid/bid" → 改过、还没捎给它的岗位说明
const bk = (gid, bid) => gid + "/" + bid;
function personaOf(g, b) {
  const p = PERSONAS[bk(g.id, b.id)];
  if (p) return p;
  const base = personaFor(b.manager ? "Manager" : b.role);
  return b.instructions && !ROLE_PERSONA[b.manager ? "Manager" : b.role] && !ROLE_PERSONA_EN[b.manager ? "Manager" : b.role] ? Object.assign(base, { duty: b.instructions }) : base;
}
function savePersona(gid, bid, p) { PERSONAS[bk(gid, bid)] = clonePersona(p); lsSet("perch.bg.persona", PERSONAS); }

/* ---------- Go 推来的 ---------- */
let BOTGROUPS = [];
const BG_EVENTS = new Map();   // gid → [event]（id 升序）
const BG_TASKS = new Map();    // gid → [task]
let BG_INTROS = {}, BG_USEDK = {}, BG_LOADED = false;
const bgGroup = (gid) => BOTGROUPS.find((g) => g.id === gid) || null;
const bgBot = (g, id) => g ? (g.bots || []).find((b) => b.id === id) || null : null;
const bgLanes = (g) => g ? (g.bots || []).filter((b) => !b.manager) : [];
const bgManager = (g) => g ? (g.bots || []).find((b) => b.manager) || null : null;
const roleOf = (b) => b ? (b.manager ? "Manager" : b.role) : "?";
function bgColor(g, b) {
  if (!b || b.manager) return MGR_COLOR;
  const i = bgLanes(g).indexOf(b);
  return ROLE_COLORS[(i < 0 ? 0 : i) % ROLE_COLORS.length];
}
function bgRole(g, id) { return id === "you" ? "你" : roleOf(bgBot(g, id)) || id; }

function applyBotGroups(m) {
  BOTGROUPS = Array.isArray(m.groups) ? m.groups : [];
  BG_EVENTS.clear();
  for (const g of BOTGROUPS) BG_EVENTS.set(g.id, Array.isArray((m.events || {})[g.id]) ? m.events[g.id] : []);
  BG_TASKS.clear();
  for (const [gid, list] of Object.entries(m.tasks || {})) BG_TASKS.set(gid, Array.isArray(list) ? list : []);
  BG_INTROS = m.intros || {};
  BG_USEDK = m.usedK || {};
  BG_LOADED = true;
  // 单聊记录要每个成员的完整转录：页面刚加载时只有个别格补过快照
  if (typeof askAllSnapshots === "function") askAllSnapshots("Bot Group");
  for (const z of Z) if (z.kind === "group") z.group.sv++;
  deskSoon("botgroups");
}
function applyBotGroupEvent(m) {
  const list = BG_EVENTS.get(m.group);
  if (!list || !m.event) return;
  const last = list.length ? list[list.length - 1].id : 0;
  if (m.event.id <= last) return;   // 按 id 追加（见 live-list-must-anchor-by-id）
  list.push(m.event);
  if (list.length > 600) list.splice(0, list.length - 400);
  deskSoon("botgroup.event");
}
function bgTaskUpdate(m) {
  if (!m || !m.task) return;
  const list = BG_TASKS.get(m.group) || [];
  const i = list.findIndex((x) => x.id === m.task.id);
  if (i >= 0) list[i] = m.task; else list.push(m.task);
  BG_TASKS.set(m.group, list);
  deskSoon("task.update");
}
const BG_PENDING = new Map();
let BG_REQ = 0;
function bgRequest(msg) {
  const req = ++BG_REQ;
  return new Promise((resolve) => {
    BG_PENDING.set(req, resolve);
    sendCtrl(Object.assign({ req }, msg));
    // 建组要等 worktree 建好才回（git 在后台跑），给足时间
    setTimeout(() => { if (BG_PENDING.has(req)) { BG_PENDING.delete(req); resolve({ ok: false, err: "Perch 没有回应，再试一次" }); } }, 30000);
  });
}
function botGroupResult(m) {
  const r = BG_PENDING.get(m.req);
  if (!r) return;
  BG_PENDING.delete(m.req);
  r(m);
}
// 10-term / 22-live 在成员格的状态变了时叫这两个：下一帧重画就行
function botStateChanged() { deskSoon("bot state"); }
function bgSchedule() { deskSoon("bot live"); }

/* ---------- 成员 ↔ 格子 ---------- */
function bgTabOf(b) {
  if (!b || !b.paneId) return null;
  return TAB_LIST.find((x) => (x.paneID | 0) === b.paneId) || null;
}
/* 启动门（读可见屏幕）：Claude 的「信任这个文件夹吗」、完全访问的确认、登录门。
   门在的时候这个成员算「等你」（送达只在空闲时送，回车不会误按），群里出一张卡，能直接答的直接答。 */
const BG_GATES = new Map();   // tab id → kind
function screenLines(tab) {
  const buf = tab && tab.term && tab.term.buffer.active;
  if (!buf) return [];
  const lo = Math.max(0, buf.viewportY), hi = Math.min(buf.length - 1, lo + (tab.term.rows || 50) - 1);
  const out = [];
  for (let i = lo; i <= hi; i++) { const l = buf.getLine(i); if (l) out.push(l.translateToString(true)); }
  return out;
}
function readGate(tab) {
  if (!tab || tab.connDown || !tab.group) return "";
  let bypass = false, accept = false, trust = false;
  for (const s of screenLines(tab)) {
    if (/Bypass Permissions mode/i.test(s)) bypass = true;
    if (/Yes, I accept/i.test(s)) accept = true;
    // Claude 2.x 的信任门默认选中「No, exit」：一包粘贴带回车进去，格子就退了（claude-trust-screen-defaults-to-exit）
    if (/Do you trust the files in this folder|Is this a project you created or one you trust|Yes, I trust this folder/i.test(s)) trust = true;
  }
  if (bypass && accept) return "bypass";
  if (trust) return "trust";
  if (LOGIN_GATES.has(tab.id)) return "login";
  return "";
}
setInterval(() => {
  let changed = false;
  for (const tab of TAB_LIST) {
    if (!tab.group) continue;
    const k = readGate(tab);
    if ((BG_GATES.get(tab.id) || "") === k) continue;
    changed = true;
    if (k) BG_GATES.set(tab.id, k); else BG_GATES.delete(tab.id);
    sendCtrl({ type: "log", msg: `Bot Group：启动门 ${k || "消失"} tab=${tab.id} ${tab.group}/${tab.bot}` });
  }
  for (const id of [...BG_GATES.keys()]) if (!TAB_LIST.some((x) => x.id === id)) { BG_GATES.delete(id); changed = true; }
  if (changed) deskSoon("gate");
}, 1000);
// 屏上菜单：光标行（❯ / >）到想选的那一行要按几下 ↓（负数 = ↑）；找不到 = null
function menuMoves(tab, want) {
  const ls = screenLines(tab);
  let cur = -1, hit = -1;
  ls.forEach((s, i) => { if (/^\s*[❯>›]\s*\S/.test(s)) cur = i; if (hit < 0 && want.test(s)) hit = i; });
  return cur >= 0 && hit >= 0 ? hit - cur : null;
}
function pressMenu(tab, moves) {
  const key = moves > 0 ? "\x1b[B" : "\x1b[A";
  for (let i = 0; i < Math.abs(moves); i++) setTimeout(() => { try { if (tab.stream) tab.stream.send(enc.encode(key)); } catch (_) {} }, i * 120);
  // 回车单独送：和挪光标一包送，有的 TUI 会把它当成别的输入
  setTimeout(() => { try { if (tab.stream) tab.stream.send(enc.encode("\r")); } catch (_) {} }, Math.abs(moves) * 120 + 250);
}
const PERM_YES = /^\s*[❯>›]?\s*1\.\s*Yes\b/i, PERM_NO = /^\s*[❯>›]?\s*\d\.\s*No\b/i;

/* 成员的状态，折成定稿里那几种点：work / wait / idle / off（pend = 还没起过格子）/ fail */
function botState(b) {
  const tab = bgTabOf(b);
  if (!tab) return "pend";
  if (BG_GATES.has(tab.id)) return "wait";
  const s = cellState(tab);
  if (s === "working") return "work";
  if (s === "ask") {
    // Claude 停下 60 秒后补的 idle_prompt（「在等你输入」）对成员来说只是这轮完了 —— 当成等你，投递会一直等它
    const v = LIVE.get(tab.id);
    const idleOnly = v && v.note && v.note.ntype === "idle_prompt" && v.st !== "waiting" && !pendingAsk(v) && !LOGIN_GATES.has(tab.id);
    return idleOnly ? "idle" : "wait";
  }
  if (s === "failed") return "fail";
  if (s === "off") return "off";
  return "idle";
}
const DOT_OF = { pend: "off", work: "work", wait: "wait", idle: "idle", off: "off", fail: "fail" };
const ST_TXT = { pend: "还没起来", work: "在干活", wait: "在等你", idle: "空闲", off: "停了", fail: "出错了" };

/* ---------- 起 / 接上一个成员的格子 ---------- */
const BG_STARTING = new Set();
async function bgStartBot(g, b, why, force) {
  if (!g || !b) return null;
  const k = bk(g.id, b.id);
  let tab = bgTabOf(b);
  if (tab && !tab.connDown && !force) return tab;
  if (BG_STARTING.has(k)) return null;
  BG_STARTING.add(k);
  try {
    let resume = { kind: "new", id: "" }, cwd = b.folder || b.worktree || g.project, target = "directory";
    if (tab) {
      // 停了 / 要重开（换模型牵涉它自己的登录）：同一个 paneId 接着来（有会话就接回那条）
      const sid = tab.sessionID || (tab.spec && tab.spec.resume && tab.spec.resume.kind === "exact" ? tab.spec.resume.id : "");
      if (sid) { resume = { kind: "exact", id: sid }; cwd = (tab.spec && tab.spec.cwd) || cwd; target = "legacy"; }
      closeTab(tab, { reseat: true, why: force ? "Bot 重开" : "Bot 停了，接着来" });
    } else if (b.paneId && CLOSED_PANES.has(b.paneId)) {
      const r = CLOSED_PANES.get(b.paneId);
      if (r.sessionId) { resume = { kind: "exact", id: r.sessionId }; cwd = r.cwd || cwd; target = "legacy"; }
      CLOSED_PANES.delete(b.paneId);
    }
    const spec = { agent: b.agent, cwd, target, resume, paneId: b.paneId || undefined, group: g.id, bot: b.id };
    const m = BG_MODEL[k];
    if (m) { if (m.provider) spec.provider = m.provider; if (m.model) spec.model = m.model; }
    else b.boot = typeof PROV !== "undefined" && PROV.view ? agentDefaultModel(b.agent) : null;
    sendCtrl({ type: "log", msg: `Bot Group：起格 ${k} agent=${b.agent} pane=${b.paneId || 0} resume=${resume.kind}（${why || ""}）` });
    const nt = await createTab(spec);
    if (!nt || !TAB_LIST.includes(nt)) {
      const r = nt && nt.resumeRefused;
      toast(`「${roleOf(b)}」没起来：${(r && r.msg) || "看一眼它的终端"}`, "warn");
      return null;
    }
    nt.bgBorn = Date.now();
    return nt;
  } finally { BG_STARTING.delete(k); }
}

/* ---------- 送话：发给谁、怎么送 ----------
   群里不 @ = Manager；@某个成员 = 它；@全员 = 所有人。单聊 = 那一个。按名字从长到短匹配，免得「开发」吃掉「开发二」。 */
const BG_Q = new Map();   // "gid/bid" → [{ text, origin, key? }]
const ALL_RE = /@(全员|all|everyone)(?=\s|$)/i;
function bgTargets(g, text) {
  const all = g.bots || [];
  if (ALL_RE.test(text)) return { targets: all, all: true };
  const names = all.map((b) => ({ b, n: roleOf(b) })).sort((a, b) => b.n.length - a.n.length);
  const hit = [];
  let rest = text;
  for (const { b, n } of names) {
    const re = new RegExp("@" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s|$|[，,。.:：!！?？])", "i");
    if (re.test(rest)) { if (!hit.includes(b)) hit.push(b); rest = rest.replace(re, " "); }
  }
  if (hit.length) return { targets: hit };
  const mgr = bgManager(g);
  return { targets: mgr ? [mgr] : [] };
}
const targetLabel = (r) => r.all ? "@全员" : r.targets.map((b) => "@" + roleOf(b)).join(" ");
function bgSend(g, text, opts) {
  opts = opts || {};
  text = String(text || "").trim();
  if (!g || !text) return false;
  const r = opts.to ? { targets: [opts.to] } : bgTargets(g, text);
  if (!r.targets.length) { toast("这个组里还没有能收话的成员", "warn"); return false; }
  const origin = opts.to ? "direct" : "group";
  if (origin === "group") sendCtrl({ type: "botgroup.event", id: g.id, event: { bot: "you", kind: "msg", title: targetLabel(r), text } });
  else {
    const k = bk(g.id, opts.to.id);
    BG_DM[k] = (BG_DM[k] || []).concat([text]).slice(-60);
    lsSet("perch.bg.dm", BG_DM);
  }
  // 群里说话 = 你又在管这个组了：暂停着就恢复派送（定稿里一说话就接着干）
  if (origin === "group" && g.paused) bgRequest({ type: "botgroup.pause", id: g.id, paused: false });
  for (const b of r.targets) {
    const k = bk(g.id, b.id);
    if (!BG_Q.has(k)) BG_Q.set(k, []);
    BG_Q.get(k).push({ text, origin });
  }
  sendCtrl({ type: "log", msg: `Bot Group：${origin === "group" ? "群聊" : "单聊"}发给 ${r.targets.map((b) => b.id).join(",")}（${text.length} 字，${opts.why || ""}）` });
  bgPumpAll();
  return true;
}
// Go 的投递：任务包、交回的结果。送过的 key 记在本机，页面重载后 Go 重推时只补回执、不再粘贴一遍
const SENT_KEY = "perch.bg.sent";
function bgSentKeys() { return lsGet(SENT_KEY, {}) || {}; }
function bgMarkSent(gid, key) {
  const m = bgSentKeys();
  m[gid + "|" + key] = Date.now();
  const ks = Object.keys(m);
  if (ks.length > 400) ks.sort((a, b) => m[a] - m[b]).slice(0, ks.length - 400).forEach((x) => delete m[x]);
  lsSet(SENT_KEY, m);
}
function bgDeliverFromGo(d) {
  if (!d || !d.key || !d.group) return;
  if (bgSentKeys()[d.group + "|" + d.key]) { sendCtrl({ type: "bg.delivered", id: d.group, key: d.key }); return; }
  const k = bk(d.group, d.bot);
  const q = BG_Q.get(k) || [];
  if (q.some((x) => x.key === d.key)) return;
  q.push({ text: d.text, origin: "go", key: d.key });
  BG_Q.set(k, q);
  sendCtrl({ type: "log", msg: `Bot Group：收到投递 ${d.key} → ${k}` });
  bgPumpAll();
}
function bgPumpAll() {
  for (const [k, q] of BG_Q) {
    if (!q.length) { BG_Q.delete(k); continue; }
    const [gid, bid] = k.split("/");
    const g = bgGroup(gid), b = bgBot(g, bid);
    if (!g || !b) { BG_Q.delete(k); continue; }
    const tab = bgTabOf(b);
    if (!tab && !BOOT_SEATED) continue;   // 冷恢复还没把它的格子建出来，别抢着起新会话
    if (!tab || tab.connDown) {
      if (!BG_STARTING.has(k)) bgStartBot(g, b, "有话要送").then((nt) => {
        if (nt) return;
        // 起不来：Go 的投递报回去（它记次数，两次就让任务失败、告诉派活人）
        const rest = (BG_Q.get(k) || []).filter((it) => { if (it.key) sendCtrl({ type: "bg.failed", id: gid, key: it.key, msg: "start failed" }); return !it.key; });
        BG_Q.set(k, rest);
      });
      continue;
    }
    if (!tab.ready || !tab.stream || Date.now() - (tab.bgBorn || 0) < 3000) continue;
    if (botState(b) !== "idle") continue;
    // Claude 的会话在 SessionStart 才有；之前那一屏是信任门 / 登录，粘贴进去会被当成菜单按键
    if (b.agent === "claude" && !tab.sessionID) continue;
    if (tab.bgSentAt && Date.now() - tab.bgSentAt < 1500) continue;
    bgWrite(g, b, tab, q.shift());
  }
}
setInterval(() => { if (BG_Q.size) bgPumpAll(); }, 700);
function bgWrite(g, b, tab, item) {
  const k = bk(g.id, b.id);
  let body = item.text;
  // 改过的岗位说明：捎在这一条前面（不另开一轮）
  if (ROLE_PENDING[k]) {
    body = "[Perch · 你的岗位说明更新了，从这条起按新的来]\n" + ROLE_PENDING[k] + "\n\n" + body;
    delete ROLE_PENDING[k]; lsSet("perch.bg.rolePending", ROLE_PENDING);
  }
  // 接上的旧会话里已经有过开场说明；新会话第一条带上（Go 生成：团队、分工、工作目录、记忆、perch-bg 用法）
  const rk = tab.spec && tab.spec.resume && tab.spec.resume.kind;
  if (!tab.bgIntro && rk && rk !== "new") tab.bgIntro = true;
  if (!tab.bgIntro) {
    tab.bgIntro = true;
    const intro = BG_INTROS[g.id] && BG_INTROS[g.id][b.id];
    if (intro) body = intro + "\n\n" + body;
  }
  const bp = !!(tab.term && tab.term.modes && tab.term.modes.bracketedPasteMode);
  const payload = bp ? "\x1b[200~" + body.replace(/\r?\n/g, "\r") + "\x1b[201~" : body.replace(/\s*\r?\n\s*/g, " ");
  tab.stream.send(enc.encode(payload));
  setTimeout(() => { try { if (tab.stream) tab.stream.send(enc.encode("\r")); } catch (_) {} }, 160);
  tab.bgSentAt = Date.now();
  if (item.key) { bgMarkSent(g.id, item.key); sendCtrl({ type: "bg.delivered", id: g.id, key: item.key }); }
  sendCtrl({ type: "log", msg: `Bot Group：送达 ${k} tab=${tab.id} ${bp ? "bracketed" : "单行"} ${body.length} 字（${item.origin}${item.key ? " " + item.key : ""}）` });
}

/* ---------- 从转录里取：成员详情的逐行、群里那几轮的回答 ---------- */
const PKT_TASK = /^\[Perch · (?:任务|task) (T\d+) · (?:来自|from) ([^\]]+)\]/;
const PKT_RES = /^\[Perch · (T\d+) [^\]]*?· (?:来自|from) ([^\]]+)\]/;
function stripPrompt(s) {
  s = String(s || "");
  for (;;) {
    // 开场说明、岗位说明更新：各占一段，后面空一行才是真正的那句话
    if (/^\[Perch Bot Group/.test(s) || /^\[Perch · 你的岗位说明更新了/.test(s)) { const cut = s.indexOf("\n\n"); s = cut >= 0 ? s.slice(cut + 2) : ""; continue; }
    return s.trim();
  }
}
function groupAsks(g, b) {
  const out = [];
  const me = "@" + roleOf(b);
  for (const e of BG_EVENTS.get(g.id) || []) {
    if (e.bot !== "you" || e.kind !== "msg") continue;
    const to = String(e.title || "").split(/\s+/);
    if (to.includes("@全员") || to.includes(me)) out.push(String(e.text || "").trim());
  }
  return out;
}
const DERIVED = new WeakMap();
function derive(g, b) {
  const tab = bgTabOf(b);
  const v = tab ? LIVE.get(tab.id) : null;
  const acts = (v && v.acts) || [];
  const last = acts[acts.length - 1];
  const asks = groupAsks(g, b), dm = BG_DM[bk(g.id, b.id)] || [];
  const st = botState(b);
  const key = [(v && v.actsGen) | 0, acts.length, last ? last.id + "|" + last.ok + "|" + (last.text || "").length : "", asks.length, dm.length, st, roleOf(b)].join(":");
  const hit = tab && DERIVED.get(tab);
  if (hit && hit.key === key) return hit.out;
  const lines = [], said = [];
  let src = "other", lastText = null;
  const close = () => { if (lastText) said.push({ at: lastText.at, t: lastText.text, src, id: lastText.id }); lastText = null; };
  for (const a of acts) {
    if (a.kind === "prompt") {
      close();
      const txt = stripPrompt(a.text);
      if (!txt) continue;
      const tm = PKT_TASK.exec(txt), rm = !tm && PKT_RES.exec(txt);
      if (tm) { src = "task"; lines.push({ k: "sys", t: `收到任务 ${tm[1]}（来自 ${tm[2]}）：${clamp(txt.split("\n")[1] || "", 80)}` }); continue; }
      if (rm) { src = "result"; lines.push({ k: "sys", t: `${rm[1]} 交回来了（来自 ${rm[2]}）` }); continue; }
      src = dm.includes(txt) ? "dm" : asks.some((q) => q && (txt === q || txt.endsWith(q))) ? "group" : "other";
      lines.push({ k: "me", t: clamp(txt, 300) });
    } else if (a.kind === "tool") {
      if (a.tool === "TodoWrite") continue;
      lines.push({ k: "act", t: clamp(a.text || a.tool || "", 120) });
    } else if (a.kind === "text") {
      // 续接时 Claude 给上一轮补的那句占位话（不是它说的）
      if (!String(a.text || "").trim() || /^No response requested.?$/.test(a.text.trim())) continue;
      lines.push({ k: "say", t: clamp(a.text, 600) });
      lastText = a;
    } else if (a.kind === "compact") lines.push({ k: "sys", t: "上下文压缩了一次" });
  }
  // 这一轮还在干：最后那段话不算定论，先不贴进群
  if (st !== "work") close();
  const out = { lines: lines.slice(-80), said, has: acts.length > 0 };
  if (tab) DERIVED.set(tab, { key, out });
  return out;
}

/* ---------- 建组向导 ---------- */
function newSetup(opts) {
  opts = opts || {};
  const def = defAgent();
  return { stage: "setup", step: 1, sv: 0, err: "", busy: false,
    name: "", goal: "", proj: opts.proj || defProj(), budget: 500,
    manager: def, mgrPersona: personaFor("Manager"), editBot: null,
    bots: [{ role: rolePresets()[0], agent: opts.agent || def, persona: personaFor(rolePresets()[0]) }],
    gid: "", sel: null, adding: false, add: { role: "", agent: def }, edit: false, pdraft: null, draft: "", term: null };
}
function groupValid(s, step) {
  if (step >= 1) {
    if (!s.name.trim()) return "给这个组起个名字";
    if (!s.proj || !isProjPath(s.proj)) return "选一个项目（文件夹）";
  }
  if (step >= 2) {
    if (!s.bots.length) return "至少要有一个 Bot";
    if (s.bots.some((b) => !b.role.trim())) return "每个 Bot 都要有个角色名";
    const seen = new Set();
    for (const b of s.bots) { const r = b.role.trim(); if (seen.has(r) || r === "Manager") return `角色「${r}」重复了`; seen.add(r); }
    const pend = [...new Set([s.manager, ...s.bots.map((b) => b.agent)])].filter((a) => !ag(a).installed);
    if (pend.length) {
      const cant = pend.filter((a) => !ag(a).canInstall);
      if (cant.length) return `${cant.map((a) => ag(a).name).join("、")} 还没装，Perch 也代装不了 —— 换一个 agent`;
      for (const a of pend) installAgent(a);
      return `还在装 ${pend.map((a) => ag(a).name).join("、")}，装好就能开工`;
    }
  }
  return "";
}
const ensureInstalled = (id, z) => { if (!ag(id).installed) installAgent(id, () => { if (z.group) z.group.sv++; render(); }); };
function agentPick(attr, cur, compact) {
  return `<div class="g-ags${compact ? " compact" : ""}">${agentList().map((a) => `<button class="g-ag${a.id === cur ? " on" : ""}${a.installed ? "" : " ni"}" ${attr}="${a.id}" title="${esc(a.name)}${a.installed ? "" : a.canInstall ? "（还没装，选了就在后台下载）" : "（还没装）"}">${agiHTML(a.id)}${compact ? "" : agLabel(a, agShort(a))}</button>`).join("")}</div>`;
}
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
// 表单里的输入落到哪份人设上：s0..= 建组时第几个 Bot，m = 建组时的 Manager，d = 开工后正在改的草稿，a = 中途加 Bot
function personaTarget(el) {
  const box = el.closest("[data-pctx]"), z = box && zoneOfEl(box), s = z && z.group;
  if (!s) return null;
  const c = box.dataset.pctx;
  return c === "d" ? s.pdraft : c === "m" ? s.mgrPersona : c === "a" ? s.add.persona : c[0] === "s" ? (s.bots[+c.slice(1)] || {}).persona : null;
}
// 没在任何一块里开着的组：建组第一步里能直接接回
const openGids = () => new Set(Z.filter((z) => z.kind === "group" && z.group.gid).map((z) => z.group.gid));
function groupSetupHTML(z) {
  const s = z.group, st = s.step;
  const steps = ["目标与项目", "成员", "开工"].map((t, i) => `<span class="${i + 1 === st ? "on" : i + 1 < st ? "done" : ""}"><em>${i + 1 < st ? "✓" : i + 1}</em>${t}</span>`).join("<i></i>");
  let body = "";
  if (st === 1) {
    const ps = PROJECTS();
    const back = BOTGROUPS.filter((g) => !openGids().has(g.id));
    body = (back.length ? `<div class="pk-back gs-back"><span>接着上次的组：</span>${back.map((g) => `<button data-greopen="${g.id}" title="${esc(g.project)}">${ICON("users-round", 13)}${esc(g.name)}<em>${(g.bots || []).length} 个成员</em></button>`).join("")}</div>` : "")
      + `<label class="gl">名字</label><input class="inp" data-gf="name" value="${esc(s.name)}" placeholder="比如：官网改版小队" spellcheck="false" autocomplete="off">`
      + `<label class="gl">目标 <em>Manager 会照这个拆活</em></label><textarea class="inp gs-ta" data-gf="goal" placeholder="这个组要做成什么？" spellcheck="false">${esc(s.goal)}</textarea>`
      + `<label class="gl">在哪个项目里干</label><div class="pk-p gs-pj">${ps.map((x) => `<button data-gproj="${esc(x.path)}" class="${normPath(x.path) === normPath(s.proj) ? "on" : ""}" title="${esc(x.path)}">${esc(x.name)}</button>`).join("")}<button class="add" data-gprojadd>+ 文件夹</button></div>`
      + (isProjPath(s.proj) ? `<div class="gs-path">${esc(s.proj)}</div>` : "")
      + `<label class="gl">预算上限 <em>花到了会先停下问你</em></label><div class="seg">${BUDGETS.map(([v, t]) => `<button data-gbud="${v}" class="${s.budget === v ? "on" : ""}">${t}${v > 0 ? " tokens" : ""}</button>`).join("")}</div>`;
  } else if (st === 2) {
    body = `<label class="gl">Manager <em>负责拆活、派活、汇总，有事找你拍板</em><button class="gb-pe${s.editBot === "m" ? " on" : ""}" data-gbedit="m">${ICON("id-card", 13)}人设与岗位</button></label>${agentPick("data-gmgr", s.manager)}`
      + (s.editBot === "m" ? `<div class="gb-pf">${personaFormHTML(s.mgrPersona, "m")}</div>` : "")
      + `<label class="gl">Bot（${s.bots.length} / ${BG_MAX}）<em>一个角色配一个 agent；「人设」里写清它具体干什么</em></label>`
      + s.bots.map((b, i) => `<div class="gb-row" style="--c:${ROLE_COLORS[i % ROLE_COLORS.length]}"><i class="gb-dot"></i>`
        + `<input class="inp" data-gbrole="${i}" value="${esc(b.role)}" placeholder="角色，比如 开发" spellcheck="false" autocomplete="off">`
        + agentPick(`data-gbag="${i}" data-gba`, b.agent, true)
        + `<button class="gb-pe${s.editBot === i ? " on" : ""}" data-gbedit="${i}" title="人设与岗位">${ICON("id-card", 13)}人设</button>`
        + `<button class="gb-x" data-gbdel="${i}" title="去掉这个 Bot">${ICON("x", 13)}</button></div>`
        + (s.editBot === i ? `<div class="gb-pf">${personaFormHTML(b.persona, "s" + i)}</div>` : "")).join("")
      + `<div class="gb-pre">${rolePresets().filter((r) => !s.bots.some((b) => b.role.trim() === r)).map((r) => `<button data-gbpre="${r}">+ ${r}</button>`).join("")}`
      + PERSONA_TPL.map((t, i) => `<button data-gbtpl="${i}" class="tpl">+ ${esc(t.name)}</button>`).join("")
      + `<button data-gbpre="">+ 自定义</button></div>`;
  } else {
    body = `<div class="gs-sum"><div class="gs-sum-h"><b>${esc(s.name)}</b><span>${esc(projName(s.proj))} · ${esc(s.proj)}</span></div>`
      + (s.goal.trim() ? `<p>${esc(s.goal)}</p>` : `<p class="dim">（没写目标：开工后直接在群里跟 Manager 说）</p>`)
      + `<div class="gs-mem"><span class="gm-c">${logo(s.manager)}Manager · ${esc(ag(s.manager).name)}</span>`
      + s.bots.map((b, i) => `<span class="gm-c" style="--c:${ROLE_COLORS[i % ROLE_COLORS.length]}"><i class="gb-dot"></i>${logo(b.agent)}${esc(b.role)} · ${esc(ag(b.agent).name)}</span>`).join("") + `</div>`
      + `<div class="gs-note">开工后：项目是 git 仓库的话，Perch 在 ${esc(projName(s.proj))} 里给每个 Bot 各开一个工作副本（git worktree），互不踩脚；Manager 先拆活派活，Bot 之间交接、交回都由 Perch 转达；要你拍板的事会在群里问你，Dock 的铃铛也会亮。预算 ${s.budget > 0 ? s.budget + "k tokens" : "不限"}。</div></div>`;
  }
  const err = s.err ? `<span class="gs-err">${esc(s.err)}</span>` : `<span></span>`;
  const foot = `${err}<span class="sp"></span>${st > 1 ? `<button class="btn" data-gprev>上一步</button>` : ""}`
    + (st < 3 ? `<button class="btn pri" data-gnext>下一步</button>` : `<button class="btn pri${s.busy ? " na" : ""}" data-gstart>${ICON("sparkles", 14)}${s.busy ? "正在开工…" : "开工"}</button>`);
  return `<div class="gs"><div class="gs-steps">${steps}</div><div class="gs-body">${body}</div><div class="gs-foot">${foot}</div></div>`;
}
async function startGroup(z) {
  const s = z.group;
  if (s.busy) return;
  const err = groupValid(s, 2);
  if (err) { s.err = err; s.sv++; render(); return; }
  s.busy = true; s.err = ""; s.sv++; render();
  const r = await bgRequest({ type: "botgroup.create", botgroup: {
    name: s.name.trim(), goal: s.goal.trim(), project: s.proj, managerAgent: s.manager, budget: s.budget,
    managerInstructions: personaText(s.mgrPersona),
    bots: s.bots.map((b) => ({ role: b.role.trim(), agent: b.agent, instructions: personaText(b.persona) })) } });
  s.busy = false;
  if (!r.ok || !r.group) { s.err = r.err || "没建成，再试一次"; s.sv++; render(); return; }
  const g = r.group;
  if (!bgGroup(g.id)) { BOTGROUPS.push(g); BG_EVENTS.set(g.id, []); }
  savePersona(g.id, "manager", s.mgrPersona);
  bgLanes(g).forEach((b, i) => { if (s.bots[i]) savePersona(g.id, b.id, s.bots[i].persona); });
  Object.assign(s, { stage: "run", gid: g.id, sel: null, edit: false, pdraft: null, adding: false, editBot: null });
  s.sv++; render(); saveLayout();
  // 写了目标：先交给 Manager（群里记一句，它的回答会回到群里）
  if (g.goal) bgSend(g, "目标：" + g.goal, { why: "开工" });
  // 逐个起格（同时发一串 tab.new 会互相顶，见 ctl-stream-must-not-block-on-reload）
  for (const b of g.bots || []) await bgStartBot(g, b, "开工");
  sendCtrl({ type: "log", msg: `Bot Group：开工 ${g.id}「${g.name}」${(g.bots || []).length} 个成员 worktree=${!!g.worktrees}` });
}

/* ---------- 开工以后 ---------- */
function runSkeleton(z, g) {
  const s = z.group;
  const add = s.adding ? `<div class="g-add"><b>加一个 Bot</b><div class="gb-pre">${rolePresets().filter((r) => !(g.bots || []).some((b) => b.role === r)).map((r) => `<button data-gaddpre="${r}" class="${s.add.role === r ? "on" : ""}">${r}</button>`).join("")}`
    + PERSONA_TPL.map((t, i) => `<button data-gaddtpl="${i}" class="tpl">${esc(t.name)}</button>`).join("") + `</div>`
    + `<input class="inp" data-gaddrole value="${esc(s.add.role)}" placeholder="角色名" spellcheck="false" autocomplete="off">${agentPick("data-gaddag", s.add.agent, true)}`
    + `<div class="g-add-f">${s.err ? `<span class="gs-err">${esc(s.err)}</span>` : ""}<span class="sp"></span><button class="btn" data-gaddcancel>取消</button><button class="btn pri${s.busy ? " na" : ""}" data-gaddok>${s.busy ? "正在加…" : "加进来"}</button></div></div>` : "";
  const m = s.sel && bgBot(g, s.sel);
  const drawer = !m ? "" : s.edit
    ? `<div class="g-drawer"><div class="gd-h2">${logo(m.agent)}<b>${esc(roleOf(m))} 的人设与岗位</b><span class="sp"></span><button class="gd-x" data-gpecancel title="不改了">${ICON("x", 13)}</button></div>`
      + `<div class="gd-pf">${personaFormHTML(s.pdraft, "d", m.manager ? undefined : s.pdraft.title)}</div>`
      + `<div class="gd-f"><span class="pf-note">保存后写进它的岗位说明，下一轮起按新的来，不用重启</span><span class="sp"></span><button class="btn" data-gpetpl>存成模板</button><button class="btn pri" data-gpesave>保存</button></div></div>`
    : `<div class="g-drawer"><div class="gd-h"></div><div class="gd-duty"></div>`
      + (s.term === m.id ? `<div class="tterm gd-term"></div>` : `<div class="tb gd-lines"></div>`)
      + `<div class="ti gd-ti"><input class="g-in gd-in" data-gdin placeholder="单聊 ${esc(roleOf(m))}：只有它看得到" spellcheck="false" autocomplete="off"><button data-gpsend title="发送">${ICON("arrow-up", 13, 2)}</button></div>`
      + `<div class="gd-f"><button class="btn" data-gpedit>${ICON("id-card", 13)}人设与岗位</button><button class="btn${s.term === m.id ? " on" : ""}" data-gterm="${m.id}">${ICON("square-terminal", 13)}${s.term === m.id ? "回到记录" : "终端"}</button><span class="sp"></span>${m.manager ? "" : `<button class="btn" data-gkick>${ICON("trash-2", 13)}移出群</button>`}</div></div>`;
  return `<div class="grp"><div class="g-top"></div><div class="g-mem"></div>${add}`
    + `<div class="g-main${m ? " has-d" : ""}"><div class="g-feed"></div>${drawer}</div>`
    + `<div class="ti g-ti"><input class="g-in" data-gin placeholder="在群里说… 用 @角色 点名某个 Bot，@全员 发给所有人" value="${esc(s.draft || "")}" spellcheck="false" autocomplete="off"><button data-gsend title="发送">${ICON("arrow-up", 13, 2)}</button></div></div>`;
}
const budgetOf = (g) => g.budget === 0 || g.budget == null ? 500 : g.budget;
// 群里这一条是谁说的：成员的头像 + 角色 + agent 名
function memberMsg(g, b, inner, cls) {
  if (!b) return `<div class="gmsg sys${cls || ""}">${inner}</div>`;
  return `<div class="gmsg${cls || ""}" style="--c:${bgColor(g, b)}">${logo(b.agent)}<div><b>${esc(roleOf(b))}<em>${esc(ag(b.agent).name)}</em></b>${inner}</div></div>`;
}
/* 群里的一条条：按时间排。每条带 key（新来的那条有入场动画）。 */
function feedItems(g) {
  const out = [];
  const created = Date.parse(g.createdAt || "") || 0;
  const seenStart = new Set();
  for (const e of BG_EVENTS.get(g.id) || []) {
    const at = Date.parse(e.ts || "") || 0, key = "e" + e.id, b = bgBot(g, e.bot);
    const txt = esc(clamp(e.text || "", 400));
    if (e.kind === "msg" && e.bot === "you") out.push({ at, key, html: `<div class="gmsg you"><div><b>你</b>${esc(e.text || "")}</div></div>` });
    else if (e.kind === "created") out.push({ at, key, html: `<div class="gmsg sys">${g.worktrees ? `Perch 在 ${esc(projName(g.project))} 里给每个 Bot 各开了一个工作副本（git worktree），互不踩脚` : `建好了：${esc(g.name)}（${esc(projName(g.project))} 不是 git 仓库，成员们在同一个文件夹里干活）`}</div>` });
    else if (e.kind === "started") {
      // 中途加进来的才说一句（开工那一批不刷屏）
      if (!b || seenStart.has(b.id)) continue;
      seenStart.add(b.id);
      if ((Date.parse(b.createdAt || "") || 0) - created < 60000) continue;
      out.push({ at, key, html: `<div class="gmsg sys">${esc(roleOf(b))}（${esc(ag(b.agent).name)}）加入了群${b.worktree ? ` —— 也在 ${esc(projName(g.project))} 里有了自己的工作副本` : ""}</div>` });
    } else if (e.kind === "handoff" || e.kind === "return" || e.kind === "review") {
      out.push({ at, key, html: memberMsg(g, b, `<span class="gtag">${esc(e.title)}</span>${txt}`) });
    } else if (e.kind === "paused") out.push({ at, key, html: `<div class="gmsg sys">你把全组暂停了：手上这一步做完就停，新派的活先排着</div>` });
    else if (e.kind === "resumed") out.push({ at, key, html: `<div class="gmsg sys">${esc(e.title === "恢复派送" ? "继续干活" : e.title)}</div>` });
    else if (e.kind === "blocked" || e.kind === "fail") out.push({ at, key, html: `<div class="gmsg sys warn">${esc(bgRole(g, e.bot))} · ${esc(e.title)}${e.text ? "：" + txt : ""}</div>` });
    else if (e.kind === "memory") out.push({ at, key, html: `<div class="gmsg sys">${esc(bgRole(g, e.bot))} 记了一笔共享记忆：${txt}</div>` });
    else if (e.kind === "stopped" || e.kind === "note") out.push({ at, key, html: `<div class="gmsg sys">${esc(e.title)}</div>` });
  }
  for (const b of g.bots || []) {
    for (const x of derive(g, b).said) {
      // Manager 是对你汇报的那个：群里的、交回给它之后的话都贴；别的成员只贴回答群里那几轮的
      if (!(x.src === "group" || (b.manager && x.src === "result"))) continue;
      out.push({ at: Date.parse(x.at || "") || 0, key: "s" + b.id + x.id, html: memberMsg(g, b, esc(clamp(x.t, 1200))) });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-160).concat(askCards(g));
}
// 等你拍板：成员停在批准 / 提问 / 启动门上；任务被守卫拦下
function askCards(g) {
  const out = [];
  const rows = new Map(needModel().rows.map((r) => [r.t, r]));
  for (const b of g.bots || []) {
    if (botState(b) !== "wait") continue;
    const tab = bgTabOf(b);
    const gate = BG_GATES.get(tab.id) || "";
    const r = rows.get(tab);
    const id = `data-gbot="${b.id}"`;
    let why, btns;
    if (gate === "trust") { why = `${ag(b.agent).name} 问：信任这个文件夹吗？（${esc((tab.spec && tab.spec.cwd) || g.project)}）`; btns = `<button class="y" data-ggate="trust" ${id}>信任</button><button data-gterm="${b.id}">去终端</button>`; }
    else if (gate === "bypass") { why = `${ag(b.agent).name} 要你确认「完全访问」`; btns = `<button class="y" data-ggate="accept" ${id}>接受</button><button data-gterm="${b.id}">去终端</button>`; }
    else if (gate === "login") { why = `${ag(b.agent).name} 要先登录`; btns = `<button class="y" data-gterm="${b.id}">去登录</button>`; }
    else {
      why = esc((r && (r.text || needWhy(r.kind))) || "在等你");
      // 只有一个单选题：选项直接点（提问选择器里数字键直选、不用回车 —— claude-code-ask-picker-keys）
      const pa = pendingAsk(LIVE.get(tab.id));
      const q = pa && Array.isArray(pa.qs) && pa.qs.length === 1 && !pa.qs[0].multi ? pa.qs[0] : null;
      if (q && Array.isArray(q.opts) && q.opts.length && q.opts.length <= 4) {
        out.push({ key: "w" + b.id, html: memberMsg(g, b, `${esc(q.q || why)}<div class="ask"><span>等你拍板</span>${q.opts.map((o, i) => `<button${i ? "" : ` class="y"`} data-gpick="${i + 1}" ${id} title="${esc(o.desc || "")}">${esc(o.label)}</button>`).join("")}<button data-gterm="${b.id}">去终端</button></div>`, " asking") });
        continue;
      }
      const yes = menuMoves(tab, PERM_YES) !== null && menuMoves(tab, PERM_NO) !== null;
      btns = (yes ? `<button class="y" data-ggate="yes" ${id}>允许</button><button data-ggate="no" ${id}>先别</button>` : "") + `<button${yes ? "" : ` class="y"`} data-gterm="${b.id}">去终端</button>`;
    }
    out.push({ key: "w" + b.id, html: memberMsg(g, b, `${why}<div class="ask"><span>等你拍板</span>${btns}</div>`, " asking") });
  }
  for (const t of BG_TASKS.get(g.id) || []) {
    if (t.status !== "blocked") continue;
    const ev = (BG_EVENTS.get(g.id) || []).filter((e) => e.kind === "blocked" && String(e.title).includes(t.id)).pop();
    out.push({ key: "t" + t.id, html: memberMsg(g, bgBot(g, t.from), `想把 ${esc(t.id)} 交给 ${esc(bgRole(g, t.to))}，被拦下了${ev && ev.text ? "：" + esc(ev.text) : ""}<div class="ask"><span>等你拍板</span><button class="y" data-gtask="${esc(t.id)}" data-gans="allow">放行</button><button data-gtask="${esc(t.id)}" data-gans="cancel">取消这件</button></div>`, " asking") });
  }
  return out;
}
function botModel(g, b) {
  const m = BG_MODEL[bk(g.id, b.id)];
  if (m) return m;
  return b.boot || agentDefaultModel(b.agent);
}
function renderRun(z, zb) {
  const s = z.group, g = bgGroup(s.gid);
  if (!g) {
    if (zb._sk !== "wait") { zb._sk = "wait"; zb.innerHTML = `<div class="gs"><div class="gs-body"><p class="dim">${BG_LOADED ? "这个组已经不在了。" : "正在读这个组…"}</p></div></div>`; }
    if (BG_LOADED) { Object.assign(z.group, newSetup({ proj: s.proj })); z.group.sv++; }
    return;
  }
  if (s.sel && !bgBot(g, s.sel)) { s.sel = null; s.edit = false; s.term = null; }
  const sk = "run:" + s.sv + ":" + (s.sel || "") + ":" + (s.adding ? 1 : 0) + ":" + (s.edit ? 1 : 0) + ":" + (s.term || "");
  if (zb._sk !== sk) {
    parkBotTerm(zb);
    zb._sk = sk; zb._top = zb._mem = zb._feed = zb._dh = zb._dl = "";
    zb.innerHTML = runSkeleton(z, g);
    const f = qs(".g-feed", zb);
    f.addEventListener("scroll", () => { z.gpin = f.scrollHeight - f.scrollTop - f.clientHeight < 24; }, { passive: true });
    if (s.adding) setTimeout(() => { const i = qs("[data-gaddrole]", zb); if (i && !s.add.role) i.focus(); }, 30);
    mountBotTerm(z, g, zb);
  }
  const lanes = bgLanes(g), used = BG_USEDK[g.id] || 0, cap = budgetOf(g);
  const pct = cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;
  const top = `<div class="g-goal"><span>目标</span>${esc(g.goal || "（还没写 —— 在群里跟 Manager 说）")}</div><span class="sp"></span>`
    + `<span class="g-bud${cap > 0 && used >= cap ? " over" : ""}" title="已经花掉的 / 预算上限（各成员这一组里的 token 合计）"><i style="width:${pct}%"></i><em>${used}k / ${cap > 0 ? cap + "k" : "不限"}</em></span>`
    + `<button class="btn" data-gpause>${g.paused ? "继续" : "全部暂停"}</button>`;
  if (zb._top !== top) { zb._top = top; qs(".g-top", zb).innerHTML = top; }
  const mem = (g.bots || []).map((b) => { const st = botState(b); return `<button class="gm-c ${DOT_OF[st]}${s.sel === b.id ? " on" : ""}" data-gmem="${b.id}" style="--c:${bgColor(g, b)}" title="${esc(ST_TXT[st])}">${b.manager ? "" : `<i class="gb-dot"></i>`}${logo(b.agent)}${esc(roleOf(b))}<i class="dot ${DOT_OF[st]}"></i></button>`; }).join("")
    + (lanes.length < BG_MAX ? `<button class="gm-c add" data-gadd>${ICON("plus", 12, 2.2)}加 Bot</button>` : "");
  if (zb._mem !== mem) { zb._mem = mem; qs(".g-mem", zb).innerHTML = mem; }
  const items = feedItems(g);
  const fk = items.map((x) => x.key + (x.html.length)).join("|");
  if (zb._feed !== fk) {
    const f = qs(".g-feed", zb), st = f.scrollTop, pinned = z.gpin !== false;
    const seen = zb._seen || (zb._seen = new Set());
    const first = !zb._feed;
    f.innerHTML = items.length ? items.map((x) => { const fresh = !first && !seen.has(x.key); seen.add(x.key); return fresh ? x.html.replace(/^<div class="gmsg/, '<div class="gmsg new') : x.html; }).join("")
      : `<div class="gmsg sys">群里还没有人说话。直接说一句交给 Manager，或者 @某个 Bot</div>`;
    zb._feed = fk;
    f.scrollTop = pinned ? f.scrollHeight : st;
  }
  const m = s.sel && bgBot(g, s.sel);
  if (m && !s.edit) {
    const st = botState(m), cur = botModel(g, m);
    const pend = m.pendModel;
    const md = (PROV.protocols[m.agent] || []).length ? `<button class="md${pend ? " pend" : ""}" data-gmodel title="换模型：不用重启">${esc(pend ? "→ " + modelLabel(pend.provider, pend.model) : modelLabel(cur.provider, cur.model))}</button>` : "";
    const dh = `${logo(m.agent)}<b>${esc(roleOf(m))}</b><span class="dim">${esc(ag(m.agent).name)}${m.branch ? " · " + esc(m.branch) : ""}</span><span class="sp"></span>${md}<i class="dot ${DOT_OF[st]}" title="${esc(ST_TXT[st])}"></i><button class="gd-x" data-gdclose title="收起">${ICON("x", 13)}</button>`;
    if (zb._dh !== dh) { zb._dh = dh; const el = qs(".gd-h", zb); if (el) el.innerHTML = dh; const p = personaOf(g, m); const du = qs(".gd-duty", zb); if (du) du.innerHTML = p.duty ? `<span>职责</span>${esc(p.duty)}` : `<span>职责</span>还没写 —— 点下面「人设与岗位」写清楚它干什么`; }
    const L = qs(".gd-lines", zb);
    if (L) {
      const d = derive(g, m);
      const lines = d.lines.length ? d.lines : [{ k: "sys", t: bgTabOf(m) ? "还没开始干活" : "还没起来 —— 给它发句话，它就上线" }];
      const lk = lines.length + ":" + (lines[lines.length - 1] || {}).t;
      if (zb._dl !== lk) {
        const lp = L.scrollHeight - L.scrollTop - L.clientHeight < 12 || !zb._dl, lst = L.scrollTop;
        zb._dl = lk;
        L.innerHTML = lines.map((x) => `<div class="ln ${x.k}">${esc(x.t)}</div>`).join("");
        L.scrollTop = lp ? L.scrollHeight : lst;
      }
    }
  }
}
// 成员详情里的「终端」：把那一格的 .cell 从 #termpark 搬进抽屉；抽屉换掉 / 收起时搬回去
function mountBotTerm(z, g, zb) {
  const s = z.group;
  const host = qs(".gd-term", zb);
  if (!host || !s.term) return;
  const b = bgBot(g, s.term), tab = b && bgTabOf(b);
  if (!tab) { host.innerHTML = `<div class="gd-none">它还没起来。给它发句话、或者点下面「终端」再试一次</div>`; if (b) bgStartBot(g, b, "打开终端").then(() => { s.sv++; render(); }); return; }
  host.appendChild(tab.cellEl);
  zb._term = tab;
  requestAnimationFrame(() => { try { tab.refit(); tab.focus(); } catch (_) {} });
  if (typeof ackNote === "function") ackNote(tab, "打开 Bot 终端");
}
function parkBotTerm(zb) {
  const tab = zb._term;
  zb._term = null;
  if (!tab || !tab.cellEl) return;
  const park = qs("#termpark");
  if (park && tab.cellEl.parentNode !== park) { park.appendChild(tab.cellEl); requestAnimationFrame(() => { try { tab.refit(); } catch (_) {} }); }
}

/* ---------- 成员详情里的动作 ---------- */
function setBotModel(z, g, b, provider, model) {
  const k = bk(g.id, b.id), cur = botModel(g, b);
  if ((cur.provider || "own") === (provider || "own") && (cur.model || "") === (model || "")) { b.pendModel = null; z.group.sv++; render(); return; }
  const tab = bgTabOf(b);
  if (!tab || !tab.paneID) { BG_MODEL[k] = { provider, model }; lsSet("perch.bg.model", BG_MODEL); toast(`${roleOf(b)} 起来以后用 ${modelLabel(provider, model)}`); deskSoon(); return; }
  if (botState(b) === "work") { b.pendModel = { provider, model }; toast(`${roleOf(b)} 下一轮起用 ${modelLabel(provider, model)} —— 不用重启`); deskSoon(); return; }
  b.pendModel = null;
  const req = ++MODEL_REQ;
  modelWait.set(req, { onDone(m) {
    if (m.err) { toast(`换不了：${m.err}`, "warn"); deskSoon(); return; }
    BG_MODEL[k] = { provider, model }; lsSet("perch.bg.model", BG_MODEL);
    if (m.mode === "relay") toast(`${roleOf(b)} 换成 ${modelLabel(provider, model)} —— 不用重启，下一句话就用它`);
    else { bgStartBot(g, b, "换模型（接着原来的对话重开）", true); toast(`${roleOf(b)} 换成 ${modelLabel(provider, model)} —— 接着原来的对话重开了一下`); }
    deskSoon();
  } });
  sendCtrl({ type: "pane.model", req, pane: tab.paneID, agentId: b.agent, providerId: provider, model });
}
// 干活中换的模型：这一轮做完再换
AFTER_RENDER.push(() => {
  for (const z of Z) {
    if (z.kind !== "group" || !z.group.gid) continue;
    const g = bgGroup(z.group.gid);
    for (const b of (g && g.bots) || []) if (b.pendModel && botState(b) !== "work") { const p = b.pendModel; setBotModel(z, g, b, p.provider, p.model); }
  }
});
async function addBotToGroup(z) {
  const s = z.group, g = bgGroup(s.gid), role = s.add.role.trim();
  if (!g || s.busy) return;
  const fail = (t) => { s.err = t; s.sv++; render(); };
  if (!role) return fail("给新 Bot 起个角色名");
  if (role === "Manager" || (g.bots || []).some((b) => b.role === role)) return fail(`已经有「${role}」了`);
  if (bgLanes(g).length >= BG_MAX) return fail(`一个组最多 ${BG_MAX} 个 Bot`);
  if (!ag(s.add.agent).installed) { ensureInstalled(s.add.agent, z); return fail(`还在装 ${ag(s.add.agent).name}，装好再加`); }
  const tpl = s.add.persona || PERSONA_TPL.find((x) => x.role === role) && clonePersona(PERSONA_TPL.find((x) => x.role === role).persona);
  const persona = tpl || personaFor(role);
  s.busy = true; s.err = ""; s.sv++; render();
  const r = await bgRequest({ type: "botgroup.addbot", id: g.id, botgroup: { bots: [{ role, agent: s.add.agent, instructions: personaText(persona) }] } });
  s.busy = false;
  if (!r.ok || !r.bot) return fail(r.err || "没加上，再试一次");
  if (!bgBot(g, r.bot.id)) g.bots.push(r.bot);
  savePersona(g.id, r.bot.id, persona);
  s.adding = false; s.add = { role: "", agent: defAgent() }; s.sv++; render();
  await bgStartBot(g, bgBot(g, r.bot.id), "加 Bot");
}
function savePersonaDraft(z) {
  const s = z.group, g = bgGroup(s.gid), m = g && bgBot(g, s.sel);
  if (!m) return;
  const p = clonePersona(s.pdraft), title = String(p.title || "").trim();
  delete p.title;
  const patch = { instructions: personaText(p) };
  if (!m.manager && title && title !== m.role) {
    if (title === "Manager" || (g.bots || []).some((x) => x !== m && x.role === title)) { toast(`已经有「${title}」了`, "warn"); return; }
    patch.role = title;
  }
  bgRequest({ type: "botgroup.updatebot", id: g.id, botId: m.id, botPatch: patch }).then((r) => {
    if (!r.ok) { toast("没存上：" + (r.err || ""), "warn"); return; }
    if (r.bot) Object.assign(m, r.bot);
    savePersona(g.id, m.id, p);
    const tab = bgTabOf(m);
    // 已经收过开场说明的：改过的岗位说明捎在下一条前面；还没收过的，开场说明里就是新的
    if (tab && tab.bgIntro) { ROLE_PENDING[bk(g.id, m.id)] = patch.instructions; lsSet("perch.bg.rolePending", ROLE_PENDING); }
    s.edit = false; s.pdraft = null; s.sv++; render();
    sendCtrl({ type: "botgroup.event", id: g.id, event: { bot: "you", kind: "note", title: `你更新了「${roleOf(m)}」的人设与岗位 —— 下一轮起按新的来（不用重启）` } });
    toast(`「${roleOf(m)}」的人设与岗位已保存 —— 下一轮起按新的来（不用重启）`);
  });
}
function kickBot(z) {
  const s = z.group, g = bgGroup(s.gid), m = g && bgBot(g, s.sel);
  if (!m || m.manager) return;
  deskConfirm(`把「${m.role}」移出群？`, "它停下来；手上的改动留在它的工作副本里，不会丢。之后可以再加一个回来。", "移出").then((ok) => {
    if (!ok) return;
    const tab = bgTabOf(m);
    bgRequest({ type: "botgroup.removebot", id: g.id, botId: m.id }).then((r) => {
      if (!r.ok) { toast("没移出：" + (r.err || ""), "warn"); return; }
      if (tab) closeTab(tab, { close: true, why: "移出 Bot Group" });
      g.bots = (g.bots || []).filter((x) => x !== m);
      BG_Q.delete(bk(g.id, m.id));
      sendCtrl({ type: "botgroup.event", id: g.id, event: { bot: m.id, kind: "note", title: `${m.role} 离开了群` } });
      s.sel = null; s.term = null; s.sv++; render();
    });
  });
}
function answerGate(g, b, how) {
  const tab = bgTabOf(b);
  if (!tab || !tab.stream) return;
  let moves = null;
  if (how === "trust") moves = menuMoves(tab, /Yes, I trust|Yes, proceed|^\s*[❯>›]?\s*(1\.\s*)?Trust\b/i);
  else if (how === "accept") { moves = menuMoves(tab, /Yes, I accept/i); if (moves === null) moves = 1; }
  else if (how === "yes") moves = menuMoves(tab, PERM_YES);
  else if (how === "no") moves = menuMoves(tab, PERM_NO);
  if (moves === null) { toast("屏上的选项对不上了 —— 去终端里自己点一下", "warn"); return; }
  sendCtrl({ type: "log", msg: `Bot Group：替你回答 ${how} ${g.id}/${b.id} tab=${tab.id} 挪 ${moves} 行再回车` });
  pressMenu(tab, moves);
}

/* ---------- 点击 ---------- */
function groupClick(z, t) {
  const s = z.group;
  const b = t.closest("button,[data-gmem]");
  if (!b) return false;
  const d = b.dataset;
  const re = () => { s.sv++; render(); return true; };
  if (d.gba !== undefined) { s.bots[+d.gbag].agent = d.gba; ensureInstalled(d.gba, z); return re(); }
  // 建组向导
  if (d.greopen) { Object.assign(s, { stage: "run", gid: d.greopen, sel: null, adding: false, edit: false, term: null }); saveLayout(); return re(); }
  if (d.gproj) { s.proj = d.gproj; s.err = ""; return re(); }
  if (b.hasAttribute("data-gprojadd")) { PENDING_GROUP = z; openPP("add"); return true; }
  if (d.gbud !== undefined) { s.budget = +d.gbud; return re(); }
  if (d.gmgr) { s.manager = d.gmgr; ensureInstalled(d.gmgr, z); return re(); }
  if (d.gbdel !== undefined) { s.bots.splice(+d.gbdel, 1); if (s.editBot === +d.gbdel) s.editBot = null; return re(); }
  if (d.gbpre !== undefined) {
    if (s.bots.length >= BG_MAX) { s.err = `一个组最多 ${BG_MAX} 个 Bot`; return re(); }
    s.bots.push({ role: d.gbpre, agent: defAgent(), persona: personaFor(d.gbpre) }); s.err = ""; re();
    if (!d.gbpre) setTimeout(() => { const ins = qsa("[data-gbrole]", ZEL.get(z.id)); if (ins.length) ins[ins.length - 1].focus(); }, 30);
    return true;
  }
  if (d.gbtpl !== undefined) {
    const tp = PERSONA_TPL[+d.gbtpl];
    if (s.bots.length >= BG_MAX) { s.err = `一个组最多 ${BG_MAX} 个 Bot`; return re(); }
    if (tp) s.bots.push({ role: tp.role, agent: defAgent(), persona: clonePersona(tp.persona) });
    return re();
  }
  if (d.gbedit !== undefined) { const k = d.gbedit === "m" ? "m" : +d.gbedit; s.editBot = s.editBot === k ? null : k; return re(); }
  if (b.hasAttribute("data-gnext")) {
    const err = groupValid(s, s.step); if (err) { s.err = err; return re(); }
    s.err = ""; s.step++;
    if (s.step === 3) sendCtrl({ type: "log", msg: `Bot Group：建组第三步 ${s.proj}` });
    return re();
  }
  if (b.hasAttribute("data-gprev")) { s.err = ""; s.step--; return re(); }
  if (b.hasAttribute("data-gstart")) { startGroup(z); return true; }
  // 开工以后
  const g = bgGroup(s.gid);
  if (!g) return false;
  if (d.gans && d.gtask) { bgRequest({ type: "bg.answer", id: g.id, task: d.gtask, action: d.gans }).then((r) => { if (!r.ok) toast(r.err || "没成", "warn"); }); return true; }
  if (d.ggate) { const m = bgBot(g, d.gbot); if (m) answerGate(g, m, d.ggate); return true; }
  if (d.gpick) {
    const m = bgBot(g, d.gbot), tab = m && bgTabOf(m);
    if (tab && tab.stream) { tab.stream.send(enc.encode(d.gpick)); sendCtrl({ type: "log", msg: `Bot Group：替你选了第 ${d.gpick} 项 ${g.id}/${m.id}` }); }
    return true;
  }
  if (d.gterm) {
    if (s.sel === d.gterm && s.term === d.gterm) s.term = null;
    else { s.sel = d.gterm; s.term = d.gterm; s.edit = false; s.adding = false; }
    return re();
  }
  if (d.gmem) { s.sel = s.sel === d.gmem ? null : d.gmem; s.adding = false; s.edit = false; s.term = null; return re(); }
  if (b.hasAttribute("data-gdclose")) { s.sel = null; s.term = null; return re(); }
  if (b.hasAttribute("data-gadd")) { s.adding = !s.adding; s.err = ""; s.add = { role: "", agent: defAgent() }; return re(); }
  if (d.gaddpre) { s.add.role = d.gaddpre; s.add.persona = null; const i = qs("[data-gaddrole]", ZEL.get(z.id)); if (i) i.value = d.gaddpre; for (const x of qsa("[data-gaddpre],[data-gaddtpl]", ZEL.get(z.id))) x.classList.toggle("on", x === b); return true; }
  if (d.gaddtpl !== undefined) { const tp = PERSONA_TPL[+d.gaddtpl]; if (tp) { s.add.role = tp.role; s.add.persona = clonePersona(tp.persona); const i = qs("[data-gaddrole]", ZEL.get(z.id)); if (i) i.value = tp.role; for (const x of qsa("[data-gaddpre],[data-gaddtpl]", ZEL.get(z.id))) x.classList.toggle("on", x === b); } return true; }
  if (d.gaddag) { s.add.agent = d.gaddag; ensureInstalled(d.gaddag, z); for (const x of qsa("[data-gaddag]", ZEL.get(z.id))) x.classList.toggle("on", x === b); return true; }
  if (b.hasAttribute("data-gaddcancel")) { s.adding = false; s.err = ""; return re(); }
  if (b.hasAttribute("data-gaddok")) { addBotToGroup(z); return true; }
  if (b.hasAttribute("data-gsend")) { const i = qs("[data-gin]", ZEL.get(z.id)); if (i && bgSend(g, i.value, { why: "发送键" })) { i.value = ""; s.draft = ""; z.gpin = true; } return true; }
  if (b.hasAttribute("data-gpsend")) { const i = qs("[data-gdin]", ZEL.get(z.id)), m = bgBot(g, s.sel); if (i && m && bgSend(g, i.value, { to: m, why: "单聊" })) i.value = ""; return true; }
  if (b.hasAttribute("data-gpause")) { bgRequest({ type: "botgroup.pause", id: g.id, paused: !g.paused }).then((r) => { if (!r.ok) toast(r.err || "没成", "warn"); }); return true; }
  if (b.hasAttribute("data-gmodel")) { const m = bgBot(g, s.sel); if (m) openModelPicker(b, m.agent, m.pendModel || botModel(g, m), (prov, model) => setBotModel(z, g, m, prov, model)); return true; }
  // 人设与岗位
  if (d.pfx) { const p = personaTarget(b); if (p) { const v = !pget(p, d.pfx); pset(p, d.pfx, v); b.classList.toggle("on", v); b.innerHTML = ICON(v ? "check" : "plus", 12, 2.2) + b.textContent; } return true; }
  if (b.hasAttribute("data-gpedit")) { const m = bgBot(g, s.sel); if (!m) return true; s.pdraft = clonePersona(personaOf(g, m)); s.pdraft.title = roleOf(m); s.edit = true; s.term = null; return re(); }
  if (b.hasAttribute("data-gpecancel")) { s.edit = false; s.pdraft = null; return re(); }
  if (b.hasAttribute("data-gpetpl")) {
    const m = bgBot(g, s.sel), role = (String(s.pdraft.title || roleOf(m)).trim() || roleOf(m)), name = role + (PERCH_LOCALE === "en" ? " (my template)" : "（我的模板）");
    const p = clonePersona(s.pdraft); delete p.title;
    PERSONA_TPL = PERSONA_TPL.filter((x) => x.name !== name).concat([{ name, role, persona: p }]);
    lsSet("perch.bg.personaTpl", PERSONA_TPL);
    toast(`存成模板了：「${name}」—— 下次建组、加 Bot 时直接选`);
    return true;
  }
  if (b.hasAttribute("data-gpesave")) { savePersonaDraft(z); return true; }
  if (b.hasAttribute("data-gkick")) { kickBot(z); return true; }
  return false;
}
CLICKS.push((t) => {
  if (inTerm(t)) return false;
  const zEl = t.closest(".zone .zb");
  const z = zEl && zoneOfEl(zEl);
  if (!z || z.kind !== "group") return false;
  return groupClick(z, t);
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.closest) return;
  const pfi = el.closest("[data-pf]");
  if (pfi) { const p = personaTarget(pfi); if (p) { const k = pfi.dataset.pf; pset(p, k, k === "ask.cost" ? Math.max(0, parseInt(pfi.value, 10) || 0) : pfi.value); } return; }
  const gi = el.closest("[data-gf],[data-gbrole],[data-gaddrole],[data-gin]");
  if (!gi) return;
  const z = zoneOfEl(gi), s = z && z.group;
  if (!s) return;
  if (gi.dataset.gf) s[gi.dataset.gf] = gi.value;
  else if (gi.dataset.gbrole !== undefined) s.bots[+gi.dataset.gbrole].role = gi.value;
  else if (gi.hasAttribute("data-gaddrole")) { s.add.role = gi.value; s.add.persona = null; }
  else s.draft = gi.value;
  if (gi.dataset.gf === "name") { const zt = qs(".zt", ZEL.get(z.id)); if (zt) zt.textContent = gi.value.trim() || "新的 Bot Group"; }
  if (gi.dataset.gf) saveLayout();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229 || !e.target.matches || !e.target.matches("[data-gin],[data-gdin],[data-gaddrole]")) return;
  const z = zoneOfEl(e.target), s = z && z.group, g = s && bgGroup(s.gid);
  if (!g) return;
  e.preventDefault();
  if (e.target.matches("[data-gin]")) { if (bgSend(g, e.target.value, { why: "回车" })) { e.target.value = ""; s.draft = ""; z.gpin = true; } }
  else if (e.target.matches("[data-gdin]")) { const m = bgBot(g, s.sel); if (m && bgSend(g, e.target.value, { to: m, why: "单聊回车" })) e.target.value = ""; }
  else addBotToGroup(z);
});

/* ---------- 块的种类 ---------- */
ZONE_KINDS.group = {
  min: ZMIN_GROUP,
  init(z, opts) { z.group = newSetup(opts); },
  title(z) {
    const s = z.group, g = s.stage === "run" && bgGroup(s.gid);
    if (g) return [g.name, `Bot Group · ${(g.bots || []).length} 个成员 · ${projName(g.project)}`];
    return [s.name.trim() || "新的 Bot Group", "Bot Group · 建组中"];
  },
  tab(z) {
    const g = z.group.stage === "run" && bgGroup(z.group.gid);
    if (!g) return { ic: `<span class="tl">${ICON("users-round", 14)}</span>`, st: "还在建组", wait: 0 };
    const bots = g.bots || [];
    const ic = bots.slice(0, 4).map((b) => `<span class="tl ${DOT_OF[botState(b)]}">${logo(b.agent)}</span>`).join("");
    const w = askCards(g), sp = bots.find((b) => botState(b) === "work");
    return { ic, wait: w.length, st: w.length ? `<em>${w.length} 件等你拍板</em>` : sp ? `${esc(roleOf(sp))} 在干活` : `${bots.length} 个成员 · 空闲` };
  },
  render(z, zb) {
    const s = z.group;
    if (s.stage === "run") { renderRun(z, zb); return; }
    // 建组时项目名单还没到：到了就补上
    if (!isProjPath(s.proj) && isProjPath(defProj())) { s.proj = defProj(); s.sv++; }
    const sk = "setup:" + s.sv + ":" + s.step + ":" + BOTGROUPS.length + ":" + PROJECTS().length;
    if (zb._sk === sk) return;
    zb._sk = sk;
    const body = qs(".gs-body", zb), st = body ? body.scrollTop : 0;
    zb.innerHTML = groupSetupHTML(z);
    const b2 = qs(".gs-body", zb); if (b2) b2.scrollTop = st;
  },
  busy(z) { const g = z.group.stage === "run" && bgGroup(z.group.gid); return g ? (g.bots || []).filter((b) => { const t = bgTabOf(b); return t && !t.connDown; }).length : 0; },
  running() { let n = 0; for (const z of Z) { const g = z.kind === "group" && bgGroup(z.group.gid); if (g) n += (g.bots || []).filter((b) => botState(b) === "work").length; } return n; },
  // 关掉这一块 = 成员们停下来（× 不是删：组和每个成员的记录都留着，新开一块 Bot Group 时能接回）
  close(z) {
    const zb = qs(".zb", ZEL.get(z.id));
    if (zb) parkBotTerm(zb);
    const g = bgGroup(z.group.gid);
    for (const b of (g && g.bots) || []) { const t = bgTabOf(b); if (t) closeTab(t, { close: true, why: "关掉 Bot Group 那一块" }); BG_Q.delete(bk(g.id, b.id)); }
  },
  closeText(z, n) { return `里面 ${n} 个成员会停下来。组、群聊和每个成员的记录都留着，新开一块 Bot Group 时能接着用。`; },
  drop(z, agentId) {
    const s = z.group;
    if (s.stage === "run") { s.adding = true; s.err = ""; s.add = { role: "", agent: agentId }; s.sel = null; s.term = null; ensureInstalled(agentId, z); s.sv++; render(); return; }
    if (s.bots.length >= BG_MAX) { toast(`一个组最多 ${BG_MAX} 个 Bot`, "warn"); return; }
    s.bots.push({ role: "", agent: agentId, persona: personaFor("") });
    ensureInstalled(agentId, z);
    if (s.step !== 2 && !groupValid(s, 1)) s.step = 2;
    s.err = ""; s.sv++; render();
    setTimeout(() => { const ins = qsa("[data-gbrole]", ZEL.get(z.id)); if (ins.length) ins[ins.length - 1].focus(); }, 30);
  },
  dropLabel(a) { return `加进群：${a.name}`; },
  save(z) {
    const s = z.group;
    if (s.stage === "run") return { gid: s.gid, sel: s.sel || null };
    return { setup: { step: s.step, name: s.name, goal: s.goal, proj: s.proj, budget: s.budget, manager: s.manager, mgrPersona: s.mgrPersona, bots: s.bots } };
  },
  load(z, x) {
    z.group = newSetup({});
    if (x.gid) Object.assign(z.group, { stage: "run", gid: x.gid, sel: x.sel || null });
    else if (x.setup) Object.assign(z.group, x.setup, { step: Math.min(3, Math.max(1, x.setup.step | 0 || 1)) });
  },
};
// Dock 的铃铛 / 收起时的气泡：群里等你拍板的
WAIT_SRC.push(() => {
  const out = [];
  for (const z of Z) {
    const g = z.kind === "group" && bgGroup(z.group.gid);
    if (!g) continue;
    for (const b of g.bots || []) if (botState(b) === "wait") out.push({ z, l: null, text: `${g.name} · ${roleOf(b)} 在等你拍板` });
    for (const t of BG_TASKS.get(g.id) || []) if (t.status === "blocked") out.push({ z, l: null, text: `${g.name} · ${t.id} 被拦下了，等你决定` });
  }
  return out;
});
// 项目面板里「在跑的 agent」
RUNNING_IN.push((path) => {
  const out = [];
  for (const z of Z) { const g = z.kind === "group" && bgGroup(z.group.gid); if (g && normPath(g.project) === normPath(path)) for (const b of g.bots || []) if (bgTabOf(b)) out.push(b.agent); }
  return out;
});
// 总览：等你拍板的、开着的组
OV_WAITS.push(() => {
  const out = [];
  for (const z of Z) {
    const g = z.kind === "group" && bgGroup(z.group.gid);
    if (!g) continue;
    for (const b of g.bots || []) if (botState(b) === "wait") out.push({ id: "", z: z.id, agent: b.agent, name: `${g.name} · ${roleOf(b)}`, proj: projName(g.project), t: "等你拍板", st: "wait", block: g.name });
  }
  return out;
});
OV_GROUPS.push(() => Z.filter((z) => z.kind === "group" && bgGroup(z.group.gid)).map((z) => {
  const g = bgGroup(z.group.gid), used = BG_USEDK[g.id] || 0, cap = budgetOf(g);
  const waiting = askCards(g).length;
  return { html: `<button class="ov-g" data-ovgo="z" data-ovz="${z.id}"><b>${esc(g.name)}</b><span>${(g.bots || []).length} 个成员 · ${esc(projName(g.project))}${waiting ? " · <em>等你拍板</em>" : ""}</span><div class="g-bud"><i style="width:${cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0}%"></i><em>${used}k / ${cap > 0 ? cap + "k" : "不限"}</em></div></button>` };
}));
