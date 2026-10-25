package project

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPoolRevAdvancesOnlyOnSuccessfulWrites(t *testing.T) {
	root := t.TempDir()
	p := &Pool{file: filepath.Join(root, "projects.json")}
	dir := filepath.Join(root, "a")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, added, err := p.Add(dir, "a", "manual"); err != nil || !added {
		t.Fatalf("Add = %v, %v; want added", added, err)
	}
	if got := p.Rev(); got != 1 {
		t.Fatalf("rev after add = %d, want 1", got)
	}
	if _, added, err := p.Add(dir, "a", "manual"); err != nil || added {
		t.Fatalf("duplicate Add = %v, %v; want not added", added, err)
	}
	if got := p.Rev(); got != 1 {
		t.Fatalf("rev after duplicate add = %d, want 1", got)
	}
	if _, err := p.SetPinned(dir, true); err != nil {
		t.Fatal(err)
	}
	if got := p.Rev(); got != 2 {
		t.Fatalf("rev after pin = %d, want 2", got)
	}
	if _, err := p.Rename(dir, "renamed"); err != nil {
		t.Fatal(err)
	}
	if got := p.Rev(); got != 3 {
		t.Fatalf("rev after rename = %d, want 3", got)
	}
	if ok, err := p.Remove(dir); err != nil || !ok {
		t.Fatalf("Remove = %v, %v; want true", ok, err)
	}
	if got := p.Rev(); got != 4 {
		t.Fatalf("rev after remove = %d, want 4", got)
	}
}
