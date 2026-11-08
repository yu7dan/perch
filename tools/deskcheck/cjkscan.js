// 英文界面验收：列出台面上还剩的中文（文字节点 + title / placeholder）。终端、文件预览、成员说的话不算。
// 用法：node tools/deskcheck/cdp.mjs eval "$(cat tools/deskcheck/cjkscan.js)"
(() => {
  const CJK = /[㐀-鿿　-〿！-～]/;
  const skip = ".xterm, #termpark, .fp-c, .gd-lines, .ql-c, #__tourcap";
  const out = new Map();
  const add = (s, where) => { s = s.trim(); if (s && CJK.test(s)) out.set(s, where); };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: (x) => x.nodeType === 1 && x.matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) { const p = n.parentElement; if (p && !p.closest("script,style") && p.getClientRects().length) add(n.nodeValue, p.className || p.tagName); }
    else for (const a of ["title", "placeholder"]) { const v = n.getAttribute(a); if (v) add(v, "@" + a + " " + (n.className || n.tagName)); }
  }
  return JSON.stringify([...out].map(([s, w]) => s + "   ⟵ " + w), null, 1);
})()
