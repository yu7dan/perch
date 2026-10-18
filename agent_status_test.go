package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestCapsForAgent(t *testing.T) {
	claude := capsForAgent("claude")
	if !claude.Resume || !claude.Status || !claude.Waiting || !claude.Actions {
		t.Fatalf("claude 能力矩阵不对: %+v", claude)
	}
	oc := capsForAgent("opencode")
	if !oc.Launch || !oc.Status || !oc.Waiting {
		t.Fatalf("opencode 能力矩阵不对: %+v", oc)
	}
	if oc.Resume {
		t.Fatalf("opencode 还没做续接，不能标成 resume: %+v", oc)
	}
	// 通用启动不等于有状态。qwen 有 Bin，能开一格；但没接状态。
	qwen := capsForAgent("qwen")
	if !qwen.Launch || qwen.Status || qwen.Waiting {
		t.Fatalf("通用 agent 只能 launch: %+v", qwen)
	}
	// zcode 在 init 里被跳过（Bin 有但不能直接启动），不能假装能开。
	if zcode := capsForAgent("zcode"); zcode.Launch {
		t.Fatalf("zcode 没有启动适配器，不能标 launch: %+v", zcode)
	}
	pi := capsForAgent("pi")
	if !pi.Launch || !pi.Resume || !pi.Status || !pi.Waiting {
		t.Fatalf("pi 能力矩阵不对: %+v", pi)
	}
	if pi.Mechanism != "extension" {
		t.Fatalf("pi 的机制应当写明 extension（观察扩展）: %+v", pi)
	}
}

// TestPiObserverTail 走的是真实路径：observer.ts 往文件里追加，Go 侧 tail。
// 这里不模拟事件结构体，只按扩展现行输出写行 —— 协议变了这条测试会先红。
func TestPiObserverTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "t1.jsonl")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan agentEvent, 32)
	go observePi(ctx, 1, path, 10*time.Millisecond, func(ev agentEvent) {
		events <- ev
	})

	appendLine := func(v any) {
		t.Helper()
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(append(b, '\n')); err != nil {
			_ = f.Close()
			t.Fatal(err)
		}
		_ = f.Close()
	}

	next := func(want string) agentEvent {
		t.Helper()
		deadline := time.After(2 * time.Second)
		for {
			select {
			case ev := <-events:
				if ev.Status == want {
					return ev
				}
			case <-deadline:
				t.Fatalf("2s 内没等到 status=%s", want)
				return agentEvent{}
			}
		}
	}

	appendLine(piEvent{Type: "session_start", Session: "ses_pi", Reason: "startup"})
	appendLine(piEvent{Type: "status", Session: "ses_pi", Status: "busy"})
	busy := next("busy")
	if busy.Agent != "pi" || busy.Session != "ses_pi" {
		t.Fatalf("busy 事件不对: %+v", busy)
	}

	// 名字事件自己不带 status，只能跟进下一条状态；单独发会把 v.st 清空。
	appendLine(piEvent{Type: "name", Session: "ses_pi", Name: "Refactor auth"})
	appendLine(piEvent{Type: "status", Session: "ses_pi", Status: "waiting", Kind: "perm", Text: "Allow bash?"})
	wait := next("waiting")
	if wait.Name != "Refactor auth" || wait.Kind != "perm" || wait.Text != "Allow bash?" {
		t.Fatalf("waiting 事件不对: %+v", wait)
	}

	// 半行必须留到下一次：observer 的 appendFileSync 不是按行原子，
	// tail 不能把半截 JSON 当坏行丢掉。
	b, _ := json.Marshal(piEvent{Type: "status", Session: "ses_pi", Status: "idle"})
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.Write(b[:len(b)/2])
	_ = f.Close()
	select {
	case ev := <-events:
		t.Fatalf("半行不该产生事件，却收到 %+v", ev)
	case <-time.After(100 * time.Millisecond):
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.Write(append(b[len(b)/2:], '\n'))
	_ = f.Close()
	idle := next("idle")
	if idle.Session != "ses_pi" || idle.Name != "Refactor auth" {
		t.Fatalf("idle 事件不对: %+v", idle)
	}

	// 文件被截断（重开同一格）→ 偏移量必须归零，否则新事件永远读不到。
	f, _ = os.OpenFile(path, os.O_TRUNC|os.O_WRONLY, 0o644)
	_, _ = f.Write([]byte(`{"type":"status","session":"ses_pi","status":"busy"}` + "\n"))
	_ = f.Close()
	next("busy")
}

// TestPiRejectsUnknownStatus 守住协议边界：扩展写坏了不能把格子推成第三种状态。
func TestPiRejectsUnknownStatus(t *testing.T) {
	line := `{"type":"status","session":"","status":"thinking"}`
	handlePiLine(1, line, &piPaneState{}, func(ev agentEvent) {
		t.Fatalf("未知状态不该下发: %+v", ev)
	})
	handlePiLine(1, `not json`, &piPaneState{}, func(ev agentEvent) {
		t.Fatalf("坏行不该下发: %+v", ev)
	})
}

func TestOpenCodeObserver(t *testing.T) {
	type fakeState struct {
		mu        sync.Mutex
		status    string
		perms     []ocPermission
		questions []ocQuestion
	}
	st := &fakeState{status: "busy"}

	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	auth := func(w http.ResponseWriter, r *http.Request) bool {
		u, p, ok := r.BasicAuth()
		if !ok || u != "opencode" || p != "test-pass" {
			w.WriteHeader(http.StatusUnauthorized)
			return false
		}
		return true
	}
	mux.HandleFunc("/doc", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		writeJSON(w, map[string]any{"openapi": "3.1.0"})
	})
	mux.HandleFunc("/api/session/active", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		// 实测 TUI 一轮结束后 active 也会变空：这时观察者必须靠“上次绑定的
		// 会话”判空闲，而不是把格子的状态永远冻在 busy。
		st.mu.Lock()
		status := st.status
		st.mu.Unlock()
		if status == "" {
			writeJSON(w, map[string]any{"data": map[string]any{}})
			return
		}
		writeJSON(w, map[string]any{"data": map[string]any{"ses_test": map[string]any{"type": "running"}}})
	})
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		st.mu.Lock()
		status := st.status
		st.mu.Unlock()
		// 真实 1.19.3：空闲时整个条目被删掉，而不是 {type:"idle"}。
		if status == "" {
			writeJSON(w, map[string]any{})
			return
		}
		writeJSON(w, map[string]any{"ses_test": map[string]any{"type": status}})
	})
	mux.HandleFunc("/permission", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		st.mu.Lock()
		perms := append([]ocPermission(nil), st.perms...)
		st.mu.Unlock()
		writeJSON(w, perms)
	})
	mux.HandleFunc("/question", func(w http.ResponseWriter, r *http.Request) {
		if !auth(w, r) {
			return
		}
		st.mu.Lock()
		qs := append([]ocQuestion(nil), st.questions...)
		st.mu.Unlock()
		writeJSON(w, qs)
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan agentEvent, 16)
	go observeOpenCode(ctx, 1, srv.URL, "test-pass", 10*time.Millisecond, func(ev agentEvent) {
		events <- ev
	})

	next := func(want string) agentEvent {
		t.Helper()
		deadline := time.After(2 * time.Second)
		for {
			select {
			case ev := <-events:
				if ev.Status == want {
					return ev
				}
			case <-deadline:
				t.Fatalf("2s 内没等到 status=%s", want)
				return agentEvent{}
			}
		}
	}

	busy := next("busy")
	if busy.Session != "ses_test" || busy.Agent != "opencode" {
		t.Fatalf("busy 事件不对: %+v", busy)
	}

	st.mu.Lock()
	st.perms = []ocPermission{{
		ID: "per_1", SessionID: "ses_test", Permission: "bash",
		Patterns: []string{"echo hi"},
	}}
	st.mu.Unlock()

	wait := next("waiting")
	if wait.Kind != "perm" || !strings.Contains(wait.Text, "bash") || !strings.Contains(wait.Text, "echo hi") {
		t.Fatalf("权限等待事件不对: %+v", wait)
	}

	st.mu.Lock()
	st.perms = nil
	st.status = "" // 条目消失 = 空闲
	st.mu.Unlock()

	idle := next("idle")
	if idle.Session != "ses_test" {
		t.Fatalf("idle 事件不对: %+v", idle)
	}

	// 没有 auth 的请求必须被 server 拒掉；观察者用的是 Basic，不是无鉴权。
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/session/status", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无鉴权请求应 401，实际 %d", resp.StatusCode)
	}
}
