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
