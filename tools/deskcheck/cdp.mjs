// 经 WebView2 调试端口驱动真产品（测试实例要用 PERCH_DEVTOOLS_PORT 启动）。
// 用法：node tools/deskcheck/cdp.mjs eval "<js 表达式>"
//       node tools/deskcheck/cdp.mjs shot <输出.png>
import fs from "node:fs";
const PORT = Number(process.env.PERCH_DEVTOOLS_PORT || 9333);
const [cmd, arg] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.startsWith("http://wails.localhost"));
if (!page) { console.error("no Perch page on port " + PORT); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved " + arg);
}
ws.close();
