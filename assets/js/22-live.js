"use strict";
/* 22-live.js —— 每一格的实时读数：壳层载荷、hook / 登记表 / 转录三条腿、「需要你」的判定。
   2026-11-08 从 80-live.js 原样切出（旧外壳的菜单、右栏模块、需要你浮层随旧外壳一起退役；
   判据一个字没改）。画法在台面那边（30-desk.js 读 cellState / needModel）。 */

// 壳层数据：一次性推完就关，所以拿到即渲染
const shell = Stream("shell");
/* 启动闸（和 20-ctl.js 的 ctlInbox 是同一条理由）：
   这条流在**本文件求值时就建好了**，而 handleShell 是"连上就同步扫一遍、
   马上 Send"（main.go:1601）—— 会话库很小的时候（比如验收用的沙盒），
   载荷几毫秒就回来，落在后面的文件还没求值的那条缝里（当年的红条就是
   `applyMagpie is not defined`，网关已于 2026-10-28 拿掉）。
   启动期间先收住这一帧，99-boot 打开 ctl 启动闸时按同一顺序补画。 */
let pendingShell = null;
function applyShell(p) {
  STATE = p;
  sbar("s-index").textContent = t("status.index", {
    sessions: STATE.sessions?.length ?? 0,
    projects: (STATE.projects || []).filter((p) => p && !p.synthetic).length,
  });
  // 设置随首份载荷一起到（settings.go）。权威值一到就覆盖 localStorage 那份缓存；
  // 终端已经按缓存里的字体/字号建好了，这里再把它们校正到盘上的值。
  if (STATE.osBuild && typeof setOsBuild === "function") setOsBuild(STATE.osBuild);
  if (STATE.settings) {
    applySettings(STATE.settings, { fromGo: true, effectiveCwd: STATE.cwd });
  }
  // 本机 Agent 名单随壳层一起到；安装 / 接入状态之后由 catalog 推送更新。
  if (Array.isArray(STATE.catalog)) setCatalog(STATE.catalog, "shell 载荷");
  renderShell();
  // 启动载荷是项目池最早到的那一份（冷启动约 20s）：在这之前打开的「新建 Bot Group」
  // 项目栏一直写着「先添加一个项目」，这里不通知它，它就永远停在那句上。
  if (typeof bgCreatePoolArrived === "function") bgCreatePoolArrived();
  /* ⚠️ 播种必须在**这条**流上也做一次（不只是 hook 绑上会话那一次）：
     启动的顺序是"先按冷恢复摆座位、再收到这份壳层数据"—— 也就是说 hook 绑上会话时
     （约 +1s）名字表**还是空的**（实测 2026-10-17 03:11:44：`名字播种：有身份的格 1、
     名字表 0 条`），名字是这份载荷（约 +3s）才到的。少了这一句，重开之后格子头
     就永远停在 agent 自己写的标题上，而左栏（读同一份 STATE.titles）已经是你起的名字。 */
  seedTabTitles();
  if (typeof renderAbout === "function") renderAbout();
  // 文件台账的分组依赖项目池，而壳层可能晚于第一份 files 到达（冷恢复 / 页面
  // 重载）。不在这里强制重画，第一帧会把项目内的文件缓存成「工作区外」，
  // 直到下一次文件变化或用户点刷新才恢复。83-files.js 可能还没求值完，先看函数。
  if (typeof renderFiles === "function") {
    try { renderFiles(true); } catch (e) { console.error("[perch] 文件栏重画失败:", e); }
  }
}
shell.onmessage = (ev) => {
  let p;
  try {
    p = typeof ev.data === "string" ? JSON.parse(ev.data) : JSON.parse(new TextDecoder().decode(ev.data));
  } catch (e) { console.error("[perch] 壳层数据解析失败:", e); return; }
  // 启动闸：这一刻 85/87 可能还没求值（见上面那段），先收住，等 99-boot 放行。
  if (!ctlBootReady) { pendingShell = p; return; }
  applyShell(p);
};
shell.onerror = () => { sbar("s-index").textContent = t("status.indexFailed"); };

/* C7：会话库刷新（关掉一格之后由 Go 重扫一次推回来，见 main.go 的 lib.reload）。
   ⚠️ **不走 renderShell**：那个函数是"页面刚起来时画骨架"的那条路 ——
   它会重报一遍启动探针、把下段切回启动态、重画工作区列表。
   拿它当刷新用，用户眼前的状态会被一起打乱；这里只换列表要用的那份数据，
   再让两张列表自己重画。
   ⚠️ 重画要**带上当前的搜索词**，否则用户正在过滤的时候关一格，
   过滤会莫名其妙地被清掉（高亮的不再匹配、列表突然变长）。 */
function applyLibrary(p) {
  if (!p || !Array.isArray(p.sessions)) return;
  STATE.sessions = p.sessions;
  // 左栏那一轮起：重扫也带上池子与归属（Go 侧是同一次 buildShellPayload 算的）。
  // 不跟着更新的话，新落盘的会话会归不进它该在的项目里 —— 而那正是"重扫"的用途。
  // 但整份载荷也会扫十几秒；若它手里的池子版本比刚到的 project.result 旧，
  // 只更新会话/历史，别把新的项目行覆盖回去。
  const poolStale = typeof p.poolRev === "number" &&
    typeof STATE.poolRev === "number" && p.poolRev < STATE.poolRev;
  if (!poolStale) {
    if (Array.isArray(p.projects)) STATE.projects = p.projects;
    if (p.assign && typeof p.assign === "object") STATE.assign = p.assign;
    if (typeof p.poolRev === "number") STATE.poolRev = p.poolRev;
    if (typeof bgCreatePoolArrived === "function") bgCreatePoolArrived();
  } else {
    sendCtrl({ type: "log", msg: `整份载荷的旧项目池跳过 rev=${p.poolRev} < ${STATE.poolRev}` });
  }
  STATE.history = p.history || STATE.history;
  // 标题也要换：用户刚改过的名字走的是 Go 那边 titles.json，不跟着刷新就一直旧着
  STATE.titles = p.titles || STATE.titles;
  if (Array.isArray(p.hidden)) STATE.hidden = p.hidden;
  // 总览的每日活动也在这份载荷里（同一次扫描算的，见 store.go 的 scanSessions）——
  // 不跟着换的话，"重扫会话库"之后热力图还是旧的。
  if (Array.isArray(p.activity)) STATE.activity = p.activity;
  // 设置也在这份载荷里（同一次 buildShellPayload）。重扫不该改设置，但
  // 手改过 settings.json 的人点一次「重扫」就能看到盘上的值 —— 顺手对齐。
  if (p.osBuild && typeof setOsBuild === "function") setOsBuild(p.osBuild);
  if (p.settings) applySettings(p.settings, { fromGo: true, effectiveCwd: p.cwd });
  if (Array.isArray(p.catalog)) setCatalog(p.catalog, "lib.reload");
  // 名字表变了，正在跑的那几格的格子头也得跟着换（谁后到都得对得上，见 seedTabTitles）
  seedTabTitles();
  // 左栏那张卡的对象是**上一次 payload 里的那个**了 —— 按 id 重新指到新的，
  // 否则下段讲的那条会话永远停在这一刻之前的内容上（selected 只按 id 比较，
  // 所以高亮不会掉，但对象本身是旧的）。
  if (selected) {
    const n = p.sessions.find((s) => s.id === selected.id);
    if (n) selected = n;
  }
  deskSoon("会话库刷新");
  // 总览正开着的时候，重扫要把它也刷新（读数、热力图、Agent 名单都读这份数据）。
  // 状态栏那行"索引：N 会话 / M 项目"每格都是现算的 —— 重扫之后要跟着换，
  // 否则用户点完「重扫会话库」，列表变了而底下那个数还是旧的（同一屏两句话）。
  sbar("s-index").textContent = t("status.index", {
    sessions: p.sessions.length,
    projects: (STATE.projects || []).filter((p) => p && !p.synthetic).length,
  });
  sendCtrl({ type: "log", msg: `会话库已刷新 会话=${p.sessions.length} 子代理=${p.sessions.filter((s) => s.sidechain).length}` });
}

/* ===========================================================================
   右栏四个「格子级」模块的汇流处（需要你 / 子代理 / 改动 / 流水）

   Go 那边三条腿已经在推消息了，这里只做一件事：**按格子归档**。
     {"type":"hook",  tab, event, ntype, msg, last, agent, agt, reason, source}
     {"type":"agent", tab, session, status:"busy"|"idle", name}
     {"type":"acts",  tab, items:[…]}   ← **增量**（新增 + 原地更新，前端按 id 覆盖）
     {"type":"files", tab, files:[…]}   ← **全量**（每次整体替换）

   ⚠️ 为什么不合成一条"状态"消息：三条腿的节拍和可靠度都不一样 —— hook 是事件
   驱动（只在事件上说话）、登记表是 700ms 轮询（说"忙/闲"）、转录是 400ms 跟随
   （说"动了什么"）。合成一条等于给最慢的那条腿定拍，而且一条腿哑了会连带把
   另外两条的正确读数一起抹掉。

   ⚠️「谁在等你」**必须两条腿合起来判**，这是这一段里唯一的推理，值得说清楚：
     只看 hook：Stop 只说明"这一轮说完了"，说明不了它**此刻**是不是还在等你
                —— 你可能已经回话了、它又在跑了。
     只看登记表：busy/idle 说明不了"它是刚说完在等你，还是你根本没让它开跑"。
   所以：hook 给事件和那句原话，登记表给"此刻忙不忙"，转录给"是不是挂着个问题"。

   ⚠️ 这里没有一处是"猜"的：三个输入都是实测过的（见 hooks.go / status.go /
   transcript.go 的文件头）。凭空推出来的状态比没有状态更糟 —— Orca 那条
   「从不从标题推状态、只信 hook 报的枚举」的原则，落到我们这里就是这一句。
   =========================================================================== */

// ⚠️ `LIVE` / `RSB_READY` / `liveRaf` / `liveTab` / 那一组 G_* 图标 path 都声明在
// **启动那一段之前**（见上面 RSB_MODS 那一块）—— 这里是它们的使用方，不是创建方。
// 这一条是实测踩出来的，别把声明挪回来。
function liveOf(tab) {
  let v = LIVE.get(tab);
  if (!v) {
    v = { st: "", state: "", evidence: "", name: "", at: "", note: null, wait: null,
          subs: [], files: [], acts: [] };
    LIVE.set(tab, v);
  }
  return v;
}
// 「挂着一条还没结果的工具调用」——**从流水里推**，不是另记一份状态：
// 工具调用先到（ok=null = 还在跑），结果到了同一条被原地更新成 ok=true。
// 所以往回扫到"最后一个你说的话"为止就够了，而且它**自己是会失效的** ——
// 不需要任何人去清理它（实测：中断那一下转录会落一条 `prompt [Request
// interrupted by user for tool use]`，扫到它就返回 null，正好把这条作废）。
//
// ⚠️ 2026-10-16 放宽：以前这里只认 `tool === "AskUserQuestion"`。但
// transcript.go:611 的 `it.OK = &ok` 是对**每一个**工具结果都写的 ——
// 权限框（PowerShell/Write…）挂着的时候，那条 tool_use 也一样是 ok==null。
// 实测两处：提问型（11:44:30 起）和批准型（12:43:38 `tool Write permtest file`）。
// 所以判据形状一字不改，只是**不再按工具名挑**，挑工具名是调用方的事。
function pendingTool(v) {
  if (!v) return null;
  for (let i = v.acts.length - 1; i >= 0; i--) {
    const a = v.acts[i];
    if (a.kind === "prompt") return null;      // 你已经回话了 ⇒ 挂着的那个作废
    if (a.kind === "tool") {
      if (a.ok != null) return null;
      // 冷恢复 / 原座位接上：上一个进程挂着的那条（实测重开后 Claude 屏上写的是 User declined to answer questions，
      // 转录里那条却永远没有结果）—— 比这一格的进程还早，作废
      const at = Date.parse(a.at || "");
      if (v.bornAt && at && at < v.bornAt - 1500) return null;
      return a;
    }
  }
  return null;
}
// 提问那一类单独留个名字：群组展开了要画它的 options（只有 AskUserQuestion 有）。
function pendingAsk(v) {
  const a = pendingTool(v);
  return a && a.tool === "AskUserQuestion" ? a : null;
}
/* 批准框那一类（2026-10-19）：挂着的工具调用**不是**提问，而且这一格确实在等批准。
   为什么要 wait.kind 这道闸：`ok==null` 只说"这条工具还没结果"，工具正在跑的时候
   也是它 —— 那是"在干活"，不是"在等你批"。PermissionRequest / 登记表的 waiting 都把
   kind 填成 perm（见 enterWaitingFromHook / applyAgent）。 */
function pendingPerm(v) {
  if (!v || v.st !== "waiting") return null;
  const a = pendingTool(v);
  if (!a || a.tool === "AskUserQuestion") return null;
  const k = (v.wait && v.wait.kind) || (v.note && v.note.kind) || "";
  return k === "perm" ? a : null;
}

// 「你正看着这一格吗」= 它是当前格 **且** 窗口有焦点。两个条件缺一不可：
// 只看"是不是当前格"，会把"切出去喝咖啡、回来发现跑完了"也当成看过了。
// （原来这条内联在 applyHook 里，现在 applyAgent 也要用 —— 抽出来一份，
//  否则两处迟早漂移。）
function watchedNow(t) {
  return (t === activeTab) && document.hasFocus();
}

/* 冷恢复出来的格子先标成“未确认”（createTab 里按 spec.restored 打标）。
   app-server 重连会先发一帧 thread/read 的补状态（evidence=resync），那一帧
   里的 waiting 可能是**重启前**留下的旧事实 —— 不能凭它给用户记一条未读。
   任何一条活证据（hook / registry / extension / http / 非 resync 的 app-server）
   到了才解除。 */
function confirmRestored(t, why) {
  if (!t || !t.restoredUnconfirmed) return;
  t.restoredUnconfirmed = false;
  // resync 报上来的那条 waiting 也随确认转为“真等待”（之后按正常规则算未读）。
  t.waitUnconfirmed = false;
  sendCtrl({ type: "log", msg: `冷恢复 tab=${t.id} 已确认（${why}）：之后的状态按活事件算` });
}

/* hook 的**低延迟**等待信号（2026-10-19，Wave 1）：
     PermissionRequest                 批准框出现 → kind=perm, state=waiting
     PreToolUse(AskUserQuestion)      提问卡片出现 → kind=ask, state=blocked
   它比登记表（≤700ms）和 Notification（实测晚 6 秒）都早，而且知道具体是
   哪一种。登记表随后到的 waiting 只会走 applyAgent 的“已在等待”分支，
   不会重复记未读（alreadyBlocked / prev 判断）。 */
function enterWaitingFromHook(t, v, kind, text, why, tid, agent) {
  const at = new Date().toISOString();
  const was = v.st === "waiting";
  v.st = "waiting";
  // 四态：提问工具 = blocked（有具体卡片），批准框 = waiting（泛化等待）。
  // wire 上两者都是 waiting，UI 现有判据不分叉。
  // ⚠️ 判据是 **kind** 而不是事件名：新版 Claude 会把 AskUserQuestion 报成
  // PermissionRequest（Orca claude-events.ts:112-118 实测过），那也是一张提问卡。
  v.state = kind === "ask" ? "blocked" : "waiting";
  v.evidence = "hook";
  /* id/agent 是**销账的钥匙**（Wave 2）：PostToolUse 到达时要认出“返回的正是
     在等的那个调用”。Orca 用 waitingToolUseId 判这件事，并专门挡掉“平行兄弟
     调用先返回、把还在挂着的问题销掉”（claude-events.ts:156-166）。 */
  v.wait = { kind, text: text || "", at, id: tid || "", agent: agent || "" };
  v.at = at;
  if (!was) {
    if (!watchedNow(t)) {
      v.note = { kind, text: text || "", at };
      sendCtrl({ type: "log", msg:
        `记未读 tab=${t.id} 因=hook ${why}（${kind}${text ? "，" + text : ""}）` });
    }
  } else if (v.note && (v.note.kind === "ask" || v.note.kind === "perm")) {
    // 还在等，但提问/批准换了：更新那一行（和 applyAgent 的同状态分支一致）。
    v.note.kind = kind;
    if (text) v.note.text = text;
  }
  scheduleLive();
}

/* hook 侧的收尾（Wave 1 的配套）：Stop / StopFailure 说明这一轮**结束了**，
   hook 记下的 waiting 必须在这里销掉。
   为什么不能等 applyAgent：登记表只在状态**变化**时推。启动后一直空闲的格子
   （实测：主题选择屏上弹批准框，登记表里始终是 idle）在等待期间没有任何状态
   变化，答完之后也不会有一帧“离开等待”——那条未读会一直挂到下一轮。
   Stop 是 hook 能拿到的、语义最硬的一次“不再等了”。 */
function leaveWaitingFromHook(t, v, why) {
  if (!v || v.st !== "waiting") return;
  // note 是 ask/perm 才销；stop/fail（上一轮留下的）不归这条管。
  if (v.note && (v.note.kind === "ask" || v.note.kind === "perm")) ackNote(t, why);
  v.st = "idle";
  v.state = "done";
  v.evidence = "hook";
  v.wait = null;
  scheduleLive();
}

// dsh 的 hook busy 只有一条路（它没有登记表）。标题已经是 ✦ 时，这条 busy
// 可能是迟到的 UserPromptSubmit；补一个收尾计时器，别让格子永久转圈。
function markDshBusy(t, v, why) {
  v.st = "busy";
  v.state = "working";
  v.evidence = "hook";
  v.wait = null;
  if (t.agentState === "idle" && typeof armDshLateSettle === "function") {
    armDshLateSettle(t);
  }
}

/* 这条 PostToolUse/PostToolUseFailure 能不能销掉当前的等待？
   判据照 Orca 的 claude-events.ts:112-166：
     · **工具调用 id 优先**（waitingToolUseId）—— 平行兄弟调用（比如同时跑了
       两个 Bash，其中一个返回）不许把另一个还挂着的等待销掉；
     · 没有 id 的旧 payload 退回“工具名 + 谁在等”；
     · agent 必须一致：子代理自己的工具返回销不了主线程的等待（反过来也一样）。
   子代理自己被批准的那一次是个**正当例外** —— 它的等待里记着同一个 agent_id，
   所以这里天然放行。 */
function postToolClosesWait(v, m) {
  if (!v || v.st !== "waiting" || !v.wait) return false;
  if ((v.wait.agent || "") !== (m.agent || "")) return false;
  const wid = v.wait.id || "", mid = m.tid || "";
  if (wid && mid) return wid === mid;
  return !!v.wait.text && v.wait.text === (m.tool || "");
}

// 「这一格**已经**处于卡在等你」—— 由两条**比 hook 更早、更具体**的腿判断：
// 登记表的 waiting，和转录里挂着的那个工具调用。
// 用途只有一个：让 6 秒后到的那条 hook 通知**不许再记一次未读**（实测那个
// 幻影未读就是这么来的）。它只做"抑制"，不产生任何状态 —— 也就是说它判错
// （比如某条 tool_use 永远没有结果）最多是"少记一条未读"，不会凭空多出"需要你"。
function alreadyBlocked(v) {
  return !!v && (v.st === "waiting" || !!pendingTool(v));
}

// 格子头上那个点/字形的状态。**优先级照 Orca 那一条梯子**
// （terminal-tab-activity-status.ts:196-226 / resolveTerminalTabAttentionBadge）：
//   in-turn（working / permission）→ unread 铃铛 → done / failed
// "在干活"赢过一切：它比"上一轮没看过"新。这一条是梯子里最容易搞反的一级。
//
// ⚠️ 2026-10-16 把登记表的 `waiting` 插到最前并把顺序钉死（原来是 hook 的 note
// 压过一切、waiting 根本不读）。为什么 waiting 压过"在跑"——两个方向的风险不对称：
//   迟到的"需要你"只是一瞬间（下一次 700ms 轮询就纠回来），
//   迟到的"在跑"会让整件事**漏掉**：实测权限框挂起的那 6 秒里，界面说的就是
//   "空闲"（需要你 共0、格子头 idle），而 agent 正卡在等你批准。
// Orca 那张 attention 表里 permission/waiting 也排在 working 前面
// （activity-thread-grouping.ts:19-32：waiting 0 → permission 2 → working 5）。
function cellState(t) {
  if (!t) return "idle";
  if (t.connDown) return "off";                    // 我们自己的态，Orca 没有这条
  // A generic CLI at its sign-in screen is waiting for the user even though it
  // has no LIVE event; the tab dot must say so, not "idle".
  if (LOGIN_GATES.has(t.id)) return "ask";
  const v = LIVE.get(t.id);
  // ① 官方机器可读的"我卡在等你"（waiting = 提问和批准都算，见 status.go 的实测）
  if (v && v.st === "waiting") return "ask";
  // ② 两条"在跑"的证据取或：OSC 标题里的转圈字形（快，但 3s 没标题就自己熄）
  //    和登记表的 busy（慢 700ms，但不会因为"没输出"而熄）。互补，不是重复。
  if (t.agentState === "working" || (v && v.st === "busy")) return "working";
  // ③ hook 的 note（比上面两条晚，是它们的兜底）④ 转录里挂着的提问
  if (v && v.note && (v.note.kind === "ask" || v.note.kind === "perm")) return "ask";
  if (pendingAsk(v)) return "ask";
  if (v && v.note) return v.note.kind === "fail" ? "failed" : "unread";
  return "idle";
}

// 消息进来时**只改状态、不渲染**，渲染统一由 scheduleLive() 收口：
// ① 三条腿会连着推（一次工具调用能同时惊动 hook 和转录），一帧渲染一次就够；
// ② 启动那一段里有 `await`，消息可能落在"脚本还没求值完"的缝里 ——
//    那时渲染函数要用的 esc/rel 还在 TDZ 里，一渲染就是白屏。RSB_READY 是那道闸。
// （liveRaf 的声明在上面，和 RSB_READY 一起 —— 理由见那一段注释。）
function scheduleLive() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => { liveRaf = 0; if (RSB_READY) renderLive(); });
}

/* 格↔会话的绑定/改写只有一个地方做。hook 那条腿先到，agent 状态那条腿
   （OpenCode 等）也会带 session；两处各写一遍迟早漂移。 */
function adoptSession(t, session, why) {
  if (!session || t.sessionID === session) return;
  sendCtrl({ type: "log", msg:
    `格子会话 tab=${t.id} ${t.sessionID ? "改写" : "绑定"} session=` +
    `${String(session).slice(0, 8)}（${why}）` });
  t.sessionID = session;
  // 身份刚到，名字也就有了主语：把名字表里的那份名字播到这一格的头上
  // （重开之后"左栏改了名、格子头还是 agent 自己写的"就是漏了这一步）
  seedTabTitles();
}

/* 工具名归一化（Orca agent-question-answered-intent.ts:19-22）：
   Claude 用 AskUserQuestion，dsh/Pi 用 ask_user_question，Codex 用
   request_user_input。去掉非字母数字后比较，别按某一家的大小写写死。 */
function isAskUserQuestionToolName(name) {
  const n = (name || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return n === "askuserquestion" || n === "requestuserinput";
}

function applyHook(m) {
  const tab = m.tab | 0;
  if (tab <= 0) return;                     // 对比窗口（wt）不是格子，不进这一列
  const t = liveTab(tab);
  if (!t) return;
  // dsh 的 hook 形状和 Claude 一样（官方桥），但没有登记表/HTTP 那条腿：
  // 所以它的 working/idle 必须由 hook 直接写入，不能等 700ms 轮询纠偏。
  const isDsh = (m.agentType || "") === "dsh";
  /* 新格"还没开始"的门：除 SessionStart 外的任何 hook 都是活证据
     （用户发了提示 / 批准框 / 工具调用 / Stop …）。SessionStart 只是新进程的
     开场白，不代表用户派了活，所以不算。门一关就永久收起换 Agent 的入口。 */
  if (m.event && m.event !== "SessionStart") freshCellStarted(t, `hook ${m.event}`);
  /* 「这一格跑的是哪条会话」—— 左栏那条腿就认它（tabForSession）：点会话行时
     "它在跑 ⇒ 跳过去"、行上那句「正在第 N 格里跑」、还有那行的选中高亮，全靠
     这一个字段。在此之前**没有任何地方写过它**，于是那三件事全是死的 ——
     线上症状就是用户报的那条：点一条正跑在自己格子里的会话，去撞护栏、报冲突、
     还把刚建的格子撤掉。第一条到达的 hook 就把身份说出来（SessionStart 最快，
     但任何一条事件都带着 session）。
     会话**变了**（格内 /clear 换了一条）就改写：这里答的是"现在在跑谁"，旧那条
     已经不在这一格里了（Go 侧 panes.bind 同一时刻也把 Spoke 清掉）。 */
  adoptSession(t, m.session, `${m.event}${m.source ? " " + m.source : ""}`);
  // 这条事件是不是“来确认冷恢复那条未确认等待”的（确认前先记下来，见 switch 之后）。
  const coldWait = !!t.waitUnconfirmed;
  // 任何一条 hook 都是活证据：冷恢复的 resync 静音到此为止。
  confirmRestored(t, `hook ${m.event || "?"}`);
  const v = liveOf(tab);
  const at = new Date().toISOString();
  v.at = at;
  const watched = watchedNow(t);   // "你在看它吗"（判据见 watchedNow）
  switch (m.event) {
    case "Stop":
      // 这轮结束了：hook 记下的“在等你”随之作废（理由见 leaveWaitingFromHook）。
      leaveWaitingFromHook(t, v, "hook Stop：这轮结束");
      // dsh 没有登记表：Stop 是“这一轮完了”的直接信号；收到它时把标题
      // 兜底的迟到计时器一起撤掉，避免下一轮刚开始又被旧计时器熄掉。
      if (isDsh) {
        if (typeof cancelDshLateSettle === "function") cancelDshLateSettle(t);
        v.st = "idle";
        v.state = "done";
        v.evidence = "hook";
        v.wait = null;
      } else if (v.st === "busy" && v.evidence === "hook") {
        // 「忙」是 PostToolUse 这条 hook 置的（登记表 700ms 一轮，太快的一轮它前后都读到 idle、一次都不报）：
        // 那就只有 Stop 能把它收回来，否则这一格永远「在干活」（实测：Bot Group 的投递一直等它空闲）
        v.st = "idle";
        v.state = "done";
      }
      // 只看没看着它。看着它跑完不是新闻（那是你等的结果，不是"有事找你"）。
      if (!watched) v.note = { kind: "stop", text: m.last || "", at };
      break;
    case "StopFailure":
      leaveWaitingFromHook(t, v, `hook StopFailure：${m.reason || m.msg || "非正常收尾"}`);
      v.note = { kind: "fail", text: m.reason || m.msg || "", at };
      break;
    case "Notification": {
      const nt = m.ntype || "";
      const isPerm = nt === "permission_prompt";
      const isAsk = nt === "idle_prompt" || nt === "agent_needs_input";
      // ⚠️ 2026-10-16 两条守卫，缺一个就是实测里那个"幻影未读"：
      //   ① `watched` —— 你正盯着它，就不是未读。`idle_prompt` 那一支一直有
      //      这条，而 perm 这一支**没有**：实测 11:44:36 盯着权限框也被记了一条。
      //   ② `alreadyBlocked(v)` —— 这个格子**已经**卡在等你了（登记表 waiting
      //      或转录里挂着的那个工具，两条腿都比这条通知早 6 秒、还更具体）。
      //      那这条通知只是同一个事件的第二个说法，不许再记一次未读。
      //      实测：12:43:38 转录+登记表都说了，12:43:44 这条把徽标从 0 顶成 1。
      if ((isPerm || isAsk) && !watched) {
        if (alreadyBlocked(v)) {
          // 被挡住这件事必须留一行：不然"这条通知没起作用"在日志里看不出来，
          // 而"记一次且只记一次"这条规矩就变成了没有证据的口头约定。
          sendCtrl({ type: "log", msg:
            `未记未读 tab=${t.id} 因=${nt} 迟到（已卡在等你：` +
            (v.st === "waiting" ? "登记表 waiting" : "转录里挂着的工具") + `）` });
        } else {
          v.note = { kind: isPerm ? "perm" : "ask", text: m.msg || "", at, ntype: nt };
        }
      }
      // agent_completed / agent_needs_input 里的"子代理"那部分归「子代理」模块，
      // 它有自己的数据源（转录里的 Agent 工具调用带描述），不在这里重复记账。
      break;
    }
    case "PermissionRequest": {
      // 批准框出现。这是 perm 等待的第一手证据（比 Notification 早得多），
      // 带 tool_name。新版 Claude 也可能用它报 AskUserQuestion —— 那要算提问
      // （blocked + “在等你回答”），不能一律按批准框算。
      const kind = isAskUserQuestionToolName(m.tool) ? "ask" : "perm";
      enterWaitingFromHook(t, v, kind, m.tool || "", "PermissionRequest", m.tid, m.agent);
      break;
    }
    case "PreToolUse": {
      // Claude 的订阅只收 AskUserQuestion（matcher 写死在 --settings 里）；
      // dsh 的桥没有 matcher，所有工具都会来 —— 只有 ask_user_question 是
      // “卡在等你”，其余是普通工具，按 working 处理（Orca 的 dsh-events.ts
      // 同一口径；批准没有 hook，读成 working 是诚实答案）。
      const ask = isAskUserQuestionToolName(m.tool);
      if (ask || (!isDsh && (!m.tool || m.tool === "AskUserQuestion"))) {
        enterWaitingFromHook(t, v, "ask", m.tool || "", "PreToolUse", m.tid, m.agent);
      } else if (isDsh) {
        markDshBusy(t, v, "PreToolUse");
      }
      break;
    }
    /* —— Wave 2 的收尾信号（Orca managed hook 同一组，见 hooks.go 文件头）——
       没有它们，「在等你」只能等 Stop 才销：用户答完批准后这一轮可能还要跑
       好几分钟，期间右栏一直挂着一条已经解决了的等待。 */
    case "UserPromptSubmit":
      // 用户又发了提示 ⇒ 之前那条等待一定已经是旧账。
      // Claude 不在这里置 busy：/compact 的续跑提示也会走这个事件（Orca 直接
      // 忽略它），而登记表 700ms 内会报出真实的 busy。dsh 没有登记表，事件
      // 就是它唯一的忙信号。
      leaveWaitingFromHook(t, v, "hook UserPromptSubmit：用户发了新提示");
      if (isDsh) {
        markDshBusy(t, v, "UserPromptSubmit");
      }
      break;
    case "PostToolUse":
    case "PostToolUseFailure": {
      const wasWaiting = v.st === "waiting";
      const closed = postToolClosesWait(v, m);
      if (closed) {
        leaveWaitingFromHook(t, v, `hook ${m.event}：${m.tool || "工具"} 已返回`);
      }
      /* 工具返回 ≠ 这一轮结束：模型通常还要接着说，Orca 把这两条映射成
         working。只有**主线程**的工具事件能改格子状态；子代理的工具活动不
         代表主线程在干什么。⚠️ 还在等（平行兄弟调用返回）时绝不覆盖 waiting
         —— 那会把一个真的还挂着的问题销掉（Orca 的
         isParallelSiblingCompletionDuringQuestion 就是挡这件事）。 */
      if (!m.agent && (!wasWaiting || closed)) {
        if (isDsh) {
          markDshBusy(t, v, m.event);
        } else {
          v.st = "busy";
          v.state = "working";
          v.evidence = "hook";
          v.wait = null;
        }
      }
      break;
    }
    case "PostCompact":
      /* 只有**手动** /compact 落在空闲提示符上（手动的唯一收尾信号，Orca
         STA-2915）；auto compact 发生在一轮内部，随后还有自己的 Stop ——
         那时什么都不该声明（Orca claude-compact-completion.ts:1-12）。 */
      if ((m.trigger || "") === "manual") {
        leaveWaitingFromHook(t, v, "hook PostCompact：手动压缩完成");
        v.st = "idle";
        v.state = "done";
        v.evidence = "hook";
        v.wait = null;
      }
      break;
    case "SessionStart":
      // 新会话（含 /clear、/compact）⇒ 之前那条"等你"作废。
      v.note = null;
      v.wait = null;
      if (isDsh) {
        // dsh 没有登记表：新建/续接出来的会话先落到 idle，别让上一格的
        // busy 一直挂着。SessionStart 不是 turn-end，但这里没有别的收尾腿。
        if (typeof cancelDshLateSettle === "function") cancelDshLateSettle(t);
        v.st = "idle";
        v.state = "done";
        v.evidence = "hook";
      } else {
        v.state = "";
        v.evidence = "";
      }
      break;
    case "SessionEnd":
      v.note = null;
      v.wait = null;
      v.state = "";
      v.evidence = "";
      break;
    case "SubagentStart": case "SubagentStop": {
      // Orca 对 dsh 直接忽略这两个事件：官方桥把子会话的 session id 当成
      // 事件主体，子代理活动会把主格子翻回 working（dsh-events.ts:38-44）。
      if (isDsh) break;
      // 钩子给的是 agent_id + agent_type，转录那边给的 Agent 工具调用里有**描述**
      // 和结果。两边靠 agentId 对得上（Go 侧填进 ActItem.Agent），
      // 所以这里只存 id/type，展示时去和流水 join —— 谁的信息更全就用谁的。
      let s = v.subs.find((x) => x.id === m.agent);
      if (!s) { s = { id: m.agent, type: m.agt || "", at, done: false }; v.subs.push(s); }
      if (m.event === "SubagentStop") s.done = true;
      if (v.subs.length > 40) v.subs.splice(0, v.subs.length - 40);
      break;
    }
  }
  /* 冷恢复那条“只显示、不算未读”的等待，被这条活证据确认之后就是普通等待了
     —— 补记一次（规矩不变：只记一次，且只在没看着它的时候）。 */
  if (coldWait && !t.waitUnconfirmed && v.st === "waiting" && !v.note && !watchedNow(t)) {
    v.note = { kind: (v.wait && v.wait.kind) || "ask",
               text: (v.wait && v.wait.text) || "", at };
    sendCtrl({ type: "log", msg:
      `记未读 tab=${t.id} 因=冷恢复的等待被活证据确认（hook ${m.event}）` });
  }
  scheduleLive();
}

function applyAgent(m) {
  const tab = m.tab | 0;
  if (tab <= 0) return;
  const t = liveTab(tab);
  if (!t) return;
  // OpenCode 等外部状态源也会带 session；和 hook 走同一个绑定口。
  adoptSession(t, m.session, `状态 ${m.agent || "agent"} ${m.status || ""}`.trim());
  const evidence = m.evidence || "";
  /* 冷恢复的 resync：这是 app-server 补齐的**快照**，不是新事件。waiting 可能
     是重启前留下的（用户可能早就回答过了）。Orca 对水合上来的非终态就是这么
     处理的：**照常显示，但标成 restoredUnconfirmed —— 不算新鲜、不产生未读**，
     等一条活证据再确认（server-hydration.ts:105-108 +
     terminal-tab-activity-status.ts:67-70）。我们之前是整帧丢掉：界面在“它真的
     还卡着”时反而漏掉了一次该看见的等待。 */
  const coldWait = !!(t.restoredUnconfirmed && evidence === "resync" && m.status === "waiting");
  if (coldWait && !t.waitUnconfirmed) {
    t.waitUnconfirmed = true;
    sendCtrl({ type: "log", msg:
      `冷恢复 tab=${t.id} resync 报 waiting（state=${m.state || "?"} ` +
      `kind=${m.kind || "?"}）：可见但不算未读，等活证据确认` });
  }
  /* 这条帧到来**之前**那条等待是不是未确认的 —— 确认之后要补记一次未读，
     所以必须在 confirmRestored 清旗之前取下来。 */
  const wasUnconfirmed = !!t.waitUnconfirmed;
  if (evidence && evidence !== "resync") confirmRestored(t, `活证据 ${evidence}`);
  const v = liveOf(tab);
  const prev = v.st;
  v.st = m.status || "";
  if (m.state) v.state = m.state;
  if (evidence) v.evidence = evidence;
  if (m.name) v.name = m.name;
  // waiting 的 kind/text 单独留一份：note 只在“没看着它”的时候才写，
  // 你正看着它时也需要它来决定那一行是“等回答”还是“等批准”。
  // Claude 的 kind 优先从转录里的 tool 推断；外部状态源没有转录，用消息自带。
  if (v.st === "waiting") {
    const pt = pendingTool(v);
    const k = m.kind ||
      (pt ? (pt.tool === "AskUserQuestion" ? "ask" : "perm") : "") ||
      (v.wait && v.wait.kind) || "ask";
    /* 登记表/外部状态源说的是“同一件事还在等”时，把 hook 留下的销账钥匙
       （tool_use_id / agent_id）带过去 —— 否则 PostToolUse 只能退回按工具名认。
       外部源自带 kind（它在说一件新的等待）时则不继承。 */
    const old = v.wait;
    const keep = (!m.kind && old) ? { id: old.id || "", agent: old.agent || "" }
                                   : { id: "", agent: "" };
    v.wait = { kind: k, text: m.text || (old && old.text) || "", ...keep };
  } else {
    v.wait = null;
  }
  // ⚠️ 从 busy 回到 idle **不**自动进「需要你」：idle 只说"它没在跑"，
  // 说不出"它刚说完了话"——那必须由 hook 说。这条界线是这一整段的地基：
  // 状态（忙/闲）和事件（说过话）是两回事，混起来就会出现
  // "刚起来的空会话也显示成有消息"这种假读数。
  if (v.st === "busy" && v.note && v.note.kind === "stop") v.note = null;
  // ⚠️ 2026-10-16：`waiting` 的**跃迁**才是那个事件（用户定的规矩：记一次，且只记一次）。
  //   ① 进：从"不卡"变成"卡在等你"的那一刻记一条未读 —— 这就是唯一的记账点，
  //      比 hook 早 6 秒。后面到的那条通知被 alreadyBlocked 挡住（见 applyHook）。
  //      note 里的 text 由 needModel 现取；外部状态源直接带 text 时就存下来。
  //   ② 出：离开等待 = 这个问题有结局了（你答了/拒了/中断了），那条未读随之作废。
  //      走 ackNote 而不是直接置 null —— "未读自己没了"必须留一行原因，
  //      否则分不出"用户销的"和"代码误销的"（那条规矩见 ackNote）。
  if (prev !== "waiting" && v.st === "waiting") {
    // 冷恢复的 resync 那一帧只说“显示”，不说“未读”（见上面 coldWait）。
    if (!watchedNow(t) && !t.waitUnconfirmed) {
      v.note = { kind: v.wait.kind, text: v.wait.text, at: new Date().toISOString() };
      // 未读**出现**也要留一行：`[ui need]` 里那个"徽标=1"只说它在了，
      // 说不出是谁、因为什么把它记上的（对称于 ackNote 那条"消失必须留原因"）。
      sendCtrl({ type: "log", msg:
        `记未读 tab=${t.id} 因=进入等待（${v.wait.kind}，` +
        `${m.kind ? (m.agent || "agent 状态") : "登记表 waiting"}）` });
    }
  } else if (prev === "waiting" && v.st !== "waiting") {
    if (v.note && (v.note.kind === "ask" || v.note.kind === "perm")) ackNote(t, "已从等待恢复");
    t.waitUnconfirmed = false;
  } else if (prev === "waiting" && v.st === "waiting" && wasUnconfirmed && !t.waitUnconfirmed) {
    /* 冷恢复的那条等待刚刚被活证据确认：现在它才是“真的在等你”。 */
    if (!watchedNow(t) && !v.note) {
      v.note = { kind: v.wait.kind, text: v.wait.text, at: new Date().toISOString() };
      sendCtrl({ type: "log", msg:
        `记未读 tab=${t.id} 因=冷恢复的等待被活证据确认（${v.wait.kind}，${m.agent || "agent 状态"}）` });
    }
  } else if (prev === "waiting" && v.st === "waiting" && (m.kind || m.text)) {
    // 还在等，但问题/权限换了：更新那一行。你正看着它时不补记未读。
    if (v.note && (v.note.kind === "ask" || v.note.kind === "perm")) {
      v.note.kind = v.wait.kind;
      if (m.text) v.note.text = m.text;
      scheduleLive();
    }
  }
  if (prev !== v.st) scheduleLive();
}

function applyActs(m) {
  const tab = m.tab | 0;
  if (tab <= 0) return;
  const v = liveOf(tab);
  /* `replace:true` = "这份是**完整**流水，别追加，整份换掉"。两种来源会带它：
     页面刚加载完的补发快照（acts.snapshot）和 tracer 换代后第一次读到文件。
     ⚠️ 它必须**同时**让 actsGen 前进：下段的"只追加"游标只知道"我画到第几条"，
     整份替换之后条数可能**变少**（换了会话），此时光比条数会得出"没有新内容"，
     屏上就会留着上一格的对话 —— 那是这套设计里最难发现的一类错
     （看着完全正常，只是内容不对）。actsGen 一变，renderFlow 就整表重建。 */
  if (m.replace) {
    v.acts = [];
    v.actsGen = ((v.actsGen | 0) + 1) || 1;
  }
  for (const it of m.items || []) {
    const i = it.id ? v.acts.findIndex((x) => x.id === it.id) : -1;
    if (i >= 0) v.acts[i] = it; else v.acts.push(it);
  }
  if (v.acts.length > 300) v.acts.splice(0, v.acts.length - 300);
  scheduleLive();
  // Bot 的对话也是 Bot Group 页的正文（单聊 / 正在回复的预览，见 91-botgroup.js）。
  if (typeof bgSchedule === "function" && TAB_LIST.some((x) => x.id === tab && x.group)) bgSchedule();
}

/* 页面刚连上时，tracer 手上**已经有**的那段流水是"连之前"推的 —— 而 pushJSON
   只发给当前那条连接，没连上就丢了。于是刷新页面之后每一格都是空的，要等到
   下一次有新内容才从半截开始长出来。所以主动要一份完整快照。

   每格只要一次（Set 记账）：这是"补历史"，不是"每次切格都重来一遍" ——
   切回来时 LIVE 里那份还在（前端状态没丢），重来一遍只会多一次整表重建。
   ⚠️ 不能指望 ctl.onopen 那一刻就有当前格：那是通道连上的时刻，标签还在
   路上。挂到 setActive（第一个格被设为当前格时必然调一次）才不会漏。 */
/* ⚠️ 用 `var` 而不是 `const`：`setActive(firstTab)` 那句在**模块求值期**就跑了
   （顶层 `await createTab()` 的下一行，3886），而这一块在那之后才求值 ——
   写 `const` 会当场 TDZ 报错，把启动那一段打断在 ackNote 和 scheduleLive 之间，
   表现是"页面起来了但右栏和几何探针全没了"。`var` 会被提到作用域顶部（此时是
   undefined），下面那句 `!snapAsked` 守卫让它当场静默跳过，改由 applyShell 那一次
   补上。 */
var snapAsked = new Set();
function askActsSnapshot(why) {
  const t = activeTab;
  if (!t || !snapAsked || snapAsked.has(t.id)) return;
  snapAsked.add(t.id);
  sendCtrl({ type: "acts.snapshot", tab: t.id });
  sendCtrl({ type: "files.snapshot", tab: t.id });
  sendCtrl({ type: "log", msg: `对话流 要一份完整快照 tab=${t.id}（${why}）` });
}

/* 群组面要的是**每一格**的流水，不只是当前格 —— 上面那个函数的主语是当前格
   （它服务的是右栏对话流，那条流本来就说当前格的事）。N 格时收起进群组，非当前格
   历史明明在，屏上却是空的（补发只发给了连上时的那一刻的当前格）。
   同一个 Set 记账、同一次快照，只是主语换成"所有活着的格"：每格一辈子只补一次。 */
function askAllSnapshots(why) {
  if (!snapAsked) return;
  let n = 0;
  for (const t of TAB_LIST) {
    if (snapAsked.has(t.id)) continue;
    snapAsked.add(t.id);
    sendCtrl({ type: "acts.snapshot", tab: t.id });
    sendCtrl({ type: "files.snapshot", tab: t.id });
    n++;
  }
  if (n) sendCtrl({ type: "log", msg: `群组 补快照 ${n} 格（${why}）` });
}

function applyFiles(m) {
  const tab = m.tab | 0;
  if (tab <= 0) return;
  liveOf(tab).files = m.files || [];
  scheduleLive();
}

// 看过即销（Orca 的 unread 就是这个语义：**看过 = 销**，不是"读过内容才算"）。
// 但"看过"在这里的含义是**你动手看了它**（点那一格 / 点「需要你」那一行），
// **不是**"窗口又被激活了" —— 这一条是网格视图和标签页视图的**本质差别**：
//   标签页视图里，"切回这个标签"和"看到这一格"是同一件事（Orca 就是那个形状）；
//   网格视图里 N 格**一直**都看得见，所以"窗口获得焦点"谁也证明不了 ——
//   它只会把"我不在的时候哪几格动过"这个**唯一**的读数抹掉，而那正是你要的。
// 所以窗口 focus 只做一件事：重画（把离开期间攒下的变化补上）。
function ackNote(t, why) {
  if (!t) return;
  const v = LIVE.get(t.id);
  if (!v || !v.note) return;
  const kind = v.note.kind;
  v.note = null;
  // 销账本身回一条日志：这是"未读"消失的**唯一**路径（另一条是新一轮开始），
  // 而"我没点它、它自己没了"恰恰是最需要解释的现象 —— 不带原因的消失
  // 分不出"用户销的"和"代码误销的"。
  sendCtrl({ type: "log", msg: `销未读 tab=${t.id} 因=${why || "?"}（原 ${kind}）` });
}
window.addEventListener("focus", scheduleLive);
// 失焦也要重算：可能正好是"这一刻起我才该开始闪"（用户切走了，而未读本来就在）。
window.addEventListener("blur", scheduleLive);

/* —— 「需要你」怎么送到**别的应用**那一层 ————————————————————————————
   应用内的所有提示（描边脉冲、活动条徽标、格子头的橙）都在我们自己的窗口里 ——
   用户在浏览器/编辑器里的时候一个都看不见。系统层只剩一个手段：闪任务栏。
   Wails 那边就是 FlashWindow（见 main.go 的 attention 分支），语义是
   "true 会一直闪到窗口被激活"，所以**关掉它必须显式做**，不能指望它自己停。
   判据只有一条：**窗口不在前台 + 存在未读**。
     窗口在前台时不闪（那是我眼皮底下的事，闪了是噪音）；
     销账之后不闪（renderLive 会跟着重算一次）。
   ⚠️ 必须去重：renderLive 每帧都跑，不做 diff 就会每帧发一条消息。 */
let attnOn = false;
function paintAttention() {
  const loud = [...LIVE.entries()].filter(([, v]) => v.note);
  const want = !document.hasFocus() && loud.length > 0;
  if (want === attnOn) return;
  attnOn = want;
  sendCtrl({
    type: "attention",
    on: want,
    why: want ? `窗口不在前台且有未读：${loud.map(([id]) => "格子" + id).join("/")}`
              : "没有未读或窗口回来了",
  });
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
// 把"这一帧到底画了什么"回传到日志 —— 这页面没有控制台，**像素是看不到的**
// （Orca 能拿 Playwright 截图，我们只有日志）。所以每个模块渲染完回一条读数：
// 行数、分组、以及第一行的内容。只在**内容变了**的时候回，否则 400ms 一条
// 转录会让日志原地爆炸。
// ⚠️ 去重必须**按模块**分键（第一次写成"一个全局变量"，几个模块轮流写它、
// 于是每一条都和上一条不同，等于没有去重 —— 日志里同一行刷三遍就是这个原因）。
const lastUI = new Map();
function uiFact(key, s) {
  if (lastUI.get(key) === s) return;
  lastUI.set(key, s);
  sendCtrl({ type: "log", msg: `[ui ${key}] ${s}` });
}

function hhmm(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
const clamp = (s, n) => { const r = String(s ?? ""); return r.length > n ? r.slice(0, n) + "…" : r; };

const NEED_WHY = { stop: "跑完了一轮", ask: "在等你回答", perm: "要你批权限",
                   login: "在等你登录", fail: "出错了", idle: "空闲" };
const NEED_WHY_KEY = { stop: "live.need.whyStop", ask: "live.need.whyAsk",
                       perm: "live.need.whyPerm", login: "live.need.whyLogin",
                       fail: "live.need.whyFail", idle: "live.need.whyIdle" };
function needWhy(kind) {
  return NEED_WHY_KEY[kind] ? t(NEED_WHY_KEY[kind]) : kind;
}
const NEED_GLYPH = { stop: G_BELL, ask: G_ASK, perm: G_ASK, login: G_ASK,
                     fail: G_DOT, idle: G_DOT };

/* Login gates are not agent events: a generic CLI at its sign-in screen has no
   hook/registry waiting flag, so its title still says "Ready" and the pane
   looks idle. Read the visible terminal screen instead. This is deliberately
   conservative: only strong login-screen lines count, and only the viewport,
   so code/history containing the word "sign in" does not create a ghost. */
const LOGIN_GATES = new Map();   // tab id -> { at, text, agent }
const LOGIN_PATTERNS = [
  /not log(?:ged)? in/i,
  /sign in to (?:continue|get started|use)/i,
  /log ?in to (?:continue|get started)/i,
  // Copilot CLI 的登录门实测是 "Please use /login to sign in to use Copilot"
  // （1.0.103）；它既不写 "log in" 也不写 "to continue"。
  /please use \/login/i,
  /use \/login to (?:sign in|continue)/i,
  /press any key to log ?in/i,
  /how would you like to authenticate/i,
  /login with .*(?:platform|browser|google|github)/i,
  /use .*personal access token/i,
  /authentication is required/i,
  /sign in with (?:google|github|microsoft)/i,
  /(?:choose|select) (?:a )?(?:login|sign-in) method/i,
];

function loginGateLine(s) {
  return LOGIN_PATTERNS.some((re) => re.test(s));
}

function readLoginGate(tab) {
  // A pane whose process exited keeps its last screen (including the login
  // menu) in the buffer; that is history, not a live gate.
  if (!tab || tab.connDown) return null;
  const b = tab && tab.term && tab.term.buffer.active;
  if (!b) return null;
  const rows = tab.term.rows || 50;
  const lo = Math.max(0, b.viewportY);
  const hi = Math.min(b.length - 1, lo + rows - 1);
  let hit = "";
  for (let i = lo; i <= hi; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const s = line.translateToString(true).replace(/\s+$/, "");
    if (s && loginGateLine(s)) hit = s;
  }
  if (!hit) return null;
  return { text: hit.length > 140 ? hit.slice(0, 140) + "…" : hit };
}

function scanLoginGates() {
  const present = new Set();
  let changed = false;
  for (const tab of TAB_LIST) {
    if (!tab || !tab.id) continue;
    present.add(tab.id);
    const hit = readLoginGate(tab);
    const prev = LOGIN_GATES.get(tab.id);
    if (!hit) {
      if (prev) {
        LOGIN_GATES.delete(tab.id);
        changed = true;
        uiFact("login", `登录门消失 tab=${tab.id}`);
      }
      continue;
    }
    if (!prev) {
      LOGIN_GATES.set(tab.id, {
        at: Date.now(), text: hit.text,
        agent: (tab.spec && tab.spec.agent) || "",
      });
      changed = true;
      uiFact("login", `登录门 tab=${tab.id} agent=${(tab.spec && tab.spec.agent) || "?"} ` +
        `首行=${hit.text.replace(/\s+/g, " ").slice(0, 32)}`);
    } else if (prev.text !== hit.text) {
      prev.text = hit.text;
      prev.at = Date.now();
      changed = true;
    }
  }
  for (const id of [...LOGIN_GATES.keys()]) {
    if (!present.has(id)) {
      LOGIN_GATES.delete(id);
      changed = true;
    }
  }
  return changed;
}

// Terminal output is not a LIVE event: a CLI that stops at a sign-in screen
// writes bytes only, so scheduleLive() never fires. Poll the viewport so the
// dashboard's "在等你" and the taskbar badge learn about the gate.
setInterval(() => {
  if (document.hidden) return;
  if (scanLoginGates()) scheduleLive();
}, 1000);

function loginGateText(tab, gate) {
  const agent = (gate && gate.agent) || (tab.spec && tab.spec.agent) || "";
  return agent === "qoder" ? t("live.need.loginQoder") : t("live.need.loginHint");
}

// 「需要你」的模型 = 每一格当前该怎么归类。抽出来是因为徽标和列表要读**同一个**
// 结果（两处各算一遍迟早会出现"徽标 2、列表 1"）。
function needModel() {
  const rows = [];
  for (const t of TAB_LIST) {
    const v = LIVE.get(t.id) || null;
    const login = LOGIN_GATES.get(t.id) || null;
    // Generic CLIs (Qoder, etc.) may have no LIVE entry at all; a login gate is
    // still a "waiting for you" fact and must not be skipped with `!v`.
    if (!v && !login) continue;
    const n = v && v.note;
    // ⚠️ 2026-10-16：这条 if/else 链**就是"谁说了算"**，顺序不是随便排的。
    //   原来是 `if (n)…` 打头 —— 于是 6 秒后到的那条 hook 通知压过一切，并把转录
    //   里更具体的话换成一句泛化套话（实测：11:44:30「在等你回答「提问：Which
    //   color should th」」→ 11:44:36 变成「要你批权限「Claude needs your permis」」）。
    //   现在是：登记表 waiting（官方、≤700ms、提问和批准都算）> hook 的 note
    //   > 转录里挂着的提问 > 登录门 > idle。
    const pt = v ? pendingTool(v) : null;   // 挂着的那个工具调用：问题或权限框
    const ask = v ? pendingAsk(v) : null;
    let kind = "";
    if (v && v.st === "waiting") {
      // 转录里的 tool 最具体（Claude）；没有转录的外部状态源用消息自带的 kind。
      kind = (pt ? (pt.tool === "AskUserQuestion" ? "ask" : "perm") : "") ||
        (v.wait && v.wait.kind) || "ask";
    }
    else if (n) kind = n.kind;
    else if (ask) kind = "ask";
    else if (login) kind = "login";
    else if (v && v.st === "idle") kind = "idle";
    if (!kind) continue;
    // 未读 = 有事发生而你没看。note 只在"没看着它"的时候才写下（见 applyHook /
    // applyAgent 的跃迁），所以有 note 就是未读；而"挂着的提问/权限框"那一类
    // **只在你不看它的时候**算未读 —— 你正看着它，那一行就在你眼前，不必再报一次。
    // 登录门是阻塞在等用户动作，即使当前格也不该被藏进"空闲"。
    // ⚠️ 这一条原来是 `kind === "ask"`，2026-10-16 补上 perm：waiting 现在两种都算，
    //    只留 ask 就会变成"同一种等待，问题算未读、权限框不算"这种没有道理的区别。
    // ⚠️ 2026-10-19（Wave 2）：冷恢复的 resync waiting 先**可见但不算未读**
    //    （Orca 的 restoredUnconfirmed）。否则重开一次就凭空多一条“需要你”，
    //    而那条等待可能在你关掉 Perch 之前就已经答过了。
    const unread = kind === "login" || (!t.waitUnconfirmed &&
      (!!n || ((kind === "ask" || kind === "perm") && t !== activeTab)));
    // ⚠️ 文字和时间**取最具体那条腿**：转录里那条 tool 的 text 就是权限框自己那句
    //   描述（实测 `Write permtest file`，和屏幕上的权限框一字不差），比 hook 的
    //   "Claude needs your permission" 有用得多。
    const at = kind === "login" ? login.at
      : (pt && pt.at) || (n && n.at) || (ask && ask.at) || (v && v.at) || "";
    const text = kind === "login" ? loginGateText(t, login)
      : (pt && pt.text) || (n && n.text) || (v && v.wait && v.wait.text) || "";
    rows.push({ t, kind, unread, at, text });
  }
  // 未读的在前（新的在上），没未读的那组按"最后听到它的时刻"排。
  rows.sort((a, b) => (b.unread - a.unread) || (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  return { rows, wait: rows.filter((r) => r.unread), quiet: rows.filter((r) => !r.unread) };
}



// hook 报的 agent_id 是**裸 uuid**，会话库那边的 id 是**文件名**
// （subagents\agent-<uuid>.jsonl → "agent-<uuid>"，store.go:236）。
// 两边差一个前缀，join 之前先归一 —— 别指望两种写法相等。
function subKey(id) { return String(id || "").replace(/^agent-/, ""); }

// subClosed / subStateSeen 声明在启动之前（和 LIVE 挨着，那里写了为什么）。
function subNote(id, st, why) {
  const k = subKey(id);
  if (!k || subStateSeen.get(k) === st) return;
  subStateSeen.set(k, st);
  sendCtrl({ type: "log", msg: `子代理状态 ${k.slice(0, 8)} → ${SUB_WORD[st] || "未标记"}（${why}）` });
}

/* 这一格的 hook 模型里，有没有说过"这个子代理停了"（SubagentStop）。
   这是**亲眼看过的**证据，而 subStateOf 下面那两条是**对文件的推断** ——
   两者的可信度不同，所以每次都要先问它。 */
function subHookSeenDone(k) {
  for (const lv of LIVE.values()) {
    if (!lv.subs) continue;
    for (const sb of lv.subs) if (sb.done && subKey(sb.id) === k) return true;
  }
  return false;
}

/* 这一格的 hook 模型里，这个子代理**还活着**吗（Start 到了、Stop 没到）。
   用途是给下面"文件还在不在写"那条兜底：一次跑超过 3 分钟的工具调用
   （长构建、嵌套另一个 Agent）会让文件看起来"没在写"，
   而那条判据会把它误判成"被打断"。 */
function subLiveRunning(k) {
  for (const lv of LIVE.values()) {
    if (!lv.subs) continue;
    for (const sb of lv.subs) if (!sb.done && subKey(sb.id) === k) return true;
  }
  return false;
}

