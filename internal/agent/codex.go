package agent

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// ---------------------------------------------------------------------------
// Codex 适配器（0.163.0）
//
// 机制：**每一格自己起一个 app-server**，TUI 通过 --remote 连它。
//
//	codex app-server --listen ws://127.0.0.1:0 --ws-auth capability-token \
//	      --ws-token-sha256 <sha256(口令)>
//	codex [resume …] --remote ws://127.0.0.1:<port> \
//	      --remote-auth-token-env PERCH_CODEX_TOKEN
//
// 为什么不走 hooks（Orca 对 Codex 的 TUI 走的是那条）：这台机器上的
// ~/.codex/hooks.json 是 Orca 装的，Perch 不该改写用户的全局 agent 配置。
// app-server 是 Codex 自己公开的协议面，状态就在 thread/status/changed 里，
// 正好是我们要的“忙 / 闲 / 卡在等你”，而且不碰任何配置文件。
//
// 为什么每格一个 server，而不是连默认的共享 daemon（app-server-control.sock）：
// 共享 daemon 上所有客户端的通知混在一起，格子只能靠 cwd / 时间猜归属；
// 每格一个 server 时，“这个 server 里的一切都属于这一格”是进程边界保证的。
// server 是 Perch 的子进程，继承 job（见 job_windows.go），Perch 退它跟着退；
// 关格时观察者用 taskkill /T 把它和它拉起的子进程一起收掉。
//
// ⚠️ capability token 只走内存：启动参数给的是**摘要**（--ws-token-sha256），
// 明文只通过 PERCH_CODEX_TOKEN 交给 TUI，盘上不落。
//
// 失败一律**退回普通 codex**（无状态，但能正常用）：app-server 是实验特性，
// 老版本没有子命令、端口被策略挡住之类的事都会发生。退回时 env/args 都为空，
// 由 handleTab 照常启动 `codex [resume …]`（它自己会连共享 daemon）。
// ---------------------------------------------------------------------------

const (
	codexTokenEnv      = "PERCH_CODEX_TOKEN"
	codexServerTimeout = 6 * time.Second // 从 Start 到 stderr 报出监听端口
	codexDialTimeout   = 4 * time.Second // WS 握手 + initialize
	codexRetryMin      = 300 * time.Millisecond
	codexRetryMax      = 3 * time.Second
)

// codexPortRe 只认回环地址上的端口。banner 实测是
//
//	listening on: ws://127.0.0.1:54321
//
// 但前面可能带 ANSI 颜色或时间戳，所以不锚定行首。
var codexPortRe = regexp.MustCompile(`ws://127\.0\.0\.1:(\d+)`)

func codexDef() Def {
	d := GenericDef("codex")
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			// resume --last：不弹选择器，直接接最近一条（0.163.0 的 --help 实测）。
			return []string{"resume", "--last"}
		case "exact":
			if r.ID != "" {
				return []string{"resume", r.ID}
			}
		case "fork":
			if r.ID != "" {
				return []string{"fork", r.ID}
			}
		}
		// "new"：裸启动就是新会话。
		return nil
	}
	d.Prepare = prepareCodex
	return d
}

// prepareCodex 起这一格的 app-server，握手成功后把 --remote 参数交给 TUI。
// 任何一步失败都不算启动失败：返回空 env/args，让 TUI 走普通 codex。
func prepareCodex(tag string, tabID int, cwd string, profileArgs []string, profileEnv map[string]string) (map[string]string, []string, func(context.Context), error) {
	token, digest, err := newCodexToken()
	if err != nil {
		log.Printf("[codex %s] 生成口令失败，退回普通 codex: %v", tag, err)
		return nil, nil, nil, nil
	}
	// 真正的会话/模型在 app-server 里，不在 TUI。Perch 的 -c 覆盖必须同时
	// 交给 app-server（连同 profileEnv 里的 key），否则 TUI 连上的是一个仍用
	// 用户自己 ~/.codex 配置的服务，模型/provider 对不上时 TUI 会立刻退出（空白格子）。
	cmd, waitCh, port, err := startCodexAppServer(tag, cwd, digest, profileArgs, profileEnv)
	if err != nil {
		log.Printf("[codex %s] app-server 起不来，退回普通 codex（无状态）: %v", tag, err)
		return nil, nil, nil, nil
	}
	url := fmt.Sprintf("ws://127.0.0.1:%d", port)

	ctx, cancel := context.WithTimeout(context.Background(), codexDialTimeout)
	conn, derr := dialCodex(ctx, url, token, tag)
	cancel()
	if derr != nil {
		log.Printf("[codex %s] app-server 握手失败，退回普通 codex（无状态）: %v", tag, derr)
		stopCodexServer(cmd, waitCh)
		return nil, nil, nil, nil
	}

	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			stopCodexServer(cmd, waitCh)
		})
	}

	env := map[string]string{codexTokenEnv: token}
	args := []string{"--remote", url, "--remote-auth-token-env", codexTokenEnv}
	log.Printf("[codex %s] app-server pid=%d %s（状态观察已接上）", tag, cmd.Process.Pid, url)
	observe := func(octx context.Context) {
		observeCodex(octx, tabID, cwd, url, token, conn, emitAgentStatus, stop)
	}
	return env, args, observe, nil
}

// newCodexToken 生成明文与它的 SHA-256 摘要（都是 hex）。
// 服务端只拿摘要；TUI 只拿明文。
func newCodexToken() (token, digest string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}

// startCodexAppServer 起进程并等它把监听端口报出来。
//
// 返回的 waitCh 只会收到一次 Wait 的结果；调用方**不要**再 cmd.Wait()。
// stderr 用自己建的 os.Pipe 接：cmd.Wait 只关它自己那一端的句柄，不会把
// 还没读完的 banner 截掉（exec.Cmd.StderrPipe 的文档明确警告这个顺序）。
func startCodexAppServer(tag, cwd, digest string, profileArgs []string, profileEnv map[string]string) (*exec.Cmd, chan error, int, error) {
	exe, prefix := host.ResolveExe("codex")
	args := append([]string{}, prefix...)
	// `-c` 是 Codex 的全局选项，必须在 app-server 子命令之前。
	args = append(args, profileArgs...)
	args = append(args,
		"app-server",
		"--listen", "ws://127.0.0.1:0",
		"--ws-auth", "capability-token",
		"--ws-token-sha256", digest,
	)
	cmd := exec.Command(exe, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	// 和 PTY 里那份环境一致：不继承 CLAUDE*、终端身份由我们声明。
	// profileEnv 必须也给它：真正调模型的是 app-server，不是 TUI —— 提供商的 key
	// 走 env_key 注入时，只给 TUI 等于没给（2026-10-28 拆网关时修的）。
	cmd.Env = BuildEnv(profileEnv)
	// 同一个 job：Perch 一退，server 跟着退（见 job_windows.go）。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}

	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, nil, 0, fmt.Errorf("建 stderr 管道: %w", err)
	}
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return nil, nil, 0, fmt.Errorf("启动 %s: %w", exe, err)
	}
	_ = pw.Close() // 父进程不再写；子进程那份由它自己关

	portCh := make(chan int, 1)
	go scanCodexStderr(pr, tag, portCh)
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	deadline := time.After(codexServerTimeout)
	for {
		select {
		case p, ok := <-portCh:
			if !ok || p <= 0 {
				stopCodexServer(cmd, waitCh)
				return nil, nil, 0, fmt.Errorf("app-server 在报出监听端口前退出")
			}
			return cmd, waitCh, p, nil
		case werr := <-waitCh:
			// Wait 返回不等于 stderr 已经读完；给扫描器一点收尾时间，
			// 否则“打印了端口但立刻退出”会被误判成没起来。
			select {
			case p, ok := <-portCh:
				if ok && p > 0 {
					return cmd, waitCh, p, nil
				}
			case <-time.After(300 * time.Millisecond):
			}
			return nil, nil, 0, fmt.Errorf("app-server 提前退出: %v", werr)
		case <-deadline:
			stopCodexServer(cmd, waitCh)
			return nil, nil, 0, fmt.Errorf("app-server 在 %s 内没有报出监听端口", codexServerTimeout)
		}
	}
}

// scanCodexStderr 一直读到 EOF（server 退出才 EOF），找出监听端口后 close(portCh)。
// 端口之后的行照样读掉，别让管道写满把 server 卡死。
func scanCodexStderr(r io.ReadCloser, tag string, portCh chan<- int) {
	defer close(portCh)
	defer r.Close()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 512*1024)
	sent := false
	kept := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if !sent {
			if m := codexPortRe.FindStringSubmatch(line); m != nil {
				if p, err := strconv.Atoi(m[1]); err == nil && p > 0 {
					portCh <- p
					sent = true
					log.Printf("[codex %s] app-server 监听 %s", tag, line)
					continue
				}
			}
		}
		// 启动阶段留几行诊断；之后只留像错误的行，避免把 server 的正常
		// 输出当日志刷屏（turn 的执行输出走的是别的通知，不在这里）。
		low := strings.ToLower(line)
		if kept < 20 || strings.Contains(low, "error") || strings.Contains(low, "panic") {
			log.Printf("[codex %s] app-server: %s", tag, Clip(line, 300))
			kept++
		}
	}
}

// stopCodexServer 收掉进程树并等 Wait 返回。
// taskkill /T 是关键：app-server 会拉起 MCP / shell 子进程，只杀它自己
// 会在盘上留下孤儿（Perch 退出时有 job 兜底，关单格时没有）。
func stopCodexServer(cmd *exec.Cmd, waitCh <-chan error) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	k := exec.CommandContext(ctx, "taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	k.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	_ = k.Run()
	cancel()
	_ = cmd.Process.Kill() // taskkill 没找到时兜底；已经退了就忽略错误
	select {
	case <-waitCh:
	case <-time.After(3 * time.Second):
	}
}

// dialCodex 建 WS、带能力口令、走完 initialize。
// 只连回环地址：URL 是我们自己拼的，token 也只该走本机。
func dialCodex(ctx context.Context, url, token, tag string) (*websocket.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, codexDialTimeout)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	conn, _, err := websocket.Dial(dctx, url, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
	})
	if err != nil {
		return nil, err
	}
	if err := codexInitialize(dctx, conn, tag); err != nil {
		conn.CloseNow()
		return nil, err
	}
	return conn, nil
}

// codexInitialize 发 initialize，等它的响应。
//
// 客户端是“被动观察者”：initialize 之后只读通知，不发 turn/start 之类。
// server 反向发来的请求（批准/提问）在这条连接上不该出现（实测 0.163.0
// 只发给 TUI），真出现时回 -32601 —— 沉默会让 server 那边一直挂着。
func codexInitialize(ctx context.Context, conn *websocket.Conn, tag string) error {
	if err := codexWrite(ctx, conn, map[string]any{
		"id":     1,
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]any{
				"name": "perch", "title": "Perch", "version": "0.1.0",
			},
			// thread/status/changed 属于实验 API 面；Orca 同款客户端也开它。
			"capabilities": map[string]any{"experimentalApi": true},
		},
	}); err != nil {
		return err
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var m codexMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.Method != "" {
			if codexHasID(m.ID) {
				codexRejectRequest(ctx, conn, m.ID, tag)
			}
			continue
		}
		if !codexIDIs(m.ID, 1) {
			continue
		}
		if m.Error != nil {
			return fmt.Errorf("initialize: %s", m.Error.Message)
		}
		var res struct {
			UserAgent string `json:"userAgent"`
		}
		_ = json.Unmarshal(m.Result, &res)
		log.Printf("[codex %s] app-server 握手完成（%s）", tag, Clip(res.UserAgent, 160))
		return nil
	}
}

// observeCodex 读这一格的 app-server 通知，归一化成 agentEvent。
// 断线就重连（同一台 server）；重连后用 thread/read 把状态补回来。
// sink 在生产里是 emitAgentStatus；集成测试传自己的收集器。
func observeCodex(ctx context.Context, tabID int, cwd, url, token string, conn *websocket.Conn, sink func(agentEvent), stop func()) {
	defer stop()
	st := &codexPaneState{
		tabID:     tabID,
		cwd:       cwd,
		threads:   map[string]codexThreadStatus{},
		ephemeral: map[string]bool{},
		subagent:  map[string]bool{},
		// 第一帧是快照：冷恢复的格子可能带着重启前的旧状态，前端要按 resync 处理。
		evidence: EvidenceResync,
	}
	backoff := codexRetryMin
	for {
		if conn == nil {
			if !sleepCtx(ctx, backoff) {
				return
			}
			c, err := dialCodex(ctx, url, token, fmt.Sprintf("t%d", tabID))
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("[codex t%d] 重连失败: %v", tabID, err)
				backoff *= 2
				if backoff > codexRetryMax {
					backoff = codexRetryMax
				}
				continue
			}
			conn = c
			backoff = codexRetryMin
			log.Printf("[codex t%d] 已重连 app-server", tabID)
			if st.session != "" {
				// 断线期间的变化不会重放：主动读一次当前状态。
				_ = codexWrite(ctx, conn, map[string]any{
					"id": 3, "method": "thread/read",
					"params": map[string]any{"threadId": st.session, "includeTurns": false},
				})
			}
		}

		err := codexReadLoop(ctx, conn, st, sink)
		conn.CloseNow()
		conn = nil
		if ctx.Err() != nil {
			return
		}
		log.Printf("[codex t%d] 观察连接断开: %v", tabID, err)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// ---------------- 协议消息 ----------------

type codexMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *codexRPCError  `json:"error"`
}

type codexRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type codexThreadStatus struct {
	Type  string   `json:"type"`
	Flags []string `json:"activeFlags"`
}

type codexThread struct {
	ID             string            `json:"id"`
	SessionID      string            `json:"sessionId"`
	Name           string            `json:"name"`
	Ephemeral      bool              `json:"ephemeral"`
	ParentThreadID *string           `json:"parentThreadId"`
	Status         codexThreadStatus `json:"status"`
}

func codexHasID(id json.RawMessage) bool {
	s := strings.TrimSpace(string(id))
	return s != "" && s != "null"
}

func codexIDIs(id json.RawMessage, n int) bool {
	return strings.TrimSpace(string(id)) == strconv.Itoa(n)
}

func codexWrite(ctx context.Context, conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

func codexRejectRequest(ctx context.Context, conn *websocket.Conn, id json.RawMessage, tag string) {
	log.Printf("[codex %s] ⚠️ app-server 发来请求（观察者不回答，回 -32601）", tag)
	_ = codexWrite(ctx, conn, map[string]any{
		"id":    id,
		"error": map[string]any{"code": -32601, "message": "perch observer does not answer requests"},
	})
}

func codexReadLoop(ctx context.Context, conn *websocket.Conn, st *codexPaneState, sink func(agentEvent)) error {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var m codexMessage
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.Method != "" {
			if codexHasID(m.ID) {
				codexRejectRequest(ctx, conn, m.ID, fmt.Sprintf("t%d", st.tabID))
				continue
			}
			handleCodexNotification(m.Method, m.Params, st, sink)
			continue
		}
		if codexIDIs(m.ID, 3) && m.Error == nil {
			st.handleThreadRead(m.Result, sink)
		}
	}
}

// ---------------- 归一化 ----------------

// codexPaneState 是一次观察里的格内上下文。
//
// 只由读循环那一个 goroutine 改写（重连后的 thread/read 响应也在读循环里），
// 不需要锁。session 一旦定下就只用于**选择聚合哪条线程**，后面的状态改写
// 交给 bindObservedSession（它才有落盘/判落空的语义）。
type codexPaneState struct {
	tabID     int
	cwd       string
	session   string
	name      string
	threads   map[string]codexThreadStatus
	ephemeral map[string]bool // 标题生成之类的内部线程：状态不算这一格的
	subagent  map[string]bool // parentThreadId 非空：子代理线程，同样不算
	// evidence 是**下一条**事件的证据来源。连上后的第一帧（thread/started）
	// 和重连后的 thread/read 都是快照，标 resync；其余通知是 app-server。
	evidence string
}

func (st *codexPaneState) bindSession(id string) {
	if id == "" || st.session != "" {
		return
	}
	st.session = id
	bindObservedSession(st.tabID, id, "codex")
}

// maybeBind 决定“这条线程值不值得记成这一格的会话”。
//
// 为什么不在 thread/started 时无条件绑：实测 0.163.0 **在第一轮对话之前
// 不写 rollout 文件**。先绑的话，盘上会留下一个接不回来的 id —— 下次重开
// 会被判成 no_session，而它本来应该是“还没开始”。所以只在两种时刻绑：
//
//  1. 状态变成 active（有一轮在跑，rollout 就要落盘了）；
//  2. 盘上已经有这条线程的 rollout（resume --last 接回来的老会话：
//     它可能一启动就是 idle，但确实可续，必须绑）。
//
// 文件判据是只读 glob，且只在没绑定时问一次，代价可以忽略。
func (st *codexPaneState) maybeBind(id string, s codexThreadStatus) {
	if st.session != "" || id == "" {
		return
	}
	if s.Type == "active" || codexSessionFileExists(st.cwd, id) {
		st.bindSession(id)
	}
}

// threadOf 决定聚合时的“根线程”集合：
//   - 已绑定：只看这一条（格子就是它）；
//   - 未绑定：所有非 ephemeral、非子代理的线程（通常只有启动时那一条）。
func (st *codexPaneState) threadOf() []codexThreadStatus {
	if st.session != "" {
		if s, ok := st.threads[st.session]; ok {
			return []codexThreadStatus{s}
		}
		return nil
	}
	out := make([]codexThreadStatus, 0, len(st.threads))
	for id, s := range st.threads {
		if st.ephemeral[id] || st.subagent[id] {
			continue
		}
		out = append(out, s)
	}
	return out
}

// aggregate 是一条格子的汇总结论：等批准 > 等回答 > 忙碌 > 空闲。
// 没有可聚合的线程时 ok=false —— 这时**不发**事件，否则会把格子提前推成
// “空闲”（前端一收到就会把状态写实）。
func (st *codexPaneState) aggregate() (status, kind string, ok bool) {
	ss := st.threadOf()
	if len(ss) == 0 {
		return "", "", false
	}
	busy := false
	for _, s := range ss {
		if s.Type == "active" {
			for _, f := range s.Flags {
				if f == "waitingOnApproval" {
					return "waiting", "perm", true
				}
			}
			for _, f := range s.Flags {
				if f == "waitingOnUserInput" {
					return "waiting", "ask", true
				}
			}
			busy = true
		}
	}
	if busy {
		return "busy", "", true
	}
	// idle / notLoaded / systemError 都按空闲处理：systemError 不是“在跑”，
	// 也不是“在等你”，把格子冻在忙碌反而更糟。
	return "idle", "", true
}

func (st *codexPaneState) emit(sink func(agentEvent)) {
	status, kind, ok := st.aggregate()
	if !ok {
		return
	}
	evidence := st.evidence
	if evidence == "" {
		// 测试构造的 state 没有这个字段；生产构造时一定是 resync。
		evidence = EvidenceAppServer
	}
	st.evidence = EvidenceAppServer
	state := agentStateWaiting // waitingOnApproval / waitingOnUserInput 都是“在等你”
	switch status {
	case "busy":
		state = agentStateWorking
	case "idle":
		state = agentStateDone
	}
	sink(agentEvent{
		V: 1, Tab: st.tabID, Agent: "codex", Event: "status",
		Status: status, State: state, Kind: kind, Session: st.session, Name: st.name,
		Evidence: evidence,
	})
}

func handleCodexNotification(method string, params json.RawMessage, st *codexPaneState, sink func(agentEvent)) {
	switch method {
	case "thread/started":
		var p struct {
			Thread codexThread `json:"thread"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		th := p.Thread
		id := th.ID
		if id == "" {
			id = th.SessionID
		}
		if id == "" {
			return
		}
		st.threads[id] = th.Status
		st.ephemeral[id] = th.Ephemeral
		if th.ParentThreadID != nil && strings.TrimSpace(*th.ParentThreadID) != "" {
			st.subagent[id] = true
		}
		if th.Name != "" && (st.session == "" || id == st.session) {
			st.name = th.Name
		}
		if !th.Ephemeral && !st.subagent[id] {
			st.maybeBind(id, th.Status)
		}
		st.emit(sink)

	case "thread/status/changed":
		var p struct {
			ThreadID string            `json:"threadId"`
			Status   codexThreadStatus `json:"status"`
		}
		if json.Unmarshal(params, &p) != nil || p.ThreadID == "" {
			return
		}
		st.threads[p.ThreadID] = p.Status
		if !st.ephemeral[p.ThreadID] && !st.subagent[p.ThreadID] {
			st.maybeBind(p.ThreadID, p.Status)
		}
		st.emit(sink)

	case "thread/name/updated":
		var p struct {
			ThreadID string `json:"threadId"`
			Name     string `json:"threadName"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		if st.session == "" || p.ThreadID == st.session {
			st.name = p.Name
			// 名字不是状态：单独发一条没有 status 的 agent 消息会把前端
			// v.st 清成 ""（同 Pi）。跟着下一条状态一起发。
			log.Printf("[codex t%d] 名字 → %q", st.tabID, Clip(p.Name, 80))
		}

	default:
		// turn/item/delta/tokenUsage 等对本阶段没用；静默丢掉。
	}
}

// handleThreadRead 是**重连后**的状态补齐（thread/read 的响应）。
func (st *codexPaneState) handleThreadRead(result json.RawMessage, sink func(agentEvent)) {
	var r struct {
		Thread codexThread `json:"thread"`
	}
	if json.Unmarshal(result, &r) != nil || r.Thread.ID == "" {
		return
	}
	th := r.Thread
	st.threads[th.ID] = th.Status
	if th.Name != "" {
		st.name = th.Name
	}
	if !th.Ephemeral {
		st.bindSession(th.ID)
	}
	// 这是**断线期间**的补齐：前端刚冷恢复时，先把这一帧当 resync（waiting 要等
	// 一条活事件才认，见 80-live.js 的 restoredUnconfirmed）。
	st.evidence = EvidenceResync
	st.emit(sink)
}

// ---------------- 盘上的会话文件 ----------------

// codexHome 解析 Codex 的 home（CODEX_HOME 优先，否则 ~/.codex）。
// 相对路径按 Codex 的规则从工作目录解析。
func codexHome(cwd string) string {
	if v := strings.TrimSpace(os.Getenv("CODEX_HOME")); v != "" {
		if filepath.IsAbs(v) || cwd == "" {
			return v
		}
		return filepath.Join(cwd, v)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// codexSessionFileExists：这条会话在盘上还有没有。
//
// 实测 0.163.0 的 rollout 路径：
//
//	<home>/sessions/<年>/<月>/<日>/rollout-<时间戳>-<thread-id>.jsonl
//
// 和 Claude/Pi 一样**不从 cwd 反推目录**，只 glob 文件名尾部的 id。
// 归档目录的层级各版本不同，两种形状都试一次；找不到只影响冷恢复的
// 判定（会被降级成新会话），不会写任何东西。
func codexSessionFileExists(cwd, id string) bool {
	if !SafeSessionID(id) {
		return false
	}
	root := codexHome(cwd)
	if root == "" {
		return false
	}
	patterns := []string{
		filepath.Join(root, "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"),
		filepath.Join(root, "archived_sessions", "rollout-*-"+id+".jsonl"),
		filepath.Join(root, "archived_sessions", "*", "rollout-*-"+id+".jsonl"),
	}
	for _, pat := range patterns {
		if m, err := filepath.Glob(pat); err == nil && len(m) > 0 {
			return true
		}
	}
	return false
}
