package main

import (
	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/agentcatalog"
)

// 这一层把主程序的旧名字接到 internal/agent 的公开类型上。
// Host 的实现已经搬进 internal/session（Manager），由 main 在组合期 SetHost。

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

// capsForAgent 决定 Agent 名单上那一行该说什么：Launch 看静态清单（不触发
// Defs/Exe 探测），状态能力看适配器表。
func capsForAgent(id string) agentCaps {
	return agent.CapsFor(id, agentcatalog.Has(id))
}

// buildEnv 让主程序和适配器共用同一份终端环境规则。
func buildEnv(extra map[string]string) []string { return agent.BuildEnv(extra) }
