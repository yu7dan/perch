package session

/* ===========================================================================
   C2：复接一条已有会话 —— 护栏（判据全在这一侧）

   这些判据**住在这里**，是照 Orca 的分工定的：归属判定在主进程
   （src/main/native-chat/agent-session-wire/structured-agent-session-resume-
   eligibility.ts，以及 src/main/ai-vault/structured-session-ownership.ts），
   渲染层只负责"做灰 + 显示拒绝理由"。理由很硬：只有主进程手里有权威的
   「谁占着谁」表 —— 我们这张表就是 Manager.bySession，而前端判不了这件事
   （它手上没有 session id，也不该为此多出一份会跟这边矛盾的副本）。

   三个判据，两个直接抄 Orca：

   1. **已被活着的格子占着 → 拒**（`agent_session_conflict`）。
      两个 claude 同时写一份 jsonl 会毁掉会话，这是复接唯一的真实风险。
      那一格的进程已经退出就不算占着。

   2. **无目标的续接（--continue）→ 一律拒**。Orca 的原话
      （structured-session-ownership.ts:227-232）：它可能挑中任何一条会话，
      所以只要同 provider 有一条被占着就不能放行。我们这边更糟：并行区的两格
      一起 `--continue`，两边都会认领"最新那条"，直接撞上。

   3. **fork 永不拒**。Orca 的注释：*"A fork writes a new conversation, and
      preparing its home never writes this one."*（同文件 :147-153）。
      它只读旧文件、写新文件，所以"从同一起点跑两条路"是这个网格的正当用法，
      不该被"那条会话正被占着"挡住。

   拒绝的形状也是照 Orca 的线格式：**拒绝就是创建请求的应答**，不是另一次查询
   （mobile/rpc-foundation/goldens/aivault-resume-launch-create-refused.json ——
   `session.tabs.createTerminal` 的应答里直接带 `error.code`）。
   =========================================================================== */

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yu7dan/perch/internal/agent"
)

// Refusal 是一次拒绝。Retryable：**同一件事再试一次有没有可能成功**。
// 判在产生判决的这一侧，不由前端拿 code 去查表 —— 理由照 Orca
// （native-chat-resume-failure-guidance.ts:41-45）：
// "The host already knows a retry would not run, whatever the reason suggests"。
//
// 我们这边这么分：
//
//	agent_session_conflict —— **瞬时**：判据是"某个 pid 正占着 / 某个格子正跑着"，
//	   而冷启动正是它最不可靠的时刻（上一轮的 claude 由 KILL_ON_JOB_CLOSE
//	   异步收掉，登记表残留不自清，pid 还可能被复用）。等 800ms 再问一次
//	   往往就过了 —— 实测过的那条"关掉后立刻重开"就是它。
//	unavailable / bad_id / unknown_kind —— **终局**：文件不在、id 形状不对、
//	   意图不认识，再试一百次也还是这样。
type Refusal struct {
	Code      string
	Msg       string
	Retryable bool
}

// SafeSessionID 是**白名单**，比 Orca 的黑名单严（那边只挡"空 / 超长 / 以 - 开头 /
// 含控制字符"，agent-session-resume.ts:101-115）。理由是我们的 id 还有两个去处：
//
//	① 原样进命令行（`--resume <id>`）—— 以 `-` 开头就成了另一个开关；
//	② 拿去拼盘上的路径做 glob —— `..`、`/`、`\`、`*`、`?` 都是路径或通配符语法。
//
// claude 给的 id 是 UUID、子代理文件是 agent-<hex>，白名单一点代价都没有。
func SafeSessionID(id string) bool { return agent.SafeSessionID(id) }

// SessionFileExists 是 Claude 那条判据：这条会话在盘上还有没有。
//
// 主会话是 <stateDir>\projects\<项目目录>\<id>.jsonl；子代理会话落在
// <项目目录>\<主会话 id>\subagents\agent-<hex>.jsonl。两种形状不同，于是这一次
// 检查同时回答两件事："文件没了"（卡片是旧的）和"它是子代理"（子代理的 id 不是一条
// 独立会话，`--resume` 拿它起不来）。Orca 有同类规则：Pi 的会话文件不在，即使 id
// 存在也标成不可接（docs/site/content/docs/agents/session-history.mdx:41）。
//
// 那条主会话路径**不用**从 id 反推项目目录名（它是有损 slug）—— 这里只问
// "有没有"，不问"是哪一个"，glob 一次就够。
func (m *Manager) SessionFileExists(id string) bool {
	if !SafeSessionID(id) {
		return false
	}
	match, err := filepath.Glob(filepath.Join(m.stateDir, "projects", "*", id+".jsonl"))
	return err == nil && len(match) > 0
}

// SessionFileExistsFor：冷恢复/续接护栏的 agent 分派口。
// Claude 的判据原样保留（projects/<slug>/<id>.jsonl），别的 agent 各问各的盘。
func (m *Manager) SessionFileExistsFor(agentName, cwd, id string) bool {
	switch agentName {
	case "pi", "codex":
		return agent.SessionFileExistsFor(agentName, cwd, id)
	}
	return m.SessionFileExists(id)
}

func (m *Manager) alive(pid int) bool {
	if m.processAlive == nil {
		// 判不出来时按"活着"处理：宁可让用户去关掉那一格，
		// 也不要赌"它没在跑"而放进来第二个写者。
		return true
	}
	return m.processAlive(pid)
}

// sessionLiveElsewhere：这条会话正被**某个 claude 进程**跑着吗？返回那个 pid。
//
// 这个判据比 bySession **硬**，而且是实测出来的：`<stateDir>\sessions\<pid>.json`
// 是**全机器**范围的登记表 —— 每一个 claude 进程都会写一条，包括不是我们启动的那些
// （另一个终端里的 claude、用户自己那个 Claude Code 会话）。于是它能回答 bySession
// 回答不了的问题："这条会话正被一个**不属于我们**的进程跑着"。那种情况下接上去
// 照样是两个写者，后果和被我们自己另一格占着一样。
//
// 两道判据都留着，不是重复：登记表可能还没写出来（claude 刚起来那一两秒），
// 而 bySession 从 hook 事件就能绑上，比登记表早。
func (m *Manager) sessionLiveElsewhere(sid string) int {
	ents, err := os.ReadDir(filepath.Join(m.stateDir, "sessions"))
	if err != nil {
		return 0
	}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		// 进程没了就跳过：登记表是**残留**的（claude 退出不保证清理），
		// 而残留的文件名和 pid 会一直在那儿等着骗人。
		if err != nil || !m.alive(pid) {
			continue
		}
		reg, ok := readSessionReg(m.stateDir, pid)
		if !ok || !strings.EqualFold(reg.SessionID, sid) {
			continue
		}
		return pid
	}
	return 0
}

// anyClaudeInCWD：这个工作目录下有没有活着的 claude？
// 只给 `--continue` 那条判据用 —— 它解析出来的是"这个目录里最新的会话"，
// 所以只要那个目录里有别人在跑，接上去就可能挑中同一条。
func (m *Manager) anyClaudeInCWD(cwd string) int {
	if cwd == "" {
		return 0
	}
	ents, err := os.ReadDir(filepath.Join(m.stateDir, "sessions"))
	if err != nil {
		return 0
	}
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil || !m.alive(pid) {
			continue
		}
		if reg, ok := readSessionReg(m.stateDir, pid); ok && sameDir(reg.CWD, cwd) {
			return pid
		}
	}
	return 0
}

// sameDir：两个路径是不是同一个目录。Windows 上大小写和斜杠都不敏感，
// 而 claude 写进登记表的 cwd 和我们 spec 里的不一定字面一致。
func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// ResumeRefusal 返回 nil = 放行。
func (m *Manager) ResumeRefusal(spec SpawnSpec) *Refusal {
	r := spec.Resume
	switch r.Kind {
	case "", "new":
		// 裸启动就是全新会话，没有"接谁"的问题。
		return nil

	case "latest":
		if owner, sid := m.AnyLiveSession(); owner != 0 {
			return &Refusal{Code: "agent_session_conflict", Retryable: true, Msg: fmt.Sprintf(
				"格子 t%d 正跑着会话 %s：--continue 会挑中同一条，两个进程一起写会毁掉它。要开新的请用 +。",
				owner, short(sid))}
		}
		// 这一格之外的 claude 也算：`--continue` 解析的是"这个目录里最新的会话"，
		// 而登记表是全机器范围的，所以这一条能挡住"另一个终端正在这个目录里跑"。
		// Pi 不写这份登记表，这道判据只对 claude 有意义。
		if spec.Agent == "claude" {
			if pid := m.anyClaudeInCWD(spec.CWD); pid != 0 {
				return &Refusal{Code: "agent_session_conflict", Retryable: true, Msg: fmt.Sprintf(
					"这个目录里已经有一个 claude 在跑（pid=%d）：--continue 会挑中同一条会话。要开新的请用 +。", pid)}
			}
		}
		return nil

	case "exact", "fork":
		if !SafeSessionID(r.ID) {
			return &Refusal{Code: "bad_id", Msg: "会话 id 的形状不对（只允许字母数字和 -_，长度 ≤128），不接：" +
				strconv.Quote(r.ID)}
		}
		if !m.SessionFileExistsFor(spec.Agent, spec.CWD, r.ID) {
			return &Refusal{Code: "unavailable", Msg: "盘上找不到这条会话 —— 可能是张旧卡片，" +
				"或者它是子代理会话（子代理的 id 不是一条能单独接上的会话）"}
		}
		// fork 到这儿就放行：它写的是**新**文件，不碰旧的。
		if r.Kind == "fork" {
			return nil
		}
		// 两道占用判据，**谁也不替谁**（见 sessionLiveElsewhere 的说明）：
		// 登记表是全机器的（能看见别的终端的 claude），bySession 从 hook 就能绑
		// （比登记表早，claude 刚起来那一两秒只有它知道）。
		// 全机器登记表只有 claude 会写；Pi/OpenCode 没有等价的“外部进程”视图。
		if spec.Agent == "claude" {
			if pid := m.sessionLiveElsewhere(r.ID); pid != 0 {
				return &Refusal{Code: "agent_session_conflict", Retryable: true, Msg: fmt.Sprintf(
					"这条会话正被一个 claude 进程跑着（pid=%d）—— 两个进程同时写同一份会话"+
						"文件会毁掉它。先停掉那一个，或者用「另起分支」（fork 写的是新文件）。", pid)}
			}
		}
		if owner := m.LiveOwnerOf(r.ID); owner != 0 {
			return &Refusal{Code: "agent_session_conflict", Retryable: true, Msg: fmt.Sprintf(
				"这条会话正被格子 t%d 跑着 —— 两条 claude 同时写同一份会话文件会毁掉它。"+
					"先关掉那一格，或者用「另起分支」（fork 写的是新文件）。", owner)}
		}
		return nil
	}
	return &Refusal{Code: "unknown_kind", Msg: "未知的续接意图：" + strconv.Quote(r.Kind)}
}

// LiveOwnerOf：这条会话正被哪个**活着的**格子占着？没有就 0。
// ⚠️ processAlive 是系统调用，**锁外**问 —— 别在持着 Manager 锁的时候做。
func (m *Manager) LiveOwnerOf(sid string) int {
	m.mu.Lock()
	h := m.bySession[sid]
	var id, pid int
	if h != nil {
		id, pid = h.ID, h.pid
	}
	m.mu.Unlock()
	if h == nil {
		return 0
	}
	// pid 还没登记（PTY 正在起/起失败了）也当占着：**宁可让用户去关掉那一格，
	// 也不要赌"它没在跑"而放进来第二个写者**。真放进来，坏掉的是会话文件本身，
	// 而那是不可逆的。
	if pid > 0 && !m.alive(pid) {
		return 0 // claude 已经退出 = Orca 说的"租约已释放"
	}
	return id
}

// AnyLiveSession：随便挑一个活着的格子，返回它的 tab id 和会话 id。
// 只给 --continue 那条判据用（Orca 在那边是按 provider 分组看的，我们目前只有
// claude 一个 agent，所以"同一组"就是全部）。
func (m *Manager) AnyLiveSession() (int, string) {
	type pair struct {
		id, pid int
		sid     string
	}
	m.mu.Lock()
	all := make([]pair, 0, len(m.bySession))
	for sid, h := range m.bySession {
		all = append(all, pair{h.ID, h.pid, sid})
	}
	m.mu.Unlock()
	for _, p := range all {
		if p.pid > 0 && !m.alive(p.pid) {
			continue
		}
		return p.id, p.sid
	}
	return 0, ""
}
