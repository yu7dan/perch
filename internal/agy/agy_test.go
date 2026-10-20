package agy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isolate 把 USERPROFILE/HOME 指到临时目录，绝不碰真实 ~/.gemini。
func isolate(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	oldP, hadP := os.LookupEnv("USERPROFILE")
	oldH, hadH := os.LookupEnv("HOME")
	os.Setenv("USERPROFILE", home)
	os.Setenv("HOME", home)
	t.Cleanup(func() {
		if hadP {
			os.Setenv("USERPROFILE", oldP)
		} else {
			os.Unsetenv("USERPROFILE")
		}
		if hadH {
			os.Setenv("HOME", oldH)
		} else {
			os.Unsetenv("HOME")
		}
	})
	return home
}

func TestEnsureHooksPreservesOthersAndIsReady(t *testing.T) {
	home := isolate(t)
	path := filepath.Join(home, ".gemini", "config", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := `{"lint-checker":{"PostToolUse":[{"matcher":"*","hooks":[{"command":"echo hi"}]}]}}`
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	if HooksReady() {
		t.Fatal("还没写就说 ready")
	}
	if err := EnsureHooks(`C:\Perch\perch-hook.exe`, `C:\Perch\hook-events`, nil); err != nil {
		t.Fatal(err)
	}
	if !HooksReady() {
		t.Fatal("写完仍不 ready")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		t.Fatal(err)
	}
	if _, ok := all["lint-checker"]; !ok {
		t.Fatal("用户原有的 hook 被吃掉了")
	}
	var entry map[string]json.RawMessage
	if err := json.Unmarshal(all[HookName], &entry); err != nil {
		t.Fatal(err)
	}
	for _, ev := range hookEvents {
		if len(entry[ev]) == 0 {
			t.Fatalf("缺事件 %s", ev)
		}
	}
	// 备份必须真的存在。
	ents, _ := os.ReadDir(filepath.Dir(path))
	var bak bool
	for _, e := range ents {
		if strings.Contains(e.Name(), ".bak-") {
			bak = true
		}
	}
	if !bak {
		t.Fatal("没有备份")
	}
}

func TestEnsureHooksRefusesBadJSON(t *testing.T) {
	home := isolate(t)
	path := filepath.Join(home, ".gemini", "config", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	bad := []byte("{not json")
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	err := EnsureHooks(`C:\Perch\perch-hook.exe`, `C:\Perch\hook-events`, nil)
	if err == nil {
		t.Fatal("坏 JSON 应该报错")
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(bad) {
		t.Fatal("坏文件被覆盖了")
	}
	if HooksReady() {
		t.Fatal("坏文件不应 ready")
	}
}

func TestHookCommandQuotesPaths(t *testing.T) {
	cmd := HookCommand(`C:\Program Files\Perch\perch-hook.exe`, `C:\Users\me\hook events`, "Stop")
	if !strings.HasPrefix(cmd, `"C:\Program Files\Perch\perch-hook.exe"`) {
		t.Fatalf("exe 没加引号: %s", cmd)
	}
	if !strings.Contains(cmd, `"C:\Users\me\hook events"`) {
		t.Fatalf("事件目录没加引号: %s", cmd)
	}
	if !strings.HasSuffix(cmd, " Stop") {
		t.Fatalf("事件名不对: %s", cmd)
	}
}
