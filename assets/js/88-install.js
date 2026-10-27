"use strict";
/* 88-install.js —— 行内安装控制台：agent 官方安装命令的流式日志与收尾。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 10743-10840（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

/* ---------------------------------------------------------------------------
   安装进度台
   点「安装」→ Go 跑写死的官方 CLI 命令 → 输出逐行推回来。
   进度台固定在总览底部，不随 Agent 名单滚动：阶段、已用时间、进度条、
   最后一行日志都在这里；完整日志可展开。
   装完 Go 先推新名单、再推 done，所以行会在同一个事件里从「未检测到」
   翻成「已接入」，不用等下一次 2.5 秒轮询。
   --------------------------------------------------------------------------- */
let INSTALL_LOG_OPEN = false;
let INSTALL_TICK = 0;

function instAll() { return Object.keys(INSTALLS).map((k) => INSTALLS[k]); }
function instCur() { return INSTALL_AT ? (INSTALLS[INSTALL_AT] || null) : null; }
function instRunning() { return instAll().some((x) => x.state === "running"); }

function instEnsure(id) {
  if (INSTALLS[id]) return INSTALLS[id];
  const a = CATALOG.find((x) => x.id === id);
  const it = {
    id, name: (a && a.name) || id, state: "running", phase: "preparing",
    source: "", startedAt: Date.now(), lines: [], ahead: 0, active: "",
    detected: undefined, err: null, elapsedMs: 0,
  };
  INSTALLS[id] = it;
  if (!INSTALL_AT) INSTALL_AT = id;
  return it;
}

function instElapsed(it) {
  if (!it) return "";
  const ms = it.elapsedMs || (Date.now() - (it.startedAt || Date.now()));
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" +
         String(s % 60).padStart(2, "0");
}

function instPhaseText(it) {
  if (!it) return "";
  if (it.state === "failed") {
    return it.err ? t("inst.failedWith", { err: msgText(it.err) }) : t("inst.failed");
  }
  if (it.state === "done") {
    if (it.detected === true) return t("inst.doneDetected");
    if (it.detected === false) return t("inst.doneNotDetected");
    return t("inst.doneRescanned");
  }
  if (it.phase === "queued") {
    return (it.ahead | 0) > 0
      ? t("inst.phase.queuedAhead", { n: it.ahead | 0 })
      : t("inst.phase.queued");
  }
  if (it.phase === "scanning") return t("inst.phase.scanning");
  if (it.phase === "cancelling") return t("inst.phase.cancelling");
  if (it.phase === "preparing") return t("inst.phase.preparing");
  return t("inst.phase.installing");
}

function startInstTicker() {
  if (INSTALL_TICK) return;
  INSTALL_TICK = setInterval(() => {
    if (!instRunning()) { stopInstTicker(); return; }
    instPaint();
  }, 1000);
}

function stopInstTicker() {
  if (INSTALL_TICK) { clearInterval(INSTALL_TICK); INSTALL_TICK = 0; }
}

/* 只画进度台，不动名单；名单由 instOpen/instDone 显式重画。
   顶部任务条只在有两个以上任务时出现：一个任务时它就是原来的面板。 */
function instPaint() {
  const tasks = instAll();
  const box = $("dash-install");
  if (!box) return;
  if (!tasks.length) { box.hidden = true; return; }
  if (!INSTALL_AT || !INSTALLS[INSTALL_AT]) {
    INSTALL_AT = (tasks.find((x) => x.state === "running") || tasks[0]).id;
  }
  const it = INSTALLS[INSTALL_AT];
  box.hidden = false;

  const strip = $("inst-tasks");
  if (strip) {
    strip.hidden = tasks.length < 2;
    if (tasks.length >= 2) {
      strip.innerHTML = tasks.map((x) => {
        const dot = x.state === "done" ? "on" : x.state === "failed" ? "bad" : "running";
        return `<button type="button" role="tab" class="inst-task${x.id === INSTALL_AT ? " on" : ""}"` +
          ` aria-selected="${x.id === INSTALL_AT}" data-inst="${esc(x.id)}" title="${esc(x.name)}">` +
          `<span class="dot ${dot}"></span><span class="nm">${esc(x.name)}</span>` +
          (x.state === "running" ? "" :
            `<span class="x" data-instdrop="${esc(x.id)}" title="${esc(t("inst.dismiss"))}">×</span>`) +
          `</button>`;
      }).join("");
    }
  }

  $("inst-title").textContent = t("inst.title", { name: it.name });
  $("inst-source").textContent = it.source || "CLI";
  $("inst-state").textContent = instPhaseText(it);
  $("inst-time").textContent = instElapsed(it);
  $("inst-dot").className = "dot" +
    (it.state === "done" ? " on" : it.state === "failed" ? " bad" : " running");
  const bar = $("inst-bar");
  if (bar) {
    bar.className = "inst-bar" +
      (it.state === "failed" ? " bad" : it.state === "done" ? " ok" : " running");
  }
  const last = $("inst-last");
  if (last) {
    let line = it.phase === "queued"
      ? t("inst.queuedWait")
      : (it.lines.length ? it.lines[it.lines.length - 1] : t("inst.waitingOutput"));
    // Some installers download hundreds of MB and print one line and then
    // nothing for minutes (Codex measured 7m49s). Keep the elapsed time on
    // that line so it reads as "still working", not "stuck".
    const ms = it.elapsedMs || (it.startedAt ? Date.now() - it.startedAt : 0);
    if (it.state === "running" && it.phase !== "queued" && ms >= 60000) {
      line += " · " + t("inst.stillRunning", { min: Math.max(1, Math.floor(ms / 60000)) });
    }
    last.textContent = line;
  }
  const log = $("inst-log");
  if (log) log.hidden = !INSTALL_LOG_OPEN;
  const lt = $("inst-log-toggle");
  if (lt) lt.textContent = INSTALL_LOG_OPEN ? t("inst.logHide") : t("inst.logShow");
  $("inst-cancel").hidden = it.state !== "running";
  $("inst-close").hidden = it.state === "running";
}

function instLine(id, line) {
  const it = INSTALLS[id];
  if (!it) return;
  it.lines.push(line);
  if (it.lines.length > 1500) it.lines.splice(0, it.lines.length - 1500);
  if (id !== INSTALL_AT) return;
  const log = $("inst-log");
  if (log) {
    const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.textContent = it.lines.join("\n");
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  if (it.phase === "preparing") {
    it.phase = "running";
    instPaint();
  }
  const last = $("inst-last");
  if (last) last.textContent = line;
}

function instOpen(a) {
  INSTALLS[a.id] = {
    id: a.id, name: a.name, state: "running", phase: "preparing",
    source: "", startedAt: Date.now(), lines: [], ahead: 0, active: "",
    detected: undefined, err: null, elapsedMs: 0,
  };
  INSTALL_AT = a.id;
  INSTALL_LOG_OPEN = false;
  $("inst-log").textContent = "";
  $("inst-log").hidden = true;
  instPaint();
  startInstTicker();
  renderDashAgents();
}

function instDone(m) {
  const it = INSTALLS[m.id];
  if (!it) return;
  // done 里带的新名单先应用：行和进度台在同一个事件里翻过来。
  if (m.catalog) {
    setCatalog(m.catalog, "安装完成");
  }
  it.state = m.ok ? "done" : "failed";
  it.phase = it.state;
  it.detected = m.detected;
  it.err = m.ok ? null : errMsgOf(m);
  it.elapsedMs = m.elapsedMs || (Date.now() - it.startedAt);
  it.ahead = 0;
  if (!m.ok && m.id === INSTALL_AT) INSTALL_LOG_OPEN = true;
  if (!instRunning()) stopInstTicker();
  instPaint();
  renderDashAgents();
  if (m.ok && m.id === "pi" && typeof showToast === "function") {
    showToast(t("inst.piFirstRunTitle"), t("inst.piFirstRunNote"), "info");
  }
  if (!m.ok && m.id === INSTALL_AT) {
    const log = $("inst-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
}

/* 收起一个已完成的任务（×）；运行中的任务只能取消，不能收起。 */
function instDrop(id) {
  const it = INSTALLS[id];
  if (!it || it.state === "running") return;
  delete INSTALLS[id];
  if (INSTALL_AT === id) {
    const rest = instAll();
    const next = rest.find((x) => x.state === "running") || rest[0];
    INSTALL_AT = next ? next.id : "";
  }
  INSTALL_LOG_OPEN = false;
  if (!instAll().length) {
    stopInstTicker();
    const box = $("dash-install");
    if (box) box.hidden = true;
    INSTALL_AT = "";
  } else {
    instPaint();
  }
  renderDashAgents();
}

function applyInstall(m) {
  if (m.type === "install.start") {
    const it = instEnsure(m.id);
    it.state = "running";
    it.phase = "preparing";
    it.source = m.source || "";
    it.startedAt = m.at || Date.now();
    it.ahead = 0;
    it.active = "";
    if (m.id === INSTALL_AT) instPaint();
    renderDashAgents();
    return;
  }
  if (m.type === "install.queued") {
    const it = instEnsure(m.id);
    it.state = "running";
    it.phase = "queued";
    it.source = m.source || it.source || "";
    it.ahead = m.ahead | 0;
    it.active = m.active || "";
    if (m.id === INSTALL_AT) instPaint();
    renderDashAgents();
    return;
  }
  if (m.type === "install.log") {
    instLine(m.id, m.line || "");
    return;
  }
  if (m.type === "install.phase") {
    const it = INSTALLS[m.id];
    if (it) {
      it.phase = m.phase || it.phase;
      if (m.id === INSTALL_AT) instPaint();
    }
    return;
  }
  if (m.type === "install.done") instDone(m);
}

async function launchAgent(id) {
  const a = CATALOG.find((x) => x.id === id);
  // Workspaces 不再有默认项目：从总览启动也要先选一个真实 Project。
  // 新建 Agent 卡会预选项目；没有项目时卡里就是"先添加项目"。
  setNavView("workspace");
  openNewAgent({ agent: id, why: "总览 Agent 启动" });
  sendCtrl({ type: "log", msg: `从 Agent 接线台打开 ${a ? a.name : id} → 新建 Agent 卡（项目必选）` });
}

$("dash-agent-list").addEventListener("click", (e) => {
  const fb = e.target.closest("[data-agents-fold]");
  if (fb) {
    agentsFoldOpen = !agentsFoldOpen;
    // 就地切类，不重画：重画会新建折叠容器，grid-rows 没有"从 0fr 到 1fr"的起点，
    // 动画就没了（magpie 那条 fold 也是靠同一个元素过渡的）。
    fb.classList.toggle("open", agentsFoldOpen);
    const fold = $("dash-agent-fold");
    if (fold) fold.classList.toggle("open", agentsFoldOpen);
    const label = $("dash-agent-more-label");
    if (label) {
      const n = CATALOG.filter((a) => !a.installed).length;
      label.textContent = agentsFoldOpen ? t("dash.agents.foldHide")
        : t("dash.agents.foldShow", { n });
    }
    return;
  }
  const sb = e.target.closest("[data-setup]");
  if (sb) {
    // “只启动” → “接入状态”：和安装共用同一个流式面板，但不动 CLI 本身。
    const id = sb.dataset.setup;
      const a = CATALOG.find((x) => x.id === id) || { id, name: id };
    instOpen(a);
    sendCtrl({ type: "agent.setup", id });
    bootFact(`Agent 状态接入 → ${id}`);
    return;
  }
  const ib = e.target.closest("[data-install]");
  if (ib) {
    const id = ib.dataset.install;
      const a = CATALOG.find((x) => x.id === id) || { id, name: id };
    instOpen(a);
    sendCtrl({ type: "install.agent", id });
    bootFact(`Agent 安装 → ${id}`);
    return;
  }
  const db = e.target.closest("[data-docs]");
  if (db) {
    const id = db.dataset.docs;
      const a = CATALOG.find((x) => x.id === id);
    const url = a && a.url;
    // 后端 open.url 还会再拦一次；这里先挡掉空值和别的 scheme。
    if (!url || !/^https?:\/\//i.test(url)) return;
    sendCtrl({ type: "open.url", url });
    bootFact(`Agent 安装说明 → ${id}`);
    return;
  }
  const lb = e.target.closest("[data-launch]");
  if (lb) {
    launchAgent(lb.dataset.launch);
    bootFact(`Agent 打开 → ${lb.dataset.launch}`);
    return;
  }
  // 行本身 = 跳到设置 › Agents 的那一行（2026-10-28 起配置在设置里，见 85b-providers.js）。
  // 安装/打开按钮在上面已经各自处理并 return，所以点按钮不会顺带跳走。
  const cb = e.target.closest("[data-agentcfg]");
  if (cb) openAgentSettings(cb.dataset.agentcfg);
});

// 行的 role="button" 也要能用键盘打开（Enter / 空格），和鼠标点击同一条路。
$("dash-agent-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cb = e.target.closest("[data-agentcfg]");
  if (!cb) return;
  e.preventDefault();
  openAgentSettings(cb.dataset.agentcfg);
});

// 任务条：点名字切换面板；点 × 收起一个已完成的任务。
$("inst-tasks").addEventListener("click", (e) => {
  const x = e.target.closest("[data-instdrop]");
  if (x) { instDrop(x.dataset.instdrop); return; }
  const b = e.target.closest("[data-inst]");
  if (!b) return;
  INSTALL_AT = b.dataset.inst;
  INSTALL_LOG_OPEN = !!(INSTALLS[INSTALL_AT] && INSTALLS[INSTALL_AT].state === "failed");
  instPaint();
});

$("inst-log-toggle").addEventListener("click", () => {
  INSTALL_LOG_OPEN = !INSTALL_LOG_OPEN;
  instPaint();
  const log = $("inst-log");
  if (INSTALL_LOG_OPEN && log) log.scrollTop = log.scrollHeight;
});

$("inst-cancel").addEventListener("click", () => {
  const it = instCur();
  if (!it || it.state !== "running") return;
  it.phase = "cancelling";
  instPaint();
  sendCtrl({ type: "install.cancel", id: it.id });
});

$("inst-close").addEventListener("click", () => {
  const it = instCur();
  if (!it || it.state === "running") return;
  instDrop(it.id);
});

