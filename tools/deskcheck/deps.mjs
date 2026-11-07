// 台面重构用：列出「保留的脚本」引用了哪些只在「要删的脚本」里声明的全局名。
// 用法：node tools/deskcheck/deps.mjs <keep1,keep2,...> [只看某个文件]
//      （文件名不带 .js；其余 assets/js/*.js 视为要删）
import fs from "node:fs";
import path from "node:path";
const dir = "assets/js";
const keep = new Set((process.argv[2] || "").split(",").filter(Boolean));
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
const decl = {};
const src = {};
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f + ".js"), "utf8");
  src[f] = raw;
  const names = new Set();
  for (const m of raw.matchAll(/^(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm)) names.add(m[1] || m[2]);
  decl[f] = names;
}
const keptDecl = new Set();
for (const f of files) if (keep.has(f)) for (const n of decl[f]) keptDecl.add(n);
const droppedDecl = new Map();
for (const f of files) if (!keep.has(f)) for (const n of decl[f]) if (!keptDecl.has(n)) droppedDecl.set(n, f);
const want = process.argv[3] || "";
for (const f of files) {
  if (!keep.has(f)) continue;
  if (want && f !== want) continue;
  const code = strip(src[f]);
  const hits = new Map();
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b/g)) {
    const n = m[1];
    if (droppedDecl.has(n)) hits.set(n, (hits.get(n) || 0) + 1);
  }
  if (!hits.size) continue;
  console.log(`== ${f}`);
  for (const [n, c] of [...hits].sort()) console.log(`   ${n}  (${droppedDecl.get(n)}) x${c}`);
}
