package main

// Agent 安装器。
//
// 用户 2026-10-17 的评审：点「下载」跳浏览器不算安装 —— 要真的下载、真的装，
// 装完能直接在 Perch 里开一格。magpie 自己只把命令显示给用户复制；我们在
// **用户明确点下「安装」之后**替他把同一条官方命令跑完，并把输出原样摊在
// 页面里（不藏进度、不假装成功）。
//
// 三条边界：
//   1. 只跑这里写死的官方命令，绝不执行远端返回的任意脚本；
//   2. 每个动作都由用户点一次触发，不静默、不后台安装；
//   3. 输出里不打印任何凭据（安装脚本本身也不接受凭据）。

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// installRecipe 是一个 agent 的 Windows 安装配方。
//   - Script：直接交给 PowerShell 的脚本（官方 irm ... | iex）
//   - NPM：先确保 Node.js，再 npm i -g Pkg
//   - NeedsGit：Kimi Code 的官方要求（Git for Windows）
type installRecipe struct {
	Source   string // 页面里显示给用户的来源（命令或包名）
	Script   string
	NPM      bool
	Pkg      string
	NeedsGit bool
}

var installRecipes = map[string]installRecipe{
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
		Source: `npm install -g @deepseek-ai/dsh`,
		NPM:    true, Pkg: "@deepseek-ai/dsh",
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
		Script: magpieInstallScript,
	},
}

// magpieInstallScript：
//   1) 读官方 feed，按本机架构挑 magpie-cli-windows-*.exe；
//   2) 下载到 Perch 自己的目录，用 feed 给的 SHA-256 校验（不是只验 MZ 头）；
//   3) 落成 magpie.exe。**不执行它** —— 执行留给控制面（gwEnsure）按需拉起。
// 下载物一律当不可信数据：先落到 .new，校验通过才替换。
const magpieInstallScript = `$ErrorActionPreference='Stop'
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

const installPathPrelude = `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$ProgressPreference='SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
`

// recipeScript 把配方拼成一段 PowerShell。npm 那条先确保 Node.js ——
// 和 magpie 的做法一致（winget 装 LTS，然后从注册表重新读 PATH）。
func recipeScript(r installRecipe) string {
	var b strings.Builder
	b.WriteString(installPathPrelude)
	if r.NeedsGit {
		b.WriteString(`if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { ` +
			`Write-Host '== 需要 Git for Windows（官方安装要求）=='; ` +
			`throw '没有找到 git.exe：请先安装 Git for Windows，再点一次安装' }` + "\n")
	}
	if r.NPM {
		b.WriteString(`if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {` + "\n")
		b.WriteString(`  Write-Host '== 没有找到 Node.js，先安装 Node.js LTS（winget）=='` + "\n")
		b.WriteString(`  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --disable-interactivity` + "\n")
		b.WriteString(`  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')` + "\n")
		b.WriteString(`}` + "\n")
		b.WriteString(`if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 安装后仍然找不到 npm.cmd' }` + "\n")
		b.WriteString(`npm.cmd install -g ` + r.Pkg + "\n")
	} else {
		b.WriteString(r.Script + "\n")
	}
	b.WriteString(`Write-Host '== 完成 =='` + "\n")
	return b.String()
}

type installRun struct {
	cancel context.CancelFunc
	pid    int
}

var (
	installMu   sync.Mutex
	installRuns = map[string]*installRun{}
)

func installLog(id, line string) {
	pushJSON(map[string]any{"type": "install.log", "id": id, "line": line})
}

// startAgentInstall 在后台跑一条配方。同一个 agent 同时只允许一条。
func startAgentInstall(id string) {
	r, ok := installRecipes[id]
	if !ok || (r.Script == "" && !r.NPM) {
		installLog(id, "这个 agent 没有可用的自动安装配方（桌面应用请在官网安装）。")
		pushJSON(map[string]any{"type": "install.done", "id": id, "ok": false, "err": "no recipe"})
		return
	}
	installMu.Lock()
	if _, busy := installRuns[id]; busy {
		installMu.Unlock()
		installLog(id, "已经在安装了。")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	run := &installRun{cancel: cancel}
	installRuns[id] = run
	installMu.Unlock()

	home, _ := os.UserHomeDir()
	script := recipeScript(r)
	pushJSON(map[string]any{
		"type": "install.start", "id": id, "source": r.Source,
	})
	installLog(id, "$ "+r.Source)

	cmd := exec.CommandContext(ctx, "powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Dir = home
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		finishInstall(id, false, 1, err.Error(), cancelled(ctx))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		finishInstall(id, false, 1, err.Error(), cancelled(ctx))
		return
	}
	if err := cmd.Start(); err != nil {
		finishInstall(id, false, 1, err.Error(), false)
		return
	}
	installMu.Lock()
	run.pid = cmd.Process.Pid
	installMu.Unlock()

	var wg sync.WaitGroup
	scan := func(rc interface{ Read([]byte) (int, error) }) {
		defer wg.Done()
		br := bufio.NewReaderSize(rc, 64*1024)
		for {
			line, err := br.ReadString('\n')
			if line != "" {
				line = strings.TrimRight(line, "\r\n")
				if len(line) > 4000 {
					line = line[:4000] + " …"
				}
				installLog(id, line)
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go scan(stdout)
	go scan(stderr)
	wg.Wait()
	werr := cmd.Wait()
	code := 0
	if werr != nil {
		if ee, ok := werr.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	if ctx.Err() == context.DeadlineExceeded {
		werr = fmt.Errorf("安装超时（20 分钟）")
	}
	finishInstall(id, werr == nil, code, errText(werr), cancelled(ctx))
}

func cancelled(ctx context.Context) bool {
	return ctx.Err() == context.Canceled
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// finishInstall 收尾：重读 PATH（安装脚本改的是注册表里的用户 PATH，而本进程
// 的环境变量是启动时快照）、重扫 Agent 名单、跑一次 --version 作为证据。
func finishInstall(id string, ok bool, code int, msg string, wasCancelled bool) {
	installMu.Lock()
	delete(installRuns, id)
	installMu.Unlock()

	if ok {
		if id == "magpie" {
			// 装完就**自动接入**控制面（用户 2026-10-17 定的：不再有「连接 magpie」
			// 这个手动动作）。gwConnect 会自己找到刚装好的那个 exe。
			pushJSON(map[string]any{"type": "install.done", "id": id, "ok": true, "code": code})
			go gwConnect()
			return
		}
		reloadPathFromRegistry()
		home, _ := os.UserHomeDir()
		cat := scanAgentCatalog(home)
		mergeCatalogCalls(cat)
		if d := agentCatalogDefsByID(id); d != nil && d.Bin != "" {
			if line := probeAgentVersion(d.Bin); line != "" {
				installLog(id, "版本："+line)
			}
		}
		pushJSON(map[string]any{"type": "install.done", "id": id, "ok": true, "code": code})
		pushJSON(map[string]any{"type": "catalog", "catalog": cat})
	} else {
		if wasCancelled {
			msg = "已取消"
		}
		if msg == "" {
			msg = fmt.Sprintf("退出码 %d", code)
		}
		installLog(id, "失败："+msg)
		pushJSON(map[string]any{"type": "install.done", "id": id, "ok": false, "code": code, "err": msg})
	}
}

// cancelAgentInstall 先按进程树杀（npm / winget 会再起子进程），再取消 context。
func cancelAgentInstall(id string) {
	installMu.Lock()
	run := installRuns[id]
	installMu.Unlock()
	if run == nil {
		return
	}
	if run.pid > 0 {
		_ = exec.Command("taskkill", "/PID", fmt.Sprint(run.pid), "/T", "/F").Run()
	}
	run.cancel()
}

// reloadPathFromRegistry 把机器级 + 用户级的 PATH 重新读进本进程。
// 安装脚本（以及 winget）写的是注册表；os.Getenv 在进程启动后就冻住了。
func reloadPathFromRegistry() {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command",
		`[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil {
		return
	}
	p := strings.TrimSpace(strings.TrimRight(string(out), "\r\n"))
	if p != "" {
		_ = os.Setenv("PATH", p)
	}
}

// probeAgentVersion 跑一次 --version，给安装结果留一条可核对的证据。
// 有些 CLI 没有这个参数、或者会起 TUI —— 6 秒拿不到就放弃，不拖住收尾。
func probeAgentVersion(bin string) string {
	exe, prefix := resolveAgentExe(bin)
	if exe == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	args := append(append([]string{}, prefix...), "--version")
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

// agentExeHints：有些 agent 的官方安装器**不写 PATH**，但落点是固定的。
// Codex 就是这一类：install.ps1 把 exe 放在
//
//	%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//
// 那是一枚指向 ~\.codex\packages\standalone\current\bin 的 junction；
// GUI 进程的 PATH 通常比终端里短，所以 exec.LookPath 找不到它。
// 以后有同类落点的 agent，也加在这里，别把候选表抄成第二份。
func agentExeHints(bin, home, local string) []string {
	switch strings.ToLower(strings.TrimSpace(bin)) {
	case "codex":
		out := []string{
			filepath.Join(home, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
		}
		if local != "" {
			out = append([]string{
				filepath.Join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
			}, out...)
		}
		return out
	}
	return nil
}

// findAgentExe 找 agent 的可执行文件，返回**真实路径**；找不到返回 ok=false。
// 「名单上探到没探到」和「启动时用哪个 exe」必须走同一份候选表 ——
// 否则会出现名单显示已安装、点开却报 "The system cannot find the file specified"。
func findAgentExe(bin string) (string, bool) {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return "", false
	}
	home, _ := os.UserHomeDir()
	local := os.Getenv("LOCALAPPDATA")
	appdata := os.Getenv("APPDATA")
	names := []string{bin, bin + ".exe", bin + ".cmd"}
	var cands []string
	for _, n := range names {
		cands = append(cands,
			filepath.Join(home, ".local", n),
			filepath.Join(home, ".local", "bin", n),
		)
		if local != "" {
			cands = append(cands,
				filepath.Join(local, "Programs", bin, n),
				filepath.Join(local, bin, n),
			)
		}
		if appdata != "" {
			cands = append(cands, filepath.Join(appdata, "npm", n))
		}
	}
	cands = append(cands, agentExeHints(bin, home, local)...)
	for _, p := range cands {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, true
		}
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}
	return "", false
}

// resolveAgentExe 找一个 agent 的可执行文件，并处理 Windows 的 .cmd shim：
// npm 装出来的是 <bin>.cmd，ConPTY 不能直接启动它，要经 cmd.exe /c。
//
// 顺序按"本机实际安装位置"排：官方脚本大多落在 ~/.local/bin 或
// %LOCALAPPDATA%\Programs\<name>，npm 落在 %APPDATA%\npm，个别固定落点
// 由 agentExeHints 补。
func resolveAgentExe(bin string) (string, []string) {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return "", nil
	}
	if p, ok := findAgentExe(bin); ok {
		return wrapShim(p)
	}
	return bin, nil
}

func wrapShim(p string) (string, []string) {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".cmd", ".bat":
		return "cmd.exe", []string{"/c", p}
	}
	return p, nil
}

func agentCatalogDefsByID(id string) *agentCatalogDef {
	for i := range agentCatalogDefs {
		if agentCatalogDefs[i].ID == id {
			return &agentCatalogDefs[i]
		}
	}
	return nil
}

// mergeCatalogCalls 把“今日经过网关”的读数保留下来：刚扫出来的名单没有
// calls，直接推给前端会让所有 agent 的今日流量闪成 0。
func mergeCatalogCalls(cat []agentCard) {
	s := magpieSnapshot()
	if s == nil {
		return
	}
	byID := map[string]int{}
	for _, a := range s.Catalog {
		byID[a.ID] = a.Calls
	}
	for i := range cat {
		cat[i].Calls = byID[cat[i].ID]
	}
}
