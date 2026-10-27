// Package install 是 Agent 安装器的执行层。
//
// 用户 2026-10-17 的评审：点「下载」跳浏览器不算安装 —— 要真的下载、真的装，
// 装完能直接在 Perch 里开一格。不只是把命令显示给用户复制，而是在
// **用户明确点下「安装」之后**替他把同一条官方命令跑完，并把输出原样摊在
// 页面里（不藏进度、不假装成功）。
//
// 三条边界：
//  1. 只跑 agentcatalog 里写死的官方命令，绝不执行远端返回的任意脚本；
//  2. 每个动作都由用户点一次触发，不静默、不后台安装；
//  3. 输出里不打印任何凭据（安装脚本本身也不接受凭据）。
//
// 装完的收尾只做“重读 PATH + 重扫名单 + 版本证据”，不碰任何模型配置。
package install

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
	"github.com/yu7dan/perch/internal/uimsg"
)

const pathPrelude = `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$ProgressPreference='SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
`

// nodeCheckScript 返回一段 PowerShell：确保 Node 存在且版本够新。
//
// 只检查 npm.cmd 是不够的：旧 Node 也能提供 npm.cmd，但 Pi 1.4 要求
// Node >= 22.19，装完 CLI 会在启动时崩。版本不够时先让 winget 升 LTS，
// 再从注册表刷新 PATH；仍然不够就抛错，让界面拿到真实原因。
func nodeCheckScript(min string) string {
	if strings.TrimSpace(min) == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString(`$needNode = [version]'` + min + `'` + "\n")
	b.WriteString(`$nodeOK = $false` + "\n")
	b.WriteString(`if (Get-Command node.exe -ErrorAction SilentlyContinue) {` + "\n")
	b.WriteString(`  $nv = (& node.exe -p "process.versions.node" 2>$null).Trim()` + "\n")
	b.WriteString(`  if ($nv -and ([version]$nv -ge $needNode)) { $nodeOK = $true }` + "\n")
	b.WriteString(`}` + "\n")
	b.WriteString(`if (-not $nodeOK) {` + "\n")
	b.WriteString(`  Write-Host ('== Node.js 低于 ' + $needNode + '，安装 Node.js LTS ==')` + "\n")
	b.WriteString(`  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --disable-interactivity` + "\n")
	b.WriteString(`  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path` + "\n")
	b.WriteString(`  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 安装后仍然找不到 node.exe' }` + "\n")
	b.WriteString(`  $nv = (& node.exe -p "process.versions.node" 2>$null).Trim()` + "\n")
	b.WriteString(`  if (-not $nv -or ([version]$nv -lt $needNode)) { throw ('Node.js 版本仍低于 ' + $needNode + '（当前 ' + $nv + '）') }` + "\n")
	b.WriteString(`}` + "\n")
	return b.String()
}

// recipeScript 把配方拼成一段 PowerShell。npm 那条先确保 Node.js ——
// 和 magpie 的做法一致（winget 装 LTS，然后从注册表重新读 PATH）。
func recipeScript(r agentcatalog.Recipe) string {
	var b strings.Builder
	b.WriteString(pathPrelude)
	if r.NPM {
		b.WriteString(nodeCheckScript(r.NodeMin))
		b.WriteString(`if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {` + "\n")
		b.WriteString(`  Write-Host '== 没有找到 Node.js，先安装 Node.js LTS（winget）=='` + "\n")
		b.WriteString(`  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --disable-interactivity` + "\n")
		b.WriteString(`  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path` + "\n")
		b.WriteString(`}` + "\n")
		b.WriteString(`if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Node.js 安装后仍然找不到 npm.cmd' }` + "\n")
		if r.Script != "" {
			// 有些 agent（dsh）不是“一条 npm install”就完了：还要 bootstrap
			// 一个 dsh profile。配方脚本仍然是写死的、可审计的官方/社区命令。
			b.WriteString(r.Script + "\n")
		} else {
			b.WriteString(`npm.cmd install -g ` + r.Pkg + "\n")
		}
	} else {
		b.WriteString(r.Script + "\n")
	}
	b.WriteString(`Write-Host '== 完成 =='` + "\n")
	return b.String()
}

type run struct {
	cancel  context.CancelFunc
	pid     int
	started time.Time
	// queued 只用于 npm 配方：它们共用同一个全局前缀，不能并发执行。
	// 排队中的 run 没有进程，Cancel 直接从队列里摘掉即可。
	queued bool
	// cancelled 覆盖「刚点开始、进程还没起来」的那一小段：Cancel 先记下，
	// runRecipe 起来后看到就不再启动 PowerShell。
	cancelled bool
}

// Deps 是安装器需要的外部能力。Cards 让"安装完重扫名单"与
// 总览使用同一份探测规则。
type Deps struct {
	Push         func(any)
	Cards        func() []agentcatalog.Card
	ReloadPath   func()
	ProbeVersion func(bin string) string
	Home         func() (string, error)
	// Setup 在官方 CLI 安装成功后、收尾扫描前跑一次“接入状态”的准备工作
	// （目前只有 dsh：写官方 hook 桥 / profile peer / home patch）。
	// 失败只记日志，不把 CLI 安装判成失败 —— 终端仍然能开。
	Setup func(id string, log func(string)) error
}

// Installer 串行化每个 agent 的安装，构建外部调用面。
//
// npm 配方额外走一条单队列：npm 的全局前缀（%APPDATA%\npm）只有一份，
// 几个 `npm install -g` 同时跑会争 lockfile 和 shim，轻则互相等待，重则
// 装完了却没有命令。脚本配方（irm | iex）落在各自的目录里，仍可并行。
type Installer struct {
	deps Deps
	mu   sync.Mutex
	runs map[string]*run

	npmQueue  []string // 等待中的 npm id（先进先出）
	npmActive string   // 正在跑的 npm id；空 = 空闲
}

// New 构造安装器。Deps 里除 Push 外都应为非 nil；缺失的能力按"没有"处理。
func New(d Deps) *Installer {
	return &Installer{deps: d, runs: map[string]*run{}}
}

func (in *Installer) emit(v any) {
	if in.deps.Push != nil {
		in.deps.Push(v)
	}
}

func (in *Installer) log(id, line string) {
	in.emit(map[string]any{"type": "install.log", "id": id, "line": line})
}

// Start 在后台跑一条配方。同一个 agent 同时只允许一条。
//
// npm 配方不会并发：第一条直接跑，后面的进队列并推 install.queued。
// 脚本配方各自独立，仍按原来的方式并行。
func (in *Installer) Start(id string) {
	r, ok := agentcatalog.Recipes[id]
	if !ok || (r.Script == "" && !r.NPM) {
		in.log(id, "这个 agent 没有可用的自动安装配方（请打开官方安装说明）。")
		in.emit(uimsg.Fields(map[string]any{"type": "install.done", "id": id, "ok": false},
			uimsg.New("install.noRecipe", "这个 agent 没有可用的自动安装配方（请打开官方安装说明）。")))
		return
	}

	in.mu.Lock()
	if _, busy := in.runs[id]; busy {
		in.mu.Unlock()
		in.log(id, "已经在安装了。")
		return
	}
	job := &run{}
	in.runs[id] = job
	if r.NPM && in.npmActive != "" {
		job.queued = true
		in.npmQueue = append(in.npmQueue, id)
		ahead := len(in.npmQueue) - 1
		active := in.npmActive
		in.mu.Unlock()
		// 先推 queued 再写日志：前端收到日志时已经知道这是排队，不会闪一下
		// 「安装中」再退回「排队中」。
		in.emit(map[string]any{
			"type": "install.queued", "id": id, "source": r.Source,
			"ahead": ahead, "active": active, "at": time.Now().UnixMilli(),
		})
		return
	}
	if r.NPM {
		in.npmActive = id
	}
	in.mu.Unlock()

	in.runRecipe(id, r, job)
}

// runRecipe 是真正执行一条配方的部分。排队项被推进时也走这里。
func (in *Installer) runRecipe(id string, r agentcatalog.Recipe, job *run) {
	limit := 20 * time.Minute
	if r.NPM {
		// npm 的大包（带原生依赖/桌面运行时的 CLI）在慢网络上会超过 20 分钟；
		// 重试会命中缓存，但第一次要给它足够的时间走完，否则前面的下载全白费。
		limit = 30 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	if r.NPM {
		// 无论成功、失败还是超时，都要把队列往前推一格。
		defer in.npmDone(id)
	}
	in.mu.Lock()
	if job.cancelled {
		in.mu.Unlock()
		in.finish(id, false, 0, uimsg.New("install.cancelled", "已取消"), true)
		return
	}
	job.cancel = cancel
	job.started = time.Now()
	in.mu.Unlock()

	home := ""
	if in.deps.Home != nil {
		home, _ = in.deps.Home()
	}
	script := recipeScript(r)
	in.emit(map[string]any{
		"type": "install.start", "id": id, "source": r.Source,
		"at": time.Now().UnixMilli(),
	})
	in.log(id, "$ "+r.Source)
	if p := proxyLogLine(); p != "" {
		in.log(id, p)
	}

	cmd := exec.CommandContext(ctx, "powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Dir = home
	// 系统代理只被 PowerShell 的 Invoke-WebRequest 使用；官方安装脚本里的
	// 原生子进程（claude.exe install、npm、winget）需要环境变量才会走它。
	cmd.Env = systemProxyEnv(os.Environ())
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// 进程退出后最多再等 2 秒输出流；孙进程占着管道时，Wait 会关掉它并返回。
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		in.finish(id, false, 1, startFailed(err), cancelled(ctx))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		in.finish(id, false, 1, startFailed(err), cancelled(ctx))
		return
	}
	if err := cmd.Start(); err != nil {
		in.finish(id, false, 1, startFailed(err), false)
		return
	}
	in.mu.Lock()
	job.pid = cmd.Process.Pid
	in.mu.Unlock()

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
				in.log(id, line)
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
			in.log(id, "（安装进程已退出，输出流仍未关闭，继续收尾）")
			werr = nil
		} else if _, ok := werr.(*exec.ExitError); !ok {
			code = -1
		}
	}
	if ctx.Err() == context.DeadlineExceeded {
		minutes := "20"
		if r.NPM {
			minutes = "30"
		}
		werr = uimsg.NewParams("install.timeout", fmt.Sprintf("安装超时（%s 分钟）", minutes),
			map[string]string{"minutes": minutes})
	}
	if werr == nil && !cancelled(ctx) && in.deps.Setup != nil {
		if serr := in.deps.Setup(id, func(line string) { in.log(id, line) }); serr != nil {
			// 终端已经装好了；状态钩子失败不影响开格，但必须让用户看见。
			in.log(id, "状态接入没有完成："+serr.Error())
		}
	}
	in.finish(id, werr == nil, code, werr, cancelled(ctx))
}

// npmDone 在当前 npm 安装结束后推进队列。只有正在跑的那一条能推进；
// 取消排队项不会走到这里（Cancel 直接从 npmQueue 摘掉）。
func (in *Installer) npmDone(id string) {
	in.mu.Lock()
	if in.npmActive != id {
		in.mu.Unlock()
		return
	}
	in.npmActive = ""
	var nextID string
	var nextR agentcatalog.Recipe
	var next *run
	for len(in.npmQueue) > 0 {
		candidate := in.npmQueue[0]
		in.npmQueue = in.npmQueue[1:]
		job, ok := in.runs[candidate]
		if !ok || !job.queued {
			continue
		}
		recipe, ok := agentcatalog.Recipes[candidate]
		if !ok || !recipe.NPM {
			// 配方表是静态的；真出现缺口就把它从内存里摘掉，别卡住后面的队列。
			delete(in.runs, candidate)
			continue
		}
		job.queued = false
		in.npmActive = candidate
		nextID, nextR, next = candidate, recipe, job
		break
	}
	in.mu.Unlock()
	if nextID == "" {
		return
	}
	go in.runRecipe(nextID, nextR, next)
}

func cancelled(ctx context.Context) bool {
	return ctx.Err() == context.Canceled
}

func startFailed(err error) error {
	return uimsg.Wrap(err, "install.startFailed", "起不了安装进程："+err.Error(),
		map[string]string{"err": err.Error()})
}

// finish 收尾：重读 PATH（安装脚本改的是注册表里的用户 PATH，而本进程
// 的环境变量是启动时快照）、重扫 Agent 名单、跑一次 --version 作为证据。
//
// 顺序很重要：**先推新名单，再推 done**。前端收到 done 时手里已经是新名单，
// 行会在同一个事件里从「未检测到」翻成「已接入」，不用等下一次 2.5 秒轮询。
// --version 只是证据，放后台跑，不挡收尾。
func (in *Installer) finish(id string, ok bool, code int, err error, wasCancelled bool) {
	in.mu.Lock()
	job := in.runs[id]
	delete(in.runs, id)
	in.mu.Unlock()

	elapsed := time.Duration(0)
	if job != nil && !job.started.IsZero() {
		elapsed = time.Since(job.started)
	}

	if ok {
		// 重读 PATH 可能要几秒；先告诉界面进入「重新检测」阶段，
		// 别让行一直显示「安装中」。
		in.emit(map[string]any{"type": "install.phase", "id": id, "phase": "scanning"})
		if in.deps.ReloadPath != nil {
			in.deps.ReloadPath()
		}
		cat := in.cards()
		detected, path := catalogAgentState(cat, id)

		in.emit(map[string]any{"type": "catalog", "catalog": cat})
		in.emit(map[string]any{
			"type": "install.done", "id": id, "ok": true, "code": code,
			"detected": detected, "path": path,
			"elapsedMs": elapsed.Milliseconds(),
		})
		log.Printf("[install] %s 收尾 ok=true detected=%v 用时=%s", id, detected, elapsed)

		if d := agentcatalog.ByID(id); d != nil && d.Bin != "" && in.deps.ProbeVersion != nil {
			go func(bin string) {
				if line := in.deps.ProbeVersion(bin); line != "" {
					in.log(id, "版本："+line)
				}
			}(d.Bin)
		}
		// npm 写 shim 偶尔比进程退出晚；没探到就短重试几次，探到立刻推名单。
		if !detected {
			go in.retryCatalog(id)
		}
		return
	}

	uiErr := failureMessage(code, err, wasCancelled)
	in.log(id, "失败："+uiErr.Error())
	in.emit(uimsg.Fields(map[string]any{
		"type": "install.done", "id": id, "ok": false, "code": code,
		"elapsedMs": elapsed.Milliseconds(),
	}, uiErr))
}

// failureMessage 把「为什么没装成」归一成一句带稳定 code 的话。
// 已有 code 的错误（超时 / 起不了进程）原样保留；退出码与取消各自成一个 code。
func failureMessage(code int, err error, wasCancelled bool) error {
	switch {
	case wasCancelled:
		return uimsg.New("install.cancelled", "已取消")
	case err != nil:
		if _, ok := uimsg.From(err); ok {
			return err
		}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return uimsg.Wrap(err, "install.exitCode", fmt.Sprintf("退出码 %d", code),
				map[string]string{"code": fmt.Sprint(code)})
		}
		return uimsg.Wrap(err, "install.failed", "安装失败："+err.Error(),
			map[string]string{"err": err.Error()})
	default:
		return uimsg.NewParams("install.exitCode", fmt.Sprintf("退出码 %d", code),
			map[string]string{"code": fmt.Sprint(code)})
	}
}

func (in *Installer) cards() []agentcatalog.Card {
	if in.deps.Cards == nil {
		return nil
	}
	return in.deps.Cards()
}

// catalogAgentState 从刚扫出来的名单里取一个 agent 的检测结果。
func catalogAgentState(cat []agentcatalog.Card, id string) (bool, string) {
	for _, a := range cat {
		if a.ID == id {
			return a.Installed, a.Path
		}
	}
	return false, ""
}

// retryCatalog 给 npm 写 shim 留一点时间：400ms / 1.2s / 2.5s 各扫一次，
// 探到就推名单。最多三次，不无限轮询。
func (in *Installer) retryCatalog(id string) {
	for _, wait := range []time.Duration{400 * time.Millisecond, 1200 * time.Millisecond, 2500 * time.Millisecond} {
		time.Sleep(wait)
		cat := in.cards()
		if ok, _ := catalogAgentState(cat, id); ok {
			in.emit(map[string]any{"type": "catalog", "catalog": cat})
			in.log(id, "已重新检测到 CLI。")
			return
		}
	}
}

// Cancel 先按进程树杀（npm / winget 会再起子进程），再取消 context。
// 排队中的 npm 任务没有进程，从队列里摘掉并直接推 done。
func (in *Installer) Cancel(id string) {
	in.mu.Lock()
	job := in.runs[id]
	if job == nil {
		in.mu.Unlock()
		return
	}
	if job.queued {
		delete(in.runs, id)
		for i, v := range in.npmQueue {
			if v == id {
				in.npmQueue = append(in.npmQueue[:i], in.npmQueue[i+1:]...)
				break
			}
		}
		in.mu.Unlock()
		in.emit(uimsg.Fields(map[string]any{
			"type": "install.done", "id": id, "ok": false, "code": 0, "elapsedMs": 0,
		}, uimsg.New("install.cancelled", "已取消")))
		return
	}
	job.cancelled = true
	pid := job.pid
	cancel := job.cancel
	in.mu.Unlock()
	if pid > 0 {
		_ = exec.Command("taskkill", "/PID", fmt.Sprint(pid), "/T", "/F").Run()
	}
	if cancel != nil {
		cancel()
	}
}
