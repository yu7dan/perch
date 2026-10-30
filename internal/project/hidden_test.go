package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 移除项目要把目录记进 Hidden（左栏据此不再拼「未归类」行），重新添加要撤掉，
// 而且两者都要落盘 —— 重开 Perch 之后「移除了但还在」不能卷土重来。
func TestRemoveHidesAndReAddUnhides(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "projects.json")
	p := &Pool{file: file}
	dir := filepath.Join(root, "a")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.Add(dir, "a", "manual"); err != nil {
		t.Fatal(err)
	}
	if ok, err := p.Remove(strings.ToUpper(dir)); err != nil || !ok {
		t.Fatalf("Remove = %v, %v; want removed", ok, err)
	}
	if p.Has(dir) {
		t.Fatal("project still in pool after Remove")
	}
	if got := p.HiddenDirs(); len(got) != 1 || PathKey(got[0]) != PathKey(dir) {
		t.Fatalf("HiddenDirs = %v, want [%s]", got, dir)
	}
	var disk struct {
		Hidden []string `json:"hidden"`
	}
	b, _ := os.ReadFile(file)
	if err := json.Unmarshal(b, &disk); err != nil || len(disk.Hidden) != 1 {
		t.Fatalf("hidden not persisted: %s", b)
	}
	// 再移除一次：已经藏了，不算改动。
	if ok, err := p.Remove(dir); err != nil || ok {
		t.Fatalf("second Remove = %v, %v; want no-op", ok, err)
	}
	if _, added, err := p.Add(dir, "a", "manual"); err != nil || !added {
		t.Fatalf("re-Add = %v, %v; want added", added, err)
	}
	if got := p.HiddenDirs(); len(got) != 0 {
		t.Fatalf("HiddenDirs after re-add = %v, want empty", got)
	}
}

// 不在池子里的目录（左栏的「未归类」行）也能移除：只记 Hidden。
func TestRemoveUnfiledDirOnlyHides(t *testing.T) {
	root := t.TempDir()
	p := &Pool{file: filepath.Join(root, "projects.json")}
	dir := filepath.Join(root, "loose")
	if ok, err := p.Remove(dir); err != nil || !ok {
		t.Fatalf("Remove(unfiled) = %v, %v; want hidden", ok, err)
	}
	if got := p.HiddenDirs(); len(got) != 1 {
		t.Fatalf("HiddenDirs = %v", got)
	}
	if got := p.Rev(); got != 1 {
		t.Fatalf("rev = %d, want 1", got)
	}
}
