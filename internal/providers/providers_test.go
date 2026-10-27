package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), FileName)
	return Load(p), p
}

// key 落盘是加密的，界面视图里只有末四位；改别的字段不会把 key 冲掉。
func TestProviderKeyIsSealedAndWriteOnly(t *testing.T) {
	s, path := newStore(t)
	id, err := s.SaveProvider(ProviderInput{Name: "零词元", Anthropic: "https://zzq.si/", OpenAI: "https://zzq.si/v1", Key: "sk-test-1234"})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "sk-test-1234") {
		t.Fatalf("key leaked to disk: %s", raw)
	}
	v := s.View()
	if len(v.Providers) != 1 || !v.Providers[0].HasKey || v.Providers[0].KeyHint != "…1234" || v.Providers[0].Anthropic != "https://zzq.si" {
		t.Fatalf("view = %+v", v.Providers)
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "sk-test") {
		t.Fatalf("key leaked to view: %s", b)
	}
	// 只改名字、key 留空 = 保留原来那把
	if _, err := s.SaveProvider(ProviderInput{ID: id, Name: "zzq", Anthropic: "https://zzq.si", OpenAI: "https://zzq.si/v1"}); err != nil {
		t.Fatal(err)
	}
	if _, k, err := s.ProviderSecret(id); err != nil || k != "sk-test-1234" {
		t.Fatalf("key after rename = %q, %v", k, err)
	}
	// 重新载入还解得开
	if _, k, err := Load(path).ProviderSecret(id); err != nil || k != "sk-test-1234" {
		t.Fatalf("key after reload = %q, %v", k, err)
	}
}

func TestSaveProviderValidates(t *testing.T) {
	s, _ := newStore(t)
	for _, in := range []ProviderInput{
		{Name: "", Anthropic: "https://a"},
		{Name: "x"},
		{Name: "x", OpenAI: "ftp://a"},
	} {
		if _, err := s.SaveProvider(in); err == nil {
			t.Errorf("expected error for %+v", in)
		}
	}
}

// 环境变量：值加密、按名删、Windows 下名字不分大小写去重；删提供商时 agent 回到自己的配置。
func TestAgentEnvAndProviderDelete(t *testing.T) {
	s, _ := newStore(t)
	id, _ := s.SaveProvider(ProviderInput{Name: "p", OpenAI: "https://x/v1", Key: "k"})
	if err := s.SetAgent("codex", AgentInput{Provider: id, Model: "gpt-x", Effort: "high",
		EnvSet: map[string]string{"Foo": "1", "BAR": "2"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgent("codex", AgentInput{Provider: id, Model: "gpt-x", Effort: "high",
		EnvSet: map[string]string{"FOO": "3"}, EnvRemove: []string{"bar"}}); err != nil {
		t.Fatal(err)
	}
	r, ok, err := s.Resolve("codex")
	if err != nil || !ok || r.Env["FOO"] != "3" || len(r.Env) != 1 || r.Key != "k" {
		t.Fatalf("resolve = %+v ok=%v err=%v", r, ok, err)
	}
	if err := s.SetAgent("codex", AgentInput{Effort: "turbo"}); err == nil {
		t.Fatal("bad effort accepted")
	}
	if err := s.SetAgent("codex", AgentInput{EnvSet: map[string]string{"1BAD": "x"}}); err == nil {
		t.Fatal("bad env name accepted")
	}
	if err := s.DeleteProvider(id); err != nil {
		t.Fatal(err)
	}
	if a := s.View().Agents["codex"]; a.Provider != "" || a.Model != "" || len(a.EnvNames) != 1 {
		t.Fatalf("after delete agent = %+v", a)
	}
}

func TestBuildPerAgent(t *testing.T) {
	both := &Provider{Name: "R", Anthropic: "https://r", OpenAI: "https://r/v1"}
	r := Resolved{Provider: both, Key: "sk-1", Model: "m1", Effort: "max", Env: map[string]string{"X": "y"}}

	cl, err := Build("claude", r, "")
	if err != nil {
		t.Fatal(err)
	}
	if cl.Env["ANTHROPIC_BASE_URL"] != "https://r" || cl.Env["ANTHROPIC_AUTH_TOKEN"] != "sk-1" ||
		cl.Env["ANTHROPIC_MODEL"] != "m1" || cl.Env["CLAUDE_CODE_EFFORT_LEVEL"] != "max" ||
		cl.Env["X"] != "y" || cl.Env["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("claude env = %v", cl.Env)
	}

	cx, err := Build("codex", r, "")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cx.Args, " ")
	for _, want := range []string{`model_provider="perch"`, `model_providers.perch.base_url="https://r/v1"`,
		`model_providers.perch.env_key="PERCH_PROVIDER_KEY"`, `model="m1"`, `model_reasoning_effort="xhigh"`} {
		if !strings.Contains(joined, want) {
			t.Errorf("codex args missing %s: %s", want, joined)
		}
	}
	if strings.Contains(joined, "sk-1") || cx.Env[KeyEnv] != "sk-1" {
		t.Fatalf("codex key must go via env only: args=%s env=%v", joined, cx.Env)
	}

	if _, err := Build("claude", Resolved{Provider: &Provider{Name: "o", OpenAI: "https://o/v1"}}, ""); err == nil {
		t.Fatal("claude accepted an OpenAI-only provider")
	}
	if _, err := Build("pi", Resolved{Provider: both}, t.TempDir()); err == nil {
		t.Fatal("pi accepted a provider without a model")
	}

	home := t.TempDir()
	pi, err := Build("pi", r, home)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(pi.Env["PI_CODING_AGENT_DIR"], "models.json"))
	if !strings.Contains(string(b), `"$PERCH_PROVIDER_KEY"`) || strings.Contains(string(b), "sk-1") {
		t.Fatalf("pi models.json = %s", b)
	}
	oc, err := Build("opencode", r, home)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(oc.Env["OPENCODE_CONFIG"])
	if !strings.Contains(string(b), "{env:PERCH_PROVIDER_KEY}") || strings.Contains(string(b), "sk-1") {
		t.Fatalf("opencode config = %s", b)
	}
}

func TestProbeListsModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer good" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"bad key"}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"b-model"},{"id":"a-model"}]}`))
	}))
	defer srv.Close()
	res, err := Probe(context.Background(), Provider{OpenAI: srv.URL + "/v1"}, "good")
	if err != nil || strings.Join(res.Models, ",") != "a-model,b-model" {
		t.Fatalf("probe = %+v, %v", res, err)
	}
	if _, err := Probe(context.Background(), Provider{OpenAI: srv.URL + "/v1"}, "bad"); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("bad key err = %v", err)
	}
}
