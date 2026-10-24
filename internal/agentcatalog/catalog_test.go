package agentcatalog

import "testing"

// 产品名单是用户 2026-10-23 定的：只保留这 9 个 agent，其他不再出现在
// 安装/启动/UI 里。这个测试把“名单”和“安装配方必须一一对应”钉死，
// 防止以后改 entries 忘了 recipes（或反过来）。
func TestAgentCliList(t *testing.T) {
	want := []string{
		"claude", "codex", "pi", "opencode",
		"agy", "dsh", "cursor", "copilot", "qoder",
	}
	got := Entries()
	if len(got) != len(want) {
		t.Fatalf("entries=%d want %d: %+v", len(got), len(want), got)
	}
	for i, e := range got {
		if e.ID != want[i] {
			t.Errorf("entry[%d]=%q want %q", i, e.ID, want[i])
		}
		if _, ok := Recipes[e.ID]; !ok {
			t.Errorf("%s has no install recipe", e.ID)
		}
	}
	removed := []string{"codebuddy", "kimi", "muse", "zcode", "gemini", "qwen", "crush"}
	for _, id := range removed {
		if Exists(id) {
			t.Errorf("removed agent %q is still in entries", id)
		}
		if _, ok := Recipes[id]; ok {
			t.Errorf("removed agent %q still has a recipe", id)
		}
	}
}
