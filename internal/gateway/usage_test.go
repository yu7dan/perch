package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUsageViewNormalizesEngineFields(t *testing.T) {
	u := Usage{
		Since: "2026-10-22T00:00:00+08:00",
		Calls: 3, Errors: 1, Retried: 2, Input: 100, Output: 40,
		CacheRead: 60, CacheWrite: 10, Reasoning: 5, Cost: 0.25,
		Unpriced: 1, Timed: 2, TTFT: 123,
		Agents: []AgentTotal{{
			ID: "codex", Name: "Codex", Icon: "codex-color", Calls: 2,
			Input: 80, Output: 30, CacheRead: 20, CacheWrite: 4, Cost: 0.1,
		}},
		Models: []ModelTotal{{
			ID: "local-stub/stub-model", Provider: "local-stub", Model: "stub-model",
			Name: "stub-model", Sub: "Local Stub", Calls: 3,
			Input: 100, Output: 40, CacheRead: 60, Cost: 0.25,
		}},
	}
	v := usageView(u, "7d")
	if v.Period != "7d" || v.Totals.Calls != 3 || v.Totals.CacheRead != 60 || v.Totals.TTFT != 123 {
		t.Fatalf("totals lost: %+v", v)
	}
	if len(v.Agents) != 1 || v.Agents[0].ID != "codex" || v.Agents[0].CacheRead != 20 {
		t.Fatalf("agents lost: %+v", v.Agents)
	}
	if len(v.Models) != 1 || v.Models[0].Sub != "Local Stub" || v.Models[0].Provider != "local-stub" {
		t.Fatalf("models lost: %+v", v.Models)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	for _, want := range []string{`"cacheRead":60`, `"ttftMs":123`, `"agents":[`, `"models":[`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %s in %s", want, s)
		}
	}
	for _, bad := range []string{"cache_read", "cache_write", "ttft_ms"} {
		if strings.Contains(s, bad) {
			t.Fatalf("engine field %q leaked: %s", bad, s)
		}
	}
}

func TestUsagePeriodWhitelist(t *testing.T) {
	for _, p := range []string{"today", "7d", "30d", "all"} {
		if !usagePeriods[p] {
			t.Fatalf("%q must be allowed", p)
		}
	}
	for _, p := range []string{"", "week", "month", "1d", "7D", "all;drop"} {
		if usagePeriods[p] {
			t.Fatalf("%q must not be allowed", p)
		}
	}
}
