package gateway

import (
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
