"use strict";
/* 35-desk-models.js —— 模型：提供商（设置 › 模型）、每个 agent 的默认（设置 › Agents）、格头上那颗模型按钮。
   照定稿模拟（spec/desk 的模型选择器 / 设置那两节）。数据全在 Go（internal/providers）：这里只画视图、
   发改动，回来的永远是不含密钥的快照。

   格头上换模型「不用重启」的做法（Go 那边是 internal/relay 本机转发层）：
     · 这一格走提供商、要换到的也是提供商 —— 转发层就地改目标，下一个请求起生效，agent 进程不动；
     · 牵涉 agent 自己的登录（订阅 / 自带账号）—— 进程得按新配置起：同一个 paneId 接回原来那条会话
       重开这一格，对话接着；
     · 这一格正在干活：先记着（格头显示「→ 新模型」），这一轮跑完再换。 */

const PROV = { view: null, protocols: {}, efforts: [], req: 0, addPre: null, addQ: "", busy: null, flash: null };
// 厂商 / 中转站 / 本机服务（取自 magpie internal/provider/presets.go，MIT；零词元是模拟里就有的那家）
const MODEL_PRESETS = [{"id":"zerotoken","name":"零词元","kind":"relay","anthropic":"https://zzq.si","openai":"https://zzq.si/v1","responses":true,"site":"https://zzq.si","keys":"https://zzq.si/console/token"},{"id":"anthropic","name":"Anthropic","kind":"vendor","anthropic":"https://api.anthropic.com","site":"https://console.anthropic.com","keys":"https://console.anthropic.com/settings/keys"},{"id":"openai","name":"OpenAI","kind":"vendor","openai":"https://api.openai.com/v1","responses":true,"site":"https://platform.openai.com","keys":"https://platform.openai.com/api-keys"},{"id":"google","name":"Google Gemini","kind":"vendor","openai":"https://generativelanguage.googleapis.com/v1beta/openai","site":"https://aistudio.google.com","keys":"https://aistudio.google.com/apikey","note":"Gemini Developer API"},{"id":"deepseek","name":"DeepSeek","kind":"vendor","anthropic":"https://api.deepseek.com/anthropic","openai":"https://api.deepseek.com/v1","responses":true,"site":"https://platform.deepseek.com","keys":"https://platform.deepseek.com/api_keys"},{"id":"xai","name":"xAI","kind":"vendor","anthropic":"https://api.x.ai","openai":"https://api.x.ai/v1","responses":true,"site":"https://console.x.ai","keys":"https://console.x.ai"},{"id":"moonshot","name":"Kimi","kind":"vendor","anthropic":"https://api.moonshot.ai/anthropic","openai":"https://api.moonshot.ai/v1","site":"https://platform.moonshot.ai","keys":"https://platform.moonshot.ai/console/api-keys"},{"id":"moonshot-cn","name":"Kimi (China)","kind":"vendor","anthropic":"https://api.moonshot.cn/anthropic","openai":"https://api.moonshot.cn/v1","site":"https://platform.moonshot.cn","keys":"https://platform.moonshot.cn/console/api-keys"},{"id":"kimi-code","name":"Kimi Code","kind":"vendor","anthropic":"https://api.kimi.ai/coding","openai":"https://api.kimi.ai/coding/v1","site":"https://www.kimi.com/code","keys":"https://www.kimi.com/code/console","note":"Membership"},{"id":"kimi-code-cn","name":"Kimi Code (China)","kind":"vendor","anthropic":"https://api.kimi.com/coding","openai":"https://api.kimi.com/coding/v1","site":"https://www.kimi.com/code","keys":"https://www.kimi.com/code/console","note":"Membership"},{"id":"zhipu","name":"Zhipu GLM","kind":"vendor","anthropic":"https://open.bigmodel.cn/api/anthropic","openai":"https://open.bigmodel.cn/api/paas/v4","site":"https://open.bigmodel.cn","keys":"https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys"},{"id":"zai","name":"Z.ai","kind":"vendor","anthropic":"https://api.z.ai/api/anthropic","openai":"https://api.z.ai/api/paas/v4","site":"https://z.ai","keys":"https://z.ai/manage-apikey/apikey-list"},{"id":"minimax","name":"MiniMax","kind":"vendor","anthropic":"https://api.minimax.io/anthropic","openai":"https://api.minimax.io/v1","site":"https://platform.minimax.io","keys":"https://platform.minimax.io/user-center/basic-information/interface-key"},{"id":"minimax-cn","name":"MiniMax (China)","kind":"vendor","anthropic":"https://api.minimaxi.com/anthropic","openai":"https://api.minimaxi.com/v1","site":"https://platform.minimaxi.com","keys":"https://platform.minimaxi.com/user-center/basic-information/interface-key"},{"id":"stepfun","name":"StepFun","kind":"vendor","anthropic":"https://api.stepfun.ai/step_plan","openai":"https://api.stepfun.ai/step_plan/v1","site":"https://platform.stepfun.ai","keys":"https://platform.stepfun.ai/interface-key"},{"id":"stepfun-cn","name":"StepFun (China)","kind":"vendor","anthropic":"https://api.stepfun.com/step_plan","openai":"https://api.stepfun.com/step_plan/v1","site":"https://platform.stepfun.com","keys":"https://platform.stepfun.com/interface-key"},{"id":"xiaomi","name":"Xiaomi MiMo","kind":"vendor","anthropic":"https://token-plan-cn.xiaomimimo.com/anthropic","openai":"https://token-plan-cn.xiaomimimo.com/v1","responses":true,"site":"https://platform.xiaomimimo.com","keys":"https://platform.xiaomimimo.com/token-plan","note":"Token Plan · pay as you go"},{"id":"baidu-qianfan","name":"Baidu Qianfan","kind":"vendor","anthropic":"https://qianfan.baidubce.com/anthropic/tokenplan/personal","openai":"https://qianfan.baidubce.com/v2/tokenplan/personal","responses":true,"site":"https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6","keys":"https://console.bce.baidu.com/qianfan/resource/token-plan","note":"Token Plan · pay as you go"},{"id":"tencent-cloud","name":"Tencent Cloud","kind":"vendor","anthropic":"https://api.lkeap.cloud.tencent.com/plan/anthropic","openai":"https://api.lkeap.cloud.tencent.com/plan/v3","site":"https://cloud.tencent.com/document/product/1823/130060","keys":"https://console.cloud.tencent.com/tokenhub/tokenplan","note":"Token Plan · pay as you go"},{"id":"huaweicloud","name":"Huawei Cloud MaaS","kind":"vendor","anthropic":"https://api.modelarts-maas.com/plan/anthropic","openai":"https://api.modelarts-maas.com/plan/v2","site":"https://support.huaweicloud.com/Token-plan-maas/tokenplan-maas-0001.html","keys":"https://console.huaweicloud.com/modelarts/?#/model-studio/authmanage","note":"Token Plan · 西南-贵阳一"},{"id":"volcengine","name":"Volcengine Ark","kind":"vendor","anthropic":"https://ark.cn-beijing.volces.com/api/coding","openai":"https://ark.cn-beijing.volces.com/api/coding/v3","responses":true,"site":"https://www.volcengine.com/docs/82379/1925114","keys":"https://ark.volcengine.com/region:cn-beijing/apikey","note":"火山方舟 · Coding / Agent Plan"},{"id":"qwen","name":"Qwen","kind":"vendor","anthropic":"https://dashscope-intl.aliyuncs.com/apps/anthropic","openai":"https://dashscope-intl.aliyuncs.com/compatible-mode/v1","site":"https://modelstudio.console.alibabacloud.com","keys":"https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key","note":"DashScope · intl"},{"id":"qwen-cn","name":"Qwen (China)","kind":"vendor","anthropic":"https://dashscope.aliyuncs.com/apps/anthropic","openai":"https://dashscope.aliyuncs.com/compatible-mode/v1","site":"https://bailian.console.aliyun.com","keys":"https://bailian.console.aliyun.com/?tab=model#/api-key","note":"DashScope · China"},{"id":"qwen-token-plan","name":"Qwen Token Plan","kind":"vendor","anthropic":"https://token-plan.maas.qianwenaiapi.com/apps/anthropic","openai":"https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1","site":"https://platform.qianwenai.com/docs/token-plan/overview","keys":"https://platform.qianwenai.com/home/analytics/token-plan/individual","note":"Qwen AI platform · subscription"},{"id":"bailian-token-plan","name":"Bailian Token Plan","kind":"vendor","anthropic":"https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic","openai":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1","site":"https://help.aliyun.com/zh/model-studio/token-plan-overview","keys":"https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal","note":"Alibaba Cloud Bailian · subscription"},{"id":"mistral","name":"Mistral","kind":"vendor","openai":"https://api.mistral.ai/v1","site":"https://console.mistral.ai","keys":"https://console.mistral.ai/api-keys"},{"id":"groq","name":"Groq","kind":"vendor","openai":"https://api.groq.com/openai/v1","responses":true,"site":"https://console.groq.com","keys":"https://console.groq.com/keys"},{"id":"ollama-cloud","name":"Ollama Cloud","kind":"vendor","anthropic":"https://ollama.com","openai":"https://ollama.com/v1","site":"https://docs.ollama.com/cloud","keys":"https://ollama.com/settings/keys","note":"cloud models, with an API key"},{"id":"nous","name":"Nous Portal","kind":"vendor","openai":"https://inference-api.nousresearch.com/v1","site":"https://portal.nousresearch.com","keys":"https://portal.nousresearch.com","note":"Nous Research · Hermes and other models"},{"id":"openrouter","name":"OpenRouter","kind":"relay","anthropic":"https://openrouter.ai/api","openai":"https://openrouter.ai/api/v1","site":"https://openrouter.ai","keys":"https://openrouter.ai/keys"},{"id":"opencode-go","name":"OpenCode Go","kind":"relay","anthropic":"https://opencode.ai/zen/go","openai":"https://opencode.ai/zen/go/v1","responses":true,"site":"https://opencode.ai/docs/go","keys":"https://opencode.ai/auth","note":"open coding models, $10/month"},{"id":"clinepass","name":"ClinePass","kind":"relay","openai":"https://api.cline.bot/api/v1","site":"https://docs.cline.bot/getting-started/clinepass","keys":"https://app.cline.bot","note":"open coding models, $9.99/month"},{"id":"opencode-zen","name":"OpenCode Zen","kind":"relay","anthropic":"https://opencode.ai/zen","openai":"https://opencode.ai/zen/v1","responses":true,"site":"https://opencode.ai/docs/zen","keys":"https://opencode.ai/auth"},{"id":"kilo","name":"Kilo Gateway","kind":"relay","openai":"https://api.kilo.ai/api/openrouter","site":"https://kilo.ai/docs/gateway","keys":"https://app.kilo.ai","note":"free models with no key"},{"id":"commandcode","name":"Command Code","kind":"relay","anthropic":"https://api.commandcode.ai/provider","openai":"https://api.commandcode.ai/provider/v1","responses":true,"site":"https://commandcode.ai/docs/provider","keys":"https://commandcode.ai/settings/keys"},{"id":"together","name":"Together AI","kind":"relay","openai":"https://api.together.xyz/v1","site":"https://api.together.ai","keys":"https://api.together.ai/settings/api-keys"},{"id":"fireworks","name":"Fireworks","kind":"relay","openai":"https://api.fireworks.ai/inference/v1","site":"https://fireworks.ai","keys":"https://app.fireworks.ai/settings/users/api-keys"},{"id":"siliconflow","name":"SiliconFlow","kind":"relay","openai":"https://api.siliconflow.cn/v1","site":"https://cloud.siliconflow.cn","keys":"https://cloud.siliconflow.cn/account/ak"},{"id":"nvidia","name":"NVIDIA NIM","kind":"relay","openai":"https://integrate.api.nvidia.com/v1","site":"https://build.nvidia.com","keys":"https://build.nvidia.com/settings/api-keys"},{"id":"modelscope","name":"ModelScope","kind":"relay","openai":"https://api-inference.modelscope.cn/v1","responses":true,"site":"https://modelscope.cn/docs/model-service/API-Inference/intro","keys":"https://modelscope.cn/my/myaccesstoken","note":"魔搭 · API-Inference"},{"id":"aihubmix","name":"AiHubMix","kind":"relay","anthropic":"https://aihubmix.com","openai":"https://aihubmix.com/v1","site":"https://aihubmix.com","keys":"https://console.aihubmix.com/token"},{"id":"pipellm","name":"PipeLLM","kind":"relay","anthropic":"https://api.pipellm.ai","openai":"https://api.pipellm.ai/openai/v1","responses":true,"site":"https://www.pipellm.ai","keys":"https://console.pipellm.ai"},{"id":"302ai","name":"302.AI","kind":"relay","anthropic":"https://api.302.ai","openai":"https://api.302.ai/v1","site":"https://302.ai","keys":"https://302.ai/api-keys/list"},{"id":"cherryin","name":"CherryIN","kind":"relay","anthropic":"https://open.cherryin.ai","openai":"https://open.cherryin.ai/v1","responses":true,"site":"https://open.cherryin.ai","keys":"https://open.cherryin.ai/console/token"},{"id":"yylx","name":"鱼鱼连线","kind":"relay","anthropic":"https://app.yylx.io","openai":"https://app.yylx.io/v1","site":"https://yylx.io","keys":"https://app.yylx.io/keys"},{"id":"ollama","name":"Ollama","kind":"local","anthropic":"http://localhost:11434","openai":"http://localhost:11434/v1","site":"https://ollama.com","note":"your local models"},{"id":"lmstudio","name":"LM Studio","kind":"local","openai":"http://localhost:1234/v1","site":"https://lmstudio.ai","note":"local server, port 1234 by default"}];
// agent 自己的登录能选的模型（Claude Code 认这几个别名；别的 agent 用它自己的默认）
const OWN_MODELS = { claude: ["opus", "sonnet", "haiku"] };
const OWN_LABEL = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
const provList = () => (PROV.view && PROV.view.providers) || [];
const provById = (id) => provList().find((p) => p.id === id) || null;
const agentCfg = (id) => (PROV.view && PROV.view.agents && PROV.view.agents[id]) || {};
const MODEL_AGENTS = ["claude", "codex", "pi", "opencode"];
function provFits(p, agentId) {
  const ps = PROV.protocols[agentId] || [];
  if (!ps.length) return { ok: false, why: `Perch 还不能替 ${ag(agentId).name} 接提供商` };
  if (agentId === "claude" && !p.anthropic) return { ok: false, why: "Claude Code 只认 Anthropic 接口，这家没有" };
  if (agentId === "codex" && !p.openai) return { ok: false, why: "Codex 只认 OpenAI Responses 接口，这家没有" };
  return { ok: true, why: "" };
}
function applyProviders(m) {
  PROV.view = m.view || { providers: [], agents: {} };
  PROV.protocols = m.protocols || {};
  PROV.efforts = m.efforts || [];
  // 启动时提供商快照还没到就起的格子：现在补上它起的时候用的那套默认
  for (const { l } of allLeaves()) { if (l.boot === "pending") l.boot = agentDefaultModel(l.agent); l.v++; }
  deskSoon("提供商");
  if (!qs("#set").hidden && (SET.sec === "models" || SET.sec === "agents")) renderSettings();
}
function provResult(m) {
  if (!m.ok) { toast((m.op === "provider.delete" ? "删除没成：" : "没保存上：") + (m.err || ""), "warn"); PROV.busy = null; }
  else if (m.op === "provider.delete") toast("已删除提供商");
  else if (m.op === "agent.config.set") { PROV.flash = "ag-" + m.id; setTimeout(() => { PROV.flash = null; }, 1500); }
  else if (m.op === "provider.save") { PROV.flash = m.id; if (PROV.busy) PROV.busy.id = m.id; setTimeout(() => { PROV.flash = null; }, 1500); }
  if (!qs("#set").hidden) renderSettings();
}
// 保存后 Go 顺手测一次连接：拿到模型列表，告诉你它能接哪种接口
function provTestResult(m) {
  const p = provById(m.id);
  const name = (p && p.name) || m.id;
  if (PROV.busy && PROV.busy.id === m.id) PROV.busy = null;
  if (m.ok) {
    const proto = p ? ["Anthropic", "OpenAI"].map((x) => x + ((x === "Anthropic" ? p.anthropic : p.openai) ? " ✓" : " ✗")).join(" · ") : "";
    toast(`已添加 ${name}：${proto}，${m.models | 0} 个模型${m.via === "proxy" ? "（走系统代理）" : ""}`);
  } else toast(`${name} 连不上：${m.err || "测试失败"} —— 地址和 key 再看一眼`, "warn");
  if (!qs("#set").hidden) renderSettings();
}

/* ---------- 模型选择器（格头 / 设置 › Agents 共用） ---------- */
let MP_CB = null;
function modelGroups(agentId) {
  const out = [];
  out.push({ prov: "own", name: `${ag(agentId).name} 自己的登录`, models: OWN_MODELS[agentId] || [""] });
  for (const p of provList()) {
    const f = provFits(p, agentId);
    out.push({ prov: p.id, name: p.name, models: p.models && p.models.length ? p.models : [""], why: f.ok ? "" : f.why });
  }
  return out;
}
const modelLabel = (prov, model) => model ? (OWN_LABEL[model] || model) : prov === "own" || !prov ? "默认模型" : `${(provById(prov) || {}).name || prov} 的默认`;
function openModelPicker(anchor, agentId, cur, cb) {
  const mp = qs("#mp");
  const curKey = (cur.provider || "own") + "|" + (cur.model || "");
  mp.innerHTML = modelGroups(agentId).map((g) => `<div class="grp-h">${esc(g.name)}${g.why ? `<em>· ${esc(g.why)}</em>` : ""}</div>`
    + g.models.map((m) => { const k = g.prov + "|" + m; return `<button class="mi${k === curKey ? " on" : ""}${g.why ? " na" : ""}" data-mpick="${esc(m)}" data-mprov="${esc(g.prov)}"${g.why ? ` data-na="${esc(g.why)}"` : ""}>${esc(m ? (OWN_LABEL[m] || m) : g.prov === "own" ? "它自己的默认" : "这家的默认模型")}${k === curKey ? `<span class="ic">${ICON("check", 14)}</span>` : ""}</button>`; }).join("")).join("")
    + (provList().length ? "" : `<div class="pp-note">还没有提供商。设置 › 模型 里加一个（官方、中转站、本地都行），每个 agent 都能选。</div>`);
  MP_CB = cb;
  mp.hidden = false;
  const r = anchor.getBoundingClientRect(), w = mp.offsetWidth, h = mp.offsetHeight;
  mp.style.left = clampN(r.right - w, 12, innerWidth - w - 12) + "px";
  mp.style.top = (r.bottom + 6 + h < innerHeight - 12 ? r.bottom + 6 : Math.max(12, r.top - h - 6)) + "px";
}

/* ---------- 格头上那颗模型按钮 ---------- */
// 这一格现在用的：自己选过的 > agent 的默认配置 > 它自己的登录
function agentDefaultModel(id) { const c = agentCfg(id); return { provider: c.provider || "own", model: c.model || "" }; }
function leafModel(l) {
  if (l.provider || l.model) return { provider: l.provider || "own", model: l.model || "" };
  return l.boot && l.boot !== "pending" ? l.boot : agentDefaultModel(l.agent);
}
LEAF_CTL.push((l) => {
  if (!l.tab || !(PROV.protocols[l.agent] || []).length) return "";
  const cur = leafModel(l);
  const label = l.pend ? "→ " + modelLabel(l.pend.provider, l.pend.model) : modelLabel(cur.provider, cur.model);
  return `<button class="md${l.pend ? " pend" : ""}" data-tmodel data-leaf="${l.id}" title="换模型：不用重启">${esc(label)}</button>`;
});
function setLeafModel(z, l, provider, model) {
  const cur = leafModel(l);
  if ((cur.provider || "own") === (provider || "own") && (cur.model || "") === (model || "")) { l.pend = null; l.v++; render(); return; }
  if (leafState(l) === "work") {
    l.pend = { provider, model }; l.v++; render();
    toast(`下一轮起用 ${modelLabel(provider, model)} —— 不用重启，对话接着走`);
    return;
  }
  applyLeafModel(z, l, provider, model);
}
let MODEL_REQ = 0;
const modelWait = new Map();
function applyLeafModel(z, l, provider, model) {
  l.pend = null;
  const T = l.tab;
  if (!T || !T.paneID) return;
  const req = ++MODEL_REQ;
  modelWait.set(req, { z, l, provider, model, from: leafModel(l) });
  sendCtrl({ type: "pane.model", req, pane: T.paneID, agentId: l.agent, providerId: provider, model });
}
function applyPaneModel(m) {
  const w = modelWait.get(m.req);
  modelWait.delete(m.req);
  if (!w) return;
  const { l, provider, model } = w;
  if (m.err) { toast(`换不了：${m.err}`, "warn"); l.v++; render(); return; }
  l.provider = provider; l.model = model; l.v++;
  if (m.mode === "relay") {
    toast(`已换成 ${modelLabel(provider, model)} —— 不用重启，下一句话就用它`);
  } else {
    // 牵涉 agent 自己的登录：同一个 paneId 接回原来那条会话重开这一格（对话接着）
    reseatLeaf(l);
    toast(`换成 ${modelLabel(provider, model)} —— 这一格接着原来的对话重开了一下`);
  }
  render(); saveLayout();
}
// 干活中的格子：这一轮跑完（不在干活了）再换
AFTER_RENDER.push(() => {
  for (const { z, l } of allLeaves()) if (l.pend && l.tab && leafState(l) !== "work") applyLeafModel(z, l, l.pend.provider, l.pend.model);
});

/* ---------- 设置 › 模型 ---------- */
const PRESET_KIND = { relay: "中转站", vendor: "官方", local: "本机" };
function modelsSecHTML() {
  const pre = PROV.addPre && (PROV.addPre === "custom" ? { id: "custom", name: "自定义", custom: true } : MODEL_PRESETS.find((p) => p.id === PROV.addPre));
  const q = PROV.addQ.trim().toLowerCase();
  const have = new Set(provList().map((p) => p.name));
  const presets = MODEL_PRESETS.filter((p) => !have.has(p.name) && (!q || p.name.toLowerCase().includes(q) || p.id.includes(q)))
    .sort((a, b) => ["relay", "vendor", "local"].indexOf(a.kind) - ["relay", "vendor", "local"].indexOf(b.kind));
  return `<h2>模型</h2><p class="sub">加一次提供商（官方、中转站、本地都行），每个 agent 都能选。key 只存在本机（Windows 加密）。</p>`
    + provList().map((p) => `<div class="prov${PROV.flash === p.id ? " srow flash" : ""}"><div class="pm"><b>${esc(p.name)}</b><span>${[p.anthropic && "Anthropic", p.openai && "OpenAI"].filter(Boolean).map((x) => `<span class="tag k">${x}</span>`).join("")} ${p.hasKey ? "key ··" + esc(p.keyHint || "") : "没填 key"} · ${p.models && p.models.length ? p.models.length + " 个模型" : "还没测到模型"}</span></div>`
      + `<span class="sp"></span><button class="btn" data-provtest="${esc(p.id)}">${PROV.busy && PROV.busy.id === p.id ? "检测中…" : "重新检测"}</button><button class="btn" data-provrm="${esc(p.id)}">${ICON("trash-2", 13)}删除</button></div>`).join("")
    + (pre ? `<div class="pform"><b style="font-size:12.5px;white-space:nowrap">${esc(pre.name)}</b>${pre.custom ? `<input id="pf-url" class="inp" placeholder="地址：照它文档里写的粘进来" spellcheck="false">` : ""}`
      + `<input id="pf-key" class="inp" type="password" placeholder="API key" spellcheck="false" autocomplete="off"><button class="btn pri" data-provsave>${PROV.busy ? "检测中…" : "检测并保存"}</button><button class="btn" data-provcancel>取消</button></div>`
      + (pre.keys ? `<div class="pp-note" style="padding-left:0">key 在这里拿：<button class="lnk" data-openurl="${esc(pre.keys)}">${esc(pre.keys)}</button></div>` : "")
      : `<div class="pp-sec" style="padding-left:0;margin-top:14px;display:flex;align-items:center;gap:10px">添加提供商<input class="inp" data-provq value="${esc(PROV.addQ)}" placeholder="搜一下" spellcheck="false" style="width:180px"></div>`
        + `<div class="pre-g">${presets.map((p) => `<button class="pre" data-pre="${p.id}"><b>${esc(p.name)}</b><span>${PRESET_KIND[p.kind] || ""} · ${[p.anthropic && "Anthropic", p.openai && (p.responses ? "OpenAI / Responses" : "OpenAI")].filter(Boolean).join(" / ")}</span></button>`).join("")}`
        + `<button class="pre" data-pre="custom"><b>自定义</b><span>中转站文档给的地址</span></button></div>`);
}
function saveProvider() {
  if (PROV.busy) return;
  const pre = PROV.addPre === "custom" ? { custom: true } : MODEL_PRESETS.find((p) => p.id === PROV.addPre);
  const key = (qs("#pf-key") || {}).value || "";
  const url = ((qs("#pf-url") || {}).value || "").trim().replace(/\/+$/, "");
  if (pre.custom && !url) { toast("先把地址粘进来", "warn"); return; }
  if (!key.trim() && pre.kind !== "local") { toast("先填 API key", "warn"); qs("#pf-key").focus(); return; }
  // 自定义地址：以 /v1 结尾的当 OpenAI 兼容，否则当 Anthropic 的根地址（两种都填上，检测时会说清楚哪个能用）
  const input = pre.custom
    ? { name: url.replace(/^https?:\/\//, "").split(/[/:]/)[0], anthropic: /\/v1$/.test(url) ? url.replace(/\/v1$/, "") : url, openai: /\/v1$/.test(url) ? url : url + "/v1", key: key.trim() }
    : { name: pre.name, anthropic: pre.anthropic || "", openai: pre.openai || "", key: key.trim() };
  PROV.busy = { id: "" };
  PROV.addPre = null;
  sendCtrl({ type: "provider.save", req: ++PROV.req, provider: input });
  renderSettings();
}

/* ---------- 设置 › Agents ---------- */
function agentsSecHTML() {
  const efforts = PROV.efforts.length ? PROV.efforts : ["low", "medium", "high", "max"];
  const rows = MODEL_AGENTS.map((id) => ag(id)).filter((a) => a.installed);
  return `<h2>Agents</h2><p class="sub">新开一格时默认用哪个模型、推理多强。已经在跑的格子，点它右上角的模型随时换，不用重启。这里只列装好的；别的 agent 在开格子时选到就能就地下载。</p>`
    + rows.map((a) => {
      const c = agentCfg(a.id), cur = { provider: c.provider || "own", model: c.model || "" };
      const provName = cur.provider === "own" ? `${agShort(a)} 自己的登录` : ((provById(cur.provider) || {}).name || "");
      const effOK = a.id === "claude" || a.id === "codex";
      return `<div class="arow${PROV.flash === "ag-" + a.id ? " srow flash" : ""}">${logo(a.id)}<b>${esc(a.name)}</b>`
        + `<button class="mbtn" data-amodel="${a.id}">${esc(modelLabel(cur.provider, cur.model))}<em>${esc(provName)}</em><span class="ic">${ICON("chevron-down", 14)}</span></button><span class="sp"></span>`
        + (effOK ? `<div class="seg">${efforts.map((v) => `<button data-effort="${a.id}" data-v="${v}" class="${(c.effort || "") === v ? "on" : ""}">${v}</button>`).join("")}</div>` : `<span class="pp-note" style="padding:0">推理强度它自己定</span>`)
        + `</div>`;
    }).join("");
}
function saveAgentCfg(id, patch) {
  const c = agentCfg(id);
  const cfg = Object.assign({ provider: c.provider || "", model: c.model || "", effort: c.effort || "" }, patch);
  if (cfg.provider === "own") cfg.provider = "";
  sendCtrl({ type: "agent.config.set", req: ++PROV.req, agentId: id, config: cfg });
}

/* ---------- 点击 ---------- */
CLICKS.unshift((t) => {
  const mp = t.closest("#mp [data-mpick]");
  if (mp) {
    if (mp.dataset.na) { toast(mp.dataset.na, "warn"); return true; }
    const cb = MP_CB; qs("#mp").hidden = true; MP_CB = null;
    if (cb) cb(mp.dataset.mprov, mp.dataset.mpick);
    return true;
  }
  const tm = t.closest("[data-tmodel]");
  if (tm) {
    const x = allLeaves().find((y) => y.l.id === tm.dataset.leaf);
    if (x) openModelPicker(tm, x.l.agent, x.l.pend || leafModel(x.l), (prov, model) => setLeafModel(x.z, x.l, prov, model));
    return true;
  }
  if (!t.closest("#set")) return false;
  const b = t.closest("[data-pre],[data-provsave],[data-provcancel],[data-provrm],[data-provtest],[data-amodel],[data-effort],[data-openurl]");
  if (!b) return false;
  const d = b.dataset;
  if (d.pre) { PROV.addPre = d.pre; renderSettings(); setTimeout(() => { const i = qs("#pf-url") || qs("#pf-key"); if (i) i.focus(); }, 30); }
  else if (b.hasAttribute("data-provcancel")) { PROV.addPre = null; renderSettings(); }
  else if (b.hasAttribute("data-provsave")) saveProvider();
  else if (d.provtest) { PROV.busy = { id: d.provtest }; sendCtrl({ type: "provider.test", req: ++PROV.req, id: d.provtest }); renderSettings(); }
  else if (d.provrm) { const p = provById(d.provrm); deskConfirm(`删除提供商「${p ? p.name : ""}」？`, "用着它的 agent 会回到它自己的登录；key 一起删掉。", "删除").then((ok) => { if (ok) sendCtrl({ type: "provider.delete", req: ++PROV.req, id: d.provrm }); }); }
  else if (d.amodel) {
    const c = agentCfg(d.amodel);
    openModelPicker(b, d.amodel, { provider: c.provider || "own", model: c.model || "" }, (prov, model) => {
      saveAgentCfg(d.amodel, { provider: prov, model });
      toast(`${ag(d.amodel).name} 新开的格子默认用 ${modelLabel(prov, model)}`);
    });
  } else if (d.effort) saveAgentCfg(d.effort, { effort: d.v });
  else if (d.openurl) sendCtrl({ type: "open.url", url: d.openurl });
  return true;
});
document.addEventListener("input", (e) => {
  if (e.target.matches && e.target.matches("[data-provq]")) {
    PROV.addQ = e.target.value;
    const pos = e.target.selectionStart;
    renderSettings();
    const i = qs("[data-provq]"); if (i) { i.focus(); i.setSelectionRange(pos, pos); }
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing && e.target.matches && e.target.matches("#pf-key,#pf-url")) { e.preventDefault(); saveProvider(); }
});
POPS.push("#mp");
// 提供商快照：ctl 通道一通就要一份（格头的模型按钮、设置都读它）
AFTER_RENDER.push(() => { if (!PROV.asked && ctlReady) { PROV.asked = true; sendCtrl({ type: "providers.get" }); } });
