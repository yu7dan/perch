package session

import (
	"errors"
	"testing"

	"github.com/yu7dan/perch/internal/agent"
)

// A configured agent must not fall back to its own config when the gateway
// profile cannot be applied. The fallback is what made Codex hit OpenAI with a
// stale login and print a raw 401 after restart.
func TestProfileErrorBlocksLaunch(t *testing.T) {
	m := New(Deps{
		StateDir:   t.TempDir(),
		DefaultCWD: func() string { return t.TempDir() },
	})
	m.SetDefs(map[string]agent.Def{
		"fake": {Exe: "cmd.exe"},
	})
	want := errors.New("gateway model profile could not be applied")
	m.SetWireProfile(func(string) (map[string]string, []string, bool, error) {
		return nil, nil, false, want
	})

	_, err := m.StartTab(&Tab{
		ID:   1,
		Spec: SpawnSpec{Agent: "fake", Resume: ResumeIntent{Kind: "new"}},
	}, 80, 24)
	if err == nil {
		t.Fatal("StartTab started despite a profile error")
	}
	var se *StartError
	if !errors.As(err, &se) {
		t.Fatalf("error is %T, want *StartError: %v", err, err)
	}
	if se.Stage != StageProfile {
		t.Fatalf("stage = %q, want %q", se.Stage, StageProfile)
	}
	if !errors.Is(err, want) {
		t.Fatalf("error lost its cause: %v", err)
	}
}
