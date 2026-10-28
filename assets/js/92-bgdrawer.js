/* Bot Group · 角色配置抽屉（2026-10-28，取代每个 Bot 的「终端」入口）。
   照 DS-Bot 的详情抽屉（src/client/details-drawer.js + bot-settings.js）：
     · 抽屉占右栏那一列（盖住工作树，不压暗、不挡中间），从右边滑进来；左边缘可以拖宽；
     · 概览：顶上一排圆按钮（设置 / 终端 / 关闭）、居中的身份（大头像、可点改名、agent · 模型、状态）、
       运行读数，下面是 模型 / 权限 / 工作文件夹 / 分工说明 / 共享记忆 / 用量 / 当前任务；
     · 设置：从右边推进来的子页（返回从左边回来），分组卡片，改完失焦 / 回车就存，Esc 撤回；
       「从组里移除」要点两次。
   终端没有拿掉，只是从一级入口收进了抽屉顶上的那颗按钮。
   模型 / 强度 / 权限只有 Claude、Codex 有按格设的口子（Go：agent.BotLaunch），别的 agent 那几项做灰。
   要重启才生效的项（agent / 模型 / 强度 / 权限 / 文件夹）存完挂一条「下次启动生效」，空闲时可以立刻重启。 */

const BG_CFG_AGENTS = new Set(["claude", "codex"]);
const BG_CLAUDE_ALIASES = ["opus", "sonnet", "haiku"];
const BG_PERMS = [["read-only", "bg.d.perm.ro"], ["workspace-write", "bg.d.perm.ws"], ["full-access", "bg.d.perm.full"]];
const BGD_W_KEY = "perch.bg.drawerW";

const BGD = {
  open: false,
  gid: "", bid: "",
  view: "overview",      // "overview" | "settings"
  move: "",              // 这一次重画要不要带进场动画："" | "in" | "out" | "open"
  confirm: false,        // 「从组里移除」点过一次
  renaming: false,
  pickReq: 0,            // 文件夹选择器的请求号（借 project.pick）
};

function bgdGroup() { return BOTGROUPS.find((g) => g.id === BGD.gid) || null; }
function bgdBot() { return bgBot(bgdGroup(), BGD.bid); }
function bgdTabOf(g, b) {
  return bgTabOf(b) || TAB_LIST.find((x) => x.group === g.id && x.bot === b.id && !x.connDown) || null;
}

function bgOpenDrawer(gid, bid, view) {
  if (BGD.open && BGD.gid === gid && BGD.bid === bid && !view) { bgCloseDrawer(); return; }
  const was = BGD.open;
  Object.assign(BGD, { open: true, gid, bid, view: view || "overview", move: was ? "swap" : "open", confirm: false, renaming: false });
  if (typeof PROV !== "undefined" && !PROV.view && typeof provRequest === "function") provRequest();
  sendCtrl({ type: "log", msg: `Bot Group：打开角色配置 ${gid}/${bid}（${view || "概览"}）` });
  bgDrawerSync(true);
}
function bgCloseDrawer() {
  if (!BGD.open) return;
  BGD.open = false;
  bgdMenuClose();
  const el = $("bg-drawer");
  if (el) el.classList.remove("open");
  const root = $("bg");
  if (root) root.classList.remove("bgd-on");
  bgApplyCfgRow();
  // 右栏宽度弹回去之后，工作树按新宽度重画一遍。
  setTimeout(() => { const ts = $("bg-tscroll"); if (ts) ts.__html = ""; if (!BGD.open) renderBotGroup(); }, 450);
}

/* 打开 / 换了 Bot / 换了页才整块重画；平时（acts 一秒十几次）只在 HTML 真变了、而且
   用户没在抽屉里打字的时候才换。 */
function bgDrawerSync(force) {
  const root = $("bg");
  if (!root) return;
  let wrap = $("bg-dwrap");
  if (!wrap || wrap.parentElement !== root) {
    wrap = document.createElement("div");
    wrap.id = "bg-dwrap";
    wrap.className = "bg-dwrap";
    wrap.innerHTML = `<div class="bg-dgrip" id="bg-dgrip" title=""></div><aside class="bg-drawer" id="bg-drawer" role="complementary"></aside>`;
    root.appendChild(wrap);
    bgdBind(wrap);
  }
  const el = $("bg-drawer");
  const g = bgdGroup(), b = bgdBot();
  if (BGD.open && (!g || !b || BG.group !== g.id)) { bgCloseDrawer(); return; }
  // 抽屉开着时在左栏点了另一个成员：抽屉跟过去（DS-Bot 的抽屉跟着当前会话走）。
  if (BGD.open && BG.focus !== "all" && BG.focus !== BGD.bid && bgBot(g, BG.focus)) {
    Object.assign(BGD, { bid: BG.focus, view: "overview", move: "swap", confirm: false, renaming: false });
    force = true;
  }
  root.classList.toggle("bgd-on", BGD.open);
  root.style.setProperty("--bg-dw", bgdWidth() + "px");
  el.classList.toggle("open", BGD.open);
  bgApplyCfgRow();
  if (!BGD.open) return;
  const typing = el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (typing && !force) return;
  const html = BGD.view === "settings" ? bgdSettingsHTML(g, b) : bgdOverviewHTML(g, b);
  const key = BGD.view + "|" + html;
  if (!force && el.__k === key) return;
  el.__k = key;
  el.dataset.move = BGD.move || "";
  el.innerHTML = html;
  BGD.move = "";
  if (BGD.renaming) {
    const inp = $("bgd-name-in");
    if (inp) { inp.focus(); inp.select(); }
  }
}
function bgApplyCfgRow() {
  const root = $("bg");
  if (!root) return;
  root.querySelectorAll(".bg-row").forEach((r) => {
    r.classList.toggle("cfg-on", BGD.open && r.dataset.bgGroup === BGD.gid && r.dataset.bgFocus === BGD.bid);
  });
}

/* ---------- 读数 ---------- */
function bgdLaunchCfg(g, b) {
  return JSON.stringify([b.agent, b.model || "", b.effort || "", b.permission || "", b.folder || g.project]);
}
/* 这一格起来时用的是哪一份配置。Bot 页起的格子在起格时记；冷恢复回来的格子第一次被看见时
   按当时的配置记（那一刻它就是按这份起的 —— Go 每次起格都现查）。 */
function bgdNoteLaunch(tab, g, b) {
  if (tab && !tab.bgCfg) tab.bgCfg = bgdLaunchCfg(g, b);
}
function bgdPendingRestart(g, b) {
  const tab = bgdTabOf(g, b);
  if (!tab || tab.connDown) return false;
  bgdNoteLaunch(tab, g, b);
  return tab.bgCfg !== bgdLaunchCfg(g, b);
}
function bgdModelLabel(g, b) {
  if (b.model) return { name: b.model, sub: t("bg.d.model.own") };
  const cfg = typeof provAgentCfg === "function" ? provAgentCfg(b.agent) : {};
  const seen = bgDerive(g, b).model;
  if (cfg.model) return { name: cfg.model, sub: t("bg.d.model.follow") };
  if (seen) return { name: seen, sub: t("bg.d.model.followSeen") };
  return { name: t("bg.d.model.default"), sub: t("bg.d.model.follow") };
}
function bgdFolder(g, b) { return b.folder || g.project; }
function bgdStats(g, b) {
  const d = bgDerive(g, b);
  const turns = d.items.filter((x) => x.type === "prompt").length;
  const made = d.items.filter((x) => x.type === "proc" && (x.kind === "artifact" || x.kind === "commit")).length;
  const bits = [];
  if (turns) bits.push(t("bg.d.stat.turns", { n: turns }));
  if (d.cum) bits.push(t("bg.d.stat.tok", { n: (d.cum / 1000).toFixed(1) }));
  if (made) bits.push(t("bg.d.stat.made", { n: made }));
  return bits;
}

/* ---------- 图标 ---------- */
const BGD_I = {
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  tick: '<path d="M20 6 9 17l-5-5"/>',
};
function bgdIco(name, size) { return lucide(BGD_I[name] || BG_I[name], size || 14); }

/* ---------- 概览 ---------- */
function bgdTopHTML(g, b) {
  const st = bgBotState(b);
  const start = st === "pending" || st === "off";
  return `<div class="bgd-top">`
    + `<button type="button" class="bgd-round" data-bgd-act="settings" title="${esc(t("bg.d.settings"))}" aria-label="${esc(t("bg.d.settings"))}">${bgdIco("gear", 15)}</button>`
    + `<button type="button" class="bgd-round" data-bgd-act="term" title="${esc(t(start ? "bg.feed.startTitle" : "bg.feed.openTermTitle"))}" aria-label="${esc(t(start ? "bg.feed.startTitle" : "bg.feed.openTermTitle"))}">${bgdIco(start ? "play" : "term", 15)}</button>`
    + `<button type="button" class="bgd-round" data-bgd-act="close" title="${esc(t("bg.d.close"))}" aria-label="${esc(t("bg.d.close"))}">${bgdIco("x", 15)}</button>`
    + `</div>`;
}
function bgdAvatar(g, b, size) {
  return `<span class="bgd-ava" style="--lane:${bgColor(g, b.id)};--s:${size}px">${agentTabIcon(b.agent || "", Math.round(size * 0.5))}</span>`;
}
function bgdName(b) { return b.manager ? "Manager" : b.role; }
function bgdIdHTML(g, b) {
  const st = bgBotState(b);
  const task = bgTaskOf(g, b);
  const model = bgModelShort(b.model || bgDerive(g, b).model || (typeof provAgentCfg === "function" ? provAgentCfg(b.agent).model : "") || "");
  const name = BGD.renaming && !b.manager
    ? `<input class="bgd-name-in" id="bgd-name-in" maxlength="24" spellcheck="false" value="${esc(b.role)}" aria-label="${esc(t("bg.d.f.name"))}">`
    : b.manager
      ? `<span class="bgd-name static">${esc(bgdName(b))}</span>`
      : `<button type="button" class="bgd-name" data-bgd-act="rename" title="${esc(t("bg.d.rename"))}">${esc(bgdName(b))}</button>`;
  return `<div class="bgd-id">${bgdAvatar(g, b, 64)}${name}`
    + `<span class="bgd-role">${esc(bgAgentName(b.agent))}${model ? " · " + esc(model) : ""}</span>`
    + `<span class="bgd-st" data-state="${esc(st)}">${bgDot(st)}<span class="ell">${esc(t(BG_STATE_KEY[st]))}${task ? " · " + esc(task) : ""}</span></span>`
    + `</div>`;
}
function bgdRestartHTML(g, b) {
  if (!bgdPendingRestart(g, b)) return "";
  const st = bgBotState(b);
  const busy = st === "working" || st === "waiting";
  return `<div class="bgd-restart"><span>${esc(t("bg.d.pending"))}</span>`
    + `<button type="button" class="bgd-soft${busy ? " grey" : ""}" data-bgd-act="restart" title="${esc(t(busy ? "bg.d.restartBusy" : "bg.d.restartTitle"))}">${bgdIco("restart", 12)}<span>${esc(t("bg.d.restart"))}</span></button></div>`;
}
function bgdTrigger(act, name, sub, opts) {
  opts = opts || {};
  return `<button type="button" class="bgd-trigger${opts.wide ? " wide" : ""}${opts.grey ? " grey" : ""}" data-bgd-act="${esc(act)}"${opts.title ? ` title="${esc(opts.title)}"` : ""} aria-haspopup="menu">`
    + (opts.ico ? `<span class="bgd-tico">${opts.ico}</span>` : "")
    + `<span class="bgd-tcopy"><span class="bgd-tname ell">${esc(name)}</span>${sub ? `<span class="bgd-tsub ell">${esc(sub)}</span>` : ""}</span>`
    + `<span class="bgd-caret">${bgdIco("down", 14)}</span></button>`;
}
function bgdPermHTML(b) {
  const ok = BG_CFG_AGENTS.has(b.agent);
  const cur = b.permission || "";
  return `<div class="bgd-seg${ok ? "" : " grey"}" role="group" aria-label="${esc(t("bg.d.sec.perm"))}"${ok ? "" : ` title="${esc(t("bg.d.unsupported", { agent: bgAgentName(b.agent) }))}"`}>`
    + BG_PERMS.map(([v, k]) => `<button type="button" data-bgd-perm="${esc(v)}" aria-pressed="${ok && cur === v}"${v === "full-access" ? ` class="danger"` : ""}>${esc(t(k))}</button>`).join("")
    + `</div>`
    + `<div class="bgd-note">${esc(ok ? (cur ? t("bg.d.perm.note." + cur) : t("bg.d.perm.follow")) : t("bg.d.unsupported", { agent: bgAgentName(b.agent) }))}</div>`;
}
function bgdOverviewHTML(g, b) {
  const ml = bgdModelLabel(g, b);
  const ok = BG_CFG_AGENTS.has(b.agent);
  const folder = bgdFolder(g, b);
  const stats = bgdStats(g, b);
  const d = bgDerive(g, b);
  const sec = (title, body, cls) => `<section class="bgd-sec${cls ? " " + cls : ""}"><div class="bgd-st-t">${esc(title)}</div>${body}</section>`;
  const about = b.instructions
    ? sec(t("bg.d.sec.about"), `<div class="bgd-about">${esc(b.instructions)}</div>`)
    : `<button type="button" class="bgd-more" data-bgd-act="settings">${esc(t("bg.d.addAbout"))}</button>`;
  const todo = d.todo
    ? sec(t("bg.d.sec.task"), `<div class="bgd-kv"><span class="ell">${esc(d.todo.cur || bgTaskOf(g, b) || "—")}</span><span>${d.todo.done}/${d.todo.total}</span></div>`)
    : (bgTaskOf(g, b) ? sec(t("bg.d.sec.task"), `<div class="bgd-kv"><span class="ell">${esc(bgTaskOf(g, b))}</span><span></span></div>`) : "");
  return bgdTopHTML(g, b) + bgdIdHTML(g, b)
    + (stats.length ? `<div class="bgd-stats">${stats.map((s) => `<span>${esc(s)}</span>`).join(`<i>·</i>`)}</div>` : "")
    + `<div class="bgd-body">`
    +   bgdRestartHTML(g, b)
    +   sec(t("bg.d.sec.model"), bgdTrigger("model", ml.name, ok ? ml.sub : t("bg.d.unsupportedShort"), { wide: true, grey: !ok, title: ok ? "" : t("bg.d.unsupported", { agent: bgAgentName(b.agent) }) }))
    +   sec(t("bg.d.sec.perm"), bgdPermHTML(b))
    +   sec(t("bg.d.sec.folder"), bgdTrigger("folder", bgBase(folder), b.folder ? folder : t("bg.d.folder.followSub", { path: folder }), { wide: true, ico: bgdIco("folder", 14) }))
    +   about
    +   (g.brief ? sec(t("bg.d.sec.memory"), `<button type="button" class="bgd-mem" data-bgd-act="brief">${bgdIco("file", 14)}<span class="bgd-mem-copy ell">brief.md</span><span class="bgd-mem-go">${esc(t("bg.d.open"))}${bgdIco("right", 13)}</span></button>`) : "")
    +   (d.cum ? sec(t("bg.d.sec.usage"), `<div class="bgd-kv"><span>${esc(bgdName(b))}</span><span>${esc(t("bg.d.stat.tok", { n: (d.cum / 1000).toFixed(1) }))}</span></div>`) : "")
    +   todo
    + `</div>`;
}

/* ---------- 设置子页 ---------- */
function bgdRow(label, hint, control, opts) {
  opts = opts || {};
  return `<div class="bgd-row${opts.stack ? " stack" : ""}"><span class="bgd-copy"><span class="bgd-label">${esc(label)}</span>${hint ? `<span class="bgd-hint">${esc(hint)}</span>` : ""}</span>${control}</div>`;
}
function bgdCard(title, body) {
  return `<section class="bgd-card-s">${title ? `<h3>${esc(title)}</h3>` : ""}<div class="bgd-card">${body}</div></section>`;
}
function bgdInput(field, value, ph, opts) {
  opts = opts || {};
  return opts.multi
    ? `<textarea class="bgd-in area" data-bgd-field="${esc(field)}" spellcheck="false" placeholder="${esc(ph || "")}">${esc(value || "")}</textarea>`
    : `<input class="bgd-in" data-bgd-field="${esc(field)}" spellcheck="false" maxlength="${opts.max || 60}" placeholder="${esc(ph || "")}" value="${esc(value || "")}">`;
}
function bgdEffortHTML(b) {
  const ok = BG_CFG_AGENTS.has(b.agent);
  const efforts = (typeof PROV !== "undefined" && PROV.efforts && PROV.efforts.length) ? PROV.efforts : ["low", "medium", "high", "max"];
  const cur = b.effort || "";
  return `<div class="bgd-seg sm${ok ? "" : " grey"}" role="group"${ok ? "" : ` title="${esc(t("bg.d.unsupported", { agent: bgAgentName(b.agent) }))}"`}>`
    + `<button type="button" data-bgd-effort="" aria-pressed="${ok && !cur}">${esc(t("bg.d.effort.default"))}</button>`
    + efforts.map((e) => `<button type="button" data-bgd-effort="${esc(e)}" aria-pressed="${ok && cur === e}">${esc(e)}</button>`).join("")
    + `</div>`;
}
function bgdSettingsHTML(g, b) {
  const ml = bgdModelLabel(g, b);
  const ok = BG_CFG_AGENTS.has(b.agent);
  const folder = bgdFolder(g, b);
  const lockAgent = b.manager && g.source && g.source.kind === "derived";
  const manage = bgdCard(t("bg.d.card.manage"),
    `<button type="button" class="bgd-row btn" data-bgd-act="duplicate"><span class="bgd-copy"><span class="bgd-label">${esc(t("bg.d.dup"))}</span><span class="bgd-hint">${esc(t("bg.d.dupHint"))}</span></span><span class="bgd-chev">${bgdIco("right", 14)}</span></button>`
    + (b.manager ? "" : `<button type="button" class="bgd-row btn danger"${BGD.confirm ? " data-confirm" : ""} data-bgd-act="remove"><span class="bgd-copy"><span class="bgd-label">${esc(t(BGD.confirm ? "bg.d.removeQ" : "bg.d.remove", { name: b.role }))}</span><span class="bgd-hint">${esc(t(BGD.confirm ? "bg.d.removeAgain" : "bg.d.removeHint"))}</span></span><span class="bgd-chev">${bgdIco("right", 14)}</span></button>`));
  return `<div class="bgd-sub"><button type="button" class="bgd-icon" data-bgd-act="back" aria-label="${esc(t("bg.d.back"))}" title="${esc(t("bg.d.back"))}">${bgdIco("back", 16)}</button>`
    + `<span class="bgd-sub-t">${esc(t("bg.d.settingsTitle"))}</span>`
    + `<button type="button" class="bgd-icon" data-bgd-act="close" aria-label="${esc(t("bg.d.close"))}" title="${esc(t("bg.d.close"))}">${bgdIco("x", 15)}</button></div>`
    + `<div class="bgd-body set">`
    +   bgdRestartHTML(g, b)
    +   `<div class="bgd-hero">${bgdAvatar(g, b, 52)}<span class="bgd-who"><span class="bgd-hname ell">${esc(bgdName(b))}</span><span class="bgd-hsub ell">${esc(g.name)} · ${esc(b.manager ? t("bg.d.mgrSub") : (b.task || t("bg.d.botSub")))}</span></span></div>`
    +   bgdCard(t("bg.d.card.profile"),
          (b.manager ? bgdRow(t("bg.d.f.name"), t("bg.d.mgrFixed"), `<span class="bgd-val">Manager</span>`)
                     : bgdRow(t("bg.d.f.name"), "", bgdInput("role", b.role, t("bg.d.ph.name"), { max: 24 })))
          + bgdRow(t("bg.d.f.task"), t("bg.d.f.taskHint"), bgdInput("task", b.task, t("bg.d.ph.task"), { max: 40 })))
    +   bgdCard(t("bg.d.card.agent"),
          bgdRow(t("bg.d.f.agent"), lockAgent ? t("bg.d.agentLocked") : t("bg.d.f.agentHint"),
            bgdTrigger(lockAgent ? "agent-locked" : "agent", bgAgentName(b.agent), "", { ico: bgAgentIco(b.agent), grey: lockAgent })))
    +   bgdCard(t("bg.d.card.model"),
          bgdRow(t("bg.d.sec.model"), ok ? (b.model ? t("bg.d.model.nextStart") : t("bg.d.model.followHint")) : t("bg.d.unsupported", { agent: bgAgentName(b.agent) }),
            bgdTrigger("model", ml.name, "", { grey: !ok }))
          + bgdRow(t("bg.d.f.effort"), "", bgdEffortHTML(b), { stack: true })
          + bgdRow(t("bg.d.sec.perm"), "", bgdPermHTML(b), { stack: true }))
    +   bgdCard(t("bg.d.sec.folder"),
          bgdRow(t("bg.d.f.folder"), b.folder ? folder : t("bg.d.folder.followSub", { path: folder }), bgdTrigger("folder", bgBase(folder), "", { ico: bgdIco("folder", 13) })))
    +   bgdCard(t("bg.d.sec.about"),
          bgdRow(t("bg.d.f.about"), t("bg.d.f.aboutHint"), bgdInput("instructions", b.instructions, t("bg.d.ph.about"), { multi: true }), { stack: true }))
    +   manage
    + `</div>`;
}

/* ---------- 保存 ---------- */
async function bgdSave(g, b, patch, why) {
  const r = await bgRequest({ type: "botgroup.updatebot", id: g.id, botId: b.id, botPatch: patch });
  if (!r.ok) { showToast(t("bg.d.saveFailed"), r.err || "", "err"); bgDrawerSync(true); return false; }
  // 分工说明：下一条消息起带上（重新送一遍开场说明）。
  if ("instructions" in patch) { const tab = bgdTabOf(g, b); if (tab) tab.bgIntro = false; }
  sendCtrl({ type: "log", msg: `Bot Group：角色配置 ${g.id}/${b.id} ${Object.keys(patch).join(",")}（${why || ""}）` });
  return true;
}
function bgdCommitField(inp, revert) {
  const g = bgdGroup(), b = bgdBot();
  if (!g || !b || !inp) return;
  const f = inp.dataset.bgdField;
  const old = (f === "role" ? b.role : b[f]) || "";
  if (revert) { inp.value = old; return; }
  const v = inp.value.trim();
  if (v === old.trim()) return;
  if (f === "role" && !v) { inp.value = old; return; }
  bgdSave(g, b, { [f]: v }, "失焦保存");
}

/* 「现在重启它」：同一个座位（paneId）重新起，进程级的配置才换得上。
   cwd 没变就接着原来的会话（resume exact），变了只能新开一条会话（agent 的会话按目录存）。
   换了 agent：旧格子按「关掉运行」收掉（记录留在 Workspaces 的「已关闭」里），新起一格。 */
async function bgdRestart(g, b) {
  const st = bgBotState(b);
  if (st === "working" || st === "waiting") { showToast(t("bg.d.restartBusy"), "", "err"); return; }
  const tab = bgdTabOf(g, b);
  const cwd = bgdFolder(g, b);
  if (!tab) { bgStartBot(g, b, "配置抽屉"); return; }
  const sameAgent = tab.spec && tab.spec.agent === b.agent;
  const sameCwd = (tab.spec && (tab.spec.cwd || "")) === cwd;
  const sid = sameAgent && sameCwd ? (tab.sessionID || "") : "";
  const spec = {
    agent: b.agent, cwd,
    target: sid ? "legacy" : "directory",
    resume: sid ? { kind: "exact", id: sid } : { kind: "new", id: "" },
    paneId: sameAgent ? (tab.paneID || undefined) : undefined,
    group: g.id, bot: b.id,
  };
  sendCtrl({ type: "log", msg: `Bot Group：按新配置重启 ${g.id}/${b.id} agent=${b.agent} 同会话=${!!sid}` });
  closeTab(tab, sameAgent ? { reseat: true } : { close: true, why: "Bot 换了 agent" });
  const nt = await createTab(spec);
  if (!nt || !TAB_LIST.includes(nt)) { showToast(t("bg.toast.startFailed", { role: b.role }), t("bg.toast.startFailedNote"), "err"); return; }
  nt.bgCfg = bgdLaunchCfg(g, b);
  bgSchedule();
}

async function bgdRemove(g, b) {
  const tab = bgdTabOf(g, b);
  // 它的终端先按「关掉运行」收掉：记录留着（Workspaces 的「已关闭」里能接上），不会被放回网格里跑。
  if (tab) closeTab(tab, { close: true, why: "从 Bot Group 移除" });
  const r = await bgRequest({ type: "botgroup.removebot", id: g.id, botId: b.id });
  if (!r.ok) { showToast(t("bg.d.saveFailed"), r.err || "", "err"); return; }
  bgCloseDrawer();
  if (BG.focus === b.id) BG.focus = "all";
  showToast(t("bg.d.removed", { name: b.role }), t("bg.d.removedNote"), "info");
  bgSchedule();
}
async function bgdDuplicate(g, b) {
  if (b.manager) { showToast(t("bg.d.dupMgr"), "", "err"); return; }
  const r = await bgRequest({ type: "botgroup.addbot", id: g.id, botgroup: { name: g.name, project: g.project, bots: [{
    role: t("bg.d.dupName", { name: b.role }), agent: b.agent, task: b.task || "",
    instructions: b.instructions || "", model: b.model || "", effort: b.effort || "", permission: b.permission || "", folder: b.folder || "" }] } });
  if (!r.ok) { showToast(t("bg.d.saveFailed"), r.err || "", "err"); return; }
  if (r.bot) bgOpenDrawer(g.id, r.bot.id, "settings");
}

/* ---------- 浮层菜单（模型 / agent / 文件夹） ---------- */
function bgdMenuClose() { const p = $("bgd-pop"); if (p) p.hidden = true; }
function bgdMenu(kind, anchor) {
  const g = bgdGroup(), b = bgdBot();
  if (!g || !b) return;
  let pop = $("bgd-pop");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "bgd-pop";
    pop.setAttribute("role", "menu");
    document.body.appendChild(pop);
    pop.addEventListener("click", bgdMenuClick);
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "bgd-pop-in" && !e.isComposing) { e.preventDefault(); bgdMenuPick("model", e.target.value.trim()); }
    });
    document.addEventListener("mousedown", (e) => { if (!e.target.closest("#bgd-pop,.bgd-trigger")) bgdMenuClose(); });
  }
  const tick = (on) => `<span class="bgd-tick">${on ? bgdIco("tick", 13) : ""}</span>`;
  const item = (val, label, sub, on, ico) => `<button type="button" class="bgd-mi" data-bgd-pick="${esc(val)}">${tick(on)}${ico || ""}<span class="bgd-mi-copy"><span class="ell">${esc(label)}</span>${sub ? `<span class="bgd-mi-sub ell">${esc(sub)}</span>` : ""}</span></button>`;
  let html = "";
  if (kind === "model") {
    const cfg = typeof provAgentCfg === "function" ? provAgentCfg(b.agent) : {};
    const prov = cfg.provider && typeof provById === "function" ? provById(cfg.provider) : null;
    const seen = bgDerive(g, b).model;
    html += item("", t("bg.d.model.followItem"), cfg.model || seen || t("bg.d.model.default"), !b.model);
    const models = prov && prov.models && prov.models.length ? prov.models
      : (b.agent === "claude" ? BG_CLAUDE_ALIASES : []);
    if (models.length) {
      html += `<div class="bgd-mg">${esc(prov ? prov.name : t("bg.d.model.aliases"))}</div>`;
      html += models.slice(0, 40).map((m) => item(m, m, "", b.model === m)).join("");
    }
    if (b.model && !models.includes(b.model)) html += item(b.model, b.model, t("bg.d.model.custom"), true);
    html += `<div class="bgd-mg">${esc(t("bg.d.model.customHead"))}</div><input class="bgd-pop-in" id="bgd-pop-in" spellcheck="false" placeholder="${esc(t("bg.d.model.customPh"))}">`;
  } else if (kind === "agent") {
    html += bgLaunchable().map((a) => item(a.id, a.name || a.id, "", a.id === b.agent, `<span class="bgd-mi-ico">${bgAgentIco(a.id)}</span>`)).join("");
    html += `<div class="bgd-mnote">${esc(t("bg.d.agentNote"))}</div>`;
  } else if (kind === "folder") {
    html += item("", t("bg.d.folder.follow"), g.project, !b.folder, `<span class="bgd-mi-ico">${bgdIco("folder", 13)}</span>`);
    if (b.folder) html += item(b.folder, bgBase(b.folder), b.folder, true, `<span class="bgd-mi-ico">${bgdIco("folder", 13)}</span>`);
    html += `<button type="button" class="bgd-mi" data-bgd-pick="__pick">${tick(false)}<span class="bgd-mi-copy"><span>${esc(t("bg.d.folder.pick"))}</span></span></button>`;
  }
  pop.dataset.kind = kind;
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.max(220, Math.min(320, r.width));
  pop.style.width = w + "px";
  // 放不下就往左边长（右栏贴着窗口右边）。
  pop.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + "px";
  const below = r.bottom + 4, h = Math.min(pop.scrollHeight, 360);
  pop.style.top = Math.round(below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below) + "px";
  const first = pop.querySelector(".bgd-mi");
  if (first) first.focus({ preventScroll: true });
}
function bgdMenuClick(e) {
  const it = e.target.closest("[data-bgd-pick]");
  if (!it) return;
  bgdMenuPick($("bgd-pop").dataset.kind, it.dataset.bgdPick);
}
function bgdMenuPick(kind, val) {
  const g = bgdGroup(), b = bgdBot();
  bgdMenuClose();
  if (!g || !b) return;
  if (kind === "model") { if (val !== (b.model || "")) bgdSave(g, b, { model: val }, "选模型"); }
  else if (kind === "agent") { if (val && val !== b.agent) bgdSave(g, b, { agent: val }, "换 agent"); }
  else if (kind === "folder") {
    if (val === "__pick") {
      BGD.pickReq = ++PROJECT_REQ;
      sendCtrl({ type: "project.pick", req: BGD.pickReq, msg: t("bg.d.folder.pickTitle", { name: bgdName(b) }) });
      return;
    }
    if (val !== (b.folder || "")) bgdSave(g, b, { folder: val }, "选文件夹");
  }
}
/* project.picked 先问这里：是抽屉借用的选择器就自己吃掉。 */
function bgFolderPicked(m) {
  if (!BGD.pickReq || m.req !== BGD.pickReq) return false;
  BGD.pickReq = 0;
  const g = bgdGroup(), b = bgdBot();
  if (m.canceled || !m.path || !g || !b) return true;
  if (m.err) { showToast(t("bg.d.saveFailed"), String(m.err.msg || m.err), "err"); return true; }
  bgdSave(g, b, { folder: m.path }, "选文件夹");
  return true;
}

/* ---------- 宽度 ---------- */
function bgdWidth() {
  let w = 352;
  try { w = parseInt(localStorage.getItem(BGD_W_KEY), 10) || 352; } catch (_) {}
  return Math.max(320, Math.min(520, w));
}

/* ---------- 事件 ---------- */
function bgdBind(wrap) {
  const el = wrap.querySelector("#bg-drawer");
  el.addEventListener("click", (e) => {
    const g = bgdGroup(), b = bgdBot();
    if (!g || !b) return;
    const perm = e.target.closest("[data-bgd-perm]");
    if (perm) {
      if (!BG_CFG_AGENTS.has(b.agent)) return;
      const v = perm.dataset.bgdPerm;
      bgdSave(g, b, { permission: v === (b.permission || "") ? "" : v }, "权限");
      return;
    }
    const eff = e.target.closest("[data-bgd-effort]");
    if (eff) {
      if (!BG_CFG_AGENTS.has(b.agent)) return;
      if (eff.dataset.bgdEffort !== (b.effort || "")) bgdSave(g, b, { effort: eff.dataset.bgdEffort }, "强度");
      return;
    }
    const a = e.target.closest("[data-bgd-act]");
    if (!a) return;
    const act = a.dataset.bgdAct;
    if (act === "close") bgCloseDrawer();
    else if (act === "settings") { BGD.view = "settings"; BGD.move = "in"; BGD.confirm = false; bgDrawerSync(true); }
    else if (act === "back") { BGD.view = "overview"; BGD.move = "out"; BGD.confirm = false; bgDrawerSync(true); }
    else if (act === "term") bgStartBot(g, b, "配置抽屉").then((tab) => { if (tab) botOpenTerminal(tab); });
    else if (act === "rename") { BGD.renaming = true; bgDrawerSync(true); }
    else if (act === "restart") bgdRestart(g, b);
    else if (act === "brief") { if (g.brief) sendCtrl({ type: "open", mode: "open", path: g.brief }); }
    else if (act === "model") {
      if (!BG_CFG_AGENTS.has(b.agent)) { showToast(t("bg.d.unsupported", { agent: bgAgentName(b.agent) }), "", "info"); return; }
      bgdMenu("model", a);
    }
    else if (act === "agent") bgdMenu("agent", a);
    else if (act === "folder") bgdMenu("folder", a);
    else if (act === "duplicate") bgdDuplicate(g, b);
    else if (act === "remove") {
      if (BGD.confirm) { BGD.confirm = false; bgdRemove(g, b); return; }
      BGD.confirm = true;
      bgDrawerSync(true);
      clearTimeout(BGD.confirmT);
      BGD.confirmT = setTimeout(() => { if (BGD.confirm) { BGD.confirm = false; bgDrawerSync(true); } }, 4000);
    }
  });
  // 设置项：失焦 / 回车就存，Esc 撤回（DS-Bot 的 InlineText）。
  el.addEventListener("focusout", (e) => {
    const inp = e.target;
    if (inp.id === "bgd-name-in") {
      const g = bgdGroup(), b = bgdBot();
      BGD.renaming = false;
      if (!inp.dataset.revert && g && b && inp.value.trim() && inp.value.trim() !== b.role) bgdSave(g, b, { role: inp.value.trim() }, "改名");
      setTimeout(() => bgDrawerSync(true), 0);
      return;
    }
    if (inp.dataset && inp.dataset.bgdField) {
      bgdCommitField(inp, !!inp.dataset.revert);
      delete inp.dataset.revert;
    }
  });
  el.addEventListener("keydown", (e) => {
    const inp = e.target;
    if (!(inp.id === "bgd-name-in" || (inp.dataset && inp.dataset.bgdField))) return;
    if (e.key === "Escape") { e.stopPropagation(); inp.dataset.revert = "1"; inp.blur(); }
    else if (e.key === "Enter" && inp.tagName === "INPUT" && !e.isComposing) { e.preventDefault(); inp.blur(); }
  });
  // 左边缘拖宽（320–520），松手记住。
  const grip = wrap.querySelector("#bg-dgrip");
  grip.addEventListener("pointerdown", (e) => {
    if (!BGD.open) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const root = $("bg");
    const x0 = e.clientX, w0 = bgdWidth();
    root.classList.add("bgd-drag");
    const mv = (ev) => {
      const w = Math.max(320, Math.min(520, w0 + (x0 - ev.clientX)));
      root.style.setProperty("--bg-dw", w + "px");
      grip.__w = w;
    };
    const up = () => {
      grip.removeEventListener("pointermove", mv);
      grip.removeEventListener("pointerup", up);
      root.classList.remove("bgd-drag");
      if (grip.__w) { try { localStorage.setItem(BGD_W_KEY, String(grip.__w)); } catch (_) {} }
      const ts = $("bg-tscroll"); if (ts) ts.__html = "";
    };
    grip.addEventListener("pointermove", mv);
    grip.addEventListener("pointerup", up);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !BGD.open || !document.body.classList.contains("botgroup")) return;
  const p = $("bgd-pop");
  if (p && !p.hidden) { bgdMenuClose(); e.stopPropagation(); return; }
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#bg-drawer input,#bg-drawer textarea")) return;
  if (BGD.view === "settings") { BGD.view = "overview"; BGD.move = "out"; bgDrawerSync(true); }
  else bgCloseDrawer();
});
