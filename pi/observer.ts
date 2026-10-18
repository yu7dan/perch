/**
 * Perch 的 Pi 状态观察扩展。
 *
 * Perch 用 `pi -e <本文件>` 把它挂到每一格里；事件写到 PERCH_PI_EVENTS
 * 指定的 JSONL 文件（每格一份，归属由文件名定，不靠反查）。这个扩展**只读**
 * Pi 的生命周期，不注册工具/命令，也不改任何用户配置。
 *
 * 事件形状（v1）：
 *   {type:"session_start", session, reason}
 *   {type:"name", session, name}
 *   {type:"status", session, status:"busy|idle|waiting", kind:"ask|perm", text}
 *
 * Pi 没有内建审批，等待只可能来自扩展的 ctx.ui 提示（confirm/select/input/
 * editor/custom）。没有扩展提问时不会出现 waiting —— 这是能力边界，不假装。
 */

import { appendFileSync } from "node:fs";

export default function (pi) {
  const file = process.env.PERCH_PI_EVENTS;
  if (!file) return;

  let session = "";
  let running = false;
  let waiting = false;

  const write = (rec) => {
    try {
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...rec }) + "\n");
    } catch {
      // 事件文件写不进去不能影响 agent 本身。
    }
  };

  const status = (st, extra) => {
    write({ type: "status", status: st, session, ...(extra || {}) });
  };

  pi.on("session_start", (event, ctx) => {
    // 会话 id 不在事件里，只有 sessionManager 有（实测 1.2.0）。
    try {
      session = ctx.sessionManager.getSessionId() || "";
    } catch {
      session = "";
    }
    running = false;
    waiting = false;
    write({ type: "session_start", reason: (event && event.reason) || "", session });
    status("idle");
  });

  pi.on("session_info_changed", (event) => {
    write({ type: "name", name: (event && event.name) || "", session });
  });

  pi.on("agent_start", () => {
    running = true;
    if (!waiting) status("busy");
  });

  // agent_settled 是“不会再有自动工作了”；比 agent_end 更适合当空闲信号。
  pi.on("agent_settled", (event) => {
    running = false;
    if (!waiting) status("idle", { aborted: !!(event && event.aborted) });
  });

  pi.on("ui_prompt_start", (event) => {
    waiting = true;
    // confirm/select 是“批准/选择”，其余是“等回答”。
    const kind =
      event && (event.kind === "confirm" || event.kind === "select") ? "perm" : "ask";
    status("waiting", { kind, text: (event && event.title) || "" });
  });

  pi.on("ui_prompt_end", () => {
    waiting = false;
    // 提示答完不等于这一轮结束：跑着就回 busy，闲着才回 idle。
    status(running ? "busy" : "idle");
  });
}
