package gateway

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeEngine is just enough of magpie's /api/providers surface to prove what
// Perch puts on the wire when saving a provider. It never sees a real key from
// a user; the payloads here are test strings.
type fakeEngine struct {
	mu       sync.Mutex
	presets  []map[string]any
	rows     []map[string]any
	lastSave map[string]any
	failCode int
	failBody string
}

func (f *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == "GET" && r.URL.Path == "/api/providers":
		f.mu.Lock()
		defer f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"providers": f.rows,
			"presets":   f.presets,
		})
	case r.Method == "POST" && r.URL.Path == "/api/provider/save":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.lastSave = body
		if f.failCode != 0 {
			w.WriteHeader(f.failCode)
			_, _ = w.Write([]byte(f.failBody))
			return
		}
		id, _ := body["id"].(string)
		name, _ := body["name"].(string)
		preset, _ := body["preset"].(string)
		row := map[string]any{
			"id": id, "name": name, "preset": preset,
			"key":    map[string]any{"set": true, "masked": "sk-…test", "optional": false},
			"models": []any{},
		}
		for _, k := range []string{"chat", "responses", "anthropic", "gemini"} {
			if v, ok := body[k].(string); ok && v != "" {
				row[k] = v
			}
		}
		f.rows = append(f.rows, row)
		_, _ = w.Write([]byte(`{"ok":true}`))
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeEngine) saved() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastSave
}

func newFakeGateway(t *testing.T) (*Gateway, *fakeEngine, *httptest.Server) {
	t.Helper()
	f := &fakeEngine{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	g := New(nil)
	g.port = srv.Listener.Addr().(*net.TCPAddr).Port
	g.key = "test-key"
	g.client = srv.Client()
	return g, f, srv
}

func TestSavePresetPayloadUsesPresetEndpoints(t *testing.T) {
	g, f, _ := newFakeGateway(t)
	f.presets = []map[string]any{{
		"id": "azure", "name": "Azure OpenAI", "kind": "vendor",
		"endpoint": "resource", "chat": "https://{resource}.openai.azure.com/openai/v1",
	}}
	var pushes []any
	g.push = func(v any) { pushes = append(pushes, v) }

	g.SaveProvider(ProviderInput{
		Name: "My Azure", Preset: "azure", Key: "sk-test",
		Endpoints: map[string]string{"chat": "https://res.openai.azure.com/openai/v1"},
	})
	saved := f.saved()
	if saved == nil {
		t.Fatal("no save request reached the engine")
	}
	if saved["id"] != "azure" || saved["name"] != "My Azure" || saved["preset"] != "azure" || saved["new"] != true {
		t.Fatalf("identity payload = %#v", saved)
	}
	if saved["key"] != "sk-test" {
		t.Fatalf("key not sent: %#v", saved)
	}
	if saved["chat"] != "https://res.openai.azure.com/openai/v1" {
		t.Fatalf("endpoint not sent: %#v", saved)
	}
	if _, ok := saved["baseAPI"]; ok {
		t.Fatalf("preset save must not set baseAPI: %#v", saved)
	}
	if !hasPush(pushes, "gw.provider.saved") {
		t.Fatalf("saved push missing: %#v", pushes)
	}
}

func TestSaveCustomPayloadUsesProtocolEndpoint(t *testing.T) {
	g, f, _ := newFakeGateway(t)
	g.SaveProvider(ProviderInput{
		Name: "My Relay", Protocol: "responses", BaseURL: "https://relay.example/v1",
		Key: "sk-relay", Models: []string{"m1", "m2"},
	})
	saved := f.saved()
	if saved == nil {
		t.Fatal("no save request reached the engine")
	}
	if saved["id"] != "my-relay" || saved["baseAPI"] != "responses" || saved["new"] != true {
		t.Fatalf("custom payload = %#v", saved)
	}
	if saved["responses"] != "https://relay.example/v1" {
		t.Fatalf("responses endpoint not sent: %#v", saved)
	}
	if _, ok := saved["chat"]; ok {
		t.Fatalf("responses save must not set chat: %#v", saved)
	}
	models, _ := saved["models"].([]any)
	if len(models) != 2 || models[0] != "m1" || models[1] != "m2" {
		t.Fatalf("models = %#v", saved["models"])
	}
}

func TestSaveFailureDoesNotEchoUpstreamText(t *testing.T) {
	g, f, _ := newFakeGateway(t)
	f.presets = []map[string]any{{"id": "kimi", "name": "Kimi", "kind": "vendor", "chat": "https://api.moonshot.cn/v1"}}
	f.failCode = http.StatusInternalServerError
	f.failBody = `{"error":"Incorrect API key provided: sk-secret-123"}`
	var pushes []any
	g.push = func(v any) { pushes = append(pushes, v) }

	g.SaveProvider(ProviderInput{Name: "Kimi", Preset: "kimi", Key: "sk-secret-123"})
	raw, _ := json.Marshal(pushes)
	if strings.Contains(string(raw), "sk-secret-123") {
		t.Fatalf("upstream key leaked into a push: %s", raw)
	}
	found := false
	for _, p := range pushes {
		m, _ := p.(map[string]any)
		if m["type"] == "gw.provider.error" {
			found = true
			if m["errCode"] != "gw.providerSaveFailed" {
				t.Fatalf("error code = %v, want gw.providerSaveFailed", m["errCode"])
			}
		}
	}
	if !found {
		t.Fatalf("no provider error push: %#v", pushes)
	}
}

func hasPush(pushes []any, typ string) bool {
	for _, p := range pushes {
		if m, ok := p.(map[string]any); ok && m["type"] == typ {
			return true
		}
	}
	return false
}
