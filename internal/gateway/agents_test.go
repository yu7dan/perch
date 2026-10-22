package gateway

import "testing"

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
