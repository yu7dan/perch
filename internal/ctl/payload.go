package ctl

import (
	"log"
	"os"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/history"
	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/settings"
	"github.com/yu7dan/perch/internal/transcript"
	"github.com/yu7dan/perch/internal/uimsg"
)

// ShellPayload 是界面骨架的第一份全量载荷：会话库、历史流、项目池、偏好、
// Agent 名单拼成一份。扫描与聚合分别在 history / project；这里只剩组合。
type ShellPayload struct {
	Sessions []history.Session                `json:"sessions"`
	History  map[string][]history.HistoryItem `json:"history"` // key = sessionId
	StateDir string                           `json:"stateDir"`
	Version  string                           `json:"version,omitempty"`
	// Cwd 是终端的工作目录。以前它是前端 HTML 里写死的一行文本（#p-path），
	// 那个副本从来没被更新过；现在由后端给出唯一一份事实，前端渲染到状态栏。
	Cwd string `json:"cwd"`
	// Titles 是**用户给会话起的名字**，键是 sessionId（见 session.TitleStore）。
	// 后端是它的唯一一份事实：卡片和标签都读这里，用户起的名字压过 agent
	// 自己写在标题里的名字（Orca 的 tab.customTitle ?? tab.title）。
	Titles map[string]string `json:"titles"`
	// Projects 是左栏的主角：用户声明的项目池，已排好序（置顶在前，其余按
	// 组内最近活动倒序）并带上算出来的会话数。
	Projects []project.Wire `json:"projects"`
	// Assign 是会话 id → 项目路径。**不在这张表里的就是「未归类」** ——
	// 前端不要自己重算归属（那样两边的口径会漂），也别把"没出现在表里"
	// 当成"归属为空字符串"：前者是一个真实分组，后者是数据的缺失。
	Assign map[string]string `json:"assign"`
	// Roots 是"去哪儿找项目"的根目录。
	Roots []string `json:"roots"`
	// PoolRev 是这份 Projects/Assign 对应的池子版本；前端用它拒绝被
	// 后台慢扫描的旧快照覆盖刚到的 project.result。
	PoolRev uint64 `json:"poolRev"`
	// Activity 是总览热力图的数据：每个有轮次的本地日期一格。
	// 口径是**用户轮次**（不含压缩摘要、不含命令回显 —— 和「N 轮」同一套判据），
	// 主会话与子代理都算。只发有活动的日期，前端按 53 周铺格子。
	Activity []history.DayActivity `json:"activity"`
	// Catalog 是本机 Agent 名单（agentcatalog 的探测结果）：总览 / 引导 /
	// 新建卡都读它。
	Catalog []agentcatalog.Card `json:"catalog"`
	// Settings 是 Perch 自己的偏好。跟着首份载荷一起下来，
	// 前端就不用为了"终端用什么字号"再发一次请求；之后的改动走 ctl 的 settings 消息。
	Settings settings.Settings `json:"settings"`
	// OSBuild 是 Windows 内部版本号，前端填 xterm 的 windowsPty。原来只在 settings 消息里带，
	// 而那条消息只有进设置页才会发 —— 启动后终端一直不知道自己在 ConPTY 后面。
	OSBuild int `json:"osBuild,omitempty"`
}

// ShellPayload 现场扫一遍，拼出首份载荷。
func (s *Server) ShellPayload() ShellPayload {
	sessions, activity := history.Scan(s.deps.StateDir, transcript.SystemTurn)

	cwd := ""
	if s.deps.DefaultCWD != nil {
		cwd = s.deps.DefaultCWD()
	}
	var titles map[string]string
	if s.deps.Titles != nil {
		titles = s.deps.Titles.Snapshot()
	}
	p := ShellPayload{
		StateDir: s.deps.StateDir,
		Version:  s.deps.Version,
		Cwd:      cwd,
		Sessions: sessions,
		Titles:   titles,
		History:  make(map[string][]history.HistoryItem, len(sessions)),
		Activity: activity,
		Catalog:  s.bootAgentCards(),
		OSBuild:  osBuild(),
	}
	// Prefs 在组合根里先于第一次载荷初始化；万一某条测试路径没初始化，
	// 给默认值而不是零值（零值会让确认默认变成关）。
	if s.deps.Prefs != nil {
		p.Settings = s.deps.Prefs.Snapshot()
	} else {
		p.Settings = settings.Defaults()
	}
	if len(activity) > 0 {
		last := activity[len(activity)-1]
		log.Printf("[dash] 每日活动：%d 个活跃日，最近 %s 有 %d 轮（%d 个会话）",
			len(activity), last.Day, last.Turns, last.Sessions)
	} else {
		log.Printf("[dash] 每日活动：没有带时间戳的轮次（热力图会是空的）")
	}
	// 每个会话都带上历史：点哪张卡就换哪条流。只带第一条的话，
	// 界面看起来能点其实是死的 —— 那是演示，不是产品。
	for _, sess := range sessions {
		if h := history.TailHistory(sess, s.deps.StateDir, 30); len(h) > 0 {
			p.History[sess.ID] = h
		}
	}
	// 项目池：归属与排序都从 sessions 这一遍里算。
	// Pool 为 nil = 池子没初始化（读盘失败），这时**不发 projects 字段**，
	// 让前端自己走"池子不可用"那条路，而不是收到一个空池子就以为用户没项目。
	if s.deps.Pool != nil {
		projects, roots, rev := s.deps.Pool.SnapshotRev()
		// 合成的默认工作区并进这份副本，池子本身不动。
		// 少了这一句，"未归类"里那些落在 Documents\Perch 的会话就永远没有归属。
		projects = project.WithDefaultWorkspace(projects, s.customCWD)
		assign, recent, count := project.Stats(sessions, projects)
		p.Projects = project.WireProjects(projects, recent, count)
		p.Assign = assign
		p.Roots = roots
		p.PoolRev = rev
		// 启动这份载荷就是用户**第一眼**看到的那一屏，它也得过同一条不变量。
		sum, nUn, nMain, nAll := project.Audit(sessions, assign, p.Projects)
		log.Printf("[pool] 启动载荷：%d 个项目 / 归属 %d 条（Σ项目 %d + 未归类 %d = %d，主会话共 %d，全部 %d）",
			len(p.Projects), len(assign), sum, nUn, sum+nUn, nMain, nAll)
	}
	return p
}

// customCWD 把设置里的「默认目录」注入项目池；空串 = 用内置目录。
func (s *Server) customCWD() string {
	if s.deps.Prefs == nil {
		return ""
	}
	return s.deps.Prefs.Snapshot().DefaultCWD
}

// poolReply 把池子的**最新全量**推回前端（projects + 归属 + 根）。
//
// 为什么每次都是全量而不是"改了哪条回哪条"：归属是算出来的（一条会话的
// 归属会随着"谁加了哪个项目"整体变），增量的差集要在两边各维护一份状态、
// 迟早会漂。池子操作是低频动作，全量重算一次是毫秒级 —— 拿一次重扫换掉
// 一整类"两边不一致"的毛病。会话数少的时候这笔买卖非常划算。
func (s *Server) poolReply(err error) {
	if s.deps.Pool == nil {
		m := map[string]any{"type": "pool", "projects": []any{}, "assign": map[string]string{}}
		s.Push(withUIErr(m, uimsg.New("pool.unavailable", "项目池不可用")))
		return
	}
	t0 := time.Now()
	projects, roots, rev := s.deps.Pool.SnapshotRev()
	// 合成的默认工作区只并进这一份**内存列表**（归属计算和 wire 都吃它）——
	// 池子本身照旧，落盘的还是用户自己攒的那些（见 project.WithDefaultWorkspace）。
	projects = project.WithDefaultWorkspace(projects, s.customCWD)
	sessions, _ := history.Scan(s.deps.StateDir, transcript.SystemTurn)
	assign, recent, count := project.Stats(sessions, projects)
	wire := project.WireProjects(projects, recent, count)
	m := map[string]any{
		"type":     "pool",
		"projects": wire,
		"assign":   assign,
		"roots":    roots,
		"rev":      rev,
		"err":      "",
	}
	s.Push(withUIErr(m, err))
	sum, nUn, nMain, nAll := project.Audit(sessions, assign, wire)
	log.Printf("[pool] 推回前端 rev=%d：%d 个项目 / 归属 %d 条（Σ项目 %d + 未归类 %d = %d，主会话共 %d，全部 %d）；用时 %v",
		rev, len(wire), len(assign), sum, nUn, sum+nUn, nMain, nAll, time.Since(t0).Round(time.Millisecond))
}

// refreshPoolAsync schedules one full pool recompute without blocking the
// caller. Writes that happen while a scan is running request one more pass;
// otherwise the last UI state could describe a pool older than the ack it just
// received. The scan itself stays off the ctl receive loop.
func (s *Server) refreshPoolAsync(why string) {
	s.poolMu.Lock()
	if s.poolRefreshing {
		s.poolAgain = true
		s.poolMu.Unlock()
		return
	}
	s.poolRefreshing = true
	s.poolMu.Unlock()
	log.Printf("[pool] 后台刷新开始（%s）", why)
	go func() {
		for {
			s.poolReply(nil)
			s.poolMu.Lock()
			if !s.poolAgain {
				s.poolRefreshing = false
				s.poolMu.Unlock()
				return
			}
			s.poolAgain = false
			s.poolMu.Unlock()
			log.Printf("[pool] 后台刷新补一轮（扫描期间又有写操作）")
		}
	}()
}

// bootAgentCards 是冷恢复应答里附带的本机 Agent 名单。
//
// 前端要在**建第一格之前**决定默认用哪个 agent，而那一刻 shell 载荷还没到
// （它要扫会话库）；panes.query 是唯一更早的往返，所以名单跟着它走。
// 和总览用的是同一份 agentcatalog.Cards —— 两份探测规则迟早会漂。
func (s *Server) bootAgentCards() []agentcatalog.Card {
	home, err := os.UserHomeDir()
	if err != nil {
		return []agentcatalog.Card{}
	}
	return agentcatalog.Cards(home)
}

// defaultAgentSetting 是设置里的显式默认（空 = 自动）。前端自己还会校验
// “已安装 / 能启动”，这里只把落盘的事实带过去。
func (s *Server) defaultAgentSetting() string {
	if s.deps.Prefs == nil {
		return ""
	}
	return s.deps.Prefs.Snapshot().DefaultAgent
}

// settingsWire 是发给前端的整份读数。除了落盘的七项，还带上**算出来的**三样：
//
//	· cwd             当前生效的默认工作目录（自定义失效时是内置那个）
//	· builtinCwd      内置默认目录，设置页拿它写"恢复默认"的说明
//	· defaultCwdMissing 用户选的目录此刻不在盘上（不代表配置坏了）
//
// 这三个数都由 Go 现算：前端自己拼路径会在「文档/Documents」这种地方分叉。
func (s *Server) settingsWire(err error) map[string]any {
	m := map[string]any{"type": "settings"}
	if s.deps.Prefs == nil {
		m["settings"] = settings.Defaults()
		return withUIErr(m, uimsg.New("settings.storeUnavailable", "设置存储没起来（拿不到用户配置目录）"))
	}
	st := s.deps.Prefs.Snapshot()
	builtin, _ := project.BuiltinDefaultWorkspacePath()
	m["settings"] = st
	if s.deps.DefaultCWD != nil {
		m["cwd"] = s.deps.DefaultCWD()
	}
	m["builtinCwd"] = builtin
	m["osBuild"] = osBuild()
	m["defaultCwdMissing"] = s.deps.Prefs.DefaultCWDUnavailable()
	return withUIErr(m, err)
}

func (s *Server) pushSettings(err error) {
	s.Push(s.settingsWire(err))
}

// applySettingsPatch 是 settings.set / settings.pickDefaultCWD 的共同落点。
// 默认目录一变，还要做两件事：确保新目录存在（新格要落在里面），并把池子
// 重算一遍（合成的「默认工作区」那一行跟着换路径）。
func (s *Server) applySettingsPatch(p settings.Patch, why string) {
	if s.deps.Prefs == nil {
		s.pushSettings(uimsg.New("settings.storeUnavailable", "设置存储没起来（拿不到用户配置目录）"))
		return
	}
	old := s.deps.Prefs.Snapshot()
	next, err := s.deps.Prefs.Patch(p)
	if err != nil {
		log.Printf("[settings] %s 失败：%v（保持原值）", why, err)
		s.pushSettings(err)
		return
	}
	log.Printf("[settings] %s：默认目录=%s 字号=%d 字体=%s 启动=%s 语言=%s UI=%s 模式=%s 主题=%s 默认 agent=%s 快捷键=%s 关窗确认=%v 结束确认=%v",
		why, pick(next.DefaultCWD, "(内置)"), next.TermFontSize, next.TermFontFamily,
		next.StartView, next.Language, next.UIMode, next.TopMode, next.Theme,
		pick(next.DefaultAgent, "(自动)"), pick(next.NewAgentShortcut, "(关闭)"),
		next.ConfirmClose, next.ConfirmEndAgent)
	s.pushSettings(nil)
	if next.DefaultCWD != old.DefaultCWD {
		project.EnsureDefaultWorkspace(s.customCWD)
		s.refreshPoolAsync("默认目录改了")
	}
}

func pick(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}
