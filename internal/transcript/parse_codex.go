package transcript

import (
	"encoding/json"
	"strings"
)

// Codex rollout 实测形状（0.164.0，~/.codex/sessions/<年>/<月>/<日>/
// rollout-*.jsonl）：
//
//	{"type":"response_item","payload":{"type":"message","role":"user",
//	  "content":[{"type":"input_text","text":…}]}}
//	{"type":"response_item","payload":{"type":"reasoning","summary":[…],"text":…}}
//	{"type":"response_item","payload":{"type":"function_call","name":"shell",
//	  "call_id":"call_…","arguments":"{…}"}}
//	{"type":"response_item","payload":{"type":"function_call_output",
//	  "call_id":"call_…","output":…}}
//
// 同一轮还会出现 event_msg/user_message、event_msg/agent_message —— 它们是
// **同一条内容的第二条腿**。两份都落会让流水里每句话出现两次，所以只要见过
// response_item，event_msg 的文本就丢掉（见 sawResponseItem）。
func (tr *trace) consumeCodexLine(line string) *ActItem {
	var ev struct {
		Type      string          `json:"type"`
		Timestamp string          `json:"timestamp"`
		Payload   json.RawMessage `json:"payload"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil || len(ev.Payload) == 0 {
		return nil
	}
	at := ev.Timestamp
	switch ev.Type {
	case "response_item":
		tr.sawResponseItem = true
		return tr.consumeCodexItem(ev.Payload, at)
	case "event_msg":
		return tr.consumeCodexEvent(ev.Payload, at)
	}
	return nil
}

func (tr *trace) consumeCodexItem(raw json.RawMessage, at string) *ActItem {
	var p struct {
		Type    string          `json:"type"`
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
		Text    string          `json:"text"`
		Summary json.RawMessage `json:"summary"`
		ID      string          `json:"id"`
		CallID  string          `json:"call_id"`
		Name    string          `json:"name"`
		Input   json.RawMessage `json:"input"`
		Action  json.RawMessage `json:"action"`
		Args    json.RawMessage `json:"arguments"`
		Output  json.RawMessage `json:"output"`
		Success *bool           `json:"success"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	switch p.Type {
	case "message":
		txt := codexContentText(p.Content)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		switch p.Role {
		case "user":
			// environment_context / skills_instructions 是壳层塞进来的，不是用户的话。
			if isCodexContext(txt) {
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
			out, full := msgText(txt)
			return tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
		}
		return nil
	case "reasoning":
		txt := strings.TrimSpace(p.Text)
		if txt == "" {
			txt = codexSummaryText(p.Summary)
		}
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		return tr.append(ActItem{Kind: "thinking", Text: clip(txt, 200), At: at})
	case "function_call", "custom_tool_call", "local_shell_call":
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = "tool"
		}
		in := decodeAnyInput(p.Args)
		if p.Type == "local_shell_call" {
			in = codexShellInput(p.Action)
		} else if len(in) == 0 {
			in = decodeAnyInput(p.Input)
		}
		return tr.appendTool(p.CallID, name, in, at)
	case "function_call_output", "custom_tool_call_output":
		out := codexOutputText(p.Output)
		ok := p.Success == nil || *p.Success
		if strings.HasPrefix(strings.TrimSpace(strings.ToLower(out)), "error") {
			ok = false
		}
		id, pending, found := tr.takeWait(p.CallID)
		if !found {
			return nil
		}
		return tr.finishAnyTool(id, pending, ok, out, at)
	}
	return nil
}

// event_msg 只在没有 response_item 的旧 rollout 里当正文来源。
func (tr *trace) consumeCodexEvent(raw json.RawMessage, at string) *ActItem {
	var p struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Reason  string `json:"reason"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	switch p.Type {
	case "user_message":
		if tr.sawResponseItem || isCodexContext(p.Message) {
			return nil
		}
		out, full := msgText(p.Message)
		return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
	case "agent_message":
		if tr.sawResponseItem {
			return nil
		}
		out, full := msgText(p.Message)
		return tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
	case "turn_aborted":
		return tr.append(ActItem{Kind: "system", Text: "已中断", At: at})
	}
	return nil
}

func isCodexContext(txt string) bool {
	s := strings.TrimSpace(txt)
	return strings.HasPrefix(s, "<environment_context>") ||
		strings.HasPrefix(s, "<skills_instructions>") ||
		strings.HasPrefix(s, "<user_instructions>") ||
		strings.HasPrefix(s, "# AGENTS.md instructions")
}

func codexContentText(raw json.RawMessage) string {
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s
		}
		return ""
	}
	var parts []string
	for _, b := range blocks {
		switch b.Type {
		case "text", "input_text", "output_text", "Text":
			if strings.TrimSpace(b.Text) != "" {
				parts = append(parts, b.Text)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func codexSummaryText(raw json.RawMessage) string {
	var items []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &items) != nil {
		var one string
		if json.Unmarshal(raw, &one) == nil {
			return one
		}
		return ""
	}
	var parts []string
	for _, it := range items {
		if strings.TrimSpace(it.Text) != "" {
			parts = append(parts, it.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// local_shell_call 的 action 实测是 {command:["powershell","-Command",…]}。
func codexShellInput(raw json.RawMessage) toolInput {
	var a struct {
		Command []string `json:"command"`
		Workdir string   `json:"workdir"`
	}
	if json.Unmarshal(raw, &a) != nil {
		return decodeAnyInput(raw)
	}
	cmd := strings.Join(a.Command, " ")
	if cmd == "" {
		return decodeAnyInput(raw)
	}
	b, _ := json.Marshal(map[string]string{"command": cmd, "cwd": a.Workdir})
	return decodeInput(b)
}

func codexOutputText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Content json.RawMessage `json:"content"`
		Output  json.RawMessage `json:"output"`
		Success *bool           `json:"success"`
		IsError bool            `json:"is_error"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if t := codexContentText(obj.Content); t != "" {
			return t
		}
		var o string
		if json.Unmarshal(obj.Output, &o) == nil {
			return o
		}
	}
	return string(raw)
}
