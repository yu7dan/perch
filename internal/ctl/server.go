// Package ctl 是前端那条常驻控制通道的协议层：收 JSON、按 type 分发、
// 推 JSON 回去。它不认识 Wails：Conn 只有 Send/Receive/Close 三个方法，
// 系统动作（打开网页/路径、选目录、闪任务栏、关窗）走注入的 UI。
//
// 为什么不走 Wails 的绑定（前端的 Call.ByName）而自己开一条流：绑定在服务端是
// 按「<包路径>.<结构体>.<方法>」查的，而那些名字要跑 codegen 生成带对象 id 的
// JS 调用桩 —— 我们的构建现在是纯 `go build`，不想为此引入构建步骤。
// 这条流复用已有的控制帧形状：**零新 API 面、零构建步骤**。
//
// 和标签数据通道的分工是干净的：这边**双向都是 JSON**，那边**双向都是字节**
// （键盘原始输入 + PTY 原始输出），互不掺和。
package ctl

import (
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/agentprofile"
	"github.com/yu7dan/perch/internal/gateway"
	"github.com/yu7dan/perch/internal/install"
	"github.com/yu7dan/perch/internal/panes"
	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/session"
	"github.com/yu7dan/perch/internal/settings"
	"github.com/yu7dan/perch/internal/transcript"
)

// Conn 是控制通道的传输层。Wails 的 *application.StreamConn 由组合根适配。
type Conn interface {
	Send([]byte) error
	Receive() ([]byte, error)
	Close() error
}

// ErrNoWindow = 窗口还没建出来，系统对话框打不开。
// 用哨兵而不是文案判断：调用方要按"这不是失败，是时机未到"分别说话。
var ErrNoWindow = errors.New("窗口还没起来")

// ErrPickerCancelled = 用户在系统选择器里按了取消。取消是**正常手势**，
// 不是失败：调用方不推错误 toast，只落一行日志。UI 适配层把各家对话框
// 的 "cancelled by user" 归一成这一个哨兵，编排层不必再猜错误文案。
var ErrPickerCancelled = errors.New("cancelled by user")

// UI 是 ctl 需要的系统动作。实现留在组合根（Wails），本包不认识它。
type UI interface {
	OpenURL(url string) error
	ChooseDirectory(title string) (string, error)
	OpenPath(mode, path string)
	Flash(on bool)
	CloseWindow()
	EmitCloseRequest()
}

// Deps 是 ctl 的外部世界。所有 store/service 都是构造出来的，不读包级单例。
type Deps struct {
	StateDir       string
	SecondInstance bool
	// Version 是构建时注入的版本号（main.buildVersion）；设置页「关于」显示它。
	Version string

	Tabs        *session.Manager
	Panes       *panes.Store
	Titles      *session.TitleStore
	Pool        *project.Pool
	Prefs       *settings.Store
	Gateway     *gateway.Gateway
	Profiles    *agentprofile.Store
	ProfileSets *agentprofile.SetStore
	Installer   *install.Installer
	Transcript  *transcript.Follower

	DefaultCWD    func() string
	SessionExists func(agentName, cwd, id string) bool
	// MergeCalls 把 magpie 的今日调用数合并进 agentcatalog.Cards 的结果，
	// 让“接入状态”成功后推回去的名单和总览使用同一份数据。
	MergeCalls func([]agentcatalog.Card)
	// SetupAgent 是“只启动 → 接入状态”的动作（目前只有 dsh）。它是用户
	// 点下按钮才跑的，不静默；失败由 ctl 折成 install.done(ok=false)。
	SetupAgent func(id string, log func(string)) error
	// CreateTab 在组合根里**先** app.HandleStream(host.Stream, …)、再返回 ——
	// 顺序是硬约束：前端拿到 tab.ok 就会立刻去连那条流。
	CreateTab func(session.SpawnSpec) *session.Tab

	UI UI
}

// Server 是控制通道的处理器。它同时持有「当前推送连接」与关窗确认状态。
type Server struct {
	deps Deps

	mu       sync.Mutex
	pushConn Conn

	// 所有 c.Send 都过 sendMu：lib.reload 现在在 goroutine 里扫描，
	// 它和 tab.ok / 推送会同时写同一条流。Send 是否线程安全没人保证，
	// 一把锁比一个未知数便宜。
	sendMu sync.Mutex

	// lib.reload 是单飞 + 尾巴合并：扫描期间再来的请求只记一次，
	// 扫完再补一次。它绝不能在 ctl 的 receive 循环里同步跑 ——
	// 171 个会话的扫描会让后面的 tab.new 应答迟到，前端 7.5s 就放弃。
	reloadMu    sync.Mutex
	reloading   bool
	reloadAgain bool

	guard CloseGuard
}

func New(d Deps) *Server {
	return &Server{deps: d}
}

// Guard 是关窗确认的共享状态：ctl 的 window.close 与窗口的 WindowClosing
// hook 必须看同一份，否则"确认过了"和"再问一次"会同时成立。
func (s *Server) Guard() *CloseGuard { return &s.guard }

// Serve 跑一条控制通道，直到它断开。
func (s *Server) Serve(c Conn) {
	defer c.Close()
	s.setPush(c)
	defer s.clearPush(c)
	log.Printf("[ctl] 控制通道已连接")
	/* 令牌去重表：**同一根连接上，同一个 req 只允许建一次格子**。
	   前端在没等到应答时会拿同一个令牌重发（见 assets 里 sendSpawn 的兜底重发），
	   所以这里必须认得出"这是我刚答过的那一条"并**重放**应答 —— 少了这一层，
	   一次"请求发出去、应答在回来的路上丢了"就会变成两个 tabHost、两条 PTY、
	   两条 pane 记录，而**同一份会话文件被两个进程追加**是本项目唯一不可逆的失败。
	   ⚠️ 缓存**按连接**，不做全局：前端刷新页面后 spawnReqSeq 从 0 重新发号，
	   全局缓存会把上一轮的旧应答当成新请求的答复发回去（那一格会连上别人的流）。 */
	tabReqCache := map[int][]byte{}
	for {
		data, err := c.Receive()
		if err != nil {
			log.Printf("[ctl] 控制通道断开")
			return
		}
		var m Msg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		s.dispatch(c, &m, tabReqCache)
	}
}

func (s *Server) dispatch(c Conn, m *Msg, tabReqCache map[int][]byte) {
	switch m.Type {
	// 标签 / 冷恢复 / 会话库
	case "tab.new":
		s.tabNew(c, m, tabReqCache)
	case "panes.query":
		s.panesQuery(c)
	case "pane.close":
		s.paneClose(m)
	case "pane.forget":
		s.paneForget(m)
	case "title.set":
		s.titleSet(m)
	case "lib.reload":
		s.libReload(c)

	// 文件树 / 系统打开
	case "open":
		s.openPath(m)
	case "fs.list":
		s.fsListReq(m)
	case "fs.read":
		s.fsReadReq(m)

	// 页面级事实、快照补发、系统打开地址
	case "log", "acts.snapshot", "files.snapshot", "trace.diff", "open.url":
		s.handleMisc(m)

	// 网关（magpie）
	case "magpie.refresh", "magpie.update.get", "magpie.update.install",
		"gw.connect", "gw.disconnect", "gw.refresh",
		"gw.agents", "gw.agents.prefetch", "gw.agent.set",
		"gw.agent.connect", "gw.agent.disconnect", "gw.agent.reapply",
		"gw.agent.keep", "gw.agent.preview", "gw.agents.drift":
		s.handleGateway(m)

	// Perch 自己的 per-agent 配置（隔离网关；不写 agent 全局配置）
	case "agent.profiles", "agent.profile.set", "agent.profile.tier", "agent.profile.models",
		"agent.profile.save", "agent.profile.use", "agent.profile.delete":
		s.handleAgentProfile(m)

	// 安装器 / “只启动”agent 的状态接入
	case "install.agent", "install.magpie", "install.cancel", "agent.setup":
		s.handleInstall(m)

	// 设置
	case "settings.get", "settings.set", "settings.pickDefaultCWD":
		s.handleSettings(m)

	// 窗口 / 任务栏
	case "attention", "window.close", "window.close.cancel":
		s.handleWindow(m)

	// 项目池
	case "project.add", "project.remove", "project.pin", "project.rename":
		s.handleProjects(m)
	}
}

// send 是所有 c.Send 的唯一入口。lib.reload 的扫描在 goroutine 里跑，
// 它和 tab.ok / 推送可能同时写同一条流；这里把写串起来。
func (s *Server) send(c Conn, b []byte) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	return c.Send(b)
}

// Push 把一条消息推给前端（走 ctl 那条常驻通道）。
//
// 加锁是因为这里有**两个写者**（链路轮询的 goroutine 和可能的其它 goroutine），
// 而 Send 内部是不是线程安全我们没验过；一把锁比一个未知数便宜。
func (s *Server) Push(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.mu.Lock()
	c := s.pushConn
	s.mu.Unlock()
	if c == nil {
		return
	}
	if err := s.send(c, b); err != nil {
		s.mu.Lock()
		if s.pushConn == c {
			s.pushConn = nil
			log.Printf("[ctl] 推送失败，先停掉推送（下次前端连上会重新接管）: %v", err)
		}
		s.mu.Unlock()
	}
}

// Connected = 前端那条控制通道此刻在不在。关窗确认必须问它：页面还没连上
// （启动最初一两秒）或者已经崩了的时候，不能因为"要确认"把窗口卡死。
func (s *Server) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pushConn != nil
}

func (s *Server) setPush(c Conn) {
	s.mu.Lock()
	s.pushConn = c
	s.mu.Unlock()
}

func (s *Server) clearPush(c Conn) {
	s.mu.Lock()
	if s.pushConn == c {
		s.pushConn = nil
	}
	s.mu.Unlock()
}

// ServeShell 一次性把界面骨架要的数据推给前端。
//
// 用 Stream 而不是开 HTTP 路由，是因为流通道是已经跑通的那条，
// 不引入任何新的 API 面（beta 版里少一个未知数就是少一个坑）。
// 推完必须**等一下再关** —— 立刻 Close 会把刚写出去的那帧一起带走。
func (s *Server) ServeShell(c Conn) {
	defer func() {
		time.Sleep(120 * time.Millisecond)
		_ = c.Close()
	}()

	b, err := json.Marshal(s.ShellPayload())
	if err != nil {
		log.Printf("[perch] 索引失败: %v", err)
		return
	}
	log.Printf("[perch] 索引 %d 字节", len(b))
	_ = s.send(c, b)
}
