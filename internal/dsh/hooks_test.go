package dsh

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildHooksJSONCoversSupportedEvents(t *testing.T) {
	b, err := BuildHooksJSON(`C:\Program Files\Perch\perch-hook.exe`, `C:\Users\dev\.claude\hook-events`)
	if err != nil {
		t.Fatal(err)
	}
	var f hooksFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Hooks) != len(HookEvents) {
		t.Fatalf("hooks = %d, want %d", len(f.Hooks), len(HookEvents))
	}
	for _, e := range HookEvents {
		groups := f.Hooks[e]
		if len(groups) != 1 || len(groups[0].Hooks) != 1 {
			t.Fatalf("%s missing command group", e)
		}
		h := groups[0].Hooks[0]
		if h.Type != "command" {
			t.Fatalf("%s type = %q", e, h.Type)
		}
		if !strings.Contains(h.Command, "perch-hook.exe") ||
			!strings.Contains(h.Command, "hook-events") ||
			!strings.HasSuffix(h.Command, "--pane") {
			t.Fatalf("%s command = %q", e, h.Command)
		}
	}
	if !hooksJSONComplete(b) {
		t.Fatal("generated hooks file should be complete")
	}
}

func TestHooksJSONCompleteRejectsMissingEvent(t *testing.T) {
	b, err := BuildHooksJSON(`C:\perch-hook.exe`, `C:\hook-events`)
	if err != nil {
		t.Fatal(err)
	}
	var f hooksFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	delete(f.Hooks, "Stop")
	trimmed, _ := json.Marshal(f)
	if hooksJSONComplete(trimmed) {
		t.Fatal("missing Stop must not be complete")
	}
}

func TestPSQuoteEscapesSingleQuotes(t *testing.T) {
	got := psQuote(`C:\it's\perch-hook.exe`)
	want := `'C:\it''s\perch-hook.exe'`
	if got != want {
		t.Fatalf("psQuote = %q, want %q", got, want)
	}
}
