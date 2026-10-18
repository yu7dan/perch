"use strict";
/* 99-boot.js —— 总览的事件绑定 + 首帧：整段脚本跑到底的证据在这里。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 10890-10963（2026-10-17 从 app.js 原样切出，逻辑未改）。 */


$("dash-refresh").addEventListener("click", () => {
  sendCtrl({ type: "lib.reload" });
  sendCtrl({ type: "magpie.refresh" });
  sendCtrl({ type: "log", msg: "总览 点刷新 → lib.reload + magpie.refresh" });
});

// 点「在等你」的一行 = 回到工作区 + 跳到那一格。
$("dash-need").addEventListener("click", (e) => {
  const row = e.target.closest(".need");
  if (!row) return;
  const t = liveTab(row.dataset.tab | 0);
  if (!t) return;
  setNavView("workspace");
  jumpToTab(t, "点总览「在等你」");
});

// 热力图悬停：日期 + 轮次 + 会话数（magpie 的 .heat-tip 同一套做法）。
$("dash-heat").addEventListener("mouseover", (e) => {
  const cell = e.target.closest("i[data-day]");
  if (!cell) return;
  const tip = $("dash-heat-tip");
  if (!tip) return;
  const v = +cell.dataset.v || 0;
  const extra = +cell.dataset.x || 0;
  const metric = cell.dataset.metric;
  tip.innerHTML = `<b>${cell.dataset.day}</b><span>` +
    (metric === "calls"
      ? (v ? `${dashNum(v)} 次请求${extra ? ` · ${dashNum(extra)} 失败` : ""}` : "没有请求")
      : (v ? `${dashNum(v)} 轮 · ${extra} 个会话` : "没有活动")) + `</span>`;
  tip.hidden = false;
  const card = cell.closest(".console-main").getBoundingClientRect();
  const r = cell.getBoundingClientRect();
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  const x = Math.max(6, Math.min(r.left - card.left + r.width / 2 - tw / 2,
    card.width - tw - 6));
  const y = Math.max(6, r.top - card.top - th - 6);
  tip.style.left = x + "px";
  tip.style.top = y + "px";
});
$("dash-heat").addEventListener("mouseleave", () => {
  const tip = $("dash-heat-tip");
  if (tip) tip.hidden = true;
});

// 启动时补一次首帧。放在**整段脚本的最后**：上面这些渲染函数用到
// esc/rel/currentTabTitle/svg，其中前两个是文件后段的 const（TDZ），
// 而这一刻它们都已经初始化完了。RSB_READY 是给"启动 await 期间跑进来的消息"
// 用的闸：那会儿渲染会把页面打白，所以先只收状态，到这里一次性画出来。
/* 启动即总览：不等 shell（会话库扫描要一会儿），先把左栏和总览的结构画出来。
   这一刻 STATE 还没到，读数按 0 画；shell 一到 renderShell 会再刷一遍
   （热力图/读数那时才有数据）。左栏也一起画，否则首屏左侧会空一阵。 */
renderNav();
if (NAV_HERE === "dash") renderDashboard("启动");
RSB_READY = true;
renderLive();
// 首帧之后留一条**读数**（不是"应该没问题"）：四个模块各自拿到了什么、
// 徽标几个。它同时也是一条"整段脚本跑到底了"的证据 ——
// 这行在文件最后一行，页面要是白屏，这条就不会出现。
{
  const M = needModel();
  const t = activeTab;
  const v = t ? LIVE.get(t.id) : null;
  bootFact(`右栏就绪 当前格=${t ? t.id : "?"} 需要你=${M.rows.length}(未读${M.wait.length}) ` +
           `改动=${((v && v.files) || []).length} 流水=${((v && v.acts) || []).length} ` +
           `模块=${rsbMod}${rsbOpen ? "" : "(收起)"} ` +
           `对话流=${rsbHistOpen ? Math.round(rsbHistH) + "px" : "折叠"}`);
}
// ⚠️ 「需要你」的**计数徽标是明确偏离 Orca** 的一处**（用户点名要的）** ——
// Orca 的活动条只有 7px 圆点、全库没有任何数字徽标。理由见 HTML 里那颗
// .badge 的注释：我们默认是 N 格同屏，"几件事在等你"这个读数比一个点更能
// 回答"我现在要不要切过去"。
