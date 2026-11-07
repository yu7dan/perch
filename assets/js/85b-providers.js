"use strict";
/* 设置 › 模型提供商 / Agents（2026-10-28 取代内嵌 magpie 网关；2026-10-31 照 magpie 重做）。

   提供商：
     · 「添加提供商」打开一张清单：从现有配置导入 / 官方厂商 / 中转站 / 本机服务 / 自定义。
       清单的厂商和中转站地址取自 magpie 的 presets.go（MIT）。
     · 自定义（中转站文档给的地址）：只贴一个地址，「检测」把 Anthropic / OpenAI Chat /
       OpenAI Responses 三种接口各试一次，告诉你哪种能用、能给哪些 agent，再列出模型让你勾选。
     · key 和环境变量的值**只写不读**（DPAPI 加密），存过只显示「已保存 · 末四位」。
   Agents：每个 agent 一行 —— 现在实际在用什么、主模型（统一选择器）、推理强度、
     Claude 的档位（Opus / Sonnet / Haiku / 子代理，默认跟主模型）、高级里的环境变量。
     改了立刻保存，新开的格子生效；已开的格子在格子头上换（85c-models.js）。
   数据都在 Go（internal/providers）：这里只画视图、发改动，回来的永远是不含密钥的快照。 */

const PROV = {
  view: null,          // { providers: [...], agents: {id: {...}} }
  protocols: {},       // agent id → ["anthropic"|"openai", ...]；空 = 只能写环境变量
  efforts: [],
  own: {},             // agent id → { base, model, importable }：agent 自己的配置里写的（不含 key）
  adding: false,       // 添加清单开着
  addQ: "",            // 清单的搜索
  addMore: {},         // kind → 展开全部
  draft: null,         // 正在新建 / 编辑的提供商（见 provDraftFrom）
  err: "",             // 编辑表单的错误
  tests: {},           // provider id → { busy, ok, msg }
  agentErr: {},        // agent id → 错误
  openTiers: {},       // agent id → 档位展开
  openAdv: {},         // agent id → 高级展开
  req: 0,
  flashAgent: "",      // 从总览 / 新建卡跳过来时要闪一下的那一行
};

// 厂商 / 中转站 / 本机服务（取自 magpie internal/provider/presets.go，MIT）。
// openai = Chat Completions 的根地址；responses = 同一个地址也提供 Responses（Codex 要它）。
const PROV_PRESETS = [{"id":"anthropic","name":"Anthropic","kind":"vendor","anthropic":"https://api.anthropic.com","site":"https://console.anthropic.com","keys":"https://console.anthropic.com/settings/keys"},{"id":"openai","name":"OpenAI","kind":"vendor","openai":"https://api.openai.com/v1","responses":true,"site":"https://platform.openai.com","keys":"https://platform.openai.com/api-keys"},{"id":"google","name":"Google Gemini","kind":"vendor","openai":"https://generativelanguage.googleapis.com/v1beta/openai","site":"https://aistudio.google.com","keys":"https://aistudio.google.com/apikey","note":"Gemini Developer API"},{"id":"deepseek","name":"DeepSeek","kind":"vendor","anthropic":"https://api.deepseek.com/anthropic","openai":"https://api.deepseek.com/v1","responses":true,"site":"https://platform.deepseek.com","keys":"https://platform.deepseek.com/api_keys"},{"id":"xai","name":"xAI","kind":"vendor","anthropic":"https://api.x.ai","openai":"https://api.x.ai/v1","responses":true,"site":"https://console.x.ai","keys":"https://console.x.ai"},{"id":"moonshot","name":"Kimi","kind":"vendor","anthropic":"https://api.moonshot.ai/anthropic","openai":"https://api.moonshot.ai/v1","site":"https://platform.moonshot.ai","keys":"https://platform.moonshot.ai/console/api-keys"},{"id":"moonshot-cn","name":"Kimi (China)","kind":"vendor","anthropic":"https://api.moonshot.cn/anthropic","openai":"https://api.moonshot.cn/v1","site":"https://platform.moonshot.cn","keys":"https://platform.moonshot.cn/console/api-keys"},{"id":"kimi-code","name":"Kimi Code","kind":"vendor","anthropic":"https://api.kimi.ai/coding","openai":"https://api.kimi.ai/coding/v1","site":"https://www.kimi.com/code","keys":"https://www.kimi.com/code/console","note":"Membership"},{"id":"kimi-code-cn","name":"Kimi Code (China)","kind":"vendor","anthropic":"https://api.kimi.com/coding","openai":"https://api.kimi.com/coding/v1","site":"https://www.kimi.com/code","keys":"https://www.kimi.com/code/console","note":"Membership"},{"id":"zhipu","name":"Zhipu GLM","kind":"vendor","anthropic":"https://open.bigmodel.cn/api/anthropic","openai":"https://open.bigmodel.cn/api/paas/v4","site":"https://open.bigmodel.cn","keys":"https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys"},{"id":"zai","name":"Z.ai","kind":"vendor","anthropic":"https://api.z.ai/api/anthropic","openai":"https://api.z.ai/api/paas/v4","site":"https://z.ai","keys":"https://z.ai/manage-apikey/apikey-list"},{"id":"minimax","name":"MiniMax","kind":"vendor","anthropic":"https://api.minimax.io/anthropic","openai":"https://api.minimax.io/v1","site":"https://platform.minimax.io","keys":"https://platform.minimax.io/user-center/basic-information/interface-key"},{"id":"minimax-cn","name":"MiniMax (China)","kind":"vendor","anthropic":"https://api.minimaxi.com/anthropic","openai":"https://api.minimaxi.com/v1","site":"https://platform.minimaxi.com","keys":"https://platform.minimaxi.com/user-center/basic-information/interface-key"},{"id":"stepfun","name":"StepFun","kind":"vendor","anthropic":"https://api.stepfun.ai/step_plan","openai":"https://api.stepfun.ai/step_plan/v1","site":"https://platform.stepfun.ai","keys":"https://platform.stepfun.ai/interface-key"},{"id":"stepfun-cn","name":"StepFun (China)","kind":"vendor","anthropic":"https://api.stepfun.com/step_plan","openai":"https://api.stepfun.com/step_plan/v1","site":"https://platform.stepfun.com","keys":"https://platform.stepfun.com/interface-key"},{"id":"xiaomi","name":"Xiaomi MiMo","kind":"vendor","anthropic":"https://token-plan-cn.xiaomimimo.com/anthropic","openai":"https://token-plan-cn.xiaomimimo.com/v1","responses":true,"site":"https://platform.xiaomimimo.com","keys":"https://platform.xiaomimimo.com/token-plan","note":"Token Plan · pay as you go"},{"id":"baidu-qianfan","name":"Baidu Qianfan","kind":"vendor","anthropic":"https://qianfan.baidubce.com/anthropic/tokenplan/personal","openai":"https://qianfan.baidubce.com/v2/tokenplan/personal","responses":true,"site":"https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6","keys":"https://console.bce.baidu.com/qianfan/resource/token-plan","note":"Token Plan · pay as you go"},{"id":"tencent-cloud","name":"Tencent Cloud","kind":"vendor","anthropic":"https://api.lkeap.cloud.tencent.com/plan/anthropic","openai":"https://api.lkeap.cloud.tencent.com/plan/v3","site":"https://cloud.tencent.com/document/product/1823/130060","keys":"https://console.cloud.tencent.com/tokenhub/tokenplan","note":"Token Plan · pay as you go"},{"id":"huaweicloud","name":"Huawei Cloud MaaS","kind":"vendor","anthropic":"https://api.modelarts-maas.com/plan/anthropic","openai":"https://api.modelarts-maas.com/plan/v2","site":"https://support.huaweicloud.com/Token-plan-maas/tokenplan-maas-0001.html","keys":"https://console.huaweicloud.com/modelarts/?#/model-studio/authmanage","note":"Token Plan · 西南-贵阳一"},{"id":"volcengine","name":"Volcengine Ark","kind":"vendor","anthropic":"https://ark.cn-beijing.volces.com/api/coding","openai":"https://ark.cn-beijing.volces.com/api/coding/v3","responses":true,"site":"https://www.volcengine.com/docs/82379/1925114","keys":"https://ark.volcengine.com/region:cn-beijing/apikey","note":"火山方舟 · Coding / Agent Plan"},{"id":"qwen","name":"Qwen","kind":"vendor","anthropic":"https://dashscope-intl.aliyuncs.com/apps/anthropic","openai":"https://dashscope-intl.aliyuncs.com/compatible-mode/v1","site":"https://modelstudio.console.alibabacloud.com","keys":"https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key","note":"DashScope · intl"},{"id":"qwen-cn","name":"Qwen (China)","kind":"vendor","anthropic":"https://dashscope.aliyuncs.com/apps/anthropic","openai":"https://dashscope.aliyuncs.com/compatible-mode/v1","site":"https://bailian.console.aliyun.com","keys":"https://bailian.console.aliyun.com/?tab=model#/api-key","note":"DashScope · China"},{"id":"qwen-token-plan","name":"Qwen Token Plan","kind":"vendor","anthropic":"https://token-plan.maas.qianwenaiapi.com/apps/anthropic","openai":"https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1","site":"https://platform.qianwenai.com/docs/token-plan/overview","keys":"https://platform.qianwenai.com/home/analytics/token-plan/individual","note":"Qwen AI platform · subscription"},{"id":"bailian-token-plan","name":"Bailian Token Plan","kind":"vendor","anthropic":"https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic","openai":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1","site":"https://help.aliyun.com/zh/model-studio/token-plan-overview","keys":"https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal","note":"Alibaba Cloud Bailian · subscription"},{"id":"mistral","name":"Mistral","kind":"vendor","openai":"https://api.mistral.ai/v1","site":"https://console.mistral.ai","keys":"https://console.mistral.ai/api-keys"},{"id":"groq","name":"Groq","kind":"vendor","openai":"https://api.groq.com/openai/v1","responses":true,"site":"https://console.groq.com","keys":"https://console.groq.com/keys"},{"id":"ollama-cloud","name":"Ollama Cloud","kind":"vendor","anthropic":"https://ollama.com","openai":"https://ollama.com/v1","site":"https://docs.ollama.com/cloud","keys":"https://ollama.com/settings/keys","note":"cloud models, with an API key"},{"id":"nous","name":"Nous Portal","kind":"vendor","openai":"https://inference-api.nousresearch.com/v1","site":"https://portal.nousresearch.com","keys":"https://portal.nousresearch.com","note":"Nous Research · Hermes and other models"},{"id":"openrouter","name":"OpenRouter","kind":"relay","anthropic":"https://openrouter.ai/api","openai":"https://openrouter.ai/api/v1","site":"https://openrouter.ai","keys":"https://openrouter.ai/keys"},{"id":"opencode-go","name":"OpenCode Go","kind":"relay","anthropic":"https://opencode.ai/zen/go","openai":"https://opencode.ai/zen/go/v1","responses":true,"site":"https://opencode.ai/docs/go","keys":"https://opencode.ai/auth","note":"open coding models, $10/month"},{"id":"clinepass","name":"ClinePass","kind":"relay","openai":"https://api.cline.bot/api/v1","site":"https://docs.cline.bot/getting-started/clinepass","keys":"https://app.cline.bot","note":"open coding models, $9.99/month"},{"id":"opencode-zen","name":"OpenCode Zen","kind":"relay","anthropic":"https://opencode.ai/zen","openai":"https://opencode.ai/zen/v1","responses":true,"site":"https://opencode.ai/docs/zen","keys":"https://opencode.ai/auth"},{"id":"kilo","name":"Kilo Gateway","kind":"relay","openai":"https://api.kilo.ai/api/openrouter","site":"https://kilo.ai/docs/gateway","keys":"https://app.kilo.ai","note":"free models with no key"},{"id":"commandcode","name":"Command Code","kind":"relay","anthropic":"https://api.commandcode.ai/provider","openai":"https://api.commandcode.ai/provider/v1","responses":true,"site":"https://commandcode.ai/docs/provider","keys":"https://commandcode.ai/settings/keys"},{"id":"together","name":"Together AI","kind":"relay","openai":"https://api.together.xyz/v1","site":"https://api.together.ai","keys":"https://api.together.ai/settings/api-keys"},{"id":"fireworks","name":"Fireworks","kind":"relay","openai":"https://api.fireworks.ai/inference/v1","site":"https://fireworks.ai","keys":"https://app.fireworks.ai/settings/users/api-keys"},{"id":"siliconflow","name":"SiliconFlow","kind":"relay","openai":"https://api.siliconflow.cn/v1","site":"https://cloud.siliconflow.cn","keys":"https://cloud.siliconflow.cn/account/ak"},{"id":"nvidia","name":"NVIDIA NIM","kind":"relay","openai":"https://integrate.api.nvidia.com/v1","site":"https://build.nvidia.com","keys":"https://build.nvidia.com/settings/api-keys"},{"id":"modelscope","name":"ModelScope","kind":"relay","openai":"https://api-inference.modelscope.cn/v1","responses":true,"site":"https://modelscope.cn/docs/model-service/API-Inference/intro","keys":"https://modelscope.cn/my/myaccesstoken","note":"魔搭 · API-Inference"},{"id":"aihubmix","name":"AiHubMix","kind":"relay","anthropic":"https://aihubmix.com","openai":"https://aihubmix.com/v1","site":"https://aihubmix.com","keys":"https://console.aihubmix.com/token"},{"id":"pipellm","name":"PipeLLM","kind":"relay","anthropic":"https://api.pipellm.ai","openai":"https://api.pipellm.ai/openai/v1","responses":true,"site":"https://www.pipellm.ai","keys":"https://console.pipellm.ai"},{"id":"302ai","name":"302.AI","kind":"relay","anthropic":"https://api.302.ai","openai":"https://api.302.ai/v1","site":"https://302.ai","keys":"https://302.ai/api-keys/list"},{"id":"cherryin","name":"CherryIN","kind":"relay","anthropic":"https://open.cherryin.ai","openai":"https://open.cherryin.ai/v1","responses":true,"site":"https://open.cherryin.ai","keys":"https://open.cherryin.ai/console/token"},{"id":"yylx","name":"鱼鱼连线","kind":"relay","anthropic":"https://app.yylx.io","openai":"https://app.yylx.io/v1","site":"https://yylx.io","keys":"https://app.yylx.io/keys"},{"id":"ollama","name":"Ollama","kind":"local","anthropic":"http://localhost:11434","openai":"http://localhost:11434/v1","site":"https://ollama.com","note":"your local models"},{"id":"lmstudio","name":"LM Studio","kind":"local","openai":"http://localhost:1234/v1","site":"https://lmstudio.ai","note":"local server, port 1234 by default"}];
// 中转站在前：清单里最常被找的是它（官方厂商各家都有自己的入口，中转站的地址最难记）
const PROV_KIND_ORDER = ["relay", "vendor", "local"];
const PROV_KIND_FOLD = 10;   // 不搜索时每组先露这么多，其余点「显示全部」

function provRequest() { sendCtrl({ type: "providers.get" }); }
function provList() { return (PROV.view && PROV.view.providers) || []; }
function provById(id) { return provList().find((p) => p.id === id) || null; }
function provAgentCfg(id) { return (PROV.view && PROV.view.agents && PROV.view.agents[id]) || {}; }

function applyProviders(m) {
  PROV.view = m.view || { providers: [], agents: {} };
  PROV.protocols = m.protocols || {};
  PROV.efforts = m.efforts || [];
  PROV.own = m.own || {};
  if (NAV_HERE === "settings") renderProviderSettings();
  if (NAV_HERE === "dash" && typeof renderDashAgents === "function") renderDashAgents();
  if (typeof renderAllPaneModelChips === "function") renderAllPaneModelChips();
}
function provResult(m) {
  if (m.op === "provider.save" || m.op === "provider.import") {
    if (m.ok) { PROV.draft = null; PROV.adding = false; PROV.err = ""; showToast(t("prov.toast.saved"), m.name || "", "ok"); }
    else PROV.err = m.err || "";
  } else if (m.op === "provider.delete") {
    if (!m.ok) showToast(t("prov.toast.failed"), m.err || "", "error");
  } else if (m.op === "agent.config.set") {
    if (m.ok) { delete PROV.agentErr[m.id]; showToast(t("prov.toast.agentSaved"), "", "info"); }
    else PROV.agentErr[m.id] = m.err || "";
  }
  if (NAV_HERE === "settings") renderProviderSettings();
}
function provTestResult(m) {
  PROV.tests[m.id] = m.ok
    ? { ok: true, msg: t(m.via === "proxy" ? "prov.test.okProxy" : "prov.test.ok", { n: m.models | 0 }) }
    : { ok: false, msg: m.err || t("prov.test.failed") };
  if (NAV_HERE === "settings") renderProviderSettings();
}
/* 「检测」的回执：三种接口各自的结果 + 拿到的模型。 */
function provDetected(m) {
  const d = PROV.draft;
  if (!d || m.req !== d.detectReq) return;
  d.detectReq = 0;
  d.detected = { anthropic: m.anthropic || null, chat: m.chat || null, responses: m.responses || null };
  if (m.anthropic && m.anthropic.ok) d.anthropic = m.anthropic.url;
  if (m.chat && m.chat.ok) d.openai = m.chat.url;
  else if (m.responses && m.responses.ok) d.openai = m.responses.url;
  d.responses = !!(m.responses && m.responses.ok);
  d.models = (m.models || []).slice();
  // 第一次拿到列表：模型少就全选；多了只先勾前 12 个，其余手动勾
  d.picked = new Set(d.models.length <= 12 ? d.models : d.models.slice(0, 12));
  d.err = m.err || "";
  // 表单里的地址框也要跟着换：重画前会把表单读回 draft，不改这里就把刚测到的地址冲掉了
  if ($("pv-ant")) $("pv-ant").value = d.anthropic;
  if ($("pv-oai")) $("pv-oai").value = d.openai;
  renderProvidersCard();
}

/* ---------- 模型提供商：列表 ---------- */
const PROV_KIND_TAG = { vendor: "prov.kind.vendor", relay: "prov.kind.relay", local: "prov.kind.local", custom: "prov.kind.custom", imported: "prov.kind.imported" };
// 这个提供商能给哪些 agent（只看协议）
function provAgentsFor(p) {
  const out = [];
  for (const a of agentsCfgList()) {
    if (!(PROV.protocols[a.id] || []).length) continue;
    if (provFitsAgent(p, a.id).ok) out.push(a.name || a.id);
  }
  return out;
}
function provRowHTML(p) {
  const tst = PROV.tests[p.id];
  const eps = [
    p.anthropic ? `<span class="pv-ep ok"><i>Anthropic</i></span>` : "",
    p.openai ? `<span class="pv-ep ok"><i>OpenAI</i></span>` : "",
    p.openai && p.responses ? `<span class="pv-ep ok"><i>Responses</i></span>` : "",
  ].join("");
  const fits = provAgentsFor(p);
  const meta = [
    p.hasKey ? t("prov.keySaved", { hint: p.keyHint || "" }) : t("prov.keyNone"),
    p.models && p.models.length ? t("prov.models", { n: p.models.length }) : t("prov.modelsUnknown"),
  ].join(" · ");
  const status = tst
    ? `<span class="pv-test ${tst.busy ? "busy" : tst.ok ? "ok" : "bad"}">${esc(tst.busy ? t("prov.test.busy") : tst.msg)}</span>`
    : "";
  return `<div class="settings-row pv-row" data-prov="${esc(p.id)}">`
    + `<div class="settings-lab"><b>${esc(p.name)}${p.kind && PROV_KIND_TAG[p.kind] ? `<span class="pv-kind">${esc(t(PROV_KIND_TAG[p.kind]))}</span>` : ""}</b>`
    + `<span class="pv-eps">${eps}${fits.length ? `<span class="pv-fits">${esc(t("prov.fits", { list: fits.join(" · ") }))}</span>` : ""}</span>`
    + `<span class="pv-meta">${esc(meta)}${status}</span></div>`
    + `<div class="settings-ctl pv-acts">`
    + `<button type="button" class="set-btn" data-pact="test"${p.hasKey ? "" : ` aria-disabled="true"`}>${esc(t("prov.test"))}</button>`
    + `<button type="button" class="set-btn quiet" data-pact="edit">${esc(t("prov.edit"))}</button>`
    + `<button type="button" class="set-btn quiet" data-pact="delete">${esc(t("prov.delete"))}</button>`
    + `</div></div>`;
}

/* ---------- 添加清单 ---------- */
function provAddSheetHTML() {
  const q = PROV.addQ.trim().toLowerCase();
  const hit = (x) => !q || (x.name + " " + (x.note || "") + " " + (x.site || "")).toLowerCase().includes(q);
  let html = `<div class="pv-add" id="pv-add"><div class="pv-add-h"><b>${esc(t("prov.add"))}</b>`
    + `<input class="pv-in pv-add-q" id="pv-add-q" value="${esc(PROV.addQ)}" placeholder="${esc(t("prov.add.searchPh"))}" spellcheck="false" autocomplete="off">`
    + `<button type="button" class="set-btn quiet" data-pact="addclose">${esc(t("common.cancel"))}</button></div>`;
  // ① 从现有配置导入：agent 自己的配置里已经写好的地址（比如 Claude Code 的 settings.json）
  const known = new Set(provList().map((p) => (p.anthropic || "").replace(/\/+$/, "")));
  const imports = Object.entries(PROV.own || {}).filter(([, o]) => o && o.base && o.importable && !known.has(o.base.replace(/\/+$/, "")));
  if (imports.length && !q) {
    html += `<div class="pv-add-sec"><p>${esc(t("prov.add.import"))}</p>`;
    for (const [aid, o] of imports) {
      const a = agentsCfgList().find((x) => x.id === aid);
      html += `<div class="pv-imp"><span>${iconHTML(a && a.icon, "sm")}<b>${esc(t("prov.add.importFrom", { agent: (a && a.name) || aid }))}</b>`
        + `<code>${esc(o.base.replace(/^https?:\/\//, ""))}${o.model ? " · " + esc(o.model) : ""}</code></span>`
        + `<button type="button" class="set-btn primary" data-pact="import" data-agent="${esc(aid)}">${esc(t("prov.add.importBtn"))}</button></div>`;
    }
    html += `<em class="pv-add-note">${esc(t("prov.add.importNote"))}</em></div>`;
  }
  for (const kind of PROV_KIND_ORDER) {
    const all = PROV_PRESETS.filter((x) => x.kind === kind && hit(x));
    if (!all.length) continue;
    const fold = !q && !PROV.addMore[kind] && all.length > PROV_KIND_FOLD;
    const list = fold ? all.slice(0, PROV_KIND_FOLD) : all;
    const proto = (x) => [x.anthropic ? "A" : "", x.openai ? "O" : ""].filter(Boolean).join("·");
    const protoTip = (x) => [x.anthropic ? "Anthropic" : "", x.openai ? "OpenAI" : "", x.responses ? "Responses" : ""].filter(Boolean).join(" · ");
    html += `<div class="pv-add-sec"><p>${esc(t("prov.add.sec." + kind))}</p><div class="pv-add-grid">`
      + list.map((x) => `<button type="button" class="pv-pre" data-preset="${esc(x.id)}" title="${esc(protoTip(x) + (x.site ? " · " + x.site : ""))}">`
        + `<b>${esc(x.name)}</b><span>${esc(proto(x))}</span></button>`).join("")
      + `</div>`
      + (fold ? `<button type="button" class="pv-more" data-pact="more" data-kind="${kind}">${esc(t("prov.add.more", { n: all.length }))}</button>` : "")
      + `</div>`;
  }
  html += `<div class="pv-add-sec"><button type="button" class="pv-custom" data-pact="custom"><b>${esc(t("prov.add.custom"))}</b>`
    + `<span>${esc(t("prov.add.customNote"))}</span></button></div></div>`;
  return html;
}

/* ---------- 编辑 / 新建 ---------- */
function provDraftFrom(src) {
  return {
    id: src.id || "", kind: src.kind || "custom", preset: src.preset || "",
    name: src.name || "", url: src.url || "",
    anthropic: src.anthropic || "", openai: src.openai || "", responses: src.responses === true,
    site: src.site || "", keys: src.keys || "",
    hasKey: !!src.hasKey, keyHint: src.keyHint || "", key: "",
    models: (src.models || []).slice(), picked: new Set(src.models || []),
    detected: null, detectReq: 0, err: "",
  };
}
function provNameFromUrl(u) {
  let h = "";
  try { h = new URL(String(u || "").trim()).hostname; } catch (_) { return ""; }
  if (/^[\d.]+$|^\[|^localhost$/i.test(h)) return h;
  const parts = h.split(".").filter((x) => x && !/^(api|www|gateway|open)$/i.test(x));
  return parts.length > 1 ? parts[parts.length - 2] : (parts[0] || h);
}
function provDetectRowHTML(label, r) {
  if (!r) return "";
  return `<div class="pv-det ${r.ok ? "ok" : "bad"}"><i>${r.ok ? "✓" : "✕"}</i><b>${esc(label)}</b>`
    + `<code>${esc(r.url || "")}</code><span>${esc(r.ok ? (r.ms ? r.ms + " ms" : "") : (r.err || t("prov.det.no")))}</span></div>`;
}
function provEditorHTML() {
  const d = PROV.draft;
  const editing = !!d.id;
  const preset = d.preset ? PROV_PRESETS.find((x) => x.id === d.preset) : null;
  const title = editing ? t("prov.editTitle", { name: d.name }) : preset ? t("prov.newFrom", { name: preset.name }) : t("prov.newTitle");
  const keyPh = d.hasKey ? t("prov.keyKeep", { hint: d.keyHint || "" }) : "sk-…";
  const links = (d.site || d.keys)
    ? `<span class="pv-links">${d.site ? `<a href="#" data-open-url="${esc(d.site)}">${esc(t("prov.site"))} ↗</a>` : ""}${d.keys ? `<a href="#" data-open-url="${esc(d.keys)}">${esc(t("prov.getKey"))} ↗</a>` : ""}</span>`
    : "";
  let html = `<div class="pv-edit" id="pv-edit"><div class="pv-edit-h"><b>${esc(title)}</b>${links}</div>`
    + `<label class="pv-f"><span>${esc(t("prov.f.name"))}</span><input id="pv-name" class="pv-in" value="${esc(d.name)}" spellcheck="false" autocomplete="off"></label>`;
  if (d.kind === "custom" && !editing) {
    html += `<label class="pv-f"><span>${esc(t("prov.f.url"))}</span><input id="pv-url" class="pv-in mono" value="${esc(d.url)}" placeholder="https://…" spellcheck="false" autocomplete="off"><em>${esc(t("prov.f.urlHint"))}</em></label>`;
  }
  html += `<label class="pv-f"><span>${esc(t("prov.f.key"))}</span><input id="pv-key" class="pv-in mono" type="password" placeholder="${esc(keyPh)}" spellcheck="false" autocomplete="new-password"><em>${esc(t("prov.f.keyHint"))}</em></label>`;
  // 检测：三种接口 + 模型
  const det = d.detected;
  html += `<div class="pv-f pv-detect"><span>${esc(t("prov.f.detect"))}</span><div class="pv-det-box">`
    + `<button type="button" class="set-btn${det ? "" : " primary"}" data-pact="detect"${d.detectReq ? ` aria-disabled="true"` : ""}>${esc(d.detectReq ? t("prov.det.busy") : det ? t("prov.det.again") : t("prov.det.run"))}</button>`
    + (det ? provDetectRowHTML("Anthropic", det.anthropic) + provDetectRowHTML("OpenAI Chat", det.chat) + provDetectRowHTML("OpenAI Responses", det.responses) : `<em>${esc(t("prov.det.note"))}</em>`)
    + (det ? `<div class="pv-fitline">${esc(t("prov.fits", { list: provAgentsFor({ anthropic: d.anthropic, openai: d.openai, responses: d.responses }).join(" · ") || "—" }))}</div>` : "")
    + `</div></div>`;
  if (d.models.length) {
    const n = d.picked.size;
    html += `<div class="pv-f pv-models"><span>${esc(t("prov.f.models"))}</span><div>`
      + `<div class="pv-mtools"><em>${esc(t("prov.models.picked", { n, total: d.models.length }))}</em>`
      + `<button type="button" class="set-btn quiet" data-pact="pickall">${esc(t("prov.models.all"))}</button>`
      + `<button type="button" class="set-btn quiet" data-pact="picknone">${esc(t("prov.models.none"))}</button></div>`
      + `<div class="pv-mchips">${d.models.map((m) => `<button type="button" class="pv-mchip${d.picked.has(m) ? " on" : ""}" data-pmodel="${esc(m)}">${esc(m)}</button>`).join("")}</div>`
      + `</div></div>`;
  }
  // 接口地址：检测之后自动填好；高级用户也能直接改
  html += `<details class="pv-f pv-eps-edit"><summary>${esc(t("prov.f.endpoints"))}</summary>`
    + `<label class="pv-f"><span>${esc(t("prov.f.anthropic"))}</span><input id="pv-ant" class="pv-in mono" value="${esc(d.anthropic)}" placeholder="https://api.anthropic.com" spellcheck="false" autocomplete="off"><em>${esc(t("prov.f.anthropicHint"))}</em></label>`
    + `<label class="pv-f"><span>${esc(t("prov.f.openai"))}</span><input id="pv-oai" class="pv-in mono" value="${esc(d.openai)}" placeholder="https://api.openai.com/v1" spellcheck="false" autocomplete="off"><em>${esc(t("prov.f.openaiHint"))}</em></label>`
    + `</details>`;
  html += (d.err || PROV.err ? `<div class="set-err pv-err" role="alert">${esc(d.err || PROV.err)}</div>` : "")
    + `<div class="pv-edit-acts">`
    + (d.hasKey ? `<button type="button" class="set-btn quiet" data-pact="clearkey">${esc(t("prov.clearKey"))}</button>` : "")
    + `<span class="sp"></span>`
    + `<button type="button" class="set-btn quiet" data-pact="cancel">${esc(t("common.cancel"))}</button>`
    + `<button type="button" class="set-btn primary" data-pact="save">${esc(t("prov.save"))}</button>`
    + `</div></div>`;
  return html;
}
// 表单里的值收回 draft（重画前调用，免得冲掉正在打的字）
function provSyncDraft() {
  const d = PROV.draft;
  if (!d) return;
  const v = (id) => { const el = $(id); return el ? el.value : null; };
  const name = v("pv-name"); if (name !== null) d.name = name;
  const url = v("pv-url"); if (url !== null) d.url = url;
  const ant = v("pv-ant"); if (ant !== null) d.anthropic = ant;
  const oai = v("pv-oai"); if (oai !== null) d.openai = oai;
  const key = v("pv-key"); if (key !== null) d.key = key;
}
function renderProvidersCard() {
  const host = $("set-providers");
  if (!host) return;
  if (!PROV.view) {
    host.innerHTML = `<div class="settings-row"><div class="settings-lab"><span>${esc(t("prov.loading"))}</span></div></div>`;
    return;
  }
  provSyncDraft();
  const keep = PROV.draft && PROV.draft.key;
  const list = provList();
  let html = "";
  if (PROV.view.broken) html += `<div class="set-note">${esc(t("prov.broken"))}</div>`;
  if (!list.length && !PROV.adding && !PROV.draft) {
    html += `<div class="settings-row pv-empty"><div class="settings-lab"><b>${esc(t("prov.emptyTitle"))}</b>`
      + `<span>${esc(t("prov.emptyNote"))}</span></div>`
      + `<div class="settings-ctl"><button type="button" class="set-btn primary" data-pact="new">${esc(t("prov.add"))}</button></div></div>`;
  }
  for (const p of list) html += PROV.draft && PROV.draft.id === p.id ? provEditorHTML() : provRowHTML(p);
  if (PROV.draft && !PROV.draft.id) html += provEditorHTML();
  else if (PROV.adding) html += provAddSheetHTML();
  else if (list.length) html += `<div class="settings-row pv-addrow"><button type="button" class="set-btn quiet" data-pact="new">+ ${esc(t("prov.add"))}</button></div>`;
  const focusId = document.activeElement && document.activeElement.id;
  const caret = document.activeElement && typeof document.activeElement.selectionStart === "number" ? document.activeElement.selectionStart : null;
  host.innerHTML = html;
  if (keep && $("pv-key")) $("pv-key").value = keep;
  if (focusId && $(focusId)) {
    const el = $(focusId);
    el.focus();
    if (caret !== null && el.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch (_) {}
  }
}

/* ---------- Agents ---------- */
function agentsCfgList() {
  const cat = (typeof opCatalog === "function" ? opCatalog() : []).filter((a) => a && a.id);
  // 已安装的在前；没装的也列出来（配置可以先写好，装上就生效）。
  return cat.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
}
const CLAUDE_TIERS = [
  { id: "opus", hint: "prov.tier.opusHint" },
  { id: "sonnet", hint: "prov.tier.sonnetHint" },
  { id: "haiku", hint: "prov.tier.haikuHint" },
  { id: "subagent", hint: "prov.tier.subagentHint" },
];
function agentRowCfgHTML(a) {
  const id = a.id;
  const cfg = provAgentCfg(id);
  const protos = PROV.protocols[id] || [];
  const err = PROV.agentErr[id] ? `<div class="set-err ag-err" role="alert">${esc(PROV.agentErr[id])}</div>` : "";
  const envChips = (cfg.envNames || []).map((n) =>
    `<span class="ag-env-chip" title="${esc(t("prov.agent.envSaved"))}"><code>${esc(n)}</code>`
    + `<button type="button" data-envrm="${esc(n)}" aria-label="${esc(t("prov.agent.envRemove", { name: n }))}">×</button></span>`).join("");
  const current = protos.length ? choiceText(id, cfg.provider, cfg.model) : t("prov.agent.envOnly");
  let html = `<div class="ag-cfg-row${PROV.flashAgent === id ? " flash" : ""}" id="set-agent-${esc(id)}" data-agent="${esc(id)}"`
    + ` data-search="${esc([id, a.name || ""].join(" "))}">`
    + `<div class="ag-cfg-h">${iconHTML(a.icon, "sm")}<b>${esc(a.name || id)}</b>`
    + `<span class="ag-cfg-st">${esc(a.installed ? t("prov.agent.installed") : t("prov.agent.notInstalled"))}</span>`
    + `<span class="ag-now">${esc(current)}</span></div>`;
  if (protos.length) {
    html += `<div class="ag-cfg-line">`
      + `<label class="ag-f"><span>${esc(t("prov.agent.model"))}</span>`
      + `<button type="button" class="ag-pick" data-aact="pick">${esc(cfg.provider ? choiceText(id, cfg.provider, cfg.model) : t("mp.own"))}`
      + `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></label>`;
    if (id === "claude" || id === "codex") {
      html += `<label class="ag-f"><span>${esc(t("prov.agent.effort"))}</span><div class="set-seg ag-effort-seg">`
        + [""].concat(PROV.efforts).map((e) => `<button type="button" class="${(cfg.effort || "") === e ? "on" : ""}" data-effort="${esc(e)}">${esc(e || t("prov.agent.default"))}</button>`).join("")
        + `</div></label>`;
    }
    html += `<span class="sp"></span>`
      + (id === "claude" ? `<button type="button" class="set-btn quiet${PROV.openTiers[id] ? " on" : ""}" data-aact="tiers">${esc(t("prov.tiers"))} ${PROV.openTiers[id] ? "▴" : "▾"}</button>` : "")
      + `<button type="button" class="set-btn quiet${PROV.openAdv[id] ? " on" : ""}" data-aact="adv">${esc(t("prov.adv"))} ${PROV.openAdv[id] ? "▴" : "▾"}</button>`
      + `</div>`;
    if (id === "claude" && PROV.openTiers[id]) {
      const main = cfg.model ? modelLabel(cfg.model) : t("mp.ownShort");
      html += `<div class="ag-tiers"><p>${esc(t("prov.tiers.note"))}</p>`
        + CLAUDE_TIERS.map((tr) => {
          const v = (cfg.tiers || {})[tr.id] || "";
          const lab = v ? modelLabel(v) : t("prov.tier.follow", { model: main });
          return `<div class="ag-tier"><b>${esc(t("prov.tier." + tr.id))}</b>`
            + `<button type="button" class="ag-pick sm${v ? "" : " follow"}" data-aact="tier" data-tier="${tr.id}">${esc(lab)}`
            + `<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
            + `<em>${esc(t(tr.hint))}</em></div>`;
        }).join("") + `</div>`;
    }
  }
  if (!protos.length || PROV.openAdv[id]) {
    html += `<div class="ag-adv"><label class="ag-f wide"><span>${esc(t("prov.agent.env"))}</span>`
      + (envChips ? `<span class="ag-env-saved">${envChips}</span>` : "")
      + `<textarea class="pv-in mono ag-env" rows="2" placeholder="${esc(t("prov.agent.envPh"))}" spellcheck="false"></textarea></label>`
      + `<div class="ag-adv-acts"><span class="sp"></span><button type="button" class="set-btn" data-aact="envsave">${esc(t("prov.agent.envSaveBtn"))}</button></div></div>`;
  }
  return html + `${err}</div>`;
}
function renderAgentsCard() {
  const host = $("set-agents");
  if (!host) return;
  const typing = document.activeElement && document.activeElement.closest && document.activeElement.closest("#set-agents .ag-env");
  if (typing) return;   // 正在写环境变量：不重建，免得字被冲掉
  const list = agentsCfgList();
  host.innerHTML = list.length
    ? list.map(agentRowCfgHTML).join("")
    : `<div class="settings-row"><div class="settings-lab"><span>${esc(t("prov.agent.none"))}</span></div></div>`;
}

/* "KEY=VALUE" 每行一个；# 开头是注释。只写不读：值永远不回显。 */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) throw new Error(t("prov.agent.envBad", { line }));
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}
// 改一项就存一项：其余照旧。
function saveAgentCfg(id, patch) {
  const cfg = provAgentCfg(id);
  const config = Object.assign({
    provider: cfg.provider || "", model: cfg.model || "", effort: cfg.effort || "",
    tiers: Object.assign({}, cfg.tiers || {}), envSet: {}, envRemove: [],
  }, patch);
  // 乐观更新：选择器和行马上变，Go 的快照到了再校正
  if (PROV.view) {
    PROV.view.agents = PROV.view.agents || {};
    PROV.view.agents[id] = Object.assign({}, cfg, { provider: config.provider, model: config.model, effort: config.effort, tiers: config.tiers });
  }
  sendCtrl({ type: "agent.config.set", req: ++PROV.req, agentId: id, config });
  renderAgentsCard();
}

function renderProviderSettings() {
  renderProvidersCard();
  renderAgentsCard();
  if (PROV.flashAgent) {
    const el = $("set-agent-" + PROV.flashAgent);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => { PROV.flashAgent = ""; const e2 = $("set-agent-" + (el && el.dataset.agent)); if (e2) e2.classList.remove("flash"); }, 1600);
  }
}

/* 总览 Agent CLI 一行 / 新建卡「改默认」→ 设置 › Agents 那一行。 */
function openAgentSettings(id) {
  PROV.flashAgent = id;
  setNavView("settings");
  if (typeof setSettingsPage === "function") setSettingsPage("set-sec-agents");
  renderProviderSettings();
}

{
  const ph = $("set-providers");
  if (ph && !ph.dataset.bound) {
    ph.dataset.bound = "1";
    ph.addEventListener("click", async (e) => {
      const url = e.target.closest("[data-open-url]");
      if (url) { e.preventDefault(); sendCtrl({ type: "openurl", url: url.dataset.openUrl }); return; }
      const pre = e.target.closest("[data-preset]");
      if (pre) {
        const x = PROV_PRESETS.find((y) => y.id === pre.dataset.preset);
        if (!x) return;
        PROV.adding = false;
        PROV.draft = provDraftFrom({ kind: x.kind, preset: x.id, name: x.name, anthropic: x.anthropic, openai: x.openai, responses: x.responses, site: x.site, keys: x.keys });
        renderProvidersCard();
        if ($("pv-key")) $("pv-key").focus();
        return;
      }
      const mc = e.target.closest("[data-pmodel]");
      if (mc && PROV.draft) {
        const m = mc.dataset.pmodel;
        if (PROV.draft.picked.has(m)) PROV.draft.picked.delete(m); else PROV.draft.picked.add(m);
        renderProvidersCard();
        return;
      }
      const b = e.target.closest("[data-pact]");
      if (!b || b.getAttribute("aria-disabled") === "true") return;
      const act = b.dataset.pact;
      const row = b.closest("[data-prov]");
      const id = row ? row.dataset.prov : "";
      if (act === "new") { PROV.adding = true; PROV.addQ = ""; PROV.draft = null; PROV.err = ""; renderProvidersCard(); if ($("pv-add-q")) $("pv-add-q").focus(); }
      else if (act === "addclose") { PROV.adding = false; renderProvidersCard(); }
      else if (act === "more") { PROV.addMore[b.dataset.kind] = true; renderProvidersCard(); }
      else if (act === "custom") {
        PROV.adding = false;
        PROV.draft = provDraftFrom({ kind: "custom" });
        renderProvidersCard();
        if ($("pv-name")) $("pv-name").focus();
      } else if (act === "import") {
        sendCtrl({ type: "provider.import", req: ++PROV.req, agentId: b.dataset.agent });
      } else if (act === "edit") {
        const p = provById(id);
        if (!p) return;
        const pre = PROV_PRESETS.find((x) => x.id === p.preset) || {};
        PROV.adding = false; PROV.err = "";
        PROV.draft = provDraftFrom(Object.assign({}, p, { site: pre.site, keys: pre.keys }));
        renderProvidersCard();
      } else if (act === "cancel") { PROV.draft = null; PROV.err = ""; renderProvidersCard(); }
      else if (act === "detect") {
        provSyncDraft();
        const d = PROV.draft;
        d.detectReq = ++PROV.req; d.err = "";
        sendCtrl({ type: "provider.detect", req: d.detectReq, id: d.id, url: d.url, anthropic: d.anthropic, openai: d.openai, key: d.key || "" });
        renderProvidersCard();
      } else if (act === "pickall" && PROV.draft) { PROV.draft.picked = new Set(PROV.draft.models); renderProvidersCard(); }
      else if (act === "picknone" && PROV.draft) { PROV.draft.picked = new Set(); renderProvidersCard(); }
      else if (act === "save" || act === "clearkey") {
        provSyncDraft();
        const d = PROV.draft;
        // 名字空着就用域名顶上（api.some-relay.com → some-relay），不然左边快捷栏和分组头都是空的
        d.name = (d.name || "").trim() || provNameFromUrl(d.url || d.anthropic || d.openai);
        if (!d.name) { d.err = t("prov.err.needName"); renderProvidersCard(); if ($("pv-name")) $("pv-name").focus(); return; }
        sendCtrl({ type: "provider.save", req: ++PROV.req, provider: {
          id: d.id, name: d.name, kind: d.kind, preset: d.preset,
          anthropic: d.anthropic, openai: d.openai, responses: d.responses,
          key: act === "clearkey" ? "" : (d.key || ""), clearKey: act === "clearkey",
          models: d.models.length ? d.models.filter((m) => d.picked.has(m)) : null,
        } });
      } else if (act === "test") {
        const p = provById(id);
        if (!p || !p.hasKey) { showToast(t("prov.test.needKey"), "", "info"); return; }
        PROV.tests[id] = { busy: true };
        renderProvidersCard();
        sendCtrl({ type: "provider.test", req: ++PROV.req, id });
      } else if (act === "delete") {
        const p = provById(id);
        const ok = await askConfirm({ title: t("prov.deleteTitle", { name: p ? p.name : id }), body: t("prov.deleteBody"), ok: t("prov.delete"), danger: true });
        if (ok) sendCtrl({ type: "provider.delete", req: ++PROV.req, id });
      }
    });
    ph.addEventListener("input", (e) => {
      if (e.target.id === "pv-add-q") { PROV.addQ = e.target.value; renderProvidersCard(); }
    });
    ph.addEventListener("keydown", (e) => {
      if (isImeOwnedKey(e)) return;
      if (e.key === "Escape" && (PROV.draft || PROV.adding)) { e.preventDefault(); PROV.draft = null; PROV.adding = false; PROV.err = ""; renderProvidersCard(); }
    });
  }
  const ah = $("set-agents");
  if (ah && !ah.dataset.bound) {
    ah.dataset.bound = "1";
    ah.addEventListener("click", (e) => {
      const row = e.target.closest(".ag-cfg-row");
      if (!row) return;
      const id = row.dataset.agent;
      const cfg = provAgentCfg(id);
      const rm = e.target.closest("[data-envrm]");
      if (rm) { saveAgentCfg(id, { envRemove: [rm.dataset.envrm] }); return; }
      const ef = e.target.closest("[data-effort]");
      if (ef) { saveAgentCfg(id, { effort: ef.dataset.effort }); return; }
      const b = e.target.closest("[data-aact]");
      if (!b) return;
      const act = b.dataset.aact;
      if (act === "pick") {
        openModelPicker(b, { agent: id, current: { provider: cfg.provider || "", model: cfg.model || "" }, allowOwn: true,
          onPick: (c) => saveAgentCfg(id, c.own ? { provider: "", model: "", tiers: {} } : { provider: c.provider, model: c.model }) });
      } else if (act === "tier") {
        const tier = b.dataset.tier;
        const cur = (cfg.tiers || {})[tier] || "";
        openModelPicker(b, { agent: id, current: cur ? { provider: cfg.provider, model: cur } : { follow: true },
          followLabel: t("prov.tier.follow", { model: cfg.model ? modelLabel(cfg.model) : t("mp.ownShort") }),
          onPick: (c) => {
            const tiers = Object.assign({}, cfg.tiers || {});
            if (c.follow || c.own) delete tiers[tier];
            else if (c.provider !== cfg.provider) { showToast(t("prov.tier.sameProvTitle"), t("prov.tier.sameProvNote"), "err"); return; }
            else tiers[tier] = c.model;
            saveAgentCfg(id, { tiers });
          } });
      } else if (act === "tiers") { PROV.openTiers[id] = !PROV.openTiers[id]; renderAgentsCard(); }
      else if (act === "adv") { PROV.openAdv[id] = !PROV.openAdv[id]; renderAgentsCard(); }
      else if (act === "envsave") {
        let envSet;
        try { envSet = parseEnvText((row.querySelector(".ag-env") || {}).value || ""); }
        catch (err) { PROV.agentErr[id] = err.message; renderAgentsCard(); return; }
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        saveAgentCfg(id, { envSet });
      }
    });
  }
}
