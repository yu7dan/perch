package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestPiBlockedState：观察扩展对提问工具写 state=blocked；Go 侧必须原样
// 带到 agentEvent，并把 wire 状态换成 waiting（UI 现有判据只认 status）。
func TestPiBlockedState(t *testing.T) {
	var got []agentEvent
	handlePiLine(1, `{"type":"status","session":"ses_pi","status":"waiting",`+
		`"state":"blocked","kind":"ask","text":"AskUserQuestion"}`, &piPaneState{}, func(ev agentEvent) {
		got = append(got, ev)
	})
	if len(got) != 1 {
		t.Fatalf("应收到 1 条事件，实际 %d", len(got))
	}
	ev := got[0]
	if ev.State != agentStateBlocked || ev.Status != "waiting" ||
		ev.Evidence != EvidenceExtension || ev.Kind != "ask" {
		t.Fatalf("提问工具事件不对: %+v", ev)
	}

	// 普通 busy 没有 state：按 status 补成 working。
	handlePiLine(1, `{"type":"status","session":"ses_pi","status":"busy"}`, &piPaneState{}, func(ev agentEvent) {
		got = append(got, ev)
	})
	if ev := got[len(got)-1]; ev.State != agentStateWorking || ev.Evidence != EvidenceExtension {
		t.Fatalf("busy 事件不对: %+v", ev)
	}
}

func TestPiFlowActsAndFiles(t *testing.T) {
	h := &flowTestHost{}
	SetHost(h)
	defer SetHost(defaultHost{})
	st := &piPaneState{flow: newPiFlow()}
	noop := func(agentEvent) {}

	handlePiLine(1, `{"type":"session_start","session":"ses_pi"}`, st, noop)
	handlePiLine(1, `{"type":"act","id":"m1","kind":"prompt","text":"读 a.txt"}`, st, noop)
	handlePiLine(1, `{"type":"act","id":"call_1","kind":"tool","tool":"read","text":"read a.txt","path":"a.txt"}`, st, noop)
	handlePiLine(1, `{"type":"act_update","id":"call_1","ok":true,"text":"hello"}`, st, noop)
	handlePiLine(1, `{"type":"file","path":"a.txt","op":"read"}`, st, noop)

	if len(st.flow.acts) != 2 {
		t.Fatalf("同 id 的 act_update 必须原地更新，实际 %+v", st.flow.acts)
	}
	tool := st.flow.acts[1]
	if tool.OK == nil || !*tool.OK || tool.Text != "hello" {
		t.Fatalf("工具结果没回填: %+v", tool)
	}
	if f := st.flow.files["a.txt"]; f == nil || len(f.Ops) != 1 || f.Ops[0] != "read" {
		t.Fatalf("文件台账不对: %+v", st.flow.files)
	}
	// 第一帧必须 replace：否则新会话会叠在上一条 Pi 会话后面。
	var first map[string]any
	for _, p := range h.pushed {
		m, ok := p.(map[string]any)
		if ok && m["type"] == "acts" && len(fmtActs(m)) > 0 {
			first = m
			break
		}
	}
	if first == nil || first["replace"] != true {
		t.Fatalf("第一条非空流水必须 replace=true: %+v", h.pushed)
	}
}

func fmtActs(m map[string]any) []any {
	b, _ := json.Marshal(m["items"])
	var out []any
	_ = json.Unmarshal(b, &out)
	return out
}

func TestPiResumeArgs(t *testing.T) {
	def := PiDef()
	cases := []struct {
		in   ResumeIntent
		want []string
	}{
		{ResumeIntent{Kind: "new"}, nil},
		{ResumeIntent{Kind: "latest"}, []string{"--continue"}},
		{ResumeIntent{Kind: "exact", ID: "01a15035-3fc0"}, []string{"--session-id", "01a15035-3fc0"}},
		{ResumeIntent{Kind: "fork", ID: "01a15035-3fc0"}, []string{"--fork", "01a15035-3fc0"}},
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
	if !SessionFileExistsFor("pi", "", "01a15035-3fc0-7204-8817-23e1bf203ddc") {
		t.Fatal("SessionFileExistsFor 没有分派到 Pi 的判据")
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
