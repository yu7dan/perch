// Package agentprofile 存 Perch 自己的 per-agent 配置（模型/档位）。
//
// 它和 agent 自己的全局配置是两回事：这里只记“Perch 拉起这一格时用什么”，
// 由 internal/gateway 在开格时注入，**永远不写** ~/.claude、~/.codex 等文件。
// 每个 agent 一份，模型指向 Perch 网关里的稳定别名（group/perch-<agent>），
// 这样换模型只改网关路由，运行中的会话下一轮就生效。
package agentprofile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// TierProfile 是一个 Claude 模型档位（opus/sonnet/haiku/fable）自己的
// 模型和推理强度；空表示跟随主模型。
type TierProfile struct {
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
}

// Profile 是一个 agent 的 Perch 侧配置。
type Profile struct {
	Agent  string `json:"agent"`
	Alias  string `json:"alias,omitempty"`  // group/perch-<agent>
	Model  string `json:"model,omitempty"`  // 网关目录里的 provider/model
	Effort string `json:"effort,omitempty"` // 推理强度（magpie 的 effort）
	// Tiers 只有 Claude 用：opus/sonnet/haiku/fable 各自可以指向不同的
	// 网关模型/推理强度；没有的键跟随 Model/Effort。
	Tiers map[string]TierProfile `json:"tiers,omitempty"`
	// Hidden 是这个 agent 的模型选择器里被收起的模型 id。当前主模型/档位
	// 模型始终显示，不会被 Hidden 藏掉。
	Hidden []string `json:"hidden,omitempty"`
}

// AliasFor 是 Perch 给 agent 的稳定模型别名。只保留字母数字和连字符，
// 避免 group 名里出现奇怪字符。
func AliasFor(agent string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(agent) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	id := strings.Trim(b.String(), "-")
	if id == "" {
		id = "agent"
	}
	return "group/perch-" + id
}

// Store 是一份 JSON 文件；零值不可用，用 Load。
type Store struct {
	path string
	mu   sync.Mutex
	m    map[string]Profile
}

// Load 读配置；文件不存在/损坏都按空表处理（配置是用户态，不该挡住启动）。
func Load(path string) *Store {
	s := &Store{path: path, m: map[string]Profile{}}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var m map[string]Profile
	if json.Unmarshal(b, &m) != nil {
		return s
	}
	for id, p := range m {
		if p.Agent == "" {
			p.Agent = id
		}
		s.m[id] = p
	}
	return s
}

func cloneProfile(p Profile) Profile {
	if p.Tiers != nil {
		m := make(map[string]TierProfile, len(p.Tiers))
		for k, v := range p.Tiers {
			m[k] = v
		}
		p.Tiers = m
	}
	if p.Hidden != nil {
		p.Hidden = append([]string(nil), p.Hidden...)
	}
	return p
}

func (s *Store) Get(agent string) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[agent]
	return cloneProfile(p), ok
}

// Set 写一份配置并落盘。空 Model 是“清掉这个 agent 的 Perch 配置”。
func (s *Store) Set(p Profile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.Agent == "" {
		return nil
	}
	if strings.TrimSpace(p.Model) == "" {
		delete(s.m, p.Agent)
	} else {
		s.m[p.Agent] = cloneProfile(p)
	}
	return s.saveLocked()
}

// SetHidden 记录这个 agent 的模型选择器里收起的模型 id；去重、去空。
func (s *Store) SetHidden(agent string, hidden []string) (Profile, error) {
	agent = strings.TrimSpace(agent)
	if agent == "" {
		return Profile{}, fmt.Errorf("缺少 agent")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[agent]
	if !ok || strings.TrimSpace(p.Model) == "" {
		return Profile{}, fmt.Errorf("先给 %s 选一个主模型", agent)
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(hidden))
	for _, id := range hidden {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		p.Hidden = nil
	} else {
		p.Hidden = out
	}
	s.m[agent] = cloneProfile(p)
	return cloneProfile(p), s.saveLocked()
}

// SetTier 改一个 Claude 档位的模型/推理强度；空 model 是回到跟随主模型。
// 没有主模型时拒绝 —— 只设一个档位没有可注入的东西。
func (s *Store) SetTier(agent, tier, model, effort string) (Profile, error) {
	agent, tier = strings.TrimSpace(agent), strings.ToLower(strings.TrimSpace(tier))
	model, effort = strings.TrimSpace(model), strings.ToLower(strings.TrimSpace(effort))
	if agent == "" || tier == "" {
		return Profile{}, fmt.Errorf("缺少 agent 或档位")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[agent]
	if !ok || strings.TrimSpace(p.Model) == "" {
		return Profile{}, fmt.Errorf("先给 %s 选一个主模型", agent)
	}
	if model == "" {
		delete(p.Tiers, tier)
		if len(p.Tiers) == 0 {
			p.Tiers = nil
		}
	} else {
		if p.Tiers == nil {
			p.Tiers = map[string]TierProfile{}
		}
		p.Tiers[tier] = TierProfile{Model: model, Effort: effort}
	}
	s.m[agent] = cloneProfile(p)
	return cloneProfile(p), s.saveLocked()
}

// All 按 agent id 排序返回，给 UI 用。
func (s *Store) All() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Profile, 0, len(s.m))
	for _, p := range s.m {
		out = append(out, cloneProfile(p))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Agent < out[j].Agent })
	return out
}

func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
