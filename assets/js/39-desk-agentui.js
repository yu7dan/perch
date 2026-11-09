"use strict";
/* 39-desk-agentui.js —— 格子里的 Agent 界面（照定稿模拟 spec/desk 的格子：说的话、做的事、拍板卡、「跟它说…」）。
   用户 2026-11-09 验收：格子里不要 CLI 终端的样子，要模拟里的 Agent 界面。
   · 内容从这一格的转录来（22-live.js 的 LIVE.acts，Go 跟着 agent 自己的会话文件读）：你说的 → › 一行，
     它做的事（读取 / 编辑 / 运行……）→ 小圆点一行，它说的话 → 正文。
   · 「跟它说…」= 把这句话粘贴进它的终端再回车（和你在终端里打字是一回事，斜杠命令也照样能用）。
   · 拍板卡：它停下来问你（提问 / 批权限 / 信任这个文件夹 / 登录 ……）时，从转录和它屏上的菜单读出选项，直接点。
   · 真终端一直在这一格底下跑着（看不见，但有尺寸 —— PTY 要量到尺寸才起）；格头的「终端」按钮随时切过去看原样。 */

const AUI_LIMIT = 160;
const AUI_SNAP = new Set();   // 要过完整快照的格子（tab id）
const AUI_CACHE = new WeakMap();

/* ---------- 转录 → 一行一行 ---------- */
function auiActLine(a) {
  const tgt = a.rel || a.path || "";
  const n = (x) => x | 0;
  const tail = a.ok === false ? "  → 失败" : "";
  switch (a.tool) {
    case "Read": return "读取 " + (tgt || a.text || "");
    case "Edit": case "MultiEdit": case "NotebookEdit": return `编辑 ${tgt || a.text || ""}${n(a.add) || n(a.del) ? `  +${n(a.add)} −${n(a.del)}` : ""}${tail}`;
    case "Write": return `新建 ${tgt || a.text || ""}${n(a.add) ? `  +${n(a.add)}` : ""}${tail}`;
    case "Bash": case "PowerShell": {
      const c = String(a.cmd || a.text || "").split("\n")[0];
      return "运行 " + c + (a.ok === true ? "  → 通过" : tail);
    }
    case "Grep": case "Glob": return "搜索 " + (a.text || tgt);
    case "WebFetch": case "WebSearch": return "查网页 " + (a.text || "");
    case "Task": case "Agent": return "子代理：" + (a.agent || String(a.text || "").replace(/^子代理：/, ""));
    case "TodoWrite": return "更新待办";
    default: return (a.tool ? a.tool + " " : "") + (a.text || tgt);
  }
}
function auiLines(T) {
  const v = LIVE.get(T.id);
  const acts = (v && v.acts) || [];
  const last = acts[acts.length - 1];
  const key = ((v && v.actsGen) | 0) + ":" + acts.length + ":" + (last ? last.id + "|" + last.ok + "|" + String(last.text || "").length : "");
  const hit = AUI_CACHE.get(T);
  if (hit && hit.key === key) return hit.lines;
  const lines = [];
  for (const a of acts.slice(-AUI_LIMIT * 2)) {
    if (a.kind === "prompt") {
      const t = String(a.text || "").trim();
      // 系统自己塞进来的提示（打断、命令输出……）不算你说的话
      if (!t || /^\[Request interrupted/.test(t) || /^<(command|local-command|bash-|system)/.test(t)) continue;
      lines.push({ k: "me", t: clamp(t, 600), id: a.id });
    } else if (a.kind === "tool") {
      if (a.tool === "AskUserQuestion") continue;   // 提问画成拍板卡
      lines.push({ k: "act" + (a.ok == null ? " run" : a.ok === false ? " bad" : ""), t: auiActLine(a), id: a.id });
    } else if (a.kind === "text") {
      const t = String(a.text || "").trim();
      if (!t || /^No response requested\.?$/.test(t)) continue;
      lines.push({ k: "say", t, md: true, id: a.id });
    } else if (a.kind === "compact") lines.push({ k: "sys", t: "上下文压缩了一次", id: a.id });
  }
  const out = lines.slice(-AUI_LIMIT);
  AUI_CACHE.set(T, { key, lines: out });
  return out;
}

/* ---------- 拍板卡：它停下来等你的时候 ---------- */
// 屏上的编号菜单（「❯ 1. Yes / 2. No」这种）：从屏幕底部往上找，至少两项、其中一项带光标。
function auiScreenMenu(T) {
  const ls = screenLines(T).map((s) => s.replace(/[│┃║╎]/g, " ").replace(/\s+$/, ""));
  let end = ls.length - 1;
  while (end >= 0 && !ls[end].trim()) end--;
  const opts = [];
  let cursor = false, i = end, first = -1;
  for (; i >= 0 && end - i < 24; i--) {
    const m = /^\s*([❯>›]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/.exec(ls[i]);
    if (m) { opts.unshift({ n: +m[2], label: m[3], line: i }); if (m[1]) cursor = true; first = i; continue; }
    if (opts.length && ls[i].trim() && !/^\s{2,}\S/.test(ls[i])) break;   // 选项下面缩进的说明行跳过
  }
  if (opts.length < 2 || !cursor) return null;
  let q = "";
  for (let j = first - 1; j >= 0 && first - j < 6; j--) { const s = ls[j].trim(); if (s && !/^[─━═\-–—]+$/.test(s)) { q = s; break; } }
  return { q, opts: opts.slice(0, 6) };
}
function auiGate(T) {
  if (!T || T.connDown) return "";
  let trust = false, bypass = false, accept = false;
  for (const s of screenLines(T)) {
    if (/Do you trust the files in this folder|Is this a project you created or one you trust|Yes, I trust this folder/i.test(s)) trust = true;
    if (/Bypass Permissions mode/i.test(s)) bypass = true;
    if (/Yes, I accept/i.test(s)) accept = true;
  }
  if (bypass && accept) return "bypass";
  if (trust) return "trust";
  if (LOGIN_GATES.has(T.id)) return "login";
  return "";
}
function auiAsk(l) {
  const T = l.tab;
  if (!T || T.connDown) return null;
  const st = leafState(l);
  const gate = auiGate(T);
  const v = LIVE.get(T.id);
  const pa = pendingAsk(v);
  // 只有一道单选题：选项从转录里来（带说明），数字键直选（claude-code-ask-picker-keys）
  if (pa && Array.isArray(pa.qs) && pa.qs.length === 1 && !pa.qs[0].multi && (pa.qs[0].opts || []).length && pa.qs[0].opts.length <= 6) {
    const q = pa.qs[0];
    return { q: q.q, btns: q.opts.map((o, i) => ({ t: o.label, title: o.desc || "", act: "pick", v: String(i + 1) })) };
  }
  if (gate === "login") return { q: `${ag(l.agent).name} 要先登录`, btns: [{ t: "去终端登录", act: "term" }] };
  const menu = (st === "wait" || gate || leafState(l) !== "work") ? auiScreenMenu(T) : null;
  if (menu) {
    const row = needModel().rows.find((r) => r.t === T);
    const why = gate === "trust" ? `${ag(l.agent).name} 问：信任这个文件夹吗？` : (row && row.text) || menu.q || "屏上有个选择";
    return { q: why, sub: menu.q && menu.q !== why ? menu.q : "", btns: menu.opts.map((o, i) => ({ t: o.label, act: "menu", v: String(o.n), y: i === 0 })) };
  }
  if (st === "wait") {
    const row = needModel().rows.find((r) => r.t === T);
    return { q: (row && (row.text || needWhy(row.kind))) || "在等你", btns: [{ t: "去终端看看", act: "term" }] };
  }
  return null;
}
function auiAskHTML(l, a) {
  return `<div class="ask aui-ask"><div class="aui-q"><span>${esc(a.q)}</span>${a.sub ? `<em>${esc(a.sub)}</em>` : ""}</div><div class="aui-btns">`
    + a.btns.map((b, i) => `<button class="${b.y || (i === 0 && b.act !== "term") ? "y" : ""}" data-aui="${b.act}" data-v="${esc(b.v || "")}" data-leaf="${l.id}" title="${esc(b.title || "")}">${esc(b.t)}</button>`).join("")
    + `</div></div>`;
}

/* ---------- 画 ---------- */
function auiEmpty(l) {
  const T = l.tab;
  if (!T || !T.ready) return "正在启动…";
  return LIVE.get(T.id) && (LIVE.get(T.id).acts || []).length ? "" : "起来了 —— 在下面跟它说";
}
function renderAgentBody(l, el) {
  const T = l.tab;
  const term = l.view === "term";
  el.classList.toggle("v-term", term);
  if (term || !T) return;
  if (T.id && !AUI_SNAP.has(T.id) && ctlReady) { AUI_SNAP.add(T.id); sendCtrl({ type: "acts.snapshot", tab: T.id }); sendCtrl({ type: "files.snapshot", tab: T.id }); }
  const tb = qs(".tb", el);
  if (!tb) return;
  const lines = auiLines(T);
  const ask = auiAsk(l);
  const empty = lines.length ? "" : auiEmpty(l);
  const sig = (lines.length ? lines[lines.length - 1].id + ":" + lines[lines.length - 1].k + ":" + String(lines[lines.length - 1].t).length : "") + ":" + lines.length + "|" + (ask ? JSON.stringify(ask) : "") + "|" + empty;
  if (tb._sig === sig) return;
  const first = !tb._sig;
  const pinned = l.pin !== false;
  const st = tb.scrollTop;
  const seen = tb._seen || (tb._seen = new Set());
  tb.innerHTML = (empty ? `<div class="ln sys">${esc(empty)}</div>` : "")
    + lines.map((x) => { const fresh = !first && !seen.has(x.id + x.k); seen.add(x.id + x.k); return `<div class="ln ${x.k}${fresh ? " new" : ""}">${x.md ? md(x.t) : esc(x.t)}</div>`; }).join("")
    + (ask ? auiAskHTML(l, ask) : "");
  const grew = tb._sig && lines.length && (!tb._last || tb._last !== lines[lines.length - 1].id);
  tb._sig = sig; tb._last = lines.length ? lines[lines.length - 1].id : "";
  if (pinned) tb.scrollTop = tb.scrollHeight;
  else { tb.scrollTop = st; if (grew) { l.unseen = true; const nb = qs(".tb-new", el); if (nb) nb.hidden = false; } }
  if (!tb._bound) {
    tb._bound = true;
    tb.addEventListener("scroll", () => {
      const atEnd = tb.scrollHeight - tb.scrollTop - tb.clientHeight < 24;
      l.pin = atEnd;
      if (atEnd && l.unseen) { l.unseen = false; const nb = qs(".tb-new", el); if (nb) nb.hidden = true; }
    }, { passive: true });
  }
  const go = qs("[data-tsend]", el);
  if (go) {
    const working = leafState(l) === "work";
    if (go._w !== working) { go._w = working; go.innerHTML = working ? ICON("square", 11, 2.4) : ICON("arrow-up", 13, 2); go.title = working ? "打断它（Esc）" : "发送（回车）"; go.classList.toggle("stop", working); }
  }
}

/* ---------- 跟它说 ---------- */
function auiSend(l, text) {
  const T = l.tab;
  text = String(text || "").replace(/\s+$/, "");
  if (!T || !text.trim()) return false;
  if (T.connDown || !T.stream) { toast(`${ag(l.agent).name} 停了 —— 点格子里的「接着来」`, "warn"); return false; }
  const bp = !!(T.term && T.term.modes && T.term.modes.bracketedPasteMode);
  const payload = bp ? "\x1b[200~" + text.replace(/\r?\n/g, "\r") + "\x1b[201~" : text.replace(/\s*\r?\n\s*/g, " ");
  T.stream.send(enc.encode(payload));
  // 粘贴和回车分开送：同一包里的回车会被一些 TUI 当成粘贴内容里的换行
  setTimeout(() => { try { if (T.stream) T.stream.send(enc.encode("\r")); } catch (_) {} }, 160);
  l.pin = true;
  if (typeof ackNote === "function") ackNote(T, "格子里跟它说");
  return true;
}
function auiKey(l, key) { const T = l.tab; if (T && T.stream) T.stream.send(enc.encode(key)); }
const leafById = (id) => { const x = allLeaves().find((y) => y.l.id === id); return x ? x.l : null; };
function auiInput(el) {
  el.style.height = "auto";
  el.style.height = Math.min(140, Math.max(20, el.scrollHeight)) + "px";
}
CLICKS.push((t) => {
  const b = t.closest("[data-aui],[data-tsend],[data-tview]");
  if (!b) {
    // 点到格子身体的空处：键盘交给「跟它说」（有选中文字时不抢，让人能复制）
    const tb = t.closest(".tile:not(.v-term) .tb");
    if (tb && !t.closest("a,button") && !String(getSelection() || "").trim()) { const i = qs(".tin-in", tb.closest(".tile")); if (i) i.focus(); }
    return false;
  }
  if (b.dataset.tview) {
    const l = leafById(b.dataset.tview);
    if (!l) return true;
    l.view = l.view === "term" ? "ui" : "term"; l.v++;
    render();
    const el = TEL.get(l.id);
    requestAnimationFrame(() => {
      if (l.view === "term" && l.tab) { try { l.tab.refit(); l.tab.focus(); } catch (_) {} }
      else { const i = el && qs(".tin-in", el); if (i) i.focus(); }
    });
    return true;
  }
  const lf = leafOfEl(b);
  const l = lf && lf.leaf;
  if (!l) return true;
  if (b.hasAttribute("data-tsend")) {
    if (leafState(l) === "work" && b.classList.contains("stop")) { auiKey(l, "\x1b"); return true; }
    const i = qs(".tin-in", TEL.get(l.id));
    if (i && auiSend(l, i.value)) { i.value = ""; auiInput(i); i.focus(); }
    return true;
  }
  const act = b.dataset.aui, v = b.dataset.v;
  if (act === "pick") auiKey(l, v);
  else if (act === "menu") {
    const T = l.tab;
    const moves = menuMoves(T, new RegExp("^\\s*[❯>›]?\\s*" + v + "[.)]\\s"));
    if (moves === null) { toast("屏上的选项对不上了 —— 去终端里自己点一下", "warn"); return true; }
    pressMenu(T, moves);
  } else if (act === "term") { l.view = "term"; l.v++; render(); requestAnimationFrame(() => { try { l.tab.refit(); l.tab.focus(); } catch (_) {} }); }
  return true;
});
document.addEventListener("keydown", (e) => {
  const i = e.target;
  if (!i.classList || !i.classList.contains("tin-in")) return;
  if (e.isComposing || e.keyCode === 229) return;   // 输入法组字中：回车是选词
  const lf = leafOfEl(i);
  if (!lf) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (auiSend(lf.leaf, i.value)) { i.value = ""; auiInput(i); }
  } else if (e.key === "Escape" && leafState(lf.leaf) === "work") {
    e.preventDefault(); e.stopPropagation();
    auiKey(lf.leaf, "\x1b");
  }
}, true);
document.addEventListener("input", (e) => { if (e.target.classList && e.target.classList.contains("tin-in")) auiInput(e.target); });

// 格头上的「终端」按钮（切到它的原样终端 / 切回 Agent 界面）
LEAF_CTL.unshift((l) => l.tab ? `<button class="tf tv${l.view === "term" ? " on" : ""}" data-tview="${l.id}" title="${l.view === "term" ? "回到 Agent 界面" : "看它的终端（原样）"}">${ICON("square-terminal", 13)}</button>` : "");
// 屏上菜单 / 登录门不是事件：有格子在等或刚起来时，每秒看一眼它的屏
setInterval(() => {
  if (document.hidden) return;
  for (const { z, l } of allLeaves()) if (l.tab && l.view !== "term" && !z.collapsed) { const el = TEL.get(l.id); if (el) renderAgentBody(l, el); }
}, 1000);
