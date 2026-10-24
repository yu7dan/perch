package agentprofile

import (
	"path/filepath"
	"testing"
)

func TestAliasFor(t *testing.T) {
	cases := map[string]string{
		"claude":   "group/perch-claude",
		"Codex":    "group/perch-codex",
		"omp#work": "group/perch-omp-work",
	}
	for in, want := range cases {
		if got := AliasFor(in); got != want {
			t.Errorf("AliasFor(%q)=%q want %q", in, got, want)
		}
	}
}

func TestStorePersistsAndDeletes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-profiles.json")
	s := Load(path)
	if err := s.Set(Profile{Agent: "claude", Alias: AliasFor("claude"), Model: "deepseek/deepseek-flash"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(Profile{Agent: "codex", Alias: AliasFor("codex"), Model: "deepseek/deepseek-v4-pro"}); err != nil {
		t.Fatal(err)
	}
	re := Load(path)
	if p, ok := re.Get("claude"); !ok || p.Model != "deepseek/deepseek-flash" {
		t.Fatalf("claude=%+v ok=%v", p, ok)
	}
	all := re.All()
	if len(all) != 2 || all[0].Agent != "claude" || all[1].Agent != "codex" {
		t.Fatalf("all=%+v", all)
	}
	if err := re.Set(Profile{Agent: "codex"}); err != nil {
		t.Fatal(err)
	}
	re2 := Load(path)
	if _, ok := re2.Get("codex"); ok {
		t.Fatal("empty model should delete the profile")
	}
	if len(re2.All()) != 1 {
		t.Fatalf("all=%+v", re2.All())
	}
}

func TestLoadMissingOrBrokenIsEmpty(t *testing.T) {
	for _, path := range []string{"", filepath.Join(t.TempDir(), "missing.json")} {
		s := Load(path)
		if len(s.All()) != 0 {
			t.Fatalf("path %q not empty", path)
		}
	}
}
