package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 库文件跨过一次读缓冲时不能漏检，更不能越界 —— 2026-10-23 真机启动
// 就是在这里 panic 的（旧实现把保留字节的偏移算到了缓冲区外）。
func TestOpenCodeSessionAcrossReadChunks(t *testing.T) {
	home := t.TempDir()
	// agent 都跑在用户真实的主目录里：把主目录指到临时目录。
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)

	const id = "ses_boundary_check"
	db := filepath.Join(home, ".local", "share", "opencode", "perch-cli.db")
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	// 让 id 跨在 256KB 的读块边界附近，且文件本身远大于一块。
	body := strings.Repeat("x", (256<<10)-3) + id + strings.Repeat("y", 300<<10)
	if err := os.WriteFile(db, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if !openCodeSessionExists(id) {
		t.Fatal("跨读块的会话 id 没有找到")
	}
	if openCodeSessionExists("ses_not_there") {
		t.Fatal("不存在的 id 被误判")
	}
}
