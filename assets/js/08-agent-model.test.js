"use strict";
/* 08-agent-model.js 的纯函数测试：一行只回答“装没装 / 走哪条路由 / 当前模型”。
   node --test assets/js/08-agent-model.test.js */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_SETUP_MARKERS, agentMainModelField, agentGatewayOptions, agentModelLabel,
  agentRouteView, agentSetupKind, agentReopenDecision,
} = require("./08-agent-model.js");

const CAPS = (over) => Object.assign({ launch: true }, over || {});
const CARD = (over) => Object.assign({
  id: "claude", name: "Claude Code", installed: true,
  caps: CAPS(), install: true, windows: true, url: "https://example.test/docs",
}, over || {});
const MG = (known) => ({ state: "running", agentsKnown: known !== false });
const OPT = (value, extra) => Object.assign({ value, label: value }, extra || {});
const FIELD = (value, options) => ({
  key: "model", label: "model", value,
  options: options || [],
});
const ROW = (over) => Object.assign({
  id: "claude", wired: false, source: "",
  fields: [FIELD("", [OPT("deepseek/flash", { ref: "deepseek/flash" })])],
}, over || {});

test("未安装：missing + install", () => {
  const v = agentRouteView(CARD({ installed: false }), null, MG(false));
  assert.equal(v.route, "missing");
  assert.equal(v.action, "install");
  assert.equal(v.canOpen, false);
});

test("装了但 Perch 没有终端适配：no-launch", () => {
  const v = agentRouteView(CARD({ caps: { launch: false } }), null, MG(false));
  assert.equal(v.route, "no-launch");
  assert.equal(v.action, "docs");
});

test("网关状态没读到：unknown，不冒充本机已配置", () => {
  const v = agentRouteView(CARD(), null, MG(false));
  assert.equal(v.route, "unknown");
  assert.equal(v.action, "open");
});

test("已接网关：gateway + 当前模型", () => {
  const row = ROW({ wired: true, fields: [FIELD("deepseek/flash", [OPT("deepseek/flash", { ref: "deepseek/flash" })])] });
  const v = agentRouteView(CARD(), row, MG(true));
  assert.equal(v.route, "gateway");
  assert.equal(v.modelLabel, "deepseek/flash");
  assert.equal(v.wired, true);
});

test("未接但有网关模型：unconfigured + connectable", () => {
  const v = agentRouteView(CARD(), ROW(), MG(true));
  assert.equal(v.route, "unconfigured");
  assert.equal(v.hasGatewayModels, true);
  assert.equal(v.connectable, true);
  assert.equal(v.modelLabel, "");
});

test("本机已有 source：native，不因为网关可接就改口", () => {
  const v = agentRouteView(CARD(), ROW({ source: "chatgpt" }), MG(true));
  assert.equal(v.route, "native");
});

test("本机已有自己的模型：native", () => {
  const row = ROW({ fields: [FIELD("gpt-5", [OPT("gpt-5", { direct: "OpenAI" }), OPT("deepseek/flash", { ref: "deepseek/flash" })])] });
  const v = agentRouteView(CARD(), row, MG(true));
  assert.equal(v.route, "native");
  assert.equal(v.modelLabel, "gpt-5");
});

test("magpie 明确不能接（Cursor）：native，不显示可接", () => {
  const row = ROW({ connectable: false, fields: [FIELD("auto", [OPT("auto")])] });
  const v = agentRouteView(CARD({ id: "cursor" }), row, MG(true));
  assert.equal(v.route, "native");
  assert.equal(v.hasGatewayModels, false);
  assert.equal(v.connectable, false);
});

test("magpie 读到了但没有这个 agent：native，不假装能接", () => {
  const v = agentRouteView(CARD({ id: "pi" }), null, MG(true));
  assert.equal(v.route, "native");
  assert.equal(v.hasGatewayModels, false);
});

test("当前值是网关模型但 wired=false：仍按网关路由（drift/半接）", () => {
  const row = ROW({ fields: [FIELD("deepseek/flash", [OPT("deepseek/flash", { ref: "deepseek/flash" })])] });
  const v = agentRouteView(CARD(), row, MG(true));
  assert.equal(v.route, "gateway");
});

test("主模型字段：优先带 ref 的字段，而不是死认 key=model", () => {
  const row = {
    fields: [
      { key: "auth", value: "x", options: [OPT("x")] },
      { key: "primary", value: "deepseek/flash", options: [OPT("deepseek/flash", { ref: "deepseek/flash" })] },
    ],
  };
  const f = agentMainModelField(row);
  assert.equal(f.key, "primary");
  assert.equal(agentGatewayOptions(f).length, 1);
  assert.equal(agentModelLabel(f, "deepseek/flash"), "deepseek/flash");
});

test("主模型字段：provider 型网关字段在前时仍选 model（Ante/Pencil）", () => {
  const row = {
    fields: [
      { key: "provider", value: "magpie", options: [OPT("magpie")] },
      { key: "model", value: "", options: [OPT("magpie/stepfun/step-1", { ref: "stepfun/step-1" })] },
    ],
  };
  const f = agentMainModelField(row);
  assert.equal(f.key, "model");
  assert.equal(agentGatewayOptions(f).length, 1);
});

test("主模型字段：没有 ref 的模型字段退在 provider 型字段之前", () => {
  const row = {
    fields: [
      { key: "provider", value: "", options: [OPT("magpie")] },
      { key: "model", value: "", options: [OPT("magpie/some/model")] },
    ],
  };
  assert.equal(agentMainModelField(row).key, "model");
});

test("ownMenu：模型在 agent 自己的菜单里选（ZCode / Cursor Private Inference）", () => {
  const v = agentRouteView(CARD({ id: "zcode" }), ROW({ id: "zcode", wired: true, menu: true, fields: [] }), MG(true));
  assert.equal(v.route, "gateway");
  assert.equal(v.ownMenu, true);
  assert.equal(v.hasGatewayModels, false);
});

test("输出不再包含七步/五条腿/完整度", () => {
  const v = agentRouteView(CARD(), ROW(), MG(true));
  assert.equal(v.steps, undefined);
  assert.equal(v.legs, undefined);
  assert.equal(v.complete, undefined);
  assert.equal(v.group, undefined);
});

test("首启标记：agy 的主题/条款/登录错误都认得出", () => {
  assert.equal(agentSetupKind("agy", ["Welcome to Antigravity CLI!", "Choose your color scheme:"]), "agy-color");
  assert.equal(agentSetupKind("agy", ["Terms of Service & Data Use", "I agree to help improve Antigravity CLI"]), "agy-tos");
  assert.equal(agentSetupKind("agy", ["Got an error: token exchange failed", "Press any key to go back."]), "agy-login");
  // 未接线的 agy 1.4.4 首屏：登录方式菜单（实测）。
  assert.equal(agentSetupKind("agy", [
    "Welcome to the Antigravity CLI. You are", "currently not signed in.",
    "Select login method:", "1. Google OAuth", "2. Use a Google Cloud project",
  ]), "agy-login");
  // 聊天里讨论 OAuth 不是登录页：标记要「标题 + 菜单项」同时出现。
  assert.equal(agentSetupKind("agy", ["How do I configure Google OAuth in my app?"]), "");
  assert.equal(agentSetupKind("agy", ["The error says Select login method but there is no menu"]), "");
  assert.equal(agentSetupKind("agy", [
    "Select login method:", "1. Google OAuth", "2. Use a Google Cloud project",
  ]), "agy-login");
});

test("首启标记：dsh 的中英引导/启动画面都认得出", () => {
  assert.equal(agentSetupKind("dsh", ["欢迎使用 dsh-TUI", "第 1 / 4 步", "还没检测到 DEEPSEEK_API_KEY"]), "dsh-onboarding");
  assert.equal(agentSetupKind("dsh", ["Welcome to dsh-TUI", "Step 1 / 4", "Esc to skip"]), "dsh-onboarding");
  assert.equal(agentSetupKind("dsh", ["DEEPSEEK HARNESS", "正在启动 DSH..."]), "dsh-starting");
  // 单独出现 DEEPSEEK_API_KEY 不当作首启页：普通终端输出/日志里完全可能有它。
  assert.equal(agentSetupKind("dsh", ["DEEPSEEK_API_KEY=sk-...", "some build output"]), "");
});

test("首启标记：不认识的 agent / 普通终端内容不误判", () => {
  assert.equal(agentSetupKind("claude", ["Choose your color scheme"]), "");
  assert.equal(agentSetupKind("agy", ["❯ explain this code"]), "");
  assert.equal(agentSetupKind("dsh", ["deepseek/deepseek-flash · max"]), "");
  assert.equal(agentSetupKind("agy", []), "");
  assert.ok(AGENT_SETUP_MARKERS.agy.length >= 3);
});

test("接线后动作：没有格子 → 替用户打开；只接入则不打开", () => {
  assert.equal(agentReopenDecision({ hasTab: false, openIntent: true }), "open");
  assert.equal(agentReopenDecision({ hasTab: false, openIntent: false }), "none");
});

test("接线后动作：首启/空闲/已停止 → 自动重开", () => {
  assert.equal(agentReopenDecision({ hasTab: true, setup: "agy-tos", state: "ask", openIntent: true }), "reopen");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "dsh-onboarding", state: "ask", openIntent: true }), "reopen");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "", state: "idle", openIntent: true }), "reopen");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "", state: "off", openIntent: true }), "reopen");
});

test("接线后动作：真正在干活/真正的 ask → 不动进程", () => {
  assert.equal(agentReopenDecision({ hasTab: true, setup: "", state: "working", openIntent: true }), "defer");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "", state: "ask", openIntent: true }), "defer");
  // 屏上是首启页/启动画面：即使 hook 还报 working，也是可安全重开的（不是任务页）。
  assert.equal(agentReopenDecision({ hasTab: true, setup: "agy-tos", state: "working", openIntent: true }), "reopen");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "dsh-starting", state: "working", openIntent: true }), "reopen");
  assert.equal(agentReopenDecision({ hasTab: true, setup: "", state: "idle", openIntent: false }), "none");
});
