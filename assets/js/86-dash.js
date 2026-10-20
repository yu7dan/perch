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

/* "有没有下载"是用户 2026-10-17 定的分界线：已检测到的按「接没接进 Perch」
   分成两组；没检测到的收进 magpie 那个样式的折叠栏里。
   2026-10-19 用户把默认改成了**展开**：收起时页面底部会空一截，先让用户
   看到完整清单；要收起是他们自己的动作（同一个会话里不会被重画弹回去）。 */
let agentsFoldOpen = true;

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

/* 一行的接入视图。所有判断都在 08-agent-model.js 的纯函数里 —— 这里只把
   三份外部事实拼起来：名单（探测）、magpie 的接线行、落盘的接入记录。 */
function dashAgentView(a) {
  const gw = typeof gwInfoFor === "function" ? gwInfoFor(a.id) : null;
  return agentIntegrationView(a, gw, AGENT_STATE[a.id] || null, dashMagpieState());
}

/* 主行动 → 一颗按钮。动作名来自模型，不在这里重新判断“该不该出现”。 */
function dashAgentAction(a, v, busy) {
  const name = a.name || "";
  const id = esc(a.id);
  if (busy) {
    const inst = INSTALLS[a.id];
    return `<span class="st">${esc(inst.phase === "scanning"
      ? t("dash.agents.installScanning")
      : inst.phase === "queued" ? t("dash.agents.installQueued")
      : t("dash.agents.installBusy"))}</span>`;
  }
  switch (v.primary.action) {
    case "install":
      return a.install
        ? `<button type="button" class="dl" data-install="${id}"` +
          ` title="${esc(t("dash.agents.installTitle", { name }))}">${esc(t("dash.agents.install"))}</button>`
        : a.url
          ? `<button type="button" class="dl" data-docs="${id}"` +
            ` title="${esc(t("dash.agents.docsTitle", { name }))}">${esc(t("dash.agents.docs"))}</button>`
          : "";
    case "docs":
      return a.url
        ? `<button type="button" class="dl" data-docs="${id}"` +
          ` title="${esc(t("dash.agents.docsTitle", { name }))}">${esc(t("dash.agents.docs"))}</button>`
        : "";
    case "open": {
      const live = typeof liveAgentTab === "function" && liveAgentTab(a.id);
      const key = live ? "dash.agents.view" : "dash.agents.open";
      const titleKey = live ? "dash.agents.viewTitle" : "dash.agents.openTitle";
      return `<button type="button" class="dl" data-launch="${id}"` +
        ` title="${esc(t(titleKey, { name }))}">${esc(t(key))}</button>`;
    }
    case "setup":
      return `<button type="button" class="dl" data-setup="${id}"` +
        ` title="${esc(t("dash.agents.setupTitle", { name }))}">${esc(t("dash.agents.setup"))}</button>`;
    case "connect":
      return `<button type="button" class="dl" data-gwconnect="${id}"` +
        ` title="${esc(t("dash.agents.connectTitle", { name }))}">${esc(t("dash.agents.connect"))}</button>`;
    case "settings":
      return `<button type="button" class="dl" data-gwsettings="${id}"` +
        ` title="${esc(t("dash.agents.gwSettingsTitle", { name }))}">${esc(t("dash.agents.gwSettings"))}</button>`;
    case "usage":
      return `<button type="button" class="dl" data-usage="${id}"` +
        ` title="${esc(t("dash.agents.usageTitle", { name }))}">${esc(t("dash.agents.usage"))}</button>`;
    case "drawer":
      return `<button type="button" class="dl" data-usage="${id}"` +
        ` title="${esc(t("dash.agents.configTitle", { name }))}">${esc(t("dash.agents.config"))}</button>`;
    default:
      return "";
  }
}

/* 行上那句状态：分组名之外，还要说“下一步是什么”。用户不需要知道
   “完整状态”这个抽象词；他需要看到「已安装 · 下一步：打开」。 */
function dashAgentStatus(a, v, gid) {
  if (gid === "missing") {
    return a.windows === false ? t("dash.agents.macOnly") : t("dash.agents.notDetected");
  }
  if (v.group === "complete" || v.group === "native") {
    return t("dash.agents.group." + v.group);
  }
  if (v.group === "launch") return t("dash.agents.group.launch");
  if (v.group === "nolaunch") return t("dash.agents.group.nolaunch");
  const step = v.primary.step || v.nextStep;
  const key = {
    detect: "dash.agents.next.install",
    install: "dash.agents.next.install",
    launch: "dash.agents.next.open",
    auth: "dash.agents.next.auth",
    status: v.primary.action === "setup" ? "dash.agents.next.setup" : "dash.agents.next.status",
    resume: "dash.agents.next.resume",
    gateway: v.primary.action === "settings" ? "dash.agents.next.magpie" : "dash.agents.next.gateway",
  }[step];
  return key ? t(key) : t("dash.agents.levelNone");
}

/* 五条腿的小标记（L 启动 / S 状态 / R 续接 / G 网关 / A 登录）。它们是
   同一份步骤状态的另一种排布，不是第二套判断。 */
function dashAgentLegs(v) {
  const letter = { launch: "L", status: "S", resume: "R", gateway: "G", auth: "A" };
  return `<span class="ag-legs" aria-hidden="true">` +
    v.legs.map((l) =>
      `<i class="ag-leg ${esc(l.state)}" title="${esc(t("agent.leg.title", {
        step: t("agent.step." + l.key), state: t("agent.step.state." + l.state),
      }))}">` + `${letter[l.key] || "?"}</i>`).join("") +
    `</span>`;
}

function renderDashAgents() {
  const host = $("dash-agent-list");
  if (!host) return;
  const m = mg();
  const list = m && (m.catalog || []).length ? m.catalog : [];
  const sub = $("dash-agent-sub");

  // 每个 agent 只落一个组（08-agent-model 里保证互斥）。这里不再用三个
  // 独立的布尔过滤 —— 旧写法会让同一个 agent 同时出现在「完整」和「仅启动」。
  const groups = Object.create(null);
  for (const g of AGENT_GROUPS) groups[g] = [];
  const views = new Map();
  for (const a of list) {
    const v = dashAgentView(a);
    views.set(a.id, v);
    groups[v.group].push(a);
  }
  const total = AGENT_GROUPS.reduce((n, g) => n + groups[g].length, 0);
  if (list.length && total !== list.length) {
    // 真出现的话，屏上会少行；这条日志是唯一抓得住它的证人。
    bootFact(`Agent 名单分组不变量被破坏：${list.length} 个 agent 只落进 ${total} 个组`);
  }

  const routed = list.filter((a) => (a.calls | 0) > 0);
  if (sub) {
    const bits = [];
    for (const g of ["complete", "native", "action", "launch", "nolaunch", "missing"]) {
      if (!groups[g].length) continue;
      bits.push(t("dash.agents.sum." + g, { n: groups[g].length }));
    }
    sub.textContent = list.length
      ? bits.join(" · ") + (routed.length ? t("dash.agents.sumRouted", { n: routed.length }) : "")
      : t("dash.agents.scanning");
  }
  if (!list.length) {
    host.innerHTML = `<div class="gw-empty">${esc(t("dash.agents.listPending"))}</div>`;
    return;
  }

  const row = (a, gid) => {
    const v = views.get(a.id);
    const cfg = gid !== "missing";
    const st = dashAgentStatus(a, v, gid);
    const stateCls = v.complete ? " ok"
      : v.group === "missing" || v.group === "nolaunch" || v.group === "launch" ? " off" : "";
    // 这份名单只列 CLI agent：每行副标题都带 CLI，和网关层的桌面客户端分开。
    const detail = gid === "missing"
      ? t("dash.agents.detailCli", { vendor: a.vendor || "" })
      : t("dash.agents.detailPath", { path: a.path || a.vendor || "" });
    const calls = (a.calls | 0) > 0 ? t("dash.agents.calls", { n: dashNum(a.calls) }) : "";
    const inst = INSTALLS[a.id];
    const busy = !!(inst && inst.state === "running");
    const ga = typeof gwInfoFor === "function" ? gwInfoFor(a.id) : null;
    const gdot = ga
      ? `<span class="gwdot${ga.wired ? " on" : ""}" title="${esc(ga.wired
          ? t("dash.agents.wired") : t("dash.agents.notWired"))}"></span>`
      : "";
    // 状态那句的 title 说“为什么”：模型给的 noteKey 是稳定的，文案在这边翻。
    const why = v.reason ? t(v.reason, { name: a.name || "" }) : "";
    return `<div class="ag${cfg ? " cfg" : ""}"` +
      (cfg ? ` data-agentcfg="${esc(a.id)}" role="button" tabindex="0"` +
        ` aria-label="${esc(t("dash.agents.configAria", { name: a.name || "" }))}"` : "") + `>` +
      iconHTML(a.icon) +
      `<span class="who"><span class="nm">${esc(a.name)}${gdot}</span>` +
      `<span class="sub" title="${esc(detail + calls)}">${esc(detail + calls)}</span></span>` +
      dashAgentLegs(v) +
      `<span class="st${stateCls}"${why ? ` title="${esc(why)}"` : ""}>${esc(st)}</span>` +
      dashAgentAction(a, v, busy) +
      (cfg ? `<span class="ag-cfg-chev" aria-hidden="true">›</span>` : "") +
      `</div>`;
  };
  const group = (label, items, gid) =>
    `<div class="ag-group">${esc(label)}<span>${items.length}</span></div>` +
    `<div class="roster">${items.map((a) => row(a, gid)).join("")}</div>`;

  let html = "";
  for (const gid of ["complete", "native", "action", "launch", "nolaunch"]) {
    if (!groups[gid].length) continue;
    html += group(t("dash.agents.group." + gid), groups[gid], gid);
  }
  if (!list.some((a) => a.installed)) {
    html += `<div class="gw-empty">${esc(t("dash.agents.emptyAll"))}</div>`;
  }
  if (groups.missing.length) {
    html +=
      `<button type="button" class="agent-more${agentsFoldOpen ? " open" : ""}"` +
      ` id="dash-agent-more" data-agents-fold>` +
      `<span id="dash-agent-more-label">${esc(agentsFoldOpen
        ? t("dash.agents.foldHide")
        : t("dash.agents.foldShow", { n: groups.missing.length }))}</span>` +
      `<span class="chev" aria-hidden="true">▾</span></button>` +
      `<div class="agent-fold${agentsFoldOpen ? " open" : ""}" id="dash-agent-fold"><div>` +
      group(t("dash.agents.group.missing"), groups.missing, "missing") +
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

