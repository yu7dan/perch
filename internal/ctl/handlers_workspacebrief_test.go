package ctl

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yu7dan/perch/internal/project"
)

func TestBriefRootAllowsDefaultAndProjectOnly(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	proj := filepath.Join(root, "project")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{deps: Deps{
		DefaultCWD: func() string { return root },
		Pool: &project.Pool{Projects: []project.Project{
			{Path: proj},
		}},
	}}
	// The default root is allowed even though it is not in the user's pool.
	got, err := s.briefRoot(root)
	if err != nil || got == "" {
		t.Fatalf("default root rejected: %q %v", got, err)
	}
	// A pool project is allowed.
	if _, err := s.briefRoot(proj); err != nil {
		t.Fatalf("pool project rejected: %v", err)
	}
	// An arbitrary existing folder is not a project; refuse before writing.
	if _, err := s.briefRoot(outside); err == nil {
		t.Fatal("outside folder must be refused")
	}
}
