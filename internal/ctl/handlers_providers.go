package ctl

// 模型提供商与每个 agent 的配置（设置页「模型提供商」「Agents」两节）。
// 落盘与注入在 internal/providers；这里只做编排：改完推一份不含密钥的视图。
//
// ⚠️ key 只在 provider.save 这一条消息里过一次内存：不写日志、不回显、
// 推回前端的视图里只有末四位。

import (
	"context"
	"log"

	"github.com/yu7dan/perch/internal/providers"
)

func (s *Server) handleProviders(m *Msg) {
	st := s.deps.Providers
	if st == nil {
		s.Push(map[string]any{"type": "provider.result", "req": m.Req, "ok": false, "err": "提供商配置没有初始化"})
		return
	}
	switch m.Type {
	case "providers.get":
		s.pushProviders()
	case "provider.save":
		if m.Provider == nil {
			return
		}
		id, err := st.SaveProvider(*m.Provider)
		s.providerResult(m, id, err, "保存提供商")
		if err == nil && m.Provider.Key != "" {
			// 新填 / 换了 key：顺手测一次，把模型列表拿回来给 Agents 那一栏用。
			go s.testProvider(id, m.Req)
		}
	case "provider.delete":
		err := st.DeleteProvider(m.ID)
		s.providerResult(m, m.ID, err, "删除提供商")
	case "provider.test":
		go s.testProvider(m.ID, m.Req)
	case "agent.config.set":
		if m.Config == nil || m.AgentID == "" {
			return
		}
		err := st.SetAgent(m.AgentID, *m.Config)
		s.providerResult(m, m.AgentID, err, "保存 agent 配置")
	}
}

func (s *Server) providerResult(m *Msg, id string, err error, what string) {
	res := map[string]any{"type": "provider.result", "req": m.Req, "op": m.Type, "id": id, "ok": err == nil}
	if err != nil {
		res["err"] = err.Error()
		log.Printf("[providers] %s 失败：%v", what, err)
	} else {
		log.Printf("[providers] %s：%s", what, id)
	}
	s.Push(res)
	s.pushProviders()
}

func (s *Server) testProvider(id string, req int) {
	p, key, err := s.deps.Providers.ProviderSecret(id)
	var res providers.ProbeResult
	if err == nil {
		res, err = providers.Probe(context.Background(), p, key)
	}
	out := map[string]any{"type": "provider.test", "req": req, "id": id, "ok": err == nil}
	if err != nil {
		out["err"] = err.Error()
		log.Printf("[providers] 测试连接 %s 失败：%v", id, err)
	} else {
		out["models"] = len(res.Models)
		out["via"] = res.Via
		log.Printf("[providers] 测试连接 %s：%d 个模型（%s）", id, len(res.Models), res.Via)
		_ = s.deps.Providers.SetModels(id, res.Models)
	}
	s.Push(out)
	s.pushProviders()
}

func (s *Server) pushProviders() {
	if s.deps.Providers == nil {
		return
	}
	protos := map[string][]string{}
	for _, id := range []string{"claude", "codex", "pi", "opencode"} {
		protos[id] = providers.Protocols(id)
	}
	s.Push(map[string]any{
		"type":      "providers",
		"view":      s.deps.Providers.View(),
		"protocols": protos,
		"efforts":   providers.Efforts,
	})
}
