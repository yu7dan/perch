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
// **桌面端安装器不许进这张表** —— 桌面端由用户自己下载，只在 magpie 网关层配置。
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
	// 网关本体（不是 agent，但用户 2026-10-17 定的规则一样："下载"要真的下载）。
	// 2026-10-18 换成官方 feed：它同时给出各资产的 URL 与 SHA-256，而且
	// Windows 有 **terminal only** 的 magpie-cli-*.exe —— 我们只需要它跑
	// `magpie web`，不需要桌面壳。旧的那条 github latest/download 地址是猜的，
	// 官方 feed 指向的是 magpie-releases 仓库。
	"magpie": {
		Source: `https://usemagpie.ai/api/latest（官方 feed · SHA-256 校验）`,
		Script: MagpieInstallScript,
	},
}

// MagpieInstallScript：
//  1. 读官方 feed，按本机架构挑 magpie-cli-windows-*.exe；
//  2. 下载到 Perch 自己的目录，用 feed 给的 SHA-256 校验（不是只验 MZ 头）；
//  3. 落成 magpie.exe。**不执行它** —— 执行留给控制面（gwEnsure）按需拉起。
//
// 下载物一律当不可信数据：先落到 .new，校验通过才替换。
const MagpieInstallScript = `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$ProgressPreference='SilentlyContinue'
$feedUrl = 'https://usemagpie.ai/api/latest'
Write-Host ('== 读取 magpie 官方版本信息：' + $feedUrl + ' ==')
$feed = Invoke-RestMethod -Uri $feedUrl -UseBasicParsing -TimeoutSec 30
if (-not $feed.version) { throw '官方版本信息里没有 version' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$name = 'magpie-cli-windows-' + $arch + '.exe'
$prop = $feed.assets.PSObject.Properties[$name]
if ($null -eq $prop) { throw ('官方版本信息里没有 ' + $name) }
$asset = $prop.Value
if (-not $asset.url) { throw ($name + ' 没有下载地址') }
$want = ([string]$asset.sha256).ToLowerInvariant()
if ($want.Length -ne 64) { throw ('官方没有给出 ' + $name + ' 的 SHA-256，拒绝安装') }
$dir = Join-Path $env:LOCALAPPDATA 'Perch\magpie'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'magpie.exe'
$tmp = $exe + '.new'
Write-Host ('== 下载 magpie ' + $feed.version + '（' + $arch + '）：' + $asset.url + ' ==')
Invoke-WebRequest -Uri $asset.url -OutFile $tmp -UseBasicParsing -TimeoutSec 600
$fi = Get-Item $tmp
if ($fi.Length -lt 10MB) { throw ('下载文件过小（' + $fi.Length + ' 字节），可能被网络拦截') }
$got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
if ($got -ne $want) { Remove-Item -Force $tmp; throw ('SHA-256 不匹配：期望 ' + $want + '，实际 ' + $got) }
$fs = [IO.File]::OpenRead($tmp); $b = New-Object byte[] 2; [void]$fs.Read($b,0,2); $fs.Close()
if ($b[0] -ne 0x4D -or $b[1] -ne 0x5A) { throw '下载到的不是 Windows 可执行文件（缺少 MZ 头）' }
Move-Item -Force $tmp $exe
Write-Host ('已安装 magpie ' + $feed.version + ' 到 ' + $exe + '（' + [math]::Round($fi.Length/1MB) + ' MB，SHA-256 已核对）')
`
