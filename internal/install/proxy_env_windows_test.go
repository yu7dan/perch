//go:build windows

package install

import (
	"strings"
	"testing"
)

func TestSystemProxyEnvAddsRegistryProxy(t *testing.T) {
	proxy := proxyFromRegistry()
	if len(proxy) == 0 {
		t.Skip("no system proxy configured")
	}
	env := systemProxyEnv([]string{"PATH=C:\\Windows"})
	joined := strings.Join(env, "\n")
	for _, key := range []string{"HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY="} {
		if !strings.Contains(joined, key) {
			t.Errorf("systemProxyEnv missing %s in %v", key, env)
		}
	}
	if !strings.Contains(joined, "127.0.0.1") && !strings.Contains(joined, "localhost") {
		t.Errorf("NO_PROXY should include loopback: %v", env)
	}
}

func TestSystemProxyEnvKeepsUserValues(t *testing.T) {
	if len(proxyFromRegistry()) == 0 {
		t.Skip("no system proxy configured")
	}
	env := systemProxyEnv([]string{"HTTPS_PROXY=http://user-proxy:1"})
	found := false
	for _, e := range env {
		if strings.HasPrefix(e, "HTTPS_PROXY=") {
			found = true
			if !strings.Contains(e, "user-proxy") {
				t.Fatalf("user HTTPS_PROXY was overwritten: %v", env)
			}
		}
	}
	if !found {
		t.Fatalf("HTTPS_PROXY disappeared: %v", env)
	}
}
