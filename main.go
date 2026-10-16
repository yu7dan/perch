package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed assets
var assets embed.FS

// ctrlPrefix 是控制帧的起始字节。
// xterm 的键盘输入只会产生 0x00–0x7F 的字节，0xFF 不可能出现在真实终端输入里，
// 所以用它来区分「控制帧」和「原样透传的终端输入」。
const ctrlPrefix = 0xFF

// spike 阶段的写死项：默认工作目录和状态根。
// 可执行文件**不再在这儿写死一个**了 —— 见下面的 agentDefs。
const (
	spikeCwd      = `D:\AIAgents\workspace\ai工作台`
	spikeStateDir = `D:\AIAgents\claude-code`
)

type ctrlMsg struct {
	Type string     `json:"type"`
	Cols int        `json:"cols"`
	Rows int        `json:"rows"`
	Msg  string     `json:"msg"`
	Spec *spawnSpec `json:"spec,omitempty"`
	// attention 用：On = 开始/停止闪任务栏，Why 只为了日志能回答"为什么开始/停了"。
	On  bool   `json:"on"`
	Why string `json:"why"`
	// acts.snapshot 用：要哪一格的流水。
	Tab int `json:"tab"`
	// open 用：在系统里打开一个路径（Mode "reveal" = 在资源管理器里选中它）。
	// 路径由索引器给出（卡片上那份会话文件的绝对路径 / 它的 cwd），
	// Go 侧仍然要复核（绝对路径 + 存在），见 resume.go 的 openPath。
	Mode string `json:"mode"`
	Path string `json:"path"`
}

// ---------------------------------------------------------------------------
// 标签：一个标签 = 一条 stream + 一个 ConPTY + 一份启动意图
// ---------------------------------------------------------------------------

// resumeIntent 是「以什么姿态接上已有会话」。前端只声明意图，
// 翻译成命令行是 agent 自己的事（见 agentDefs）。
type resumeIntent struct {
	Kind string `json:"kind"` // "new" | "latest" | "exact" | "fork"
	ID   string `json:"id"`
}

type spawnSpec struct {
	Agent  string       `json:"agent"`
	CWD    string       `json:"cwd"`
	Resume resumeIntent `json:"resume"`
}

// agentDef 把「续接意图」翻译成命令行参数，外加这个 agent 需要的环境变量。
//
// 新增第三个 agent = 在这张表里加一条，别处**零改动**。
// 参数来源：计划书那张意图表，两个 agent 各自的 --help 都核实过。
// （pi 先不登记 —— 它的 --session/--fork 要绝对 jsonl 路径，
//  那要等索引器把 SourcePath 喂进来，C2 一起做。）
type agentDef struct {
	Exe string
	Env map[string]string
	// Args 把「续接意图」翻译成命令行。settings 是我们注入的那份 --settings
	// JSON 字符串（空 = 不注入）：它跟着**每一次启动**走、只对这一次生效，
	// 不碰用户的任何配置文件（第 0 步实测：--settings 是**合并**不是替换，
	// 用户 settings.json 里的 env/model 照样生效）。
	Args func(resumeIntent, string) []string
}

var agentDefs = map[string]agentDef{
	"claude": {
		Exe: `C:\Users\Administrator\.local\claude.exe`,
		Env: map[string]string{"CLAUDE_CONFIG_DIR": spikeStateDir},
		Args: func(r resumeIntent, settings string) []string {
			var args []string
			switch r.Kind {
			case "latest":
				args = []string{"--continue"}
			case "exact":
				args = []string{"--resume", r.ID}
			case "fork":
				args = []string{"--resume", r.ID, "--fork-session"}
			}
			// "new"：裸启动就是全新会话，本身不需要参数。
			//
			// ⚠️ 刻意**不用 --session-id 去钉住新会话**：格子↔会话的关联改由
			// claude 自己写的 sessions\<pid>.json 登记表定（见 status.go）——
			// 那条路对 --resume/--continue 一视同仁，也不会多出一个可能和真实
			// 状态不一致的第二事实源。也正因为如此，这里绝不能把 --session-id
			// 和 --resume/--continue 混用：实测重复 id 是**硬失败**（起不来）。
			if settings != "" {
				args = append(args, "--settings", settings)
			}
			return args
		},
	},
}

type tabHost struct {
	id     int
	stream string
	spec   spawnSpec

	// 下面这些是**运行期状态**，一律只经 tabManager 的方法读写（锁在那边）。
	// 它们由 status.go 的轮询在盘上的登记表里发现，不是启动时算出来的 ——
	// 所以格子刚起来时它们都是空的。
	pid       int
	sessionID string
	sessName  string // claude 自己派生的会话名（nameSource:"derived"）
	status    string // "busy" | "idle"（实测取值，见 status.go 的更正说明）
	// transcript 是会话的 .jsonl 绝对路径。**由 hook 的 SessionStart 直接给**
	// （payload 里有 transcript_path）—— 比我们去 projects\<有损slug>\ 下面拼路径可靠。
	transcript string
}

// tabManager 发放标签 id 和 stream 名。
//
// ⚠️ 一条读 Wails 源码得到的关键事实（不是试出来的）：HandleStream 只是往 map
// 里塞，**服务端在连接建立时**才按名字查 handler，查不到直接 404
// （stream_server.go:247-256）。所以顺序必须是「Go 先注册、前端后连接」——
// 这条由 ctl 通道的 request/reply 保证，不靠时序运气。
// 容量：streamMaxConnectionsGlobal = 4096，标签数远够。
type tabManager struct {
	mu        sync.Mutex
	next      int
	tabs      map[int]*tabHost
	bySession map[string]*tabHost // sessionId → 格子：hook 事件靠它认领归属
}

var tabs = &tabManager{tabs: map[int]*tabHost{}, bySession: map[string]*tabHost{}}

func (tm *tabManager) create(app *application.App, spec spawnSpec) *tabHost {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	tm.next++
	host := &tabHost{id: tm.next, stream: fmt.Sprintf("term:%d", tm.next), spec: spec}
	tm.tabs[host.id] = host
	// 闭包只捕获 host：每次连接自己起一个新 PTY，连接断了那个 PTY 就结束。
	app.HandleStream(host.stream, func(c *application.StreamConn) { handleTab(c, host) })
	return host
}

func (tm *tabManager) drop(id int) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if h := tm.tabs[id]; h != nil && h.sessionID != "" {
		delete(tm.bySession, h.sessionID)
	}
	delete(tm.tabs, id)
}

// setPID 在 PTY 起来之后登记 pid —— 登记表是按 pid 命名的，这是那条链子的起点。
func (tm *tabManager) setPID(id, pid int) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if h := tm.tabs[id]; h != nil {
		h.pid = pid
	}
}

// tabView 是给轮询用的**只读快照**：轮询在锁外拿数据，不和收包循环抢，
// 也不用让整个轮询循环持着锁去读盘。
type tabView struct {
	id         int
	pid        int
	sessionID  string
	status     string
	name       string
	transcript string
	cwd        string
}

func (tm *tabManager) live() []tabView {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	out := make([]tabView, 0, len(tm.tabs))
	for _, h := range tm.tabs {
		cwd := h.spec.CWD
		if cwd == "" {
			cwd = spikeCwd
		}
		out = append(out, tabView{
			id: h.id, pid: h.pid, sessionID: h.sessionID, status: h.status,
			name: h.sessName, transcript: h.transcript, cwd: cwd,
		})
	}
	return out
}

// setTranscript 记下这个格子的转录文件（hook SessionStart 里直接给的）。
func (tm *tabManager) setTranscript(id int, path string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if h := tm.tabs[id]; h != nil && path != "" {
		h.transcript = path
	}
}

// bindSession 把"这个格子跑的是哪个会话"钉下来（只在第一次生效，返回是否绑上了）。
// 两个调用点：hook 事件（最早，session_id 直接随事件来）和会话登记表（兜底）。
func (tm *tabManager) bindSession(id int, sid, name string) bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	h := tm.tabs[id]
	if h == nil || h.sessionID != "" || sid == "" {
		return false
	}
	h.sessionID = sid
	if name != "" {
		h.sessName = name
	}
	tm.bySession[sid] = h
	return true
}

// setStatus 记一次忙闲变化，返回上一次的值和"到底变没变" ——
// 调用方只在变的时候出声，否则 700ms 一次会把日志淹掉。
func (tm *tabManager) setStatus(id int, st string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	h := tm.tabs[id]
	if h == nil || st == "" || h.status == st {
		return "", false
	}
	prev := h.status
	h.status = st
	return prev, true
}

// tabForSession 反查：这条 hook 事件是哪个格子发出来的。
// 查不到返回 0（事件照样推给前端，只是没有归属 —— 比如登记表还没写出来的那一瞬）。
func (tm *tabManager) tabForSession(sid string) int {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if h := tm.bySession[sid]; h != nil {
		return h.id
	}
	return 0
}

// globalApp 只是为了在**运行期**注册新的 stream handler（见 tabManager.create）。
var globalApp *application.App

// mainWindow 是主窗口本身。存下来只为一件事：ctl 收到 attention 时闪任务栏
// （窗口是建的时候顺手丢掉的返回值，别处都不需要它）。
var mainWindow *application.WebviewWindow

// handleCtl 是常驻的控制通道。
//
// 为什么不走 Wails 的绑定（前端的 Call.ByName）而自己开一条流：绑定在服务端是
// 按「<包路径>.<结构体>.<方法>」查的，而那些名字要跑 codegen 生成带对象 id 的
// JS 调用桩 —— 我们的构建现在是纯 `go build`，不想为此引入构建步骤。
// 这条流复用已有的控制帧形状：**零新 API 面、零构建步骤**。
//
// 和标签那条数据通道的分工是干净的：这边**双向都是 JSON**，
// 那边**双向都是字节**（键盘原始输入 + PTY 原始输出），互不掺和。
// pushJSON 把一条消息推给前端（走 ctl 那条常驻通道）。
//
// 为什么不走 Wails 的事件 API：见上面那段 —— 这条通道已经跑通、零新 API 面、
// 零构建步骤。加锁是因为这里有**两个写者**（链路轮询的 goroutine 和可能的
// 其它 goroutine），而 Send 内部是不是线程安全我们没验过；一把锁比一个未知数便宜。
var (
	pushMu   sync.Mutex
	pushConn *application.StreamConn
)

func setPushConn(c *application.StreamConn) {
	pushMu.Lock()
	pushConn = c
	pushMu.Unlock()
}

func pushJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	pushMu.Lock()
	c := pushConn
	pushMu.Unlock()
	if c == nil {
		return
	}
	if err := c.Send(b); err != nil {
		pushMu.Lock()
		if pushConn == c {
			pushConn = nil
			log.Printf("[ctl] 推送失败，先停掉推送（下次前端连上会重新接管）: %v", err)
		}
		pushMu.Unlock()
	}
}

func handleCtl(c *application.StreamConn) {
	defer c.Close()
	setPushConn(c)
	defer setPushConn(nil)
	log.Printf("[ctl] 控制通道已连接")
	for {
		data, err := c.Receive()
		if err != nil {
			log.Printf("[ctl] 控制通道断开")
			return
		}
		var m ctrlMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "tab.new":
			if m.Spec == nil {
				continue
			}
			// C2 护栏：判**在建标签之前**。一个没有 PTY 的占位格比"什么都没发生"
			// 更糟 —— 界面上会多出一格，用户以为它在跑。判据见 resume.go。
			if ref := resumeRefusal(*m.Spec); ref != nil {
				reply, _ := json.Marshal(map[string]any{
					"type": "tab.ok", "tab": 0, "stream": "",
					"err": ref.code, "msg": ref.msg,
				})
				_ = c.Send(reply)
				log.Printf("[ctl] 拒绝接上 agent=%s cwd=%s resume=%s id=%s 因=%s：%s",
					m.Spec.Agent, m.Spec.CWD, m.Spec.Resume.Kind, m.Spec.Resume.ID,
					ref.code, ref.msg)
				continue
			}
			host := tabs.create(globalApp, *m.Spec)
			reply, _ := json.Marshal(map[string]any{
				"type": "tab.ok", "tab": host.id, "stream": host.stream,
			})
			_ = c.Send(reply)
			log.Printf("[ctl] 新标签 tab=%d stream=%s agent=%s cwd=%s resume=%s id=%s",
				host.id, host.stream, m.Spec.Agent, m.Spec.CWD, m.Spec.Resume.Kind,
				m.Spec.Resume.ID)
		case "open":
			// 在系统里打开一个路径（卡片菜单里的"打开会话文件/在文件夹中显示/
			// 打开工作目录"）。换协程：explorer 起进程不该拖住 ctl 收包。
			go openPath(m.Mode, m.Path)
		case "lib.reload":
			/* C7：前端关掉一格之后要一次**会话库重扫**。
			   为什么非有这条路不可：那份数据是 boot 时一推了之的（handleShell），
			   而关格子恰恰是"这一格里的子代理刚刚死了"的那一刻。不复扫的后果实测过
			   （2026-10-16 00:53）：我在格子里起了个子代理、眼看着关掉那一格，
			   日志里只有"关格子"，**没有**任何一条"已关闭" —— 因为那条子代理是在
			   boot **之后**才落盘的，库里压根没有它的卡，没卡就没签可改。
			   同一个洞还有另一面：库里那些"本格在跑的"子代理，跑完也不会露面。
			   顺带一提，这条路也把"这一格自己的会话文件"带进库里（新起的 claude
			   在 boot 时同样还不存在）。
			   代价：载荷 85KB、扫一遍毫秒级，而关格子是低频动作 —— 所以直接**同步**
			   重扫。不换协程，是因为 Send 走的就是手里这根流，换协程反而要和
			   在途的推送（pushCtrl）处理并发，而这里慢的那几十毫秒没有任何人等着。 */
			st := buildShellPayload(spikeStateDir, spikeCwd, spikeTitles.snapshot())
			b, err := json.Marshal(map[string]any{"type": "state", "state": st})
			if err != nil {
				log.Printf("[ctl] 会话库刷新失败: %v", err)
				continue
			}
			nSide := 0
			for _, s := range st.Sessions {
				if s.Sidechain {
					nSide++
				}
			}
			log.Printf("[ctl] 会话库刷新：%d 会话（其中子代理 %d）%d 字节", len(st.Sessions), nSide, len(b))
			_ = c.Send(b)
		case "log":
			// 页面级事实（没有标签归属的那些）走这条 —— 它比任何标签流命都长，
			// 页面刚起来还没标签时也能落日志。
			log.Printf("[web] %s", m.Msg)
		case "attention":
			// 「需要你」送到窗口之外的那一层：闪任务栏。
			//
			// 为什么这件事必须由 Go 做：应用内的描边脉冲/徽标都在我们自己的窗口里，
			// 用户在浏览器里时一个都看不见 —— 系统层只剩这一个手段。
			// Wails 在 Windows 上就是 `w32.FlashWindow(hwnd, enabled)`
			// （webview_window_windows.go:2696-2698；darwin 是 requestUserAttention、
			//  Linux 是空实现）。语义：true 会**一直闪到窗口被激活**，所以"停"要显式发。
			//
			// 判据在前端（窗口不在前台 + 存在未读），Go 这边不做判断 ——
			// 它只管"闪"与"别闪"，这是唯一不需要知道"未读"是什么的一侧。
			if mainWindow != nil {
				mainWindow.Flash(m.On)
				log.Printf("[web] 任务栏闪烁 %v（%s）", m.On, m.Why)
			} else {
				log.Printf("[web] attention 要闪任务栏，但主窗口还没拿到（%s）", m.Why)
			}
		case "acts.snapshot":
			// 页面重载后补一次首帧。
			//
			// 为什么需要它：跟随器只在**初次读入**时推整份（见 transcript.go 的
			// firstRead），页面一重载它那边的 first 早就是 false 了 —— 不补这一次，
			// 下段（实时对话流）会空白到下一次有新内容为止，而"这一格其实跑了
			// 一个小时"这件事前端无从得知。
			if m.Tab <= 0 {
				continue
			}
			items := actSnapshot(m.Tab, 2*time.Second)
			if items == nil {
				log.Printf("[ctl] 补发流水快照 tab=%d 超时/没被取走，跳过（不拿 nil 去替换前端已有的列表）", m.Tab)
				continue
			}
			pushJSON(map[string]any{"type": "acts", "tab": m.Tab, "items": items, "replace": true})
			log.Printf("[ctl] 补发流水快照 tab=%d（%d 条）", m.Tab, len(items))
		}
	}
}

// spikeTitles 是用户给会话起的名字（见 titles.go）。在 main 里初始化 ——
// 它要读盘，放在包级变量的初始化里会让"读盘失败"发生在 log 还没配好之前。
var spikeTitles *titleStore

func main() {
	spikeTitles = loadTitleStore(filepath.Join(spikeStateDir, "titles.json"))

	// C3：**第一个动作**就是给自己上"随进程退出清理整棵树"的保险 ——
	// 必须早于任何子进程（窗口的 WebView2、每个格子的 ConPTY 都在这之后才起）。
	// 挂一次宿主，此后所有进程靠继承覆盖，不需要每格再管一次。
	ownProcessTree()

	app := application.New(application.Options{
		Name:        "AgentTerm Spike",
		Description: "ConPTY + xterm.js 可行性验证",
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
	})
	// 标签是运行期创建的，创建时要 HandleStream —— 拿不到 app 就注册不了。
	globalApp = app

	// 两条通道，职责分开：
	//   ctl        —— 常驻，纯 JSON 双向。前端唯一的控制面（建标签、落日志）。
	//   term:<id>  —— 每个标签一条，纯字节。PTY 的出口和键盘的入口。
	// 启动时**一个标签都没有** —— 标签由前端点出来（这样以后"恢复上次的标签"
	// 是纯前端的事，Go 侧不需要一份默认 spec）。
	app.HandleStream("ctl", handleCtl)
	app.HandleStream("shell", handleShell)

	// 默认窗口尺寸是**我们自己的值**，不是 Orca 的 —— Orca 的默认尺寸在它
	// 主进程的窗口创建代码里，那份文件不在我们抓到的源码范围内，不编。
	//
	// 取值依据是可测的：Claude Code 的开场介绍框需要 ≥64 列才不折行，
	// 而 1200px 窗口 + 240px 侧栏 + 原来的 62% 分栏只给到 60 列。
	// 1440 宽 + 74% 分栏让终端拿到 ~85 列，留出余量。
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:  "AI 工作台",
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
		// 适配它自己的侧栏可折叠布局。我们左边是固定的 132+240 两列，
		// 600 宽会让终端只剩 20 来列、开场介绍框直接折行 —— 所以这里按
		// **"终端至少 64 列"** 倒推：64×8.15px ≈ 522px 终端宽，
		// 除以 74% 分栏 ≈ 711px 的主区，再加 372px 固定列 ≈ 1083。
		// 这是被允许的适配，不是随口取的。
		MinWidth:  1080,
		MinHeight: 560,

		URL: "/",
	})

	// hooks：每个格子启动时现造一份**只对它生效**的 --settings（不碰用户的配置文件）。
	// 接收器不在 exe 旁边就造不出来 → 不注入，忙闲那条腿仍然可用。
	if exe := hookExePath(); exe == "" {
		log.Printf("[hook] 未注入 hooks：%s 不在 exe 旁边（忙闲仍来自 sessions\\<pid>.json）", hookExeName)
	} else {
		log.Printf("[hook] 已备好：%d 个事件（exec 形式 / async / timeout=5s）接收器=%s 事件目录=%s",
			len(hookEventTypes), exe, hookDir())
	}

	// 两条观察腿，一细一粗：
	//   hook 事件      —— 精确到轮次，带内容（Stop 的最后一句、Notification 的类型）
	//   会话登记表    —— 粗粒度忙闲，永远在（hook 没起来时它也告诉你谁在等你）
	// 两条都只写日志 + 推前端，**不碰 PTY 通道**：这一层坏掉最坏是"侧栏没数据"，
	// 绝不会让终端本身出问题。
	startHookEventPoller(pushJSON)
	startAgentStatusPoller(pushJSON)
	// 第三条腿：跟着每个格子的转录文件走（「改动」和「流水」的数据源）。
	// 它靠 SessionStart 给的 transcript_path 才知道该跟哪个文件，所以排在 hooks 之后。
	startTranscriptFollower(pushJSON)

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// envBlocked 列出**绝不能从宿主继承**的终端呈现类变量。
//
// 规则的由来：宿主自己就是一个 Claude Code 会话，它的环境是
// 「我是谁、我在什么终端里」的**第一人称描述** —— 对子进程来说这些描述全是
// 谎话，而且会实质改变子 agent 的行为。我们已经在这上面栽过两次：
//
//   - CLAUDE_CODE_CHILD_SESSION 之类 → 子 claude 认为自己是子会话，
//     **历史根本不落盘**，直接毁掉「续接」这个核心功能。
//   - NO_COLOR=1 → 子 claude 认为终端不支持颜色，**关掉全部颜色输出**。
//     表现是：开场横幅的吉祥物从 #D97757 橙色变成纯白，整个终端黑白一片。
//     2026-10-15 实测：去掉这个变量后，终端区域的主色立刻变成 215,119,87。
//
// 两次都是「宿主的环境泄漏进了子 agent」。补一个删一个的写法永远补不完，
// 所以这里把**终端呈现相关的一整类**显式列出并整类剥掉，
// 再由我们在下面按事实重新声明。
var envBlocked = map[string]bool{
	"NO_COLOR": true, "FORCE_COLOR": true,
	"CLICOLOR": true, "CLICOLOR_FORCE": true,
	"TERM": true, "COLORTERM": true, "COLORFGBG": true,
	"TERM_PROGRAM": true, "TERM_PROGRAM_VERSION": true,
	// 下面这些是在**别的终端里**才成立的标识。宿主如果跑在 Windows Terminal
	// 里，它们就会漏进来，让子 claude 以为自己在 WT 里（进而期待 WT 才有的能力）。
	"WT_SESSION": true, "WT_PROFILE_ID": true,
	"VTE_VERSION": true, "KITTY_WINDOW_ID": true,
	"ITERM_SESSION_ID": true, "ITERM_PROFILE": true,
	"WEZTERM_PANE": true, "WEZTERM_EXECUTABLE": true,
}

// buildEnv 从父进程环境出发，剥掉不该继承的，再**按事实**重新声明终端身份。
// extra 是 agent 自己那份（claude 要 CLAUDE_CONFIG_DIR，pi 要 PI_CODING_AGENT_DIR）——
// 从外面传进来，因为这个函数不该知道有几个 agent。
func buildEnv(extra map[string]string) []string {
	parent := os.Environ()
	out := make([]string, 0, len(parent)+len(extra)+8)
	for _, e := range parent {
		k, _, _ := strings.Cut(e, "=")
		if strings.HasPrefix(k, "CLAUDE") || envBlocked[strings.ToUpper(k)] {
			continue
		}
		out = append(out, e)
	}
	// 排序只为让日志/调试时两次运行的顺序一致（map 遍历顺序是随机的）。
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return append(out,
		// 下面这几条是**我们对"自己是什么终端"的事实声明**，不是从宿主抄来的。
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=ai-workbench",
		// fg;bg 的 0-15 索引形式。有些工具只认这个、不做 OSC 查询。
		// 我们的主题是深底 + 白字 → 15;0。底色 2026-10-15 改成 #0a0a0a 后
		// **这条不用动**：索引 0 就是"黑"，任何近黑底都对得上。
		"COLORFGBG=15;0",
		// 兜底再声明一次"要颜色"，24-bit。有它就不怕上游再塞进别的禁色变量。
		"FORCE_COLOR=3",
	)
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
		log.Printf("[spike] 未知 agent %q，无法在 Windows Terminal 中打开", spec.Agent)
		return
	}
	// 参数翻译走**同一个** agentDefs.Args —— 对比窗口和嵌进来的窗口必须是同一个
	// 会话意图，否则这个"对比"就成了两个不同的东西，没有可比性。
	tail := append([]string{"-d", spec.CWD, def.Exe}, def.Args(spec.Resume, buildHookSettings("wt"))...)
	cmd := exec.Command("wt.exe", tail...)
	cmd.Env = buildEnv(def.Env)
	// 「在 WT 里打开」是**交出去**的意思：那个窗口不是我们的子界面，不该随 spike
	// 一起被清掉，而 C3 的 job 会连带杀掉所有子进程 —— 所以这里显式请求脱离。
	// 这是那个 BREAKAWAY_OK 标志的存在理由之一（见 job_windows.go 文件头 ②），
	// 也把"哪种东西该活下来"写进了代码里，而不是碰运气。
	cmd.SysProcAttr = handoffSysProcAttr()
	if err := cmd.Start(); err != nil {
		log.Printf("[spike] 启动 Windows Terminal 失败: %v", err)
		_ = exec.Command("cmd", append([]string{"/c", "start", "", "wt.exe"}, tail...)...).Start()
		return
	}
	log.Printf("[spike] 已在 Windows Terminal 中打开 pid=%d", cmd.Process.Pid)
}

// handleShell 一次性把界面骨架要的数据推给前端。
//
// 用 Stream 而不是开 HTTP 路由，是因为流通道是已经跑通的那条，
// 不引入任何新的 API 面（beta 版里少一个未知数就是少一个坑）。
// 推完必须**等一下再关** —— 立刻 Close 会把刚写出去的那帧一起带走。
func handleShell(c *application.StreamConn) {
	defer func() {
		time.Sleep(120 * time.Millisecond)
		_ = c.Close()
	}()

	b, err := json.Marshal(buildShellPayload(spikeStateDir, spikeCwd, spikeTitles.snapshot()))
	if err != nil {
		log.Printf("[spike] 索引失败: %v", err)
		return
	}
	log.Printf("[spike] 索引 %d 字节", len(b))
	_ = c.Send(b)
}

// sgrParams 从一段原始 PTY 字节里挑出所有 SGR（`ESC [ … m`）序列并原样返回。
//
// 只认 `m` 结尾，且要求 ESC [ 与 m 之间全是数字和分号 —— 这样就不会把
// 光标移动、清屏之类的 CSI 混进来（那些是渲染指令，不是颜色）。
// 序列可能被切在两个读块中间，所以这里会漏掉边界上的少数几条；
// 对「上游到底用不用这个色号」这个判断来说足够了。
func sgrParams(b []byte) []string {
	var out []string
	for i := 0; i+2 < len(b); i++ {
		if b[i] != 0x1b || b[i+1] != '[' {
			continue
		}
		j := i + 2
		for j < len(b) && (b[j] == ';' || (b[j] >= '0' && b[j] <= '9')) {
			j++
		}
		if j < len(b) && b[j] == 'm' && j > i+2 {
			out = append(out, string(b[i+2:j]))
			i = j
		}
	}
	return out
}

// 说明：sgrParams 是上一轮排查"横幅为什么全白"时留下的探针。结论是
// **上游根本没发颜色**（真因是宿主会话的 NO_COLOR=1 泄漏，见 buildEnv），
// 所以现在改由 osc_color.go 在字节流里应答 OSC 10/11 查询 —— 那才是
// 让 agent 敢用颜色的正路。这个函数暂时留着，别删：
// 下次再遇到"颜色不对"时，第一步还是先看上游到底发了什么。
// rawProbeLimit 是启动时原样打印的字节数上限。
//
// 为什么需要它：屏幕上"看起来不对"时，有两类完全不同的原因 ——
//
//	A. CLI 本来就发的是这些字符（那我们渲染是忠实的，要改的是别处）；
//	B. 我们的链路把字节改了（那是我们的 bug）。
//
// 从截图上分辨这两者是徒劳的。**先看 CLI 到底发了什么，一次就能定性。**
// 开场横幅很小、出现得很早，几 KB 足够覆盖。
//
// ⚠️ 2026-10-15 补：这个"只dump前 8000 字节"的闸门**自己把证据掐断过**。
// 排查「吉祥物反复出现」时，9 秒时探针数到回滚缓冲里有 1 个介绍框、现在有 6 个，
// 而中间那 5 个恰好全部发生在 8000 字节用完之后 —— 日志一片安静，说不清是什么触发的。
// 所以现在加了下面这条按**内容**触发的探针：不再限制总量，而是只标记
// 「这一帧的字节里含开场介绍框」。介绍框每被重画一次，回滚缓冲就多一份，
// 于是"什么时刻、因为什么又画了一帧"在日志里就是可数的一行行。
const rawProbeLimit = 8000

// bannerMark 是开场介绍框的判据：介绍框里最有辨识度、又不会出现在别处的字符串。
// （前端的 countBanners 用的是同一串，两边对得上。）
const bannerMark = "API Usage Billing"

// escapeBytes 把原始字节转成可读形式：控制字符和 ESC 显式标出，
// 其余字节原样保留（本来就是 UTF-8，块元素和中文都能直接看）。
func escapeBytes(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		switch {
		case c == 0x1b:
			sb.WriteString("<ESC>")
		case c == '\r':
			sb.WriteString("<CR>")
		case c == '\n':
			sb.WriteString("<LF>")
		case c < 0x20:
			fmt.Fprintf(&sb, "<%02X>", c)
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}

// awaitInitialSize 等前端把它 fit 出来的列宽行数报上来。
//
// 为什么必须等：终端进程的**第一个字节**就决定了它按多少列画屏。
// 原来这里写死 120x30 起 PTY，前端 fit 到 60 列之后再 resize —— 但那时
// CLI 已经按 120 列画完一整屏了；xterm 收到 resize 会把已有内容按新宽度
// **折行重排**，于是屏幕上出现 "C / de / Claude Code v" 这种交错重影，
// 且这段脏内容永久留在回滚缓冲里。
//
// 这类问题在截图上看起来像"渲染 bug"，根因却在启动时序上。
// 前端在 stream.onopen 里就会发第一帧 resize（sendCtrl 需要 ready，
// onopen 里 ready 已经置位），所以正常路径下这里是零等待。
// 兜底：1.5 秒还没等到（比如前端 fit 失败）就用 80x24 起，宁可难看也别卡死。
const (
	initialSizeTimeout = 1500 * time.Millisecond
	initialCols        = 80
	initialRows        = 24
)

/* 前端上报的一帧。data 与 err 二选一。
   ⚠️ 读 conn 的**只能有一个 goroutine**（Receive 内部是 sync.Cond，两个读者会把帧
   随机分走 —— 键盘字节被偷走那种错）。所以这里不是"再加一个读者"，而是把**读**
   整个搬进这个 goroutine：这个 goroutine 是全程唯一的读家，处理逻辑只从通道拿帧。 */
type tabFrame struct {
	data []byte
	err  error
}

/* 读帧 goroutine。为什么非得把读挪出去（2026-10-16 实测的根因）：

   `StreamConn.Receive()` 是 sync.Cond 上的死等 —— **只有两件事叫得醒它**：来帧，
   或者 Close（Close 会 cancel + Broadcast）。它没有 deadline、没有可用的 ctx。
   而下面那句 1.5 秒兜底原来写在循环体里：

       for { if time.Now().After(deadline) { 兜底启动 }; data, err := c.Receive() }

   —— 时间是**在 Receive 返回之后**才检查的。一帧都没有的时候它永远不返回，
   于是"宁可难看也别卡死"那句兜底压根轮不到：**收起的群组里新建的那一格
   45 秒都没有 PTY，展开的那一下才起来**（2026-10-16 实测）。
   把读挪进这里，处理逻辑才第一次有可能"在没帧的时候被定时器叫醒"。

   代价是帧要过一次通道 —— 顺序由通道保证（单读、单消费、无重排、无丢失）。

   ⚠️ 两个细节都是**防泄漏**的，不是顺手写的：
   · 缓冲至少 1：读家从 Receive 拿到一帧就去塞通道，塞不进去就卡着；消费方那一瞬间
     正好在跑 handle 的时候，有个槽位它才不用等。
   · done：消费方提前 return 的时候（下面 PTY 写失败那条），读家可能**正卡在塞帧上**
     —— 那时它不在 Receive 里，`c.Close()` 根本叫不醒它，这条 goroutine 就永远留下了。
     所以塞帧要走 select，done 一关就撤。 */
func readFrames(c *application.StreamConn, done <-chan struct{}) <-chan tabFrame {
	frames := make(chan tabFrame, 1)
	send := func(f tabFrame) bool {
		select {
		case frames <- f:
			return true
		case <-done:
			return false
		}
	}
	go func() {
		defer close(frames)
		for {
			data, err := c.Receive()
			if err != nil {
				send(tabFrame{err: err})
				return
			}
			if !send(tabFrame{data: data}) {
				return
			}
		}
	}()
	return frames
}

// ⚠️ 2026-10-15 修：这个握手以前会**吃掉**不是 resize 的控制帧，后果很严重。
// 前端启动那一刻是连着发好几条的（fit 读数、fontprobe、dpr…），全被这里
// `continue` 掉。更糟的是：前端发消息是**事件驱动**的 —— onopen 那一批被吃掉之后，
// 除非尺寸/内容再变，它不会再发。于是握手一旦超时，整条前端->后端通道看起来就是死的：
// 页面正常（终端在跑、页脚写着"已连接"），日志却一片安静。排查吉祥物那次，
// 我在这上面绕了很久，直到把握手摘掉才看见日志里立刻冒出 `[web] fit=...`。
// 现在把吃掉的帧按原顺序交还给收包循环，一帧不丢。
func awaitInitialSize(frames <-chan tabFrame) (int, int, [][]byte, error) {
	var pending [][]byte
	timer := time.NewTimer(initialSizeTimeout)
	defer timer.Stop()
	for {
		select {
		case f, ok := <-frames:
			if !ok { // 读家退出了（通道被关），等价于原来 Receive 报错
				return 0, 0, nil, application.ErrStreamClosed
			}
			if f.err != nil {
				return 0, 0, nil, f.err
			}
			data := f.data
			if len(data) == 0 {
				continue
			}
			if data[0] == ctrlPrefix {
				var m ctrlMsg
				if json.Unmarshal(data[1:], &m) == nil && m.Type == "resize" && m.Cols > 0 && m.Rows > 0 {
					log.Printf("[spike] 前端报尺寸 %dx%d，按此启动 PTY", m.Cols, m.Rows)
					return m.Cols, m.Rows, pending, nil
				}
			}
			pending = append(pending, data)
		case <-timer.C:
			// 一寸都没报（不是"fit 失败"，而是**一个字节都没来**）——前端发消息是
			// 事件驱动的，隐藏的格子报不出尺寸，也就什么都不会发。这里必须起，
			// 否则这一格永远没有 PTY。
			// ⚠️ 副作用要知道：80x24 起来之后，真正的那一帧尺寸到了会走
			//    Resize —— CLI 会重画开场界面（老那一份进回滚缓冲）。这是
			//    "宁可难看也别卡死"这句兜底本来就要付的代价，别当成新 bug。
			log.Printf("[spike] 前端 %v 内未报尺寸，按 %dx%d 兜底启动（其间收到 %d 帧，转交收包循环）",
				initialSizeTimeout, initialCols, initialRows, len(pending))
			return initialCols, initialRows, pending, nil
		}
	}
}

// handleTab 是**一个标签**的数据通道：Go → 前端是 PTY 原始字节，
// 前端 → Go 是键盘原始字节 + 0xFF 打头的控制帧。
//
// 这条通道的寿命就是标签的寿命：前端关掉标签 = 关掉这条流 = 本函数返回
// = `defer sess.Close()` 收掉 ConPTY。**所以不需要一条"关闭标签"的控制帧** ——
// 少一个能跟真实状态不同步的开关。
func handleTab(c *application.StreamConn, host *tabHost) {
	defer c.Close()
	defer tabs.drop(host.id)
	// C3 的观察腿（格子收尾这一端）：这一格关了之后，job 里还剩谁。
	// 和下面"起来后"那条配对 —— 两条合起来才能看出"这一格带走了什么、留下了什么"。
	defer logJobInventory(fmt.Sprintf("tab=%d 收尾", host.id))

	// 读家**必须在握手之前**就位：握手要能"在没帧的时候被定时器叫醒"，
	// 而 Receive 是会死等的那种读（见 readFrames 的说明）。
	done := make(chan struct{})
	defer close(done) // 本函数一返回就让读家撤（防它卡在塞帧上，见 readFrames）
	frames := readFrames(c, done)
	cols, rows, pending, err := awaitInitialSize(frames)
	if err != nil {
		return
	}

	def, ok := agentDefs[host.spec.Agent]
	if !ok {
		log.Printf("[spike] tab=%d 未知 agent %q", host.id, host.spec.Agent)
		_ = c.Send([]byte("\r\n\x1b[31m[spike] 未知 agent: " + host.spec.Agent + "\x1b[0m\r\n"))
		return
	}
	// hooks 是**每格子一份**：事件文件路径写死进这一份 --settings 里，
	// 于是"这条事件属于哪个格子"由文件名决定，不需要任何反查（见 hooks.go 末尾那段）。
	settings := buildHookSettings(fmt.Sprintf("t%d", host.id))
	args := def.Args(host.spec.Resume, settings)
	cwd := host.spec.CWD
	if cwd == "" {
		cwd = spikeCwd
	}

	sess, err := startPTY(def.Exe, args, cwd, buildEnv(def.Env), cols, rows)
	if err != nil {
		log.Printf("[spike] tab=%d 启动失败: %v", host.id, err)
		_ = c.Send([]byte("\r\n\x1b[31m[spike] 启动失败: " + err.Error() + "\x1b[0m\r\n"))
		return
	}
	defer sess.Close()
	// pid 是「格子 ↔ 会话」那条链子的起点（登记表按 pid 命名，见 status.go）。
	tabs.setPID(host.id, sess.Pid())
	// 注意日志里**打印参数**会把整份 --settings JSON 也打出来（几 KB）。
	// 这里改打长度：那串东西对读日志的人是噪音，长度足够判断"注进去了没有"。
	log.Printf("[spike] tab=%d 已启动 pid=%d exe=%s 参数%d个(settings=%d字节) cwd=%s resume=%s",
		host.id, sess.Pid(), def.Exe, len(args), len(settings), cwd, host.spec.Resume.Kind)
	// C3 的观察腿（格子起来这一端）：这一格的 claude 是靠**继承**进 job 的
	// （我们从没单独 assign 过它）—— 这句话是不是真的，问内核拿清单看。
	logJobInventory(fmt.Sprintf("tab=%d pid=%d 起来后", host.id, sess.Pid()))

	// ConPTY -> 前端：原样转发字节，不做任何字符串转换。
	// string(bytes) 会把被切在两个读块之间的 UTF-8 序列打断 ——
	// 而这个场景满地中文。
	go func() {
		buf := make([]byte, 32*1024)
		// OSC 10/11 颜色查询应答。必须在**原始字节**这一层做，
		// 因为查询可能早于任何渲染器到达（见 osc_color.go 的说明）。
		osc := newOSCColorResponder()
		probeDone := false
		probeUntil := time.Now().Add(20 * time.Second)
		rawLeft := rawProbeLimit
		for {
			n, rerr := sess.Read(buf)
			if n > 0 {
				if rawLeft > 0 {
					take := n
					if take > rawLeft {
						take = rawLeft
					}
					rawLeft -= take
					log.Printf("[raw t%d] %s", host.id, escapeBytes(buf[:take]))
				} else if bytes.Contains(buf[:n], []byte(bannerMark)) {
					// 不打印整帧（TUI 重画很频繁，整个 dump 出来日志会失控），
					// 只留一行"这一帧里又有一份介绍框"。数行数 = 数份数。
					log.Printf("[banner t%d] 这一帧的字节里含开场介绍框（%d 字节）", host.id, n)
				}
				for _, reply := range osc.scan(buf[:n]) {
					log.Printf("[osc] 回答颜色查询: %q", reply)
					if _, werr := sess.Write([]byte(reply)); werr != nil {
						log.Printf("[osc] 写回应答失败: %v", werr)
					}
				}
				if !probeDone && time.Now().After(probeUntil) {
					probeDone = true
					log.Printf("[osc] 这段时间收到的查询统计: %v", osc.seen)
				}
				// ⚠️ Send 是「排队」不是「拷贝」。Wails v3 在
				// pkg/application/stream.go 的注释里把这条契约写得很直白：
				//
				//	The frame is queued, not copied. Do not mutate or reuse
				//	data after passing it to Send; hand over a slice the
				//	transport can own until it is delivered.
				//
				// 而 buf 是每轮 Read 复用的 —— 直接 Send(buf[:n]) 就等于把一块
				// **马上会被下一次 Read 覆盖**的内存交出去，帧往往在送达前就被改了。
				//
				// 症状极具欺骗性：同一个字节流，每次跑出来都不一样。
				// 2026-10-15 实测到的样子是开场横幅里
				// `<ESC>[38;2;215;119;87m` 被当正文打出来（`8;2;215;119;87m`
				// 出现在第 0 行）、吉祥物位置随机漂移、还多出一个字符 ——
				// 看起来全是字体/渲染/宽度问题，实际是读循环和发送队列抢同一块内存。
				// 用同一个字节流喂**干净的** xterm 实例则完全正确，这就是分水岭。
				//
				// 修法：按帧复制。一次 PTY 读块多一次分配，代价可忽略，
				// 换来"交出去的内存归对方"这条不变量。
				frame := make([]byte, n)
				copy(frame, buf[:n])
				if serr := c.Send(frame); serr != nil {
					return
				}
			}
			if rerr != nil {
				_ = c.Send([]byte("\r\n\x1b[33m[spike] 进程已退出\x1b[0m\r\n"))
				_ = c.Close() // 让下面的收包循环立刻醒过来
				return
			}
		}
	}()

	// 前端 -> ConPTY。控制帧（0xFF 打头）在这里分发，其余字节原样写进终端。
	// 抽成闭包是为了让握手里攒下的帧走**同一条**路径（见 awaitInitialSize）。
	handle := func(data []byte) (stop bool) {
		if len(data) == 0 {
			return false
		}
		if data[0] == ctrlPrefix {
			var m ctrlMsg
			if json.Unmarshal(data[1:], &m) == nil {
				switch m.Type {
				case "resize":
					if m.Cols > 0 && m.Rows > 0 {
						if err := sess.Resize(m.Cols, m.Rows); err != nil {
							log.Printf("[spike] resize %dx%d 失败: %v", m.Cols, m.Rows, err)
						}
					}
				case "open-wt":
					go openInWindowsTerminal(host.spec)
				case "rename":
					// 用户给这个面板起了个名字。名字的主语是**会话**，不是面板 ——
					// 面板在内存里，会话在盘上，中间那条链子见 titles.go 的
					// sessionIDForPID。这里只把 pid 交出去，反查和落盘都在那边做，
					// 以免这段收包逻辑被拖住（反查有重试，可能等上一两秒）。
					applyRename(spikeStateDir, spikeTitles, sess.Pid(), m.Msg)
				case "log":
					// 前端把渲染层的事实（fit 结果 / 元素尺寸 / dpr）回传到
					// 服务端日志 —— 页面里没有控制台可看，这是唯一能拿到的真相。
					// 带标签号：多标签之后不带号的日志没法读。
					log.Printf("[web t%d] %s", host.id, m.Msg)
				}
			}
			return false
		}
		if _, werr := sess.Write(data); werr != nil {
			return true
		}
		return false
	}
	for _, data := range pending {
		if handle(data) {
			return
		}
	}
	// 通道由 readFrames 那个 goroutine 关：它把 Receive 的错先当一帧发出来再 close，
	// 所以这里的 `!ok` 是防御性的（真有那一天说明那条约定被改了）。
	for f := range frames {
		if f.err != nil {
			// 读到这儿只有一个成因：这条流关了（前端关标签 / 页面重载 / 窗口关掉）
			// —— `StreamConn.Receive` 唯一的错误就是 ErrStreamClosed（stream.go:293
			// 直接返回那个哨兵），而正常关格本来就是这个结果。所以这里**不打日志**：
			// 每次关格一条像报错的行，读日志的人很快就会不看日志了。
			//（留这个判断而不是直接 return：万一以后换成别的读法，真错还能露出来。）
			if !errors.Is(f.err, application.ErrStreamClosed) {
				log.Printf("[spike] tab=%d 读帧中断: %v", host.id, f.err)
			}
			return
		}
		if handle(f.data) {
			return
		}
	}
}
