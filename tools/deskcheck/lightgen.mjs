// 从深色的 desk.css / desk-term.css 推出浅色主题的覆盖层（assets/css/desk-light.gen.css）。
// 规则按「这个颜色在这条声明里干什么」换：字的颜色深浅对调，白色细线 / 悬停底换成深色细线，
// 深色的面板底换成白色磨砂，阴影保留但调淡。生成的只是底稿，手调的放在 desk-light.css（在它后面加载、优先）。
// 用法：node tools/deskcheck/lightgen.mjs
import fs from "node:fs";
const root = "D:/AIAgents/_spike/term-botgroup/assets/css/";
const SRC = ["desk.css", "desk-term.css"];
const P = "html.theme-light";

const num = (s) => parseFloat(s);
const cap = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const f = (v) => +v.toFixed(3);
function mapColor(r, g, b, a, prop) {
  const shadow = /shadow/.test(prop);
  const isText = prop === "color" || prop === "fill" || prop === "stroke" || prop === "caret-color" || prop === "-webkit-text-fill-color";
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  if (shadow) {
    // 阴影：浅底上用偏蓝灰的淡阴影；白色的内高光加强；彩色的光晕（等你的琥珀、强调色）不动
    if (lum > 200) return `rgba(255,255,255,${f(cap(a * 3, 0, .9))})`;
    if (lum < 60) return `rgba(30,40,80,${f(cap(a * .45, 0, .3))})`;
    return null;
  }
  // 深色的字只出现在亮色按钮上（强调色 / 琥珀底上的深字）：浅色主题里照旧
  if (isText && lum < 60) return null;
  if (lum > 200) {
    // 浅色（白 / 近白）：字 → 深字；底和线 → 深色细线 / 悬停底
    if (isText) return `rgba(27,29,36,${f(cap(a + .05, 0, 1))})`;
    return `rgba(20,24,40,${f(cap(a * .9, 0, 1))})`;
  }
  if (lum < 60) {
    // 深色（黑 / 深灰面板）：字 → 白；底 → 白色磨砂（越深越实）
    if (isText) return `rgba(255,255,255,${f(a)})`;
    return `rgba(255,255,255,${f(cap(a * 1.15 + .1, 0, .96))})`;
  }
  return null;   // 中间色（强调色、状态色、品牌色）不动
}
function mapValue(v, prop) {
  let changed = false;
  let out = v.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g, (m, r, g, b, a) => {
    const c = mapColor(+r, +g, +b, a === undefined ? 1 : num(a), prop);
    if (!c) return m;
    changed = true; return c;
  });
  out = out.replace(/#([0-9a-fA-F]{6})\b/g, (m, h) => {
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const c = mapColor(r, g, b, 1, prop);
    if (!c) return m;
    changed = true; return c;
  });
  return changed ? out : null;
}
function prefix(sel) {
  return sel.split(",").map((s) => {
    s = s.trim();
    if (s === ":root" || s === "html") return P;
    if (/^html[.:#\[]/.test(s)) return P + s.slice(4);
    return P + " " + s;
  }).join(", ");
}
let out = "/* desk-light.gen.css —— 由 tools/deskcheck/lightgen.mjs 从深色样式推出来的浅色覆盖层，别手改（手调的在 desk-light.css）。 */\n";
for (const file of SRC) {
  const css = fs.readFileSync(root + file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0, depth = 0;
  const stack = [];
  // 逐个规则块扫：@keyframes 整段跳过，@media 进去照常处理
  const re = /([^{}]+)\{|\}/g;
  let m, skip = 0, buf = [];
  while ((m = re.exec(css))) {
    if (m[0] === "}") { if (skip) skip--; continue; }
    const head = m[1].trim();
    const start = re.lastIndex;
    if (/^@keyframes|^@font-face/.test(head)) {
      // 跳过整个块
      let d = 1, j = start;
      while (j < css.length && d) { if (css[j] === "{") d++; else if (css[j] === "}") d--; j++; }
      re.lastIndex = j; continue;
    }
    if (/^@media|^@supports/.test(head)) { out += head + " {\n"; buf.push("@"); continue; }
    // 普通规则：取到它的 }
    const end = css.indexOf("}", start);
    const body = css.slice(start, end);
    re.lastIndex = end + 1;
    const decls = [];
    for (const d of body.split(/;(?![^(]*\))/)) {
      const k = d.indexOf(":");
      if (k < 0) continue;
      const prop = d.slice(0, k).trim(), val = d.slice(k + 1).trim();
      if (!prop || prop.startsWith("--") && !/^--(line|line-2|txt|dim|faint|sheet|glass)$/.test(prop)) continue;
      const nv = mapValue(val, prop.startsWith("--") ? (/txt|dim|faint/.test(prop) ? "color" : "background") : prop);
      if (nv) decls.push(`${prop}: ${nv}`);
    }
    // 台面底色和暗角在 desk-light.css 里手写（透明窗口、渐变、纯色各有讲究）
    if (decls.length && !/^(body(\.bg-[a-z]+)*|#veil|html)$/.test(head)) out += `${prefix(head)} { ${decls.join("; ")}; }\n`;
    // @media 收尾：看下一个字符是不是 }
    while (buf.length && /^\s*\}/.test(css.slice(re.lastIndex))) { const k2 = css.indexOf("}", re.lastIndex); re.lastIndex = k2 + 1; buf.pop(); out += "}\n"; }
  }
}
fs.writeFileSync(root + "desk-light.gen.css", out);
console.log("wrote", out.split("\n").length, "lines");
