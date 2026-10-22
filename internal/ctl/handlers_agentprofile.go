package ctl

// Perch 自己的 per-agent 配置（隔离网关）。
//
// 和 magpie 的 gw.agent.set 不同：这里不写 ~/.claude/settings.json 也不写
// ~/.codex/config.toml。写入的是 %APPDATA%\Perch\agent-profiles.json，
// 开格时由 session.Manager 注入到那一格（见 internal/gateway/agent_profile.go）。

import (
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/yu7dan/perch/internal/agentprofile"
	"github.com/yu7dan/perch/internal/gateway"
	"github.com/yu7dan/perch/internal/uimsg"
)

// 所有 per-agent 配置的写操作串行化：保存方案、应用方案、单选模型
// 可能被用户连点，别让两份写入交错。
var agentProfileOps sync.Mutex

func (s *Server) handleAgentProfile(m *Msg) {
	switch m.Type {
	case "agent.profiles":
		go s.pushAgentProfiles()
	case "agent.profile.set":
		go s.setAgentProfile(trimSpace(m.ID), trimSpace(m.Value), trimSpace(m.Effort))
	case "agent.profile.tier":
		go s.setAgentTier(trimSpace(m.ID), trimSpace(m.Tier), trimSpace(m.Value), trimSpace(m.Effort))
	case "agent.profile.models":
		go s.setAgentModels(trimSpace(m.ID), m.Hidden)
	case "agent.profile.save":
		go s.saveAgentProfileSet(trimSpace(m.SetName))
	case "agent.profile.use":
		go s.useAgentProfileSet(trimSpace(m.SetName))
	case "agent.profile.delete":
		go s.deleteAgentProfileSet(trimSpace(m.SetName))
	}
}

func (s *Server) pushAgentProfiles() {
	s.pushAgentProfilesErr(nil)
}

func (s *Server) pushAgentProfilesErr(cause error) {
	out := map[string]any{
		"type":     "agent.profiles",
		"isolated": false,
		"agents":   []agentprofile.Profile{},
		"models":   []gateway.AgentModel{},
		"sets":     []agentprofile.SetInfo{},
	}
	if s.deps.Gateway != nil {
		out["isolated"] = s.deps.Gateway.Isolated()
	}
	if s.deps.Profiles != nil {
		out["agents"] = s.deps.Profiles.All()
	}
	if s.deps.ProfileSets != nil {
		out["sets"] = s.deps.ProfileSets.List()
	}
	if s.deps.Gateway == nil || !s.deps.Gateway.Isolated() {
		if cause != nil {
			s.Push(withUIErr(out, cause))
		} else {
			s.Push(out)
		}
		return
	}
	// 先把隔离模式和现有配置推过去，让 UI 立刻切成 Perch 的 Agent 板；
	// 引擎首次启动/模型目录可能要几十秒，不能把整条推送堵在 AgentModels 里。
	s.Push(out)
	models, err := s.deps.Gateway.AgentModels()
	if err != nil {
		s.Push(withUIErr(out, err))
		return
	}
	if models != nil {
		out["models"] = models
	}
	if cause != nil {
		s.Push(withUIErr(out, cause))
		return
	}
	s.Push(out)
}

func (s *Server) setAgentProfile(id, model, effort string) {
	if id == "" || s.deps.Profiles == nil {
		return
	}
	agentProfileOps.Lock()
	defer agentProfileOps.Unlock()
	old, hadOld := s.deps.Profiles.Get(id)
	p := agentprofile.Profile{
		Agent:  id,
		Alias:  agentprofile.AliasFor(id),
		Model:  model,
		Effort: effort,
	}
	// 换主模型不要顺手把各档位自己的模型、模型列表的隐藏项清掉。
	if hadOld {
		p.Tiers = old.Tiers
		p.Hidden = old.Hidden
	}
	if err := s.deps.Profiles.Set(p); err != nil {
		log.Printf("[agentprofile] 保存 %s 失败：%v", id, err)
		s.pushAgentProfilesErr(err)
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
			s.pushAgentProfilesErr(err)
			return
		}
	}
	log.Printf("[agentprofile] %s -> %s（档位 %q）", id, model, effort)
	s.pushAgentProfiles()
}

// setAgentTier 改 Claude 某个档位（opus/sonnet/haiku/fable）的模型/推理强度。
// 空 model 是清掉这档，让它跟随主模型；网关里对应的稳定组不再使用。
func (s *Server) setAgentTier(id, tier, model, effort string) {
	if id == "" || tier == "" || s.deps.Profiles == nil {
		return
	}
	if gateway.ClaudeTierEnvKey(tier) == "" {
		s.pushAgentProfilesErr(uimsg.NewParams("gw.agentTierBad",
			"不认识的档位："+tier, map[string]string{"tier": tier}))
		return
	}
	agentProfileOps.Lock()
	old, ok := s.deps.Profiles.Get(id)
	if !ok || old.Model == "" {
		agentProfileOps.Unlock()
		s.pushAgentProfilesErr(uimsg.New("gw.agentProfileBad", "先给这个 agent 选一个主模型"))
		return
	}
	oldTier, hadTier := old.Tiers[strings.ToLower(tier)]
	if _, err := s.deps.Profiles.SetTier(id, tier, model, effort); err != nil {
		agentProfileOps.Unlock()
		s.pushAgentProfilesErr(err)
		return
	}
	if model != "" && s.deps.Gateway != nil && s.deps.Gateway.Isolated() {
		alias := old.Alias
		if alias == "" {
			alias = agentprofile.AliasFor(id)
		}
		if err := s.deps.Gateway.EnsureAgentGroup(gateway.ClaudeTierAlias(alias, tier), model, effort); err != nil {
			// 回退这一档，别让 UI/磁盘和网关各说各话。
			if hadTier {
				_, _ = s.deps.Profiles.SetTier(id, tier, oldTier.Model, oldTier.Effort)
			} else {
				_, _ = s.deps.Profiles.SetTier(id, tier, "", "")
			}
			agentProfileOps.Unlock()
			s.pushAgentProfilesErr(err)
			return
		}
	}
	agentProfileOps.Unlock()
	log.Printf("[agentprofile] %s 档位 %s -> %s（推理强度 %q）", id, tier, model, effort)
	s.pushAgentProfiles()
}

// setAgentModels 记下这个 agent 的模型选择器里要收起的模型。
func (s *Server) setAgentModels(id string, hidden []string) {
	if id == "" || s.deps.Profiles == nil {
		return
	}
	agentProfileOps.Lock()
	_, err := s.deps.Profiles.SetHidden(id, hidden)
	agentProfileOps.Unlock()
	if err != nil {
		s.pushAgentProfilesErr(err)
		return
	}
	log.Printf("[agentprofile] %s 隐藏 %d 个模型", id, len(hidden))
	s.pushAgentProfiles()
}

// saveAgentProfileSet 把当前所有 agent 的模型/档位存成一套方案。
func (s *Server) saveAgentProfileSet(name string) {
	if name == "" {
		s.pushAgentProfilesErr(uimsg.New("gw.agentProfileSetName", "方案名不能为空"))
		return
	}
	if s.deps.Profiles == nil || s.deps.ProfileSets == nil {
		s.pushAgentProfilesErr(uimsg.New("gw.agentProfileSetBad", "当前不支持配置方案"))
		return
	}
	agentProfileOps.Lock()
	agents := s.deps.Profiles.All()
	err := s.deps.ProfileSets.Save(name, agents)
	agentProfileOps.Unlock()
	if err != nil {
		log.Printf("[agentprofile] 保存方案 %q 失败：%v", name, err)
		s.pushAgentProfilesErr(uimsg.Wrap(err, "gw.agentProfileSetSave",
			"保存配置方案失败："+err.Error(), map[string]string{"err": err.Error()}))
		return
	}
	log.Printf("[agentprofile] 已保存方案 %q（%d 个 agent）", name, len(agents))
	s.pushAgentProfiles()
}

// applyAgentProfile 写入一份配置，并同步网关里的稳定别名组。
func (s *Server) applyAgentProfile(p agentprofile.Profile) error {
	if p.Agent == "" {
		return nil
	}
	if p.Alias == "" {
		p.Alias = agentprofile.AliasFor(p.Agent)
	}
	if err := s.deps.Profiles.Set(p); err != nil {
		return err
	}
	if p.Model != "" && s.deps.Gateway != nil && s.deps.Gateway.Isolated() {
		if err := s.deps.Gateway.EnsureAgentGroup(p.Alias, p.Model, p.Effort); err != nil {
			return err
		}
		for tier, tp := range p.Tiers {
			if tp.Model == "" || gateway.ClaudeTierEnvKey(tier) == "" {
				continue
			}
			if err := s.deps.Gateway.EnsureAgentGroup(
				gateway.ClaudeTierAlias(p.Alias, tier), tp.Model, tp.Effort); err != nil {
				return err
			}
		}
	}
	return nil
}

// useAgentProfileSet 应用一套方案。所有写入在锁内完成；中途失败就把
// 旧配置写回去，别让 UI、磁盘和网关路由各说各话。
func (s *Server) useAgentProfileSet(name string) {
	if name == "" {
		s.pushAgentProfilesErr(uimsg.New("gw.agentProfileSetName", "方案名不能为空"))
		return
	}
	if s.deps.Profiles == nil || s.deps.ProfileSets == nil {
		s.pushAgentProfilesErr(uimsg.New("gw.agentProfileSetBad", "当前不支持配置方案"))
		return
	}
	agents, ok := s.deps.ProfileSets.Get(name)
	if !ok || len(agents) == 0 {
		s.pushAgentProfilesErr(uimsg.NewParams("gw.agentProfileSetMissing",
			fmt.Sprintf("找不到配置方案：%s", name), map[string]string{"name": name}))
		return
	}
	agentProfileOps.Lock()
	old := s.deps.Profiles.All()
	oldByAgent := make(map[string]agentprofile.Profile, len(old))
	for _, p := range old {
		oldByAgent[p.Agent] = p
	}
	inSet := make(map[string]bool, len(agents))
	touched := make(map[string]bool, len(agents)+len(old))
	for _, p := range agents {
		inSet[p.Agent] = true
		touched[p.Agent] = true
	}
	var failed error
	// 方案是完整快照：当前有、方案里没有的 agent 回到未设置。
	for _, p := range old {
		if inSet[p.Agent] {
			continue
		}
		touched[p.Agent] = true
		if err := s.applyAgentProfile(agentprofile.Profile{Agent: p.Agent}); err != nil {
			failed = err
			break
		}
	}
	if failed == nil {
		for _, p := range agents {
			if err := s.applyAgentProfile(p); err != nil {
				failed = err
				break
			}
		}
	}
	if failed != nil {
		// 回滚：方案里碰过的 agent 全部回到旧值；旧值没有的删掉。
		for id := range touched {
			was, had := oldByAgent[id]
			if !had {
				was = agentprofile.Profile{Agent: id}
			}
			_ = s.applyAgentProfile(was)
		}
		agentProfileOps.Unlock()
		log.Printf("[agentprofile] 应用方案 %q 失败：%v", name, failed)
		s.pushAgentProfilesErr(uimsg.Wrap(failed, "gw.agentProfileUse",
			"应用配置方案失败："+failed.Error(), map[string]string{"err": failed.Error()}))
		return
	}
	agentProfileOps.Unlock()
	log.Printf("[agentprofile] 已应用方案 %q（%d 个 agent）", name, len(agents))
	s.pushAgentProfiles()
}

func (s *Server) deleteAgentProfileSet(name string) {
	if name == "" || s.deps.ProfileSets == nil {
		return
	}
	agentProfileOps.Lock()
	err := s.deps.ProfileSets.Delete(name)
	agentProfileOps.Unlock()
	if err != nil {
		s.pushAgentProfilesErr(uimsg.Wrap(err, "gw.agentProfileSetSave",
			"删除配置方案失败："+err.Error(), map[string]string{"err": err.Error()}))
		return
	}
	log.Printf("[agentprofile] 已删除方案 %q", name)
	s.pushAgentProfiles()
}
