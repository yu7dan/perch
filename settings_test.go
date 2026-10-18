package main

import "testing"

// TestSettingsDefaultAgentNormalize 守住“默认 agent”这条设置的形状：
//
//	· 空串合法 = 自动；
//	· 大小写/空白收成小写 id；
//	· 不认识的 id（手改配置、卸载了）落回自动 —— 不能拿一个起不来的 id
//	  去建格。
func TestSettingsDefaultAgentNormalize(t *testing.T) {
	if got := settingsDefaults().DefaultAgent; got != "" {
		t.Fatalf("默认应是自动（空串），实际 %q", got)
	}

	s := settingsDefaults()
	s.DefaultAgent = " PI "
	if got := s.normalize().DefaultAgent; got != "pi" {
		t.Fatalf("应归一成 pi，实际 %q", got)
	}

	s.DefaultAgent = "not-an-agent"
	if got := s.normalize().DefaultAgent; got != "" {
		t.Fatalf("不认识的 id 应落回自动，实际 %q", got)
	}

	// 已知 id 原样保留（pi 在 agentDefs 里，见 main.go 的 init）。
	s.DefaultAgent = "claude"
	if got := s.normalize().DefaultAgent; got != "claude" {
		t.Fatalf("claude 应保留，实际 %q", got)
	}
}
