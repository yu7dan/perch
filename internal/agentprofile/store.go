// Package agentprofile 存 Perch 自己的 per-agent 配置（模型/档位）。
//
// 它和 agent 自己的全局配置是两回事：这里只记“Perch 拉起这一格时用什么”，
// 由 internal/gateway 在开格时注入，**永远不写** ~/.claude、~/.codex 等文件。
// 每个 agent 一份，模型指向 Perch 网关里的稳定别名（group/perch-<agent>），
// 这样换模型只改网关路由，运行中的会话下一轮就生效。
package agentprofile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Profile 是一个 agent 的 Perch 侧配置。
type Profile struct {
	Agent  string `json:"agent"`
	Alias  string `json:"alias,omitempty"`  // group/perch-<agent>
	Model  string `json:"model,omitempty"`  // 网关目录里的 provider/model
	Effort string `json:"effort,omitempty"` // 档位；先存，live 生效随后接
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

func (s *Store) Get(agent string) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[agent]
	return p, ok
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
		s.m[p.Agent] = p
	}
	return s.saveLocked()
}

// All 按 agent id 排序返回，给 UI 用。
func (s *Store) All() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Profile, 0, len(s.m))
	for _, p := range s.m {
		out = append(out, p)
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
