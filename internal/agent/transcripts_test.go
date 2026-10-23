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

	// OpenCode 没有 jsonl：会话 id 明文存在 perch-cli.db / -wal 里。
	ocid := "ses_" + sid
	ocDB := filepath.Join(home, ".local", "share", "opencode", "perch-cli.db")
	if err := os.MkdirAll(filepath.Dir(ocDB), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ocDB, []byte("noise "+ocid+" noise"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !SessionFileExistsFor("opencode", `C:\work`, ocid) {
		t.Fatal("opencode 的会话 id 在 perch-cli.db 里，却报不存在")
	}
	if SessionFileExistsFor("opencode", `C:\work`, "ses_missing") {
		t.Fatal("opencode 不存在的 id 被误判成存在")
	}

	// 没有文件的 agent 不能借 Claude 的 projects\ 目录误判。
	if SessionFileExistsFor("claude", `C:\work`, sid) {
		t.Fatal("claude 在临时 home 里没有 projects，不该报存在")
	}
}

// Pi 一启动就写 session 文件；零轮次的那种不能被当成"有会话" —— 否则关掉
// 一个从没说过话的 Pi，记录会留下来，左栏多一行永远接不上的壳。
func TestPiSessionNeedsAConversationTurn(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", root)

	const id = "01a16809-e424-706d-a0ad-4e753051336c"
	p := filepath.Join(root, "--C-work--", "20261023_"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"type":"session","id":"`+id+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if SessionFileExistsFor("pi", `C:\work`, id) {
		t.Fatal("零轮次的 Pi 会话文件被误判成可续")
	}
	if err := os.WriteFile(p, []byte(`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !SessionFileExistsFor("pi", `C:\work`, id) {
		t.Fatal("有过 user 消息的 Pi 会话应当可续")
	}
}
