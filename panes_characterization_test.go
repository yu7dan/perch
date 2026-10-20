package main

import (
	"os"
	"path/filepath"
	"testing"
)

// 这些测试是仓库结构整理前给 panes 拍的照片：判据、计数、只读语义。
// 搬进 internal/panes 时断言不变，只改包名与构造方式。

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
	oldState := claudeStateDir
	claudeStateDir = t.TempDir()
	defer func() { claudeStateDir = oldState }()

	writeClaudeTranscript(t, claudeStateDir, "dup-id")

	p := &paneStore{
		file: filepath.Join(t.TempDir(), "panes.json"),
		Panes: []Pane{
			{PaneID: 1, Agent: "claude"},
			{PaneID: 2, Agent: "claude", SessionID: "missing-id"},
			{PaneID: 3, Agent: "claude", SessionID: "dup-id"},
			{PaneID: 4, Agent: "claude", SessionID: "dup-id"},
			{PaneID: 5, Agent: "claude", SessionID: "closed-id", Closed: true},
		},
	}

	plan := p.restorePlan()

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
	if got := p.count(); got != 4 {
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

func TestPaneStoreReadOnlyNeverWrites(t *testing.T) {
	file := filepath.Join(t.TempDir(), "panes.json")
	p := &paneStore{file: file, readOnly: true, next: 1}

	p.bind(1, "claude", `C:\demo`, "sid-1", "", "test")
	p.flushSync("test")

	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("read-only store wrote %s (err=%v)", file, err)
	}
	if !p.readOnly {
		t.Fatal("readOnly flag was cleared")
	}
}
