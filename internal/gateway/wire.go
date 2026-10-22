package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

const (
	pollEvery = 2500 * time.Millisecond
	httpWait  = 1800 * time.Millisecond
)

// ---------------------------------------------------------------------------
// wire 形状
// ---------------------------------------------------------------------------

// Totals 是 `/v1/magpie/usage` 的一段汇总。字段名直接沿用接口（snake_case），
// 少一层翻译就少一处会漂的地方。
type Totals struct {
	Calls      int     `json:"calls"`
	Errors     int     `json:"errors"`
	Retried    int     `json:"retried"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cache_read"`
	CacheWrite int64   `json:"cache_write"`
	Reasoning  int64   `json:"reasoning"`
	Cost       float64 `json:"cost"`
	Unpriced   int     `json:"unpriced"`
	Timed      int     `json:"timed"`
	TTFT       int64   `json:"ttft_ms"`
	Decode     int64   `json:"decode_ms"`
	DecodeOut  int64   `json:"decode_out"`
	DecodeN    int     `json:"decode_n"`
}

type Day struct {
	Day        string `json:"day"` // YYYY-MM-DD（接口给的是本地时区的 RFC3339，截前 10 位）
	Calls      int    `json:"calls"`
	Errors     int    `json:"errors"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
}

type AgentTotal struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Icon       string  `json:"icon"`
	Calls      int     `json:"calls"`
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cache_read"`
	CacheWrite int64   `json:"cache_write"`
	Cost       float64 `json:"cost"`
}

type ModelTotal struct {
	ID        string  `json:"id"`
	Provider  string  `json:"provider"`
	Model     string  `json:"model"`
	Name      string  `json:"name"`
	Sub       string  `json:"sub"`
	Icon      string  `json:"icon"`
	Calls     int     `json:"calls"`
	Input     int64   `json:"input"`
	Output    int64   `json:"output"`
	CacheRead int64   `json:"cache_read"`
	Cost      float64 `json:"cost"`
}

type ProviderKey struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Calls     int    `json:"calls"`
	Errors    int    `json:"errors"`
	Input     int64  `json:"input"`
	Output    int64  `json:"output"`
	CacheRead int64  `json:"cache_read"`
}

type Series struct {
	Time       string `json:"time"`
	Calls      int    `json:"calls"`
	Errors     int    `json:"errors"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
}

type Usage struct {
	Totals
	Since        string        `json:"since"`
	Bucket       string        `json:"bucket"`
	Series       []Series      `json:"series"`
	Agents       []AgentTotal  `json:"agents"`
	Models       []ModelTotal  `json:"models"`
	ProviderKeys []ProviderKey `json:"providerKeys"`
}

// Req 是一条已经完成的请求。刻意不含 prompt / 工具参数 / session 正文。
type Req struct {
	At           string  `json:"t"`
	Agent        string  `json:"agent"`
	AgentName    string  `json:"agentName"`
	Icon         string  `json:"icon"`
	Provider     string  `json:"provider"`
	ProviderName string  `json:"providerName"`
	Model        string  `json:"model"`
	Served       string  `json:"served"`
	In           int64   `json:"in"`
	Out          int64   `json:"out"`
	CacheRead    int64   `json:"cache_read"`
	CacheWrite   int64   `json:"cache_write"`
	Ms           int64   `json:"ms"`
	TTFT         int64   `json:"ttft_ms"`
	Status       int     `json:"status"`
	Effort       string  `json:"effort"`
	Cost         float64 `json:"cost"`
	// 下面两个由 Perch 补：served 模型对应的上下文窗口，以及由 in+cache 算出的
	// prompt 总量。前端拿它们画「上下文」那一格，不必再带一份模型表。
	Window int64 `json:"window,omitempty"`
	Prompt int64 `json:"prompt,omitempty"`
}

type ReqResp struct {
	Rows  []Req `json:"rows"`
	Total int   `json:"total"`
}

type Conc struct {
	Requests int `json:"requests"`
	Waiting  int `json:"waiting"`
	Tools    int `json:"tools"`
	Lanes    int `json:"lanes"`
}

type Provider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	Host    string `json:"host"`
	Preset  string `json:"preset,omitempty"`
	Website string `json:"website,omitempty"`
	Keys    int    `json:"keys"`
}

type Model struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Owner   string `json:"owner"`
	Type    string `json:"type,omitempty"`
	Context int64  `json:"context"`
	Group   bool   `json:"group"`
}

type Ctx struct {
	Prompt    int64  `json:"prompt"`
	Window    int64  `json:"window"`
	Model     string `json:"model,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Icon      string `json:"icon,omitempty"`
	CacheRead int64  `json:"cacheRead"`
	At        string `json:"at,omitempty"`
}

// Snapshot 是发给前端的整份读数。
type Snapshot struct {
	State     string `json:"state"` // running | stopped | absent
	Version   string `json:"version,omitempty"`
	Gateway   string `json:"gateway,omitempty"`
	ConfigDir string `json:"configDir,omitempty"`
	At        string `json:"at"`
	Err       string `json:"err,omitempty"`
	// ErrCode/ErrParams 与 Err 并行：Err 始终是原文（日志/旧前端），
	// 这一对让当前前端把同一句按用户语言重画。
	ErrCode    string              `json:"errCode,omitempty"`
	ErrParams  map[string]string   `json:"errParams,omitempty"`
	Today      Totals              `json:"today"`
	All        Totals              `json:"all"`
	TodayUsage UsageView           `json:"todayUsage"`
	Series     []Day               `json:"series"`
	Recent     []Req               `json:"recent"`
	Conc       Conc                `json:"conc"`
	Providers  []Provider          `json:"providers"`
	Models     []Model             `json:"models"`
	Context    Ctx                 `json:"context"`
	Catalog    []agentcatalog.Card `json:"catalog"`
	UsageAt    string              `json:"usageAt,omitempty"`
	// 今天的三个榜（接口算好的，前端只排序取前几）：agent / 模型 / provider 账号。
	TodayAgents       []AgentTotal  `json:"todayAgents"`
	TodayModels       []ModelTotal  `json:"todayModels"`
	TodayProviderKeys []ProviderKey `json:"todayProviderKeys"`
}

// ---------------------------------------------------------------------------
// watcher
// ---------------------------------------------------------------------------

// watcher 只保留**最新一份**快照。前端拿到的永远是整份（低频、几 KB），
// 不做增量 —— 读数这种小载荷上，增量省不下什么，却会多出一整类"两边漂了"的毛病。
type watcher struct {
	mu       sync.Mutex
	refreshM sync.Mutex // 一轮没跑完就不开下一轮（网关卡住时别把协程堆起来）
	snap     *Snapshot
	lastJSON []byte
	lastStat string // 只用来在状态变化时落一行日志
	lastCat  string // 本地 Agent 名单的指纹：变了就先推，不等 HTTP
	client   *http.Client
	push     func(any)
	// The managed engine is started by Perch; these read its live address and
	// private config dir. Empty means "engine not up yet" (local scan only).
	baseURL   func() string
	configDir func() string
}

// StartWatcher 先扫本机（瞬时），再把 HTTP 那条腿放进协程。
// 不阻塞 app.Run：magpie 没开的时候，启动一秒都不该等它。
func (g *Gateway) StartWatcher() {
	w := &watcher{
		client: &http.Client{
			Timeout: httpWait,
			// 本机地址绝不能被系统代理截走（Windows 上 HTTP_PROXY 很常见）。
			Transport: &http.Transport{Proxy: nil},
		},
		push: g.push,
		baseURL: func() string {
			g.mu.Lock()
			defer g.mu.Unlock()
			return g.gatewayURL
		},
		configDir: func() string {
			g.mu.Lock()
			defer g.mu.Unlock()
			return g.configDir
		},
	}
	// 本机那份先出（版本 / Provider / Agent 名单），网关读数稍后补。
	w.mu.Lock()
	w.snap = w.scanLocal()
	w.mu.Unlock()

	g.watcherMu.Lock()
	g.docWatcher = w
	g.watcherMu.Unlock()

	go func() {
		w.refresh()
		t := time.NewTicker(pollEvery)
		defer t.Stop()
		for range t.C {
			w.refresh()
		}
	}()
}

// Snapshot 返回最新一份读数；watcher 还没起来时为 nil。
func (g *Gateway) Snapshot() *Snapshot {
	g.watcherMu.RLock()
	w := g.docWatcher
	g.watcherMu.RUnlock()
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.snap
}

// RefreshNow 立刻跑一轮（用户点刷新）。后台 watcher 仍按自己的节奏走。
func (g *Gateway) RefreshNow() {
	g.watcherMu.RLock()
	w := g.docWatcher
	g.watcherMu.RUnlock()
	if w != nil {
		w.refresh()
	}
}

func (w *watcher) refresh() bool {
	if !w.refreshM.TryLock() {
		return false
	}
	defer w.refreshM.Unlock()

	s := w.scanLocal()
	// 名单只碰本地磁盘：变了就先推一份，别让 fillRemote 的 HTTP
	//（每个请求 1.8 秒超时）把「刚装好」的名单拖到下一轮。
	catJSON, _ := json.Marshal(s.Catalog)
	catChanged := string(catJSON) != w.lastCat
	w.lastCat = string(catJSON)
	if catChanged && w.push != nil {
		w.push(map[string]any{"type": "catalog", "catalog": s.Catalog})
	}
	w.fillRemote(s)

	b, err := json.Marshal(s)
	if err != nil {
		return false
	}
	w.mu.Lock()
	changed := !bytes.Equal(b, w.lastJSON)
	statChanged := s.State != w.lastStat
	w.lastJSON = b
	w.snap = s
	w.lastStat = s.State
	w.mu.Unlock()

	if statChanged {
		log.Printf("[magpie] 网关状态=%s 版本=%s 地址=%s 今日请求=%d 历史上限=%s",
			s.State, orNone(s.Version), orDash(s.Gateway), s.Today.Calls, orNone(s.Err))
	}
	if changed && w.push != nil {
		w.push(map[string]any{"type": "magpie", "magpie": s})
	}
	return true
}

// scanLocal 只碰磁盘：配置目录、版本、Provider 清单、Agent 名单。
// 网关关着的时候这些仍然是对的 —— 「装了没开」和「没装」必须分得开。
func (w *watcher) scanLocal() *Snapshot {
	home, _ := os.UserHomeDir()
	dir := ""
	if w.configDir != nil {
		dir = w.configDir()
	}
	base := ""
	if w.baseURL != nil {
		base = w.baseURL()
	}
	s := &Snapshot{
		State:     "absent",
		Gateway:   base,
		ConfigDir: dir,
		At:        time.Now().Format(time.RFC3339),
		Catalog:   agentcatalog.Cards(home),
	}
	if dir != "" {
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			s.State = "stopped"
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "last-version")); err == nil {
		s.Version = strings.TrimSpace(string(b))
	}
	if dir != "" {
		s.Providers = scanMagpieProviders(dir)
	} else {
		s.Providers = []Provider{}
	}
	return s
}

// fillRemote 覆盖 HTTP 那部分。任何一个接口失败都不抹掉别的 —— 比如网关开着、
// usage 却因为一个受限 key 回答 403 时，Provider 清单和「在跑」仍然要看得见。
func (w *watcher) fillRemote(s *Snapshot) {
	base := ""
	if w.baseURL != nil {
		base = w.baseURL()
	}
	if base == "" {
		return
	}
	var today, all Usage
	var recent ReqResp
	var conc struct {
		Requests int            `json:"requests"`
		Waiting  int            `json:"waiting"`
		Tools    int            `json:"tools"`
		Data     map[string]any `json:"data"`
	}
	var models struct {
		Data []struct {
			ID      string `json:"id"`
			Name    string `json:"display_name"`
			Owner   string `json:"owned_by"`
			Type    string `json:"type"`
			Context int64  `json:"context_window"`
		} `json:"data"`
	}

	errToday := w.getJSON(base, "/v1/magpie/usage?period=today", &today)
	errAll := w.getJSON(base, "/v1/magpie/usage?period=all", &all)
	errReq := w.getJSON(base, "/v1/magpie/usage/requests?period=today&limit=16", &recent)
	errConc := w.getJSON(base, "/v1/magpie/concurrency", &conc)
	errModels := w.getJSON(base, "/v1/models", &models)

	if errConc == nil {
		s.State = "running"
		s.Conc = Conc{Requests: conc.Requests, Waiting: conc.Waiting, Tools: conc.Tools, Lanes: len(conc.Data)}
	} else if s.State == "stopped" {
		// 目录在、网关没应答：保持 stopped，把原因留给界面。
		setSnapErr(s, "gw.notRunning", "网关未运行")
	}
	if errToday == nil {
		s.Today = today.Totals
		s.UsageAt = time.Now().Format(time.RFC3339)
		s.TodayUsage = usageView(today, "today")
		s.TodayAgents = today.Agents
		s.TodayModels = today.Models
		s.TodayProviderKeys = today.ProviderKeys
		if len(today.Agents) > 0 {
			calls := map[string]int{}
			for _, a := range today.Agents {
				calls[a.ID] = a.Calls
			}
			for i := range s.Catalog {
				s.Catalog[i].Calls = calls[s.Catalog[i].ID]
			}
		}
	}
	if errAll == nil {
		s.All = all.Totals
		s.Series = s.Series[:0]
		for _, p := range all.Series {
			day := p.Time
			if len(day) > 10 {
				day = day[:10]
			}
			s.Series = append(s.Series, Day{
				Day: day, Calls: p.Calls, Errors: p.Errors,
				Input: p.Input, Output: p.Output,
				CacheRead: p.CacheRead, CacheWrite: p.CacheWrite,
			})
		}
	}
	if errReq == nil && len(recent.Rows) > 0 {
		ctx := map[string]int64{}
		// 上下文窗口先按 "provider/model" 建表，再退化到裸 model 名 ——
		// 同一个模型在不同 provider 下窗口可能不同，先精确后宽泛。
		for _, m := range models.Data {
			ctx[m.ID] = m.Context
			if !strings.Contains(m.ID, "/") {
				if _, ok := ctx[m.ID]; !ok {
					ctx[m.ID] = m.Context
				}
			}
		}
		s.Recent = make([]Req, 0, len(recent.Rows))
		for _, r := range recent.Rows {
			r.Prompt = r.In + r.CacheRead + r.CacheWrite
			r.Window = ctx[r.Provider+"/"+r.Served]
			if r.Window == 0 {
				// 有的记录 served 只有模型名；全局再兜一次。
				r.Window = ctx[r.Served]
			}
			s.Recent = append(s.Recent, r)
		}
		if s.Context.At == "" && len(s.Recent) > 0 {
			r := s.Recent[0]
			s.Context = Ctx{
				Prompt: r.Prompt, Window: r.Window, Model: r.Served,
				Agent: r.AgentName, Icon: r.Icon, CacheRead: r.CacheRead, At: r.At,
			}
		}
	}
	if errModels == nil {
		s.Models = s.Models[:0]
		for _, m := range models.Data {
			s.Models = append(s.Models, Model{
				ID: m.ID, Name: m.Name, Owner: m.Owner, Type: m.Type,
				Context: m.Context, Group: strings.HasPrefix(m.ID, "group/"),
			})
		}
	}
	// 活跃分组优先展示（路由页的"分组"一行）。顺序稳定：Calls 多的先，
	// 其余按 id —— 前端不该因为每次刷新的 map 序而跳。
	sort.SliceStable(s.Models, func(i, j int) bool { return s.Models[i].ID < s.Models[j].ID })
	if errConc != nil && errToday != nil && errAll != nil && errReq != nil && errModels != nil {
		// 五条全灭：网关确实不在。
		if s.State == "absent" {
			setSnapErr(s, "gw.notDetected", "没有检测到本地网关")
		} else {
			s.State = "stopped"
			setSnapErr(s, "gw.notRunning", "网关未运行")
		}
	} else if s.Err != "" && errConc == nil {
		s.Err, s.ErrCode, s.ErrParams = "", "", nil
	}
}

// setSnapErr 同时写原文与稳定 code；快照的 Err 是字符串，不能像 map 那样
// 再挂两个字段到同一条错误上，所以在结构体上并排留了一对。
func setSnapErr(s *Snapshot, code, text string) {
	s.Err = text
	s.ErrCode = code
	s.ErrParams = nil
}

func (w *watcher) getJSON(base, path string, v any) error {
	res, err := w.client.Get(strings.TrimRight(base, "/") + path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	// 上限 64MB 只是防一条坏响应把内存吃光；实际最大的是 usage?period=all 的 ~20KB。
	return json.NewDecoder(io.LimitReader(res.Body, 64<<20)).Decode(v)
}

func scanMagpieProviders(dir string) []Provider {
	b, err := os.ReadFile(filepath.Join(dir, "providers.json"))
	if err != nil {
		return []Provider{}
	}
	var f struct {
		Providers []struct {
			ID      string            `json:"id"`
			Name    string            `json:"name"`
			Icon    string            `json:"icon"`
			Preset  string            `json:"preset"`
			Chat    string            `json:"chat"`
			Website string            `json:"website"`
			Key     string            `json:"key"`
			Keys    []json.RawMessage `json:"keys"`
		} `json:"providers"`
	}
	if json.Unmarshal(b, &f) != nil {
		return []Provider{}
	}
	out := make([]Provider, 0, len(f.Providers))
	for _, p := range f.Providers {
		out = append(out, Provider{
			ID: p.ID, Name: p.Name, Icon: p.Icon, Preset: p.Preset,
			Host: hostOf(p.Chat), Website: p.Website,
			Keys: len(p.Keys) + boolInt(p.Key != ""),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func hostOf(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	if i := strings.IndexAny(u, "/?#"); i >= 0 {
		u = u[:i]
	}
	return u
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func orNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "无"
	}
	return s
}
