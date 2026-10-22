package agentprofile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sets.json")
	s := LoadSets(path)
	if got := s.List(); len(got) != 0 {
		t.Fatalf("new store has %d sets", len(got))
	}
	agents := []Profile{
		{Agent: "claude", Alias: "group/perch-claude", Model: "workbuddy/glm-5.3", Effort: "high"},
		{Agent: "codex", Alias: "group/perch-codex", Model: "deepseek/deepseek-flash"},
	}
	if err := s.Save("写代码", agents); err != nil {
		t.Fatal(err)
	}
	got, ok := s.Get("写代码")
	if !ok || len(got) != 2 || got[0].Effort != "high" {
		t.Fatalf("get=%+v ok=%v", got, ok)
	}
	// A new Store reads the same file, so a restart keeps the set.
	s2 := LoadSets(path)
	list := s2.List()
	if len(list) != 1 || list[0].Name != "写代码" || len(list[0].Agents) != 2 {
		t.Fatalf("reloaded=%+v", list)
	}
	if err := s2.Delete("写代码"); err != nil {
		t.Fatal(err)
	}
	if _, ok := s2.Get("写代码"); ok {
		t.Fatal("deleted set still there")
	}
	if err := s2.Delete("不存在"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestSetStoreRejectsBadNamesAndEmpty(t *testing.T) {
	s := LoadSets(filepath.Join(t.TempDir(), "sets.json"))
	if err := s.Save("  ", []Profile{{Agent: "claude", Model: "x"}}); err == nil {
		t.Fatal("empty name accepted")
	}
	if err := s.Save("empty", nil); err == nil {
		t.Fatal("empty set accepted")
	}
	long := make([]byte, 61)
	for i := range long {
		long[i] = 'a'
	}
	if err := s.Save(string(long), []Profile{{Agent: "claude", Model: "x"}}); err == nil {
		t.Fatal("long name accepted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(s.path), "sets.json")); !os.IsNotExist(err) {
		t.Fatalf("rejected saves wrote the file: %v", err)
	}
}
