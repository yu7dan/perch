/**
 * Perch 的 Pi 状态观察扩展。
 *
 * Perch 用 `pi -e <本文件>` 把它挂到每一格里；事件写到 PERCH_PI_EVENTS
 * 指定的 JSONL 文件（每格一份，归属由文件名定，不靠反查）。这个扩展**只读**
 * Pi 的生命周期，不注册工具/命令，也不改任何用户配置。
 *
 * 事件形状（v1，字段只增不改）：
 *   {type:"session_start", session, reason}
 *   {type:"name", session, name}
 *   {type:"status", session, status:"busy|idle|waiting", state:"working|blocked|waiting|done", kind:"ask|perm", text}
 *
 * Pi 没有内建审批，等待只可能来自扩展的 ctx.ui 提示（confirm/select/input/
 * editor/custom）或一个**提问工具**。没有扩展提问时不会出现 waiting —— 这是
 * 能力边界，不假装。
 *
 * 2026-10-19（Wave 1）：除了 ui_prompt_*，还认提问工具本身。Orca 的 Pi 归一化
 * 把 `tool_call`/`tool_execution_start` 上的提问工具记成 blocked（有具体问题
 * 卡片），把 ui_prompt_start 记成 waiting（泛化等待），见
 * _ref\orca\fetched\src\shared\agent-hook-listener\providers\pi-family-events.ts:58-94。
 * 这里用同一个分法：工具 → blocked，ui prompt → waiting。
 */

import { appendFileSync } from "node:fs";

/** 各家的“问用户”工具名。Pi 本身没有，来自扩展/MCP；Claude 兼容层叫第一个。 */
const ASK_TOOLS = new Set(["AskUserQuestion", "ask_user", "ask", "ask_user_question"]);

export default function (pi) {
  const file = process.env.PERCH_PI_EVENTS;
  if (!file) return;

  let session = "";
  let running = false;
  // 两个等待源分开记：ui prompt 和提问工具可能同时挂着，任何一个结束都不能
  // 把另一个的 waiting 提前收掉。
  let uiWaiting = false;
  const askIds = new Set();
  let askNoId = 0; // 极少数没有 toolCallId 的事件：按名字计数兜底

  const isWaiting = () => uiWaiting || askIds.size > 0 || askNoId > 0;

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

  // 没有等待源时才敢把 running 翻成 busy/idle；有等待就保持 waiting。
  const refresh = (aborted) => {
    if (isWaiting()) return;
    status(running ? "busy" : "idle", aborted === undefined ? undefined : { aborted });
  };

  pi.on("session_start", (event, ctx) => {
    // 会话 id 不在事件里，只有 sessionManager 有（实测 1.2.0）。
    try {
      session = ctx.sessionManager.getSessionId() || "";
    } catch {
      session = "";
    }
    running = false;
    uiWaiting = false;
    askIds.clear();
    askNoId = 0;
    write({ type: "session_start", reason: (event && event.reason) || "", session });
    status("idle");
  });

  pi.on("session_info_changed", (event) => {
    write({ type: "name", name: (event && event.name) || "", session });
  });

  pi.on("agent_start", () => {
    running = true;
    refresh();
  });

  // agent_settled 是“不会再有自动工作了”；比 agent_end 更适合当空闲信号。
  pi.on("agent_settled", (event) => {
    running = false;
    // settled 之后不会再有自动工作：挂在工具表里的 ask 也已经有了结局
    // （正常回答、中断、或工具压根没跑）。不清的话，缺失的 end 事件会让
    // 这一格永远停在“等你”。
    askIds.clear();
    askNoId = 0;
    refresh(!!(event && event.aborted));
  });

  // —— 提问工具 ——
  const onAskStart = (event) => {
    const name = String(
      (event && (event.toolName || event.tool_name)) || ""
    );
    if (!ASK_TOOLS.has(name)) return;
    const id = String((event && (event.toolCallId || event.tool_call_id)) || "");
    if (id) askIds.add(id);
    else askNoId++;
    status("waiting", { state: "blocked", kind: "ask", text: name });
  };
  pi.on("tool_call", onAskStart);

  // 工具执行完：只有**这一次提问**的 id 能清掉它的等待；别的工具结束不动它。
  pi.on("tool_execution_end", (event) => {
    const id = String((event && (event.toolCallId || event.tool_call_id)) || "");
    const name = String(
      (event && (event.toolName || event.tool_name)) || ""
    );
    let cleared = false;
    if (id) {
      cleared = askIds.delete(id);
    } else if (askNoId > 0 && ASK_TOOLS.has(name)) {
      askNoId--;
      cleared = true;
    }
    if (cleared) refresh();
  });

  // —— 扩展自己的 UI 提示（confirm/select/input/…）——
  pi.on("ui_prompt_start", (event) => {
    uiWaiting = true;
    // confirm/select 是“批准/选择”，其余是“等回答”。
    const kind =
      event && (event.kind === "confirm" || event.kind === "select") ? "perm" : "ask";
    status("waiting", { state: "waiting", kind, text: (event && event.title) || "" });
  });

  pi.on("ui_prompt_end", () => {
    uiWaiting = false;
    // 提示答完不等于这一轮结束：跑着就回 busy，闲着才回 idle；
    // 还有提问工具挂着就继续 waiting。
    refresh();
  });
}
