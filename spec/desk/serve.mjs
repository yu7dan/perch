// 台面形态的定稿模拟（0.1.1 的「标准答案」）。
// 用法：node spec/desk/serve.mjs            —— 起本地服务并全屏打开导览
//       NO_OPEN=1 node spec/desk/serve.mjs  —— 只起服务（给无头连拍 / 对比用）
// 地址后面加 #ch=<章节> 只放那一章：shape fold group persona dock files apps ov set
// 壁纸取当前桌面壁纸（不进仓库）；agent 图标直接读 assets/icons/agents。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ICONS = path.join(ROOT, "..", "..", "assets", "icons", "agents");
const PORT = Number(process.env.PORT || 8815);

function wallpaper() {
  try {
    const out = execSync('reg query "HKCU\\Control Panel\\Desktop" /v WallPaper', { encoding: "utf8" });
    const m = out.match(/WallPaper\s+REG_SZ\s+(.+)/);
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch (_) {}
  return "C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg";
}
const WALL = wallpaper();
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };

http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let f;
  if (u === "/wallpaper.jpg") f = WALL;
  else if (u.startsWith("/agents/")) f = path.join(AGENT_ICONS, path.basename(u));
  else f = path.join(ROOT, u === "/" ? "index.html" : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, "127.0.0.1", () => {
  console.log(`desk sim at http://127.0.0.1:${PORT}/`);
  if (process.env.NO_OPEN) return;
  const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  spawn(EDGE, [`--app=http://127.0.0.1:${PORT}/`, "--start-fullscreen", "--no-first-run",
    "--user-data-dir=" + path.join(process.env.TEMP || ROOT, "perch-desk-spec-ud")], { detached: true, stdio: "ignore" }).unref();
});
