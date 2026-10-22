package gateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCodeProfileEnv(t *testing.T) {
	withIsolatedPort(t, 64755)
	env, err := OpenCodeProfileEnv(t.TempDir(), "group/perch-opencode", "deepseek/deepseek-flash", "high")
	if err != nil {
		t.Fatal(err)
	}
	p := env["OPENCODE_CONFIG"]
	if p == "" {
		t.Fatal("OPENCODE_CONFIG missing")
	}
	defer os.RemoveAll(filepath.Dir(p))

	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if json.Unmarshal(b, &cfg) != nil {
		t.Fatalf("config: %s", b)
	}
	if cfg["model"] != "perch/group/perch-opencode" {
		t.Fatalf("model=%v", cfg["model"])
	}
	providers, _ := cfg["provider"].(map[string]any)
	perch, _ := providers["perch"].(map[string]any)
	opts, _ := perch["options"].(map[string]any)
	if opts["baseURL"] != "http://127.0.0.1:64755/v1" || opts["apiKey"] != PerchLocalToken {
		t.Fatalf("perch options=%v", opts)
	}
}
