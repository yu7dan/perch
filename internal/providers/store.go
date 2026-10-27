// Package providers 是 Perch 自己的「模型提供商 + 每个 agent 用谁」配置。
//
// 2026-10-28 起取代内嵌的 magpie 网关：用户在设置里加一次提供商（名称、
// Anthropic / OpenAI 兼容接口的地址、key），再给每个 agent 选提供商和默认模型，
// 必要时直接写原始环境变量（Orca 的 Settings › Agents 那一套）。
//
// 只注入 Perch 自己启动的那一个进程（见 inject.go），不写任何 agent 的全局配置。
// key 和环境变量的值用 DPAPI 加密落盘，界面上只写不读。
package providers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// FileName 是 %APPDATA%\Perch 下的配置文件名。
const FileName = "providers.json"

// Provider 是一个模型提供商（官方 API、中转站、本地服务都算）。
// 两个接口地址至少有一个：Claude Code 只认 Anthropic 接口，Codex 只认 OpenAI 兼容
// （Responses）接口，Pi / OpenCode 两种都行。
type Provider struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Anthropic string   `json:"anthropic,omitempty"` // Anthropic Messages 接口的根地址（不带 /v1）
	OpenAI    string   `json:"openai,omitempty"`    // OpenAI 兼容接口的根地址（通常以 /v1 结尾）
	Key       string   `json:"key,omitempty"`       // 加密后的 key（见 secret_*.go）
	KeyHint   string   `json:"keyHint,omitempty"`   // key 的末四位，只用来让人认出是哪一把
	Models    []string `json:"models,omitempty"`    // 最近一次「测试连接」拿到的模型 id
	Checked   string   `json:"checked,omitempty"`   // 最近一次测试的时间（RFC3339）
}

// Agent 是一个 agent 的配置：用哪个提供商、默认模型、推理强度、额外环境变量。
// 全部为空 = 按 agent 自己的登录 / 配置启动（Perch 什么都不注入）。
type Agent struct {
	Provider string            `json:"provider,omitempty"`
	Model    string            `json:"model,omitempty"`
	Effort   string            `json:"effort,omitempty"`
	Env      map[string]string `json:"env,omitempty"` // 值是加密的
}

type file struct {
	Version   int              `json:"version"`
	Providers []Provider       `json:"providers"`
	Agents    map[string]Agent `json:"agents"`
}

// Store 持有配置文件。零值不可用；用 Load 构造。
type Store struct {
	mu     sync.Mutex
	path   string
	f      file
	broken bool // 文件在、但解析不了：一次都不许覆盖
}

// Load 读配置文件。不存在 = 空配置（第一次改动时创建）；解析失败 = 内存里为空，
// 但**永远不覆盖**盘上那份（和 settings.Store 同一条规矩）。
func Load(path string) *Store {
	s := &Store{path: path, f: file{Version: 1, Agents: map[string]Agent{}}}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.broken = true
			log.Printf("[providers] ⚠️ 读配置失败（保持原样、不覆盖）：%s（%v）", path, err)
		}
		return s
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		s.broken = true
		log.Printf("[providers] ⚠️ 配置解析失败，保持原样、一次都不覆盖：%s（%v）", path, err)
		return s
	}
	if f.Agents == nil {
		f.Agents = map[string]Agent{}
	}
	s.f = f
	log.Printf("[providers] 载入：%d 个提供商、%d 个 agent 配置（%s）", len(f.Providers), len(f.Agents), path)
	return s
}

// ---- 给界面的视图（不含任何密钥 / 环境变量的值）----

type ProviderView struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Anthropic string   `json:"anthropic"`
	OpenAI    string   `json:"openai"`
	HasKey    bool     `json:"hasKey"`
	KeyHint   string   `json:"keyHint"`
	Models    []string `json:"models"`
	Checked   string   `json:"checked"`
}

type AgentView struct {
	Provider string   `json:"provider"`
	Model    string   `json:"model"`
	Effort   string   `json:"effort"`
	EnvNames []string `json:"envNames"`
}

type View struct {
	Providers []ProviderView       `json:"providers"`
	Agents    map[string]AgentView `json:"agents"`
	Broken    bool                 `json:"broken,omitempty"`
}

// View 返回可以直接发给前端的快照。
func (s *Store) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Providers: []ProviderView{}, Agents: map[string]AgentView{}, Broken: s.broken}
	for _, p := range s.f.Providers {
		v.Providers = append(v.Providers, ProviderView{
			ID: p.ID, Name: p.Name, Anthropic: p.Anthropic, OpenAI: p.OpenAI,
			HasKey: p.Key != "", KeyHint: p.KeyHint, Models: append([]string{}, p.Models...),
			Checked: p.Checked,
		})
	}
	for id, a := range s.f.Agents {
		names := make([]string, 0, len(a.Env))
		for k := range a.Env {
			names = append(names, k)
		}
		sort.Strings(names)
		v.Agents[id] = AgentView{Provider: a.Provider, Model: a.Model, Effort: a.Effort, EnvNames: names}
	}
	return v
}

// ---- 写操作 ----

// ProviderInput 是界面提交的一条提供商。Key 为空 = 保留原来那把；ClearKey = 删掉。
type ProviderInput struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Anthropic string `json:"anthropic"`
	OpenAI    string `json:"openai"`
	Key       string `json:"key"`
	ClearKey  bool   `json:"clearKey"`
}

// SaveProvider 新建或更新一条提供商，返回它的 id。
func (s *Store) SaveProvider(in ProviderInput) (string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return "", fmt.Errorf("提供商需要一个名称")
	}
	ant, err := cleanURL(in.Anthropic)
	if err != nil {
		return "", fmt.Errorf("Anthropic 接口地址：%w", err)
	}
	oai, err := cleanURL(in.OpenAI)
	if err != nil {
		return "", fmt.Errorf("OpenAI 兼容接口地址：%w", err)
	}
	if ant == "" && oai == "" {
		return "", fmt.Errorf("至少填一个接口地址（Anthropic 或 OpenAI 兼容）")
	}
	key := strings.TrimSpace(in.Key)
	sealed := ""
	if key != "" {
		if sealed, err = sealSecret(key); err != nil {
			return "", err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return "", fmt.Errorf("providers.json 解析失败，为了不覆盖它，这次改动没有保存")
	}
	idx := -1
	for i, p := range s.f.Providers {
		if in.ID != "" && p.ID == in.ID {
			idx = i
		}
	}
	if in.ID != "" && idx < 0 {
		return "", fmt.Errorf("找不到提供商 %s", in.ID)
	}
	p := Provider{}
	if idx >= 0 {
		p = s.f.Providers[idx]
	} else {
		p.ID = newID(name, s.f.Providers)
	}
	urlChanged := p.Anthropic != ant || p.OpenAI != oai
	p.Name, p.Anthropic, p.OpenAI = name, ant, oai
	switch {
	case sealed != "":
		p.Key, p.KeyHint = sealed, hint(key)
		p.Models, p.Checked = nil, "" // 换了 key：上次测到的模型不作数
	case in.ClearKey:
		p.Key, p.KeyHint = "", ""
	}
	if urlChanged {
		p.Models, p.Checked = nil, ""
	}
	if idx >= 0 {
		s.f.Providers[idx] = p
	} else {
		s.f.Providers = append(s.f.Providers, p)
	}
	return p.ID, s.saveLocked()
}

// DeleteProvider 删除一条提供商；用它的 agent 回到「agent 自己的配置」（环境变量保留）。
func (s *Store) DeleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return fmt.Errorf("providers.json 解析失败，为了不覆盖它，这次改动没有保存")
	}
	out := s.f.Providers[:0]
	found := false
	for _, p := range s.f.Providers {
		if p.ID == id {
			found = true
			continue
		}
		out = append(out, p)
	}
	if !found {
		return fmt.Errorf("找不到提供商 %s", id)
	}
	s.f.Providers = out
	for aid, a := range s.f.Agents {
		if a.Provider == id {
			a.Provider, a.Model = "", ""
			s.f.Agents[aid] = a
		}
	}
	return s.saveLocked()
}

// SetModels 记下一次测试连接拿到的模型列表。
func (s *Store) SetModels(id string, models []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.f.Providers {
		if p.ID == id {
			s.f.Providers[i].Models = models
			s.f.Providers[i].Checked = time.Now().UTC().Format(time.RFC3339)
			if s.broken {
				return nil
			}
			return s.saveLocked()
		}
	}
	return fmt.Errorf("找不到提供商 %s", id)
}

// AgentInput 是界面提交的一个 agent 配置。EnvSet 里的值会被加密；EnvRemove 按名删。
// 值为空的 EnvSet 条目会被忽略（"留空 = 不改"，Orca 的只写语义）。
type AgentInput struct {
	Provider  string            `json:"provider"`
	Model     string            `json:"model"`
	Effort    string            `json:"effort"`
	EnvSet    map[string]string `json:"envSet"`
	EnvRemove []string          `json:"envRemove"`
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Efforts 是界面给的推理强度档位（只有 Claude Code 和 Codex 能吃）。
var Efforts = []string{"low", "medium", "high", "xhigh", "max"}

// SetAgent 改一个 agent 的配置。
func (s *Store) SetAgent(id string, in AgentInput) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("缺少 agent id")
	}
	eff := strings.ToLower(strings.TrimSpace(in.Effort))
	if eff != "" && !contains(Efforts, eff) {
		return fmt.Errorf("不认识的推理强度 %q", in.Effort)
	}
	set := map[string]string{}
	for k, v := range in.EnvSet {
		k = strings.TrimSpace(k)
		if !envName.MatchString(k) {
			return fmt.Errorf("环境变量名 %q 不合法（只能是字母、数字、下划线，且不以数字开头）", k)
		}
		if v == "" {
			continue
		}
		sv, err := sealSecret(v)
		if err != nil {
			return err
		}
		set[k] = sv
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return fmt.Errorf("providers.json 解析失败，为了不覆盖它，这次改动没有保存")
	}
	if in.Provider != "" && s.providerLocked(in.Provider) == nil {
		return fmt.Errorf("找不到提供商 %s", in.Provider)
	}
	a := s.f.Agents[id]
	a.Provider = in.Provider
	a.Model = strings.TrimSpace(in.Model)
	a.Effort = eff
	if a.Env == nil {
		a.Env = map[string]string{}
	}
	// Windows 的环境变量名不分大小写：同名不同写法只留一条（Orca 也这么做）。
	for _, rm := range in.EnvRemove {
		for k := range a.Env {
			if strings.EqualFold(k, rm) {
				delete(a.Env, k)
			}
		}
	}
	for k, v := range set {
		for old := range a.Env {
			if strings.EqualFold(old, k) {
				delete(a.Env, old)
			}
		}
		a.Env[k] = v
	}
	if len(a.Env) == 0 {
		a.Env = nil
	}
	if a.Provider == "" && a.Model == "" && a.Effort == "" && len(a.Env) == 0 {
		delete(s.f.Agents, id)
	} else {
		s.f.Agents[id] = a
	}
	return s.saveLocked()
}

// ---- 启动时用 ----

// Resolved 是一个 agent 解密后的完整配置。Provider 为 nil = 没选提供商。
type Resolved struct {
	Provider *Provider
	Key      string
	Model    string
	Effort   string
	Env      map[string]string
}

// Resolve 解出 agent 的配置。ok=false 表示这个 agent 什么都没配。
func (s *Store) Resolve(agentID string) (Resolved, bool, error) {
	s.mu.Lock()
	a, ok := s.f.Agents[agentID]
	var p *Provider
	if ok && a.Provider != "" {
		if pp := s.providerLocked(a.Provider); pp != nil {
			cp := *pp
			p = &cp
		}
	}
	s.mu.Unlock()
	if !ok {
		return Resolved{}, false, nil
	}
	r := Resolved{Provider: p, Model: a.Model, Effort: a.Effort, Env: map[string]string{}}
	if a.Provider != "" && p == nil {
		return r, false, fmt.Errorf("这个 agent 选的提供商已经不在了，请在设置 › Agents 里重新选")
	}
	if p != nil && p.Key != "" {
		k, err := openSecret(p.Key)
		if err != nil {
			return r, false, fmt.Errorf("提供商「%s」的 key 解不开：%w", p.Name, err)
		}
		r.Key = k
	}
	for k, v := range a.Env {
		pv, err := openSecret(v)
		if err != nil {
			return r, false, fmt.Errorf("环境变量 %s 的值解不开：%w", k, err)
		}
		r.Env[k] = pv
	}
	return r, p != nil || len(r.Env) > 0 || r.Model != "" || r.Effort != "", nil
}

// ProviderSecret 给「测试连接」用：按 id 取地址和解密后的 key。
func (s *Store) ProviderSecret(id string) (Provider, string, error) {
	s.mu.Lock()
	p := s.providerLocked(id)
	var cp Provider
	if p != nil {
		cp = *p
	}
	s.mu.Unlock()
	if p == nil {
		return Provider{}, "", fmt.Errorf("找不到提供商 %s", id)
	}
	k, err := openSecret(cp.Key)
	return cp, k, err
}

// ---- 内部 ----

func (s *Store) providerLocked(id string) *Provider {
	for i := range s.f.Providers {
		if s.f.Providers[i].ID == id {
			return &s.f.Providers[i]
		}
	}
	return nil
}

func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func cleanURL(raw string) (string, error) {
	v := strings.TrimRight(strings.TrimSpace(raw), "/")
	if v == "" {
		return "", nil
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("%q 不是 http(s) 地址", raw)
	}
	return v, nil
}

var idClean = regexp.MustCompile(`[^a-z0-9]+`)

func newID(name string, existing []Provider) string {
	base := strings.Trim(idClean.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if base == "" {
		base = "provider"
	}
	id := base
	for n := 2; ; n++ {
		taken := false
		for _, p := range existing {
			if p.ID == id {
				taken = true
				break
			}
		}
		if !taken {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}
}

func hint(key string) string {
	r := []rune(key)
	if len(r) <= 4 {
		return "…"
	}
	return "…" + string(r[len(r)-4:])
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
