package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 每格的 --settings 文件落在这个 Perch 自己的配置目录（不是共享的 %TEMP%），
// 流一结束就删 —— 里面可能有提供商的 key。
func TestClaudeSettingsFileLivesInPerchDirAndIsRemoved(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", root)
	t.Setenv("XDG_CONFIG_HOME", root)
	p := writeClaudeSettings("t7", `{"env":{"ANTHROPIC_AUTH_TOKEN":"x"}}`)
	if p == "" {
		t.Fatal("writeClaudeSettings returned empty path")
	}
	if !strings.HasPrefix(p, root) || filepath.Base(filepath.Dir(p)) != "claude-settings" {
		t.Fatalf("settings file at %s, want under %s\\Perch\\claude-settings", p, root)
	}
	r := &Running{settingsFile: p}
	r.StopObserve()
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("settings file still there after StopObserve: %v", err)
	}
}
