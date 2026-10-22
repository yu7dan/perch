package gateway

// Usage readings for the Overview card. The engine already aggregates the
// local ledger; Perch only normalizes the wire shape so the frontend never
// reads engine tags such as cache_read / ttft_ms.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/uimsg"
)

// usagePeriods is the only query surface we expose to the frontend. The
// engine also accepts picked ranges; v1 does not, and a string from the page
// must never become an unchecked engine query.
var usagePeriods = map[string]bool{
	"today": true,
	"7d":    true,
	"30d":   true,
	"all":   true,
}

type UsageTotalsView struct {
	Calls      int     `json:"calls"`
	Errors     int     `json:"errors"`
	Retried    int     `json:"retried"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	Reasoning  int64   `json:"reasoning"`
	Cost       float64 `json:"cost"`
	Unpriced   int     `json:"unpriced"`
	Timed      int     `json:"timed"`
	TTFT       int64   `json:"ttftMs"`
}

type UsageAgentView struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Icon       string  `json:"icon,omitempty"`
	Calls      int     `json:"calls"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	Cost       float64 `json:"cost"`
}

type UsageModelView struct {
	ID        string  `json:"id"`
	Provider  string  `json:"provider,omitempty"`
	Model     string  `json:"model,omitempty"`
	Name      string  `json:"name"`
	Sub       string  `json:"sub,omitempty"`
	Icon      string  `json:"icon,omitempty"`
	Calls     int     `json:"calls"`
	Input     int64   `json:"input"`
	Output    int64   `json:"output"`
	CacheRead int64   `json:"cacheRead"`
	Cost      float64 `json:"cost"`
}

type UsageView struct {
	Period string           `json:"period"`
	Since  string           `json:"since,omitempty"`
	Totals UsageTotalsView  `json:"totals"`
	Agents []UsageAgentView `json:"agents"`
	Models []UsageModelView `json:"models"`
}

func usageView(u Usage, period string) UsageView {
	out := UsageView{
		Period: period,
		Since:  u.Since,
		Totals: UsageTotalsView{
			Calls: u.Calls, Errors: u.Errors, Retried: u.Retried,
			Input: u.Input, Output: u.Output,
			CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
			Reasoning: u.Reasoning, Cost: u.Cost, Unpriced: u.Unpriced,
			Timed: u.Timed, TTFT: u.TTFT,
		},
		Agents: make([]UsageAgentView, 0, len(u.Agents)),
		Models: make([]UsageModelView, 0, len(u.Models)),
	}
	for _, a := range u.Agents {
		out.Agents = append(out.Agents, UsageAgentView{
			ID: a.ID, Name: a.Name, Icon: a.Icon, Calls: a.Calls,
			Input: a.Input, Output: a.Output,
			CacheRead: a.CacheRead, CacheWrite: a.CacheWrite, Cost: a.Cost,
		})
	}
	for _, m := range u.Models {
		out.Models = append(out.Models, UsageModelView{
			ID: m.ID, Provider: m.Provider, Model: m.Model,
			Name: firstNonEmpty(m.Name, m.Model, m.ID), Sub: m.Sub, Icon: m.Icon,
			Calls: m.Calls, Input: m.Input, Output: m.Output,
			CacheRead: m.CacheRead, Cost: m.Cost,
		})
	}
	return out
}

func (g *Gateway) gatewayBase() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.gatewayURL
}

// getGatewayJSON reads the engine's gateway port. It is deliberately not the
// control-plane API: /v1/magpie/* is the stable read surface the agents use.
func getGatewayJSON(base, path string, v any) error {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return uimsg.New("gw.notRunning", "网关未运行")
	}
	c := &http.Client{
		Timeout:   12 * time.Second,
		Transport: &http.Transport{Proxy: nil},
	}
	res, err := c.Get(base + path)
	if err != nil {
		return uimsg.New("gw.requestFailed", "网关请求失败")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
		return uimsg.NewParams("gw.httpError", fmt.Sprintf("网关回答 HTTP %d", res.StatusCode),
			map[string]string{"status": fmt.Sprintf("%d", res.StatusCode)})
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 32<<20)).Decode(v); err != nil {
		return uimsg.New("gw.badUsage", "网关返回了无法读取的用量")
	}
	return nil
}

// Usage answers gw.usage for one period. It is only called from a ctl
// goroutine; the period whitelist is enforced here, not in the page.
func (g *Gateway) Usage(period string) {
	period = strings.TrimSpace(period)
	if period == "" {
		period = "today"
	}
	if !usagePeriods[period] {
		g.emit(uimsg.Fields(map[string]any{
			"type": "gw.usage", "period": period, "at": nowISO(),
		}, uimsg.New("gw.usageBadPeriod", "不支持的用量周期")))
		return
	}
	if err := g.Ensure(); err != nil {
		g.emit(uimsg.Fields(map[string]any{
			"type": "gw.usage", "period": period, "at": nowISO(),
		}, err))
		return
	}
	var u Usage
	if err := getGatewayJSON(g.gatewayBase(),
		"/v1/magpie/usage?period="+url.QueryEscape(period), &u); err != nil {
		g.emit(uimsg.Fields(map[string]any{
			"type": "gw.usage", "period": period, "at": nowISO(),
		}, err))
		return
	}
	g.emit(map[string]any{
		"type": "gw.usage", "period": period,
		"usage": usageView(u, period), "at": nowISO(),
	})
}
