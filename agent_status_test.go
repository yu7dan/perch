package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
