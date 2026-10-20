"use strict";
/* 08-agent-model.js —— 一个 agent「从零到完整/可用」的**纯视图模型**。
 *
 * 为什么单独一份（不塞进 86-dash）：总览那一行、右侧配置抽屉、以后的欢迎页
 * 说的是同一个问题 —— 这个 agent 现在走到第几步、下一步是什么。把判断写在
 * 渲染函数里，三处会各写一遍，然后悄悄漂开。
 *
 * 输入（全部是外部事实，本文件不认识 DOM、不读全局）：
 *   card        agentcatalog.Card：installed / caps / install / setup / url …
 *   gwInfo      magpie /api/state 里的那一行（{id,wired,connectable?}），没读到时 null
 *   record      internal/agentstate.Record（assets 侧的 AGENT_STATE[id]），没有时 null
 *   magpieState {state:"running|stopped|absent|unknown", agentsKnown:bool}
 *
 * 输出：
 *   { steps, legs, complete, completeKind, group, primary, nextStep, reason }
 *
 * ⚠️ 「录入」不是「打开过一次」：每一步都要有记录/机制/证据。内置适配器的
 * 机制由 caps 给出（hook / app-server / http / extension）；标题状态是弱信号，
 * 必须显式标 title；没有任何来源就写 unsupported，不拿空白冒充完成。
 *
 * ⚠️ 分组必须**互斥**：旧总览按三个独立布尔过滤，同一个 agent 会同时出现在
 * 「完整」和「仅启动」里（实测）。这里的 group 是一个单值。
 */

/* 七步的键（检测 / 安装 / 启动 / 就绪 / 状态 / 续接 / 网关）。
   Go 侧 internal/agentstate 的 Step* 常量与这里一一对应。 */
const AGENT_STEP_KEYS = ["detect", "install", "launch", "auth", "status", "resume", "gateway"];
/* 卡片上那五条腿的短标记（L 启动 / S 状态 / R 续接 / G 网关 / A 登录）。 */
const AGENT_LEG_KEYS = ["launch", "status", "resume", "gateway", "auth"];
const AGENT_STEP_STATES = ["todo", "doing", "done", "failed", "unsupported", "not_applicable"];

function agvIsState(v) {
  return AGENT_STEP_STATES.indexOf(v) >= 0;
}

function agvStep(key, state, extra) {
  return Object.assign({
    key: key,
    state: agvIsState(state) ? state : "todo",
    mechanism: "",
    source: "",
    errorCode: "",
    evidence: "",
    verified: false,
    noteKey: "",
    noteParams: null,
    action: "",
  }, extra || {});
}

function agvRecStep(record, key) {
  if (!record || !record.steps || typeof record.steps !== "object") return null;
  const s = record.steps[key];
  if (!s || !agvIsState(s.state)) return null;
  return s;
}

function agvCaps(card) {
  return (card && card.caps) || {};
}

function agvReadiness(record) {
  const r = record && record.readiness;
  return r === "ready" || r === "needs-login" || r === "needs-key" ||
    r === "needs-setup" || r === "unknown" ? r : "";
}

/* magpie 的状态只分三档（internal/gateway/wire.go 的 Snapshot.State）。
   absent = 没有控制面；stopped = 有但没跑；unknown = watcher 还没出第一份。 */
function agvMagpie(magpieState) {
  const s = magpieState && magpieState.state;
  return {
    state: s === "running" || s === "stopped" || s === "absent" ? s : "unknown",
    agentsKnown: !!(magpieState && magpieState.agentsKnown),
  };
}

/* 主行动。action 是**手势**，不是文案；文案由渲染层按 i18n 给。
   install / docs / open / setup / connect / settings / usage / drawer / none */
function agvPrimary(card, group, steps) {
  const by = {};
  for (const s of steps) by[s.key] = s;
  const caps = agvCaps(card);
  const installed = !!card.installed;

  if (!installed) {
    if (card.install) return { action: "install", step: "install" };
    if (card.url) return { action: "docs", step: "install" };
    return { action: "none", step: "install" };
  }
  if (!caps.launch) {
    return { action: card.url ? "docs" : "none", step: "launch" };
  }
  if (by.launch.state !== "done") {
    if (by.launch.state === "failed" && card.install) return { action: "install", step: "launch" };
    return { action: "open", step: "launch" };
  }
  // 状态钩子能装就先装：它和登录是两条独立的腿，不该被“还没登录”挡住。
  // （agy/dsh 的 hooks 装上之后，第一条事件会同时把就绪写成 ready。）
  if (card.setup && by.status.state !== "done" && by.status.state !== "not_applicable") {
    return { action: "setup", step: "status" };
  }
  // 登录/key：再开一格就是入口（不自动登录、不碰凭据）。
  const rd = by.auth.state;
  if (rd !== "done" && rd !== "unsupported" && rd !== "not_applicable") {
    return { action: "open", step: "auth" };
  }
  // 状态：Perch 知道怎么补的（dsh/agy hooks）给一键接入；其余只能说明。
  if (by.status.state !== "done" && by.status.state !== "not_applicable") {
    if (card.setup) return { action: "setup", step: "status" };
    if (by.status.state === "unsupported") {
      return { action: card.url ? "docs" : "usage", step: "status" };
    }
    return { action: "open", step: "status" };
  }
  if (by.gateway.state !== "done" && by.gateway.state !== "unsupported" &&
      by.gateway.state !== "not_applicable") {
    if (by.gateway.noteKey === "agent.note.magpieAbsent" ||
        by.gateway.noteKey === "agent.note.magpieStopped") {
      return { action: "settings", step: "gateway" };
    }
    return { action: "connect", step: "gateway" };
  }
  if (by.gateway.state === "unsupported") {
    return { action: card.url ? "docs" : "usage", step: "gateway" };
  }
  if (group === "complete" || group === "native") return { action: "open", step: "" };
  return { action: "drawer", step: "" };
}

/**
 * 主入口。纯函数：同一份输入永远得到同一份输出（测试见 08-agent-model.test.js）。
 */
function agentIntegrationView(card, gwInfo, record, magpieState) {
  card = card || {};
  record = record || null;
  const caps = agvCaps(card);
  const mg = agvMagpie(magpieState);
  const installed = !!card.installed;
  const readiness = agvReadiness(record);
  const steps = [];

  // 1 检测 -------------------------------------------------------------------
  // 探测是**每一次**都由 Go 现算的（配置目录 / exe），不是“以前打开过”。
  steps.push(agvStep("detect", installed ? "done" : "todo", {
    mechanism: "probe",
    source: installed ? "card.path" : "",
    evidence: installed ? (card.path || "") : "",
    noteKey: installed ? "" : "agent.note.notDetected",
    action: installed ? "" : (card.install ? "install" : "docs"),
  }));

  // 2 安装 -------------------------------------------------------------------
  const recInstall = agvRecStep(record, "install");
  let installState = installed ? "done" : (recInstall ? recInstall.state : "todo");
  if (!installed && installState === "done") installState = "todo"; // 卸掉了：探测是权威
  if (!installed && !card.install && !card.url && card.windows === false) {
    installState = "unsupported";
  }
  steps.push(agvStep("install", installState, {
    mechanism: installed ? "existing" : (card.install ? "recipe" : ""),
    source: installed ? "card.path" : "",
    evidence: installed ? (card.path || "") : "",
    noteKey: installed ? "" : (card.install ? "agent.note.installable" : "agent.note.docsOnly"),
    action: installed ? "" : (card.install ? "install" : "docs"),
  }));

  // 2 启动 -------------------------------------------------------------------
  const recLaunch = agvRecStep(record, "launch");
  let launchState = "todo";
  if (!installed) launchState = "todo";
  else if (!caps.launch) launchState = "unsupported";
  else if (recLaunch) launchState = recLaunch.state;
  steps.push(agvStep("launch", launchState, {
    mechanism: caps.launch ? "terminal" : "",
    source: recLaunch ? recLaunch.source : "",
    errorCode: recLaunch ? recLaunch.errorCode : "",
    evidence: recLaunch ? recLaunch.evidence : "",
    verified: !!(recLaunch && recLaunch.verified),
    noteKey: !installed ? "agent.note.installFirst"
      : !caps.launch ? "agent.note.noTerminal"
      : launchState === "failed" ? "agent.note.launchFailed" : "",
    action: installed && caps.launch ? "open" : "",
  }));

  // 3 就绪 / 登录 ------------------------------------------------------------
  const recAuth = agvRecStep(record, "auth");
  let authState = "todo";
  if (recAuth && recAuth.state === "done") authState = "done";
  else if (readiness === "ready") authState = "done";
  else if (!installed || (launchState !== "done" && !recAuth)) authState = "todo";
  steps.push(agvStep("auth", authState, {
    source: readiness ? ("readiness:" + readiness) : (recAuth ? recAuth.source : ""),
    evidence: recAuth ? recAuth.evidence : "",
    verified: authState === "done",
    noteKey: authState === "done" ? "agent.note.ready"
      : readiness === "needs-login" ? "agent.note.needsLogin"
      : readiness === "needs-key" ? "agent.note.needsKey"
      : readiness === "needs-setup" ? "agent.note.needsSetup"
      : "agent.note.readinessUnknown",
    action: installed ? "open" : "",
  }));

  // 4 状态 -------------------------------------------------------------------
  const recStatus = agvRecStep(record, "status");
  let statusState = "todo";
  let statusMech = caps.mechanism || "";
  if (recStatus) {
    statusState = recStatus.state;
    if (recStatus.mechanism) statusMech = recStatus.mechanism;
  } else if (!installed) {
    statusState = "todo";
  } else if (caps.status) {
    statusState = "todo"; // 适配器在，但还没有第一条真实事件
  } else if (caps.title) {
    statusState = "todo";
    statusMech = "title";
  } else if (card.setup) {
    // Perch 知道怎么补（dsh / agy 的 hooks）：不是“无来源”，是“还没接”。
    statusState = "todo";
    statusMech = "hook";
  } else {
    statusState = "unsupported";
    statusMech = "";
  }
  steps.push(agvStep("status", statusState, {
    mechanism: statusMech,
    source: recStatus ? recStatus.source : "",
    evidence: recStatus ? recStatus.evidence : "",
    verified: !!(recStatus && recStatus.verified),
    noteKey: statusState === "done" ? "agent.note.statusWired"
      : statusMech === "title" ? "agent.note.titleWaiting"
      : statusMech === "hook" && card.setup && !caps.status ? "agent.note.statusSetup"
      : statusMech && statusState !== "unsupported" ? "agent.note.statusAuto"
      : statusState === "unsupported" ? "agent.note.noStatusSource" : "",
    action: statusState === "unsupported" ? "" : (card.setup && !caps.status ? "setup" : ""),
  }));

  // 5 续接 -------------------------------------------------------------------
  const recResume = agvRecStep(record, "resume");
  let resumeState;
  let resumeKind = caps.resumeKind || "";
  if (recResume) {
    resumeState = recResume.state;
    if (recResume.mechanism) resumeKind = recResume.mechanism;
  } else if (caps.resume) {
    // 适配器本身就是证据：启动参数由 agent.Defs 统一给，不靠用户再走一遍。
    resumeState = "done";
    resumeKind = resumeKind || "exact";
  } else {
    resumeState = "unsupported";
  }
  steps.push(agvStep("resume", resumeState, {
    mechanism: resumeKind,
    source: recResume ? recResume.source : (caps.resume ? "adapter" : ""),
    evidence: recResume ? recResume.evidence : "",
    verified: !!(recResume && recResume.verified),
    noteKey: resumeState === "done" ? "agent.note.resumeBuiltin"
      : resumeState === "unsupported" ? "agent.note.resumeNotWired" : "",
    action: "",
  }));

  // 6 网关 -------------------------------------------------------------------
  const recGw = agvRecStep(record, "gateway");
  let gwState = "todo";
  let gwNote = "";
  const wired = !!(gwInfo && gwInfo.wired);
  const connectable = gwInfo && typeof gwInfo.connectable === "boolean" ? gwInfo.connectable : null;
  if (wired) {
    gwState = "done";
    gwNote = "agent.note.gatewayWired";
  } else if (connectable === false) {
    gwState = "unsupported";
    gwNote = gwInfo && gwInfo.reasonKey ? gwInfo.reasonKey : "agent.note.gatewayNotConnectable";
  } else if (!mg.agentsKnown) {
    gwState = "todo";
    gwNote = mg.state === "absent" ? "agent.note.magpieAbsent"
      : mg.state === "stopped" ? "agent.note.magpieStopped"
      : "agent.note.gatewayUnknown";
  } else if (!gwInfo) {
    // 控制面读到了，但没有这个 agent 的行：magpie 没注册它，Perch 不假装能接。
    gwState = "unsupported";
    gwNote = "agent.note.gatewayNotManaged";
  } else if (recGw && recGw.state === "failed") {
    gwState = "failed";
    gwNote = "agent.note.gatewayFailed";
  } else {
    gwState = "todo";
    gwNote = "agent.note.gatewayAvailable";
  }
  steps.push(agvStep("gateway", gwState, {
    mechanism: "magpie",
    source: recGw ? recGw.source : "",
    errorCode: recGw ? recGw.errorCode : "",
    evidence: recGw ? recGw.evidence : "",
    verified: wired,
    noteKey: gwNote,
    action: gwState === "todo" ? "connect" : "",
  }));

  // 完整 / 可用 ---------------------------------------------------------------
  const core = ["detect", "install", "launch", "auth", "status", "resume"];
  const by = {};
  for (const s of steps) by[s.key] = s;
  const coreDone = core.every((k) => by[k].state === "done");
  let completeKind = null;
  if (coreDone && by.gateway.state === "done") completeKind = "gateway";
  else if (coreDone && by.gateway.state === "unsupported") completeKind = "native";

  // 互斥分组（一个 agent 只属于一个）。
  let group;
  if (!installed) group = "missing";
  else if (!caps.launch) group = "nolaunch";
  else if (completeKind === "gateway") group = "complete";
  else if (completeKind === "native") group = "native";
  else if (by.status.state === "unsupported" && by.launch.state === "done" && !card.setup) {
    // 有补救动作的（agy 的 hooks）留在「待处理」，别把用户钉在「仅启动」。
    group = "launch";
  }
  else group = "action";

  const legs = AGENT_LEG_KEYS.map((k) => ({ key: k, state: by[k].state }));
  const primary = agvPrimary(card, group, steps);
  const next = primary.step ? by[primary.step] : null;

  return {
    steps: steps,
    legs: legs,
    complete: !!completeKind,
    completeKind: completeKind,
    group: group,
    primary: primary,
    nextStep: next ? next.key : "",
    reason: next ? next.noteKey : "",
    wired: wired,
  };
}

/* 总览的五个分组（显示顺序）。缺省组不画。 */
const AGENT_GROUPS = ["complete", "native", "action", "launch", "nolaunch", "missing"];

/* Node 测试入口；浏览器里 module 不存在，这一段不执行。 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AGENT_STEP_KEYS: AGENT_STEP_KEYS,
    AGENT_LEG_KEYS: AGENT_LEG_KEYS,
    AGENT_GROUPS: AGENT_GROUPS,
    agentIntegrationView: agentIntegrationView,
  };
}
