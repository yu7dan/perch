package agent

import (
	"reflect"
	"testing"
)

func TestBotLaunch(t *testing.T) {
	env, args := BotLaunch("claude", BotConfig{Model: "opus", Effort: "high", Permission: "workspace-write"})
	if env["ANTHROPIC_MODEL"] != "opus" || env["CLAUDE_CODE_EFFORT_LEVEL"] != "high" {
		t.Fatalf("claude env = %v", env)
	}
	if !reflect.DeepEqual(args, []string{"--permission-mode", "acceptEdits"}) {
		t.Fatalf("claude args = %v", args)
	}
	_, args = BotLaunch("codex", BotConfig{Model: "gpt-5", Effort: "max", Permission: "full-access"})
	want := []string{"-c", `model="gpt-5"`, "-c", `model_reasoning_effort="xhigh"`,
		"-c", `sandbox_mode="danger-full-access"`, "-c", `approval_policy="never"`}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("codex args = %v", args)
	}
	_, args = BotLaunch("opencode", BotConfig{Model: "anthropic/claude-sonnet-4", Effort: "high", Permission: "full-access"})
	if !reflect.DeepEqual(args, []string{"-m", "anthropic/claude-sonnet-4", "--auto"}) {
		t.Fatalf("opencode args = %v", args)
	}
	_, args = BotLaunch("pi", BotConfig{Model: "x", Effort: "high", Permission: "read-only"})
	if !reflect.DeepEqual(args, []string{"--model", "x", "--thinking", "high", "--tools", "read,grep,find,ls"}) {
		t.Fatalf("pi args = %v", args)
	}
	_, args = BotLaunch("qoder", BotConfig{Model: "q1", Effort: "high", Permission: "read-only"})
	if !reflect.DeepEqual(args, []string{"-m", "q1", "--reasoning-effort", "high", "--tools", "Read", "Grep", "Glob"}) {
		t.Fatalf("qoder args = %v", args)
	}
	_, args = BotLaunch("agy", BotConfig{Model: "gemini-x", Effort: "max", Permission: "full-access"})
	if !reflect.DeepEqual(args, []string{"--model", "gemini-x", "--effort", "max", "--dangerously-skip-permissions"}) {
		t.Fatalf("agy args = %v", args)
	}
	_, args = BotLaunch("agy", BotConfig{Permission: "read-only"})
	if !reflect.DeepEqual(args, []string{"--mode", "plan"}) {
		t.Fatalf("agy read-only args = %v", args)
	}
	env, args = BotLaunch("copilot", BotConfig{Model: "x", Permission: "read-only"})
	if len(env) != 0 || len(args) != 0 {
		t.Fatalf("copilot should get nothing, got %v %v", env, args)
	}
	if env, args := BotLaunch("claude", BotConfig{}); len(env) != 0 || len(args) != 0 {
		t.Fatalf("empty config should inject nothing, got %v %v", env, args)
	}
}
