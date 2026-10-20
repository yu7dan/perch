package transcript

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
)

// toolInput 把工具参数解成好查的小对象（值都当字符串用，够 describeTool 用）。
type toolInput map[string]json.RawMessage

func decodeInput(raw json.RawMessage) toolInput {
	var m toolInput
	if json.Unmarshal(raw, &m) != nil {
		return toolInput{}
	}
	return m
}

func (t toolInput) str(k string) string {
	v, ok := t[k]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(v, &s) == nil {
		return s
	}
	return ""
}

// describeTool 给一条工具调用写一句"它在干什么"，并返回要记进台账的路径。
func describeTool(name string, in toolInput) (text, path string) {
	switch name {
	case "Read", "Edit", "Write", "NotebookEdit":
		path = in.str("file_path")
		if path == "" {
			path = in.str("notebook_path")
		}
		return name + " " + filepath.Base(path), path
	case "PowerShell", "Bash":
		c := strings.TrimSpace(in.str("command"))
		if i := strings.IndexByte(c, '\n'); i >= 0 {
			c = c[:i]
		}
		d := in.str("description")
		if d != "" {
			return d, ""
		}
		return clip(c, 120), ""
	case "Grep":
		return "Grep " + in.str("pattern"), ""
	case "Glob":
		return "Glob " + in.str("pattern"), ""
	case "Agent", "Task":
		d := in.str("description")
		if d == "" {
			d = in.str("subagent_type")
		}
		return "子代理：" + clip(d, 100), ""
	case "AskUserQuestion":
		// **把问题本身带出来**，而不是留一个"提问"就完事：
		// 「需要你」那一行要回答"它在问我什么"，光说"它在提问"等于没说。
		// 形状实测：input 是 {questions:[{question,header,options,multiSelect}]}。
		// （选项本身不在这里 —— 它挂在 ActItem.Qs 上，见 consumeAssistant。）
		qs := readQuestions(in)
		if len(qs) == 0 {
			return "提问", ""
		}
		if len(qs) > 1 {
			return "提问：" + clip(qs[0].Q, 100) + "（" + strconv.Itoa(len(qs)) + " 个问题）", ""
		}
		return "提问：" + clip(qs[0].Q, 100), ""
	case "TodoWrite":
		return "更新待办", ""
	}
	return name, ""
}

// readQuestions 从 AskUserQuestion 的入参里把**问题和选项都**读出来。
//
// 它原来是 firstQuestion，只取第一问的原文和问题数 —— 选项全扔了。
// 「收起后进群组」那一轮要的正是选项（要点、要看 description/preview），
// 而转录里本来就有，扔掉它等于把已经到手的东西再丢一次。
//
// 形状是本机实测的（不是查文档）：
//
//	input = {"questions":[{"question":…,"header":…,"multiSelect":false,
//	                       "options":[{"label":…,"description":…,"preview":…}]}]}
//
// 两个字段都可能缺：question 空时退回 header（问题原文为空的那一行，
// 前端画出来会是一行空白）；两个都空的那一问仍然**保留**（它的 options 可能有用），
// 只是没有标题。
func readQuestions(in toolInput) []QAsk {
	raw := in["questions"]
	if len(raw) == 0 {
		return nil
	}
	var qs []struct {
		Question    string `json:"question"`
		Header      string `json:"header"`
		MultiSelect bool   `json:"multiSelect"`
		Options     []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
			Preview     string `json:"preview"`
		} `json:"options"`
	}
	if json.Unmarshal(raw, &qs) != nil || len(qs) == 0 {
		return nil
	}
	out := make([]QAsk, 0, len(qs))
	for _, q := range qs {
		qk := QAsk{Q: strings.TrimSpace(q.Question), Header: strings.TrimSpace(q.Header),
			Multi: q.MultiSelect}
		if qk.Q == "" {
			qk.Q = qk.Header
		}
		for _, o := range q.Options {
			op := QOpt{Label: o.Label, Desc: clip(o.Description, 600),
				Prev: cutRunes(o.Preview, qPreviewMax)}
			if op.Label == "" && op.Desc == "" && op.Prev == "" {
				continue // 空选项画出来是一条没有字的行，不如不要
			}
			qk.Opts = append(qk.Opts, op)
		}
		out = append(out, qk)
	}
	return out
}

// askShape 给日志用：每问几个选项，按问题顺序连起来（"每问 3/2 个选项"）。
func askShape(qs []QAsk) string {
	if len(qs) == 0 {
		return "没读到问题（input 形状变了？）"
	}
	parts := make([]string, 0, len(qs))
	for _, q := range qs {
		parts = append(parts, strconv.Itoa(len(q.Opts)))
	}
	return "每问 " + strings.Join(parts, "/") + " 个选项"
}

// qPreviewMax 一个 preview 最多带多少字符。
//
// 为什么要有上限：preview 是**逐字节进每一帧推送**的（流水是增量推、但同一条
// 改动会重推），而它是人写的排版块，没有天然上界。Orca 那边给的量级是 16000
// （它整个 interactivePrompt 的上限）。我们这里一条流水会发给**所有**格子视图，
// 所以按"一屏最多看清多少"来定，而不是照抄它的 16000：1200 字符大约是一整块
// 影响面列表，再多本来也读不完。
const qPreviewMax = 1200

// fileOp 把工具名映射成台账里的动作类型。不是文件类工具就返回 false。
func fileOp(tool string) (string, bool) {
	switch tool {
	case "Read":
		return "read", true
	case "Edit", "NotebookEdit":
		return "edit", true
	case "Write":
		return "write", true
	}
	return "", false
}
