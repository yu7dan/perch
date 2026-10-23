package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// 续接护栏的“盘上还有没有这条会话”必须按 agent 各自的落点回答。
// 以前 qoder/copilot/dsh/cursor/agy 全掉进 Claude 的 projects\ 判据，
// 于是“明明有对话”的已关闭 agent 会被说成接不上。
func TestSessionFileExistsForEachAgent(t *testing.T) {
	home := t.TempDir()
	SetHost(agyTestHost{homeEnv: map[string]string{"USERPROFILE": home, "HOME": home}})
	defer SetHost(defaultHost{})

	write := func(rel string) {
		t.Helper()
		p := filepath.Join(home, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const sid = "01a16809-e424-706d-a0ad-4e753051336c"

	write(".qoder/projects/C--work/" + sid + ".jsonl")
	if !SessionFileExistsFor("qoder", `C:\work`, sid) {
		t.Fatal("qoder 有项目 jsonl，却报不存在")
	}

	write(".copilot/session-state/" + sid + "/events.jsonl")
	if !SessionFileExistsFor("copilot", `C:\work`, sid) {
		t.Fatal("copilot 有 events.jsonl，却报不存在")
	}

	write(".dsh/sessions/--C-work--/" + sid + "/session.v4.jsonl.zstd")
	if !SessionFileExistsFor("dsh", `C:\work`, sid) {
		t.Fatal("dsh 有 session.v4.jsonl.zstd，却报不存在")
	}

	write(".cursor/projects/C-work/agent-transcripts/" + sid + "/" + sid + ".jsonl")
	if !SessionFileExistsFor("cursor", `C:\work`, sid) {
		t.Fatal("cursor 有 agent-transcripts，却报不存在")
	}

	write(".gemini/antigravity-cli/brain/" + sid + "/.system_generated/logs/transcript.jsonl")
	if !SessionFileExistsFor("agy", `C:\work`, sid) {
		t.Fatal("agy 有 brain transcript，却报不存在")
	}

	// 没有文件的 agent 不能借 Claude 的 projects\ 目录误判。
	if SessionFileExistsFor("claude", `C:\work`, sid) {
		t.Fatal("claude 在临时 home 里没有 projects，不该报存在")
	}
}
