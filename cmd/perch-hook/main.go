// hook 接收器：claude 按事件起我们一次，我们读 stdin、往一条 jsonl 追加一行。
//
// 为什么是编译好的原生 exe 而不是 PowerShell 脚本 —— 一个实测数字：
// hook 命令走 PowerShell 光起进程就要 272–286ms（三次 272/286/272），
// 而 Stop 是**每轮对话**都触发的，TUI 还会把 "running Stop hook" 画在状态栏上
// （用户看得见）。同一个测量壳子里原生 exe 是 16–25ms，差 15 倍。
//
// 用法（由 --settings 注入，exec 形式）：
//
//	perch-hook.exe <dest.jsonl>
//
// 任何失败都必须静默 exit 0：hook 挂掉可以丢事件，但绝不能拖住 agent 的轮次。
// （实测的 stdout 契约：SessionStart 的 exit-0 stdout **会进模型上下文**，
//
//	Stop/Notification 的不显示；exit 2 在 Stop 上反而是"唤醒模型继续对话"。）
package main

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// DSH 的 hook 配置是**全局一份**，不能像 Claude 的 --settings 那样把每个格子的
// 事件路径写死。所以它用第二个参数 `--pane` 表示“目录模式”：接收器从环境变量
// PERCH_AGENT_PANE 读出格子标签（t1、t2…），再拼出和 Claude 同名的
// <hookDir>/t<N>.jsonl。轮询器因此完全不用改。
var paneTagRE = regexp.MustCompile(`^t[0-9]+$`)

func destFor(args []string, getenv func(string) string) string {
	if len(args) > 2 && (args[2] == "--pane" || args[2] == "-pane") {
		pane := getenv("PERCH_AGENT_PANE")
		if !paneTagRE.MatchString(pane) {
			return ""
		}
		return filepath.Join(args[1], pane+".jsonl")
	}
	if len(args) > 1 {
		return args[1]
	}
	return ""
}

func main() {
	dest := destFor(os.Args, os.Getenv)
	body, _ := io.ReadAll(os.Stdin)

	if dest == "" || len(body) == 0 {
		os.Exit(0)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		os.Exit(0)
	}

	// 一次 Write 追加：Windows 上单次写入是原子的，多个 hook 并发不会互相切碎行。
	f, err := os.OpenFile(dest, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		os.Exit(0)
	}
	defer f.Close()
	// 前缀本地时间，方便和 TUI 屏幕上的时间对。
	f.WriteString(time.Now().Format("15:04:05.000") + " ")
	f.Write(body)
	f.WriteString("\n")
}
