package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCodexResumeArgs(t *testing.T) {
	def := CodexDef()
	cases := []struct {
		in   ResumeIntent
		want []string
	}{
		{ResumeIntent{Kind: "new"}, nil},
		{ResumeIntent{Kind: "latest"}, []string{"resume", "--last"}},
		{ResumeIntent{Kind: "exact", ID: "01a15035-3fc0"}, []string{"resume", "01a15035-3fc0"}},
		{ResumeIntent{Kind: "fork", ID: "01a15035-3fc0"}, []string{"fork", "01a15035-3fc0"}},
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

func TestCodexTokenDigest(t *testing.T) {
	token, digest, err := newCodexToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 64 {
		t.Fatalf("口令应是 32 字节的 hex（64 字符），实际 %d: %q", len(token), token)
	}
	sum := sha256.Sum256([]byte(token))
	if want := hex.EncodeToString(sum[:]); digest != want {
		t.Fatalf("摘要是对不上的：%s != %s", digest, want)
	}
	if token == digest {
		t.Fatal("明文和摘要不能相同")
	}
}

// TestCodexPortBanner 守住 stderr 里找端口这条链。实测 banner 前后可能带
// ANSI 颜色，所以正则不锚行首。
func TestCodexPortBanner(t *testing.T) {
	line := "\x1b[32mlistening on: ws://127.0.0.1:54321\x1b[0m"
	m := codexPortRe.FindStringSubmatch(line)
	if m == nil || m[1] != "54321" {
		t.Fatalf("没从 banner 里认出端口: %q → %v", line, m)
	}
	if codexPortRe.MatchString("ws://10.0.0.2:54321") {
		t.Fatal("只该认回环地址")
	}
}

func newCodexTestState() (*codexPaneState, *[]agentEvent) {
	evs := &[]agentEvent{}
	st := &codexPaneState{
		tabID:     1,
		threads:   map[string]codexThreadStatus{},
		ephemeral: map[string]bool{},
		subagent:  map[string]bool{},
	}
	return st, evs
}

// 绑定判据会 glob CODEX_HOME；测试必须指向空目录，别去读用户的会话库。
func emptyCodexHome(t *testing.T) {
	t.Helper()
	t.Setenv("CODEX_HOME", t.TempDir())
}

func feedCodex(t *testing.T, st *codexPaneState, evs *[]agentEvent, method string, params any) {
	t.Helper()
	b, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	handleCodexNotification(method, b, st, func(ev agentEvent) {
		*evs = append(*evs, ev)
	})
}

func lastCodexEvent(t *testing.T, evs *[]agentEvent) agentEvent {
	t.Helper()
	if len(*evs) == 0 {
		t.Fatal("没有收到事件")
	}
	return (*evs)[len(*evs)-1]
}

// TestCodexStatusFlow 按 0.163.0 实测的通知形状走一遍：
// thread/started → status active → waitingOnApproval → … → idle。
func TestCodexStatusFlow(t *testing.T) {
	emptyCodexHome(t)
	st, evs := newCodexTestState()

	feedCodex(t, st, evs, "thread/started", map[string]any{
		"thread": map[string]any{
			"id": "th-main", "ephemeral": false,
			"status": map[string]any{"type": "idle"},
		},
	})
	// 启动时的 idle 不绑定：0.163.0 在第一轮之前不写 rollout，先绑会留下
	// 一个接不回来的 id。状态本身照样要推（格子就是空闲的）。
	if ev := lastCodexEvent(t, evs); ev.Status != "idle" || ev.Session != "" || ev.Agent != "codex" {
		t.Fatalf("初始事件不对: %+v", ev)
	}
	if st.session != "" {
		t.Fatalf("第一轮之前不该绑定会话: %q", st.session)
	}

	// 第一轮开始 = 有一轮在跑：这时才绑定。
	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-main",
		"status":   map[string]any{"type": "active", "activeFlags": []string{}},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "busy" || ev.Kind != "" || ev.Session != "th-main" {
		t.Fatalf("忙碌事件不对: %+v", ev)
	}
	if st.session != "th-main" {
		t.Fatalf("active 时没有绑定主线程: %+v", st)
	}

	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-main",
		"status":   map[string]any{"type": "active", "activeFlags": []string{"waitingOnApproval"}},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "waiting" || ev.Kind != "perm" {
		t.Fatalf("等批准事件不对: %+v", ev)
	}

	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-main",
		"status":   map[string]any{"type": "active", "activeFlags": []string{"waitingOnUserInput"}},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "waiting" || ev.Kind != "ask" {
		t.Fatalf("等回答事件不对: %+v", ev)
	}

	// 名字永远跟下一条状态走：单独一条没有 status 的消息会把前端 v.st 清空。
	feedCodex(t, st, evs, "thread/name/updated", map[string]any{
		"threadId": "th-main", "threadName": "Refactor auth",
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "waiting" || ev.Name != "" {
		t.Fatalf("name 事件不该单独下发: %+v", ev)
	}
	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-main",
		"status":   map[string]any{"type": "active", "activeFlags": []string{}},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "busy" || ev.Name != "Refactor auth" {
		t.Fatalf("名字没有跟下一条状态走: %+v", ev)
	}

	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-main",
		"status":   map[string]any{"type": "idle"},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "idle" || ev.Name != "Refactor auth" {
		t.Fatalf("空闲事件不对: %+v", ev)
	}
}

// TestCodexIgnoresInternalThreads：标题生成线程（ephemeral）和子代理线程
// （parentThreadId 非空）不是这一格的状态，不能把它们算进来、更不能绑成会话。
func TestCodexIgnoresInternalThreads(t *testing.T) {
	emptyCodexHome(t)
	st, evs := newCodexTestState()

	feedCodex(t, st, evs, "thread/started", map[string]any{
		"thread": map[string]any{
			"id": "th-title", "ephemeral": true,
			"status": map[string]any{"type": "idle"},
		},
	})
	feedCodex(t, st, evs, "thread/started", map[string]any{
		"thread": map[string]any{
			"id": "th-sub", "ephemeral": false, "parentThreadId": "th-main",
			"status": map[string]any{"type": "idle"},
		},
	})
	if len(*evs) != 0 {
		t.Fatalf("只有内部线程时不该发事件: %+v", *evs)
	}
	if st.session != "" {
		t.Fatalf("不能把内部线程绑成这一格的会话: %q", st.session)
	}

	feedCodex(t, st, evs, "thread/started", map[string]any{
		"thread": map[string]any{
			"id": "th-main", "ephemeral": false,
			"status": map[string]any{"type": "idle"},
		},
	})
	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-title",
		"status":   map[string]any{"type": "active", "activeFlags": []string{}},
	})
	feedCodex(t, st, evs, "thread/status/changed", map[string]any{
		"threadId": "th-sub",
		"status":   map[string]any{"type": "active", "activeFlags": []string{}},
	})
	if ev := lastCodexEvent(t, evs); ev.Status != "idle" {
		t.Fatalf("内部线程把格子推成了别的状态: %+v", ev)
	}
	if st.session != "" {
		t.Fatalf("内部线程不能绑成这一格的会话: %q", st.session)
	}
}

// TestCodexBindsRolledThreadWhileIdle：resume --last 接回来的老会话可能一启动
// 就是 idle；盘上有 rollout 就说明它可续，必须绑上（否则重开就丢了）。
func TestCodexBindsRolledThreadWhileIdle(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	id := "01a15035-3fc0-7204-8817-23e1bf203ddc"
	day := filepath.Join(home, "sessions", "2026", "10", "19")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(day, "rollout-2026-10-19T02-24-50-"+id+".jsonl"),
		[]byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	st, evs := newCodexTestState()
	feedCodex(t, st, evs, "thread/started", map[string]any{
		"thread": map[string]any{
			"id": id, "ephemeral": false,
			"status": map[string]any{"type": "idle"},
		},
	})
	if st.session != id {
		t.Fatalf("盘上有 rollout 的空闲线程应当绑定，实际 %q", st.session)
	}
	if ev := lastCodexEvent(t, evs); ev.Session != id || ev.Status != "idle" {
		t.Fatalf("事件不对: %+v", ev)
	}
}

// TestCodexThreadReadResync：重连后 thread/read 的响应要把断线期间的状态补回来。
func TestCodexThreadReadResync(t *testing.T) {
	st, evs := newCodexTestState()
	st.session = "th-main"
	st.threads["th-main"] = codexThreadStatus{Type: "active"}
	st.name = ""

	st.handleThreadRead(json.RawMessage(`{"thread":{"id":"th-main","name":"Cold resume","status":{"type":"idle"}}}`), func(ev agentEvent) {
		*evs = append(*evs, ev)
	})
	ev := lastCodexEvent(t, evs)
	if ev.Status != "idle" || ev.Name != "Cold resume" || ev.Session != "th-main" {
		t.Fatalf("补齐事件不对: %+v", ev)
	}
}

// TestCodexSessionFileExists 守住冷恢复的判据。实测布局：
// <CODEX_HOME>/sessions/2026/10/19/rollout-2026-10-19T02-24-50-<uuid>.jsonl
func TestCodexSessionFileExists(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)

	id := "01a15035-3fc0-7204-8817-23e1bf203ddc"
	if codexSessionFileExists("", id) {
		t.Fatal("空目录不该报存在")
	}
	day := filepath.Join(home, "sessions", "2026", "10", "19")
	if err := os.MkdirAll(day, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(day, "rollout-2026-10-19T02-24-50-"+id+".jsonl")
	if err := os.WriteFile(file, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !codexSessionFileExists("", id) {
		t.Fatal("盘上有 rollout 文件，却报不存在")
	}
	if !SessionFileExistsFor("codex", "", id) {
		t.Fatal("SessionFileExistsFor 没有分派到 Codex 的判据")
	}
	if codexSessionFileExists("", "../01a15035") {
		t.Fatal("非法 id 不该报存在")
	}
}
