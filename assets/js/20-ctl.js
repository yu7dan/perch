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

   现在 × 发 `pane.close`：Go 把记录打上 `closed`，**不删**；重启时它不占座位
   （不自动拉起），只在左栏工作区里留一行「已关闭」，点一下用**同一个 paneId**
   接上原来那条会话。真正删记录的只有「结束这个 agent」。

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
  CLOSED_PANES.set(pane, {
    paneId: pane,
    agent: (t.spec && t.spec.agent) || DEFAULT_SPAWN_SPEC.agent,
    cwd: (t.spec && t.spec.cwd) || "",
    sessionId: t.sessionID || (t.spec?.resume?.kind === "exact" ? t.spec.resume.id : "") || "",
    lastSeenAt: new Date().toISOString(),
    name: agentRowName(t),
    // 盘上有没有会话文件：关格这一刻不知道（零轮次的会话本来就没有），
    // 交给"点下去被 unavailable 拒了"或下一次冷恢复去判定 —— 不猜。
    // `spoke` 只是一个**措辞用**的近似（会话在库里 ≈ 说过话）；判定接不接得上
    // 永远只看 onDisk。
    spoke: !!(t.sessionID && findSess(t.sessionID)),
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
  return r.name || "已关闭的 agent";
}
function closedMatch(r, key) {
  if (!key) return true;
  return `${closedRowName(r)} ${r.agent || ""} ${r.cwd || defaultWorkspacePath()}`
    .toLowerCase().includes(key);
}
function closedInProject(p) {
  const path = typeof p === "string" ? p : (p && p.path);
  const defPath = defaultWorkspacePath();
  return closedList().filter((r) => insidePath(r.cwd || defPath, path));
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
  const head = r.spoke
    ? "它上次那条会话文件已经不在盘上了（可能被删了，或者在别的机器上）。"
    : "它上次没说过话 —— 零轮次的会话在盘上本来就没有文件，所以没有内容可接。";
  return head + " 这个 agent 的记录还在，这一行也留着 —— "
    + "可以右键「在这个工作区新开一个 agent」，或者选「结束这个 agent」把它清掉。";
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
  return {
    agent: v.agent,
    cwd: v.cwd || "",
    resume: v.resume || { kind: "new", id: "" },
    paneId: v.paneId,
    restored: true,
    verdict: v.verdict || "",
    spoke: !!v.spoke,
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
   红条 `applyMagpie is not defined` 的根因就在这里。两条事实拼在一起：

     ① index.html 里那一串 defer 脚本是**按文档顺序、一块一块求值**的，而浏览器
        在块与块之间可以让出事件循环 —— 网络消息会落在"后面的脚本还没求值"的缝里；
     ② 这条 ctl 流在 20-ctl 求值时就建好了（`const ctl = JSONStream("ctl")`），
        而分发要用到的处理函数散在后面的文件里：applyHook/applyAgent/applyActs/
        applyFiles/applyLibrary 在 80-live，MAGPIE 在 85-dash，applyInstall 在
        86-install，applyMagpie/applyGw* 在 87-gw-apply。

   哪一条消息会先到不由我们决定：magpie watcher 每 2.5s 推整份读数（Go 的
   `startMagpieWatcher` 在开窗之前就起了），沙盒里会话库很小的时候 shell 首帧
   也会在几十毫秒内回来。于是一条 `magpie` 落在 87 求值之前，就是一条红条；
   一条 `hook` 落在 80 之前，就是 `applyHook is not defined` —— 同一类病。

   ⚠️ 修法**不是**在每个 case 里加 `typeof` 守卫：
     · `MAGPIE` 是 85 才声明的 `let`，TDZ 里连 `typeof MAGPIE` 都会抛
       （60-shell.js:462 那条注释记的就是这个教训）；
     · 守卫会把消息**当场丢掉** —— 丢一条 `panes.list` 等于这一轮冷恢复不恢复，
       丢一条 `magpie` 就要等下一次推送才画得出来。
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
        t.resumeRefused = { code: m.err, msg: m.msg || "", retryable: m.retryable === true };
        if (m.pane) t.paneID = m.pane;
        t.onSpawned = null;
        sendCtrl({ type: "log", msg: `接上被拒 code=${m.err} retryable=${m.retryable === true} msg=${m.msg} spec=${JSON.stringify(t.spec)}` });
        w.done("");
        return;
      }
      t.id = m.tab;
      t.streamName = m.stream;
      if (m.pane) t.paneID = m.pane;
      t.onSpawned = null;
      /* 2026-10-17：id 到了 = 这一格正式出现在左栏（行 = agent）。必须**在这里**
         重画一次 —— 建格时 id 还是 0（不在模型里），只等下一次状态推送的话，
         新 agent 会有一两秒"看不见"（而它可能正是用户刚点 + 要用的那个）。 */
      armRailRebuild();
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
      const t = TAB_LIST.find((x) => x.spec && x.spec.paneId && x.spec.paneId === p) || null;
      const short8 = (s) => String(s || "").slice(0, 8);
      if (!t) {
        sendCtrl({ type: "log", msg: `续接落空横幅：pane=${p} 已经不在界面上了（用户关掉了？），只落日志` });
        return;
      }
      showCellBanner(t, {
        kind: "mismatch",
        // 屏幕上这一行只留"最该看见的那半句"；哪两个 id、claude 报了什么，进 title
        // （窄格子里放不下，而放不下的部分被省略号切掉时，留在开头的那半句才是要点）。
        text: `接上来的不是上次那条会话 —— 记录里那条 id 没改`,
        sub: `请求 ${m.want}（这就是记录里那条）· 实际 ${m.got}\n` +
             `claude 报的 source=${m.source || "(未报)"}；盘上那条会话一个字没动，下次重开还会再试它`,
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
      renderLists(searchKey());   // 正在编辑另一个名字时它自己会让开（见 renderLists 顶上那条闸）
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
      /* 「已关闭」那几条**不占座位**（awaitRestorePlan 会滤掉），但用户上次关掉的
         agent 还得在工作区里看得见、点得回来 —— 在这里重建那份薄快照。 */
      CLOSED_PANES.clear();
      for (const p of RESTORE.panes) {
        if (!p.closed) continue;
        CLOSED_PANES.set(p.paneId | 0, {
          paneId: p.paneId | 0, agent: p.agent || "claude", cwd: p.cwd || "",
          sessionId: p.sessionId || "", lastSeenAt: p.lastSeenAt || "", name: "",
          // 盘上还有没有它上次那条会话（Go 现算的）。没有的话，那一行先说
          // 「接不上」并把原因写进 title —— 别等用户点下去才吃一句莫名其妙的报错。
          onDisk: !!p.onDisk, spoke: !!p.spoke,
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
      armRailRebuild();
      if (RESTORE.panes.length) {
        // 座位序 + 每一格的身份（步 4 要照着它建）。dup 那几条也在里面：
        // 前端得说得出"这一条为什么没有座位"。
        bootFact("冷恢复清单：" + RESTORE.panes.map((p) =>
          `pane=${p.paneId}:${p.verdict}(${p.agent}→${p.resume ? p.resume.kind : "?"} cwd=${p.cwd || "(默认)"})`).join(" "));
      }
      return;
    }
    case "hook":  applyHook(m);  return;
    case "agent": applyAgent(m); return;
    case "acts":  applyActs(m);  return;
    case "files": applyFiles(m); return;
    case "state": applyLibrary(m.state); return;
    // 网关读数：shell 首帧里也带一份，之后由 Go 的 watcher 每 2.5s 推整份。
    case "magpie": applyMagpie(m.magpie); return;
    // 控制面：整份原生读数（网关页的 iframe 直接用 magpie 自己的界面，
    // 用量/账本/插件市场不再经过 Perch 中转）。
    case "gw": applyGw(m.gw); return;
    // 安装器：start / log / phase / done 四条；done 里也带一份重扫过的 catalog。
    case "install.start":
    case "install.log":
    case "install.phase":
    case "install.done": applyInstall(m); return;
    case "catalog":
      if (m.catalog) {
        if (MAGPIE) applyMagpie(Object.assign({}, MAGPIE, { catalog: m.catalog }));
        else {
          // 首帧快照还没到也别把安装结果丢掉：先画名单，整份快照到了再覆盖。
          MAGPIE = { catalog: m.catalog };
          if (NAV_HERE === "dash") renderDashAgents();
        }
      }
      return;
    // Agent 接线（agent_cfg.go）：整份 /api/state 的 agents 快照；预览是
    // 断开前那次 dry run 的答案。两类都只落进状态，由 88-agent-cfg.js 画。
    case "gw.agents": applyGwAgents(m); return;
    case "gw.agents.drift": applyGwAgentsDrift(m); return;
    case "gw.agent.preview": applyGwPreview(m); return;
    // magpie 本体的版本 / 更新（magpie_update.go）：只落状态，壳在 gw/00-frame.js。
    case "magpie.update": applyGwUpdate(m); return;
    // 项目池（左栏那一轮）。它和 state 是两回事：state 是"扫出来的会话库"，
    // 这一条是"用户声明的项目池 + 归属"。分开发的理由和三条腿分开是同一条 ——
    // 池子只在动作时变（低频、全量），会话库每关一格就要重扫。
    case "pool":  applyPool(m);  return;
    // 设置（Perch 自己的偏好）。shell 首帧里也带一份，之后每次改动 Go 都推整份；
    // 默认目录选择器是协程里推的，所以它和 settings.set 的答复走同一条消息。
    case "settings": {
      // 默认目录的提交错误就地显示在输入框下面，不再弹 toast（84-settings.js）。
      const inline = typeof settingsMessageArrived === "function" && settingsMessageArrived(m);
      if (m.err && !inline) showToast("设置没保存", m.err, "err");
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

// ---------------------------------------------------------------------------
// 标签条
//
// **渲染 = 把已有的 .tab 元素按模型顺序重新 append**，不重建 DOM。
// 重建会有一个很难查的后果：重命名时 .nm 被换成了输入框，重建等于把用户
// 正在打的字连输入框一起删掉。标签元素由 createTab 建一次，归属它自己。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 网格形状（C4.5）—— 从 ceil(sqrt(N)) 换成**按容器实测推导**
//
// 老规则是「正方形」启发式：1→1、2→2、3~4→2、5~9→3。它的问题不在结果，
// 在**依据**：格子是 8×18 的竖长格（字宽 : 行高 ≈ 1:2.25），一个"每格接近
// 正方形"的网格，等于每格的**行数**只有列数的三分之一 —— 而 claude 的 TUI
// 是横着排版的，它先缺行、后缺列。所以"方形"从来不是这个问题的正确目标。
//
// ⚠️ 先说清楚**Orca 没有回答这个问题**，别以为这里有现成的答案可抄：
//   - `pane-fit-measurability.ts:8-11`：MIN_PANE_FIT_{WIDTH_PX,HEIGHT_PX,COLS,ROWS}
//     = 48/24/8/4，低于它**拒绝 fit**，注释理由是防止 "Fitting there pins the
//     PTY at ~2 cols" —— 它保证的是"不把不可信的尺寸推给 PTY"（= 我们的 boxOk()），
//     **不是**"每一格都好看"。
//   - `terminal-grid-size-for-box.ts:2`：MINIMUM_COLS = 2，直接抄 xterm FitAddon。
//   - `pane-divider-drag.ts:16`：拖动下限 MIN_PANE_SIZE = 50(px)，而且
//     `effectiveMinPaneSize = Math.min(50, totalSize/2)` —— 总宽不够两个 50 时
//     **自动让路**（否则算出负 flex）。
//   ⇒ Orca 把"切成多小"完全交给用户的手（它默认是手工分屏）。我们既然是
//     **自动**成网格，就必须自己定这条规则 —— 这段就是它。
//
// 列数：ceil(sqrt(N))。**这条一个字都没改** —— 1→1、2→2、3~4→2、5~9→3，
// 先并排、排满一行再下一行。
// ⚠️ 2026-10-15 我一度把它换成"按容器实测挑最平衡的摆法"，结果 N=2 排成了
// **上下叠**（1×2）—— 用户在它出现的那一刻就否了：并行就是先并排，像之前那样。
// 教训记在这儿别再走一遍：**"每格列数最多"不是个好目标**（叠起来每格 111 列、
// 并排 54 列，比列数它赢），而 claude 的介绍框宽度固定 ~65 字符，多出来的列
// 全是空的；可它错得不像"少两列"那么无害 —— 它把**并排**变成了**上下叠**，
// 那是产品形态，不是布局细节。布局这一层不许自己改。
//
// 这里原先还有两个 JS 常量（CELL_HEAD_H / GRID_GAP_PX），是给"每格能排下多少
// 列多少行"用的。那个读数算错过（见下），两个常量就一起删了 —— 间距的唯一
// 定义回到 CSS 的 `gap: var(--grid-gap)`，不再有一份必须"记得同步"的影子副本。 */

// ⚠️ 这里**故意没有**"一个格子里能排下多少列多少行"这种函数 —— 我写过一个，
// 拿它算出"每格 34 列"写进日志，而真值是 54。错因不是公式，是**调用时机**：
// renderGrid 跑的时候主区宽度还没被折成列数。
// 教训：**在"摆法"这一层只允许出现 N 的纯函数**（下面的 gridCols 就是），
// 凡是需要量容器的数，都放到布局稳定之后、由真正负责渲染的那个人去报。
function gridCols(n) { return Math.max(1, Math.ceil(Math.sqrt(n))); }

// 摆法：**只算列，不算别的**。rows 是 N 摊到列数上的结果，不是另选的参数。
//
// 这里**故意不量容器**：早先它顺手把"每格可用宽高"也算了（bw/bh）并写进日志，
// 结果是错的 —— renderGrid 里那一刻主区宽度还没落地（见上面那段注释），
// 量到的是变宽之前的中间态。既然这个数不可信，就别让它存在：
// 要每格多大，去读各格自己 fit 完报的 `[web tN] fit=WxH`。
//
// ⚠️ 2026-10-17 试过一版"多了先改摆法、超限再降字号"（用户当时挑的 C 方案）：
//    网格区 848×840 下 8 格变成 **2×4 每格 50×11**，替掉原来的 3×3 每格 32×15。
//    字节上都对（实测日志：`网格 N=8 摆法=2×4 字号=14 预计每格=50×11`
//    ↔ 各格 `fit=50x11`），但**用户看过实际效果后否了** —— 换来的宽度不值那些
//    高度：2×4 每格只剩 11 行，claude 的开场框直接被切掉。整段已撤回，规则回到
//    下面这条 N 的纯函数、字号永远 14。
//    （否掉的是**这条规则**，不是"这些数得实测"那个教训 —— 那一次量出来的
//     字格 8.0px（14px 字号）/ 行高 16.5px、每格被吃掉 4+14(横) / 22+4(纵)、
//     以及"claude 那条状态行要 51 字符"这些数以后真要量"每格能排下多少字"时
//     可以直接用，别再量一遍。）
function gridShape(n) {
  const cols = gridCols(n);
  return { cols, rows: Math.ceil(n / cols) };
}

/* 只写"列数"决定的那两样东西：--gcols 和最后一行的跨度。
   C5：独立页视图下 --gcols 必须是 1 —— 别的格虽然 display:none（不参与布局），
   但"可见的那一格占几列"仍然由 --gcols 决定：3 列的网格里只放一个 1 跨的格子，
   它只会拿到 1/3 宽。

   最后一行的空格子**必须填掉**，理由比 C4 时更硬：网格底色现在是 #3f3f46
   （隔离线那一层），留一个空槽就是**一块实心灰**，比 C4 时那块"看着像坏了"的
   #151515 更刺眼。做法：最后一行的 k 格按比例吃掉整行的列（cols=3、k=2 → 2+1；
   k=1 → 整行）。余数给**最后一格**。

   ⚠️ 抽成函数只是为了给这两样东西一个名字（早先那套"摆法按容器改判"会调它
   两次，2026-10-17 跟着整段撤了）：现在整份文件里只有 renderGrid 一个调用点。 */
function applyGridCols(n, cols) {
  $("termbody").style.setProperty("--gcols", String(soloTab ? 1 : cols));
  const lastRow = n % cols === 0 ? cols : n % cols;
  const each = lastRow > 0 ? Math.floor(cols / lastRow) : cols;
  TAB_LIST.forEach((t, i) => {
    const k = i - (n - lastRow);              // 本行第几格（0 起；负数=不在最后一行）
    let span = 1;
    if (!soloTab && n > 1 && lastRow < cols && k >= 0) {
      span = k === lastRow - 1 ? cols - each * (lastRow - 1) : each;
    }
    // 用行内样式而不是 class：class 没法带数值，而这里的跨度是算出来的。
    // 置空是必须的 —— 网格会自动把"上一轮的 span"继承下来（元素没换）。
    // ⚠️ 独立页视图下**所有**格子都要置空：被拎出去那格若留着上一轮的 span，
    // 回到网格时它会先按错的跨度渲染一帧（布局抖动，截图看得出来）。
    t.cellEl.style.gridColumn = span > 1 ? `span ${span}` : "";
    t.cellEl.classList.toggle("solo", t === soloTab);
  });
}

// 网格重排。**只动容器上的一个变量**，格子元素由 createTab 建、归属它自己
// （重命名会把 .nm 换成输入框，重建 DOM 等于把用户正在打的字一起删掉）。
function renderGrid() {
  const n = TAB_LIST.length;
  const tb = $("termbody");
  // 摆法是 **N 的纯函数**（见上面 gridShape 那段）：不量容器、不看字号、也没有
  // 第二份状态。要每格多大，去读各格自己 fit 完报的 `[web tN] fit=WxH`。
  const shape = gridShape(n);
  // 压暗只对"多个格同时可见"成立（独立页上只有一个格，压暗它自己没道理）。
  tb.classList.toggle("multi", n > 1 && !soloTab);
  tb.classList.toggle("solo", !!soloTab);
  applyGridCols(n, shape.cols);

  const cnt = $("pn-cnt");
  if (cnt) cnt.textContent = String(n);
  // 群组那一屏的"座位"跟着网格模型走（多一格/少一格/换了当前格），所以在这里
  // 补一次。它是"一帧一次"的（scheduleGroup 自己挡），收起时才真的干活 ——
  // 启动路径上 createTab → renderGrid 会跑到这一句，那时 collapsed 还是 false，
  // 直接返回（这也是那批声明必须写在启动之前的原因，见 RSB_READY 那一块）。
  scheduleGroup();
  // C6a：这里原来还有一句 `applyPaneColsForCells()` —— 格数变了就把"每格多少列"
  // 这个用户偏好重新折成主区宽度。现在**没有这个动作了**：
  //   主区宽度只由"窗口 − 左栏 − 右栏"决定，格数变不改变它，只改变它怎么分
  //   （cols = ceil(sqrt(N))）。宽度一变，各格自己的 ResizeObserver 就醒了，
  //   各自 refit —— 不需要谁来"按 N 折一遍"。
  // 顺带，C5 那条"独立页视图下故意不碰主区宽度"的顾虑也一起消失：
  // 拎进拎出时本来就没人会去改主区宽度。
  paintGridStatus();
  /* 探针：**摆法是算出来的、屏幕上看不出它凭什么这么算**，所以回一条。
     ⚠️ 这条只报**renderGrid 自己能确定的三件事**：几格、摆法、容器多大。
     - **不报"每格多少列"**：这个数要等各格 fit 完才成立（C6a 之前还要等主区
       宽度落地），而且"每格"这个概念在 N=1 时根本没意义。每格真实的列×行由它
       自己 fit 完报的 `[web tN] tab=N fit=WxH` 给，那一条才是权威（实测过：
       N=2 容器 906 → 每格 54 列；N=1 容器 673 → 81 列。都对得上）。
     - **不报字格**：那条要么量的是"当前这一格"（renderGrid 跑的时候可能还没有
       当前格），要么落到 8×18 的估数上 —— 屏幕上显示的 18 跟真实的 16 不一样，
       等于往探针里塞了一个假的测量值。字宽/行高、DPI、字体这些"渲染是否正常"的
       事实在 `fontprobe` / `canvas dpr` 两条里各有一份真的，别在这儿重复。
     ⚠️ 容器走 rAF 再量：不是因为它现在量错（实测 673/906 都对），而是因为
     网格样式（--gcols / span）是**同一帧里**刚写上去的，等一帧再读永远比
     抢在布局中间读稳。摆法是 N 的纯函数，不用等，先取值带进闭包。
     ⚠️ 必须走 bootFact 而不是 sendCtrl：**第一个标签是在模块求值期间同步建出来的**
     （顶层 `await createTab(...)` 的第一个 await 之前那段），而 ctl 通道要等
     模块求值让出主线程之后才会 onopen —— 那一刻 ctlReady 还是 false，
     页面级 sendCtrl 会**静默 return**（`if (!ctlReady) return;`）。
     这正是这条日志第一次跑就消失的原因，也正是本文件里 bootFact 存在的原因
     （它自己那段注释说"现在没有调用点了" —— 现在又有了）。 */
  const soloId = soloTab ? soloTab.id : 0;
  requestAnimationFrame(() => {
    /* 等一帧再量容器**只为了报数**（容器尺寸 + 关格坐标）：摆法是 N 的纯函数，
       不用等布局；这里要避开的只是"抢在布局中间读宽度"（2026-10-15 那次翻车就是
       这个原因，见上面 gridShape 那段注释）。 */
    const W = Math.round(tb.clientWidth), H = Math.round(tb.clientHeight);
    const 摆法 = soloId ? `独立页(tab=${soloId})` : `${shape.cols}×${shape.rows}`;
    // C3 验收要按"结束这一格"的 ×（`.cellhead .x`），而它**每一格都在不同位置**、
    // 而且 N 一变就整体重排 —— 把 N=1 那次量的坐标拿去点 N=2 的格子就是目测。
    // 所以坐标跟着布局事实一起报：重排一次就有一行新的、可直接用的数。
    const 关格 = TAB_LIST.map((t, i) => {
      const el = t.tabEl && t.tabEl.querySelector(".x");
      if (!el) return `#${i + 1}=?`;
      const b = el.getBoundingClientRect();
      // 报**序号**而不是 `t.id`：第一帧布局时标签 id 还没从 ctl 回来（那时是 0），
      // 报出来就是 `t0` —— 一个会骗人的名字（我自己就被它绕了一下：
      // N=1 那行的 `t0` 是"还没拿到 id 的第一格"，不是"id 为 0 的格子"）。
      // 序号和网格里的位置一一对应，也就是"该点哪一颗"。
      return `#${i + 1}=${Math.round(b.left + b.width / 2)},${Math.round(b.top + b.height / 2)}`;
    }).join(" ");
    bootFact(`网格 N=${n} 摆法=${摆法} 容器=${W}×${H} 关格 ${关格}`);
  });
}

