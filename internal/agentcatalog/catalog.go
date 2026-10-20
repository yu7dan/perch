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
	"github.com/yu7dan/perch/internal/winproc"
)

// Entry 是 Agent 名单上的一行静态事实。
type Entry struct {
	ID, Name, Icon, Vendor, URL, Note string
	Windows, Adapter                  bool
	Paths                             []string
	Bin                               string
	// Launch：Perch 能不能在终端里启动它。必须显式 —— 以前是
	// "有 Bin 且不是 zcode" 这种藏在 init() 里的隐式例外。
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
	Windows   bool       `json:"windows"` // 这个 agent 在 Windows 上有原生支持
	Note      string     `json:"note,omitempty"`
	Calls     int        `json:"calls"`
}

// entries 是用户 2026-10-17 点名的那份清单（外加几枚同类里最该有的）。
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
	{"dsh", "DeepSeek Harness", "deepseek-color", "DeepSeek", "https://www.npmjs.com/package/@deepseek-ai/dsh", "", true, false,
		[]string{"~/.dsh/config.yaml", "~/.dsh/settings.yaml", "~/.dsh/profiles"}, "dsh", true},
	{"cursor", "Cursor", "cursor", "Anysphere", "https://cursor.com/cli", "", true, false,
		[]string{"~/.cursor/cli-config.json"}, "cursor-agent", true},
	{"codebuddy", "CodeBuddy Code", "codebuddy-color", "Tencent", "https://www.codebuddy.ai/docs/cli/installation", "", true, false,
		[]string{"~/.codebuddy/models.json", "~/.codebuddy/settings.json"}, "codebuddy", true},
	{"kimi", "Kimi Code", "kimi", "Moonshot", "https://github.com/MoonshotAI/kimi-code", "", true, false,
		[]string{"~/.kimi/config.toml", "~/.kimi-code/config.toml"}, "kimi", true},
	{"muse", "Muse Code", "meta-color", "Meta", "https://dev.meta.ai/docs/muse-code", "原生 Windows（2026-09 起）", true, false,
		[]string{"~/.config/muse/settings.json", "~/.muse", "~/AppData/Local/Programs/muse"}, "muse", true},
	{"zcode", "ZCode", "zcode", "Zhipu", "https://zcode.z.ai", "", true, false,
		[]string{"~/.zcode/v2/config.json", "~/.zcode/v2/provider_config.json"}, "zcode", false},
	// 追加的同类：magpie 都有图标与配置格式，接进来不增加猜测。
	{"gemini", "Gemini CLI", "geminicli-color", "Google", "https://github.com/google-gemini/gemini-cli", "", true, false,
		[]string{"~/.gemini/settings.json"}, "gemini", true},
	{"copilot", "Copilot CLI", "githubcopilot", "GitHub", "https://github.com/github/copilot-cli", "", true, false,
		[]string{"~/.copilot/settings.json"}, "copilot", true},
	{"qwen", "Qwen Code", "qwen-color", "Alibaba", "https://github.com/QwenLM/qwen-code", "", true, false,
		[]string{"~/.qwen/settings.json"}, "qwen", true},
	{"crush", "Crush", "crush", "Charm", "https://github.com/charmbracelet/crush", "", true, false,
		[]string{"~/.config/crush/crush.json"}, "crush", true},
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
		defs[e.ID] = agent.GenericDef(e.Bin)
	}
	// 深度适配器覆盖通用那条。
	defs["opencode"] = agent.OpenCodeDef()
	defs["pi"] = agent.PiDef()
	defs["codex"] = agent.CodexDef()
	// agy 只有「启动」是深度适配：网关地址/密钥必须按 magpie 的 launch
	// 命令在每次开格时注入（见 internal/agent/def.go 的 AgyDef）。
	defs["agy"] = agent.AgyDef()
	return defs
}

// Cards 探测本机，拼出发给前端的名单。
func Cards(home string) []Card {
	out := make([]Card, 0, len(entries))
	for _, d := range entries {
		caps := agent.CapsFor(d.ID, d.Launch)
		_, canInstall := Recipes[d.ID]
		c := Card{
			ID: d.ID, Name: d.Name, Icon: d.Icon, Vendor: d.Vendor, URL: d.URL,
			// ⚠️ Adapter 不能从"能不能启动"推：通用启动会给所有有 Bin 的
			// agent 注册一条"只开新会话"，那会把"能启动"写成"已接入"。
			// 结构化能力只认 agent.CapsFor。
			Adapter: caps.Status || caps.Resume || caps.Actions,
			Caps:    caps, Install: canInstall, Windows: d.Windows, Note: d.Note,
		}
		for _, raw := range d.Paths {
			p := expandHome(home, raw)
			if _, err := os.Stat(p); err == nil {
				c.Installed = true
				c.Path = prettyHome(home, p)
				break
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
