package main

import (
	"embed"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/ctl"
	"github.com/yu7dan/perch/internal/stream"
)

//go:embed assets
var assets embed.FS

// 状态根，以及"拿不到用户主目录时落在哪"的兜底。
// 可执行文件**不在代码里写死**了 —— 见下面的 agentDefs。
//
// ⚠️ 仓库里**不留任何本机绝对路径**（发布清理的一部分）：状态根按 Claude Code
// 自己的规则取 —— 环境里有 CLAUDE_CONFIG_DIR 就用它，否则 <用户主目录>\.claude。
// 这样换一台机器、换一个用户，索引到的就是那个人自己的会话库。
var claudeStateDir = appdir.ClaudeState()

// fallbackCWD 只在**拿不到用户主目录**时兜底（那种情况下总不能连格都起不来）。
var fallbackCWD = appdir.HomeOrDot()

// defaultCWD 是「新格没指定目录时落在哪」的**唯一**答案。
// 2026-10-16 起它是默认工作区（<用户主目录>\Documents\Perch，见 internal/project）——
// 左栏末尾那一行就是它，用户没挑项目时新格就该落在它那里（Claude / Codex 桌面端
// 也是这么办的）。拿不到用户主目录才退回 fallbackCWD。
// ⚠️ session.Manager.Live() 报"这一格在哪个目录跑"必须用**同一个**函数：两处各写一遍，
// 报出来的 cwd 和真正起 PTY 用的 cwd 会在"拿不到主目录"的机器上悄悄分叉 ——
// 而那种分叉从界面上看不出来，只会表现为"某个动作在这个目录里失败"。
func defaultCWD() string {
	if p := defaultWorkspaceCWD(); p != "" {
		return p
	}
	return fallbackCWD
}

// 标签的形状（spawnSpec / resumeIntent）在 internal/session 与 internal/agent；
// 这里只留组合根需要的别名（见 session_bridge.go）。
//
// agentDef / resumeIntent 的字段定义在 internal/agent（见 agent_bridge.go 的别名）。
// 新增一个深度适配的 agent = 在那个包里加一份构造函数，别处不用改。

// agentDefs 是本机可启动的 agent 表。清单、能力、配方、Exe 解析全在
// internal/agentcatalog；这里只留启动表本身。
//
// ⚠️ 只能在 main 里、**agent.SetHost 之后**构造，不能做成包级字面量或 init：
// Defs 会走 agent.Host.ResolveExe，先建表会拿到占位实现给出的 exe。
// 这是组合期的顺序，不是风格（见 docs/ARCHITECTURE.md 的启动顺序）。
var agentDefs map[string]agentDef

// globalApp 只是为了在**运行期**注册新的 stream handler（见 session.Manager.Create）。
var globalApp *application.App

// mainWindow 是主窗口本身。存下来只为一件事：ctl 收到 attention 时闪任务栏
// （窗口是建的时候顺手丢掉的返回值，别处都不需要它）。
var mainWindow *application.WebviewWindow

// ctlServer 是前端那条常驻控制通道（协议与句柄在 internal/ctl）。它在 main
// 里构造（依赖都先就位），构造后这里只剩三处接缝：注册流、推送、关窗确认。
var ctlServer *ctl.Server

// pushJSON 把一条消息推给前端。真正的锁与连接在 ctl.Server —— 这里的函数
// 只是旧调用点（会话表/安装器/网关在初始化时拿到的函数值）的接缝。
func pushJSON(v any) {
	if ctlServer != nil {
		ctlServer.Push(v)
	}
}

// titlesStore 是用户给会话起的名字（见 internal/session/titles.go）。在 main 里初始化 ——
// 它要读盘，放在包级变量的初始化里会让"读盘失败"发生在 log 还没配好之前。
var titlesStore *titleStore

// pool 是项目池（见 internal/project）。**同样在 main 里初始化**，理由同上；
// nil = 没起来（拿不到配置目录），这时候所有 project.* 都是 no-op 并在
// 日志里说清楚 —— 半死不活的池子（能读不能写）比明确的不可用更难查。
var pool *projectPool

// prefsStore 是 Perch 自己的偏好（见 internal/settings）。必须在 pool 之前载入 ——
// 默认工作区路径会读它。nil = 还没初始化（只有测试路径会见到）。
var prefsStore *settingsStore

// panes 是格子登记表（冷恢复的输入）。nil = 没起来（拿不到用户配置目录），
// 这时候所有记录动作都是 no-op —— 冷恢复这一轮退化成现状（一个默认格）。
var panes *paneStore

// tabs 是会话表（见 internal/session）。在 main 里构造 —— 它要 titles/panes
// 先就位，而且必须在 agent.SetHost 之前。
var tabs *tabManager

// secondInstance = 这台机器上已经有一个我在跑（见 internal/winproc 的单实例闸）。
// 它的作用有两个，缺一不可：
//
//	· panes.query 一律回"登记表不可用" ⇒ 前端**一个座位都不恢复**（它拿不到清单）；
//	· 登记表按**只读**对待 ⇒ 它那一格的变动一个字节都不落盘。
//
// 为什么第二条不能省：写盘是**整份重写**的，第二个实例手里那份清单天生残缺
// ——它写一次就等于把第一个实例的座位表按残缺的那份覆盖掉（8 格变 1 格，不报错）。
var secondInstance bool

func main() {
	titlesStore = loadTitleStore(filepath.Join(claudeStateDir, "titles.json"))
	// 设置要在池子**之前**载入：默认工作区路径会读里面的「默认目录」，
	// 而 ensureDefaultWorkspace / 合成的默认工作区都走它。
	prefsStore = loadSettingsStore()
	pool = loadProjectPool()
	// 「安装即存在」那条要求落地的就是这一句：默认工作区那个目录**由我们建出来**，
	// 因为新格没挑项目时会落在它里面（claude 起不来一个不存在的 cwd）。
	// 它不写进 projects.json —— 合成的池子条目只在内存里（见 project.WithDefaultWorkspace）。
	ensureDefaultWorkspace()

	/* 步 7：单实例闸 —— **必须早于登记表被使用**，因为它决定这份登记表能不能写。
	   判据与代价见 internal/winproc 的单实例闸。这里的取值逻辑只有一条：
	   只要不是"明确地拿到了锁"，就按第二个实例处理（判不出来 ≠ 可以放开跑）。 */
	if ok, err := acquireInstanceLock(instanceMutexName); err != nil {
		secondInstance = true
		log.Printf("[perch] ⚠️ 单实例闸：判不出来（%v）→ 按「已经有别人在跑」处理：不恢复、不写登记表", err)
	} else if !ok {
		secondInstance = true
		log.Printf("[perch] 单实例闸：已经有一个我在跑 → 这一轮**不恢复任何会话**、也不写登记表（窗口照开，你可以在里面开新格）")
	} else {
		log.Printf("[perch] 单实例闸：拿到（%s）", instanceMutexName)
	}

	// 格子登记表（冷恢复的输入，见 internal/panes）。它只记**意图**（哪几格、各跑哪条
	// 会话），不记状态 —— 所以"重启后不许假装在跑"这件事不需要额外实现。
	panes = loadPaneStore()
	if secondInstance && panes != nil {
		// 只读 = 不写；恢复那一步由 panes.query 的应答挡（见下面那段）。
		panes.SetReadOnly("已经有一个我在跑（步 7 的单实例闸）")
	}
	panes.Warn()

	// C3：**第一个动作**就是给自己上"随进程退出清理整棵树"的保险 ——
	// 必须早于任何子进程（窗口的 WebView2、每个格子的 ConPTY 都在这之后才起）。
	// 挂一次宿主，此后所有进程靠继承覆盖，不需要每格再管一次。
	ownProcessTree()

	// 会话表（步 7）：先只拿宿主能力；启动表要等 SetHost 之后才建。
	tabs = newSessionManager()
	// 步 8：适配器此后拿到的就是真正的会话表（绑定/状态/推送/Exe 解析）。
	agent.SetHost(tabs)
	// 步 9：Defs() 会走 Host.ResolveExe，所以**必须**在 SetHost 之后。
	agentDefs = agentcatalog.Defs(claudeStateDir)
	tabs.SetDefs(agentDefs)

	app := application.New(application.Options{
		Name:        "Perch",
		Description: "面向 agent 终端的 Windows 桌面网关",
		Assets: application.AssetOptions{
			// /gwui/ 只做一次跳转：把网关页的 iframe 指到本地反代
			// （见 internal/gateway/ui.go；真正的 /gwui/* 与 /api/* 在 127.0.0.1 的
			// 随机端口上，因为 Wails 这一版交给 asset handler 的
			// POST 请求没有请求体）。其余路径仍由嵌入的 assets 提供。
			Handler: gwUIHandler(application.BundledAssetFileServer(assets)),
		},
	})
	// 标签是运行期创建的，创建时要 HandleStream —— 拿不到 app 就注册不了。
	globalApp = app

	// 两条通道，职责分开：
	//   ctl        —— 常驻，纯 JSON 双向。前端唯一的控制面（建标签、落日志）。
	//   term:<id>  —— 每个标签一条，纯字节。PTY 的出口和键盘的入口。
	// 启动时**一个标签都没有** —— 标签由前端点出来（这样以后"恢复上次的标签"
	// 是纯前端的事，Go 侧不需要一份默认 spec）。
	// 处理函数引用 ctlServer 变量，而它在窗口建好、转录跟随器起来之后才构造；
	// 流的 handler 只在**前端连上来时**才被调用（那一定在 app.Run 之后），
	// 所以这里注册的是"到时候用那个 server"，不是它此刻的值。
	app.HandleStream("ctl", func(c *application.StreamConn) { ctlServer.Serve(wailsConn{c}) })
	app.HandleStream("shell", func(c *application.StreamConn) { ctlServer.ServeShell(wailsConn{c}) })

	// 默认窗口尺寸是**我们自己的值**，不是 Orca 的 —— Orca 的默认尺寸在它
	// 主进程的窗口创建代码里，那份文件不在我们抓到的源码范围内，不编。
	//
	// 取值依据是可测的：Claude Code 的开场介绍框需要 ≥64 列才不折行，
	// 而 1200px 窗口 + 240px 侧栏 + 原来的 62% 分栏只给到 60 列。
	// 1440 宽 + 74% 分栏让终端拿到 ~85 列，留出余量。
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
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

		URL: "/",
	})

	/* 关窗确认（设置页「关闭窗口前确认」）。
	   ⚠️ 必须用 **RegisterHook**，不是 OnWindowEvent：Wails 在构造窗口时先注册了一个
	   默认的 WindowClosing 监听器（它无条件关窗），监听器按注册序执行；hook 则在
	   它们**之前**同步跑，Cancel() 之后默认监听器和后面的监听器都不会执行 ——
	   这才是"先问一句，再决定关不关"能成立的地方（2026-10-18 核过 webview_window.go
	   的 handleWindowEvent：hooks → listeners）。
	   前端确认后发 window.close：guard 置位，这条路就直接放行。
	   前端不在（ctl 没连上/崩了）时放行 —— 确认是为了防手滑，不是为了锁死窗口。
	   状态与 30s 超时都在 ctl.CloseGuard 里：ctl 的 window.close 与这里必须看同一份。 */
	mainWindow.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		confirm := prefsStore != nil && prefsStore.Snapshot().ConfirmClose
		cancel, emit := ctlServer.Guard().ShouldAsk(confirm, ctlServer.Connected())
		if !cancel {
			return
		}
		e.Cancel()
		if emit {
			mainWindow.EmitEvent("perch:close-request")
		}
	})

	// hooks：每个格子启动时现造一份**只对它生效**的 --settings（不碰用户的配置文件）。
	// 接收器不在 exe 旁边就造不出来 → 不注入，忙闲那条腿仍然可用。
	if exe := hookExePath(); exe == "" {
		log.Printf("[hook] 未注入 hooks：%s 不在 exe 旁边（忙闲仍来自 sessions\\<pid>.json）", sessionHookExeName)
	} else {
		log.Printf("[hook] 已备好：%d 个事件（exec 形式 / 交互点 sync、其余 async / timeout=5s）接收器=%s 事件目录=%s",
			hookEventCount(), exe, hookDir())
	}

	// 两条观察腿，一细一粗：
	//   hook 事件      —— 精确到轮次，带内容（Stop 的最后一句、Notification 的类型）
	//   会话登记表    —— 粗粒度忙闲，永远在（hook 没起来时它也告诉你谁在等你）
	// 两条都只写日志 + 推前端，**不碰 PTY 通道**：这一层坏掉最坏是"侧栏没数据"，
	// 绝不会让终端本身出问题。
	tabs.StartHookPoller()
	tabs.StartStatusPoller()
	// 第三条腿：跟着每个格子的转录文件走（「改动」和「流水」的数据源）。
	// 它靠 SessionStart 给的 transcript_path 才知道该跟哪个文件，所以排在 hooks 之后。
	startTranscriptFollower(pushJSON)

	// 控制通道的处理器：所有 store 都已就位，转录跟随器也刚起 ——
	// 它收的是跟随器的指针，所以构造必须排在这一行之后。
	ctlServer = ctl.New(ctl.Deps{
		StateDir:       claudeStateDir,
		SecondInstance: secondInstance,
		Tabs:           tabs,
		Panes:          panes,
		Titles:         titlesStore,
		Pool:           pool,
		Prefs:          prefsStore,
		Gateway:        gw,
		Installer:      installer,
		Transcript:     transcriptFollower,
		DefaultCWD:     defaultCWD,
		SessionExists:  sessionFileExistsFor,
		// 顺序是硬约束：**先**注册流、**再**返回 —— ctl 接着就回 tab.ok，
		// 前端拿到应答会立刻去连那条流（Wails 在连接建立时才按名字查 handler）。
		CreateTab: func(spec spawnSpec) *tabHost {
			host := tabs.Create(spec)
			globalApp.HandleStream(host.Stream, func(c *application.StreamConn) { handleTab(c, host) })
			return host
		},
		UI: wailsUI{},
	})

	// 网关读数（只读）：本机那份立刻出，HTTP 那条腿在后台 2.5s 一次。
	// 它不参与任何 PTY/会话逻辑 —— 网关关着时最坏也只是总览少几张读数。
	startMagpieWatcher(pushJSON)
	// 控制面只做**被动探测**：接已经存在的那个，不在这里拉起 magpie web ——
	// 用户没点「连接」之前，Perch 不该多出一个后台进程。
	go gwProbe()

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
	mainWindow.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		if panes != nil {
			panes.FlushSync("窗口正在关闭")
		}
		// Perch 自己拉起的 magpie web 随窗口一起收掉；外部控制面（桌面 magpie
		// 或用户自己起的）只断开连接，不动进程。关窗这条路不经过 OnShutdown，
		// 所以必须挂在这里（见上面那段实测）。
		gwStop()
	})
	// 兜底（**留着，但它不是关窗那条路**）：App.Quit() / 信号那几条退出路会跑
	// OnShutdown 那串任务，顺序照注册序 —— 里面最先跑的是 Wails 自己的
	// `streams.close`（构造时注册，application.go:79），所以轮到我们时，每个格子的
	// `defer tabs.drop` 都已经执行完了 ⇒ **只许写内存记录，不许从 tabs.live() 现取**
	// （那时它是空的，取出来是一张空表，而且不报错）。
	app.OnShutdown(func() {
		gwStop()
		if panes != nil {
			panes.FlushSync("应用收尾（Quit/信号）")
		}
	})

	// 网关页内嵌 magpie 界面所需的本地反代（127.0.0.1，随机端口 + token）。
	// 必须在 Run 之前起：页面首帧就可能落到网关页。
	gwUIStart()

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
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
func openInWindowsTerminal(spec spawnSpec) {
	def, ok := agentDefs[spec.Agent]
	if !ok {
		log.Printf("[perch] 未知 agent %q，无法在 Windows Terminal 中打开", spec.Agent)
		return
	}
	// 参数翻译走**同一个** agentDefs.Args —— 对比窗口和嵌进来的窗口必须是同一个
	// 会话意图，否则这个"对比"就成了两个不同的东西，没有可比性。
	agentArgs := append(append([]string{}, def.Prefix...), def.Args(spec.Resume, buildHookSettings("wt"))...)
	tail := append([]string{"-d", spec.CWD, def.Exe}, agentArgs...)
	cmd := exec.Command("wt.exe", tail...)
	cmd.Env = buildEnv(def.Env)
	// 「在 WT 里打开」是**交出去**的意思：那个窗口不是我们的子界面，不该随 Perch
	// 一起被清掉，而 C3 的 job 会连带杀掉所有子进程 —— 所以这里显式请求脱离。
	// 这是那个 BREAKAWAY_OK 标志的存在理由之一（见 internal/winproc/job_windows.go 文件头 ②），
	// 也把"哪种东西该活下来"写进了代码里，而不是碰运气。
	cmd.SysProcAttr = handoffSysProcAttr()
	if err := cmd.Start(); err != nil {
		log.Printf("[perch] 启动 Windows Terminal 失败: %v", err)
		_ = exec.Command("cmd", append([]string{"/c", "start", "", "wt.exe"}, tail...)...).Start()
		return
	}
	log.Printf("[perch] 已在 Windows Terminal 中打开 pid=%d", cmd.Process.Pid)
}

// handleShell 一次性把界面骨架要的数据推给前端。
//
// 用 Stream 而不是开 HTTP 路由，是因为流通道是已经跑通的那条，
// 不引入任何新的 API 面（beta 版里少一个未知数就是少一个坑）。
// 推完必须**等一下再关** —— 立刻 Close 会把刚写出去的那帧一起带走。
// handleTab 是**一个标签**的数据通道：Go → 前端是 PTY 原始字节，
// 前端 → Go 是键盘原始字节 + 0xFF 打头的控制帧。
//
// 这条通道的寿命就是标签的寿命：前端关掉标签 = 关掉这条流 = 本函数返回
// = `defer running.Close()` 收掉 ConPTY。**所以不需要一条"关闭标签"的控制帧** ——
// 少一个能跟真实状态不同步的开关。
func handleTab(c *application.StreamConn, host *tabHost) {
	defer c.Close()
	defer tabs.Drop(host.ID)
	// C3 的观察腿（格子收尾这一端）：这一格关了之后，job 里还剩谁。
	// 和下面"起来后"那条配对 —— 两条合起来才能看出"这一格带走了什么、留下了什么"。
	defer logJobInventory(fmt.Sprintf("tab=%d 收尾", host.ID))

	// 流的一生（握手、唯一的读协程、原始字节转发、四个控制帧）在 stream 包里。
	// Close 的时机和以前的 done 一样：本函数一返回就让读协程撤
	// （防它卡在塞帧上 —— 那时它不在 Receive 里，c.Close 叫不醒它）。
	srv := stream.New(wailsConn{c}, stream.Callbacks{
		TabID:  host.ID,
		OpenWT: func() { go openInWindowsTerminal(host.Spec) },
		Rename: func(pid int, name string) { applyRename(claudeStateDir, titlesStore, pid, name) },
		Log:    func(msg string) { log.Printf("[web t%d] %s", host.ID, msg) },
		NewOSC: func() stream.OSC { return newOSCColorResponder() },
	})
	defer srv.Close()
	cols, rows, pending, err := srv.AwaitInitialSize()
	if err != nil {
		return
	}

	running, err := tabs.StartTab(host, cols, rows)
	if err != nil {
		var se *startError
		if errors.As(err, &se) {
			switch se.Stage {
			case startStageUnknownAgent:
				log.Printf("[perch] tab=%d 未知 agent %q", host.ID, se.Agent)
				_ = c.Send([]byte("\r\n\x1b[31m[perch] 未知 agent: " + se.Agent + "\x1b[0m\r\n"))
			case startStagePrepare:
				log.Printf("[perch] tab=%d 启动准备失败: %v", host.ID, se.Err)
				_ = c.Send([]byte("\r\n\x1b[31m[perch] 启动准备失败: " + se.Err.Error() + "\x1b[0m\r\n"))
			default:
				log.Printf("[perch] tab=%d 启动失败: %v", host.ID, se.Err)
				_ = c.Send([]byte("\r\n\x1b[31m[perch] 启动失败: " + se.Err.Error() + "\x1b[0m\r\n"))
			}
		} else {
			log.Printf("[perch] tab=%d 启动失败: %v", host.ID, err)
			_ = c.Send([]byte("\r\n\x1b[31m[perch] 启动失败: " + err.Error() + "\x1b[0m\r\n"))
		}
		return
	}
	defer running.Close()
	// 状态观察者跟着这条 PTY 的生命周期走：流一断/进程一关，ctx 就取消。
	defer running.StopObserve()
	// C3 的观察腿（格子起来这一端）：这一格的 claude 是靠**继承**进 job 的
	// （我们从没单独 assign 过它）—— 这句话是不是真的，问内核拿清单看。
	logJobInventory(fmt.Sprintf("tab=%d pid=%d 起来后", host.ID, running.Pid()))

	// 进程退出看门狗、PTY→前端、前端→PTY 都在 Serve 里；它返回 = 这条流结束。
	srv.Serve(running.Session, pending)
}
