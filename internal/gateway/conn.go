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
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/uimsg"
)

const (
	gwFirstPort  = 3439
	gwPortTries  = 4
	gwKeyFile    = "magpie-web.key"
	gwHTTPWait   = 20 * time.Second
	gwActionWait = 8 * time.Minute // 首个插件要下载 Bun + npm 包
)

// Gateway 是控制面连接 + 读数 watcher + 内嵌页反代的持有者。
// 用 New 构造；零值不可用。
type Gateway struct {
	push func(any)

	mu      sync.Mutex
	port    int
	key     string
	client  *http.Client
	proc    *os.Process // 只存 Process：更新会 re-exec 成另一个 PID，句柄要能换
	ours    bool
	exe     string
	lastErr string
	// isolated：Perch 自己的 portable 引擎（isolated.go）。默认 false，
	// 保持桌面 magpie 的旧路径；由组合根在 StartWatcher 之前打开。
	isolated bool
	isoPort  int

	// profileApplied 记录当前引擎进程里已经成功设置过的模型组。
	// 开格时同一个 alias/model/effort 不再启动 magpie CLI；引擎重连（key/port
	// 变化）自然会 miss，下一次开格重新应用。
	profileMu      sync.Mutex
	profileApplied map[string]string

	watcherMu  sync.RWMutex
	docWatcher *watcher

	uiMu sync.Mutex
	ui   *uiState

	updMu   sync.Mutex // TryLock：同一时间只允许一条更新链路
	updLast string     // 上一次推给前端的原始状态，进度没变就不重复推

	// 界面语言：langWant 是 Perch 的选择（system/en/zh），langApplied 是已经
	// 写进 magpie 的那个值。langRun 串行化"读整份设置 → 只改 lang → 写回"。
	langMu      sync.Mutex
	langRun     sync.Mutex
	langWant    string
	langApplied string

	driftErr string

	// 接线状态的 launch 命令：agy 这类 agent 把网关地址/密钥放在环境变量里，
	// 只能按 magpie 给的那条命令启动。每次 /api/state 到达时整份替换。
	launchMu    sync.Mutex
	agentLaunch map[string]string
	// agentEngine：哪些 agent 现在确实由引擎接入了网关。只有这些 agent 的
	// 启动才应该把用户目录换到引擎沙盒；没接线的仍读用户自己的配置。
	// 这份表会落盘：冷恢复的格子比第一次 /api/state 更早启动，不能等状态
	// 到了才知道该不该换沙盒。
	agentEngine      map[string]bool
	engineAgentsFile string
}

// New 构造一个未连接的网关。push 是发给前端的函数，可以为 nil（测试）。
func New(push func(any)) *Gateway {
	return &Gateway{
		push:        push,
		agentLaunch: map[string]string{},
		agentEngine: map[string]bool{},
	}
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

// Ensure 接上或拉起控制面。只由用户点「连接」或启动时的被动探测调用。
func (g *Gateway) Ensure() error {
	if g.Isolated() {
		return g.ensureIsolated()
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.client != nil && gwPing(g.port, g.key) {
		return nil
	}

	key := g.key
	if key == "" {
		key = g.loadKey()
	}
	// 1) 已经有一个用同一枚 key 跑在候选端口上的控制面：直接接。
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		if gwPing(p, key) {
			g.port, g.key = p, key
			g.client = gwClient()
			g.proc, g.ours = nil, false
			g.lastErr = ""
			g.exe = ""
			log.Printf("[gw] 接到已有的 magpie 控制面 127.0.0.1:%d", p)
			go g.applyLanguage()
			return nil
		}
	}
	// 2) 自己拉一个。端口被别的程序占着就换下一个 —— 绝不能停别人的进程。
	exe := findMagpieExe()
	if exe == "" {
		return gwErr(g, uimsg.New("gw.exeMissing", "没有找到 magpie 可执行文件（先安装/打开一次 magpie）"))
	}
	var lastStart error
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		cmd := exec.Command(exe, "web", "--no-open", "--addr", fmt.Sprintf("127.0.0.1:%d", p))
		cmd.Env = append(os.Environ(), "MAGPIE_WEB_KEY="+key)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			lastStart = uimsg.Wrap(err, "gw.startFailed", "控制面启动失败："+err.Error(),
				map[string]string{"err": err.Error()})
			continue
		}
		// 等它就绪。启动日志里带 key，**只在失败时**把 key 抹掉再取尾部。
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if gwPing(p, key) {
				g.port, g.key = p, key
				g.client = gwClient()
				g.proc, g.ours = cmd.Process, true
				g.exe, g.lastErr = exe, ""
				log.Printf("[gw] 已启动 magpie 控制面 127.0.0.1:%d（pid=%d，只由 Perch 使用）", p, cmd.Process.Pid)
				go g.applyLanguage()
				return nil
			}
			if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		msg := strings.ReplaceAll(out.String(), key, "***")
		if i := strings.LastIndex(msg, "\n"); i > 0 && len(msg) > 400 {
			msg = msg[len(msg)-400:]
		}
		detail := strings.TrimSpace(msg)
		lastStart = uimsg.NewParams("gw.startFailedDetail",
			fmt.Sprintf("magpie web 没能在 127.0.0.1:%d 起来：%s", p, detail),
			map[string]string{"port": strconv.Itoa(p), "err": detail})
	}
	uiErr := error(uimsg.New("gw.startFailed", "控制面启动失败"))
	if lastStart != nil {
		uiErr = lastStart
	}
	return gwErr(g, uiErr)
}

// gwErr 记下最后一次连接失败并把它交给调用方（日志与网关页读同一句）。
func gwErr(g *Gateway, err error) error {
	g.lastErr = err.Error()
	return err
}

// findMagpieExe 找 magpie 本体：先问正在跑的那个进程（最可靠 —— 用户点开的就是它），
// 再看常见安装位置，最后看 PATH。
func findMagpieExe() string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ps := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command",
		`$p=Get-CimInstance Win32_Process -Filter "Name LIKE 'magpie%'" -ErrorAction SilentlyContinue | `+
			`Where-Object { $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath; `+
			`if($p){$p}`)
	ps.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, err := ps.Output(); err == nil {
		if p := strings.TrimSpace(string(out)); p != "" {
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return p
			}
		}
	}
	home, _ := os.UserHomeDir()
	local := os.Getenv("LOCALAPPDATA")
	var cands []string
	if local != "" {
		// Perch 自己装的（见 agentcatalog 的 magpie 配方）优先：它是最可控的一份，
		// 不会被 Downloads 里残留的旧版本抢走。
		cands = append(cands, filepath.Join(local, "Perch", "magpie", "magpie.exe"))
	}
	for _, n := range []string{"magpie.exe", "magpie-windows-amd64.exe"} {
		cands = append(cands,
			filepath.Join(home, "Downloads", n),
			filepath.Join(home, ".local", "bin", n),
			filepath.Join(home, ".local", n),
		)
		if local != "" {
			cands = append(cands,
				filepath.Join(local, "Programs", "magpie", n),
				filepath.Join(local, "magpie", n),
			)
			for _, glob := range []string{filepath.Join(local, "Programs", "magpie*", n), filepath.Join(local, "magpie*", n)} {
				if m, _ := filepath.Glob(glob); len(m) > 0 {
					cands = append(cands, m...)
				}
			}
		}
	}
	for _, p := range cands {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	for _, n := range []string{"magpie", "magpie.exe", "magpie-windows-amd64.exe"} {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
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
	g.lastErr = ""
	port := g.port
	g.mu.Unlock()
	if ours && proc != nil {
		_ = proc.Kill()
		_, _ = proc.Wait()
		log.Printf("[gw] 已停止 Perch 拉起的控制面（端口 %d）；magpie 桌面程序与网关不受影响", port)
	} else {
		log.Printf("[gw] 已断开控制面（%d 是外部进程，保持运行）", port)
	}
	g.emit(map[string]any{"type": "gw", "gw": map[string]any{"connected": false, "at": nowISO(), "external": true}})
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
		return nil, uimsg.NewParams("gw.badAPIPath", fmt.Sprintf("不允许的 magpie API 路径：%s", path),
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
	// 写操作（插件安装）要等很久：换一个不带短超时的 client，但连接仍复用。
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
		msg := strings.TrimSpace(string(data))
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return nil, uimsg.NewParams("gw.httpError",
			fmt.Sprintf("magpie 回答 HTTP %d：%s", res.StatusCode, msg),
			map[string]string{"status": strconv.Itoa(res.StatusCode), "body": msg})
	}
	return data, nil
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

/* Refresh 只确认「控制面还在、端口是多少」。供应商/路由/用量/插件的数据
 * 全部由内嵌的 magpie 页面自己取（ui.go），Perch 不再抄一份到内存里。 */
func (g *Gateway) Refresh() {
	port, key, client, ours := g.connState()
	if client == nil || !gwPing(port, key) {
		g.pushGW(map[string]any{"connected": false, "at": nowISO()})
		return
	}
	g.mu.Lock()
	exe := g.exe
	g.mu.Unlock()
	g.pushGW(map[string]any{
		"connected": true,
		"port":      port,
		"ours":      ours,
		"exe":       exe,
		"at":        nowISO(),
	})
}

// Probe 是启动时的被动探测：只接已经存在的控制面，绝不拉起进程。
// 隔离模式下启动时不碰任何外部控制面；引擎由用户点开网关时才拉起。
func (g *Gateway) Probe() {
	if g.Isolated() {
		return
	}
	key := g.loadKey()
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		if gwPing(p, key) {
			g.mu.Lock()
			g.port, g.key = p, key
			g.client = gwClient()
			g.proc, g.ours, g.exe = nil, false, ""
			g.mu.Unlock()
			log.Printf("[gw] 启动时接到已有的控制面 127.0.0.1:%d", p)
			g.Refresh()
			return
		}
	}
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}
