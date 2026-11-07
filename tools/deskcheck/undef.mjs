// 台面重构用：列出 assets/js 里被当函数调用、却哪儿都没声明过的名字（粗查：不认参数和解构，结果要人看一眼）。
// 用法：node tools/deskcheck/undef.mjs
import fs from "node:fs";
import path from "node:path";
const dir = "assets/js";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
  .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
const declared = new Set();
const code = {};
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), "utf8");
  const c = strip(raw);
  code[f] = c;
  for (const m of c.matchAll(/\b(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of c.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) for (const n of m[1].split(",")) { const k = n.split(":").pop().trim().split("=")[0].trim(); if (k) declared.add(k); }
  for (const m of c.matchAll(/\(([^()]*)\)\s*=>/g)) for (const n of m[1].split(",")) { const k = n.trim().split("=")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(k)) declared.add(k); }
  for (const m of c.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
  for (const m of c.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) for (const n of m[1].split(",")) { const k = n.trim().split("=")[0].trim(); if (k) declared.add(k); }
  for (const m of c.matchAll(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) declared.add(m[1]);   // 对象方法
}
const builtins = new Set(("if for while switch catch return typeof new function await import super " +
  "setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame queueMicrotask " +
  "parseInt parseFloat isNaN isFinite String Number Boolean Array Object Map Set WeakMap Promise Date Math JSON " +
  "RegExp Error TypeError encodeURIComponent decodeURIComponent getComputedStyle fetch structuredClone " +
  "Uint8Array TextEncoder TextDecoder ResizeObserver MutationObserver DOMMatrixReadOnly Symbol URL Event " +
  "Terminal StableCellFitAddon alert confirm require").split(/\s+/));
const known = new Set(["Stream", "JSONStream"]);
for (const f of files) {
  const miss = new Map();
  for (const m of code[f].matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const n = m[1];
    if (declared.has(n) || builtins.has(n) || known.has(n)) continue;
    miss.set(n, (miss.get(n) || 0) + 1);
  }
  if (miss.size) console.log(f + ": " + [...miss].map(([n, c]) => `${n}×${c}`).join(" "));
}
