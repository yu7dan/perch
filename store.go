package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 会话索引器
//
// 这一版只解决「界面要有真东西可渲染」。数据来源完全按已批准计划里的原则：
//
//   1. **绝不反解目录名**。`C--Users-someone-my-project` 这种编码是有损的
//      （中文、连字符都还原不回来），只能当定位用的 key；真正的 cwd 一律
//      从文件**内容**里读。
//   2. 标题走四级降级：aiTitle → slug → 第一条 user 文本 → 会话 ID。
//      这个 fork 的 ai-title 事件是现成的好标题，先吃满。
//   3. 只做 O(1) 次全文件扫描，且用 bytes.Contains 做前置过滤 ——
//      主会话文件 5.5MB，13 个文件全量 JSON 解析是几秒级，过滤后是毫秒级。
// ---------------------------------------------------------------------------

type Session struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Slug       string `json:"slug"`
	Cwd        string `json:"cwd"`
	Project    string `json:"project"` // 编码目录名：仅用于定位，不展示
	// Path 是这份会话文件的绝对路径。C2 的卡片菜单要"打开会话文件 / 在文件夹中
	// 显示"就得有它 —— 从前端拼不出来：项目目录名是有损 slug（见
	// transcript.go 的说明），子代理还多一层 subagents\。
	Path string `json:"path"`
	Branch     string `json:"branch"`
	Permission string `json:"permission"`
	Preview    string `json:"preview"`
	Updated    string `json:"updated"`
	Agents     int    `json:"agents"` // 子代理会话数 = 卡片上那一排小胶囊
	Turns      int    `json:"turns"`
	Bytes      int64  `json:"bytes"`
	Sidechain  bool   `json:"sidechain"` // 子代理会话
	Parent     string `json:"parent"`    // 子代理所属主会话 ID
	AgentName  string `json:"agentName"`
	AgentType  string `json:"agentType"` // 例如 general-purpose
	// C7：子代理"停下来了"这件事要分成**已完成**和**被中断（已关闭）**两种，
	// 材料只有一样：文件**最后一条事件**是什么。
	//
	// ⚠️ 这一对字段的**可靠程度是单向的**，别读成"能分辨这两种结局"。
	// 本机全量扫过 37 份子代理会话文件（2026-10-16 00:56）：末条是 tool_result 的
	// **32 份**、是收尾 assistant 文本的 3 份、是悬空 tool_use 的只有 2 份。
	// 而且 01:01 那次又量到：**关格子软杀掉的子代理，它的工具调用会拿到一个
	// tool_result**（PTY 一关，正在跑的命令就中断返回了；实测 a321f9d6 那份：
	// tool_use 16:59:54 → tool_result 17:01:14.306，被杀前 0.7 秒落盘）。
	// 会留下悬空 tool_use 的是**硬杀**（进程树瞬间没了，来不及写结果）。
	// 所以"正常收尾"和"被软杀掉"在文件里**长得一模一样**。LastTool 只能当
	// **单边**证据用：
	//
	//   LastTool == true  → 一次工具调用没拿到结果 = 写者消失了 → 被打断（站得住）
	//   LastTool == false → **不是**"它正常收完了"，只是"我这儿看不出被打断"
	//
	// 而我原来在注释里写的"正常收尾以一句 assistant 文本结束"是**错的** ——
	// 那种收尾只占 3/37（大概是真写了最后总结的那几次）。谁要用这两个字段，
	// 先把上面那份分布读一遍。前端的判据顺序见 index.html 的 subStateOf。
	//
	// ⚠️ 这也是**对文件的推断**，不是"亲眼看着"（hook 的 SubagentStop 才是后者）。
	// 所以用它的时候必须先过一遍"还在不在写"：一个正在跑的子代理，两次工具调用
	// 之间也长这样。
	// 只在**子代理会话**上算（见 indexSession 的 sidechain 参数）：主会话没有这个
	// 用途，而它是每次刷新都要全量扫的热路径。
	LastKind string `json:"lastKind"` // 末尾事件的 type（"assistant" / "user"）
	LastTool bool   `json:"lastTool"` // 末尾那条事件是一次**没拿到结果**的工具调用
}

type HistoryItem struct {
	Role string `json:"role"`
	At   string `json:"at"`
	Text string `json:"text"`
}

type ShellPayload struct {
	Sessions []Session `json:"sessions"`
	History    map[string][]HistoryItem `json:"history"` // key = sessionId
	StateDir   string                  `json:"stateDir"`
	// Cwd 是终端的工作目录。以前它是前端 HTML 里写死的一行文本（#p-path），
	// 那个副本从来没被更新过；现在由后端给出唯一一份事实，前端渲染到状态栏。
	Cwd string `json:"cwd"`
	// Titles 是**用户给会话起的名字**，键是 sessionId（见 titles.go 的说明）。
	// 后端是它的唯一一份事实：卡片和标签都读这里，用户起的名字压过 agent
	// 自己写在标题里的名字（Orca 的 tab.customTitle ?? tab.title）。
	Titles map[string]string `json:"titles"`
	// Projects 是左栏的主角：用户声明的项目池（见 projects.go），已排好序
	// （置顶在前，其余按组内最近活动倒序）并带上算出来的会话数。
	Projects []projectWire `json:"projects"`
	// Assign 是会话 id → 项目路径。**不在这张表里的就是「未归类」** ——
	// 前端不要自己重算归属（那样两边的口径会漂），也别把"没出现在表里"
	// 当成"归属为空字符串"：前者是一个真实分组，后者是数据的缺失。
	Assign map[string]string `json:"assign"`
	// Roots 是"去哪儿找项目"的根目录（发现/扫描的起点，见 projects.go）。
	Roots []string `json:"roots"`
}

// maxLine 是单行 JSON 的上限。attachment / file-history-snapshot 事件
// 里会内嵌整份文件内容，实测单行能到几 MB，默认的 64KB scanner 会直接报
// ErrTooLong 并**静默丢掉后面所有行** —— 那是很难查的错。
const maxLine = 24 << 20

func buildShellPayload(stateDir, cwd string, titles map[string]string) ShellPayload {
	sessions := scanSessions(stateDir)

	p := ShellPayload{
		StateDir: stateDir,
		Cwd:      cwd,
		Sessions: sessions,
		Titles:   titles,
		History:  make(map[string][]HistoryItem, len(sessions)),
	}
	// 每个会话都带上历史：点哪张卡就换哪条流。只带第一条的话，
	// 界面看起来能点其实是死的 —— 那是演示，不是产品。
	for _, s := range sessions {
		if h := tailHistory(s, stateDir, 30); len(h) > 0 {
			p.History[s.ID] = h
		}
	}
	// 项目池：归属与排序都从 sessions 这一遍里算（见 projects.go 的 projectStats）。
	// pool 为 nil = 池子没初始化（读盘失败），这时**不发 projects 字段**，
	// 让前端自己走"池子不可用"那条路，而不是收到一个空池子就以为用户没项目。
	if pool != nil {
		projects, roots := pool.snapshot()
		// 合成的默认工作区（见 projects.go）：并进这份副本，池子本身不动。
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

func scanSessions(stateDir string) []Session {
	root := filepath.Join(stateDir, "projects")
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []Session
	for _, proj := range projects {
		if !proj.IsDir() {
			continue
		}
		projDir := filepath.Join(root, proj.Name())
		files, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			// agent-*.jsonl 是子代理会话，归到所属主会话里计数，不独立成卡。
			if strings.HasPrefix(f.Name(), "agent-") {
				continue
			}
			s, ok := indexSession(filepath.Join(projDir, f.Name()), proj.Name(), false)
			if !ok {
				continue
			}
			// 子代理文件落在 <project>/<sessionId>/ 下。
			// 它们**独立成卡**：这个产品的卖点就是「看着一队 agent 并行干活」，
			// 把子代理折叠成一个数字，等于把最该看见的东西藏起来。
			siblings := []Session{}
			if sub, err := os.ReadDir(filepath.Join(projDir, s.ID, "subagents")); err == nil {
				for _, sf := range sub {
					if sf.IsDir() || !strings.HasPrefix(sf.Name(), "agent-") ||
						!strings.HasSuffix(sf.Name(), ".jsonl") {
						continue
					}
					s.Agents++
					a, ok := indexSession(filepath.Join(projDir, s.ID, "subagents", sf.Name()), proj.Name(), true)
					if !ok {
						continue
					}
					// 旁边那个 .meta.json 才是真正好用的东西：
					// 里面有 description（**人写的任务描述**）和 agentType。
					// 拿它当标题，卡片上就是「Extract Orca UI design spec」这种
					// 一眼能认的句子，而不是一串 agent-a726fb84… 的哈希。
					metaPath := filepath.Join(projDir, s.ID, "subagents",
						strings.TrimSuffix(sf.Name(), ".jsonl")+".meta.json")
					if mb, err := os.ReadFile(metaPath); err == nil {
						var m struct {
							AgentType   string `json:"agentType"`
							Description string `json:"description"`
						}
						if json.Unmarshal(mb, &m) == nil {
							a.AgentType = m.AgentType
							if strings.TrimSpace(m.Description) != "" {
								a.Title = m.Description
							}
						}
					}
					a.Sidechain = true
					a.Parent = s.ID
					// 子代理文件里 cwd/分支常常缺失，从主会话兜过来
					if a.Cwd == "" {
						a.Cwd = s.Cwd
					}
					if a.Branch == "" {
						a.Branch = s.Branch
					}
					siblings = append(siblings, a)
				}
			}
			out = append(out, s)
			out = append(out, siblings...)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out
}

// indexSession 读一份会话文件，填出一张卡的元信息。
// sidechain=true 时**额外**算 LastKind/LastTool（子代理三态里"已完成 / 已关闭"
// 的那条判据，理由见 Session 那两个字段的注释）—— 主会话不算，因为它是每次刷新
// 都要全量扫的热路径，而这份读数的唯一用途在子代理那边。
func indexSession(path, project string, sidechain bool) (Session, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Session{}, false
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return Session{}, false
	}

	s := Session{
		ID:      strings.TrimSuffix(filepath.Base(path), ".jsonl"),
		Project: project,
		Path:    path,
		Bytes:   info.Size(),
		Updated: info.ModTime().UTC().Format(time.RFC3339),
	}

	// 每条事件里都带 cwd/gitBranch，取最后一次为准；标题类字段只认第一次
	// （ai-title 是滚动的，越新的越贴合当前内容，所以它反过来取最后一次）。
	var firstUser string
	var lastEventTS string
	var lastKind string
	var lastTool bool

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), maxLine)
	for sc.Scan() {
		line := sc.Bytes()

		if bytes.Contains(line, []byte(`"type":"user"`)) {
			/* ⚠️ 上下文压缩行**也是 `"type":"user"`**（它是被折成一页的摘要，
			   不是你说的一轮）。不摘出来的话「N 轮」会被它一格一格地抬高，
			   而且第一句提问的位置上会站着一份 2 万字的摘要当标题 ——
			   界面上看着像"用户打了 2 万字"。判据就是它自己的标记
			   （`isCompactSummary:true`，本机 42/42 条压缩行都带），
			   见 transcript.go 的 consumeCompact。 */
			if !bytes.Contains(line, []byte(`"isCompactSummary":true`)) {
				/* ⚠️ 还有一类"以 user 轮的形状出现、但**不是你写的**"：斜杠命令的回显
				   （`<command-name>` / `<local-command-stdout>` / `<local-command-caveat>`）
				   和系统提醒。实测症状就在左栏上：有一行会话的标题是 `<local-comma…`，
				   而那一格其实只是敲过一次 `/xxx`；「N 轮」也把它算了一轮。
				   （实测那份转录 798928f6 的第一条 user 行就是 local-command-caveat。）

				   判据**不在这里再写一份名单**：transcript.go 的 systemTurn 已经按
				   "整条文本是不是以一个 <tag …> 开头"认过同一件事（那里判"这一行是谁
				   在说话"，好决定流水栏怎么显示）。两边必须认同一批 —— 否则会出现
				   "流水栏里藏起来了、标题里又冒出来"这种自相矛盾的界面。
				   只丢 drop=true 的那几种（只给模型看的：提醒 + 命令回显）；子代理回报、
				   跨会话消息照样算一轮、也能当标题 —— 那些是真的有话。

				   ⚠️ 那一层 prefilter 是**有意的**：extractText 要反序列化整行，而会话
				   索引是全量扫（143MB / 56 份），文件头第 3 条写着"靠 bytes.Contains
				   前置过滤，过滤后是毫秒级"。`"<` 这个序列两种编码都盖得住
				   （`"content":"<…"` 和 `"text":"<…"`），不写标签名 = 不引入第二份名单。 */
				drop := false
				if bytes.Contains(line, []byte(`"<`)) {
					if v := extractText(line, "user"); v != "" {
						_, drop = systemTurn(v)
					}
				}
				if !drop {
					s.Turns++
					if firstUser == "" {
						firstUser = extractText(line, "user")
					}
				}
			}
		}
		// C7：记下**最后一条**事件是什么（只认 assistant/user 两种 —— 其余
		// （summary/queue-operation…）对"它是不是正常收尾"这个问题没有说法，
		// 让它们**不改**这个记录，好过把上一次的答案抹成一个没意义的 kind）。
		// 判断顺序就是"哪条先匹配"，而一行里 `"type":"assistant"` 和
		// `"type":"tool_use"` 可以同时出现 —— 后者在前者的事件体里。
		if sidechain {
			if bytes.Contains(line, []byte(`"type":"assistant"`)) {
				lastKind = "assistant"
				lastTool = bytes.Contains(line, []byte(`"type":"tool_use"`))
			} else if bytes.Contains(line, []byte(`"type":"user"`)) {
				lastKind, lastTool = "user", false
			}
		}
		// 下面几个都是「只在该键出现时才解析」，避免全量 json.Unmarshal
		if s.Cwd == "" && bytes.Contains(line, []byte(`"cwd":"`)) {
			s.Cwd = stringField(line, "cwd")
		}
		if bytes.Contains(line, []byte(`"gitBranch":"`)) {
			if v := stringField(line, "gitBranch"); v != "" {
				s.Branch = v
			}
		}
		if bytes.Contains(line, []byte(`"timestamp":"`)) {
			if v := stringField(line, "timestamp"); v != "" {
				lastEventTS = v
			}
		}
		if bytes.Contains(line, []byte(`"slug":"`)) {
			if v := stringField(line, "slug"); v != "" && s.Slug == "" {
				s.Slug = v
			}
		}
		if bytes.Contains(line, []byte(`"aiTitle":"`)) {
			if v := stringField(line, "aiTitle"); v != "" {
				s.Title = v // 取最后一次
			}
		}
		if bytes.Contains(line, []byte(`"lastPrompt":"`)) {
			if v := stringField(line, "lastPrompt"); v != "" {
				s.Preview = v // 取最后一次
			}
		}
		if bytes.Contains(line, []byte(`"permissionMode":"`)) {
			if v := stringField(line, "permissionMode"); v != "" {
				s.Permission = v
			}
		}
		if bytes.Contains(line, []byte(`"agentName":"`)) {
			if v := stringField(line, "agentName"); v != "" && s.AgentName == "" {
				s.AgentName = v
			}
		}
		if bytes.Contains(line, []byte(`"attributionAgent":"`)) {
			if v := stringField(line, "attributionAgent"); v != "" && s.AgentName == "" {
				s.AgentName = v
			}
		}
		if bytes.Contains(line, []byte(`"isSidechain":true`)) {
			s.Sidechain = true
		}
	}
	if err := sc.Err(); err != nil {
		// 读不动就用已有的一半信息，别整条丢掉
		return s, s.Cwd != "" || s.Title != ""
	}

	// 时间用**事件里的最大时间戳**，比文件 mtime 准：mtime 会被 touch、
	// 备份还原、同步工具改，而事件时间戳是写进去就不动的。
	if lastEventTS != "" {
		s.Updated = lastEventTS
	}
	if sidechain {
		s.LastKind, s.LastTool = lastKind, lastTool
	}

	// 五级标题降级。空字符串一路往下掉，不会出现「有 slug 没标题」的卡。
	if s.Title == "" {
		s.Title = s.Slug
	}
	if s.Title == "" {
		s.Title = s.AgentName
	}
	if s.Title == "" {
		s.Title = clamp(firstUser, 80)
	}
	if s.Title == "" {
		s.Title = s.ID
	}
	if s.Preview == "" {
		s.Preview = clamp(firstUser, 160)
	}
	return s, true
}

// tailHistory 取一个会话最近的对话轮次，给右侧「历史流」用。
// 全部读进来再截尾是浪费 —— 但两个流式读（先定位再回读）在开发阶段
// 不值当，5MB 扫一遍是毫秒级，先这样。
func tailHistory(s Session, stateDir string, keep int) []HistoryItem {
	path := filepath.Join(stateDir, "projects", s.Project, s.ID+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	items := make([]HistoryItem, 0, keep)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), maxLine)
	for sc.Scan() {
		line := sc.Bytes()
		var role string
		switch {
		case bytes.Contains(line, []byte(`"type":"user"`)):
			role = "user"
		case bytes.Contains(line, []byte(`"type":"assistant"`)):
			role = "assistant"
		default:
			continue
		}
		text := extractText(line, role)
		if text == "" {
			continue // 纯 tool_use / attachment 轮次，历史流里没有信息量
		}
		items = append(items, HistoryItem{
			Role: role,
			At:   stringField(line, "timestamp"),
			Text: clamp(text, 300),
		})
	}
	if len(items) > keep {
		items = items[len(items)-keep:]
	}
	return items
}

// extractText 从一条事件里抠出人类可读文本。
//
// message.content 在这个 fork 里**两种形状都出现过**：主线是 string，
// 但也有 array of blocks。上游 Claude Code 是 array。两种都得吃，
// 否则换个版本就整个历史流空白。
func extractText(line []byte, role string) string {
	var ev struct {
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		LastPrompt string `json:"lastPrompt"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return ""
	}
	if ev.Message == nil {
		return ""
	}
	raw := bytes.TrimSpace(ev.Message.Content)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return cleanText(s)
		}
		return ""
	}
	if raw[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &blocks) == nil {
			for _, b := range blocks {
				if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
					return cleanText(b.Text)
				}
			}
		}
	}
	return ""
}

// cleanText 去掉终端控制序列和换行，让卡片上那一行是干净的一句话。
func cleanText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == 0x1b: // ESC：吃掉整个 CSI/OSC 序列
			i++
			if i < len(s) && s[i] == '[' {
				for i+1 < len(s) && (s[i+1] < 0x40 || s[i+1] > 0x7e) {
					i++
				}
				i++
			}
		case c == '\r' || c == '\n' || c == '\t':
			b.WriteByte(' ')
		case c < 0x20:
			// 其它控制字符丢掉
		default:
			b.WriteByte(c)
		}
	}
	return strings.TrimSpace(strings.Join(strings.Fields(b.String()), " "))
}

func stringField(line []byte, key string) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(line, &m); err != nil {
		return ""
	}
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return cleanText(s)
	}
	return ""
}

func clamp(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
