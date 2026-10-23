package agent

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/transcript"
)

// OpenCode 的“流水/改动”两条腿走 TUI 自己的 HTTP server，不读 SQLite：
//
//	GET /session/<id>/message
//	→ [{info:{id,role,time},parts:[{id,type,text|tool,state:{status,input,output}}]}]
//
// 这条端点在 1.19.3/1.19.4 实测可用（新的 /api/session/{id}/message 对旧库
// 会返回空）。观察者只读；写操作仍在 TUI 里。
type ocFlow struct {
	started  bool
	sent     map[string]string // act id → 上一帧的 JSON 签名
	files    map[string]*transcript.FileTouch
	filesSig string
	errOnce  bool
}

type ocMessage struct {
	Info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Time struct {
			Created int64 `json:"created"`
		} `json:"time"`
	} `json:"info"`
	Parts []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		Text string `json:"text"`
		Tool string `json:"tool"`
		Call string `json:"callID"`
		Time struct {
			Start int64 `json:"start"`
			End   int64 `json:"end"`
		} `json:"time"`
		State *struct {
			Status string          `json:"status"`
			Input  json.RawMessage `json:"input"`
			Output string          `json:"output"`
			Error  string          `json:"error"`
		} `json:"state"`
		Files []string `json:"files"`
	} `json:"parts"`
}

func (f *ocFlow) poll(ctx context.Context, client *http.Client, baseURL, password, sid string, tabID int, cwd string) {
	if sid == "" {
		return
	}
	var msgs []ocMessage
	if err := ocGet(ctx, client, baseURL+"/session/"+sid+"/message", password, &msgs); err != nil {
		if ctx.Err() == nil && !f.errOnce {
			f.errOnce = true
			log.Printf("[opencode t%d] 读取消息失败（流水这条腿会一直重试）: %v", tabID, err)
		}
		return
	}
	f.errOnce = false

	var items []transcript.ActItem
	files := map[string]*transcript.FileTouch{}
	for _, m := range msgs {
		at := time.UnixMilli(m.Info.Time.Created).Format(time.RFC3339)
		role := m.Info.Role
		for _, p := range m.Parts {
			id := "oc:" + p.ID
			if id == "oc:" {
				id = "oc:" + m.Info.ID
			}
			switch p.Type {
			case "text":
				if strings.TrimSpace(p.Text) == "" || role != "user" && role != "assistant" {
					continue
				}
				kind := "text"
				if role == "user" {
					kind = "prompt"
					// OpenCode 没有 Claude 形状的 hooks：关格时后端要知道
					// 这条记录“说过话”，不能当成空开合把记录摘掉。
					host.NoteActivity(tabID, false)
				} else {
					host.NoteActivity(tabID, true)
				}
				items = append(items, transcript.ActItem{ID: id, Kind: kind, Text: p.Text, At: at})
			case "reasoning":
				if strings.TrimSpace(p.Text) == "" {
					continue
				}
				items = append(items, transcript.ActItem{ID: id, Kind: "thinking", Text: clipText(p.Text, 200), At: at})
			case "tool":
				host.NoteActivity(tabID, true)
				it := transcript.ActItem{ID: id, Kind: "tool", Tool: p.Tool, At: at}
				var in map[string]json.RawMessage
				if p.State != nil && len(p.State.Input) > 0 {
					_ = json.Unmarshal(p.State.Input, &in)
				}
				toolName := strings.ToLower(p.Tool)
				path := ocInputPath(in)
				if path != "" {
					it.Path = path
					it.Rel = relTo(cwd, path)
				}
				it.Text = ocToolText(toolName, in, path)
				if p.State != nil {
					switch p.State.Status {
					case "completed":
						ok := true
						it.OK = &ok
					case "error":
						ok := false
						it.OK = &ok
					}
				}
				items = append(items, it)
				if path != "" {
					ocTouch(files, path, it.Rel, ocFileOp(toolName), at)
				}
			case "patch":
				for _, pth := range p.Files {
					items = append(items, transcript.ActItem{
						ID: id + ":" + pth, Kind: "tool", Tool: "patch",
						Text: "patch " + filepath.Base(pth), Path: pth, Rel: relTo(cwd, pth), At: at,
					})
					ocTouch(files, pth, relTo(cwd, pth), "edit", at)
				}
			}
		}
	}

	// 页面刚连上时补一份历史；之后只推变化。工具状态会原地更新（同 id 重发）。
	if !f.started {
		f.started = true
		if n := len(items); n > 30 {
			items = items[n-30:]
		}
		f.sent = map[string]string{}
		for _, it := range items {
			f.sent[it.ID] = mustJSON(it)
		}
		host.Push(map[string]any{"type": "acts", "tab": tabID, "items": items, "replace": true})
		log.Printf("[opencode t%d] 初次读入：流水 %d 条，改动文件 %d 个", tabID, len(items), len(files))
	} else {
		var changed []transcript.ActItem
		for _, it := range items {
			sig := mustJSON(it)
			if f.sent[it.ID] == sig {
				continue
			}
			f.sent[it.ID] = sig
			changed = append(changed, it)
		}
		if len(changed) > 0 {
			host.Push(map[string]any{"type": "acts", "tab": tabID, "items": changed})
		}
	}

	list := make([]transcript.FileTouch, 0, len(files))
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		list = append(list, *files[k])
	}
	sig := mustJSON(list)
	if sig != f.filesSig {
		f.filesSig = sig
		f.files = files
		host.Push(map[string]any{"type": "files", "tab": tabID, "files": list})
	}
}

// ocTouch 把一次文件动作并进本帧的台账。同一文件先写后读时**不能覆盖**：
// 之前直接赋值，屏上只剩最后一次的 R（实测 1.19.4：write 之后 read 同一个文件）。
func ocTouch(files map[string]*transcript.FileTouch, path, rel, op, at string) {
	key := strings.ToLower(filepath.Clean(path))
	ft := files[key]
	if ft == nil {
		ft = &transcript.FileTouch{Path: path, Rel: rel, At: at}
		files[key] = ft
	}
	for _, o := range ft.Ops {
		if o == op {
			return
		}
	}
	ft.Ops = append(ft.Ops, op)
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func ocInputPath(in map[string]json.RawMessage) string {
	if in == nil {
		return ""
	}
	for _, k := range []string{"filePath", "file_path", "path", "filename", "target_file"} {
		var s string
		if json.Unmarshal(in[k], &s) == nil && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func ocToolText(tool string, in map[string]json.RawMessage, path string) string {
	if path != "" {
		return tool + " " + filepath.Base(path)
	}
	for _, k := range []string{"command", "pattern", "query"} {
		var s string
		if json.Unmarshal(in[k], &s) == nil && strings.TrimSpace(s) != "" {
			s = strings.TrimSpace(s)
			if i := strings.IndexByte(s, '\n'); i >= 0 {
				s = s[:i]
			}
			return clipText(s, 120)
		}
	}
	return tool
}

func ocFileOp(tool string) string {
	switch tool {
	case "read", "view":
		return "read"
	case "write", "create":
		return "write"
	case "edit", "patch", "multiedit":
		return "edit"
	}
	return "touch"
}

func relTo(cwd, path string) string {
	if strings.TrimSpace(cwd) == "" {
		return path
	}
	r, err := filepath.Rel(cwd, path)
	if err != nil || strings.HasPrefix(r, "..") {
		return path
	}
	return r
}
