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
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

// 配方数据住在 internal/agentcatalog（Cards 也要读它）。这里留旧名字给 root
// 过渡期用；6b 之后 root 不再有安装器。
type installRecipe = agentcatalog.Recipe

var installRecipes = agentcatalog.Recipes

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
	cancel  context.CancelFunc
	pid     int
	started time.Time
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
		installLog(id, "这个 agent 没有可用的自动安装配方（请打开官方安装说明）。")
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
	run := &installRun{cancel: cancel, started: time.Now()}
	installRuns[id] = run
	installMu.Unlock()

	home, _ := os.UserHomeDir()
	script := recipeScript(r)
	pushJSON(map[string]any{
		"type": "install.start", "id": id, "source": r.Source,
		"at": time.Now().UnixMilli(),
	})
	installLog(id, "$ "+r.Source)

	cmd := exec.CommandContext(ctx, "powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Dir = home
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// 进程退出后最多再等 2 秒输出流；孙进程占着管道时，Wait 会关掉它并返回。
	cmd.WaitDelay = 2 * time.Second
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
	// Wait 必须在后台跑：它负责在进程退出后关掉管道。如果先等 wg.Wait()
	// 再 Wait，孙进程（npm / 安装脚本常留）会让读取永远等不到 EOF，
	// 界面就一直停在「安装中」。
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()

	wg.Add(2)
	go scan(stdout)
	go scan(stderr)
	wg.Wait()
	werr := <-waitErr
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	if werr != nil {
		if errors.Is(werr, exec.ErrWaitDelay) {
			// 进程已经退出，只是输出流没关干净；不把这次安装判成失败。
			installLog(id, "（安装进程已退出，输出流仍未关闭，继续收尾）")
			werr = nil
		} else if _, ok := werr.(*exec.ExitError); !ok {
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
//
// 顺序很重要：**先推新名单，再推 done**。前端收到 done 时手里已经是新名单，
// 行会在同一个事件里从「未检测到」翻成「已接入」，不用等下一次 2.5 秒轮询。
// --version 只是证据，放后台跑，不挡收尾。
func finishInstall(id string, ok bool, code int, msg string, wasCancelled bool) {
	installMu.Lock()
	run := installRuns[id]
	delete(installRuns, id)
	installMu.Unlock()

	elapsed := time.Duration(0)
	if run != nil && !run.started.IsZero() {
		elapsed = time.Since(run.started)
	}

	if ok {
		if id == "magpie" {
			// 装完就**自动接入**控制面（用户 2026-10-17 定的：不再有「连接 magpie」
			// 这个手动动作）。gwConnect 会自己找到刚装好的那个 exe。
			pushJSON(map[string]any{
				"type": "install.done", "id": id, "ok": true, "code": code,
				"elapsedMs": elapsed.Milliseconds(),
			})
			go gwConnect()
			return
		}

		// 重读 PATH 可能要几秒；先告诉界面进入「重新检测」阶段，
		// 别让行一直显示「安装中」。
		pushJSON(map[string]any{"type": "install.phase", "id": id, "phase": "scanning"})
		reloadPathFromRegistry()
		home, _ := os.UserHomeDir()
		cat := scanAgentCatalog(home)
		mergeCatalogCalls(cat)
		detected, path := catalogAgentState(cat, id)

		pushJSON(map[string]any{"type": "catalog", "catalog": cat})
		pushJSON(map[string]any{
			"type": "install.done", "id": id, "ok": true, "code": code,
			"detected": detected, "path": path,
			"elapsedMs": elapsed.Milliseconds(),
		})
		log.Printf("[install] %s 收尾 ok=true detected=%v 用时=%s", id, detected, elapsed)

		if d := agentCatalogDefsByID(id); d != nil && d.Bin != "" {
			go func(bin string) {
				if line := probeAgentVersion(bin); line != "" {
					installLog(id, "版本："+line)
				}
			}(d.Bin)
		}
		// npm 写 shim 偶尔比进程退出晚；没探到就短重试几次，探到立刻推名单。
		if !detected {
			go retryCatalogAfterInstall(id)
		}
		return
	}

	if wasCancelled {
		msg = "已取消"
	}
	if msg == "" {
		msg = fmt.Sprintf("退出码 %d", code)
	}
	installLog(id, "失败："+msg)
	pushJSON(map[string]any{
		"type": "install.done", "id": id, "ok": false, "code": code, "err": msg,
		"elapsedMs": elapsed.Milliseconds(),
	})
}

// catalogAgentState 从刚扫出来的名单里取一个 agent 的检测结果。
func catalogAgentState(cat []agentCard, id string) (bool, string) {
	for _, a := range cat {
		if a.ID == id {
			return a.Installed, a.Path
		}
	}
	return false, ""
}

// retryCatalogAfterInstall 给 npm 写 shim 留一点时间：400ms / 1.2s / 2.5s
// 各扫一次，探到就推名单。最多三次，不无限轮询。
func retryCatalogAfterInstall(id string) {
	home, _ := os.UserHomeDir()
	for _, wait := range []time.Duration{400 * time.Millisecond, 1200 * time.Millisecond, 2500 * time.Millisecond} {
		time.Sleep(wait)
		cat := scanAgentCatalog(home)
		mergeCatalogCalls(cat)
		if ok, _ := catalogAgentState(cat, id); ok {
			pushJSON(map[string]any{"type": "catalog", "catalog": cat})
			installLog(id, "已重新检测到 CLI。")
			return
		}
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

func agentCatalogDefsByID(id string) *agentcatalog.Entry { return agentcatalog.ByID(id) }

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
