package gateway

import (
	"path/filepath"
	"testing"
)

func TestAgentEngineManagedPersistsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine-agents.json")
	g := New(nil)
	g.SetEngineAgentsFile(path)
	g.setAgentEngine(map[string]bool{"gemini": true})

	g2 := New(nil)
	g2.SetEngineAgentsFile(path)
	if !g2.AgentEngineManaged("gemini") {
		t.Fatal("wired set did not survive a restart; restored panes would launch on the real config")
	}
}

func TestAgentEngineManagedFollowsWired(t *testing.T) {
	g := New(nil)
	g.agentPushState("test", "", []byte(`{"agents":[
		{"id":"gemini","wired":true},
		{"id":"cursor","wired":false}
	]}`))
	if !g.AgentEngineManaged("gemini") {
		t.Fatal("wired gemini must be engine-managed")
	}
	if g.AgentEngineManaged("cursor") {
		t.Fatal("unwired cursor must not be engine-managed")
	}
	// 断开后旧结果不能留着：下一次开格要回到用户自己的配置。
	g.agentPushState("test", "", []byte(`{"agents":[{"id":"gemini","wired":false}]}`))
	if g.AgentEngineManaged("gemini") {
		t.Fatal("disconnected gemini must not stay engine-managed")
	}
}
