package session

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"

	"github.com/yu7dan/perch/internal/agent"
	"github.com/yu7dan/perch/internal/panes"
)

// Deps 是会话层从组合根拿到的全部外部能力。这里没有界面、没有 Wails。
type Deps struct {
	StateDir     string
	Panes        *panes.Store
	Titles       *TitleStore
	DefaultCWD   func() string
	ResolveExe   func(bin string) (string, []string)
	ProcessAlive func(pid int) bool
	Push         func(any)
	// Caps 是能力矩阵（它需要 agentcatalog 的"能否启动"），由组合根注入，
	// 免得会话层反过来认识 agent 名单。
	Caps func(id string) agent.Caps
}

// Manager 发放标签 id、维护运行期表与 bySession 反查，并实现 agent.Host。
type Manager struct {
	mu        sync.Mutex
	next      int
	tabs      map[int]*Tab
	bySession map[string]*Tab // sessionId → 格子：hook 事件靠它认领归属

	stateDir     string
	panes        *panes.Store
	titles       *TitleStore
	defaultCWD   func() string
	resolveExe   func(bin string) (string, []string)
	processAlive func(pid int) bool
	push         func(any)
	caps         func(id string) agent.Caps

	defsMu sync.RWMutex
	defs   map[string]agent.Def

	// 组合根在网关建好之后注入：查 agy 这类 agent 的启动环境。
	// 唯一调用点是 agent.AgyDef 的 Prepare；没接网关时保持 nil。
	wireMu     sync.RWMutex
	wireLaunch func(id string) (map[string]string, []string, bool)

	// profileMu：Perch 自己的 per-agent 配置（模型/档位）注入。
	// 只有隔离网关模式下列表函数才返回内容；旧路径保持 nil。
	profileMu   sync.RWMutex
	wireProfile func(id string) (map[string]string, []string, bool)

	// homeMu：隔离引擎的沙盒用户目录。agy 这类由 Perch 直接启动、
	// 但配置由引擎管理的 agent 要和引擎读同一份配置。
	homeMu     sync.RWMutex
	homeEnv    func() map[string]string
	homeEnvFor func(string) map[string]string
}

// New 构造空的会话表。Defs 在 agent.SetHost 之后由 SetDefs 填 —— 顺序见
// docs/ARCHITECTURE.md 的启动顺序。
func New(d Deps) *Manager {
	return &Manager{
		tabs:         map[int]*Tab{},
		bySession:    map[string]*Tab{},
		stateDir:     d.StateDir,
		panes:        d.Panes,
		titles:       d.Titles,
		defaultCWD:   d.DefaultCWD,
		resolveExe:   d.ResolveExe,
		processAlive: d.ProcessAlive,
		push:         d.Push,
		caps:         d.Caps,
	}
}

// SetDefs 填入启动表。必须在 agent.SetHost(m) 之后调用：Def 构造会走
// Host.ResolveExe，先建表会拿到占位实现给出的 exe。
func (m *Manager) SetDefs(defs map[string]agent.Def) {
	m.defsMu.Lock()
	m.defs = defs
	m.defsMu.Unlock()
}

// SetWireLaunch 由组合根在网关构造完成后调用。设置后每次开格都会现查，
// 这样在抽屉里改完网关接线不需要重启 Perch。
func (m *Manager) SetWireLaunch(fn func(id string) (map[string]string, []string, bool)) {
	m.wireMu.Lock()
	m.wireLaunch = fn
	m.wireMu.Unlock()
}

// SetWireProfile 由组合根注入：返回这一格要用的 Perch 网关配置。
// Claude 的 env 会合并进 --settings；Codex 的 args 是顶层 -c 覆盖。
func (m *Manager) SetWireProfile(fn func(id string) (map[string]string, []string, bool)) {
	m.profileMu.Lock()
	m.wireProfile = fn
	m.profileMu.Unlock()
}

// SetEngineHomeEnv 由组合根在隔离模式确定后注入。
func (m *Manager) SetEngineHomeEnv(fn func() map[string]string) {
	m.homeMu.Lock()
	m.homeEnv = fn
	m.homeMu.Unlock()
}

func (m *Manager) EngineHomeEnv() map[string]string {
	m.homeMu.RLock()
	fn := m.homeEnv
	m.homeMu.RUnlock()
	if fn == nil {
		return nil
	}
	return fn()
}

// SetEngineHomeEnvFor 给通用 CLI 用：按 agent id 决定是否换引擎沙盒。
func (m *Manager) SetEngineHomeEnvFor(fn func(string) map[string]string) {
	m.homeMu.Lock()
	m.homeEnvFor = fn
	m.homeMu.Unlock()
}

func (m *Manager) EngineHomeEnvFor(id string) map[string]string {
	m.homeMu.RLock()
	fn := m.homeEnvFor
	m.homeMu.RUnlock()
	if fn == nil {
		return nil
	}
	return fn(id)
}

func (m *Manager) profileFor(id string) (map[string]string, []string, bool) {
	m.profileMu.RLock()
	fn := m.wireProfile
	m.profileMu.RUnlock()
	if fn == nil {
		return nil, nil, false
	}
	return fn(id)
}

func (m *Manager) defFor(id string) (agent.Def, bool) {
	m.defsMu.RLock()
	defer m.defsMu.RUnlock()
	d, ok := m.defs[id]
	return d, ok
}

// EffectiveCWD 是一份 spec 的**生效 cwd** = 落盘那份记录里该记的值。
// 它就是"起 PTY 时真正用的那个目录"，所以谁都不许自己再写一遍这个判断。
func (m *Manager) EffectiveCWD(spec SpawnSpec) string {
	if c := strings.TrimSpace(spec.CWD); c != "" {
		return c
	}
	if m.defaultCWD != nil {
		return m.defaultCWD()
	}
	return ""
}

// Tab 是一格。ID/Stream/Spec/PaneID 是运行期与协议共享的字段；其余是**运行期
// 状态**，一律只经 Manager 的方法读写（锁在那边）。
type Tab struct {
	ID     int
	Stream string
	Spec   SpawnSpec

	// PaneID 是这一格**跨重启的身份**（登记表里的 PaneID，见 internal/panes）。
	// ⚠️ 它和 ID 是两件事：ID 是这一次运行里的编号（1、2、3…，每次启动重发），
	// PaneID 是"哪一格"这个问题的答案。拿 ID 当身份的话，重启后 1 号格就会
	// 继承上次 1 号格的会话 —— 那正是"接错会话"。
	PaneID int

	// 下面这些由登记表轮询/hook 在盘上发现，不是启动时算出来的 ——
	// 所以格子刚起来时它们都是空的。
	pid       int
	sessionID string
	sessName  string // claude 自己派生的会话名（nameSource:"derived"）
	status    string // "busy" | "idle" | "waiting"（实测取值，见 registry.go）
	// transcript 是会话的 .jsonl 绝对路径。**由 hook 的 SessionStart 直接给**
	// （payload 里有 transcript_path）—— 比我们去 projects\<有损slug>\ 下面拼路径可靠。
	transcript string
}

// Create 只分配 id/stream/pane 记录；流注册与 PTY 由调用方接着做（组合根先
// HandleStream、再回 tab.ok，前端才会去连）。
func (m *Manager) Create(spec SpawnSpec) *Tab {
	// paneId 在**锁外**定：panes 有自己的锁，而且下面的 Bind 会落盘 ——
	// 绝不持着 m.mu 做磁盘 I/O（那会把所有格子的操作一起卡在文件系统上）。
	paneID := 0
	if spec.PaneID > 0 {
		m.panesClaim(spec.PaneID, "冷恢复建格")
		paneID = spec.PaneID
	} else if m.panes != nil {
		paneID = m.panes.NextID()
	}
	m.mu.Lock()
	m.next++
	host := &Tab{ID: m.next, Stream: fmt.Sprintf("term:%d", m.next), Spec: spec, PaneID: paneID}
	m.tabs[host.ID] = host
	m.mu.Unlock()

	if m.panes != nil && paneID > 0 {
		// 建格**立刻**记一条：还没有 sessionId 也要写 —— "这一格开着"本身就是一件
		// 事实（它意味着"这一格的座位还在"，重启后要给它留个位置）。
		m.panes.Bind(paneID, spec.Agent, m.EffectiveCWD(spec), "", "", fmt.Sprintf("建格 tab=%d", host.ID))
		// 降级那一笔（如果有）**跟在 Bind 后面**写：Bind 的规矩是"空值不覆盖"，
		// 两者写的是不同字段，谁也不影响谁 —— 分开写是为了让"留证"这件事
		// 一眼看得出是**附带**的，不是建格的一部分。
		if spec.DegradedFrom != "" {
			m.panes.MarkDegraded(paneID, spec.DegradedFrom, fmt.Sprintf("tab=%d 被拒后改起新会话", host.ID))
		}
	}
	return host
}

func (m *Manager) panesClaim(id int, why string) {
	if m.panes != nil {
		m.panes.Claim(id, why)
	}
}

// Drop 在流断开时把一个标签从运行期表里摘掉。
//
// ⚠️ **它一行都不许碰登记表**（panes 包文件头第 ③ 条约束）。关窗那一刻每个
// 格子的收尾都会先跑一遍 —— 要是这里顺手删了记录，写下去的就是 `{"panes":[]}`，
// **恢复能力被自己抹掉，而且不报错**。删记录只有一条路：前端在用户点
// 「结束这个 agent」时发 pane.forget（点 × 发的是 pane.close —— 只打 Closed
// 标记，记录留着）。
func (m *Manager) Drop(id int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.tabs[id]; h != nil && h.sessionID != "" {
		delete(m.bySession, h.sessionID)
	}
	delete(m.tabs, id)
}

// AgentForTab 返回这一格启动时选的 agent id。hook 事件归一化要用它：
// dsh 的 PreToolUse 和 Claude 的语义不同（dsh 的普通工具也算 working），
// 不能只看事件名。
func (m *Manager) AgentForTab(tab int) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.tabs[tab]; h != nil {
		return h.Spec.Agent
	}
	return ""
}

// PaneIDFor：运行期的 tab id → **跨重启**的 paneId（登记表的身份）。
func (m *Manager) PaneIDFor(tab int) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.tabs[tab]; h != nil {
		return h.PaneID
	}
	return 0
}

// SetPID 在 PTY 起来之后登记 pid —— 登记表是按 pid 命名的，这是那条链子的起点。
func (m *Manager) SetPID(id, pid int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.tabs[id]; h != nil {
		h.pid = pid
	}
}

// LiveTab 是给轮询/转录跟随器用的**只读快照**：调用方在锁外拿数据，
// 不和收包循环抢，也不用让整个轮询循环持着锁去读盘。
type LiveTab struct {
	ID         int
	Agent      string
	PID        int
	SessionID  string
	Status     string
	Name       string
	Transcript string
	CWD        string
}

// Live 返回当前所有格子的只读快照。
func (m *Manager) Live() []LiveTab {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]LiveTab, 0, len(m.tabs))
	for _, h := range m.tabs {
		out = append(out, LiveTab{
			ID: h.ID, Agent: h.Spec.Agent, PID: h.pid, SessionID: h.sessionID, Status: h.status,
			Name: h.sessName, Transcript: h.transcript, CWD: m.EffectiveCWD(h.Spec),
		})
	}
	return out
}

// SetTranscript 记下这个格子的转录文件（hook SessionStart 里直接给的）。
//
// ⚠️ 它也受续接证据规则管：转录文件名去掉目录和 .jsonl 就是会话 id
// （实测：`projects\<目录>\<session id>.jsonl`），拿它去问 judgeResume 即可 ——
// 多写一条"这两个字段要不要一起改"的规矩，迟早会和那条分叉。
func (m *Manager) SetTranscript(id int, path string) {
	if path == "" {
		return
	}
	m.mu.Lock()
	h := m.tabs[id]
	if h == nil {
		m.mu.Unlock()
		return
	}
	h.transcript = path
	intent := h.Spec.Resume
	paneID, agentName := h.PaneID, h.Spec.Agent
	cwd := m.EffectiveCWD(h.Spec)
	m.mu.Unlock()
	// 落盘在**锁外**（磁盘 I/O 不进 m.mu）
	if m.panes == nil {
		return
	}
	if stem := transcriptStem(path); judgeResume(intent, stem) == evMissed {
		log.Printf("[panes] ⚠️ 转录路径不记：pane=%d 那条路径说的是会话 %s，而这一格请求的是 %s —— "+
			"记录里 sessionId 和 transcript 必须说**同一条**会话（见 SetTranscript 的注释）",
			paneID, short(stem), short(intent.ID))
		return
	}
	m.panes.Bind(paneID, agentName, cwd, "", path, "拿到转录路径")
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
resumeEvidence 是续接证据的**唯一判据**：「这一次身份到达」能不能当成
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
	  evMatched    承诺的是 `exact X`，来的**正是** X；记录照写（同一 id，等价于
	               确认），并撤掉上一次可能留下的那笔落空。
	  evMissed     承诺的是 `exact X`，来的却是别人 —— **记录一个字都不改**，
	               只留 mismatchAt + 一条醒目日志 + 格内横幅。

	⚠️ `latest` 按"没有承诺"处理：`--continue` 的承诺是"这个目录里最新那条"，
	我们手上**没有 id 可以去对**。判不了的事不判。
*/
type resumeEvidence int

const (
	evNoPromise resumeEvidence = iota
	evMatched
	evMissed
)

func judgeResume(intent ResumeIntent, sid string) resumeEvidence {
	if sid == "" || intent.Kind != "exact" || intent.ID == "" {
		return evNoPromise
	}
	if intent.ID == sid {
		return evMatched
	}
	return evMissed
}

// BindSession 把"这个格子跑的是哪个会话"钉下来（只在第一次生效，返回是否绑上了）。
// 两个调用点：hook 事件（最早，session_id 直接随事件来）和会话登记表（兜底）。
//
// ⚠️ 它同时喂**两张表**，而两张表记的不是同一件事：
//
//	运行期表（h.sessionID + bySession）记的是**事实**：这一格现在跑的就是 sid。
//	  所以要**照实记、无条件记** —— 护栏 LiveOwnerOf 靠它拦"两个进程写同一份
//	  jsonl"，记成"我们以为的那条"就会放过一次真正的冲突。
//	盘上那条记录（panes.json 的 sessionId）记的是**意图**：下次重开该去接谁。
//	  这一张只在有证据时才改写（见 judgeResume）。
func (m *Manager) BindSession(id int, sid, name, source string) bool {
	m.mu.Lock()
	h := m.tabs[id]
	if h == nil || h.sessionID != "" || sid == "" {
		m.mu.Unlock()
		return false
	}
	h.sessionID = sid
	if name != "" {
		h.sessName = name
	}
	m.bySession[sid] = h
	intent := h.Spec.Resume
	paneID, agentName := h.PaneID, h.Spec.Agent
	cwd := m.EffectiveCWD(h.Spec)
	m.mu.Unlock()

	// 没有续接能力的 agent（OpenCode 现在就是）不要拿请求的 exact 去判落空：
	// 它本来就会开一条新会话，判成 mismatch 只会给用户挂一条假横幅。
	if !m.resumeCapable(agentName) {
		intent = ResumeIntent{Kind: "new"}
	}

	// 首次身份绑定**立即落盘**（配 ~250ms 合并窗，见 internal/panes）：
	// 建格到绑上身份之间大约 1–3 秒，正是整条链最脆的窗口 —— 这段里被关掉，
	// 记录里就只会有"这一格开着、不知道跑的是谁"。⚠️ 出了锁才写：那是磁盘 I/O。
	if m.panes == nil {
		return true
	}
	switch judgeResume(intent, sid) {
	case evMissed:
		m.panes.MarkMismatch(paneID, intent.ID, sid, "首次身份到达")
		log.Printf("[panes] ⚠️ 续接落空：请求 %s 实际 %s（source=%s）—— 格子 t%d pane=%d。"+
			"记录里那条会话 id **一个字都不改**（盘上那条还在），只留 mismatchAt",
			short(intent.ID), short(sid), orNone(source), id, paneID)
		// 格内横幅：横幅是给**人**看的，日志是给排查看的，两样都要。
		m.Push(map[string]any{
			"type": "pane.mismatch", "pane": paneID, "tab": id,
			"want": intent.ID, "got": sid, "source": source,
		})
	case evMatched:
		if m.panes.ClearMismatch(paneID, fmt.Sprintf("续接对上 tab=%d（撤掉上次那笔落空）", id)) {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（source=%s）—— 上次那笔落空撤掉",
				id, paneID, short(sid), orNone(source))
		} else {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（source=%s）",
				id, paneID, short(sid), orNone(source))
		}
		m.panes.Bind(paneID, agentName, cwd, sid, "", fmt.Sprintf("首次绑上会话 tab=%d（证据对上）", id))
	default:
		m.panes.Bind(paneID, agentName, cwd, sid, "", fmt.Sprintf("首次绑上会话 tab=%d", id))
	}
	return true
}

// RebindSession 是“格内换了会话”的路径（OpenCode 的 active session 变了会走它）。
// 和 BindSession 的区别只有一个：允许覆盖已有的 sessionID。
func (m *Manager) RebindSession(id int, sid, name, source string) bool {
	m.mu.Lock()
	h := m.tabs[id]
	if h == nil || sid == "" || h.sessionID == sid {
		m.mu.Unlock()
		return false
	}
	old := h.sessionID
	if old != "" {
		delete(m.bySession, old)
	}
	h.sessionID = sid
	if name != "" {
		h.sessName = name
	}
	m.bySession[sid] = h
	intent := h.Spec.Resume
	paneID, agentName := h.PaneID, h.Spec.Agent
	cwd := m.EffectiveCWD(h.Spec)
	m.mu.Unlock()

	log.Printf("[agent t%d] 会话改写 %s → %s（source=%s）",
		id, short(old), short(sid), orNone(source))
	if !m.resumeCapable(agentName) {
		intent = ResumeIntent{Kind: "new"}
	}
	if m.panes == nil {
		return true
	}
	// 和 BindSession 用同一条判据：请求的是 exact X 却来了 Y，记录里那条 id
	// 一个字都不改，只留 mismatch；格子的内存身份仍然跟着 Y（它才是现在跑的）。
	switch judgeResume(intent, sid) {
	case evMissed:
		m.panes.MarkMismatch(paneID, intent.ID, sid, "格内换会话")
	case evMatched:
		if m.panes.ClearMismatch(paneID, fmt.Sprintf("格内换会话对上 tab=%d", id)) {
			log.Printf("[panes] 续接对上：格子 t%d pane=%d 请求的就是 %s（格内换会话）",
				id, paneID, short(sid))
		}
	default:
		m.panes.Bind(paneID, agentName, cwd, sid, "", fmt.Sprintf("格内换会话 tab=%d", id))
	}
	return true
}

func (m *Manager) resumeCapable(id string) bool {
	if m.caps == nil {
		return false
	}
	return m.caps(id).Resume
}

// SetStatus 记一次忙闲变化，返回上一次的值和"到底变没变" ——
// 调用方只在变的时候出声，否则 700ms 一次会把日志淹掉。
func (m *Manager) SetStatus(id int, st string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := m.tabs[id]
	if h == nil || st == "" || h.status == st {
		return "", false
	}
	prev := h.status
	h.status = st
	return prev, true
}

// TabForSession 反查：这条 hook 事件是哪个格子发出来的。
// 查不到返回 0（事件照样推给前端，只是没有归属 —— 比如登记表还没写出来的那一瞬）。
func (m *Manager) TabForSession(sid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if h := m.bySession[sid]; h != nil {
		return h.ID
	}
	return 0
}

// Push 实现 agent.Host。
func (m *Manager) Push(v any) {
	if m.push != nil {
		m.push(v)
	}
}

// ResolveExe 实现 agent.Host：把 Exe 发现委托给组合根注入的实现
// （生产上是 winproc.ResolveExe）。
func (m *Manager) ResolveExe(bin string) (string, []string) {
	if m.resolveExe == nil {
		return bin, nil
	}
	return m.resolveExe(bin)
}

// WireLaunch 实现 agent.Host：把请求转给组合根注入的网关查询。
func (m *Manager) WireLaunch(id string) (map[string]string, []string, bool) {
	m.wireMu.RLock()
	fn := m.wireLaunch
	m.wireMu.RUnlock()
	if fn == nil {
		return nil, nil, false
	}
	return fn(id)
}
