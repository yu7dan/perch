package transcript

import (
	"encoding/json"
	"strings"
)

// Cursor agent 的 transcript 实测（~/.cursor/projects/<slug>/agent-transcripts/
// <chat-id>/<chat-id>.jsonl）：
//
//	{"role":"user","message":{"content":[{"type":"text","text":
//	  "<timestamp>…</timestamp>\n<user_query>你好</user_query>"}]}}
//	{"role":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
//
// 它只落对话正文，不落工具调用（工具在 Cursor 自己的 store.db 里）。所以这里
// 只产出 prompt/text —— 「改动」那一栏对 Cursor 是空的，这是格式边界，不伪造。
func (tr *trace) consumeCursorLine(line string) *ActItem {
	var ev struct {
		Role      string          `json:"role"`
		Timestamp string          `json:"timestamp"`
		Message   json.RawMessage `json:"message"`
		Content   json.RawMessage `json:"content"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	at := ev.Timestamp
	if at == "" {
		at = nowAt()
	}
	raw := ev.Content
	if len(ev.Message) > 0 {
		var m struct {
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(ev.Message, &m) == nil && len(m.Content) > 0 {
			raw = m.Content
		}
	}
	txt := msgTextOf(raw)
	if strings.TrimSpace(txt) == "" {
		return nil
	}
	switch ev.Role {
	case "user":
		txt = cursorUserQuery(txt)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		out, full := msgText(txt)
		return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
	case "assistant":
		out, full := msgText(txt)
		return tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
	}
	return nil
}

func cursorUserQuery(txt string) string {
	const open, closeTag = "<user_query>", "</user_query>"
	if i := strings.Index(txt, open); i >= 0 {
		body := txt[i+len(open):]
		if j := strings.Index(body, closeTag); j >= 0 {
			body = body[:j]
		}
		return strings.TrimSpace(body)
	}
	return strings.TrimSpace(txt)
}
