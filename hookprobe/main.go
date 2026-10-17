// 交互式探针：hooks 在 **PTY 里的交互式 TUI**（生产路径）上也触发吗？
//
// 已经证明过的：`-p` 模式下 --session-id / 内联 --settings / hook 触发 / stdin 形状 / env。
// 还没证明的：交互式 TUI 是不是同一条路。这个是整份计划的地基假设 —— 如果不成立，
// 「格子↔会话关联」就只能退回按时间戳猜 jsonl，形状要改。
//
// 第一版探针跑了 25s 一无所获，dump 出 TUI 字节才发现真相：
// 交互式启动会先问「Is this project you created or one you trust?」，
// 在用户应答之前 SessionStart 根本不触发。所以探针必须**先走完人机流程**，
// 否则"没事件"是探针自己的锅，不是 CLI 的。
//
// 而且那个框的 ❯ 光标默认停在 "No, exit" 上 —— 直接回车是退出，得先按方向下。
package main

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// 探针不写死任何本机路径：agent 可执行文件、Claude 状态根、临时目录都从
// 环境/系统默认值取。要指向别处的 agent 就设 CLAUDE_EXE。
var (
	claudeExe = func() string {
		if v := strings.TrimSpace(os.Getenv("CLAUDE_EXE")); v != "" {
			return v
		}
		return "claude.exe"
	}()
	configDir = func() string {
		if v := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); v != "" {
			return v
		}
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, ".claude")
		}
		return ".claude"
	}()
	smokeDir = filepath.Join(os.TempDir(), "perch-hooksmoke")
	outPath  = filepath.Join(smokeDir, "probe-out.bin")
	evPath   = filepath.Join(smokeDir, "events.jsonl")
)

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func events() string {
	b, _ := os.ReadFile(evPath)
	return strings.TrimRight(string(b), "\n")
}

// tail 取输出文件最后 n 字节。TUI 会一直在重绘，全量读会越来越大，
// 而且我们只关心"现在屏幕上是什么"。
func tail(n int64) string {
	f, err := os.Open(outPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	fi, _ := f.Stat()
	off := fi.Size() - n
	if off < 0 {
		off = 0
	}
	f.Seek(off, 0)
	b, _ := io.ReadAll(f)
	return string(b)
}

// waitFor 每秒看一次，秒级精度就够（这些事件本身就是秒级）。
func waitFor(what string, d time.Duration, pred func() bool) bool {
	t0 := time.Now()
	for i := 0; i < int(d.Seconds()); i++ {
		if pred() {
			fmt.Printf("  ✅ %s（%s）\n", what, time.Since(t0).Round(time.Millisecond))
			return true
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("  ❌ %s 没等到（等了 %s）\n", what, d)
	return false
}

func main() {
	raw, err := os.ReadFile(smokeDir + `\settings.smoke.json`)
	if err != nil {
		fmt.Println("读 settings 失败:", err)
		os.Exit(1)
	}
	// 刻意用**内联字符串**：这条路径会经过 quoteArg（cmd 的引号规则），
	// 带引号带反斜杠的 JSON 能不能活着到子进程，是生产路径要用的东西。
	settings := strings.TrimSpace(string(raw))

	id := newUUID()
	args := []string{"--session-id", id, "--settings", settings}

	os.Remove(evPath)
	os.Remove(outPath)

	fmt.Println("session-id =", id)
	fmt.Println("settings  =", len(settings), "字节，内联字符串")
	fmt.Println("cwd       =", smokeDir)

	p, err := startPTY(claudeExe, args, smokeDir,
		buildEnv(map[string]string{"CLAUDE_CONFIG_DIR": configDir}), 120, 30)
	if err != nil {
		fmt.Println("startPTY 失败:", err)
		os.Exit(1)
	}
	pid := p.Pid()
	fmt.Println("claude pid =", pid)

	outF, _ := os.Create(outPath)
	go io.Copy(outF, p)

	defer func() {
		p.Close()
		time.Sleep(300 * time.Millisecond)
		outF.Close()
		// 只按**这一个 PID** 收树。绝不用 Stop-Process -Name claude。
		exec.Command("taskkill", "/PID", fmt.Sprint(pid), "/T", "/F").Run()
		fmt.Println("---- 收尾：taskkill /PID", pid, "/T /F ----")
	}()

	// ── 阶段 0：信任框（只有没见过的目录才会出现）────────────────────
	// 不能 startPTY 一返回就检查：那时 TUI 还没画出来，会漏掉框、然后白等 30s。
	// 轮询到"出现信任框"或"SessionStart 已到"为止，两者谁先都行。
	fmt.Println("---- 等 TUI 画出来（看有没有信任框）----")
	t0 := time.Now()
	sawTrust := false
	for i := 0; i < 20; i++ {
		if strings.Contains(events(), "SessionStart") {
			break
		}
		if strings.Contains(tail(8192), "trust") {
			sawTrust = true
			break
		}
		time.Sleep(time.Second)
	}
	if sawTrust {
		fmt.Printf("---- 出现信任框（%s），按 ↓ 再回车；❯ 默认停在 No, exit 上，直接回车是退出 ----\n",
			time.Since(t0).Round(time.Millisecond))
		time.Sleep(400 * time.Millisecond)
		p.Write([]byte("\x1b[B")) // ↓ 移到 "Yes, I trust this folder"
		time.Sleep(400 * time.Millisecond)
		p.Write([]byte("\r"))
	} else {
		fmt.Println("---- 没有信任框（目录已被信任，或已经把会话开起来了）----")
	}

	// ── 阶段 1：SessionStart ────────────────────────────────────────
	fmt.Println("---- 等 SessionStart ----")
	if !waitFor("SessionStart", 30*time.Second, func() bool { return strings.Contains(events(), "SessionStart") }) {
		fmt.Println("---- 事件文件 ----");  fmt.Println(events())
		fmt.Println("---- 屏幕 ----"); fmt.Println(visibleTail(3000))
		return
	}

	// ── 阶段 2：真打一句话，看一轮走完会不会触发 Stop ────────────────
	time.Sleep(2 * time.Second)
	fmt.Println(`---- 往 PTY 写：reply with exactly: ok \r ----`)
	p.Write([]byte("reply with exactly: ok\r"))

	fmt.Println("---- 等 Stop ----")
	waitFor("Stop", 90*time.Second, func() bool { return strings.Contains(events(), `"Stop"`) })

	fmt.Println("---- 全部事件 ----")
	fmt.Println(events())

	fmt.Println("---- transcript ----")
	if m, _ := filepath.Glob(filepath.Join(configDir, "projects", "*", id+".jsonl")); len(m) == 0 {
		fmt.Println("  没找到")
	} else {
		for _, x := range m {
			fi, _ := os.Stat(x)
			fmt.Printf("  %s  %d 字节\n", x, fi.Size())
		}
	}

	fmt.Println("---- 屏幕（控制字符已可视化）----")
	fmt.Println(visibleTail(3000))
}

// visibleTail 把控制字符换成可见记号再返回，否则把这些字节直接打到自己的终端上，
// 会被重新解释成光标移动，我看到的就不是子进程的屏幕了。
func visibleTail(n int64) string {
	return strings.NewReplacer("\x1b", "<ESC>", "\r", "<CR>", "\n", "<LF>\n").Replace(tail(n))
}
