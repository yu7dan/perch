package transcript

import (
	"encoding/json"
	"strings"
	"time"
)

// DeepSeek Harness 的 session.v4.jsonl（zstd 帧流，解压后）实测：
//
//	{"type":"user/message","seq":10,"time":…,"data":{
//	  "content":[{"type":"text","text":"…"}],"source":{"kind":"user"}}}
//	{"type":"assistant/message","data":{"turn":1,"step":1,"message":{"role":"assistant",
//	  "content":[{"type":"reasoning","text":…},{"type":"text","text":…},
//	            {"type":"tool_use","id":"…","name":"…","input":{…}}]}}}
//	{"type":"tool/result",…}     ← 工具结果的形状随版本，按字段找
//	{"type":"turn/start"/"turn/end",…}
//
// 文件里还有 request/header、hook/*、session/title 等簿记记录 —— 它们不进流水。
func (tr *trace) consumeDshLine(line string) *ActItem {
	var ev struct {
		Type string          `json:"type"`
		Time int64           `json:"time"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	at := dshAt(ev.Time)
	switch ev.Type {
	case "user/message":
		return tr.consumeDshUser(ev.Data, at)
	case "assistant/message":
		return tr.consumeDshAssistant(ev.Data, at)
	case "turn/start":
		return tr.append(ActItem{Kind: "system", Text: "开始一轮", At: at})
	case "turn/end":
		var d struct {
			Reason struct {
				Kind string `json:"kind"`
			} `json:"reason"`
		}
		_ = json.Unmarshal(ev.Data, &d)
		if d.Reason.Kind != "" && d.Reason.Kind != "completed" {
			return tr.append(ActItem{Kind: "system", Text: "本轮结束：" + d.Reason.Kind, At: at})
		}
		return nil
	}
	if strings.HasPrefix(ev.Type, "tool/") {
		return tr.consumeDshTool(ev.Type, ev.Data, at)
	}
	return nil
}

func dshAt(ms int64) string {
	if ms <= 0 {
		return nowAt()
	}
	return time.UnixMilli(ms).Format(time.RFC3339)
}

func (tr *trace) consumeDshUser(raw json.RawMessage, at string) *ActItem {
	var d struct {
		Content json.RawMessage `json:"content"`
		Source  struct {
			Kind string `json:"kind"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil
	}
	// 只有真正来自人的那一条才是 prompt。hook/context/system 注入的 user/message
	// 在 DSH 里也是同一个 type（实测每轮 3–4 条），必须按 source 分开。
	if d.Source.Kind != "" && d.Source.Kind != "user" {
		return nil
	}
	txt := msgTextOf(d.Content)
	if strings.TrimSpace(txt) == "" || dshIsContext(txt) {
		return nil
	}
	if label, drop := SystemTurn(txt); drop {
		return nil
	} else if label != "" {
		return tr.append(ActItem{Kind: "system", Text: label, At: at})
	}
	out, full := msgText(txt)
	return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
}

func dshIsContext(txt string) bool {
	s := strings.TrimSpace(txt)
	return strings.HasPrefix(s, "<system-reminder>") ||
		strings.HasPrefix(s, "Current runtime context.") ||
		strings.HasPrefix(s, "Time sampled while preparing") ||
		strings.HasPrefix(s, "You are an AI agent powered by DeepSeek Harness.")
}

func (tr *trace) consumeDshAssistant(raw json.RawMessage, at string) *ActItem {
	var d struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil
	}
	content := d.Message.Content
	if len(content) == 0 {
		content = d.Content
	}
	var blocks []struct {
		Type     string          `json:"type"`
		Text     string          `json:"text"`
		Thinking string          `json:"thinking"`
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Input    json.RawMessage `json:"input"`
		Output   json.RawMessage `json:"output"`
		IsError  bool            `json:"is_error"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return nil
	}
	var last *ActItem
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			out, full := msgText(b.Text)
			last = tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
		case "reasoning", "thinking":
			t := strings.TrimSpace(b.Thinking)
			if t == "" {
				t = strings.TrimSpace(b.Text)
			}
			if t == "" {
				t = "思考…"
			}
			last = tr.append(ActItem{Kind: "thinking", Text: clip(t, 200), At: at})
		case "tool_use":
			name := strings.TrimSpace(b.Name)
			if name == "" {
				name = "tool"
			}
			last = tr.appendTool(b.ID, name, decodeAnyInput(b.Input), at)
		case "tool_result":
			out := rawText(b.Output)
			waitID, pending, found := tr.takeWait(b.ID)
			if found {
				last = tr.finishAnyTool(waitID, pending, !b.IsError, out, at)
			}
		}
	}
	return last
}

// consumeDshTool 兜住“工具调用/结果不在 assistant/message 里，而是独立事件”的版本。
// 字段名按实测常见的几个候选找，找不到就跳过 —— 不猜形状。
func (tr *trace) consumeDshTool(evType string, raw json.RawMessage, at string) *ActItem {
	var d struct {
		CallID    string          `json:"callId"`
		CallIDAlt string          `json:"call_id"`
		ID        string          `json:"id"`
		Name      string          `json:"name"`
		Tool      string          `json:"tool"`
		Input     json.RawMessage `json:"input"`
		Arguments json.RawMessage `json:"arguments"`
		Output    json.RawMessage `json:"output"`
		Result    json.RawMessage `json:"result"`
		OK        *bool           `json:"ok"`
		IsError   bool            `json:"isError"`
		Error     json.RawMessage `json:"error"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil
	}
	id := firstNonEmpty(d.CallID, d.CallIDAlt, d.ID)
	lower := strings.ToLower(evType)
	isResult := strings.Contains(lower, "result") || strings.Contains(lower, "end") ||
		strings.Contains(lower, "complete") || strings.Contains(lower, "output")
	if !isResult {
		name := firstNonEmpty(d.Name, d.Tool)
		if name == "" {
			name = "tool"
		}
		in := decodeAnyInput(d.Arguments)
		if len(in) == 0 {
			in = decodeAnyInput(d.Input)
		}
		return tr.appendTool(id, name, in, at)
	}
	out := rawText(d.Output)
	if out == "" {
		out = rawText(d.Result)
	}
	ok := !d.IsError
	if d.OK != nil {
		ok = *d.OK
	}
	if len(d.Error) > 0 && string(d.Error) != "null" && string(d.Error) != `""` {
		ok = false
		if out == "" {
			out = rawText(d.Error)
		}
	}
	waitID, pending, found := tr.takeWait(id)
	if !found {
		return nil
	}
	return tr.finishAnyTool(waitID, pending, ok, out, at)
}
