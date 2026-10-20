package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestDestForClaudeFileMode(t *testing.T) {
	args := []string{`C:\Perch\perch-hook.exe`, `C:\Perch\hook-events\t1.jsonl`}
	got := destFor(args, func(string) string { return "" })
	if got != args[1] {
		t.Fatalf("destFor = %q, want %q", got, args[1])
	}
}

func TestDestForDshPaneMode(t *testing.T) {
	dir := `C:\Perch\hook-events`
	args := []string{`C:\Perch\perch-hook.exe`, dir, "--pane"}
	got := destFor(args, func(k string) string {
		if k == "PERCH_AGENT_PANE" {
			return "t42"
		}
		return ""
	})
	want := filepath.Join(dir, "t42.jsonl")
	if got != want {
		t.Fatalf("destFor = %q, want %q", got, want)
	}
}

func TestDestForDshPaneModeRejectsBadPaneTag(t *testing.T) {
	args := []string{`C:\Perch\perch-hook.exe`, `C:\Perch\hook-events`, "--pane"}
	for _, tag := range []string{"", "t", "t-1", `t1\..\x`, "wt"} {
		got := destFor(args, func(string) string { return tag })
		if got != "" {
			t.Fatalf("pane tag %q produced %q, want empty", tag, got)
		}
	}
}

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("不是 JSON: %v\n%s", err, b)
	}
	return m
}

const agyBase = `{
  "conversationId": "ec33ebf9-0cba-4100-8142-c61503f6c587",
  "workspacePaths": ["C:\\work\\demo"],
  "transcriptPath": "C:\\work\\demo\\.gemini\\antigravity-cli\\transcript.jsonl",
  "modelName": "auto",
  "toolCall": {"name": "run_command", "args": {"CommandLine": "secret command"}}
}`

func TestAgySessionStart(t *testing.T) {
	m := decode(t, normalizeAgy("SessionStart", []byte(agyBase)))
	if m["hook_event_name"] != "AgySessionStart" {
		t.Fatalf("event = %v", m["hook_event_name"])
	}
	if m["session_id"] != "ec33ebf9-0cba-4100-8142-c61503f6c587" {
		t.Fatalf("session = %v", m["session_id"])
	}
	if m["cwd"] != `C:\work\demo` {
		t.Fatalf("cwd = %v", m["cwd"])
	}
	if !strings.Contains(m["transcript_path"].(string), "transcript.jsonl") {
		t.Fatalf("transcript = %v", m["transcript_path"])
	}
	if _, ok := m["toolCall"]; ok {
		t.Fatal("工具参数泄漏进了事件")
	}
}

func TestAgyWorkingAndIdle(t *testing.T) {
	if got := decode(t, normalizeAgy("PreInvocation", []byte(agyBase)))["hook_event_name"]; got != "AgyWorking" {
		t.Fatalf("PreInvocation → %v", got)
	}
	idle := agyBase[:len(agyBase)-2] + `, "fullyIdle": true}`
	if got := decode(t, normalizeAgy("Stop", []byte(idle)))["hook_event_name"]; got != "AgyIdle" {
		t.Fatalf("Stop(fullyIdle) → %v", got)
	}
	bg := agyBase[:len(agyBase)-2] + `, "fullyIdle": false}`
	if got := decode(t, normalizeAgy("Stop", []byte(bg)))["hook_event_name"]; got != "AgyWorking" {
		t.Fatalf("Stop(not idle) → %v", got)
	}
}

func TestAgyStopErrorIsFailedIdle(t *testing.T) {
	body := agyBase[:len(agyBase)-2] + `, "terminationReason": "ERROR", "error": "boom"}`
	m := decode(t, normalizeAgy("Stop", []byte(body)))
	if m["hook_event_name"] != "AgyIdle" || m["failed"] != true {
		t.Fatalf("错误收尾 = %v", m)
	}
	if _, ok := m["error"]; ok {
		t.Fatal("错误正文不该进事件")
	}
}

func TestAgyUnknownEventIgnored(t *testing.T) {
	if b := normalizeAgy("PreToolUse", []byte(agyBase)); b != nil {
		t.Fatalf("PreToolUse 不该被订阅: %s", b)
	}
}
