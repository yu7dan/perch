package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Scan 扫一遍 stateDir\projects，返回所有会话（含子代理）与日活聚合。
//
// systemTurn 是注入的「这一条以 user 轮的形状出现、但不是用户说的话」判据
// （实现见 transcript.SystemTurn）：返回 (标签, 丢掉)。nil 视为不丢任何条目。
// 注入而不是 import，是为了让本包保持为叶子。
func Scan(stateDir string, systemTurn func(string) (string, bool)) ([]Session, []DayActivity) {
	if systemTurn == nil {
		systemTurn = func(string) (string, bool) { return "", false }
	}
	root := filepath.Join(stateDir, "projects")
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil, nil
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
			s, ok := indexSession(filepath.Join(projDir, f.Name()), proj.Name(), false, systemTurn)
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
					a, ok := indexSession(filepath.Join(projDir, s.ID, "subagents", sf.Name()), proj.Name(), true, systemTurn)
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

	/* 日活聚合：把每份文件自己的 day → 轮次 并成一张全局表。
	   sessions 只在**这份文件当天确实有轮次**时 +1 —— 它是"这一天有几个
	   会话/子代理写过东西"，不是"这一天启动过几个会话"。 */
	byDay := make(map[string]*DayActivity, 366)
	for _, s := range out {
		for day, n := range s.days {
			a := byDay[day]
			if a == nil {
				a = &DayActivity{Day: day}
				byDay[day] = a
			}
			a.Turns += n
			a.Sessions++
		}
	}
	activity := make([]DayActivity, 0, len(byDay))
	for _, a := range byDay {
		activity = append(activity, *a)
	}
	sort.Slice(activity, func(i, j int) bool { return activity[i].Day < activity[j].Day })
	return out, activity
}

// indexSession 读一份会话文件，填出一张卡的元信息。
// sidechain=true 时**额外**算 LastKind/LastTool（子代理三态里"已完成 / 已关闭"
// 的那条判据，理由见 Session 那两个字段的注释）—— 主会话不算，因为它是每次刷新
// 都要全量扫的热路径，而这份读数的唯一用途在子代理那边。
func indexSession(path, project string, sidechain bool, systemTurn func(string) (string, bool)) (Session, bool) {
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

		// 这一行的时间戳只解析一次：下面日活聚合要用，lastEventTS 也要用。
		// （stringField 会整行反序列化，同一行解两遍纯属浪费。）
		var lineTS string
		if bytes.Contains(line, []byte(`"timestamp":"`)) {
			if v := stringField(line, "timestamp"); v != "" {
				lineTS = v
				lastEventTS = v
			}
		}

		if bytes.Contains(line, []byte(`"type":"user"`)) {
			/* ⚠️ 上下文压缩行**也是 `"type":"user"`**（它是被折成一页的摘要，
			   不是你说的一轮）。不摘出来的话「N 轮」会被它一格一格地抬高，
			   而且第一句提问的位置上会站着一份 2 万字的摘要当标题 ——
			   界面上看着像"用户打了 2 万字"。判据就是它自己的标记
			   （`isCompactSummary:true`，本机 42/42 条压缩行都带），
			   见 transcript 包的 consumeCompact。 */
			if !bytes.Contains(line, []byte(`"isCompactSummary":true`)) {
				/* ⚠️ 还有一类"以 user 轮的形状出现、但**不是你写的**"：斜杠命令的回显
				   （`<command-name>` / `<local-command-stdout>` / `<local-command-caveat>`）
				   和系统提醒。实测症状就在左栏上：有一行会话的标题是 `<local-comma…`，
				   而那一格其实只是敲过一次 `/xxx`；「N 轮」也把它算了一轮。
				   （实测那份转录 798928f6 的第一条 user 行就是 local-command-caveat。）

				   判据**不在这里再写一份名单**：transcript 包的 SystemTurn 已经按
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
					if v := extractText(line); v != "" {
						_, drop = systemTurn(v)
					}
				}
				if !drop {
					s.Turns++
					// 日活按**本地日期**归天：UTC 的 23:30 在中国是第二天早上 7:30，
					// 直接截字符串前 10 位会让跨时区用户的"今天"错一天。
					if day := localDay(lineTS); day != "" {
						if s.days == nil {
							s.days = make(map[string]int, 32)
						}
						s.days[day]++
					}
					if firstUser == "" {
						firstUser = extractText(line)
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
