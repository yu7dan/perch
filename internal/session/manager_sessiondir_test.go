package session

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/yu7dan/perch/internal/panes"
)

func TestCreateAllocatesDefaultSessionDirForNewPanes(t *testing.T) {
	root := t.TempDir()
	m := New(Deps{
		Panes:      panes.Load(filepath.Join(root, "panes.json"), false),
		DefaultCWD: func() string { return filepath.Join(root, "default") },
	})
	m.SetSessionDir(func(agent string, paneID int) string {
		return filepath.Join(root, "sessions", fmt.Sprintf("%s-%d", agent, paneID))
	})

	tab := m.Create(SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "new"}})
	want := filepath.Join(root, "sessions", fmt.Sprintf("claude-%d", tab.PaneID))
	if tab.Spec.CWD != want {
		t.Fatalf("new pane cwd = %q，想要独立会话目录 %q", tab.Spec.CWD, want)
	}
	// 同一条记录必须写的是这个目录，重启才有得接。
	for _, p := range m.Live() {
		if p.ID == tab.ID && p.CWD != want {
			t.Fatalf("Live cwd = %q，想要 %q", p.CWD, want)
		}
	}

	// exact 续接不许另开目录：它必须沿用记录里的 cwd（这里显式给了 d 盘目录）。
	old := m.Create(SpawnSpec{
		Agent: "claude", CWD: `D:\old\session`,
		Resume: ResumeIntent{Kind: "exact", ID: "abc"},
	})
	if old.Spec.CWD != `D:\old\session` {
		t.Fatalf("exact resume cwd = %q，不该被改写", old.Spec.CWD)
	}
}
