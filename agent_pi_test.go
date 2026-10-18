package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPiResumeArgs(t *testing.T) {
	def := piAgentDef()
	cases := []struct {
		in   resumeIntent
		want []string
	}{
		{resumeIntent{Kind: "new"}, nil},
		{resumeIntent{Kind: "latest"}, []string{"--continue"}},
		{resumeIntent{Kind: "exact", ID: "01a15035-3fc0"}, []string{"--session-id", "01a15035-3fc0"}},
		{resumeIntent{Kind: "fork", ID: "01a15035-3fc0"}, []string{"--fork", "01a15035-3fc0"}},
	}
	for _, c := range cases {
		got := def.Args(c.in, "")
		if len(got) != len(c.want) {
			t.Fatalf("%+v → %v，想要 %v", c.in, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%+v → %v，想要 %v", c.in, got, c.want)
			}
		}
	}
}

// TestPiSessionFileExists 守住“冷恢复能不能接回 Pi 会话”这条判据。
// 真实布局：sessions/--<项目路径>--/<时间戳>_<session-id>.jsonl。
func TestPiSessionFileExists(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", root)

	if piSessionFileExists("", "01a15035-3fc0-7204-8817-23e1bf203ddc") {
		t.Fatal("空目录不该报存在")
	}
	proj := filepath.Join(root, "--C--Users-Administrator-Documents-Perch--")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(proj, "2026-10-18T18-10-29-442Z_01a15035-3fc0-7204-8817-23e1bf203ddc.jsonl")
	if err := os.WriteFile(file, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !piSessionFileExists("", "01a15035-3fc0-7204-8817-23e1bf203ddc") {
		t.Fatal("盘上有会话文件，却报不存在")
	}
	if !sessionFileExistsFor("pi", "", "01a15035-3fc0-7204-8817-23e1bf203ddc") {
		t.Fatal("sessionFileExistsFor 没有分派到 Pi 的判据")
	}
	// 形状不对的 id 不去 glob（同 safeSessionID 的白名单）。
	if piSessionFileExists("", "../01a15035") {
		t.Fatal("非法 id 不该报存在")
	}
}

// TestPiSessionRootSettings：没有环境变量覆盖时，settings.json 的 sessionDir
// 决定会话目录；相对路径从工作目录解析（docs/settings.md）。
func TestPiSessionRootSettings(t *testing.T) {
	agentDir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", "")
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"),
		[]byte(`{"sessionDir":"sessions-here"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	if got, want := piSessionRoot(cwd), filepath.Join(cwd, "sessions-here"); got != want {
		t.Fatalf("root=%q，想要 %q", got, want)
	}

	// 没有 sessionDir 时退回 <agent-dir>/sessions。
	if err := os.WriteFile(filepath.Join(agentDir, "settings.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, want := piSessionRoot(cwd), filepath.Join(agentDir, "sessions"); got != want {
		t.Fatalf("root=%q，想要 %q", got, want)
	}
}
