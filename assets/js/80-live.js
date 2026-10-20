"use strict";
/* 80-live.js —— 复接/分叉动作、shell 推送应用、右栏需要你/改动/流水/子代理、实时读数。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 7411-8851（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

/* ===========================================================================
   C2：复接一条已有会话 —— 卡片的动作

   **三个出口，一份数据**（照 Orca 抄的形制：它那边有四个出口 —— hover 图标组 /
   kebab 菜单 / 右键 ContextMenu / 展开详情条里的带字按钮 —— 全部共用同一份
   SessionActionMenuItems，见 AiVaultSessionRow.tsx:145-282）。我们三个：
   hover 浮出的 ▶、常驻的 ⋯、右键卡片。菜单项和可用性只在一处算（cardMenuItems）。

   下面这几条是**从 Orca 学来的、不写清楚下次一定会丢**的：

   1. **接上永远新开一格，绝不占用当前格**。Orca 的 Resume 就是
      `session.tabs.createTerminal`（golden: aivault-resume-launch-locked.json:10），
      它跟"当前在看哪个面板"没有任何关系 —— 要接的是**那条会话**。
   2. **可不可用由 Go 说了算**（tab.new 的应答里带 err/msg，见 main.go 的护栏）。
      前端只做"本地就能确定"的灰态（resumeWhy），并且**灰了也能点** —— 点一下
      把原因说出来。真正的占用冲突前端判不了，也不该猜：权威的「谁占着谁」表在
      Go 的 tabManager.bySession 里。
   3. **拒绝必须把占位格撤掉**（Orca 状态里有显式的 `launched:"unlaunched"`）。
      一个没有 PTY 的格子比"什么都没发生"更糟 —— 它看起来在跑。
   =========================================================================== */

const ICON_FORK = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2a6 6 0 0 1-6 6H8"/></svg>`;
const ICON_COPY = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>`;
const ICON_OPEN = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>`;
const ICON_DIR = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;

let cardMenuCard = null;   // 菜单现在讲的是哪张**会话卡**（null = 不是卡片的菜单）
let cardMenuProj = null;   // 菜单现在讲的是哪个**项目/目录**（null = 不是项目的菜单）
/* 2026-10-17：左栏的菜单多了第三种主语 —— **agent 行**。它和项目菜单共用
   同一个 #cardmenu 元素（一份数据、多个出口是这里立过的形制），靠这个变量
   分辨"讲的是谁"。三个身份变量**互斥**：开一份菜单时必须把另外两个清掉，
   否则 dispatch 会照着上一份的身份执行（点在 A 上、动的是 B）。 */
let cardMenuAgent = null;
/* 第四种主语：「已关闭」的 agent（没有格对象，只有那条薄快照）。
   它和 agent 菜单互斥 —— 开一份菜单时另外几个身份一律清掉（见 open*Menu）。 */
let cardMenuClosed = null;
/* 第五种主语：**还没开始干活的新格**（格子头的 ⇄ / 格内提示条的「切换」）。
   它和上面四种互斥；动作只有一条：换一个 Agent 重开这一格
   （switchFreshAgent，见 60-shell）。 */
let cardMenuFresh = null;
let cardMenuRowEl = null;  // 菜单是从**哪个元素**上开出来的（.arow / .card）——
                           // 「重命名」拿它去找要被换掉的标题元素（见 openCardMenu）
// lucide circle-info / check / x（同一套笔法，官方 path 原文）
const LUCIDE_INFO = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>';
const LUCIDE_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const LUCIDE_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';

/* 提示卡。拒绝/失败的事实要有地方落地 —— 从前端只有对话流能显示文字，而对话流
   是"会话的内容"，往里塞一条系统消息等于伪造内容。

   2026-10-17 第二版（用户：「出现在右上角，作为弹窗的那种形式」）：
   · 右上角通知卡：**标题**说"发生了什么"，**正文**说"为什么/在哪"；
   · 新的在上（插到最前），最多 3 条，被挤掉的是最老的那条；
   · 悬停停表；点卡片或 × 关闭；`ok` 绿勾 / `err` 红三角 / 默认中性。
   签名：showToast(标题, 正文, 种类, 等宽?)。
   兼容老的两参写法（第二参是 kind）：漏改的调用不会把 "err" 印成正文。 */
const TOAST_MAX = 3;
const TOAST_MS = 5000;      // 读一行标题 + 一行正文的时间
const TOAST_MS_ERR = 8000;  // 失败那条有原因，多留三秒
function showToast(title, body, kind, mono) {
  if (kind === undefined && (body === "err" || body === "ok" || body === "info")) {
    kind = body; body = "";
  }
  const host = $("toasts");
  if (!host) return;
  body = body || "";
  const k = kind || "info";
  const el = document.createElement("div");
  el.className = "toast" + (k === "err" ? " err" : "") + (k === "ok" ? " ok" : "");
  el.innerHTML = `<div class="thead">`
    + `<span class="tic">${lucide(k === "err" ? LUCIDE_TRIANGLE_ALERT
                                          : k === "ok" ? LUCIDE_CHECK : LUCIDE_INFO, 14)}</span>`
    + `<span class="ttl"></span>`
    + `<button class="tclose" type="button" aria-label="关闭">${lucide(LUCIDE_X, 13)}</button>`
    + `</div>`
    + `<div class="tbody${mono ? " mono" : ""}"></div>`;
  // 走 textContent：标题和正文里有路径、引号、中文引号 —— 不能拼 HTML
  el.querySelector(".ttl").textContent = title || "";
  el.querySelector(".tbody").textContent = body;
  /* 新的在上：老的往下推；超上限时挤掉最下面那条，不留退场动画
     （它本来就是被挤走的，不是被你读完的）。
     推下来这件事要有过渡：先量一遍老卡的位置，插完再按位移补一个 FLIP 动画，
     否则上面多出一张卡时，下面两张是"瞬移"的 —— 这是那一版看起来生硬的原因。 */
  const prevTop = new Map(
    Array.from(host.children).map((n) => [n, n.getBoundingClientRect().top]));
  host.insertBefore(el, host.firstChild);
  while (host.children.length > TOAST_MAX) host.lastElementChild.remove();
  for (const n of host.children) {
    if (n === el) continue;
    const old = prevTop.get(n);
    if (old == null) continue;
    const dy = old - n.getBoundingClientRect().top;
    if (dy) n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 180, easing: "cubic-bezier(.16,1,.3,1)" });
  }

  let timer = 0;
  const kill = (anim) => {
    clearTimeout(timer);
    if (el.dataset.gone) return;
    el.dataset.gone = "1";
    if (!anim) { el.remove(); return; }
    el.classList.add("out");
    setTimeout(() => el.remove(), 140);
  };
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => kill(true), ms); };
  el.addEventListener("click", () => kill(true));
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => arm(1600));
  arm(k === "err" ? TOAST_MS_ERR : TOAST_MS);
  sendCtrl({ type: "log", msg: `提示卡 ${k}：${title}${body ? " —— " + body : ""}` });
}

/* 灰态菜单项点下去时，标题用菜单上那行字（"从列表移除"），正文用 title 里的原因。
   title 里常常是三四行说明 —— 塞进标题行会被截掉，拆成正文才读得全。 */
function miLabel(el) {
  const s = el && el.querySelector("span");
  return s ? (s.textContent || "").trim() : "";
}

/* 菜单项。`hint` 同时是 title（鼠标停上去能读到原因）和灰态点击时那句解释 ——
   一处写、两处用，不会出现"灰的理由"和"说了什么"不一致。 */
function cardMenuItems(s) {
  const why = resumeWhy(s);
  const na = why ? " na" : "";
  const hasFile = !!s.path;
  return [
    /* 重命名排在最前面：它是这份菜单里**唯一**一件"改我们自己的东西"的事
       （其余全是跟 claude 或文件系统打交道），而且它是那种会想顺手做一下的动作。
       接上这条会话在**这一行本身上**已经有更好的出口（hover 浮出的 ▶）。 */
    { act: "rename", icon: ICON_PENCIL, label: "重命名",
      hint: (STATE?.titles?.[s.id] ? `现在叫「${STATE.titles[s.id]}」` : "这条会话还没有名字")
            + "\n改的是**显示名**：会话 id 是盘上那份文件的文件名，不动它。清空 = 取消命名" },
    { sep: true },
    { act: "resume", icon: ICON_PLAY, label: "接上这条会话", cls: na,
      hint: why || "新开一格，在它自己的工作目录里继续" },
    { act: "fork", icon: ICON_FORK, label: "另起分支", cls: na,
      hint: why || "读这条会话、写一条新的（原会话不动，两条可以并着跑）" },
    { sep: true },
    { act: "copycmd", icon: ICON_COPY, label: "复制 resume 命令",
      hint: `claude --resume ${s.id}（在 ${s.cwd || "默认目录"} 里执行）` },
    { act: "copyid", icon: ICON_COPY, label: "复制会话 id", hint: s.id },
    { sep: true },
    { act: "openlog", icon: ICON_OPEN, label: "打开会话文件", cls: hasFile ? "" : " na",
      hint: hasFile ? s.path : "这张卡片没有文件路径" },
    { act: "reveallog", icon: ICON_DIR, label: "在文件夹中显示", cls: hasFile ? "" : " na",
      hint: hasFile ? s.path : "这张卡片没有文件路径" },
    { act: "opencwd", icon: ICON_DIR, label: "打开工作目录", cls: s.cwd ? "" : " na",
      hint: s.cwd || "这条会话没有工作目录" },
  ];
}

/* 开菜单的**唯一出口**（卡片和项目共用）。`anchor` 是一个矩形（⋯ 按钮那个，
   或者右键时鼠标那一点），alignRight=true 表示**优先**把菜单的右边缘对上锚点的
   右边缘。落点和自证读数只有一处 —— 两份实现迟早会在"放不下往哪边长"这条上分叉。

   落点的算法有个实测教训：第一次实现是"右对齐 + 钳到窗口内"，结果菜单
   （352px 宽）被右对齐到侧栏（213px 宽）之后左边缘变成 -9，被钳到 6 ——
   菜单**飘到了窗口最左边的导航条上**，看起来像是那里的东西，而不是这张卡的。
   所以顺序必须是：先试右对齐；放不下（会跑出左边界）就改成**从锚点左边缘
   往右长**，允许它盖住主区（下拉菜单盖住邻居是正常的，飘到另一边不是）。
   落点算完再显示：先显示再量会量到上一帧的尺寸，菜单会先闪在错的位置。 */
function showMenuAt(headHTML, items, anchor, alignRight, what) {
  const menu = $("cardmenu");
  menu.innerHTML = headHTML + items.map((it) => it.sep
    ? `<div class="sep"></div>`
    : `<button class="mi${it.cls || ""}" data-act="${it.act}"
         title="${esc(it.hint)}">${it.icon}<span>${esc(it.label)}</span></button>`
  ).join("");
  menu.classList.add("on");
  const r = menu.getBoundingClientRect();
  let left = alignRight ? anchor.right - r.width : anchor.left;
  if (left < 6) left = anchor.left;                    // 右对齐放不下 → 从左边缘往右长
  left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
  let top = anchor.bottom + 4;
  if (top + r.height > window.innerHeight - 6) top = anchor.top - r.height - 4;
  top = Math.max(6, Math.min(top, window.innerHeight - r.height - 6));
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
  // 自证读数：菜单"在不在、落在哪、几项、几项灰"全回日志 —— 这三件事在截图里
  // 都不好认（尤其"灰"，一眼看不出是灰还是配色），而落点错了更是只有量才知道
  // （上面那条"飘到导航条上"就是这么逮到的）。
  sendCtrl({ type: "log", msg: `菜单 打开 ${what} ` +
    `锚=${Math.round(anchor.left)},${Math.round(anchor.top)}-${Math.round(anchor.right)},${Math.round(anchor.bottom)} ` +
    `落=${Math.round(left)},${Math.round(top)} ${Math.round(r.width)}x${Math.round(r.height)} ` +
    `项=${items.filter((i) => !i.sep).length} 灰=${items.filter((i) => i.cls).length}` });
}

function openCardMenu(cardEl, anchor, alignRight) {
  const s = (STATE?.sessions || []).find((v) => v.id === cardEl.dataset.id);
  if (!s) return false;         // 返回"到底开没开"：右键那一路要据此落一行日志
  cardMenuProj = null;
  cardMenuAgent = null;
  cardMenuClosed = null;
  cardMenuCard = s;
  /* 菜单"讲的是谁"有两层：会话数据（cardMenuCard）和**这一行/这张卡那个元素**
     ——「重命名」要在原地把标题元素换成输入框，而菜单项是点在 #cardmenu 里的，
     从那儿 closest() 爬不回那一行。所以在开菜单的这一处（唯一的出处）把它记住。 */
  cardMenuRowEl = cardEl;
  showMenuAt(`<div class="mhead" title="${esc(sessionTitle(s))}">${esc(sessionTitle(s))}</div>`,
    cardMenuItems(s), anchor, alignRight, `卡片 id=${s.id}`);
  return true;
}

/* 格子头上那颗常驻下拉的菜单：和项目/agent 菜单共用 #cardmenu，只列
   **可启动**的 Agent。
   两种状态（用户 2026-10-20 确认）：
     · 未开始 —— 其它项可点，换 = 重开这一格；
     · 已经开始 —— 当前项和其它项**一律灰掉**，点了会说明"要换请新开一格"，
       不静默（不可用的动作做灰、做说明，不做隐）。 */
function freshMenuItems(t) {
  const cur = (t.spec && t.spec.agent) || "";
  const started = !t.fresh;
  const list = opCatalog().filter(opLaunchable);
  if (!list.length) {
    return [{ act: "fresh:none", icon: lucide(LUCIDE_INFO, 13),
      label: "没有可启动的 Agent", cls: " na",
      hint: "没有检测到已安装、能启动的 Agent。去总览 → Agent 安装。" }];
  }
  return list.map((a) => {
    const isCur = a.id === cur;
    let cls = "", hint;
    if (isCur) {
      cls = " na";
      hint = started
        ? "现在就是这个 Agent；这一格已经开始干活"
        : "现在就是这个 Agent；这一格还没开始，随时可以换";
    } else if (started) {
      cls = " na";
      hint = `${a.name}：这一格已经开始干活，不能原地换 —— 要换请新开一格（Ctrl+Alt+N）`;
    } else {
      hint = `换成 ${a.name}：这一格会重开（还没开始，旧的空会话不留记录）`;
    }
    return {
      act: "fresh:" + a.id,
      icon: opAgentIcon(a.icon) || lucide(LUCIDE_INFO, 13),
      label: a.name + (isCur ? "（当前）" : ""),
      cls, hint,
    };
  });
}

function openFreshAgentMenu(t, anchorEl) {
  if (!t || !TAB_LIST.includes(t)) return;
  const r = anchorEl.getBoundingClientRect();
  cardMenuCard = null;
  cardMenuProj = null;
  cardMenuAgent = null;
  cardMenuClosed = null;
  cardMenuFresh = t;
  cardMenuRowEl = null;
  showMenuAt(`<div class="mhead">Agent · ${t.fresh ? "这一格还没开始" : "这一格已经开始"}</div>`,
    freshMenuItems(t), r, false,
    `格子头 Agent 菜单 tab=${t.id || 0} agent=${(t.spec && t.spec.agent) || "?"} ` +
    `fresh=${t.fresh ? 1 : 0}`);
}

function doFreshAct(act, t) {
  if (!act || act.indexOf("fresh:") !== 0) return;
  const id = act.slice("fresh:".length);
  if (id === "none") {
    showToast("没有可启动的 Agent", "没有检测到已安装、能启动的 Agent。去总览 → Agent 安装。", "err");
    return;
  }
  // 已经开始干活：菜单项是灰的，但点了要**说清楚**为什么不做（不做静默）。
  if (!t.fresh) {
    showToast("这一格已经开始干活", "换 Agent 只能在新会话开始前；要换请新开一格。", "info");
    sendCtrl({ type: "log", msg: `换 Agent 拒绝：tab=${t.id || 0} 已开始` +
      `（${t.freshStartedBy || "?"}）` });
    return;
  }
  // 不 await：菜单已经关了，重开一格是后台上的一段异步动作（内部自己会报结果）。
  switchFreshAgent(t, id);
}

function closeCardMenu(why) {
  const menu = $("cardmenu");
  if (!cardMenuCard && !cardMenuProj && !cardMenuAgent && !cardMenuClosed && !cardMenuFresh) return;
  cardMenuCard = null;
  cardMenuProj = null;
  cardMenuAgent = null;
  cardMenuClosed = null;
  cardMenuFresh = null;
  cardMenuRowEl = null;
  menu.classList.remove("on");
  if (why) sendCtrl({ type: "log", msg: `菜单 关闭（${why}）` });
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
    showToast("复制失败", String(e && e.message ? e.message : e), "err");
    return false;
  }
}

/* 接上（kind="exact"）或另起分支（kind="fork"）。
   Go 那边会把 exact 翻译成 `--resume <id>`、fork 翻译成 `--resume <id>
   --fork-session`（见 agentDefs.Args）—— 这里只声明意图，不拼命令行。 */
async function connectSession(s, kind) {
  const why = resumeWhy(s);
  if (why) { showToast("接不上这条会话", why, "err"); return; }
  /* ⚠️ **exact 才有这条**：它已经在某一格里跑着 ⇒ 那不是"接上"，是**跳到那一格**。
     再起一条 = 两个 claude 同时写同一份会话文件，Go 那道护栏会拒 —— 而用户看到的
     是红字报错 + 白等 2.4 秒重试。就在这个出口上判一次（点会话行和行尾那颗 ▶
     都从这儿走）。
     fork **不**走这条：它写的是**新**文件，从同一起点跑第二条路是这个网格的正当
     用法（resume.go 的判据 3，Go 那边也放行）。 */
  if (kind === "exact") {
    const live = tabForSession(s.id);
    if (live) { jumpToTab(live, "它已经在跑了"); return; }
  }
  if (soloTab) backToGrid();   // 新格加进的是"并行区"，正看独立页时先回网格
  const t = await createTab({ agent: "claude", cwd: s.cwd || "", resume: { kind, id: s.id } });
  // Go 拒了：createTab 那条路上已经把占位格撤掉、toast 弹过了（见 tab.ok 的处理）。
  // tab.id === 0 就是"这个标签没有 PTY"，不是一条能用的格子。
  if (!t || !t.id) return;
  setActive(t);
  sendCtrl({ type: "log", msg: `接上会话 id=${s.id} kind=${kind} → tab=${t.id} ` +
    `cwd=${s.cwd || "(默认)"} 格数=${TAB_LIST.length}` });
}

async function doCardAct(act, el, s, anchorEl) {
  // 灰的项**可点**：点一下把 title 里那句原因原样说出来。禁用元素在 Chromium 里
  // 不弹 title，所以"灰"如果不可点，原因就没有任何出口。
  if (el && el.classList.contains("na")) {
    showToast(miLabel(el) || (el && el.dataset.act === "resume" ? "接不上这条会话" : "做不了"),
      el.title, "err"); return;
  }
  switch (act) {
    case "resume":  await connectSession(s, "exact"); break;
    case "fork":    await connectSession(s, "fork");  break;
    case "rename": {
      /* 就地换掉**这一行/这张卡**的标题元素（会话行是 `.nm`，卡片是 `.t` 里那个
         `.nm` —— 两种都命中，所以一个选择器就够）。
         ⚠️ 元素找不到就说出来，别静默什么都不做：那样"点了没反应"又要靠猜。 */
      const nmEl = liveNmEl(s.id, anchorEl && anchorEl.querySelector(".nm"));
      if (!nmEl) {
        showToast("这一行已经不在界面上了", "列表刚重画过 —— 再点一次 ⋯。", "err");
        sendCtrl({ type: "log", msg: `重命名 找不到标题元素 id=${s.id} anchor=${anchorEl ? anchorEl.className : "null"}` });
        break;
      }
      /* ⚠️ 这句只说明"这个菜单项被点了"，**不说明编辑器开了** ——
         开没开由 openSessionRename → mountRenameInput 自己报（「输入框挂上了」/
         「没挂上」）。实测被自己骗过一次：拿这行当"编辑器开了"的证据，
         于是把一个幽灵编辑器误判成"挂上了、只是没焦点"。 */
      sendCtrl({ type: "log", msg: `重命名 点了菜单项 id=${s.id}（现在的名字=${JSON.stringify((STATE?.titles || {})[s.id] || "")}）` });
      openSessionRename(s, nmEl);
      break;
    }
    case "copycmd": {
      // **必须和 Go 那边 agentDefs.Args 拼出来的是同一条命令** —— 否则"复制出来的"
      // 和"接上跑的"不是一个东西，这条功能就只剩误导。
      const cmd = "claude --resume " + s.id;
      if (await copyText(cmd)) showToast("已复制 resume 命令",
        `${cmd}（在 ${s.cwd || "默认目录"} 里执行）`, "ok");
      break;
    }
    case "copyid":
      if (await copyText(s.id)) showToast("已复制会话 id", s.id, "ok", true);
      break;
    case "openlog":   sendCtrl({ type: "open", mode: "open",   path: s.path }); break;
    case "reveallog": sendCtrl({ type: "open", mode: "reveal", path: s.path }); break;
    case "opencwd":   sendCtrl({ type: "open", mode: "open",   path: s.cwd  }); break;
  }
}

/* 监听**挂在 document 上、而且是捕获阶段**，两个理由：

   1. 卡片是 innerHTML 整份重建的（renderLists），"每张卡挂一套监听"漏挂一次
      就是"某张卡点了没反应"，而且没有任何地方看得出来。
   2. 卡片自己的 click（切对话流）挂在 .card 上、走冒泡。捕获阶段先跑，
      所以这里 stopPropagation() 能挡住那一下 —— 点「接上」不该顺带把下段
      切到这条会话（对照 Orca：每个动作上都有 stopPropagation）。
      ⚠️ 少了这行，症状是"点接上，格子起来了，但下段也换了主语"。 */
document.addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (actEl && actEl.closest("#cardmenu, .card")) {
    e.stopPropagation();
    e.preventDefault();
    const cardEl = actEl.closest(".card");
    const s = cardEl
      ? (STATE?.sessions || []).find((v) => v.id === cardEl.dataset.id)
      : cardMenuCard;
    /* 没有对应的会话卡 = 这枚菜单是**项目的**菜单（左栏那一轮）。
       两条路共用同一个 #cardmenu 元素和同一个点击出口，靠"讲的是谁"分流 ——
       这也正是"一份数据、多个出口"那条形制在这个文件里的落法。 */
    if (!s) {
      /* 先认 agent 菜单（2026-10-17 加的第三种主语），再认项目菜单。
         两个身份和行元素都**先取在手里再关** —— closeCardMenu 会把它们清成 null
         （项目那条的老教训：关完再读就是"没有身份"，整个动作静默不做）。 */
      const a = cardMenuAgent, cl = cardMenuClosed, fr = cardMenuFresh;
      const arow = cardMenuRowEl, p = cardMenuProj;
      if (fr) { closeCardMenu("选了菜单项"); doFreshAct(actEl.dataset.act, fr); return; }
      if (a) { closeCardMenu("选了菜单项"); doAgentAct(actEl.dataset.act, actEl, a, arow); return; }
      if (cl) { closeCardMenu("选了菜单项"); doClosedAct(actEl.dataset.act, actEl, cl, arow); return; }
      if (p) { closeCardMenu("选了菜单项"); doProjAct(actEl.dataset.act, actEl, p); }
      return;
    }
    if (actEl.dataset.act === "menu") {
      const r = actEl.getBoundingClientRect();
      openCardMenu(cardEl, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, true);
      return;
    }
    // 菜单项：菜单先关（先关再执行 —— 执行里有 await，菜单留在屏幕上会显得卡住）。
    const fromMenu = !cardEl;
    /* 「重命名」要回到**原来那一行**上开编辑框，而关菜单会把那个锚点清掉 ——
       先取在手里再关（和上面项目那条 `const p = cardMenuProj` 同一个理由）。
       卡片上那几颗常驻按钮（data-act 直接挂在 .card 里）没有菜单锚点，用卡片自己。 */
    const anchorEl = cardMenuRowEl || cardEl;
    closeCardMenu(fromMenu ? "选了菜单项" : "");
    doCardAct(actEl.dataset.act, actEl, s, anchorEl);
    return;
  }
  /* 点菜单外面 = 关。⚠️ 这一句原来只判 `cardMenuCard`（卡片菜单），而**项目/目录
     的菜单**身份在 `cardMenuProj` 里 —— 于是项目菜单点空白处关不掉（用户报的
     "必须点某个按钮才能取消"）。两种菜单都是这一枚 #cardmenu，守卫就该认两种。 */
  if (cardMenuCard || cardMenuProj || cardMenuAgent || cardMenuClosed || cardMenuFresh) {
    closeCardMenu("点了菜单外面");
  }
  /* 「开一个 agent」面板同一套：点面板外面 = 关。⚠️ 触发它的那颗 + 要排除 ——
     不排除的话捕获阶段先关、随后的 click 又把它打开，看起来像"关不掉"。 */
  if ($("openpanel").classList.contains("on")
      && !e.target.closest("#openpanel") && !e.target.closest("#tab-add")) {
    closeAgentPanel("点了面板外面");
  }
  /* 铃铛浮层 / 文件预览 / 新建工作区卡片：同一套"点外面 = 关"。
     触发器（铃铛）和卡片本身要排除，否则捕获阶段先关、随后的 click 又打开。 */
  if ($("need-pop") && !$("need-pop").hidden
      && !e.target.closest("#need-pop") && !e.target.closest("#need-bell")) {
    setNeedPop(false, "点了外面");
  }
  if (typeof closeFileView === "function"
      && $("fview") && !$("fview").hidden && !e.target.closest(".fv-card")) {
    closeFileView("点了外面");
  }
  if (typeof closeNewSpace === "function"
      && $("newspace") && !$("newspace").hidden && !e.target.closest(".ns-card")) {
    closeNewSpace("点了外面");
  }
}, true);

/* 右键 = 同一个菜单，四个出口（卡片 / 项目行 / 会话行 / 其它一律不管）。
   给的是指针位置（用户心里那个锚点就是鼠标）。

   ⚠️ `.arow` 这一支是补上的（用户报的：右键缩进行冒出来的是 WebView2 **自带**的
   那个菜单 —— 返回/刷新/另存为/打印/更多工具/检查，每一项都不是这个应用的事）。
   根因是这里只认 `.proj` 和 `.card`，而 agent 行是**兄弟**不是 `.proj` 的子节点
   （见 projRowHTML 的返回值），于是它一路漏到浏览器的默认菜单。
   走的还是现成那条：agent 行那个「⋯」按钮本来就是 openAgentMenu(row)（onLeftClick），
   右键只是同一个东西的第二种手势。 */
document.addEventListener("contextmenu", (e) => {
  const at = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY };
  const projRow = e.target.closest(".proj");
  if (projRow) {
    e.preventDefault();
    openProjMenu(projRow, at, false);
    return;
  }
  const crow = e.target.closest(".arow.closed[data-pane]");
  if (crow) {
    e.preventDefault();
    const r = CLOSED_PANES.get(crow.dataset.pane | 0);
    if (r) openClosedMenu(r, at, false, crow);
    return;
  }
  const arow = e.target.closest(".arow[data-tab]");
  if (arow) {
    e.preventDefault();
    const t = liveTab(arow.dataset.tab | 0);
    if (t) openAgentMenu(t, at, false, arow);
    return;
  }
  const cardEl = e.target.closest(".card");
  if (!cardEl) return;
  e.preventDefault();
  // 右键：锚点就是鼠标那一点（宽高为 0），于是"左上角对准指针、下面放不下就翻到
  // 指针上面"这套算法原样适用。
  openCardMenu(cardEl, at, false);
});

/* Escape 关菜单；滚动/改窗口大小也关（否则菜单会浮在一个已经挪走的卡片上）。
   ⚠️ 这两句原来都只认 `cardMenuCard` —— **项目的菜单关不掉**：它的身份存在
   `cardMenuProj` 里，于是"点空白处关不掉、Esc 也关不掉"，只剩"点菜单里某一项"
   一条出路（用户原话：必须点某个按钮才能取消）。线上日志也正是这样：整场只有
   `菜单 关闭（选了菜单项）` 一种关闭方式，`点了菜单外面` 一次都没出现过。
   改成"开着菜单就关"（关没开的时候 closeCardMenu 自己就是空操作）。 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (cardMenuCard || cardMenuProj || cardMenuAgent || cardMenuClosed || cardMenuFresh)) {
    closeCardMenu("按了 Esc");
  }
  if (e.key === "Escape") closeAgentPanel("按了 Esc");
}, true);
window.addEventListener("resize", () => {
  closeCardMenu("改了窗口大小");
  closeAgentPanel("改了窗口大小");
});
window.addEventListener("wheel", () => closeCardMenu("滚了页面"), { passive: true, capture: true });

// 提示卡自己也不该抢焦点（键盘焦点在终端里，点它只是为了把它关掉）。
/* 点击/悬停都挂在**每一张卡**上（一个容器 + N 个 .toast，见 showToast）。
   这里只保证点它不会把焦点从终端抢走。 */
$("toasts").addEventListener("mousedown", (e) => e.preventDefault());

// 搜索：标题、路径、预览一起过滤（主会话和子代理同时过滤）
$("q").addEventListener("input", (e) => renderLists(e.target.value.trim().toLowerCase()));
/* ⚠️ 这一条原来挂在冒泡阶段，那是个**真 bug**（今天顺手修掉，理由和上面那条
   快捷键一模一样）：Ctrl+K 先被 xterm 吃掉发成 `^K`（在 Claude Code 的输入行里
   = 删到行尾），我们这边才把焦点交给搜索框 —— 也就是说"打开搜索"顺带把用户
   正在写的那行字删了。capture 阶段先手 preventDefault 之后，xterm 见到
   defaultPrevented 直接整条跳过。 */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("q").focus(); }
}, true);

/* 「重扫会话库」—— 原来这一颗是 `location.reload()`：整页重载会把终端、网格、
   每个格子的滚动位置全部推倒重来（用户点"刷新"要的是新会话出现在列表里，
   不是把手上这盘活重开一遍）。现在发真的 lib.reload：Go 那边**同步**重扫一次
   会话库、把载荷推回来（那条路本来就存在，关格子之后就在用，见 main.go）。 */
$("reload").addEventListener("click", () => {
  sendCtrl({ type: "lib.reload" });
  sendCtrl({ type: "log", msg: "点「重扫会话库」→ 发 lib.reload（不再整页重载）" });
});

// 壳层数据：一次性推完就关，所以拿到即渲染
const shell = Stream("shell");
/* 启动闸（和 20-ctl.js 的 ctlInbox 是同一条理由）：
   这条流在**本文件求值时就建好了**，而 handleShell 是"连上就同步扫一遍、
   马上 Send"（main.go:1601）—— 会话库很小的时候（比如验收用的沙盒），
   载荷几毫秒就回来，落在 85-settings / 87-gateway 还没求值的那条缝里。
   处理函数 applyMagpie 在 87，于是就是红条 `applyMagpie is not defined`。
   启动期间先收住这一帧，99-boot 打开 ctl 启动闸时按同一顺序补画。 */
let pendingShell = null;
function applyShell(p) {
  STATE = p;
  $("s-index").textContent = t("status.index", {
    sessions: STATE.sessions?.length ?? 0,
    projects: (STATE.projects || []).length,
  });
  // 设置随首份载荷一起到（settings.go）。权威值一到就覆盖 localStorage 那份缓存；
  // 终端已经按缓存里的字体/字号建好了，这里再把它们校正到盘上的值。
  if (STATE.settings) {
    applySettings(STATE.settings, { fromGo: true, effectiveCwd: STATE.cwd });
  }
  // 网关首份读数随壳层一起到（watcher 在 main 里先扫了本机那份）。
  // 之后的更新走 ctl 的 "magpie" 消息 —— 两条路都进 applyMagpie。
  if (STATE.magpie) applyMagpie(STATE.magpie);
  renderShell();
  /* ⚠️ 播种必须在**这条**流上也做一次（不只是 hook 绑上会话那一次）：
     启动的顺序是"先按冷恢复摆座位、再收到这份壳层数据"—— 也就是说 hook 绑上会话时
     （约 +1s）名字表**还是空的**（实测 2026-10-17 03:11:44：`名字播种：有身份的格 1、
     名字表 0 条`），名字是这份载荷（约 +3s）才到的。少了这一句，重开之后格子头
     就永远停在 agent 自己写的标题上，而左栏（读同一份 STATE.titles）已经是你起的名字。 */
  seedTabTitles();
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
shell.onerror = () => { $("s-index").textContent = t("status.indexFailed"); };

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
  if (Array.isArray(p.projects)) STATE.projects = p.projects;
  if (p.assign && typeof p.assign === "object") STATE.assign = p.assign;
  STATE.history = p.history || STATE.history;
  // 标题也要换：用户刚改过的名字走的是 Go 那边 titles.json，不跟着刷新就一直旧着
  STATE.titles = p.titles || STATE.titles;
  // 总览的每日活动也在这份载荷里（同一次扫描算的，见 store.go 的 scanSessions）——
  // 不跟着换的话，"重扫会话库"之后热力图还是旧的。
  if (Array.isArray(p.activity)) STATE.activity = p.activity;
  // 设置也在这份载荷里（同一次 buildShellPayload）。重扫不该改设置，但
  // 手改过 settings.json 的人点一次「重扫」就能看到盘上的值 —— 顺手对齐。
  if (p.settings) applySettings(p.settings, { fromGo: true, effectiveCwd: p.cwd });
  if (p.magpie) applyMagpie(p.magpie);
  // 名字表变了，正在跑的那几格的格子头也得跟着换（谁后到都得对得上，见 seedTabTitles）
  seedTabTitles();
  // 左栏那张卡的对象是**上一次 payload 里的那个**了 —— 按 id 重新指到新的，
  // 否则下段讲的那条会话永远停在这一刻之前的内容上（selected 只按 id 比较，
  // 所以高亮不会掉，但对象本身是旧的）。
  if (selected) {
    const n = p.sessions.find((s) => s.id === selected.id);
    if (n) selected = n;
  }
  renderLists(($("q")?.value || "").trim().toLowerCase());
  // 总览正开着的时候，重扫要把它也刷新（读数、热力图、Agent 名单都读这份数据）。
  if (NAV_HERE === "dash") renderDashboard("会话库刷新");
  // 状态栏那行"索引：N 会话 / M 项目"每格都是现算的 —— 重扫之后要跟着换，
  // 否则用户点完「重扫会话库」，列表变了而底下那个数还是旧的（同一屏两句话）。
  $("s-index").textContent = t("status.index", {
    sessions: p.sessions.length,
    projects: (STATE.projects || []).length,
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
    if (a.kind === "tool") return a.ok == null ? a : null;
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

function applyHook(m) {
  const tab = m.tab | 0;
  if (tab <= 0) return;                     // 对比窗口（wt）不是格子，不进这一列
  const t = liveTab(tab);
  if (!t) return;
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
          v.note = { kind: isPerm ? "perm" : "ask", text: m.msg || "", at };
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
      const kind = m.tool === "AskUserQuestion" ? "ask" : "perm";
      enterWaitingFromHook(t, v, kind, m.tool || "", "PermissionRequest", m.tid, m.agent);
      break;
    }
    case "PreToolUse":
      // 只订阅了 AskUserQuestion（matcher 写死在 --settings 里）。这里再判一次
      // 工具名：旧 --settings（订阅表是启动时写死的）万一送来别的工具，不能
      // 把一次普通工具调用记成“在等你提问”。
      if (!m.tool || m.tool === "AskUserQuestion") {
        enterWaitingFromHook(t, v, "ask", m.tool || "", "PreToolUse", m.tid, m.agent);
      }
      break;
    /* —— Wave 2 的收尾信号（Orca managed hook 同一组，见 hooks.go 文件头）——
       没有它们，「在等你」只能等 Stop 才销：用户答完批准后这一轮可能还要跑
       好几分钟，期间右栏一直挂着一条已经解决了的等待。 */
    case "UserPromptSubmit":
      // 用户又发了提示 ⇒ 之前那条等待一定已经是旧账。
      // 不在这里置 busy：/compact 的续跑提示也会走这个事件（Orca 直接忽略它），
      // 而登记表 700ms 内会报出真实的 busy。
      leaveWaitingFromHook(t, v, "hook UserPromptSubmit：用户发了新提示");
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
        v.st = "busy";
        v.state = "working";
        v.evidence = "hook";
        v.wait = null;
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
      v.state = "";
      v.evidence = "";
      break;
    case "SessionEnd":
      v.note = null;
      v.wait = null;
      v.state = "";
      v.evidence = "";
      break;
    case "SubagentStart": case "SubagentStop": {
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

// 重画一个列表但**保住滚动位置**：Orca 的 activity 列表就是"不自动滚、不补位"
// （新条目排到最上面，视口留在原地）。我们的列表是整体重画，所以得自己把
// scrollTop 记一下 —— 否则"正在往回翻看它干了什么"会被每 400ms 的一条新流水
// 反复拽回顶部，那种体验是没法读的。
function swapList(vlistId, html) {
  const box = $(vlistId);
  if (!box) return;
  const sc = box.parentElement;
  const top = sc ? sc.scrollTop : 0;
  box.innerHTML = html;
  if (sc) sc.scrollTop = top;
}

const NEED_WHY = { stop: "跑完了一轮", ask: "在等你回答", perm: "要你批权限",
                   fail: "出错了", idle: "空闲" };
const NEED_GLYPH = { stop: G_BELL, ask: G_ASK, perm: G_ASK, fail: G_DOT, idle: G_DOT };

// 「需要你」的模型 = 每一格当前该怎么归类。抽出来是因为徽标和列表要读**同一个**
// 结果（两处各算一遍迟早会出现"徽标 2、列表 1"）。
function needModel() {
  const rows = [];
  for (const t of TAB_LIST) {
    const v = LIVE.get(t.id);
    if (!v) continue;
    const n = v.note;
    // ⚠️ 2026-10-16：这条 if/else 链**就是"谁说了算"**，顺序不是随便排的。
    //   原来是 `if (n)…` 打头 —— 于是 6 秒后到的那条 hook 通知压过一切，并把转录
    //   里更具体的话换成一句泛化套话（实测：11:44:30「在等你回答「提问：Which
    //   color should th」」→ 11:44:36 变成「要你批权限「Claude needs your permis」」）。
    //   现在是：登记表 waiting（官方、≤700ms、提问和批准都算）> hook 的 note
    //   > 转录里挂着的提问 > idle。
    const pt = pendingTool(v);   // 挂着的那个工具调用：问题或权限框
    const ask = pendingAsk(v);
    let kind = "";
    if (v.st === "waiting") {
      // 转录里的 tool 最具体（Claude）；没有转录的外部状态源用消息自带的 kind。
      kind = (pt ? (pt.tool === "AskUserQuestion" ? "ask" : "perm") : "") ||
        (v.wait && v.wait.kind) || "ask";
    }
    else if (n) kind = n.kind;
    else if (ask) kind = "ask";
    else if (v.st === "idle") kind = "idle";
    if (!kind) continue;
    // 未读 = 有事发生而你没看。note 只在"没看着它"的时候才写下（见 applyHook /
    // applyAgent 的跃迁），所以有 note 就是未读；而"挂着的提问/权限框"那一类
    // **只在你不看它的时候**算未读 —— 你正看着它，那一行就在你眼前，不必再报一次。
    // ⚠️ 这一条原来是 `kind === "ask"`，2026-10-16 补上 perm：waiting 现在两种都算，
    //    只留 ask 就会变成"同一种等待，问题算未读、权限框不算"这种没有道理的区别。
    // ⚠️ 2026-10-19（Wave 2）：冷恢复的 resync waiting 先**可见但不算未读**
    //    （Orca 的 restoredUnconfirmed）。否则重开一次就凭空多一条“需要你”，
    //    而那条等待可能在你关掉 Perch 之前就已经答过了。
    const unread = !t.waitUnconfirmed &&
      (!!n || ((kind === "ask" || kind === "perm") && t !== activeTab));
    // ⚠️ 文字和时间**取最具体那条腿**：转录里那条 tool 的 text 就是权限框自己那句
    //   描述（实测 `Write permtest file`，和屏幕上的权限框一字不差），比 hook 的
    //   "Claude needs your permission" 有用得多。
    const at = (pt && pt.at) || (n && n.at) || (ask && ask.at) || v.at || "";
    const text = (pt && pt.text) || (n && n.text) || (v.wait && v.wait.text) || "";
    rows.push({ t, kind, unread, at, text });
  }
  // 未读的在前（新的在上），没未读的那组按"最后听到它的时刻"排。
  rows.sort((a, b) => (b.unread - a.unread) || (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
  return { rows, wait: rows.filter((r) => r.unread), quiet: rows.filter((r) => !r.unread) };
}

function needRowHTML(r) {
  const nm = currentTabTitle(r.t);
  const why = NEED_WHY[r.kind] || r.kind;
  const title = `${nm} · ${why}${r.text ? "\n" + r.text : ""}`;
  return `<button class="vrow need${r.kind === "idle" ? " quiet" : ""} k-${r.kind}"
      data-tab="${r.t.id}" title="${esc(title)}">
    <span class="g">${svg(NEED_GLYPH[r.kind] || G_DOT, 12)}</span>
    <span class="m">
      <span class="hd"><span class="who ell">${esc(nm)}</span>
        <span class="why">${esc(why)}</span></span>
      ${r.text ? `<span class="tx">${esc(r.text)}</span>` : ""}
    </span>
    <span class="tm">${rel(r.at)}</span>
  </button>`;
}

function renderNeed() {
  const M = needModel();
  let html = "";
  if (M.wait.length) {
    html += `<div class="cap">在等你 · ${M.wait.length}</div>` + M.wait.map(needRowHTML).join("");
  }
  // quiet 里混着两种事：真的没事做（idle），和"你正看着它，所以不算未读"
  // （前台格的权限框/提问）。原来一律写「空闲」—— 于是一条「要你批权限」
  // 躺在标题「空闲」下面，读起来像自相矛盾。分开写，判据只用 kind，不另算。
  const quietSeen = M.quiet.filter((r) => r.kind !== "idle");
  const quietIdle = M.quiet.filter((r) => r.kind === "idle");
  if (quietSeen.length) {
    html += `<div class="cap">已看到 · ${quietSeen.length}</div>` + quietSeen.map(needRowHTML).join("");
  }
  if (quietIdle.length) {
    html += `<div class="cap">空闲 · ${quietIdle.length}</div>` + quietIdle.map(needRowHTML).join("");
  }
  if (!M.rows.length) {
    html = `<div class="empty">没有在等你的格子。<br>
      这里列的是"跑完了一轮而你没在看"和"正挂着问题"的格子 ——
      数据来自 agent 自己的 hook 事件和它的会话登记表，不靠猜。</div>`;
  }
  swapList("need-list", html);
  const cnt = $("need-cnt");
  if (cnt) cnt.textContent = M.rows.length;
  const first = M.rows[0];
  const badge = $("need-badge");
  uiFact("need", `需要你 共${M.rows.length}（未读${M.wait.length}/空闲${M.quiet.length}）` +
    (first ? ` 首行=格子${first.t.id} ${NEED_WHY[first.kind]}` +
      (first.text ? `「${String(first.text).replace(/\s+/g, " ").slice(0, 24)}」` : "") : "") +
    ` 徽标=${!badge || badge.hidden ? "藏" : badge.textContent}`);
}

function paintNeedBadge() {
  const n = needModel().wait.length;
  const b = $("need-badge");
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 99 ? "99+" : String(n);
  // 提示挂在**按钮**上而不是徽标上：徽标是 pointer-events:none（悬停要落到按钮
  // 上才点得动），挂在它身上等于永远不显示。
  // 2026-10-19：按钮从右栏活动条搬到了标题栏铃铛 —— 这里别再写 `.arbtn`
  // （那会把 title 静默留在旧元素上，铃铛永远只有一句"需要你"）。
  const btn = b.closest("button");
  if (btn) {
    btn.title = n ? `需要你 · ${n} 件还没看` : "需要你";
    btn.classList.toggle("has", !!n);
  }
}

/* 「需要你」浮层（标题栏铃铛）。打开/关闭只动 hidden 与 aria-expanded；
   列表内容仍由 renderNeed 每次重画（它本来就在 renderLive 里跑）。 */
function placeNeedPop() {
  const pop = $("need-pop"), bell = $("need-bell");
  if (!pop || !bell || pop.hidden) return;
  const b = bell.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.round(b.right - w);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = Math.round(b.bottom + 6);
  if (top + h > window.innerHeight - 8) top = Math.max(8, Math.round(b.top - h - 6));
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
function setNeedPop(open, why) {
  const pop = $("need-pop"), bell = $("need-bell");
  if (!pop || !bell) return;
  if (!!open === !pop.hidden) return;
  pop.hidden = !open;
  bell.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    renderNeed();       // 打开这一下按最新数据画（平时也在画，这里只是保证）
    placeNeedPop();
  }
  sendCtrl({ type: "log", msg: `铃铛 ${open ? "打开" : "关闭"}（${why || ""}）` +
    ` 条数=${$("need-cnt") ? $("need-cnt").textContent : "?"}` +
    ` 落点=${open ? `${pop.style.left},${pop.style.top}` : "-"}` });
}

// —— 文件台账的行标记。字母照 git 那套：A 新建、M 改动、R 读过。
//   独立「改动」模块并进文件预览之后，这三个符号只剩文件树在用；
//   ±N 仍是**字面量**（来自转录里 Edit 的 structuredPatch / Write 的 content）。
const OP_LETTER = { write: "A", edit: "M", read: "R" };
const OP_NAME = { write: "新建", edit: "改动", read: "读过" };
// 一个文件可能被读过也被改过（ops 是个**去重集合**）——展示时取"最重"的那个动作：
// 新建 > 改动 > 读过。抽成一个函数是因为文件树和预览都要用它，
// 两处各写一遍必然有一天不一致。
function opOf(f) {
  const ops = (f && f.ops) || [];
  return ops.includes("write") ? "write" : ops.includes("edit") ? "edit" : "read";
}

// —— ④ 流水。新的在上（和 Orca 的 activity 列表一致），不自动滚。
const FEED_KIND = {
  prompt:   { g: "❯" },
  thinking: { g: "✻" },
  text:     { svg: G_SAY },
  tool:     { svg: G_TOOL },
  system:   { g: "·" },
};
function feedRowHTML(a) {
  const k = a.kind || "text";
  const meta = FEED_KIND[k] || FEED_KIND.text;
  const g = meta.svg ? svg(meta.svg, 12, 1.9) : (meta.g || "");
  let body;
  if (k === "tool") {
    // 工具行分两段：**工具名**（亮）和**目标**（暗的等宽）—— 一眼看出
    // "这一步在动什么"，不用把整行读完。path 只有文件类工具有。
    const tgt = a.rel || a.path || "";
    body = `<span class="tool">${esc(a.tool || "工具")}</span>` +
           (tgt ? ` <span class="tgt">${esc(tgt)}</span>`
                : (a.text ? ` <span class="tgt">${esc(a.text)}</span>` : ""));
    if (a.ok == null) body += ' <span class="ok">跑着…</span>';
    else if (a.ok === false) body += ' <span class="no">失败</span>';
  } else if (k === "thinking") {
    body = `<span class="tgt">${esc(clamp(a.text, 200))}</span>`;
  } else {
    body = esc(clamp(a.text, 320));   // 320 = Orca 对回复预览的截断长度
  }
  const cls = k === "prompt" ? " p" : (a.ok === false ? " fail" : "");
  return `<div class="vrow fd${cls}" title="${esc(a.text || a.tool || "")}">
    <span class="k">${g}</span><span class="tx">${body}</span>
    <span class="tm">${hhmm(a.at)}</span>
  </div>`;
}

function renderFeed() {
  const t = activeTab;
  const v = t ? LIVE.get(t.id) : null;
  const acts = (v && v.acts) || [];
  $("feed-who").textContent = t ? currentTabTitle(t) : "没有当前格";
  $("feed-cnt").textContent = acts.length;
  // 只画最后一屏的量（内存里留 300 条是为了"更新时能按 id 找到"，
  // 不是为了全画出来 —— 一屏 120 行已经比任何人愿意读的都多）。
  const last = acts.slice(-120).reverse();
  swapList("feed-list", last.length ? last.map(feedRowHTML).join("")
    : `<div class="empty">${t ? "这一格还没有动静。" : "没有当前格。"}<br>
       流水跟着当前格的转录文件实时进来：它说的每句话、每次工具调用、
       每个文件动作，都在这里按时间排开。</div>`);
  const a0 = last[0];
  uiFact("feed", `流水 当前格=${t ? t.id : "?"} 共${acts.length} 屏上${last.length}` +
    (a0 ? ` 首条=${a0.kind}${a0.tool ? "/" + a0.tool : ""}` +
      (a0.rel || a0.path ? ` ${a0.rel || a0.path}` : "") +
      ` ${a0.ok == null ? "跑着" : a0.ok ? "成" : "败"}「${String(a0.text || "").replace(/\s+/g, " ").slice(0, 24)}」` : ""));
}

/* ===========================================================================
   子代理的三态（C7）

   用户的原话：「正在进行中就显示一个正在进行的提示，已经完成的标记已完成或已关闭
   —— 要不然点开一个子 Agent，里面有很多子代理，根本不知道有什么区别」。

   状态词和图形**照 Orca 的 AgentStateDot 搬**（AgentStateDot.tsx:93-171），不是
   自己配的一套：那张表里 `working` 是转圈环、`done` 是**绿对勾**（原文理由：列表里
   要列很多 agent，对勾比点扫得快，还能和 idle 那几个点态一眼分开）、`interrupted`
   是**灰点**（原文理由：用户按了停不是新闻，别用故障红、也别用完成绿）。
   对应关系：进行中=working、已完成=done、已关闭=interrupted、失败=failed。
   —— 它没有"已关闭"这个词；它管这件事的词是 stopped/interrupted，意思一样。

   判据只有三条，每条都能追到一个事实（**不猜**）：
     ① hook 的 SubagentStart/Stop —— 这一条是**亲眼看着的**（v.subs[].done）。
        对"本格在跑"那一段它是权威。
     ② 会话库里的：文件里最后一条事件的**时间戳**（Session.updated 就是它，
        store.go 里明写了"时间用事件里的最大时间戳，比文件 mtime 准"）离现在够近
        = 文件还在写 = 它还在干活。窗口取 3 分钟：够跨过一次长命令或一轮思考，
        又不至于把一小时前的算成活的。
     ③ 停下来了，而且文件最后一条是**悬空的 tool_use**（Session.lastTool）
        = 被打断（结果永远不会来了）。正常收尾的子代理以一句 assistant 文本结束。
   ⚠️ ②必须排在③前面：一个**正在跑**的子代理，两次工具调用之间**也**长成③那样。
   Orca 内部那份状态表有同一条告诫的原版：状态不许由"这一轮结束了"推断，因为
   子代理活得比生它的那一轮长（structured-agent-session-subagent-rows.ts:154-168）。
   ⚠️ 剩下一个**我判不了**的情况：从没亲眼见过、文件也停了（会话库里那几十张老卡
   多半是这种）。这时**不显示状态词**，只显示"多久前" —— 宁可不说，也不该把
   "判不出来"说成"已完成"。Orca 对这种情况有第四态（unverifiable / "status
   unavailable"），而这套只有三态是用户点名要的，所以这里选沉默。
   =========================================================================== */
// SUB_WORD / SUB_RECENT_MS 声明在启动之前（和 LIVE 挨着，那里写了为什么）。

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

/* 会话库那张卡的状态。返回 "" = 判不出来（不显示状态词）。
   ⚠️ 判据的顺序就是**可信度**的顺序，别按方便改。前三档是"我们看着的"，
   后两档是"对文件的推断"：

     ① 我们看着它那一格被关掉（subClosed，closeTab 写的）
     ② 我们这格的 hook 报过 SubagentStop（subHookSeenDone）
     ③ 我们看着它起的、还没报 Stop（subLiveRunning）
     ④ 文件 3 分钟内还在写
     ⑤ 末尾那条事件是不是**一次没拿到结果的工具调用**

   ⚠️⚠️ 第 ⑤ 档只能**单向**信，而且比想象的更弱。两次实测（都在 2026-10-16）：

     · 00:56 把 37 份子代理会话文件的末条全量扫了一遍：**32 份是 tool_result**、
       3 份是收尾的 assistant 文本、只有 2 份是悬空的 tool_use。也就是说
       "正常收尾"长得**不像**我以为的那样（"以一句 assistant 文本结束"），
       它绝大多数时候就停在一次工具结果上。
     · 01:01 又量到更要命的一条：**关格子杀掉的子代理，它的工具调用会拿到一个
       tool_result** —— 我眼看着关掉那一格时，里面那个 `Start-Sleep 120` 被
       PTY 一关就中断返回了（结果写在格子被杀前 0.7 秒，a321f9d6 那份文件：
       `tool_use 16:59:54` → `tool_result 17:01:14.306` → 三条 attachment）。
       真正会留下悬空 tool_use 的，是**硬杀**（进程树瞬间没了、来不及写结果）
       —— 现存的 2 份悬空样本（af886089 / acc8175d）正是被我 taskkill 掉 Perch
       那次留下的。

   所以：**悬空的 tool_use → 被打断**这条推理站得住（工具结果没回来 = 写者没了）；
   但反过来**读成"已完成"的那一堆里，混着被软杀掉的**，纯看文件分不开。
   这一档的措辞（"停下来了，末尾不是悬空的工具调用"）说的正是"我知道的就这么多"，
   别把它读成"它收尾了"。跨进程重启后 subClosed 也空了（它只在内存里），
   于是**上一轮软杀掉的子代理会读成已完成** —— 想让它准，得把"谁关的"落到
   文件里（现在没做；那要写盘，而写盘的就是 claude 自己，不是我们）。 */
function subStateOf(s) {
  const k = subKey(s.id);
  if (subClosed.has(k)) return "closed";
  if (subDone.has(k) || subHookSeenDone(k)) return "done";
  if (subLiveRunning(k)) return "run";
  const age = Date.now() - Date.parse(s.updated || "");
  if (isFinite(age) && age < SUB_RECENT_MS) return "run";
  if (!s.lastKind) return "";     // 索引里没有"末尾那条"（老索引 / 空文件）→ 不说
  return s.lastTool ? "closed" : "done";
}

/* 卡上那个状态签的"凭什么"。抽出来是因为它有两个调用点：cardHTML 画的时候，
   以及 refreshSubChips 过期重算的时候 —— 抄一份就等于两处会分叉。
   ② 那条要分成两种说法：hook 说的（权威）和文件推断的（弱证据）。 */
function cardSubWhy(s, st) {
  if (st === "run") return subLiveRunning(subKey(s.id))
    ? "我们看着它起的，hook 还没报 SubagentStop"
    : `最后一条事件在 ${Math.round(SUB_RECENT_MS / 60000)} 分钟内（文件还在写）`;
  if (st === "closed") return subClosed.has(subKey(s.id))
    ? "我们看着它那一格被关掉了"
    : "末尾是一次没拿到结果的工具调用 —— 被打断";
  if (st === "done") {
    // 三种说法对应三种可信度：我们记着的 > 这一格 hook 现在说的 > 对文件的推断
    const k = subKey(s.id);
    // 不用括号：subNote 那条日志自己会再包一层（`→ 已完成（…）`），
    // 嵌套起来读着累
    if (subDone.has(k)) return "hook 报过 SubagentStop · 在它那一格关掉之前";
    if (subHookSeenDone(k)) return "hook 报了 SubagentStop";
    return "停下来了，末尾不是悬空的工具调用";
  }
  return "";
}

/* 我们的态词 → `.adot` 的态词。翻译**只在这一处**，别在别的地方再写 data-state。
   ⚠️ 这张表是一次真实漏配留下的（2026-10-16 01:07 靠截图才发现）：
   CSS 那几条（idle / working / failed / done / interrupted）写的是 **Orca 的词**
   —— 它 AgentStateDot 的枚举；而 C7 这套三态用的是**产品的词**
   （run / done / closed / fail，和 SUB_WORD、日志里的「进行中/已完成/已关闭」同一套）。
   两边名字对不上，后果**是静默的**：`.adot[data-state="working"]` 这类规则压根不匹配，
   于是三态里除了「已完成」拿到那个绿对勾，其余全部掉回 `.adot::before`
   （只有 content + border-radius，没有尺寸也没有颜色）—— 签上只剩光秃秃两个字。
   截图看得见，日志里一个字都不会有（和 `[hidden]` 那次是同一类坑：
   规则写了、看着也在，实际没生效）。
   映射不是随手挑的：working → 黄圈、interrupted → 灰点、failed → 红点，
   正是 Orca 给这三态画的图形（AgentStateDot.tsx:118-166）。 */
const ADOT_STATE = { run: "working", closed: "interrupted", fail: "failed", done: "done" };

// 一颗状态点。图形**不自己画**（同 LUCIDE_* 那条规矩）。
function adotEl(state, sm) {
  const cls = "adot" + (sm ? " sm" : "");
  // done 在两边是同名，而且它是**字形**态（对勾）不是点态，先走掉
  if (state === "done") return `<span class="${cls} glyph" data-state="done" aria-hidden="true">${lucide(LUCIDE_CIRCLE_CHECK, sm ? 11 : 12)}</span>`;
  // 兜底 `|| state`：传进来的本来就是 CSS 词（idle / off / ask…）时照原样用
  return `<span class="${cls}" data-state="${ADOT_STATE[state] || state}" aria-hidden="true"></span>`;
}

// 状态签。st 为空 = 什么都不显示（见上面"我判不了"那一段）。
// id/why 是给观察腿用的：状态**变化**时那条日志里要写得出"凭什么"。
// sid 只有卡上的签才给（= 会话 id）：refreshSubChips 靠它找回这条会话重算，
// 而实时行给的是**工具调用 id**，不是会话 id —— 所以它是可选参数，不能无脑塞。
function subChipHTML(st, id, why, sid) {
  if (!st) return "";
  subNote(id, st, why);
  return `<span class="subst ${st}" data-st="${st}"${sid ? ` data-sid="${esc(sid)}"` : ""} title="${esc(why || "")}">${adotEl(st, true)}<span class="w">${SUB_WORD[st]}</span></span>`;
}

/* 状态签会**过期**，这和相对时间是同一件事，但危害更大：subStateOf 里
   "最后一条事件在 3 分钟内 → 进行中"读的是**当下时钟**，所以一张卡在启动那一刻
   被算成"进行中"之后，DOM 里就永远写着"进行中" —— 那条子代理早收尾了，
   判据自己已经翻篇，可没有任何东西会把 DOM 改过来。**一个不会自己变旧的
   状态词就是一句谎**，而它恰恰是用户用来分辨那几十条子代理的唯一线索。
   所以跟着 60s 那个 ticker 就地重算。**只换签，不重画列表**：重画会把 hover、
   滚动位置、用户正在读的那一眼一起冲掉，而这里要变的只是几个字符。
   （st 变空时签会**消失**，这是对的 —— "判不出来"就不该显示状态词。） */
function refreshSubChips() {
  const byId = new Map((STATE?.sessions || []).map((s) => [s.id, s]));
  document.querySelectorAll(".subst[data-sid]").forEach((el) => {
    const s = byId.get(el.dataset.sid);
    if (!s) return;
    const st = subStateOf(s);
    if (el.dataset.st === st) return;
    el.outerHTML = subChipHTML(st, s.id, cardSubWhy(s, st), s.id);
  });
}

// —— ② 子代理的"正在跑"那段。数据源是转录里的 Agent/Task 工具调用（它带**描述**
//    和结果），用 hook 报的 agent_type 补一格类型 —— 两边靠 agentId join。
function renderSideLive() {
  const t = activeTab;
  const v = t ? LIVE.get(t.id) : null;
  const acts = (v && v.acts) || [];
  const subs = acts.filter((a) => a.kind === "tool" && (a.tool === "Agent" || a.tool === "Task"));
  const host = $("side-live");
  if (!host) return;
  if (!subs.length) {
    host.innerHTML = "";
    uiFact("subs", `子代理实时 当前格=${t ? t.id : "?"} 0 个`);
    return;
  }
  /* 状态判据 —— **顺序是实测出来的，别按直觉改**（2026-10-16 00:46 那次）：
     用 Task 起一个 `Start-Sleep 45` 的子代理，**工具调用 6 秒就返回了**
     （后台子代理：父 agent 那句原话是 "Waiting on the subagent's 45s sleep to
     finish."），而 `SubagentStop` 在 **51 秒**后才到。
     也就是说"工具结果回来了"和"子代理干完了"是**两件事** —— 拿前者当判据，
     这一行会挂着一个假的「已完成」整整 45 秒（第一版就是这么写的，日志里
     00:46:11 标完成、00:47:01 才真完成）。Orca 把这条写成了教条：状态不许由
     "这一轮结束了"推断，因为 spawn 出来的子代理活得比生它的那一轮长
     （structured-agent-session-subagent-rows.ts:154-168）。
     所以：① 工具失败 → 失败；② hook 报了 Stop → 已完成（**唯一**权威）；
     ③ 其余 → 进行中（含"工具返回了但还没 Stop"那种后台子代理）。
     ⚠️ 兜底：**这一格压根没有 hook 记录**时（hook 没配上/没收上）才退回"工具结果
     回来了"当弱证据 —— 宁可标得保守，也不该让一行永远转圈。Orca 对"联系丢了"
     是单开一个 unverifiable 态，而三态是用户点的，所以这里只能退回弱证据，
     并在判据那句里写明"没有 hook 记录作证"。
     ⚠️⚠️ 兜底**必须按格子整体判断**（hooksAlive），不能按这一条自己有没有 hook 记录：
     第一版就是后者，实测出现了一次**闪回** —— 工具结果先到、SubagentStart 后到
     （同一秒，差一帧），那一行先是"已完成（工具结果回来了）"、紧接着又变回
     "进行中"。而 Orca 那条 `canReplaceSubagentState` 的规矩正是"子代理自己的结局
     要**latch**住，任何东西都不许把它推回 working"（native-chat-subagent-summary.ts:65-83）
     —— 会闪回的状态和"转圈永不结束"是一样坏的两头。所以只要这一格的 hook 是活的，
     就老老实实等 Stop。 */
  const hooksAlive = v.subs.length > 0;
  const rows = subs.slice(-5).reverse().map((a) => {
    const s = v.subs.find((x) => x.id && subKey(x.id) === subKey(a.agent)) || {};
    const desc = String(a.text || "子代理").replace(/^子代理：/, "");
    const st = a.ok === false ? "fail"
             : s.done ? "done"
             : hooksAlive ? "run" : (a.ok != null ? "done" : "run");
    const why = st === "fail" ? "工具调用失败"
      : st === "done" ? (s.done ? "hook 报了 SubagentStop" : "工具结果回来了（这一格没有 hook 记录作证）")
      : a.ok != null ? "工具返回了，但 hook 还没报 SubagentStop（后台子代理就是这样）"
      : "工具调用还没有结果";
    /* ⚠️ 状态日志的主键是**这个工具调用自己的 id**（a.id），不是 a.agent：
       工具还没返回时 Go 那边往 Agent 里放的是**描述**（transcript.go:370，
       返回之后才换成真 agentId，:569）—— 拿它当键会记出 "Run slee → 进行中"
       这种假 id（第一版实测就是这个）。 */
    // 状态签放在**时间左边**（不是正文里）：正文一折行，签就跟着掉到第二行去，
    // 截图里读出来是"…report ose | 进行中"。而且 Orca 也是把状态词钉在行右端
    // （`ml-auto shrink-0`，NativeChatSubagentRun.tsx:131-141），一行扫下去
    // 状态在同一个位置。
    return `<div class="vrow fd" title="${esc(a.text || "")}">
      <span class="k" style="color:var(--green)">${svg(G_FORK, 12, 1.9)}</span>
      <span class="tx">${esc(clamp(desc, 90))}${s.type ? ` <span class="tgt">${esc(s.type)}</span>` : ""}</span>
      <span class="tm">${subChipHTML(st, a.id, why)}${hhmm(a.at)}</span>
    </div>`;
  });
  const running = subs.slice(-5).filter((a) => {
    const s = v.subs.find((x) => x.id && subKey(x.id) === subKey(a.agent)) || {};
    return a.ok !== false && !s.done && (hooksAlive || a.ok == null);
  }).length;
  // 小标题带一个**汇总**：一行行扫之前，先知道这一堆里还有几个在跑
  // （Orca 的分组头也是这个作用："Ran 2 subagents … 2 failed"）。
  host.innerHTML = `<div class="cap">本格在跑 · ${subs.length}${running ? `（${running} 个进行中）` : ""}</div>` + rows.join("");
  const s0 = subs[subs.length - 1];
  // ⚠️ 这一句里 s0.agent 可能还是**描述**（工具没返回时，见上面那条），
  // 所以如实写成"首个"，不写"首个agentId" —— 免得后来的人拿它去 join 别的东西。
  uiFact("subs", `子代理实时 当前格=${t ? t.id : "?"} ${subs.length} 个 进行中=${running}` +
    (s0 ? ` 首个=${s0.agent ? subKey(s0.agent).slice(0, 8) : "?"}` : ""));
}

function renderLive() {
  paintNeedBadge();                       // 徽标永远要（模块条可能收着）
  for (const t of TAB_LIST) renderAgentDot(t);
  /* ⚠️ 模块**每次都全画**，不是只画当前显示的那个。
     代价是每次多几次 innerHTML（文件/子代理是"当前格"的短表，需要你是每格一行
     —— N 格也就 N 行），换来两件事：
       ① 切模块时不可能看到过期内容（数据在你看另一个模块时也一直在更新）；
       ② 验收时日志里几条读数是一组，能直接对上"这一刻每个模块各是什么"。
     唯一"贵"的是流水（屏上 120 行）；它本来也就是屏幕上会滚的那一栏。 */
  renderNeed();
  /* 右栏「文件」：碰过的列表跟着转录增量更新；全部树只在签名变化时重画
     （renderFiles 自己做这道闸，展开态和滚动位置不会被 700ms 的推送冲掉）。 */
  if (typeof renderFiles === "function") renderFiles();
  // 总览开着时，「在跑 / 在等你 / 今日轮次」跟着同一拍更新。
  // 热力图**不在这里重画** —— 它读的是会话库重扫的结果，不是 700ms 的推送。
  renderDashLive();
  renderFeed();
  renderSideLive();
  // 任务栏闪烁跟未读一起重算（它只在"未读存在 + 窗口不在前台"这两个条件
  // 同时成立时开着，见 paintAttention）。
  paintAttention();
  /* 下段对话流也在这里重画（以前它归 selectSession 管 —— 那是"快照"时代的
     写法，只在左栏点一下才会动）。搬过来的原因就是这次的目的：会话内容变化
     时**不经过任何左栏交互**也该往下走。renderFlow 自己判断"有没有真的变"，
     没变的时候它只写那几个读数、不碰列表，所以每次 scheduleLive 都调它不亏。 */
  renderFlow("数据变了");
}

// 点一行「需要你」= 切到那一格 + 闪两下。**只跳过去，就地作答留给以后** ——
// 要往别人的 PTY 里写按键，得先量出 TUI 那个选择器的按键序列，而且还得有
// "那一格是不是还停在这个问题上"的守卫，那是一次机制改动，不是一次装修。
// （收起后的「群组」那一屏也走这一条 —— 点气泡、点顶部条、点那颗「进入 →」，
//   动作是同一件：把我带到那一格。所以 why 是个参数，不是写死的。）
function jumpToTab(t, why) {
  if (!t) return;
  // 先销账，再切格：下面两个分支都会**顺带**销一次，那时已是空操作 ——
  // 顺序反过来的话，日志里记的就是"切格销的"，而这个动作明明是"点了那一行"。
  ackNote(t, why || "点需要你行");
  if (soloTab && soloTab !== t) showPage(t);   // 它在独立页里 ⇒ 连着那张页一起切
  else setActive(t);
  const el = t.cellEl;
  if (!el) return;
  clearTimeout(t.flashTimer);
  el.classList.remove("flash");
  void el.offsetWidth;                    // 强制一次回流，否则连点两下不会重新播
  el.classList.add("flash");
  // 900ms 不是随手取的：描边那一版是 420ms×2 = 840ms，而**动画中途把 class 摘掉
  // 会让它当场断在半路**（第二下只闪一半）。上一版是 300ms×2 = 600ms，700 够用；
  // 这里跟着动画一起加长。
  t.flashTimer = setTimeout(() => el.classList.remove("flash"), 900);
  sendCtrl({ type: "log", msg: `跳转 tab=${t.id}（${why || "点需要你行"}）当前格=${activeTab ? activeTab.id : "?"}` });
}

$("need-list").addEventListener("click", (e) => {
  const row = e.target.closest(".need");
  if (!row) return;
  const t = liveTab(row.dataset.tab | 0);
  jumpToTab(t);
  setNeedPop(false, "点了需要你的一行");
});
if ($("need-bell")) {
  $("need-bell").addEventListener("click", () =>
    setNeedPop($("need-pop").hidden, "点铃铛"));
  $("need-pop-x").addEventListener("click", () => setNeedPop(false, "点 ×"));
  window.addEventListener("resize", placeNeedPop);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // 文件预览/新建卡片是更上层的模态：它们开着时 Esc 归它们，别把下面
    // 那个铃铛浮层一起关掉。
    const over = $("fview") && !$("fview").hidden;
    const ns = $("newspace") && !$("newspace").hidden;
    if (!over && !ns) setNeedPop(false, "Esc");
  }, true);
}

/* ===========================================================================
   总览（Dashboard）
   ---------------------------------------------------------------------------
   形态（用户 2026-10-17 定）：启动即总览（也可以点左栏「总览」进来）→
   `#app.dash`；grid 列**不收缩**，主区/列表/右栏只是 visibility:hidden，
   #dash 盖在它们上面 —— 除了左栏整块都是总览，而终端仍按真实尺寸活着
   （理由见 CSS「#app.dash」那段）。模块切换在窗口顶栏里照 magpie 的 .seg：
   绝对居中、没有灰底轨道、只有一枚滑动白片；换页是整页淡入 + 挪 5px。

   数据口径（这一页最容易含糊的地方，钉在这里）：
     · 轮次 = 用户轮次，主会话 + 子代理；判据和左栏「N 轮」同一条
       （压缩摘要、命令回显不算 —— 见 store.go 的 Turns）；
     · 日活 = Go 扫描时按**本地日期**归天的同一批轮次（ShellPayload.activity）；
     · 热力图强度按**活跃日的分位数**分档，不拿最大值等比 —— 否则一次爆量的
       会话会把其余日子全冲成最淡的一档。
   =========================================================================== */

