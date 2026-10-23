package agent

import (
	"bytes"
	"os"
	"path/filepath"
)

// OpenCode 的会话不在 jsonl 里：1.19.x 把它写在 OPENCODE_DB=perch-cli.db 的
// SQLite 库里（Perch 特意用独立库名，见 prepareOpenCode 那段）。这里只回答
// "这个 id 还在不在"，不引 SQLite 驱动 —— 会话 id 是 `ses_<random>`，
// 在库文件里是明文；流式扫一遍就够，且不会写锁。
//
// ⚠️ 必须把 -wal 也算上：刚跑完的一轮可能还没 checkpoint 到主库。
func openCodeSessionExists(id string) bool {
	if !SafeSessionID(id) {
		return false
	}
	home := agentHome("opencode")
	if home == "" {
		return false
	}
	base := filepath.Join(home, ".local", "share", "opencode", "perch-cli.db")
	for _, p := range []string{base, base + "-wal"} {
		if fileContains(p, id) {
			return true
		}
	}
	return false
}

func fileContains(path, needle string) bool {
	if needle == "" {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	want := []byte(needle)
	const chunk = 256 << 10
	buf := make([]byte, chunk)
	// 保留上一块末尾 len(want)-1 字节，避免命中的 id 被切在两次读之间。
	var tail []byte
	for {
		n, err := f.Read(buf)
		if n > 0 {
			data := make([]byte, 0, len(tail)+n)
			data = append(data, tail...)
			data = append(data, buf[:n]...)
			if bytes.Contains(data, want) {
				return true
			}
			keep := len(want) - 1
			if keep > len(data) {
				keep = len(data)
			}
			tail = append(tail[:0], data[len(data)-keep:]...)
		}
		if err != nil {
			return false
		}
	}
}
