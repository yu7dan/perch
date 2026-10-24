//go:build windows

package install

import "testing"

func TestParseProxyServer(t *testing.T) {
	cases := []struct {
		in    string
		http  string
		https string
	}{
		{"127.0.0.1:7897", "http://127.0.0.1:7897", "http://127.0.0.1:7897"},
		{"http://127.0.0.1:7897", "http://127.0.0.1:7897", "http://127.0.0.1:7897"},
		{"http=127.0.0.1:8080;https=127.0.0.1:8443",
			"http://127.0.0.1:8080", "http://127.0.0.1:8443"},
		{"socks=127.0.0.1:1080",
			"socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"},
		{"http=127.0.0.1:8080", "http://127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"", "", ""},
	}
	for _, c := range cases {
		httpProxy, httpsProxy := parseProxyServer(c.in)
		if httpProxy != c.http || httpsProxy != c.https {
			t.Errorf("parseProxyServer(%q) = (%q, %q), want (%q, %q)",
				c.in, httpProxy, httpsProxy, c.http, c.https)
		}
	}
}

func TestNormalizeNoProxy(t *testing.T) {
	got := normalizeNoProxy("localhost;127.*;10.*;<local>;")
	want := "localhost,127.*,10.*,127.0.0.1,::1"
	if got != want {
		t.Fatalf("normalizeNoProxy = %q, want %q", got, want)
	}
}

func TestSanitizeProxyURL(t *testing.T) {
	cases := map[string]string{
		"http://127.0.0.1:7897":           "http://127.0.0.1:7897",
		"http://user:pass@127.0.0.1:7897": "http://***@127.0.0.1:7897",
	}
	for in, want := range cases {
		if got := sanitizeProxyURL(in); got != want {
			t.Errorf("sanitizeProxyURL(%q) = %q, want %q", in, got, want)
		}
	}
}
