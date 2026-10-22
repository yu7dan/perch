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
		},
	}

	plan := p.RestorePlan(claudeSessionExists(stateDir))

	wantVerdicts := map[int]string{1: "no_id", 2: "no_session", 3: "ok", 4: "dup", 5: "closed"}
	if len(plan.Views) != len(wantVerdicts) {
		t.Fatalf("views=%d want %d", len(plan.Views), len(wantVerdicts))
	}
	for _, v := range plan.Views {
		if got, want := v.Verdict, wantVerdicts[v.PaneID]; got != want {
			t.Errorf("pane %d verdict=%q want %q", v.PaneID, got, want)
		}
	}
	if len(plan.Dups) != 1 || plan.Dups[0] != 4 {
		t.Fatalf("dups=%v want [4]", plan.Dups)
	}
	if plan.Counts["ok"] != 1 || plan.Counts["dup"] != 1 ||
		plan.Counts["no_id"] != 1 || plan.Counts["no_session"] != 1 || plan.Counts["closed"] != 1 {
		t.Fatalf("counts=%v", plan.Counts)
	}
	if got := p.Count(); got != 4 {
		t.Fatalf("after prune count=%d want 4", got)
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
		},
	}
	plan := p.RestorePlan(nil)
	if len(plan.Views) != 2 {
		t.Fatalf("views=%d want 2 (empty closed must be pruned)", len(plan.Views))
	}
	for _, v := range plan.Views {
		if v.PaneID == 1 {
			t.Fatal("pane 1 has no conversation and must be pruned")
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
		},
	}
	if kept, found := p.Close(1, "test"); !found || kept {
		t.Fatalf("empty pane close: kept=%v found=%v want false,true", kept, found)
	}
	if got := p.Count(); got != 2 {
		t.Fatalf("after empty close count=%d want 2", got)
	}
	if kept, found := p.Close(2, "test"); !found || !kept {
		t.Fatalf("talked pane close: kept=%v found=%v want true,true", kept, found)
	}
	if kept, found := p.Close(3, "test"); !found || !kept {
		t.Fatalf("spoke pane close: kept=%v found=%v want true,true", kept, found)
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
