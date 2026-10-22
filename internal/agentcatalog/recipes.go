package agentcatalog

// Agent 安装配方：Perch 在用户**明确点下「安装」之后**替用户跑的那条官方命令。
//
// 配方放在 agentcatalog 而不是 install：Cards() 要回答"有没有自动安装"，
// 而 install 又要读 Defs/清单；放 install 会形成循环。
//
// 三条边界（与 install 的执行层一致）：
//  1. 只跑这里写死的官方命令，绝不执行远端返回的任意脚本；
//  2. 每个动作都由用户点一次触发，不静默、不后台安装；
//  3. 输出里不打印任何凭据（安装脚本本身也不接受凭据）。

// Recipe 是一个 agent 的 Windows 安装配方。
//   - Script：直接交给 PowerShell 的脚本（官方 irm ... | iex）
//   - NPM：先确保 Node.js，再 npm i -g Pkg
//   - NeedsGit：Kimi Code 的官方要求（Git for Windows）
type Recipe struct {
	Source   string // 页面里显示给用户的来源（命令或包名）
	Script   string
	NPM      bool
	Pkg      string
	NeedsGit bool
}

// Recipes 只装 CLI：官方 CLI 安装脚本，或 npm 包的 bin。
// **桌面端安装器不许进这张表** —— 桌面端由用户自己下载，只在网关层配置。
var Recipes = map[string]Recipe{
	"claude": {
		Source: `irm https://claude.ai/install.ps1 | iex`,
		Script: `irm https://claude.ai/install.ps1 | iex`,
	},
	"codex": {
		Source: `irm https://chatgpt.com/codex/install.ps1 | iex`,
		Script: `irm https://chatgpt.com/codex/install.ps1 | iex`,
	},
	"pi": {
		Source: `npm install -g @earendil-works/pi-coding-agent`,
		NPM:    true, Pkg: "@earendil-works/pi-coding-agent",
	},
	"opencode": {
		Source: `npm install -g opencode-ai`,
		NPM:    true, Pkg: "opencode-ai",
	},
	"agy": {
		Source: `irm https://antigravity.google/cli/install.ps1 | iex`,
		Script: `irm https://antigravity.google/cli/install.ps1 | iex`,
	},
	"dsh": {
		// 官方 dsh + 社区终端界面。两个包一起装：dsh-tui 的 peer 依赖需要和
		// 同一个 dsh 版本对齐。**不要**换成 npm 上的 dsh-tui@0.2.x —— 那是
		// 另一个实现（要求已运行的 dsh web host + API cookie），不是 Orca
		// 用的 @deepseek-harness-tui/dsh-tui。
		Source: `npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui pnpm@11`,
		NPM:    true,
		Script: `npm.cmd install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui pnpm@11
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + (Join-Path $env:APPDATA 'npm')
$dshTui = Join-Path $env:APPDATA 'npm\dsh-tui.cmd'
if (-not (Test-Path $dshTui)) { throw 'dsh-tui.cmd 没有出现：npm 安装可能没有完成' }
& $dshTui update
`,
	},
	"cursor": {
		Source: `irm 'https://cursor.com/install?win32=true' | iex`,
		Script: `irm 'https://cursor.com/install?win32=true' | iex`,
	},
	"codebuddy": {
		Source: `npm install -g @tencent-ai/codebuddy-code`,
		NPM:    true, Pkg: "@tencent-ai/codebuddy-code",
	},
	"kimi": {
		Source:   `irm https://code.kimi.com/kimi-code/install.ps1 | iex`,
		Script:   `irm https://code.kimi.com/kimi-code/install.ps1 | iex`,
		NeedsGit: true,
	},
	"muse": {
		// 2026-09 起官方提供原生 Windows 安装脚本：%LOCALAPPDATA%\Programs\muse\muse.cmd
		Source: `irm https://dev.meta.ai/install.ps1 | iex`,
		Script: `irm https://dev.meta.ai/install.ps1 | iex`,
	},
	"gemini": {
		Source: `npm install -g @google/gemini-cli`,
		NPM:    true, Pkg: "@google/gemini-cli",
	},
	"copilot": {
		Source: `npm install -g @github/copilot`,
		NPM:    true, Pkg: "@github/copilot",
	},
	"qwen": {
		Source: `npm install -g @qwen-code/qwen-code`,
		NPM:    true, Pkg: "@qwen-code/qwen-code",
	},
	"crush": {
		Source: `npm install -g @charmland/crush`,
		NPM:    true, Pkg: "@charmland/crush",
	},
}
