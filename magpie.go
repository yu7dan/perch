package main

// magpie 读数：Perch 对本地 magpie 网关的**只读**观测。
//
// 为什么单独一个文件、为什么全部走 HTTP：
//
//   - magpie 的网关就开在 127.0.0.1:3425 上，`/v1/magpie/usage`、
//     `/v1/magpie/usage/requests`、`/v1/magpie/concurrency`、`/v1/models`
//     这几条就是它自己界面在用的数据（docs/reference.md:1727+），
//     形状稳定、字段齐全，还带上了 agent/provider 的名字和图标 id。
//   - 直接读 `usage.jsonl` 要自己重算聚合，而且那份文件 9MB+、还在长；
//     网关接口已经把**窗口、聚合、分档**都做好了 —— 不重复造一份会漂的口径。
//   - 请求记录里**没有 prompt 内容**（reference.md 原话 "What was said in a
//     call is not in either"）。这是选它、不选 routing/*.jsonl 的硬理由：
//     后者每一行都带着整份 prompt 的分段统计，我们一个字节都不该往界面上搬。
//
// 连接不上的三种真实状态必须分得开（用户特别点名"不要因为本机配好了就忽略
// 别人接不上的情况"）：
//
//	running  3425 上有人应答（magpie 开着）
//	stopped  ~/.config/magpie 在、但 3425 连不上（装了没开 / 网关关了）
//	absent   两样都没有（没装，或者装在认不出的位置）
//
// 三种都发同一副骨架，前端按 state 决定是画读数还是画空态 —— 不做假数据。
//
// ⚠️ 隐私：这里只解 JSON 里点名的字段。provider 的 key、账号、prompt 一律
// 不进结构体，日志里也只打数量。providers.json 是唯一一份带 key 的文件，
// 我们只取 id/name/icon/chat/website/preset，并且**永远不 Marshal 原始结构**。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	magpieGateway   = "http://127.0.0.1:3425"
	magpiePollEvery = 2500 * time.Millisecond
	magpieHTTPWait  = 1800 * time.Millisecond
)

// ---------------------------------------------------------------------------
// wire 形状
// ---------------------------------------------------------------------------

// magpieTotals 是 `/v1/magpie/usage` 的一段汇总。字段名直接沿用接口（snake_case），
// 少一层翻译就少一处会漂的地方。
type magpieTotals struct {
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

type magpieDay struct {
	Day        string `json:"day"` // YYYY-MM-DD（接口给的是本地时区的 RFC3339，截前 10 位）
	Calls      int    `json:"calls"`
	Errors     int    `json:"errors"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
}

type magpieAgentTotal struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Icon       string `json:"icon"`
	Calls      int    `json:"calls"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
}

type magpieModelTotal struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Name      string `json:"name"`
	Sub       string `json:"sub"`
	Icon      string `json:"icon"`
	Calls     int    `json:"calls"`
	Input     int64  `json:"input"`
	Output    int64  `json:"output"`
	CacheRead int64  `json:"cache_read"`
}

type magpieProviderKey struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Calls     int    `json:"calls"`
	Errors    int    `json:"errors"`
	Input     int64  `json:"input"`
	Output    int64  `json:"output"`
	CacheRead int64  `json:"cache_read"`
}

type magpieSeries struct {
	Time       string `json:"time"`
	Calls      int    `json:"calls"`
	Errors     int    `json:"errors"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
}

type magpieUsage struct {
	magpieTotals
	Since        string              `json:"since"`
	Bucket       string              `json:"bucket"`
	Series       []magpieSeries      `json:"series"`
	Agents       []magpieAgentTotal  `json:"agents"`
	Models       []magpieModelTotal  `json:"models"`
	ProviderKeys []magpieProviderKey `json:"providerKeys"`
}

// magpieReq 是一条已经完成的请求。刻意不含 prompt / 工具参数 / session 正文。
type magpieReq struct {
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

type magpieReqResp struct {
	Rows  []magpieReq `json:"rows"`
	Total int         `json:"total"`
}

type magpieConc struct {
	Requests int `json:"requests"`
	Waiting  int `json:"waiting"`
	Tools    int `json:"tools"`
	Lanes    int `json:"lanes"`
}

type magpieProvider struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Icon    string `json:"icon"`
	Host    string `json:"host"`
	Preset  string `json:"preset,omitempty"`
	Website string `json:"website,omitempty"`
	Keys    int    `json:"keys"`
}

type magpieModel struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Owner   string `json:"owner"`
	Type    string `json:"type,omitempty"`
	Context int64  `json:"context"`
	Group   bool   `json:"group"`
}

type magpieCtx struct {
	Prompt    int64  `json:"prompt"`
	Window    int64  `json:"window"`
	Model     string `json:"model,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Icon      string `json:"icon,omitempty"`
	CacheRead int64  `json:"cacheRead"`
	At        string `json:"at,omitempty"`
}

type magpiePlugins struct {
	Preset    string   `json:"preset,omitempty"`
	Installed []string `json:"installed"`
	Entries   int      `json:"entries"`
}

// agentCard 是 Agent 名单的一行。数据一半来自本机探测（装没装、Perch 能不能跑），
// 一半来自今天的网关流量（calls）—— 后者是"真的接上了"的唯一证据。
type agentCard struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Icon      string    `json:"icon"`
	Vendor    string    `json:"vendor"`
	URL       string    `json:"url"`
	Path      string    `json:"path,omitempty"`
	Installed bool      `json:"installed"`
	Adapter   bool      `json:"adapter"` // 有结构化状态/续接（兼容旧字段；新代码读 caps）
	Caps      agentCaps `json:"caps"`    // 启动/忙闲/等用户/动作，到哪一层
	Install   bool      `json:"install"` // 有 Perch 能代跑的官方安装配方
	Windows   bool      `json:"windows"` // 这个 agent 在 Windows 上有原生支持
	Note      string    `json:"note,omitempty"`
	Calls     int       `json:"calls"`
}

type magpieSnap struct {
	State     string           `json:"state"` // running | stopped | absent
	Version   string           `json:"version,omitempty"`
	Gateway   string           `json:"gateway,omitempty"`
	ConfigDir string           `json:"configDir,omitempty"`
	At        string           `json:"at"`
	Err       string           `json:"err,omitempty"`
	Today     magpieTotals     `json:"today"`
	All       magpieTotals     `json:"all"`
	Series    []magpieDay      `json:"series"`
	Recent    []magpieReq      `json:"recent"`
	Conc      magpieConc       `json:"conc"`
	Providers []magpieProvider `json:"providers"`
	Models    []magpieModel    `json:"models"`
	Context   magpieCtx        `json:"context"`
	Catalog   []agentCard      `json:"catalog"`
	Plugins   magpiePlugins    `json:"plugins"`
	UsageAt   string           `json:"usageAt,omitempty"`
	// 今天的三个榜（接口算好的，前端只排序取前几）：agent / 模型 / provider 账号。
	TodayAgents   []magpieAgentTotal  `json:"todayAgents"`
	TodayModels   []magpieModelTotal  `json:"todayModels"`
	TodayProviderKeys []magpieProviderKey `json:"todayProviderKeys"`
}

// ---------------------------------------------------------------------------
// watcher
// ---------------------------------------------------------------------------

// magpieWatcher 只保留**最新一份**快照。前端拿到的永远是整份（低频、几 KB），
// 不做增量 —— 读数这种小载荷上，增量省不下什么，却会多出一整类"两边漂了"的毛病。
type magpieWatcher struct {
	mu       sync.Mutex
	refreshM sync.Mutex // 一轮没跑完就不开下一轮（网关卡住时别把协程堆起来）
	snap     *magpieSnap
	lastJSON []byte
	lastStat string // 只用来在状态变化时落一行日志
	lastCat  string // 本地 Agent 名单的指纹：变了就先推，不等 HTTP
	client   *http.Client
	push     func(any)
}

var (
	magpieWatchMu sync.RWMutex
	magpieWatch   *magpieWatcher
)

func magpieSnapshot() *magpieSnap {
	magpieWatchMu.RLock()
	w := magpieWatch
	magpieWatchMu.RUnlock()
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.snap
}

// startMagpieWatcher 先扫本机（瞬时），再把 HTTP 那条腿放进协程。
// 不阻塞 app.Run：magpie 没开的时候，启动一秒都不该等它。
func startMagpieWatcher(push func(any)) *magpieWatcher {
	w := &magpieWatcher{
		client: &http.Client{
			Timeout: magpieHTTPWait,
			// 本机地址绝不能被系统代理截走（Windows 上 HTTP_PROXY 很常见）。
			Transport: &http.Transport{Proxy: nil},
		},
		push: push,
	}
	// 本机那份先出（版本 / Provider / 插件 / Agent 名单），网关读数稍后补。
	w.mu.Lock()
	w.snap = w.scanLocal()
	w.mu.Unlock()

	magpieWatchMu.Lock()
	magpieWatch = w
	magpieWatchMu.Unlock()

	go func() {
		w.refresh()
		t := time.NewTicker(magpiePollEvery)
		defer t.Stop()
		for range t.C {
			w.refresh()
		}
	}()
	return w
}

func (w *magpieWatcher) refresh() bool {
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

// scanLocal 只碰磁盘：配置目录、版本、Provider 清单、插件、Agent 名单。
// 网关关着的时候这些仍然是对的 —— 「装了没开」和「没装」必须分得开。
func (w *magpieWatcher) scanLocal() *magpieSnap {
	home, _ := os.UserHomeDir()
	dir := magpieConfigDir(home)
	s := &magpieSnap{
		State:     "absent",
		Gateway:   magpieGateway,
		ConfigDir: dir,
		At:        time.Now().Format(time.RFC3339),
		Catalog:   scanAgentCatalog(home),
		Plugins:   scanMagpiePlugins(dir),
	}
	if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
		s.State = "stopped"
	}
	if b, err := os.ReadFile(filepath.Join(dir, "last-version")); err == nil {
		s.Version = strings.TrimSpace(string(b))
	}
	s.Providers = scanMagpieProviders(dir)
	return s
}

// fillRemote 覆盖 HTTP 那部分。任何一个接口失败都不抹掉别的 —— 比如网关开着、
// usage 却因为一个受限 key 回答 403 时，Provider 清单和「在跑」仍然要看得见。
func (w *magpieWatcher) fillRemote(s *magpieSnap) {
	var today, all magpieUsage
	var recent magpieReqResp
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

	errToday := w.getJSON("/v1/magpie/usage?period=today", &today)
	errAll := w.getJSON("/v1/magpie/usage?period=all", &all)
	errReq := w.getJSON("/v1/magpie/usage/requests?period=today&limit=16", &recent)
	errConc := w.getJSON("/v1/magpie/concurrency", &conc)
	errModels := w.getJSON("/v1/models", &models)

	if errConc == nil {
		s.State = "running"
		s.Conc = magpieConc{Requests: conc.Requests, Waiting: conc.Waiting, Tools: conc.Tools, Lanes: len(conc.Data)}
	} else if s.State == "stopped" {
		// 目录在、网关没应答：保持 stopped，把原因留给界面。
		s.Err = "网关未运行"
	}
	if errToday == nil {
		s.Today = today.magpieTotals
		s.UsageAt = time.Now().Format(time.RFC3339)
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
		s.All = all.magpieTotals
		s.Series = s.Series[:0]
		for _, p := range all.Series {
			day := p.Time
			if len(day) > 10 {
				day = day[:10]
			}
			s.Series = append(s.Series, magpieDay{
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
		s.Recent = make([]magpieReq, 0, len(recent.Rows))
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
			s.Context = magpieCtx{
				Prompt: r.Prompt, Window: r.Window, Model: r.Served,
				Agent: r.AgentName, Icon: r.Icon, CacheRead: r.CacheRead, At: r.At,
			}
		}
	}
	if errModels == nil {
		s.Models = s.Models[:0]
		for _, m := range models.Data {
			s.Models = append(s.Models, magpieModel{
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
			s.Err = "没有检测到本地网关"
		} else {
			s.State = "stopped"
			s.Err = "网关未运行"
		}
	} else if s.Err != "" && errConc == nil {
		s.Err = ""
	}
}

func (w *magpieWatcher) getJSON(path string, v any) error {
	res, err := w.client.Get(magpieGateway + path)
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

// magpieConfigDir 和 magpie 自己的 appdir 规则一致（appdir.go:224-234）：
// XDG_CONFIG_HOME 优先，否则 ~/.config/magpie。不猜 portable 目录 ——
// 猜错会把别人的配置当成"没装"。
func magpieConfigDir(home string) string {
	if d := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); d != "" {
		return filepath.Join(d, "magpie")
	}
	return filepath.Join(home, ".config", "magpie")
}

func scanMagpieProviders(dir string) []magpieProvider {
	b, err := os.ReadFile(filepath.Join(dir, "providers.json"))
	if err != nil {
		return []magpieProvider{}
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
		return []magpieProvider{}
	}
	out := make([]magpieProvider, 0, len(f.Providers))
	for _, p := range f.Providers {
		out = append(out, magpieProvider{
			ID: p.ID, Name: p.Name, Icon: p.Icon, Preset: p.Preset,
			Host: hostOf(p.Chat), Website: p.Website,
			Keys: len(p.Keys) + boolInt(p.Key != ""),
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func scanMagpiePlugins(dir string) magpiePlugins {
	out := magpiePlugins{Installed: []string{}}
	b, err := os.ReadFile(filepath.Join(dir, "plugins.yml"))
	if err != nil {
		return out
	}
	seen := map[string]bool{}
	inPlugins := false
	for _, ln := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if strings.HasPrefix(t, "preset:") {
			out.Preset = strings.TrimSpace(strings.TrimPrefix(t, "preset:"))
			continue
		}
		if t == "plugins:" {
			inPlugins = true
			continue
		}
		if !inPlugins {
			continue
		}
		if !strings.HasPrefix(ln, " ") && !strings.HasPrefix(ln, "\t") {
			inPlugins = false
			continue
		}
		// 两种写法都收：`- spec` 和 `name:`。只记名字，不解释其余配置。
		name := ""
		if strings.HasPrefix(t, "- ") {
			name = strings.TrimSpace(strings.TrimPrefix(t, "- "))
		} else if i := strings.Index(t, ":"); i > 0 {
			name = strings.TrimSpace(t[:i])
		}
		name = strings.Trim(name, `"'`)
		if name != "" && pluginNameOK.MatchString(name) && !seen[name] && len(out.Installed) < 200 {
			seen[name] = true
			out.Installed = append(out.Installed, name)
		}
	}
	out.Entries = len(out.Installed)
	return out
}

// ---------------------------------------------------------------------------
// Agent 名单
// ---------------------------------------------------------------------------

// agentCatalogDefs 是用户 2026-10-17 点名的那份清单（外加几枚同类里最该有的）。
//
// 这份清单是**使用层**：只收能在终端里跑的 CLI agent，不收桌面应用。
// 桌面客户端（Claude Desktop 等）属于 magpie 的**网关层**，可以出现在
// /api/state 里，但不从这里安装、启动或展示。没有安装配方也不等于桌面应用 ——
// 那只是"Perch 还不能替它跑安装命令"，前端给官方安装说明的出口。
//
// 探测规则抄 magpie 的 reference.md（第 88 行起那张表）：**看配置文件**，
// 不看 PATH —— Windows 上装完不重开、PATH 没刷新的情况太常见了。
// 能不能启动、有没有忙闲、能不能看到“在等你”是三件事，能力由 capsForAgent
// （agent_status.go）决定。别再拿 agentDefs 里有没有它当“已接入”：通用启动
// 会给所有有 Bin 的 agent 都注册一条，只代表能开一格。
//
// URL 一律是官方安装页/仓库：按钮的动作是"打开下载页"，不是静默安装 ——
// 在别人机器上替人跑安装脚本，比少一个按钮危险得多。
type agentCatalogDef struct {
	ID, Name, Icon, Vendor, URL, Note string
	Windows, Adapter                  bool
	Paths                             []string
	Bin                               string
}

var agentCatalogDefs = []agentCatalogDef{
	{"claude", "Claude Code", "claudecode-color", "Anthropic", "https://code.claude.com/docs/en/setup", "", true, true,
		[]string{"~/.claude/settings.json", "~/.local/claude.exe"}, "claude"},
	{"codex", "Codex", "codex-color", "OpenAI", "https://chatgpt.com/codex", "", true, false,
		[]string{"~/.codex/config.toml"}, "codex"},
	{"pi", "Pi", "pi", "Earendil Works", "https://github.com/earendil-works/pi", "", true, false,
		[]string{"~/.pi/agent/settings.json", "~/.pi/agent/models.json"}, "pi"},
	{"opencode", "OpenCode", "opencode", "OpenCode", "https://opencode.ai", "", true, false,
		[]string{"~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc",
			"~/.local/share/opencode/auth.json"}, "opencode"},
	{"agy", "Antigravity CLI", "antigravity-color", "Google", "https://antigravity.google/docs/cli/install", "", true, false,
		[]string{"~/.gemini/antigravity-cli/settings.json"}, "agy"},
	{"dsh", "DeepSeek Harness", "deepseek-color", "DeepSeek", "https://www.npmjs.com/package/@deepseek-ai/dsh", "", true, false,
		[]string{"~/.dsh/config.yaml", "~/.dsh/settings.yaml", "~/.dsh/profiles"}, "dsh"},
	{"cursor", "Cursor", "cursor", "Anysphere", "https://cursor.com/cli", "", true, false,
		[]string{"~/.cursor/cli-config.json"}, "cursor-agent"},
	{"codebuddy", "CodeBuddy Code", "codebuddy-color", "Tencent", "https://www.codebuddy.ai/docs/cli/installation", "", true, false,
		[]string{"~/.codebuddy/models.json", "~/.codebuddy/settings.json"}, "codebuddy"},
	{"kimi", "Kimi Code", "kimi", "Moonshot", "https://github.com/MoonshotAI/kimi-code", "", true, false,
		[]string{"~/.kimi/config.toml", "~/.kimi-code/config.toml"}, "kimi"},
	{"muse", "Muse Code", "meta-color", "Meta", "https://dev.meta.ai/docs/muse-code", "原生 Windows（2026-09 起）", true, false,
		[]string{"~/.config/muse/settings.json", "~/.muse", "~/AppData/Local/Programs/muse"}, "muse"},
	{"zcode", "ZCode", "zcode", "Zhipu", "https://zcode.z.ai", "", true, false,
		[]string{"~/.zcode/v2/config.json", "~/.zcode/v2/provider_config.json"}, "zcode"},
	// 追加的同类：magpie 都有图标与配置格式，接进来不增加猜测。
	{"gemini", "Gemini CLI", "geminicli-color", "Google", "https://github.com/google-gemini/gemini-cli", "", true, false,
		[]string{"~/.gemini/settings.json"}, "gemini"},
	{"copilot", "Copilot CLI", "githubcopilot", "GitHub", "https://github.com/github/copilot-cli", "", true, false,
		[]string{"~/.copilot/settings.json"}, "copilot"},
	{"qwen", "Qwen Code", "qwen-color", "Alibaba", "https://github.com/QwenLM/qwen-code", "", true, false,
		[]string{"~/.qwen/settings.json"}, "qwen"},
	{"crush", "Crush", "crush", "Charm", "https://github.com/charmbracelet/crush", "", true, false,
		[]string{"~/.config/crush/crush.json"}, "crush"},
}

func scanAgentCatalog(home string) []agentCard {
	out := make([]agentCard, 0, len(agentCatalogDefs))
	for _, d := range agentCatalogDefs {
		caps := capsForAgent(d.ID)
		_, canInstall := installRecipes[d.ID]
		c := agentCard{
			ID: d.ID, Name: d.Name, Icon: d.Icon, Vendor: d.Vendor, URL: d.URL,
			// ⚠️ Adapter 不能再从 agentDefs 里查：genericAgentDef 会给所有有 Bin
			// 的 agent 注册一条“只开新会话”，那会把“能启动”写成“已接入”。
			// 结构化能力只认 capsForAgent。
			Adapter: caps.Status || caps.Resume || caps.Actions,
			Caps:    caps, Install: canInstall, Windows: d.Windows, Note: d.Note,
		}
		for _, raw := range d.Paths {
			p := expandHome(home, raw)
			if fi, err := os.Stat(p); err == nil {
				c.Installed = true
				c.Path = prettyHome(home, p)
				if fi.IsDir() {
					// 目录也算（dsh profiles / zcode 数据目录）。
					break
				}
				break
			}
		}
		// 配置目录不在时，用**和启动同一份**候选表再找一次 exe：GUI 进程的
		// PATH 常常比终端里短，而且 Codex 的官方安装器根本不写 PATH。
		if !c.Installed && d.Bin != "" {
			if p, ok := findAgentExe(d.Bin); ok {
				c.Installed = true
				c.Path = p
			}
		}
		out = append(out, c)
	}
	return out
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

func expandHome(home, p string) string {
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(home, p[2:])
	}
	return p
}

func prettyHome(home, p string) string {
	if home != "" && strings.HasPrefix(strings.ToLower(p), strings.ToLower(home)) {
		return "~" + p[len(home):]
	}
	return p
}

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

// 插件名的宽校验：免得把 YAML 里的标点当成插件名。
var pluginNameOK = regexp.MustCompile(`^[@A-Za-z0-9][@A-Za-z0-9._/-]*$`)
