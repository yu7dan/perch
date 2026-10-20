package settings

import "testing"

// TestSettingsDefaultAgentNormalize 守住“默认 agent”这条设置的形状：
//
//	· 空串合法 = 自动；
//	· 大小写/空白收成小写 id；
//	· 不认识的 id（手改配置、卸载了）落回自动 —— 不能拿一个起不来的 id
//	  去建格。
func TestSettingsDefaultAgentNormalize(t *testing.T) {
	if got := Defaults().DefaultAgent; got != "" {
		t.Fatalf("默认应是自动（空串），实际 %q", got)
	}

	s := Defaults()
	s.DefaultAgent = " PI "
	if got := s.Normalize().DefaultAgent; got != "pi" {
		t.Fatalf("应归一成 pi，实际 %q", got)
	}

	s.DefaultAgent = "not-an-agent"
	if got := s.Normalize().DefaultAgent; got != "" {
		t.Fatalf("不认识的 id 应落回自动，实际 %q", got)
	}

	// 已知 id 原样保留（pi 在 agentcatalog 的启动清单里）。
	s.DefaultAgent = "claude"
	if got := s.Normalize().DefaultAgent; got != "claude" {
		t.Fatalf("claude 应保留，实际 %q", got)
	}
}

func TestNormalizeShortcut(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"", "", true},
		{"ctrl+alt+n", "Ctrl+Alt+N", true},
		{"shift+ctrl+f5", "Ctrl+Shift+F5", true},
		{"N", "", false}, // 裸键会在终端里吃掉输入
		{"Ctrl+N", "Ctrl+N", true},
		{"Ctrl+Ctrl+N", "", false}, // 重复修饰键
		{"Cmd+N", "", false},       // 不认识的修饰键
		{"Ctrl+Enter", "", false},  // Enter 留给终端
	}
	for _, tc := range tests {
		got, ok := NormalizeShortcut(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("NormalizeShortcut(%q) = (%q, %v)，想要 (%q, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
