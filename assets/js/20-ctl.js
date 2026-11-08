"use strict";
/* 20-ctl.js —— ctl 控制流、建格请求/应答、冷恢复计划、已关闭的格、sendCtrl/bootFact。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 1608-2246（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

const ctl = JSONStream("ctl");
let ctlReady = false;
const ctlPending = [];        // ctl 连上之前攒下的建标签请求
let spawnTabCalls = 0;        // 临时探针：spawnTab 被调了几次

/* ---------------------------------------------------------------------------
   冷恢复：开窗时**先问一次**"上一轮有哪几格"（步 3）
   ---------------------------------------------------------------------------
   没有它的时候：关掉再开 = 一格全新空会话，用户既不知道上次做到哪，也接不上。

   为什么不跟着 ShellPayload 一起下来：前端在**模块求值期间**就已经把默认那一格
   建出来了（下面 `await createTab(DEFAULT_SPAWN_SPEC)`），载荷到达时那一格已经在
   会话库里落了一条空会话 —— 正是这一轮要消灭的噪音。查询能抢在它前面。

   三条状态（`state`），步 4 的建格要认它们：
     asking   已经发出去了，等应答
     ready    拿到了清单（**只有这一种才允许按它建格**）
     timeout  ~800ms 没应答 → 退回现状（一个默认格 + 一行日志）
     failed   Go 说登记表不可用（只读盘 / 拿不到配置目录）→ 同 timeout
   ⚠️ 只问一次（`asked`）：无论 WebSocket 会不会自动重连，重问一次都可能让
   步 4 把同一批会话**再接一遍**（两个写者写同一份 jsonl —— 这个项目唯一不可逆的失败）。
   ⚠️ 它只是一份**建议**：每一格建的时候照旧走 Go 的 resumeRefusal 那道护栏。 */
const RESTORE = { state: "init", panes: [], err: "", asked: false };
// 启动那一批座位（冷恢复的格子）都建完了没有。Bot Group 的投递在这之前不许自己起格：
// 它会抢在冷恢复前面给同一个 paneId 起一个**新**会话，原来那段对话就接不上了（实测 2026-10-29）。
let BOOT_SEATED = false;
/* 冷恢复应答里顺带来的本机 Agent 名单 + 设置里的默认 agent。
   为什么必须跟着 panes.list 走：建第一格发生在 shell 载荷**之前**（见上面那段），
   而“默认用哪个 agent”不能等 shell。名单的权威探测在 Go（internal/agentcatalog），
   前端只读，不自己再探一遍。 */
let BOOT_AGENTS = [];
let BOOT_DEFAULT_AGENT = "";
let restoreTimer = 0;
function askRestorePlan() {
  if (RESTORE.asked) { ctl.send({ type: "log", msg: "冷恢复：已经问过了，不重问（重问可能让同一批会话被接两遍）" }); return; }
  RESTORE.asked = true;
  RESTORE.state = "asking";
  ctl.send({ type: "panes.query" });
  // 兜底：Go 一直不回就退回现状，**别把启动卡在这里**。代价只是"这一轮不恢复"。
  restoreTimer = setTimeout(() => {
    if (RESTORE.state !== "asking") return;
    RESTORE.state = "timeout";
    bootFact("冷恢复：panes.query 800ms 没应答，这一轮按现状起（一个默认格）");
  }, 800);
}
const restoreCount = (v) => RESTORE.panes.filter((p) => p.verdict === v).length;

/* ---------------------------------------------------------------------------
   「已关闭」的 agent —— 关格 ≠ 删记录（用户 2026-10-17 报的那个 bug）
   ---------------------------------------------------------------------------
   以前格子头的 × 直接发 `pane.forget`：于是"面板里关掉一格"= "把它从工作区
   里删掉"。用户的意思正好相反 —— 关掉只是"我现在不需要它开着"，那个 agent
   以后还要用。

   现在 × 发 `pane.close`：发过提示的格子，Go 把记录打上 `closed`，**不删**；
   重启时它不占座位（不自动拉起），只在左栏工作区里留一行「已关闭」，点一下用
   **同一个 paneId** 接上原来那条会话。从没发过提示的空开合没有会话可续，
   Go 会直接摘掉记录，前端收到 `pane.closed kept=false` 后把乐观补的那行撤回。
   真正删除有内容记录的仍然只有「结束这个 agent」。

   ⚠️ 这份 Map 是**薄快照**，只为画那一行/接回它；权威那份在
   %APPDATA%\Perch\panes.json，冷恢复时由 `panes.list` 推回来重建一遍。 */
const CLOSED_PANES = new Map();   // paneId → {paneId, agent, cwd, sessionId, lastSeenAt, name}
const closedList = () => [...CLOSED_PANES.values()];
function defaultWorkspacePath() {
  return (STATE?.projects || []).find((x) => x.synthetic)?.path || "";
}
/* 关格时把这一格的**身份**留在界面这一侧（名字/目录/会话 id 都还没被摘掉）。 */
function rememberClosedPane(t) {
  if (!t) return;
  const pane = t.paneID | 0;
  if (!pane) {
    sendCtrl({ type: "log", msg: `关格：tab=${t.id} 还没拿到 paneId（建格应答没到），这一格不留「已关闭」记录` });
    return;
  }
  const live = (typeof LIVE !== "undefined") ? LIVE.get(t.id) : null;
  const prompted = !!(live && Array.isArray(live.acts) && live.acts.some((a) => a.kind === "prompt"));
  const known = !!(t.sessionID && findSess(t.sessionID));
  CLOSED_PANES.set(pane, {
    paneId: pane,
    agent: (t.spec && t.spec.agent) || DEFAULT_SPAWN_SPEC.agent,
    cwd: (t.spec && t.spec.cwd) || "",
    sessionId: t.sessionID || (t.spec?.resume?.kind === "exact" ? t.spec.resume.id : "") || "",
    lastSeenAt: new Date().toISOString(),
    name: agentRowName(t),
    // 盘上有没有会话文件：关格这一刻不知道（零轮次的会话本来就没有），
    // 交给"点下去被 unavailable 拒了"或下一次冷恢复去判定 —— 不猜。
    // `spoke/talked` 只是**措辞和乐观行**用的证据；判定接不接得上永远只看 onDisk。
    // ⚠️ 不能拿"有 sessionId"当说过话：Claude 启动就会绑 session，零轮次也有 id。
    // 之前的写法让两个没发过提示的格子留下「已关闭」行，点下去后端已经删了记录，
    // 只能被 unavailable 拒掉。
    spoke: known || prompted,
    talked: prompted || known,
    // 关格瞬间乐观补的行还没经过 pane.closed 的判决：在确认前不许点。
    // 否则用户点的是"后端马上要删掉/还没处理完"的记录，续接请求只会得到
    // 一个拒绝或一次与关闭竞争的重建。
    closing: true,
    // 空态里的「接回」只列已经落盘的记录（冷恢复推回来的），
    // 不列这种还在等答复的。
    optimistic: true,
  });
}
function closedRowName(r) {
  const sid = r.sessionId || "";
  if (sid) {
    const s = findSess(sid);
    if (s) return sessionTitle(s);
    const t = (STATE?.titles || {})[sid];
    if (t) return t;
  }
  /* 冷恢复回来的 closed 记录只有 cwd/sessionId，没有 name（PaneView 不带名字）。
     旧版本的无项目格在 `sessions\<日期>-<agent>-<pane>` 下，这个目录名
     本身就是一条能认出来的身份；再不济也比一排「已关闭的 agent」强。 */
  const dir = String(r.cwd || "").replace(/[\\/]+$/, "");
  const base = dir ? dir.split(/[\\/]/).pop() : "";
  if (base) return base;
  return r.name || t("pane.closedAgent");
}
function closedMatch(r, key) {
  if (!key) return true;
  return `${closedRowName(r)} ${r.agent || ""} ${r.cwd || defaultWorkspacePath()}`
    .toLowerCase().includes(key);
}
function closedInProject(p) {
  const path = typeof p === "string" ? p : (p && p.path);
  // 和 tabsInProject 共用 ownerProjectPath：最长前缀唯一归属，父目录不再
  // 把子项目的 agent 重复数一遍。ownerProjectPath 在 60-shell 里定义，
  // 这里只会在所有脚本加载完之后被调用（renderWorkspaceView）。
  if (typeof ownerProjectPath !== "function") {
    const defPath = defaultWorkspacePath();
    return closedList().filter((r) => insidePath(r.cwd || defPath, path));
  }
  const want = String(path || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return closedList().filter((r) => {
    const got = ownerProjectPath(r.cwd || "");
    const k = String(got || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    return k === want;
  });
}
/* 这一条「已关闭」的 agent 还接不接得上（盘上还有没有它上次那条会话）。
   只有**明确知道没有**（Go 冷恢复算出的 false，或这一次尝试被 unavailable 拒了）
   才算接不上；还不知道（undefined）就照旧试一次 —— 不拿猜测吓唬人。 */
function closedUnresumable(r) {
  return !!(r && r.sessionId && r.onDisk === false);
}
/* 为什么接不上、记录还在哪、还能做什么 —— 这套话说给**不知道 jsonl 是什么**的用户。
   ⚠️ 最常见的一种是零轮次（盘上本来就没有文件，见 panes.Pane.Spoke），另一种是
   文件被删了；两种分开说，因为用户能做的判断不一样（"我还没让它干过活" vs
   "我的文件怎么没了"）。 */
function closedWhy(r) {
  if (r.spoke) return t("pane.closedWhy.spoke");
  if (r.talked) return t("pane.closedWhy.talked");
  return t("pane.closedWhy.zero");
}

/* 等那份清单，最多 800ms。**为什么不是直接 await 一个 promise**：清单是 ctl 通道上
   的一次往返，而那条通道可能整个不来（Go 挂了 / WebView 出错）。"等不到"必须和
   "没有座位"走同一条路：起一个默认格，把界面交出去。
   ⚠️ 时钟只有这一个 —— askRestorePlan 里那个 800ms 定时器也把 state 从 asking
   挪走（应答、到点、Go 说不可用，三条路都会离开 asking），所以这个循环不会空转。 */
async function awaitRestorePlan() {
  const t0 = Date.now();
  while (RESTORE.state === "init" || RESTORE.state === "asking") {
    if (Date.now() - t0 > 800) {
      if (RESTORE.state === "init") {
        RESTORE.state = "timeout";
        bootFact("冷恢复：800ms 过去了 ctl 还没把清单送来（通道可能压根没起来），按现状起");
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (RESTORE.state !== "ready" || !RESTORE.panes.length) return [];
  /* dup 那几条**没有座位**：同一条会话不可能同时被两格接上（两个写者写一份 jsonl
     是这个项目唯一不可逆的失败，见 panes.go 的 restorePlan）。它们在自己的清单日志
     里出过一次，所以用户问得出"这一条为什么没接"。
     「已关闭」（closed）同样不占座位：用户上次点 × 就是"现在别开着它" ——
     重启自动拉起来等于违背他刚做过的那个动作。 */
  const seats = RESTORE.panes.filter((p) => p.verdict !== "dup" && !p.closed);
  if (seats.length !== RESTORE.panes.length) {
    const dups = RESTORE.panes.filter((p) => p.verdict === "dup").length;
    const closed = RESTORE.panes.filter((p) => p.closed).length;
    bootFact(`冷恢复：${RESTORE.panes.length - seats.length} 条不占座位` +
      `（dup=${dups} 同一条会话的另外几格 · closed=${closed} 用户上次关掉的），不起格`);
  }
  return seats;
}

/* 清单里的一条 → createTab 的 spec。
   `restored: true` 是这一格的**出身**：Go 拒绝时不许撤格，改成原地降级
   （见 createTab ②）—— 从左边栏点「接上」的那些格子没有这个标记，接不上就收掉。
   ⚠️ `verdict` / `spoke` 也**原样带过去**（步 6 的横幅读它们）：Go 判定"这一格
   能不能接上"用的是这两个字段，前端要说"为什么没接上"就得拿着同一份事实 ——
   自己再推一遍（比如"文件不在 ⇒ spoke"）就是第二份迟早会漂的规则。 */
function seatSpecFrom(v) {
  const resume = v.resume || { kind: "new", id: "" };
  return {
    agent: v.agent,
    cwd: v.cwd || "",
    // 冷恢复的目标就是记录里的 cwd（空则默认工作区）。标 legacy 跳过“项目
    // 目标必须在池子里”的新建校验 —— 恢复不该依赖项目池扫描的启动顺序。
    target: "legacy",
    resume,
    paneId: v.paneId,
    restored: true,
    verdict: v.verdict || "",
    spoke: !!v.spoke,
    // Bot Group 成员格：带着组 / Bot 身份回来，createTab 据此把它挂进格子坞。
    group: v.group || "",
    bot: v.bot || "",
  };
}

/* 建格请求的令牌：**每次请求发一个号**，Go 在 tab.ok 里原样带回（拒绝那条路也带）。
   ⚠️ 为什么不能再用"在 TAB_LIST 里找一个 id=0 且还在等应答的格子"来配对：
   冷恢复是 **burst**（好几格一起发），而且中间还夹着"被拒→重试"的格子 ——
   pane1 重试时又把自己标成"还在等"，于是 pane2 收到的那条应答就配到了 pane1 头上，
   **整批错位一格**（表现是"每格跑的都是隔壁的会话"，而日志全正常）。
   令牌把配对变成一一对应，重试多少次都不会串。 */
let spawnReqSeq = 0;
const spawnWaiters = new Map();   // req → { t, done, tries, … }

/* 等一条 tab.ok 的窗口 × 连发几次。本机一次应答是毫秒级（见 main.go 那条 log），
   2s 那次失败纯粹是"钟从错误的时刻开始走"（见 spawnTab）；留出三次是为了兜住
   Go 那边正忙的时候 —— 比如同一秒它正在推整个会话库的启动载荷。 */
const SPAWN_WAIT_MS = 2500;
const SPAWN_TRIES = 3;

/* 瞬时拒绝的重试等待：Go 说 `retryable` 才用（见 resume.go 的 refusal.retryable）。
   800/1600 是**冷启动那一刻**的尺度：上一轮的 claude 由 KILL_ON_JOB_CLOSE 异步收掉，
   登记表落在盘上的残留要过一小会儿才失效，pid 还可能被复用 —— 等一轮再问通常就过了。 */
const RESUME_RETRY_MS = [800, 1600];

function spawnTab(t) {
  /* 探针，**故意留着**：2026-10-15 见过一次"点一下 + 建出 7 个标签"（建 7 个、
     又关掉 6 个，全在无输入的情况下按 ~1s 的节奏发生）。它和那次
     `ReferenceError: Cannot access 'ready' before initialization` 同时出现，
     修掉那个 TDZ 之后再点 9 次都是"一次点击 = 一个标签"，**复现不出来了**。
     这条是唯一能抓住它回来的证人（Go 那边 `[ctl] 新标签` 只在往返成功后才打，
     页面这条在 Go 不回应时也留得下）。 */
  bootFact(`建标签 #${++spawnTabCalls} spec=${JSON.stringify(t.spec)}`);
  return new Promise((resolve) => {
    const req = ++spawnReqSeq;
    const w = { t, req, tries: 0, settled: false, timer: 0 };
    const done = (name) => {
      if (w.settled) return;
      w.settled = true;
      clearTimeout(w.timer);
      spawnWaiters.delete(req);
      if (t.spawnReq === req) t.spawnReq = 0;
      t.onSpawned = null;
      resolve(name);
    };
    w.done = done;
    t.onSpawned = done;   // 留着：格子里别处仍按它判"这一格还在等应答"
    t.spawnReq = req;
    spawnWaiters.set(req, w);
    t.__spawnSend = () => sendSpawn(w);   // onopen 补发走它（见下面那条实测）
    /* ⚠️ 钟**只在真发出去那一刻**开始走 —— 不是在这里。
       ctl 还没连上时这一格会趴在 ctlPending 里等通道，那段"等通道"的时间
       不该算进"等 Go 应答"的预算里。
       2026-10-17 实测（开发期日志 02:41:21）：点 + 时 ctl 还没连上，请求趴在队列里
       等 onopen 补发，而钟从"点下去"就在走 —— 通道一开、请求刚发出去、Go 的应答
       还在路上，钟就响了（`tab.new 超时（2s 没收到 tab.ok），标签 ?`），座位被判死刑；
       紧接着迟到的 `tab.ok` 因令牌对不上被丢掉（`令牌 req=5 对不上任何还在等的格子`）
       ⇒ **那一格出生即死**（id=0、不连 PTY）。根因不是"Go 慢了 2 秒"，
       是**钟从错误的那一刻开始走**。 */
    if (!ctlReady) { ctlPending.push(t); return; }
    sendSpawn(w);
  });
}

/* 把这次的 tab.new **真发出去**，并在这一刻起钟（见 spawnTab 里那条实测）。
   超时不再一枪打死：拿**同一个令牌**重发（Go 侧按令牌去重，见 main.go 的 tabReqCache，
   所以重发不会建出第二个格子）。试满 SPAWN_TRIES 次才认输；认输那条路保持原样 ——
   格子留着、界面交出去，因为模块顶层那句 await 一直挂着的话页面就是白屏。 */
function sendSpawn(w) {
  if (w.settled) return;   // 已经拿到应答了（通道断过又重连那一类时序），不许再发一次
  if (!ctlReady) {
    // 等应答期间通道断了：退回队列，补发与计时都交给下一次 onopen，不许在这里空转
    if (!ctlPending.includes(w.t)) ctlPending.push(w.t);
    bootFact(`建标签 通道断了（令牌 req=${w.req}），这次请求退回队列等重连`);
    return;
  }
  w.tries++;
  try { ctl.send({ type: "tab.new", spec: w.t.spec, req: w.req }); }
  catch (e) {
    // 发失败和"通道断了"同一条路：退回队列等下一次 onopen（**不许**在这里死循环重试）
    jserr("spawnTab.send", e);
    if (!ctlPending.includes(w.t)) ctlPending.push(w.t);
    return;
  }
  w.timer = setTimeout(() => {
    if (w.settled) return;
    if (w.tries >= SPAWN_TRIES) {
      sendCtrl({ type: "log", msg: `tab.new 超时（发了 ${w.tries} 次共 ${(w.tries * SPAWN_WAIT_MS / 1000).toFixed(1)}s 没等到 tab.ok，令牌 req=${w.req}），标签 ${w.t.id || "?"} 先不连 PTY` });
      w.done("");
      return;
    }
    sendCtrl({ type: "log", msg: `tab.new 第 ${w.tries} 次没等到 tab.ok（${SPAWN_WAIT_MS}ms，令牌 req=${w.req}）→ 同一令牌重发` });
    sendSpawn(w);
  }, SPAWN_WAIT_MS);
}
ctl.onopen = () => {
  ctlReady = true;
  ctl.send({ type: "log", msg: `ctl 通道已连接（攒下的建标签请求 ${ctlPending.length} 个）` });
  // Bot Group 的组清单：冷恢复出来的 Bot 格要靠它对上身份（91-botgroup.js 的 bgSyncTabs）。
  ctl.send({ type: "botgroups.get" });
  // 冷恢复的清单**抢在**下面那批攒下的建标签请求前面问（步 4 要按"先有计划、
  // 再有座位"的顺序来：清单还没到就先把默认格建出来，那一格会占掉 1 号座位）。
  askRestorePlan();
  // 补发启动期攒下的错误（那段"普通脚本"抓的，见文件头部）—— 那时还没有通道。
  for (const m of window.__bootErr) ctl.send({ type: "log", msg: "启动期错误: " + m });
  window.__bootErr.length = 0;
  // 通道建好之前攒下的**非错误**事实（见 bootFact）——同样补发，但不加"错误"前缀。
  for (const m of window.__facts) ctl.send({ type: "log", msg: m });
  window.__facts.length = 0;
  // 应答按发送顺序回来（同一条流），所以谁先发谁先拿到 id。
  // ⚠️ 令牌要跟着一起补发：配对靠它，漏了就是"这一格永远等不到应答"（见 spawnTab）。
  // ⚠️ 走 t.__spawnSend：它顺手把钟起在"真发出去"这一刻（见 spawnTab 里那条实测）。
  //    这里直接 ctl.send 就等于又把这批格子的钟留在"用户点下去"的那一刻 ——
  //    通道等多久都算进等应答的预算里，正是出生即死那个 bug 的成因。
  for (const t of ctlPending.splice(0)) {
    if (t.__spawnSend) t.__spawnSend();
    else ctl.send({ type: "tab.new", spec: t.spec, req: t.spawnReq || 0 });
  }
};
/* ---------------------------------------------------------------------------
   启动闸：ctl 消息在"整段脚本跑到底"之前**只收不发**（2026-10-19）
   ---------------------------------------------------------------------------
   当年红条 `applyMagpie is not defined`（网关已于 2026-10-28 拿掉）的根因就在这里。
   两条事实拼在一起：

     ① index.html 里那一串 defer 脚本是**按文档顺序、一块一块求值**的，而浏览器
        在块与块之间可以让出事件循环 —— 网络消息会落在"后面的脚本还没求值"的缝里；
     ② 这条 ctl 流在 20-ctl 求值时就建好了（`const ctl = JSONStream("ctl")`），
        而分发要用到的处理函数散在后面的文件里：applyHook/applyAgent/applyActs/
        applyFiles/applyLibrary 在 80-live，applyInstall 在 88-install，
        applyProviders 在 85b-providers。

   哪一条消息会先到不由我们决定：沙盒里会话库很小的时候 shell 首帧会在几十
   毫秒内回来；一条 `hook` 落在 80 之前，就是 `applyHook is not defined`。

   ⚠️ 修法**不是**在每个 case 里加 `typeof` 守卫：
     · 后面文件里的 `let` 在 TDZ 里连 `typeof` 都会抛
       （60-shell.js 那条注释记的就是这个教训）；
     · 守卫会把消息**当场丢掉** —— 丢一条 `panes.list` 等于这一轮冷恢复不恢复，
       丢一条 `catalog` 就要等下一次推送才画得出名单。
   所以按到达顺序攒着，等 99-boot（最后一条脚本）把闸打开，再原顺序分发。

   ⚠️ 闸变量必须声明在**这条脚本**里：消息可能落在 40-chrome 求值之前，那时
   它的 `RSB_READY` 自己还在 TDZ，借不得。 */
let ctlBootReady = false;
const ctlInbox = [];
function flushCtlBoot() {
  ctlBootReady = true;
  if (ctlInbox.length) {
    // 带上类型：这条日志是"闸真的拦到了东西"的唯一证据（哪一条都不该被静默丢掉）。
    bootFact(`ctl 启动闸：放行 ${ctlInbox.length} 条在脚本求值期间到达的消息` +
      `（${ctlInbox.map((m) => m.type || "?").join("、")}）`);
  }
  for (const m of ctlInbox.splice(0)) dispatchCtl(m);
}
ctl.onmessage = (ev) => {
  const m = ev.data || {};
  if (!ctlBootReady) { ctlInbox.push(m); return; }
  dispatchCtl(m);
};
function dispatchCtl(m) {
  // Go 推来的**观测**消息（hook / 会话登记表 / 转录）都走这条通道 ——
  // 它们和 tab.ok 是同一根流上的两类东西：一类是应答（tab.ok），
  // 一类是"它自己说它在干什么"（下面四种）。分发出去，各自归档。
  switch (m.type) {
    case "tab.ok": {
      // 配对**只认令牌**（见 spawnTab 上面那段）：顺序猜法在 burst + 重试的队列上
      // 会整体错位一格。对不上就大声说 —— 静默丢一条 tab.ok 的表现是
      // "这一格永远没有 PTY"，而那种幽灵格最难查。
      const w = spawnWaiters.get(m.req);
      const t = w ? w.t : null;
      if (!t) { ctl.send({ type: "log", msg: `tab.ok 的令牌 req=${m.req} 对不上任何还在等的格子，忽略（tab=${m.tab}）` }); return; }
      /* C2：Go **拒绝**了这次启动（护栏见 main.go / resume.go）。它没有建标签，
         所以 tab=0、stream 空。
         ⚠️ 这里**只记不做收尾**：撤格子和弹提示都交给 createTab 在 `await
         spawnTab(T)` 之后统一做。原因很实在 —— createTab 在那个 await 后面还要
         建流（`Stream(streamName)`）、挂 addon、设 T.stream，在这里就把格子拆掉的话，
         那些代码会对着一个已经消失的格子继续跑，等于造出一个"看起来在跑、
         其实没有 PTY、流还连着一个不存在的名字"的幽灵格。 */
      if (m.err) {
        // `retryable` 由 Go 给（见 resume.go）—— 前端**不许**拿 code 去查表：
        // "能不能再试一次"是判决的一部分，只有做判决的那一侧知道。
        t.resumeRefused = {
          code: m.err, msg: m.msg || "", msgCode: m.msgCode || "",
          msgParams: m.msgParams || null, retryable: m.retryable === true,
        };
        if (m.pane) t.paneID = m.pane;
        t.onSpawned = null;
        sendCtrl({ type: "log", msg: `接上被拒 code=${m.err} retryable=${m.retryable === true} msg=${m.msg} spec=${JSON.stringify(t.spec)}` });
        w.done("");
        return;
      }
      t.id = m.tab;
      t.streamName = m.stream;
      // 这一格的进程是这一刻起的：转录里比它早、还挂着的工具调用（上一个进程问到一半的问题 / 批准框）
      // 已经随那个进程作废了，不能再算「在等你」（见 22-live.js 的 pendingTool）
      liveOf(m.tab).bornAt = Date.now();
      if (m.pane) t.paneID = m.pane;
      // Go 会把无项目格的空 cwd 换成默认工作区根目录 —— 左栏归属和标题里的
      // 目录提示都要用**生效后**的那个（见 ctl handlers_tabs.go 的 tab.ok）。
      if (typeof m.cwd === "string" && m.cwd) t.spec.cwd = m.cwd;
      t.onSpawned = null;
      /* 2026-10-17：id 到了 = 这一格正式出现在左栏（行 = agent）。必须**在这里**
         重画一次 —— 建格时 id 还是 0（不在模型里），只等下一次状态推送的话，
         新 agent 会有一两秒"看不见"（而它可能正是用户刚点 + 要用的那个）。 */
      deskSoon("rail");
      w.done(m.stream);
      return;
    }
    case "pane.mismatch": {
      /* 步 5 的落点在屏幕上（步 6）：Go **在运行中**发现"请求接回的那条会话
         不是实际起来的那条"（判据见 main.go 的 judgeResume）。它到得比
         SessionStart 还晚（那正是判据本身），所以这一格早就建好了 ——
         找格子的钥匙只能是 paneId，**不是 tab id 也不是会话 id**：
           · tab id 每次启动重发，Go 那边算的时候是对的、到达时可能已经变了；
           · 会话 id 正是这件事有争议的那个东西。
         找不到就只记一行（用户可能已经把这一格关掉了）——绝不新建、绝不猜测。 */
      const p = m.pane | 0;
      const tab = TAB_LIST.find((x) => x.spec && x.spec.paneId && x.spec.paneId === p) || null;
      if (!tab) {
        sendCtrl({ type: "log", msg: `续接落空横幅：pane=${p} 已经不在界面上了（用户关掉了？），只落日志` });
        return;
      }
      showCellBanner(tab, {
        kind: "mismatch",
        // 屏幕上这一行只留"最该看见的那半句"；哪两个 id、claude 报了什么，进 title
        // （窄格子里放不下，而放不下的部分被省略号切掉时，留在开头的那半句才是要点）。
        text: t("pane.mismatch.text"),
        sub: t("pane.mismatch.sub", {
          want: m.want,
          got: m.got,
          source: m.source || t("pane.mismatch.notReported"),
        }),
      });
      return;
    }
    case "titles": {
      /* Go 把**权威的那份名字表**推回来 —— 只在它写盘失败时发（见 main.go 的
         title.set）。改名那条路是乐观更新的（先把界面改了、再落盘），所以
         "盘上没写成"必须有一条回来的路，否则界面会一直挂着一条盘上不存在的名字，
         下次打开又变回去 —— 那种"我明明改过"的悬案最难查。
         整份替换（不是打补丁）：那份表就是唯一事实，推来的就是它的全部。 */
      STATE.titles = m.titles || {};
      bootFact(`名字表被 Go 纠正：${Object.keys(STATE.titles).length} 条（改名的落盘没成）`);
      deskSoon("titles");
      return;
    }
    case "panes.list": {
      /* 冷恢复清单到了（见上面 askRestorePlan）。**只接住、只打事实** ——
         按它建格是步 4，这一步先把"算出来的"和"收到的"对上：
         Go 那边打一条 `[panes] 冷恢复：N 条候选（ok=… no_session=… no_id=… dup=…）`，
         这里打同一组数；两条对得上，才说明这份清单没在线上走样。 */
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
      RESTORE.panes = Array.isArray(m.panes) ? m.panes : [];
      RESTORE.err = m.err || "";
      RESTORE.state = m.err ? "failed" : "ready";
      /* Agent 名单：建第一格之前就要知道默认是谁（见 30-pages 的
         defaultAgentId）。它和总览的 catalog 是同一份 Go 探测结果。 */
      BOOT_AGENTS = Array.isArray(m.agents) ? m.agents : [];
      BOOT_DEFAULT_AGENT = typeof m.defaultAgent === "string" ? m.defaultAgent : "";
      if (!CATALOG.length && BOOT_AGENTS.length) setCatalog(BOOT_AGENTS, "冷恢复应答");
      // 项目名单（不带统计）跟着冷恢复清单先到：台面起来就要它；完整的 pool 推送随后覆盖。
      if (Array.isArray(m.projects) && !(STATE && Array.isArray(STATE.projects) && STATE.projects.length)) {
        STATE = STATE || {};
        STATE.projects = m.projects;
        if (typeof m.poolRev === "number") STATE.poolRev = m.poolRev;
      }
      const installed = BOOT_AGENTS.filter((a) => a && a.installed).length;
      const launchable = BOOT_AGENTS.filter((a) => a && a.installed &&
        a.caps && a.caps.launch).length;
      bootFact(`Agent 名单：${BOOT_AGENTS.length} 个（已安装 ${installed}、可启动 ${launchable}）；` +
        `设置默认=${BOOT_DEFAULT_AGENT || "(自动)"}`);
      /* 「已关闭」那几条**不占座位**（awaitRestorePlan 会滤掉），但用户上次关掉的
         agent 还得在工作区里看得见、点得回来 —— 在这里重建那份薄快照。 */
      CLOSED_PANES.clear();
      for (const p of RESTORE.panes) {
        if (!p.closed || p.group) continue;   // Bot 格不进 Workspaces 的「已关闭」
        CLOSED_PANES.set(p.paneId | 0, {
          paneId: p.paneId | 0, agent: p.agent || "claude", cwd: p.cwd || "",
          sessionId: p.sessionId || "", lastSeenAt: p.lastSeenAt || "", name: "",
          // 盘上还有没有它上次那条会话（Go 现算的）。没有的话，那一行先说
          // 「接不上」并把原因写进 title —— 别等用户点下去才吃一句莫名其妙的报错。
          onDisk: !!p.onDisk, spoke: !!p.spoke, talked: !!p.talked,
        });
      }
      bootFact(`冷恢复：${RESTORE.panes.length} 条候选（ok=${restoreCount("ok")} ` +
        `no_session=${restoreCount("no_session")} no_id=${restoreCount("no_id")} ` +
        `dup=${restoreCount("dup")} closed=${restoreCount("closed")}）${RESTORE.err ? " err=" + RESTORE.err : ""}`);
      if (CLOSED_PANES.size) {
        bootFact(`冷恢复：「已关闭」${CLOSED_PANES.size} 个 agent 只列表、不拉起 —— ` +
          closedList().map((r) => `pane=${r.paneId}(${r.agent} sid=${(r.sessionId || "无").slice(0, 8)}` +
            `${r.sessionId && !r.onDisk ? " 盘上无文件" : ""})`).join(" "));
      }
      // 左栏这时候可能已经画过一遍了（启动顺序不保证）—— 让它跟上。
      deskSoon("rail");
      if (RESTORE.panes.length) {
        // 座位序 + 每一格的身份（步 4 要照着它建）。dup 那几条也在里面：
        // 前端得说得出"这一条为什么没有座位"。
        bootFact("冷恢复清单：" + RESTORE.panes.map((p) =>
          `pane=${p.paneId}:${p.verdict}(${p.agent}→${p.resume ? p.resume.kind : "?"} cwd=${p.cwd || "(默认)"})`).join(" "));
      }
      return;
    }
    case "pane.closed": {
      // 关格时前端乐观补的那一行，只有 Go 真的留下了记录才该存在；
      // 从没发过提示的格子 Go 会直接摘掉，这里把那一行撤回。
      const pane = m.pane | 0;
      if (!m.kept || !m.found) {
        CLOSED_PANES.delete(pane);
        deskSoon("rail");
        return;
      }
      // 记录留下了：这一行从"正在关"变成可接。名字/会话 id 已经在乐观行里，
      // 下一次 panes.list（重启）会用后端的事实覆盖。
      const keep = CLOSED_PANES.get(pane);
      if (keep) {
        keep.closing = false;
        keep.optimistic = false;
        deskSoon("rail");
      }
      return;
    }
    case "hook":  applyHook(m);  return;
    case "agent": applyAgent(m); return;
    case "acts":  applyActs(m);  return;
    case "files": applyFiles(m); return;
    // 右栏「文件」：fs.list / fs.read 的应答，fs.err 是两条共用的错误通道
    // （护栏、目录没了、文件不是普通文件…）。实现和渲染都在 83-files.js。
    case "fs.list": if (typeof applyFsList === "function") applyFsList(m); return;
    case "fs.read": if (typeof applyFsRead === "function") applyFsRead(m); return;
    case "fs.err":  if (typeof applyFsErr === "function") applyFsErr(m);  return;
    // 文件预览「改动」页：按需取这一格记到的 diff 正文（见 transcript.go 的 trace.diff）。
    // 台面「选文件夹」窗口：子文件夹清单（31-desk-projects.js）
    case "dir.browse": if (typeof applyDirBrowse === "function") applyDirBrowse(m); return;
    case "diff":    if (typeof applyTraceDiff === "function") applyTraceDiff(m); return;
    case "state": applyLibrary(m.state); return;
    // 安装器：start / log / phase / done 四条；done 里也带一份重扫过的 catalog。
    case "install.start":
    case "install.log":
    case "install.phase":
    case "install.done": if (typeof applyInstall === "function") applyInstall(m); return;
    // 设置 › 模型提供商 / Agents（85b-providers.js）。视图里没有任何密钥。
    case "providers": if (typeof applyProviders === "function") applyProviders(m); return;
    case "provider.result": if (typeof provResult === "function") provResult(m); return;
    case "botgroups": if (typeof applyBotGroups === "function") applyBotGroups(m); return;
    case "botgroup.event": if (typeof applyBotGroupEvent === "function") applyBotGroupEvent(m); return;
    case "botgroup.result": if (typeof botGroupResult === "function") botGroupResult(m); return;
    // Bot Group C：Go 的投递（前端只执行：对方空闲时粘贴，送完回执 bg.delivered）、任务账本的变化
    case "bg.deliver": if (typeof bgDeliverFromGo === "function") bgDeliverFromGo(m.delivery); return;
    case "task.update": if (typeof bgTaskUpdate === "function") bgTaskUpdate(m); return;
    case "provider.test": if (typeof provTestResult === "function") provTestResult(m); return;
    case "provider.detected": if (typeof provDetected === "function") provDetected(m); return;
    case "pane.model": if (typeof applyPaneModel === "function") applyPaneModel(m); return;
    case "catalog":
      if (m.catalog) setCatalog(m.catalog, "catalog 推送");
      return;
    // 项目池（左栏那一轮）。它和 state 是两回事：state 是"扫出来的会话库"，
    // 这一条是"用户声明的项目池 + 归属"。分开发的理由和三条腿分开是同一条 ——
    // 池子只在动作时变（低频、全量），会话库每关一格就要重扫。
    // 写操作的轻量回执先到，全量 pool 由后台统计随后补上；选择器则是
    // project.picked 一条独立应答，不再搭 pool 的车。
    case "pool":  applyPool(m);  return;
    case "project.picked":
      if (typeof bgFolderPicked === "function" && bgFolderPicked(m)) return;
      if (typeof projectPickedArrived === "function") projectPickedArrived(m);
      return;
    case "project.result":
      if (typeof projectResultArrived === "function") projectResultArrived(m);
      return;
    // 设置（Perch 自己的偏好）。shell 首帧里也带一份，之后每次改动 Go 都推整份；
    // 默认目录选择器是协程里推的，所以它和 settings.set 的答复走同一条消息。
    case "settings": {
      // 默认目录的提交错误就地显示在输入框下面，不再弹 toast（85-settings.js）。
      const inline = typeof settingsMessageArrived === "function" && settingsMessageArrived(m);
      if (m.err && !inline) showToast(t("ctl.settingsFailedTitle"), tMsg(m.errCode, m.errParams, m.err), "err");
      if (m.osBuild && typeof setOsBuild === "function") setOsBuild(m.osBuild);
      if (m.settings) {
        applySettings(m.settings, {
          fromGo: true,
          effectiveCwd: m.cwd,
          builtinCwd: m.builtinCwd,
          defaultCwdMissing: m.defaultCwdMissing === true,
        });
      }
      return;
    }
    // 工作区共享 brief：get/set 的应答走同一条；编辑卡在 81c-workspace-brief.js。
    case "workspace.brief":
      if (typeof briefMessage === "function") briefMessage(m);
      return;
  }
}
ctl.onerror = () => { ctlReady = false; };

// 页面级日志走这条通道。它比任何标签流命都长 —— 页面刚起来、一个标签都还没有
// 的时候也能落日志（C1 重构期间就是靠这一点看见"前端到底跑到哪一步了"）。
function sendCtrl(obj) {
  if (!ctlReady) return;
  try { ctl.send(obj); } catch (e) { jserr("sendCtrl", e); }
}

// 建标签早期（term.open 前后）想留一条事实时用它：那时标签自己的 sendCtrl
// 还没就绪（它挂在 await 之后），而页面级通道可能也还没连上 —— 没连上就先攒着。
// 当前唯一调用点是 renderGrid() 里那条网格形状探针 —— 它正好落在
// "**第一个**标签还在模块求值期间同步建出来"的那段里，那时 ctlReady 必然是 false。
// 教训：**在模块求值路径上，页面级 sendCtrl 是一条会静默吞掉消息的通路**，
// 它只适合放在事件回调（onopen 之后）里。
function bootFact(msg) {
  if (ctlReady) { try { ctl.send({ type: "log", msg }); return; } catch (e) {} }
  window.__facts.push(msg);
}
