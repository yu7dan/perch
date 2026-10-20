package session

import (
	"context"
	"fmt"
	"log"

	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/term"
)

// StartError 标出启动是在哪一步失败的。调用方按 Stage 选对用户说的那句话，
// 而不是把三种完全不同的失败揉成一句“启动失败”。
type StartError struct {
	Stage string
	Agent string
	Err   error
}

const (
	StageUnknownAgent = "unknown_agent"
	StagePrepare      = "prepare"
	StagePTY          = "pty"
)

func (e *StartError) Error() string {
	if e.Err == nil {
		return e.Stage + ": " + e.Agent
	}
	return e.Stage + ": " + e.Err.Error()
}

func (e *StartError) Unwrap() error { return e.Err }

// Running 是一格起来之后的 PTY。它嵌着 term.Session（Read/Write/Resize/Wait/
// Close/Pid），外加这次启动用到的参数与观察者取消函数 —— 字节循环由调用方
// （stream 包）拥有，本包只负责把进程正确地带起来。
type Running struct {
	*term.Session
	Exe      string
	Args     []string
	Settings string
	CWD      string

	cancelObserve context.CancelFunc
}

// StopObserve 让 Prepare 交出来的 observe 退出。流结束时调用一次即可。
func (r *Running) StopObserve() {
	if r != nil && r.cancelObserve != nil {
		r.cancelObserve()
	}
}

// StartTab 做“这一格才有的”启动准备（OpenCode 的端口/口令、Codex 的 app-server）、
// 解析 exe、起 PTY，并把 pid 记进运行期表。
//
// 它不碰流的收发：启动失败要告诉用户的那句话、进程退出后关流，都由调用方做。
func (m *Manager) StartTab(tab *Tab, cols, rows int) (*Running, error) {
	def, ok := m.defFor(tab.Spec.Agent)
	if !ok {
		return nil, &StartError{Stage: StageUnknownAgent, Agent: tab.Spec.Agent}
	}
	tag := fmt.Sprintf("t%d", tab.ID)
	// 「新格没指定目录时落在哪」只有这一个答案（见 EffectiveCWD）——
	// 2026-10-16 起是默认工作区，不是 fallbackCWD。这也正是记进登记表的那个值。
	// Prepare 也要它：Codex 的 app-server 必须和 TUI 在同一个目录里起来。
	cwd := m.EffectiveCWD(tab.Spec)
	// Prepare 是“这一格才有的”启动准备（OpenCode 的端口/口令、Codex 的
	// app-server 都是它给的）。
	var prepEnv map[string]string
	var prepArgs []string
	var observe func(context.Context)
	if def.Prepare != nil {
		var perr error
		prepEnv, prepArgs, observe, perr = def.Prepare(tag, tab.ID, cwd)
		if perr != nil {
			return nil, &StartError{Stage: StagePrepare, Agent: tab.Spec.Agent, Err: perr}
		}
	}
	// hooks 是**每格子一份**：事件文件路径写死进这一份 --settings 里，
	// 于是"这条事件属于哪个格子"由文件名决定，不需要任何反查。
	// 只有 Claude 用这份 --settings；别的 agent 传空串。
	settings := ""
	if tab.Spec.Agent == "claude" {
		settings = BuildHookSettings(m.stateDir, tag)
	}
	// 每次开格重新解析一次（见 agent.Def.Bin 的注释）：装完/更新完不用重启 Perch。
	exe, prefix := def.Exe, def.Prefix
	if def.Bin != "" {
		exe, prefix = m.ResolveExe(def.Bin)
	}
	args := append(append([]string{}, prefix...), def.Args(tab.Spec.Resume, settings)...)
	args = append(args, prepArgs...)

	env := make(map[string]string, len(def.Env)+len(prepEnv))
	for k, v := range def.Env {
		env[k] = v
	}
	for k, v := range prepEnv {
		env[k] = v
	}
	sess, err := term.Start(exe, args, cwd, agent.BuildEnv(env), cols, rows)
	if err != nil {
		// Prepare 可能已经在外面起了东西（Codex 的 app-server）。PTY 没起来
		// 就没有“流的寿命”来取消观察者 —— 给它一个已取消的 ctx 让它自己收尾，
		// 否则那个 server 会一直留到 Perch 退出。
		if observe != nil {
			octx, ocancel := context.WithCancel(context.Background())
			ocancel()
			go observe(octx)
		}
		return nil, &StartError{Stage: StagePTY, Agent: tab.Spec.Agent, Err: err}
	}
	// pid 是「格子 ↔ 会话」那条链子的起点（登记表按 pid 命名）。
	m.SetPID(tab.ID, sess.Pid())

	// 状态观察者跟着这条 PTY 的生命周期走：流一断/进程一关，ctx 就取消。
	// observe 自己负责“server 还没起来就等”，不阻塞这里的启动。
	r := &Running{Session: sess, Exe: exe, Args: args, Settings: settings, CWD: cwd}
	if observe != nil {
		octx, ocancel := context.WithCancel(context.Background())
		r.cancelObserve = ocancel
		go observe(octx)
	}
	// 注意日志里**打印参数**会把整份 --settings JSON 也打出来（几 KB）。
	// 这里改打长度：那串东西对读日志的人是噪音，长度足够判断"注进去了没有"。
	log.Printf("[perch] tab=%d 已启动 pid=%d exe=%s 参数%d个(settings=%d字节) cwd=%s resume=%s",
		tab.ID, sess.Pid(), exe, len(args), len(settings), cwd, tab.Spec.Resume.Kind)
	return r, nil
}
