package main

// root 测试共用的手工夹具。

import (
	"os"
	"path/filepath"
	"testing"
)

// writeClaudeTranscript 在 stateDir\projects\demo 下造一份会话文件，
// 供续接护栏的测试使用。
func writeClaudeTranscript(t *testing.T, stateDir, id string) {
	t.Helper()
	dir := filepath.Join(stateDir, "projects", "demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
