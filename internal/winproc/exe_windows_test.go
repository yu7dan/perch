package winproc

import (
	"path/filepath"
	"testing"
)

// Qoder 的官方安装器把 dispatcher 放在 ~/.qoder/entry，而 GUI 进程常常
// 继承不到用户 PATH —— 这条契约保证 FindExe 还能在固定落点找到它。
func TestQoderExeHints(t *testing.T) {
	hints := agentExeHints("qodercli", `C:\Users\me`, `C:\Users\me\AppData\Local`)
	want := []string{
		filepath.Join(`C:\Users\me`, ".qoder", "bin", "qodercli", "qodercli.exe"),
		filepath.Join(`C:\Users\me`, ".qoder", "entry", "qoder.cmd"),
	}
	if len(hints) != len(want) {
		t.Fatalf("hints = %#v", hints)
	}
	for i := range want {
		if hints[i] != want[i] {
			t.Fatalf("hints[%d] = %q，想要 %q", i, hints[i], want[i])
		}
	}
}
