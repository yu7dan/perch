package gateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnginePathsFollowLocalAppData(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)

	wantExe := filepath.Join(local, "Perch", "magpie", "magpie.exe")
	if got := PerchEngineExe(); got != wantExe {
		t.Fatalf("PerchEngineExe=%q want %q", got, wantExe)
	}
	if got, want := PerchEngineDataDir(), filepath.Join(local, "Perch", "magpie", "data"); got != want {
		t.Fatalf("PerchEngineDataDir=%q want %q", got, want)
	}
	if got, want := PerchEngineHomeDir(), filepath.Join(local, "Perch", "gateway", "home"); got != want {
		t.Fatalf("PerchEngineHomeDir=%q want %q", got, want)
	}
}

func TestEngineEnvSandboxesAgentHomes(t *testing.T) {
	local := t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	t.Setenv("PERCH_ISOLATED_PORT", "64749")
	oldPort := isolatedGatewayPort
	oldURL := gatewayURL
	isolatedGatewayPort = 64749
	gatewayURL = "http://127.0.0.1:64749"
	t.Cleanup(func() {
		isolatedGatewayPort = oldPort
		gatewayURL = oldURL
	})

	env, err := engineEnv("sandbox-key")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("bad env entry %q", kv)
		}
		if _, dup := got[k]; dup {
			t.Fatalf("duplicate env key %q", k)
		}
		got[k] = v
	}
	home := PerchEngineHomeDir()
	checks := map[string]string{
		"APPDATA":            filepath.Join(home, "appdata"),
		"LOCALAPPDATA":       filepath.Join(home, "localappdata"),
		"CLAUDE_CONFIG_DIR":  filepath.Join(home, ".claude"),
		"CODEX_HOME":         filepath.Join(home, ".codex"),
		"DSH_HOME":           filepath.Join(home, ".dsh"),
		"MAGPIE_NO_ACCOUNTS": "0",
		"MAGPIE_ADDR":        "127.0.0.1:64749",
		"MAGPIE_WEB_KEY":     "sandbox-key",
		"XDG_CONFIG_HOME":    filepath.Join(home, ".config"),
		"XDG_CACHE_HOME":     filepath.Join(home, ".cache"),
		"XDG_DATA_HOME":      filepath.Join(home, ".local", "share"),
	}
	// USERPROFILE/HOME stay real: the WorkBuddy plugin reads the desktop app's
	// sign-in from %USERPROFILE%\AppData\Local\CodeBuddyExtension. Agent config
	// homes are redirected by the explicit variables checked above.
	realHome := t.TempDir()
	t.Setenv("USERPROFILE", realHome)
	t.Setenv("HOME", realHome)
	env, err = engineEnv("sandbox-key")
	if err != nil {
		t.Fatal(err)
	}
	got = map[string]string{}
	for _, kv := range env {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			t.Fatalf("bad env entry %q", kv)
		}
		got[k] = v
	}
	if got["USERPROFILE"] != realHome || got["HOME"] != realHome {
		t.Errorf("USERPROFILE/HOME must stay real for WorkBuddy desktop sign-in: %q/%q",
			got["USERPROFILE"], got["HOME"])
	}
	for k, want := range checks {
		if got[k] != want {
			t.Errorf("%s=%q want %q", k, got[k], want)
		}
	}
}

func TestEngineStartArgs(t *testing.T) {
	args := strings.Join(engineStartArgs(3445), " ")
	for _, want := range []string{"web", "--no-open", "--addr 127.0.0.1:3445", "--gateway"} {
		if !strings.Contains(args, want) {
			t.Errorf("args %q missing %q", args, want)
		}
	}
}

func TestImportProvidersFromDesktopOnce(t *testing.T) {
	home := t.TempDir()
	local := t.TempDir()
	cache := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("XDG_CACHE_HOME", cache)
	t.Setenv("LOCALAPPDATA", local)

	srcDir := filepath.Join(home, ".config", "magpie")
	if err := os.MkdirAll(srcDir, 0700); err != nil {
		t.Fatal(err)
	}
	cacheSrc := filepath.Join(cache, "magpie", "providers-state.json")
	if err := os.MkdirAll(filepath.Dir(cacheSrc), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cacheSrc, []byte(`{"version":1,"providers":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(srcDir, "providers.json")
	body := `{"alpha":{"id":"alpha","name":"Alpha"},"beta":{"id":"beta","name":"Beta"}}`
	if err := os.WriteFile(src, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}

	n, err := importProvidersFromDesktop()
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("imported count=%d want 2", n)
	}
	target := filepath.Join(PerchEngineDataDir(), "providers.json")
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != body {
		t.Fatalf("target content changed: %q", got)
	}
	cacheGot, err := os.ReadFile(filepath.Join(PerchEngineDataDir(), "cache", "providers-state.json"))
	if err != nil {
		t.Fatalf("providers cache not imported: %v", err)
	}
	if string(cacheGot) != `{"version":1,"providers":{}}` {
		t.Fatalf("providers cache content changed: %q", cacheGot)
	}

	// A later user change in Perch must not be overwritten by a restart.
	if err := os.WriteFile(target, []byte(`{"kept":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if n, err := importProvidersFromDesktop(); err != nil || n != 0 {
		t.Fatalf("second import n=%d err=%v, want 0,nil", n, err)
	}
	got, _ = os.ReadFile(target)
	if string(got) != `{"kept":{}}` {
		t.Fatalf("second import overwrote target: %q", got)
	}
	srcGot, _ := os.ReadFile(src)
	if string(srcGot) != body {
		t.Fatalf("source was modified: %q", srcGot)
	}
}

func TestSetIsolatedPinsPortAndProbeStaysOff(t *testing.T) {
	oldURL := gatewayURL
	oldPort := isolatedGatewayPort
	t.Cleanup(func() {
		gatewayURL = oldURL
		isolatedGatewayPort = oldPort
	})
	t.Setenv("PERCH_ISOLATED_PORT", "64750")

	g := New(nil)
	g.SetIsolated(true)
	if !g.Isolated() {
		t.Fatal("gateway not isolated")
	}
	if gatewayURL != "http://127.0.0.1:64750" {
		t.Fatalf("gatewayURL=%q", gatewayURL)
	}
	if got := IsolatedGatewayAddr(); got != "127.0.0.1:64750" {
		t.Fatalf("addr=%q", got)
	}
	g.Probe()
	g.mu.Lock()
	client := g.client
	g.mu.Unlock()
	if client != nil {
		t.Fatal("Probe attached a client in isolated mode")
	}
}
