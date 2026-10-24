package session

import (
	"encoding/json"
	"os"
	"testing"
)

func TestMergeSettingsEnvKeepsHooks(t *testing.T) {
	in := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"C:/hook.exe"}]}]}}`
	out := mergeSettingsEnv(in, map[string]string{
		"ANTHROPIC_BASE_URL": "http://127.0.0.1:64730",
		"ANTHROPIC_MODEL":    "group/perch-claude",
	})
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("not JSON: %v (%s)", err, out)
	}
	if _, ok := m["hooks"]; !ok {
		t.Fatalf("hooks lost: %s", out)
	}
	env, _ := m["env"].(map[string]any)
	if env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:64730" {
		t.Fatalf("env not merged: %s", out)
	}
	if env["ANTHROPIC_MODEL"] != "group/perch-claude" {
		t.Fatalf("model not merged: %s", out)
	}
}

func TestMergeSettingsEnvFromEmpty(t *testing.T) {
	out := mergeSettingsEnv("", map[string]string{"A": "b"})
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatal(err)
	}
	env, _ := m["env"].(map[string]any)
	if env["A"] != "b" {
		t.Fatalf("env=%v", env)
	}
}

func TestMergeSettingsEnvBadInputDoesNotPanic(t *testing.T) {
	out := mergeSettingsEnv("{not json", map[string]string{"A": "b"})
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("bad input did not produce valid JSON: %v", err)
	}
}

func TestWriteClaudeSettings(t *testing.T) {
	body := `{"env":{"ANTHROPIC_MODEL":"group/perch-claude"}}`
	p := writeClaudeSettings("t-write-test", body)
	if p == "" {
		t.Fatal("no settings file written")
	}
	defer os.Remove(p)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != body {
		t.Fatalf("content=%q", b)
	}
}
