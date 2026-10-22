package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/yu7dan/perch/internal/winproc"
)

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
	Prepare func(tag string, tabID int, cwd string, profileArgs []string) (env map[string]string, args []string, observe func(context.Context), err error)
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

// AgyDef 是 Antigravity CLI 的启动适配。
//
// agy 接进 magpie 之后，modelProvider="gemini" 写在 settings.json 里，但
// 网关地址和密钥只认环境变量（GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY），
// 配置文件里没有它们的位置。magpie 的 /api/state 会为这种 agent 给一条
// launch 命令；组合根把它解析成 env+args 交给这里，每次开格现取。
//
// 没接线时 WireLaunch 返回 ok=false，退回 GenericDef 的普通启动。
//
// 隔离引擎模式下还要把 agy 的用户目录换到引擎沙盒：引擎已经 seed 了一份
// agy settings，且之后 magpie 的通用接入只写沙盒；如果 agy 仍读桌面配置，
// 两边就会看到不同的模型/信任列表，还会把会话写回桌面。
func AgyDef() Def {
	d := GenericDef("agy")
	d.Prepare = func(_ string, _ int, _ string, _ []string) (map[string]string, []string, func(context.Context), error) {
		env, args, ok := host.WireLaunch("agy")
		if !ok {
			return nil, nil, nil, nil
		}
		if homeEnv := host.EngineHomeEnv(); len(homeEnv) > 0 {
			if env == nil {
				env = map[string]string{}
			}
			for k, v := range homeEnv {
				if _, exists := env[k]; !exists {
					env[k] = v
				}
			}
		}
		return env, args, nil, nil
	}
	return d
}

// DshDef 是 DeepSeek Harness 的“Orca 式”接入：官方 dsh 没有交互式 TUI，
// 社区的 @deepseek-harness-tui/dsh-tui 以 dsh profile 的形式提供终端界面。
//
//	launchCmd: dsh-tui .        （Orca tui-agent-config.ts）
//	resume:    dsh-tui --resume [id]
//	detect:    dsh-tui / dsh + profile
//
// 状态不靠这里：由 dsh.EnsureHooks 写入的官方 hook 桥提供。Prepare 只做两件
// 每格才有的事：给 hook 接收器一个格子身份，以及让 dsh-tui 找得到 dsh/node/pnpm。
func DshDef() Def {
	d := GenericDef("dsh-tui")
	d.Args = func(intent ResumeIntent, _ string) []string { return dshArgs(intent) }
	d.Prepare = func(tag string, _ int, _ string, _ []string) (map[string]string, []string, func(context.Context), error) {
		return map[string]string{
			// dsh 的 shell executor 会剥掉名字里含 KEY/TOKEN/SECRET/PASSWORD 的
			// 环境变量（Orca 在 dsh-hook.cmd 里实测过）。这个变量名必须继续
			// 不含这些词，否则 hook 会拿不到格子身份。
			"PERCH_AGENT_PANE": tag,
			// dsh-tui 的启动器用 `dsh --version` 探测官方 CLI；npm 的 shim 又要
			// 找 node。GUI 进程的 PATH 常常比终端短，这里按事实补齐。
			"PATH": dshChildPath(),
		}, nil, nil, nil
	}
	return d
}

func dshArgs(intent ResumeIntent) []string {
	switch intent.Kind {
	case "exact":
		if strings.TrimSpace(intent.ID) != "" {
			return []string{"--resume", intent.ID}
		}
	case "latest":
		return []string{"--resume"}
	}
	// fork 在 dsh-tui 里没有对应形态；按新会话开，别假装能复制。
	// "." 是 Orca 的 launchCmd 里的工作区目标；Tab 的 cwd 已经是工作区。
	return []string{"."}
}

func dshChildPath() string {
	var parts []string
	if appdata := strings.TrimSpace(os.Getenv("APPDATA")); appdata != "" {
		parts = append(parts, filepath.Join(appdata, "npm"))
	}
	if node, ok := winproc.FindExe("node"); ok {
		parts = append(parts, filepath.Dir(node))
	} else {
		for _, dir := range []string{
			filepath.Join(os.Getenv("ProgramFiles"), "nodejs"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "nodejs"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "node"),
		} {
			if fi, err := os.Stat(filepath.Join(dir, "node.exe")); err == nil && !fi.IsDir() {
				parts = append(parts, dir)
				break
			}
		}
	}
	if p := os.Getenv("PATH"); p != "" {
		parts = append(parts, p)
	}
	return strings.Join(parts, ";")
}
