package ctl

// Bot Group 的控制消息（阶段 B：数据与创建）。数据在 internal/botgroup；这里只做编排。
//
//   botgroups.get     → push botgroups（全部组 + 每组最近的过程流）
//   botgroup.create   → 建组（衍生：原 Agent 的格子直接当 Manager）→ provider.result 式回执
//   botgroup.bind     → 某个 Bot 的格子起来了（前端拿到 paneId 之后发）
//   botgroup.event    → 前端看到的状态跃迁（开始干活 / 等你 / 空闲 / 停了）记进过程流
//   botgroup.delete   → 删组记录与过程流（Bot 的格子由前端决定关不关）
//
// Bot 的格子怎么起、怎么藏在 Workspaces 之外，是前端的事（91-botgroup.js）。

import (
	"log"

	"github.com/yu7dan/perch/internal/botgroup"
)

const botEventsPerGroup = 400

func (s *Server) handleBotGroup(m *Msg) {
	st := s.deps.BotGroups
	if st == nil {
		return
	}
	switch m.Type {
	case "botgroups.get":
		s.pushBotGroups()
	case "botgroup.create":
		if m.BotGroup == nil {
			return
		}
		g, err := st.Create(*m.BotGroup)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil}
		if err != nil {
			res["err"] = err.Error()
			log.Printf("[botgroup] 建组失败：%v", err)
		} else {
			res["group"] = g
			log.Printf("[botgroup] 建组 %s「%s」：%d 个 Bot，来源=%s", g.ID, g.Name, len(g.Bots), g.Source.Kind)
			title := "建组：" + g.Name
			if g.Source.Kind == "derived" {
				title = "从「" + pickStr(g.Source.Title, g.Source.Agent) + "」衍生：" + g.Name
			}
			_, _ = st.Append(g.ID, botgroup.Event{Kind: "created", Bot: "manager", Title: title, Text: g.Goal})
			// 衍生：原 Agent 的格子直接当 Manager —— 在格子记录上打上成员身份。
			if g.Source.Kind == "derived" && s.deps.Panes != nil {
				s.deps.Panes.SetGroup(g.Source.PaneID, g.ID, "manager", "衍生 Bot Group")
			}
		}
		s.Push(res)
		s.pushBotGroups()
	case "botgroup.bind":
		if err := st.BindPane(m.ID, m.BotID, m.Pane); err != nil {
			log.Printf("[botgroup] 绑定格子失败：%v", err)
			return
		}
		s.pushBotGroups()
	case "botgroup.event":
		if m.Event == nil {
			return
		}
		e, err := st.Append(m.ID, *m.Event)
		if err != nil {
			log.Printf("[botgroup] 记事件失败：%v", err)
			return
		}
		s.Push(map[string]any{"type": "botgroup.event", "group": m.ID, "event": e})
	case "botgroup.delete":
		// 先把成员格从组里放出来（格子记录还在；关不关由前端决定）。
		if s.deps.Panes != nil {
			for _, g := range st.List() {
				if g.ID != m.ID {
					continue
				}
				for _, b := range g.Bots {
					if b.PaneID > 0 {
						s.deps.Panes.SetGroup(b.PaneID, "", "", "删除 Bot Group")
					}
				}
			}
		}
		err := st.Delete(m.ID)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID}
		if err != nil {
			res["err"] = err.Error()
		}
		s.Push(res)
		s.pushBotGroups()
	}
}

func (s *Server) pushBotGroups() {
	st := s.deps.BotGroups
	if st == nil {
		return
	}
	groups := st.List()
	events := make(map[string][]botgroup.Event, len(groups))
	for _, g := range groups {
		events[g.ID] = st.Events(g.ID, 0, botEventsPerGroup)
	}
	s.Push(map[string]any{"type": "botgroups", "groups": groups, "events": events})
}

func pickStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// botStarted 记一笔「某个 Bot 的格子起来了」并推一次组清单（paneId 变了）。
func (s *Server) botStarted(gid, botID, agentID string) {
	role := botID
	for _, g := range s.deps.BotGroups.List() {
		if g.ID != gid {
			continue
		}
		for _, b := range g.Bots {
			if b.ID == botID {
				role = b.Role
			}
		}
	}
	_, _ = s.deps.BotGroups.Append(gid, botgroup.Event{Kind: "started", Bot: botID, Title: role + " 上线（" + agentID + "）"})
	s.pushBotGroups()
}
