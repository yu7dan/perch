package main

import (
	"github.com/yu7dan/perch/internal/agent"
)

// 这一层只做两件事：把主程序的旧名字接到 internal/agent 的公开类型上，
// 以及把标签表/前端推送/可执行文件解析这几样宿主能力交给适配器。

type agentDef = agent.Def
type resumeIntent = agent.ResumeIntent
type agentCaps = agent.Caps

// 主程序的 Claude 状态腿仍用旧名字读这些常量；值只来自 internal/agent。
const (
	agentStateWorking     = agent.StateWorking
	agentStateWaiting     = agent.StateWaiting
	agentStateDone        = agent.StateDone
	agentEvidenceHook     = agent.EvidenceHook
	agentEvidenceRegistry = agent.EvidenceRegistry
)

// capsForAgent 决定 Agent 名单上那一行该说什么：Launch 看主程序的完整名单，
// 状态能力看适配器表。
func capsForAgent(id string) agentCaps {
	_, canLaunch := agentDefs[id]
	return agent.CapsFor(id, canLaunch)
}

// buildEnv 让主程序和适配器共用同一份终端环境规则。
func buildEnv(extra map[string]string) []string { return agent.BuildEnv(extra) }

// rootAgentHost 把适配器需要的最小表面接回主程序。
type rootAgentHost struct{}

func (rootAgentHost) BindSession(tabID int, sid, name, agentID string) bool {
	return tabs.bindSession(tabID, sid, name, agentID)
}

func (rootAgentHost) RebindSession(tabID int, sid, name, agentID string) bool {
	return tabs.rebindSession(tabID, sid, name, agentID)
}

func (rootAgentHost) SetStatus(tabID int, status string) (string, bool) {
	return tabs.setStatus(tabID, status)
}

func (rootAgentHost) Push(v any) { pushJSON(v) }

func (rootAgentHost) ResolveExe(bin string) (string, []string) {
	return resolveAgentExe(bin)
}
