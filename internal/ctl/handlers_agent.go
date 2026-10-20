package ctl

import (
	"log"

	"github.com/yu7dan/perch/internal/agentstate"
)

// agentReadiness 是前端首屏分类的落点（Cursor 还有一条 Go 侧 whoami 探测，
// 两条都写同一个字段）。
//
// 护栏：paneId 必须对应一个**现在活着**的格子，且 agent 对得上 —— 前端不能
// 凭空给名单里任何一个 agent 写“已就绪”。来源只记分类和来源名，不记屏幕文本。
func (s *Server) agentReadiness(m *Msg) {
	if s.deps.AgentState == nil || s.deps.Tabs == nil {
		return
	}
	readiness := m.Readiness
	switch readiness {
	case "ready", "needs-login", "needs-key", "needs-setup", "unknown":
	default:
		return
	}
	agent, ok := s.deps.Tabs.AgentForPane(m.Pane)
	if !ok || agent == "" {
		return
	}
	if m.Agent != "" && m.Agent != agent {
		log.Printf("[agentstate] 忽略就绪上报：pane=%d 跑的是 %s，上报的是 %s", m.Pane, agent, m.Agent)
		return
	}
	source := m.Source
	if source == "" {
		source = "screen"
	}
	s.deps.AgentState.RecordReadiness(agent, readiness, source)
	// 认出来是“要登录”时留一条日志；认成 ready 不记正文（屏幕里可能有账号名）。
	if readiness != "ready" {
		log.Printf("[agentstate] %s pane=%d 就绪=%s（来源=%s）", agent, m.Pane, readiness, source)
	}
}

// agentStatus 记“标题这条腿已经给出过状态”。它和结构化状态（hook/http/…）
// 分开写机制，UI 才能如实标成「标题（弱）」。
func (s *Server) agentStatus(m *Msg) {
	if s.deps.AgentState == nil || s.deps.Tabs == nil || m.Mechanism != "title" {
		return
	}
	agent, ok := s.deps.Tabs.AgentForPane(m.Pane)
	if !ok || agent == "" {
		return
	}
	if m.Agent != "" && m.Agent != agent {
		return
	}
	s.deps.AgentState.SetStep(agent, agentstate.StepStatus, agentstate.Step{
		State:     agentstate.StepDone,
		Mechanism: "title",
		Source:    "title",
		Verified:  true,
		Evidence:  "pane",
	})
}
