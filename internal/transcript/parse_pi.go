package transcript

import (
	"encoding/json"
	"strings"
)

// Pi（pi-coding-agent 1.4.0）的 session jsonl 形状，实测：
//
//	{"type":"message","id":…,"message":{"role":"user","content":[{"type":"text",…}]}}
//	{"type":"message","message":{"role":"assistant","content":[
//	  {"type":"text",…},{"type":"thinking",…},
//	  {"type":"toolCall","id":"call_…","name":"read","arguments":{…}}]}}
//	{"type":"message","message":{"role":"toolResult","content":[{"type":"text",…}],
//	  "isError":false,"toolCallId":"call_…"}}
//	{"type":"compaction",…}
//
// 会话文件在 <PI_CODING_AGENT_DIR>/sessions/<项目slug>/<时间戳>_<session-id>.jsonl。
func (tr *trace) consumePiLine(line string) *ActItem {
	var ev struct {
		Type      string          `json:"type"`
		Timestamp string          `json:"timestamp"`
		Message   json.RawMessage `json:"message"`
		Display   bool            `json:"display"`
		Content   json.RawMessage `json:"content"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	at := ev.Timestamp
	switch ev.Type {
	case "compaction":
		return tr.append(ActItem{Kind: "compact", Text: "上下文压缩", At: at})
	case "custom_message":
		if !ev.Display {
			return nil
		}
		txt := msgTextOf(ev.Content)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		return tr.append(ActItem{Kind: "system", Text: clip(txt, 300), At: at})
	case "message":
		return tr.consumePiMessage(ev.Message, at)
	}
	return nil
}

func (tr *trace) consumePiMessage(raw json.RawMessage, at string) *ActItem {
	var m struct {
		Role       string          `json:"role"`
		Content    json.RawMessage `json:"content"`
		Command    string          `json:"command"`
		Code       string          `json:"code"`
		Output     string          `json:"output"`
		ExitCode   *int            `json:"exitCode"`
		Cancelled  bool            `json:"cancelled"`
		ToolCallID string          `json:"toolCallId"`
		IsError    bool            `json:"isError"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	switch m.Role {
	case "user":
		txt := msgTextOf(m.Content)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		if label, drop := SystemTurn(txt); drop {
			return nil
		} else if label != "" {
			return tr.append(ActItem{Kind: "system", Text: label, At: at})
		}
		out, full := msgText(txt)
		return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
	case "assistant":
		var last *ActItem
		var blocks []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			Thinking  string          `json:"thinking"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(m.Content, &blocks) == nil {
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if strings.TrimSpace(b.Text) == "" {
						continue
					}
					out, full := msgText(b.Text)
					last = tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
				case "thinking":
					t := strings.TrimSpace(b.Thinking)
					if t == "" {
						t = strings.TrimSpace(b.Text)
					}
					if t == "" {
						t = "思考…"
					}
					last = tr.append(ActItem{Kind: "thinking", Text: clip(t, 200), At: at})
				case "toolCall":
					name := strings.TrimSpace(b.Name)
					if name == "" {
						name = "tool"
					}
					last = tr.appendTool(b.ID, name, decodeAnyInput(b.Arguments), at)
				}
			}
		}
		return last
	case "toolResult":
		out := msgTextOf(m.Content)
		ok := !m.IsError
		id, pending, found := tr.takeWait(m.ToolCallID)
		if !found {
			return nil
		}
		return tr.finishAnyTool(id, pending, ok, out, at)
	case "bashExecution", "pythonExecution":
		name := "bash"
		src := m.Command
		if m.Role == "pythonExecution" {
			name = "python"
			src = m.Code
		}
		b, _ := json.Marshal(map[string]string{"command": src})
		it := tr.appendTool("", name, decodeInput(b), at)
		ok := !m.Cancelled && (m.ExitCode == nil || *m.ExitCode == 0)
		id, pending, found := tr.takeWait(it.ID)
		if found {
			tr.finishAnyTool(id, pending, ok, m.Output, at)
		}
		return it
	case "fileMention":
		// @path 是附件，不是“你说的话”。列成一行系统条目即可。
		return tr.append(ActItem{Kind: "system", Text: "@" + clip(msgTextOf(m.Content), 200), At: at})
	}
	return nil
}

func msgTextOf(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if (b.Type == "text" || b.Type == "") && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}
