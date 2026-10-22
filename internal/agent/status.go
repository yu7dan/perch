package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// 多 agent 状态接入：能力矩阵 + 归一化事件 + 适配器
//
// 目标不是“给每家写一套状态”，而是把 Claude 的三条腿归一成同一条事件：
//
//	{type:"agent", tab, session, status:"busy|idle|waiting", kind:"ask|perm", text}
//
// 前端 80-live.js 的 applyAgent 已经认这条消息；Claude 原有的 hooks / 登记表 /
// 转录不动，新 agent 只需要提供一个能产出 agentEvent 的观察者。
//
// 能力矩阵只登记**已经落地**的适配器。没写的 agent 默认只有“能在 Perch 里开一格”，
// 不要把计划要接的写进来——UI 会把它当成事实。
// ---------------------------------------------------------------------------

// 内部四态（照 Orca 的 AGENT_STATUS_STATES，src/shared/agent-status-types.ts:51-52）。
// wire 上的 busy/idle/waiting 只留给现有 UI：
//
//	working  在跑
//	blocked  卡在一个**具体提问**上（有 question 卡片可画；Pi 的 ask 工具、
//	         Claude 的 AskUserQuestion）
//	waiting  泛化等待（批准框、扩展的 ui prompt、只有忙闲的登记表 ——
//	         说不清是哪一种，但人确实要来看）
//	done     没有自动工作
//
// blocked 和 waiting 在 UI 上都是“需要你”，区别留给以后画不同的卡片。
// 别把 blocked 当成“出错”：出错是 done + 一条 fail note（见 80-live.js）。
const (
	StateWorking = "working"
	StateBlocked = "blocked"
	StateWaiting = "waiting"
	StateDone    = "done"
)

// 包内的短名字，读起来和原来的四态表一致。
const (
	agentStateWorking = StateWorking
	agentStateBlocked = StateBlocked
	agentStateWaiting = StateWaiting
	agentStateDone    = StateDone
)

// 状态证据的来源（wire 字段 evidence）。前端用它判断冷恢复后收到的是
// **重放**还是活事件：resync 的 waiting 在确认之前不许记未读。
const (
	EvidenceHook      = "hook"
	EvidenceRegistry  = "registry"
	EvidenceExtension = "extension"
	EvidenceHTTP      = "http"
	EvidenceAppServer = "app-server"
	EvidenceResync    = "resync"
)

type Caps struct {
	Launch    bool   `json:"launch"`    // Perch 能在终端里启动它
	Resume    bool   `json:"resume"`    // 能按会话续接
	Status    bool   `json:"status"`    // 能给出忙/闲
	Waiting   bool   `json:"waiting"`   // 能给出“卡在等你”（提问/批准）
	Actions   bool   `json:"actions"`   // 能给出工具/文件/子代理等动作
	Approvals bool   `json:"approvals"` // 能从 Perch 里回答批准/提问（后续）
	Mechanism string `json:"mechanism,omitempty"`
}

var agentAdapterCaps = map[string]Caps{
	"claude": {
		Launch: true, Resume: true, Status: true, Waiting: true, Actions: true,
		Mechanism: "hook",
	},
	"opencode": {
		Launch: true, Status: true, Waiting: true,
		Mechanism: "http",
	},
	"pi": {
		// 状态/等待来自 pi -e 挂进去的观察扩展（internal/agent/pi/observer.ts）。
		// 等待是**条件性**的：Pi 没有内建审批，只有扩展的 ctx.ui 提示才会
		// 出现 waiting；没有扩展提问时不会等 —— 这是能力边界，不假装。
		Launch: true, Resume: true, Status: true, Waiting: true,
		Mechanism: "extension",
	},
	"codex": {
		// 每格一个 app-server，TUI 通过 --remote 连它；状态取
		// thread/status/changed 的 activeFlags（waitingOnApproval /
		// waitingOnUserInput）。批准本身仍然在 TUI 里回答（Approvals=false）：
		// 实测 0.163.0 的批准请求只发给 TUI，不发给旁路观察者。
		Launch: true, Resume: true, Status: true, Waiting: true,
		Mechanism: "app-server",
	},
	"dsh": {
		// 非官方 TUI 的接入（照 Orca）：终端界面来自社区的 dsh-tui profile，
		// 状态来自官方的 @deepseek-ai/dsh-hooks-claude-code 桥。
		// Waiting 只覆盖 dsh 的 ask_user_question；批准没有 hook，按 Orca 的
		// 口径算 working（harness 还在工具中间，不是 idle，也不假装看得见）。
		Launch: true, Resume: true, Status: true, Waiting: true,
		Mechanism: "hook",
	},
}

// CapsFor 决定 Agent 名单上那一行该说什么。
//
// ⚠️ “能启动”和“有状态”是两件事：能启动的 agent 都可以有一条 GenericDef
// （只开新会话），如果拿它当“已接入”，总览会把“只能启动”写成“完整状态”。
// 这里分开：Launch 由宿主传入（它知道完整的 agent 名单），Status/Waiting
// 只看适配器表。
func CapsFor(id string, canLaunch bool) Caps {
	if c, ok := agentAdapterCaps[id]; ok {
		// 深度适配器也只在这台机器上**真的能启动**时才说 Launch：
		// 装没装是每台机器的事实，不能写进静态能力表。
		c.Launch = c.Launch && canLaunch
		return c
	}
	return Caps{Launch: canLaunch, Mechanism: "terminal"}
}

// agentEvent 是适配器 -> Perch 的归一化事件。未来的外部适配器（JSONL/HTTP）
// 也按这个形状发；v=1 是协议版本，字段只增不改。
type agentEvent struct {
	V       int    `json:"v"`
	Tab     int    `json:"tab,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Event   string `json:"event,omitempty"`  // status（目前只用到这个）
	Status  string `json:"status,omitempty"` // busy | idle | waiting（wire 兼容层）
	State   string `json:"state,omitempty"`  // working | blocked | waiting | done（内部四态）
	Kind    string `json:"kind,omitempty"`   // ask | perm
	Text    string `json:"text,omitempty"`
	Session string `json:"session,omitempty"`
	Name    string `json:"name,omitempty"`
	// Evidence 是这条状态从哪条腿来的：hook | registry | extension | http |
	// app-server | resync。适配器必须填；resync 表示“这是补状态的重放”。
	Evidence string `json:"evidence,omitempty"`
	At       int64  `json:"at,omitempty"`
}

// normalizeAgentEvent 把四态和 wire 状态对齐。State 是**权威**：给了 state
// 就一定按它推 status；只给 status 时按表补 state。这样适配器可以只写自己
// 确定的那一半，UI 永远拿得到 busy/idle/waiting。
func normalizeAgentEvent(ev *agentEvent) {
	switch ev.State {
	case agentStateWorking, agentStateBlocked, agentStateWaiting, agentStateDone:
		switch ev.State {
		case agentStateWorking:
			ev.Status = "busy"
		case agentStateBlocked, agentStateWaiting:
			ev.Status = "waiting"
		case agentStateDone:
			ev.Status = "idle"
		}
		return
	default:
		ev.State = ""
	}
	switch ev.Status {
	case "busy":
		ev.State = agentStateWorking
	case "waiting":
		// 只说“在等”、说不出是提问还是批准：泛化等待，不是 blocked。
		ev.State = agentStateWaiting
	case "idle":
		ev.State = agentStateDone
	}
}

var (
	agentNoteMu       sync.Mutex
	agentLastNote     = map[int]string{} // tab -> kind + "\x00" + text
	agentLastState    = map[int]string{} // tab -> working|blocked|waiting|done
	agentLastEvidence = map[int]string{} // tab -> hook|registry|…
)

// emitAgentStatus 是归一化事件落到前端的那一层。非 Claude 适配器都走它。
// 只在 status / waiting 的 kind+text / 四态 / 证据变化时推，避免每次轮询都刷一条。
// 证据变化也要推：冷恢复后“resync → 活事件”本身就是要让前端看见的事实。
func emitAgentStatus(ev agentEvent) {
	normalizeAgentEvent(&ev)
	if ev.Tab <= 0 || ev.Status == "" {
		return
	}
	if ev.V == 0 {
		ev.V = 1
	}
	if ev.At == 0 {
		ev.At = time.Now().UnixMilli()
	}

	noteKey := ev.Kind + "\x00" + ev.Text
	agentNoteMu.Lock()
	prevNote, hadNote := agentLastNote[ev.Tab]
	if ev.Status == "waiting" {
		agentLastNote[ev.Tab] = noteKey
	} else {
		delete(agentLastNote, ev.Tab)
	}
	prevState := agentLastState[ev.Tab]
	if ev.State != "" {
		agentLastState[ev.Tab] = ev.State
	}
	prevEvidence := agentLastEvidence[ev.Tab]
	if ev.Evidence != "" {
		agentLastEvidence[ev.Tab] = ev.Evidence
	}
	agentNoteMu.Unlock()
	noteChanged := !hadNote || prevNote != noteKey
	stateChanged := ev.State != "" && ev.State != prevState
	evidenceChanged := ev.Evidence != "" && ev.Evidence != prevEvidence

	prev, changed := host.SetStatus(ev.Tab, ev.Status)
	if !changed && !(ev.Status == "waiting" && noteChanged) && !stateChanged && !evidenceChanged {
		return
	}
	log.Printf("[agent t%d] %s status %s → %s state=%s evidence=%s%s", ev.Tab, ev.Agent,
		prev, ev.Status, OrNone(ev.State), OrNone(ev.Evidence), waitingHint(ev))
	host.Push(map[string]any{
		"type":     "agent",
		"tab":      ev.Tab,
		"session":  ev.Session,
		"status":   ev.Status,
		"state":    ev.State,
		"evidence": ev.Evidence,
		"name":     ev.Name,
		"kind":     ev.Kind,
		"text":     ev.Text,
		"agent":    ev.Agent,
	})
}

func waitingHint(ev agentEvent) string {
	if ev.Status != "waiting" {
		return ""
	}
	if ev.Kind == "perm" {
		return "（等批准）"
	}
	return "（等回答）"
}

// ---------------------------------------------------------------------------
// OpenCode 适配器
//
// 实测（1.19.3）：TUI 自己会在 --port 上起 HTTP server，1 格 = 1 server = 1 活跃会话。
// 我们只读它：
//
//	/api/session/active   {"data":{"ses_…":{"type":"running"}}}
//	/session/status       {"ses_…":{"type":"idle|busy|retry", …}}
//	/permission           [{id,sessionID,permission,patterns,…}]
//	/question             [{id,sessionID,questions:[{question,header,…}]}]
//
// server 默认无鉴权；启动时设 OPENCODE_SERVER_PASSWORD，HTTP 用 Basic
// （用户名固定 opencode，实测 1.19.3）。口令只在本机进程间用，不进日志。
// ---------------------------------------------------------------------------

const openCodePollEvery = 500 * time.Millisecond

func openCodeDef() Def {
	d := GenericDef("opencode")
	d.Prepare = prepareOpenCode
	return d
}

// prepareOpenCode 在 PTY 起来之前分配端口/口令，并返回 PTY 起来后要跑的观察者。
func prepareOpenCode(tag string, tabID int, _ string, _ []string) (map[string]string, []string, func(context.Context), error) {
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("找空闲端口: %w", err)
	}
	pass, err := randomToken(24)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("生成 server 口令: %w", err)
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	env := map[string]string{
		"OPENCODE_SERVER_PASSWORD": pass,
		// OpenCode 桌面版 2.x 和 CLI 1.x 的库不兼容：桌面版在同一目录写
		// opencode.db（session_v2 表），CLI 1.19.3 打开它时 TUI 会卡在
		// "applying tui config" 之后、永不监听端口（`serve` 则报
		// "Database is not empty and has no session table"）。实测把路径
		// 换成独立文件后 CLI 立即正常。
		//
		// OPENCODE_DB 只换数据库文件；配置和 auth 仍在原处共享。绝不能
		// 为了"能用"去删/改桌面版的 opencode.db —— 那是用户的历史会话。
		"OPENCODE_DB": "perch-cli.db",
	}
	args := []string{"--port", strconv.Itoa(port), "--hostname", "127.0.0.1"}
	log.Printf("[opencode %s] 状态观察口径 port=%d host=127.0.0.1（口令已设）", tag, port)
	observe := func(ctx context.Context) {
		observeOpenCode(ctx, tabID, base, pass, openCodePollEvery, emitAgentStatus)
	}
	return env, args, observe, nil
}

func freeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

type ocSessionStatus struct {
	Type    string `json:"type"`
	Attempt int    `json:"attempt,omitempty"`
	Message string `json:"message,omitempty"`
}

type ocActiveResp struct {
	Data map[string]json.RawMessage `json:"data"`
}

type ocPermission struct {
	ID         string   `json:"id"`
	SessionID  string   `json:"sessionID"`
	Permission string   `json:"permission"`
	Patterns   []string `json:"patterns"`
}

type ocQuestion struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
	Questions []struct {
		Question string `json:"question"`
		Header   string `json:"header"`
	} `json:"questions"`
}

type ocState struct {
	session string
	status  string // busy | idle | waiting
	kind    string // ask | perm
	text    string
}

func observeOpenCode(ctx context.Context, tabID int, baseURL, password string, every time.Duration, sink func(agentEvent)) {
	client := &http.Client{Timeout: 2 * time.Second}
	if !waitOpenCode(ctx, client, baseURL, password, 20*time.Second) {
		if ctx.Err() == nil {
			log.Printf("[opencode t%d] server 20s 内没就绪，放弃状态观察", tabID)
		}
		return
	}
	log.Printf("[opencode t%d] server 就绪，开始观察", tabID)

	ticker := time.NewTicker(every)
	defer ticker.Stop()
	var lastStatus, lastKind, lastText, lastSession string
	errLogged := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		st, err := pollOpenCode(ctx, client, baseURL, password)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if msg := err.Error(); msg != errLogged {
				log.Printf("[opencode t%d] 状态请求失败: %v", tabID, err)
				errLogged = msg
			}
			continue
		}
		errLogged = ""
		if st.session == "" {
			// 一轮结束后 OpenCode 把 busy 条目删掉；如果这时 active 也空了，
			// 就一个会话都选不出来。但格子已经绑定过的会话并没有消失 ——
			// 对它来说“选不出来”就是空闲，不能把格子的状态永远冻在忙碌。
			if lastSession == "" {
				continue
			}
			st = ocState{session: lastSession, status: "idle"}
		}
		if st.session != lastSession {
			bindOpenCodeSession(tabID, st.session)
			lastSession = st.session
			lastStatus = "" // 会话变了：即使状态相同也要让前端拿到新 session
		}
		if st.status == lastStatus && st.kind == lastKind && st.text == lastText {
			continue
		}
		lastStatus, lastKind, lastText = st.status, st.kind, st.text
		out := agentEvent{
			V: 1, Tab: tabID, Agent: "opencode", Event: "status",
			Status: st.status, Kind: st.kind, Text: st.text,
			Session: st.session, Evidence: EvidenceHTTP,
		}
		normalizeAgentEvent(&out)
		sink(out)
	}
}

func bindOpenCodeSession(tabID int, sid string) {
	if host.BindSession(tabID, sid, "", "opencode") {
		log.Printf("[agent t%d] 关联建立 session=%s（opencode）", tabID, Short(sid))
		return
	}
	if host.RebindSession(tabID, sid, "", "opencode") {
		log.Printf("[agent t%d] 会话改写 session=%s（opencode）", tabID, Short(sid))
	}
}

func waitOpenCode(ctx context.Context, client *http.Client, baseURL, password string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if ctx.Err() != nil {
			return false
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/doc", nil)
		if err == nil {
			if password != "" {
				req.SetBasicAuth("opencode", password)
			}
			resp, derr := client.Do(req)
			if derr == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return true
				}
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func pollOpenCode(ctx context.Context, client *http.Client, baseURL, password string) (ocState, error) {
	var active ocActiveResp
	if err := ocGet(ctx, client, baseURL+"/api/session/active", password, &active); err != nil {
		return ocState{}, err
	}
	var statuses map[string]ocSessionStatus
	if err := ocGet(ctx, client, baseURL+"/session/status", password, &statuses); err != nil {
		return ocState{}, err
	}
	var perms []ocPermission
	if err := ocGet(ctx, client, baseURL+"/permission", password, &perms); err != nil {
		return ocState{}, err
	}
	var questions []ocQuestion
	if err := ocGet(ctx, client, baseURL+"/question", password, &questions); err != nil {
		return ocState{}, err
	}

	sid := chooseOCSession(active, statuses, perms, questions)
	if sid == "" {
		return ocState{}, nil
	}
	out := ocState{session: sid}

	// 等批准优先于等回答：权限框挂着的时候 OpenCode 不会继续跑。
	for _, p := range perms {
		if p.SessionID != sid {
			continue
		}
		out.status, out.kind = "waiting", "perm"
		out.text = strings.TrimSpace(p.Permission)
		if out.text == "" {
			out.text = "permission"
		}
		if len(p.Patterns) > 0 {
			if pat := strings.TrimSpace(p.Patterns[0]); pat != "" {
				out.text += ": " + pat
			}
		}
		out.text = Clip(out.text, 160)
		return out, nil
	}
	for _, q := range questions {
		if q.SessionID != sid {
			continue
		}
		out.status, out.kind = "waiting", "ask"
		if len(q.Questions) > 0 {
			t := strings.TrimSpace(q.Questions[0].Header)
			if t == "" {
				t = strings.TrimSpace(q.Questions[0].Question)
			}
			out.text = Clip(t, 160)
		}
		if out.text == "" {
			out.text = "OpenCode 在等你回答"
		}
		return out, nil
	}

	switch statuses[sid].Type {
	case "busy", "retry":
		out.status = "busy"
	case "idle":
		out.status = "idle"
	default:
		// 实测 1.19.3：一轮结束后条目是**被删掉**的，`/session/status`
		// 直接变回 `{}`，不会留下 `{type:"idle"}`。只要这条会话还选得
		// 出来（TUI 还开着它），没有条目就是空闲 —— 不能当作“没变化”
		// 跳过，否则格子会永远停在“工作中”。
		out.status = "idle"
	}
	return out, nil
}

// chooseOCSession 在“这个 server 上到底哪条会话是这一格的”上做确定性选择。
// TUI 正常只有一个活跃会话；多开时优先 pending 交互所属的那条，再退到排序后的
// 第一条（宁可稳定地选一条，也不要在两条之间来回跳）。
func chooseOCSession(active ocActiveResp, statuses map[string]ocSessionStatus, perms []ocPermission, questions []ocQuestion) string {
	if len(active.Data) == 1 {
		for sid := range active.Data {
			return sid
		}
	}
	for _, p := range perms {
		if p.SessionID != "" {
			return p.SessionID
		}
	}
	for _, q := range questions {
		if q.SessionID != "" {
			return q.SessionID
		}
	}
	if len(statuses) == 1 {
		for sid := range statuses {
			return sid
		}
	}
	keys := make([]string, 0, len(active.Data)+len(statuses))
	for sid := range active.Data {
		keys = append(keys, sid)
	}
	for sid := range statuses {
		keys = append(keys, sid)
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	return keys[0]
}

func ocGet(ctx context.Context, client *http.Client, url, password string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if password != "" {
		req.SetBasicAuth("opencode", password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: HTTP %d %s", url, resp.StatusCode, Clip(string(b), 120))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
