package gateway

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

func withIsolatedPort(t *testing.T, port int) {
	t.Helper()
	oldPort := isolatedGatewayPort
	oldURL := gatewayURL
	isolatedGatewayPort = port
	gatewayURL = "http://127.0.0.1:" + strconv.Itoa(port)
	t.Cleanup(func() {
		isolatedGatewayPort = oldPort
		gatewayURL = oldURL
	})
}

func TestClaudeProfileEnv(t *testing.T) {
	withIsolatedPort(t, 64752)
	env := ClaudeProfileEnv("group/perch-claude")
	if env["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:64752" {
		t.Fatalf("base url=%q", env["ANTHROPIC_BASE_URL"])
	}
	if env["ANTHROPIC_AUTH_TOKEN"] != PerchLocalToken {
		t.Fatalf("token=%q", env["ANTHROPIC_AUTH_TOKEN"])
	}
	for _, k := range []string{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"} {
		if env[k] != "group/perch-claude" {
			t.Errorf("%s=%q", k, env[k])
		}
	}
}

func TestCodexProfileArgs(t *testing.T) {
	withIsolatedPort(t, 64753)
	args := strings.Join(CodexProfileArgs("group/perch-codex"), " ")
	for _, want := range []string{
		`model="group/perch-codex"`,
		`model_provider="perch"`,
		`model_providers.perch.base_url="http://127.0.0.1:64753/v1"`,
		`model_providers.perch.wire_api="responses"`,
		`model_providers.perch.experimental_bearer_token="perch-local"`,
	} {
		if !strings.Contains(args, want) {
			t.Errorf("args %q missing %q", args, want)
		}
	}
}

func TestClaudeTiers(t *testing.T) {
	if got := ClaudeTierAlias("group/perch-claude", "opus"); got != "group/perch-claude-opus" {
		t.Fatalf("alias=%q", got)
	}
	if got := ClaudeTierEnvKey("sonnet"); got != "ANTHROPIC_DEFAULT_SONNET_MODEL" {
		t.Fatalf("env=%q", got)
	}
	if got := ClaudeTierEnvKey("bogus"); got != "" {
		t.Fatalf("bogus env=%q", got)
	}
	env := ClaudeProfileEnv("group/perch-claude")
	if env["ANTHROPIC_DEFAULT_OPUS_MODEL"] != "group/perch-claude" {
		t.Fatalf("default opus=%q", env["ANTHROPIC_DEFAULT_OPUS_MODEL"])
	}
}

func TestAgentGroupTarget(t *testing.T) {
	if got, err := agentGroupTarget("workbuddy/hy3", "high"); err != nil || got != "workbuddy/hy3:high" {
		t.Fatalf("high: %q %v", got, err)
	}
	if got, err := agentGroupTarget(" deepseek/deepseek-flash ", ""); err != nil || got != "deepseek/deepseek-flash" {
		t.Fatalf("no effort: %q %v", got, err)
	}
	if _, err := agentGroupTarget("workbuddy/hy3", "ultra"); err == nil {
		t.Fatal("ultra must be refused")
	}
	if _, err := agentGroupTarget("", "high"); err == nil {
		t.Fatal("empty model must be refused")
	}
}

func TestPluginAgentModels(t *testing.T) {
	dir := t.TempDir()
	body := `[
		{"id":"workbuddy-ai","name":"WorkBuddy AI","signedIn":false,"models":[{"id":"default-model","name":"Default"}]},
		{"id":"workbuddy","name":"WorkBuddy","signedIn":true,"authType":"oauth","models":[
			{"id":"auto","name":"Auto","context":256000},
			{"id":"hy3","name":"Hy3","context":192000,"efforts":["low","high"]}
		]}
	]`
	if err := os.WriteFile(dir+"/plugin-providers.json", []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	out := pluginAgentModels(dir)
	if len(out) != 2 {
		t.Fatalf("len=%d out=%+v", len(out), out)
	}
	if out[0].ID != "workbuddy/auto" || out[0].ProviderName != "WorkBuddy" || out[0].Context != 256000 {
		t.Fatalf("out[0]=%+v", out[0])
	}
	if out[1].ID != "workbuddy/hy3" || len(out[1].Efforts) != 2 || out[1].Efforts[1] != "high" {
		t.Fatalf("out[1]=%+v", out[1])
	}
}

func TestParseAgentModels(t *testing.T) {
	b := []byte(`{"providers":[
		{"id":"deepseek","name":"DeepSeek","icon":"deepseek","models":[
			{"id":"deepseek-flash","name":"Flash","on":true,"efforts":["low","high"],"context":1000000},
			{"id":"deepseek/deepseek-v4-pro","name":"","on":false,"context":200000}
		]},
		{"id":"workbuddy","name":"WorkBuddy","models":[
			{"id":"auto","name":"Auto","on":true}
		]}
	]}`)
	out, err := parseAgentModels(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 3 {
		t.Fatalf("len=%d", len(out))
	}
	byID := map[string]AgentModel{}
	for _, m := range out {
		byID[m.ID] = m
	}
	if m, ok := byID["deepseek/deepseek-flash"]; !ok || m.Name != "Flash" || !m.On || m.Context != 1000000 {
		t.Fatalf("deepseek-flash=%+v ok=%v", m, ok)
	}
	if _, ok := byID["deepseek/deepseek/deepseek-v4-pro"]; ok {
		t.Fatal("already-prefixed model id got prefixed twice")
	}
	if m, ok := byID["workbuddy/auto"]; !ok || m.ProviderName != "WorkBuddy" {
		t.Fatalf("workbuddy=%+v ok=%v", m, ok)
	}
}
