// Package install 是 Agent 安装器的执行层。
//
// 用户 2026-10-17 的评审：点「下载」跳浏览器不算安装 —— 要真的下载、真的装，
// 装完能直接在 Perch 里开一格。magpie 自己只把命令显示给用户复制；我们在
// **用户明确点下「安装」之后**替他把同一条官方命令跑完，并把输出原样摊在
// 页面里（不藏进度、不假装成功）。
//
// 三条边界：
//  1. 只跑 agentcatalog 里写死的官方命令，绝不执行远端返回的任意脚本；
//  2. 每个动作都由用户点一次触发，不静默、不后台安装；
//  3. 输出里不打印任何凭据（安装脚本本身也不接受凭据）。
//
// 这个包不 import gateway：装完要不要接网关由 OnInstalled 回调决定。
package install

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

const pathPrelude = `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$ProgressPreference='SilentlyContinue'
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
`

// recipeScript 把配方拼成一段 PowerShell。npm 那条先确保 Node.js ——
// 和 magpie 的做法一致（winget 装 LTS，然后从注册表重新读 PATH）。
func recipeScript(r agentcatalog.Recipe) string {
	var b strings.Builder
	b.WriteString(pathPrelude)
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

type run struct {
	cancel  context.CancelFunc
	pid     int
	started time.Time
}

// Deps 是安装器需要的外部能力。Cards/MergeCalls 让"安装完重扫名单"与
// 总览使用同一份探测规则；OnInstalled 让"装完接网关"留在组合根。
type Deps struct {
	Push         func(any)
	Cards        func() []agentcatalog.Card
	MergeCalls   func([]agentcatalog.Card)
	ReloadPath   func()
	ProbeVersion func(bin string) string
	Home         func() (string, error)
	OnInstalled  func(id string, ok bool)
}

// Installer 串行化每个 agent 的安装，构建外部调用面。
type Installer struct {
	deps Deps
	mu   sync.Mutex
	runs map[string]*run
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
func (in *Installer) Start(id string) {
	r, ok := agentcatalog.Recipes[id]
	if !ok || (r.Script == "" && !r.NPM) {
		in.log(id, "这个 agent 没有可用的自动安装配方（请打开官方安装说明）。")
		in.emit(map[string]any{"type": "install.done", "id": id, "ok": false, "err": "no recipe"})
		return
	}
	in.mu.Lock()
	if _, busy := in.runs[id]; busy {
		in.mu.Unlock()
		in.log(id, "已经在安装了。")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	job := &run{cancel: cancel, started: time.Now()}
	in.runs[id] = job
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

	cmd := exec.CommandContext(ctx, "powershell.exe",
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Dir = home
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	// 进程退出后最多再等 2 秒输出流；孙进程占着管道时，Wait 会关掉它并返回。
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		in.finish(id, false, 1, err.Error(), cancelled(ctx))
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		in.finish(id, false, 1, err.Error(), cancelled(ctx))
		return
	}
	if err := cmd.Start(); err != nil {
		in.finish(id, false, 1, err.Error(), false)
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
		werr = fmt.Errorf("安装超时（20 分钟）")
	}
	in.finish(id, werr == nil, code, errText(werr), cancelled(ctx))
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

// finish 收尾：重读 PATH（安装脚本改的是注册表里的用户 PATH，而本进程
// 的环境变量是启动时快照）、重扫 Agent 名单、跑一次 --version 作为证据。
//
// 顺序很重要：**先推新名单，再推 done**。前端收到 done 时手里已经是新名单，
// 行会在同一个事件里从「未检测到」翻成「已接入」，不用等下一次 2.5 秒轮询。
// --version 只是证据，放后台跑，不挡收尾。
func (in *Installer) finish(id string, ok bool, code int, msg string, wasCancelled bool) {
	in.mu.Lock()
	job := in.runs[id]
	delete(in.runs, id)
	in.mu.Unlock()

	elapsed := time.Duration(0)
	if job != nil && !job.started.IsZero() {
		elapsed = time.Since(job.started)
	}

	if ok {
		if id == "magpie" {
			// 装完就**自动接入**控制面（用户 2026-10-17 定的：不再有「连接 magpie」
			// 这个手动动作）。OnInstalled 会自己找到刚装好的那个 exe。
			in.emit(map[string]any{
				"type": "install.done", "id": id, "ok": true, "code": code,
				"elapsedMs": elapsed.Milliseconds(),
			})
			if in.deps.OnInstalled != nil {
				in.deps.OnInstalled(id, true)
			}
			return
		}

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

	if wasCancelled {
		msg = "已取消"
	}
	if msg == "" {
		msg = fmt.Sprintf("退出码 %d", code)
	}
	in.log(id, "失败："+msg)
	in.emit(map[string]any{
		"type": "install.done", "id": id, "ok": false, "code": code, "err": msg,
		"elapsedMs": elapsed.Milliseconds(),
	})
}

func (in *Installer) cards() []agentcatalog.Card {
	if in.deps.Cards == nil {
		return nil
	}
	cat := in.deps.Cards()
	if in.deps.MergeCalls != nil {
		in.deps.MergeCalls(cat)
	}
	return cat
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
func (in *Installer) Cancel(id string) {
	in.mu.Lock()
	job := in.runs[id]
	in.mu.Unlock()
	if job == nil {
		return
	}
	if job.pid > 0 {
		_ = exec.Command("taskkill", "/PID", fmt.Sprint(job.pid), "/T", "/F").Run()
	}
	job.cancel()
}
