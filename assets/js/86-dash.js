"use strict";
/* 86-dash.js —— 总览（读数、热力图、实时、在等你、Agent 名单）。
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


/* 热力图口径：轮次来自 Perch 自己的会话库，请求来自 magpie 的网关。
   两套数据放在同一副 53 周骨架上，用户切一下就能对照"我干了多少"和"网关替我发了多少"。 */
let heatMetric = "turns";
try {
  const k = localStorage.getItem("perch.heatMetric");
  if (k === "turns" || k === "calls") heatMetric = k;
} catch { /* 存不了就用默认 */ }

/* MAGPIE：最近一次网关快照（见 magpie.go）。null = 后端还没交付，
   这时不画"0"，画 "—" —— 零和"没数据"是两件不同的事。 */
let MAGPIE = null;
let MG_SIG = "";      // 热力图口径用的指纹（避免每 2.5s 重画 371 个格子）
let MG_CAT_SIG = "";  // Agent 名单指纹（安装状态/今日流量变了才重画）


function mg() {
  return MAGPIE && MAGPIE.state ? MAGPIE : null;
}
function mgLive() {
  const m = mg();
  return !!(m && m.state === "running");
}
function mgCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}
function mgPromptOf(u) {
  return (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0);
}
function mgSpeed(u) {
  if (!u || !u.decode_ms) return "—";
  return (u.decode_out / (u.decode_ms / 1000)).toFixed(0);
}
function mgTTFT(u) {
  if (!u || !u.timed) return "—";
  return Math.round(u.ttft_ms / u.timed) + "ms";
}
function mgCacheRate(u) {
  const p = mgPromptOf(u || {});
  return p ? Math.round((100 * (u.cache_read || 0)) / p) : null;
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
function magpieLogo(cls) {
  const c = " " + (cls || "");
  return `<span class="ico-mask${c}" aria-hidden="true" style="-webkit-mask-image:url('icons/magpie.svg');mask-image:url('icons/magpie.svg')"></span>`;
}
/* 图标文件缺失（例如 magpie 报了一个我们没有的 icon id）时不要留 404 空白。
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
    // 配置抽屉属于总览的 Agent 名单；离开总览就收起（见 89-agent-cfg.js）。
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

/* 六个读数：左边两格是 Perch 自己的（在跑 / 轮次），右边四格是网关的
   （请求 / 缓存 / 上下文 / 速度）。没有数据时写 "—" —— 0 是一个读数，
   "网关没开"是另一件事，两者不能长成一个零。 */
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

  const m = mg(), on = mgLive();
  const mt = (m && m.today) || {}; // magpie 的今日读数；别叫 today，上面有日期
  const ctx = (m && m.context) || {};
  const cache = on ? mgCacheRate(mt) : null;
  const ctxPct = ctx.window ? Math.round((100 * ctx.prompt) / ctx.window) : null;
  const ctxSub = ctx.window
    ? `${mgCompact(ctx.prompt)} / ${mgCompact(ctx.window)} · ${ctx.model || ""}`
    : on ? (ctx.model
        ? t("dash.kpi.windowUnknown", { model: ctx.model })
        : t("dash.kpi.noRequests"))
      : t("dash.kpi.gatewayDown");
  const failSub = on
    ? (mt.retried
        ? t("dash.kpi.failedRetried", { n: dashNum(mt.errors || 0), retried: dashNum(mt.retried) })
        : t("dash.kpi.failed", { n: dashNum(mt.errors || 0) }))
    : t("dash.kpi.gatewayDown");
  const cacheSub = on
    ? t("dash.kpi.cacheSub", {
        read: mgCompact(mt.cache_read || 0),
        prompt: mgCompact(mgPromptOf(mt)),
      })
    : t("dash.kpi.gatewayDown");

  const kpi = (n, label, sub, bad) =>
    `<div class="ck"><b>${n}</b><span>${label}</span>` +
    `<small${bad ? ' class="bad"' : ""}>${esc(sub)}</small></div>`;
  host.innerHTML =
    kpi(tCount("dash.kpi.panes", running), t("dash.kpi.running"),
      tCount("dash.kpi.runningSub", live.length, { panes: live.length, need: need.wait.length })) +
    kpi(dashNum(todayN), t("dash.kpi.turnsToday"),
      t("dash.kpi.turnsSub", { week: dashNum(week), days: act.length })) +
    kpi(on ? mgCompact(mt.calls || 0) : "—", t("dash.kpi.requestsToday"), failSub, on && mt.errors > 0) +
    kpi(cache == null ? "—" : cache + "%", t("dash.kpi.cacheHit"), cacheSub) +
    kpi(ctxPct == null ? "—" : ctxPct + "%", t("dash.kpi.context"), ctxSub) +
    kpi(on ? mgSpeed(mt) : "—", t("dash.kpi.outputSpeed"),
      on ? t("dash.kpi.avgFirstToken", { ttft: mgTTFT(mt) }) : t("dash.kpi.gatewayDown"));
}

/* 53 周 × 7 天。周一在最上、月份在顶行 —— 和 magpie 的 Usage 热力图同一副骨架。
   所有格子用**显式 grid-column/grid-row** 摆位：月份标签和日期格在同一张 grid 里，
   靠自动排布会把它们挤到同一行。
   两种口径（轮次 / 请求）共用这一张骨架：切 tab 只换数据，不换版式。 */
function heatPoints() {
  if (heatMetric === "calls") {
    const m = mg();
    return (m?.series || []).map((x) => ({
      day: x.day, v: x.calls | 0, extra: (x.errors | 0),
    }));
  }
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
      el.dataset.metric = heatMetric;
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
          ` data-v="${v}" data-x="${a ? a.extra : 0}" data-metric="${heatMetric}"></i>`;
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
    if (heatMetric === "calls") {
      const m = mg();
      const calls = pts.reduce((n, p) => n + p.v, 0);
      sub.textContent = !m
        ? t("dash.heat.pending")
        : m.state !== "running"
          ? t("dash.heat.down")
          : pts.some((p) => p.v > 0)
            ? tCount("dash.heat.callsSub", calls, {
                total: dashNum(calls),
                days: pts.filter((p) => p.v > 0).length,
              })
            : t("dash.heat.noCalls");
    } else {
      const total = (STATE?.sessions || []).reduce((n, s) => n + (s.turns | 0), 0);
      sub.textContent = pts.length
        ? tCount("dash.heat.turnsSub", total, {
            total: dashNum(total),
            days: pts.filter((p) => p.v > 0).length,
          })
        : t("dash.heat.noTurns");
    }
  }
}

/* 今日 token 构成：缓存读 / 输入 / 输出 / 缓存写，四段一条。
   缓存读占绝大多数是常态（agent 每轮都复用前缀），分开一色才看得出用量花在哪。 */
function renderDashMix() {
  const bar = $("dash-mix-bar"), leg = $("dash-mix-legend");
  if (!bar || !leg) return;
  const m = mg(), on = mgLive();
  const today = on ? (m?.today || {}) : {};
  const segs = [
    { k: "cache", label: t("dash.mix.cache"), v: today.cache_read || 0 },
    { k: "input", label: t("dash.mix.input"), v: today.input || 0 },
    { k: "output", label: t("dash.mix.output"), v: today.output || 0 },
    { k: "write", label: t("dash.mix.write"), v: today.cache_write || 0 },
  ];
  const total = segs.reduce((n, s) => n + s.v, 0);
  const sub = $("dash-mix-sub"), cost = $("dash-mix-cost");
  if (sub) {
    sub.textContent = !m ? t("dash.mix.pending")
      : !on ? t("dash.kpi.gatewayDown")
      : total ? t("dash.mix.total", { n: mgCompact(total) }) : t("dash.mix.noUsage");
  }
  if (cost) cost.textContent = on && (today.cost || 0) > 0
    ? t("dash.mix.cost", { n: today.cost.toFixed(2) })
    : "";
  bar.innerHTML = total
    ? segs.filter((s) => s.v > 0).map((s) =>
        `<i class="${s.k}" style="flex:${s.v} 0 0" title="${s.label} ${mgCompact(s.v)}"></i>`).join("")
    : `<i class="input" style="flex:1"></i>`;
  // 输出通常只占零点几个百分点；四舍五入成「0%」会像是在说"没有输出"。
  const share = (v) => !total || v === 0 ? "0%"
    : (100 * v / total) >= 10 ? Math.round(100 * v / total) + "%"
    : (100 * v / total).toFixed(1) + "%";
  leg.innerHTML = total
    ? segs.map((s) => `<span><i class="${s.k}"></i>${s.label} <b>${mgCompact(s.v)}</b>` +
        `<em>${share(s.v)}</em></span>`).join("")
    : `<span>${esc(t("dash.mix.empty"))}</span>`;
}

/* 最近请求的耗时形状：旧 → 新，一根一根柱；红柱是失败。
   「实时」那列给的是每条的字（agent / model / ms），这里给的是**形状**——
   同一批元数据，不读 prompt。 */
function renderDashLat() {
  const host = $("dash-lat-bars");
  if (!host) return;
  const m = mg(), on = mgLive();
  const rows = on ? (m?.recent || []).slice(0, 16) : [];
  const good = rows.filter((r) => (r.status | 0) < 400);
  const avg = good.length
    ? Math.round(good.reduce((n, r) => n + (r.ms | 0), 0) / good.length) : 0;
  const sub = $("dash-lat-sub");
  if (sub) {
    sub.textContent = !m ? t("dash.mix.pending")
      : !on ? t("dash.kpi.gatewayDown")
      : rows.length
        ? t("dash.lat.sub", { n: rows.length, ms: dashNum(avg) })
        : t("dash.lat.noRequests");
  }
  if (!rows.length) {
    host.innerHTML = `<span class="lat-empty">${esc(t("dash.live.empty"))}</span>`;
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.ms | 0));
  host.innerHTML = rows.slice().reverse().map((r) => {
    const bad = (r.status | 0) >= 400;
    const h = Math.max(2, Math.round(44 * (r.ms | 0) / max));
    const at = (r.t || "").slice(11, 19);
    return `<i class="${bad ? "bad" : ""}" style="height:${h}px" title="${esc(at)} · ` +
      `${esc(r.agentName || r.agent || "")} · ${esc(r.model || r.served || "")} · ` +
      `${bad ? "HTTP " + (r.status | 0) : dashNum(r.ms) + "ms"}"></i>`;
  }).join("");
}

/* 顶部是**工作区入口**，不是网关状态条。
   用户 2026-10-17 评审原话："总览页面，你顶部放一个 magpie 的连接显示不合适" ——
   用不用网关是另一件事，不该占据总览的第一行。这一行回答的是"我现在这边怎么样"，
   并把「进入工作区 / 新建 Agent」摆在手边（用户点名要的入口）。 */
function renderDashStatus() {
  const host = $("dash-status");
  if (!host) return;
  const live = TAB_LIST.filter((t) => t.id > 0);
  const running = live.filter((t) => !t.connDown).length;
  const need = needModel();
  // 默认会话区是合成条目，不是“项目”；和左栏导航的计数用同一条口径。
  const projs = (STATE?.projects || []).filter((p) => !p.synthetic).length;
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

/* 总览右上角是「新建 Agent」：项目/无项目 + Agent 是独立的一步。
   加文件夹走左栏的「添加项目」，总览不再承担项目池的添加。 */
function startNewAgent() {
  openNewAgent({ why: "总览「新建 Agent」" });
}

$("dash-status").addEventListener("click", (e) => {
  const b = e.target.closest("[data-wsact]");
  if (!b) return;
  if (b.dataset.wsact === "enter") {
    setNavView("workspace");
  } else if (b.dataset.wsact === "new") {
    startNewAgent();
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

/* "有没有下载"是用户 2026-10-17 定的分界线：已检测到的按「接没接进 Perch」
   分成两组；没检测到的收进 magpie 那个样式的折叠栏里。
   2026-10-19 用户把默认改成了**展开**：收起时页面底部会空一截，先让用户
   看到完整清单；要收起是他们自己的动作（同一个会话里不会被重画弹回去）。 */
let agentsFoldOpen = true;

/* ===========================================================================
   Perch 自己的 Agent 工作板（隔离网关，2026-10-22）
   ---------------------------------------------------------------------------
   magpie 的 Agent 页上半部分在这里重生：每行一个 agent，明确写「未设置 /
   已设置」，模型直接从网关目录里选；安装仍然走 Perch 自己的一键安装。
   数据来自 ctl 的 agent.profiles（Perch 自己的 agent-profiles.json +
   引擎 /api/providers），**不是** magpie 的全局 agent 配置。

   非隔离模式（默认）保持旧的三列名单和右侧抽屉不变；只有后端说
   isolated=true 时才启用这块。
   =========================================================================== */
let AGENT_UI_ISOLATED = false;
let AGENT_PROFILES = Object.create(null);
let AGENT_MODELS = [];
let AGENT_PROFILE_ASKED = false;
let AGENT_PROFILE_AT = 0;
let AGENT_PROFILE_ERR = "";
let AGENT_DETAIL_ID = "";
let GW_AGENT_BUSY = "";
let GW_FIELD_POP = null;
let AGENT_MODEL_POP = null;
let AGENT_MODELS_POP = null;
let AGENT_SETS = [];
let AGENT_SET_PENDING = "";
let AGENT_SET_NAMING = false;
let AGENT_SET_DRAFT = "";
// 网关/模型/安装状态变了，但用户正开着选择器：先记下来，等空闲再刷。
let GW_CONFIG_REFRESH_PENDING = false;
let GW_CONFIG_REFRESH_TIMER = 0;
// magpie 的 Agents 页默认把未设置/未检测到的收在 "Show N more" 下面。
let PERCH_FOLD_OPEN = false;
// 网关 /api/state 已识别、但不在下载名单里的 agent：单独折叠，只配置、不安装/启动。
let PERCH_EXTRA_FOLD_OPEN = false;

/* 模型目录（agent.profiles 里的 models）以前只请求一次。首次进总览时网关
   还没起来，拿到的就是空数组；之后加供应商也不会再问，于是必须重启。
   现在：失败后 10s 内不重试，超过就再问；网关连上/安装完成/从网关页切回
   都用 force 立即再问。 */
function ensureAgentProfiles(force) {
  const now = Date.now();
  if (!force && AGENT_PROFILE_ASKED) {
    if (!AGENT_PROFILE_ERR || now - AGENT_PROFILE_AT < 10000) return;
  }
  AGENT_PROFILE_ASKED = true;
  AGENT_PROFILE_AT = now;
  try { sendCtrl({ type: "agent.profiles" }); } catch (e) { /* 控制通道还没起就等下次 */ }
}

/* 网关配置统一刷新：profile/models + gw agents 一起重读。
   如果选择器/写入正在进行，先挂起，避免把用户正在挑的东西冲掉。 */
function refreshGatewayConfig() {
  GW_CONFIG_REFRESH_PENDING = true;
  if (typeof gwAgentsBusyHere === "function" && gwAgentsBusyHere()) {
    if (!GW_CONFIG_REFRESH_TIMER) {
      GW_CONFIG_REFRESH_TIMER = setTimeout(() => {
        GW_CONFIG_REFRESH_TIMER = 0;
        maybeRefreshGatewayConfig();
      }, 1000);
    }
    return;
  }
  GW_CONFIG_REFRESH_PENDING = false;
  if (GW_CONFIG_REFRESH_TIMER) {
    clearTimeout(GW_CONFIG_REFRESH_TIMER);
    GW_CONFIG_REFRESH_TIMER = 0;
  }
  if (typeof gwAgentsReset === "function") gwAgentsReset();
  if (typeof gwAgentsPrefetch === "function") gwAgentsPrefetch(true);
  ensureAgentProfiles(true);
}

function maybeRefreshGatewayConfig() {
  if (GW_CONFIG_REFRESH_PENDING) refreshGatewayConfig();
}

function applyAgentProfiles(m) {
  AGENT_UI_ISOLATED = !!(m && m.isolated);
  const next = Object.create(null);
  for (const p of (m && m.agents) || []) {
    if (p && p.agent) next[p.agent] = p;
  }
  AGENT_PROFILES = next;
  AGENT_MODELS = Array.isArray(m && m.models) ? m.models : [];
  AGENT_SETS = Array.isArray(m && m.sets) ? m.sets : [];
  // 不因为一次普通推送关掉正在输入的方案名：只有保存/取消/应用成功才关。
  AGENT_SET_PENDING = "";
  AGENT_PROFILE_ERR = (m && typeof errMsgOf === "function") ? (errMsgOf(m) || "") : "";
  AGENT_PROFILE_AT = Date.now();
  if (AGENT_MODEL_POP) dashModelClose(false);
  if (AGENT_UI_ISOLATED && typeof AC_ID !== "undefined" && AC_ID &&
      typeof acClose === "function") acClose();
  if (NAV_HERE === "dash") renderDashAgents();
  maybeRefreshGatewayConfig();
}

/* 模型标签压缩：网关路由的标签常带引擎前缀（magpie/deepseek/...），
   在行里没有信息量；完整标签留在 title 里。 */
function dashModelShort(label) {
  const s = String(label || "");
  return /^magpie\//i.test(s) ? s.slice(7) : s;
}

function dashContextLabel(n) {
  n = Number(n) || 0;
  if (!n) return "—";
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + "M";
  return Math.round(n / 1000) + "k";
}

function perchAlias(id) {
  const s = String(id || "agent").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return "group/perch-" + (s || "agent");
}

function perchProfileOf(id) { return AGENT_PROFILES[id] || null; }

function perchModelOf(p) {
  if (!p || !p.model) return null;
  return AGENT_MODELS.find((m) => m && m.id === p.model) || null;
}

function perchHiddenSet(id) {
  const p = perchProfileOf(id);
  return new Set(Array.isArray(p && p.hidden) ? p.hidden : []);
}

// 这个 agent 的模型选择器里实际展示的模型：收起的去掉，但当前主模型/
// 档位模型始终保留（magpie 也不允许把正在用的模型藏掉）。
function perchVisibleModels(id, extraKeep) {
  const p = perchProfileOf(id);
  const hidden = perchHiddenSet(id);
  const keep = new Set(extraKeep || []);
  if (p && p.model) keep.add(p.model);
  if (p && p.tiers) for (const t of Object.keys(p.tiers)) {
    if (p.tiers[t] && p.tiers[t].model) keep.add(p.tiers[t].model);
  }
  return AGENT_MODELS.filter((m) => m && m.id && (!hidden.has(m.id) || keep.has(m.id)));
}

function perchModelLabel(p) {
  if (!p || !p.model) return "";
  const m = perchModelOf(p);
  return m ? (m.name || m.id) : dashModelShort(p.model);
}

function perchGoGateway() {
  const b = document.querySelector('#dash-tabs .opt[data-dtab="gateway"]');
  if (b) b.click();
}

function perchCaps(a) {
  return a.caps || {
    launch: !!a.adapter, status: !!a.adapter, waiting: !!a.adapter, inject: false,
  };
}

/* ---------------------------------------------------------------------------
   引擎托管的 agent（agy / dsh / Gemini 这类）：配置由 magpie 的 /api/state
   字段和 /api/set 写进 Perch 自己的沙盒，不在 Perch 里另存一份模型。
   Claude/Codex/Pi/OpenCode 继续走 Perch 的每格注入（下面 wireable），
   因为它们的运行中会话要下一轮生效、还要状态适配器。
   --------------------------------------------------------------------------- */
function gwFieldOfAgent(g, key) {
  const fs = g && Array.isArray(g.fields) ? g.fields : [];
  return fs.find((f) => f && f.key === key) || null;
}

function gwFieldName(f) {
  if (!f) return "";
  return (typeof acFieldLabel === "function") ? acFieldLabel(f) : (f.label || f.key);
}

function gwOptionLabel(f, o) {
  if (!o) return "";
  if (typeof acOptName === "function") return acOptName(f, o);
  return o.label || o.value || "";
}

function gwValueLabel(f, value) {
  if (!f) return "";
  const o = (f.options || []).find((x) => x && x.value === value);
  return o ? gwOptionLabel(f, o) : dashModelShort(value);
}

function gwDefaultLabel(g, f) {
  if (typeof acDefaultLabel === "function") return acDefaultLabel(g, f);
  return t("dash.agents.gwFieldDefault");
}

// 引擎字段里有 magpie/… 选项 = 这个字段能接进 Perch 的网关。只有这类
// agent 才画模型 chip 和接入开关；Cursor 这种官方只让选 auto 的仍是本机配置。
// magpie 的选项值不一定带 magpie/ 前缀：Gemini 用自己的拼法（gemini-4-argon，
// workbuddy/auto…），但会带 ref / “via magpie” 标记。ref 是更稳的判据。
function gwIsGatewayOption(o) {
  return !!o && !gwIsRoutingGroup(o) &&
    (!!o.ref || String(o.value || "").startsWith("magpie/"));
}

function gwGatewayOptions(f) {
  return (f && Array.isArray(f.options) ? f.options : []).filter(gwIsGatewayOption);
}

// magpie 的 Routing groups 是路由组别名，不是供应商模型。`group/perch-*`
// 是 Perch 给四个每格注入的 agent 建的内部别名（换模型/档位下一轮生效），
// `auto/*` 是 magpie 自己的路由组。agy/dsh 的模型选择器不该出现它们。
function gwIsRoutingGroup(o) {
  return !!o && (o.group === "Routing groups" ||
    /^magpie\/group\//.test(String(o.value || "")));
}

function gwVisibleFieldOptions(f) {
  let out = (f && Array.isArray(f.options) ? f.options : []).filter((o) => !gwIsRoutingGroup(o));
  // 引擎托管行是“经 Perch 网关”的模型选择器：DSH 这类还会列出本机
  // DeepSeek 直连模型，选了就等于绕过网关（甚至断开）。这里只留
  // magpie/… 的网关模型，直连留在「使用自己的配置」那一侧。
  if (f && f.key === "model") {
    out = out.filter(gwIsGatewayOption);
  }
  return out;
}

// 引擎字段里有 magpie/… 模型选项，就说明这个 CLI 能被网关接入。未接入
// 时它仍按用户自己的配置启动（EngineDef 只在 wired 后换沙盒）；开关和
// 模型选择先在这里完成，接入后的下一次开格才走引擎沙盒。
// 引擎状态是配置资格的权威：只要 /api/state 认出了它，且已接入或有网关模型，
// 就应该能配置。不再看 Perch 自己的 installed/launch —— Qoder 的 PATH 探测
// 失败时仍要能选模型/接入；开格能力另由 caps.launch 控制。
function gwStateConnectable(g) {
  if (!g) return false;
  if (g.wired) return true;
  const fields = Array.isArray(g.fields) ? g.fields : [];
  return fields.some((f) => gwGatewayOptions(f).length > 0);
}

function gwEngineManaged(a) {
  if (!a || perchCaps(a).inject) return false;
  return gwStateConnectable(gwAgentOf(a.id));
}

// 名单外但网关已识别的 agent：只生成配置卡，不进入下载/安装/启动路径。
// 完整 caps 形状是给 perchCaps/分组用的，别只写 launch。
function gwStateOnlyCards(list) {
  const known = new Set((list || []).map((a) => String(a.id).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const g of (Array.isArray(GW_AGENTS) ? GW_AGENTS : [])) {
    if (!g || !g.id) continue;
    const id = String(g.id);
    if (known.has(id.toLowerCase()) || seen.has(id) || !gwStateConnectable(g)) continue;
    seen.add(id);
    out.push({
      id,
      name: g.name || id,
      icon: g.icon || "",
      vendor: "",
      url: "",
      path: g.path || "",
      installed: true,
      adapter: false,
      install: false,
      windows: true,
      stateOnly: true,
      caps: {
        launch: false, inject: false, status: false, waiting: false,
        resume: false, actions: false, approvals: false, mechanism: "gateway",
      },
    });
  }
  return out;
}

function gwModelField(g) { return gwFieldOfAgent(g, "model"); }

function gwModelLabel(g) {
  const f = gwModelField(g);
  if (!f || !f.value) return "";
  const o = (f.options || []).find((x) => x && x.value === f.value);
  if (o && gwIsRoutingGroup(o)) return t("dash.agents.gwInternalRoute");
  return gwValueLabel(f, f.value);
}

// 引擎字段的 chip：结构照搬 magpie 的 fieldBtn（app.js:422-448）：
// 选项图标 → agent 图标 → 纯文字，值 + chevron；点击交给统一 picker。
// 不再把字段倒成原生 <select>，否则和 profile 行是两套控件语言。
function gwFieldChipHTML(g, f, id, busy) {
  const opts = gwVisibleFieldOptions(f);
  const cur = opts.find((o) => o.value === f.value) ||
    (f.options || []).find((o) => o && o.value === f.value);
  const routing = cur && gwIsRoutingGroup(cur);
  const label = routing ? t("dash.agents.gwInternalRoute")
    : f.value ? (cur ? gwOptionLabel(f, cur) : gwValueLabel(f, f.value))
      : gwDefaultLabel(g, f);
  const icon = cur && cur.icon ? iconHTML(cur.icon, "agp-mic") : "";
  const title = gwFieldName(f) + ": " + label + (cur && cur.note ? " · " + cur.note : "");
  return `<button type="button" class="agp-field${f.value ? "" : " empty"}"` +
    ` data-gwfieldpick="${esc(f.key)}" data-gwid="${esc(id)}"` +
    ` aria-haspopup="listbox" aria-expanded="false" title="${esc(title)}"` +
    `${busy ? " disabled" : ""}>${icon}` +
    `<span class="v">${esc(label)}</span><span class="chev" aria-hidden="true">▾</span></button>`;
}

// effort 用和 profile 行相同的分段 chip，而不是一个裸 select。
function gwEffortChipsHTML(g, f, id, busy) {
  const opts = gwVisibleFieldOptions(f);
  const on = (v) => (v === "" ? !f.value : f.value === v);
  const chip = (v, label) => `<button type="button" class="agp-effort${on(v) ? " on" : ""}"` +
    ` data-gwfieldset="${esc(id)}" data-field="${esc(f.key)}" data-value="${esc(v)}"` +
    `${busy ? " disabled" : ""}>${esc(label)}</button>`;
  const levels = opts.filter((o) => o.value !== "").map((o) => chip(o.value, gwOptionLabel(f, o))).join("");
  return `<span class="agp-efforts">${chip("", t("dash.agents.perchEffortDefault"))}${levels}</span>`;
}

// 一行 = label + 控件；label 列由 CSS 统一宽度，所有字段从同一条竖线开始。
function gwFieldRowHTML(g, f, id, busy) {
  const effort = f.key === "effort" || f.label === "effort" || f.label === "thinking";
  const value = effort ? gwEffortChipsHTML(g, f, id, busy) : gwFieldChipHTML(g, f, id, busy);
  return `<div class="agp-kv"><div class="agp-k">${esc(gwFieldName(f))}</div>` +
    `<div class="agp-v">${value}</div></div>`;
}

// magpie 的模型列表摘要：提供商 + 数量。settings 里的 g.models.by 已经分好组；
// 没有时从网关选项里推，不额外发请求。
function gwModelsSummaryHTML(g, id, busy) {
  const modelField = gwModelField(g);
  if (!modelField) return "";
  let by = g && g.models && Array.isArray(g.models.by) ? g.models.by : [];
  by = by.filter((m) => m && m.name && m.name !== "Routing groups" && (m.n | 0) > 0);
  if (!by.length) {
    const seen = new Map();
    for (const o of gwVisibleFieldOptions(modelField)) {
      const name = o.group || "";
      if (!name) continue;
      const cur = seen.get(name) || { name, icon: o.icon || "", n: 0 };
      cur.n++;
      if (!cur.icon && o.icon) cur.icon = o.icon;
      seen.set(name, cur);
    }
    by = [...seen.values()];
  }
  if (!by.length) return "";
  const chips = by.map((m) => `<span class="agp-pchip">` +
    `${m.icon ? iconHTML(m.icon, "agp-pic") : ""}` +
    `<span>${esc(m.name)}</span><span class="n">${m.n | 0}</span></span>`).join("");
  return `<div class="agp-kv"><div class="agp-k">${esc(t("dash.agents.perchModelList"))}</div>` +
    `<div class="agp-v agp-mlist"><span class="agp-pchips">${chips}</span>` +
    `<button type="button" class="agp-quiet" data-gwfieldpick="model" data-gwid="${esc(id)}"` +
    `${busy ? " disabled" : ""}>${esc(t("dash.agents.perchPick"))}</button>` +
    `</div></div>`;
}

function perchConfirm(opts) {
  if (typeof askConfirm === "function") return askConfirm(opts);
  return Promise.resolve(true);
}

// 引擎托管 agent 的接入开关：接入立刻写 magpie 的配置；断开先确认（会
// 恢复接入前的值）。繁忙时忽略重复点击，等下一次 /api/state 推送。
function gwToggleAgent(id) {
  const g = gwAgentOf(id);
  if (!g || GW_AGENT_BUSY) return;
  if (!g.wired) {
    GW_AGENT_BUSY = id;
    sendCtrl({ type: "gw.agent.connect", id });
    if (NAV_HERE === "dash") renderDashAgents();
    return;
  }
  perchConfirm({
    title: t("dash.agents.perchDisconnectTitle"),
    body: t("dash.agents.perchDisconnectBody"),
    ok: t("dash.agents.perchDisconnectOk"),
    danger: true,
  }).then((yes) => {
    if (!yes) return;
    GW_AGENT_BUSY = id;
    sendCtrl({ type: "gw.agent.disconnect", id });
    if (NAV_HERE === "dash") renderDashAgents();
  });
}

// Profiles 条：已保存的方案 + 保存当前。方案存的是 per-agent 模型/档位，
// 应用时由后端把每个 agent 写回并同步网关别名组；运行中的会话下一轮生效。
function perchProfilesHTML() {
  const chips = AGENT_SETS.map((s) => {
    const n = Array.isArray(s && s.agents) ? s.agents.length : 0;
    const pending = AGENT_SET_PENDING === s.name;
    return `<span class="agp-chip${pending ? " pending" : ""}" data-perchset="${esc(s.name)}"` +
      ` role="button" tabindex="0" title="${esc(t("dash.agents.perchProfileHint", { name: s.name, n }))}">` +
      `<span class="nm">${esc(s.name)}</span><span class="dot" aria-hidden="true"></span>` +
      `<span class="x" data-perchsetdel="${esc(s.name)}"` +
      ` title="${esc(t("dash.agents.perchProfileDelete"))}" aria-label="${esc(t("dash.agents.perchProfileDelete"))}">×</span>` +
      `</span>`;
  }).join("");
  let editor = "";
  if (AGENT_SET_NAMING) {
    editor = `<input id="perch-set-name" class="agp-setname" type="text" maxlength="60"` +
      ` value="${esc(AGENT_SET_DRAFT)}" placeholder="${esc(t("dash.agents.perchProfileName"))}"` +
      ` aria-label="${esc(t("dash.agents.perchProfileName"))}">` +
      `<button type="button" class="agp-setdo" data-perchsetapply>${esc(t("dash.agents.perchProfileSave"))}</button>` +
      `<button type="button" class="agp-setcancel" data-perchsetcancel>${esc(t("common.cancel"))}</button>`;
  } else {
    editor = `<button type="button" class="agp-setsave" data-perchsetsave>` +
      `${esc(t("dash.agents.perchSaveProfile"))}</button>`;
  }
  return `<div class="agp-profiles"><span class="agp-plabel">${esc(t("dash.agents.perchProfiles"))}</span>` +
    `<span class="agp-chips">${chips || `<span class="agp-phint">${esc(t("dash.agents.perchNoProfiles"))}</span>`}</span>` +
    `<span class="agp-pedit">${editor}</span></div>`;
}

function perchLeadHTML() {
  return `<div class="agp-lead">${esc(t("dash.agents.perchLead"))}</div>`;
}

function renderPerchAgentList(host, list, sub) {
  if (AGENT_MODEL_POP) dashModelClose(false);
  if (GW_FIELD_POP) gwFieldPopClose(false);
  const extras = gwStateOnlyCards(list);
  const installed = list.filter((a) => a.installed);
  // Claude/Codex/Pi/OpenCode 走 Perch 的每格注入（运行中的会话下一轮生效）。
  // 这个能力来自后端的 caps.inject，不再在这里写四个 id。
  const wireable = (a) => {
    const c = perchCaps(a);
    return !!(c.inject && c.launch);
  };
  const wired = installed.filter((a) => {
    const p = perchProfileOf(a.id);
    return wireable(a) && !!(p && p.model);
  });
  const unset = installed.filter((a) => {
    const p = perchProfileOf(a.id);
    return wireable(a) && !(p && p.model) && perchCaps(a).launch;
  });
  // 其余能由 magpie 字段写进 Perch 沙盒的 agent（agy、dsh、qoder…）：
  // 直接用 /api/state 的字段做配置。engine 从整份名单算，不要求 Perch 自己
  // 已经探测到可执行文件 —— 状态里的 wired/网关字段才是配置资格。
  const engine = list.filter((a) => !wireable(a) && gwEngineManaged(a));
  const engineIds = new Set(engine.map((a) => a.id));
  const own = installed.filter((a) =>
    !wireable(a) && !engineIds.has(a.id) && perchCaps(a).launch);
  const needs = installed.filter((a) =>
    !perchCaps(a).launch && !engineIds.has(a.id));
  const missing = list.filter((a) => !a.installed && !engineIds.has(a.id));

  const engineWired = (a) => !!(gwAgentOf(a.id) || {}).wired;
  const engineOn = engine.filter(engineWired).length;
  const engineOnAll = engineOn + extras.filter(engineWired).length;
  if (sub) {
    const bits = [];
    if (wired.length + engineOn) bits.push(t("dash.agents.perchSumSet", { n: wired.length + engineOn }));
    if (AGENT_MODELS.length) bits.push(t("dash.agents.perchSumModels", { n: AGENT_MODELS.length }));
    else if (AGENT_PROFILE_ERR) bits.push(t("dash.agents.perchGatewayErr"));
    sub.textContent = bits.join(" · ");
  }

  let html = perchLeadHTML();
  if (!AGENT_MODELS.length && !wired.length && !engineOnAll) {
    html += `<div class="agp-guide">` +
      `<b>${esc(t("dash.agents.perchGuideTitle"))}</b>` +
      `<p>${esc(t("dash.agents.perchGuideBody"))}</p>` +
      `<button type="button" class="dl" data-gwlink>${esc(t("dash.agents.perchGuideAction"))}</button>` +
      `</div>`;
  } else if (!AGENT_MODELS.length) {
    html += `<div class="agp-guide"><p>${esc(t("dash.agents.perchGatewayConnecting"))}</p></div>`;
  }

  const rows = wired.map((a) => perchRowHTML(a, "set")).join("") +
    engine.map((a) => perchEngineRowHTML(a)).join("") +
    unset.map((a) => perchRowHTML(a, "unset")).join("") +
    own.map((a) => perchRowHTML(a, "own")).join("") +
    needs.map((a) => perchRowHTML(a, "needs")).join("");
  html += `<div class="agp-list">` + rows;
  if (!installed.length && !engine.length) {
    html += `<div class="agp-empty">${esc(t("dash.agents.emptyAll"))}</div>`;
  }
  if (missing.length) {
    const label = PERCH_FOLD_OPEN
      ? t("dash.agents.perchFoldHide")
      : t("dash.agents.perchFoldShow", { n: missing.length });
    html += `<button type="button" class="agp-more${PERCH_FOLD_OPEN ? " open" : ""}"` +
      ` id="dash-agent-more" data-perchfold data-fold-count="${missing.length}"` +
      ` aria-expanded="${PERCH_FOLD_OPEN}"><span id="dash-agent-more-label">${esc(label)}</span>` +
      `<span class="chev" aria-hidden="true">▾</span></button>` +
      `<div class="agp-fold${PERCH_FOLD_OPEN ? " open" : ""}" id="dash-agent-fold"><div class="agp-fold-inner">` +
      `<div class="agp-cap">${esc(t("dash.agents.perchNotInstalled"))}<span>${missing.length}</span></div>` +
      missing.map((a) => perchRowHTML(a, "missing")).join("") +
      `</div></div>`;
  }
  if (extras.length) {
    const label = PERCH_EXTRA_FOLD_OPEN
      ? t("dash.agents.perchGwFoldHide")
      : t("dash.agents.perchGwFoldShow", { n: extras.length });
    html += `<button type="button" class="agp-more${PERCH_EXTRA_FOLD_OPEN ? " open" : ""}"` +
      ` id="dash-agent-gwmore" data-gwfold data-fold-count="${extras.length}"` +
      ` aria-expanded="${PERCH_EXTRA_FOLD_OPEN}"><span id="dash-agent-gwmore-label">${esc(label)}</span>` +
      `<span class="chev" aria-hidden="true">▾</span></button>` +
      `<div class="agp-fold${PERCH_EXTRA_FOLD_OPEN ? " open" : ""}" id="dash-agent-gwfold"><div class="agp-fold-inner">` +
      `<div class="agp-cap">${esc(t("dash.agents.perchGwFoldCap"))}<span>${extras.length}</span></div>` +
      extras.map(perchEngineRowHTML).join("") +
      `</div></div>`;
  }
  html += `</div>` + perchProfilesHTML();

  host.innerHTML = html;
  if (AGENT_SET_NAMING) {
    const inp = $("perch-set-name");
    if (inp) {
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (_) {}
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          perchCommitProfileSave(inp.value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          AGENT_SET_NAMING = false;
          AGENT_SET_DRAFT = "";
          renderDashAgents();
        }
      });
    }
  }
}

// 引擎托管行：magpie /api/state 的字段就是配置界面，Perch 只负责画和转发。
function perchEngineRowHTML(a) {
  const id = esc(a.id);
  const g = gwAgentOf(a.id) || {};
  const wired = !!g.wired;
  const busy = GW_AGENT_BUSY === a.id;
  const open = AGENT_DETAIL_ID === a.id;
  const name = a.name || g.name || a.id;
  const live = typeof liveAgentTab === "function" ? liveAgentTab(a.id) : null;
  const detail = a.path || g.path || a.vendor || "";
  const fields = Array.isArray(g.fields) ? g.fields : [];
  const modelField = gwModelField(g);
  const modelOpt = modelField && modelField.value
    ? (modelField.options || []).find((o) => o && o.value === modelField.value) : null;
  const modelLabel = gwModelLabel(g);
  const cliMissing = !!g.cliMissing || (!!a.install && !a.installed);
  const status = busy ? t("dash.agents.gwBusy")
    : wired ? t("dash.agents.gwConnected", { model: modelLabel || "—" })
      : cliMissing ? t("dash.agents.gwCliMissing")
        : t("dash.agents.gwUnwired");
  const chipLabel = modelLabel || t("dash.agents.perchPickModel");
  const chipIcon = modelOpt && modelOpt.icon ? iconHTML(modelOpt.icon, "agp-mic") : "";
  const chip = modelField
    ? `<button type="button" class="agp-field${wired ? "" : " empty"}"` +
      ` data-gwmodelpick="${id}" aria-haspopup="listbox" aria-expanded="false"` +
      ` title="${esc(t("dash.agents.gwModelHint"))}">` +
      `${chipIcon}<span class="v">${esc(chipLabel)}</span><span class="chev" aria-hidden="true">▾</span></button>`
    : `<span class="agp-field-slot" aria-hidden="true"></span>`;
  const link = `<button type="button" class="agp-link" data-gwdetail="${id}"` +
    ` aria-expanded="${open}">${esc(t("dash.agents.settings"))}` +
    `<span class="chev" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
  const sw = `<button type="button" class="agp-switch${wired ? " on" : ""}"` +
    ` data-gwswitch="${id}" role="switch" aria-checked="${wired}"` +
    ` title="${esc(wired ? t("dash.agents.perchSwitchOffHint") : t("dash.agents.perchSwitchOnHint"))}">` +
    `<i></i></button>`;
  const canOpen = !a.stateOnly && !!perchCaps(a).launch;
  const openBtn = canOpen
    ? `<button type="button" class="agp-open" data-launch="${id}"` +
      ` title="${esc(t("dash.agents.openTitle", { name }))}"` +
      ` aria-label="${esc(t("dash.agents.openTitle", { name }))}">▶</button>`
    : `<button type="button" class="agp-open off" aria-disabled="true"` +
      ` title="${esc(t("dash.agents.gwNoLaunch"))}"` +
      ` aria-label="${esc(t("dash.agents.gwNoLaunch"))}">▶</button>`;
  const installBtn = a.install && !perchCaps(a).launch
    ? `<button type="button" class="agp-quiet" data-install="${id}">${esc(t("dash.agents.perchRepairInstall"))}</button>`
    : "";

  let exp = "";
  if (open) {
    // 字段顺序和 magpie 的 agentRow 一致：model 最宽，effort 第二，其余在后。
    // 每个字段都是一行 label + 同一个 chip 控件；不再有“网关字段”这层嵌套。
    const rank = (f) => f.key === "model" ? 0
      : (f.key === "effort" || f.label === "effort" || f.label === "thinking") ? 1 : 2;
    const ordered = fields.slice().sort((x, y) => rank(x) - rank(y));
    const fieldRows = ordered.length
      ? ordered.map((f) => gwFieldRowHTML(g, f, a.id, busy)).join("")
      : `<div class="agp-kv"><div class="agp-k"></div>` +
        `<div class="agp-v"><span class="agp-dim">${esc(t("ac.fields.none"))}</span></div></div>`;
    let driftHTML = "";
    const d = g.drift;
    if (d) {
      const df = fields.find((f) => f.key === d.field);
      const want = df && d.want ? gwValueLabel(df, d.want) : (d.want || "");
      const whyKey = {
        unwired: "ac.drift.unwired", replaced: "ac.drift.replaced",
        bypassed: "ac.drift.bypassed", unreachable: "ac.drift.unreachable",
        proxied: "ac.drift.proxied",
      }[d.kind] || "ac.drift.generic";
      driftHTML = `<div class="ac-drift"><b>${esc(t(whyKey, { who: name, want }))}</b>` +
        `<div class="agp-exp-acts">` +
        `<button type="button" class="agp-quiet" data-gwreapply="${id}">${esc(t("ac.action.reapply"))}</button>` +
        (d.kind === "replaced"
          ? `<button type="button" class="agp-quiet" data-gwkeep="${id}">${esc(t("ac.keep"))}</button>`
          : "") +
        `</div></div>`;
    }
    exp = `<div class="agp-exp"><div class="agp-exp-body">` +
      fieldRows + gwModelsSummaryHTML(g, a.id, busy) + driftHTML +
      `</div><div class="agp-exp-foot">` +
      (canOpen
        ? `<button type="button" class="agp-quiet accent" data-launch="${id}">${esc(t("dash.agents.open"))}</button>`
        : `<button type="button" class="agp-quiet accent off" aria-disabled="true"` +
          ` title="${esc(t("dash.agents.gwNoLaunch"))}">${esc(t("dash.agents.open"))}</button>`) +
      installBtn +
      (a.id === "dsh"
        ? `<button type="button" class="agp-quiet" data-gwsetup="dsh"` +
          ` title="${esc(t("dash.agents.gwSetupHooksHint"))}">${esc(t("dash.agents.gwSetupHooks"))}</button>`
        : "") +
      `<span class="agp-grow"></span>` +
      (wired
        ? `<button type="button" class="agp-quiet red" data-gwdisconnect="${id}">${esc(t("ac.action.disconnect"))}</button>`
        : `<button type="button" class="agp-quiet" data-gwconnect="${id}"${fields.length ? "" : " disabled"}>${esc(t("ac.action.connect"))}</button>`) +
      `</div></div>`;
  }

  return `<div class="agp-row${wired ? " conn" : " unplugged"}${open ? " open" : ""}"` +
    ` data-perchrow="${id}" data-gwrow="${id}" title="${esc(detail)}"` +
    ` aria-expanded="${open}">` +
    `<span class="agp-ic">${iconHTML(a.icon)}</span>` +
    `<div class="agp-who"><div class="agp-name">${esc(name)}` +
    `${live ? `<i class="agp-live" title="${esc(t("dash.agents.running"))}"></i>` : ""}</div>` +
    `<div class="agp-status"><i class="agp-dot${wired ? " on" : ""}"></i><span>${esc(status)}</span></div></div>` +
    link + chip + openBtn + sw + exp + `</div>`;
}

function perchRowHTML(a, gid) {
  const id = esc(a.id);
  const name = a.name || a.id;
  const p = gid === "missing" ? null : perchProfileOf(a.id);
  const model = perchModelOf(p);
  const caps = perchCaps(a);
  const live = typeof liveAgentTab === "function" ? liveAgentTab(a.id) : null;
  const detail = gid === "missing" ? (a.vendor || "") : (a.path || a.vendor || "");
  const calls = (a.calls | 0) > 0 ? t("dash.agents.calls", { n: dashNum(a.calls) }) : "";
  const open = AGENT_DETAIL_ID === a.id && (gid === "set" || gid === "unset");
  const inst = INSTALLS[a.id];
  const busy = inst && inst.state === "running";
  const busySpan = busy
    ? `<span class="agp-state">${esc(inst.phase === "scanning"
        ? t("dash.agents.installScanning")
        : inst.phase === "queued" ? t("dash.agents.installQueued")
          : t("dash.agents.installBusy"))}</span>`
    : "";

  // 使用自己配置的 CLI / 需要补可执行文件 / 没装：仍然是平面列表里的一行。
  if (gid === "own" || gid === "needs" || gid === "missing") {
    let action = "";
    if (gid === "own") {
      action = `<button type="button" class="agp-install" data-launch="${id}"` +
        ` title="${esc(t("dash.agents.openTitle", { name }))}">${esc(t("dash.agents.open"))}</button>`;
    } else if (a.install) {
      action = busy ? busySpan
        : `<button type="button" class="agp-install" data-install="${id}"` +
          ` title="${esc(t("dash.agents.installTitle", { name }))}">` +
          `${esc(gid === "needs" ? t("dash.agents.perchRepairInstall") : t("dash.agents.install"))}</button>`;
    } else if (a.url) {
      action = `<button type="button" class="agp-install" data-docs="${id}"` +
        ` title="${esc(t("dash.agents.docsTitle", { name }))}">${esc(t("dash.agents.docs"))}</button>`;
    }
    const status = gid === "own"
      ? t("dash.agents.perchOwnConfig")
      : gid === "needs"
        ? t("dash.agents.perchNeedsInstall")
        : (a.vendor || t("dash.agents.notDetected"));
    return `<div class="agp-row flat ${gid}" data-perchrow="${id}" title="${esc(detail + calls)}">` +
      `<span class="agp-ic">${iconHTML(a.icon)}</span>` +
      `<div class="agp-who"><div class="agp-name">${esc(name)}</div>` +
      `<div class="agp-status"><i class="agp-dot"></i><span>${esc(status)}</span></div></div>` +
      action + `</div>`;
  }

  const wired = gid === "set" && !!(p && p.model);
  const modelIcon = wired && model && model.icon ? iconHTML(model.icon, "agp-mic") : "";
  const modelLabel = wired ? perchModelLabel(p) : t("dash.agents.perchPickModel");
  const modelTitle = wired ? t("dash.agents.perchModelHint") : t("dash.agents.perchPickHint");
  const linkLabel = t("dash.agents.settings");
  const link = `<button type="button" class="agp-link" data-perchdetail="${id}" aria-expanded="${open}">` +
    `${esc(linkLabel)}<span class="chev" aria-hidden="true">${open ? "⌄" : "›"}</span></button>`;
  const sw = `<button type="button" class="agp-switch${wired ? " on" : ""}"` +
    ` data-perchtoggle="${id}" role="switch" aria-checked="${wired}"` +
    ` title="${esc(wired ? t("dash.agents.perchSwitchOffHint") : t("dash.agents.perchSwitchOnHint"))}">` +
    `<i></i></button>`;
  const openBtn = `<button type="button" class="agp-open" data-launch="${id}"` +
    ` title="${esc(t("dash.agents.openTitle", { name }))}"` +
    ` aria-label="${esc(t("dash.agents.openTitle", { name }))}">▶</button>`;

  let exp = "";
  if (open) {
    const efforts = model && Array.isArray(model.efforts)
      ? model.efforts.map((e) => String(e).toLowerCase()).filter(Boolean) : [];
    const cur = String((p && p.effort) || "").toLowerCase();
    if (cur && !efforts.includes(cur)) efforts.push(cur);
    const elabel = (v) => (typeof acOptName === "function"
      ? acOptName({ key: "effort" }, { value: v }) : v);
    const chip = (v, label) =>
      `<button type="button" class="agp-effort${cur === v ? " on" : ""}"` +
      ` data-percheffort="${id}" data-effort="${esc(v)}"` +
      ` title="${esc(t("dash.agents.perchEffortHint"))}">${esc(label)}</button>`;
    const effortsHTML = [chip("", t("dash.agents.perchEffortDefault"))]
      .concat(efforts.map((e) => chip(e, elabel(e)))).join("");
    const provs = [];
    const byProv = Object.create(null);
    const visible = perchVisibleModels(a.id);
    for (const m of visible) {
      const key = m.provider || m.providerName || "?";
      if (!byProv[key]) {
        byProv[key] = { name: m.providerName || key, icon: m.icon || "", n: 0 };
        provs.push(key);
      }
      byProv[key].n++;
    }
    const hiddenN = Math.max(0, AGENT_MODELS.length - visible.length);
    const provChips = provs.map((k) => {
      const g = byProv[k];
      return `<span class="agp-pchip">${g.icon ? iconHTML(g.icon, "agp-pic") : ""}` +
        `<span>${esc(g.name)}</span><span class="n">${g.n}</span></span>`;
    }).join("");
    let tiersHTML = "";
    if (a.id === "claude") {
      const tierDefs = [["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"], ["fable", "Fable"]];
      // 每一档也是一行 label + 控件，和模型/推理强度共用同一条 label 竖线；
      // 不再在 value 里再嵌一层 58px 的小标签列。
      tiersHTML = tierDefs.map(([key, label]) => {
        const tp = p && p.tiers ? p.tiers[key] : null;
        const tm = tp && tp.model ? AGENT_MODELS.find((x) => x && x.id === tp.model) : null;
        const tlabel = tp && tp.model ? ((tm && tm.name) || tp.model) : t("dash.agents.perchTierFollow");
        const ticon = tm && tm.icon ? iconHTML(tm.icon, "agp-mic") : "";
        const tlevels = tm && Array.isArray(tm.efforts)
          ? tm.efforts.map((e) => String(e).toLowerCase()).filter(Boolean) : [];
        const tcur = tp && tp.effort ? String(tp.effort).toLowerCase() : "";
        const teff = (tp && tp.model)
          ? [t("dash.agents.perchEffortDefault")].concat(tlevels).map((e, i) => {
            const v = i === 0 ? "" : e;
            return `<button type="button" class="agp-effort${tcur === v ? " on" : ""}"` +
              ` data-percheffort="${id}" data-perchtier="${key}" data-effort="${esc(v)}">` +
              `${esc(i === 0 ? t("dash.agents.perchEffortDefault") : elabel(e))}</button>`;
          }).join("")
          : "";
        return `<div class="agp-kv"><div class="agp-k">${esc(label)}</div>` +
          `<div class="agp-v agp-tier">` +
          `<button type="button" class="agp-field agp-tier-field${tp && tp.model ? "" : " empty"}"` +
          ` data-perchmodel="${id}" data-tier="${key}" aria-haspopup="listbox" aria-expanded="false">` +
          `${ticon}<span class="v">${esc(tlabel)}</span><span class="chev" aria-hidden="true">▾</span></button>` +
          (teff ? `<span class="agp-efforts">${teff}</span>` : "") +
          `<span class="agp-tier-hint">/model ${esc(key)}</span>` +
          `</div></div>`;
      }).join("");
    }
    const modelIcon = model && model.icon ? iconHTML(model.icon, "agp-mic") : "";
    const modelBtn = `<button type="button" class="agp-field${modelLabel ? "" : " empty"}"` +
      ` data-perchmodel="${id}" aria-haspopup="listbox" aria-expanded="false"` +
      ` title="${esc(t("dash.agents.perchModelHint"))}">${modelIcon}` +
      `<span class="v">${esc(modelLabel || t("dash.agents.perchPickModel"))}</span>` +
      `<span class="chev" aria-hidden="true">▾</span></button>`;
    exp = `<div class="agp-exp">` +
      `<div class="agp-exp-body">` +
      `<div class="agp-kv"><div class="agp-k">${esc(t("ac.field.model"))}</div>` +
      `<div class="agp-v">${modelBtn}` +
      `<span class="agp-dim"> · ${esc(model && model.context ? dashContextLabel(model.context) : "—")}</span>` +
      `</div></div>` +
      tiersHTML +
      `<div class="agp-kv"><div class="agp-k">${esc(t("ac.field.effort"))}</div>` +
      `<div class="agp-v"><span class="agp-efforts"${efforts.length ? "" : ` title="${esc(t("dash.agents.perchEffortNone"))}"`}>${effortsHTML}</span></div></div>` +
      `<div class="agp-kv"><div class="agp-k">${esc(t("dash.agents.perchModelList"))}</div>` +
      `<div class="agp-v agp-mlist"><span class="agp-pchips">${provChips}` +
      (hiddenN ? `<span class="agp-pchip agp-pdim">${esc(t("dash.agents.perchHiddenCount", { n: hiddenN }))}</span>` : "") +
      `</span>` +
      `<button type="button" class="agp-quiet" data-perchmodels="${id}">${esc(t("dash.agents.perchManageModels"))}</button>` +
      `<button type="button" class="agp-quiet" data-perchpick="${id}">${esc(t("dash.agents.perchPick"))}</button>` +
      `</div></div>` +
      `</div>` +
      `<div class="agp-exp-foot">` +
      `<button type="button" class="agp-quiet accent" data-launch="${id}">${esc(t("dash.agents.open"))}</button>` +
      `<span class="agp-grow"></span>` +
      `<button type="button" class="agp-quiet red" data-perchclear="${id}">${esc(t("dash.agents.perchClear"))}</button>` +
      `</div></div>`;
  }

  return `<div class="agp-row${wired ? " conn" : " unplugged"}${open ? " open" : ""}"` +
    ` data-perchrow="${id}" title="${esc(detail + calls)}"` +
    ` aria-expanded="${open}">` +
    `<span class="agp-ic">${iconHTML(a.icon)}</span>` +
    `<div class="agp-who"><div class="agp-name">${esc(name)}` +
    `${live ? `<i class="agp-live" title="${esc(t("dash.agents.running"))}"></i>` : ""}</div>` +
    `<div class="agp-status"><i class="agp-dot${wired ? " on" : ""}"></i><span>${esc(wired
      ? t("dash.agents.perchConnected", { model: modelLabel })
      : t("dash.agents.perchUnset"))}</span></div></div>` +
    link +
    `<button type="button" class="agp-field${wired ? "" : " empty"}"` +
    ` data-perchmodel="${id}" aria-haspopup="listbox" aria-expanded="false"` +
    ` title="${esc(modelTitle)}">${modelIcon}<span class="v">${esc(modelLabel)}</span>` +
    `<span class="chev" aria-hidden="true">▾</span></button>` +
    openBtn + sw + exp + `</div>`;
}

function dashModelPickTitle(m) {
  const bits = [m.name || m.id, m.providerName || m.provider || ""];
  if (m.context) bits.push(Math.round(m.context / 1000) + "k");
  return bits.filter(Boolean).join(" · ");
}

function dashModelPickOpen(anchor, id, tier) {
  if (!anchor || !anchor.isConnected) return;
  const key = id + (tier ? ":" + tier : "");
  if (AGENT_MODEL_POP && AGENT_MODEL_POP.key === key) { dashModelClose(true); return; }
  dashModelClose(false);
  const p = perchProfileOf(id);
  const tp = tier && p && p.tiers ? p.tiers[tier] : null;
  const curModel = tier ? ((tp && tp.model) || "") : ((p && p.model) || "");
  const pop = document.createElement("div");
  pop.className = "ac-pop dash-model-pop";
  if (!AGENT_MODELS.length) {
    pop.innerHTML = `<div class="dash-model-empty">` +
      `<p>${esc(AGENT_PROFILE_ERR || t("dash.agents.perchNoModels"))}</p>` +
      `<button type="button" class="dl" data-gwlink>${esc(t("dash.agents.perchGuideAction"))}</button>` +
      `</div>`;
  } else {
    let listHTML = `<button type="button" class="ac-pop-opt dm-opt dm-default${curModel ? "" : " on"}"` +
      ` data-val=""><span class="dm-ic"></span>` +
      `<span class="dm-txt"><span class="nm">${esc(tier ? t("dash.agents.perchTierFollow") : t("dash.agents.perchModelDefault"))}</span>` +
      `<span class="dm-prov">${esc(tier ? t("dash.agents.perchTierFollowSub") : t("dash.agents.perchModelDefaultSub"))}</span></span>` +
      `${curModel ? "" : `<span class="dm-check" aria-hidden="true">✓</span>`}</button>`;
    const pickModels = perchVisibleModels(id, tier && tp && tp.model ? [tp.model] : []);
    let grp = null;
    for (const m of pickModels) {
      const g = m.providerName || m.provider || "";
      if (g !== grp) {
        listHTML += `<div class="ac-pop-grp">${esc(g)}</div>`;
        grp = g;
      }
      const on = curModel === m.id;
      const prov = m.providerName || m.provider || "";
      const ctx = m.context ? dashContextLabel(m.context) : "";
      const mi = m.icon ? iconHTML(m.icon) : "";
      listHTML += `<button type="button" class="ac-pop-opt dm-opt${on ? " on" : ""}"` +
        ` data-val="${esc(m.id)}" title="${esc(dashModelPickTitle(m))}">` +
        `<span class="dm-ic">${mi}</span>` +
        `<span class="dm-txt"><span class="nm">${esc(m.name || m.id)}</span>` +
        `<span class="dm-prov">${esc(prov)}</span></span>` +
        `<span class="dm-ctx">${esc(ctx)}</span>` +
        (on ? `<span class="dm-check" aria-hidden="true">✓</span>` : ``) +
        `</button>`;
    }
    if (!pickModels.length) {
      listHTML += `<div class="dash-model-empty"><p>${esc(t("dash.agents.perchAllModelsHidden"))}</p></div>`;
    }
    pop.innerHTML = `<input class="ac-pop-find" type="search" autocomplete="off"` +
      ` placeholder="${esc(t("dash.agents.perchSearch"))}"` +
      ` aria-label="${esc(t("dash.agents.perchSearch"))}">` +
      `<div class="ac-pop-list" role="listbox">${listHTML}</div>`;
  }
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  const h = pop.offsetHeight || 260;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "";
  anchor.setAttribute("aria-expanded", "true");
  AGENT_MODEL_POP = { anchor, pop, id, tier, key };

  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("input", (e) => {
    if (e.target.classList.contains("ac-pop-find") && typeof acPickFilter === "function") {
      acPickFilter(pop, e.target.value);
    }
  });
  pop.addEventListener("click", (e) => {
    const gw = e.target.closest("[data-gwlink]");
    if (gw) { dashModelClose(false); perchGoGateway(); return; }
    const b = e.target.closest(".ac-pop-opt");
    if (!b) return;
    const val = b.dataset.val;
    dashModelClose(false);
    if (tier) {
      if (val === "") {
        const np = { ...p, tiers: { ...((p && p.tiers) || {}) } };
        delete np.tiers[tier];
        if (!Object.keys(np.tiers).length) delete np.tiers;
        AGENT_PROFILES[id] = np;
        if (NAV_HERE === "dash") renderDashAgents();
        sendCtrl({ type: "agent.profile.tier", id, tier, value: "", effort: "" });
        return;
      }
      if (!val) return;
      const m = AGENT_MODELS.find((x) => x && x.id === val);
      const levels = (m && Array.isArray(m.efforts) ? m.efforts : [])
        .map((e) => String(e).toLowerCase());
      const oldEffort = tp && tp.effort ? String(tp.effort).toLowerCase() : "";
      const keep = oldEffort && levels.includes(oldEffort) ? oldEffort : "";
      AGENT_PROFILES[id] = {
        ...p,
        tiers: { ...((p && p.tiers) || {}), [tier]: { model: val, effort: keep } },
      };
      if (NAV_HERE === "dash") renderDashAgents();
      sendCtrl({ type: "agent.profile.tier", id, tier, value: val, effort: keep });
      return;
    }
    if (val === "") {
      // magpie picker 的 Default：回到 agent 自己的配置，等同于关掉开关。
      delete AGENT_PROFILES[id];
      renderDashAgents();
      sendCtrl({ type: "agent.profile.set", id, value: "", effort: "" });
      return;
    }
    if (!val) return;
    const m = AGENT_MODELS.find((x) => x && x.id === val);
    // 换模型时只保留新模型也支持的档位；不支持就回到默认，别把上一款
    // 模型的档位硬塞进新组的成员写法里。
    const levels = (m && Array.isArray(m.efforts) ? m.efforts : [])
      .map((e) => String(e).toLowerCase());
    const keep = p && p.effort && levels.includes(String(p.effort).toLowerCase())
      ? String(p.effort).toLowerCase() : "";
    if (m) {
      AGENT_PROFILES[id] = { agent: id, alias: perchAlias(id), model: val, effort: keep };
      if (NAV_HERE === "dash") renderDashAgents();
    }
    sendCtrl({ type: "agent.profile.set", id, value: val, effort: keep });
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); dashModelClose(true); return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...pop.querySelectorAll(".ac-pop-opt")].filter((o) => !o.hidden);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    const i = e.key === "ArrowDown"
      ? (cur < 0 ? 0 : Math.min(items.length - 1, cur + 1))
      : (cur < 0 ? items.length - 1 : Math.max(0, cur - 1));
    items[i].focus();
  });
  const inp = pop.querySelector(".ac-pop-find");
  if (inp) inp.focus();
}

/* 引擎字段的模型选择器：选项来自 /api/state 的 Field.Options（magpie 已经把
   分组、图标、上下文长度和 note 都给了），选中后走 /api/set 写进沙盒。 */
function gwFieldPopClose(refocus) {
  if (!GW_FIELD_POP) return;
  const { anchor, pop } = GW_FIELD_POP;
  GW_FIELD_POP = null;
  if (pop) pop.remove();
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    if (refocus && anchor.isConnected) anchor.focus();
  }
}

function gwFieldPopOpen(anchor, id, key) {
  if (!anchor || !anchor.isConnected) return;
  if (GW_FIELD_POP && GW_FIELD_POP.id === id && GW_FIELD_POP.key === key) {
    gwFieldPopClose(true);
    return;
  }
  gwFieldPopClose(false);
  const g = gwAgentOf(id);
  const f = gwFieldOfAgent(g, key);
  if (!f) return;
  const opts = gwVisibleFieldOptions(f);
  let listHTML = "";
  if (f.value && !opts.some((o) => o.value === f.value)) {
    listHTML += `<div class="dash-model-empty"><p>` +
      `${esc(t("dash.agents.gwInternalRoute"))}</p></div>`;
  }
  if (!opts.some((o) => o.value === "")) {
    listHTML += `<button type="button" class="ac-pop-opt dm-opt${f.value ? "" : " on"}"` +
      ` role="option" aria-selected="${!f.value}" data-val="">` +
      `<span class="dm-ic"></span><span class="dm-txt">` +
      `<span class="nm">${esc(gwDefaultLabel(g, f))}</span>` +
      `<span class="dm-prov">${esc(t("dash.agents.gwFieldDefaultSub"))}</span></span>` +
      `${f.value ? "" : `<span class="dm-check" aria-hidden="true">✓</span>`}</button>`;
  }
  let grp = null;
  for (const o of opts) {
    const gname = o.group || "";
    if (gname !== grp && gname) {
      listHTML += `<div class="ac-pop-grp">${esc(gname)}</div>`;
    }
    grp = gname;
    const on = o.value === f.value;
    const note = o.note || gname || "";
    listHTML += `<button type="button" class="ac-pop-opt dm-opt${on ? " on" : ""}"` +
      ` role="option" aria-selected="${on}" data-val="${esc(o.value)}"` +
      `${o.note ? ` title="${esc(o.note)}"` : ""}>` +
      `<span class="dm-ic">${o.icon ? iconHTML(o.icon) : ""}</span>` +
      `<span class="dm-txt"><span class="nm">${esc(gwOptionLabel(f, o))}</span>` +
      `<span class="dm-prov">${esc(note)}</span></span>` +
      `${o.context ? `<span class="dm-ctx">${esc(dashContextLabel(o.context))}</span>` : ""}` +
      `${on ? `<span class="dm-check" aria-hidden="true">✓</span>` : ""}</button>`;
  }
  const pop = document.createElement("div");
  pop.className = "ac-pop dash-model-pop";
  pop.innerHTML = `<input class="ac-pop-find" type="search" autocomplete="off"` +
    ` placeholder="${esc(t("dash.agents.perchSearch"))}"` +
    ` aria-label="${esc(t("dash.agents.perchSearch"))}">` +
    `<div class="ac-pop-list" role="listbox">${listHTML}</div>`;
  pop.style.visibility = "hidden";
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  const h = pop.offsetHeight || 260;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  pop.style.visibility = "";
  anchor.setAttribute("aria-expanded", "true");
  GW_FIELD_POP = { anchor, pop, id, key };

  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("input", (e) => {
    if (!e.target.classList.contains("ac-pop-find")) return;
    if (typeof acPickFilter === "function") { acPickFilter(pop, e.target.value); return; }
    const q = String(e.target.value || "").trim().toLowerCase();
    for (const el of pop.querySelectorAll(".ac-pop-opt")) {
      el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
    }
  });
  pop.addEventListener("click", (e) => {
    const b = e.target.closest(".ac-pop-opt");
    if (!b) return;
    const value = b.dataset.val || "";
    gwFieldPopClose(false);
    if (GW_AGENT_BUSY) return;
    GW_AGENT_BUSY = id;
    sendCtrl({ type: "gw.agent.set", id, field: key, value });
    if (NAV_HERE === "dash") renderDashAgents();
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation(); gwFieldPopClose(true); return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...pop.querySelectorAll(".ac-pop-opt")].filter((o) => !o.hidden);
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement);
    const i = e.key === "ArrowDown"
      ? (cur < 0 ? 0 : Math.min(items.length - 1, cur + 1))
      : (cur < 0 ? items.length - 1 : Math.max(0, cur - 1));
    items[i].focus();
  });
  const inp = pop.querySelector(".ac-pop-find");
  if (inp) inp.focus();
}

function dashModelClose(refocus) {
  if (!AGENT_MODEL_POP) return;
  const { anchor, pop } = AGENT_MODEL_POP;
  AGENT_MODEL_POP = null;
  if (pop) pop.remove();
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    if (refocus && anchor.isConnected) anchor.focus();
  }
}

function dashModelListClose() {
  if (!AGENT_MODELS_POP) return;
  const { pop } = AGENT_MODELS_POP;
  AGENT_MODELS_POP = null;
  if (pop) pop.remove();
}

function dashModelListOpen(anchor, id) {
  if (!anchor || !anchor.isConnected) return;
  if (AGENT_MODELS_POP && AGENT_MODELS_POP.id === id) { dashModelListClose(); return; }
  dashModelListClose();
  dashModelClose(false);
  const p = perchProfileOf(id);
  if (!p) return;
  const keep = new Set([p.model].filter(Boolean));
  if (p.tiers) for (const t of Object.keys(p.tiers)) {
    if (p.tiers[t] && p.tiers[t].model) keep.add(p.tiers[t].model);
  }
  const pop = document.createElement("div");
  pop.className = "ac-pop dash-model-pop agp-models-pop";
  let listHTML = "";
  let grp = null;
  for (const m of AGENT_MODELS) {
    const g = m.providerName || m.provider || "";
    if (g !== grp) {
      listHTML += `<div class="ac-pop-grp">${esc(g)}</div>`;
      grp = g;
    }
    const on = keep.has(m.id) || !perchHiddenSet(id).has(m.id);
    const locked = keep.has(m.id);
    const mi = m.icon ? iconHTML(m.icon) : "";
    const ctx = m.context ? dashContextLabel(m.context) : "";
    listHTML += `<button type="button" class="ac-pop-opt dm-opt dm-manage${on ? " on" : ""}"` +
      ` data-mhide="${esc(m.id)}"${locked ? " disabled" : ""}>` +
      `<span class="dm-box" aria-hidden="true">${on ? "✓" : ""}</span>` +
      `<span class="dm-ic">${mi}</span>` +
      `<span class="dm-txt"><span class="nm">${esc(m.name || m.id)}</span>` +
      `<span class="dm-prov">${esc(g)}</span></span>` +
      `<span class="dm-ctx">${locked ? esc(t("dash.agents.perchCurrentModel")) : esc(ctx)}</span>` +
      `</button>`;
  }
  pop.innerHTML = `<div class="agp-mpop-head"><span>${esc(t("dash.agents.perchModelList"))}</span>` +
    `<button type="button" class="agp-mpop-x" data-mpopclose aria-label="${esc(t("common.close"))}">×</button></div>` +
    `<input class="ac-pop-find" type="search" autocomplete="off"` +
    ` placeholder="${esc(t("dash.agents.perchSearch"))}"` +
    ` aria-label="${esc(t("dash.agents.perchSearch"))}">` +
    `<div class="ac-pop-list" role="listbox">${listHTML}</div>` +
    `<div class="agp-mpop-foot"><span class="agp-mpop-count"></span>` +
    `<button type="button" class="agp-quiet" data-mpopall>${esc(t("dash.agents.perchShowAllModels"))}</button>` +
    `<button type="button" class="agp-quiet accent" data-mpopdone>${esc(t("dash.agents.perchManageDone"))}</button></div>`;
  document.body.appendChild(pop);

  const count = () => {
    const hidden = perchHiddenSet(id);
    const shown = AGENT_MODELS.filter((m) => keep.has(m.id) || !hidden.has(m.id)).length;
    pop.querySelector(".agp-mpop-count").textContent =
      t("dash.agents.perchModelsSelected", { n: shown, total: AGENT_MODELS.length });
  };
  count();

  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 460;
  const h = pop.offsetHeight || 440;
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, r.right - w);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - 6 - h);
  pop.style.left = left + "px";
  pop.style.top = top + "px";

  AGENT_MODELS_POP = { anchor, pop, id };
  pop.addEventListener("pointerdown", (e) => e.stopPropagation());
  pop.addEventListener("click", (e) => {
    if (e.target.closest("[data-mpopclose]") || e.target.closest("[data-mpopdone]")) {
      dashModelListClose();
      return;
    }
    if (e.target.closest("[data-mpopall]")) {
      const p2 = perchProfileOf(id) || {};
      AGENT_PROFILES[id] = { ...p2, hidden: [] };
      sendCtrl({ type: "agent.profile.models", id, hidden: [] });
      for (const b of pop.querySelectorAll("[data-mhide]")) {
        const m = b.dataset.mhide;
        if (!keep.has(m)) {
          b.classList.remove("on");
          const box = b.querySelector(".dm-box");
          if (box) box.textContent = "";
        }
      }
      // "Show all" means every model visible: re-mark all rows on.
      for (const b of pop.querySelectorAll("[data-mhide]")) {
        b.classList.add("on");
        const box = b.querySelector(".dm-box");
        if (box) box.textContent = "✓";
      }
      count();
      return;
    }
    const b = e.target.closest("[data-mhide]");
    if (!b || b.disabled) return;
    const mid = b.dataset.mhide;
    const hidden = new Set(perchHiddenSet(id));
    if (hidden.has(mid)) hidden.delete(mid); else hidden.add(mid);
    const arr = [...hidden];
    const p2 = perchProfileOf(id) || {};
    AGENT_PROFILES[id] = { ...p2, hidden: arr };
    sendCtrl({ type: "agent.profile.models", id, hidden: arr });
    const on = !hidden.has(mid);
    b.classList.toggle("on", on);
    const box = b.querySelector(".dm-box");
    if (box) box.textContent = on ? "✓" : "";
    count();
  });
  pop.addEventListener("input", (e) => {
    if (!e.target.classList.contains("ac-pop-find")) return;
    const q = e.target.value.trim().toLowerCase();
    for (const b of pop.querySelectorAll("[data-mhide]")) {
      b.hidden = !!q && !b.textContent.toLowerCase().includes(q);
    }
  });
  const inp = pop.querySelector(".ac-pop-find");
  if (inp) inp.focus();
}

document.addEventListener("pointerdown", (e) => {
  if (AGENT_MODELS_POP && !e.target.closest(".agp-models-pop") && !e.target.closest("[data-perchmodels]")) {
    dashModelListClose();
  }
  if (GW_FIELD_POP && !e.target.closest(".dash-model-pop") && !e.target.closest("[data-gwmodelpick]")) {
    gwFieldPopClose(false);
  }
  if (!AGENT_MODEL_POP) return;
  if (e.target.closest(".dash-model-pop") || e.target.closest("[data-perchmodel]")) return;
  dashModelClose(false);
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (AGENT_MODELS_POP) {
    e.preventDefault();
    e.stopPropagation();
    dashModelListClose();
    return;
  }
  if (GW_FIELD_POP) {
    e.preventDefault();
    e.stopPropagation();
    gwFieldPopClose(true);
    return;
  }
  if (!AGENT_MODEL_POP) return;
  e.preventDefault();
  e.stopPropagation();
  dashModelClose(true);
}, true);

function perchSetEditorName() {
  const inp = $("perch-set-name");
  return (inp ? inp.value : AGENT_SET_DRAFT).trim();
}

function perchCommitProfileSave(name) {
  if (!name) return;
  const same = AGENT_SETS.some((s) => s && s.name === name);
  const go = () => {
    AGENT_SET_PENDING = name;
    AGENT_SET_NAMING = false;
    AGENT_SET_DRAFT = "";
    sendCtrl({ type: "agent.profile.save", setName: name });
    renderDashAgents();
  };
  if (!same) { go(); return; }
  perchConfirm({
    title: t("dash.agents.perchProfileOverwriteTitle"),
    body: t("dash.agents.perchProfileOverwriteBody", { name }),
    ok: t("dash.agents.perchProfileOverwriteOk"),
  }).then((yes) => { if (yes) go(); });
}

function perchApplyProfileSet(name) {
  if (!name || AGENT_SET_PENDING) return;
  AGENT_SET_PENDING = name;
  sendCtrl({ type: "agent.profile.use", setName: name });
  renderDashAgents();
}

function perchDeleteProfileSet(name) {
  if (!name) return;
  perchConfirm({
    title: t("dash.agents.perchProfileDeleteTitle"),
    body: t("dash.agents.perchProfileDeleteBody", { name }),
    ok: t("dash.agents.perchProfileDeleteOk"),
    danger: true,
  }).then((yes) => {
    if (!yes) return;
    AGENT_SET_PENDING = name;
    sendCtrl({ type: "agent.profile.delete", setName: name });
    renderDashAgents();
  });
}

$("dash-agent-list").addEventListener("click", (e) => {
  if (!AGENT_UI_ISOLATED) return;
  const gw = e.target.closest("[data-gwlink]");
  if (gw) { e.preventDefault(); e.stopPropagation(); perchGoGateway(); return; }
  const fb = e.target.closest("[data-perchfold]");
  if (fb) {
    e.preventDefault();
    e.stopPropagation();
    PERCH_FOLD_OPEN = !PERCH_FOLD_OPEN;
    fb.classList.toggle("open", PERCH_FOLD_OPEN);
    fb.setAttribute("aria-expanded", String(PERCH_FOLD_OPEN));
    const fold = $("dash-agent-fold");
    if (fold) fold.classList.toggle("open", PERCH_FOLD_OPEN);
    const label = $("dash-agent-more-label");
    if (label) {
      const n = Number(fb.dataset.foldCount || 0);
      label.textContent = PERCH_FOLD_OPEN
        ? t("dash.agents.perchFoldHide")
        : t("dash.agents.perchFoldShow", { n });
    }
    return;
  }
  const gfold = e.target.closest("[data-gwfold]");
  if (gfold) {
    e.preventDefault();
    e.stopPropagation();
    PERCH_EXTRA_FOLD_OPEN = !PERCH_EXTRA_FOLD_OPEN;
    gfold.classList.toggle("open", PERCH_EXTRA_FOLD_OPEN);
    gfold.setAttribute("aria-expanded", String(PERCH_EXTRA_FOLD_OPEN));
    const fold = $("dash-agent-gwfold");
    if (fold) fold.classList.toggle("open", PERCH_EXTRA_FOLD_OPEN);
    const label = $("dash-agent-gwmore-label");
    if (label) {
      const n = Number(gfold.dataset.foldCount || 0);
      label.textContent = PERCH_EXTRA_FOLD_OPEN
        ? t("dash.agents.perchGwFoldHide")
        : t("dash.agents.perchGwFoldShow", { n });
    }
    return;
  }
  const gfp = e.target.closest("[data-gwfieldpick]");
  if (gfp) {
    e.preventDefault();
    e.stopPropagation();
    gwFieldPopOpen(gfp, gfp.dataset.gwid, gfp.dataset.gwfieldpick);
    return;
  }
  const gfs = e.target.closest("[data-gwfieldset]");
  if (gfs) {
    e.preventDefault();
    e.stopPropagation();
    if (GW_AGENT_BUSY) return;
    const id = gfs.dataset.gwfieldset;
    GW_AGENT_BUSY = id;
    sendCtrl({
      type: "gw.agent.set", id,
      field: gfs.dataset.field, value: gfs.dataset.value,
    });
    renderDashAgents();
    return;
  }
  const gmp = e.target.closest("[data-gwmodelpick]");
  if (gmp) {
    e.preventDefault();
    e.stopPropagation();
    gwFieldPopOpen(gmp, gmp.dataset.gwmodelpick, "model");
    return;
  }
  const gsw = e.target.closest("[data-gwswitch]");
  if (gsw) {
    e.preventDefault();
    e.stopPropagation();
    gwToggleAgent(gsw.dataset.gwswitch);
    return;
  }
  const gdb = e.target.closest("[data-gwdetail]");
  if (gdb) {
    e.preventDefault();
    e.stopPropagation();
    const id = gdb.dataset.gwdetail;
    AGENT_DETAIL_ID = AGENT_DETAIL_ID === id ? "" : id;
    renderDashAgents();
    return;
  }
  const gcn = e.target.closest("[data-gwconnect]");
  if (gcn) {
    e.preventDefault();
    e.stopPropagation();
    gwToggleAgent(gcn.dataset.gwconnect);
    return;
  }
  const gdc = e.target.closest("[data-gwdisconnect]");
  if (gdc) {
    e.preventDefault();
    e.stopPropagation();
    gwToggleAgent(gdc.dataset.gwdisconnect);
    return;
  }
  const gsu = e.target.closest("[data-gwsetup]");
  if (gsu) {
    e.preventDefault();
    e.stopPropagation();
    sendCtrl({ type: "agent.setup", id: gsu.dataset.gwsetup });
    bootFact(`Agent 状态接入 → ${gsu.dataset.gwsetup}`);
    return;
  }
  const grp = e.target.closest("[data-gwreapply]");
  if (grp) {
    e.preventDefault();
    e.stopPropagation();
    if (GW_AGENT_BUSY) return;
    GW_AGENT_BUSY = grp.dataset.gwreapply;
    sendCtrl({ type: "gw.agent.reapply", id: grp.dataset.gwreapply });
    renderDashAgents();
    return;
  }
  const gkp = e.target.closest("[data-gwkeep]");
  if (gkp) {
    e.preventDefault();
    e.stopPropagation();
    if (GW_AGENT_BUSY) return;
    GW_AGENT_BUSY = gkp.dataset.gwkeep;
    sendCtrl({ type: "gw.agent.keep", id: gkp.dataset.gwkeep });
    renderDashAgents();
    return;
  }
  const mdl = e.target.closest("[data-perchmodels]");
  if (mdl) {
    e.preventDefault();
    e.stopPropagation();
    dashModelListOpen(mdl, mdl.dataset.perchmodels);
    return;
  }
  const pk = e.target.closest("[data-perchpick]");
  if (pk) {
    e.preventDefault();
    e.stopPropagation();
    const row = pk.closest("[data-perchrow]");
    const anchor = row && row.querySelector("[data-perchmodel]");
    if (anchor) dashModelPickOpen(anchor, pk.dataset.perchpick);
    return;
  }
  const tgl = e.target.closest("[data-perchtoggle]");
  if (tgl) {
    e.preventDefault();
    e.stopPropagation();
    const id = tgl.dataset.perchtoggle;
    const p = perchProfileOf(id);
    if (p && p.model) {
      perchConfirm({
        title: t("dash.agents.perchDisconnectTitle"),
        body: t("dash.agents.perchDisconnectBody"),
        ok: t("dash.agents.perchDisconnectOk"),
        danger: true,
      }).then((yes) => {
        if (!yes) return;
        delete AGENT_PROFILES[id];
        renderDashAgents();
        sendCtrl({ type: "agent.profile.set", id, value: "", effort: "" });
      });
    } else {
      const row = tgl.closest("[data-perchrow]");
      const anchor = row && row.querySelector("[data-perchmodel]");
      if (anchor) dashModelPickOpen(anchor, id);
    }
    return;
  }
  const del = e.target.closest("[data-perchsetdel]");
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    perchDeleteProfileSet(del.dataset.perchsetdel);
    return;
  }
  const set = e.target.closest("[data-perchset]");
  if (set) {
    e.preventDefault();
    e.stopPropagation();
    perchApplyProfileSet(set.dataset.perchset);
    return;
  }
  const save = e.target.closest("[data-perchsetsave]");
  if (save) {
    e.preventDefault();
    e.stopPropagation();
    AGENT_SET_NAMING = true;
    AGENT_SET_DRAFT = "";
    renderDashAgents();
    return;
  }
  const apply = e.target.closest("[data-perchsetapply]");
  if (apply) {
    e.preventDefault();
    e.stopPropagation();
    perchCommitProfileSave(perchSetEditorName());
    return;
  }
  const cancel = e.target.closest("[data-perchsetcancel]");
  if (cancel) {
    e.preventDefault();
    e.stopPropagation();
    AGENT_SET_NAMING = false;
    AGENT_SET_DRAFT = "";
    renderDashAgents();
    return;
  }
  const mb = e.target.closest("[data-perchmodel]");
  if (mb) {
    e.preventDefault();
    e.stopPropagation();
    dashModelPickOpen(mb, mb.dataset.perchmodel, mb.dataset.tier || "");
    return;
  }
  const eb = e.target.closest("[data-percheffort]");
  if (eb) {
    e.preventDefault();
    e.stopPropagation();
    const id = eb.dataset.percheffort;
    const p = perchProfileOf(id);
    if (!p || !p.model) return;
    const effort = String(eb.dataset.effort || "").toLowerCase();
    const tier = String(eb.dataset.perchtier || "").toLowerCase();
    if (tier) {
      const tp = p.tiers && p.tiers[tier];
      if (!tp || !tp.model) return;
      AGENT_PROFILES[id] = {
        ...p,
        tiers: { ...p.tiers, [tier]: { ...tp, effort } },
      };
      renderDashAgents();
      sendCtrl({ type: "agent.profile.tier", id, tier, value: tp.model, effort });
      return;
    }
    AGENT_PROFILES[id] = { ...p, effort };
    renderDashAgents();
    sendCtrl({ type: "agent.profile.set", id, value: p.model, effort });
    return;
  }
  const cb = e.target.closest("[data-perchclear]");
  if (cb) {
    e.preventDefault();
    e.stopPropagation();
    sendCtrl({ type: "agent.profile.set", id: cb.dataset.perchclear, value: "" });
    return;
  }
  const db = e.target.closest("[data-perchdetail]");
  if (db) {
    e.preventDefault();
    e.stopPropagation();
    AGENT_DETAIL_ID = AGENT_DETAIL_ID === db.dataset.perchdetail ? "" : db.dataset.perchdetail;
    renderDashAgents();
    return;
  }
});

$("dash-agent-list").addEventListener("input", (e) => {
  if (e.target && e.target.id === "perch-set-name") AGENT_SET_DRAFT = e.target.value;
});

$("dash-agent-list").addEventListener("keydown", (e) => {
  if (!AGENT_UI_ISOLATED) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  const set = e.target.closest("[data-perchset]");
  if (set && !e.target.closest("[data-perchsetdel]")) {
    e.preventDefault();
    perchApplyProfileSet(set.dataset.perchset);
    return;
  }
});

function renderDashAgents() {
  const host = $("dash-agent-list");
  if (!host) return;
  const m = mg();
  const list = m && (m.catalog || []).length ? m.catalog : [];
  const sub = $("dash-agent-sub");
  ensureAgentProfiles();
  if (AGENT_UI_ISOLATED) {
    renderPerchAgentList(host, list, sub);
    return;
  }
  // caps 是权威；老 magpie 还没有这个字段时退回 adapter（只认结构化状态）。
  const capsOf = (a) => a.caps || {
    launch: !!a.adapter, status: !!a.adapter, waiting: !!a.adapter,
  };
  const installed = list.filter((a) => a.installed);
  const full = installed.filter((a) => capsOf(a).waiting);
  const basic = installed.filter((a) => capsOf(a).status && !capsOf(a).waiting);
  const launchOnly = installed.filter((a) => capsOf(a).launch && !capsOf(a).status);
  const noLaunch = installed.filter((a) => !capsOf(a).launch);
  const missing = list.filter((a) => !a.installed);
  const routed = list.filter((a) => (a.calls | 0) > 0);
  if (sub) {
    const bits = [];
    if (full.length) bits.push(t("dash.agents.sumFull", { n: full.length }));
    if (basic.length) bits.push(t("dash.agents.sumBasic", { n: basic.length }));
    if (launchOnly.length) bits.push(t("dash.agents.sumLaunch", { n: launchOnly.length }));
    if (noLaunch.length) bits.push(t("dash.agents.sumNone", { n: noLaunch.length }));
    bits.push(t("dash.agents.sumMissing", { n: missing.length }));
    sub.textContent = list.length
      ? bits.join(" · ") + (routed.length ? t("dash.agents.sumRouted", { n: routed.length }) : "")
      : t("dash.agents.scanning");
  }
  if (!list.length) {
    host.innerHTML = `<div class="gw-empty">${esc(t("dash.agents.listPending"))}</div>`;
    return;
  }

  const row = (a, gid) => {
    const c = capsOf(a);
    const level = c.waiting ? t("dash.agents.levelFull")
      : c.status ? t("dash.agents.levelBasic")
      : c.launch ? t("dash.agents.levelLaunch")
      : t("dash.agents.levelNone");
    // 没探测到 ≠ 没装：GUI 进程的 PATH 常常比终端里短，有的 agent 也把配置
    // 放在别处。所以写「未检测到」，不写「未安装」——前者说的是我们的证据。
    const st = gid === "missing"
      ? (a.windows === false ? t("dash.agents.macOnly") : t("dash.agents.notDetected"))
      : level;
    const stClass = c.status ? " ok" : (gid === "missing" || !c.launch) ? " off" : "";
    // 这份名单只列 CLI agent：每行副标题都带 CLI，和网关层的桌面客户端分开。
    const detail = gid === "missing"
      ? t("dash.agents.detailCli", { vendor: a.vendor || "" })
      : t("dash.agents.detailPath", { path: a.path || a.vendor || "" });
    const calls = (a.calls | 0) > 0 ? t("dash.agents.calls", { n: dashNum(a.calls) }) : "";
    const inst = INSTALLS[a.id];
    const busy = inst && inst.state === "running";
    // 没有安装配方 ≠ 桌面应用：这份名单是**使用层**，只认 CLI 能不能装。
    // 没配方就给官方安装说明的出口；桌面客户端属于网关层，由 magpie 管，
    // 不在这份名单里（见 magpie.go 的 agentCatalogDefs 注释）。
    const busySpan = busy
      ? `<span class="st">${esc(inst.phase === "scanning"
          ? t("dash.agents.installScanning")
          : inst.phase === "queued" ? t("dash.agents.installQueued")
          : t("dash.agents.installBusy"))}</span>`
      : "";
    const installBtn = a.install
      ? (busy
          ? busySpan
          : `<button type="button" class="dl" data-install="${esc(a.id)}"` +
            ` title="${esc(t("dash.agents.installTitle", { name: a.name || "" }))}">${esc(t("dash.agents.install"))}</button>`)
      : a.url
        ? `<button type="button" class="dl" data-docs="${esc(a.id)}"` +
          ` title="${esc(t("dash.agents.docsTitle", { name: a.name || "" }))}">${esc(t("dash.agents.docs"))}</button>`
        : "";
    /* “只启动”那一类如果 Perch 知道怎么补状态（目前是 dsh），就在这里给一个
       明确的入口。它和「打开」并排：点打开仍然只是开格，点接入状态才动用户
       的 DSH 配置 —— 两个动作不混。 */
    const setupBtn = (gid !== "missing" && a.setup && !busy)
      ? `<button type="button" class="dl" data-setup="${esc(a.id)}"` +
        ` title="${esc(t("dash.agents.setupTitle", { name: a.name || "" }))}">${esc(t("dash.agents.setup"))}</button>`
      : "";
    const openBtn = c.launch
      ? `<button type="button" class="dl" data-launch="${esc(a.id)}"` +
        ` title="${esc(t("dash.agents.openTitle", { name: a.name || "" }))}">${esc(t("dash.agents.open"))}</button>`
      : "";
    const action = gid === "missing"
      ? installBtn
      : c.launch
        ? (busy && a.setup ? busySpan : setupBtn + openBtn)
        // 已安装但还起不来：给安装配方一个出口（dsh 就是缺 dsh-tui profile）。
        : installBtn;
    const stTitle = gid === "missing"
      ? t("dash.agents.stTitleMissing")
      : c.waiting
        ? t("dash.agents.stTitleFull")
        : c.status
          ? t("dash.agents.stTitleBasic")
          : c.launch
            ? t("dash.agents.stTitleLaunch")
            : t("dash.agents.stTitleNone");
    // 已检测到的行可以点开右侧配置抽屉（89-agent-cfg.js）。网关那个点只有
    // 读到 magpie 的 agent 列表之后才画 —— 没读到时不假装"未接入"。
    const cfg = gid !== "missing";
    const ga = cfg && typeof gwAgentOf === "function" ? gwAgentOf(a.id) : null;
    const gdot = ga
      ? `<span class="gwdot${ga.wired ? " on" : ""}" title="${esc(ga.wired
          ? t("dash.agents.wired") : t("dash.agents.notWired"))}"></span>`
      : "";
    return `<div class="ag${cfg ? " cfg" : ""}"` +
      (cfg ? ` data-agentcfg="${esc(a.id)}" role="button" tabindex="0"` +
        ` aria-label="${esc(t("dash.agents.configAria", { name: a.name || "" }))}"` : "") + `>` +
      iconHTML(a.icon) +
      `<span class="who"><span class="nm">${esc(a.name)}${gdot}</span>` +
      `<span class="sub" title="${esc(detail + calls)}">${esc(detail + calls)}</span></span>` +
      `<span class="st${stClass}"` +
      (stTitle ? ` title="${esc(stTitle)}"` : "") +
      `>${st}</span>` +
      action +
      (cfg ? `<span class="ag-cfg-chev" aria-hidden="true">›</span>` : "") +
      `</div>`;
  };
  const group = (label, items, gid) =>
    `<div class="ag-group">${esc(label)}<span>${items.length}</span></div>` +
    `<div class="roster">${items.map((a) => row(a, gid)).join("")}</div>`;

  let html = "";
  if (full.length) html += group(t("dash.agents.levelFull"), full, "full");
  if (basic.length) html += group(t("dash.agents.levelBasic"), basic, "basic");
  if (launchOnly.length) html += group(t("dash.agents.levelLaunch"), launchOnly, "launch");
  if (noLaunch.length) html += group(t("dash.agents.levelNone"), noLaunch, "nolaunch");
  if (!installed.length) {
    html += `<div class="gw-empty">${esc(t("dash.agents.emptyAll"))}</div>`;
  }
  if (missing.length) {
    html +=
      `<button type="button" class="agent-more${agentsFoldOpen ? " open" : ""}"` +
      ` id="dash-agent-more" data-agents-fold>` +
      `<span id="dash-agent-more-label">${esc(agentsFoldOpen
        ? t("dash.agents.foldHide")
        : t("dash.agents.foldShow", { n: missing.length }))}</span>` +
      `<span class="chev" aria-hidden="true">▾</span></button>` +
      `<div class="agent-fold${agentsFoldOpen ? " open" : ""}" id="dash-agent-fold"><div>` +
      group(t("dash.agents.notDetected"), missing, "missing") +
      `</div></div>`;
  }
  host.innerHTML = html;
}

/* 网关页 = magpie 自己的界面（2026-10-18 改）。它由 87-gateway.js 管：
   控制面接上之后，一个 iframe 指向同源反代的 /gwui/?view=providers；
   没接上时显示 Perch 的安装/接入卡。供应商/路由/用量/插件不再手写。
   总览的读数仍然来自两条腿：
     · MAGPIE（只读、2.5s）—— 网关自己 /v1/magpie/* 的读数；
     · GW（按需）—— 控制面快照，只用来判断 iframe 该不该出现。 */
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
  renderDashLiveFeed();
  renderHeat();
  renderDashMix();
  renderDashLat();
  renderDashAgents();
  if (typeof gwAgentsPrefetch === "function") gwAgentsPrefetch();
  renderGateway();
  syncHeatMetric();
  dashProbe(why, performance.now() - t0);
}

// 实时读数（700ms 跟着 renderLive 走）：只重画 Perch 自己那几个秒级读数
// （在跑 / 在等你）和网关状态条。热力图、Agent 名单、网关页都不在这里重画 ——
// 它们的数据来自会话库重扫和 magpie 的 2.5s 推送，不是 700ms 的本地状态。
function renderDashLive() {
  if (NAV_HERE !== "dash") return;
  renderDashStatus();
  renderDashKpis();
  renderDashNeed();
  renderDashLiveFeed();
}

function syncHeatMetric() {
  const bar = $("heat-metric");
  if (!bar) return;
  for (const b of bar.querySelectorAll("[data-hm]")) {
    const on = b.dataset.hm === heatMetric;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
}

/* 「实时」那一块：网关正在处理多少、最近几条请求落在哪。
   网关空闲时它不是空白 —— 最近请求仍然说明"你刚才干了什么"。
   ⚠️ 这一块只画 usage 接口的**请求元数据**（agent / provider / model / ms /
   status），没有 prompt，也没有回复内容。 */
function renderDashLiveFeed() {
  const host = $("dash-live");
  if (!host) return;
  const m = mg(), on = mgLive();
  const sub = $("dash-live-sub");
  if (sub) {
    sub.textContent = !m ? t("dash.live.pending")
      : !on ? t("dash.kpi.gatewayDown")
      : (m.conc?.requests
          ? tCount("dash.live.processing", m.conc.requests, { n: m.conc.requests })
          : t("dash.live.idleRecent", { n: (m.recent || []).length }));
  }
  if (!m) {
    host.innerHTML = `<div class="live-now idle">${esc(t("dash.live.reading"))}</div>`;
    return;
  }
  if (!on) {
    host.innerHTML = `<div class="live-now idle">${esc(m.state === "stopped"
      ? t("dash.live.downStopped") : t("dash.live.downMissing"))}</div>`;
    return;
  }
  const c = m.conc || {};
  const head = c.requests
    ? `<div class="live-now"><span class="spin"></span>${tCount("dash.live.headProcessing", c.requests, { n: dashNum(c.requests) })}` +
      (c.waiting ? esc(t("dash.live.queued", { n: dashNum(c.waiting) })) : "") +
      (c.tools ? esc(tCount("dash.live.tools", c.tools, { n: dashNum(c.tools) })) : "") + `</div>`
    : `<div class="live-now idle"><span class="dot on"></span>${esc(t("dash.live.headIdle", { n: (m.recent || []).length }))}</div>`;
  const rows = (m.recent || []).slice(0, 6);
  host.innerHTML = head + (rows.length
    ? rows.map((r) => {
        const bad = (r.status | 0) >= 400;
        const at = (r.t || "").slice(11, 19);
        return `<div class="live-row" title="${esc(at)} · ${esc(r.providerName || r.provider || "")}` +
          ` · ${esc(r.served || r.model || "")}${r.effort ? " · effort " + esc(r.effort) : ""}` +
          `${r.ttft_ms ? esc(t("dash.live.firstToken", { ms: dashNum(r.ttft_ms) })) : ""}">` +
          `<span class="st${bad ? " bad" : ""}"></span>` +
          `<span class="who">${iconHTML(r.icon, "sm")}<span class="nm">${esc(r.agentName || r.agent || "?")}</span></span>` +
          `<span class="to">${esc(r.model || r.served || "")}</span>` +
          `<span class="ms${bad ? " bad" : ""}">${bad ? "HTTP " + (r.status | 0) : dashNum(r.ms) + "ms"}</span>` +
          `</div>`;
      }).join("")
    : `<div class="live-now idle">${esc(t("dash.live.empty"))}</div>`);
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
  const prevTab = dashTab;
  dashTab = b.dataset.dtab;
  // Agent 配置抽屉挂在总览的名单上；换页就收起（网关页是全幅 iframe）。
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
  if (dashTab === "overview") {
    // 从网关页回来时强制重读：用户可能刚加了供应商/模型，而 iframe 里的
    // 写入不一定能通过 postMessage 到达（旧 magpie 版本/页面被缓存时）。
    if (prevTab === "gateway" && typeof refreshGatewayConfig === "function") {
      refreshGatewayConfig();
    } else if (typeof gwAgentsPrefetch === "function") {
      gwAgentsPrefetch();
    }
  }
  bootFact(`总览 切页=${dashTab}`);
});

// 热力图口径：轮次（本机会话库）/ 请求（magpie 网关）。
$("heat-metric").addEventListener("click", (e) => {
  const b = e.target.closest("[data-hm]");
  if (!b || b.dataset.hm === heatMetric) return;
  heatMetric = b.dataset.hm;
  try { localStorage.setItem("perch.heatMetric", heatMetric); } catch { /* 存不了就只在这一次生效 */ }
  syncHeatMetric();
  renderHeat();
  bootFact(`总览 热力图口径=${heatMetric}`);
});

