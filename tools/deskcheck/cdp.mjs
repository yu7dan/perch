// 经 WebView2 调试端口驱动真产品（测试实例要用 PERCH_DEVTOOLS_PORT 启动）。
// 用法：node tools/deskcheck/cdp.mjs eval "<js 表达式>"
//       node tools/deskcheck/cdp.mjs shot <输出.png>
//       node tools/deskcheck/cdp.mjs click <x> <y>          真的鼠标事件（Input.dispatchMouseEvent），不是 el.click()
//       node tools/deskcheck/cdp.mjs dbl <x> <y>
//       node tools/deskcheck/cdp.mjs drag <x0> <y0> <x1> <y1> [步数]
//       node tools/deskcheck/cdp.mjs type "<文字>"           往当前焦点里插字（Input.insertText）
//       node tools/deskcheck/cdp.mjs key <Escape|Enter|…>
// PERCH_PAGE=orb 时连悬浮按钮那个窗口（/orb.html），否则连主窗口。
import fs from "node:fs";
const PORT = Number(process.env.PERCH_DEVTOOLS_PORT || 9333);
const WANT = process.env.PERCH_PAGE || "main";
const [cmd, ...args] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((p) => p.type === "page" && p.url.startsWith("http://wails.localhost")
  && (WANT === "orb" ? p.url.includes("/orb.html") : !p.url.includes("/orb.html")));
if (!page) { console.error(`no Perch ${WANT} page on port ${PORT}`); process.exit(2); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, ...extra });
const KEYS = { Escape: 27, Enter: 13, Tab: 9, Backspace: 8 };
if (cmd === "eval") {
  const r = await send("Runtime.evaluate", { expression: args[0], returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result));
} else if (cmd === "shot") {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(args[0], Buffer.from(r.result.data, "base64"));
  console.log("saved " + args[0]);
} else if (cmd === "click" || cmd === "dbl") {
  const [x, y] = args.map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= (cmd === "dbl" ? 2 : 1); i++) {
    await mouse("mousePressed", x, y, { clickCount: i });
    await mouse("mouseReleased", x, y, { clickCount: i });
  }
  console.log(`${cmd} ${x},${y}`);
} else if (cmd === "drag") {
  const [x0, y0, x1, y1] = args.map(Number);
  const n = Number(args[4] || 16);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
  await mouse("mousePressed", x0, y0, { clickCount: 1 });
  for (let i = 1; i <= n; i++) {
    await mouse("mouseMoved", x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
    await sleep(16);
  }
  await mouse("mouseReleased", x1, y1, { clickCount: 1 });
  console.log(`drag ${x0},${y0} -> ${x1},${y1}`);
} else if (cmd === "type") {
  await send("Input.insertText", { text: args[0] });
  console.log("typed");
} else if (cmd === "key") {
  const k = args[0], code = KEYS[k] || 0;
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: code });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code });
  console.log("key " + k);
} else {
  console.error("unknown command: " + cmd); process.exit(2);
}
ws.close();
