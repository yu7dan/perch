// 给用户录真产品的导览视频（里程碑验收用）。驱动测试实例（PERCH_DEVTOOLS_PORT），录主窗口的 screencast；
// 收起成悬浮按钮那一段主窗口藏着，录的是「桌面壁纸 + 按钮窗口」合成的画面（不截真桌面：不碰用户别的窗口）。
// 用法：node tools/deskcheck/tour.mjs <导览脚本.mjs> <输出.mp4>
//   导览脚本 export default async function (t) { await t.say("…"); await t.drag(…); … }
// 画面上的说明条和假光标是录像时临时注进页面的，不是产品的一部分。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PORT = Number(process.env.PERCH_DEVTOOLS_PORT || 9333);
const [scriptPath, outPath] = process.argv.slice(2);
const work = path.join(path.dirname(outPath), path.basename(outPath, ".mp4") + "-frames");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(want) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((x) => x.type === "page" && x.url.startsWith("http://wails.localhost") && (want === "orb" ? x.url.includes("/orb.html") : !x.url.includes("/orb.html")));
    if (p) {
      const ws = new WebSocket(p.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      let seq = 0; const pend = new Map(); const handlers = [];
      ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) for (const h of handlers) h(m); };
      const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
      return { ws, send, on: (h) => handlers.push(h) };
    }
    await sleep(250);
  }
  throw new Error("no page " + want);
}

const main = await connect("main");
const ev = async (expr) => { const r = await main.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

// ---- 录像：screencast 帧落盘，带时间戳；之后按真实时长拼成定帧率视频 ----
const frames = [];   // { file, t }
let rec = true, fseq = 0;
main.on(async (m) => {
  if (m.method !== "Page.screencastFrame") return;
  main.send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  if (!rec) return;
  const file = path.join(work, `m${String(++fseq).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(m.params.data, "base64"));
  frames.push({ file, t: Date.now() });
});
await main.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
// screencast 只在画面变化时出帧：静止的时候补一张，保证时间轴连续。
const keep = setInterval(async () => {
  if (!rec) return;
  const last = frames[frames.length - 1];
  if (last && Date.now() - last.t < 400) return;
  const r = await main.send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
  if (!rec || !r.result) return;
  const file = path.join(work, `m${String(++fseq).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  frames.push({ file, t: Date.now() });
}, 250);

// ---- 注进页面的说明条和假光标（只为录像） ----
await ev(`(() => {
  if (document.getElementById("__tourcap")) return;
  const st = document.createElement("style");
  st.textContent = "#__tourcap{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:100000;padding:9px 18px;border-radius:12px;font:13px/1.5 'Segoe UI','Microsoft YaHei UI',sans-serif;color:#fff;background:rgba(14,15,20,.82);border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.45);pointer-events:none;max-width:80vw;text-align:center;transition:opacity .3s}"
   + "#__tourcur{position:fixed;left:0;top:0;z-index:100001;pointer-events:none;transition:left .45s cubic-bezier(.3,.7,.2,1),top .45s cubic-bezier(.3,.7,.2,1)}#__tourcur.inst{transition:none}"
   + "#__tourcur i{position:absolute;left:-9px;top:-9px;width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.55);transform:scale(0);opacity:0}"
   + "#__tourcur.down i{animation:__rip .45s ease-out}@keyframes __rip{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.6);opacity:0}}";
  document.head.appendChild(st);
  const c = document.createElement("div"); c.id = "__tourcap"; c.style.opacity = 0; document.body.appendChild(c);
  const k = document.createElement("div"); k.id = "__tourcur";
  k.innerHTML = '<i></i><svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5 19.5 12l-7 1.6-3.6 6.9z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  k.style.left = "960px"; k.style.top = "540px"; document.body.appendChild(k);
})()`);

let cx = 960, cy = 540;
const curTo = async (x, y, ms = 450, inst = false) => {
  await ev(`(() => { const k = document.getElementById("__tourcur"); k.classList.toggle("inst", ${inst}); k.style.transitionDuration = "${ms}ms"; k.style.left = "${x}px"; k.style.top = "${y}px"; })()`);
  cx = x; cy = y;
};
const ripple = () => ev(`(() => { const k = document.getElementById("__tourcur"); k.classList.remove("down"); void k.offsetWidth; k.classList.add("down"); })()`);
const mouse = (type, x, y, extra = {}) => main.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, ...extra });

const t = {
  ev, sleep,
  async say(text) { await ev(`(() => { const c = document.getElementById("__tourcap"); c.textContent = ${JSON.stringify(text)}; c.style.opacity = ${text ? 1 : 0}; })()`); },
  async move(x, y, ms = 500) { await curTo(x, y, ms); await main.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await sleep(ms + 60); },
  async click(x, y, ms = 500) {
    await t.move(x, y, ms); await ripple();
    await mouse("mousePressed", x, y, { clickCount: 1 }); await mouse("mouseReleased", x, y, { clickCount: 1 });
    await sleep(260);
  },
  async dbl(x, y) {
    await t.move(x, y); await ripple();
    for (let i = 1; i <= 2; i++) { await mouse("mousePressed", x, y, { clickCount: i }); await mouse("mouseReleased", x, y, { clickCount: i }); }
    await sleep(300);
  },
  async drag(x0, y0, x1, y1, ms = 1000) {
    await t.move(x0, y0); await ripple();
    await mouse("mousePressed", x0, y0, { clickCount: 1 });
    const n = Math.max(8, Math.round(ms / 24));
    for (let i = 1; i <= n; i++) {
      const k = i / n, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e;
      await curTo(Math.round(x), Math.round(y), 0, true);
      await mouse("mouseMoved", x, y);
      await sleep(18);
    }
    await mouse("mouseReleased", x1, y1, { clickCount: 1 });
    await sleep(300);
  },
  async type(text, per = 70) { for (const ch of text) { await main.send("Input.insertText", { text: ch }); await sleep(per); } },
  // 某个元素的中心（选择器 + 第几个）
  async at(sel, i = 0) { return ev(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`); },
  async clickSel(sel, i = 0) { const p = await t.at(sel, i); if (!p) throw new Error("not found: " + sel); await t.click(p[0], p[1]); },
  /* 收起那一段：主窗口藏着，录「壁纸 + 悬浮按钮」。fn 里可以对按钮窗口做事（hover / click）。 */
  async stowed(fn) {
    rec = false;
    const seg = { start: Date.now(), shots: [] };
    const wall = path.join(work, "wall.jpg");
    if (!fs.existsSync(wall)) {
      const b64 = await ev(`fetch("/__desk/wallpaper").then(r => r.blob()).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(",")[1]); fr.readAsDataURL(b); }))`);
      fs.writeFileSync(path.join(work, "wall.src"), Buffer.from(b64, "base64"));
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(work, "wall.src"), "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080", wall]);
    }
    const winPos = await ev(`[screenX, screenY]`);
    await t.click(...(await t.at('[data-dock="stow"]')));
    const orb = await connect("orb");
    // 按钮窗口是透明底：截图时别给它垫白底，合成到壁纸上才是真样子。
    await orb.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    const oev = async (expr) => { const r = await orb.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    let on = true, n = 0;
    const loop = (async () => {
      while (on) {
        // 按钮窗口一藏起来，截图请求就再也不回 —— 每一下都限时，别把整段录像挂住。
        const lim = (p) => Promise.race([p, sleep(1500).then(() => null)]);
        const pos = await lim(oev(`[screenX, screenY, innerWidth, innerHeight]`));
        const r = (await lim(orb.send("Page.captureScreenshot", { format: "png" }))) || {};
        if (r.result && pos) {
          const f = path.join(work, `o${String(++n).padStart(5, "0")}.png`);
          fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
          seg.shots.push({ f, t: Date.now(), x: pos[0] - winPos[0], y: pos[1] - winPos[1] });
        }
        await sleep(120);
      }
    })();
    await fn({ orb, oev, sleep, async hover() { await oev(`document.getElementById("orb").dispatchEvent(new MouseEvent("mouseenter"))`); }, async leave() { await oev(`document.getElementById("orb").dispatchEvent(new MouseEvent("mouseleave"))`); },
      // 点按钮 = 回到台面，按钮窗口随即藏起：先停掉截图再点。
      async click() { on = false; await loop; await orb.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 46, y: 46, button: "left", buttons: 1, clickCount: 1 }); await orb.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 46, y: 46, button: "left", buttons: 0, clickCount: 1 }); } });
    on = false; await loop;
    orb.ws.close();
    // 把每一张按钮截图合成到壁纸上，当成录像帧插进时间轴
    for (const s of seg.shots) {
      const out = s.f.replace(/\.png$/, ".jpg");
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wall, "-i", s.f, "-filter_complex", `overlay=${s.x}:${s.y}`, "-q:v", "3", out]);
      frames.push({ file: out, t: s.t });
    }
    await sleep(500);
    rec = true;
  },
};

const mod = await import("file://" + path.resolve(scriptPath).replace(/\\/g, "/"));
try { await mod.default(t); } finally {
  await sleep(800);
  rec = false; clearInterval(keep);
  await main.send("Page.stopScreencast");
  await t.say("");
  await ev(`(() => { for (const id of ["__tourcap", "__tourcur"]) { const e = document.getElementById(id); if (e) e.remove(); } })()`);
  main.ws.close();
}
// 拼片：concat 清单按真实时长
frames.sort((a, b) => a.t - b.t);
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? Math.max(0.02, (frames[i + 1].t - frames[i].t) / 1000) : 1;
  lines.push(`file '${frames[i].file.replace(/\\/g, "/")}'`, `duration ${d.toFixed(3)}`);
}
lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, "/")}'`);
fs.writeFileSync(path.join(work, "list.txt"), lines.join("\n"));
const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"),
  "-vf", "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p", "-c:v", "libx264", "-crf", "20", outPath], { stdio: "inherit" });
console.log(r.status === 0 ? `saved ${outPath}（${frames.length} 帧）` : "ffmpeg failed");
