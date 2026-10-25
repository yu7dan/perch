package ctl

import (
	"path/filepath"
	"testing"

	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/session"
)

func TestTargetRefusalProjectNeedsPoolMembership(t *testing.T) {
	dir := t.TempDir()
	pool := &project.Pool{Projects: []project.Project{{Path: dir, Name: "p"}}}
	spec := session.SpawnSpec{Agent: "claude", CWD: dir, Target: "project",
		Resume: session.ResumeIntent{Kind: "new"}}
	if ref := targetRefusal(&spec, pool); ref != nil {
		t.Fatalf("known project rejected: %+v", ref)
	}

	other := t.TempDir()
	spec = session.SpawnSpec{Agent: "claude", CWD: other, Target: "project",
		Resume: session.ResumeIntent{Kind: "new"}}
	ref := targetRefusal(&spec, pool)
	if ref == nil || ref.Code != "project.targetUnknown" {
		t.Fatalf("unknown project refusal = %+v, want project.targetUnknown", ref)
	}
}

func TestTargetRefusalRequiresPathForProject(t *testing.T) {
	spec := session.SpawnSpec{Agent: "claude", Target: "project",
		Resume: session.ResumeIntent{Kind: "new"}}
	ref := targetRefusal(&spec, &project.Pool{})
	if ref == nil || ref.Code != "project.targetRequired" {
		t.Fatalf("refusal = %+v, want project.targetRequired", ref)
	}
}

func TestTargetRefusalDirectoryAndScratch(t *testing.T) {
	dir := t.TempDir()
	spec := session.SpawnSpec{Agent: "claude", CWD: dir, Target: "directory",
		Resume: session.ResumeIntent{Kind: "new"}}
	if ref := targetRefusal(&spec, nil); ref != nil {
		t.Fatalf("directory rejected: %+v", ref)
	}

	missing := filepath.Join(dir, "missing")
	spec = session.SpawnSpec{Agent: "claude", CWD: missing, Target: "directory",
		Resume: session.ResumeIntent{Kind: "new"}}
	ref := targetRefusal(&spec, nil)
	if ref == nil || ref.Code != "project.targetMissing" {
		t.Fatalf("missing directory refusal = %+v, want project.targetMissing", ref)
	}

	spec = session.SpawnSpec{Agent: "claude", CWD: dir, Target: "scratch",
		Resume: session.ResumeIntent{Kind: "new"}}
	if ref := targetRefusal(&spec, nil); ref != nil {
		t.Fatalf("scratch rejected: %+v", ref)
	}
	if spec.CWD != "" {
		t.Fatalf("scratch left cwd = %q, want empty", spec.CWD)
	}
}

func TestTargetRefusalIgnoresResumeTargets(t *testing.T) {
	spec := session.SpawnSpec{Agent: "claude", CWD: "", Target: "project",
		Resume: session.ResumeIntent{Kind: "exact", ID: "abc"}}
	if ref := targetRefusal(&spec, &project.Pool{}); ref != nil {
		t.Fatalf("resume target should be ignored, got %+v", ref)
	}
}
