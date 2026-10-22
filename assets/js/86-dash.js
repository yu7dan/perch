"use strict";
/* 86-dash.js —— 总览（本地读数、热力图、在等你、Agent 名单）。
   网关在 87-gateway.js（2026-10-17 拆出，2026-10-20 合回一个域文件）：
   本文件只做总览，别再往这里放网关代码。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。 */


/* 顶栏只剩两枚：Agent 的内容 2026-10-17 并进了总览（用户要求）。
   存过 "agents" 的旧 localStorage 会被下面的校验挡掉、回落到总览，不用迁移。 */
const DASH_TABS = [["overview", "dash.tab.overview"], ["gateway", "dash.tab.gateway"]];
let dashTab = "overview";
try {
  const k = localStorage.getItem("perch.dashTab");
  if (DASH_TABS.some(([id]) => id === k)) dashTab = k;
} catch { /* 存不了就用默认 */ }


/* 热力图只读 Perch 自己的会话库（轮次 / 会话数）。网关的请求与 token
   读数在网关页的用量标签里，不再混进总览 —— 两套事实分开说话。 */

/* MAGPIE：最近一次引擎快照（见 internal/gateway）。null = 后端还没交付。
   Agent 工作台 / 用量卡要用它；本地读数不依赖它。 */
let MAGPIE = null;
let MG_CAT_SIG = "";    // Agent 名单指纹（只算安装身份，不算今日 calls）
let MG_USAGE_SIG = "";  // 今日用量的指纹（变了才重画用量卡）
let MG_GW_SIG = "";     // 网关「供应商 · 模型」指纹（只重画表头那一行）

/* 总览的网关用量卡。today 用 MAGPIE.todayUsage（2.5s 快照），
   7d/30d/all 走 gw.usage 按需读；缓存按周期分开。 */
const DASH_USAGE_PERIODS = ["today", "7d", "30d", "all"];
let DASH_USAGE_PERIOD = "today";
try {
  const p = localStorage.getItem("perch.usagePeriod");
  if (DASH_USAGE_PERIODS.includes(p)) DASH_USAGE_PERIOD = p;
} catch { /* 存不了就今天 */ }
let DASH_USAGE_METRIC = "agents"; // agents | models
let GW_USAGE = Object.create(null);
let GW_USAGE_ERR = null;
let GW_USAGE_LOADING = "";
let GW_USAGE_REQ = 0;
let GW_USAGE_TIMER = 0;
let GW_AGENT_BUSY = "";           // 行上接入/写模型中
let AGENT_RENDER_PENDING = false; // 选择器开着时推迟名单重画


function mg() {
  return MAGPIE && MAGPIE.state ? MAGPIE : null;
}
/* 图标 resolver：照搬 magpie 的 icon()（app.js:285-321）——
   名字带 -color 或是已知位图 → <img>（图标自带颜色，直接给扩展名）；
   其余单色 SVG → CSS mask，跟着当前前景色走。
   我们的图标名**不带扩展名**（Go 侧给的是 "claudecode-color"），所以这里是
   按名字补 `.svg` / `.png`，而不是拿名字当文件名 —— 之前就是这条规则写错，
   所有品牌 logo 都掉进了单色 mask（用户 2026-10-17："你没有放上他们的logo"）。 */
/* ⚠️ 写成函数而不是 `const PNG_ICONS = new Set(...)`：第一个标签是在模块
   求值期间同步建的，那时文件后半段的 `const` 还在 TDZ 里 —— 原来这一行会让
   启动时抛 "Cannot access 'PNG_ICONS' before initialization"，整个前端只画一半。 */
function isPngIcon(nm) {
  switch (nm) {
    case "crush": case "zcode": case "alma": case "hanako": case "cindy":
    case "typesafe": case "atomcode": case "snow": case "mlx-serve":
    case "app-alma": case "app-cc-switch": case "rtk":
      return true;
  }
  return false;
}
function iconHTML(name, cls) {
  const c = " " + (cls || "");
  const nm = String(name || "").trim();
  if (!nm) return `<span class="ico-mask${c}" aria-hidden="true"></span>`;
  const explicit = /\.(svg|png|webp|ico)$/i.test(nm);
  const png = isPngIcon(nm);
  if (explicit || nm.endsWith("-color") || png) {
    const file = explicit ? nm : nm + (png ? ".png" : ".svg");
    return `<img class="ico-img${c}" src="icons/agents/${encodeURIComponent(file)}" alt="" loading="lazy">`;
  }
  const url = `icons/agents/${encodeURIComponent(nm)}.svg`;
  return `<span class="ico-mask${c}" aria-hidden="true" ` +
    `style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"></span>`;
}
/* 图标文件缺失（例如引擎报了一个我们没有的 icon id）时不要留 404 空白。
   img 的 error 事件不冒泡，所以在 document 的捕获阶段接住，换成带底色的「?」。 */
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("ico-img")) return;
  const span = document.createElement("span");
  span.className = img.className.replace(/\bico-img\b/, "ico-mask ico-unknown");
  span.textContent = "?";
  span.setAttribute("aria-hidden", "true");
  img.replaceWith(span);
}, true);

const THUMB_MS = 280, THUMB_EASE = "cubic-bezier(.2,.8,.2,1)";

/* 模块切换那枚白片 —— 机制照 magpie 的 slide()/thumbNow()/thumbPut()/thumbFit()
   （magpie app.js:8228-8328），只裁掉"控件换行"那一支。为什么要整套搬：
     · 动画中途再点，必须从**当前视觉位置**重新定向 —— 所以要读 computed
       transform，而不是记上一次的目标位置；
     · 切 tab 时按钮不重建（见 renderDashTabs），thumb 要活过每一次重绘；
     · 窗口/字体尺寸变化时静默归位（ResizeObserver），不播一段无意义动画。
   位置用 transform + width，不用 left：只有 transform 能在动画中途读回来。 */
function thumbNow(th) {
  if (!th.style.width || !th.isConnected) return null;
  const cs = getComputedStyle(th);
  const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
  return { x: m.m41, w: parseFloat(cs.width) };
}
function thumbPut(th, p) {
  for (const a of th.getAnimations()) if (a.id === "thumb") a.cancel();
  th.classList.add("still");
  th.style.transform = `translateX(${p.x}px)`;
  th.style.width = p.w + "px";
  void th.offsetWidth;
  th.classList.remove("still");
}
function thumbSame(a, b) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.w - b.w) < 0.5;
}
// 活动项现在在哪；null = 控件还没布局出来（display:none）
function thumbTo(box, on) {
  if (!on || !on.offsetParent || !on.offsetWidth) return null;
  return { x: on.offsetLeft, w: on.offsetWidth };
}
/* 控件尺寸变了（窗口缩放、字体加载、从不可见变为可见）：白片**静止**归位。
   magpie 的 thumbFit 是同一个 ResizeObserver。 */
const segFit = new ResizeObserver((es) => {
  for (const { target: box } of es) {
    const th = box.querySelector(":scope > .thumb");
    const on = box.querySelector(":scope > .on");
    const to = thumbTo(box, on);
    if (!th || !to) continue;
    const now = thumbNow(th);
    if (now && thumbSame(now, to)) continue;
    thumbPut(th, to);
  }
});
function slideThumb(box) {
  if (!box) return;
  let th = box.querySelector(":scope > .thumb");
  if (!th) {
    th = document.createElement("span");
    th.className = "thumb";
    box.prepend(th);
  }
  segFit.observe(box);
  const on = box.querySelector(":scope > .on");
  if (!on) { th.style.opacity = "0"; return; }
  th.style.opacity = "";
  const to = thumbTo(box, on);
  if (!to) return;               // 不可见：等 ResizeObserver 在可见时归位
  const from = thumbNow(th);
  thumbPut(th, to);
  if (!from || thumbSame(from, to)) return;
  th.animate(
    [{ transform: `translateX(${from.x}px)`, width: from.w + "px" },
     { transform: `translateX(${to.x}px)`, width: to.w + "px" }],
    { duration: THUMB_MS, easing: THUMB_EASE, id: "thumb" });
}

// 本地日期（**不走 toISOString**：那是 UTC，跨时区会错一天）。
function dashDay(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dashAddDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function dashNum(n) {
  return Math.round(Number(n) || 0).toLocaleString("zh-CN");
}

/* 视图切换：工作区 ⇄ 总览 ⇄ 设置。
   ⚠️ 总览/设置打开时主区是 visibility:hidden（不是 display:none）：布局尺寸还在，
   这样 PTY 的起始 resize 拿的是**真实列/行**，不会走 Go 的 80x24 兜底、
   也不会在切回来时让 CLI 重画开场（见 CSS「#app.dash」那段）。
   visibility:hidden 已经让格子不可聚焦，但焦点还停在 xterm 的 textarea 上时
   键盘会继续往那里送 —— 所以照样先 blur 一次。
   回来时再 refit/focus 一次（和收起/展开同一个理由）。 */
function setNavView(view) {
  if (view !== "workspace" && view !== "dash" && view !== "settings") return;
  // 记下"来设置页之前在哪"（Esc 回退用），离开设置页时把搜索清干净。
  if (view !== NAV_HERE && NAV_HERE !== "settings") NAV_PREV = NAV_HERE;
  if (view !== "settings" && NAV_HERE === "settings" &&
      typeof clearSettingsSearch === "function") clearSettingsSearch(false);
  NAV_HERE = view;
  const app = $("app");
  app.classList.toggle("dash", view === "dash");
  app.classList.toggle("settings", view === "settings");
  renderNav();
  if (view === "dash") {
    if (typeof acClose === "function") acClose();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderDashboard("进入总览");
  } else if (view === "settings") {
    // 行内详情属于总览的 Agent 名单；离开总览就收起（见 89-agent-cfg.js）。
    if (typeof acClose === "function") acClose();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // 先按缓存画（第一帧不空），同时问 Go 要权威值（默认目录是不是还在盘上
    // 只有 Go 知道）。settings 消息回来时 syncSettingsUI 会再刷一遍。
    renderSettings("进入设置");
    sendCtrl({ type: "settings.get" });
    // 进来就能直接打字搜索（Orca 的设置页同样把焦点交给搜索框）。
    if (typeof focusSettingsSearch === "function") focusSettingsSearch(false);
  } else {
    if (typeof acClose === "function") acClose();
    requestAnimationFrame(() => {
      if (!activeTab) return;
      activeTab.refit();
      activeTab.focus();
    });
    renderLists(searchKey());
    viewProbe("回到工作区");
  }
}

/* ⚠️ 按钮只建一次，之后只切 .on / aria-selected。
   原来每次 `seg.innerHTML = ...` 会把 .thumb 一起销毁，slideThumb 每次都拿到
   一枚全新的白片、没有"从哪来"，于是**滑动动画从来没播过** —— 这是 2026-10-17
   对齐 magpie 时量出来的真 bug。白片必须活过重绘。 */
function renderDashTabs() {
  const seg = $("dash-tabs");
  if (!seg) return;
  if (!seg.querySelector(".opt")) {
    seg.innerHTML = DASH_TABS.map(([id, key]) =>
      `<button type="button" class="opt" data-dtab="${id}" role="tab">${esc(t(key))}</button>`
    ).join("");
  }
  for (const b of seg.querySelectorAll(".opt")) {
    const row = DASH_TABS.find(([id]) => id === b.dataset.dtab);
    if (row) b.textContent = t(row[1]);
    const on = b.dataset.dtab === dashTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  slideThumb(seg);
}

/* 四个读数全部来自 Perch 自己的会话库与格子状态：在跑 / 今日轮次 /
   会话总数 / 活跃日。网关的请求与 token 读数在网关页，不在总览重复。 */
function renderDashKpis() {
  const host = $("dash-kpi");
  if (!host) return;
  const sess = STATE?.sessions || [];
  const act = STATE?.activity || [];
  const byDay = new Map(act.map((a) => [a.day, a]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayN = (byDay.get(dashDay(today)) || {}).turns || 0;
  let week = 0;
  for (let i = 0; i < 7; i++) {
    week += (byDay.get(dashDay(dashAddDays(today, -i))) || {}).turns || 0;
  }
  const live = TAB_LIST.filter((t) => t.id > 0);
  const running = live.filter((t) => !t.connDown).length;
  const need = needModel();

  const kpi = (n, label, sub) =>
    `<div class="ck"><b>${n}</b><span>${label}</span>` +
    `<small>${esc(sub)}</small></div>`;
  host.innerHTML =
    kpi(tCount("dash.kpi.panes", running), t("dash.kpi.running"),
      tCount("dash.kpi.runningSub", live.length, { panes: live.length, need: need.wait.length })) +
    kpi(dashNum(todayN), t("dash.kpi.turnsToday"),
      t("dash.kpi.turnsSub", { week: dashNum(week), days: act.length })) +
    kpi(dashNum(sess.length), t("dash.kpi.sessions"), t("dash.kpi.sessionsSub")) +
    kpi(dashNum(act.length), t("dash.kpi.activeDays"), t("dash.kpi.activeDaysSub"));
}

/* 53 周 × 7 天。周一在最上、月份在顶行 —— 和 magpie 的 Usage 热力图同一副骨架。
   所有格子用**显式 grid-column/grid-row** 摆位：月份标签和日期格在同一张 grid 里，
   靠自动排布会把它们挤到同一行。数据只有一种口径：Perch 会话库里的轮次。 */
function heatPoints() {
  return (STATE?.activity || []).map((a) => ({
    day: a.day, v: a.turns | 0, extra: a.sessions | 0,
  }));
}
function renderHeat() {
  const grid = $("dash-heat");
  if (!grid) return;
  const pts = heatPoints();
  const byDay = new Map(pts.map((a) => [a.day, a]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;               // 周一 = 0
  const start = dashAddDays(today, -(52 * 7 + dow));  // 53 周前那个周一
  // 分位数分档：p50 / p75 / p90，0 是没活动。
  const vals = pts.map((a) => a.v).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
  const t1 = q(0.5), t2 = q(0.75), t3 = q(0.9);
  const lv = (v) => v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4;

  // 每 2.5s 一次推送里只要今天有请求，series 的合计就会变。整张重画会把鼠标
  // 正悬停的格子从 DOM 里换掉 —— tooltip 随之消失（实测）。所以同一天内只
  // 就地改格子的 class / 数据，不重建节点；换天或首次才建骨架。
  const todayKey = dashDay(today);
  // 语言切换要重建骨架：月份/星期的标签是画在骨架上的一次性文本。
  const canPatch = grid.dataset.day === todayKey &&
    grid.dataset.locale === PERCH_LOCALE &&
    grid.querySelectorAll("i").length === 371;
  if (canPatch) {
    for (const el of grid.querySelectorAll("i[data-day]")) {
      const k = el.dataset.day;
      const a = byDay.get(k);
      const v = a ? a.v : 0;
      el.className = "lv" + lv(v);
      el.dataset.v = String(v);
      el.dataset.x = String(a ? a.extra : 0);
    }
  } else {
    const WD = [t("dash.wd.mon"), "", t("dash.wd.wed"), "", t("dash.wd.fri"), "", t("dash.wd.sun")];
    // 月份标签交给 Intl：中文给「11月」，英文给「Nov」。骨架只在换天/换语言时重建。
    const monthFmt = new Intl.DateTimeFormat(PERCH_LOCALE === "zh" ? "zh-CN" : "en", { month: "short" });
    let html = `<span class="mo" style="grid-column:1;grid-row:1"></span>`;
    let lastMonth = -1;
    for (let c = 0; c < 53; c++) {
      const monday = dashAddDays(start, c * 7);
      if (monday.getMonth() !== lastMonth) {
        lastMonth = monday.getMonth();
        // 「11月」这种三个字，两格（~26px）放不下会被裁成「1月」——
        // 给三格；月份最短也有 4 周，下一枚标签从 c+6 起，不会撞上。
        const span = (c + 4 <= 54) ? 3 : 2;
        html += `<span class="mo" style="grid-column:${c + 2} / span ${span};grid-row:1">` +
          `${esc(monthFmt.format(monday))}</span>`;
      }
    }
    for (let r = 0; r < 7; r++) {
      html += `<span class="wd" style="grid-row:${r + 2}">${WD[r]}</span>`;
      for (let c = 0; c < 53; c++) {
        const d = dashAddDays(start, c * 7 + r);
        const st = `grid-column:${c + 2};grid-row:${r + 2}`;
        if (d > today) { html += `<i class="fut" style="${st}"></i>`; continue; }
        const k = dashDay(d);
        const a = byDay.get(k);
        const v = a ? a.v : 0;
        html += `<i class="lv${lv(v)}" style="${st}" data-day="${k}"` +
          ` data-v="${v}" data-x="${a ? a.extra : 0}"></i>`;
      }
    }
    grid.innerHTML = html;
    grid.dataset.day = todayKey;
    grid.dataset.locale = PERCH_LOCALE;
    const tip = $("dash-heat-tip");
    if (tip) tip.hidden = true;
  }

  const sub = $("dash-heat-sub");
  if (sub) {
    const total = (STATE?.sessions || []).reduce((n, s) => n + (s.turns | 0), 0);
    sub.textContent = pts.length
      ? tCount("dash.heat.turnsSub", total, {
          total: dashNum(total),
          days: pts.filter((p) => p.v > 0).length,
        })
      : t("dash.heat.noTurns");
  }
}

/* 顶部是**工作区入口**，不是网关状态条。
   用户 2026-10-17 评审原话："总览页面，你顶部放一个 magpie 的连接显示不合适" ——
   用不用网关是另一件事，不该占据总览的第一行。这一行回答的是"我现在这边怎么样"，
   并把「进入工作区 / 新建工作区」摆在手边（用户点名要的入口）。 */
function renderDashStatus() {
  const host = $("dash-status");
  if (!host) return;
  const live = TAB_LIST.filter((t) => t.id > 0);
  const running = live.filter((t) => !t.connDown).length;
  const need = needModel();
  const projs = (STATE?.projects || []).length;
  // ⚠️ 结构只建一次，之后只改数字 —— 这一行每 700ms 跟着 renderDashLive 重画，
  // 整块 innerHTML 会把按钮换掉；mousedown 与 mouseup 落在两个不同元素上，
  // 那次点击就静默丢了（和 seg 的 thumb 是同一类毛病）。
  // 语言切换时也要重建：这一行的文字只在建骨架时写一次，之后只改数字。
  if (!host.querySelector("[data-wsact]") || host.dataset.locale !== PERCH_LOCALE) {
    host.dataset.locale = PERCH_LOCALE;
    // 数词和单位分开：0/1 的单复数只换单位那一段，骨架不必重建
    // （重建会把按钮换掉，mousedown/mouseup 落在两颗元素上就丢点击）。
    host.innerHTML =
      `<span class="brand"><b>${esc(t("dash.status.workspace"))}</b></span>` +
      `<span class="ws-stat">${esc(t("dash.status.runningLabel"))} <b id="dash-ws-run">0</b> ` +
        `<span id="dash-ws-run-unit">${esc(tCount("dash.status.panesUnit", running))}</span></span><span class="sep">·</span>` +
      `<span class="ws-stat">${t("dash.status.need", { n: '<b id="dash-ws-need">0</b>' })}</span><span class="sep">·</span>` +
      `<span class="ws-stat"><b id="dash-ws-proj">0</b> ` +
        `<span id="dash-ws-proj-unit">${esc(tCount("dash.status.projectsUnit", projs))}</span></span>` +
      `<span class="right">` +
      `<button type="button" class="ws-act" data-wsact="enter">${esc(t("dash.status.enter"))}</button>` +
      `<button type="button" class="ws-act primary" data-wsact="new">${esc(t("dash.status.new"))}</button>` +
      `</span>`;
  }
  $("dash-ws-run").textContent = dashNum(running);
  $("dash-ws-need").textContent = dashNum(need.wait.length);
  $("dash-ws-proj").textContent = dashNum(projs);
  $("dash-ws-run-unit").textContent = tCount("dash.status.panesUnit", running);
  $("dash-ws-proj-unit").textContent = tCount("dash.status.projectsUnit", projs);
}

/* 「新建工作区」= 打开「文件夹 + Agent」卡片（2026-10-19 用户点名的形态）。
   卡片里的「选择其他文件夹…」仍然走同一条 project.add；只是新路径先落到卡片里，
   由用户决定要不要顺手开一个 agent。
   ⚠️ newWsPending 那套快照判据保留给老的调用点/回退路径：现在没有地方再设置它，
   所以正常的卡片流程不会把用户从总览拽走。 */
let newWsPending = null;
let newWsPendingAt = 0;
function startNewWorkspace() {
  openNewSpace({ why: "总览「新建工作区」" });
}

$("dash-status").addEventListener("click", (e) => {
  const b = e.target.closest("[data-wsact]");
  if (!b) return;
  if (b.dataset.wsact === "enter") {
    setNavView("workspace");
  } else if (b.dataset.wsact === "new") {
    startNewWorkspace();
  }
});

/* 「在等你」读的是右栏「需要你」同一个模型（needModel），不是另算一份。
   右栏在这个视图里退场，所以同一份数据不会在同一屏说两遍。 */
function renderDashNeed() {
  const host = $("dash-need");
  if (!host) return;
  const M = needModel();
  const cnt = $("dash-need-cnt");
  if (cnt) cnt.textContent = String(M.wait.length);
  if (!M.rows.length) {
    host.innerHTML = `<div class="empty">${t("dash.need.empty")}</div>`;
    return;
  }
  const rows = M.wait.length ? M.wait : M.quiet;
  // 标题固定叫「在等你」，所以没有待办时不能说「在等你 · 3」——那三行是空闲。
  const cap = M.wait.length
    ? t("dash.need.capWaiting", { n: M.wait.length })
    : tCount("dash.need.capIdle", M.quiet.length, { n: M.quiet.length });
  host.innerHTML = `<div class="cap">${cap}</div>` +
    rows.slice(0, 8).map(needRowHTML).join("");
}

/* Agent 接线台。清单由 Go 侧的 agentCatalogDefs 给（用户 2026-10-17 点名的那份），
   按三件事分成三组，因为它们是**三个不同的事实**：
     · 装没装 —— 本机配置/CLI 探测（不是"我猜"）
     · 接没接 —— Perch 自己的 agentDefs 里有没有适配器
     · 今天走没走网关 —— magpie 的真实请求数（0 次也是证据）
   每组三列，30px 彩色 logo + 名称 + 厂商/今日流量 + 状态；未安装的**不压暗**
   （压暗会把 logo 一起吞掉）。 */
/* 安装台按 agent 分开记：{ [id]: {id,name,state,phase,source,lines,…} }。
   同时点几个时每个都有自己的状态和日志；INSTALL_AT 只是"现在面板显示哪个"。
   声明放在这里是因为 86 的名单行要先读它，88-install.js 负责行为。 */
let INSTALLS = Object.create(null);
let INSTALL_AT = "";

/* 当前 magpie 那份读数（给接入模型）。“读到了 agent 列表”与“网关在不在”
   是两件事：前者决定能不能说「magpie 不支持它」，后者决定去不去设置。
   GW_AGENTS 在 89-agent-cfg.js 里声明；本函数只在启动闸打开后被调用。 */
function dashMagpieState() {
  const m = mg();
  return {
    state: m ? (m.state || "unknown") : "unknown",
    agentsKnown: Array.isArray(GW_AGENTS),
  };
}

/* 一行的最小视图：探测 + 控制面接线 + 当前模型。所有判断在 08-agent-model.js。 */
function dashAgentView(card) {
  const gw = typeof gwInfoFor === "function" ? gwInfoFor(card.id) : null;
  return agentRouteView(card, gw, dashMagpieState());
}

/* 名单 = 可安装的 catalog + 引擎已识别但 catalog 没有的 agent。
   后者没有安装信息，但仍然能在行上接入、选模型、看字段。 */
function dashAgentMerged() {
  const m = mg();
  const cat = (m && m.catalog) || [];
  const rows = Array.isArray(GW_AGENTS) ? GW_AGENTS : [];
  const by = new Map();
  for (const c of cat) {
    by.set(c.id, { card: c, gw: null, installed: !!c.installed, engineOnly: false });
  }
  for (const a of rows) {
    const x = by.get(a.id);
    if (x) {
      x.gw = a;
      x.installed = true;
      continue;
    }
    by.set(a.id, {
      card: {
        id: a.id, name: a.name || a.id, icon: a.icon || "",
        vendor: a.vendor || "", path: a.path || "",
        installed: true, caps: {},
      },
      gw: a, installed: true, engineOnly: true,
    });
  }
  return [...by.values()];
}

/* 子行返回的是 HTML（不是纯文本）：运行中的格子要在「运行中」前面带一颗绿点，
   但仍然要把厂商/路径转义。名单位置由调用方直接拼。 */
function dashAgentSub(x) {
  const { card, gw } = x;
  const detail = card.vendor || gw?.vendor || card.path || gw?.path || "";
  if (!x.installed) return esc(detail);
  const live = typeof liveAgentTab === "function" ? liveAgentTab(card.id) : null;
  return esc(detail) + (live
    ? `${detail ? " · " : ""}<i class="ag-live" aria-hidden="true"></i>${esc(t("dash.agents.running"))}`
    : "");
}

/* 行上的模型 chip 空间有限：网关路由的标签常带引擎前缀
   （magpie/deepseek/deepseek-flash）。前缀在总览上下文里没有信息量，
   去掉它再显示；完整标签留在 title 里。 */
function dashModelShort(label) {
  const s = String(label || "");
  return /^magpie\//i.test(s) ? s.slice(7) : s;
}

function dashModelChipHTML(x) {
  const { card, v } = x;
  if (!v) return "";
  const ga = typeof gwInfoFor === "function" ? gwInfoFor(card.id) : null;
  if (ga && ga.connectable === false) {
    return `<span class="ag-model no" title="${esc(t("dash.agents.notConnectableHint"))}">` +
      `${esc(t("dash.agents.notConnectable"))}</span>`;
  }
  if (v.ownMenu) {
    return `<span class="ag-model own" title="${esc(t("dash.agents.modelInMenuHint"))}">` +
      `${esc(t("dash.agents.modelInMenu"))}</span>`;
  }
  if (!v.hasGatewayModels) {
    return `<button type="button" class="ag-model none" data-gwlink` +
      ` title="${esc(t("dash.agents.noModelsHint"))}">${esc(t("dash.agents.noModels"))}</button>`;
  }
  if (!v.modelField) return "";
  const full = v.modelLabel || (v.wired ? t("dash.agents.wiredNoModel") : t("dash.agents.chooseModel"));
  const label = dashModelShort(full);
  const hint = t("dash.agents.modelHint", { name: card.name || card.id }) +
    (full && full !== label ? ` · ${full}` : "");
  return `<button type="button" class="ag-model${v.wired ? " on" : ""}"` +
    ` data-agentmodel="${esc(card.id)}" aria-haspopup="listbox" aria-expanded="false"` +
    ` title="${esc(hint)}">` +
    `<span>${esc(label)}</span><i aria-hidden="true">▾</i></button>`;
}

function dashConnectHTML(x) {
  const { card, v } = x;
  if (!v) return "";
  const ga = typeof gwInfoFor === "function" ? gwInfoFor(card.id) : null;
  if (ga && ga.connectable === false) {
    return `<span class="ag-sw no" title="${esc(t("dash.agents.notConnectableHint"))}"><i></i></span>`;
  }
  if (!v.hasGatewayModels) {
    return `<button type="button" class="ag-sw add" data-gwlink` +
      ` title="${esc(t("dash.agents.addProviderHint"))}"><i></i></button>`;
  }
  const busy = GW_AGENT_BUSY === card.id;
  return `<button type="button" class="ag-sw${v.wired ? " on" : ""}" role="switch"` +
    ` aria-checked="${v.wired}" data-agentconnect="${esc(card.id)}"` +
    `${busy ? " disabled" : ""}` +
    ` title="${esc(v.wired ? t("dash.agents.disconnectHint") : t("dash.agents.connectHint"))}">` +
    `<i></i></button>`;
}

function dashPrimaryHTML(x) {
  const { card, v } = x;
  if (v && v.canOpen) {
    const live = typeof liveAgentTab === "function" ? liveAgentTab(card.id) : null;
    return `<button type="button" class="ag-open" data-launch="${esc(card.id)}"` +
      ` title="${esc(t(live ? "dash.agents.viewTitle" : "dash.agents.openTitle", { name: card.name || card.id }))}">` +
      `${esc(t(live ? "dash.agents.view" : "dash.agents.open"))}</button>`;
  }
  if (card.url) {
    return `<button type="button" class="ag-open quiet" data-docs="${esc(card.id)}"` +
      ` title="${esc(t("dash.agents.docsTitle", { name: card.name || card.id }))}">` +
      `${esc(t("dash.agents.docs"))}</button>`;
  }
  return `<span class="ag-open ghost" aria-hidden="true"></span>`;
}

function dashInstallHTML(x) {
  const { card } = x;
  const inst = INSTALLS[card.id];
  if (inst && inst.state === "running") {
    return `<span class="ag-inst-busy">${esc(inst.phase === "scanning"
      ? t("dash.agents.installScanning")
      : inst.phase === "queued" ? t("dash.agents.installQueued")
        : t("dash.agents.installBusy"))}</span>`;
  }
  if (card.install) {
    return `<button type="button" class="ag-open" data-install="${esc(card.id)}"` +
      ` title="${esc(t("dash.agents.installTitle", { name: card.name || card.id }))}">` +
      `${esc(t("dash.agents.install"))}</button>`;
  }
  if (card.url) {
    return `<button type="button" class="ag-open quiet" data-docs="${esc(card.id)}"` +
      ` title="${esc(t("dash.agents.docsTitle", { name: card.name || card.id }))}">` +
      `${esc(t("dash.agents.docs"))}</button>`;
  }
  return `<span class="ag-open ghost" aria-hidden="true"></span>`;
}

function dashAgentRowHTML(x) {
  const { card, gw, installed } = x;
  const id = esc(card.id);
  const name = card.name || card.id;
  if (!installed) {
    return `<div class="ag-item missing" data-agitem="${id}">` +
      `<div class="ag missing">` +
      iconHTML(card.icon) +
      `<span class="who"><span class="nm">${esc(name)}</span>` +
      `<span class="sub" title="${esc(card.path || card.vendor || "")}">${esc(card.vendor || "")}</span></span>` +
      dashInstallHTML(x) +
      `</div></div>`;
  }
  const v = dashAgentView(card);
  x.v = v;
  const open = AC_ID === card.id;
  const detail = open && typeof acDetailHTML === "function"
    ? `<div class="ag-detail" data-agdetail="${id}">${acDetailHTML(gw, card, v)}</div>` : "";
  return `<div class="ag-item${open ? " open" : ""}" data-agitem="${id}">` +
    `<div class="ag" data-agrow="${id}" role="button" tabindex="0"` +
    ` aria-expanded="${open}" title="${esc(card.path || gw?.path || "")}">` +
    iconHTML(card.icon) +
    `<span class="who"><span class="nm">${esc(name)}</span>` +
    `<span class="sub">${dashAgentSub(x)}</span></span>` +
    dashModelChipHTML(x) + dashConnectHTML(x) + dashPrimaryHTML(x) +
    `<span class="ag-chev" aria-hidden="true">${open ? "▴" : "▾"}</span>` +
    `</div>${detail}</div>`;
}

/* 网关状态 + 供应商入口，挂在 Agent 工作台的表头。 */
function renderDashAgentGw() {
  const host = $("dash-agent-gw");
  if (!host) return;
  const m = mg();
  const providers = Array.isArray(GW_PROVIDERS) ? GW_PROVIDERS.length
    : (m && Array.isArray(m.providers) ? m.providers.length : 0);
  const models = m && Array.isArray(m.models) ? m.models.length : 0;
  const running = !!(m && m.state === "running") || (typeof gwOn === "function" && gwOn());
  let html = "";
  if (!m) {
    html = `<span class="gw-dot"></span><span>${esc(t("dash.agents.gwReading"))}</span>`;
  } else if (!running) {
    html = `<span class="gw-dot warn"></span><span>${esc(t("dash.agents.gwDown"))}</span>` +
      `<button type="button" class="ag-link" data-gwstart>${esc(t("dash.agents.gwStart"))}</button>`;
  } else if (!providers) {
    html = `<span class="gw-dot on"></span><span>${esc(t("dash.agents.gwNoProviders"))}</span>` +
      `<button type="button" class="ag-link" data-gwlink>${esc(t("dash.agents.addProvider"))}</button>`;
  } else {
    const summary = providers === 1 && models === 1
      ? t("dash.agents.gwSummaryOne", { providers, models })
      : t("dash.agents.gwSummary", { providers, models });
    html = `<span class="gw-dot on"></span><span>${esc(summary)}</span>` +
      `<button type="button" class="ag-link" data-gwlink>${esc(t("dash.agents.manageProviders"))}</button>`;
  }
  html += `<button type="button" class="ag-rescan" data-agentrescan` +
    ` title="${esc(t("dash.agents.rescan"))}" aria-label="${esc(t("dash.agents.rescan"))}">↻</button>`;
  host.innerHTML = html;
}

function dashAgentGroup(label, items) {
  return `<div class="ag-group">${esc(label)}<span>${items.length}</span></div>` +
    items.map(dashAgentRowHTML).join("");
}

/* 总览 Agent 工作台。重画契约见顶部注释：
   - 选择器开着 / 详情里有输入控件获得焦点时，推迟到关闭后再画；
   - 展开状态 AC_ID 保留；
   - 2.5s 的用量推送不触发这里。 */
function renderDashAgents() {
  const host = $("dash-agent-list");
  if (!host) return;
  if (typeof AC_PICK !== "undefined" && AC_PICK) { AGENT_RENDER_PENDING = true; return; }
  if (typeof AC_MODEL_POP !== "undefined" && AC_MODEL_POP) { AGENT_RENDER_PENDING = true; return; }
  if (AC_ID && typeof acDetailEditing === "function" && acDetailEditing()) {
    AGENT_RENDER_PENDING = true;
    return;
  }
  AGENT_RENDER_PENDING = false;
  const merged = dashAgentMerged();
  const installed = merged.filter((x) => x.installed);
  const missing = merged.filter((x) => !x.installed);
  const sub = $("dash-agent-sub");
  if (sub) {
    sub.textContent = merged.length
      ? t("dash.agents.summary", { installed: installed.length, installable: missing.length })
      : t("dash.agents.scanning");
  }
  renderDashAgentGw();
  if (!merged.length) {
    host.innerHTML = `<div class="ag-empty">${esc(t("dash.agents.listPending"))}</div>`;
    return;
  }
  let html = "";
  if (installed.length) html += dashAgentGroup(t("dash.agents.group.installed"), installed);
  if (missing.length) html += dashAgentGroup(t("dash.agents.group.installable"), missing);
  if (!installed.length) html += `<div class="ag-empty">${esc(t("dash.agents.emptyAll"))}</div>`;
  host.innerHTML = html;
}

/* 选择器关闭后，把推迟的名单重画补上。 */
function dashFlushAgentRender() {
  if (!AGENT_RENDER_PENDING) return;
  AGENT_RENDER_PENDING = false;
  renderDashAgents();
}

/* ---------------------------------------------------------------------------
   总览 · 网关用量卡
   --------------------------------------------------------------------------- */

function dashCompact(n) {
  n = Number(n) || 0;
  if (n < 1000) return dashNum(n);
  try {
    return new Intl.NumberFormat(PERCH_LOCALE === "zh" ? "zh-CN" : "en",
      { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : (n / 1e3).toFixed(1) + "k";
  }
}
function dashMoney(n) {
  const v = Number(n) || 0;
  return "$" + v.toFixed(v > 0 && v < 1 ? 3 : 2);
}
function dashUsageCurrent() {
  if (DASH_USAGE_PERIOD === "today") {
    const m = mg();
    return (m && m.todayUsage) || GW_USAGE.today || null;
  }
  return GW_USAGE[DASH_USAGE_PERIOD] || null;
}
function dashUsagePeriodLabel(p) {
  return t("dash.usage.period." + p);
}
function renderDashUsagePeriod() {
  const host = $("dash-usage-period");
  if (!host) return;
  if (host.dataset.locale !== PERCH_LOCALE || !host.querySelector("[data-usageperiod]")) {
    host.dataset.locale = PERCH_LOCALE;
    host.innerHTML = DASH_USAGE_PERIODS.map((p) =>
      `<button type="button" class="usage-opt${p === DASH_USAGE_PERIOD ? " on" : ""}"` +
      ` data-usageperiod="${p}" role="tab" aria-selected="${p === DASH_USAGE_PERIOD}">` +
      `${esc(dashUsagePeriodLabel(p))}</button>`).join("");
    return;
  }
  for (const b of host.querySelectorAll("[data-usageperiod]")) {
    const on = b.dataset.usageperiod === DASH_USAGE_PERIOD;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
}
function dashUsageKpisHTML(u) {
  const t0 = u.totals || {};
  const prompt = (t0.input || 0) + (t0.cacheRead || 0) + (t0.cacheWrite || 0);
  const hit = prompt ? Math.round(100 * (t0.cacheRead || 0) / prompt) + "%" : "—";
  const kpi = (label, value, sub) =>
    `<div class="uk"><span>${esc(label)}</span><b>${esc(value)}</b>` +
    (sub ? `<small>${esc(sub)}</small>` : "") + `</div>`;
  return `<div class="usage-kpis">` +
    kpi(t("dash.usage.calls"), dashNum(t0.calls),
      t0.errors ? t("dash.usage.failed", { n: dashNum(t0.errors) }) : t("dash.usage.noErrors")) +
    kpi(t("dash.usage.tokens"), dashCompact((t0.input || 0) + (t0.output || 0)),
      t("dash.usage.tokensSub", { input: dashCompact(t0.input), output: dashCompact(t0.output) })) +
    kpi(t("dash.usage.cache"), dashCompact(t0.cacheRead),
      t("dash.usage.hitRate", { pct: hit })) +
    kpi(t("dash.usage.cost"), dashMoney(t0.cost),
      t0.unpriced ? t("dash.usage.unpriced", { n: dashNum(t0.unpriced) }) : "") +
    `</div>`;
}
function dashUsageRowHTML(r, total) {
  const tokens = (r.input || 0) + (r.output || 0);
  const pct = total > 0 ? Math.max(1.5, Math.round(100 * tokens / total)) : 0;
  const sub = r.sub ? `${r.sub} · ` : "";
  return `<div class="ur">` +
    iconHTML(r.icon || "") +
    `<span class="un"><b>${esc(r.name || r.id || "?")}</b>` +
    `<small>${esc(sub)}${esc(tCount("dash.usage.callsN", r.calls, { n: dashNum(r.calls) }))}` +
    ` · ${esc(dashCompact(tokens))}</small>` +
    `<i class="ubar" aria-hidden="true"><i style="width:${pct}%"></i></i></span>` +
    `<span class="uc">${esc(r.cost ? dashMoney(r.cost) : dashCompact(tokens))}</span>` +
    `</div>`;
}
function renderDashUsage() {
  renderDashUsagePeriod();
  const host = $("dash-usage");
  if (!host) return;
  const u = dashUsageCurrent();
  let html = "";
  if (!u) {
    if (GW_USAGE_ERR) {
      html = `<div class="usage-note bad">${esc(msgText(GW_USAGE_ERR))}` +
        `<button type="button" class="ag-link" data-usageretry>${esc(t("dash.usage.retry"))}</button></div>`;
    } else if (DASH_USAGE_PERIOD !== "today" && GW_USAGE_LOADING === DASH_USAGE_PERIOD) {
      html = `<div class="usage-note"><span class="spin"></span>${esc(t("dash.usage.loading"))}</div>`;
    } else if (typeof gwOn === "function" && !gwOn()) {
      html = `<div class="usage-note">${esc(t("dash.usage.down"))}` +
        `<button type="button" class="ag-link" data-gwlink>${esc(t("dash.usage.manage"))}</button></div>`;
    } else {
      html = `<div class="usage-note">${esc(t("dash.usage.loading"))}</div>`;
    }
  } else {
    const rows = DASH_USAGE_METRIC === "models" ? (u.models || []) : (u.agents || []);
    const total = rows.reduce((n, r) => n + (r.input || 0) + (r.output || 0), 0);
    const top = rows.slice(0, 5);
    html = dashUsageKpisHTML(u) +
      `<div class="usage-switch" role="tablist" aria-label="${esc(t("dash.usage.metricAria"))}">` +
      `<button type="button" class="useg${DASH_USAGE_METRIC === "agents" ? " on" : ""}"` +
      ` data-usagemetric="agents" role="tab" aria-selected="${DASH_USAGE_METRIC === "agents"}">` +
      `${esc(t("dash.usage.byAgent"))}</button>` +
      `<button type="button" class="useg${DASH_USAGE_METRIC === "models" ? " on" : ""}"` +
      ` data-usagemetric="models" role="tab" aria-selected="${DASH_USAGE_METRIC === "models"}">` +
      `${esc(t("dash.usage.byModel"))}</button></div>` +
      (top.length
        ? `<div class="usage-list">${top.map((r) => dashUsageRowHTML(r, total)).join("")}</div>`
        : `<div class="usage-note">${esc(t("dash.usage.empty"))}</div>`) +
      `<div class="usage-foot"><button type="button" class="ag-link" data-gwlink>` +
      `${esc(t("dash.usage.manage"))} →</button></div>`;
    if (GW_USAGE_LOADING === DASH_USAGE_PERIOD) {
      html = `<div class="usage-loading"><span class="spin"></span></div>` + html;
    }
  }
  const was = document.activeElement;
  const metric = was && was.dataset ? was.dataset.usagemetric : "";
  if (host.__uhtml === html) return;
  host.__uhtml = html;
  host.innerHTML = html;
  if (metric) {
    const b = host.querySelector(`[data-usagemetric="${metric}"]`);
    if (b) b.focus({ preventScroll: true });
  }
}
function dashLoadUsage(period, force) {
  if (!DASH_USAGE_PERIODS.includes(period)) return;
  if (period === "today" && dashUsageCurrent() && !force) return;
  if (typeof gwOn !== "function" || !gwOn()) {
    GW_USAGE_ERR = { key: "dash.usage.down" };
    GW_USAGE_LOADING = "";
    renderDashUsage();
    return;
  }
  const req = ++GW_USAGE_REQ;
  GW_USAGE_LOADING = period;
  GW_USAGE_ERR = null;
  renderDashUsage();
  clearTimeout(GW_USAGE_TIMER);
  // 推送丢失时不要永远转圈：13s（比后端 12s HTTP 超时略长）后给出可重试的错误。
  GW_USAGE_TIMER = setTimeout(() => {
    if (GW_USAGE_LOADING !== period) return;
    GW_USAGE_LOADING = "";
    GW_USAGE_ERR = { key: "dash.usage.timeout" };
    if (DASH_USAGE_PERIOD === period) renderDashUsage();
  }, 13000);
  sendCtrl({ type: "gw.usage", period });
  return req;
}
function dashSetUsagePeriod(period) {
  if (!DASH_USAGE_PERIODS.includes(period)) return;
  DASH_USAGE_PERIOD = period;
  try { localStorage.setItem("perch.usagePeriod", period); } catch { /* 只这一次 */ }
  renderDashUsage();
  // 今天走 2.5s 的 MAGPIE 快照；其余周期每次切回来都重取一次 ——
  // 只在“没有缓存”时取会让 7d 卡片在发出新请求后一直停在旧数字。
  if (period !== "today" || !dashUsageCurrent()) dashLoadUsage(period, true);
}

/* gw.usage 推送落点（20-ctl.js）。 */
function applyGwUsage(m) {
  if (!m || typeof m !== "object") return;
  clearTimeout(GW_USAGE_TIMER);
  GW_USAGE_TIMER = 0;
  const p = m.period || "today";
  if (m.err) {
    if (p === GW_USAGE_LOADING) {
      GW_USAGE_ERR = errMsgOf(m);
      GW_USAGE_LOADING = "";
    }
    if (p === DASH_USAGE_PERIOD) renderDashUsage();
    return;
  }
  if (m.usage && typeof m.usage === "object") GW_USAGE[p] = m.usage;
  if (GW_USAGE_LOADING === p) GW_USAGE_LOADING = "";
  GW_USAGE_ERR = null;
  if (p === DASH_USAGE_PERIOD) renderDashUsage();
}

/* 打开行上的模型选择器。选中后只写配置/接入，不替用户开格子。 */
function dashOpenAgentModel(anchor, id) {
  const x = dashAgentMerged().find((y) => y.card.id === id);
  const v = x ? dashAgentView(x.card) : null;
  const field = v && v.modelField;
  if (!field) {
    showToast(t("dash.agents.noModels"), "", "info");
    return;
  }
  const ok = acModelPickOpen(anchor, id, field, v.wired ? (v.currentModel || "") : "",
    (value) => {
      if (!value) return;
      GW_AGENT_BUSY = id;
      acSetFieldFor(id, field.key, value, true, false);
      renderDashAgents();
    },
    { applyLabel: t(v.wired ? "dash.agents.applyModel" : "dash.agents.connectModel") });
  if (!ok) showToast(t("dash.agents.noModels"), t("dash.agents.noModelsHint"), "info");
}

function dashToggleAgentConnect(id) {
  const x = dashAgentMerged().find((y) => y.card.id === id);
  const v = x ? dashAgentView(x.card) : null;
  if (!v) return;
  if (!v.hasGatewayModels) {
    if (typeof gwOpenProviders === "function") gwOpenProviders();
    return;
  }
  if (v.wired) {
    acOpen(id, true);
    AC_CONFIRM = true;
    AC_ERR = null;
    sendCtrl({ type: "gw.agent.preview", id });
    renderDashAgents();
    return;
  }
  GW_AGENT_BUSY = id;
  sendCtrl({ type: "gw.agent.connect", id });
  renderDashAgents();
}

function dashHandleGwAction(e) {
  const link = e.target.closest("[data-gwlink]");
  if (link) {
    e.preventDefault();
    if (typeof gwOpenProviders === "function") gwOpenProviders();
    return true;
  }
  const start = e.target.closest("[data-gwstart]");
  if (start) {
    e.preventDefault();
    sendCtrl({ type: "gw.engine.start" });
    return true;
  }
  const rescan = e.target.closest("[data-agentrescan]");
  if (rescan) {
    e.preventDefault();
    if (typeof GW_AGENTS_LOADING !== "undefined") GW_AGENTS_LOADING = true;
    sendCtrl({ type: "gw.agents.rescan" });
    return true;
  }
  return false;
}

$("dash-agent-gw").addEventListener("click", dashHandleGwAction);
$("dash-agent-list").addEventListener("click", (e) => {
  if (dashHandleGwAction(e)) return;
  const model = e.target.closest("[data-agentmodel]");
  if (model) {
    e.preventDefault();
    e.stopPropagation();
    dashOpenAgentModel(model, model.dataset.agentmodel);
    return;
  }
  const sw = e.target.closest("[data-agentconnect]");
  if (sw) {
    e.preventDefault();
    e.stopPropagation();
    dashToggleAgentConnect(sw.dataset.agentconnect);
    return;
  }
  const row = e.target.closest("[data-agrow]");
  if (!row || e.target.closest("button, a, input, select, textarea, label")) return;
  acOpen(row.dataset.agrow);
});
$("dash-agent-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest("[data-agrow]");
  if (!row || e.target !== row) return;
  e.preventDefault();
  acOpen(row.dataset.agrow);
});
$("dash-usage-period").addEventListener("click", (e) => {
  const b = e.target.closest("[data-usageperiod]");
  if (b) dashSetUsagePeriod(b.dataset.usageperiod);
});
$("dash-usage").addEventListener("click", (e) => {
  if (dashHandleGwAction(e)) return;
  const m = e.target.closest("[data-usagemetric]");
  if (m) {
    DASH_USAGE_METRIC = m.dataset.usagemetric;
    renderDashUsage();
    return;
  }
  const retry = e.target.closest("[data-usageretry]");
  if (retry) dashLoadUsage(DASH_USAGE_PERIOD, true);
});

/* 网关页 = Perch 原生页面（2026-10-22）。它由 87-gateway.js 管：
   状态条 + 已添加供应商 + 供应商目录 + 编辑器。总览的读数仍来自两条腿：
     · MAGPIE（只读、2.5s）—— 引擎 /v1/magpie/* 的用量读数；
     · GW（按需）—— 控制面连接状态，决定引擎态与数据请求。 */
function renderDashboard(why) {
  if (NAV_HERE !== "dash") return;
  const t0 = performance.now();
  renderDashTabs();
  for (const [id] of DASH_TABS) {
    const el = $("dash-" + id);
    if (el) el.hidden = id !== dashTab;
  }
  // 让新显出来的那一页重播一次进入动画（先摘掉再放回，同一帧里浏览器不会重播）。
  const pane = $("dash-" + dashTab);
  if (pane) { pane.style.animation = "none"; void pane.offsetWidth; pane.style.animation = ""; }
  renderDashStatus();
  renderDashKpis();
  renderDashNeed();
  renderHeat();
  renderDashAgents();
  renderDashUsage();
  if (DASH_USAGE_PERIOD !== "today" && !GW_USAGE[DASH_USAGE_PERIOD] &&
      GW_USAGE_LOADING !== DASH_USAGE_PERIOD) {
    dashLoadUsage(DASH_USAGE_PERIOD);
  }
  if (typeof gwAgentsPrefetch === "function") gwAgentsPrefetch();
  renderGateway();
  dashProbe(why, performance.now() - t0);
}

// 实时读数（700ms 跟着 renderLive 走）：只重画 Perch 自己那几个秒级读数
// （在跑 / 在等你）。热力图、Agent 名单、网关页都不在这里重画 ——
// 它们的数据来自会话库重扫和引擎推送，不是 700ms 的本地状态。
function renderDashLive() {
  if (NAV_HERE !== "dash") return;
  renderDashStatus();
  renderDashKpis();
  renderDashNeed();
}

/* 总览的自证读数：盒子多大、哪一页、几格、几个活跃日、多少轮。
   截图只能看出"像不像"，这些数才是"它到底画了什么"的字节证据。
   magpie 每 2.5s 推一次，读数不变时不能跟着刷日志（一天 3 万多行）——
   同一读数 30s 内只记一次；切页、换视图、数值真变了仍然立刻落。 */
let DASH_PROBE_SIG = "", DASH_PROBE_AT = 0;
function dashProbe(why, ms) {
  const b = $("dash") ? $("dash").getBoundingClientRect() : null;
  const on = document.querySelector("#dash-tabs .on");
  const act = STATE?.activity || [];
  const total = (STATE?.sessions || []).reduce((n, s) => n + (s.turns | 0), 0);
  const line = `总览 进入=${why} 视图=${NAV_HERE} 页=${dashTab}` +
    ` 盒子=${b && NAV_HERE === "dash" ? Math.round(b.width) + "x" + Math.round(b.height) : "-"}` +
    ` 标签=${on ? on.textContent : "?"}` +
    ` 热力格=${document.querySelectorAll("#dash-heat i[data-day]").length}` +
    ` 活跃日=${act.length} 累计轮次=${total}` +
    (ms ? ` 用时=${ms.toFixed(1)}ms` : "");
  const now = performance.now();
  const sig = line.replace(/用时=[\d.]+ms$/, "");
  if (why.startsWith("magpie=") && sig === DASH_PROBE_SIG &&
      now - DASH_PROBE_AT < 30000) return;
  DASH_PROBE_SIG = sig;
  DASH_PROBE_AT = now;
  bootFact(line);
}

$("dash-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dtab]");
  if (!b || b.dataset.dtab === dashTab) return;
  dashTab = b.dataset.dtab;
  // 行内详情挂在总览的 Agent 名单上；换页就收起。
  if (typeof acClose === "function") acClose();
  try { localStorage.setItem("perch.dashTab", dashTab); } catch { /* 存不了就只在这一次生效 */ }
  renderDashTabs();
  for (const [id] of DASH_TABS) {
    const el = $("dash-" + id);
    if (el) el.hidden = id !== dashTab;
  }
  const pane = $("dash-" + dashTab);
  if (pane) { pane.style.animation = "none"; void pane.offsetWidth; pane.style.animation = ""; }
  // 网关页的自动接入只在它真的可见时才跑（这条守卫在 gwAutoAttach 里），
  // 所以切进来这一下必须立刻画一次，否则要等到下一条 2.5s 推送。
  if (dashTab === "gateway") renderGateway();
  bootFact(`总览 切页=${dashTab}`);
});


