/* 81c-workspace-brief.js —— Project 共享 brief 的编辑卡。
 *
 * 事实分工：
 *   · Go 的 internal/workspacebrief 是写盘的唯一出口；它同时维护
 *     <project>/.perch/workspace.md 和 AGENTS.md 的标记段。
 *   · 前端只负责读/写和把“下一次启动才生效”说清楚。
 *   · 这里不碰 agent 的全局配置，也不改 CLAUDE.md。
 */
"use strict";

let BRIEF = null;
// { root, name, content, agentsPath, opener, busy, dirty, request, timer }

function briefPathDisplay() {
  if (!BRIEF) return "";
  return BRIEF.root.replace(/[\\/]+$/, "") + "\\.perch\\workspace.md";
}

function briefPaint() {
  if (!BRIEF) return;
  const title = $("brief-title");
  if (title) title.textContent = t("brief.titleFor", { name: BRIEF.name || t("brief.title") });
  const path = $("brief-path");
  if (path) {
    path.textContent = briefPathDisplay();
    path.title = briefPathDisplay();
  }
  const text = $("brief-text");
  if (text) text.placeholder = t("brief.placeholder");
  const save = $("brief-save");
  if (save) {
    save.textContent = BRIEF.busy ? t("brief.saving") : t("brief.save");
    save.classList.toggle("na", BRIEF.busy);
    save.setAttribute("aria-disabled", BRIEF.busy ? "true" : "false");
  }
}

function briefSetNote(text, isErr) {
  const note = $("brief-note");
  if (!note) return;
  note.textContent = text || "";
  note.classList.toggle("err", !!isErr);
}

function openWorkspaceBrief(p) {
  if (!p || !p.path) {
    showToast(t("brief.noProjectTitle"), t("brief.noProjectNote"), "err");
    return;
  }
  if (BRIEF) closeWorkspaceBrief("reopen");
  BRIEF = {
    root: p.path,
    name: projectName(p) || p.name || p.path,
    content: "",
    agentsPath: "",
    opener: document.activeElement,
    busy: false,
    dirty: false,
    loaded: false,
    request: "get",
    timer: 0,
  };
  $("brief").hidden = false;
  $("brief-text").value = "";
  briefPaint();
  briefSetNote(t("brief.loading"), false);
  BRIEF.timer = setTimeout(() => {
    if (!BRIEF || BRIEF.request !== "get") return;
    briefSetNote(t("brief.noResponse"), true);
    BRIEF.busy = false;
    BRIEF.request = "";
    briefPaint();
  }, 6000);
  sendCtrl({ type: "workspace.brief.get", path: p.path });
  sendCtrl({ type: "log", msg: `Workspace brief 打开 project=${p.path}` });
  requestAnimationFrame(() => $("brief-text")?.focus());
}

function closeWorkspaceBrief(why) {
  if (!BRIEF) return;
  if (BRIEF.timer) clearTimeout(BRIEF.timer);
  const opener = BRIEF.opener;
  BRIEF = null;
  $("brief").hidden = true;
  if (opener && document.contains(opener)) {
    try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  if (why && why !== "reopen") sendCtrl({ type: "log", msg: `Workspace brief 关闭（${why}）` });
}

function briefSave() {
  if (!BRIEF || BRIEF.busy) return;
  const content = $("brief-text").value;
  BRIEF.busy = true;
  BRIEF.request = "save";
  briefPaint();
  briefSetNote(t("brief.savingNote"), false);
  sendCtrl({ type: "workspace.brief.set", path: BRIEF.root, content });
  sendCtrl({ type: "log", msg: `Workspace brief 保存 project=${BRIEF.root} bytes=${content.length}` });
}

/* 20-ctl.js 的 workspace.brief 分支调这里。 */
function briefMessage(m) {
  if (!m || !BRIEF) return;
  if (m.path && normPath(m.path) !== normPath(BRIEF.root)) return;
  const was = BRIEF.request;
  BRIEF.request = "";
  if (BRIEF.timer) { clearTimeout(BRIEF.timer); BRIEF.timer = 0; }

  if (!m.ok) {
    BRIEF.busy = false;
    briefPaint();
    briefSetNote(tMsg(m.errCode, m.errParams, m.err) || t("brief.saveFailed"), true);
    sendCtrl({ type: "log", msg: `Workspace brief 失败：${m.err || m.errCode || "unknown"}` });
    return;
  }

  if (m.agentsPath) BRIEF.agentsPath = m.agentsPath;
  if ((was === "get" || (!was && !BRIEF.loaded)) && !BRIEF.dirty) {
    BRIEF.content = String(m.content || "");
    BRIEF.loaded = true;
    $("brief-text").value = BRIEF.content;
  }
  BRIEF.busy = false;
  briefPaint();
  if (was === "save") {
    BRIEF.content = String(m.content || "");
    BRIEF.dirty = false;
    showToast(t("brief.savedTitle"), t("brief.savedNote"), "ok");
    closeWorkspaceBrief("saved");
    return;
  }
  briefSetNote(m.exists
    ? t("brief.noteExisting", { path: m.agentsPath || briefPathDisplay() })
    : t("brief.noteNew", { path: m.agentsPath || briefPathDisplay() }), false);
}

/* 语言切换时如果卡还开着，标题/按钮/说明要跟着换；正文不动。 */
function briefRepaint() {
  if (!BRIEF) return;
  briefPaint();
}

{
  const dlg = $("brief");
  if (dlg) {
    $("brief-x").addEventListener("click", () => closeWorkspaceBrief("x"));
    $("brief-cancel").addEventListener("click", () => closeWorkspaceBrief("cancel"));
    $("brief-save").addEventListener("click", briefSave);
    $("brief-text").addEventListener("input", () => { if (BRIEF) BRIEF.dirty = true; });
    $("brief-text").addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeWorkspaceBrief("esc"); return; }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); briefSave(); }
    });
    dlg.addEventListener("mousedown", (e) => {
      if (e.target === dlg) closeWorkspaceBrief("backdrop");
    });
    document.addEventListener("keydown", (e) => {
      if (!BRIEF) return;
      if (e.key === "Escape" && document.activeElement !== $("brief-text")) {
        e.preventDefault();
        closeWorkspaceBrief("esc");
      }
    });
  }
}
