package history

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 同一次回复按内容块写成多行：用量只算一次（取最后一行），按本地日期归天，按模型分账。
func TestScanTokensDedupByMessageID(t *testing.T) {
	root := t.TempDir()
	proj := filepath.Join(root, "projects", "D--demo")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 10, 28, 3, 0, 0, 0, time.UTC).Format(time.RFC3339)
	day := localDay(ts)
	lines := `{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"` + ts + `"}
{"message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"thinking","thinking":"\"usage\":{ not real }"}],"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}},"type":"assistant","timestamp":"` + ts + `"}
{"message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":20}}},"type":"assistant","timestamp":"` + ts + `"}
{"message":{"id":"m2","model":"claude-haiku-5-5","content":[],"usage":{"input_tokens":3,"output_tokens":2}},"type":"assistant","timestamp":"` + ts + `"}
`
	if err := os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	_, act := Scan(root, func(string) (string, bool) { return "", false })
	if len(act) != 1 || act[0].Day != day {
		t.Fatalf("activity = %+v, want one day %s", act, day)
	}
	a := act[0]
	want := TokenUse{In: 13, Out: 7, CacheRead: 100, CacheWrite: 20}
	if a.Tokens != want {
		t.Errorf("tokens = %+v, want %+v", a.Tokens, want)
	}
	if a.Replies != 2 || a.Turns != 1 {
		t.Errorf("replies=%d turns=%d, want 2 and 1", a.Replies, a.Turns)
	}
	if a.Models["claude-opus-5-5"] != 135 || a.Models["claude-haiku-5-5"] != 5 {
		t.Errorf("models = %v", a.Models)
	}
}

// 真数据冒烟（默认跳过）：PERCH_REAL_STATE=<CLAUDE_CONFIG_DIR> go test -run Real -v
// 只读扫描，打印耗时和最近几天的用量，量"多数一段"会不会拖慢会话索引。
func TestScanTokensRealData(t *testing.T) {
	dir := os.Getenv("PERCH_REAL_STATE")
	if dir == "" {
		t.Skip("PERCH_REAL_STATE not set")
	}
	t0 := time.Now()
	sess, act := Scan(dir, nil)
	t.Logf("scan: %d sessions, %d days, %v", len(sess), len(act), time.Since(t0))
	for _, a := range act[max(0, len(act)-4):] {
		t.Logf("%s turns=%d replies=%d tokens=%+v models=%v", a.Day, a.Turns, a.Replies, a.Tokens, a.Models)
	}
}
