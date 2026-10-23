package transcript

import (
	"encoding/json"
	"strings"
)

// Copilot CLI 的 events.jsonl 实测（<COPILOT_HOME>/session-state/<session>/
// events.jsonl）：
//
//	{"type":"user.message","data":{"content":"…"},"timestamp":…}
//	{"type":"assistant.message","data":{"content":"…"},"timestamp":…}
//	{"type":"assistant.turn_start"/"assistant.turn_end",…}
//	{"type":"tool.execution_start"/"tool.execution_complete",…}
//
// 工具事件的字段名各版本有差异（toolName/callId/arguments/result…），这里
// 按“能找到就记、找不到就跳过”处理；text 那两条是实测的。
func (tr *trace) consumeCopilotLine(line string) *ActItem {
	var ev struct {
		Type      string          `json:"type"`
		Timestamp string          `json:"timestamp"`
		Data      json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	at := ev.Timestamp
	switch ev.Type {
	case "user.message":
		var d struct {
			Content            string `json:"content"`
			TransformedContent string `json:"transformedContent"`
		}
		_ = json.Unmarshal(ev.Data, &d)
		txt := d.Content
		if strings.TrimSpace(txt) == "" {
			txt = d.TransformedContent
		}
		if strings.TrimSpace(txt) == "" {
			return nil
		}
		out, full := msgText(txt)
		return tr.append(ActItem{Kind: "prompt", Text: out, FullLen: full, At: at})
	case "assistant.message":
		var d struct {
			Content string `json:"content"`
		}
		_ = json.Unmarshal(ev.Data, &d)
		if strings.TrimSpace(d.Content) == "" {
			return nil
		}
		out, full := msgText(d.Content)
		return tr.append(ActItem{Kind: "text", Text: out, FullLen: full, At: at})
	}
	if strings.Contains(ev.Type, "tool") {
		return tr.consumeCopilotTool(ev.Type, ev.Data, at)
	}
	return nil
}

func (tr *trace) consumeCopilotTool(evType string, raw json.RawMessage, at string) *ActItem {
	var d struct {
		ToolName   string          `json:"toolName"`
		Name       string          `json:"name"`
		ToolCallID string          `json:"toolCallId"`
		CallID     string          `json:"callId"`
		ID         string          `json:"id"`
		Arguments  json.RawMessage `json:"arguments"`
		Input      json.RawMessage `json:"input"`
		Result     json.RawMessage `json:"result"`
		Output     json.RawMessage `json:"output"`
		Content    json.RawMessage `json:"content"`
		Success    *bool           `json:"success"`
		IsError    bool            `json:"isError"`
		Error      json.RawMessage `json:"error"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return nil
	}
	name := strings.TrimSpace(d.ToolName)
	if name == "" {
		name = strings.TrimSpace(d.Name)
	}
	id := firstNonEmpty(d.ToolCallID, d.CallID, d.ID)
	lower := strings.ToLower(evType)
	if strings.Contains(lower, "start") || strings.Contains(lower, "call") && !strings.Contains(lower, "complete") {
		in := decodeAnyInput(d.Arguments)
		if len(in) == 0 {
			in = decodeAnyInput(d.Input)
		}
		if name == "" {
			name = "tool"
		}
		return tr.appendTool(id, name, in, at)
	}
	out := rawText(d.Result)
	if out == "" {
		out = rawText(d.Output)
	}
	if out == "" {
		out = rawText(d.Content)
	}
	ok := !d.IsError
	if d.Success != nil {
		ok = *d.Success
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

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func rawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}
