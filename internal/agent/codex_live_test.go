//go:build windows

package agent

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// testTail 留住 TUI 最后一段输出，测试失败时打出来 —— 否则 ConPTY 里
// 发生了什么（信任提示？启动报错？）完全看不见。
type testTail struct {
	mu sync.Mutex
	b  []byte
}

func (w *testTail) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.b = append(w.b, p...)
	if len(w.b) > 32*1024 {
		w.b = w.b[len(w.b)-32*1024:]
	}
	w.mu.Unlock()
	return len(p), nil
}

func (w *testTail) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(w.b)
}

// liveCodexExe 给真机测试找 codex。生产路径由宿主注入（它有一份完整的
// 安装位置候选表）；测试里只补最常见的两个落点。
func liveCodexExe() (string, []string) {
	if v := strings.TrimSpace(os.Getenv("PERCH_CODEX_LIVE_EXE")); v != "" {
		return v, nil
	}
	if exe, prefix := host.ResolveExe("codex"); exe != "codex" {
		return exe, prefix
	}
	home, _ := os.UserHomeDir()
	cands := []string{
		filepath.Join(home, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		cands = append([]string{
			filepath.Join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
		}, cands...)
	}
	for _, p := range cands {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, nil
		}
	}
	return "codex", nil
}

// TestCodexLiveAppServer 是**真机**集成测试：起真的 app-server、真的 Codex
// TUI（ConPTY），打一轮真实对话，看状态腿是否按 thread/status/changed 落地。
//
// 默认不跑：它会用用户真实的 ~/.codex（需要 auth），并在会话历史里留下一条
// 测试会话。它**不读写任何配置**（不碰 hooks.json / config.toml）。
//
//	$env:PERCH_CODEX_LIVE = '1'
//	go test -run TestCodexLiveAppServer -v .
func TestCodexLiveAppServer(t *testing.T) {
	if os.Getenv("PERCH_CODEX_LIVE") != "1" {
		t.Skip("真机测试：设 PERCH_CODEX_LIVE=1 才跑（会用真实 codex 并写一条会话历史）")
	}
	// 用真实项目目录：Codex 对没见过的目录可能弹信任提示，测试没法回答。
	// 不传就用当前目录；PERCH_CODEX_LIVE_CWD 可以指定一个有 auth/信任的目录。
	cwd := os.Getenv("PERCH_CODEX_LIVE_CWD")
	if cwd == "" {
		dir, werr := os.Getwd()
		if werr != nil {
			t.Fatal(werr)
		}
		cwd = dir
	}
	token, digest, err := newCodexToken()
	if err != nil {
		t.Fatal(err)
	}
	cmd, waitCh, port, err := startCodexAppServer("live", cwd, digest, nil)
	if err != nil {
		t.Fatalf("app-server 起不来: %v", err)
	}
	defer stopCodexServer(cmd, waitCh)
	url := fmt.Sprintf("ws://127.0.0.1:%d", port)
	t.Logf("app-server: pid=%d %s", cmd.Process.Pid, url)

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	conn, err := dialCodex(ctx, url, token, "live")
	if err != nil {
		t.Fatalf("握手失败: %v", err)
	}

	events := make(chan agentEvent, 256)
	octx, ocancel := context.WithCancel(ctx)
	defer ocancel()
	obsDone := make(chan struct{})
	go func() {
		defer close(obsDone)
		observeCodex(octx, 1, cwd, url, token, conn, func(ev agentEvent) {
			select {
			case events <- ev:
			case <-octx.Done():
			}
		}, func() {}) // server 由本测试自己的 defer 收
	}()

	exe, prefix := liveCodexExe()
	args := append(append([]string{}, prefix...),
		"--remote", url, "--remote-auth-token-env", codexTokenEnv)
	env := BuildEnv(map[string]string{codexTokenEnv: token})
	sess, err := startPTY(exe, args, cwd, env, 110, 32)
	if err != nil {
		t.Fatalf("TUI 起不来: %v", err)
	}
	defer sess.Close()
	tail := &testTail{}
	defer func() {
		if t.Failed() {
			t.Logf("TUI 输出尾部：\n%s", tail.String())
		}
	}()
	go io.Copy(tail, sess)

	// 先等第一条状态：证明 TUI 已经连上这一格的 server、线程已经出现。
	// 这时 Session 还是空的 —— 第一轮之前没有 rollout，观察者刻意不绑定。
	ready := false
	startDeadline := time.After(45 * time.Second)
	for !ready {
		select {
		case ev := <-events:
			t.Logf("事件: %+v", ev)
			ready = true
		case <-startDeadline:
			t.Fatal("45s 内没有收到任何状态事件")
		}
	}

	// 等 TUI 真正画出输入框。只看状态事件不够：thread/started 在 TUI
	// 还在 loading 时就到了，这时打进去的字符会留在 composer 里但回车被吞。
	readyDeadline := time.Now().Add(30 * time.Second)
	for !strings.Contains(tail.String(), "Ask Codex to do anything") &&
		!strings.Contains(tail.String(), "To get started") {
		if time.Now().After(readyDeadline) {
			t.Fatalf("30s 内 TUI 没画出输入框；尾部：\n%s", tail.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	// 先清空可能已经存在的事件（loading 期间的 active 不算这一轮）。
drain:
	for {
		select {
		case ev := <-events:
			t.Logf("事件（安静期）: %+v", ev)
		default:
			break drain
		}
	}

	// 打一轮真实对话：只看状态腿（busy → idle），不看回复内容。
	// 文字和回车分开写：一起写的回车有几率被 loading 收掉。
	if _, err := sess.Write([]byte("Reply with exactly: PERCH-OK")); err != nil {
		t.Fatalf("写入 TUI: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if _, err := sess.Write([]byte("\r")); err != nil {
		t.Fatalf("回车写入 TUI: %v", err)
	}
	var session string
	sawBusy := false
	// 不同 TUI 对 Enter 的字节约定不一样：\r 没反应就试 \n、\r\n。
	// 这一步只影响测试怎么把字送进去，不影响产品代码。
	enterRetry := time.NewTimer(4 * time.Second)
	defer enterRetry.Stop()
	retries := 0
	turnDeadline := time.After(90 * time.Second)
	for {
		select {
		case <-enterRetry.C:
			if !sawBusy {
				retries++
				switch retries {
				case 1:
					t.Log("回车（\\r）没提交，试 \\n")
					_, _ = sess.Write([]byte("\n"))
				case 2:
					t.Log("回车（\\n）没提交，试 \\r\\n")
					_, _ = sess.Write([]byte("\r\n"))
				default:
					t.Log("Enter 都不认，放弃")
					t.Fatalf("TUI 不把 Enter 当提交；尾部：\n%s", tail.String())
				}
				enterRetry.Reset(4 * time.Second)
			}
		case ev := <-events:
			t.Logf("事件（这一轮）: %+v", ev)
			if ev.Session != "" && session == "" {
				session = ev.Session
				t.Logf("第一轮开始，绑定线程=%s", session)
			}
			if session == "" || ev.Session != session {
				continue
			}
			if ev.Status == "busy" {
				sawBusy = true
			}
			if sawBusy && ev.Status == "idle" {
				// 冷恢复的判据：第一轮之后真实 rollout 文件必须能被
				// 我们的 glob 认出来（这是产品里“下次还能接上”的依据）。
				deadline := time.Now().Add(10 * time.Second)
				for !codexSessionFileExists(cwd, session) {
					if time.Now().After(deadline) {
						t.Fatalf("盘上找不到 %s 的 rollout 文件", session)
					}
					time.Sleep(200 * time.Millisecond)
				}
				t.Logf("busy→idle 完成，rollout 存在：%s", session)
				return
			}
		case <-turnDeadline:
			t.Fatalf("90s 内没有等到 busy→idle（sawBusy=%v session=%q）", sawBusy, session)
		}
	}
}

// TestCodexLiveShutdown 验证关格那条路：取消观察者后 server 进程真的退出了。
// 和上面共用 opt-in 开关（都会起真实 codex）。
func TestCodexLiveShutdown(t *testing.T) {
	if os.Getenv("PERCH_CODEX_LIVE") != "1" {
		t.Skip("真机测试：设 PERCH_CODEX_LIVE=1 才跑")
	}
	cwd := t.TempDir()
	_, digest, err := newCodexToken()
	if err != nil {
		t.Fatal(err)
	}
	cmd, waitCh, _, err := startCodexAppServer("live-shutdown", cwd, digest, nil)
	if err != nil {
		t.Fatal(err)
	}
	stopCodexServer(cmd, waitCh)
	if cmd.ProcessState == nil || !cmd.ProcessState.Exited() {
		t.Fatalf("stopCodexServer 返回后进程还在: %+v", cmd.ProcessState)
	}
}
