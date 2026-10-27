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

func TestSettingsLanguageNormalize(t *testing.T) {
	if got := Defaults().Language; got != "auto" {
		t.Fatalf("默认语言应是 auto，实际 %q", got)
	}

	for _, tc := range []struct{ in, want string }{
		{" EN ", "en"},
		{"zh", "zh"},
		{"AUTO", "auto"},
		{"zh-CN", "auto"}, // 只收三个枚举值；系统语言由前端 auto 解析
		{"fr", "auto"},
		{"", "auto"},
	} {
		s := Defaults()
		s.Language = tc.in
		if got := s.Normalize().Language; got != tc.want {
			t.Errorf("Language %q 应归一成 %q，实际 %q", tc.in, tc.want, got)
		}
	}
}

func TestSettingsStartViewNormalize(t *testing.T) {
	if got := Defaults().StartView; got != "workspace" {
		t.Fatalf("default startView should be workspace, got %q", got)
	}
	for _, tc := range []struct{ in, want string }{
		{"workspace", "workspace"},
		{" WORKSPACE ", "workspace"},
		{"dash", "dash"}, // explicit user choice survives
		{" DASH ", "dash"},
		{"", "workspace"},
		{"overview", "workspace"},
	} {
		s := Defaults()
		s.StartView = tc.in
		if got := s.Normalize().StartView; got != tc.want {
			t.Errorf("StartView %q normalized to %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSettingsUIModeNormalize(t *testing.T) {
	if got := Defaults().UIMode; got != "classic" {
		t.Fatalf("default uiMode should be classic, got %q", got)
	}
	for _, tc := range []struct{ in, want string }{
		{" classic ", "classic"},
		{"clean", "classic"}, // old beta called this shell clean
		{"CLEAN", "classic"},
		{"", "classic"},
		{"fancy", "classic"},
	} {
		s := Defaults()
		s.UIMode = tc.in
		if got := s.Normalize().UIMode; got != tc.want {
			t.Errorf("UIMode %q normalized to %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := Defaults().TopMode; got != "workspaces" {
		t.Fatalf("default topMode should be workspaces, got %q", got)
	}
	for _, tc := range []struct{ in, want string }{
		{"botgroup", "botgroup"}, {" BotGroup ", "botgroup"},
		{"chat", "workspaces"}, {"", "workspaces"},
	} {
		s := Defaults()
		s.TopMode = tc.in
		if got := s.Normalize().TopMode; got != tc.want {
			t.Errorf("TopMode %q normalized to %q, want %q", tc.in, got, tc.want)
		}
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
