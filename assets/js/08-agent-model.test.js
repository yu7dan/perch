"use strict";
/* 08-agent-model.js 的纯函数测试：从零开始的各种场景都必须是**同一套判断**。
   node --test assets/js/08-agent-model.test.js

   这里刻意不读本机探测结果：每条用例都是一台“想象中的机器”。 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_GROUPS, agentIntegrationView,
} = require("./08-agent-model.js");

const CAPS = (over) => Object.assign({
  launch: true, resume: true, resumeKind: "exact",
  status: true, waiting: true, mechanism: "hook",
}, over || {});

const CARD = (over) => Object.assign({
  id: "claude", name: "Claude Code", installed: true,
  caps: CAPS(), install: true, setup: false, windows: true,
  url: "https://example.test/docs",
}, over || {});

const MG = (state, known) => ({ state: state || "running", agentsKnown: known !== false });

const byKey = (v) => Object.fromEntries(v.steps.map((s) => [s.key, s]));

/* 一条“已经走完 1–6 步”的记录（网关另给）。 */
function coreRecord(over) {
  return Object.assign({
    steps: {
      detect: { state: "done", at: "2026-10-21T00:00:00Z" },
      install: { state: "done", at: "2026-10-21T00:00:00Z" },
      launch: { state: "done", at: "2026-10-21T00:01:00Z", verified: true, evidence: "pane=1" },
      auth: { state: "done", at: "2026-10-21T00:01:10Z", verified: true, source: "readiness:ready" },
      status: { state: "done", at: "2026-10-21T00:01:20Z", mechanism: "hook", verified: true },
      resume: { state: "done", at: "2026-10-21T00:00:00Z", mechanism: "exact", source: "adapter" },
    },
    readiness: "ready",
  }, over || {});
}

test("空机器：每个 agent 都是未检测到，主行动是安装", () => {
  const v = agentIntegrationView(CARD({ installed: false, path: "" }), null, null, MG("absent", false));
  assert.equal(v.group, "missing");
  assert.equal(v.complete, false);
  assert.equal(v.primary.action, "install");
  const s = byKey(v);
  assert.equal(s.detect.state, "todo");
  assert.equal(s.install.state, "todo");
  assert.equal(s.launch.state, "todo");
});

test("已安装没打开过：不是完整，主行动是打开", () => {
  const v = agentIntegrationView(CARD(), null, null, MG("running", false));
  assert.equal(v.group, "action");
  assert.equal(v.primary.action, "open");
  const s = byKey(v);
  assert.equal(s.detect.state, "done");
  assert.equal(s.install.state, "done");
  assert.equal(s.launch.state, "todo");
  assert.equal(s.auth.state, "todo");
  assert.equal(v.complete, false);
});

test("打开成功但还没登录/状态：下一步明确，不冒充完整", () => {
  const rec = {
    steps: { launch: { state: "done", verified: true, evidence: "pane=58" } },
    readiness: "needs-login",
  };
  const v = agentIntegrationView(CARD(), null, rec, MG("running", false));
  assert.equal(v.group, "action");
  assert.equal(v.primary.action, "open");
  assert.equal(v.primary.step, "auth");
  const s = byKey(v);
  assert.equal(s.launch.state, "done");
  assert.equal(s.auth.state, "todo");
  assert.equal(s.status.state, "todo");
  assert.equal(v.complete, false);
});

test("内置状态 + 网关都接好才算完整（网关）", () => {
  const rec = coreRecord({
    steps: Object.assign(coreRecord().steps, {
      gateway: { state: "done", mechanism: "magpie", verified: true },
    }),
  });
  const v = agentIntegrationView(CARD(), { id: "claude", wired: true }, rec, MG("running"));
  assert.equal(v.completeKind, "gateway");
  assert.equal(v.group, "complete");
  assert.equal(v.primary.action, "open");
});

test("网关明确不支持 + 其余全通 = 可用（原生），不是完整", () => {
  const rec = coreRecord();
  const v = agentIntegrationView(
    CARD({ id: "cursor", caps: CAPS({ title: true }) }),
    { id: "cursor", wired: false, connectable: false },
    rec, MG("running"));
  assert.equal(v.completeKind, "native");
  assert.equal(v.group, "native");
  assert.equal(v.complete, true);
  const s = byKey(v);
  assert.equal(s.gateway.state, "unsupported");
});

test("标题状态是弱信号：显示 title，不写成 hooks", () => {
  const card = CARD({ id: "agy", caps: CAPS({ resume: false, resumeKind: "", status: false, title: true, mechanism: "" }) });
  const rec = { steps: { launch: { state: "done", verified: true } }, readiness: "ready" };
  const v = agentIntegrationView(card, { id: "agy", wired: true }, rec, MG("running"));
  const s = byKey(v);
  assert.equal(s.status.state, "todo");
  assert.equal(s.status.mechanism, "title");
  assert.equal(s.status.noteKey, "agent.note.titleWaiting");
  assert.equal(s.resume.state, "unsupported");
  assert.equal(v.complete, false);
});

test("状态钩子可装时先装：不被“还没登录”挡住", () => {
  const card = CARD({ id: "agy", setup: true, caps: { launch: true, resume: true, resumeKind: "exact" } });
  const rec = { steps: { launch: { state: "done", verified: true } }, readiness: "needs-login" };
  const v = agentIntegrationView(card, { id: "agy", wired: false }, rec, MG("running"));
  assert.equal(v.primary.action, "setup");
  assert.equal(v.primary.step, "status");
  const s = byKey(v);
  assert.equal(s.status.mechanism, "hook");
  assert.equal(s.status.noteKey, "agent.note.statusSetup");
  assert.equal(v.group, "action");
});

test("没有状态源：打开之后是「仅启动」，带原因不静默", () => {
  const card = CARD({ id: "mystery", caps: { launch: true, status: false, resume: false } });
  const rec = { steps: { launch: { state: "done", verified: true } }, readiness: "ready" };
  const v = agentIntegrationView(card, { id: "mystery", wired: false }, rec, MG("running"));
  assert.equal(v.group, "launch");
  const s = byKey(v);
  assert.equal(s.status.state, "unsupported");
  assert.equal(s.status.noteKey, "agent.note.noStatusSource");
  assert.equal(s.resume.state, "unsupported");
});

test("未安装且 Perch 不能启动：nolaunch，不混进未检测到", () => {
  const v = agentIntegrationView(CARD({ installed: true, caps: { launch: false } }), null, null, MG("running", false));
  assert.equal(v.group, "nolaunch");
  assert.equal(v.primary.action, "docs");
});

test("magpie 没装：网关腿是『未运行』，主行动去设置，不是 agent 坏了", () => {
  const rec = coreRecord();
  const v = agentIntegrationView(CARD(), null, rec, MG("absent", false));
  assert.equal(v.group, "action");
  const s = byKey(v);
  assert.equal(s.gateway.state, "todo");
  assert.equal(s.gateway.noteKey, "agent.note.magpieAbsent");
  assert.equal(v.primary.action, "settings");
});

test("magpie 读到了但没有这个 agent：网关 unsupported，不假装能接", () => {
  const rec = coreRecord();
  const v = agentIntegrationView(CARD({ id: "pi" }), null, rec, MG("running", true));
  const s = byKey(v);
  assert.equal(s.gateway.state, "unsupported");
  assert.equal(s.gateway.noteKey, "agent.note.gatewayNotManaged");
});

test("分组互斥：任意场景只落在一个组里", () => {
  const cards = [
    CARD({ installed: false }),
    CARD({ installed: true, caps: { launch: false } }),
    CARD(),
    CARD({ id: "cursor", caps: CAPS({ title: true }) }),
    CARD({ id: "mystery", caps: { launch: true } }),
  ];
  const recs = [null, { steps: { launch: { state: "done" } } }, coreRecord()];
  const gws = [null, { wired: false }, { wired: true }, { wired: false, connectable: false }];
  for (const card of cards) {
    for (const rec of recs) {
      for (const gw of gws) {
        for (const m of [MG("absent", false), MG("running", false), MG("running", true)]) {
          const v = agentIntegrationView(card, gw, rec, m);
          assert.ok(AGENT_GROUPS.includes(v.group), `未知分组 ${v.group}`);
          assert.equal(v.steps.length, 7);
        }
      }
    }
  }
});

test("没有记录就永远不是完整：内置能力不等于已录入", () => {
  const v = agentIntegrationView(
    CARD({ id: "claude" }),
    { id: "claude", wired: true },
    null, MG("running"));
  assert.equal(v.complete, false);
  assert.notEqual(v.group, "complete");
});
