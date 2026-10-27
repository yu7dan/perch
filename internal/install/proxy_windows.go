//go:build windows

package install

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// systemProxyEnv 把 Windows「Internet 选项」里的代理翻译成子进程能读的环境变量。
//
// 为什么需要它：PowerShell 的 Invoke-WebRequest 会走系统代理，但官方安装脚本
// 里的原生子进程（例如 claude.exe install）不会。实测在只配置了系统代理的机器
// 上，PowerShell 能拿到 install.ps1，claude.exe 却直连 downloads.claude.ai 得到
// ECONNREFUSED。安装器必须把同一份代理交给整个进程树，否则用户会看到安装失败，
// 而网络明明是通的。
//
// 只填用户当前没有显式设置的变量；日志里只出现脱敏后的地址。
func systemProxyEnv(base []string) []string {
	proxy := proxyFromRegistry()
	if len(proxy) == 0 {
		return base
	}
	have := make(map[string]bool, len(base))
	for _, e := range base {
		if k, _, ok := strings.Cut(e, "="); ok {
			have[strings.ToUpper(strings.TrimSpace(k))] = true
		}
	}
	out := append([]string{}, base...)
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"} {
		if v := proxy[k]; v != "" && !have[k] {
			out = append(out, k+"="+v)
		}
	}
	return out
}

func proxyFromRegistry() map[string]string {
	k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer k.Close()

	enabled, _, err := k.GetIntegerValue("ProxyEnable")
	if err != nil || enabled == 0 {
		return nil
	}
	raw, _, err := k.GetStringValue("ProxyServer")
	if err != nil {
		return nil
	}
	httpProxy, httpsProxy := parseProxyServer(raw)
	if httpProxy == "" && httpsProxy == "" {
		return nil
	}
	// 回环地址永远直连：本机服务（OpenCode / Codex 的 app-server 端口）不能被代理带走。
	noProxy := "localhost,127.0.0.1,::1"
	if override, _, err := k.GetStringValue("ProxyOverride"); err == nil {
		if v := normalizeNoProxy(override); v != "" {
			noProxy = v + "," + noProxy
		}
	}
	return map[string]string{
		"HTTP_PROXY":  httpProxy,
		"HTTPS_PROXY": httpsProxy,
		"ALL_PROXY":   httpsProxy,
		"NO_PROXY":    noProxy,
	}
}

// parseProxyServer 接受 Windows 的两种写法：
//
//	127.0.0.1:7897
//	http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7898
func parseProxyServer(raw string) (httpProxy, httpsProxy string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ""
	}
	if !strings.Contains(raw, "=") {
		p := normalizeProxyURL(raw, "http")
		return p, p
	}
	for _, part := range strings.Split(raw, ";") {
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "http":
			httpProxy = normalizeProxyURL(v, "http")
		case "https":
			httpsProxy = normalizeProxyURL(v, "http")
		case "socks", "socks5":
			if httpProxy == "" {
				httpProxy = normalizeProxyURL(v, "socks5")
			}
			if httpsProxy == "" {
				httpsProxy = normalizeProxyURL(v, "socks5")
			}
		}
	}
	if httpProxy == "" {
		httpProxy = httpsProxy
	}
	if httpsProxy == "" {
		httpsProxy = httpProxy
	}
	return httpProxy, httpsProxy
}

func normalizeProxyURL(raw, scheme string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.Contains(raw, "://") {
		return raw
	}
	return scheme + "://" + raw
}

func normalizeNoProxy(raw string) string {
	fields := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == ',' })
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		f = strings.TrimSpace(f)
		if f == "" || f == "*" {
			continue
		}
		if strings.EqualFold(f, "<local>") {
			out = append(out, "localhost", "127.0.0.1", "::1")
			continue
		}
		out = append(out, f)
	}
	return strings.Join(uniqueStrings(out), ",")
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := in[:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// proxyLogLine 只给日志看的脱敏描述：去掉可能存在的 user:pass@。
func proxyLogLine() string {
	proxy := proxyFromRegistry()
	if len(proxy) == 0 {
		return ""
	}
	return "系统代理 " + sanitizeProxyURL(proxy["HTTPS_PROXY"])
}

func sanitizeProxyURL(raw string) string {
	if i := strings.Index(raw, "@"); i >= 0 {
		if j := strings.Index(raw, "://"); j >= 0 && j < i {
			return raw[:j+3] + "***@" + raw[i+1:]
		}
		return "***@" + raw[i+1:]
	}
	return raw
}
