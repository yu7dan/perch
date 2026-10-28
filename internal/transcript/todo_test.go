package transcript

import "testing"

// TodoWrite 的清单折成进度（Bot Group 的车道进度条读它）。
func TestReadTodos(t *testing.T) {
	in := decodeInput([]byte(`{"todos":[
		{"content":"读代码","status":"completed","activeForm":"读代码中"},
		{"content":"改预选","status":"in_progress","activeForm":"正在改预选"},
		{"content":"跑测试","status":"pending","activeForm":"跑测试中"}]}`))
	got := readTodos(in)
	if got == nil || got.Done != 1 || got.Total != 3 || got.Cur != "正在改预选" {
		t.Fatalf("readTodos = %+v", got)
	}
	if readTodos(decodeInput([]byte(`{}`))) != nil {
		t.Fatal("empty input should give nil")
	}
}

// 同一条 message 拆成几行落盘、每行都带 usage：以最后一行为准，累计不重复算。
func TestAssistantUsageCumulative(t *testing.T) {
	tr := newTrace("x.jsonl", "", "claude", "")
	at := "2026-10-28T10:00:00Z"
	tr.consumeAssistant([]byte(`{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":5,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"a"}]}`), at)
	it := tr.consumeAssistant([]byte(`{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":40,"cache_creation_input_tokens":10},"content":[{"type":"text","text":"b"}]}`), at)
	if it == nil || it.Cum != 150 || it.Model != "claude-opus-5-5" {
		t.Fatalf("after m1 = %+v", it)
	}
	it = tr.consumeAssistant([]byte(`{"id":"m2","model":"claude-opus-5-5","usage":{"input_tokens":20,"output_tokens":30},"content":[{"type":"text","text":"c"}]}`), at)
	if it.Cum != 200 {
		t.Fatalf("after m2 cum = %d", it.Cum)
	}
}
