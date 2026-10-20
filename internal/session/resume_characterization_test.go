package session

import (
	"os"
	"path/filepath"
	"testing"
)

// 续接护栏的照片：agent 分派、id 白名单、盘上存在性、冲突。
// 搬进 internal/session 时断言不变，只改包名与构造方式。

// writeClaudeTranscript 在 stateDir\projects\demo 下造一份会话文件。
func writeClaudeTranscript(t *testing.T, stateDir, id string) {
	t.Helper()
	dir := filepath.Join(stateDir, "projects", "demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResumeRefusalCharacterization(t *testing.T) {
	stateDir := t.TempDir()
	m := New(Deps{
		StateDir:     stateDir,
		ProcessAlive: func(int) bool { return true },
	})

	const id = "11111111-1111-4111-8111-111111111111"

	cases := []struct {
		name string
		spec SpawnSpec
		code string // "" = 放行
	}{
		{"new", SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "new"}}, ""},
		{"empty-kind", SpawnSpec{Agent: "claude"}, ""},
		{"bad-id", SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "exact", ID: "../x"}}, "bad_id"},
		{"missing-file", SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "exact", ID: id}}, "unavailable"},
		{"unknown-kind", SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "wat"}}, "unknown_kind"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := m.ResumeRefusal(tc.spec)
			if tc.code == "" {
				if got != nil {
					t.Fatalf("refusal=%+v want nil", got)
				}
				return
			}
			if got == nil || got.Code != tc.code {
				t.Fatalf("refusal=%+v want code %q", got, tc.code)
			}
		})
	}

	writeClaudeTranscript(t, stateDir, id)
	if got := m.ResumeRefusal(SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "exact", ID: id}}); got != nil {
		t.Fatalf("exact with file refusal=%+v want nil", got)
	}
	if got := m.ResumeRefusal(SpawnSpec{Agent: "claude", Resume: ResumeIntent{Kind: "fork", ID: id}}); got != nil {
		t.Fatalf("fork with file refusal=%+v want nil", got)
	}
	if got := m.ResumeRefusal(SpawnSpec{Agent: "claude", CWD: t.TempDir(), Resume: ResumeIntent{Kind: "latest"}}); got != nil {
		t.Fatalf("latest with no live session refusal=%+v want nil", got)
	}
}

func TestResumeRefusalRejectsBadSessionID(t *testing.T) {
	// 白名单：路径分隔符和通配符不能进 --resume。
	// ⚠️ 前导 `-` 目前**没有**被拒绝（与 resume.go 注释里写的规则不一致）；
	// 本轮是结构整理，不顺手改行为，先把现状拍下来。
	for _, id := range []string{"..\\x", "a/b", "a*b", ""} {
		if SafeSessionID(id) {
			t.Errorf("SafeSessionID(%q)=true", id)
		}
	}
	if !SafeSessionID("-rf") {
		t.Error("behavior changed: leading dash is now rejected")
	}
	if !SafeSessionID("11111111-1111-4111-8111-111111111111") {
		t.Error("uuid rejected")
	}
}
