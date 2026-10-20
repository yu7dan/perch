package agent

import "context"

// ResumeIntent 是「以什么姿态接上已有会话」。前端只声明意图，
// 翻译成命令行是 agent 自己的事。
type ResumeIntent struct {
	Kind string `json:"kind"` // "new" | "latest" | "exact" | "fork"
	ID   string `json:"id"`
}

// Def 把「续接意图」翻译成命令行参数，外加这个 agent 需要的环境变量。
//
// 新增一个 agent = 在 internal/agent 里加一份构造函数，别处不用改。
type Def struct {
	Exe string
	// Bin 是没解析前的命令名（如 "codex"）。有它时，**每次开格都重新解析一次**
	// 可执行文件位置 —— 用户可能在 Perch 开着的时候装了/更新了一个 agent。
	Bin string
	// Prefix 只在 Windows 的 .cmd/.bat shim 上出现（npm 装出来的 CLI）：
	// Exe 是 cmd.exe，Prefix 是 ["/c", <shim>]。ConPTY 不能直接启动 .cmd。
	Prefix []string
	Env    map[string]string
	// Args 把「续接意图」翻译成命令行。settings 是注入的 --settings JSON
	// 字符串（空 = 不注入）。
	Args func(ResumeIntent, string) []string
	// Prepare 在每次开格前调用，用来做“这一格才有的”准备：分配端口、生成口令、
	// 决定事件文件路径。返回的 env/args 只作用于这一次启动；observe 在 PTY
	// 起来之后跑，ctx 一取消就退出。
	Prepare func(tag string, tabID int, cwd string) (env map[string]string, args []string, observe func(context.Context), err error)
}

// GenericDef 是最小适配：能开一格新会话，没有续接和状态。
func GenericDef(bin string) Def {
	exe, prefix := host.ResolveExe(bin)
	return Def{
		Exe:    exe,
		Bin:    bin,
		Prefix: prefix,
		Args: func(ResumeIntent, string) []string {
			return nil
		},
	}
}

// CodexDef 是每格一个 app-server + TUI --remote 的适配器。
func CodexDef() Def { return codexDef() }

// OpenCodeDef 是读取 TUI 自带 HTTP server 的适配器。
func OpenCodeDef() Def { return openCodeDef() }

// PiDef 是每格一个观察扩展 + JSONL tail 的适配器。
func PiDef() Def { return piDef() }
