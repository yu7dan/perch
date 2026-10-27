package workspacebrief

import (
	"errors"
	"os"
	"strings"
	"testing"
)

func TestSetWritesCanonicalAndMarkedSection(t *testing.T) {
	root := t.TempDir()
	user := "# My project\n\nKeep this.\n"
	if err := os.WriteFile(AgentsPath(root), []byte(user), 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := Set(root, "\nAlways run go test before claiming done.\n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != Path(root) || res.AgentsPath != AgentsPath(root) {
		t.Fatalf("unexpected result paths: %+v", res)
	}
	got, ok, err := Read(root)
	if err != nil || !ok || !strings.Contains(got, "Always run go test") {
		t.Fatalf("canonical read = %q, ok=%v, err=%v", got, ok, err)
	}
	agents, err := os.ReadFile(AgentsPath(root))
	if err != nil {
		t.Fatal(err)
	}
	s := string(agents)
	if !strings.Contains(s, "Keep this.") {
		t.Fatalf("user content was lost: %q", s)
	}
	if strings.Count(s, startMarker) != 1 || strings.Count(s, endMarker) != 1 {
		t.Fatalf("expected exactly one marker pair: %q", s)
	}
	if !strings.Contains(s, "Always run go test") {
		t.Fatalf("brief missing from AGENTS.md: %q", s)
	}
}

func TestSetReplacesExistingSectionWithoutDuplicating(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(AgentsPath(root), []byte("# User\n\nbefore\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(root, "old-brief-value"); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(root, "new-brief-value"); err != nil {
		t.Fatal(err)
	}
	agents, err := os.ReadFile(AgentsPath(root))
	if err != nil {
		t.Fatal(err)
	}
	s := string(agents)
	if strings.Count(s, startMarker) != 1 || strings.Count(s, endMarker) != 1 {
		t.Fatalf("duplicated markers: %q", s)
	}
	if strings.Contains(s, "old-brief-value") || !strings.Contains(s, "new-brief-value") {
		t.Fatalf("section was not replaced: %q", s)
	}
	if !strings.Contains(s, "before") {
		t.Fatalf("user content was lost: %q", s)
	}
}

func TestSetEmptyRemovesSectionAndKeepsUserContent(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(AgentsPath(root), []byte("# User\n\nbefore\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(root, "temporary"); err != nil {
		t.Fatal(err)
	}
	if _, err := Set(root, "   \n"); err != nil {
		t.Fatal(err)
	}
	agents, err := os.ReadFile(AgentsPath(root))
	if err != nil {
		t.Fatal(err)
	}
	s := string(agents)
	if strings.Contains(s, startMarker) || strings.Contains(s, endMarker) {
		t.Fatalf("markers should be removed: %q", s)
	}
	if !strings.Contains(s, "# User") || !strings.Contains(s, "before") {
		t.Fatalf("user content was lost: %q", s)
	}
}

func TestSetRejectsMalformedMarkersBeforeWriting(t *testing.T) {
	root := t.TempDir()
	broken := "# User\n\n" + startMarker + "\n## Perch workspace brief\n\nhalf\n"
	if err := os.WriteFile(AgentsPath(root), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Set(root, "new")
	if !errors.Is(err, ErrMalformedAgents) {
		t.Fatalf("want ErrMalformedAgents, got %v", err)
	}
	if _, err := os.Stat(Path(root)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canonical brief must not be written when AGENTS.md is malformed")
	}
	got, _ := os.ReadFile(AgentsPath(root))
	if string(got) != broken {
		t.Fatalf("AGENTS.md was changed despite refusal: %q", string(got))
	}
}

func TestSetRejectsTooLarge(t *testing.T) {
	root := t.TempDir()
	_, err := Set(root, strings.Repeat("x", MaxBytes+1))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
}

func TestFindWalksUpFromSubdirectory(t *testing.T) {
	root := t.TempDir()
	sub := root + string(os.PathSeparator) + "sub"
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root+string(os.PathSeparator)+DirName, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(root), []byte("brief"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, ok := Find(sub)
	if !ok || got != Path(root) {
		t.Fatalf("Find(%q) = %q, %v; want %q", sub, got, ok, Path(root))
	}
}
