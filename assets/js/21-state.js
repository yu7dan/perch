"use strict";
/* 21-state.js —— 页面级状态：壳层载荷、每格实时读数、本机 Agent 名单、「当前格」与关格。
   2026-11-08 台面（0.1.1）：旧外壳（左栏 / 网格 / 右栏 / 独立页）整体退役，这里只留状态本身；
   怎么画由台面（30-desk.js）决定 —— 状态一变就 deskSoon()，台面一帧之内跟上。 */

// 壳层载荷（Go 的 ShellPayload：会话库、项目池、名字表、设置……），见 22-live.js 的 applyShell。
let STATE = null;
// 旧左栏「选中的那条会话」—— 台面上没有这一层了；22-live.js 的 applyLibrary 还按 id 刷新它，留着不碍事。
let selected = null;


/* 每个格子的实时读数（文件/子代理/流水，以及铃铛的"需要你"），
   由 hook / 会话登记表 / 转录三条腿往里写。
   ⚠️ **声明必须在这里**（启动那一段之前），不能挪到文件末尾那段处理逻辑旁边：
   启动时 setActive() → renderAgentDot() → cellState() 就会读它，
   而 `const` 在初始化之前读到就是 TDZ 报错（这页面没有控制台，看起来就是白屏）。
   类型：tabId → { st, name, at, note, subs, files, acts }，见文件末尾那一段的说明。 */
const LIVE = new Map();
/* C7 子代理三态的绑定（判据、措辞、图形出处的完整说明在 renderSideLive 上面那一段）。
   ⚠️ 和 LIVE 同一个理由**必须声明在启动之前**，而且这一组比 LIVE 更容易踩：
   在模块求值期间就会被叫到的 **cardHTML** 里用到了它们（那一段自己也有同类的
   踩坑记录，见 ICON_PLAY 上面那条注释）。
     · subClosed    我们看着它跑、又看着它那一格被关掉的那些 —— 「已关闭」
                    唯一的**亲眼所见**证据（另外两条是对文件的推断）；
     · subDone      反过来那一半：我们亲眼看见 hook 报了 SubagentStop 的那些。
                    ⚠️ 它存在的理由是一条实测出来的**不对称**（01:01:15 那次）：
                    关掉一格时，hook 模型（LIVE）连着格子一起被删掉，于是"这个
                    子代理早就完成了"这条**亲眼所见**当场蒸发，卡退回去读文件，
                    而文件那条判据是"3 分钟内还在写 → 进行中" —— 一个我们明明
                    看着它收尾的子代理，在库里挂了 3 分钟的「进行中」。
                    既然是"我们看过"，就该和 subClosed 一样**跟着我们自己活**，
                    没道理只留"被关掉"那一半；
     · subStateSeen 上次报过的状态，只在**变化**时报一行日志，免得刷屏；
     · SUB_WORD     状态词；  · SUB_RECENT_MS "还在写"的窗口。
   那几个**函数**（subKey/subStateOf/subChipHTML…）留在文件末尾，靠函数声明的提升
   —— 这正是这一段上面那条注释说的分工：绑定要早，函数不用。 */
const subClosed = new Set();
const subDone = new Set();
const subStateSeen = new Map();
const SUB_WORD = { run: "进行中", done: "已完成", closed: "已关闭", fail: "失败" };
const SUB_RECENT_MS = 3 * 60 * 1000;
/* 渲染闸门与那几个"启动路径上就会碰到"的小东西。
   ⚠️ 这一段的位置不是风格问题，是被**两次实测**（2026-10-15 的开发期日志）
   钉出来的：启动那一段里有 `await createTab()`，它之后立刻就是 `setActive(tab)`，
   而 setActive 会一路走到 ackNote / scheduleLive / renderAgentDot。这些函数是
   函数声明（会提升），但它们读的 `let liveRaf` / `const liveTab` / `LIVE`
   **不提升** —— 声明写在文件末尾就会读到 TDZ，抛
   「Cannot access 'liveRaf' before initialization」。
   后果不是"少个功能"：那次异常把启动那一段**整个打断**了，于是后面所有
   顶层语句（包括末尾那一次 renderLive）全部没跑，页面上一个读数都不会有。
   所以凡是"启动路径能碰到"的绑定，一律声明在启动之前；末尾那一段只放
   **被 RSB_READY 挡住**的渲染函数和消息处理。 */
let RSB_READY = false;
let liveRaf = 0;
const liveTab = (tab) => TAB_LIST.find((x) => x.id === tab) || null;

/* ---------------------------------------------------------------------------
   默认 Agent 的解析（2026-10-19，选择面板 + 左栏一键新开共用）
   ---------------------------------------------------------------------------
   三条事实分开：
     · 设置里显式选的（Go 的 settings.defaultAgent，随 panes.list / shell 下来）；
     · 这台机器**已安装且能启动**的（Go 探测，catalog 的 installed + caps.launch）；
     · 自动时的偏好：优先能给出忙/闲的那一层（总览里看得到状态的那些）。
   显式选的如果没装/不能启动，回落到自动 —— 不静默换人，但也不能拿一个
   起不来的 id 去建格。 */
/* 名单完全没送到（ctl 超时 / 老载荷）时的退路。只在**两份来源都空**时用：
   总览的 catalog 和 panes.list 的快照是同一份 Go 探测，两个都空才说明是载荷问题，
   不是“这台机器什么都没装”。 */
const OP_FALLBACK_AGENT = {
  id: "claude", name: "Claude Code", icon: "claudecode-color", installed: true,
  caps: { launch: true, status: true, resume: true, waiting: true, actions: true,
          mechanism: "hook" },
};
let OP_CATALOG_MISSING = false;
/* 本机 Agent 名单（Go 的 agentcatalog 探测结果）。来路有三条，都进 setCatalog：
   shell 载荷 / lib.reload 的 catalog 字段、安装器与「接入状态」完成后的 catalog 推送、
   冷恢复应答里的 agents（BOOT_AGENTS，最早到）。2026-10-28 以前它搭在网关快照
   （MAGPIE.catalog）上 —— 网关拿掉之后它必须自己有一条路。
   ⚠️ 用 var：10-term.js 在本文件求值之前就会建第一个标签（那时只能 typeof 判它）。 */
var CATALOG = [];
let CATALOG_SIG = "";
function setCatalog(list, why) {
  if (!Array.isArray(list)) return;
  const sig = JSON.stringify(list.map((a) => [
    a.id, !!a.installed, a.icon, a.name, a.path, !!a.install, a.url,
    !!(a.caps && a.caps.launch), !!(a.caps && a.caps.inject),
  ]));
  CATALOG = list;
  if (sig === CATALOG_SIG) return;
  CATALOG_SIG = sig;
  deskSoon(why || "Agent 名单更新");
}
function opCatalog() {
  let list = Array.isArray(CATALOG) ? CATALOG : [];
  if (!list.length && Array.isArray(BOOT_AGENTS)) list = BOOT_AGENTS;
  if (!Array.isArray(list)) list = [];
  OP_CATALOG_MISSING = !list.length;
  if (OP_CATALOG_MISSING) list = [OP_FALLBACK_AGENT];
  return list;
}
function opLaunchable(a) {
  return !!a && a.installed === true && !!(a.caps && a.caps.launch);
}
function opAgentById(id) {
  return opCatalog().find((a) => a && a.id === id) || null;
}
function opDefaultPinned() {
  return String((SETTINGS && SETTINGS.defaultAgent) || BOOT_DEFAULT_AGENT || "");
}
function defaultAgentId() {
  const cat = opCatalog();
  const want = opDefaultPinned();
  if (want && opLaunchable(cat.find((a) => a && a.id === want))) return want;
  // 自动：先要有状态的（用户能看见它在干什么），再退到第一个可启动的。
  const smart = cat.find((a) => opLaunchable(a) && a.caps && a.caps.status);
  if (smart) return smart.id;
  const any = cat.find(opLaunchable);
  if (any) return any.id;
  // 名单完全没到（老载荷 / 探测失败）：保持旧行为，至少能开一格。
  return "claude";
}

/* ---------------------------------------------------------------------------
   项目池（Go 的 internal/project）：项目 = 盘上的一个文件夹
   --------------------------------------------------------------------------- */
// 用户自己加的项目（Go 合成的「默认工作区」不算项目，它只是不挑项目时的落脚处）。
function deskProjects() {
  return (STATE?.projects || []).filter((p) => p && !p.synthetic && p.path);
}
function defaultAreaPath() {
  return (STATE?.projects || []).find((x) => x.synthetic)?.path || STATE?.cwd || "";
}
function projectName(p) {
  if (!p) return "";
  return p.synthetic ? t("project.defaultName") : (p.name || base(p.path));
}
// 一个 cwd 只属于一个项目：嵌套项目取最长前缀；都不在就是默认工作区。
function ownerProjectPath(cwd) {
  const p = String(cwd || "").trim() || defaultAreaPath();
  if (!p) return "";
  let best = "", bestLen = -1;
  for (const pr of deskProjects()) {
    if (!insidePath(p, pr.path)) continue;
    const n = normPath(pr.path).length;
    if (n > bestLen) { best = pr.path; bestLen = n; }
  }
  return best || defaultAreaPath();
}
function projObjByPath(path) {
  return (STATE?.projects || []).find((p) => normPath(p.path) === normPath(path)) || null;
}
// 显示用的项目名：认得的用项目名，认不得的用目录名。
function projLabel(path) {
  const p = projObjByPath(path);
  return p ? projectName(p) : (base(path) || path || "");
}
function findSess(id) { return (STATE?.sessions || []).find((s) => s.id === id) || null; }
// 这条会话现在是不是某一格在跑（判据和旧左栏同一条：hook 带来的 session_id，或本来就是 --resume 起的）。
function tabForSession(sid) {
  if (!sid) return null;
  return TAB_LIST.find((t) => t.id > 0 && !t.connDown
    && (t.sessionID === sid
     || (t.spec?.resume?.kind === "exact" && t.spec.resume.id === sid))) || null;
}
// 这一格的生效 cwd：空串 = 没指定目录 = 落在默认工作区。
function effCwd(t) {
  return (t.spec && t.spec.cwd) || defaultAreaPath();
}
function agentRowName(tab) { // 参数别叫 t：会遮住 i18n 的 t()
  const live = realTabTitle(tab);
  if (live) return live;
  const s = tab.sessionID ? findSess(tab.sessionID) : null;
  if (s) return sessionTitle(s);
  return defaultTabTitle(tab);
}
function applyPool(m) {
  if (!m) return;
  if (m.err) showToast(t("shell.pool.errorTitle"), tMsg(m.errCode, m.errParams, m.err), "err");
  // 后台统计可能扫了十几秒；rev 单调，旧快照不能把刚加的项目覆盖掉。
  if (typeof m.rev === "number" && typeof STATE?.poolRev === "number" && m.rev < STATE.poolRev) {
    sendCtrl({ type: "log", msg: `项目池旧快照跳过 rev=${m.rev} < ${STATE.poolRev}` });
    return;
  }
  STATE = STATE || {};
  if (Array.isArray(m.projects)) STATE.projects = m.projects;
  if (m.assign && typeof m.assign === "object") STATE.assign = m.assign;
  if (Array.isArray(m.hidden)) STATE.hidden = m.hidden;
  if (typeof m.rev === "number") STATE.poolRev = m.rev;
  if (typeof bgCreatePoolArrived === "function") bgCreatePoolArrived();
  deskSoon("项目池");
  sendCtrl({ type: "log", msg: `项目池已更新 项目=${(STATE.projects || []).length} err=${m.err || "无"}` });
}

/* ---------------------------------------------------------------------------
   当前格 —— **唯一给模块级 `term` 赋值的地方**
   ---------------------------------------------------------------------------
   台面上所有格子同时可见，所以这里只剩三件事：把 #termhost 这个 id 挪过来、
   标出当前格、把焦点交给它。看过即销：切到它 = 它那条「需要你」降成空闲。 */
function setActive(t) {
  // Bot 格住在 Bot Group 那一块里，不进「当前格」。
  if (t && t.group) return;
  if (!t) {
    if (activeTab) {
      activeTab.host.removeAttribute("id");
      activeTab.cellEl.classList.remove("cur");
    }
    activeTab = null;
    term = null;
    scheduleLive();
    return;
  }
  /* 已经是它 ≠ 已经接上了：座位是"先登记再建"的，它可能在终端还没建好时就被认成了
     当前格（那一次是靠 T 上的空实现撑过去的）。term 还没接上就再跑一遍。 */
  if (activeTab === t && term === t.term) return;
  if (activeTab) {
    activeTab.host.removeAttribute("id");
    activeTab.cellEl.classList.remove("cur");
  }
  activeTab = t;
  t.host.id = "termhost";
  t.cellEl.classList.add("cur");
  term = t.term;
  renderAgentDot(t);
  renderTabTitle(t);
  paintConnStatus(t.ready);
  paintRenderStatus();
  t.refit();
  t.focus();
  ackNote(t, "切格");
  askActsSnapshot("成为当前格");
  scheduleLive();
  deskSoon("当前格");
  sendCtrl({ type: "log", msg: `setActive tab=${t.id} 模型=${TAB_LIST.length} 格=${Math.round(t.host.clientWidth)}x${Math.round(t.host.clientHeight)}` });
}

/* 关掉一个格子：关掉它的 stream，Go 那边 Receive 失败就收 PTY。
   两种用户点名的关法语义不同（close-is-not-delete）：
     opts.close   × = 关掉运行，记录留着（Go 打 closed），之后能按原 paneId 接回；
     opts.forget  「结束这个 agent」= 记录一起删（唯一删记录的路）。
   别的路（建格被护栏拒绝后的收尾）两个都不带：格子没建出来不等于座位不要了。 */
function closeTab(t, opts) {
  if (!t) return;
  const i = TAB_LIST.indexOf(t);
  if (i < 0) return;
  if (opts && opts.forget && t.paneID) {
    sendCtrl({ type: "pane.forget", pane: t.paneID });
    bootFact(`关格忘掉座位：pane=${t.paneID}（${(opts && opts.why) || "用户显式关格"}）`);
  } else if (opts && opts.close && t.paneID) {
    rememberClosedPane(t);
    sendCtrl({ type: "pane.close", pane: t.paneID });
    bootFact(`关格保留记录：pane=${t.paneID}（${(opts && opts.why) || "用户关格"}）`);
  }
  let closed = false;
  try { if (t.stream) { t.stream.close(); closed = true; } } catch (e) {}
  try { if (t.termOut) t.termOut.dispose(); } catch (e) {}
  sendCtrl({ type: "log", msg: `关格子 tab=${t.id} 关闭后模型=${TAB_LIST.length - 1} stream已关=${closed}` });
  // WebGL 名额还回去，否则关掉几个之后新格子会一律退回 DOM 渲染器。
  if (t.gfx && t.gfx.on) webglLive--;
  try { if (t.releaseWebgl) t.releaseWebgl(); } catch (e) {}
  // 这一格里还在跑 / 已经报过完成的子代理：趁 LIVE 还在记一笔（判据见 22-live.js 的子代理那段）。
  const lv = LIVE.get(t.id);
  if (lv && lv.subs) for (const sb of lv.subs) {
    if (sb.done) subDone.add(subKey(sb.id));
    else subClosed.add(subKey(sb.id));
  }
  TAB_LIST.splice(i, 1);
  LIVE.delete(t.id);
  t.cellEl.remove();
  if (activeTab === t) { activeTab = null; term = null; setActive(null); }
  deskSoon("关格");
  // 复接（reseat）时不重扫会话库：同步重扫会把紧接着的 tab.new 顶掉两秒多。
  if (!(opts && opts.reseat)) sendCtrl({ type: "lib.reload" });
}

/* ---------------------------------------------------------------------------
   给 22-live.js 的几个落点：状态变了，台面跟上
   --------------------------------------------------------------------------- */
function renderShell() { deskSoon("壳层载荷"); }
function renderLive() {
  scanLoginGates();
  for (const t of TAB_LIST) renderAgentDot(t);
  paintAttention();
  deskSoon("实时读数");
}
// 跳到那一格（Dock 的铃铛、总览、悬浮按钮的气泡都走这里）：先销账，再让台面把它亮出来。
function jumpToTab(t, why) {
  if (!t) return;
  ackNote(t, why || "跳转");
  if (window.DESK) DESK.reveal(t, why);
  else setActive(t);
}
// 旧代码里的提示条 / 确认框统一交给台面的那一套。
function showToast(title, body, kind) {
  const msg = body ? `${title} —— ${body}` : String(title || "");
  if (window.DESK) DESK.toast(msg, kind === "err" ? "warn" : "");
  else bootFact("提示（台面还没起来）：" + msg);
}
function askConfirm(o) {
  if (window.DESK) return DESK.confirm(o.title, o.body || "", o.ok || t("common.ok"));
  return Promise.resolve(false);
}

// 复制到剪贴板。两条路：navigator.clipboard 只在**安全上下文**里有（Wails 给的
// 是 http://127.0.0.1:port，算 secure context，但这条依赖不值得赌），
// 兜底走 execCommand。**走哪条要回日志** —— 否则"复制没反应"就只能猜。
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      sendCtrl({ type: "log", msg: `剪贴板 写入 ${text.length} 字符（navigator.clipboard）` });
      return true;
    }
  } catch (e) {
    sendCtrl({ type: "log", msg: `剪贴板 navigator.clipboard 失败（${e && e.message}），退回 execCommand` });
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    sendCtrl({ type: "log", msg: `剪贴板 写入 ${text.length} 字符（execCommand=${ok}）` });
    return ok;
  } catch (e) {
    showToast(t("live.copyFailed"), String(e && e.message ? e.message : e), "err");
    return false;
  }
}
