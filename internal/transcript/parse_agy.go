package transcript

import (
	"encoding/json"
	"strings"
)

// Antigravity CLI 的转录实测（<home>/.gemini/antigravity-cli/brain/<conversation>/
// .system_generated/logs/transcript.jsonl）：
//
//	{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",
//	 "content":"<USER_REQUEST>…</USER_REQUEST>\n<ADDITIONAL_METADATA>…"}
//	{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
//	 "content":…,"thinking":…,"tool_calls":[{"name":"run_command","args":{…}}]}
//	{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","content":"…"}
//	{"source":"SYSTEM","type":"SYSTEM_MESSAGE",…}
//
// ⚠️ 工具调用**没有 call_id**，结果只能按出现顺序配对：PLANNER_RESPONSE 里的
// tool_calls 依次进 FIFO，后面的 GENERIC 依次取。
func (tr *trace) consumeAgyLine(line string) *ActItem {
	var ev struct {
		StepIndex int             `json:"step_index"`
		Source    string          `json:"source"`
		Type      string          `json:"type"`
		Status    string          `json:"status"`
		CreatedAt string          `json:"created_at"`
		Content   string          `json:"content"`
		Thinking  string          `json:"thinking"`
		ToolCalls json.RawMessage `json:"tool_calls"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	at := ev.CreatedAt
	switch {
	case (ev.Source == "USER_EXPLICIT" || ev.Source == "USER") &&
		(ev.Type == "USER_INPUT" || ev.Type == "REQUEST"):
		txt := agyUserRequest(ev.Content)
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		out, full := msgText(txt)
		return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
	case ev.Source == "MODEL" && ev.Type == "PLANNER_RESPONSE":
		var last *ActItem
		if t := strings.TrimSpace(ev.Thinking); t != "" {
			last = tr.append(ActItem{Kind: "thinking", Text: clip(t, 200), At: at})
		}
		if c := strings.TrimSpace(ev.Content); c != "" {
			out, full := msgText(c)
			last = tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
		}
		if len(ev.ToolCalls) > 0 {
			var calls []struct {
				Name string          `json:"name"`
				Args json.RawMessage `json:"args"`
			}
			if json.Unmarshal(ev.ToolCalls, &calls) == nil {
				for _, c := range calls {
					name := strings.TrimSpace(c.Name)
					if name == "" {
						name = "tool"
					}
					last = tr.appendTool("", name, decodeAnyInput(c.Args), at)
				}
			}
		}
		return last
	case ev.Source == "MODEL" && ev.Type == "GENERIC":
		// RUNNING 只是一段还没写完的输出：先把结果挂上去（OK=nil），
		// DONE / ERROR 到了会再更新同一条。
		if ev.Status == "RUNNING" {
			return nil
		}
		if !tr.hasPending() {
			return nil
		}
		id, pending, found := tr.takeWait("")
		if !found {
			return nil
		}
		return tr.finishAnyTool(id, pending, ev.Status != "ERROR", ev.Content, at)
	case ev.Source == "SYSTEM" && ev.Type == "SYSTEM_MESSAGE":
		if strings.TrimSpace(ev.Content) == "" {
			return nil
		}
		return tr.append(ActItem{Kind: "system", Text: clip(ev.Content, 300), At: at})
	}
	return nil
}

func (tr *trace) hasPending() bool {
	for id := range tr.wait {
		if id != "" {
			return true
		}
	}
	return false
}

// agyUserRequest 只取用户真正写的那段；<ADDITIONAL_METADATA> 和
// <USER_SETTINGS_CHANGE> 是壳层加的。
func agyUserRequest(content string) string {
	const open, closeTag = "<USER_REQUEST>", "</USER_REQUEST>"
	if i := strings.Index(content, open); i >= 0 {
		body := content[i+len(open):]
		if j := strings.Index(body, closeTag); j >= 0 {
			body = body[:j]
		}
		return strings.TrimSpace(body)
	}
	return strings.TrimSpace(content)
}
