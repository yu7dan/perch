package main

// magpie 控制面适配器。
//
// 用户 2026-10-17 的要求：「供应商、路由、用量、插件要去使用 magpie 的原生体验」，
// 同时「能够在这个产品里进行修改和配置」，但「不希望把它和产品绑死」。
//
// 做法：Perch 不重写 magpie 的配置层，也不把 magpie 的页面 iframe 进来。
// 它在需要时拉起一个**独立的** `magpie web` 进程（127.0.0.1:3439），把同一份
// 配置的 /api/* 读出来、按 Perch 的页面画；写操作也走同一组 API。magpie 的
// 桌面程序、网关、配置文件都不受 Perch 生命周期影响 —— 控制面进程可以被
// 单独停掉，桌面 magpie 照常服务 agent。
//
// 安全边界：
//  1. MAGPIE_WEB_KEY 由 Perch 生成，只存在内存和 %APPDATA%\Perch\magpie-web.key
//     （0600）；**不进日志、不进渲染进程**。渲染进程只发 magpie 的 API 路径/载荷。
//  2. /api/ 路径白名单 + GET/POST 白名单；不允许 /_magpie、不允许带 ?k= 的请求。
//  3. 供应商 key 只在用户点「保存」时从 ctl 消息里过一次，随即交给 magpie；
//     不缓存、不打印、不回显（magpie 自己回的是 masked）。

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
)

const (
	gwFirstPort  = 3439
	gwPortTries  = 4
	gwKeyFile    = "magpie-web.key"
	gwHTTPWait   = 20 * time.Second
	gwActionWait = 8 * time.Minute // 首个插件要下载 Bun + npm 包
)

type gwServer struct {
	mu      sync.Mutex
	port    int
	key     string
	client  *http.Client
	proc    *os.Process // 只存 Process：更新会 re-exec 成另一个 PID，句柄要能换
	ours    bool
	exe     string
	lastErr string
}

var gwConn gwServer

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

// gwUsedBefore 只看 key 文件在不在：存在 = 这台机器上用过网关（Perch 起过控制面）。
// 不能用 gwLoadKey 判断 —— 它没有时会新发一枚并落盘，把标记本身造出来。
func gwUsedBefore() bool {
	p := gwKeyPath()
	if p == "" {
		return false
	}
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// gwLoadKey 取上一次的 key（重启 Perch 后还能接上同一个控制面），没有就新发一枚。
func gwLoadKey() string {
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

// gwEnsure 接上或拉起控制面。只由用户点「连接」或启动时的被动探测调用。
func gwEnsure() error {
	gwConn.mu.Lock()
	defer gwConn.mu.Unlock()

	if gwConn.client != nil && gwPing(gwConn.port, gwConn.key) {
		return nil
	}

	key := gwConn.key
	if key == "" {
		key = gwLoadKey()
	}
	// 1) 已经有一个用同一枚 key 跑在候选端口上的控制面：直接接。
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		if gwPing(p, key) {
			gwConn.port, gwConn.key = p, key
			gwConn.client = gwClient()
			gwConn.proc, gwConn.ours = nil, false
			gwConn.lastErr = ""
			gwConn.exe = ""
			log.Printf("[gw] 接到已有的 magpie 控制面 127.0.0.1:%d", p)
			return nil
		}
	}
	// 2) 自己拉一个。端口被别的程序占着就换下一个 —— 绝不能停别人的进程。
	exe := findMagpieExe()
	if exe == "" {
		gwConn.lastErr = "没有找到 magpie 可执行文件（先安装/打开一次 magpie）"
		return errors.New(gwConn.lastErr)
	}
	var lastStart error
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		cmd := exec.Command(exe, "web", "--no-open", "--addr", fmt.Sprintf("127.0.0.1:%d", p))
		cmd.Env = append(os.Environ(), "MAGPIE_WEB_KEY="+key)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		var out bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			lastStart = err
			continue
		}
		// 等它就绪。启动日志里带 key，**只在失败时**把 key 抹掉再取尾部。
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if gwPing(p, key) {
				gwConn.port, gwConn.key = p, key
				gwConn.client = gwClient()
				gwConn.proc, gwConn.ours = cmd.Process, true
				gwConn.exe, gwConn.lastErr = exe, ""
				log.Printf("[gw] 已启动 magpie 控制面 127.0.0.1:%d（pid=%d，只由 Perch 使用）", p, cmd.Process.Pid)
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
		lastStart = fmt.Errorf("magpie web 没能在 127.0.0.1:%d 起来：%s", p, strings.TrimSpace(msg))
	}
	gwConn.lastErr = "控制面启动失败"
	if lastStart != nil {
		gwConn.lastErr = lastStart.Error()
	}
	return errors.New(gwConn.lastErr)
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
		// Perch 自己装的（见 install.go 的 magpie 配方）优先：它是最可控的一份，
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
			for _, g := range []string{filepath.Join(local, "Programs", "magpie*", n), filepath.Join(local, "magpie*", n)} {
				if m, _ := filepath.Glob(g); len(m) > 0 {
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

// gwStop 只关 Perch 自己拉起来的那个控制面；接上的外部控制面只断开连接。
// 没接控制面时直接返回：关窗路径也会调它，不要凭空打一行"已断开 0"。
func gwStop() {
	gwConn.mu.Lock()
	if gwConn.client == nil && gwConn.proc == nil {
		gwConn.mu.Unlock()
		return
	}
	proc, ours := gwConn.proc, gwConn.ours
	gwConn.client, gwConn.proc, gwConn.ours = nil, nil, false
	gwConn.lastErr = ""
	port := gwConn.port
	gwConn.mu.Unlock()
	if ours && proc != nil {
		_ = proc.Kill()
		_, _ = proc.Wait()
		log.Printf("[gw] 已停止 Perch 拉起的控制面（端口 %d）；magpie 桌面程序与网关不受影响", port)
	} else {
		log.Printf("[gw] 已断开控制面（%d 是外部进程，保持运行）", port)
	}
	gwPush(map[string]any{"connected": false, "at": nowISO(), "external": true})
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

func gwConnState() (int, string, *http.Client, bool) {
	gwConn.mu.Lock()
	defer gwConn.mu.Unlock()
	return gwConn.port, gwConn.key, gwConn.client, gwConn.ours
}

// gwAPI 是唯一一条通往 magpie 的 HTTP 路。路径白名单在这里，不在前端。
func gwAPI(method, path string, body any) ([]byte, error) {
	port, key, client, _ := gwConnState()
	if client == nil {
		return nil, errors.New("控制面未连接")
	}
	if !strings.HasPrefix(path, "/api/") || strings.Contains(path, "..") || strings.Contains(path, "k=") {
		return nil, fmt.Errorf("不允许的 magpie API 路径：%s", path)
	}
	if method != "GET" && method != "POST" {
		return nil, errors.New("只允许 GET/POST")
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), rd)
	if err != nil {
		return nil, err
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
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(data))
		if len(msg) > 400 {
			msg = msg[:400]
		}
		return nil, fmt.Errorf("magpie 回答 HTTP %d：%s", res.StatusCode, msg)
	}
	return data, nil
}

func gwGetJSON(path string, v any) error {
	b, err := gwAPI("GET", path, nil)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func nowISO() string { return time.Now().Format(time.RFC3339) }

func gwPush(gw map[string]any) {
	pushJSON(map[string]any{"type": "gw", "gw": gw})
}

func gwPushErr(err error) {
	gwPush(map[string]any{"connected": false, "at": nowISO(), "err": err.Error()})
}

// gwConnect 由用户点「连接」触发：接上（必要时拉起）控制面，再推整份原生读数。
func gwConnect() {
	if err := gwEnsure(); err != nil {
		log.Printf("[gw] 连接失败：%v", err)
		gwPushErr(err)
		return
	}
	gwRefresh()
}

/* gwRefresh 只确认「控制面还在、端口是多少」。供应商/路由/用量/插件的数据
 * 全部由内嵌的 magpie 页面自己取（gwui.go），Perch 不再抄一份到内存里。 */
func gwRefresh() {
	port, key, client, ours := gwConnState()
	if client == nil || !gwPing(port, key) {
		gwPush(map[string]any{"connected": false, "at": nowISO()})
		return
	}
	gwConn.mu.Lock()
	exe := gwConn.exe
	gwConn.mu.Unlock()
	gwPush(map[string]any{
		"connected": true,
		"port":      port,
		"ours":      ours,
		"exe":       exe,
		"at":        nowISO(),
	})
}

// gwProbe 是启动时的被动探测：只接已经存在的控制面，绝不拉起进程。
func gwProbe() {
	key := gwLoadKey()
	for p := gwFirstPort; p < gwFirstPort+gwPortTries; p++ {
		if gwPing(p, key) {
			gwConn.mu.Lock()
			gwConn.port, gwConn.key = p, key
			gwConn.client = gwClient()
			gwConn.proc, gwConn.ours, gwConn.exe = nil, false, ""
			gwConn.mu.Unlock()
			log.Printf("[gw] 启动时接到已有的控制面 127.0.0.1:%d", p)
			gwRefresh()
			return
		}
	}
}

func urlQueryEscape(s string) string { return url.QueryEscape(s) }

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}
