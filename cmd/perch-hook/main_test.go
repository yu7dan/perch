package main

import (
	"path/filepath"
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
