package relay

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 转发层的三件事：路由到这一格选的提供商、换 key、换模型名；换了提供商之后去 thinking 块。
func TestRelayRoutesRewritesAndSwitches(t *testing.T) {
	type seen struct {
		path, auth, model string
		blocks            int
	}
	var got []seen
	up := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			n := 0
			if msgs, ok := m["messages"].([]any); ok {
				for _, mm := range msgs {
					if c, ok := mm.(map[string]any)["content"].([]any); ok {
						n += len(c)
					}
				}
			}
			mod, _ := m["model"].(string)
			got = append(got, seen{name + r.URL.Path, r.Header.Get("Authorization"), mod, n})
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: ok\n\n")
		}))
	}
	a, b := up("A"), up("B")
	defer a.Close()
	defer b.Close()

	r, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	aBase, _ := r.Bind(7, Target{ProviderID: "a", Name: "A", Anthropic: a.URL, Key: "ka", Model: "m1"})
	body := `{"model":"claude-x","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"hi"}]}]}`
	post := func() string {
		resp, err := http.Post(aBase+"/v1/messages", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return string(out)
	}
	if out := post(); !strings.Contains(out, "data: ok") {
		t.Fatalf("流没转回来：%q", out)
	}
	if got[0].path != "A/v1/messages" || got[0].auth != "Bearer ka" || got[0].model != "m1" || got[0].blocks != 2 {
		t.Fatalf("第一次转发不对：%+v", got[0])
	}
	if !r.Switch(7, Target{ProviderID: "b", Name: "B", Anthropic: b.URL, Key: "kb", Model: "m2"}) {
		t.Fatal("换目标失败")
	}
	post()
	if got[1].path != "B/v1/messages" || got[1].auth != "Bearer kb" || got[1].model != "m2" || got[1].blocks != 1 {
		t.Fatalf("换提供商之后不对（应去掉 thinking 块）：%+v", got[1])
	}
	resp, err := http.Post(strings.Replace(aBase, "/p/", "/p/x", 1)+"/v1/messages", "application/json", strings.NewReader(body))
	if err == nil && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("错的令牌应该被拒，得到 %d", resp.StatusCode)
	}
}
