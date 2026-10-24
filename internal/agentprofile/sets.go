package agentprofile

// 配置方案（Profiles）：把当前所有 agent 的模型/档位存成一套，之后一键切回。
//
// 它只存 Perch 自己的 per-agent 配置快照，不碰供应商、不碰 agent 的全局
// 配置文件。应用一套方案时，ctl 会把每个 Profile 写回 Store，并更新网关里
// 对应的稳定别名组；运行中的会话下一轮走新目标，不用重启。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// SetInfo 是给 UI 的一套方案：名字 + 这套方案里的 agent 配置。
type SetInfo struct {
	Name   string    `json:"name"`
	Agents []Profile `json:"agents"`
}

// SetStore 是一份 JSON 文件：名字 → agent 配置快照。零值不可用，用 LoadSets。
type SetStore struct {
	path string
	mu   sync.Mutex
	m    map[string][]Profile
}

// LoadSets 读方案文件；文件不存在/损坏都按空表处理。
func LoadSets(path string) *SetStore {
	s := &SetStore{path: path, m: map[string][]Profile{}}
	if path == "" {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var m map[string][]Profile
	if json.Unmarshal(b, &m) != nil {
		return s
	}
	for name, agents := range m {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		s.m[name] = append([]Profile(nil), agents...)
	}
	return s
}

// List 按名字排序返回所有方案。
func (s *SetStore) List() []SetInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SetInfo, 0, len(s.m))
	for name, agents := range s.m {
		out = append(out, SetInfo{Name: name, Agents: append([]Profile(nil), agents...)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Get 取一套方案。
func (s *SetStore) Get(name string) ([]Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	agents, ok := s.m[name]
	return append([]Profile(nil), agents...), ok
}

// Save 新增/覆盖一套方案。名字不能为空；空方案没有意义，也拒绝。
func (s *SetStore) Save(name string, agents []Profile) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("方案名不能为空")
	}
	if len(strings.TrimSpace(name)) > 60 {
		return fmt.Errorf("方案名太长了（最多 60 个字符）")
	}
	if len(agents) == 0 {
		return fmt.Errorf("当前还没有可保存的 agent 配置")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[name] = append([]Profile(nil), agents...)
	return s.saveLocked()
}

// Delete 删掉一套方案；不存在也算成功（幂等）。
func (s *SetStore) Delete(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[name]; !ok {
		return nil
	}
	delete(s.m, name)
	return s.saveLocked()
}

func (s *SetStore) saveLocked() error {
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
