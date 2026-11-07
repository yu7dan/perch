"use strict";
/* 99-boot.js —— 最后一条脚本：打开启动闸，起台面。
   到这一行，所有处理器都已经求值完了 —— 这正是启动闸要等的那一刻（20-ctl.js 的 ctlInbox、
   22-live.js 的 pendingShell 在脚本求值期间先把消息收住，这里按到达顺序放行）。 */

RSB_READY = true;
flushCtlBoot();
if (pendingShell) {
  const p = pendingShell;
  pendingShell = null;
  bootFact("壳层首帧在启动闸里到达：按启动顺序补画（applyShell）");
  applyShell(p);
}
renderLive();
bootDesk().catch((e) => jserr("bootDesk", e));
