// README 的动图：拿定稿模拟（spec/desk）的分章导览录，不录真产品（真桌面上别的东西不该进 README）。
// 模拟界面是中文的：录之前把产品的英文对照表（assets/js/38-desk-en.js）连同模拟专用的补充表（readme-en.mjs）注进页面，
// 导览说明条藏掉，壁纸换成中性的（WALL=<图片>）。
// 用法：
//   node tools/deskcheck/readme-media.mjs collect <章…>            —— 只跑导览，列出还剩的中文（补 readme-en.mjs 用）
//   node tools/deskcheck/readme-media.mjs record <输出目录> <章…>    —— 每章录成 <章>.mp4（原速、1920×1080）
// 章：shape fold group persona dock files apps ov set
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SIM_EN, SIM_SRC } from "./readme-en.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SIM_PORT = 8816, CDP_PORT = 9555, W = 1920, H = 1080;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [mode, ...rest] = process.argv.slice(2);
const outDir = mode === "record" ? rest.shift() : null;
const chapters = rest.length ? rest : ["shape"];

// 页面里先跑的：英文对照表 + 补充表，藏掉导览说明条
// 产品里不翻成员说的话（.gd-lines）、文件预览、输入框；模拟里那些都是演示用的中文，一起翻
const en = fs.readFileSync(path.join(ROOT, "assets", "js", "38-desk-en.js"), "utf8")
  .replace(/const TR_SKIP = "[^"]*";/, 'const TR_SKIP = ".xterm";')
  .replace('p.closest("script,style,textarea")', 'p.closest("script,style")')
  .replace("const DESK_EN = {", "const DESK_EN = { ..." + JSON.stringify(SIM_EN) + ",");
const inject = `(() => {
  const css = document.createElement("style");
  css.textContent = "#cap{display:none!important}";
  const run = () => {
    document.head.appendChild(css);
    (0, eval)("var PERCH_LOCALE = 'en';\\n" + ${JSON.stringify(en)});
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();`;

const server = spawn(process.execPath, [path.join(ROOT, "spec", "desk", "serve.mjs")], {
  env: { ...process.env, NO_OPEN: "1", PORT: String(SIM_PORT) }, stdio: "ignore",
});
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "perch-readme-"));
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--window-size=${W},${H}`, "--hide-scrollbars",
  "--no-first-run", `--user-data-dir=${ud}`, "about:blank"], { stdio: "ignore" });

async function page() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const p = list.find((x) => x.type === "page");
      if (p) return p.webSocketDebuggerUrl;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error("Edge 没起来");
}
const ws = new WebSocket(await page());
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map(); const on = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) for (const h of on) h(m); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.addScriptToEvaluateOnNewDocument", { source: inject });
// 模拟的源码在路上就改掉（SIM_SRC：打进输入框的字、应用名、岗位名）
await send("Fetch.enable", { patterns: [{ urlPattern: "*/app.js*", requestStage: "Response" }] });
on.push(async (m) => {
  if (m.method !== "Fetch.requestPaused") return;
  const body = await send("Fetch.getResponseBody", { requestId: m.params.requestId });
  let js = body.result.base64Encoded ? Buffer.from(body.result.body, "base64").toString("utf8") : body.result.body;
  for (const [a, b] of SIM_SRC) js = js.split(a).join(b);
  send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "content-type", value: "text/javascript; charset=utf-8" }], body: Buffer.from(js, "utf8").toString("base64") });
});

const CJK_SCAN = `(() => {
  const CJK = /[\\u3400-\\u9fff\\u3000-\\u303f\\uff01-\\uff5e]/, out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) { const p = n.parentElement; if (p && !p.closest("script,style,#cap") && p.getClientRects().length && CJK.test(n.nodeValue)) out.push((n.__zh || n.nodeValue).trim()); }
    else for (const a of ["title", "placeholder"]) { const v = n.getAttribute(a); if (v && CJK.test(v)) out.push(((n.__zhAttr && n.__zhAttr[a]) || v).trim()); }
  }
  return out;
})()`;

for (const ch of chapters) {
  await send("Page.navigate", { url: `http://127.0.0.1:${SIM_PORT}/?c=${ch}#ch=${ch}` });
  await sleep(600);
  const frames = [];
  let frameDir = null;
  if (mode === "record") {
    frameDir = path.join(outDir, ch + "-frames");
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    on.length = 1;
    on.push((m) => {
      if (m.method !== "Page.screencastFrame") return;
      const f = path.join(frameDir, String(frames.length).padStart(5, "0") + ".jpg");
      fs.writeFileSync(f, Buffer.from(m.params.data, "base64"));
      frames.push({ f, t: m.params.metadata.timestamp });
      send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
    });
    await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  }
  const seen = new Set();
  const t0 = Date.now();
  // 导览放完（TOUR.run 变回 false）或者两分钟到了就收
  for (;;) {
    await sleep(mode === "collect" ? 400 : 250);
    if (mode === "collect") for (const s of (await ev(CJK_SCAN)) || []) seen.add(s);
    const running = await ev("typeof TOUR !== 'undefined' && TOUR.run");
    if ((!running && Date.now() - t0 > 3000) || Date.now() - t0 > 120000) break;
  }
  if (mode === "record") {
    await sleep(800);
    await send("Page.stopScreencast");
    // 按真实时间戳拼成 30fps
    const list = frames.map((x, i) => {
      const next = frames[i + 1] ? frames[i + 1].t : x.t + 0.8;
      return `file '${x.f.replace(/\\/g, "/")}'\nduration ${Math.max(0.001, next - x.t).toFixed(4)}`;
    }).join("\n") + `\nfile '${frames[frames.length - 1].f.replace(/\\/g, "/")}'\n`;
    const lf = path.join(frameDir, "list.txt");
    fs.writeFileSync(lf, list);
    const out = path.join(outDir, ch + ".mp4");
    await new Promise((r) => spawn(FFMPEG, ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lf, "-vf", "fps=30,format=yuv420p",
      "-c:v", "libx264", "-crf", "18", out], { stdio: "inherit" }).on("exit", r));
    console.log(`${ch}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${frames.length} 帧 → ${out}`);
  } else {
    const errs = await ev("JSON.stringify([window.__errs || [], window.__miss || []])");
    console.log(`== ${ch}（${((Date.now() - t0) / 1000).toFixed(1)}s）${errs}`);
    for (const s of seen) console.log(s);
  }
}
ws.close();
edge.kill();
server.kill();
