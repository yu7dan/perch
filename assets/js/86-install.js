"use strict";
/* 86-install.js —— 行内安装控制台：agent 官方安装命令的流式日志与收尾。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域，
   顺序即依赖：后面的文件可以用前面声明的 const/let/function。新代码放进对应域的文件，
   别在这一段里再塞别的域。源行 10743-10840（2026-10-17 从 app.js 原样切出，逻辑未改）。 */

/* ---------------------------------------------------------------------------
   行内安装控制台
   点「安装」→ Go 跑写死的官方命令 → 输出逐行推回来，就地摊在名单下面。
   不弹窗、不开浏览器；装完 Go 重扫名单，卡片自己从「未检测到」翻成「已检测到」。
   --------------------------------------------------------------------------- */
function instLine(line) {
  if (!INSTALL) return;
  const log = $("inst-log");
  if (!log) return;
  const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  INSTALL.lines.push(line);
  if (INSTALL.lines.length > 1500) INSTALL.lines.splice(0, INSTALL.lines.length - 1500);
  log.textContent = INSTALL.lines.join("\n");
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function instOpen(a) {
  INSTALL = { id: a.id, name: a.name, state: "running", lines: [] };
  const box = $("dash-install");
  if (!box) return;
  box.hidden = false;
  $("inst-title").textContent = "安装 " + a.name;
  $("inst-state").textContent = "准备中…";
  $("inst-dot").className = "dot";
  $("inst-log").textContent = "";
  $("inst-cancel").hidden = false;
  $("inst-close").hidden = true;
  renderDashAgents();
  box.scrollIntoView({ block: "nearest" });
}

function instDone(m) {
  if (!INSTALL || INSTALL.id !== m.id) return;
  INSTALL.state = m.ok ? "done" : "failed";
  $("inst-state").textContent = m.ok
    ? "完成 · 已重新扫描名单"
    : ("失败" + (m.err ? " · " + m.err : ""));
  $("inst-dot").className = "dot" + (m.ok ? " on" : " bad");
  $("inst-cancel").hidden = true;
  $("inst-close").hidden = false;
  renderDashAgents();
}

function applyInstall(m) {
  // magpie 本体：同一个流式通道，id 固定是 "magpie"。装完之后 Go 那边会直接
  // gwConnect（见 install.go 的 finishInstall），这里只需要把日志和状态画出来。
  if (m.id === "magpie") {
    if (!GW_INSTALL) GW_INSTALL = { state: "running", lines: [], err: "" };
    if (m.type === "install.start") {
      GW_INSTALL.state = "running";
    } else if (m.type === "install.log") {
      GW_INSTALL.lines.push(m.line);
      if (GW_INSTALL.lines.length > 1500) {
        GW_INSTALL.lines.splice(0, GW_INSTALL.lines.length - 1500);
      }
    } else if (m.type === "install.done") {
      GW_INSTALL.state = m.ok ? "done" : "failed";
      GW_INSTALL.err = m.ok ? "" : (m.err || "");
      if (m.ok) {
        // 新装的一份：版本状态要重新问（旧值属于上一个 exe）。
        GW_UPD = null; GW_UPD_BUSY = ""; GW_UPD_ERR = ""; GW_UPD_TRIES = 0;
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
      $("inst-state").textContent = "运行中…";
    }
    return;
  }
  if (m.type === "install.log") {
    instLine(m.line);
    return;
  }
  if (m.type === "install.done") instDone(m);
}

async function launchAgent(id) {
  const m = mg();
  const a = ((m && m.catalog) || []).find((x) => x.id === id);
  const t = await createTab({ agent: id, cwd: "", resume: { kind: "new", id: "" } });
  if (!t || !t.id) return;
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
      label.textContent = agentsFoldOpen ? "收起" : `显示 ${n} 个未检测到的`;
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
  const lb = e.target.closest("[data-launch]");
  if (lb) {
    launchAgent(lb.dataset.launch);
    bootFact(`Agent 打开 → ${lb.dataset.launch}`);
    return;
  }
  // 行本身 = 打开右侧配置抽屉（88-agent-cfg.js）。安装/打开按钮在上面已经
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

$("inst-cancel").addEventListener("click", () => {
  if (!INSTALL || INSTALL.state !== "running") return;
  sendCtrl({ type: "install.cancel", id: INSTALL.id });
  $("inst-state").textContent = "正在取消…";
});

$("inst-close").addEventListener("click", () => {
  $("dash-install").hidden = true;
  INSTALL = null;
  renderDashAgents();
});

