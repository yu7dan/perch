package gateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPiProfileEnv(t *testing.T) {
	withIsolatedPort(t, 64754)
	home := t.TempDir()
	src := filepath.Join(home, ".pi", "agent")
	if err := os.MkdirAll(src, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "settings.json"),
		[]byte(`{"defaultProvider":"old","defaultTools":["-bash"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "models.json"),
		[]byte(`{"providers":{"old":{"name":"Old","api":"openai-completions","models":[]}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	env, err := PiProfileEnv(home, "group/perch-pi", "workbuddy/glm-5.3", "high")
	if err != nil {
		t.Fatal(err)
	}
	dir := env["PI_CODING_AGENT_DIR"]
	if dir == "" {
		t.Fatal("PI_CODING_AGENT_DIR missing")
	}
	defer os.RemoveAll(dir)

	var settings map[string]any
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(b, &settings) != nil {
		t.Fatalf("settings: %s", b)
	}
	if settings["defaultProvider"] != "perch" || settings["defaultModel"] != "group/perch-pi" {
		t.Fatalf("settings=%v", settings)
	}
	if _, ok := settings["defaultTools"]; !ok {
		t.Fatal("user's other settings were not kept")
	}

	var models map[string]any
	b, err = os.ReadFile(filepath.Join(dir, "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(b, &models) != nil {
		t.Fatalf("models: %s", b)
	}
	providers, _ := models["providers"].(map[string]any)
	if providers["old"] == nil || providers["perch"] == nil {
		t.Fatalf("providers=%v", providers)
	}
	perch, _ := providers["perch"].(map[string]any)
	if perch["baseUrl"] != "http://127.0.0.1:64754/v1" || perch["apiKey"] != PerchLocalToken {
		t.Fatalf("perch provider=%v", perch)
	}
	rows, _ := perch["models"].([]any)
	if len(rows) != 1 {
		t.Fatalf("models=%v", perch["models"])
	}
	row, _ := rows[0].(map[string]any)
	if row["id"] != "group/perch-pi" {
		t.Fatalf("model row=%v", row)
	}
	// The real Pi config is only read.
	if got, _ := os.ReadFile(filepath.Join(src, "settings.json")); string(got) != `{"defaultProvider":"old","defaultTools":["-bash"]}` {
		t.Fatalf("source settings changed: %s", got)
	}
}
