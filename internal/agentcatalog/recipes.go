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
//   - NodeMin：这个包要求的最低 Node 版本；为空表示不检查。不能只看
//     npm.cmd 在不在 —— 旧 Node 也能跑 npm，但装完 CLI 起不来。
type Recipe struct {
	Source  string // 页面里显示给用户的来源（命令或包名）
	Script  string
	NPM     bool
	Pkg     string
	NodeMin string
}

// Recipes 只装 CLI：官方 CLI 安装脚本，或 npm 包的 bin。
// **桌面端安装器不许进这张表** —— 桌面端由用户自己下载。
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
		NPM:    true, Pkg: "@earendil-works/pi-coding-agent", NodeMin: "22.19.0",
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
	"copilot": {
		Source: `npm install -g @github/copilot`,
		NPM:    true, Pkg: "@github/copilot",
	},
	"qoder": {
		// 官方推荐的原生安装脚本；它装的是 qodercli 原生可执行文件，
		// 比 npm 版启动快，和名单的 qodercli 探测也对得上。
		Source: `irm https://qoder.com/install.ps1 | iex`,
		Script: `irm https://qoder.com/install.ps1 | iex`,
	},
}
