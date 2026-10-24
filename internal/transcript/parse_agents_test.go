package transcript

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// 这些样本全部来自本机实测的转录（字段原样，只截短了正文）。它们守的是
// “每种形状至少能被自己那份解析器读懂”，不是“形状永远不变”。

func newAgentTrace(t *testing.T, agent string) *trace {
	t.Helper()
	dir := t.TempDir()
	return newTrace(filepath.Join(dir, "t.jsonl"), dir, agent, "")
}

func feedLines(tr *trace, lines ...string) {
	for _, line := range lines {
		tr.consumeLine(line)
	}
}

func findAct(tr *trace, kind, text string) *ActItem {
	for i := range tr.acts {
		if tr.acts[i].Kind == kind && (text == "" || contains(tr.acts[i].Text, text)) {
			return &tr.acts[i]
		}
	}
	return nil
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func TestCodexParser(t *testing.T) {
	tr := newAgentTrace(t, "codex")
	feedLines(tr,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:00Z","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>…"}]}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context><cwd>C:\\x</cwd></environment_context>"}]}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:02Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"看一下 a.txt"}]}}`,
		`{"type":"event_msg","timestamp":"2026-10-23T08:45:02Z","payload":{"type":"user_message","message":"看一下 a.txt"}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:03Z","payload":{"type":"function_call","name":"shell","call_id":"call_1","arguments":"{\"command\":[\"powershell\",\"-Command\",\"Get-Content a.txt\"]}"}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:04Z","payload":{"type":"function_call_output","call_id":"call_1","output":"hello"}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:05Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"读到了"}]}}`,
	)
	if got := countKind(tr, "prompt"); got != 1 {
		t.Fatalf("prompt 应当只有 1 条（环境上下文和 event_msg 重复都要丢掉），实际 %d: %+v", got, tr.acts)
	}
	if p := findAct(tr, "prompt", "a.txt"); p == nil || p.Text != "看一下 a.txt" {
		t.Fatalf("用户提问不对: %+v", tr.acts)
	}
	tool := findAct(tr, "tool", "")
	if tool == nil || tool.Tool != "shell" || tool.OK == nil || !*tool.OK {
		t.Fatalf("工具调用/结果没有配对: %+v", tr.acts)
	}
	if findAct(tr, "text", "读到了") == nil {
		t.Fatalf("assistant 正文没有落: %+v", tr.acts)
	}
}

// Codex 在 Windows 上把 apply_patch 折进 exec_command 的脚本文本里：
// 工具名不是文件工具，但补丁头就是结构化事实，台账不能空着。
func TestCodexExecCommandApplyPatch(t *testing.T) {
	tr := newAgentTrace(t, "codex")
	feedLines(tr,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:03Z","payload":{"type":"function_call","name":"exec_command","call_id":"call_2","arguments":"{\"cmd\":\"$patch = @'\\n*** Begin Patch\\n*** Update File: perch-codex-edit.txt\\n@@\\n-old\\n+new\\n*** End Patch\\n'@\\n& apply_patch $patch\"}"}}`,
		`{"type":"response_item","timestamp":"2026-10-23T08:45:04Z","payload":{"type":"function_call_output","call_id":"call_2","output":"Success"}}`,
	)
	tool := findAct(tr, "tool", "apply_patch")
	if tool == nil || !strings.HasSuffix(tool.Path, "perch-codex-edit.txt") {
		t.Fatalf("补丁头没有被读成 apply_patch 工具: %+v", tr.acts)
	}
	if tr.files[strings.ToLower(filepath.Clean(tool.Path))] == nil {
		t.Fatalf("补丁里的文件没有进台账: %+v", tr.files)
	}
}

func TestPiParser(t *testing.T) {
	tr := newAgentTrace(t, "pi")
	feedLines(tr,
		`{"type":"message","timestamp":"2026-10-23T08:00:00Z","message":{"role":"user","content":[{"type":"text","text":"读一下 a.txt"}]}}`,
		`{"type":"message","timestamp":"2026-10-23T08:00:01Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"先读文件"},{"type":"text","text":"我来看看"},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"a.txt"}}]}}`,
		`{"type":"message","timestamp":"2026-10-23T08:00:02Z","message":{"role":"toolResult","toolCallId":"call_1","content":[{"type":"text","text":"hello"}],"isError":false}}`,
	)
	if findAct(tr, "prompt", "a.txt") == nil || findAct(tr, "thinking", "") == nil {
		t.Fatalf("prompt/thinking 没落: %+v", tr.acts)
	}
	tool := findAct(tr, "tool", "")
	if tool == nil || tool.OK == nil || !*tool.OK || tool.Path != "a.txt" {
		t.Fatalf("tool 结果没回填: %+v", tr.acts)
	}
	if countKind(tr, "tool") != 1 {
		t.Fatalf("tool 应当只有 1 条: %+v", tr.acts)
	}
}

func TestAgyParser(t *testing.T) {
	tr := newAgentTrace(t, "agy")
	feedLines(tr,
		`{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-10-23T01:28:44Z","content":"<USER_REQUEST>\n继续\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"}`,
		`{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-23T01:28:45Z","thinking":"先看文件","tool_calls":[{"name":"read_file","args":{"Path":"C:\\x\\a.txt"}}]}`,
		`{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-10-23T01:28:46Z","content":"hello"}`,
		`{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-10-23T01:28:47Z","content":"好了"}`,
	)
	if p := findAct(tr, "prompt", ""); p == nil || p.Text != "继续" {
		t.Fatalf("USER_REQUEST 提取不对: %+v", tr.acts)
	}
	tool := findAct(tr, "tool", "")
	if tool == nil || tool.Tool != "read_file" || tool.OK == nil || !*tool.OK {
		t.Fatalf("工具结果没有按 FIFO 配对: %+v", tr.acts)
	}
	if findAct(tr, "text", "好了") == nil {
		t.Fatalf("最终回复没落: %+v", tr.acts)
	}
}

func TestCursorParser(t *testing.T) {
	tr := newAgentTrace(t, "cursor")
	feedLines(tr,
		`{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Friday</timestamp>\n<user_query>你好</user_query>"}]}}`,
		`{"role":"assistant","message":{"content":[{"type":"text","text":"你好！需要我做什么？"}]}}`,
	)
	if p := findAct(tr, "prompt", ""); p == nil || p.Text != "你好" {
		t.Fatalf("user_query 提取不对: %+v", tr.acts)
	}
	if findAct(tr, "text", "需要我做什么") == nil {
		t.Fatalf("assistant 正文没落: %+v", tr.acts)
	}
	if tr.acts[0].At == "" {
		t.Fatalf("无时间戳的转录应当补一个展示时间: %+v", tr.acts[0])
	}
}

func TestCopilotParser(t *testing.T) {
	tr := newAgentTrace(t, "copilot")
	feedLines(tr,
		`{"type":"user.message","data":{"content":"跑个命令"},"timestamp":"2026-10-23T00:53:20Z"}`,
		`{"type":"tool.execution_start","data":{"toolName":"bash","toolCallId":"call_1","arguments":{"command":"echo hi"}},"timestamp":"2026-10-23T00:53:21Z"}`,
		`{"type":"tool.execution_complete","data":{"toolCallId":"call_1","result":"hi","success":true},"timestamp":"2026-10-23T00:53:22Z"}`,
		`{"type":"assistant.message","data":{"content":"好了"},"timestamp":"2026-10-23T00:53:23Z"}`,
	)
	if findAct(tr, "prompt", "跑个命令") == nil {
		t.Fatalf("用户消息没落: %+v", tr.acts)
	}
	tool := findAct(tr, "tool", "")
	if tool == nil || tool.OK == nil || !*tool.OK || tool.Tool != "bash" {
		t.Fatalf("工具结果没回填: %+v", tr.acts)
	}
	if findAct(tr, "text", "好了") == nil {
		t.Fatalf("assistant 消息没落: %+v", tr.acts)
	}
}

func TestQoderParserSharesClaudeShape(t *testing.T) {
	tr := newAgentTrace(t, "qoder")
	feedLines(tr,
		`{"type":"user","uuid":"u1","timestamp":"2026-10-23T07:47:36Z","message":{"role":"user","content":"看看 a.txt"}}`,
		`{"type":"assistant","uuid":"a1","timestamp":"2026-10-23T07:47:37Z","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"a.txt"}}]}}`,
		`{"type":"user","uuid":"u2","timestamp":"2026-10-23T07:47:38Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"hello"}]}]}}`,
		`{"type":"assistant","uuid":"a2","timestamp":"2026-10-23T07:47:39Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"看到了"}]}}`,
	)
	tool := findAct(tr, "tool", "")
	if tool == nil || tool.OK == nil || !*tool.OK {
		t.Fatalf("Qoder 的裸 tool_result 没回填: %+v", tr.acts)
	}
	if findAct(tr, "text", "看到了") == nil {
		t.Fatalf("Qoder 回复没落: %+v", tr.acts)
	}
}

func TestDshParser(t *testing.T) {
	tr := newAgentTrace(t, "dsh")
	feedLines(tr,
		`{"type":"user/message","time":1792741975976,"data":{"content":[{"type":"text","text":"Reply with exactly: PERCH_DSH_OK"}],"source":{"kind":"user"}}}`,
		`{"type":"user/message","time":1792741975978,"data":{"content":[{"type":"text","text":"<system-reminder>技能清单</system-reminder>"}],"source":{"kind":"user"}}}`,
		`{"type":"assistant/message","time":1792741979751,"data":{"message":{"role":"assistant","content":[{"type":"reasoning","text":"直接回答"},{"type":"text","text":"PERCH_DSH_OK"}]}}}`,
	)
	if got := countKind(tr, "prompt"); got != 1 {
		t.Fatalf("DSH 的 system-reminder 不该算用户提问: %+v", tr.acts)
	}
	if findAct(tr, "thinking", "直接回答") == nil || findAct(tr, "text", "PERCH_DSH_OK") == nil {
		t.Fatalf("DSH assistant 内容没落: %+v", tr.acts)
	}
}

func TestZstdConcatenatedFrames(t *testing.T) {
	line1 := []byte(`{"type":"session","version":4}` + "\n")
	line2 := []byte(`{"type":"assistant/message","time":1,"data":{"message":{"content":[{"type":"text","text":"hi"}]}}}` + "\n")
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	f1 := enc.EncodeAll(line1, nil)
	f2 := enc.EncodeAll(line2, nil)
	enc.Close()
	joined := append(append([]byte{}, f1...), f2...)
	out, err := traceZstd.DecodeAll(joined, nil)
	if err != nil {
		t.Fatalf("串联帧解码失败: %v", err)
	}
	if string(out) != string(line1)+string(line2) {
		t.Fatalf("串联帧只解出了第一帧: %q", out)
	}
}

func countKind(tr *trace, kind string) int {
	n := 0
	for _, a := range tr.acts {
		if a.Kind == kind {
			n++
		}
	}
	return n
}
