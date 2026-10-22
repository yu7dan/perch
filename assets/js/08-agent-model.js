"use strict";
/* 08-agent-model.js —— agent 名单/抽屉需要的**最小事实**：装没装、走不走网关、
 * 当前是哪个模型。这里没有步骤、没有“完整”、没有 L/S/R/G/A。
 *
 * 为什么单独一份：总览行、行内详情、终端里的模型 chip 必须对“当前模型/能不能
 * 接网关”给出同一个答案。判断写在三个渲染函数里，迟早会漂开。
 *
 * 输入全部是外部事实：
 *   card       agentcatalog.Card（installed / caps / install / url）
 *   gwInfo     控制面 /api/state 里的那一行（fields/options/wired/source/connectable/menu）
 *   magpieState {state, agentsKnown}：只用来区分“网关没读到”和“网关不管理它”
 */

const AGENT_ROUTE_KEYS = ["missing", "no-launch", "gateway", "native", "unconfigured", "unknown"];

function agvOptions(field) {
  return field && Array.isArray(field.options) ? field.options : [];
}

/* magpie 的模型选项带 ref；有的 agent 把 magpie 本身作为 provider 值。 */
function agvIsGatewayOption(o) {
  return !!(o && (o.ref || o.value === "magpie"));
}

/* 主模型字段：优先找真正列出网关模型的字段（和 magpie connectField 同口径）。
   不能只看“第一个带网关选项的字段”：有的 agent（Ante/Pencil 这类）把
   provider 字段放在前面，它的唯一选项是 magpie 本身 —— 那是“接不接网关”，
   不是“用哪个模型”。所以先认带 ref 的目录模型，其次才认只有 magpie 值
   的 provider 型字段；没有模型来源时退回 key=model，至少能显示 agent 自己的值。 */
function agentMainModelField(row) {
  if (!row || !Array.isArray(row.fields)) return null;
  const fields = row.fields.filter(Boolean);
  const withRef = fields.filter((f) => agvOptions(f).some((o) => o && o.ref));
  const byKey = withRef.find((f) => f.key === "model");
  if (byKey) return byKey;
  if (withRef.length) return withRef[0];
  const modelWithAny = fields.find((f) => f.key === "model" && agvOptions(f).length);
  if (modelWithAny) return modelWithAny;
  const anyGateway = fields.find((f) => agvOptions(f).some(agvIsGatewayOption));
  if (anyGateway) return anyGateway;
  return fields.find((f) => f.key === "model") ||
    fields.find((f) => agvOptions(f).length) || null;
}

function agentGatewayOptions(field) {
  return agvOptions(field).filter(agvIsGatewayOption);
}

function agentModelOption(field, value) {
  if (!field || !value) return null;
  return agvOptions(field).find((o) => o && o.value === value) || null;
}

function agentModelLabel(field, value) {
  if (!value) return "";
  const o = agentModelOption(field, value);
  return (o && (o.label || o.value)) || value;
}

function agvRouteLabelKey(route) {
  switch (route) {
    case "gateway": return "agent.route.gateway";
    case "native": return "agent.route.native";
    case "missing": return "agent.route.missing";
    case "no-launch": return "agent.route.noLaunch";
    case "unknown": return "agent.route.unknown";
    default: return "agent.route.unconfigured";
  }
}

/**
 * 一个 agent 现在是什么路由、当前模型、主行动。
 * 纯函数：不读 DOM、不读全局状态、不写配置。
 */
function agentRouteView(card, gwInfo, magpieState) {
  card = card || {};
  const caps = card.caps || {};
  const field = agentMainModelField(gwInfo);
  const gatewayOptions = agentGatewayOptions(field);
  const current = field ? String(field.value || "") : "";
  const currentOpt = agentModelOption(field, current);
  const wired = !!(gwInfo && gwInfo.wired);
  const hasGatewayModels = gatewayOptions.length > 0;
  const connectable = !!(gwInfo && gwInfo.connectable !== false && hasGatewayModels);
  const stateKnown = !!(magpieState && magpieState.agentsKnown);

  let route;
  if (!card.installed) route = "missing";
  else if (!caps.launch) route = "no-launch";
  else if (wired || (currentOpt && agvIsGatewayOption(currentOpt))) route = "gateway";
  else if (gwInfo && gwInfo.connectable === false) route = "native";
  else if (gwInfo && gwInfo.source) route = "native";
  else if (current && !(currentOpt && agvIsGatewayOption(currentOpt))) route = "native";
  else if (!gwInfo && stateKnown) route = "native"; // 网关读到了，但不管理这个 agent
  else if (!gwInfo && !stateKnown) route = "unknown"; // 还没读到接线，不冒充“本机已配置”
  else route = "unconfigured";

  let action = "open";
  if (!card.installed) action = card.install ? "install" : (card.url ? "docs" : "none");
  else if (!caps.launch) action = card.url ? "docs" : "none";

  return {
    route,
    labelKey: agvRouteLabelKey(route),
    modelLabel: agentModelLabel(field, current),
    modelField: field,
    modelFieldKey: field ? field.key : "",
    gatewayOptions,
    hasGatewayModels,
    connectable,
    wired,
    // magpie 的 menu agent：模型在它自己的菜单里选（ZCode / Cursor Private
    // Inference 这类），Perch 没有一颗“主模型”字段可以替用户改。
    ownMenu: !!(gwInfo && gwInfo.menu),
    canOpen: !!(card.installed && caps.launch),
    action,
    currentModel: current,
  };
}

/* ---------------------------------------------------------------------------
   首次启动 / 登录页的识别
   ---------------------------------------------------------------------------
   为什么不能只看 cellState：登录页、key 页、首启引导在状态机上都是「在等你」
   （ask），但它们是**可以安全重开的**；真正的权限框/提问不能杀。所以这里只认
   已知 agent 的首启标记，命中才允许自动重开。纯函数，输入是终端当前屏的文本行，
   方便单测；读 xterm 的那一层在 10-term 的 paneSetupKind()。 */
const AGENT_SETUP_MARKERS = {
  agy: [
    // 首启向导：主题 → 条款/数据采集 → 登录失败
    { kind: "agy-color", re: /Choose your color scheme|Welcome to Antigravity CLI/i },
    { kind: "agy-tos", re: /Terms of Service\s*&\s*Data Use|I agree to help improve Antigravity CLI/i },
    // 未接线时 agy 1.4.4 的首屏是「登录方式」菜单（Google OAuth / GCP 项目）。
    // 这是登录墙，不是任务页；必须认出来，否则接入后无法走首启页的关 PTY 兜底
    // （实测 2026-10-21：setup 认不出 → 只能 toast “没能停掉这一格”）。
    { kind: "agy-login", re: /token exchange failed|Press any key to go back|sign in to antigravity/i },
    // 「登录方式」菜单要**标题 + 具体选项**两样一起认：只凭 "Select login method"
    // 或 "not signed in" 一句话，用户在聊天里讨论登录时会被误判成首启页。
    { kind: "agy-login", re: /Select login method[\s\S]{0,300}(Google OAuth|Google Cloud project)/i },
  ],
  dsh: [
    // dsh-tui 的 4 步首启引导（中英两套文案）。注意：**不把单独的
    // DEEPSEEK_API_KEY 当标记** —— 用户完全可能让 agent 在终端里编辑一个
    // 含这个字符串的文件；只有引导页的标题/步骤条/启动画面才是强证据。
    { kind: "dsh-onboarding", re: /欢迎使用\s*dsh-TUI|第\s*\d+\s*\/\s*\d+\s*步|Esc\s*跳过引导/i },
    { kind: "dsh-onboarding", re: /Welcome to\s*dsh-TUI|Step\s*\d+\s*\/\s*\d+|Esc to skip/i },
    // 启动画面：profile 刚建好、首启页还没画出来的那一两秒。它是“这一格
    // 还在启动”，不是用户在干活；重开是安全的。
    { kind: "dsh-starting", re: /正在启动\s*DSH|Starting\s+DSH/i },
  ],
};

function agentSetupKind(agent, lines) {
  const list = AGENT_SETUP_MARKERS[agent];
  if (!list || !Array.isArray(lines) || !lines.length) return "";
  const text = lines.join("\n");
  for (const m of list) if (m.re.test(text)) return m.kind;
  return "";
}

/* 接线成功之后，这一格该怎么办。纯函数，输入只有事实：
     hasTab     这一格还在不在（活格）
     setup      agentSetupKind() 的结果
     state      cellState() 的结果：idle / working / ask / failed / off …
     openIntent 用户点的是「接入并打开/应用并重开」还是「只接入」
   返回值：open / reopen / defer / none
     open    没有活格，替用户开一格
     reopen  可以安全重开（首启/登录/空闲/已停止）
     defer   有真正的活或者用户明确说只接入 —— 不动进程
     none    只接入且没有活格 */
function agentReopenDecision(o) {
  o = o || {};
  if (!o.hasTab) return o.openIntent === false ? "none" : "open";
  if (o.openIntent === false) return "none";
  // 首启/登录/启动画面是**屏上的强证据**，不是猜测：这时杀掉重开是安全的。
  // 真正的任务页不会出现这些标记；若用户已经打字进入对话，标记就消失了，
  // 下面会按 working/ask 延后。标记表刻意不放单独的 DEEPSEEK_API_KEY 这类
  // 可能出现在普通终端输出里的弱词。
  if (o.setup) return "reopen";
  if (o.state === "working" || o.state === "ask") return "defer";
  return "reopen";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    AGENT_ROUTE_KEYS,
    AGENT_SETUP_MARKERS,
    agentMainModelField,
    agentGatewayOptions,
    agentModelOption,
    agentModelLabel,
    agentRouteView,
    agentSetupKind,
    agentReopenDecision,
  };
}
