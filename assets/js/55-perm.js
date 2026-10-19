"use strict";
/* 55-perm.js —— 权限框就地答：读 Claude Code 的批准框、点「允许 / 拒绝」。
   本文件是 index.html 里按序 defer 的一段 classic script；所有文件共享同一个全局词法作用域。

   为什么要读屏：转录里只有那条工具调用挂着（ok==null），**选项和顺序一概没有** ——
   权限框只画在那一格的终端里。实测（2026-10-19，Claude Code v2.1.299 + 隔离沙盒）：

     Do you want to create spike.txt?
     ❯ 1. Yes
       2. Yes, and switch to accept edits (…) for this session (shift+tab)
       3. No
       Esc to cancel · Tab to amend

   · **数字键直选**：按 `1` 立刻生效，不用回车，且与高亮在哪一行无关（实测写过文件）。
   · **Esc = 取消**（`{behavior:"cancelled"}`）：等同「No」——实测落 `User rejected …`，
     这一轮继续。它不依赖高亮和编号，是"拒绝"最稳的一条路。
   · **选项顺序不固定**：`permissionResult.defaultToNo` 时 No 会排第一，还可能夹带
     `Yes, and …` 变体 ⇒ **绝不能固定发 `1`**（Orca 对 Claude 就是固定 `1`，这里不能照抄）。
     必须认出标签**恰好是 `Yes`** 的那一行，发它自己的编号。
   · 页脚出现 `Tab to amend` 时不在补充说明的输入态；那一行提示消失就说明 Tab 进了输入框
     （那时数字会被当打字吃掉）⇒ 拿它当闸。

   安全闸照 50-ask.js 的那一套：任何一条不过就**一个字节都不送**，只落一句实话。
   ⚠️ 屏幕是比转录更晚的事实来源，但也可能是**另一件事**（比如你在终端里已经答了上一个、
   下一个框已经弹出来）⇒ 送键前必须比对"屏上这一屏"和"转录里那条工具调用"，对不上就不送。 */

const permErr = new Map();     // tool_use_id → {act, text}：点了一下没走上的那句实话
const permBusy = new Map();    // tabId → {id, act}：已经按过一下、正在等回声（挡连点）

/* 比对用的归一：去掉空白/标点/符号，只留字母数字（含中文）。
   屏上的 `Write(spike.txt)` 与转录的 `Write spike.txt` 在归一后都是 `writespiketxt`。 */
const permNorm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/* 读那一格**屏上**的权限框。三种结果：
     null            这一屏上没有批准框（没弹、已经答完、或者页面上别的东西）
     {amend:true}    框在「Tab 补充说明」的输入态（页脚那句 `Tab to amend` 不见了）
     {…}             读到了（yesN=0 表示这一屏没有单独的 `Yes`，比如计划确认那类）
   ⚠️ 只扫**视口**：滚上去看历史时读不到当前框，这时按钮做灰是诚实的。 */
function readPermDialog(t) {
  const b = t && t.term && t.term.buffer.active;
  if (!b) return null;
  const R = t.term.rows || 50;
  const lo = Math.max(0, b.viewportY), hi = Math.min(b.length - 1, lo + R - 1);
  const at = (i) => {
    const ln = b.getLine(i);
    return ln ? ln.translateToString(true).replace(/\s+$/, "") : "";
  };

  let foot = -1;
  for (let i = lo; i <= hi; i++) {
    const s = at(i);
    // 取**最后一个**：框画在输入框上方，最后一个才是当前那一个
    if (s.indexOf("Esc to cancel") >= 0) foot = i;
  }
  if (foot < 0) return null;
  if (at(foot).indexOf("Tab to amend") < 0) return { amend: true, foot };

  /* 选项行：页脚上方 20 行内的 `N. 文本`。编号必须**恰好是 1..N、每号一次** ——
     这是挡"把屏上别的编号列表当成选项"的那道闸。高亮 `❯` 只记下来（数字键与它无关）。 */
  const lim = Math.max(lo, foot - 20);
  const opt = {};
  let firstOpt = -1, hiN = 0;
  for (let i = foot - 1; i >= lim; i--) {
    const s = at(i);
    if (!s) continue;
    const m = s.match(/^\s*(❯\s*)?(\d+)\.\s+(\S.*)$/);
    if (!m) continue;
    const n = +m[2];
    if (!(n in opt)) {
      opt[n] = m[3].trim();
      firstOpt = i;              // 往上扫 ⇒ 最后赋值的是最上面那一行
    }
    if (m[1] && !hiN) hiN = n;
  }
  const nums = Object.keys(opt).map(Number).sort((x, y) => x - y);
  const seq = nums.length >= 2 && nums.length <= 9 && nums.every((n, i) => n === i + 1);
  const yes = seq ? nums.filter((n) => opt[n] === "Yes") : [];

  // 屏上那一句问题：选项块上方最近的一行非空（给卡片显示用）
  let q = "";
  for (let i = firstOpt - 1; i >= Math.max(lo, firstOpt - 6); i--) {
    const s = at(i).trim();
    if (!s) continue;
    q = s;
    break;
  }

  /* 比对区域：页脚往上 60 行（只视口内、只页脚上方）。比选项窗口宽得多 ——
     工具调用的头部/描述可能在预览块上方很远，而选项块本身只有几行。 */
  const from = Math.max(lo, foot - 60);
  const region = [];
  for (let i = from; i < foot; i++) region.push(at(i));

  return {
    amend: false, foot,
    n: seq ? nums.length : 0,
    opts: seq ? opt : {},
    yesN: yes.length === 1 ? yes[0] : 0,
    yesCount: yes.length,
    hiN, q,
    region: region.join("\n"),
    why: seq ? "" : "屏上的选项编号对不上（不是 1..N），没按",
  };
}

/* 屏上这一屏是不是转录里**那一条**工具调用。
   为什么必须有这道闸：屏幕比转录快 —— 你刚在终端里答掉上一个框、下一个框已经弹出来时，
   转录还挂着旧的那条。那时按下的 `1` 会答到**下一件事**上，静默做错事。
   判据：转录里那句描述/文件名/命令在屏上找得到（归一去空白后比对）；
   太短的文本（<=3 字）不当判据，退回"工具名在屏上"。 */
function permScreenMatches(region, a) {
  const hay = permNorm(region);
  if (!hay || !a) return false;
  const tool = permNorm(a.tool);
  const text = permNorm(a.text);
  if (text.length >= 4) {
    if (hay.indexOf(text) >= 0) return true;
    // `Write spike.txt` ↔ 屏上的 `Write(spike.txt)`：去掉工具名再比一次
    if (text.indexOf(tool) === 0) {
      const rest = text.slice(tool.length);
      if (rest.length >= 3 && hay.indexOf(rest) >= 0) return true;
    }
    return false;
  }
  return tool.length >= 3 && hay.indexOf(tool) >= 0;
}

/* 渲染那一刻的可用性：两颗键**分开**判 —— 拒绝（Esc）不依赖"屏上有没有单独的 Yes"。
   读屏本身是便宜的（视口 60 行），每 400ms 跟着行重画读一遍没问题。 */
function permState(a, t) {
  if (!a) return null;
  const busy = !!permBusy.get(t && t.id);
  const deny0 = (why) => ({ allow: false, deny: false, yesN: 0, q: "", why, busy });
  if (!t || !t.stream || !t.ready) return deny0("那一格的终端没连着");
  const p = readPermDialog(t);
  if (!p) return deny0("那一格屏上没有权限框（可能已经答过了）");
  if (p.amend) return deny0("那一格的权限框在「Tab 补充说明」的输入态 —— 去这一格退出后再点");
  if (!permScreenMatches(p.region, a))
    return deny0("屏上这一屏和转录对不上（可能已经换成另一件事了）—— 去这一格看看");
  return {
    allow: !!p.yesN, deny: true, yesN: p.yesN | 0, q: p.q || "",
    why: p.yesN ? "" : "这一屏上没有单独的「Yes」（只有带条件的是）—— 去这一格选",
    busy,
  };
}

function permBlockSig(a, ps) {
  return "perm:" + (a.id || "") + ":" + (a.ok == null ? "pending" : "done") +
    ":" + String(a.tool || "") + ":" + String(a.text || "") +
    ":" + (ps ? [ps.allow ? 1 : 0, ps.deny ? 1 : 0, ps.yesN | 0,
                 ps.q || "", ps.why || "", ps.busy ? 1 : 0].join("\u0001") : "") +
    ":" + JSON.stringify(permErr.get(a.id) || null);
}

/* 卡片。和待办卡同一个位置/同一套边距，但它**真的是两颗按钮**（不是一份清单）：
   允许 = 按屏上那个单独的 Yes，拒绝 = 按 Esc。不可用时做灰、不做禁、不做隐 ——
   为什么不可用写在 title 上（禁了 title 不弹）。 */
function permHTML(a, t, ps) {
  const err = permErr.get(a.id) || null;
  const busy = !!(ps && ps.busy);
  const why = busy ? "已经替你在这一格里按了一下，正在等那一格的反应" : ((ps && ps.why) || "");
  const allowOn = !!(ps && ps.allow) && !busy;
  const denyOn = !!(ps && ps.deny) && !busy;
  // 屏上那句问题最具体；读不到就退回转录里那句描述
  const q = (ps && ps.q) || a.text || a.tool || "它有一件事要你批准";
  const allowTitle = allowOn
    ? `替你按「Yes」（屏上第 ${ps.yesN} 项 —— 只在它确实是单独的 Yes 时才按）`
    : (why || "现在按不了");
  const denyTitle = denyOn
    ? "替你按 Esc（等同选 No：拒绝这一次，这一轮继续）"
    : (why || "现在按不了");
  return `<div class="gperm" data-pi="${esc(a.id || "")}">` +
    `<div class="ph"><span>要你批权限</span>` +
      `<span class="px" title="${esc(a.text || a.tool || "")}">· ${esc(clamp(a.text || a.tool || "", 90))}</span>` +
    `</div>` +
    `<div class="pq">${esc(clamp(q, 300))}</div>` +
    `<div class="pf">` +
      `<button class="go allow${allowOn ? "" : " mute"}" data-perm="allow"` +
        ` title="${esc(allowTitle)}">允许</button>` +
      `<button class="go deny${denyOn ? "" : " mute"}" data-perm="deny"` +
        ` title="${esc(denyTitle)}">拒绝</button>` +
      `<span class="tm" data-at="${esc(a.at || "")}" title="${esc(absTime(a.at))}">${esc(rel(a.at))}</span>` +
      `<button class="go" data-go="${t.id}">去这一格 →</button>` +
    `</div>` +
    (err ? `<div class="perr">${esc(err.text)}</div>` : "") +
  `</div>`;
}

/* 把那句"没按成 / 结果不明"落到卡上（同一格只留最近一条），并让行重画一次。
   ⚠️ 和 answerNote 一样：贴上去只是当场可见，真正让它活过下一次重画的是 permErr。 */
function permNote(el, id, act, text) {
  if (id) permErr.set(id, { act, text });
  const box = el && el.closest ? el.closest(".gperm") : null;
  if (box) {
    for (const old of Array.from(box.querySelectorAll(".perr"))) old.remove();
    box.insertAdjacentHTML("beforeend", `<div class="perr">${esc(text)}</div>`);
  }
  scheduleGroup();
}

/* 按下去之后**等回声**：转录里那条工具调用拿到结果、或者这一格已经离开 waiting
   （Wave 2 的 PostToolUse 比转录早）都算成。
   ⚠️ 等不到就**只说不重试**：补一下可能把数字打进输入框（框已经没了的时候）。 */
function watchPermEcho(t, id, el, act, label) {
  const t0 = Date.now();
  const tick = () => {
    const v = LIVE.get(t.id);
    const it = v && (v.acts || []).find((x) => x.id === id);
    if (it && it.ok != null) {
      permBusy.delete(t.id);
      sendCtrl({ type: "log", msg: `批权限 回声 tab=${t.id} 按=${label} 转录有结果 用时=${Date.now() - t0}ms` });
      scheduleGroup();
      return;
    }
    if (v && v.st !== "waiting") {
      permBusy.delete(t.id);
      sendCtrl({ type: "log", msg: `批权限 回声 tab=${t.id} 按=${label} 已离开等待 用时=${Date.now() - t0}ms` });
      scheduleGroup();
      return;
    }
    if (Date.now() - t0 < 2500) return void setTimeout(tick, 250);
    permBusy.delete(t.id);
    permNote(el, id, act,
      `已经替你在这一格里按下「${label}」，但 2.5 秒里没等到结果 → 去这一格看看`);
    sendCtrl({ type: "log", msg: `批权限 回声 tab=${t.id} 按=${label} 没等到结果（未重试）` });
  };
  setTimeout(tick, 300);
}

/* 点「允许 / 拒绝」。闸全过才写字节；任何一条不过就什么都不送。 */
function permFromGroup(t, el, allow) {
  const box = el.closest ? el.closest(".gperm") : null;
  const id = (box && box.dataset.pi) || "";
  const act = allow ? "allow" : "deny";
  const label = allow ? "允许" : "拒绝";
  const v = LIVE.get(t.id);
  const it = v && (v.acts || []).find((x) => x.id === id);
  // 闸①：那条工具调用还挂着（结构化判据，比屏幕硬）
  if (!it || it.ok != null) return permNote(el, id, act, "这条权限框已经有结果了，没按");
  if (it.tool === "AskUserQuestion") return permNote(el, id, act, "这是提问框，不归这里按，没按");
  // 闸②：那一格活着、PTY 还连着
  if (!t.stream || !t.ready) return permNote(el, id, act, "那一格的终端没连着，没按");
  // 闸③：已经按过一下、还在等回声 ⇒ 忽略连点（再送一下可能打进已经空出来的输入框）
  if (permBusy.has(t.id)) return;
  // 闸④：屏上**现在**确实是一个权限框，而且没有进 Tab 输入态
  const p = readPermDialog(t);
  if (!p) return permNote(el, id, act, "那一格屏上没有权限框了，没按");
  if (p.amend) return permNote(el, id, act,
    "那一格的权限框在「Tab 补充说明」的输入态 —— 去这一格退出后再点，没按");
  // 闸⑤：屏上这一屏必须是转录里那一条（挡住"答到下一件事上"）
  if (!permScreenMatches(p.region, it))
    return permNote(el, id, act, "屏上这一屏和转录对不上（可能已经换成另一件事了），没按");

  let send, k;
  if (allow) {
    // 闸⑥：屏上必须**恰好**有一行标签是 `Yes`（`Yes, and …` 变体不算）
    if (!p.yesN) return permNote(el, id, act,
      p.yesCount ? "屏上有不止一个「Yes」，认不准，没按"
                 : "这一屏上没有单独的「Yes」（只有带条件的是）—— 去这一格选，没按");
    k = String(p.yesN);
    send = k;
  } else {
    // Esc 与高亮/编号无关（实测等同选 No，这一轮继续）
    k = "Esc";
    send = "\x1b";
  }
  permErr.delete(id);
  permBusy.set(t.id, { id, act });
  t.stream.send(enc.encode(send));
  scheduleGroup();                      // 立刻把两颗键做灰（连点的第一道挡）
  sendCtrl({ type: "log", msg:
    `批权限 按=${label} tab=${t.id} 送=${k}` +
    `${allow ? ` 屏上第${p.yesN}行=「${(p.opts[p.yesN] || "").slice(0, 24)}」高亮第${p.hiN || 0}行` : ""}` +
    ` 「${String(it.text || it.tool || "").slice(0, 40)}」` });
  watchPermEcho(t, id, el, act, label);
}
