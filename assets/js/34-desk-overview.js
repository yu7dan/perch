"use strict";
/* 34-desk-overview.js —— 总览：Dock 打开的面板（不是块；Agent 下载不在这里，在开格子的地方）。
   照定稿模拟（spec/desk 的总览那一段）。读数全是本机的：
     · 在干活 / 在等你 / 开着的 —— 台面上的格子（22-live.js 的 cellState / needModel）；
     · 轮次 / token / 缓存 / 按模型 —— Go 扫会话库算的每日活动（STATE.activity，internal/history）。
   只在打开时搭一次外壳（带入场动画）；之后定时刷新只换内容，而且内容没变就不动 —— 不然就是一闪一闪。 */

const OV = { metric: "turns" };
const ST_WORD = { work: "干活中", wait: "在等你", done: "跑完一轮，还没看", off: "停了", fail: "出错了", idle: "空闲" };
const HEAT_DAYS = 26 * 7;
const fmtK = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n | 0);
const tokTotal = (u) => u ? (u.in || 0) + (u.out || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
function dayKey(d) { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// 最近 n 天（含今天），旧 → 新；没有记录的日子补 0
function ovDays(n) {
  const by = new Map((STATE?.activity || []).map((a) => [a.day, a]));
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(t0); d.setDate(d.getDate() - i); out.push(by.get(dayKey(d)) || { day: dayKey(d), turns: 0, tokens: null, models: {} }); }
  return out;
}
function ovData() {
  const run = [], wait = [];
  const need = new Map(needModel().rows.map((r) => [r.t, r]));
  for (const z of Z) {
    for (const l of leaves(z.root)) if (l.tab && TAB_LIST.includes(l.tab)) {
      const st = leafState(l);
      const it = { id: l.id, z: z.id, agent: l.agent, name: currentTabTitle(l.tab) || ag(l.agent).name, proj: projName(l.proj), st, block: zoneTitle(z)[0] };
      const r = need.get(l.tab);
      if (st === "wait" || (r && r.unread)) wait.push(Object.assign({ t: r ? (r.text || needWhy(r.kind)) : "" }, it)); else run.push(it);
    }
  }
  for (const f of OV_WAITS) wait.push(...f());
  const days = ovDays(HEAT_DAYS);
  const today = days[days.length - 1];
  const week = days.slice(-7);
  return { run, wait, days, today, week, groups: OV_GROUPS.flatMap((f) => f()) };
}
// 其他模块报上来的（Bot Group：群里等你拍板的、开着的组）
const OV_WAITS = [], OV_GROUPS = [];
// 热力图分档按**活跃日的分位数**，不拿最大值等比 —— 否则一次爆量的那天会把其余日子全冲成最淡的一档
function levels(vals) {
  const act = vals.filter((v) => v > 0).sort((a, b) => a - b);
  if (!act.length) return () => 0;
  const q = (p) => act[Math.min(act.length - 1, Math.floor(p * act.length))];
  const c = [q(0.25), q(0.5), q(0.75)];
  return (v) => v <= 0 ? 0 : v <= c[0] ? 1 : v <= c[1] ? 2 : v <= c[2] ? 3 : 4;
}
function overviewHTML() {
  const d = ovData();
  const tok = d.today.tokens, toks = tokTotal(tok);
  const inp = tok ? (tok.in || 0) + (tok.cacheRead || 0) + (tok.cacheWrite || 0) : 0;
  const cache = inp ? Math.round(100 * (tok.cacheRead || 0) / inp) : null;
  const wk = d.week.reduce((s, a) => s + (a.turns || 0), 0);
  const loading = !STATE || !Array.isArray(STATE.activity);   // 会话库还在扫（冷启动要十几秒）
  const kpi = (t, v, s) => `<div class="ov-k"><span>${t}</span><b>${v}</b><em>${s}</em></div>`;
  const val = (a) => OV.metric === "turns" ? (a.turns || 0) : tokTotal(a.tokens);
  const vals = d.days.map(val);
  const lv = levels(vals);
  // 列 = 周、行 = 星期：第一列从「最早那天所在的那一周」的周日开始补空格
  const pad = new Date(d.days[0].day + "T00:00:00").getDay();
  const cells = "<i class=\"pad\"></i>".repeat(pad) + d.days.map((a, i) => `<i class="l${lv(vals[i])}" title="${a.day} · ${OV.metric === "turns" ? `${vals[i]} 轮` : `${fmtK(vals[i])} token`}"></i>`).join("");
  const sum = vals.reduce((a, b) => a + b, 0);
  const mix = Object.entries(d.today.models || {}).filter(([m, n]) => m && !m.startsWith("<") && n > 0).sort((a, b) => b[1] - a[1]);
  const mixSum = mix.reduce((s, [, n]) => s + n, 0);
  const mixRows = mix.slice(0, 5).map(([m, n]) => [m, n]);
  if (mix.length > 5) mixRows.push(["其他", mix.slice(5).reduce((s, [, n]) => s + n, 0)]);
  const row = (x) => `<button class="ov-r" data-ovgo="${x.id || "z"}" data-ovz="${x.z}">${logo(x.agent)}<div><b>${esc(x.name)}</b><span>${esc(x.t || `${ST_WORD[x.st] || "空闲"} · ${x.proj}`)}</span></div><span class="sp"></span><em class="ov-b">${esc(x.block)}</em><i class="dot ${x.st}"></i></button>`;
  const projIn = new Set(d.run.concat(d.wait).map((x) => x.proj)).size;
  return `<button class="s-x" data-ovx title="关掉（Esc）">${ICON("x", 16)}</button>`
    + `<div class="ov-h"><b>总览</b><span>${new Date().toLocaleDateString(PERCH_LOCALE === "en" ? "en-US" : "zh-CN", { month: "long", day: "numeric", weekday: "long" })}</span></div>`
    + `<div class="ov-kpis">${kpi("在干活", `${d.run.filter((x) => x.st === "work").length} 格`, `开着 ${d.run.length + d.wait.length} 格 · 在等你 ${d.wait.length}`)}`
    + kpi("今日轮次", d.today.turns || 0, `近 7 天 ${wk} · 7 天里活跃 ${d.week.filter((a) => (a.turns || 0) > 0).length} 天`)
    + kpi("今日 token", fmtK(toks), tok ? `输入 ${fmtK(inp)} · 输出 ${fmtK(tok.out || 0)}` : "今天还没有")
    + kpi("缓存命中", cache == null ? "—" : cache + "%", cache == null ? "今天还没有" : `缓存读 ${fmtK(tok.cacheRead || 0)}`)
    + kpi("项目", PROJECTS().length, `在跑的分布在 ${projIn} 个项目`) + `</div>`
    + `<div class="ov-mid"><div class="ov-card"><div class="ov-ch"><b>每日活动</b><div class="seg"><button data-ovm="turns" class="${OV.metric === "turns" ? "on" : ""}">轮次</button><button data-ovm="tok" class="${OV.metric === "tok" ? "on" : ""}">token</button></div></div>`
    + `<div class="ov-heat">${cells}</div><div class="ov-leg"><span>${loading ? "正在读会话库…" : OV.metric === "turns" ? `近半年 ${sum} 轮 · 含子代理` : `近半年 ${fmtK(sum)} token · 含子代理`}</span><span class="sp"></span>少<i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</div></div>`
    + `<div class="ov-card"><div class="ov-ch"><b>今日 token · 按模型</b></div>${mixRows.length ? mixRows.map(([m, n]) => `<div class="ov-mx"><div><b title="${esc(m)}">${esc(m)}</b><span>${fmtK(n)} token</span></div><div class="ov-bar"><i style="width:${Math.max(1, Math.round(100 * n / mixSum))}%"></i></div><em>${Math.max(1, Math.round(100 * n / mixSum))}%</em></div>`).join("") : `<div class="ov-none">${loading ? "正在读会话库…" : "今天还没有 token 记录。"}</div>`}</div></div>`
    + `<div class="ov-low"><div class="ov-card"><div class="ov-ch"><b>在等你</b><em>${d.wait.length}</em></div>${d.wait.length ? d.wait.map(row).join("") : `<div class="ov-none">现在没有在等你的。跑完一轮、挂着提问、要你拍板，都会出现在这里。</div>`}</div>`
    + `<div class="ov-card"><div class="ov-ch"><b>开着的</b><em>${d.run.length}</em></div>${d.run.length ? d.run.map(row).join("") : `<div class="ov-none">台面上还没有 agent。</div>`}</div>`
    + `<div class="ov-card"><div class="ov-ch"><b>Bot Group</b><em>${d.groups.length}</em></div>${d.groups.length ? d.groups.map((g) => g.html).join("") : `<div class="ov-none">还没有 Bot Group。</div>`}</div></div>`;
}
function renderOverview() {
  const el = qs("#ov");
  if (!qs(".ov-c", el)) el.innerHTML = `<div class="back"></div><div class="ov-c"></div>`;
  const html = overviewHTML();
  const c = qs(".ov-c", el);
  if (c._h === html) return;
  const st = c.scrollTop; c._h = html; c.innerHTML = html; c.scrollTop = st;
}
function openOverview() { closePops(); qs("#ov").innerHTML = ""; qs("#ov").hidden = false; renderOverview(); syncDock(); sendCtrl({ type: "lib.reload" }); }
function closeOverview() { qs("#ov").hidden = true; syncDock(); }
setInterval(() => { if (!qs("#ov").hidden) renderOverview(); }, 1300);
// 从总览点一项 = 跳到那一格（收着的块先展开）
function ovJump(leafId, zid) {
  closeOverview();
  const z = Z.find((x) => x.id === zid);
  if (!z) return;
  revealLeaf(z, leafId !== "z" ? leaves(z.root).find((l) => l.id === leafId) : null);
}

DOCK_ACTS.ov = { act() { if (qs("#ov").hidden) openOverview(); else closeOverview(); }, on: () => !qs("#ov").hidden };
CLICKS.push((t) => {
  if (!t.closest("#ov")) return false;
  const b = t.closest("[data-ovgo],[data-ovm],[data-ovx]");
  if (b && b.dataset.ovm) { OV.metric = b.dataset.ovm; renderOverview(); }
  else if (b && b.dataset.ovgo) ovJump(b.dataset.ovgo, b.dataset.ovz);
  else if ((b && b.hasAttribute("data-ovx")) || t.classList.contains("back")) closeOverview();
  return true;
});
ESCS.push(() => { if (!qs("#ov").hidden) { closeOverview(); return true; } return false; });
