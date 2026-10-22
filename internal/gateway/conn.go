// Package gateway 是 Perch 对本地 magpie 网关的**只读观测**与**控制面**适配。
//
// 读数为什么全部走 HTTP：
//   - magpie 的网关就开在 127.0.0.1:3425 上，`/v1/magpie/usage`、
//     `/v1/magpie/usage/requests`、`/v1/magpie/concurrency`、`/v1/models`
//     这几条就是它自己界面在用的数据（docs/reference.md:1727+），
//     形状稳定、字段齐全，还带上了 agent/provider 的名字和图标 id。
//   - 直接读 `usage.jsonl` 要自己重算聚合，而且那份文件 9MB+、还在长；
//     网关接口已经把**窗口、聚合、分档**都做好了 —— 不重复造一份会漂的口径。
//   - 请求记录里**没有 prompt 内容**（reference.md 原话 "What was said in a
//     call is not in either"）。这是选它、不选 routing/*.jsonl 的硬理由。
//
// 连接不上的三种真实状态必须分得开：
//
//	running  3425 上有人应答（magpie 开着）
//	stopped  ~/.config/magpie 在、但 3425 连不上（装了没开 / 网关关了）
//	absent   两样都没有（没装，或者装在认不出的位置）
//
// ⚠️ 隐私：这里只解 JSON 里点名的字段。provider 的 key、账号、prompt 一律
// 不进结构体，日志里也只打数量。providers.json 是唯一一份带 key 的文件，
// 我们只取 id/name/icon/chat/website/preset，并且**永远不 Marshal 原始结构**。
package gateway

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/uimsg"
)

const (
	gwKeyFile    = "magpie-web.key"
	gwHTTPWait   = 20 * time.Second
	gwActionWait = 3 * time.Minute // 供应商保存可能拉上游模型目录
)

// Gateway 是内置引擎的控制面连接 + 读数 watcher 的持有者。
// 用 New 构造；零值不可用。
type Gateway struct {
	push func(any)

	mu         sync.Mutex
	port       int
	key        string
	client     *http.Client
	proc       *os.Process // 只存 Process：更新会 re-exec 成另一个 PID，句柄要能换
	ours       bool
	exe        string
	gatewayURL string // 写进 agent 配置的稳定地址（内置引擎）
	configDir  string // 内置引擎的 magpie 配置目录
	dataDir    string // 内置引擎的数据目录
	lastErr    string

	watcherMu  sync.RWMutex
	docWatcher *watcher

	driftErr string

	// 接线状态的 launch 命令：agy 这类 agent 把网关地址/密钥放在环境变量里，
	// 只能按 magpie 给的那条命令启动。每次 /api/state 到达时整份替换。
	launchMu    sync.Mutex
	agentLaunch map[string]string
}

// New 构造一个未连接的网关。push 是发给前端的函数，可以为 nil（测试）。
func New(push func(any)) *Gateway {
	return &Gateway{push: push, agentLaunch: map[string]string{}}
}

func (g *Gateway) emit(v any) {
	if g.push != nil {
		g.push(v)
	}
}

// ---------------------------------------------------------------------------
// 进程与鉴权
// ---------------------------------------------------------------------------

func gwKeyPath() string {
	p, err := appdir.PerchFile(gwKeyFile)
	if err != nil {
		return ""
	}
	return p
}

// UsedBefore 只看 key 文件在不在：存在 = 这台机器上用过网关（Perch 起过控制面）。
// 不能用 loadKey 判断 —— 它没有时会新发一枚并落盘，把标记本身造出来。
func (g *Gateway) UsedBefore() bool {
	p := gwKeyPath()
	if p == "" {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// loadKey 取上一次的 key（重启 Perch 后还能接上同一个控制面），没有就新发一枚。
func (g *Gateway) loadKey() string {
	p := gwKeyPath()
	if p != "" {
		if b, err := os.ReadFile(p); err == nil {
			k := strings.TrimSpace(string(b))
			if len(k) >= 16 && strings.Trim(k, "0123456789abcdef") == "" {
				return k
			}
		}
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("perch%032x", time.Now().UnixNano())
	}
	k := hex.EncodeToString(buf)
	if p != "" {
		if err := os.MkdirAll(filepath.Dir(p), 0700); err == nil {
			_ = os.WriteFile(p, []byte(k), 0600)
		}
	}
	return k
}

func gwClient() *http.Client {
	return &http.Client{
		Timeout: gwHTTPWait,
		// 本机地址不能被系统代理截走。
		Transport: &http.Transport{Proxy: nil},
	}
}

// gwPing 问一次 /api/providers：200 说明这个端口上的 magpie web 认得这枚 key。
func gwPing(port int, key string) bool {
	if port <= 0 || key == "" {
		return false
	}
	req, err := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/providers", port), nil)
	if err != nil {
		return false
	}
	req.AddCookie(&http.Cookie{Name: fmt.Sprintf("magpie_web_%d", port), Value: key})
	c := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{Proxy: nil}}
	res, err := c.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	return res.StatusCode == http.StatusOK
}

// Stop 只关 Perch 自己拉起来的那个控制面；接上的外部控制面只断开连接。
// 没接控制面时直接返回：关窗路径也会调它，不要凭空打一行"已断开 0"。
func (g *Gateway) Stop() {
	g.mu.Lock()
	if g.client == nil && g.proc == nil {
		g.mu.Unlock()
		return
	}
	proc, ours := g.proc, g.ours
	g.client, g.proc, g.ours = nil, nil, false
	g.gatewayURL, g.configDir = "", ""
	g.lastErr = ""
	port := g.port
	g.mu.Unlock()
	if ours && proc != nil {
		_ = proc.Kill()
		_, _ = proc.Wait()
		log.Printf("[gw] 已停止内置网关引擎（控制面端口 %d）", port)
	} else if port != 0 {
		log.Printf("[gw] 已断开控制面（%d 不是 Perch 拉起的进程）", port)
	}
	g.emit(map[string]any{"type": "gw", "gw": map[string]any{"connected": false, "at": nowISO()}})
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

func (g *Gateway) connState() (int, string, *http.Client, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.port, g.key, g.client, g.ours
}

// API 是唯一一条通往 magpie 的 HTTP 路。路径白名单在这里，不在前端。
func (g *Gateway) API(method, path string, body any) ([]byte, error) {
	port, key, client, _ := g.connState()
	if client == nil {
		return nil, uimsg.New("gw.controlPlaneDown", "控制面未连接")
	}
	if !strings.HasPrefix(path, "/api/") || strings.Contains(path, "..") || strings.Contains(path, "k=") {
		return nil, uimsg.NewParams("gw.badAPIPath", fmt.Sprintf("不允许的网关 API 路径：%s", path),
			map[string]string{"path": path})
	}
	if method != "GET" && method != "POST" {
		return nil, uimsg.New("gw.methodNotAllowed", "只允许 GET/POST")
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, requestFailed(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), rd)
	if err != nil {
		return nil, requestFailed(err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: fmt.Sprintf("magpie_web_%d", port), Value: key})
	// 写操作（供应商保存/测试）可能要拉上游：换一个不带短超时的 client，
	// 但连接仍复用。
	c := client
	if method == "POST" {
		c = &http.Client{Timeout: gwActionWait, Transport: client.Transport}
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, requestFailed(err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return nil, requestFailed(err)
	}
	if res.StatusCode/100 != 2 {
		return nil, apiError(data, res.StatusCode)
	}
	return data, nil
}

// apiError 把非 2xx 的响应变成**用户可读**的错误。用户看到的应该是原因，
// 不是响应体：先取 {"error": "…"} 里那句；取不出来就只报状态码，绝不把
// 原始正文（可能是 HTML、堆栈或带凭据的片段）抛到界面上。
// 已知的上游边界给稳定码（前端有本地化文案），不再把英文正文抛上去。
func apiError(data []byte, statusCode int) error {
	var je struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Agent   string `json:"agent"`
		Offline string `json:"offline"`
	}
	reason := ""
	if json.Unmarshal(data, &je) == nil {
		reason = strings.TrimSpace(je.Error)
	}
	status := strconv.Itoa(statusCode)
	switch je.Code {
	case "no_models":
		return uimsg.NewParams("gw.noModels",
			"网关还没有任何模型来源，先去网关添加 provider 或订阅",
			map[string]string{"agent": je.Agent})
	case "all_hidden":
		return uimsg.NewParams("gw.allHidden",
			"这个 agent 的网关模型列表是空的，先去网关为它选择模型",
			map[string]string{"agent": je.Agent})
	case "runtime_unavailable":
		return uimsg.NewParams("gw.runtimeUnavailable",
			"这个 agent 的运行时没有启动，先打开它再接入",
			map[string]string{"agent": je.Agent, "offline": je.Offline})
	}
	if strings.Contains(strings.ToLower(reason), "can't be connected") {
		return uimsg.NewParams("gw.agentNotConnectable",
			"网关不能接入这个 agent（该 agent 没有可路由的 provider 选项）",
			map[string]string{"status": status})
	}
	if reason == "" {
		return uimsg.NewParams("gw.httpErrorNoBody",
			fmt.Sprintf("网关回答 HTTP %d", statusCode),
			map[string]string{"status": status})
	}
	return uimsg.NewParams("gw.httpError",
		fmt.Sprintf("网关回答 HTTP %d：%s", statusCode, reason),
		map[string]string{"status": status, "reason": reason})
}

// requestFailed 是控制面请求在传输层失败的统一说法；OS/网络原文作为 {err}。
func requestFailed(err error) error {
	return uimsg.Wrap(err, "gw.requestFailed", err.Error(), map[string]string{"err": err.Error()})
}

func nowISO() string { return time.Now().Format(time.RFC3339) }

func (g *Gateway) pushGW(m map[string]any) {
	g.emit(map[string]any{"type": "gw", "gw": m})
}

// Connect 由用户点「连接」触发：接上（必要时拉起）控制面，再推整份原生读数。
func (g *Gateway) Connect() {
	if err := g.Ensure(); err != nil {
		log.Printf("[gw] 连接失败：%v", err)
		g.pushGW(uimsg.Fields(map[string]any{"connected": false, "at": nowISO()}, err))
		return
	}
	g.Refresh()
}

/* Refresh 只确认「控制面还在、端口是多少」。供应商与 agent 数据由各自的
 * 原生接口按需读取；Refresh 不替页面缓存业务数据。 */
func (g *Gateway) Refresh() {
	port, key, client, ours := g.connState()
	if client == nil || !gwPing(port, key) {
		g.pushGW(map[string]any{"connected": false, "at": nowISO()})
		return
	}
	g.mu.Lock()
	exe := g.exe
	gatewayURL := g.gatewayURL
	g.mu.Unlock()
	g.pushGW(map[string]any{
		"connected": true,
		"port":      port,
		"gateway":   gatewayURL,
		"ours":      ours,
		"exe":       exe,
		"at":        nowISO(),
	})
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}
