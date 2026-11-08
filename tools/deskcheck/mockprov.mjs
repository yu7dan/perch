// 假的模型提供商（Anthropic Messages 形状），给「格子换模型」做真机验收：不花一分钱、回答里写明是谁答的。
// 用法：node tools/deskcheck/mockprov.mjs <端口> <名字>   —— 收到的每个请求（路径、模型名、key）打在标准输出上。
// 用户那句话里带 PERMTEST：回一个要跑命令的 tool_use；带 ASKTEST：回一个提问（AskUserQuestion）；带 HANDOFFTEST <角色>：跑 perch-bg handoff 派给那个成员（验 Bot 之间交接）（agent 会停下来问你批不批 —— 验「等你拍板」用）；工具结果回来以后回一句「做完了」。
import http from "node:http";
const [port, name] = [Number(process.argv[2] || 18901), process.argv[3] || "MockA"];
const models = [`${name.toLowerCase()}-large`, `${name.toLowerCase()}-small`];
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch (_) {}
    console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} model=${j.model || "-"} key=${(req.headers["x-api-key"] || req.headers.authorization || "").slice(-6)}`);
    if (req.method === "GET" && /\/models/.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id, type: "model", display_name: id })) }));
      return;
    }
    if (req.method === "POST" && /\/v1\/messages(\?|$)/.test(req.url)) {
      const last = (j.messages || []).filter((m) => m.role === "user").pop();
      const parts = last ? (Array.isArray(last.content) ? last.content : [{ type: "text", text: String(last.content || "") }]) : [];
      const toolBack = parts.some((c) => c.type === "tool_result");
      const said = parts.filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
      const has = (n) => (j.tools || []).some((t) => t.name === n);
      const wantTool = !toolBack && ((/PERMTEST/.test(said) && has("Bash")) || (/ASKTEST/.test(said) && has("AskUserQuestion")) || (/HANDOFFTEST/.test(said) && has("Bash")));
      const text = toolBack ? `${name}：做完了` : `${name} 回答（模型 ${j.model}）`;
      if (wantTool) {
        const ho = /HANDOFFTEST\s+(\S+)/.exec(said);
        const tu = ho ? { type: "tool_use", id: "toolu_" + Date.now(), name: "Bash", input: { command: `perch-bg handoff --to ${ho[1]} --task "看一眼 README，回一句话"`, description: "Hand off to " + ho[1] } }
          : /ASKTEST/.test(said)
          ? { type: "tool_use", id: "toolu_" + Date.now(), name: "AskUserQuestion", input: { questions: [{ question: "选哪个颜色？", header: "颜色", multiSelect: false, options: [{ label: "红", description: "红色" }, { label: "蓝", description: "蓝色" }] }] } }
          : { type: "tool_use", id: "toolu_" + Date.now(), name: "Bash", input: { command: "echo permtest > permtest.txt", description: "Write permtest file" } };
        const msg = { id: "msg_" + Date.now(), type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (!j.stream) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(Object.assign(msg, { content: [tu], stop_reason: "tool_use" }))); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const ev = (t, d) => res.write(`event: ${t}
data: ${JSON.stringify(d)}

`);
        ev("message_start", { type: "message_start", message: msg });
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } });
        ev("message_stop", { type: "message_stop" });
        res.end();
        return;
      }
      const msg = { id: "msg_" + Date.now(), type: "message", role: "assistant", model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
      if (!j.stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(Object.assign(msg, { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 8 } })));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
      ev("message_start", { type: "message_start", message: msg });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
      ev("message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock: " + req.url } }));
  });
}).listen(port, "127.0.0.1", () => console.log(`${name} on ${port}`));
