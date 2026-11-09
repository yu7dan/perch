"use strict";
/* 33-desk-settings.js —— 设置大面板（Dock「设置」）：通用 / 台面 / 项目 / 模型 / Agents / 关于。
   照定稿模拟（spec/desk 的设置那一段）。两份事实分开：
     · Perch 的设置（默认 Agent、默认工作区、全局快捷键、开机启动、恢复台面、铺在哪块屏）在 Go 的 settings.json，
       改了发 settings.set，Go 落实（快捷键注册、Run 注册表、挪屏）后推回整份；
     · 台面自己的外观和摆法（背景、玻璃、颜色、Dock、重叠、间距、时钟、关块前确认）在 localStorage（30-desk-core 的 CFG）。
   改了马上生效、会记住。 */

const SET = { sec: "general", rec: false, flash: null };
let DESK_SCREENS = [], DESK_VERSION = "";
const SECS = [["general", "通用", "sliders-horizontal"], ["desk", "台面", "monitor"], ["proj", "项目", "folder"], ["models", "模型", "cpu"], ["agents", "Agents", "bot"], ["about", "关于", "info"]];
// Go 那份设置的开关 / 台面那份的开关，长得一样
const tgGo = (key) => `<button class="tg${SETTINGS[key] ? " on" : ""}" data-sgo="${key}"></button>`;
const tg = (key) => `<button class="tg${CFG[key] ? " on" : ""}" data-cfg="${key}"></button>`;
const seg = (key, opts) => `<div class="seg">${opts.map(([v, t]) => `<button data-cfgseg="${key}" data-v="${v}" class="${CFG[key] === v ? "on" : ""}">${t}</button>`).join("")}</div>`;
const row = (b, s, ctl) => `<div class="srow"><div class="sl"><b>${b}</b>${s ? `<span>${s}</span>` : ""}</div>${ctl}</div>`;
function goSet(patch) { Object.assign(SETTINGS, patch); sendCtrl({ type: "settings.set", settings: patch }); }
function secHTML() {
  switch (SET.sec) {
    case "general": {
      const ags = agentList().filter((a) => a.installed);
      const def = SETTINGS.defaultAgent || "";
      return `<h2>通用</h2><p class="sub">Perch 自己怎么启动、怎么呼出。</p>`
        + row("开机自动启动", "登录 Windows 后直接铺满台面", tgGo("autoStart"))
        + row("启动时恢复上次的台面", "块的位置、大小、里面的 agent 都按上次摆好；关掉的 agent 按原记录接回", tgGo("restoreDesk"))
        + row("呼出 / 收起 Perch", "全局快捷键：在别的软件里按一下就回到台面；台面在眼前时按一下收起", `<button class="kbd${SET.rec ? " rec" : ""}" data-hotkey>${SET.rec ? "按下新的组合键…" : esc(SETTINGS.hotkey || "（没设）")}</button>`)
        + row("关掉一块前先问一句", "块里有在跑的 agent 时才问", tg("confirmClose"))
        + row("退出 Perch 前先问一句", "Alt+F4 / 关窗时提醒：在跑的 agent 会停下来", tgGo("confirmClose"))
        + row("默认 Agent", "项目面板里「在这开一个 Agent」直接用它；空格子里它排在显眼位置",
          defAgentSeg(ags, def))
        + row("界面语言", "", `<div class="seg">${[["auto", "跟随系统"], ["zh", "中文"], ["en", "English"]].map(([v, t]) => `<button data-slang="${v}" class="${(SETTINGS.language || "auto") === v ? "on" : ""}">${t}</button>`).join("")}</div>`);
    }
    case "desk": {
      const sc = DESK_SCREENS.length > 1
        ? row("铺在哪块显示器上", "Perch 只铺满一块屏；默认是主显示器", `<div class="seg wrap">${DESK_SCREENS.map((s, i) => `<button data-sscreen="${esc(s.primary ? "" : s.id)}" class="${(SETTINGS.screen || "") === (s.primary ? "" : s.id) ? "on" : ""}">${esc(s.primary ? "主显示器" : "显示器 " + (i + 1))} · ${s.w}×${s.h}</button>`).join("")}</div>`)
        : "";
      return `<h2>台面</h2><p class="sub">背景、玻璃、颜色和 Dock。改了马上生效。</p>`
        + row("背景", "透出桌面：台面是透明的，浮在桌面上，块以外看到的就是你的桌面；也可以换成渐变或纯色", seg("bg", [["wall", "透出桌面"], ["grad", "渐变"], ["solid", "纯色"]]))
        + row("玻璃浓度", "越高越不透，越低桌面透得越多", `<input type="range" min="0.3" max="0.9" step="0.02" value="${CFG.glass}" data-cfgr="glass">`)
        + row("模糊", "玻璃后面的桌面糊到什么程度", `<input type="range" min="0" max="48" step="1" value="${CFG.blur}" data-cfgr="blur">`)
        + row("强调色", "", `<div class="sw">${ACCENTS.map((c) => `<button data-acc="${c}" class="${CFG.acc === c ? "on" : ""}" style="background:${c};color:${c}"></button>`).join("")}</div>`)
        + row("Dock 的位置", "也可以直接按住 Dock 拖到任何地方；贴左右边时会竖过来", `<div class="seg">${[["bottom", "下"], ["top", "上"], ["left", "左"], ["right", "右"]].map(([v, t]) => `<button data-dockpos="${v}" class="${DK.mode === "edge" && DK.edge === v ? "on" : ""}">${t}</button>`).join("")}${DK.mode === "free" ? `<button class="on">自由</button>` : ""}</div>`)
        + row("允许块叠在一起", "关着时块和块互不重叠，挤到别人会有红框提醒；打开后可以叠着放，点哪块哪块到最前面。Dock 上也有这个开关", tg("overlap"))
        + row("块之间的间距", "", seg("gap", [["tight", "紧凑"], ["comfy", "舒适"]]))
        + row("右上角显示时间", "全屏会盖住任务栏的时钟", tg("clock"))
        + sc;
    }
    case "proj": {
      const ps = PROJECTS();
      return `<h2>项目</h2><p class="sub">项目就是盘上的文件夹。这里和 Dock 里「项目与文件」是同一份。</p>`
        + row("默认工作区", "新建文件夹时默认从这里开始挑位置；不挑项目开的 agent 也在这里干活", `<span class="kbd">${esc(defaultAreaPath() || "（还没读到）")}</span><button class="btn" data-pp="workdir">更改…</button>`)
        + `<div class="pp-sec" style="padding-left:0">项目（${ps.length}）</div>` + ps.map((p) => projRowHTML(p, false)).join("")
        + `<div class="pp-sec" style="padding-left:0;margin-top:10px">添加文件夹</div>` + ppAddHTML(true);
    }
    case "models": return typeof modelsSecHTML === "function" ? modelsSecHTML()
      : `<h2>模型</h2><p class="sub">加一次提供商（官方、中转站、本地都行），每个 agent 都能选。key 只存在本机。</p><div class="pp-note" style="padding-left:0">这一页还在接入中。</div>`;
    case "agents": return typeof agentsSecHTML === "function" ? agentsSecHTML()
      : `<h2>Agents</h2><p class="sub">新开一格时默认用哪个模型、推理多强。</p><div class="pp-note" style="padding-left:0">这一页还在接入中。</div>`;
    case "about": return `<h2>关于</h2><p class="sub">Perch ${esc(DESK_VERSION || "")} · agent 开发环境</p>`
      + row("退出 Perch", "在跑的 agent 会停下来；台面的摆法和每一格的记录都留着，下次打开按原样接回", `<button class="btn" data-squit>退出</button>`);
  }
  return "";
}
// 默认 Agent：自动 + 前四个装好的平铺（模拟里就是四个）；装得多的收进「其他…」，选中的那个总在外面
function defAgentSeg(ags, def) {
  let shown = ags.slice(0, 4);
  if (def && !shown.some((a) => a.id === def)) { const d = ags.find((a) => a.id === def); if (d) shown = shown.slice(0, 3).concat([d]); }
  const more = ags.filter((a) => !shown.includes(a));
  return `<div class="seg"><button data-sdef="" class="${def ? "" : "on"}">自动</button>${shown.map((a) => `<button data-sdef="${a.id}" class="${def === a.id ? "on" : ""}">${logo(a.id)}${esc(agShort(a))}</button>`).join("")}`
    + (more.length ? `<button data-sdefmore>其他…</button>` : "") + `</div>`;
}
function openDefAgentMore(anchor) {
  const mp = qs("#mp");
  const ags = agentList().filter((a) => a.installed);
  mp.innerHTML = `<div class="grp-h">默认 Agent</div>` + ags.map((a) => `<button class="mi${SETTINGS.defaultAgent === a.id ? " on" : ""}" data-sdef="${a.id}">${logo(a.id)} ${esc(a.name)}</button>`).join("");
  mp.hidden = false;
  const r = anchor.getBoundingClientRect(), w = mp.offsetWidth, h = mp.offsetHeight;
  mp.style.left = clampN(r.right - w, 12, innerWidth - w - 12) + "px";
  mp.style.top = (r.bottom + 6 + h < innerHeight - 12 ? r.bottom + 6 : Math.max(12, r.top - h - 6)) + "px";
}
function renderSettings() {
  const el = qs("#set");
  const old = qs(".s-body", el);
  const scroll = old ? old.scrollTop : 0;
  el.innerHTML = `<div class="back"></div><div class="sheet"><button class="s-x" data-sx title="关掉（Esc）">${ICON("x", 16)}</button>`
    + `<nav class="s-nav"><h3>设置</h3>${SECS.map(([k, t, ic]) => `<button data-snav="${k}" class="${SET.sec === k ? "on" : ""}">${ICON(ic, 16)}${t}</button>`).join("")}</nav>`
    + `<div class="s-body">${secHTML()}</div></div>`;
  qs(".s-body", el).scrollTop = scroll;
}
function openSettings(sec) { if (sec) SET.sec = sec; qs("#set").hidden = false; sendCtrl({ type: "settings.get" }); renderSettings(); syncDock(); }
function closeSettings() { qs("#set").hidden = true; SET.rec = false; qs("#mp").hidden = true; syncDock(); }
function cfgChanged() { applyCfg(); save(); render(); }
function onCfgChanged() { if (!qs("#set").hidden) renderSettings(); }
function onProjectsChanged() { if (!qs("#set").hidden && SET.sec === "proj") renderSettings(); }
function setClick(t) {
  if (t.classList.contains("back") || t.closest("[data-sx]")) { closeSettings(); return; }
  const b = t.closest("[data-snav],[data-cfg],[data-cfgseg],[data-acc],[data-dockpos],[data-sdef],[data-hotkey],[data-sgo],[data-sscreen],[data-squit],[data-pp],[data-slang]");
  if (!b) return;
  const d = b.dataset;
  if (d.slang) { goSet({ language: d.slang }); setLocale(d.slang); saveSettingsCache(); renderSettings(); return; }
  if (d.snav) { SET.sec = d.snav; SET.rec = false; qs("#mp").hidden = true; renderSettings(); return; }
  if (d.pp) { ppAct(d.pp, b); return; }
  if (d.cfg) { CFG[d.cfg] = !CFG[d.cfg]; cfgChanged(); renderSettings(); return; }
  if (d.cfgseg) { CFG[d.cfgseg] = d.v; cfgChanged(); renderSettings(); return; }
  if (d.acc) { CFG.acc = d.acc; cfgChanged(); renderSettings(); return; }
  if (d.sgo) { goSet({ [d.sgo]: !SETTINGS[d.sgo] }); renderSettings(); return; }
  if (d.sdef !== undefined) { goSet({ defaultAgent: d.sdef }); for (const { l } of allLeaves()) if (!l.tab) l.v++; render(); renderSettings(); return; }
  if (d.sscreen !== undefined) { goSet({ screen: d.sscreen }); renderSettings(); return; }
  if (d.dockpos) { DK = { mode: "edge", edge: d.dockpos, t: 0.5 }; save(); layoutDock(); fitZones(); renderSettings(); return; }
  if (b.hasAttribute("data-hotkey")) { SET.rec = true; renderSettings(); return; }
  if (b.hasAttribute("data-squit")) { closeSettings(); sendCtrl({ type: "window.close" }); return; }
}
// 录快捷键：按物理键位认（中文/非美式布局下 e.key 会变），必须带 Ctrl 或 Alt；Esc 不改
function recordHotkey(e) {
  e.preventDefault(); e.stopPropagation();
  if (e.key === "Escape") { SET.rec = false; renderSettings(); return; }
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
  const key = e.code === "Space" ? "Space" : shortcutKeyFromEvent(e);
  if (!key) { toast("主键只认字母、数字、F1–F12 或空格", "warn"); return; }
  if (!e.ctrlKey && !e.altKey) { toast("要带上 Ctrl 或 Alt 里的至少一个", "warn"); return; }
  const chord = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean).concat(key).join("+");
  SET.rec = false;
  goSet({ hotkey: chord });
  renderSettings();
}
// Go 推来的整份设置里顺带的东西：显示器清单、版本号。错误交给 20-ctl 弹提示（返回 false）。
function settingsMessageArrived(m) {
  if (Array.isArray(m.screens)) DESK_SCREENS = m.screens;
  if (m.version) DESK_VERSION = m.version;
  if (!qs("#set").hidden) setTimeout(renderSettings, 0);
  return false;
}

/* ---------- 接进台面 ---------- */
DOCK_ACTS.set = { act() { if (qs("#set").hidden) openSettings(); else closeSettings(); }, on: () => !qs("#set").hidden };
CLICKS.push((t) => {
  const sd = t.closest("#mp [data-sdef]");
  if (sd) { qs("#mp").hidden = true; goSet({ defaultAgent: sd.dataset.sdef }); for (const { l } of allLeaves()) if (!l.tab) l.v++; render(); renderSettings(); return true; }
  if (t.closest("#set")) { if (t.closest("[data-sdefmore]")) { openDefAgentMore(t.closest("[data-sdefmore]")); return true; } if (!t.closest("#mp")) setClick(t); return true; }
  return false;
});
ESCS.push(() => { if (!qs("#mp").hidden) { qs("#mp").hidden = true; return true; } if (!qs("#set").hidden) { closeSettings(); return true; } return false; });
document.addEventListener("keydown", (e) => { if (SET.rec && !qs("#set").hidden) recordHotkey(e); }, true);
document.addEventListener("input", (e) => {
  const r = e.target.closest && e.target.closest("[data-cfgr]");
  if (r) { CFG[r.dataset.cfgr] = +r.value; applyCfg(); save(); }
});
// 全局快捷键在台面就在眼前时按下：收起（按钮摆哪由这边定，所以 Go 交给页面）
if (W_EV) W_EV.On("perch:hotkey-stow", () => stow());
