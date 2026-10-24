package agent

import "testing"

func TestCursorTranscriptStatus(t *testing.T) {
	st := &transcriptStatusState{}
	if _, s, _, _, ok := ingestCursorStatus(`{"role":"user","message":{"content":[]}}`, st); !ok || s != "busy" {
		t.Fatalf("user → busy，实际 %s ok=%v", s, ok)
	}
	if _, s, _, _, ok := ingestCursorStatus(`{"role":"assistant"}`, st); !ok || s != "idle" {
		t.Fatalf("assistant → idle，实际 %s ok=%v", s, ok)
	}
}

func TestCopilotTranscriptStatus(t *testing.T) {
	st := &transcriptStatusState{}
	if _, s, _, _, ok := ingestCopilotStatus(`{"type":"user.message","data":{"content":"hi"}}`, st); !ok || s != "busy" {
		t.Fatalf("user.message → busy，实际 %s ok=%v", s, ok)
	}
	if _, s, _, _, ok := ingestCopilotStatus(`{"type":"assistant.turn_end"}`, st); !ok || s != "idle" {
		t.Fatalf("turn_end → idle，实际 %s ok=%v", s, ok)
	}
	if _, s, k, _, ok := ingestCopilotStatus(`{"type":"permission.requested","data":{"toolName":"bash"}}`, st); !ok || s != "waiting" || k != "perm" {
		t.Fatalf("permission → waiting/perm，实际 %s/%s ok=%v", s, k, ok)
	}
}

func TestAgyTranscriptStatus(t *testing.T) {
	st := &transcriptStatusState{}
	if _, s, _, _, ok := ingestAgyStatus(`{"source":"USER_EXPLICIT","type":"USER_INPUT"}`, st); !ok || s != "busy" {
		t.Fatalf("USER_INPUT → busy，实际 %s", s)
	}
	if _, s, _, _, ok := ingestAgyStatus(`{"source":"MODEL","type":"PLANNER_RESPONSE","tool_calls":[]}`, st); !ok || s != "idle" {
		t.Fatalf("无工具 planner → idle，实际 %s", s)
	}
	if _, s, k, _, ok := ingestAgyStatus(`{"source":"MODEL","type":"PLANNER_RESPONSE","tool_calls":[{"name":"ask_user","args":{"Prompt":"继续？"}}]}`, st); !ok || s != "waiting" || k != "ask" {
		t.Fatalf("ask_user → waiting/ask，实际 %s/%s", s, k)
	}
}

func TestQoderTranscriptStatus(t *testing.T) {
	st := &transcriptStatusState{}
	if _, s, _, _, ok := ingestQoderStatus(`{"type":"user"}`, st); !ok || s != "busy" {
		t.Fatalf("user → busy，实际 %s", s)
	}
	if _, s, _, _, ok := ingestQoderStatus(`{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text"}]}}`, st); !ok || s != "idle" {
		t.Fatalf("end_turn → idle，实际 %s", s)
	}
	if _, s, k, _, ok := ingestQoderStatus(`{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"AskUserQuestion"}]}}`, st); !ok || s != "waiting" || k != "ask" {
		t.Fatalf("AskUserQuestion → waiting/ask，实际 %s/%s", s, k)
	}
}

func TestSessionFromTranscriptPath(t *testing.T) {
	agy := `C:\h\.gemini\antigravity-cli\brain\1260467d-41b0-4396-876e-6076363903b2\.system_generated\logs\transcript_full.jsonl`
	if got := sessionFromTranscriptPath("agy", agy); got != "1260467d-41b0-4396-876e-6076363903b2" {
		t.Fatalf("agy session = %q", got)
	}
	cur := `C:\h\.cursor\projects\p\agent-transcripts\55d75b7f-f991-42da-8a3c-30c4355ca0bf\55d75b7f-f991-42da-8a3c-30c4355ca0bf.jsonl`
	if got := sessionFromTranscriptPath("cursor", cur); got != "55d75b7f-f991-42da-8a3c-30c4355ca0bf" {
		t.Fatalf("cursor session = %q", got)
	}
	cop := `C:\h\.copilot\session-state\cfffbead-8162-48b6-a1b4-52b19f4c6288\events.jsonl`
	if got := sessionFromTranscriptPath("copilot", cop); got != "cfffbead-8162-48b6-a1b4-52b19f4c6288" {
		t.Fatalf("copilot session = %q", got)
	}
}
