package ctl

import "log"

// pane.model：格头上那颗模型按钮（台面 0.1.1）。决定权在组合根（SwitchModel）：
// 走转发层的格子就地换（mode=relay），别的回 mode=restart 让前端用同一个 paneId 接回会话重开。
func (s *Server) paneModel(m *Msg) {
	out := map[string]any{"type": "pane.model", "req": m.Req, "pane": m.Pane, "providerId": m.ProviderID, "model": m.Model}
	if s.deps.SwitchModel == nil {
		out["mode"] = "restart"
		s.Push(out)
		return
	}
	mode, err := s.deps.SwitchModel(m.Pane, m.AgentID, m.ProviderID, m.Model)
	if err != nil {
		out["err"] = err.Error()
		log.Printf("[model] pane=%d 换模型失败：%v", m.Pane, err)
	}
	out["mode"] = mode
	log.Printf("[model] pane=%d agent=%s → %s / %s（%s）", m.Pane, m.AgentID, m.ProviderID, m.Model, mode)
	s.Push(out)
}
