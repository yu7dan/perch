// i18n guard for CI.
//
// Checks three things that used to drift silently:
//   1. every data-i18n key / t("…") / tCount("…") in the frontend exists in en
//      and zh;
//   2. backend codes passed to uimsg / setSnapErr / MsgCode have a msg.<code>
//      entry in both dictionaries (the raw text stays the runtime fallback, but
//      a missing dictionary entry is a translation gap, not a feature);
//   3. the {placeholders} of a key match between en and zh.
//
// Run: node scripts/i18n-check.mjs
// Exit code 1 on any gap.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const i18nFile = path.join(root, "assets", "js", "01-i18n.js");

let src = fs.readFileSync(i18nFile, "utf8");
// Everything after this line touches navigator/localStorage; the dictionaries
// are defined before it.
const cut = src.indexOf("// 首帧：");
if (cut >= 0) src = src.slice(0, cut);
src += "\nglobalThis.__I18N__ = PERCH_I18N;\n";
const ctx = {};
vm.runInNewContext(src, ctx);
const dict = ctx.__I18N__;

const en = dict.en;
const zh = dict.zh;
const enKeys = new Set(Object.keys(en));
const zhKeys = new Set(Object.keys(zh));

const used = new Set();
function scanText(text) {
  for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/\bt\("([^"]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/\btCount\("([^"]+)"/g)) used.add(m[1]);
}
scanText(fs.readFileSync(path.join(root, "assets", "index.html"), "utf8"));
const jsDir = path.join(root, "assets", "js");
for (const f of fs.readdirSync(jsDir)) {
  if (f.endsWith(".js")) scanText(fs.readFileSync(path.join(jsDir, f), "utf8"));
}

// Keys ending in "." are dynamic prefixes (t("state." + s)), not full keys.
const missingEn = [...used].filter((k) => !k.endsWith(".") && !enKeys.has(k)).sort();
const missingZh = [...used].filter((k) => !k.endsWith(".") && !zhKeys.has(k)).sort();
// `*One` is an English-only plural variant; zh does not need one.
const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k) && !/One$/.test(k));
const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));

const goCodes = new Set();
// A code is a dotted identifier in one of the namespaces the UI owns; this
// filter keeps updateReasonErr's human-readable arguments out of the set.
const CODE_RE = /^(?:gw|files|settings|project|pool|install|diff|refusal)\.[A-Za-z0-9_.]+$/;
const addCode = (c) => { if (CODE_RE.test(c)) goCodes.add(c); };
function scanGo(file) {
  const text = fs.readFileSync(file, "utf8");
  const patterns = [
    /\buimsg\.(?:New|NewParams)\(\s*"([^"]+)"/g,
    /\buimsg\.Wrap\([^,]+,\s*"([^"]+)"/g,
    /\bsetSnapErr\([^,]+,\s*"([^"]+)"/g,
    /\bMsgCode:\s*"([^"]+)"/g,
    /\bfailed\(\s*"([^"]+)"/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) addCode(m[1]);
  }
  for (const m of text.matchAll(/\bupdateReasonErr\(([\s\S]*?)\)/g)) {
    for (const q of m[1].matchAll(/"([^"]+)"/g)) addCode(q[1]);
  }
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".go") && !e.name.endsWith("_test.go")) scanGo(p);
  }
}
walk(path.join(root, "internal"));
walk(path.join(root, "cmd"));

const missingMsgEn = [...goCodes].filter((c) => !enKeys.has("msg." + c)).sort();
const missingMsgZh = [...goCodes].filter((c) => !zhKeys.has("msg." + c)).sort();
const unusedMsg = [...enKeys]
  .filter((k) => k.startsWith("msg.") && !goCodes.has(k.slice(4)))
  .sort();

const placeholders = (s) => {
  const out = new Set();
  for (const m of String(s).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
  return [...out].sort();
};
const badPlaceholders = [];
for (const k of enKeys) {
  if (!zhKeys.has(k)) continue;
  const a = placeholders(en[k]).join(",");
  const b = placeholders(zh[k]).join(",");
  if (a !== b) badPlaceholders.push(`${k}: en{${a}} zh{${b}}`);
}

console.log(`en keys=${enKeys.size} zh keys=${zhKeys.size} used=${used.size}`);
console.log("missing en:", missingEn.length ? missingEn : "none");
console.log("missing zh:", missingZh.length ? missingZh : "none");
console.log("only en:", onlyEn.length ? onlyEn : "none");
console.log("only zh:", onlyZh.length ? onlyZh : "none");
console.log(`go msg codes=${goCodes.size}`);
console.log("missing msg en:", missingMsgEn.length ? missingMsgEn : "none");
console.log("missing msg zh:", missingMsgZh.length ? missingMsgZh : "none");
if (unusedMsg.length) console.log("unused msg keys (info):", unusedMsg);
console.log("placeholder mismatches:", badPlaceholders.length ? badPlaceholders : "none");

const failed =
  missingEn.length || missingZh.length || onlyEn.length || onlyZh.length ||
  missingMsgEn.length || missingMsgZh.length || badPlaceholders.length;
if (failed) process.exit(1);
