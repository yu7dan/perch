// Package agentcatalog 是 agent 身份的唯一一份清单：使用层元数据、能力、
// 安装配方、启动表、本机探测。
//
// 加一个 agent 只改这里（需要深度适配器时再改 internal/agent）。
package agentcatalog

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/dsh"
	"github.com/yu7dan/perch/internal/winproc"
)

// Entry 是 Agent 名单上的一行静态事实。
type Entry struct {
	ID, Name, Icon, Vendor, URL, Note string
	Windows, Adapter                  bool
	Paths                             []string
	Bin                               string
	// Launch：Perch 能不能在终端里启动它。必须显式 —— 以前是
	// "有 Bin 但某个 agent 例外" 这种藏在 init() 里的隐式规则。
	Launch bool
}

// Card 是发给前端的那一行：静态元数据 + 本机探测 + 能力矩阵。
type Card struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Icon      string     `json:"icon"`
	Vendor    string     `json:"vendor"`
	URL       string     `json:"url"`
	Path      string     `json:"path,omitempty"`
	Installed bool       `json:"installed"`
	Adapter   bool       `json:"adapter"` // 有结构化状态/续接（兼容旧字段；新代码读 caps）
	Caps      agent.Caps `json:"caps"`    // 启动/忙闲/等用户/动作，到哪一层
	Install   bool       `json:"install"` // 有 Perch 能代跑的官方安装配方
	// Setup：能启动、但“状态/等待”这条腿还没接上，而 Perch 知道怎么补。
	// 目前只有 dsh（官方 hook 桥 + dsh-tui profile）。前端据此给一行
	// 「接入状态」，避免把“只能启动”永久留在名单里。
	Setup   bool   `json:"setup,omitempty"`
	Windows bool   `json:"windows"` // 这个 agent 在 Windows 上有原生支持
	Note    string `json:"note,omitempty"`
	Calls   int    `json:"calls"`
}

// entries 是用户 2026-10-23 定的产品名单：Claude Code、Codex、Pi、OpenCode、
// Antigravity、DeepSeek Harness、Cursor、Copilot CLI、Qoder。名单外的 agent
// 不再安装、探测或出现在 UI 里；加回时要同时补 recipes 和图标。
//
// 这份清单是**使用层**：只收能在终端里跑的 CLI agent，不收桌面应用。
// 桌面客户端属于 magpie 的**网关层**，可以出现在 /api/state 里，但不从这里
// 安装、启动或展示。
//
// 探测规则抄 magpie 的 reference.md：**看配置文件**，不看 PATH —— Windows 上
// 装完不重开、PATH 没刷新的情况太常见了。
var entries = []Entry{
	{"claude", "Claude Code", "claudecode-color", "Anthropic", "https://code.claude.com/docs/en/setup", "", true, true,
		[]string{"~/.claude/settings.json", "~/.local/claude.exe"}, "claude", true},
	{"codex", "Codex", "codex-color", "OpenAI", "https://chatgpt.com/codex", "", true, false,
		[]string{"~/.codex/config.toml"}, "codex", true},
	{"pi", "Pi", "pi", "Earendil Works", "https://github.com/earendil-works/pi", "", true, false,
		[]string{"~/.pi/agent/settings.json", "~/.pi/agent/models.json"}, "pi", true},
	{"opencode", "OpenCode", "opencode", "OpenCode", "https://opencode.ai", "", true, false,
		[]string{"~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc",
			"~/.local/share/opencode/auth.json"}, "opencode", true},
	{"agy", "Antigravity CLI", "antigravity-color", "Google", "https://antigravity.google/docs/cli/install", "", true, false,
		[]string{"~/.gemini/antigravity-cli/settings.json"}, "agy", true},
	// DeepSeek Harness 是“非官方 TUI”那一类，照 Orca 的处理：
	// 官方的 @deepseek-ai/dsh 没有交互式 TUI profile；社区维护的
	// @deepseek-harness-tui/dsh-tui 以 dsh profile 的形式提供终端界面
	// （dsh-tui / dst 启动器 → dsh --profile dsh-tui）。状态由官方
	// @deepseek-ai/dsh-hooks-claude-code 桥提供，所以这里 Launch/Bin 用
	// dsh-tui，而不是裸 dsh（裸 dsh 会要求 --profile，正是之前的启动错误）。
	//
	// 注意：npm 上另一个同名社区包 dsh-tui@0.2.x 是“需要已运行的 dsh web
	// host + API cookie”的另一个实现，不是 Orca fixture 用的那一个
	// （dsh-tui 0.10.2 on @deepseek-ai/dsh 0.1.5-rc.1）。安装配方只装
	// @deepseek-harness-tui/dsh-tui。
	{"dsh", "DeepSeek Harness", "deepseek-color", "DeepSeek", "https://github.com/deepseek-ai/deepseek-harness", "终端界面 dsh-TUI（社区）；安装会一并接入状态钩子", true, false,
		[]string{"~/.dsh/profiles/dsh-tui/package.json", "~/.dsh/config.yaml", "~/.dsh/cordis.patch.yml"}, "dsh-tui", true},
	{"cursor", "Cursor", "cursor", "Anysphere", "https://cursor.com/cli", "", true, false,
		[]string{"~/.cursor/cli-config.json"}, "cursor-agent", true},
	{"copilot", "Copilot CLI", "githubcopilot", "GitHub", "https://github.com/github/copilot-cli", "", true, false,
		[]string{"~/.copilot/settings.json"}, "copilot", true},
	// Qoder 的官方安装脚本放的是原生 qodercli；CLI 首次运行要登录 Qoder，
	// 自定义供应商（包括 Perch 网关）只对 BYOK 计划开放。
	{"qoder", "Qoder", "qoder", "Qoder", "https://docs.qoder.com/cli/installation", "首次运行需登录 Qoder；BYOK 计划可用自定义供应商", true, false,
		[]string{"~/.qoder/settings.json"}, "qodercli", true},
}

// Entries 返回清单的副本，调用方不能改到包内那份。
func Entries() []Entry {
	out := make([]Entry, len(entries))
	copy(out, entries)
	return out
}

// Exists 只问"清单里有没有这个 id"，不管能不能启动。
func Exists(id string) bool {
	for _, e := range entries {
		if e.ID == id {
			return true
		}
	}
	return false
}

// LaunchIDs 是静态的可启动集合。settings 校验用它，**不调用 Defs()** ——
// 否则加载设置就会触发 Host/Exe 探测。
func LaunchIDs() map[string]bool {
	out := make(map[string]bool, len(entries))
	for _, e := range entries {
		if e.Launch {
			out[e.ID] = true
		}
	}
	return out
}

// Has 问"这个 id 能不能作为启动目标"。
func Has(id string) bool {
	if id == "" {
		return false
	}
	for _, e := range entries {
		if e.ID == id {
			return e.Launch
		}
	}
	return false
}

// ByID 找一条静态元数据。
func ByID(id string) *Entry {
	for i := range entries {
		if entries[i].ID == id {
			e := entries[i]
			return &e
		}
	}
	return nil
}

// ClaudeExe 是 Claude Code 的特殊解析顺序：CLAUDE_EXE → ~/.local/claude.exe → PATH。
// 不写死任何人的绝对路径。
func ClaudeExe() string {
	if v := strings.TrimSpace(os.Getenv("CLAUDE_EXE")); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".local", "claude.exe")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return "claude"
}

// Defs 构造启动表。
//
// ⚠️ 必须在 agent.SetHost 之后调用：Def 构造会走 Host.ResolveExe。
// 不能做成包级变量，也不能在 init() 里调用。
func Defs(stateDir string) map[string]agent.Def {
	defs := map[string]agent.Def{
		"claude": agent.ClaudeDef(stateDir, ClaudeExe()),
	}
	for _, e := range entries {
		if e.ID == "claude" || !e.Launch || e.Bin == "" {
			continue
		}
		// 通用 CLI 在「已接入引擎网关」时也要读引擎沙盒；没接入时
		// EngineDef 返回 nil，行为与 GenericDef 完全一样。
		defs[e.ID] = agent.EngineDef(e.ID, e.Bin)
	}
	// 深度适配器覆盖通用那条。
	defs["opencode"] = agent.OpenCodeDef()
	defs["pi"] = agent.PiDef()
	defs["codex"] = agent.CodexDef()
	// agy 只有「启动」是深度适配：网关地址/密钥必须按 magpie 的 launch
	// 命令在每次开格时注入（见 internal/agent/def.go 的 AgyDef）。
	defs["agy"] = agent.AgyDef()
	// 三个 launch 级 agent 的续接/状态：cursor 只跟转录，copilot 跟 events，
	// qoder 走每格 --settings 注入的 Claude 形状 hooks。
	defs["cursor"] = agent.CursorDef()
	defs["copilot"] = agent.CopilotDef()
	defs["qoder"] = agent.QoderDef()
	// dsh 的终端界面是 dsh-tui profile，不是裸 dsh；启动/续接/状态身份都
	// 在这一层（见 internal/agent/def.go 的 DshDef）。
	defs["dsh"] = agent.DshDef()
	return defs
}

// Cards 探测本机，拼出发给前端的名单。
func Cards(home string) []Card {
	out := make([]Card, 0, len(entries))
	for _, d := range entries {
		// Launch 是「这台机器上现在能不能开格」，不是「产品理论上支不支持」：
		// 只装了配置、没装可执行文件（或 dsh 这种 TUI profile 还没装好的）不能
		// 在名单上写「可启动」，否则用户点开会得到一个必然失败的格子。
		canLaunch := d.Launch
		if canLaunch && d.Bin != "" {
			if _, ok := winproc.FindExe(d.Bin); !ok {
				canLaunch = false
			}
		}
		// dsh 的启动器是 dsh-tui，但它还会先探测官方 dsh，并依赖已经初始化
		// 的 dsh-tui profile。少任何一条都不是“可启动”。
		if canLaunch && d.ID == "dsh" {
			if _, ok := winproc.FindExe("dsh"); !ok {
				canLaunch = false
			}
			if !dsh.ProfileReady() {
				canLaunch = false
			}
		}
		caps := agent.CapsFor(d.ID, canLaunch)
		// 状态钩子还没接上时，把 Status/Waiting 如实降为 false，并给前端一个
		// “Perch 知道怎么补”的入口。不能拿静态能力表骗用户。
		setup := false
		if d.ID == "dsh" && canLaunch && !dsh.HooksReady() {
			caps.Status = false
			caps.Waiting = false
			setup = true
		}
		_, canInstall := Recipes[d.ID]
		c := Card{
			ID: d.ID, Name: d.Name, Icon: d.Icon, Vendor: d.Vendor, URL: d.URL,
			// ⚠️ Adapter 不能从"能不能启动"推：通用启动会给所有有 Bin 的
			// agent 注册一条"只开新会话"，那会把"能启动"写成"已接入"。
			// 结构化能力只认 agent.CapsFor。
			Adapter: caps.Status || caps.Resume || caps.Actions,
			Caps:    caps, Install: canInstall, Setup: setup,
			Windows: d.Windows, Note: d.Note,
		}
		for _, raw := range d.Paths {
			p := expandHome(home, raw)
			if _, err := os.Stat(p); err == nil {
				c.Installed = true
				c.Path = prettyHome(home, p)
				break
			}
		}
		// dsh 的 home 可以由 DSH_HOME 改到别处；静态 Paths 只是默认值。
		// 探测必须和 ProfileReady()/EnsureHooks 用同一个 Home()。
		if d.ID == "dsh" {
			for _, p := range []string{
				dsh.ProfilePackagePath(),
				dsh.HomePatchPath(),
				filepath.Join(dsh.Home(), "config.yaml"),
			} {
				if _, err := os.Stat(p); err == nil {
					c.Installed = true
					c.Path = prettyHome(home, p)
					break
				}
			}
		}
		// 配置目录不在时，用**和启动同一份**候选表再找一次 exe：GUI 进程的
		// PATH 常常比终端里短，而且 Codex 的官方安装器根本不写 PATH。
		if !c.Installed && d.Bin != "" {
			if p, ok := winproc.FindExe(d.Bin); ok {
				c.Installed = true
				c.Path = p
			}
		}
		out = append(out, c)
	}
	return out
}

func expandHome(home, p string) string {
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(home, p[2:])
	}
	return p
}

func prettyHome(home, p string) string {
	if home != "" && strings.HasPrefix(strings.ToLower(p), strings.ToLower(home)) {
		return "~" + p[len(home):]
	}
	return p
}
