// Package relay 是本机转发层：格子里的 agent 连它，它把请求原样转给「这一格现在选的」
// 提供商，只换地址、key 和模型名。用处只有一个 —— **格子随时换模型，不用重启 agent**
// （台面 0.1.1 格头上那颗模型按钮）。
//
// 只有选了提供商的格子走这里：agent 自己的登录（Claude 订阅、Codex 登录……）不经过
// Perch，原样直连。可行性在 tools/relayspike 里验过（Claude 走本地转发含流式正常；
// 同一段对话中途换提供商能接着聊，前提是去掉历史里的 thinking 块 —— 那是上一家的签名）。
//
// 安全：只听 127.0.0.1；每一格一个随机令牌放在路径里，别的本机进程拿不到真 key。
package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Target 是一格现在要转去的地方。
type Target struct {
	ProviderID string
	Name       string
	Anthropic  string // Anthropic 接口的根地址（不带 /v1）
	OpenAI     string // OpenAI 兼容接口的根地址（通常以 /v1 结尾）
	Key        string
	Model      string // 空 = 不改请求里的模型名
}

type route struct {
	pane  int
	t     Target
	strip bool // 换过提供商：历史里的 thinking 块是上一家签的，发出去会被拒
}

// Relay 是转发层本身。零值不可用；用 Start 构造。
type Relay struct {
	addr   string
	mu     sync.Mutex
	byTok  map[string]*route
	byPane map[int]string
	direct *http.Client
	proxy  *http.Client
}

// Start 在 127.0.0.1 的随机端口上起转发层。
func Start() (*Relay, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	r := &Relay{
		addr:   ln.Addr().String(),
		byTok:  map[string]*route{},
		byPane: map[int]string{},
		direct: &http.Client{Transport: &http.Transport{Proxy: nil}},
		proxy:  &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}},
	}
	go func() {
		srv := &http.Server{Handler: r, ReadHeaderTimeout: 30 * time.Second}
		if err := srv.Serve(ln); err != nil {
			log.Printf("[relay] 停了：%v", err)
		}
	}()
	log.Printf("[relay] 本机转发层在 %s", r.addr)
	return r, nil
}

// Bind 给一格登记一个转发目标，返回这一格专用的两个根地址（Anthropic / OpenAI 形状）。
// 同一格再 Bind 一次（重开 / 接回）沿用原来的令牌。
func (r *Relay) Bind(pane int, t Target) (anthropicBase, openAIBase string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tok, ok := r.byPane[pane]
	if !ok || pane == 0 {
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		tok = hex.EncodeToString(b)
		if pane != 0 {
			r.byPane[pane] = tok
		}
	}
	r.byTok[tok] = &route{pane: pane, t: t}
	base := "http://" + r.addr + "/p/" + tok
	return base + "/a", base + "/o"
}

// Routed 报告这一格是不是走转发层（选了提供商的格子才是）。
func (r *Relay) Routed(pane int) (Target, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	tok, ok := r.byPane[pane]
	if !ok {
		return Target{}, false
	}
	rt := r.byTok[tok]
	if rt == nil {
		return Target{}, false
	}
	return rt.t, true
}

// Switch 改一格的目标：下一个请求起生效，agent 进程不动。换了提供商就开始去 thinking 块。
func (r *Relay) Switch(pane int, t Target) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	tok, ok := r.byPane[pane]
	if !ok {
		return false
	}
	rt := r.byTok[tok]
	if rt == nil {
		return false
	}
	if rt.t.ProviderID != t.ProviderID {
		rt.strip = true
	}
	rt.t = t
	log.Printf("[relay] pane=%d 换到 %s / %s（下一个请求起）", pane, t.Name, pick(t.Model, "(原模型)"))
	return true
}

// Forget 摘掉一格（结束这个 agent 时）。
func (r *Relay) Forget(pane int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if tok, ok := r.byPane[pane]; ok {
		delete(r.byTok, tok)
		delete(r.byPane, pane)
	}
}

func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// /p/<令牌>/<a|o>/<其余>
	parts := strings.SplitN(strings.TrimPrefix(req.URL.Path, "/p/"), "/", 3)
	if len(parts) < 2 || !strings.HasPrefix(req.URL.Path, "/p/") {
		http.NotFound(w, req)
		return
	}
	r.mu.Lock()
	rt := r.byTok[parts[0]]
	var t Target
	var strip bool
	if rt != nil {
		t, strip = rt.t, rt.strip
	}
	r.mu.Unlock()
	if rt == nil {
		http.Error(w, "unknown pane", http.StatusForbidden)
		return
	}
	rest := ""
	if len(parts) == 3 {
		rest = parts[2]
	}
	var base string
	anthropic := parts[1] == "a"
	if anthropic {
		base = t.Anthropic
	} else {
		base = t.OpenAI
	}
	if base == "" {
		http.Error(w, fmt.Sprintf("提供商「%s」没有这种接口", t.Name), http.StatusBadGateway)
		return
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	from, to := "", ""
	if len(body) > 0 && strings.Contains(req.Header.Get("Content-Type"), "json") {
		body, from, to = rewrite(body, t.Model, strip && anthropic)
	}
	up := strings.TrimRight(base, "/") + "/" + rest
	if req.URL.RawQuery != "" {
		up += "?" + req.URL.RawQuery
	}
	resp, err := r.do(req.Context(), req, up, body, t.Key, anthropic)
	if err != nil {
		log.Printf("[relay] pane=%d %s %s → %s 失败：%v", rt.pane, req.Method, rest, t.Name, err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 16*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		}
		if rerr != nil {
			break
		}
	}
	if resp.StatusCode >= 400 {
		log.Printf("[relay] pane=%d %s %s → %s [%s→%s] %d", rt.pane, req.Method, rest, t.Name, from, to, resp.StatusCode)
	}
}

// do 先直连；网络层就失败（还没拿到任何响应）再按系统代理试一次 ——
// 有的中转站走本机代理反而握手失败，有的又非走代理不可（和 providers.Probe 同一条规矩）。
func (r *Relay) do(ctx context.Context, in *http.Request, up string, body []byte, key string, anthropic bool) (*http.Response, error) {
	build := func() (*http.Request, error) {
		out, err := http.NewRequestWithContext(ctx, in.Method, up, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		for k, vs := range in.Header {
			switch strings.ToLower(k) {
			case "host", "authorization", "x-api-key", "content-length", "accept-encoding":
				continue
			}
			for _, v := range vs {
				out.Header.Add(k, v)
			}
		}
		out.Header.Set("Authorization", "Bearer "+key)
		if anthropic {
			out.Header.Set("x-api-key", key)
		}
		return out, nil
	}
	req, err := build()
	if err != nil {
		return nil, err
	}
	resp, err := r.direct.Do(req)
	if err == nil {
		return resp, nil
	}
	var ne net.Error
	if ctx.Err() != nil || !(errors.As(err, &ne) || strings.Contains(err.Error(), "connect")) {
		return nil, err
	}
	req2, err2 := build()
	if err2 != nil {
		return nil, err
	}
	if resp2, err3 := r.proxy.Do(req2); err3 == nil {
		return resp2, nil
	}
	return nil, err
}

// rewrite 把请求里的模型名换成这一格选的；strip 时去掉 assistant 历史里的 thinking 块。
func rewrite(body []byte, model string, strip bool) ([]byte, string, string) {
	if model == "" && !strip {
		return body, "", ""
	}
	var m map[string]any
	if json.Unmarshal(body, &m) != nil {
		return body, "", ""
	}
	from, _ := m["model"].(string)
	if model != "" && from != "" {
		m["model"] = model
	}
	if strip {
		if msgs, ok := m["messages"].([]any); ok {
			for _, mm := range msgs {
				msg, _ := mm.(map[string]any)
				if msg == nil || msg["role"] != "assistant" {
					continue
				}
				blocks, ok := msg["content"].([]any)
				if !ok {
					continue
				}
				kept := blocks[:0]
				for _, b := range blocks {
					bb, _ := b.(map[string]any)
					if bb != nil && (bb["type"] == "thinking" || bb["type"] == "redacted_thinking") {
						continue
					}
					kept = append(kept, b)
				}
				msg["content"] = kept
			}
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return body, from, model
	}
	return out, from, model
}

func pick(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}
