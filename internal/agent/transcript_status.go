package agent

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// EvidenceTranscript 是“状态是从 agent 自己的转录推出来的”这条证据。
// 它不是 hook / app-server 的第一手信号，所以 UI 会把它当活证据，但日志里
// 能和 hook 区分开 —— 排障时这点很重要。
const EvidenceTranscript = "transcript"

const transcriptStatusEvery = 400 * time.Millisecond

// transcriptStatusState 是跨行累积的判据。只由观察协程读写。
type transcriptStatusState struct {
	lastRole string // cursor：最后一条是 user 还是 assistant
	pending  bool   // cursor：user 之后还没看到 assistant

	agyBusy   bool
	agyWait   string // "" | ask | perm
	agyWaitTx string

	copilotBusy   bool
	copilotWait   string
	copilotWaitTx string

	qoderWait   string
	qoderWaitTx string
}

// observeTranscriptStatus 是“没有 hook / app-server 的 agent”的第三条腿：
// 跟着它自己的转录，推出忙/闲/等。只读文件，不写任何配置。
//
// 它和 Follower 各读各的同一个文件：Follower 产流水，这里只产状态。
// 两边都按 tabID 认领同一个路径（ClaimTranscript 允许同一格重复认领），
// 所以不会互相抢。
func observeTranscriptStatus(ctx context.Context, tabID int, agentID, cwd, sessionID string, startedAt time.Time, sink func(agentEvent)) {
	path := ""
	var off int64
	var carry string
	st := &transcriptStatusState{}
	boundSession := sessionID
	errLogged := ""

	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(transcriptStatusEvery):
		}
		if path == "" {
			f := TranscriptFor(tabID, agentID, cwd, boundSession, startedAt)
			if f.Path == "" || f.Format == "zstd" {
				continue
			}
			path = f.Path
			off, carry = 0, ""
			if sid := sessionFromTranscriptPath(agentID, path); sid != "" && boundSession == "" {
				boundSession = sid
				bindObservedSession(tabID, sid, agentID)
			}
			log.Printf("[%s t%d] 状态跟随转录 %s", agentID, tabID, path)
		}
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		if fi.Size() < off {
			off, carry = 0, ""
		}
		if fi.Size() == off {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			f.Close()
			continue
		}
		b, rerr := io.ReadAll(f)
		f.Close()
		if rerr != nil {
			continue
		}
		off += int64(len(b))
		buf := carry + string(b)
		for {
			i := strings.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			sid, status, kind, text, ok := ingestStatusLine(agentID, line, st)
			if sid != "" && sid != boundSession {
				boundSession = sid
				bindObservedSession(tabID, sid, agentID)
			}
			if !ok || status == "" {
				continue
			}
			ev := agentEvent{
				V: 1, Tab: tabID, Agent: agentID, Event: "status",
				Status: status, Kind: kind, Text: text, Session: boundSession,
				Evidence: EvidenceTranscript,
			}
			normalizeAgentEvent(&ev)
			sink(ev)
		}
		carry = buf
		if err := ctx.Err(); err != nil && errLogged == "" {
			return
		}
	}
}

// ingestStatusLine 把一行转录变成（会话 id、忙闲、等待类型、等待文案）。
// 每个 agent 只认自己实测过的记录；认不出就三样都空。
func ingestStatusLine(agentID, line string, st *transcriptStatusState) (session, status, kind, text string, ok bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", "", "", "", false
	}
	switch agentID {
	case "agy":
		return ingestAgyStatus(line, st)
	case "cursor":
		return ingestCursorStatus(line, st)
	case "copilot":
		return ingestCopilotStatus(line, st)
	case "qoder":
		return ingestQoderStatus(line, st)
	}
	return "", "", "", "", false
}

func ingestAgyStatus(line string, st *transcriptStatusState) (string, string, string, string, bool) {
	var ev struct {
		Source    string `json:"source"`
		Type      string `json:"type"`
		Status    string `json:"status"`
		ToolCalls []struct {
			Name string          `json:"name"`
			Args json.RawMessage `json:"args"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return "", "", "", "", false
	}
	switch {
	case (ev.Source == "USER_EXPLICIT" || ev.Source == "USER") &&
		(ev.Type == "USER_INPUT" || ev.Type == "REQUEST"):
		st.agyBusy, st.agyWait, st.agyWaitTx = true, "", ""
		return "", "busy", "", "", true
	case ev.Source == "MODEL" && ev.Type == "PLANNER_RESPONSE":
		st.agyBusy = true
		st.agyWait, st.agyWaitTx = "", ""
		for _, c := range ev.ToolCalls {
			name := strings.ToLower(c.Name)
			if strings.Contains(name, "ask") || strings.Contains(name, "question") {
				st.agyWait = "ask"
				st.agyWaitTx = clipText(agyToolSummary(c.Args), 160)
				if st.agyWaitTx == "" {
					st.agyWaitTx = c.Name
				}
				return "", "waiting", "ask", st.agyWaitTx, true
			}
			if strings.Contains(name, "permission") || strings.Contains(name, "approve") {
				st.agyWait = "perm"
				st.agyWaitTx = c.Name
				return "", "waiting", "perm", st.agyWaitTx, true
			}
		}
		if len(ev.ToolCalls) == 0 {
			st.agyBusy = false
			return "", "idle", "", "", true
		}
		return "", "busy", "", "", true
	case ev.Source == "MODEL" && ev.Type == "GENERIC":
		if ev.Status == "ERROR" {
			st.agyBusy = false
			return "", "idle", "", "", true
		}
		st.agyBusy = true
		return "", "busy", "", "", true
	}
	return "", "", "", "", false
}

func agyToolSummary(raw json.RawMessage) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	for _, k := range []string{"toolSummary", "description", "Prompt", "Query"} {
		var s string
		if json.Unmarshal(m[k], &s) == nil && strings.TrimSpace(s) != "" {
			return strings.Trim(strings.TrimSpace(s), `"'`)
		}
	}
	return ""
}

func ingestCursorStatus(line string, st *transcriptStatusState) (string, string, string, string, bool) {
	var ev struct {
		Role string `json:"role"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return "", "", "", "", false
	}
	switch ev.Role {
	case "user":
		// 工具结果在 Cursor 的转录里也是 role=user，但它没有 message.content
		// 文本；这里宁可把“用户又说话了”当成新一轮开始（busy），也不把工具
		// 结果误判成 idle。
		st.lastRole, st.pending = "user", true
		return "", "busy", "", "", true
	case "assistant":
		st.lastRole, st.pending = "assistant", false
		return "", "idle", "", "", true
	}
	return "", "", "", "", false
}

func ingestCopilotStatus(line string, st *transcriptStatusState) (string, string, string, string, bool) {
	var ev struct {
		Type string          `json:"type"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return "", "", "", "", false
	}
	switch ev.Type {
	case "session.start":
		var d struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(ev.Data, &d)
		return d.SessionID, "", "", "", false
	case "user.message", "assistant.turn_start", "tool.execution_start":
		st.copilotBusy = true
		st.copilotWait, st.copilotWaitTx = "", ""
		return "", "busy", "", "", true
	case "assistant.turn_end", "session.shutdown":
		st.copilotBusy = false
		st.copilotWait, st.copilotWaitTx = "", ""
		return "", "idle", "", "", true
	}
	// 批准/提问事件：Copilot 的各版本名字不完全一致，按关键词认。
	low := strings.ToLower(ev.Type)
	if strings.Contains(low, "permission") || strings.Contains(low, "approval") {
		var d map[string]json.RawMessage
		txt := ""
		if json.Unmarshal(ev.Data, &d) == nil {
			for _, k := range []string{"message", "toolName", "permission", "reason"} {
				var s string
				if json.Unmarshal(d[k], &s) == nil && strings.TrimSpace(s) != "" {
					txt = strings.TrimSpace(s)
					break
				}
			}
		}
		st.copilotWait = "perm"
		st.copilotWaitTx = clipText(txt, 160)
		return "", "waiting", "perm", st.copilotWaitTx, true
	}
	return "", "", "", "", false
}

func ingestQoderStatus(line string, st *transcriptStatusState) (string, string, string, string, bool) {
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			StopReason string `json:"stop_reason"`
			Content    []struct {
				Type string `json:"type"`
				Name string `json:"name"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return "", "", "", "", false
	}
	switch ev.Type {
	case "user":
		st.qoderWait, st.qoderWaitTx = "", ""
		return "", "busy", "", "", true
	case "assistant":
		for _, b := range ev.Message.Content {
			if b.Type == "tool_use" && strings.EqualFold(b.Name, "AskUserQuestion") {
				st.qoderWait = "ask"
				st.qoderWaitTx = "Qoder 在等你回答"
				return "", "waiting", "ask", st.qoderWaitTx, true
			}
		}
		if ev.Message.StopReason == "end_turn" || ev.Message.StopReason == "stop" {
			return "", "idle", "", "", true
		}
		return "", "busy", "", "", true
	}
	return "", "", "", "", false
}

// sessionFromTranscriptPath 从“路径里本来就带会话 id”的 agent 取 id。
// 只对 agy/cursor/copilot 三个没有扩展上报 id 的用。
func sessionFromTranscriptPath(agentID, path string) string {
	switch agentID {
	case "agy":
		// …\brain\<conversation>\.system_generated\logs\transcript*.jsonl
		dir := filepath.Dir(filepath.Dir(filepath.Dir(path))) // logs -> .system_generated -> <conversation>
		base := filepath.Base(dir)
		if SafeSessionID(base) {
			return base
		}
	case "cursor":
		// …\agent-transcripts\<chat-id>\<chat-id>.jsonl
		base := filepath.Base(filepath.Dir(path))
		if SafeSessionID(base) {
			return base
		}
	case "copilot":
		// …\session-state\<session-id>\events.jsonl
		base := filepath.Base(filepath.Dir(path))
		if SafeSessionID(base) {
			return base
		}
	}
	return ""
}

func clipText(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
