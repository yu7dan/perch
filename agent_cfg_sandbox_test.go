package main

// 沙盒验收（P0.1，2026-10-18）：不碰用户的 Claude Code，只在一个隔离的
// USERPROFILE/APPDATA 里起一个 magpie 控制面，并且**只放 codex 的配置**，
// 然后走 Perch 真实的 gwAgent* 函数跑完一整圈：
//
//	读状态 → 接入 → 改字段 → 重新应用 → 断开预览 → 断开还原
//
// 默认跳过。由 _tools\magpie-sandbox-test.ps1 带上 PERCH_SANDBOX_* 才跑；
// 脚本负责建沙盒、起控制面、在写之前用只读 /api/state 证明沙盒里只有
// codex（出现 claude 就中止），结束后核对并清场。
//
// 为什么只测 codex：用户的 Claude Code 正在运行，任何写操作都可能换掉它
// 的网关/模型。codex 是用户明确同意用来测试的。

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func sandboxVal(t *testing.T, name string) string {
	t.Helper()
	v := os.Getenv(name)
	if v == "" {
		t.Skipf("%s 未设置：这是沙盒测试，跳过", name)
	}
	return v
}

func sandboxAgents(t *testing.T) []map[string]any {
	t.Helper()
	b, err := gwAPI("GET", "/api/state", nil)
	if err != nil {
		t.Fatalf("读 /api/state：%v", err)
	}
	var st struct {
		Agents []map[string]any `json:"agents"`
	}
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatalf("解析 /api/state：%v", err)
	}
	return st.Agents
}

func sandboxState(t *testing.T) map[string]any {
	t.Helper()
	agents := sandboxAgents(t)
	for _, a := range agents {
		if a["id"] == "claude" {
			t.Fatalf("沙盒里看到了 claude：隔离失败，拒绝继续")
		}
	}
	for _, a := range agents {
		if a["id"] == "codex" {
			return a
		}
	}
	t.Fatalf("沙盒里的 /api/state 没有 codex（agents: %v）", agents)
	return nil
}

func fieldValue(a map[string]any, key string) string {
	fields, _ := a["fields"].([]any)
	for _, f := range fields {
		m, _ := f.(map[string]any)
		if m["key"] == key {
			s, _ := m["value"].(string)
			return s
		}
	}
	return ""
}

func TestAgentSandboxCycle(t *testing.T) {
	home := sandboxVal(t, "PERCH_SANDBOX_HOME")
	portS := sandboxVal(t, "PERCH_SANDBOX_PORT")
	key := sandboxVal(t, "PERCH_SANDBOX_KEY")
	port, err := strconv.Atoi(portS)
	if err != nil {
		t.Fatalf("端口 %q：%v", portS, err)
	}
	if !gwPing(port, key) {
		t.Fatalf("沙盒控制面 127.0.0.1:%d 没起来（先跑 _tools\\magpie-sandbox-test.ps1）", port)
	}
	// 直接指向沙盒：client 非空且 ping 通，gwEnsure 就不会去拉起任何进程。
	gwConn = gwServer{port: port, key: key, client: gwClient()}

	cfg := filepath.Join(home, ".codex", "config.toml")
	orig, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("读沙盒 config.toml：%v", err)
	}

	// 1) 读状态：没有 claude（隔离成功的证据），codex 在，未接入。
	//    pi 可能因为装在机器 PATH 上被列出来，不写它就没事。
	ag := sandboxState(t)
	if ag["wired"] == true {
		t.Fatalf("沙盒一开始就是已接入：%v", ag)
	}
	fields, _ := ag["fields"].([]any)
	if len(fields) == 0 {
		t.Fatalf("codex 一个字段都没有：%v", ag)
	}

	// 2) 接入。
	gwAgentAction("connect", "codex")
	if st := sandboxState(t); st["wired"] != true {
		_, e := gwAPI("POST", "/api/agents/connect/codex", map[string]any{})
		t.Fatalf("接入后 wired 不是 true：%v（原接口错误：%v）", st, e)
	}
	connected, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("接入后读 config.toml：%v", err)
	}
	if bytes.Equal(connected, orig) {
		t.Fatalf("接入后 config.toml 没变：\n%s", connected)
	}
	if !bytes.Contains(connected, []byte("base_url")) {
		t.Fatalf("接入后 config.toml 没有 base_url：\n%s", connected)
	}

	// 3) 改一个字段（走 Perch 的 gwAgentSet）。
	gwAgentSet("codex", "effort", "high")
	ag = sandboxState(t)
	if got := fieldValue(ag, "effort"); got != "high" {
		t.Fatalf("改 effort 后 state 里是 %q，期望 high", got)
	}

	// 4) 重新应用（漂移修复同一套 URL/动作）。
	gwAgentAction("reapply", "codex")
	if st := sandboxState(t); st["wired"] != true {
		t.Fatalf("重新应用后 wired 不是 true：%v", st)
	}

	// 5) 断开预览：必须是合法 JSON，且不动文件。
	beforePreview, _ := os.ReadFile(cfg)
	gwAgentPreview("codex")
	pb, err := gwAPI("GET", "/api/agents/preview/codex", nil)
	if err != nil {
		t.Fatalf("断开预览：%v", err)
	}
	if !json.Valid(pb) {
		t.Fatalf("预览不是 JSON：%s", pb)
	}
	afterPreview, _ := os.ReadFile(cfg)
	if !bytes.Equal(beforePreview, afterPreview) {
		t.Fatal("预览改了 config.toml")
	}

	// 6) 断开，并还原到接入前。
	gwAgentAction("disconnect", "codex")
	if st := sandboxState(t); st["wired"] == true {
		t.Fatalf("断开后 wired 还是 true：%v", st)
	}
	left, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("断开后读 config.toml：%v", err)
	}
	// magpie 的 Codex 断开**故意保留** [model_providers.magpie] 表（旧线程
	// 还要靠它才能打开，见 codex.go:53-59）。所以验的是"顶层重新指向用户
	// 原来的 provider/model"，不是字节级还原。
	if got := tomlTop(left, "model_provider"); got != "openai" {
		t.Fatalf("断开后 model_provider 是 %q，期望 openai：\n%s", got, left)
	}
	if got := tomlTop(left, "model"); got != "gpt-5.5" {
		t.Fatalf("断开后 model 是 %q，期望 gpt-5.5：\n%s", got, left)
	}
	if got := tomlTop(left, "openai_base_url"); got != "" {
		t.Fatalf("断开后还留着顶层 openai_base_url=%q：\n%s", got, left)
	}
}

// tomlTop 读顶层（第一个 [table] 之前）的 key = "value"，够验这几项。
func tomlTop(b []byte, key string) string {
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		if strings.HasPrefix(line, key+" =") {
			v := strings.TrimSpace(strings.TrimPrefix(line, key+" ="))
			return strings.Trim(v, `"`)
		}
	}
	return ""
}
