"use strict";
/* 11-term-output.js —— 前台格的 PTY 输出管线（照 Orca，MIT）。

   Orca 的出处（文件:作用）：
     pty-connection/write-pty-output-to-xterm.ts      每一块输出怎么分类、带哪些写入选项
     pty-connection/foreground-output-refresh.ts      哪些输出写完要强制刷新视口
     lib/pane-manager/terminal-complex-script.ts      CR / 退格 / 擦除 / CJK / 背景色这些「原地重写」判据
     lib/pane-manager/pane-terminal-output-writer.ts  DEC 2026 同步帧：帧没结束先压住，结束了整帧写
     lib/pane-manager/pane-terminal-foreground-queue-state.ts  压帧的兜底时限（250ms / 交互帧 32ms / 合帧 16ms）
     lib/pane-manager/pane-terminal-cursor-sequencing.ts       帧中途的「显示光标」挪到帧尾
     lib/pane-manager/pane-terminal-foreground-render-settle.ts 写完按 xterm 自己的脏行同步刷新，必要时下一帧再补一次
     lib/pane-manager/terminal-parsed-dirty-rows.ts   订阅 xterm 解析出的脏行区间
     shared/terminal-synchronized-output-scan.ts      跨块拼接的 2026 标记扫描

   为什么要它：Windows ConPTY 下 TUI（Claude 的输入框、Codex / Pi / OpenCode 的整屏）原地重画时，
   xterm 的缓冲是对的、画面却会晚一帧或留下残影（"打字时画面偏移"、中文残字、光标闪到别处）。
   Orca 的做法是：整帧再画、把中途的光标显示挪走、写完对脏行做一次同步刷新、原地重写再补一帧。
   我们只有本机 ConPTY 一种情形，所以 Orca 里远程 / SSH / 隐藏格快照 / 背压计数那些分支都没搬。
   全部判据和常数原样保留。 */

// ---- 常数（foreground-output-budgets.ts / pane-terminal-foreground-queue-state.ts） ----
const TO_SYNC_START = "\x1b[?2026h";
const TO_SYNC_END = "\x1b[?2026l";
const TO_SYNC_MARKER_TAIL = TO_SYNC_START.length - 1;
const TO_CURSOR_SHOW = "\x1b[?25h";
const TO_CURSOR_HIDE = "\x1b[?25l";
const TO_INTERACTIVE_REDRAW_WINDOW_MS = 150;
const TO_SYNC_FRAME_INTERACTIVE_WINDOW_MS = 400;
const TO_INTERACTIVE_REDRAW_CHARS = 128 * 1024;
const TO_HOLD_SAFETY_MS = 250;
const TO_LATENCY_HOLD_SAFETY_MS = 32;
const TO_COALESCE_MS = 1000;
const TO_LATENCY_COALESCE_MS = 16;
const TO_RISK_SCAN_TAIL_CHARS = 256;
const TO_REWRITE_CSI_TAIL_MAX = 64;
const TO_THROUGHPUT_IMMEDIATE_CHARS = 2048;
const TO_IMMEDIATE_BUDGET_CHARS = 128 * 1024;
const TO_BUDGET_WINDOW_MS = 500;

// ---- shared/terminal-synchronized-output-scan.ts ----
function toScanSynchronized(data, markerTail, wasActive) {
  const scanData = markerTail ? markerTail + data : data;
  const chunkStart = scanData.length - data.length;
  let active = wasActive, started = false, ended = false;
  let s = scanData.indexOf(TO_SYNC_START), e = scanData.indexOf(TO_SYNC_END);
  while (s !== -1 || e !== -1) {
    if (e !== -1 && (s === -1 || e < s)) {
      active = false;
      if (e + TO_SYNC_END.length > chunkStart) ended = true;
      e = scanData.indexOf(TO_SYNC_END, e + TO_SYNC_END.length);
      continue;
    }
    active = true;
    if (s + TO_SYNC_START.length > chunkStart) started = true;
    s = scanData.indexOf(TO_SYNC_START, s + TO_SYNC_START.length);
  }
  return { started, ended, active, markerTail: scanData.slice(-TO_SYNC_MARKER_TAIL) };
}

// ---- pane-terminal-cursor-sequencing.ts（原样） ----
function toCursorPositionEnd(data, from, to = data.length) {
  let offset = data.indexOf("\x1b[", from);
  while (offset !== -1 && offset < to) {
    let i = offset + 2;
    while (i < to) {
      const c = data[i];
      if (c === "G" || c === "H" || c === "f") return i + 1;
      if ((c < "0" || c > "9") && c !== ";") break;
      i += 1;
    }
    offset = data.indexOf("\x1b[", offset + 2);
  }
  return -1;
}
function toRemoveTransientCursorShows(data) {
  let result = "", offset = 0;
  let show = data.indexOf(TO_CURSOR_SHOW);
  while (show !== -1) {
    const nextHide = data.indexOf(TO_CURSOR_HIDE, show + TO_CURSOR_SHOW.length);
    const posEnd = toCursorPositionEnd(data, show + TO_CURSOR_SHOW.length, nextHide === -1 ? data.length : nextHide);
    if (nextHide === -1) {
      if (posEnd === -1) {
        const syncEnd = data.indexOf(TO_SYNC_END, show + TO_CURSOR_SHOW.length);
        if (syncEnd === -1) break;
        // 同步重画期间保持光标隐藏，帧结束后再显示：Windows 下不会在中间位置画出光标
        result += data.slice(offset, show);
        result += data.slice(show + TO_CURSOR_SHOW.length, syncEnd + TO_SYNC_END.length);
        result += TO_CURSOR_SHOW;
        offset = syncEnd + TO_SYNC_END.length;
        show = data.indexOf(TO_CURSOR_SHOW, offset);
        continue;
      }
      // 先定位再显示，xterm 就不会把光标画在旧格子上
      result += data.slice(offset, show);
      result += data.slice(show + TO_CURSOR_SHOW.length, posEnd);
      result += TO_CURSOR_SHOW;
      offset = posEnd;
      show = data.indexOf(TO_CURSOR_SHOW, offset);
      continue;
    }
    result += data.slice(offset, show);
    offset = show + TO_CURSOR_SHOW.length;
    show = data.indexOf(TO_CURSOR_SHOW, offset);
  }
  return offset === 0 ? data : result + data.slice(offset);
}
function toContainsCursorPosition(data) { return toCursorPositionEnd(data, 0) !== -1; }
function toContainsCursorRestore(data) {
  const hide = data.indexOf(TO_CURSOR_HIDE), show = data.lastIndexOf(TO_CURSOR_SHOW);
  return hide !== -1 && show > hide && toContainsCursorPosition(data);
}
function toContainsDrainableCursorRestore(data) {
  const syncEnd = data.lastIndexOf(TO_SYNC_END);
  return syncEnd === -1 ? toContainsCursorRestore(data) : toContainsCursorRestore(data.slice(syncEnd + TO_SYNC_END.length));
}
function toFinalCursorPlacementBeforeSyncEnd(data) {
  const syncEnd = data.lastIndexOf(TO_SYNC_END);
  if (syncEnd === -1) return false;
  const lastShow = data.lastIndexOf(TO_CURSOR_SHOW, syncEnd);
  if (lastShow === -1) return false;
  if (data.lastIndexOf(TO_CURSOR_HIDE, syncEnd) > lastShow) return false;
  return toCursorPositionEnd(data, lastShow + TO_CURSOR_SHOW.length, syncEnd) !== -1;
}
function toQueuedNeedsCursorRestore(queuedData) {
  const syncEnd = queuedData.lastIndexOf(TO_SYNC_END);
  if (syncEnd === -1) return false;
  const frame = queuedData.slice(0, syncEnd + TO_SYNC_END.length);
  return toContainsCursorRestore(frame) && !toFinalCursorPlacementBeforeSyncEnd(frame) && !toContainsDrainableCursorRestore(queuedData);
}

// ---- lib/pane-manager/terminal-complex-script.ts（原样） ----
const TO_EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const TO_SGR = /\x1b\[([0-9:;]*)m/g;
const toInRange = (v, a, b) => v >= a && v <= b;
function toStandaloneCR(data) {
  let i = data.indexOf("\r");
  while (i !== -1) {
    if (i === data.length - 1) return false;
    if (data[i + 1] !== "\n") return true;
    i = data.indexOf("\r", i + 1);
  }
  return false;
}
function toRiskCodePoint(v) {
  return toInRange(v, 0x0590, 0x08ff) || v === 0x200d || toInRange(v, 0x1100, 0x11ff) ||
    toInRange(v, 0x2e80, 0x9fff) || toInRange(v, 0xa960, 0xa97f) || toInRange(v, 0xac00, 0xd7ff) ||
    toInRange(v, 0xd800, 0xdfff) || toInRange(v, 0xf900, 0xfaff) || toInRange(v, 0xfe10, 0xfe1f) ||
    toInRange(v, 0xfe30, 0xfe4f) || toInRange(v, 0xfb1d, 0xfdff) || toInRange(v, 0xfe00, 0xfe0f) ||
    toInRange(v, 0xfe70, 0xfeff) || toInRange(v, 0xff00, 0xffef) || v === 0xfffd ||
    toInRange(v, 0x10ec0, 0x10eff) || toInRange(v, 0x1e900, 0x1e95f) || toInRange(v, 0x20000, 0x2fa1f) ||
    toInRange(v, 0x30000, 0x3134f) || toInRange(v, 0xe0100, 0xe01ef);
}
function toEastAsianRiskCodePoint(v) {
  return toInRange(v, 0x1100, 0x11ff) || toInRange(v, 0x2e80, 0x9fff) || toInRange(v, 0xa960, 0xa97f) ||
    toInRange(v, 0xac00, 0xd7ff) || toInRange(v, 0xf900, 0xfaff) || toInRange(v, 0xfe10, 0xfe1f) ||
    toInRange(v, 0xfe30, 0xfe4f) || toInRange(v, 0xff00, 0xffef) || toInRange(v, 0x20000, 0x2fa1f) ||
    toInRange(v, 0x30000, 0x3134f);
}
function toSgrCode(p) {
  if (!p) return null;
  const v = Number.parseInt(p.split(":")[0] ?? "", 10);
  return Number.isFinite(v) ? v : null;
}
function toSgrSetsBackground(params) {
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const v = toSgrCode(parts[i]);
    if (v === null) continue;
    if (toInRange(v, 40, 47) || toInRange(v, 100, 107) || v === 48) return true;
    if (v === 38 && !parts[i]?.includes(":")) {
      const mode = toSgrCode(parts[i + 1]);
      if (mode === 5) i += 2; else if (mode === 2) i += 4; else i += 1;
    }
  }
  return false;
}
function toContainsBackgroundSgr(data) {
  if (!data.includes("\x1b[")) return false;
  TO_SGR.lastIndex = 0;
  for (let m = TO_SGR.exec(data); m; m = TO_SGR.exec(data)) if (toSgrSetsBackground(m[1] ?? "")) return true;
  return false;
}
function toContainsRewriteErase(data) {
  let esc = data.indexOf("\x1b[");
  while (esc !== -1) {
    for (let i = esc + 2; i < data.length; i++) {
      const c = data[i];
      if ((c >= "0" && c <= "9") || c === ";" || c === "?") continue;
      if (c === "J" || c === "K") return true;   // 擦除式重写：缓冲对、画面留残影
      break;
    }
    esc = data.indexOf("\x1b[", esc + 2);
  }
  return false;
}
function toTrailingRewriteCsiTail(data) {
  const esc = data.lastIndexOf("\x1b");
  if (esc === -1) return "";
  const tail = data.slice(esc);
  if (tail === "\x1b") return tail;
  if (!tail.startsWith("\x1b[") || tail.length > TO_REWRITE_CSI_TAIL_MAX) return "";
  for (let i = 2; i < tail.length; i++) {
    const c = tail[i];
    if ((c >= "0" && c <= "9") || c === ";" || c === "?") continue;
    return "";
  }
  return tail;
}
function toRewritePrefersRefresh(data) {
  return data.includes("\b") || toStandaloneCR(data) || toContainsRewriteErase(data);
}
function toOutputPrefersRefresh(data) {
  if (toContainsBackgroundSgr(data)) return true;
  let nonAscii = false;
  for (let i = 0; i < data.length; i += 1) if (data.charCodeAt(i) > 0x7f) { nonAscii = true; break; }
  if (!nonAscii) return false;
  if (TO_EMOJI_PRESENTATION.test(data)) return true;
  for (let i = 0; i < data.length; i += 1) {
    const cp = data.codePointAt(i);
    if (cp === undefined) continue;
    if (toRiskCodePoint(cp)) return true;
    if (cp > 0xffff) i += 1;
  }
  return false;
}
function toContainsEastAsian(data) {
  for (let i = 0; i < data.length; i += 1) {
    const cp = data.codePointAt(i);
    if (cp === undefined) continue;
    if (toEastAsianRiskCodePoint(cp)) return true;
    if (cp > 0xffff) i += 1;
  }
  return false;
}
// fresh-spawn-follow-reset.ts 的 trailingIncompleteCsiSequence
function toTrailingIncompleteCsi(data) {
  const esc = data.lastIndexOf("\x1b");
  if (esc === -1) return "";
  const tail = data.slice(esc);
  if (tail === "\x1b") return tail;
  if (!tail.startsWith("\x1b[")) return "";
  for (let i = 2; i < tail.length; i++) {
    const c = tail.charCodeAt(i);
    if (c >= 0x40 && c <= 0x7e) return "";
  }
  return tail.slice(0, TO_RISK_SCAN_TAIL_CHARS);
}

// ---- terminal-parsed-dirty-rows.ts：订阅 xterm 自己的「解析后要刷哪几行」 ----
function toAttachDirtyRows(term) {
  const ih = term._core && term._core._inputHandler;
  if (!ih || typeof ih.onRequestRefreshRows !== "function") return null;
  const tr = { start: 0, end: 0, observed: false, whole: false, dispose: () => {} };
  try {
    const sub = ih.onRequestRefreshRows.call(ih, (ev) => {
      if (!ev) { tr.whole = true; tr.observed = true; return; }
      if (!tr.observed) { tr.start = ev.start; tr.end = ev.end; tr.observed = true; return; }
      tr.start = Math.min(tr.start, ev.start); tr.end = Math.max(tr.end, ev.end);
    });
    tr.dispose = () => sub.dispose();
  } catch (_) { return null; }
  return tr;
}

/* 每一格一份。用法：
     const out = createTermOutput(term);
     out.pushBytes(u8)     —— 流上来的字节
     out.noteInput()       —— 用户按键 / 粘贴 / 输入法提交时调（判"交互帧"）
     out.dispose()                                                              */
function createTermOutput(term) {
  const decoder = new TextDecoder();
  const dirty = toAttachDirtyRows(term);
  const st = {
    syncActive: false, markerTail: "", frameInteractive: false,
    lastInputAt: -1e9,
    rewriteCR: false, rewriteTail: "", riskTail: "",
    // 压帧队列（Orca 的 QueueEntry 精简版）
    chunks: [], hold: false, coalesce: false, holdTimer: 0, coalesceTimer: 0,
    deadlineAt: null, deadlineFixed: false, holdExtended: false,
    holdDelay: TO_HOLD_SAFETY_MS, coalesceDelay: TO_COALESCE_MS,
    settleRaf: 0, disposed: false,
    budget: { chars: 0, windowStart: 0 },
  };
  // foreground-output-budgets.ts：滚动窗口预算，免得一串「交互」小帧把定时器饿死
  const consumeBudget = (n) => {
    const now = performance.now();
    if (now - st.budget.windowStart >= TO_BUDGET_WINDOW_MS) { st.budget.chars = 0; st.budget.windowStart = now; }
    if (st.budget.chars + n > TO_IMMEDIATE_BUDGET_CHARS) return false;
    st.budget.chars += n;
    return true;
  };
  // foreground-output-refresh.ts 的 isLatencySensitiveForegroundOutput（当前格那一支）
  const latencySensitiveOutput = (data) => {
    if (data.length <= TO_THROUGHPUT_IMMEDIATE_CHARS) return consumeBudget(data.length);
    const recent = performance.now() - st.lastInputAt <= TO_INTERACTIVE_REDRAW_WINDOW_MS;
    if (recent && data.length <= TO_INTERACTIVE_REDRAW_CHARS && data.includes("\x1b[")) return consumeBudget(data.length);
    return false;
  };

  // ---- 写入后对齐画面（pane-terminal-foreground-render-settle.ts） ----
  const snapshot = () => {
    const a = term.buffer.active;
    return { type: a.type, cursorY: a.cursorY, baseY: a.baseY, viewportY: a.viewportY };
  };
  const viewportMoved = (b, a) => a.baseY !== b.baseY || a.viewportY !== b.viewportY;
  const refreshRows = (span) => {
    if (!term.rows || st.disposed) return;
    try {
      const last = Math.max(0, term.rows - 1);
      const start = span ? Math.min(Math.max(span.start, 0), last) : 0;
      const end = span ? Math.min(Math.max(span.end, start), last) : last;
      // Windows 的原地重写要立刻补画；WebGL 会把它并进已排队的那一帧
      if (term._core && typeof term._core.refresh === "function") term._core.refresh(start, end, true);
      else term.refresh(start, end);
    } catch (_) { /* 格子正在拆 */ }
  };
  const scheduleSettle = () => {
    if (st.settleRaf) cancelAnimationFrame(st.settleRaf);
    st.settleRaf = requestAnimationFrame(() => { st.settleRaf = 0; refreshRows(null); });
  };
  const writeChunk = (data, o) => {
    const before = o.forceRefresh ? snapshot() : null;
    if (before && dirty) { dirty.observed = false; dirty.whole = false; dirty.start = 0; dirty.end = 0; }
    const payload = o.strip ? toRemoveTransientCursorShows(data) : data;
    term.write(payload, () => {
      if (!before || st.disposed) return;
      try {
        const after = snapshot();
        let span = null;
        if (before.type === after.type && !viewportMoved(before, after) && dirty && dirty.observed && !dirty.whole) {
          span = { start: Math.min(dirty.start, before.cursorY, after.cursorY), end: Math.max(dirty.end, before.cursorY, after.cursorY) };
        }
        refreshRows(span);
        // Chromium 可能在解析完之后才画上滚出的行：下一帧再补一次
        if (o.followup || viewportMoved(before, after)) scheduleSettle();
      } catch (_) {}
    });
  };

  // ---- 压帧 / 合帧（pane-terminal-output-writer.ts + foreground-queue-state.ts 的前台分支） ----
  const queuedText = () => st.chunks.map((c) => c.data).join("");
  const resetGate = () => { st.deadlineAt = null; st.deadlineFixed = false; st.holdExtended = false; };
  const clearHold = () => { if (st.holdTimer) { clearTimeout(st.holdTimer); st.holdTimer = 0; } st.holdDelay = TO_HOLD_SAFETY_MS; };
  const clearCoalesce = () => { if (st.coalesceTimer) { clearTimeout(st.coalesceTimer); st.coalesceTimer = 0; } st.coalesce = false; st.coalesceDelay = TO_COALESCE_MS; };
  const armDeadline = (delay, mayExtend) => {
    const now = performance.now(), want = now + delay;
    st.deadlineAt = st.deadlineAt === null || (mayExtend && !st.deadlineFixed) ? want : Math.min(st.deadlineAt, want);
    return Math.max(0, st.deadlineAt - now);
  };
  const drain = () => {
    if (st.disposed || st.hold || st.coalesce || !st.chunks.length) return;
    const list = st.chunks; st.chunks = [];
    // 同一次排空里的块按顺序合成一次写；刷新标志取并集
    const o = { strip: false, forceRefresh: false, followup: false };
    let data = "";
    for (const c of list) {
      data += c.o.strip ? toRemoveTransientCursorShows(c.data) : c.data;
      o.forceRefresh = o.forceRefresh || c.o.forceRefresh;
      o.followup = o.followup || c.o.followup;
    }
    writeChunk(data, o);
  };
  const scheduleHoldSafety = () => {
    const delay0 = st.holdDelay;
    const mayExtend = st.deadlineAt !== null && !st.holdExtended;
    clearHold();
    st.holdDelay = delay0;
    const delay = armDeadline(delay0, mayExtend);
    if (mayExtend) st.holdExtended = true;
    st.holdTimer = setTimeout(() => {
      st.holdTimer = 0; st.hold = false; clearCoalesce(); resetGate(); drain();
    }, delay);
  };
  const scheduleCoalesce = (earlier) => {
    if (st.coalesceTimer) {
      if (!earlier) { st.coalesce = true; return; }
      clearTimeout(st.coalesceTimer); st.coalesceTimer = 0;
    }
    st.coalesce = true;
    st.deadlineFixed = true;
    const delay = armDeadline(st.coalesceDelay, false);
    st.coalesceTimer = setTimeout(() => { st.coalesceTimer = 0; st.coalesce = false; resetGate(); drain(); }, delay);
  };
  const clearRelease = () => { clearHold(); clearCoalesce(); resetGate(); };

  const writeOutput = (data, o) => {
    if (!data) return;
    if (st.chunks.length || o.coalesce || o.hold) {
      st.chunks.push({ data, o });
      if (o.hold) {
        // 同步帧的开头 / 中段：压住不画，到点兜底放行
        if (o.latency) st.holdDelay = Math.min(st.holdDelay, TO_LATENCY_HOLD_SAFETY_MS);
        else if (!st.hold) st.holdDelay = TO_HOLD_SAFETY_MS;
        st.hold = true;
        clearCoalesce();
        scheduleHoldSafety();
        return;
      }
      if (o.coalesce || st.coalesce) {
        st.hold = false; clearHold();
        const shorten = o.latency === true;
        if (shorten) st.coalesceDelay = Math.min(st.coalesceDelay, TO_LATENCY_COALESCE_MS);
        const drainForLatency = shorten && !toQueuedNeedsCursorRestore(queuedText());
        if (toContainsDrainableCursorRestore(data) || drainForLatency) { clearRelease(); drain(); return; }
        // 帧结束和「光标归位」可能被切到两块里：等归位那块，到点兜底
        scheduleCoalesce(shorten);
        return;
      }
      st.hold = false; clearRelease(); drain();
      return;
    }
    writeChunk(data, o);
  };

  // ---- 每一块怎么分类（write-pty-output-to-xterm.ts + foreground-output-refresh.ts，本机 ConPTY） ----
  const shouldForceRefresh = (data) => {
    // 原地重写（CR / 退格 / 擦除），跨块拼接判断
    const scanR = st.rewriteTail ? st.rewriteTail + data : data;
    const rewrite = (st.rewriteCR && data[0] !== "\n") || toRewritePrefersRefresh(scanR);
    st.rewriteCR = data.endsWith("\r");
    st.rewriteTail = toTrailingRewriteCsiTail(scanR);
    const recentInput = performance.now() - st.lastInputAt <= TO_INTERACTIVE_REDRAW_WINDOW_MS;
    // 背景色 / CJK / emoji 这类渲染器高风险输出
    const scanK = st.riskTail ? st.riskTail + data : data;
    const risk = toOutputPrefersRefresh(scanK);
    st.riskTail = toTrailingIncompleteCsi(scanK);
    if (risk) return { refresh: true, inPlace: rewrite };
    if (rewrite) return { refresh: true, inPlace: true };
    // Windows：输入法提交的中日韩字、ConPTY 的宽字会在 DOM 渲染器里留旧格
    if (data.length <= TO_INTERACTIVE_REDRAW_CHARS && toContainsEastAsian(data)) return { refresh: true, inPlace: false };
    let nonAscii = false;
    for (let i = 0; i < data.length; i++) if (data.charCodeAt(i) > 0x7f) { nonAscii = true; break; }
    return { refresh: nonAscii && (data.includes("\r") || toRewritePrefersRefresh(data)), inPlace: false };
  };

  const push = (data) => {
    if (!data || st.disposed) return;
    const scan = toScanSynchronized(data, st.markerTail, st.syncActive);
    const syncFg = st.syncActive || scan.started || scan.ended;
    const nextActive = scan.active;
    const cursorRestore = toContainsCursorRestore(data);
    const decision = shouldForceRefresh(data);
    if (syncFg && scan.started) st.frameInteractive = performance.now() - st.lastInputAt <= TO_SYNC_FRAME_INTERACTIVE_WINDOW_MS;
    else if (!nextActive && !scan.ended) st.frameInteractive = false;
    // 键盘刚碰过的同步帧要快放（16/32ms）；其余按 Orca 的预算判（小块默认快放）
    const latency = (syncFg && st.frameInteractive) || latencySensitiveOutput(data);
    st.syncActive = nextActive;
    st.markerTail = scan.markerTail;
    writeOutput(data, {
      latency,
      forceRefresh: syncFg || cursorRestore || decision.refresh,
      followup: cursorRestore || decision.inPlace,
      strip: true,
      coalesce: syncFg && scan.ended,
      hold: syncFg && nextActive,
    });
  };

  return {
    pushBytes(u8) { push(decoder.decode(u8, { stream: true })); },
    pushText(s) { push(String(s)); },
    noteInput() { st.lastInputAt = performance.now(); },
    flushNow() { clearRelease(); st.hold = false; drain(); },
    dispose() {
      st.disposed = true; clearRelease();
      if (st.settleRaf) cancelAnimationFrame(st.settleRaf);
      try { dirty && dirty.dispose(); } catch (_) {}
      st.chunks = [];
    },
  };
}
