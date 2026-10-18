package main

import (
	"bytes"
	"context"
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
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed assets
var assets embed.FS

// ctrlPrefix 是控制帧的起始字节。
// xterm 的键盘输入只会产生 0x00–0x7F 的字节，0xFF 不可能出现在真实终端输入里，
// 所以用它来区分「控制帧」和「原样透传的终端输入」。
const ctrlPrefix = 0xFF

// 状态根，以及"拿不到用户主目录时落在哪"的兜底。
// 可执行文件**不在代码里写死**了 —— 见下面的 agentDefs。
//
// ⚠️ 仓库里**不留任何本机绝对路径**（发布清理的一部分）：状态根按 Claude Code
// 自己的规则取 —— 环境里有 CLAUDE_CONFIG_DIR 就用它，否则 <用户主目录>\.claude。
// 这样换一台机器、换一个用户，索引到的就是那个人自己的会话库。
var claudeStateDir = func() string {
	if v := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".claude")
	}
	return ".claude"
}()

// fallbackCWD 只在**拿不到用户主目录**时兜底（那种情况下总不能连格都起不来）。
var fallbackCWD = func() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "."
}()

// defaultCWD 是「新格没指定目录时落在哪」的**唯一**答案。
// 2026-10-16 起它是默认工作区（<用户主目录>\Documents\Perch，见 projects.go）——
// 左栏末尾那一行就是它，用户没挑项目时新格就该落在它那里（Claude / Codex 桌面端
// 也是这么办的）。拿不到用户主目录才退回 fallbackCWD。
// ⚠️ tabManager.live() 报"这一格在哪个目录跑"必须用**同一个**函数：两处各写一遍，
// 报出来的 cwd 和真正起 PTY 用的 cwd 会在"拿不到主目录"的机器上悄悄分叉 ——
// 而那种分叉从界面上看不出来，只会表现为"某个动作在这个目录里失败"。
func defaultCWD() string {
	if p := defaultWorkspaceCWD(); p != "" {
		return p
	}
	return fallbackCWD
}

// effectiveCWD 是一份 spec 的**生效 cwd** = 落盘那份记录里该记的值。
// 它就是"起 PTY 时真正用的那个目录"，所以谁都不许自己再写一遍这个判断
// （三处各写一遍的下场见 defaultCWD 上面那条注释）。
func effectiveCWD(spec spawnSpec) string {
	if c := strings.TrimSpace(spec.CWD); c != "" {
		return c
	}
	return defaultCWD()
}

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
	// pane.close / pane.forget 用：那一格的 paneId（登记表的身份，不是 tab id ——
	// tab id 每次启动重发，见 panes.go 的 PaneID）。close 只打标记，forget 才删。
	Pane int `json:"pane"`
	// Req：建格请求的**令牌**，原样带回 tab.ok（成功和拒绝两条路都带）。
	//
	// ⚠️ 为什么非要有它：前端原来靠"在 TAB_LIST 里找一个 id=0 且还在等应答的标签"
	// 来配对，单发时成立；而冷恢复是 burst，中间还夹着"被拒→重试"的格子 ——
	// pane1 重试时又把自己标成"还在等"，于是 pane2 起**整批错位一格**
	// （表现是"每格跑的都是隔壁的会话"，日志全正常）。令牌让配对变成一一对应。
	Req int `json:"req,omitempty"`
	// open 用：在系统里打开一个路径（Mode "reveal" = 在资源管理器里选中它）。
	// 路径由索引器给出（卡片上那份会话文件的绝对路径 / 它的 cwd），
	// Go 侧仍然要复核（绝对路径 + 存在），见 resume.go 的 openPath。
	Mode string `json:"mode"`
	Path string `json:"path"`
	// project.* 用：Path 是项目的身份（目录绝对路径）；Name 只在 rename /
	// add 时给（空 = 恢复目录名 / 取目录名）；Source 只在 add 时给。
	Name   string `json:"name"`
	Source string `json:"source"`
	// title.set 用：会话 id（= 盘上那份 .jsonl 的文件名）。
	// 左栏那条改名路**手里就有 id**（不像标签那条路只有一个 pid，得靠
	// sessions\<pid>.json 反查 —— 理由见 titles.go 的 sessionIDForPID），
	// 所以直接带 id 过来，少一次反查、也少一个"查不到"的失败模式。
	ID string `json:"id"`
	// open.url 用：在系统浏览器里打开一个 http(s) 地址（Agent 名单的下载页）。
	// 只认 http/https —— 别的 scheme 会让"打开下载页"变成一条可执行动作。
	URL string `json:"url"`
	// settings.set 用：只带用户真的改了的字段（指针 = 这条请求提没提到它）。
	// false / 0 / 空串都是合法值，所以不能用零值判断缺省。
	Settings *settingsPatch `json:"settings,omitempty"`
	// gw.* 用：控制面的读写参数。
	//   Period  today / 7d / 30d / all
	//   Preset  供应商预设 id
	//   Key     供应商 API key —— **只在内存里过一次**，不落日志、不回显
	//   From    分组改名前的 id
	//   Members 分组成员（provider/model）
	//   Plugin  插件 npm 包名；Op 是 add/remove/update/upgrade/off
	//   User    额度卡片的账号
	Period  string   `json:"period,omitempty"`
	Preset  string   `json:"preset,omitempty"`
	Key     string   `json:"key,omitempty"`
	From    string   `json:"from,omitempty"`
	Members []string `json:"members,omitempty"`
	Plugin  string   `json:"plugin,omitempty"`
	Op      string   `json:"op,omitempty"`
	User    string   `json:"user,omitempty"`
	Offset  int      `json:"offset,omitempty"`
	// 供应商编辑（gw.provider.save 且带 id、不带 preset）：三个接入点。
	// 用指针是为了把「没发」和「发来空串（清空这个接入点）」分开 ——
	// 值类型 + omitempty 会让"清空"变成静默无效。
	Chat      *string `json:"chat,omitempty"`
	Responses *string `json:"responses,omitempty"`
	Anthropic *string `json:"anthropic,omitempty"`
	// gw.provider.arrange：开关着的供应商的新顺序（id 列表，靠上的先用）。
	Order []string `json:"order,omitempty"`
	// gw.agent.set 用：Field 是 /api/state 里字段的 key，Value 是选项值。
	// 空串是**有效值** —— magpie 用它把字段还原成 agent 自己的默认，所以
	// Value 不套 omitempty：别让"清空"在编码这一层变成静默无效。
	Field string `json:"field,omitempty"`
	Value string `json:"value"`
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
	// PaneID：**冷恢复建出来的那一格**认领登记表里的旧身份时原样回传。
	// 0 / 缺省 = 这是一格全新的格子，paneId 由 Go 现发（见 paneStore.nextID）。
	// 为什么要这个字段而不是"按顺序认领"：冷恢复的建格是**一次 burst**，
	// 中间还夹着"被拒了就重试"的格子 —— 按顺序认领在那种队列上会整体错位一格
	// （表现是"每格跑的都是隔壁的会话"，而日志全正常）。
	PaneID int `json:"paneId,omitempty"`
	// DegradedFrom：这一格是**降级**建出来的，原本要接的是这条会话（空 = 不是降级）。
	// 降级这个决定是前端做的（只有它知道拒绝码、也只有它知道两次重试都过了）——
	// 而它重建这一格时正好有一趟 `tabs.create` 顺路回来，所以这件事就搭这趟车，
	// 不必再开一条 ctl 消息去说（多一条消息就多一个"它没到"的失败模式）。
	// 它只喂给 panes.markDegraded 留一笔证据，**不参与任何判定**。
	DegradedFrom string `json:"degradedFrom,omitempty"`
}

// agentDef 把「续接意图」翻译成命令行参数，外加这个 agent 需要的环境变量。
//
// 新增第三个 agent = 在这张表里加一条，别处**零改动**。
// 参数来源：计划书那张意图表，两个 agent 各自的 --help 都核实过。
// （pi 先不登记 —— 它的 --session/--fork 要绝对 jsonl 路径，
//
//	那要等索引器把 SourcePath 喂进来，C2 一起做。）
type agentDef struct {
	Exe string
	// Bin 是没解析前的命令名（如 "codex"）。有它时，**每次开格都重新解析一次**
	// 可执行文件位置 —— 用户可能在 Perch 开着的时候装了/更新了一个 agent，
	// init() 里只解析一次会把这个新装的 exe 永远漏在外。claude 走自己的
	// resolveClaudeExe，Bin 为空。
	Bin string
	// Prefix 只在 Windows 的 .cmd/.bat shim 上出现（npm 装出来的 CLI）：
	// Exe 是 cmd.exe，Prefix 是 ["/c", <shim>]。ConPTY 不能直接启动 .cmd。
	Prefix []string
	Env    map[string]string
	// Args 把「续接意图」翻译成命令行。settings 是我们注入的那份 --settings
	// JSON 字符串（空 = 不注入）：它跟着**每一次启动**走、只对这一次生效，
	// 不碰用户的任何配置文件（第 0 步实测：--settings 是**合并**不是替换，
	// 用户 settings.json 里的 env/model 照样生效）。
	Args func(resumeIntent, string) []string
	// Prepare 在每次开格前调用，用来做“这一格才有的”准备：分配端口、生成口令、
	// 决定事件文件路径。cwd 是这一格将要启动的目录（Codex 的 app-server 要在
	// 同一个目录里起来，thread/start 的默认 cwd 才和 TUI 一致）。
	// 返回的 env/args 只作用于这一次启动；observe 在 PTY 起来之后跑，
	// ctx 一取消就退出。Claude 不用它（它的 hook 走 --settings）。
	Prepare func(tag string, tabID int, cwd string) (env map[string]string, args []string, observe func(context.Context), err error)
}

// resolveClaudeExe 找 agent 的可执行文件，顺序：
//
//	① 环境变量 CLAUDE_EXE（换安装位置的人用它）；
//	② <用户主目录>\.local\claude.exe（本机常见的用户级安装位置）；
//	③ 交给 PATH 解析 "claude"。
//
// ⚠️ 不写死任何人的绝对路径。
func resolveClaudeExe() string {
	if v := strings.TrimSpace(os.Getenv("CLAUDE_EXE")); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".local", "claude.exe")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return "claude"
}

var agentDefs = map[string]agentDef{
	"claude": {
		Exe: resolveClaudeExe(),
		Env: map[string]string{"CLAUDE_CONFIG_DIR": claudeStateDir},
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

// 通用适配：凡是有配置/CLI 探测的 agent，都给它一条“新会话”启动路。
// 深度适配（续接、hook、转录）仍然只对 claude 做 —— 用户 2026-10-17 确认的
// 第一阶段范围是“装完能在 Perch 里启动”。
func init() {
	for _, d := range agentCatalogDefs {
		if d.ID == "claude" || d.ID == "zcode" || d.Bin == "" {
			continue
		}
		agentDefs[d.ID] = genericAgentDef(d.Bin)
	}
	// 通用适配只负责“能开一格”；OpenCode 有自己的一套启动参数/状态观察，
	// 覆盖掉通用那条。以后 Pi/Codex 同样在这里覆盖。
	agentDefs["opencode"] = openCodeAgentDef()
	// Pi 也覆盖通用那条：续接参数 + -e 观察扩展。
	agentDefs["pi"] = piAgentDef()
	// Codex：每格一个 app-server + TUI --remote（见 agent_codex.go）。
	agentDefs["codex"] = codexAgentDef()
}

func genericAgentDef(bin string) agentDef {
	exe, prefix := resolveAgentExe(bin)
	return agentDef{
		Exe:    exe,
		Bin:    bin,
		Prefix: prefix,
		Args: func(resumeIntent, string) []string {
			// 通用适配第一阶段只开新会话；续接要按 agent 逐个补。
			return nil
		},
	}
}

type tabHost struct {
	id     int
	stream string
	spec   spawnSpec

	// paneID 是这一格**跨重启的身份**（登记表里的 PaneID，见 panes.go）。
	// ⚠️ 它和 id 是两件事：id 是这一次运行里的编号（1、2、3…，每次启动重发），
	// paneID 是"哪一格"这个问题的答案。拿 id 当身份的话，重启后 1 号格就会
	// 继承上次 1 号格的会话 —— 那正是"接错会话"。
	paneID int

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
	// paneId 在**锁外**定：panes 有自己的锁，而且下面的 bind 会落盘 ——
	// 绝不持着 tm.mu 做磁盘 I/O（那会把所有格子的操作一起卡在文件系统上）。
	paneID := 0
	if spec.PaneID > 0 {
		panes.claim(spec.PaneID, "冷恢复建格")
		paneID = spec.PaneID
	} else if panes != nil {
		paneID = panes.nextID()
	}
	tm.mu.Lock()
	tm.next++
	host := &tabHost{id: tm.next, stream: fmt.Sprintf("term:%d", tm.next), spec: spec, paneID: paneID}
	tm.tabs[host.id] = host
	// 闭包只捕获 host：每次连接自己起一个新 PTY，连接断了那个 PTY 就结束。
	app.HandleStream(host.stream, func(c *application.StreamConn) { handleTab(c, host) })
	tm.mu.Unlock()

	if panes != nil && paneID > 0 {
		// 建格**立刻**记一条：还没有 sessionId 也要写 —— "这一格开着"本身就是一件
		// 事实（它意味着"这一格的座位还在"，重启后要给它留个位置）。
		panes.bind(paneID, spec.Agent, effectiveCWD(spec), "", "", fmt.Sprintf("建格 tab=%d", host.id))
		// 降级那一笔（如果有）**跟在 bind 后面**写：bind 的规矩是"空值不覆盖"，
		// 两者写的是不同字段，谁也不影响谁 —— 分开写是为了让"留证"这件事
		// 一眼看得出是**附带**的，不是建格的一部分。
		if spec.DegradedFrom != "" {
			panes.markDegraded(paneID, spec.DegradedFrom, fmt.Sprintf("tab=%d 被拒后改起新会话", host.id))
		}
	}
	return host
}

// drop 在流断开时把一个标签从运行期表里摘掉。
//
// ⚠️ **它一行都不许碰登记表**（panes.go 的第 ③ 条约束）。原因是一条读 Wails
// 源码得来的关停顺序（application.go:79 vs :199-200，任务按注册序执行）：
// `streams.close` 排在**我们自己的 OnShutdown 之前**，于是关窗那一刻，
// 每个格子的 `defer tabs.drop` 都会先跑一遍 —— 要是这里顺手删了记录，
// 写下去的就是 `{"panes":[]}`，**恢复能力被自己抹掉，而且不报错**。
// 删记录只有一条路：前端在用户点「结束这个 agent」时发 `pane.forget`
// （点 × 发的是 `pane.close` —— 只打 Closed 标记，记录留着）。
func (tm *tabManager) drop(id int) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if h := tm.tabs[id]; h != nil && h.sessionID != "" {
		delete(tm.bySession, h.sessionID)
	}
	delete(tm.tabs, id)
}

// paneIDFor：运行期的 tab id → **跨重启**的 paneId（登记表的身份）。
//
// hook 事件带的是 tab id（它认识的是"这一格"这个运行期概念），而记录认的是
// paneId —— 这层翻译只有 tabManager 做得了，所以它住在这里，读一次就放开锁。
func paneIDFor(tab int) int {
	tabs.mu.Lock()
	defer tabs.mu.Unlock()
	if h := tabs.tabs[tab]; h != nil {
		return h.paneID
	}
	return 0
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
		out = append(out, tabView{
			id: h.id, pid: h.pid, sessionID: h.sessionID, status: h.status,
			name: h.sessName, transcript: h.transcript, cwd: effectiveCWD(h.spec),
		})
	}
	return out
}

// setTranscript 记下这个格子的转录文件（hook SessionStart 里直接给的）。
//
// ⚠️ 它也受步 5 那条规则管（test 造出来的洞：2026-10-17 用一条伪造的
// SessionStart 打在"请求 exact X"的格子上，记录里 sessionId 保住了 X，而
// transcript 被换成了那条伪造事件给的路径 —— 同一份记录里两条字段说了两条会话，
// 读它的人（流水/尾部历史）就会去开一个和 sessionId 无关的文件）。
// 判据是**同一条规则**、只是换了个输入：转录文件名去掉目录和 .jsonl 就是会话 id
// （实测：`projects\<目录>\<session id>.jsonl`），拿它去问 judgeResume 即可 ——
// 多写一条"这两个字段要不要一起改"的规矩，迟早会和那条分叉。
func (tm *tabManager) setTranscript(id int, path string) {
	if path == "" {
		return
	}
	tm.mu.Lock()
	h := tm.tabs[id]
	if h == nil {
		tm.mu.Unlock()
		return
	}
	h.transcript = path
	intent := h.spec.Resume
	paneID, agent, cwd := h.paneID, h.spec.Agent, effectiveCWD(h.spec)
	tm.mu.Unlock()
	// 落盘在**锁外**（磁盘 I/O 不进 tm.mu）
	if panes == nil {
		return
	}
	if stem := transcriptStem(path); judgeResume(intent, stem) == evMissed {
		log.Printf("[panes] ⚠️ 转录路径不记：pane=%d 那条路径说的是会话 %s，而这一格请求的是 %s —— "+
			"记录里 sessionId 和 transcript 必须说**同一条**会话（见 setTranscript 的注释）",
			paneID, short(stem), short(intent.ID))
		return
	}
	panes.bind(paneID, agent, cwd, "", path, "拿到转录路径")
}

// transcriptStem 从转录路径里取会话 id：`…\projects\<目录>\<id>.jsonl` → `<id>`。
// 取不出来（不是 .jsonl / 空）就返回空串 —— 那样 judgeResume 判成"没有承诺"，
// 照旧记（宁可少拦一次，也不要凭一个猜出来的名字去拒绝一条真的路径）。
func transcriptStem(path string) string {
	b := filepath.Base(path)
	if !strings.HasSuffix(b, ".jsonl") {
		return ""
	}
	return strings.TrimSuffix(b, ".jsonl")
}

/*
resumeEvidence 是**步 5 的唯一判据**：「这一次身份到达」能不能当成

	"这一格接回了我们请求的那条会话"的证据。

	⚠️ 为什么需要一条规则，而不是"收到什么就是什么"：`--resume <id>` 的**意图**
	与**结果**是两件事。claude 在某些条件下（会话文件不在它认得的项目目录里、
	文件坏了、被改名了）可能找不到就**开一条新的**，而新会话的 id 会随 hook
	事件到达 —— 我们要是照单全收写进记录，就等于把"接错的那条"固化成事实，
	而且下一次重开会照着它再错一遍。冷恢复整个链条里，**这一步是唯一一次
	"我们以为自己知道了、其实是别人说了算"**。

	✅ 实测（2026-10-16，见 [[resume-hook-source-evidence]]）：`--resume <id>`
	成功时 hook 报 `source=resume` 且 **id 与请求的完全一致**；cwd 与会的所属
	目录错配时 claude 也不会静默换会话（它照旧接住那一条，只把新行的 cwd
	记成新目录）。所以"对不上"在今天是**观察不到**的 —— 这条规则防的是
	"观察不到"变成"发生了也看不出来"。

	三种情况（只有前两种允许改写记录）：
	  evNoPromise  这一格**没有对某条会话的承诺**（裸启动 / --fork-session 写的是
	               新文件 / --continue 挑的是"最新那条"、我们手上没有 id 可比）。
	               来的是谁就是谁 —— 记下来是对的。
	  evMatched    承诺的是 `exact X`，来的**正是** X。这就是 `source=resume`
	               该有的样子；记录照写（同一 id，等价于确认），并撤掉上一次
	               可能留下的那笔落空（panes.clearMismatch）。
	  evMissed     承诺的是 `exact X`，来的却是别人 —— **记录一个字都不改**，
	               只留 mismatchAt（panes.markMismatch）+ 一条醒目日志 + 格内横幅。

	⚠️ `latest` 按"没有承诺"处理：`--continue` 的承诺是"这个目录里最新那条"，
	我们手上**没有 id 可以去对**。判不了的事不判 —— 宁可少记一次落空，
	也不要凭猜测去改记录（猜错的代价是"接错会话"，而那是不可逆的那一类）。
*/
type resumeEvidence int

const (
	evNoPromise resumeEvidence = iota
	evMatched
	evMissed
)

func judgeResume(intent resumeIntent, sid string) resumeEvidence {
	if sid == "" || intent.Kind != "exact" || intent.ID == "" {
		return evNoPromise
	}
	if intent.ID == sid {
		return evMatched
	}
	return evMissed
}

// bindSession 把"这个格子跑的是哪个会话"钉下来（只在第一次生效，返回是否绑上了）。
// 两个调用点：hook 事件（最早，session_id 直接随事件来）和会话登记表（兜底）。
//
// ⚠️ 它同时喂**两张表**，而两张表记的不是同一件事 —— 这是这一层最容易搞混的地方：
//
//	运行期表（h.sessionID + bySession）记的是**事实**：这一格现在跑的就是 sid。
//	  所以要**照实记、无条件记** —— 护栏 liveOwnerOf 靠它拦"两个进程写同一份
//	  jsonl"，记成"我们以为的那条"就会放过一次真正的冲突（那是全项目唯一
//	  不可逆的失败）。
//	盘上那条记录（panes.json 的 sessionId）记的是**意图**：下次重开该去接谁。
//	  这一张只在有证据时才改写（见 judgeResume）。
//
// `source` 只给日志用（SessionStart 事件里带 startup/resume/clear/compact/fork，
// 别的调用点给空串）——**判据本身不依赖它**：我们请求的是 exact X，来的不是 X
// 就是落空，这件事不需要 claude 自报家门。
func (tm *tabManager) bindSession(id int, sid, name, source string) bool {
	tm.mu.Lock()
	h := tm.tabs[id]
	if h == nil || h.sessionID != "" || sid == "" {
		tm.mu.Unlock()
		return false
	}
	h.sessionID = sid
	if name != "" {
		h.sessName = name
	}
	tm.bySession[sid] = h
	intent := h.spec.Resume
	paneID, agent, cwd := h.paneID, h.spec.Agent, effectiveCWD(h.spec)
	tm.mu.Unlock()

	// 没有续接能力的 agent（OpenCode 现在就是）不要拿请求的 exact 去判落空：
	// 它本来就会开一条新会话，判成 mismatch 只会给用户挂一条假横幅。
	if !capsForAgent(agent).Resume {
		intent = resumeIntent{Kind: "new"}
	}

	// 首次身份绑定**立即落盘**（配 ~250ms 合并窗，见 panes.go 的 paneFlushWindow）：
	// 建格到绑上身份之间大约 1–3 秒，正是整条链最脆的窗口 —— 这段里被关掉，
	// 记录里就只会有"这一格开着、不知道跑的是谁"。⚠️ 出了锁才写：那是磁盘 I/O。
	if panes == nil {
		return true
	}
	switch judgeResume(intent, sid) {
	case evMissed:
		panes.markMismatch(paneID, intent.ID, sid, "首次身份到达")
		log.Printf("[panes] ⚠️ 续接落空：请求 %s 实际 %s（source=%s）—— 格子 t%d pane=%d。"+
			"记录里那条会话 id **一个字都不改**（盘上那条还在），只留 mismatchAt",
			short(intent.ID), short(sid), orNone(source), id, paneID)
		// 格内横幅（步 6）：横幅是给**人**看的，日志是给排查看的，两样都要。
		// pushJSON 走 ctl 那条常驻通道，加锁的，可以从任何 goroutine 调。
		pushJSON(map[string]any{
			"type": "pane.mismatch", "pane": paneID, "tab": id,
			"want": intent.ID, "got": sid, "source": source,
		})
	case evMatched:
		if panes.clearMismatch(paneID, fmt.Sprintf("续接对上 tab=%d（撤掉上次那笔落空）", id)) {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（source=%s）—— 上次那笔落空撤掉",
				id, paneID, short(sid), orNone(source))
		} else {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（source=%s）",
				id, paneID, short(sid), orNone(source))
		}
		panes.bind(paneID, agent, cwd, sid, "", fmt.Sprintf("首次绑上会话 tab=%d（证据对上）", id))
	default:
		panes.bind(paneID, agent, cwd, sid, "", fmt.Sprintf("首次绑上会话 tab=%d", id))
	}
	return true
}

// rebindSession 是“格内换了会话”的路径（OpenCode 的 active session 变了会走它）。
// 和 bindSession 的区别只有一个：允许覆盖已有的 sessionID。
//
// 为什么要单独一条：bindSession 的“只在第一次生效”是 Claude 那条链子的护栏
// （hook 和登记表会先后报同一个 id，不能让后到的把先到的改掉）。但格内 /new、
// /clear 之后确实会换一条会话；前端靠 agent 消息里的 session 改写，Go 这边的
// bySession 反查表也必须跟着改，否则后续事件会继续认旧格子。
func (tm *tabManager) rebindSession(id int, sid, name, source string) bool {
	tm.mu.Lock()
	h := tm.tabs[id]
	if h == nil || sid == "" || h.sessionID == sid {
		tm.mu.Unlock()
		return false
	}
	old := h.sessionID
	if old != "" {
		delete(tm.bySession, old)
	}
	h.sessionID = sid
	if name != "" {
		h.sessName = name
	}
	tm.bySession[sid] = h
	intent := h.spec.Resume
	paneID, agent, cwd := h.paneID, h.spec.Agent, effectiveCWD(h.spec)
	tm.mu.Unlock()

	log.Printf("[agent t%d] 会话改写 %s → %s（source=%s）",
		id, short(old), short(sid), orNone(source))
	if !capsForAgent(agent).Resume {
		intent = resumeIntent{Kind: "new"}
	}
	if panes == nil {
		return true
	}
	// 和 bindSession 用同一条判据：请求的是 exact X 却来了 Y，记录里那条 id
	// 一个字都不改，只留 mismatch；格子的内存身份仍然跟着 Y（它才是现在跑的）。
	switch judgeResume(intent, sid) {
	case evMissed:
		panes.markMismatch(paneID, intent.ID, sid, "格内换会话")
	case evMatched:
		if panes.clearMismatch(paneID, fmt.Sprintf("格内换会话对上 tab=%d", id)) {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（格内换会话）",
				id, paneID, short(sid))
		}
	default:
		panes.bind(paneID, agent, cwd, sid, "", fmt.Sprintf("格内换会话 tab=%d", id))
	}
	return true
}

// orNone 让日志里那个字段永远**有值**：空字符串在日志里和"这一行没打出来"
// 长得一样，而"source 是空的"（比如登记表那条兜底路径根本没有 source）
// 本身是一条要看得见的事实。（同理由见 panes.go 那条 nil/空切片的老账。）
func orNone(s string) string {
	if s == "" {
		return "(未报)"
	}
	return s
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

// ctlConnected = 前端那条控制通道此刻在不在。
// 关窗确认必须问它：页面还没连上（启动最初一两秒）或者已经崩了的时候，
// 不能因为"要确认"把窗口卡死 —— 那种情况下放行才是对的。
func ctlConnected() bool {
	pushMu.Lock()
	defer pushMu.Unlock()
	return pushConn != nil
}

// 关窗确认的三个状态。零值 = 还没问过 / 刚被取消。
//
//	closeConfirmed  前端已确认，这次 WindowClosing 直接放行
//	closeAskAt      上一次问前端的时刻（UnixNano）。30s 没有答复就放行，
//	                避免一个卡死的前端把窗口锁住
var (
	closeConfirmed atomic.Bool
	closeAskAt     atomic.Int64
)

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

// poolReply 把池子的**最新全量**推回前端（projects + 归属 + 根）。
//
// 为什么每次都是全量而不是"改了哪条回哪条"：归属是算出来的（一条会话的
// 归属会随着"谁加了哪个项目"整体变），增量的差集要在两边各维护一份状态、
// 迟早会漂。池子操作是低频动作，全量重算一次是毫秒级 —— 拿一次重扫换掉
// 一整类"两边不一致"的毛病。会话数少的时候这笔买卖非常划算。
//
// 走 pushJSON 而不是 c.Send：挑目录那条路要开系统对话框（阻塞），应答是从
// 一个协程里发出来的，手里没有 ctl 那根流（见 "project.add" 的注释）。
func poolReply(errMsg string) {
	if pool == nil {
		pushJSON(map[string]any{"type": "pool", "err": "项目池不可用", "projects": []any{}, "assign": map[string]string{}})
		return
	}
	t0 := time.Now()
	projects, roots := pool.snapshot()
	// 合成的默认工作区只并进这一份**内存列表**（归属计算和 wire 都吃它）——
	// 池子本身照旧，落盘的还是用户自己攒的那些（见 withDefaultWorkspace）。
	projects = withDefaultWorkspace(projects)
	sessions, _ := scanSessions(claudeStateDir)
	assign, recent, count := projectStats(sessions, projects)
	wire := wireProjects(projects, recent, count)
	pushJSON(map[string]any{
		"type":     "pool",
		"projects": wire,
		"assign":   assign,
		"roots":    roots,
		"err":      errMsg,
	})
	sum, nUn, nMain, nAll := poolAudit(sessions, assign, wire)
	log.Printf("[pool] 推回前端：%d 个项目 / 归属 %d 条（Σ项目 %d + 未归类 %d = %d，主会话共 %d，全部 %d）；用时 %v",
		len(wire), len(assign), sum, nUn, sum+nUn, nMain, nAll, time.Since(t0).Round(time.Millisecond))
}

// bootAgentCards 是冷恢复应答里附带的本机 Agent 名单。
//
// 前端要在**建第一格之前**决定默认用哪个 agent，而那一刻 shell 载荷还没到
// （它要扫会话库）；panes.query 是唯一更早的往返，所以名单跟着它走。
// 和总览用的是同一份 scanAgentCatalog —— 两份探测规则迟早会漂。
func bootAgentCards() []agentCard {
	if s := magpieSnapshot(); s != nil && len(s.Catalog) > 0 {
		return s.Catalog
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return []agentCard{}
	}
	return scanAgentCatalog(home)
}

// defaultAgentSetting 是设置里的显式默认（空 = 自动）。前端自己还会校验
// “已安装 / 能启动”，这里只把落盘的事实带过去。
func defaultAgentSetting() string {
	if prefsStore == nil {
		return ""
	}
	return prefsStore.snapshot().DefaultAgent
}

func handleCtl(c *application.StreamConn) {
	defer c.Close()
	setPushConn(c)
	defer setPushConn(nil)
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
		var m ctrlMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "tab.new":
			if m.Spec == nil {
				continue
			}
			// 令牌去重（见 handleCtl 开头那张表）：前端超时后会拿同一个 req 重发
			if m.Req != 0 {
				if prev, ok := tabReqCache[m.Req]; ok {
					_ = c.Send(prev)
					log.Printf("[ctl] tab.new 令牌 req=%d 重复（前端重发同一次请求）→ 重放上次的应答，不建第二个格子", m.Req)
					continue
				}
			}
			// C2 护栏：判**在建标签之前**。一个没有 PTY 的占位格比"什么都没发生"
			// 更糟 —— 界面上会多出一格，用户以为它在跑。判据见 resume.go。
			if ref := resumeRefusal(*m.Spec); ref != nil {
				reply, _ := json.Marshal(map[string]any{
					"type": "tab.ok", "tab": 0, "stream": "", "req": m.Req,
					// 被拒也要把 paneId 带回去：前端要么用它重试同一格
					// （瞬时冲突那 2 次重试，见计划书步 4），要么让它显式降级 ——
					// 少一个身份，降级后的那一格就没法再写进记录里。
					"pane": m.Spec.PaneID,
					"err":  ref.code, "msg": ref.msg,
					// 能不能重试由**判的人**给（见 resume.go 的 refusal.retryable）：
					// 前端不许拿 code 去查表 —— 那是第二份会漂的规则。
					"retryable": ref.retryable,
				})
				_ = c.Send(reply)
				if m.Req != 0 {
					tabReqCache[m.Req] = reply // 拒绝也是应答：重发时重放它，不重新判一次护栏
				}
				log.Printf("[ctl] 拒绝接上 agent=%s cwd=%s resume=%s id=%s pane=%d 因=%s：%s",
					m.Spec.Agent, m.Spec.CWD, m.Spec.Resume.Kind, m.Spec.Resume.ID,
					m.Spec.PaneID, ref.code, ref.msg)
				continue
			}
			host := tabs.create(globalApp, *m.Spec)
			reply, _ := json.Marshal(map[string]any{
				"type": "tab.ok", "tab": host.id, "stream": host.stream, "req": m.Req,
				// paneId 是这一格**跨重启的身份**：前端拿着它，才能在用户显式
				// 关格时发 pane.forget（那是唯一一条会删记录的路径）。
				"pane": host.paneID,
			})
			_ = c.Send(reply)
			if m.Req != 0 {
				tabReqCache[m.Req] = reply // 重发同一令牌时重放它 —— 绝不建第二个格子
			}
			log.Printf("[ctl] 新标签 tab=%d pane=%d stream=%s agent=%s cwd=%s resume=%s id=%s",
				host.id, host.paneID, host.stream, m.Spec.Agent, m.Spec.CWD,
				m.Spec.Resume.Kind, m.Spec.Resume.ID)
		case "panes.query":
			/* 冷恢复的那一次查询（步 3）：前端在**建任何格子之前**问一次
			   "上一轮有哪几格"，拿回来的清单决定这一轮摆哪几个座位、各起什么。

			   ⚠️ 为什么是请求/应答，而不是开窗时随 ShellPayload 一起推下去：
			   前端在**模块求值期间**就已经把默认那一格建出来了（index.html 的
			   `await createTab(DEFAULT_SPAWN_SPEC)`），ShellPayload 到达时那一格
			   已经起来、并且已经在会话库里落了一条空会话 —— 那股噪音正是这一轮
			   要消灭的东西。查询能在它之前发生，载荷不能。 */
			// 步 7：第二个实例**一个座位都不恢复** —— 它要是也跟着按记录起
			// `--resume`，两个实例会在"护栏还看不见对方"的那一两秒里各接一条
			// 同一条会话（这条链上唯一不可逆的失败，见 instance_windows.go）。
			// 回 err 就是前端的"登记表不可用"那条路：它自己起一个默认格，
			// 把界面交出去，并在日志里带一句 err=…（前端那行 bootFact 会写出来）。
			if secondInstance {
				reply, _ := json.Marshal(map[string]any{
					"type": "panes.list", "panes": []any{},
					"agents": bootAgentCards(), "defaultAgent": defaultAgentSetting(),
					"err": "已经有一个我在跑（单实例闸）—— 这一轮不恢复任何会话",
				})
				_ = c.Send(reply)
				continue
			}
			if panes == nil {
				reply, _ := json.Marshal(map[string]any{
					"type": "panes.list", "panes": []any{}, "err": "登记表不可用",
					"agents": bootAgentCards(), "defaultAgent": defaultAgentSetting(),
				})
				_ = c.Send(reply)
				continue
			}
			plan := panes.restorePlan() // 这一行自己打计数 + 座位序（见 panes.go）
			reply, err := json.Marshal(map[string]any{
				"type": "panes.list", "panes": plan.Views,
				"agents": bootAgentCards(), "defaultAgent": defaultAgentSetting(),
			})
			if err != nil {
				log.Printf("[panes] 冷恢复清单序列化失败（前端会走无应答那条兜底）：%v", err)
				continue
			}
			_ = c.Send(reply)
		case "pane.close":
			/* 用户**关掉了这一格的运行**（点格子头的 ×）—— 记录留着、打上 Closed。
			   它和 pane.forget 的分工见 panes.go 的 Pane.Closed：关格 = "我现在不需要
			   它开着"，结束 agent = "我不要它了"。这里绝不删记录。 */
			if panes == nil {
				continue
			}
			if panes.markClosed(m.Pane, "用户点格子头的 ×") {
				log.Printf("[ctl] pane.close pane=%d（关格保留记录，重启不自动拉起）", m.Pane)
			} else {
				log.Printf("[ctl] pane.close pane=%d：盘上没有这条记录（可能已经摘过），不动", m.Pane)
			}
		case "pane.forget":
			// **唯一**一条会删记录的路径：用户明确不要这个 agent 了（左栏「结束这个 agent」）。
			// 别的消失方式（进程挂了 / 流断了 / 关窗口 / 点 ×）一律不出现在这里 ——
			// "记录是证据，不是垃圾"（见 tabs.drop 上面那段）。
			if panes == nil {
				continue
			}
			if panes.forget(m.Pane, "用户关格") {
				log.Printf("[ctl] pane.forget pane=%d（用户显式关格 —— 只有这条路会摘记录）", m.Pane)
			} else {
				log.Printf("[ctl] pane.forget pane=%d：盘上没有这条记录（可能已经摘过），不动", m.Pane)
			}
		case "title.set":
			/* 用户在左栏给一条会话起名 / 改名。写的是**显示名**，不是 id ——
			   id 是 claude 那份 jsonl 的文件名，`--resume`、我们的记录、会话索引
			   四条链都指着它，改它等于一次性打断四条（见 panes.go 的 Pane.SessionID）。

			   它和标签那条改名路（下面字节流上的 "rename"）写的是**同一张表**：
			   名字的主语永远是会话（titles.go 开头那段）。差别只在信息从哪来 ——
			   标签只有 pid 得反查，左栏直接给 id。
			   空名字 = 清除（回到 agent 自己写的标题），两条路的语义必须一样，
			   否则"在左栏清掉"和"在标签上清掉"会得到两个不同的结果。 */
			id := strings.TrimSpace(m.ID)
			if id == "" || titlesStore == nil {
				log.Printf("[title] title.set 缺 id 或名字表不可用，不动：id=%q", id)
				continue
			}
			if err := titlesStore.set(id, m.Name); err != nil {
				log.Printf("[title] 写 titles.json 失败（会话 %s）：%v", short(id), err)
				// 前端是**乐观**改的（先把那一行改了、再落盘），所以这里必须有一条
				// 回来的路：把权威的那份表推回去，让界面掉回真实状态。不推的话，
				// 屏幕上挂着一个盘上不存在的名字，下次打开又变回去 —— 那种
				// "我明明改过"的悬案最难查。
				pushJSON(map[string]any{"type": "titles", "titles": titlesStore.snapshot()})
				continue
			}
			if strings.TrimSpace(m.Name) == "" {
				log.Printf("[title] 会话 %s 的名字已清除（左栏），回到 agent 自己写的标题", short(id))
			} else {
				log.Printf("[title] 会话 %s 命名为 %q（左栏）", short(id), strings.TrimSpace(m.Name))
			}
		case "open":
			// 在系统里打开一个路径（卡片菜单里的"打开会话文件/在文件夹中显示/
			// 打开工作目录"）。换协程：explorer 起进程不该拖住 ctl 收包。
			go openPath(m.Mode, m.Path)
		case "open.url":
			// Agent 名单的「下载」= 打开官方安装页（**不是**替用户跑安装脚本）。
			// 只放 http/https：别的 scheme 会把一个"看网页"的按钮变成可执行动作。
			u := strings.TrimSpace(m.URL)
			if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
				log.Printf("[web] 拒绝打开非 http(s) 地址：%q", u)
				continue
			}
			go func(u string) {
				if globalApp == nil {
					return
				}
				if err := globalApp.Browser.OpenURL(u); err != nil {
					log.Printf("[web] 打开下载页失败 %s：%v", u, err)
				} else {
					log.Printf("[web] 打开下载页 %s", u)
				}
			}(u)
		case "install.agent":
			// 用户点下「安装」之后才跑官方命令。换协程：npm/irm 可能跑几分钟。
			id := strings.TrimSpace(m.ID)
			if id == "" {
				continue
			}
			log.Printf("[install] 用户请求安装 agent=%s", id)
			go startAgentInstall(id)
		case "install.magpie":
			// 网关页的「下载并安装 magpie」。和 agent 安装共用同一条流式通道
			// （install.start/log/done，id=magpie），装完 finishInstall 会自动
			// gwConnect —— 用户不需要再点「连接」。
			log.Printf("[install] 用户请求安装 magpie（官方 release）")
			go startAgentInstall("magpie")
		case "install.cancel":
			id := strings.TrimSpace(m.ID)
			log.Printf("[install] 用户取消安装 agent=%s", id)
			go cancelAgentInstall(id)
		case "magpie.refresh":
			// 用户点刷新：立刻跑一轮（后台 watcher 仍在按自己的节奏走）。
			// 换协程 —— HTTP 最长 5 × 1.8s，不能把 ctl 收包卡住。
			go func() {
				magpieWatchMu.RLock()
				w := magpieWatch
				magpieWatchMu.RUnlock()
				if w != nil {
					w.refresh()
					log.Printf("[magpie] 手动刷新完成")
				}
			}()
		case "magpie.update.get":
			// 读控制面自己的更新状态（GET /api/update），只读。
			go gwMagpieUpdateGet()
		case "magpie.update.install":
			// 用户点了「更新」：驱动 magpie 自己的 check → download → install。
			go gwMagpieUpdateInstall()
		case "gw.connect":
			go gwConnect()
		case "gw.disconnect":
			gwStop()
		case "gw.refresh":
			go gwRefresh()
		// Agent 接线（总览 → Agent 名单 → 右侧配置抽屉，见 agent_cfg.go）。
		// 只读一次 /api/state 就能拿全部字段；写操作全是用户点出来的。
		case "gw.agents":
			go gwAgentState()
		case "gw.agents.prefetch":
			// 进总览时预取：只在用过网关的机器上接/拉起控制面（见 gwAgentPrefetch）。
			go gwAgentPrefetch()
		case "gw.agent.set":
			go gwAgentSet(strings.TrimSpace(m.ID), strings.TrimSpace(m.Field), m.Value)
		case "gw.agent.connect":
			go gwAgentAction("connect", strings.TrimSpace(m.ID))
		case "gw.agent.disconnect":
			go gwAgentAction("disconnect", strings.TrimSpace(m.ID))
		case "gw.agent.reapply":
			go gwAgentAction("reapply", strings.TrimSpace(m.ID))
		case "gw.agent.keep":
			// 「保留现状」：magpie 删掉 applied 记录，把现在的配置认作它写的。
			go gwAgentAction("keep", strings.TrimSpace(m.ID))
		case "gw.agent.preview":
			go gwAgentPreview(strings.TrimSpace(m.ID))
		case "gw.agents.drift":
			// 抽屉开着时的漂移轮询（15s 一次）：只读 /api/drift，不拉起控制面。
			go gwAgentDrift()
		// 供应商 / 分组 / 插件 / 用量的写操作不再经过 Perch：网关页内嵌的是
		// magpie 自己的界面，它直接打自己的 /api/*（见 gwui.go）。
		// -------------------------------------------------------------------
		// 设置页（Perch 自己的偏好，见 settings.go）
		// -------------------------------------------------------------------
		case "settings.get":
			// 进设置页时问一次权威值；也用于 shell 载荷没到时的补读。
			pushSettings("")
		case "settings.set":
			if m.Settings == nil {
				continue
			}
			applySettingsPatch(*m.Settings, "设置改动")
		case "settings.pickDefaultCWD":
			// 选默认工作目录。和 project.add 一样：系统选择器是**阻塞**的，
			// 必须换协程，否则整条 ctl 在对话框开着的时候停止收包。
			go func() {
				if globalApp == nil {
					pushSettings("窗口还没起来，选择器打不开")
					return
				}
				sel, err := globalApp.Dialog.OpenFile().
					CanChooseDirectories(true).
					CanChooseFiles(false).
					SetTitle("新 agent 默认落在哪个目录？").
					PromptForSingleSelection()
				if err != nil {
					low := strings.ToLower(err.Error())
					if strings.Contains(low, "cancel") {
						log.Printf("[settings] 默认目录选择器被取消（没有改动）")
						return
					}
					log.Printf("[settings] 默认目录选择器失败：%v", err)
					pushSettings("选择器打不开：" + err.Error())
					return
				}
				if strings.TrimSpace(sel) == "" {
					log.Printf("[settings] 默认目录选择器被取消（没有改动）")
					return
				}
				applySettingsPatch(settingsPatch{DefaultCWD: &sel}, "设置默认目录")
			}()
		case "window.close":
			// 前端确认过了（设置页的「关闭窗口前确认」）。置位后 WindowClosing
			// 那道 hook 直接放行，走 Wails 默认的关窗路。
			closeConfirmed.Store(true)
			closeAskAt.Store(0)
			log.Printf("[settings] 关窗确认：用户确认关闭，放行")
			if mainWindow != nil {
				mainWindow.Close()
			}
		case "window.close.cancel":
			closeAskAt.Store(0)
			log.Printf("[settings] 关窗确认：用户取消，窗口留着")
		case "project.add":
			// 加一个项目（左栏那一轮）。两种进法：
			//   · 带 path —— 拖拽落进来的目录、或从「未归类」收编（source="adopted"）
			//   · 不带 path —— 开**系统**的文件夹选择器让用户去指。
			// 为什么用系统选择器而不是自己画目录树：用户要的动作是"指一个盘上的
			// 目录"，系统那个里已经摆着他所有的快捷方式、能搜索、能新建文件夹 ——
			// 我们画一个只会更差。API 依据：dialogs.go:217 `CanChooseDirectories`
			// + :262 `PromptForSingleSelection`（Windows 实现确实处理选目录，
			// dialogs_windows.go:136）。
			if pool == nil {
				pushJSON(map[string]any{"type": "pool", "err": "项目池不可用（读配置目录失败）"})
				continue
			}
			if p := strings.TrimSpace(m.Path); p != "" {
				pr, added, err := pool.add(p, m.Name, m.Source)
				if err != nil {
					log.Printf("[pool] 加项目失败 %s：%v", p, err)
					poolReply(err.Error())
					continue
				}
				log.Printf("[pool] 加项目 %q（%s）路径=%s 新增=%v", pr.Name, pr.Source, pr.Path, added)
				poolReply("")
				continue
			}
			// ⚠️ 选择器是**阻塞**的（用户可能盯着它想很久），所以这条必须换协程，
			// 否则整条 ctl 会在对话框开着的时候停止收包 —— 那时连日志都进不来。
			// 代价是应答不能再用 c.Send（那是循环里那根），改走 pushJSON：
			// 它自带锁，本来就是多协程在用的那条路（转录跟随器就在用）。
			go func() {
				sel, err := globalApp.Dialog.OpenFile().
					CanChooseDirectories(true).
					CanChooseFiles(false).
					SetTitle("把哪个目录收进 Perch？").
					PromptForSingleSelection()
				if err != nil {
					// 取消在这套对话框实现里是**一个 error**（go-common-file-dialog
					// 的 ErrorCancelled 原文 "cancelled by user"），不是空路径。
					// 早先只判了空字符串，于是用户按取消会收到一条「项目池出错了」
					// 的 toast —— 取消是正常手势，不该报警。这里按语义判掉。
					low := strings.ToLower(err.Error())
					if strings.Contains(low, "cancel") {
						log.Printf("[pool] 选择器被取消（没有加任何项目）")
						return
					}
					log.Printf("[pool] 文件夹选择器失败：%v", err)
					poolReply("选择器打不开：" + err.Error())
					return
				}
				if strings.TrimSpace(sel) == "" {
					// 已经选了路径但返回空：按取消处理。**这不是错误** —— 不弹任何提示。
					log.Printf("[pool] 选择器被取消（没有加任何项目）")
					return
				}
				pr, added, err := pool.add(sel, "", "manual")
				if err != nil {
					log.Printf("[pool] 加项目失败 %s：%v", sel, err)
					poolReply(err.Error())
					return
				}
				log.Printf("[pool] 加项目 %q（选择器）路径=%s 新增=%v", pr.Name, pr.Path, added)
				poolReply("")
			}()
		case "project.remove":
			// 只从池子里摘掉，**磁盘上一个字节都不动**（这一点必须做进 UI 的措辞里：
			// Orca 的 RemoveFolderDialog.tsx:101-104 原话就是
			// "This only removes X from Orca. It is still on your disk."）。
			// "删到回收站"是另一个动作，见计划书的 L2 —— 两者绝不能合成一个按钮。
			if pool == nil {
				continue
			}
			if ok, err := pool.remove(m.Path); err != nil {
				log.Printf("[pool] 移除失败 %s：%v", m.Path, err)
				poolReply(err.Error())
			} else {
				log.Printf("[pool] 移除项目 %s（只从池子里摘掉，磁盘未动）命中=%v", m.Path, ok)
				poolReply("")
			}
		case "project.pin":
			if pool == nil {
				continue
			}
			if ok, err := pool.setPinned(m.Path, m.On); err != nil {
				log.Printf("[pool] 置顶改动失败 %s：%v", m.Path, err)
				poolReply(err.Error())
			} else {
				log.Printf("[pool] 置顶 %s = %v 命中=%v", m.Path, m.On, ok)
				poolReply("")
			}
		case "project.rename":
			// 改的是**显示名**，磁盘上那个目录不动。空名 = 恢复成目录名。
			if pool == nil {
				continue
			}
			if ok, err := pool.rename(m.Path, m.Name); err != nil {
				log.Printf("[pool] 改名失败 %s：%v", m.Path, err)
				poolReply(err.Error())
			} else {
				log.Printf("[pool] 改名 %s → %q 命中=%v", m.Path, m.Name, ok)
				poolReply("")
			}
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
			st := buildShellPayload(claudeStateDir, defaultCWD(), titlesStore.snapshot())
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

// titlesStore 是用户给会话起的名字（见 titles.go）。在 main 里初始化 ——
// 它要读盘，放在包级变量的初始化里会让"读盘失败"发生在 log 还没配好之前。
var titlesStore *titleStore

// pool 是项目池（见 projects.go）。**同样在 main 里初始化**，理由同上；
// nil = 没起来（拿不到配置目录），这时候所有 project.* 都是 no-op 并在
// 日志里说清楚 —— 半死不活的池子（能读不能写）比明确的不可用更难查。
var pool *projectPool

// prefsStore 是 Perch 自己的偏好（见 settings.go）。必须在 pool 之前载入 ——
// defaultWorkspacePath 会读它。nil = 还没初始化（只有测试路径会见到）。
var prefsStore *settingsStore

// panes 是格子登记表（冷恢复的输入）。nil = 没起来（拿不到用户配置目录），
// 这时候所有记录动作都是 no-op —— 冷恢复这一轮退化成现状（一个默认格）。
var panes *paneStore

// secondInstance = 这台机器上已经有一个我在跑（见 instance_windows.go 的步 7）。
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
	// 设置要在池子**之前**载入：defaultWorkspacePath() 会读里面的「默认目录」，
	// 而 ensureDefaultWorkspace / 合成的默认工作区都走它。
	prefsStore = loadSettingsStore()
	pool = loadProjectPool()
	// 「安装即存在」那条要求落地的就是这一句：默认工作区那个目录**由我们建出来**，
	// 因为新格没挑项目时会落在它里面（claude 起不来一个不存在的 cwd）。
	// 它不写进 projects.json —— 合成的池子条目只在内存里（见 withDefaultWorkspace）。
	ensureDefaultWorkspace()

	/* 步 7：单实例闸 —— **必须早于登记表被使用**，因为它决定这份登记表能不能写。
	   判据与代价见 instance_windows.go 那段。这里的取值逻辑只有一条：
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

	// 格子登记表（冷恢复的输入，见 panes.go）。它只记**意图**（哪几格、各跑哪条
	// 会话），不记状态 —— 所以"重启后不许假装在跑"这件事不需要额外实现。
	panes = loadPaneStore()
	if secondInstance && panes != nil {
		// 只读 = 不写；恢复那一步由 panes.query 的应答挡（见下面那段）。
		panes.setReadOnly("已经有一个我在跑（步 7 的单实例闸）")
	}
	paneStoreWarn(panes)

	// C3：**第一个动作**就是给自己上"随进程退出清理整棵树"的保险 ——
	// 必须早于任何子进程（窗口的 WebView2、每个格子的 ConPTY 都在这之后才起）。
	// 挂一次宿主，此后所有进程靠继承覆盖，不需要每格再管一次。
	ownProcessTree()

	app := application.New(application.Options{
		Name:        "Perch",
		Description: "面向 agent 终端的 Windows 桌面网关",
		Assets: application.AssetOptions{
			// /gwui/ 只做一次跳转：把网关页的 iframe 指到本地反代
			// （见 gwui.go；真正的 /gwui/* 与 /api/* 在 127.0.0.1 的
			// 随机端口上，因为 Wails 这一版交给 asset handler 的
			// POST 请求没有请求体）。其余路径仍由嵌入的 assets 提供。
			Handler: gwUIAssets{assets: application.BundledAssetFileServer(assets)},
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
	   前端确认后发 window.close：closeConfirmed 一置位，这条路就直接放行。
	   前端不在（ctl 没连上/崩了）时放行 —— 确认是为了防手滑，不是为了锁死窗口。 */
	mainWindow.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if closeConfirmed.Load() {
			return
		}
		if prefsStore == nil || !prefsStore.snapshot().ConfirmClose {
			return
		}
		if !ctlConnected() {
			log.Printf("[settings] 关窗确认：前端控制通道不在，直接放行（不能把窗口锁死）")
			return
		}
		now := time.Now()
		if last := closeAskAt.Load(); last != 0 && now.Sub(time.Unix(0, last)) > 30*time.Second {
			log.Printf("[settings] 关窗确认：问了 30s 没有答复，放行这一次关闭")
			return
		}
		e.Cancel()
		if closeAskAt.CompareAndSwap(0, now.UnixNano()) {
			log.Printf("[settings] 关窗确认：窗口要关，先问前端（确认框）")
		}
		mainWindow.EmitEvent("perch:close-request")
	})

	// hooks：每个格子启动时现造一份**只对它生效**的 --settings（不碰用户的配置文件）。
	// 接收器不在 exe 旁边就造不出来 → 不注入，忙闲那条腿仍然可用。
	if exe := hookExePath(); exe == "" {
		log.Printf("[hook] 未注入 hooks：%s 不在 exe 旁边（忙闲仍来自 sessions\\<pid>.json）", hookExeName)
	} else {
		log.Printf("[hook] 已备好：%d 个事件（exec 形式 / 交互点 sync、其余 async / timeout=5s）接收器=%s 事件目录=%s",
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
	// 网关读数（只读）：本机那份立刻出，HTTP 那条腿在后台 2.5s 一次。
	// 它不参与任何 PTY/会话逻辑 —— 网关关着时最坏也只是总览少几张读数。
	startMagpieWatcher(pushJSON)
	// 控制面只做**被动探测**：接已经存在的那个，不在这里拉起 magpie web ——
	// 用户没点「连接」之前，Perch 不该多出一个后台进程。
	go gwProbe()

	/* 关窗那一刻**同步**把登记表写一遍（写的是内存里那份，见 panes.go 的 flushSync）。
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
			panes.flushSync("窗口正在关闭")
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
			panes.flushSync("应用收尾（Quit/信号）")
		}
	})

	// 网关页内嵌 magpie 界面所需的本地反代（127.0.0.1，随机端口 + token）。
	// 必须在 Run 之前起：页面首帧就可能落到网关页。
	gwUIStart()

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
	// 这是那个 BREAKAWAY_OK 标志的存在理由之一（见 job_windows.go 文件头 ②），
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
func handleShell(c *application.StreamConn) {
	defer func() {
		time.Sleep(120 * time.Millisecond)
		_ = c.Close()
	}()

	b, err := json.Marshal(buildShellPayload(claudeStateDir, defaultCWD(), titlesStore.snapshot()))
	if err != nil {
		log.Printf("[perch] 索引失败: %v", err)
		return
	}
	log.Printf("[perch] 索引 %d 字节", len(b))
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

/*
前端上报的一帧。data 与 err 二选一。

	⚠️ 读 conn 的**只能有一个 goroutine**（Receive 内部是 sync.Cond，两个读者会把帧
	随机分走 —— 键盘字节被偷走那种错）。所以这里不是"再加一个读者"，而是把**读**
	整个搬进这个 goroutine：这个 goroutine 是全程唯一的读家，处理逻辑只从通道拿帧。
*/
type tabFrame struct {
	data []byte
	err  error
}

/*
读帧 goroutine。为什么非得把读挪出去（2026-10-16 实测的根因）：

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
	  所以塞帧要走 select，done 一关就撤。
*/
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
					log.Printf("[perch] 前端报尺寸 %dx%d，按此启动 PTY", m.Cols, m.Rows)
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
			log.Printf("[perch] 前端 %v 内未报尺寸，按 %dx%d 兜底启动（其间收到 %d 帧，转交收包循环）",
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
		log.Printf("[perch] tab=%d 未知 agent %q", host.id, host.spec.Agent)
		_ = c.Send([]byte("\r\n\x1b[31m[perch] 未知 agent: " + host.spec.Agent + "\x1b[0m\r\n"))
		return
	}
	tag := fmt.Sprintf("t%d", host.id)
	// 「新格没指定目录时落在哪」只有这一个答案（见 effectiveCWD / defaultCWD）——
	// 2026-10-16 起是默认工作区，不是 fallbackCWD。这也正是记进登记表的那个值。
	// Prepare 也要它：Codex 的 app-server 必须和 TUI 在同一个目录里起来。
	cwd := effectiveCWD(host.spec)
	// Prepare 是“这一格才有的”启动准备（OpenCode 的端口/口令、Codex 的
	// app-server 都是它给的）。
	var prepEnv map[string]string
	var prepArgs []string
	var observe func(context.Context)
	if def.Prepare != nil {
		var perr error
		prepEnv, prepArgs, observe, perr = def.Prepare(tag, host.id, cwd)
		if perr != nil {
			log.Printf("[perch] tab=%d 启动准备失败: %v", host.id, perr)
			_ = c.Send([]byte("\r\n\x1b[31m[perch] 启动准备失败: " + perr.Error() + "\x1b[0m\r\n"))
			return
		}
	}
	// hooks 是**每格子一份**：事件文件路径写死进这一份 --settings 里，
	// 于是"这条事件属于哪个格子"由文件名决定，不需要任何反查（见 hooks.go 末尾那段）。
	// 只有 Claude 用这份 --settings；别的 agent 传空串。
	settings := ""
	if host.spec.Agent == "claude" {
		settings = buildHookSettings(tag)
	}
	// 每次开格重新解析一次（见 agentDef.Bin 的注释）：装完/更新完不用重启 Perch。
	exe, prefix := def.Exe, def.Prefix
	if def.Bin != "" {
		exe, prefix = resolveAgentExe(def.Bin)
	}
	args := append(append([]string{}, prefix...), def.Args(host.spec.Resume, settings)...)
	args = append(args, prepArgs...)

	env := make(map[string]string, len(def.Env)+len(prepEnv))
	for k, v := range def.Env {
		env[k] = v
	}
	for k, v := range prepEnv {
		env[k] = v
	}
	sess, err := startPTY(exe, args, cwd, buildEnv(env), cols, rows)
	if err != nil {
		// Prepare 可能已经在外面起了东西（Codex 的 app-server）。PTY 没起来
		// 就没有“流的寿命”来取消观察者 —— 给它一个已取消的 ctx 让它自己收尾，
		// 否则那个 server 会一直留到 Perch 退出。
		if observe != nil {
			octx, ocancel := context.WithCancel(context.Background())
			ocancel()
			go observe(octx)
		}
		log.Printf("[perch] tab=%d 启动失败: %v", host.id, err)
		_ = c.Send([]byte("\r\n\x1b[31m[perch] 启动失败: " + err.Error() + "\x1b[0m\r\n"))
		return
	}
	defer sess.Close()
	// pid 是「格子 ↔ 会话」那条链子的起点（登记表按 pid 命名，见 status.go）。
	tabs.setPID(host.id, sess.Pid())

	// 状态观察者跟着这条 PTY 的生命周期走：流一断/进程一关，ctx 就取消。
	// observe 自己负责“server 还没起来就等”，不阻塞这里的启动。
	if observe != nil {
		octx, ocancel := context.WithCancel(context.Background())
		defer ocancel()
		go func() { <-done; ocancel() }()
		go observe(octx)
	}

	// 「这一格停了」的唯一可靠信号。
	// 2026-10-17 实测：格内 /exit 之后 claude.exe 已经没了（Get-CimInstance 查不到），
	// 而 ConPTY 的读循环**一条错误都没报** —— conhost 还活着、管道两端都还在我们
	// 手里，EOF 不会来。于是前端永远等不到 onclose、connDown 永远不置位，左栏那
	// 一行永远写着"在跑"，点它也进不了「接上它」这条路。
	// 所以得问**进程本身**（conpty.Wait 每 1s 看一次 WAIT_TIMEOUT）。它退了就关流：
	// 前端 onclose → connDown → 行翻「已停止」+ ▶，格内也留一行字说明。
	go func() {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() { <-done; cancel() }() // 本函数收尾（关格/关窗）就把等待撤掉
		if _, werr := sess.Wait(ctx); werr != nil {
			return // 是我们自己收的尾，不是进程退出
		}
		log.Printf("[perch] tab=%d pid=%d 进程已退出，关流", host.id, sess.Pid())
		_ = c.Send([]byte("\r\n\x1b[33m[perch] 进程已退出\x1b[0m\r\n"))
		_ = c.Close() // 让收包循环醒过来、前端看到 onclose
	}()
	// 注意日志里**打印参数**会把整份 --settings JSON 也打出来（几 KB）。
	// 这里改打长度：那串东西对读日志的人是噪音，长度足够判断"注进去了没有"。
	log.Printf("[perch] tab=%d 已启动 pid=%d exe=%s 参数%d个(settings=%d字节) cwd=%s resume=%s",
		host.id, sess.Pid(), exe, len(args), len(settings), cwd, host.spec.Resume.Kind)
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
				_ = c.Send([]byte("\r\n\x1b[33m[perch] 进程已退出\x1b[0m\r\n"))
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
							log.Printf("[perch] resize %dx%d 失败: %v", m.Cols, m.Rows, err)
						}
					}
				case "open-wt":
					go openInWindowsTerminal(host.spec)
				case "rename":
					// 用户给这个面板起了个名字。名字的主语是**会话**，不是面板 ——
					// 面板在内存里，会话在盘上，中间那条链子见 titles.go 的
					// sessionIDForPID。这里只把 pid 交出去，反查和落盘都在那边做，
					// 以免这段收包逻辑被拖住（反查有重试，可能等上一两秒）。
					applyRename(claudeStateDir, titlesStore, sess.Pid(), m.Msg)
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
				log.Printf("[perch] tab=%d 读帧中断: %v", host.id, f.err)
			}
			return
		}
		if handle(f.data) {
			return
		}
	}
}
