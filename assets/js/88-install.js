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

function instElapsed() {
  if (!INSTALL) return "";
  const ms = INSTALL.elapsedMs || (Date.now() - (INSTALL.startedAt || Date.now()));
  const s = Math.max(0, Math.floor(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" +
         String(s % 60).padStart(2, "0");
}

function instPhaseText() {
  if (!INSTALL) return "";
  if (INSTALL.state === "failed") {
    return INSTALL.err ? t("inst.failedWith", { err: msgText(INSTALL.err) }) : t("inst.failed");
  }
  if (INSTALL.state === "done") {
    if (INSTALL.detected === true) return t("inst.doneDetected");
    if (INSTALL.detected === false) return t("inst.doneNotDetected");
    return t("inst.doneRescanned");
  }
  if (INSTALL.phase === "scanning") return t("inst.phase.scanning");
  if (INSTALL.phase === "cancelling") return t("inst.phase.cancelling");
  if (INSTALL.phase === "preparing") return t("inst.phase.preparing");
  return t("inst.phase.installing");
}

function startInstTicker() {
  if (INSTALL_TICK) clearInterval(INSTALL_TICK);
  INSTALL_TICK = setInterval(() => {
    if (!INSTALL) { clearInterval(INSTALL_TICK); INSTALL_TICK = 0; return; }
    if (INSTALL.state === "running") instPaint();
  }, 1000);
}

function stopInstTicker() {
  if (INSTALL_TICK) { clearInterval(INSTALL_TICK); INSTALL_TICK = 0; }
}

/* 只画进度台，不动名单；名单由 instOpen/instDone 显式重画。 */
function instPaint() {
  if (!INSTALL) return;
  const box = $("dash-install");
  if (!box) return;
  box.hidden = false;
  $("inst-title").textContent = t("inst.title", { name: INSTALL.name });
  $("inst-source").textContent = INSTALL.source || "CLI";
  $("inst-state").textContent = instPhaseText();
  $("inst-time").textContent = instElapsed();
  $("inst-dot").className = "dot" +
    (INSTALL.state === "done" ? " on" : INSTALL.state === "failed" ? " bad" : " running");
  const bar = $("inst-bar");
  if (bar) {
    bar.className = "inst-bar" +
      (INSTALL.state === "failed" ? " bad" : INSTALL.state === "done" ? " ok" : " running");
  }
  const last = $("inst-last");
  if (last) {
    last.textContent = INSTALL.lines.length
      ? INSTALL.lines[INSTALL.lines.length - 1]
      : t("inst.waitingOutput");
  }
  const log = $("inst-log");
  if (log) log.hidden = !INSTALL_LOG_OPEN;
  const lt = $("inst-log-toggle");
  if (lt) lt.textContent = INSTALL_LOG_OPEN ? t("inst.logHide") : t("inst.logShow");
  $("inst-cancel").hidden = INSTALL.state !== "running";
  $("inst-close").hidden = INSTALL.state === "running";
}

function instLine(line) {
  if (!INSTALL) return;
  const log = $("inst-log");
  INSTALL.lines.push(line);
  if (INSTALL.lines.length > 1500) INSTALL.lines.splice(0, INSTALL.lines.length - 1500);
  if (log) {
    const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.textContent = INSTALL.lines.join("\n");
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }
  if (INSTALL.phase === "preparing") {
    INSTALL.phase = "running";
    instPaint();
  }
  const last = $("inst-last");
  if (last) last.textContent = line;
}

function instOpen(a) {
  INSTALL = {
    id: a.id, name: a.name, state: "running", phase: "preparing",
    source: "", startedAt: Date.now(), lines: [],
    detected: undefined, err: null, elapsedMs: 0,
  };
  INSTALL_LOG_OPEN = false;
  $("inst-log").textContent = "";
  $("inst-log").hidden = true;
  instPaint();
  startInstTicker();
  renderDashAgents();
}

function instDone(m) {
  if (!INSTALL || INSTALL.id !== m.id) return;
  // done 里带的新名单先应用：行和进度台在同一个事件里翻过来。
  if (m.catalog && typeof applyMagpie === "function" && MAGPIE) {
    applyMagpie(Object.assign({}, MAGPIE, { catalog: m.catalog }));
  }
  INSTALL.state = m.ok ? "done" : "failed";
  INSTALL.phase = INSTALL.state;
  INSTALL.detected = m.detected;
  INSTALL.err = m.ok ? null : errMsgOf(m);
  INSTALL.elapsedMs = m.elapsedMs || (Date.now() - INSTALL.startedAt);
  if (!m.ok) INSTALL_LOG_OPEN = true;
  stopInstTicker();
  instPaint();
  renderDashAgents();
  if (!m.ok) {
    const log = $("inst-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function applyInstall(m) {
  // magpie 本体：同一个流式通道，id 固定是 "magpie"。装完之后 Go 那边会直接
  // gwConnect（见 install.go 的 finishInstall），这里只需要把日志和状态画出来。
  if (m.id === "magpie") {
    if (!GW_INSTALL) GW_INSTALL = { state: "running", lines: [], err: null };
    if (m.type === "install.start") {
      GW_INSTALL.state = "running";
    } else if (m.type === "install.log") {
      GW_INSTALL.lines.push(m.line);
      if (GW_INSTALL.lines.length > 1500) {
        GW_INSTALL.lines.splice(0, GW_INSTALL.lines.length - 1500);
      }
    } else if (m.type === "install.done") {
      GW_INSTALL.state = m.ok ? "done" : "failed";
      GW_INSTALL.err = m.ok ? null : errMsgOf(m);
      if (m.ok) {
        // 新装的一份：版本状态要重新问（旧值属于上一个 exe）。
        GW_UPD = null; GW_UPD_BUSY = ""; GW_UPD_ERR = null; GW_UPD_TRIES = 0;
        sendCtrl({ type: "gw.refresh" });
        sendCtrl({ type: "magpie.refresh" });
      }
    }
    if (NAV_HERE === "dash" && dashTab === "gateway") renderGateway();
    return;
  }
  if (m.type === "install.start") {
    if (INSTALL && INSTALL.id === m.id) {
      INSTALL.state = "running";
      INSTALL.phase = "preparing";
      INSTALL.source = m.source || "";
      instPaint();
    }
    return;
  }
  if (m.type === "install.log") {
    instLine(m.line || "");
    return;
  }
  if (m.type === "install.phase") {
    if (INSTALL && INSTALL.id === m.id) {
      INSTALL.phase = m.phase || INSTALL.phase;
      instPaint();
    }
    return;
  }
  if (m.type === "install.done") instDone(m);
}

async function launchAgent(id) {
  const m = mg();
  const a = ((m && m.catalog) || []).find((x) => x.id === id);
  const t = await createTab({ agent: id, cwd: "", resume: { kind: "new", id: "" } }, { fresh: true });
  if (!t || !t.id) return;
  armFreshCell(t, "总览 Agent 启动");
  setActive(t);
  setNavView("workspace");
  sendCtrl({ type: "log", msg: `从 Agent 接线台打开 ${a ? a.name : id} → tab=${t.id}` });
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
      const n = ((mg() && mg().catalog) || []).filter((a) => !a.installed).length;
      label.textContent = agentsFoldOpen ? t("dash.agents.foldHide")
        : t("dash.agents.foldShow", { n });
    }
    return;
  }
  const ib = e.target.closest("[data-install]");
  if (ib) {
    const id = ib.dataset.install;
    const m = mg();
    const a = ((m && m.catalog) || []).find((x) => x.id === id) || { id, name: id };
    instOpen(a);
    sendCtrl({ type: "install.agent", id });
    bootFact(`Agent 安装 → ${id}`);
    return;
  }
  const db = e.target.closest("[data-docs]");
  if (db) {
    const id = db.dataset.docs;
    const m = mg();
    const a = ((m && m.catalog) || []).find((x) => x.id === id);
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
  // 行本身 = 打开右侧配置抽屉（89-agent-cfg.js）。安装/打开按钮在上面已经
  // 各自处理并 return，所以点按钮不会顺带打开抽屉。
  const cb = e.target.closest("[data-agentcfg]");
  if (cb) acOpen(cb.dataset.agentcfg);
});

// 行的 role="button" 也要能用键盘打开（Enter / 空格），和鼠标点击同一条路。
$("dash-agent-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cb = e.target.closest("[data-agentcfg]");
  if (!cb) return;
  e.preventDefault();
  acOpen(cb.dataset.agentcfg);
});

$("inst-log-toggle").addEventListener("click", () => {
  INSTALL_LOG_OPEN = !INSTALL_LOG_OPEN;
  instPaint();
  const log = $("inst-log");
  if (INSTALL_LOG_OPEN && log) log.scrollTop = log.scrollHeight;
});

$("inst-cancel").addEventListener("click", () => {
  if (!INSTALL || INSTALL.state !== "running") return;
  INSTALL.phase = "cancelling";
  instPaint();
  sendCtrl({ type: "install.cancel", id: INSTALL.id });
});

$("inst-close").addEventListener("click", () => {
  stopInstTicker();
  $("dash-install").hidden = true;
  INSTALL = null;
  INSTALL_LOG_OPEN = false;
  renderDashAgents();
});

