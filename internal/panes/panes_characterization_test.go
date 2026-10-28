package panes

import (
	"os"
	"path/filepath"
	"testing"
)

// 这些测试是仓库结构整理前给 panes 拍的照片：判据、计数、只读语义。
// 搬进 internal/panes 时断言不变，只改包名与构造方式。

// claudeSessionExists 复刻生产里 Claude 的判据（<root>\projects\*\ <id>.jsonl
// 存在），通过 RestorePlan 的注入点喂进去 —— 本包不 import 会话层。
func claudeSessionExists(root string) func(agent, cwd, id string) bool {
	return func(agent, cwd, id string) bool {
		m, err := filepath.Glob(filepath.Join(root, "projects", "*", id+".jsonl"))
		return err == nil && len(m) > 0
	}
}

func writeClaudeTranscript(t *testing.T, stateDir, id string) {
	t.Helper()
	dir := filepath.Join(stateDir, "projects", "demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRestorePlanCharacterization(t *testing.T) {
	stateDir := t.TempDir()
	writeClaudeTranscript(t, stateDir, "dup-id")

	p := &Store{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "claude"},
			{PaneID: 2, Agent: "claude", SessionID: "missing-id"},
			{PaneID: 3, Agent: "claude", SessionID: "dup-id"},
			{PaneID: 4, Agent: "claude", SessionID: "dup-id"},
			{PaneID: 5, Agent: "claude", SessionID: "closed-id", Closed: true, Spoke: true},
			// 真跑过一轮但文件没了：保留 no_session 座位，并把原因说出来。
			{PaneID: 6, Agent: "claude", SessionID: "missing-spoke", Spoke: true},
		},
	}

	plan := p.RestorePlan(claudeSessionExists(stateDir))

	// 2026-10-23：没有会话证据的空记录（pane 1/2）不再占座位 —— 用户点名
	// "没对过话的 agent 不要留存"；pane2 有 session id 但盘上没有 jsonl，
	// 也算没有对话。open 记录也一样（异常退出不会写 Closed）。
	wantVerdicts := map[int]string{3: "ok", 4: "dup", 5: "closed", 6: "no_session"}
	if len(plan.Views) != len(wantVerdicts) {
		t.Fatalf("views=%d want %d", len(plan.Views), len(wantVerdicts))
	}
	for _, v := range plan.Views {
		if v.PaneID == 1 || v.PaneID == 2 {
			t.Fatalf("pane %d has no conversation and must be pruned", v.PaneID)
		}
		if got, want := v.Verdict, wantVerdicts[v.PaneID]; got != want {
			t.Errorf("pane %d verdict=%q want %q", v.PaneID, got, want)
		}
	}
	if len(plan.Dups) != 1 || plan.Dups[0] != 4 {
		t.Fatalf("dups=%v want [4]", plan.Dups)
	}
	if plan.Counts["ok"] != 1 || plan.Counts["dup"] != 1 ||
		plan.Counts["no_id"] != 0 || plan.Counts["no_session"] != 1 || plan.Counts["closed"] != 1 {
		t.Fatalf("counts=%v", plan.Counts)
	}
	if got := p.Count(); got != 3 {
		t.Fatalf("after pruning empty + dup count=%d want 3", got)
	}
	for _, v := range plan.Views {
		if v.PaneID == 3 && v.Resume.Kind != "exact" {
			t.Errorf("ok pane resume=%q want exact", v.Resume.Kind)
		}
		if v.PaneID != 3 && v.Resume.Kind != "new" {
			t.Errorf("pane %d resume=%q want new", v.PaneID, v.Resume.Kind)
		}
	}
}

func TestRestorePlanPrunesEmptyClosed(t *testing.T) {
	p := &Store{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "claude", Closed: true},
			{PaneID: 2, Agent: "claude", Closed: true, Spoke: true},
			{PaneID: 3, Agent: "claude", Closed: true, Talked: true},
			// 异常退出留下的 open 记录：没有 Closed 标记，但同样没有对话。
			{PaneID: 4, Agent: "cursor"},
		},
	}
	plan := p.RestorePlan(nil)
	if len(plan.Views) != 2 {
		t.Fatalf("views=%d want 2 (empty panes must be pruned)", len(plan.Views))
	}
	for _, v := range plan.Views {
		if v.PaneID == 1 || v.PaneID == 4 {
			t.Fatalf("pane %d has no conversation and must be pruned", v.PaneID)
		}
	}
	if got := p.Count(); got != 2 {
		t.Fatalf("count=%d want 2", got)
	}
}

func TestCloseKeepsOnlyTalkedPanes(t *testing.T) {
	p := &Store{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "claude"},
			{PaneID: 2, Agent: "claude", Talked: true},
			{PaneID: 3, Agent: "claude", Spoke: true},
			// 有会话 id 但这一轮还没来得及打 Spoke/Talked 标记：仍然是"有对话"。
			{PaneID: 4, Agent: "claude", SessionID: "sid-4"},
		},
	}
	if kept, found := p.Close(1, "test"); !found || kept {
		t.Fatalf("empty pane close: kept=%v found=%v want false,true", kept, found)
	}
	if got := p.Count(); got != 3 {
		t.Fatalf("after empty close count=%d want 3", got)
	}
	if kept, found := p.Close(2, "test"); !found || !kept {
		t.Fatalf("talked pane close: kept=%v found=%v want true,true", kept, found)
	}
	if kept, found := p.Close(3, "test"); !found || !kept {
		t.Fatalf("spoke pane close: kept=%v found=%v want true,true", kept, found)
	}
	if kept, found := p.Close(4, "test"); !found || !kept {
		t.Fatalf("session-id pane close: kept=%v found=%v want true,true", kept, found)
	}
}

func TestPruneAgentsKeepsListAndShell(t *testing.T) {
	p := &Store{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "claude"},
			{PaneID: 2, Agent: "qwen"},
			{PaneID: 3, Agent: ""},
			{PaneID: 4, Agent: "qoder"},
		},
	}
	keep := func(id string) bool { return id == "claude" || id == "qoder" }
	if n := p.PruneAgents(keep, "test"); n != 1 {
		t.Fatalf("pruned=%d want 1", n)
	}
	if p.Count() != 3 {
		t.Fatalf("count=%d want 3", p.Count())
	}
	for _, r := range p.Snapshot() {
		if r.Agent == "qwen" {
			t.Fatal("removed agent record survived")
		}
	}
}

func TestPaneStoreReadOnlyNeverWrites(t *testing.T) {
	file := filepath.Join(t.TempDir(), "panes.json")
	p := &Store{file: file, readOnly: true, next: 1}

	p.Bind(1, "claude", `C:\demo`, "sid-1", "", "test")
	p.FlushSync("test")

	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("read-only store wrote %s (err=%v)", file, err)
	}
	if !p.readOnly {
		t.Fatal("readOnly flag was cleared")
	}
}

// Bot Group 的成员格（2026-10-28）：刚起来、还没说过话的 Bot 也不能被当成
// "空开合"摘掉 —— 它的身份在组里登记着，摘了组里就挂着一个找不到的 paneId。
func TestBotGroupPanesSurviveEmptyPrune(t *testing.T) {
	p := &Store{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "codex", Group: "g1", Bot: "b1"},
			{PaneID: 2, Agent: "claude", Closed: true, Group: "g1", Bot: "b2"},
			{PaneID: 3, Agent: "claude"},
		},
	}
	plan := p.RestorePlan(nil)
	got := map[int]PaneView{}
	for _, v := range plan.Views {
		got[v.PaneID] = v
	}
	if _, ok := got[3]; ok || len(got) != 2 {
		t.Fatalf("views=%v want bot panes 1,2 only", got)
	}
	if v := got[1]; v.Group != "g1" || v.Bot != "b1" {
		t.Fatalf("pane 1 view lost its group: %+v", v)
	}
	if kept, found := p.Close(1, "test"); !found || !kept {
		t.Fatalf("empty bot pane close: kept=%v found=%v want true,true", kept, found)
	}
	p.SetGroup(1, "", "", "test")
	if kept, found := p.Close(1, "test"); !found || kept {
		t.Fatalf("released empty pane close: kept=%v found=%v want false,true", kept, found)
	}
}
