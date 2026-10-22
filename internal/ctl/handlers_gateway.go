package ctl

// 网关（magpie）的控制消息。全部是无状态的转发：真正的 HTTP、进程与
// 状态机在 internal/gateway；这里只决定"换不换协程"。
//
// 换协程的判据是"会不会阻塞 ctl 收包"：HTTP 最长 5 × 1.8s、安装可能跑
// 几分钟 —— 这些一律 `go`。Stop 不换（它只是取消上下文/收进程，毫秒级）。

import (
	"log"

	"github.com/yu7dan/perch/internal/gateway"
)

func (s *Server) handleGateway(m *Msg) {
	switch m.Type {
	case "magpie.refresh":
		// 用户点刷新：立刻跑一轮（后台 watcher 仍在按自己的节奏走）。
		go func() {
			s.deps.Gateway.RefreshNow()
			log.Printf("[magpie] 手动刷新完成")
		}()
	case "gw.connect", "gw.engine.start":
		go s.deps.Gateway.StartEngine()
	case "gw.disconnect", "gw.engine.stop":
		s.deps.Gateway.Stop()
	case "gw.engine.restart":
		go func() {
			s.deps.Gateway.Stop()
			s.deps.Gateway.StartEngine()
		}()
	case "gw.refresh":
		go s.deps.Gateway.Refresh()
	case "gw.providers":
		go s.deps.Gateway.ProviderList()
	case "gw.usage":
		go s.deps.Gateway.Usage(trimSpace(m.Period))
	case "gw.provider.save":
		in := gateway.ProviderInput{
			ID:        trimSpace(m.ProviderID),
			Name:      trimSpace(m.Name),
			Preset:    trimSpace(m.Preset),
			Protocol:  trimSpace(m.Protocol),
			BaseURL:   trimSpace(m.BaseURL),
			Key:       m.Key,
			Models:    m.Models,
			Endpoints: m.Endpoints,
		}
		go s.deps.Gateway.SaveProvider(in)
	case "gw.provider.delete":
		go s.deps.Gateway.DeleteProvider(trimSpace(m.ProviderID))
	case "gw.credential.test":
		go s.deps.Gateway.TestCredential(trimSpace(m.ProviderID), trimSpace(m.CredentialID))
	// Agent 接线（总览 → Agent 工作台 → 行内详情）。
	// 只读一次 /api/state 就能拿全部字段；写操作全是用户点出来的。
	case "gw.agents":
		go s.deps.Gateway.AgentState()
	case "gw.agents.rescan":
		go s.deps.Gateway.AgentRescan()
	case "gw.agents.prefetch":
		// 进总览时预取：只在用过网关的机器上接/拉起控制面。
		go s.deps.Gateway.AgentPrefetch()
	case "gw.agent.set":
		go s.deps.Gateway.AgentSet(trimSpace(m.ID), trimSpace(m.Field), m.Value)
	case "gw.agent.connect":
		go s.deps.Gateway.AgentAction("connect", trimSpace(m.ID))
	case "gw.agent.disconnect":
		go s.deps.Gateway.AgentAction("disconnect", trimSpace(m.ID))
	case "gw.agent.reapply":
		go s.deps.Gateway.AgentAction("reapply", trimSpace(m.ID))
	case "gw.agent.keep":
		// 「保留现状」：magpie 删掉 applied 记录，把现在的配置认作它写的。
		go s.deps.Gateway.AgentAction("keep", trimSpace(m.ID))
	case "gw.agent.preview":
		go s.deps.Gateway.AgentPreview(trimSpace(m.ID))
	case "gw.agents.drift":
		// 抽屉开着时的漂移轮询（15s 一次）：只读 /api/drift，不拉起控制面。
		go s.deps.Gateway.AgentDrift()
	}
}
