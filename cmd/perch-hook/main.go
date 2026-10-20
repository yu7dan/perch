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
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	/* agy 模式：`perch-hook.exe --agy <hookDir> <Event>`。
	   agy 的 hooks.json 是**全局一份**（~/.gemini/config），事件里没有格子 id；
	   格子归属仍由环境变量 PERCH_AGENT_PANE 决定（Perch 开格时注入）。
	   ⚠️ agy 要求每个 hook 在 stdout 上输出一个 JSON 对象：`{}` = 不注入、
	   不改变 Stop 的默认决策。任何情况下都必须把这行写出去。 */
	if len(os.Args) > 3 && os.Args[1] == "--agy" {
		runAgy(os.Args[2], os.Args[3], os.Getenv)
		return
	}

	dest := destFor(os.Args, os.Getenv)
	body, _ := io.ReadAll(os.Stdin)

	if dest == "" || len(body) == 0 {
		os.Exit(0)
	}
	appendLine(dest, body)
}

func runAgy(hookDir, event string, getenv func(string) string) {
	body, _ := io.ReadAll(os.Stdin)
	if dest := paneDest(hookDir, getenv); dest != "" && len(body) > 0 {
		if line := normalizeAgy(event, body); line != nil {
			appendLine(dest, line)
		}
	}
	os.Stdout.WriteString("{}\n")
}

func paneDest(dir string, getenv func(string) string) string {
	pane := getenv("PERCH_AGENT_PANE")
	if !paneTagRE.MatchString(pane) {
		return ""
	}
	return filepath.Join(dir, pane+".jsonl")
}

type agyInput struct {
	ConversationID    string   `json:"conversationId"`
	WorkspacePaths    []string `json:"workspacePaths"`
	TranscriptPath    string   `json:"transcriptPath"`
	TerminationReason string   `json:"terminationReason"`
	FullyIdle         *bool    `json:"fullyIdle"`
	Error             string   `json:"error"`
}

// normalizeAgy 把 agy 的 camelCase payload 折成和 Claude 同一组事件名，
// 轮询器/前端就不用认识第二套 schema。
//
// ⚠️ 只保留状态分类需要的字段：**不写 prompt / 工具参数 / 错误正文**。
// transcriptPath 是文件路径（会话身份），和 Claude 那条腿一样要。
func normalizeAgy(event string, body []byte) []byte {
	var in agyInput
	if json.Unmarshal(body, &in) != nil {
		return nil
	}
	var name string
	failed := false
	switch event {
	case "SessionStart":
		name = "AgySessionStart"
	case "PreInvocation":
		name = "AgyWorking"
	case "Stop":
		if strings.EqualFold(strings.TrimSpace(in.TerminationReason), "ERROR") ||
			strings.TrimSpace(in.Error) != "" {
			name, failed = "AgyIdle", true
		} else if in.FullyIdle != nil && !*in.FullyIdle {
			// 还有后台任务没跑完：Stop 只说明执行循环结束，不等于空闲。
			name = "AgyWorking"
		} else {
			name = "AgyIdle"
		}
	default:
		return nil
	}
	cwd := ""
	if len(in.WorkspacePaths) > 0 {
		cwd = in.WorkspacePaths[0]
	}
	out := map[string]any{
		"hook_event_name": name,
		"session_id":      in.ConversationID,
		"cwd":             cwd,
		"transcript_path": in.TranscriptPath,
		"source":          "agy",
		"agy_event":       event,
		"reason":          in.TerminationReason,
	}
	if failed {
		out["failed"] = true
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil
	}
	return b
}

func appendLine(dest string, body []byte) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return
	}
	// 一次 Write 追加：Windows 上单次写入是原子的，多个 hook 并发不会互相切碎行。
	f, err := os.OpenFile(dest, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	// 前缀本地时间，方便和 TUI 屏幕上的时间对。
	f.WriteString(time.Now().Format("15:04:05.000") + " ")
	f.Write(body)
	f.WriteString("\n")
}
