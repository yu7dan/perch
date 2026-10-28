package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 每条写在用法里的命令都得真的走到 Bus 上。场景测试是直接打 HTTP 的，
// 命令行少接一个子命令它们看不出来（实测：review 漏了，Manager 跑了一次「不认识的命令」
// 就只在对话里说"已验收"，任务一直挂着）。
func TestEveryCommandReachesTheBus(t *testing.T) {
	var gotOp string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOp = strings.TrimPrefix(r.URL.Path, "/v1/")
		gotBody = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		if r.Header.Get("X-Perch-Token") != "tok" {
			t.Errorf("%s: token header missing", gotOp)
		}
		_ = json.NewEncoder(w).Encode(reply{Code: "ok:test", Msg: "fine"})
	}))
	defer srv.Close()
	env := func(k string) string {
		return map[string]string{"PERCH_BG_URL": srv.URL, "PERCH_BG_TOKEN": "tok"}[k]
	}
	cases := []struct {
		args []string
		op   string
		want map[string]string
	}{
		{[]string{"ping"}, "ping", nil},
		{[]string{"team"}, "team", nil},
		{[]string{"tasks"}, "tasks", nil},
		{[]string{"handoff", "--to", "开发", "--task", "do it", "--accept", "tests pass"}, "handoff", map[string]string{"to": "开发", "task": "do it", "accept": "tests pass"}},
		{[]string{"done", "--summary", "done it"}, "done", map[string]string{"summary": "done it"}},
		{[]string{"review", "--task", "T1", "--pass", "yes"}, "review", map[string]string{"task": "T1", "pass": "yes"}},
		{[]string{"review", "--task", "T1", "--reject", "missing test"}, "review", map[string]string{"task": "T1", "reject": "missing test"}},
		{[]string{"memory", "add", "we use pytest"}, "memory.add", map[string]string{"text": "we use pytest"}},
		{[]string{"memory", "show"}, "memory.show", nil},
	}
	for _, c := range cases {
		gotOp = ""
		var out, errOut bytes.Buffer
		code := run(c.args, &out, &errOut, strings.NewReader(""), env)
		if code != 0 || gotOp != c.op {
			t.Fatalf("%v: exit %d op %q (want %q) stderr=%s", c.args, code, gotOp, c.op, errOut.String())
		}
		for k, v := range c.want {
			if gotBody[k] != v {
				t.Errorf("%v: body[%s]=%v want %q", c.args, k, gotBody[k], v)
			}
		}
		if gotBody["rid"] == "" || gotBody["rid"] == nil {
			t.Errorf("%v: no request id", c.args)
		}
	}
	// 拒绝 + 通过同时给：按拒绝算，不能把 pass 也带过去
	run([]string{"review", "--task", "T1", "--pass", "yes", "--reject", "no"}, &bytes.Buffer{}, &bytes.Buffer{}, strings.NewReader(""), env)
	if _, ok := gotBody["pass"]; ok {
		t.Errorf("reject must drop pass: %v", gotBody)
	}
}

func TestUsageErrorsAndHelp(t *testing.T) {
	env := func(string) string { return "" }
	for _, args := range [][]string{{"review", "--task", "T1"}, {"handoff", "--to", "x"}, {"memory", "add"}, {"bogus"}} {
		if code := run(args, &bytes.Buffer{}, &bytes.Buffer{}, strings.NewReader(""), env); code != 1 {
			t.Errorf("%v: exit %d, want 1 (usage)", args, code)
		}
	}
	for _, args := range [][]string{{"--help"}, {"review", "--help"}, {"handoff", "-h"}} {
		var out bytes.Buffer
		if code := run(args, &out, &bytes.Buffer{}, strings.NewReader(""), env); code != 0 || !strings.Contains(out.String(), "perch-bg review") {
			t.Errorf("%v: exit %d, usage shown=%v", args, code, strings.Contains(out.String(), "perch-bg review"))
		}
	}
}
