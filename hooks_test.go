package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Wave 2 的订阅表：收尾那一组（PostToolUse/PostToolUseFailure/UserPromptSubmit/
// PostCompact）必须在，matcher 与 async 的取舍也必须和注释里写的理由一致 ——
// 这几条都是“看字节才知道对不对”的事（--settings 是启动时写死的，改错了界面
// 上只会表现为“销账慢/不销账”）。
func TestBuildHookSettingsWave2(t *testing.T) {
	// buildHookSettings 只认“和当前进程同目录”的接收器。测试进程在 go-build 的
	// 临时目录里，放一个占位文件就够（只解析生成出来的 JSON，不执行它）。
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dummy := filepath.Join(filepath.Dir(exe), hookExeName)
	if err := os.WriteFile(dummy, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(dummy) })

	raw := buildHookSettings("t7")
	if raw == "" {
		t.Fatal("buildHookSettings 返回空串：接收器找不到？")
	}
	var cfg struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Type    string   `json:"type"`
				Command string   `json:"command"`
				Args    []string `json:"args"`
				Async   bool     `json:"async"`
				Timeout int      `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("--settings 不是合法 JSON: %v", err)
	}

	want := map[string]string{
		// 收尾那一组（Wave 2）
		"UserPromptSubmit": "", "PostToolUse": "*", "PostToolUseFailure": "*",
		"PostCompact": "",
		// 交互点（Wave 1）
		"PermissionRequest": "", "PreToolUse": "AskUserQuestion",
	}
	for ev, matcher := range want {
		entries := cfg.Hooks[ev]
		if len(entries) != 1 || len(entries[0].Hooks) != 1 {
			t.Fatalf("%s 订阅形状不对: %+v", ev, entries)
		}
		if entries[0].Matcher != matcher {
			t.Errorf("%s matcher=%q，要 %q", ev, entries[0].Matcher, matcher)
		}
		h := entries[0].Hooks[0]
		if h.Type != "command" || h.Command == "" {
			t.Errorf("%s 的 hook 不是 exec 形式: %+v", ev, h)
		}
		if len(h.Args) != 1 || filepath.Base(h.Args[0]) != "t7.jsonl" {
			t.Errorf("%s 的事件文件参数不对: %+v", ev, h.Args)
		}
		if h.Timeout != 5 {
			t.Errorf("%s timeout=%d，要 5", ev, h.Timeout)
		}
		// 交互点同步（不挡 GUI 的“先看见再放行”），其余一律 async。
		wantAsync := ev != "PermissionRequest" && ev != "PreToolUse"
		if h.Async != wantAsync {
			t.Errorf("%s async=%v，要 %v", ev, h.Async, wantAsync)
		}
	}
	if len(cfg.Hooks) != len(hookEventTypes) {
		t.Errorf("订阅了 %d 个事件，表里有 %d 个", len(cfg.Hooks), len(hookEventTypes))
	}
}
