package main

// 首份 shell 载荷：把会话库、历史流、项目池、偏好、网关快照拼成一份。
// 扫描与聚合分别在 internal/history、internal/project；这里只剩组合，
// 6a 会把它搬进 ctl/payload.go。

import (
	"log"
)

type ShellPayload struct {
	Sessions []claudeSession          `json:"sessions"`
	History  map[string][]historyItem `json:"history"` // key = sessionId
	StateDir string                   `json:"stateDir"`
	// Cwd 是终端的工作目录。以前它是前端 HTML 里写死的一行文本（#p-path），
	// 那个副本从来没被更新过；现在由后端给出唯一一份事实，前端渲染到状态栏。
	Cwd string `json:"cwd"`
	// Titles 是**用户给会话起的名字**，键是 sessionId（见 session 包的说明）。
	// 后端是它的唯一一份事实：卡片和标签都读这里，用户起的名字压过 agent
	// 自己写在标题里的名字（Orca 的 tab.customTitle ?? tab.title）。
	Titles map[string]string `json:"titles"`
	// Projects 是左栏的主角：用户声明的项目池（见 internal/project），已排好序
	// （置顶在前，其余按组内最近活动倒序）并带上算出来的会话数。
	Projects []projectWire `json:"projects"`
	// Assign 是会话 id → 项目路径。**不在这张表里的就是「未归类」** ——
	// 前端不要自己重算归属（那样两边的口径会漂），也别把"没出现在表里"
	// 当成"归属为空字符串"：前者是一个真实分组，后者是数据的缺失。
	Assign map[string]string `json:"assign"`
	// Roots 是"去哪儿找项目"的根目录（发现/扫描的起点，见 internal/project）。
	Roots []string `json:"roots"`
	// Activity 是总览热力图的数据：每个有轮次的本地日期一格。
	// 口径是**用户轮次**（不含压缩摘要、不含命令回显 —— 和「N 轮」同一套判据），
	// 主会话与子代理都算。只发有活动的日期，前端按 53 周铺格子。
	Activity []dayActivity `json:"activity"`
	// Magpie 是本地 magpie 网关的只读读数（见 magpie.go）。它**不在这次扫描里
	// 现算** —— watcher 在后台每 2.5s 更新一份快照，这里只是把最新那份带上，
	// 否则 lib.reload 会被网关请求拖住。nil = watcher 还没起来（正常只在测试/首帧）。
	Magpie *magpieSnap `json:"magpie,omitempty"`
	// Settings 是 Perch 自己的偏好（见 internal/settings）。跟着首份载荷一起下来，
	// 前端就不用为了"终端用什么字号"再发一次请求；之后的改动走 ctl 的 settings 消息。
	Settings appSettings `json:"settings"`
}

func buildShellPayload(stateDir, cwd string, titles map[string]string) ShellPayload {
	sessions, activity := scanSessions(stateDir)

	p := ShellPayload{
		StateDir: stateDir,
		Cwd:      cwd,
		Sessions: sessions,
		Titles:   titles,
		History:  make(map[string][]historyItem, len(sessions)),
		Activity: activity,
		Magpie:   magpieSnapshot(),
	}
	// prefsStore 在 main() 里先于第一次 buildShellPayload 初始化；
	// 万一某条测试路径没初始化，给默认值而不是零值（零值会让确认默认变成关）。
	if prefsStore != nil {
		p.Settings = prefsStore.Snapshot()
	} else {
		p.Settings = settingsDefaults()
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
	for _, s := range sessions {
		if h := tailHistory(s, stateDir, 30); len(h) > 0 {
			p.History[s.ID] = h
		}
	}
	// 项目池：归属与排序都从 sessions 这一遍里算（见 internal/project 的 Stats）。
	// pool 为 nil = 池子没初始化（读盘失败），这时**不发 projects 字段**，
	// 让前端自己走"池子不可用"那条路，而不是收到一个空池子就以为用户没项目。
	if pool != nil {
		projects, roots := pool.Snapshot()
		// 合成的默认工作区（见 internal/project）：并进这份副本，池子本身不动。
		// 少了这一句，"未归类"里那些落在 Documents\Perch 的会话就永远没有归属。
		projects = withDefaultWorkspace(projects)
		assign, recent, count := projectStats(sessions, projects)
		p.Projects = wireProjects(projects, recent, count)
		p.Assign = assign
		p.Roots = roots
		// 启动这份载荷就是用户**第一眼**看到的那一屏，它也得过同一条不变量
		// （判据与四个数都出自 poolAudit，调用方只负责打印）。之所以两处都量，
		// 是因为"某条会话在界面上不存在"这种错常常就出在启动这一遍。
		sum, nUn, nMain, nAll := poolAudit(sessions, assign, p.Projects)
		log.Printf("[pool] 启动载荷：%d 个项目 / 归属 %d 条（Σ项目 %d + 未归类 %d = %d，主会话共 %d，全部 %d）",
			len(p.Projects), len(assign), sum, nUn, sum+nUn, nMain, nAll)
	}
	return p
}
