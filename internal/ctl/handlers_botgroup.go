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
		// 页面刚连上 / 重载了：没回执的投递全部再推一遍（投递归 Go，前端只执行）。
		if co := s.deps.Coordinator; co != nil {
			go co.Resend()
		}
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
		// 回执要等 worktree 建好再发：前端拿回执里的 Bot 起格，起早了就落在项目根目录里
		// （实测：三格都在 worktree 建好前就起了）。git 放在后台跑，不堵 ctl。
		go func() {
			if err == nil {
				s.prepareWorktreesNow(g.ID)
				if g2, ok := st.Get(g.ID); ok {
					res["group"] = g2
				}
			}
			s.Push(res)
			s.pushBotGroups()
		}()
	case "botgroup.addbot":
		// 页头「加 Bot」：先记进组里，前端拿到回执里的 bot 再起它的格子。
		if m.BotGroup == nil || len(m.BotGroup.Bots) != 1 {
			return
		}
		b, err := st.AddBot(m.ID, m.BotGroup.Bots[0])
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID}
		if err != nil {
			res["err"] = err.Error()
		} else {
			res["bot"] = b
			log.Printf("[botgroup] 组 %s 加 Bot %s「%s」(%s)", m.ID, b.ID, b.Role, b.Agent)
		}
		go func() {
			if err == nil {
				s.prepareWorktreesNow(m.ID)
				if g2, ok := st.Get(m.ID); ok {
					if nb, ok := g2.Bot(b.ID); ok {
						res["bot"] = nb
					}
				}
			}
			s.Push(res)
			s.pushBotGroups()
		}()
	case "botgroup.updatebot":
		// 角色配置抽屉：改完立刻存；要重启才生效的项由前端提示。
		if m.BotPatch == nil {
			return
		}
		b, err := st.UpdateBot(m.ID, m.BotID, *m.BotPatch)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID, "botId": m.BotID}
		if err != nil {
			res["err"] = err.Error()
			log.Printf("[botgroup] 改 Bot %s/%s 失败：%v", m.ID, m.BotID, err)
		} else {
			res["bot"] = b
			log.Printf("[botgroup] 改 Bot %s/%s「%s」agent=%s model=%q perm=%q folder=%q", m.ID, b.ID, b.Role, b.Agent, b.Model, b.Permission, b.Folder)
		}
		s.Push(res)
		s.pushBotGroups()
	case "botgroup.removebot":
		b, err := st.RemoveBot(m.ID, m.BotID)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID, "botId": m.BotID}
		if err != nil {
			res["err"] = err.Error()
		} else {
			if b.PaneID > 0 && s.deps.Panes != nil {
				s.deps.Panes.SetGroup(b.PaneID, "", "", "从 Bot Group 移除")
			}
			log.Printf("[botgroup] 组 %s 移除 Bot %s「%s」pane=%d", m.ID, b.ID, b.Role, b.PaneID)
		}
		s.Push(res)
		s.pushBotGroups()
	case "bg.delivered":
		if co := s.deps.Coordinator; co != nil {
			co.Delivered(m.ID, m.Key)
		}
	case "bg.failed":
		if co := s.deps.Coordinator; co != nil {
			co.DeliverFailed(m.ID, m.Key, m.Msg)
		}
	case "bg.answer":
		// 被拦的那件：你在群里点了「放行」/「取消」
		if co := s.deps.Coordinator; co != nil {
			err := co.Answer(m.ID, m.Task, m.Action)
			res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID}
			if err != nil {
				res["err"] = err.Error()
			}
			s.Push(res)
		}
	case "botgroup.pause":
		if co := s.deps.Coordinator; co != nil && m.Paused != nil {
			err := co.SetPaused(m.ID, *m.Paused)
			res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID}
			if err != nil {
				res["err"] = err.Error()
			}
			s.Push(res)
			s.pushBotGroups()
		}
	case "botgroup.settings":
		if m.GroupPatch == nil {
			return
		}
		g, err := st.UpdateGroup(m.ID, *m.GroupPatch)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID}
		if err != nil {
			res["err"] = err.Error()
		} else {
			log.Printf("[botgroup] 组 %s 设置：记忆=%q worktree=%v 预算=%d", g.ID, g.MemoryMode, g.Worktrees, g.Budget)
			if m.GroupPatch.Worktrees != nil && *m.GroupPatch.Worktrees {
				s.prepareWorktrees(g.ID)
			}
		}
		s.Push(res)
		s.pushBotGroups()
	case "botgroup.circles":
		for _, c := range m.Circles {
			if !botgroup.ValidCircle(c) {
				s.Push(map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": false, "id": m.ID, "err": "圈名只能用文字、数字、- 和 _（最多 24 个字）"})
				return
			}
		}
		_, err := st.SetCircles(m.ID, m.BotID, m.Circles)
		res := map[string]any{"type": "botgroup.result", "req": m.Req, "op": m.Type, "ok": err == nil, "id": m.ID, "botId": m.BotID}
		if err != nil {
			res["err"] = err.Error()
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
		if err == nil && s.deps.Coordinator != nil {
			s.deps.Coordinator.DropGroup(m.ID)
		}
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
	msg := map[string]any{"type": "botgroups", "groups": groups, "events": events}
	// C 阶段：每个组的任务账本、每个 Bot 的开场说明、已用的 k tokens（策略守卫和页头预算同一个数）。
	if co := s.deps.Coordinator; co != nil {
		tasks := make(map[string][]botgroup.Task, len(groups))
		intros := make(map[string]map[string]string, len(groups))
		used := make(map[string]int, len(groups))
		for _, g := range groups {
			tasks[g.ID] = co.Tasks(g.ID, botTasksPerGroup)
			intros[g.ID] = map[string]string{}
			for _, b := range g.Bots {
				intros[g.ID][b.ID] = co.Intro(g, b)
			}
			used[g.ID] = co.UsedK(g.ID)
		}
		msg["tasks"], msg["intros"], msg["usedK"] = tasks, intros, used
	}
	s.Push(msg)
}

const botTasksPerGroup = 200

// prepareWorktrees：给组里该有 worktree 的 Bot 建好（后台跑 git，建完再推一次组清单）。
func (s *Server) prepareWorktrees(gid string) {
	co := s.deps.Coordinator
	if co == nil {
		return
	}
	go func() {
		if co.PrepareWorktrees(gid) > 0 {
			s.pushBotGroups()
		}
	}()
}

// prepareWorktreesNow：同步版（调用方自己在后台 goroutine 里）。
func (s *Server) prepareWorktreesNow(gid string) {
	if co := s.deps.Coordinator; co != nil {
		co.PrepareWorktrees(gid)
	}
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
