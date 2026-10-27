package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type flowTestHost struct {
	pushed []any
	talked bool
	spoke  bool
}

func (h *flowTestHost) BindSession(int, string, string, string) bool { return false }
func (h *flowTestHost) RebindSession(int, string, string, string) bool {
	return false
}
func (h *flowTestHost) SetStatus(int, string) (string, bool) { return "", false }
func (h *flowTestHost) Push(v any)                           { h.pushed = append(h.pushed, v) }
func (h *flowTestHost) ResolveExe(bin string) (string, []string) {
	return bin, nil
}
func (h *flowTestHost) HookSettings(string) string { return "" }
func (h *flowTestHost) NoteActivity(_ int, spoke bool) {
	if spoke {
		h.spoke = true
		return
	}
	h.talked = true
}
func (h *flowTestHost) ResumeSessionOf(int) string { return "" }

func TestOpenCodeFlowKeepsToolsAndReasoning(t *testing.T) {
	first := `[{"info":{"id":"msg_1","role":"user","time":{"created":1}},"parts":[
	  {"id":"p1","type":"text","text":"读 README"}]}]`
	full := `[{"info":{"id":"msg_1","role":"user","time":{"created":1}},"parts":[
	  {"id":"p1","type":"text","text":"读 README"}]},
	 {"info":{"id":"msg_2","role":"assistant","time":{"created":2}},"parts":[
	  {"id":"p2","type":"reasoning","text":"先找文件"},
	  {"id":"p3","type":"tool","tool":"read","callID":"call_1","state":{"status":"error","input":{"filePath":"README.md"},"error":"File not found"}},
	  {"id":"p4","type":"text","text":"没有 README"}]}]`
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/session/ses_test/message" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		polls++
		if polls == 1 {
			_, _ = w.Write([]byte(first))
			return
		}
		_, _ = w.Write([]byte(full))
	}))
	defer srv.Close()

	h := &flowTestHost{}
	SetHost(h)
	defer SetHost(defaultHost{})

	f := &ocFlow{sent: map[string]string{}}
	f.poll(context.Background(), srv.Client(), srv.URL, "", "ses_test", 7, `C:\work`)
	f.poll(context.Background(), srv.Client(), srv.URL, "", "ses_test", 7, `C:\work`)

	var acts []map[string]any
	var files []any
	for _, p := range h.pushed {
		m := p.(map[string]any)
		if m["type"] == "acts" {
			b, _ := json.Marshal(m["items"])
			var batch []map[string]any
			_ = json.Unmarshal(b, &batch)
			acts = append(acts, batch...)
		}
		if m["type"] == "files" {
			b, _ := json.Marshal(m["files"])
			var list []any
			_ = json.Unmarshal(b, &list)
			files = list
		}
	}
	if len(acts) != 4 {
		t.Fatalf("应当有 4 条（prompt/thinking/tool/text），实际 %d: %+v", len(acts), acts)
	}
	kinds := map[string]bool{}
	for _, a := range acts {
		kinds[a["kind"].(string)] = true
	}
	if !kinds["thinking"] || !kinds["tool"] {
		t.Fatalf("thinking/tool 丢了: %+v", kinds)
	}
	if len(files) != 1 {
		t.Fatalf("read 碰过的文件应当进台账: %+v", files)
	}
}

// 1.19.4 实测形状：同一轮里先 write 再 read 同一个文件，而且消息里夹着
// step-start/step-finish。台账不能只剩最后一次的 read。
func TestOpenCodeFlowMergesFileOps(t *testing.T) {
	body := `[{"info":{"id":"m1","role":"user","time":{"created":1}},"parts":[
	  {"id":"p1","type":"text","text":"写一个文件再读回来"}]},
	 {"info":{"id":"m2","role":"assistant","time":{"created":2}},"parts":[
	  {"id":"p2","type":"step-start"},
	  {"id":"p3","type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"C:\\work\\a.txt","content":"ok"},"output":"Wrote file successfully."}},
	  {"id":"p4","type":"step-finish"}]},
	 {"info":{"id":"m3","role":"assistant","time":{"created":3}},"parts":[
	  {"id":"p5","type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"C:\\work\\a.txt"},"output":"ok"}},
	  {"id":"p6","type":"text","text":"好了"}]}]`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	h := &flowTestHost{}
	SetHost(h)
	defer SetHost(defaultHost{})

	f := &ocFlow{sent: map[string]string{}}
	f.poll(context.Background(), srv.Client(), srv.URL, "", "ses_test", 7, `C:\work`)

	var acts []map[string]any
	var files []map[string]any
	for _, p := range h.pushed {
		m := p.(map[string]any)
		if m["type"] == "acts" {
			b, _ := json.Marshal(m["items"])
			var batch []map[string]any
			_ = json.Unmarshal(b, &batch)
			acts = append(acts, batch...)
		}
		if m["type"] == "files" {
			b, _ := json.Marshal(m["files"])
			var list []map[string]any
			_ = json.Unmarshal(b, &list)
			files = append(files, list...)
		}
	}
	if len(acts) != 4 {
		t.Fatalf("应当有 prompt/write/read/text 4 条，实际 %d: %+v", len(acts), acts)
	}
	if len(files) != 1 {
		t.Fatalf("write 与 read 指向同一文件，台账应当只有 1 条: %+v", files)
	}
	ops, _ := files[0]["ops"].([]any)
	if len(ops) != 2 {
		t.Fatalf("write + read 两个动作都要留: %+v", files[0])
	}
	if !h.talked || !h.spoke {
		t.Fatalf("关格保记录的证据要有：talked=%v spoke=%v", h.talked, h.spoke)
	}
}
