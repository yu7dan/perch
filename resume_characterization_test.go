package main

import "testing"

// 续接护栏的照片：agent 分派、id 白名单、盘上存在性、冲突。
// 搬进 internal/session 时断言不变。

func TestResumeRefusalCharacterization(t *testing.T) {
	oldState := claudeStateDir
	oldTabs := tabs
	claudeStateDir = t.TempDir()
	tabs = &tabManager{tabs: map[int]*tabHost{}, bySession: map[string]*tabHost{}}
	defer func() {
		claudeStateDir = oldState
		tabs = oldTabs
	}()

	const id = "11111111-1111-4111-8111-111111111111"

	cases := []struct {
		name string
		spec spawnSpec
		code string // "" = 放行
	}{
		{"new", spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "new"}}, ""},
		{"empty-kind", spawnSpec{Agent: "claude"}, ""},
		{"bad-id", spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "exact", ID: "../x"}}, "bad_id"},
		{"missing-file", spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "exact", ID: id}}, "unavailable"},
		{"unknown-kind", spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "wat"}}, "unknown_kind"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resumeRefusal(tc.spec)
			if tc.code == "" {
				if got != nil {
					t.Fatalf("refusal=%+v want nil", got)
				}
				return
			}
			if got == nil || got.code != tc.code {
				t.Fatalf("refusal=%+v want code %q", got, tc.code)
			}
		})
	}

	writeClaudeTranscript(t, claudeStateDir, id)
	if got := resumeRefusal(spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "exact", ID: id}}); got != nil {
		t.Fatalf("exact with file refusal=%+v want nil", got)
	}
	if got := resumeRefusal(spawnSpec{Agent: "claude", Resume: resumeIntent{Kind: "fork", ID: id}}); got != nil {
		t.Fatalf("fork with file refusal=%+v want nil", got)
	}
	if got := resumeRefusal(spawnSpec{Agent: "claude", CWD: t.TempDir(), Resume: resumeIntent{Kind: "latest"}}); got != nil {
		t.Fatalf("latest with no live session refusal=%+v want nil", got)
	}
}

func TestResumeRefusalRejectsBadSessionID(t *testing.T) {
	oldState := claudeStateDir
	claudeStateDir = t.TempDir()
	defer func() { claudeStateDir = oldState }()

	// 白名单：路径分隔符和通配符不能进 --resume。
	// ⚠️ 前导 `-` 目前**没有**被拒绝（与 resume.go 注释里写的规则不一致）；
	// 本轮是结构整理，不顺手改行为，先把现状拍下来。
	for _, id := range []string{"..\\x", "a/b", "a*b", ""} {
		if safeSessionID(id) {
			t.Errorf("safeSessionID(%q)=true", id)
		}
	}
	if !safeSessionID("-rf") {
		t.Error("behavior changed: leading dash is now rejected")
	}
	if !safeSessionID("11111111-1111-4111-8111-111111111111") {
		t.Error("uuid rejected")
	}
}
