package gateway

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProtocolOfProvider(t *testing.T) {
	cases := []struct {
		name     string
		row      providerRow
		protocol string
		base     string
	}{
		{"anthropic wins", providerRow{Chat: "https://c", Anthropic: "https://a"}, "anthropic", "https://a"},
		{"gemini", providerRow{Gemini: "https://g"}, "gemini", "https://g"},
		{"chat", providerRow{Chat: "https://c", Responses: "https://r"}, "openai", "https://c"},
		{"responses only", providerRow{Responses: "https://r"}, "responses", "https://r"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			protocol, base := protocolOfProvider(c.row)
			if protocol != c.protocol || base != c.base {
				t.Fatalf("got (%q,%q), want (%q,%q)", protocol, base, c.protocol, c.base)
			}
		})
	}
}

func TestProviderInfoNormalizesModelsAndAgents(t *testing.T) {
	row := providerRow{
		ID: "local-stub", Name: "Local Stub", Preset: "custom", Icon: "stub",
		Host: "127.0.0.1:18999", Chat: "http://127.0.0.1:18999/v1",
		Key: providerKeyWire{Set: true, Masked: "sk-…abcd", Optional: true},
		Models: []providerModelWire{
			{ID: "stub-model", Name: "Stub Model", Context: 128000, On: true},
			{ID: "other", NoAPI: true},
		},
		Agents: []providerAgentWire{{ID: "codex", Name: "Codex", Icon: "codex-color", Current: true, Model: "stub-model"}},
		Ready:  true,
	}
	p := providerInfo(row)
	if p.Protocol != "openai" || p.BaseURL != "http://127.0.0.1:18999/v1" {
		t.Fatalf("protocol/base lost: %+v", p)
	}
	if !p.KeyConfigured || p.KeyMasked != "sk-…abcd" || !p.KeyOptional || p.KeyStatus != "untested" {
		t.Fatalf("key projection lost: %+v", p)
	}
	if len(p.Models) != 2 || !p.Models[0].On || p.Models[0].Label != "Stub Model" ||
		p.Models[1].Tools || p.Models[1].Label != "other" {
		t.Fatalf("models lost: %+v", p.Models)
	}
	if len(p.Agents) != 1 || !p.Agents[0].Current || p.Agents[0].Model != "stub-model" {
		t.Fatalf("agents lost: %+v", p.Agents)
	}
	// The engine's ready is capability, not proof the key was tested.
	if p.KeyStatus == "ok" {
		t.Fatal("ready must not be reported as a verified key")
	}
}

func TestPresetSupportedBoundary(t *testing.T) {
	cases := []struct {
		name string
		row  providerPresetRow
		want bool
	}{
		{"vendor with chat", providerPresetRow{Kind: "vendor", Chat: "https://c"}, true},
		{"relay with responses", providerPresetRow{Kind: "relay", Responses: "https://r"}, true},
		{"local without endpoints", providerPresetRow{Kind: "local"}, true},
		{"remote kind", providerPresetRow{Kind: "remote", Chat: "https://c"}, false},
		{"sponsored", providerPresetRow{Kind: "vendor", Chat: "https://c", Sponsored: true}, false},
		{"vertex", providerPresetRow{Kind: "vendor", Chat: "https://c", Vertex: true}, false},
		{"decide only", providerPresetRow{Kind: "relay", Decide: "https://d"}, false},
		{"vendor without endpoint", providerPresetRow{Kind: "vendor"}, false},
		{"endpoint editor", providerPresetRow{Kind: "vendor", Endpoint: "resource"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := presetSupported(c.row); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestPresetInfoKeepsEditorFacts(t *testing.T) {
	row := providerPresetRow{
		ID: "kimi", Name: "Kimi", Short: "Kimi", Kind: "vendor",
		Chat: "https://api.moonshot.cn/v1", KeysURL: "https://platform.moonshot.cn/console/api-keys",
		KeyHint: "sk-...", RegionLabel: "区域",
		Regions: []presetRegionWire{
			{ID: "global", Name: "全球", Chat: "https://api.moonshot.ai/v1"},
			{ID: "cn", Name: "中国", Chat: "https://api.moonshot.cn/v1"},
		},
		Models: []string{"kimi-k2"}, NoList: true, Only: "chat", Added: true,
	}
	p := presetInfo(row)
	if p.ID != "kimi" || p.Kind != "vendor" || p.Chat != "https://api.moonshot.cn/v1" {
		t.Fatalf("preset fields lost: %+v", p)
	}
	if len(p.Regions) != 2 || p.Regions[1].ID != "cn" || p.Regions[1].Chat != "https://api.moonshot.cn/v1" {
		t.Fatalf("regions lost: %+v", p.Regions)
	}
	if !p.NoList || len(p.Models) != 1 || p.Only != "chat" || !p.Added {
		t.Fatalf("model hints lost: %+v", p)
	}
}

func TestCleanProviderModelsAndEndpoints(t *testing.T) {
	models := cleanProviderModels([]string{" a ", "", "b", "  "})
	if len(models) != 2 || models[0] != "a" || models[1] != "b" {
		t.Fatalf("models = %#v", models)
	}
	eps, err := cleanProviderEndpoints(map[string]string{
		"chat": " https://api.example.com/v1/ ", "responses": "", "bogus": "https://x",
	})
	if err != nil {
		t.Fatalf("endpoints: %v", err)
	}
	if len(eps) != 1 || eps["chat"] != "https://api.example.com/v1" {
		t.Fatalf("endpoints = %#v", eps)
	}
	if _, err := cleanProviderEndpoints(map[string]string{"chat": "file:///x"}); err == nil {
		t.Fatal("non-http endpoint must be rejected")
	}
}

func TestProviderInfoJSONHasNoEngineSnakeCase(t *testing.T) {
	p := providerInfo(providerRow{
		ID: "x", Chat: "https://x", Key: providerKeyWire{Set: true},
		Models: []providerModelWire{{ID: "m", On: true}},
	})
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	for _, want := range []string{`"keyConfigured":true`, `"keyStatus":"untested"`, `"models":[`, `"on":true`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %s in %s", want, s)
		}
	}
}
