package providers

// 「测试连接」：拿 key 去问一次模型列表。能列出来 = 地址和 key 都对；顺手把模型
// id 记下来，给 Agents 那一栏的模型选择当候选。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// ProbeResult 是一次测试的结果。Via 说明最后是直连还是走了系统代理。
type ProbeResult struct {
	Models []string `json:"models"`
	Via    string   `json:"via"`
	URL    string   `json:"url"`
}

// Probe 优先问 OpenAI 兼容接口的 /models，没有就问 Anthropic 的 /v1/models。
// 先直连；网络层失败（不是 HTTP 错误）再按系统代理重试一次 —— 有的中转站走本机
// 代理反而握手失败（零词元就是，见 zerotoken-relay 那条记录），有的又非走代理不可。
func Probe(ctx context.Context, p Provider, key string) (ProbeResult, error) {
	var target string
	header := http.Header{}
	switch {
	case p.OpenAI != "":
		target = p.OpenAI + "/models"
		header.Set("Authorization", "Bearer "+key)
	case p.Anthropic != "":
		target = p.Anthropic + "/v1/models"
		header.Set("x-api-key", key)
		header.Set("Authorization", "Bearer "+key) // 不少中转站只认这个
		header.Set("anthropic-version", "2023-06-01")
	default:
		return ProbeResult{}, fmt.Errorf("没有可测的接口地址")
	}
	if key == "" {
		return ProbeResult{}, fmt.Errorf("还没有填 key")
	}
	res, err := probeOnce(ctx, target, header, nil)
	via := "direct"
	var netErr *probeNetErr
	if errors.As(err, &netErr) {
		if res2, err2 := probeOnce(ctx, target, header, http.ProxyFromEnvironment); err2 == nil {
			res, err, via = res2, nil, "proxy"
		}
	}
	if err != nil {
		return ProbeResult{URL: target}, err
	}
	res.Via, res.URL = via, target
	return res, nil
}

type probeNetErr struct{ err error }

func (e *probeNetErr) Error() string { return "连不上：" + e.err.Error() }
func (e *probeNetErr) Unwrap() error { return e.err }

func probeOnce(ctx context.Context, target string, h http.Header, proxy func(*http.Request) (*url.URL, error)) (ProbeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return ProbeResult{}, err
	}
	req.Header = h.Clone()
	tr := &http.Transport{Proxy: proxy, TLSHandshakeTimeout: 8 * time.Second}
	defer tr.CloseIdleConnections()
	resp, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return ProbeResult{}, &probeNetErr{err}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(body))
		if len(msg) > 200 {
			msg = msg[:200] + "…"
		}
		switch resp.StatusCode {
		case 401, 403:
			return ProbeResult{}, fmt.Errorf("key 被拒绝（HTTP %d）：%s", resp.StatusCode, msg)
		case 404:
			return ProbeResult{}, fmt.Errorf("地址不对（HTTP 404，%s 不存在）", target)
		}
		return ProbeResult{}, fmt.Errorf("HTTP %d：%s", resp.StatusCode, msg)
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return ProbeResult{}, fmt.Errorf("返回的不是模型列表：%w", err)
	}
	ids := make([]string, 0, len(list.Data))
	for _, m := range list.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	sort.Strings(ids)
	return ProbeResult{Models: ids}, nil
}
