package ctl

import (
	"encoding/json"
	"log"
)

// tabNew 建一格：护栏 → 分配 → 注册流 → 应答。
//
// 顺序是硬约束：CreateTab 在组合根里**先** app.HandleStream、再返回 ——
// 前端拿到 tab.ok 就会立刻去连那条流。
func (s *Server) tabNew(c Conn, m *Msg, tabReqCache map[int][]byte) {
	if m.Spec == nil {
		return
	}
	// 令牌去重（见 Serve 开头那张表）：前端超时后会拿同一个 req 重发
	if m.Req != 0 {
		if prev, ok := tabReqCache[m.Req]; ok {
			_ = c.Send(prev)
			log.Printf("[ctl] tab.new 令牌 req=%d 重复（前端重发同一次请求）→ 重放上次的应答，不建第二个格子", m.Req)
			return
		}
	}
	// C2 护栏：判**在建标签之前**。一个没有 PTY 的占位格比"什么都没发生"
	// 更糟 —— 界面上会多出一格，用户以为它在跑。判据见 session.ResumeRefusal。
	if ref := s.deps.Tabs.ResumeRefusal(*m.Spec); ref != nil {
		out := map[string]any{
			"type": "tab.ok", "tab": 0, "stream": "", "req": m.Req,
			// 被拒也要把 paneId 带回去：前端要么用它重试同一格
			// （瞬时冲突那 2 次重试），要么让它显式降级 ——
			// 少一个身份，降级后的那一格就没法再写进记录里。
			"pane": m.Spec.PaneID,
			"err":  ref.Code, "msg": ref.Msg,
			// 能不能重试由**判的人**给（见 session.Refusal.Retryable）：
			// 前端不许拿 code 去查表 —— 那是第二份会漂的规则。
			"retryable": ref.Retryable,
		}
		// msg 的稳定身份：前端按当前语言渲染 msg.<msgCode>，带 pid/格子的值
		// 从 msgParams 拼；字典里没有就回退 msg 原文。
		if ref.MsgCode != "" {
			out["msgCode"] = ref.MsgCode
		}
		if len(ref.MsgParams) > 0 {
			out["msgParams"] = ref.MsgParams
		}
		reply, _ := json.Marshal(out)
		_ = c.Send(reply)
		if m.Req != 0 {
			tabReqCache[m.Req] = reply // 拒绝也是应答：重发时重放它，不重新判一次护栏
		}
		log.Printf("[ctl] 拒绝接上 agent=%s cwd=%s resume=%s id=%s pane=%d 因=%s：%s",
			m.Spec.Agent, m.Spec.CWD, m.Spec.Resume.Kind, m.Spec.Resume.ID,
			m.Spec.PaneID, ref.Code, ref.Msg)
		return
	}
	host := s.deps.CreateTab(*m.Spec)
	reply, _ := json.Marshal(map[string]any{
		"type": "tab.ok", "tab": host.ID, "stream": host.Stream, "req": m.Req,
		// paneId 是这一格**跨重启的身份**：前端拿着它，才能在用户显式
		// 关格时发 pane.forget（那是唯一一条会删记录的路径）。
		"pane": host.PaneID,
	})
	_ = c.Send(reply)
	if m.Req != 0 {
		tabReqCache[m.Req] = reply // 重发同一令牌时重放它 —— 绝不建第二个格子
	}
	log.Printf("[ctl] 新标签 tab=%d pane=%d stream=%s agent=%s cwd=%s resume=%s id=%s",
		host.ID, host.PaneID, host.Stream, m.Spec.Agent, m.Spec.CWD,
		m.Spec.Resume.Kind, m.Spec.Resume.ID)
}

// panesQuery 是冷恢复的那一次查询（步 3）：前端在**建任何格子之前**问一次
// "上一轮有哪几格"，拿回来的清单决定这一轮摆哪几个座位、各起什么。
//
// ⚠️ 为什么是请求/应答，而不是开窗时随 ShellPayload 一起推下去：
// 前端在**模块求值期间**就已经把默认那一格建出来了（index.html 的
// `await createTab(DEFAULT_SPAWN_SPEC)`），ShellPayload 到达时那一格
// 已经起来、并且已经在会话库里落了一条空会话 —— 那股噪音正是这一轮
// 要消灭的东西。查询能在它之前发生，载荷不能。
func (s *Server) panesQuery(c Conn) {
	// 步 7：第二个实例**一个座位都不恢复** —— 它要是也跟着按记录起
	// `--resume`，两个实例会在"护栏还看不见对方"的那一两秒里各接一条
	// 同一条会话（这条链上唯一不可逆的失败，见 winproc 的单实例闸）。
	// 回 err 就是前端的"登记表不可用"那条路：它自己起一个默认格，
	// 把界面交出去，并在日志里带一句 err=…（前端那行 bootFact 会写出来）。
	if s.deps.SecondInstance {
		reply, _ := json.Marshal(map[string]any{
			"type": "panes.list", "panes": []any{},
			"agents": s.bootAgentCards(), "defaultAgent": s.defaultAgentSetting(),
			"err": "已经有一个我在跑（单实例闸）—— 这一轮不恢复任何会话",
		})
		_ = c.Send(reply)
		return
	}
	if s.deps.Panes == nil {
		reply, _ := json.Marshal(map[string]any{
			"type": "panes.list", "panes": []any{}, "err": "登记表不可用",
			"agents": s.bootAgentCards(), "defaultAgent": s.defaultAgentSetting(),
		})
		_ = c.Send(reply)
		return
	}
	plan := s.deps.Panes.RestorePlan(s.deps.SessionExists) // 这一行自己打计数 + 座位序（见 panes）
	reply, err := json.Marshal(map[string]any{
		"type": "panes.list", "panes": plan.Views,
		"agents": s.bootAgentCards(), "defaultAgent": s.defaultAgentSetting(),
	})
	if err != nil {
		log.Printf("[panes] 冷恢复清单序列化失败（前端会走无应答那条兜底）：%v", err)
		return
	}
	_ = c.Send(reply)
}

// paneClose 是用户**关掉了这一格的运行**（点格子头的 ×）—— 记录留着、打上 Closed。
// 它和 pane.forget 的分工见 panes.Pane.Closed：关格 = "我现在不需要它开着"，
// 结束 agent = "我不要它了"。这里绝不删记录。
func (s *Server) paneClose(m *Msg) {
	if s.deps.Panes == nil {
		return
	}
	kept, found := s.deps.Panes.Close(m.Pane, "用户点格子头的 ×")
	switch {
	case !found:
		log.Printf("[ctl] pane.close pane=%d：盘上没有这条记录（可能已经摘过），不动", m.Pane)
	case kept:
		log.Printf("[ctl] pane.close pane=%d（关格保留记录，重启不自动拉起）", m.Pane)
	default:
		log.Printf("[ctl] pane.close pane=%d（没发过提示，记录已摘掉）", m.Pane)
	}
	// 前端关格时先乐观地留了一行「已关闭」；空记录已经摘掉时要把那一行撤掉。
	s.Push(map[string]any{
		"type": "pane.closed", "pane": m.Pane, "kept": kept, "found": found,
	})
}

// paneForget 是**唯一**一条会删记录的路径：用户明确不要这个 agent 了
// （左栏「结束这个 agent」）。别的消失方式（进程挂了 / 流断了 / 关窗口 /
// 点 ×）一律不出现在这里 —— "记录是证据，不是垃圾"（见 session.Drop 的注释）。
func (s *Server) paneForget(m *Msg) {
	if s.deps.Panes == nil {
		return
	}
	if s.deps.Panes.Forget(m.Pane, "用户关格") {
		log.Printf("[ctl] pane.forget pane=%d（用户显式关格 —— 只有这条路会摘记录）", m.Pane)
	} else {
		log.Printf("[ctl] pane.forget pane=%d：盘上没有这条记录（可能已经摘过），不动", m.Pane)
	}
}

// titleSet 是用户在左栏给一条会话起名 / 改名。写的是**显示名**，不是 id ——
// id 是 claude 那份 jsonl 的文件名，`--resume`、我们的记录、会话索引
// 四条链都指着它，改它等于一次性打断四条（见 panes.Pane.SessionID）。
//
// 它和标签那条改名路（字节流上的 "rename"）写的是**同一张表**：
// 名字的主语永远是会话（session/titles.go 开头那段）。差别只在信息从哪来 ——
// 标签只有 pid 得反查，左栏直接给 id。
// 空名字 = 清除（回到 agent 自己写的标题），两条路的语义必须一样，
// 否则"在左栏清掉"和"在标签上清掉"会得到两个不同的结果。
func (s *Server) titleSet(m *Msg) {
	id := trimSpace(m.ID)
	if id == "" || s.deps.Titles == nil {
		log.Printf("[title] title.set 缺 id 或名字表不可用，不动：id=%q", id)
		return
	}
	if err := s.deps.Titles.Set(id, m.Name); err != nil {
		log.Printf("[title] 写 titles.json 失败（会话 %s）：%v", short(id), err)
		// 前端是**乐观**改的（先把那一行改了、再落盘），所以这里必须有一条
		// 回来的路：把权威的那份表推回去，让界面掉回真实状态。不推的话，
		// 屏幕上挂着一个盘上不存在的名字，下次打开又变回去 —— 那种
		// "我明明改过"的悬案最难查。
		s.Push(map[string]any{"type": "titles", "titles": s.deps.Titles.Snapshot()})
		return
	}
	if trimSpace(m.Name) == "" {
		log.Printf("[title] 会话 %s 的名字已清除（左栏），回到 agent 自己写的标题", short(id))
	} else {
		log.Printf("[title] 会话 %s 命名为 %q（左栏）", short(id), trimSpace(m.Name))
	}
}

// libReload 是前端关掉一格之后要的一次**会话库重扫**。
//
// 为什么非有这条路不可：那份数据是 boot 时一推了之的（ServeShell），
// 而关格子恰恰是"这一格里的子代理刚刚死了"的那一刻。不复扫的后果实测过
// （2026-10-16 00:53）：格子里起了个子代理、眼看着关掉那一格，日志里只有
// "关格子"，**没有**任何一条"已关闭" —— 因为那条子代理是在 boot **之后**
// 才落盘的，库里压根没有它的卡，没卡就没签可改。同一个洞还有另一面：
// 库里那些"本格在跑的"子代理，跑完也不会露面。顺带一提，这条路也把
// "这一格自己的会话文件"带进库里（新起的 claude 在 boot 时同样还不存在）。
//
// 代价：载荷几十 KB、扫一遍毫秒级，而关格子是低频动作 —— 所以直接**同步**
// 重扫。不换协程，是因为 Send 走的就是手里这根流，换协程反而要和
// 在途的推送处理并发，而这里慢的那几十毫秒没有任何人等着。
func (s *Server) libReload(c Conn) {
	st := s.ShellPayload()
	b, err := json.Marshal(map[string]any{"type": "state", "state": st})
	if err != nil {
		log.Printf("[ctl] 会话库刷新失败: %v", err)
		return
	}
	nSide := 0
	for _, sess := range st.Sessions {
		if sess.Sidechain {
			nSide++
		}
	}
	log.Printf("[ctl] 会话库刷新：%d 会话（其中子代理 %d）%d 字节", len(st.Sessions), nSide, len(b))
	_ = c.Send(b)
}
