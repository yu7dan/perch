// Perch 的组合根：这里也是**唯一**认识 Wails 的包。
//
// 下面的顺序不是风格，每一条都是实测或源码约束（见 docs/ARCHITECTURE.md
// 的启动顺序）：先读用户状态，再决定这一轮能不能写；SetHost 之后才能建
// 启动表；窗口建好之后才能问系统对话框；关窗确认要挂在 WindowClosing
// 的 hook 上，而不是 OnWindowEvent。
package main

import (
	"errors"
	"fmt"
	"github.com/yu7dan/perch/internal/agenttrust"
	"github.com/yu7dan/perch/internal/conpty"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	perchassets "github.com/yu7dan/perch"
	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/botbus"
	"github.com/yu7dan/perch/internal/botgroup"
	"github.com/yu7dan/perch/internal/ctl"
	"github.com/yu7dan/perch/internal/dsh"
	"github.com/yu7dan/perch/internal/install"
	"github.com/yu7dan/perch/internal/panes"
	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/providers"
	"github.com/yu7dan/perch/internal/session"
	"github.com/yu7dan/perch/internal/settings"
	"github.com/yu7dan/perch/internal/stream"
	"github.com/yu7dan/perch/internal/term"
	"github.com/yu7dan/perch/internal/transcript"
	"github.com/yu7dan/perch/internal/winproc"
)

// buildVersion 由构建脚本通过 -ldflags "-X main.buildVersion=..." 注入；
// 直接从源码 go build 时保持 "dev"。只用于日志里的可核对版本，不参与逻辑。
var buildVersion = "dev"

// perchApp 持有这一次运行的活状态。它只活在 main 的栈上 —— 没有可变包级
// 单例：每个 store/service 都是构造出来、注入下去的，后台协程拿的是函数值。
type perchApp struct {
	stateDir    string
	fallbackCWD string

	titles    *session.TitleStore
	prefs     *settings.Store
	providers *providers.Store
	botgroups *botgroup.Store
	coord     *botgroup.Coordinator
	pool      *project.Pool
	panes     *panes.Store
	tabs      *session.Manager

	defs map[string]agent.Def

	installer *install.Installer
	follower  *transcript.Follower
	push      *pushRelay
}

// teeLogToFile 让双击启动的 beta 也有日志可查：Explorer 里没有 stderr。
// 8MB 轮转一次，只留 perch.log 和 perch.log.1；拿不到目录就继续只写 stderr。
func teeLogToFile() {
	p, err := appdir.PerchFile("perch.log")
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	if fi, err := os.Stat(p); err == nil && fi.Size() > 8<<20 {
		_ = os.Remove(p + ".1")
		_ = os.Rename(p, p+".1")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	// 文件放第一个：双击启动时 os.Stderr 可能是无效句柄，写它会返回错误；
	// MultiWriter 遇到错误就停，放在后面才能保证文件一定拿到这一行。
	log.SetOutput(io.MultiWriter(f, os.Stderr))
}

// isProjectDropTarget accepts both the explicit attribute and the container
// ids/classes. WebView2 supplies the closest [data-file-drop-target] element,
// but accepting the ids keeps a drop working if a future Wails build omits
// the attribute map.
func isProjectDropTarget(d *application.DropTargetDetails) bool {
	if d == nil {
		return false
	}
	if d.Attributes["data-file-drop-target"] == "projects" {
		return true
	}
	switch d.ElementID {
	case "scroll", "proj-list", "un-view":
		return true
	}
	for _, c := range d.ClassList {
		if c == "proj" || c == "sect-projects" || c == "sect-sessions" {
			return true
		}
	}
	return false
}

func main() {
	teeLogToFile()
	if len(embeddedHook) > 0 {
		if _, err := session.InstallEmbeddedHook(embeddedHook); err != nil {
			log.Printf("[perch] 释放内嵌 hook 接收器失败：%v（状态栏会降级）", err)
		}
	}
	a := &perchApp{
		stateDir:    appdir.ClaudeState(),
		fallbackCWD: appdir.HomeOrDot(),
		push:        &pushRelay{},
	}
	log.Printf("[perch] 版本 %s（pid %d）", buildVersion, os.Getpid())
	// 自带的新版 ConPTY（照 Orca / node-pty 的 useConptyDll）：系统自带的那份会吞掉鼠标模式、
	// 改坏全屏 TUI 停放的光标（Pi 全屏模式滚不动历史、输入法跑偏）。放不好就用系统的，照常起格。
	if p, err := conpty.InstallBundled(); err != nil {
		log.Printf("[perch] 自带 ConPTY 用不了，退回系统 ConPTY：%v", err)
	} else {
		log.Printf("[perch] 用自带 ConPTY：%s", p)
	}

	// 状态根按 Claude Code 自己的规则取：环境里有 CLAUDE_CONFIG_DIR 就用它，
	// 否则 <用户主目录>\.claude。仓库里不留任何本机绝对路径。
	a.titles = session.LoadTitleStore(filepath.Join(a.stateDir, "titles.json"))
	// 设置要在池子**之前**载入：默认工作区路径会读里面的「默认目录」，
	// 而 EnsureDefaultWorkspace / 合成的默认工作区都走它。
	a.prefs = settings.Load()
	// 模型提供商与每个 agent 的配置：%APPDATA%\Perch\providers.json。
	if pf, err := appdir.PerchFile(providers.FileName); err == nil {
		a.providers = providers.Load(pf)
	} else {
		log.Printf("[providers] 拿不到配置目录，这轮只活在内存里：%v", err)
		a.providers = providers.Load("")
	}
	// Bot Group 的组清单与过程流：%APPDATA%Perchotgroups.json + botgroups<组>。
	bgDir := ""
	if pd, err := appdir.PerchDir(); err == nil {
		bgDir = pd
	}
	a.botgroups = botgroup.Load(bgDir)
	// Bot Group C（编排）：任务账本 + 协调器 + 本机总线（perch-bg 连这里）。
	a.coord = botgroup.NewCoordinator(botgroup.CoordDeps{Store: a.botgroups, Ledger: botgroup.NewLedger(bgDir), Push: a.push.Push,
		Lang: func() string {
			if a.prefs != nil && a.prefs.Snapshot().Language == "en" {
				return "en"
			}
			return "zh"
		}})
	if bus, err := botbus.Start(a.coord); err == nil {
		a.coord.SetBusURL(bus.URL)
	} else {
		log.Printf("[botbus] 起不来（Bot Group 的派活命令不可用）：%v", err)
	}
	a.coord.Run()
	a.pool = project.Load()
	// 「安装即存在」：默认工作区那个目录由我们建出来，因为新格没挑项目时会
	// 落在它里面（claude 起不来一个不存在的 cwd）。它不写进 projects.json ——
	// 合成的池子条目只在内存里（见 project.WithDefaultWorkspace）。
	project.EnsureDefaultWorkspace(a.customCWD)

	/* 步 7：单实例闸 —— 必须早于登记表被使用，因为它决定这份登记表能不能写。
	   取值逻辑只有一条：只要不是"明确地拿到了锁"，就按第二个实例处理
	   （判不出来 ≠ 可以放开跑）。 */
	secondInstance := false
	if ok, err := winproc.AcquireInstanceLock(winproc.InstanceMutexName); err != nil {
		secondInstance = true
		log.Printf("[perch] ⚠️ 单实例闸：判不出来（%v）→ 按「已经有别人在跑」处理：不恢复、不写登记表", err)
	} else if !ok {
		secondInstance = true
		log.Printf("[perch] 单实例闸：已经有一个我在跑 → 这一轮**不恢复任何会话**、也不写登记表（窗口照开，你可以在里面开新格）")
	} else {
		log.Printf("[perch] 单实例闸：拿到（%s）", winproc.InstanceMutexName)
	}

	// 格子登记表（冷恢复的输入）：只记**意图**（哪几格、各跑哪条会话），
	// 不记状态 —— 所以"重启后不许假装在跑"这件事不需要额外实现。
	// 和池子同一个目录，**绝不**写进 claude 的状态根（两家状态不许搅在一起）。
	if f, err := appdir.PerchFile("panes.json"); err != nil {
		log.Printf("[panes] 拿不到用户配置目录：%v", err)
		a.panes = panes.Load("", true)
	} else {
		a.panes = panes.Load(f, false)
	}
	if secondInstance {
		// 只读 = 不写；恢复那一步由 ctl 的 panes.query 应答挡。
		a.panes.SetReadOnly("已经有一个我在跑（步 7 的单实例闸）")
	}
	a.panes.Warn()
	// 名单精简后，旧名字（Gemini/Qwen/CodeBuddy…）的记录不再恢复、不再出现在
	// 左栏；只摘记录，磁盘上的会话文件保留。
	if n := a.panes.PruneAgents(agentcatalog.Exists, "Agent 名单精简"); n > 0 {
		log.Printf("[panes] 名单精简：摘掉 %d 条名单外 agent 记录（会话文件保留）", n)
	}

	// C3：第一个动作就是给自己上"随进程退出清理整棵树"的保险 ——
	// 必须早于任何子进程（窗口的 WebView2、每个格子的 ConPTY 都在这之后才起）。
	// 挂一次宿主，此后所有进程靠继承覆盖，不需要每格再管一次。
	winproc.OwnProcessTree()

	// 会话表：先只拿宿主能力；启动表要等 SetHost 之后才建。
	a.tabs = session.New(session.Deps{
		StateDir:     a.stateDir,
		Panes:        a.panes,
		Titles:       a.titles,
		DefaultCWD:   a.defaultCWD,
		ResolveExe:   winproc.ResolveExe,
		ProcessAlive: winproc.Alive,
		Push:         a.push.Push,
		// 能力矩阵要"能否启动"这条静态清单，由组合根注入 ——
		// 会话层不反过来认识 agent 名单。
		Caps: func(id string) agent.Caps { return agent.CapsFor(id, agentcatalog.Has(id)) },
	})
	// 登记表关格时用它区分“零轮次空壳”和“真跑过、有会话文件”。
	a.panes.SessionExists = a.tabs.SessionFileExistsFor
	// 步 8：适配器此后拿到的就是真正的会话表（绑定/状态/推送/Exe 解析）。
	agent.SetHost(a.tabs)
	// 步 9：Defs() 会走 Host.ResolveExe，所以**必须**在 SetHost 之后。
	a.defs = agentcatalog.Defs(a.stateDir)
	a.tabs.SetDefs(a.defs)

	// 每个 agent 的模型注入：开格前读 Perch 自己的「模型提供商」配置
	// （见 agentWireProfile）。没配的 agent 按它自己的登录/配置启动；
	// 所有 agent 都跑在用户真实的主目录里。
	a.tabs.SetWireProfile(a.agentWireProfile)
	// Bot Group 角色配置（抽屉里设的模型 / 强度 / 权限）：成员格每次起来现查。
	a.tabs.SetBotConfig(func(gid, bid string) (agent.BotConfig, bool) {
		for _, g := range a.botgroups.List() {
			if g.ID != gid {
				continue
			}
			for _, b := range g.Bots {
				if b.ID == bid {
					return agent.BotConfig{Model: b.Model, Effort: b.Effort, Permission: b.Permission, InGroup: true}, true
				}
			}
		}
		return agent.BotConfig{}, false
	})
	// Bot Group C：成员格起来时拿口令 + 总线地址、PATH 里放 perch-bg；忙闲变化和关格告诉协调器。
	a.tabs.SetOrchestration(a.coord.BotEnv, session.InstallBgCLI(embeddedBgCLI), a.coord.OnStatus, a.coord.TabClosed)
	// 设置 › 预先信任 agent 的工作文件夹（默认开）：起格前把 cwd 写进 agent 自己的信任记录。
	a.tabs.SetPreLaunch(func(tabID int, agentID, cwd string, env map[string]string) {
		if !agenttrust.Supported(agentID) || !a.prefs.Snapshot().TrustAgentFolders {
			return
		}
		out, err := agenttrust.Grant(agentID, cwd, env)
		if out == agenttrust.Unchanged {
			return
		}
		log.Printf("[startup t%d] 预先信任文件夹 %s（%s）：%s %v", tabID, cwd, agentID, out, errOrNil(err))
	})
	// dsh 的“状态”不是启动时顺手能做的：它要写用户的 DSH home patch，
	// 还要把官方 hook 桥和 peer 装进 dsh-tui profile。所以只放在两个
	// **用户明确点下**的动作里（安装完成 / 名单里的「接入状态」），不静默跑。
	setupAgent := func(id string, log func(string)) error {
		if id != "dsh" {
			return nil
		}
		// Perch 启动的 dsh 读的就是用户真实的 DSH home，hook 桥/home patch
		// 写进同一份即可。
		return dsh.EnsureHooks(a.stateDir, session.HookDir(a.stateDir), session.HookExePath(), log)
	}
	a.installer = install.New(install.Deps{
		Push: a.push.Push,
		Cards: func() []agentcatalog.Card {
			home, _ := os.UserHomeDir()
			return agentcatalog.Cards(home)
		},
		ReloadPath:   winproc.ReloadPathFromRegistry,
		ProbeVersion: winproc.ProbeVersion,
		Home:         os.UserHomeDir,
		Setup:        setupAgent,
	})

	app := application.New(application.Options{
		Name:        "Perch",
		Description: "面向 agent 终端的 Windows 桌面工作台",
		Icon:        appIcon,
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(perchassets.Assets),
		},
	})

	// 两条通道，职责分开：
	//   ctl        —— 常驻，纯 JSON 双向。前端唯一的控制面（建标签、落日志）。
	//   term:<id>  —— 每个标签一条，纯字节。PTY 的出口和键盘的入口。
	// 启动时**一个标签都没有** —— 标签由前端点出来（这样以后"恢复上次的标签"
	// 是纯前端的事，Go 侧不需要一份默认 spec）。
	// 处理函数到时候从 relay 取 ctl.Server（它在跟随器起来之后才构造）；
	// 流的 handler 只在**前端连上来时**才被调用（那一定在 app.Run 之后）。
	app.HandleStream("ctl", func(c *application.StreamConn) {
		if srv := a.push.Server(); srv != nil {
			srv.Serve(wailsConn{c})
		}
	})
	app.HandleStream("shell", func(c *application.StreamConn) {
		if srv := a.push.Server(); srv != nil {
			srv.ServeShell(wailsConn{c})
		}
	})

	// 默认窗口尺寸是**我们自己的值**，不是 Orca 的 —— Orca 的默认尺寸在它
	// 主进程的窗口创建代码里，那份文件不在我们抓到的源码范围内，不编。
	//
	// 取值依据是可测的：Claude Code 的开场介绍框需要 ≥64 列才不折行，
	// 而 1200px 窗口 + 240px 侧栏 + 原来的 62% 分栏只给到 60 列。
	// 1440 宽 + 74% 分栏让终端拿到 ~85 列，留出余量。
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "Perch",
		Width:  1440,
		Height: 900,

		// Frameless：去掉 Windows 原生标题栏，改由前端自绘 36px chrome。
		//
		// 这就是 Orca 在 Windows 上的做法。`src/main/window/createMainWindow.ts`：
		//
		//	titleBarStyle: process.platform === 'win32' ? 'hidden' : ...
		//	// Why: ... Windows 'hidden' removes the OS title bar so it doesn't double up.
		//
		// 它前端再按 `app-window-chrome.ts` 里的常量给这块留位置：
		//
		//	WINDOW_CONTROLS_WIDTH  = '138px'  // = 3 × 46px 窗口按钮
		//	WINDOW_CONTROLS_HEIGHT = '36px'   // 标题栏本身
		//
		// ⚠️ 不要设 DisableFramelessWindowDecorations。那个开关一开，
		// Win11 的圆角和 Aero 阴影会一起消失，窗口变成贴死的方片 ——
		// 默认（false）才是我们要的"无边框但仍是原生窗口"。
		Frameless: true,

		// 最小尺寸：Orca 是 600×400（`MIN_WIDTH`/`MIN_HEIGHT`），但那是
		// 适配它自己的侧栏可折叠布局。我们左边是**一列** 240px（2026-10-16 之前
		// 是 132+240 两列），600 宽会让终端只剩 20 来列、开场介绍框直接折行 ——
		// 所以这里按 **"终端至少 64 列"** 倒推：64×8.15px ≈ 522px 终端宽，
		// 除以 74% 分栏 ≈ 711px 的主区，再加 240px 固定列 ≈ 951。
		// ⚠️ 这个数是按"两列 372"算出来的（1080 → 951 也够用），导航栏删掉之后
		// 它只变得更宽裕，所以**不动**它 —— 但下次要改的时候照 951 重算，
		// 别再用那个 372。（JS 那边 `RSB_LEFT_PX` 是同一个数，那个必须跟着改，
		// 它管的是"右栏能拖多宽"，不改会白少算 132px。）
		MinWidth:  1080,
		MinHeight: 560,

		// 拖放只认左栏项目区（前端在 #proj-list/#un-view 上标了
		// data-file-drop-target="projects"）。别的区域落文件不会触发添加。
		EnableFileDrop: true,

		URL: "/",
	})

	// 原生拖放的路径只有 WebView2 知道；Go 只负责把事件转给前端，真正的
	// 项目校验/去重仍走 project.add（Pool.Add 会拒绝文件和不存在的目录）。
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		details := event.Context().DropTargetDetails()
		files := event.Context().DroppedFiles()
		if len(files) == 0 || !isProjectDropTarget(details) {
			log.Printf("[drop] 忽略窗口拖放（%d 项；落点不在项目区）", len(files))
			return
		}
		log.Printf("[drop] 项目区收到 %d 项（x=%d y=%d）", len(files), details.X, details.Y)
		application.Get().Event.Emit("perch:files-dropped", map[string]any{
			"files":   files,
			"details": details,
		})
	})

	ui := &systemUI{app: app, win: window}

	/* 关窗确认（设置页「关闭窗口前确认」）。
	   ⚠️ 必须用 **RegisterHook**，不是 OnWindowEvent：Wails 在构造窗口时先注册了一个
	   默认的 WindowClosing 监听器（它无条件关窗），监听器按注册序执行；hook 则在
	   它们**之前**同步跑，Cancel() 之后默认监听器和后面的监听器都不会执行 ——
	   这才是"先问一句，再决定关不关"能成立的地方（2026-10-18 核过 webview_window.go
	   的 handleWindowEvent：hooks → listeners）。
	   前端确认后发 window.close：guard 置位，这条路就直接放行。
	   前端不在（ctl 没连上/崩了）时放行 —— 确认是为了防手滑，不是为了锁死窗口。
	   状态与 30s 超时都在 ctl.CloseGuard 里：ctl 的 window.close 与这里必须看同一份。 */
	window.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		srv := a.push.Server()
		if srv == nil {
			return
		}
		cancel, emit := srv.Guard().ShouldAsk(a.prefs.Snapshot().ConfirmClose, srv.Connected())
		if !cancel {
			return
		}
		e.Cancel()
		if emit {
			window.EmitEvent("perch:close-request")
		}
	})

	// hooks：每个格子启动时现造一份**只对它生效**的 --settings（不碰用户的配置文件）。
	// 接收器不在 exe 旁边就造不出来 → 不注入，忙闲那条腿仍然可用。
	if exe := session.HookExePath(); exe == "" {
		log.Printf("[hook] 未注入 hooks：%s 不在 exe 旁边（忙闲仍来自 sessions\\<pid>.json）", session.HookExeName)
	} else {
		log.Printf("[hook] 已备好：%d 个事件（exec 形式 / 交互点 sync、其余 async / timeout=5s）接收器=%s 事件目录=%s",
			len(session.HookEventTypes), exe, session.HookDir(a.stateDir))
	}

	// 两条观察腿，一细一粗：
	//   hook 事件      —— 精确到轮次，带内容（Stop 的最后一句、Notification 的类型）
	//   会话登记表    —— 粗粒度忙闲，永远在（hook 没起来时它也告诉你谁在等你）
	// 两条都只写日志 + 推前端，**不碰 PTY 通道**：这一层坏掉最坏是"侧栏没数据"，
	// 绝不会让终端本身出问题。
	a.tabs.StartHookPoller()
	a.tabs.StartStatusPoller()
	// 第三条腿：跟着每个格子的转录文件走（「改动」和「流水」的数据源）。
	// 它靠 SessionStart 给的 transcript_path 才知道该跟哪个文件，所以排在 hooks 之后。
	a.follower = transcript.New(func() []transcript.View {
		live := a.tabs.Live()
		views := make([]transcript.View, 0, len(live))
		for _, v := range live {
			path, format := v.Transcript, ""
			// Claude 的路径由 hook 直接给（最权威）；其余 agent 由
			// internal/agent 按会话 id / 起始时间找。OpenCode 不在这里：
			// 它从 TUI 自己的 HTTP server 推流水（见 status.go 的 observeOpenCode）。
			if v.Agent != "claude" && v.Agent != "opencode" {
				f := agent.TranscriptFor(v.ID, v.Agent, v.CWD, v.SessionID, v.StartedAt)
				if f.Path != "" {
					path, format = f.Path, f.Format
				} else if v.Agent != "qoder" {
					// Qoder 有 hook 时路径在 v.Transcript；没有 hook 且还没
					// 找到文件时，不能拿 claude 那张旧路径顶上。
					path = ""
				}
			}
			if path == "" {
				continue
			}
			views = append(views, transcript.View{
				ID: v.ID, Agent: v.Agent, Transcript: path, CWD: v.CWD, Format: format,
			})
		}
		return views
	}, a.push.Push)
	a.follower.Start()

	// 控制通道的处理器：所有 store 都已就位，转录跟随器也刚起 ——
	// 它收的是跟随器的指针，所以构造必须排在这一行之后。
	ctlSrv := ctl.New(ctl.Deps{
		StateDir:       a.stateDir,
		SecondInstance: secondInstance,
		Version:        buildVersion,
		Tabs:           a.tabs,
		Panes:          a.panes,
		Titles:         a.titles,
		Pool:           a.pool,
		Prefs:          a.prefs,
		Providers:      a.providers,
		BotGroups:      a.botgroups,
		Coordinator:    a.coord,
		Installer:      a.installer,
		Transcript:     a.follower,
		DefaultCWD:     a.defaultCWD,
		SessionExists:  a.tabs.SessionFileExistsFor,
		SetupAgent:     setupAgent,
		// 顺序是硬约束：**先**注册流、**再**返回 —— ctl 接着就回 tab.ok，
		// 前端拿到应答会立刻去连那条流（Wails 在连接建立时才按名字查 handler）。
		CreateTab: func(spec session.SpawnSpec) *session.Tab {
			host := a.tabs.Create(spec)
			app.HandleStream(host.Stream, func(c *application.StreamConn) { a.handleTab(c, host) })
			return host
		},
		UI: ui,
	})
	a.push.Set(ctlSrv)

	/* 关窗那一刻**同步**把登记表写一遍（写的是内存里那份，见 panes.Store.FlushSync）。
	   ⚠️ 为什么挂在**窗口事件**上而不是 app.OnShutdown —— 2026-10-16 实测：
	   OnShutdown 那条路在"用户关窗口"时**根本不跑**。Windows 上关掉最后一个窗口走的是
	   `unregisterWindow` → `PostQuitMessage(0)`（application_windows.go:348-357），
	   而跑 OnShutdown 那些任务的 `cleanup()` 只挂在 `destroy()`（:196-205）上，
	   后者由 `App.Quit()` 调 —— 关窗口这条路两者都不经过：Run() 直接返回、main() 返回、
	   进程退出。判据是日志：优雅关窗之后，最后一行是 `tab=1 收尾`，而
	   `[panes] 收尾…` 一声没出（我原以为它跑了，是日志把这件事说穿的）。
	   `WindowClosing` 才是这条路上真的会响的那个事件（webview_window_windows.go:1681-1685，
	   原生 WM_CLOSE 也走它），而且它在窗口销毁**之前**、在同一个调用栈里 —— 来得及写。
	   为什么已经有 leading-edge 节流还要这一道：Windows 上"更新/重启把进程带走"
	   会漏掉一切"等到最后再写"的设计（Orca 的 server-constants.ts:12-14 记的正是这个坑）。
	   节流负责"平时一直在写"，这一条负责"真到最后一刻也写完"。 */
	window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		a.panes.FlushSync("窗口正在关闭")
	})
	// 兜底（**留着，但它不是关窗那条路**）：App.Quit() / 信号那几条退出路会跑
	// OnShutdown 那串任务，顺序照注册序 —— 里面最先跑的是 Wails 自己的
	// `streams.close`（构造时注册，application.go:79），所以轮到我们时，每个格子的
	// `defer tabs.Drop` 都已经执行完了 ⇒ **只许写内存记录，不许从 tabs.Live() 现取**
	// （那时它是空的，取出来是一张空表，而且不报错）。
	app.OnShutdown(func() {
		a.panes.FlushSync("应用收尾（Quit/信号）")
	})

	// Must be before app.Run: Wails exits while making the first window when
	// WebView2 is absent, and there would be no surface to explain that.
	if !webView2Check(app) {
		return
	}

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// customCWD 把设置里的「默认目录」注入项目池；空串 = 用内置目录。
// termMsg 是写进 PTY 的兜底提示。终端内容不归前端 i18n runtime 管（那是
// PTY 的字节流，不是页面 DOM），所以这里只能后端自己选词：显式 en/zh 跟设置
// 走；auto 给双语 —— 后端看不到 navigator.languages，猜错一门比两门都写出来
// 更糟。detail 里是进程/系统的原文，不再翻译。
func (a *perchApp) termWord(en, zh string) string {
	if a.prefs != nil {
		switch a.prefs.Snapshot().Language {
		case "en":
			return en
		case "zh":
			return zh
		}
	}
	return en + " / " + zh
}

func (a *perchApp) termMsg(en, zh, detail string) []byte {
	text := a.termWord(en, zh)
	if detail != "" {
		text += ": " + detail
	}
	return []byte("\r\n\x1b[31m[perch] " + text + "\x1b[0m\r\n")
}

func (a *perchApp) customCWD() string { return a.prefs.Snapshot().DefaultCWD }

// defaultCWD 是「新格没指定目录时落在哪」的**唯一**答案。
// 2026-10-16 起它是默认工作区（<用户主目录>\Documents\Perch）—— 左栏末尾那一行
// 就是它，用户没挑项目时新格就该落在它那里（Claude / Codex 桌面端也是这么办的）。
// 拿不到用户主目录才退回 fallbackCWD。
// ⚠️ session.Manager.Live() 报"这一格在哪个目录跑"必须用**同一个**函数：两处各写
// 一遍，报出来的 cwd 和真正起 PTY 用的 cwd 会在"拿不到主目录"的机器上悄悄分叉 ——
// 而那种分叉从界面上看不出来，只会表现为"某个动作在这个目录里失败"。
func (a *perchApp) defaultCWD() string {
	if p := project.DefaultWorkspaceCWD(a.customCWD); p != "" {
		return p
	}
	return a.fallbackCWD
}

// 无项目 Agent 现在直接使用默认工作区根目录；旧版本建出来的
// sessions\<...> 目录仍留在盘上，左栏按“旧临时目录”分组。
// agentWireProfile 是 session.Manager 开格前的注入点：读 Perch 自己的
// 「模型提供商」配置。
//
// 只做 Perch 自己的配置：注入只落在这一格的进程上，绝不写 agent 的全局配置。
//   - 这个 agent 什么都没配：ok=false，按 agent 自己的登录 / 配置启动；
//   - 配了但接不上（协议不对、缺模型、key 解不开）：返回 error，这一格不启动，
//     终端里说清原因 —— 不能静默回退到 agent 自己的登录（那样看到的是 401）。
func (a *perchApp) agentWireProfile(id string) (map[string]string, []string, bool, error) {
	if a.providers == nil {
		return nil, nil, false, nil
	}
	r, ok, err := a.providers.Resolve(id)
	if err != nil {
		return nil, nil, false, err
	}
	if !ok {
		return nil, nil, false, nil
	}
	home, _ := os.UserHomeDir()
	l, err := providers.Build(id, r, home)
	if err != nil {
		log.Printf("[providers] agent %s 的配置接不上：%v", id, err)
		return nil, nil, false, err
	}
	pname := "(无)"
	if r.Provider != nil {
		pname = r.Provider.Name
	}
	// 只记变量名，不记值（值里有 key）。
	names := make([]string, 0, len(l.Env))
	for k := range l.Env {
		names = append(names, k)
	}
	sort.Strings(names)
	log.Printf("[providers] agent %s 注入：提供商=%s 模型=%s 强度=%s env=%v 参数 %d 个",
		id, pname, pick(r.Model, "(默认)"), pick(r.Effort, "(默认)"), names, len(l.Args))
	return l.Env, l.Args, true, nil
}

// openInWindowsTerminal 用 Windows Terminal 打开同一个 cwd 的 claude。
//
// 存在的唯一理由是**对比**：渲染质量的差距只能靠眼睛判断，
// 而这个对比恰好也是「能不能把官方原生的嵌进来」这个问题的答案 ——
// Windows Terminal 是独立进程 + XAML/DirectWrite 渲染管线，没有任何嵌入 API，
// 所以「走原生」在物理上就等于「把终端放到我们窗口外面去」。
// 让用户亲眼看到这一点，比我在文字里断言强。
//
// ⚠️ C7（2026-10-16）：这条路现在**没有入口**了 —— 标签条上那颗带字的
// 「原生对比」胶囊删掉了（理由与它当初为什么放在那儿，见 assets/index.html
// 标签条右侧那段注释）。这条 ctl（"open-wt"）和下面整个函数**留着**：
// 要接回来只需要在格子头的 ⋯ 菜单里加一项、发同一个 ctl。
// 也因此，这条路本身**至今没有被点过一次**（上次交付时如实报的"未验证"，
// 现在状态变成"已下线"，不是"验过了"）。
func (a *perchApp) openInWindowsTerminal(spec session.SpawnSpec) {
	def, ok := a.defs[spec.Agent]
	if !ok {
		log.Printf("[perch] 未知 agent %q，无法在 Windows Terminal 中打开", spec.Agent)
		return
	}
	// 参数翻译走**同一个** a.defs.Args —— 对比窗口和嵌进来的窗口必须是同一个
	// 会话意图，否则这个"对比"就成了两个不同的东西，没有可比性。
	agentArgs := append(append([]string{}, def.Prefix...), def.Args(spec.Resume, session.BuildHookSettings(a.stateDir, "wt"))...)
	tail := append([]string{"-d", spec.CWD, def.Exe}, agentArgs...)
	cmd := exec.Command("wt.exe", tail...)
	cmd.Env = agent.BuildEnv(def.Env)
	// 「在 WT 里打开」是**交出去**的意思：那个窗口不是我们的子界面，不该随 Perch
	// 一起被清掉，而 C3 的 job 会连带杀掉所有子进程 —— 所以这里显式请求脱离。
	// 这是那个 BREAKAWAY_OK 标志的存在理由之一（见 internal/winproc/job_windows.go 文件头 ②），
	// 也把"哪种东西该活下来"写进了代码里，而不是碰运气。
	cmd.SysProcAttr = winproc.HandoffSysProcAttr()
	if err := cmd.Start(); err != nil {
		log.Printf("[perch] 启动 Windows Terminal 失败: %v", err)
		_ = exec.Command("cmd", append([]string{"/c", "start", "", "wt.exe"}, tail...)...).Start()
		return
	}
	log.Printf("[perch] 已在 Windows Terminal 中打开 pid=%d", cmd.Process.Pid)
}

// handleTab 是**一个标签**的数据通道：Go → 前端是 PTY 原始字节，
// 前端 → Go 是键盘原始字节 + 0xFF 打头的控制帧。
//
// 这条通道的寿命就是标签的寿命：前端关掉标签 = 关掉这条流 = 本函数返回
// = `defer running.Close()` 收掉 ConPTY。**所以不需要一条"关闭标签"的控制帧** ——
// 少一个能跟真实状态不同步的开关。
func (a *perchApp) handleTab(c *application.StreamConn, host *session.Tab) {
	defer c.Close()
	defer a.tabs.Drop(host.ID)
	// C3 的观察腿（格子收尾这一端）：这一格关了之后，job 里还剩谁。
	// 和下面"起来后"那条配对 —— 两条合起来才能看出"这一格带走了什么、留下了什么"。
	defer winproc.LogJobInventory(fmt.Sprintf("tab=%d 收尾", host.ID))

	// 流的一生（握手、唯一的读协程、原始字节转发、四个控制帧）在 stream 包里。
	// Close 的时机和以前的 done 一样：本函数一返回就让读协程撤
	// （防它卡在塞帧上 —— 那时它不在 Receive 里，c.Close 叫不醒它）。
	srv := stream.New(wailsConn{c}, stream.Callbacks{
		TabID:  host.ID,
		OpenWT: func() { go a.openInWindowsTerminal(host.Spec) },
		Rename: func(pid int, name string) { session.ApplyRename(a.stateDir, a.titles, pid, name) },
		Log:    func(msg string) { log.Printf("[web t%d] %s", host.ID, msg) },
		NewOSC: func() stream.OSC { return term.NewOSCResponder() },
		// 终端里那行「进程已退出」也跟界面语言走。
		ExitNotice: a.termWord("Process exited", "进程已退出"),
	})
	defer srv.Close()
	cols, rows, pending, err := srv.AwaitInitialSize()
	if err != nil {
		return
	}

	running, err := a.tabs.StartTab(host, cols, rows)
	if err != nil {
		var se *session.StartError
		if errors.As(err, &se) {
			switch se.Stage {
			case session.StageUnknownAgent:
				log.Printf("[perch] tab=%d 未知 agent %q", host.ID, se.Agent)
				_ = c.Send(a.termMsg("Unknown agent", "未知 agent", se.Agent))
			case session.StageProfile:
				log.Printf("[perch] tab=%d 模型提供商配置未生效: %v", host.ID, se.Err)
				_ = c.Send(a.termMsg(
					"This agent's model-provider settings could not be applied; check Settings > Agents",
					"这个 agent 的模型提供商配置没有生效，请检查「设置 > Agents」",
					se.Err.Error()))
			case session.StagePrepare:
				log.Printf("[perch] tab=%d 启动准备失败: %v", host.ID, se.Err)
				_ = c.Send(a.termMsg("Start preparation failed", "启动准备失败", se.Err.Error()))
			default:
				log.Printf("[perch] tab=%d 启动失败: %v", host.ID, se.Err)
				_ = c.Send(a.termMsg("Start failed", "启动失败", se.Err.Error()))
			}
		} else {
			log.Printf("[perch] tab=%d 启动失败: %v", host.ID, err)
			_ = c.Send(a.termMsg("Start failed", "启动失败", err.Error()))
		}
		return
	}
	defer running.Close()
	// 状态观察者跟着这条 PTY 的生命周期走：流一断/进程一关，ctx 就取消。
	defer running.StopObserve()
	// C3 的观察腿（格子起来这一端）：这一格的 claude 是靠**继承**进 job 的
	// （我们从没单独 assign 过它）—— 这句话是不是真的，问内核拿清单看。
	winproc.LogJobInventory(fmt.Sprintf("tab=%d pid=%d 起来后", host.ID, running.Pid()))

	// 进程退出看门狗、PTY→前端、前端→PTY 都在 Serve 里；它返回 = 这条流结束。
	srv.Serve(running.Session, pending)
}

func pick(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

func errOrNil(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
