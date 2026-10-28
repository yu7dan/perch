"use strict";
/* 86-dash.js —— 总览（读数、热力图、模型柱图、在等你、运行中、Agent 名单）。
   2026-10-28 起读数全部来自本机；模型 / key 的配置在设置 › 模型提供商（85b-providers.js）。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。 */


/* 顶栏只剩两枚：Agent 的内容 2026-10-17 并进了总览（用户要求）。
   存过 "agents" 的旧 localStorage 会被下面的校验挡掉、回落到总览，不用迁移。 */
// 2026-10-28：网关子页从总览拿掉（Perch 不再内嵌 magpie）。只剩一页时页头不画切换条。
const DASH_TABS = [["overview", "dash.tab.overview"]];
let dashTab = "overview";
try {
  const k = localStorage.getItem("perch.dashTab");
  if (DASH_TABS.some(([id]) => id === k)) dashTab = k;
} catch { /* 存不了就用默认 */ }


/* 热力图口径：轮次 / token，都来自 Perch 自己的会话库扫描（2026-10-28 起不再有网关请求数）。
   两套数据放在同一副 53 周骨架上，切一下就能对照"我说了多少轮"和"模型处理了多少 token"。 */
let heatMetric = "turns";
try {
  const k = localStorage.getItem("perch.heatMetric");
  if (k === "turns" || k === "tokens") heatMetric = k;
} catch { /* 存不了就用默认 */ }

/* 数字压缩成 1.2k / 3.4M / 5.6B（总览的 token 读数用）。名字是历史遗留：最早是给网关读数写的。 */
function mgCompact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
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
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    renderDashboard("进入总览");
    // Agent 卡要显示每个 agent 现在用哪个提供商（设置 › Agents 里配的）。
    if (typeof provRequest === "function") provRequest();
  } else if (view === "settings") {
    // 配置抽屉属于总览的 Agent 名单；离开总览就收起（见 89-agent-cfg.js）。
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // 先按缓存画（第一帧不空），同时问 Go 要权威值（默认目录是不是还在盘上
    // 只有 Go 知道）。settings 消息回来时 syncSettingsUI 会再刷一遍。
    renderSettings("进入设置");
    sendCtrl({ type: "settings.get" });
    if (typeof provRequest === "function") { renderProviderSettings(); provRequest(); }
    if (typeof renderSetNav === "function") { renderSetNav(); requestAnimationFrame(setNavSync); }
    // 进来就能直接打字搜索（Orca 的设置页同样把焦点交给搜索框）。
    if (typeof focusSettingsSearch === "function") focusSettingsSearch(false);
  } else {
    requestAnimationFrame(() => {
      if (!activeTab) return;
      activeTab.refit();
      activeTab.focus();
    });
    renderLists(searchKey());
    viewProbe("回到工作区");
    if (SETTINGS.topMode === "botgroup" && typeof renderBotGroup === "function") {
      renderBotGroup("回到 Bot Group");
    }
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
/* 一天的 token 合计（输入 + 输出 + 缓存读写）。数据来自会话文件（internal/history/tokens.go），
   不再问网关 —— 总览的每一个读数都必须在没有网关的机器上成立。 */
function tokTotal(u) {
  return u ? (u.in || 0) + (u.out || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
}
function tokCacheRate(u) {
  const prompt = u ? (u.in || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
  return prompt ? Math.round((100 * (u.cacheRead || 0)) / prompt) : null;
}
/* 最近 n 天（含今天）的日活，旧 → 新；查不到的日子补 0。 */
function ovDays(n) {
  const byDay = new Map((STATE?.activity || []).map((a) => [a.day, a]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = dashAddDays(today, -i);
    out.push(Object.assign({ date: d }, byDay.get(dashDay(d)) || { day: dashDay(d) }));
  }
  return out;
}
/* 7 天趋势线（KPI 卡右下角）。纯形状，不画轴；最后一点是今天。 */
function ovSpark(vals, color) {
  const w = 92, h = 30, max = Math.max(1, ...vals), step = w / Math.max(1, vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return `<svg class="ov-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">` +
    `<path d="M0,${h} L${pts.join(" L")} L${w},${h} Z" fill="${color}" opacity=".12"/>` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}

function renderDashKpis() {
  const host = $("dash-kpi");
  if (!host) return;
  const d7 = ovDays(7);
  const td = d7[6];
  const turns7 = d7.map((a) => a.turns || 0);
  const tok7 = d7.map((a) => tokTotal(a.tokens));
  const cache7 = d7.map((a) => tokCacheRate(a.tokens) || 0);
  const avgPrev = turns7.slice(0, 6).reduce((a, b) => a + b, 0) / 6;
  const delta = avgPrev > 0 ? Math.round((100 * ((td.turns || 0) - avgPrev)) / avgPrev) : null;
  // 和旁边的「需要你」同一个口径：Bot Group 的成员格也算（原来只数 Workspaces，出现过「在跑 0/0 · 1 个等你」）。
  const live = TAB_LIST.filter((t) => t.id > 0);
  const bots = live.filter((t) => t.group).length;
  const running = live.filter((t) => !t.connDown).length;
  const need = needModel();
  const working = live.filter((t) => cellState(t) === "working").length;
  const tok = td.tokens || null;
  const cache = tokCacheRate(tok);
  const cacheWeek = (() => {
    const u = d7.reduce((a, x) => {
      const t = x.tokens || {};
      a.in += t.in || 0; a.cacheRead += t.cacheRead || 0; a.cacheWrite += t.cacheWrite || 0;
      return a;
    }, { in: 0, cacheRead: 0, cacheWrite: 0 });
    return tokCacheRate(u);
  })();
  const date = $("dash-date");
  if (date) {
    try {
      date.textContent = new Intl.DateTimeFormat(PERCH_LOCALE === "zh" ? "zh-CN" : "en",
        { month: "short", day: "numeric", weekday: "short" }).format(new Date());
    } catch (_) { date.textContent = ""; }
  }
  const card = (label, value, unit, sub, cls, spark) =>
    `<div class="ov-card ov-kpi"><span class="lbl">${esc(label)}</span>` +
    `<div class="v">${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}</div>` +
    `<div class="s${cls ? " " + cls : ""}">${esc(sub)}</div>${spark || ""}</div>`;
  const inp = tok ? (tok.in || 0) + (tok.cacheRead || 0) + (tok.cacheWrite || 0) : 0;
  host.innerHTML =
    card(t("dash.kpi.running"), dashNum(running), t("ov.kpi.ofPanes", { n: live.length }) + (bots ? " · " + t("ov.kpi.bots", { n: bots }) : ""),
      t("ov.kpi.runningSub", { need: need.wait.length, working }), need.wait.length ? "ask" : "") +
    card(t("dash.kpi.turnsToday"), dashNum(td.turns || 0), "",
      delta == null ? t("ov.kpi.noBaseline") : t(delta >= 0 ? "ov.kpi.up" : "ov.kpi.down", { n: Math.abs(delta) }),
      delta == null ? "" : (delta >= 0 ? "up" : "down"), ovSpark(turns7, "var(--mx-1)")) +
    card(t("dash.kpi.tokensToday"), tok ? mgCompact(tokTotal(tok)) : "0", "",
      tok ? t("dash.kpi.tokensSub", { inp: mgCompact(inp), out: mgCompact(tok.out || 0) }) : t("dash.kpi.tokensNone"),
      "", ovSpark(tok7, "var(--mx-2)")) +
    card(t("dash.kpi.cacheHit"), cache == null ? "—" : String(cache), cache == null ? "" : "%",
      cacheWeek == null ? t("dash.kpi.tokensNone") : t("ov.kpi.cacheWeek", { n: cacheWeek }),
      "", ovSpark(cache7, "var(--mx-3)"));
}

/* 活动：近 14 天一根一柱（轮次 / token 两种口径，和原来的热力图共用 heatMetric）。
   今天那根用强调色，其余是前景色 16%；悬停给日期和数值。 */
function renderOvActivity() {
  const host = $("ov-bars");
  if (!host) return;
  const days = ovDays(14);
  const val = (a) => heatMetric === "tokens" ? tokTotal(a.tokens) : (a.turns || 0);
  const vals = days.map(val);
  const max = Math.max(1, ...vals);
  const sub = $("ov-activity-sub");
  const total = vals.reduce((a, b) => a + b, 0);
  if (sub) sub.textContent = heatMetric === "tokens"
    ? t("ov.activity.subTokens", { n: mgCompact(total) })
    : t("ov.activity.subTurns", { n: dashNum(total) });
  host.innerHTML = days.map((a, i) => {
    const v = vals[i], last = i === days.length - 1;
    const h = v ? Math.max(3, Math.round((100 * v) / max)) : 0;
    const label = heatMetric === "tokens" ? mgCompact(v) + " token" : tCount("dash.heat.tip.turns", v, { n: dashNum(v), sessions: dashNum(a.sessions || 0) });
    return `<div class="ov-bar${last ? " today" : ""}" title="${esc(a.day + " · " + label)}">` +
      `<div class="ov-bar-t"><i style="height:${h}%"></i></div>` +
      `<span>${i % 2 === 1 || last ? a.date.getDate() : ""}</span></div>`;
  }).join("");
}

/* 53 周 × 7 天。周一在最上、月份在顶行 —— 和 magpie 的 Usage 热力图同一副骨架。
   所有格子用**显式 grid-column/grid-row** 摆位：月份标签和日期格在同一张 grid 里，
   靠自动排布会把它们挤到同一行。
   两种口径（轮次 / 请求）共用这一张骨架：切 tab 只换数据，不换版式。 */
function heatPoints() {
  if (heatMetric === "tokens") {
    return (STATE?.activity || []).map((a) => ({
      day: a.day, v: tokTotal(a.tokens), extra: a.replies | 0,
    }));
  }
  return (STATE?.activity || []).map((a) => ({
    day: a.day, v: a.turns | 0, extra: a.sessions | 0,
  }));
}
const HEAT_WEEKS = 53;

function renderHeat() {
  // 方案 A 的「活动」柱图和热力图共用口径（heatMetric）；页面上现在只有柱图。
  renderOvActivity();
  const grid = $("dash-heat");
  if (!grid) return;
  const pts = heatPoints();
  const byDay = new Map(pts.map((a) => [a.day, a]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = (today.getDay() + 6) % 7;               // 周一 = 0
  const start = dashAddDays(today, -((HEAT_WEEKS - 1) * 7 + dow)); // 53 周前那个周一
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
    grid.querySelectorAll("i").length === HEAT_WEEKS * 7;
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
    for (let c = 0; c < HEAT_WEEKS; c++) {
      const monday = dashAddDays(start, c * 7);
      if (monday.getMonth() !== lastMonth) {
        lastMonth = monday.getMonth();
        // 「11月」这种三个字，两格（~26px）放不下会被裁成「1月」——
        // 给三格；月份最短也有 4 周，下一枚标签从 c+6 起，不会撞上。
        const span = (c + 3 <= HEAT_WEEKS + 1) ? 3 : 2;
        html += `<span class="mo" style="grid-column:${c + 2} / span ${span};grid-row:1">` +
          `${esc(monthFmt.format(monday))}</span>`;
      }
    }
    for (let r = 0; r < 7; r++) {
      html += `<span class="wd" style="grid-row:${r + 2}">${WD[r]}</span>`;
      for (let c = 0; c < HEAT_WEEKS; c++) {
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
    if (heatMetric === "tokens") {
      const total = pts.reduce((n, p) => n + p.v, 0);
      sub.textContent = total
        ? t("dash.heat.tokensSub", { total: mgCompact(total), days: pts.filter((p) => p.v > 0).length })
        : t("dash.heat.noTokens");
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

/* 模型用量：近 30 天每个模型经手的 token（横条，按总量排序；前 4 个各占一色，其余并成「其他」）。
   配色走 dataviz 参考调色板的前四个分类槽（深浅两档都跑过校验），「其他」是中性灰。
   **颜色跟着模型走，不跟名次走**：一个模型第一次领到槽之后整段会话都用它（MIX_SLOT）。
   横条旁边永远带数值和占比 —— 浅色下黄 / 青两槽对底色不足 3:1，数值是"可读替代"。 */
const MIX_DAYS = 30, MIX_SLOTS = 4;
const MIX_SLOT = new Map();
function mixSlotOf(model) {
  if (!MIX_SLOT.has(model)) {
    const used = new Set(MIX_SLOT.values());
    for (let i = 1; i <= MIX_SLOTS; i++) if (!used.has(i)) { MIX_SLOT.set(model, i); break; }
  }
  return MIX_SLOT.get(model) || 0;
}
function renderDashMix() {
  const host = $("dash-mix-bar");
  if (!host) return;
  const days = ovDays(MIX_DAYS);
  // <synthetic> 是本地合成的占位回复（不经过任何模型），不进图。
  const totals = new Map();
  for (const d of days) for (const [m, n] of Object.entries(d.models || {})) {
    if (m && !m.startsWith("<")) totals.set(m, (totals.get(m) || 0) + n);
  }
  const ranked = [...totals.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const series = [];
  for (const [m] of ranked) {
    if (series.length >= MIX_SLOTS) break;
    if (mixSlotOf(m)) series.push(m);
  }
  const inSeries = new Set(series);
  const otherSum = ranked.filter(([m]) => !inSeries.has(m)).reduce((n, [, v]) => n + v, 0);
  const sum = ranked.reduce((n, [, v]) => n + v, 0);
  const sub = $("dash-mix-sub");
  if (sub) sub.textContent = sum ? t("ov.models.sub", { n: mgCompact(sum) }) : "";
  if (!sum) {
    host.innerHTML = `<div class="ov-empty">${esc(t("ov.models.empty"))}</div>`;
    return;
  }
  const top = Math.max(1, ...series.map((m) => totals.get(m)), otherSum);
  const row = (name, v, cls) =>
    `<div class="ov-mrow" title="${esc(name + " · " + mgCompact(v))}">` +
    `<span class="nm"><i class="${cls}"></i><span class="ell">${esc(name)}</span></span>` +
    `<span class="tr"><i class="${cls}" style="width:${Math.max(1, (100 * v) / top).toFixed(1)}%"></i></span>` +
    `<span class="vv">${esc(mgCompact(v))} · ${Math.max(v ? 1 : 0, Math.round((100 * v) / sum))}%</span></div>`;
  host.innerHTML = series.map((m) => row(m, totals.get(m), "s" + MIX_SLOT.get(m))).join("") +
    (otherSum ? row(t("dash.mix.other"), otherSum, "so") : "");
}

/* 顶部是**工作区入口**，不是网关状态条。
   用户 2026-10-17 评审原话："总览页面，你顶部放一个 magpie 的连接显示不合适" ——
   用不用网关是另一件事，不该占据总览的第一行。这一行回答的是"我现在这边怎么样"，
   并把「进入工作区 / 新建 Agent」摆在手边（用户点名要的入口）。 */
function renderDashStatus() {
  const host = $("dash-status");
  if (!host) return;
  // 2026-10-28：在跑 / 在等你 / 项目数并进了下面的读数条（同一屏不说两遍），
  // 页头只留两个入口。⚠️ 结构只建一次（换语言才重建）：700ms 一次的重画如果
  // 把按钮换掉，mousedown / mouseup 落在两颗元素上，那次点击就静默丢了。
  if (host.querySelector("[data-wsact]") && host.dataset.locale === PERCH_LOCALE) return;
  host.dataset.locale = PERCH_LOCALE;
  host.innerHTML =
    `<button type="button" class="ws-act" data-wsact="enter">${esc(t("dash.status.enter"))}</button>` +
    `<button type="button" class="ws-act primary" data-wsact="new">${esc(t("dash.status.new"))}</button>`;
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
/* 「需要你」：页面最上面一排卡（方案 A）。读的是右栏「需要你」同一个模型（needModel），
   不另算一份。卡就是 99-boot 里那个点击委托认的 `.need[data-tab]`：点卡 / 点「去处理」=
   回工作区并跳到那一格。没有待办时不占一排：只留一行安静的说明。 */
function ovProjectOf(tab) {
  const cwd = String((typeof effCwd === "function" ? effCwd(tab) : "") || "").replace(/[\\/]+$/, "").toLowerCase();
  let best = null;
  for (const p of (STATE?.projects || [])) {
    const root = String(p.path || "").replace(/[\\/]+$/, "").toLowerCase();
    if (root && (cwd === root || cwd.startsWith(root + "\\") || cwd.startsWith(root + "/"))) {
      if (!best || root.length > best.root.length) best = { root, p };
    }
  }
  if (best) return typeof projectName === "function" ? projectName(best.p) : (best.p.name || "");
  return cwd ? cwd.split(/[\\/]/).pop() : "";
}
function renderDashNeed() {
  const host = $("dash-need");
  if (!host) return;
  const M = needModel();
  const title = $("ov-need-title");
  if (title) title.textContent = t("ov.need.title", { n: M.wait.length });
  if (!M.wait.length) {
    host.classList.add("quiet");
    host.innerHTML = `<div class="ov-need-none"><span class="dot"></span>${esc(t("ov.need.none"))}</div>`;
    return;
  }
  host.classList.remove("quiet");
  host.innerHTML = M.wait.slice(0, 4).map((r) => {
    const typ = (r.t.spec && r.t.spec.agent) || "";
    // Bot Group 的成员：标题是「组名 · 角色」，第二行说它在哪个组、是哪个 agent（Bot 没有会话名，
    // 原来退回成光秃秃的 agent 名，看不出是哪个组的哪个角色）。
    const bg = r.t.group && typeof BOTGROUPS !== "undefined" ? BOTGROUPS.find((x) => x.id === r.t.group) : null;
    const bot = bg ? (bg.bots || []).find((x) => x.id === r.t.bot) : null;
    const name = bot ? bg.name + " · " + (bot.manager ? "Manager" : bot.role) : currentTabTitle(r.t);
    const proj = bot ? t("ov.need.inGroup", { agent: typeof opAgentById === "function" && opAgentById(typ) ? opAgentById(typ).name : typ }) : ovProjectOf(r.t);
    // ⚠️ 不挂 .need：右栏「需要你」的 .need 是一张 13px 首列的网格（40-sidebar.css，后加载），
    //    挂上就把这张卡的图标塞进 13px、压在标题上。点击委托认 .ov-needcard（99-boot.js）。
    return `<div class="ov-card ov-needcard k-${esc(r.kind)}" data-tab="${r.t.id}" role="button" tabindex="0">` +
      `<span class="ov-need-ico">${typeof agentMarkHTML === "function" ? agentMarkHTML(typ) : ""}</span>` +
      `<span class="ov-need-m"><span class="hd"><b class="ell">${esc(name)}</b>` +
      `<span class="ov-chip ask">${esc(needWhy(r.kind))}</span>` +
      `<span class="tm">${esc(rel(r.at))}</span></span>` +
      (r.text ? `<span class="tx">${esc(r.text)}</span>` : "") +
      (proj ? `<span class="pj">${esc(bot ? proj : t("ov.need.project", { name: proj }))}</span>` : "") + `</span>` +
      `<span class="ov-btn sm">${esc(t("ov.need.go"))} →</span></div>`;
  }).join("");
}

/* Agent 接线台。清单由 Go 侧的 agentCatalogDefs 给（用户 2026-10-17 点名的那份），
   按两件事分组，因为它们是**两个不同的事实**：
     · 装没装 —— 本机配置/CLI 探测（不是"我猜"）
     · 接没接 —— Perch 自己的 agentDefs 里有没有适配器
   每组三列，30px 彩色 logo + 名称 + 厂商 / 路径 + 状态；未安装的**不压暗**
   （压暗会把 logo 一起吞掉）。 */
/* 安装台按 agent 分开记：{ [id]: {id,name,state,phase,source,lines,…} }。
   同时点几个时每个都有自己的状态和日志；INSTALL_AT 只是"现在面板显示哪个"。
   声明放在这里是因为 86 的名单行要先读它，88-install.js 负责行为。 */
let INSTALLS = Object.create(null);
let INSTALL_AT = "";

/* "有没有下载"是用户 2026-10-17 定的分界线：已检测到的按「接没接进 Perch」
   分成两组；没检测到的收进折叠栏里。
   2026-10-19 用户把默认改成了**展开**：收起时页面底部会空一截，先让用户
   看到完整清单；要收起是他们自己的动作（同一个会话里不会被重画弹回去）。 */
let agentsFoldOpen = true;

function renderDashAgents() {
  const host = $("dash-agent-list");
  if (!host) return;
  const list = Array.isArray(CATALOG) ? CATALOG : [];
  const sub = $("dash-agent-sub");
  // caps 是权威；没有这个字段的旧名单退回 adapter（只认结构化状态）。
  const capsOf = (a) => a.caps || {
    launch: !!a.adapter, status: !!a.adapter, waiting: !!a.adapter,
  };
  const installed = list.filter((a) => a.installed);
  const missing = list.filter((a) => !a.installed);
  if (sub) {
    sub.textContent = list.length
      ? t("ov.agents.sub", { inst: installed.length, miss: missing.length })
      : t("dash.agents.scanning");
  }
  if (!list.length) {
    host.innerHTML = `<div class="ag-empty">${esc(t("dash.agents.listPending"))}</div>`;
    return;
  }
  /* 一张卡 = 一个 agent（方案 A）。已安装的：状态等级 + 它现在用哪个模型提供商（设置 ›
     Agents 里配的；没配 = 自己的登录）+ 打开 / 配置。没检测到的：安装（有配方）或安装说明。
     按钮的 data-* 和原来的名单一样，行为仍由 88-install.js 的委托处理。 */
  const card = (a) => {
    const c = capsOf(a);
    const inst = INSTALLS[a.id];
    const busy = inst && inst.state === "running";
    const isIn = !!a.installed;
    const level = !isIn
      ? (a.windows === false ? t("dash.agents.macOnly") : a.install ? t("ov.agents.installable") : t("dash.agents.notDetected"))
      : c.waiting ? t("dash.agents.levelFull")
        : c.status ? t("dash.agents.levelBasic")
          : c.launch ? t("dash.agents.levelLaunch") : t("dash.agents.levelNone");
    const lvCls = isIn ? (c.status ? " ok" : "") : "";
    let line;
    if (isIn) {
      const cfg = (typeof provAgentCfg === "function") ? provAgentCfg(a.id) : {};
      const p = cfg.provider && typeof provById === "function" ? provById(cfg.provider) : null;
      line = `<span class="k">${esc(t("ov.agents.model"))}</span>` +
        esc(p ? (cfg.model ? `${p.name} · ${cfg.model}` : p.name) : t("ov.agents.ownLogin"));
    } else {
      line = esc(a.install ? t("ov.agents.installHint") : t("dash.agents.detailCli", { vendor: a.vendor || "" }));
    }
    const busyTx = busy ? (inst.phase === "scanning" ? t("dash.agents.installScanning")
      : inst.phase === "queued" ? t("dash.agents.installQueued") : t("dash.agents.installBusy")) : "";
    let acts = "";
    if (busy) {
      acts = `<span class="ov-busy"><span class="spin"></span>${esc(busyTx)}</span>`;
    } else if (isIn && c.launch) {
      acts = `<button type="button" class="ov-btn sm p" data-launch="${esc(a.id)}" title="${esc(t("dash.agents.openTitle", { name: a.name || "" }))}">${esc(t("dash.agents.open"))}</button>` +
        (a.setup ? `<button type="button" class="ov-btn sm" data-setup="${esc(a.id)}" title="${esc(t("dash.agents.setupTitle", { name: a.name || "" }))}">${esc(t("dash.agents.setup"))}</button>` : "") +
        `<button type="button" class="ov-btn sm" data-agentcfg="${esc(a.id)}" aria-label="${esc(t("dash.agents.configAria", { name: a.name || "" }))}">${esc(t("ov.agents.config"))}</button>`;
    } else if (a.install) {
      acts = `<button type="button" class="ov-btn sm${isIn ? "" : " p"}" data-install="${esc(a.id)}" title="${esc(t("dash.agents.installTitle", { name: a.name || "" }))}">${esc(t("dash.agents.install"))}</button>`;
    } else if (a.url) {
      acts = `<button type="button" class="ov-btn sm" data-docs="${esc(a.id)}" title="${esc(t("dash.agents.docsTitle", { name: a.name || "" }))}">${esc(t("dash.agents.docs"))}</button>`;
    }
    return `<div class="ov-card ov-agent${isIn ? "" : " missing"}">` +
      `<div class="hd">${iconHTML(a.icon, "lg")}<span class="who"><b class="ell">${esc(a.name || a.id)}</b>` +
      `<span class="ell" title="${esc(a.path || a.vendor || "")}">${esc(isIn ? (a.vendor || "") : t("dash.agents.notDetected"))}</span></span>` +
      `<span class="ov-chip${lvCls}">${esc(level)}</span></div>` +
      `<div class="ln">${line}</div><div class="acts">${acts}</div></div>`;
  };
  host.innerHTML = installed.map(card).join("") + missing.map(card).join("") +
    (installed.length ? "" : `<div class="ag-empty">${esc(t("dash.agents.emptyAll"))}</div>`);
}

/* 总览：本机读数（会话库扫描 + 格子状态）+ Agent CLI 名单。2026-10-28 起不再有网关读数。 */
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
  renderDashAgents();
  syncHeatMetric();
  dashProbe(why, performance.now() - t0);
}

// 实时读数（700ms 跟着 renderLive 走）：只重画 Perch 自己那几个秒级读数
// （在跑 / 在等你 / 运行中）。热力图、模型柱图、Agent 名单都不在这里重画 ——
// 它们的数据来自会话库重扫和 catalog 推送，不是 700ms 的本地状态。
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

/* 「运行中」：Perch 里开着的 agent 格（和左栏同一种行）。点一行 = 回工作区并切到那一格。
   等你的排最前，其次在干活的，最后是空闲 / 已停。 */
const DASH_RUN_ORDER = { ask: 0, unread: 1, working: 2, failed: 3, idle: 4, done: 5, interrupted: 6, off: 7 };
function renderDashLiveFeed() {
  const host = $("dash-live");
  if (!host) return;
  const live = wsTabs().filter((t) => t.id > 0);
  const sub = $("dash-live-sub");
  if (sub) sub.textContent = live.length ? t("dash.run.sub", { n: live.length }) : "";
  if (!live.length) {
    host.innerHTML = `<div class="live-now idle">${esc(t("dash.run.empty"))}</div>`;
    return;
  }
  const rank = (tab) => DASH_RUN_ORDER[cellState(tab)] ?? 9;
  host.innerHTML = live.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 8).map(agentRowHTML).join("");
}

/* 总览的自证读数：盒子多大、哪一页、几格、几个活跃日、多少轮。
   截图只能看出"像不像"，这些数才是"它到底画了什么"的字节证据。
   周期性重画时读数不变就不能跟着刷日志 —— 同一读数 30s 内只记一次；
   切页、换视图、数值真变了仍然立刻落。 */
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
  try { localStorage.setItem("perch.dashTab", dashTab); } catch { /* 存不了就只在这一次生效 */ }
  renderDashTabs();
  for (const [id] of DASH_TABS) {
    const el = $("dash-" + id);
    if (el) el.hidden = id !== dashTab;
  }
  const pane = $("dash-" + dashTab);
  if (pane) { pane.style.animation = "none"; void pane.offsetWidth; pane.style.animation = ""; }
  bootFact(`总览 切页=${dashTab}`);
});

// 热力图口径：轮次 / token（都来自本机会话库）。
$("heat-metric").addEventListener("click", (e) => {
  const b = e.target.closest("[data-hm]");
  if (!b || b.dataset.hm === heatMetric) return;
  heatMetric = b.dataset.hm;
  try { localStorage.setItem("perch.heatMetric", heatMetric); } catch { /* 存不了就只在这一次生效 */ }
  syncHeatMetric();
  renderHeat();
  bootFact(`总览 热力图口径=${heatMetric}`);
});

