package transcript

import (
	"encoding/json"
	"log"
	"strconv"
	"strings"
)

// consumeLine 吃一行，返回**新增或更新后**的流水条（没有就返回 nil）。
// 返回值既用于"追加"，也用于"原地更新"—— 前端按 id 覆盖。
func (tr *trace) consumeLine(line string) *ActItem {
	if !strings.Contains(line, `"type":`) {
		return nil
	}
	var ev struct {
		Type          string          `json:"type"`
		Timestamp     string          `json:"timestamp"`
		Message       json.RawMessage `json:"message"`
		ToolUseResult json.RawMessage `json:"toolUseResult"`

		// 上下文压缩那三个字段（只有压缩行有，见 consumeCompact）
		IsCompactSummary bool `json:"isCompactSummary"`
		TurnPosition     *struct {
			PromptIndex int `json:"promptIndex"`
			TurnIndex   int `json:"turnIndex"`
		} `json:"turnPosition"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	switch ev.Type {
	case "assistant":
		return tr.consumeAssistant(ev.Message, ev.Timestamp)
	case "user":
		// ⚠️ 压缩行**也是 user 轮的形状**，而且消息体比普通提问大一个量级
		// （实测 17–26KB vs 几百字），所以从前它整段以"你说的话"的样子
		// 混进流水、还占掉了「N 轮」里的一轮。判据放在这里、**先于**其它两条。
		if ev.IsCompactSummary {
			turn := 0
			if ev.TurnPosition != nil {
				turn = ev.TurnPosition.TurnIndex
			}
			return tr.consumeCompact(ev.Message, ev.Timestamp, turn)
		}
		if len(ev.ToolUseResult) > 0 {
			return tr.consumeResult(ev.Message, ev.ToolUseResult, ev.Timestamp)
		}
		return tr.consumePrompt(ev.Message, ev.Timestamp)
	}
	return nil
}

func (tr *trace) consumeAssistant(raw json.RawMessage, at string) *ActItem {
	var msg struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	var last *ActItem
	for _, b := range msg.Content {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			txt, full := msgText(b.Text)
			last = tr.append(ActItem{Kind: "text", Text: txt, FullLen: full, At: at})
		case "thinking":
			// 思考过程也是流水的一部分（用户能看出"它在想"还是在"卡着"）
			last = tr.append(ActItem{Kind: "thinking", Text: "思考…", At: at})
		case "tool_use":
			in := decodeInput(b.Input)
			it := ActItem{ID: b.ID, Kind: "tool", Tool: b.Name, At: at}
			it.Text, it.Path = describeTool(b.Name, in)
			if it.Path != "" {
				it.Rel = tr.rel(it.Path)
			}
			if b.Name == "Agent" || b.Name == "Task" {
				it.Agent = in.str("description")
			}
			if b.Name == "AskUserQuestion" {
				it.Qs = readQuestions(in)
				// 落一行事实：这条流水是「它在等你答」的**唯一**证据来源，
				// 而"到底带出来几问几选项"只有日志说得清（前端画出来不一定在屏幕上）。
				log.Printf("[trace] AskUserQuestion 提问：%d 问，%s（待答 —— 就等它的 tool_result）",
					len(it.Qs), askShape(it.Qs))
			}
			// 被拒绝的 Write/Edit 在结果里没有正文，只能靠调用参数回放 ——
			// 所以这里先把它们截断后留在 pending 里（上限见 maxPendingToolText）。
			pd := pending{tool: b.Name, path: it.Path}
			if _, isFile := fileOp(b.Name); isFile {
				pd.content, _ = cutUTF8(in.str("content"), maxPendingToolText)
				pd.old, _ = cutUTF8(in.str("old_string"), maxPendingToolText)
				pd.new, _ = cutUTF8(in.str("new_string"), maxPendingToolText)
			}
			tr.wait[b.ID] = pd
			// 文件类工具先记一笔"碰过"（成败和 ±N 等结果回来再补）
			if op, ok := fileOp(b.Name); ok && it.Path != "" {
				tr.touch(it.Path, op, 0, 0, at)
			}
			last = tr.append(it)
		}
	}
	return last
}

func (tr *trace) consumePrompt(raw json.RawMessage, at string) *ActItem {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	txt := textOf(msg.Content)
	if strings.TrimSpace(txt) == "" {
		return nil
	}
	// 壳层塞进 user 轮的那些东西不是"你说的话"（理由见 SystemTurn）。
	// 不分类的话「流水」里会混进一屏看起来像你在说话的系统条目 ——
	// 实测：本会话自己的转录里 `system-reminder` 出现 2814 次，
	// 它们全都是以 user 轮的形状落盘的。
	if label, drop := SystemTurn(txt); drop {
		return nil
	} else if label != "" {
		return tr.append(ActItem{Kind: "system", Text: label, At: at})
	}
	ptxt, pfull := msgText(txt)
	return tr.append(ActItem{Kind: "prompt", Text: ptxt, FullLen: pfull, At: at})
}

/*
consumeCompact 吃一条**上下文压缩**行。

	这是 Claude Code 自带的机制，发生在**一个会话文件的内部**：把此前若干回合
	折成一页摘要落进转录（`isCompactSummary:true`、`isVisibleInTranscriptOnly:true`，
	`message.content` 是**字符串**而不是块数组）。它**不是**一次新的会话 ——
	所以它在界面上是**会话内部的节点**，不是左边栏的一行、也不算一轮。

	为什么它非要单独一条 Kind：从前它走 consumePrompt，于是那 17–26KB 的摘要
	以"你说的一大段话"的样子占满流水，还把 store.go 的「N 轮」抬高一格
	（那一行同样是 `"type":"user"`）。界面上看着就是"用户打了 2 万字"。

	⚠️ **不画 token 数**。计划书里那张 `98k → 21k` 的图是照 Orca 的形态画的，
	落地时按实测降级了：本机 42 条压缩行里 `compact_metadata` **一次都没出现**。
	`summarizedTurnPromptUuids` 也不是"吞了几回合"的清单（1 个 / 没有）。
	所以这里只报两个转录里真有的数：**第几回合**、**距上次压缩几个回合**。
*/
func (tr *trace) consumeCompact(raw json.RawMessage, at string, turn int) *ActItem {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	txt := textOf(msg.Content)
	if strings.TrimSpace(txt) == "" {
		return nil
	}
	txt, full := msgText(txt)
	it := ActItem{Kind: "compact", Text: txt, FullLen: full, At: at, Turn: turn}
	// 回合号偶尔缺失（实测 1/42），缺了就两个数都不报 —— 不猜。
	// 也要求递增：同一份转录被整读两遍、或者反过来拿到旧的一行时，
	// 相减会得到负数或负数长度的"距离"，那种数不如不显示。
	if turn > 0 && tr.lastCompactTurn > 0 && turn > tr.lastCompactTurn {
		it.Swallowed = turn - tr.lastCompactTurn
	}
	if turn > 0 {
		tr.lastCompactTurn = turn
	}
	// 一行事实：几个压缩点、各在第几回合、摘要多大（前端画出来不一定在屏幕上）。
	// 这条日志也是"`N 轮` 有没有被压缩行抬高"的对照物。
	pos, dist := "回合未知", ""
	if it.Turn > 0 {
		pos = "第 " + strconv.Itoa(it.Turn) + " 回合"
	}
	if it.Swallowed > 0 {
		dist = "，距上次 " + strconv.Itoa(it.Swallowed) + " 回合"
	}
	cut := ""
	size := full
	if size > 0 {
		cut = "，截到 " + strconv.Itoa(msgMax) + " 字送出"
	} else {
		size = len([]rune(txt)) // full==0 表示没截，txt 就是原文
	}
	log.Printf("[trace] 上下文压缩点：%s%s，摘要 %d 字%s", pos, dist, size, cut)
	return tr.append(it)
}

// SystemTurn 认出"以 user 轮的形状出现、但不是用户说的话"的那些条目。
//
// ⚠️ 它是**按形状**认的，不是按一张写死的名单：转录里没有任何字段标着
// "这条是系统消息"（实测过，它就是普通的 type=user），而这类包装会跟着
// claude 的版本增加（task-notification / cross-session-message / … 都是这条路的）。
// 所以判据收在"整条文本以一个形如 <tag …> 的标签开头"这一点上。
// 代价：你**手打**一段以 `<` 开头的 XML 也会被归成系统条目 ——
// 不影响读（正文照样在），只是那一行的字形和标签换了个说法。
//
// 返回 (标签, 丢掉)。丢掉的那几个是**只给模型看**的（提醒、命令回显），
// 混在"你说过什么"里只会把这一栏变成噪音。
// proseWrappers 是"白话在前、标签在后"那类包装的开头。
//
// 它是**名单**不是判据 —— 白话没有形状可认，而这类包装会跟着 harness 版本增加。
// 漏掉一条的代价可控：那一行还按 prompt 显示（看得见，只是标签不对），不会丢内容。
var proseWrappers = []struct{ prefix, label string }{
	{"Another Claude session sent a message:", "跨会话消息"},
}

func SystemTurn(txt string) (label string, drop bool) {
	s := strings.TrimSpace(txt)
	// 第一类形状：**先一行白话、下一行才是标签**。实测（对应 SubagentStop
	// agent_id=a3e601df 那条）原文是：
	//     Another Claude session sent a message:
	//     <agent-message from="a3e601dfd9259f93a">
	//     [Subagent hand-back] …（子代理的最终报告）
	// 只按"以 < 开头"去认的话，这一整段会当成**你自己说的**一句话落进流水
	// （实测就是这么混进来的：一行 300 字的 prompt）。
	// 所以白话前缀必须排在标签判据**前面** —— 它的第一个字符不是 '<'。
	for _, w := range proseWrappers {
		if !strings.HasPrefix(s, w.prefix) {
			continue
		}
		// 框里那行能进一步说清"是谁"：子代理交回报告、和别的会话发来的消息，
		// 走的是同一层包装，脸一样、牌子不一样。认不出来就退回宽的那个说法 ——
		// 错的只是**谁**，不会错成"你在说话"。
		// 正文刻意不进流水：它可能是几千 token 的长报告，而这一栏是
		// "一眼看过去发生了什么"，不是阅读器（正文在终端里本来就在）。
		if strings.Contains(s, "Subagent hand-back") {
			return "子代理回报", false
		}
		return w.label, false
	}
	if !strings.HasPrefix(s, "<") {
		return "", false
	}
	end := strings.IndexAny(s, "> \n\t")
	if end < 6 || end > 40 { // <6 的是 <b> 这种，40 以上不像标签了
		return "", false
	}
	name := s[1:end]
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return "", false
		}
	}
	switch name {
	case "system-reminder", "command-name", "command-message",
		"local-command-stdout", "local-command-caveat":
		return "", true
	case "task-notification":
		return "任务通知", false
	case "cross-session-message":
		return "跨会话消息", false
	}
	return name, false
}

// consumeResult 处理工具返回。这是"成了没有 / 加了几行"的唯一来源。
func (tr *trace) consumeResult(raw, res json.RawMessage, at string) *ActItem {
	// 先把这个结果对应到哪次调用（tool_use_id 在 message.content[] 里）
	var msg struct {
		Content []struct {
			Type      string          `json:"type"`
			ToolUseID string          `json:"tool_use_id"`
			IsError   bool            `json:"is_error"`
			Content   json.RawMessage `json:"content"`
		} `json:"content"`
	}
	_ = json.Unmarshal(raw, &msg)
	var id string
	sawErr := false
	errText := ""
	for _, b := range msg.Content {
		if b.Type == "tool_result" && b.ToolUseID != "" {
			id = b.ToolUseID
			if b.IsError {
				sawErr = true
				errText = strings.TrimSpace(textOf(b.Content))
			}
			break
		}
	}

	var r map[string]json.RawMessage
	resText := ""
	if json.Unmarshal(res, &r) != nil {
		// 工具报错时 toolUseResult 可能直接是一段字符串（实测形状：
		// "Error: Exit code 2\n…"）。它不是对象，别当成"结果里什么都没有"。
		var s string
		if json.Unmarshal(res, &s) == nil {
			resText = strings.TrimSpace(s)
		}
		r = nil
	}
	if errText == "" {
		errText = resText
	}

	// ±N：Edit 的结果里是标准 unified diff。readPatch 同时留一份**有上限**的
	// 可展示 hunk（原来的 countPatch 只数数，正文被丢掉了 —— 这正是
	// "点开文件看不到改了什么"的根因）。
	hunks, add, del, patchTrunc := readPatch(r["structuredPatch"])
	ok := !sawErr
	// Bash：interrupted 表示被打断（不算成功）
	if v, has := r["interrupted"]; has {
		var b bool
		if json.Unmarshal(v, &b) == nil && b {
			ok = false
			if errText == "" {
				errText = "被打断"
			}
		}
	}
	// Write 的 content：行数就是新增。
	// ⚠️ 尾换行不算额外一行 —— 实测写出来的文件是 "a\nB\nc\n"（6 字节、3 个 LF），
	// 而 `Count("\n")+1` 会数成 4。第一次跑就是这么错的，对着真文件核才看出来。
	if v, has := r["content"]; has && r["type"] != nil {
		var s string
		if json.Unmarshal(v, &s) == nil && add == 0 {
			add = strings.Count(s, "\n")
			if s != "" && !strings.HasSuffix(s, "\n") {
				add++
			}
		}
	}

	// 更新台账（文件路径优先用结果里的 filePath/filenames，比调用参数更权威）
	path := ""
	for _, k := range []string{"filePath", "notebookPath"} {
		if v, has := r[k]; has {
			_ = json.Unmarshal(v, &path)
		}
	}
	if path == "" {
		if v, has := r["filenames"]; has {
			var fs []string
			if json.Unmarshal(v, &fs) == nil && len(fs) > 0 {
				path = fs[0]
			}
		}
	}
	p := tr.wait[id]
	tool := p.tool
	if path == "" {
		path = p.path
	}
	if tool == "" && r["structuredPatch"] != nil {
		tool = "Edit"
	}
	// 文件类工具成功时结果一定是对象；拿到的是字符串 = 失败（即使
	// tool_result 那一块漏了 is_error，也不能把一次报错记成"已落盘"）。
	if r == nil && resText != "" {
		if _, isFile := fileOp(tool); isFile {
			ok = false
		}
	}

	// 文件类工具：Read 不参与改动正文。
	if op, isFile := fileOp(tool); isFile && path != "" {
		if op == "read" {
			if ok && (add > 0 || del > 0) {
				tr.touch(path, op, add, del, at)
			}
		} else {
			tr.recordChange(path, op, add, del, at, fileChangeOf(tool, p, r, at, ok, errText,
				hunks, add, del, patchTrunc))
		}
	}
	// 「子代理」：Agent 工具的结果里带 agentId，直接对上 subagents\agent-<id>.jsonl。
	// 这个 id 也是 hook 的 SubagentStart/Stop 报的那个 agent_id —— 所以把它落在
	// 流水条上，前端就能把"转录里的描述/结果"和"hook 报的类型/存活"对上，
	// 而且以后要跟着**子代理自己**的转录看它干了什么，入口也是这一个 id。
	var agentID string
	if v, has := r["agentId"]; has {
		if json.Unmarshal(v, &agentID) != nil {
			agentID = ""
		}
		if agentID != "" {
			log.Printf("[trace] Agent 子会话 agentId=%s（%s）", short(agentID), clip(p.path, 80))
		}
	}
	// AskUserQuestion 的答案：map[**问题原文**]选中的 label（形状取自工具自己的
	// output schema）。它和"有没有结果"是**两件事** —— 结果本身由下面的 OK 表达，
	// 这里只补上"选了哪个"，好在"已答"那一态里把那句话说完整。
	var answers map[string]string
	if v, has := r["answers"]; has {
		_ = json.Unmarshal(v, &answers)
	}

	delete(tr.wait, id)

	// 原地更新那条流水（前端按 id 覆盖）
	if idx, has := tr.byID[id]; has && id != "" {
		it := &tr.acts[idx]
		it.OK = &ok
		if add > 0 || del > 0 {
			it.Add, it.Del = add, del
		}
		if agentID != "" {
			it.Agent = agentID
		}
		if len(answers) > 0 {
			it.Answers = answers
			// 按**问题的顺序**取第一条来记 —— map 的遍历顺序是随机的，
			// 直接 range 每次打出的可能是不同的一条，"验一遍"就对不上。
			first := ""
			if len(it.Qs) > 0 {
				first = "（" + clip(answers[it.Qs[0].Q], 60) + "）"
			}
			log.Printf("[trace] AskUserQuestion 已答 %d 问%s（OK=%v）", len(answers), first, ok)
		}
		if it.Text == "" {
			it.Text = tool
		}
		return it
	}
	return nil
}

func (tr *trace) append(it ActItem) *ActItem {
	// 没有 id 的（prompt/text/system/thinking）补一个。前缀 "s" 和 tool_use_id
	// （`call_00_…`）不会撞；序号只增不减，所以同一份转录读两次得到同一批 id。
	if it.ID == "" {
		tr.seq++
		it.ID = "s" + strconv.Itoa(tr.seq)
	}
	tr.acts = append(tr.acts, it)
	/* ⚠️ 砍头和取下标**顺序不能反**。原来写的是先 `idx = len(acts)-1`、砍完再
	   `return &tr.acts[idx]` —— 砍之前 idx=300，砍完这个切片只剩 300 个元素
	   （下标 0..299），`tr.acts[300]` 当场 **index out of range [300] with length 300**，
	   跟随协程**整个死掉**：从此这一格的「流水/改动」两条腿一起静默停更，
	   界面上什么都看不出来（日志里那串 panic 是唯一的痕迹）。
	   它平时不出现，是因为要一条会话攒到 300 条以上才踩得到 —— 我灌了 320 条
	   一次性读入，才把它炸出来（负结果也是证据）。 */
	if len(tr.acts) > maxActs {
		drop := len(tr.acts) - maxActs
		tr.acts = append([]ActItem(nil), tr.acts[drop:]...)
		// 下标全变了：重建（比记一堆偏移简单，而且只在砍的时候发生）
		tr.byID = map[string]int{}
		for i, a := range tr.acts {
			tr.byID[a.ID] = i
		}
		// 砍的是**头**，新来的那条（也就是 return 的那条）永远还在最后。
		return &tr.acts[len(tr.acts)-1]
	}
	idx := len(tr.acts) - 1
	tr.byID[it.ID] = idx
	return &tr.acts[idx]
}
