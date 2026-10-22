package ctl

// Perch 自己的 per-agent 配置（隔离网关）。
//
// 和 magpie 的 gw.agent.set 不同：这里不写 ~/.claude/settings.json 也不写
// ~/.codex/config.toml。写入的是 %APPDATA%\Perch\agent-profiles.json，
// 开格时由 session.Manager 注入到那一格（见 internal/gateway/agent_profile.go）。

import (
	"log"

	"github.com/yu7dan/perch/internal/agentprofile"
	"github.com/yu7dan/perch/internal/gateway"
)

func (s *Server) handleAgentProfile(m *Msg) {
	switch m.Type {
	case "agent.profiles":
		go s.pushAgentProfiles()
	case "agent.profile.set":
		go s.setAgentProfile(trimSpace(m.ID), trimSpace(m.Value), trimSpace(m.Effort))
	}
}

func (s *Server) pushAgentProfiles() {
	out := map[string]any{
		"type":     "agent.profiles",
		"isolated": false,
		"agents":   []agentprofile.Profile{},
		"models":   []gateway.AgentModel{},
	}
	if s.deps.Gateway != nil {
		out["isolated"] = s.deps.Gateway.Isolated()
	}
	if s.deps.Profiles != nil {
		out["agents"] = s.deps.Profiles.All()
	}
	if s.deps.Gateway == nil || !s.deps.Gateway.Isolated() {
		s.Push(out)
		return
	}
	models, err := s.deps.Gateway.AgentModels()
	if err != nil {
		s.Push(withUIErr(out, err))
		return
	}
	if models != nil {
		out["models"] = models
	}
	s.Push(out)
}

func (s *Server) setAgentProfile(id, model, effort string) {
	if id == "" || s.deps.Profiles == nil {
		return
	}
	old, hadOld := s.deps.Profiles.Get(id)
	p := agentprofile.Profile{
		Agent:  id,
		Alias:  agentprofile.AliasFor(id),
		Model:  model,
		Effort: effort,
	}
	if err := s.deps.Profiles.Set(p); err != nil {
		log.Printf("[agentprofile] 保存 %s 失败：%v", id, err)
		s.Push(withUIErr(map[string]any{"type": "agent.profiles"}, err))
		return
	}
	if model != "" && s.deps.Gateway != nil && s.deps.Gateway.Isolated() {
		if err := s.deps.Gateway.EnsureAgentGroup(p.Alias, p.Model, p.Effort); err != nil {
			log.Printf("[agentprofile] %s 的网关路由组设置失败：%v", id, err)
			// 回退到旧配置，别让 UI/磁盘和网关路由各说各话。
			if hadOld {
				_ = s.deps.Profiles.Set(old)
			} else {
				_ = s.deps.Profiles.Set(agentprofile.Profile{Agent: id})
			}
			models, _ := s.deps.Gateway.AgentModels()
			if models == nil {
				models = []gateway.AgentModel{}
			}
			s.Push(withUIErr(map[string]any{
				"type":     "agent.profiles",
				"isolated": true,
				"agents":   s.deps.Profiles.All(),
				"models":   models,
			}, err))
			return
		}
	}
	log.Printf("[agentprofile] %s -> %s", id, model)
	s.pushAgentProfiles()
}
