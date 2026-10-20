package install

import "testing"

// 排队中的 npm 安装被取消：从 runs 和队列里一起摘掉，推一条 done，
// 正在跑的那条不受影响；之后再推进队列也不会把它捡回来。
func TestCancelQueuedNPM(t *testing.T) {
	var events []map[string]any
	in := New(Deps{Push: func(v any) {
		if m, ok := v.(map[string]any); ok {
			events = append(events, m)
		}
	}})
	in.mu.Lock()
	in.runs["a"] = &run{}
	in.npmActive = "a"
	in.runs["b"] = &run{queued: true}
	in.npmQueue = []string{"b"}
	in.mu.Unlock()

	in.Cancel("b")

	in.mu.Lock()
	_, stillThere := in.runs["b"]
	queueLen := len(in.npmQueue)
	active := in.npmActive
	in.mu.Unlock()
	if stillThere {
		t.Fatal("取消后 runs 里还留着排队项")
	}
	if queueLen != 0 {
		t.Fatalf("取消后队列还有 %d 项", queueLen)
	}
	if active != "a" {
		t.Fatalf("正在跑的任务被动了：active=%q", active)
	}

	var done map[string]any
	for _, m := range events {
		if m["type"] == "install.done" && m["id"] == "b" {
			done = m
		}
	}
	if done == nil || done["ok"] != false {
		t.Fatalf("没有收到 b 的失败 done：%#v", events)
	}
	if done["errCode"] != "install.cancelled" {
		t.Fatalf("errCode = %#v", done["errCode"])
	}

	// a 结束后推进队列：b 已经被取消，不能复活，也不能卡住 active。
	in.npmDone("a")
	in.mu.Lock()
	active = in.npmActive
	in.mu.Unlock()
	if active != "" {
		t.Fatalf("取消项被复活或 active 没清：%q", active)
	}
}
