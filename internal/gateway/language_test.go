package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestMagpieLang(t *testing.T) {
	cases := map[string]string{
		"auto": "system",
		"":     "system",
		"en":   "en",
		"zh":   "zh",
		"EN":   "en",
		" zh ": "zh",
	}
	for in, want := range cases {
		if got := magpieLang(in); got != want {
			t.Errorf("magpieLang(%q) = %q, want %q", in, got, want)
		}
	}
}

// applyLanguage must round-trip magpie's whole settings object and change only
// lang: a partial {"lang":…} would reset the other fields to zero.
func TestApplyLanguageRewritesOnlyLang(t *testing.T) {
	var posted map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			io.WriteString(w, `{"lang":"system","theme":"dark","currency":"cny","proxy":"direct"}`)
		case http.MethodPost:
			if err := json.NewDecoder(r.Body).Decode(&posted); err != nil {
				t.Errorf("decode POST: %v", err)
			}
			io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	g := New(nil)
	g.port, g.client, g.key = port, srv.Client(), "test-key"
	g.SetLanguage("zh")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		g.langMu.Lock()
		applied := g.langApplied
		g.langMu.Unlock()
		if applied == "zh" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	g.langMu.Lock()
	applied := g.langApplied
	g.langMu.Unlock()
	if applied != "zh" {
		t.Fatalf("langApplied = %q, want zh", applied)
	}
	if posted == nil {
		t.Fatal("no POST /api/settings")
	}
	if posted["lang"] != "zh" {
		t.Fatalf("posted lang = %v", posted["lang"])
	}
	if posted["theme"] != "dark" || posted["currency"] != "cny" || posted["proxy"] != "direct" {
		t.Fatalf("other settings were not carried over: %#v", posted)
	}
}
