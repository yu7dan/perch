package agenttrust

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 全部在临时目录里：USERPROFILE / CLAUDE_CONFIG_DIR 都指沙盒，绝不碰真机上正在用的配置。
func sandbox(t *testing.T) (home string, env map[string]string) {
	home = t.TempDir()
	return home, map[string]string{"USERPROFILE": home, "CLAUDE_CONFIG_DIR": filepath.Join(home, "cc")}
}

func readJSON(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("%s: %v", p, err)
	}
	return m
}

func TestClaudeTrustKeepsEverythingElse(t *testing.T) {
	home, env := sandbox(t)
	cc := filepath.Join(home, "cc")
	os.MkdirAll(cc, 0o755)
	cfg := filepath.Join(cc, ".claude.json")
	os.WriteFile(cfg, []byte(`{"numStartups": 12345678901234, "oauthAccount": {"x": "<y>"}, "projects": {"D:/other": {"allowedTools": ["Bash"]}}}`), 0o600)
	proj := filepath.Join(home, "work", "proj")
	os.MkdirAll(proj, 0o755)

	out, err := Grant("claude", proj, env)
	if err != nil || out != Granted {
		t.Fatalf("first grant: %s %v", out, err)
	}
	m := readJSON(t, cfg)
	key := strings.ReplaceAll(proj, `\`, "/")
	p := m["projects"].(map[string]any)
	if p[key].(map[string]any)["hasTrustDialogAccepted"] != true {
		t.Fatalf("not trusted: %v", p)
	}
	if p["D:/other"].(map[string]any)["allowedTools"] == nil || m["oauthAccount"].(map[string]any)["x"] != "<y>" {
		t.Fatalf("other keys lost: %v", m)
	}
	raw, _ := os.ReadFile(cfg)
	if !strings.Contains(string(raw), "12345678901234") || strings.Contains(string(raw), `\u003c`) {
		t.Fatalf("numbers / html chars mangled: %s", raw)
	}
	if out, _ := Grant("claude", proj, env); out != Unchanged {
		t.Fatalf("second grant should be unchanged, got %s", out)
	}
	if _, err := os.Stat(cfg + ".lock"); !os.IsNotExist(err) {
		t.Fatal("lock left behind")
	}
}

func TestClaudeRespectsHeldLockAndBadFiles(t *testing.T) {
	home, env := sandbox(t)
	cc := filepath.Join(home, "cc")
	os.MkdirAll(cc, 0o755)
	cfg := filepath.Join(cc, ".claude.json")
	os.WriteFile(cfg, []byte(`{}`), 0o600)
	os.Mkdir(cfg+".lock", 0o755) // Claude 正拿着锁
	proj := filepath.Join(home, "p")
	os.MkdirAll(proj, 0o755)
	if out, _ := Grant("claude", proj, env); out != Locked {
		t.Fatalf("held lock: got %s", out)
	}
	os.Remove(cfg + ".lock")

	os.WriteFile(cfg, []byte(`{"projects": []}`), 0o600)
	if out, _ := Grant("claude", proj, env); out != Unreadable {
		t.Fatalf("wrong shape: got %s", out)
	}
	os.WriteFile(cfg, []byte(`not json`), 0o600)
	if out, _ := Grant("claude", proj, env); out != Unreadable {
		t.Fatalf("not json: got %s", out)
	}
	if b, _ := os.ReadFile(cfg); string(b) != "not json" {
		t.Fatal("an unreadable config must never be rewritten")
	}
	os.Remove(cfg)
	if out, _ := Grant("claude", proj, env); out != Missing {
		t.Fatalf("missing config: got %s", out)
	}
}

func TestNeverTrustHomeOrRoot(t *testing.T) {
	home, env := sandbox(t)
	for _, p := range []string{home, filepath.Dir(home), filepath.VolumeName(home) + `\`} {
		if out, _ := Grant("claude", p, env); out != TooBroad {
			t.Errorf("%s: got %s, want too-broad", p, out)
		}
	}
}

func TestQoderAndAgy(t *testing.T) {
	home, env := sandbox(t)
	proj := filepath.Join(home, "proj")
	os.MkdirAll(proj, 0o755)

	// Qoder：没登录过（没有 settings.json）就不建
	if out, _ := Grant("qoder", proj, env); out != Missing {
		t.Fatalf("qoder without settings: %s", out)
	}
	qs := filepath.Join(home, ".qoder", "settings.json")
	os.MkdirAll(filepath.Dir(qs), 0o755)
	os.WriteFile(qs, []byte(`{"model": "x", "permissions": {"allow": ["Read"]}}`), 0o644)
	if out, err := Grant("qoder", proj, env); out != Granted {
		t.Fatalf("qoder: %s %v", out, err)
	}
	m := readJSON(t, qs)
	perm := m["permissions"].(map[string]any)
	if len(perm["trustDirectories"].([]any)) != 1 || perm["allow"] == nil || m["model"] != "x" {
		t.Fatalf("qoder settings: %v", m)
	}
	if out, _ := Grant("qoder", proj, env); out != Unchanged {
		t.Fatalf("qoder twice: %s", out)
	}

	// agy：文件不在就建一个只有这一项的
	if out, err := Grant("agy", proj, env); out != Granted {
		t.Fatalf("agy: %s %v", out, err)
	}
	as := readJSON(t, filepath.Join(home, ".gemini", "antigravity-cli", "settings.json"))
	if len(as["trustedWorkspaces"].([]any)) != 1 {
		t.Fatalf("agy settings: %v", as)
	}

	if out, _ := Grant("codex", proj, env); out != Unsupported {
		t.Fatalf("codex: %s", out)
	}
}
