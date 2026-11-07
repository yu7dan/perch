// 把 Lucide 图标（ISC 许可，原文 path 一个字符不改）打成 assets/js/03-icons.js。
// 用法：node tools/deskcheck/icons.mjs [图标目录，默认 D:/AIAgents/_ref/lucide]
// 缺图标时从 unpkg 的 lucide-static 下到那个目录里再跑一次。
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[2] || "D:/AIAgents/_ref/lucide";
const icons = {};
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith(".svg")) continue;
  const m = fs.readFileSync(path.join(dir, f), "utf8").match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (m) icons[f.slice(0, -4)] = m[1].replace(/\s+/g, " ").trim();
}
fs.writeFileSync("assets/js/03-icons.js",
  "/* 03-icons.js —— 台面用到的 Lucide 图标（lucide-static，ISC 许可）。由 tools/deskcheck/icons.mjs 生成，别手改。 */\n" +
  "const ICONS = " + JSON.stringify(icons) + ";\n");
console.log(Object.keys(icons).length + " icons");
