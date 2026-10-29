"use strict";
/* 12-term-keys.js —— 终端格的按键策略（照 Orca，MIT）。

   出处：
     components/terminal-pane/terminal-shortcut-policy.ts   修饰键组合 → 发什么字节（Windows 本机 ConPTY 那几支）
     shared/terminal-modified-enter-encoding.ts             Shift+Enter / Ctrl+Backspace 的编码
     components/terminal-pane/terminal-windows-shift-enter.ts + shared/tui-agent-config.ts
                                                            Shift+Enter 按 agent 选编码：pi 用 CSI-u，其余 ESC CR
     components/terminal-pane/terminal-ctrl-enter.ts        Ctrl+Enter：本机 ConPTY 下只有 droid/grok 这类认 CSI-u 的才发
     shared/keybindings/definitions-core-3.ts               复制 Ctrl+Shift+C / 有选区时 Ctrl+C；全选 Ctrl+Shift+A；
                                                            粘贴 Ctrl+V / Ctrl+Shift+V / Shift+Insert
     components/terminal-pane/xterm-bypass-policy.ts        没选区时 Ctrl+C 照常是中断

   2026-10-29 之前 Perch 没有任何自定义按键处理：Shift+Enter 发的是裸 \r（等于直接提交），
   选中文字按 Ctrl+C 发的是 ^C（打断 agent，而不是复制）。
   我们的 kitty 键盘协议在本机 ConPTY 下是关的（照 Orca），所以「已协商 KKP」那几支恒为假，不搬。 */

const TK_KITTY_SHIFT_ENTER = "\x1b[13;2u";
const TK_ALT_ENTER = "\x1b\r";
const TK_CTRL_BACKSPACE = "\x17";   // 删前一个词，同 readline 的 Ctrl+W
// tui-agent-config.ts 里 windowsShiftEnterEncoding: 'csi-u' 的（Perch 支持的只有 pi）
const TK_SHIFT_ENTER_CSI_U = new Set(["pi"]);
// ctrlEnterEncoding: 'csi-u' 的（droid / grok，Perch 暂未接入；留着表）
const TK_CTRL_ENTER_CSI_U = new Set(["droid", "grok"]);

function tkAgentOf(T) {
  return (T && T.spec && T.spec.agent) || "";
}

/* 返回 null = 交给 xterm 自己编码；否则 { type, data? }。只看 keydown。 */
function tkResolve(e, T, term) {
  const noMods = !e.metaKey && !e.ctrlKey && !e.altKey;
  const key = e.key;
  // 复制 / 全选：Ctrl+Shift+C 总是复制；Ctrl+C 只在有选区时复制（没选区就是中断，交给 xterm 发 ^C）
  if (e.ctrlKey && !e.altKey && !e.metaKey && (key === "c" || key === "C")) {
    if (e.shiftKey || term.hasSelection()) return { type: "copy" };
    return null;
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (key === "a" || key === "A")) return { type: "selectAll" };
  // Ctrl+Shift+V：让浏览器走原生粘贴（xterm 接 paste 事件，按需包 bracketed paste），别把它当按键发出去
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (key === "v" || key === "V")) return { type: "nativePaste" };
  if (e.shiftKey && noMods && key === "Enter") {
    return { type: "send", data: TK_SHIFT_ENTER_CSI_U.has(tkAgentOf(T)) ? TK_KITTY_SHIFT_ENTER : TK_ALT_ENTER };
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === "Enter") {
    // 本机 ConPTY 的 shell 不认 CSI-u（#12329）：只有已知认它的 agent 才发
    return { type: "send", data: TK_CTRL_ENTER_CSI_U.has(tkAgentOf(T)) ? "\x1b[13;5u" : "\r" };
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && key === "Backspace") return { type: "send", data: TK_CTRL_BACKSPACE };
  if (!e.metaKey && !e.ctrlKey && e.altKey && !e.shiftKey && key === "Backspace") return { type: "send", data: "\x1b\x7f" };
  // Alt+←/→、Ctrl+←/→：本机 ConPTY 下交给 xterm 原生编码（PSReadLine / Codex 认它们；\eb/\ef 会打出 b/f）
  return null;
}

function attachTermKeys(term, T, termOut) {
  // 被我们接管的组合键，它的 keyup 也不能漏给 xterm（否则 kitty / win32-input 下会出孤儿 keyup）
  const claimed = new Set();
  term.attachCustomKeyEventHandler((e) => {
    // 输入法组字中：一律交给 xterm / 输入法（keyCode 229 = IME 在处理这个键）
    if (e.isComposing || e.keyCode === 229) return true;
    if (e.type === "keyup" || e.type === "keypress") {
      if (e.type === "keyup" && claimed.has(e.code)) { claimed.delete(e.code); return false; }
      return true;
    }
    if (e.type !== "keydown") return true;
    const act = tkResolve(e, T, term);
    if (!act) return true;
    claimed.add(e.code);
    if (act.type === "nativePaste") return false;    // 不 preventDefault：让 paste 事件发生
    e.preventDefault();
    if (act.type === "copy") {
      const text = term.getSelection();
      if (text && typeof copyText === "function") copyText(text);
      return false;
    }
    if (act.type === "selectAll") { term.selectAll(); return false; }
    if (act.type === "send") {
      if (termOut) termOut.noteInput();
      term.input(act.data, true);   // 走 onData → PTY，和用户打字同一条路
      return false;
    }
    return true;
  });
}
