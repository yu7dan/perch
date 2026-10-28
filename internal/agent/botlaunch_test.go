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
	env, args = BotLaunch("pi", BotConfig{Model: "x", Permission: "read-only"})
	if len(env) != 0 || len(args) != 0 {
		t.Fatalf("pi should get nothing, got %v %v", env, args)
	}
	if env, args := BotLaunch("claude", BotConfig{}); len(env) != 0 || len(args) != 0 {
		t.Fatalf("empty config should inject nothing, got %v %v", env, args)
	}
}
