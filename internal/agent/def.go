package agent

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// EngineDef 给 magpie 的通用 agent 用：已接入引擎网关时，启动进程也换到
// 引擎沙盒，这样它读到的是 /api/set 写进去的模型/供应商；没接入时照旧读
// 用户自己的配置。agy/dsh 有自己的深度适配，不经过这里。
func EngineDef(id, bin string) Def {
	d := GenericDef(bin)
	d.Prepare = func(string, int, string, []string) (map[string]string, []string, func(context.Context), error) {
		// npm 全局装出来的 CLI 是 .cmd shim，shim 里还要找 node；GUI 的
		// PATH 往往比终端短。PATH 始终补上，沙盒 home 只在已接入时加。
		env := map[string]string{"PATH": dshChildPath()}
		for k, v := range host.EngineHomeEnvFor(id) {
			env[k] = v
		}
		return env, nil, nil, nil
	}
	return d
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
	// agy 的续接参数（实测 --help）：--continue / --conversation <id>。
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			return []string{"--continue"}
		case "exact":
			if strings.TrimSpace(r.ID) != "" {
				return []string{"--conversation", r.ID}
			}
		}
		return nil
	}
	d.Prepare = func(_ string, tabID int, cwd string, _ []string) (map[string]string, []string, func(context.Context), error) {
		started := time.Now()
		env, args, ok := host.WireLaunch("agy")
		// 沙盒 home 不依赖 WireLaunch 成不成功：冷恢复的 agy 可能在引擎
		// /api/state 到达之前就起来，那一刻拿不到 launch；如果这时退回
		// 真实 home，agy 会读写桌面 settings（实测会改掉真实文件）。
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
		observe := func(ctx context.Context) {
			observeTranscriptStatus(ctx, tabID, "agy", cwd, "", started, emitAgentStatus)
		}
		if !ok {
			return env, nil, observe, nil
		}
		return env, args, observe, nil
	}
	return d
}

// CursorDef 是 cursor-agent 的适配：续接用 --continue / --resume [chatId]。
//
// 状态没有 hook：Cursor 的 hooks.json 是全局配置，Perch 不替用户装。这里跟
// 它自己的 agent-transcripts 走 —— 最后一条 user 之后还没 assistant = 在跑，
// assistant 到了 = 本轮结束。这是转录级证据（evidence=transcript），不是假装
// 拿到了 hook。等待批准/提问在转录里没有，Caps.Waiting 因此为 false。
func CursorDef() Def {
	d := GenericDef("cursor-agent")
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			return []string{"--continue"}
		case "exact":
			if strings.TrimSpace(r.ID) != "" {
				return []string{"--resume", r.ID}
			}
		}
		return nil
	}
	d.Prepare = func(_ string, tabID int, cwd string, _ []string) (map[string]string, []string, func(context.Context), error) {
		started := time.Now()
		observe := func(ctx context.Context) {
			observeTranscriptStatus(ctx, tabID, "cursor", cwd, "", started, emitAgentStatus)
		}
		return launchEnvFor("cursor", cursorBinDir()), nil, observe, nil
	}
	return d
}

// CopilotDef 是 Copilot CLI 的适配。1.0.103 的 --help 实测有
// --resume [id] / --continue / --session-id —— 之前“Copilot 不能续接”的
// 结论已经被版本推翻，能力表按现在这份 help 说真话。
//
// 状态来自 events.jsonl 的 turn_start/turn_end；等待批准如果能从事件里
// 认出来，observeTranscriptStatus 会发等待，否则只报忙/闲。
func CopilotDef() Def {
	d := GenericDef("copilot")
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			return []string{"--continue"}
		case "exact":
			if strings.TrimSpace(r.ID) != "" {
				return []string{"--resume", r.ID}
			}
		}
		return nil
	}
	d.Prepare = func(_ string, tabID int, cwd string, _ []string) (map[string]string, []string, func(context.Context), error) {
		started := time.Now()
		observe := func(ctx context.Context) {
			observeTranscriptStatus(ctx, tabID, "copilot", cwd, "", started, emitAgentStatus)
		}
		return launchEnvFor("copilot", ""), nil, observe, nil
	}
	return d
}

// QoderDef 是 Qoder CLI（Claude 形状）的适配。
//
// 续接：--continue / --resume [id]；fork 有 --fork-session。
// 状态：Qoder 支持 Claude 形状的 hooks（官方文档 + Orca 的 qoder hook service
// 都是这套）。hooks 通过 --settings 注入**这一格**的配置，不写用户的
// ~/.qoder/settings.json；SessionStart 里的 transcript_path 同时把流水路径
// 钉下来。注入失败时退回转录状态（忙/闲，等待能力如实降级）。
func QoderDef() Def {
	d := GenericDef("qodercli")
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			return []string{"--continue"}
		case "exact":
			if strings.TrimSpace(r.ID) != "" {
				return []string{"--resume", r.ID}
			}
		case "fork":
			if strings.TrimSpace(r.ID) != "" {
				return []string{"--resume", r.ID, "--fork-session"}
			}
		}
		return nil
	}
	d.Prepare = func(tag string, tabID int, cwd string, _ []string) (map[string]string, []string, func(context.Context), error) {
		started := time.Now()
		env := launchEnvFor("qoder", "")
		settings := host.HookSettings(tag)
		if settings != "" {
			if p := writeAgentSettings("qoder", tag, settings); p != "" {
				return env, []string{"--settings", p}, nil, nil
			}
		}
		observe := func(ctx context.Context) {
			observeTranscriptStatus(ctx, tabID, "qoder", cwd, "", started, emitAgentStatus)
		}
		log.Printf("[qoder %s] hooks 注入失败，退回转录状态（无等待）", tag)
		return env, nil, observe, nil
	}
	return d
}

// launchEnvFor 给“由 Perch 直接起、但配置由引擎管理”的 agent 拼环境。
// 沙盒 home 只在已接入引擎时加；PATH 始终补 —— GUI 进程的 PATH 比终端短。
func launchEnvFor(id, extraPath string) map[string]string {
	env := map[string]string{"PATH": childPathWith(extraPath)}
	for k, v := range host.EngineHomeEnvFor(id) {
		env[k] = v
	}
	return env
}

func cursorBinDir() string {
	if v := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); v != "" {
		return filepath.Join(v, "cursor-agent")
	}
	return ""
}

// childPathWith 在 dshChildPath 的基础上再加一个目录。
func childPathWith(dir string) string {
	p := dshChildPath()
	if strings.TrimSpace(dir) == "" {
		return p
	}
	if p == "" {
		return dir
	}
	return dir + ";" + p
}

func writeAgentSettings(agentID, tag, body string) string {
	dir := filepath.Join(os.TempDir(), "perch-agent-settings")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	p := filepath.Join(dir, agentID+"-"+tag+".json")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		return ""
	}
	return p
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
		env := map[string]string{
			// dsh 的 shell executor 会剥掉名字里含 KEY/TOKEN/SECRET/PASSWORD 的
			// 环境变量（Orca 在 dsh-hook.cmd 里实测过）。这个变量名必须继续
			// 不含这些词，否则 hook 会拿不到格子身份。
			"PERCH_AGENT_PANE": tag,
			// dsh-tui 的启动器用 `dsh --version` 探测官方 CLI；npm 的 shim 又要
			// 找 node。GUI 进程的 PATH 常常比终端短，这里按事实补齐。
			"PATH": dshChildPath(),
		}
		// 隔离引擎把 magpie 的 dsh 字段写进 Perch 的 DSH_HOME；Perch 直接
		// 启动 dsh-tui 时也必须读同一个 home，否则「已接入」只写不进运行。
		for k, v := range host.EngineHomeEnv() {
			if _, exists := env[k]; !exists {
				env[k] = v
			}
		}
		return env, nil, nil, nil
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
