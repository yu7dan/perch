package session

import (
	"path/filepath"
	"testing"

	"github.com/yu7dan/perch/internal/panes"
)

func TestCreateUsesDefaultWorkspaceRootForProjectlessPanes(t *testing.T) {
	root := t.TempDir()
	defaultCWD := filepath.Join(root, "default")
	m := New(Deps{
		Panes:      panes.Load(filepath.Join(root, "panes.json"), false),
		DefaultCWD: func() string { return defaultCWD },
	})

	tab := m.Create(SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "new"}})
	if tab.Spec.CWD != defaultCWD {
		t.Fatalf("new projectless pane cwd = %q，想要默认工作区根目录 %q", tab.Spec.CWD, defaultCWD)
	}
	// 同一条记录必须写的是这个目录，重启才有得接。
	for _, p := range m.Live() {
		if p.ID == tab.ID && p.CWD != defaultCWD {
			t.Fatalf("Live cwd = %q，想要 %q", p.CWD, defaultCWD)
		}
	}

	// 显式项目目录必须原样沿用，不能被默认目录覆盖。
	projectDir := filepath.Join(root, "project")
	proj := m.Create(SpawnSpec{
		Agent: "claude", CWD: projectDir,
		Resume: ResumeIntent{Kind: "new"},
	})
	if proj.Spec.CWD != projectDir {
		t.Fatalf("project pane cwd = %q，想要 %q", proj.Spec.CWD, projectDir)
	}

	// exact 续接不许换目录：它必须沿用记录里的 cwd。
	old := m.Create(SpawnSpec{
		Agent: "claude", CWD: `D:\old\session`,
		Resume: ResumeIntent{Kind: "exact", ID: "abc"},
	})
	if old.Spec.CWD != `D:\old\session` {
		t.Fatalf("exact resume cwd = %q，不该被改写", old.Spec.CWD)
	}
}
