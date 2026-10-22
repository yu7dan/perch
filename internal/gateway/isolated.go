package gateway

// Perch 自己的网关引擎（2026-10-22）。
//
// 桌面 magpie 的那一套不能再用了：它把 agent 的全局配置当成自己的，会在
// 启动/接入时写 ~/.claude、~/.codex、~/.dsh；用户桌面端和 CLI 共用一份
// 配置，CLI 一接网关就把桌面端的模型/供应商覆盖掉。
//
// 这里的目标是**隔离**：
//   - 用 Perch 自己安装的 magpie CLI（%LOCALAPPDATA%\Perch\magpie\magpie.exe）
//     的 portable 模式：配置、供应商、用量都落在 exe 旁边的 data\ 里；
//   - 引擎进程把 agent 的配置目录（APPDATA/LOCALAPPDATA/XDG_*/
//     CLAUDE_CONFIG_DIR/CODEX_HOME/DSH_HOME）全部指向 Perch 自己的沙盒，
//     这样 magpie 的 agent 自动同步即使写文件，也只写进沙盒；
//   - USERPROFILE/HOME **不换**：WorkBuddy 插件要从
//     %USERPROFILE%\AppData\Local\CodeBuddyExtension 读桌面端自己的登录态；
//     换掉它，插件会报“WorkBuddy desktop isn't signed in”，反代就不可用。
//     这只读桌面登录态，不写；Claude/Codex 等会被换配置目录的 agent 仍隔离。
//   - 网关端口固定为 Perch 自己的端口（默认 64730 起找空闲），永远不是 3425。
//
// 桌面 magpie、桌面 Claude/Codex、当前正在用的网关都不受影响。agent 的
// 会话级注入在 Phase 2 另做，这里只负责引擎本身。

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/uimsg"
)

const (
	isolatedGateFirstPort = 64730
	isolatedGateTries     = 10
	isolatedWebFirstPort  = 3443 // 避开外部 magpie web 常用的 3439
	isolatedWebTries      = 4
	isolatedEngineSubdir  = "gateway"
)

// isolatedGatewayPort 在 SetIsolated 时定下来。gatewayURL 是包级变量
// （wire.go），watcher 的 HTTP 腿直接读它；SetIsolated 必须在 StartWatcher
// 之前调用。
var isolatedGatewayPort int

func localAppData() string {
	if v := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); v != "" {
		return v
	}
	if v, err := os.UserCacheDir(); err == nil {
		return v
	}
	return ""
}

// PerchEngineExe 是 Perch 安装的 magpie CLI。只认 Perch 自己的目录：
// 绝不回退到 Downloads/桌面 magpie，否则“隔离”就是一句空话。
func PerchEngineExe() string {
	local := localAppData()
	if local == "" {
		return ""
	}
	return filepath.Join(local, "Perch", "magpie", "magpie.exe")
}

// PerchEngineDataDir 是 portable 数据目录（exe 旁边那层 data）。
func PerchEngineDataDir() string {
	exe := PerchEngineExe()
	if exe == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(exe), "data")
}

// PerchEngineHomeDir 是引擎进程的“用户目录”。agent 的自动同步只能写到这里。
func PerchEngineHomeDir() string {
	local := localAppData()
	if local == "" {
		return ""
	}
	return filepath.Join(local, "Perch", isolatedEngineSubdir, "home")
}

func engineInstalled() bool {
	exe := PerchEngineExe()
	if exe == "" {
		return false
	}
	fi, err := os.Stat(exe)
	return err == nil && !fi.IsDir()
}

// IsolatedGatewayAddr 是 gateway 子进程要监听的地址。
func IsolatedGatewayAddr() string {
	p := isolatedGatewayPort
	if p == 0 {
		p = isolatedGateFirstPort
	}
	return fmt.Sprintf("127.0.0.1:%d", p)
}

// IsolatedGatewayURL 给 agent 注入和前端状态用。
func IsolatedGatewayURL() string {
	return "http://" + IsolatedGatewayAddr()
}

// pickIsolatedGatewayPort 找一个 Perch 自己的空闲端口。测试可以用
// PERCH_ISOLATED_PORT 钉住一个端口。
func pickIsolatedGatewayPort() int {
	if v := strings.TrimSpace(os.Getenv("PERCH_ISOLATED_PORT")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	for p := isolatedGateFirstPort; p < isolatedGateFirstPort+isolatedGateTries; p++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			_ = ln.Close()
			return p
		}
	}
	return isolatedGateFirstPort
}

// SetIsolated 打开/关闭隔离引擎模式。调用点必须在 StartWatcher/Probe 之前。
func (g *Gateway) SetIsolated(v bool) {
	g.mu.Lock()
	g.isolated = v
	if v && g.isoPort == 0 {
		g.isoPort = pickIsolatedGatewayPort()
	}
	port := g.isoPort
	g.mu.Unlock()
	if v {
		isolatedGatewayPort = port
		gatewayURL = fmt.Sprintf("http://127.0.0.1:%d", port)
		log.Printf("[gw] 隔离引擎模式：gateway=%s data=%s", IsolatedGatewayAddr(), PerchEngineDataDir())
	}
}

// Isolated 是给 command/handlers 判断模式用的只读快照。
func (g *Gateway) Isolated() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.isolated
}

// EngineDataDir 返回当前模式下本机配置目录；非隔离模式返回空。
func (g *Gateway) engineDataDir() string {
	if !g.Isolated() {
		return ""
	}
	return PerchEngineDataDir()
}

// engineEnv 构造引擎子进程的环境：先继承，再把 agent 的配置目录换到沙盒。
// 不设置 PATH，agent 二进制仍然能被探测到；但它们写配置时只会写沙盒。
// USERPROFILE/HOME 保持真实值，只为了让 WorkBuddy 插件读到桌面端登录态；
// 它的读取是只读的，Claude/Codex 的目录已由下面的显式变量隔开。
func engineEnv(key string) ([]string, error) {
	home := PerchEngineHomeDir()
	if home == "" {
		return nil, uimsg.New("gw.engineHomeMissing", "找不到网关引擎的隔离目录")
	}
	appdata := filepath.Join(home, "appdata")
	localappdata := filepath.Join(home, "localappdata")
	dirs := []string{
		home, appdata, localappdata,
		filepath.Join(home, ".config"),
		filepath.Join(home, ".cache"),
		filepath.Join(home, ".local", "share"),
		filepath.Join(home, ".claude"),
		filepath.Join(home, ".codex"),
		filepath.Join(home, ".dsh"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0700); err != nil {
			return nil, uimsg.Wrap(err, "gw.engineHomeFailed", "建不了网关引擎隔离目录："+err.Error(),
				map[string]string{"err": err.Error()})
		}
	}
	m := make(map[string]string, len(os.Environ())+12)
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	// 不覆盖 USERPROFILE/HOME（见上面的 WorkBuddy 说明）。只把 agent 自己
	// 的配置目录和 Windows 的 AppData/XDG 目录搬到沙盒。
	m["APPDATA"] = appdata
	m["LOCALAPPDATA"] = localappdata
	m["XDG_CONFIG_HOME"] = filepath.Join(home, ".config")
	m["XDG_CACHE_HOME"] = filepath.Join(home, ".cache")
	m["XDG_DATA_HOME"] = filepath.Join(home, ".local", "share")
	m["CLAUDE_CONFIG_DIR"] = filepath.Join(home, ".claude")
	m["CODEX_HOME"] = filepath.Join(home, ".codex")
	m["DSH_HOME"] = filepath.Join(home, ".dsh")
	// 不能设 1：magpie 的账号发现一旦关闭，plugin-auth.json 也会被跳过，
	// WorkBuddy 插件供应商就不会出现在 /v1/models。agent 的目录已隔开，
	// 这里显式写 0，避免父进程环境里带进来的 1 生效。
	m["MAGPIE_NO_ACCOUNTS"] = "0"
	m["MAGPIE_ADDR"] = IsolatedGatewayAddr()
	m["MAGPIE_WEB_KEY"] = key
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out, nil
}

// engineStartArgs 是隔离引擎的启动参数；单独列出来给测试。
func engineStartArgs(webPort int) []string {
	return []string{
		"web", "--no-open",
		"--addr", fmt.Sprintf("127.0.0.1:%d", webPort),
		"--gateway",
	}
}

// importProvidersFromDesktop 把桌面 magpie 的**供应商**只读复制一次到 Perch
// 引擎的 portable data。除了内置 providers.json，也带 WorkBuddy 这类插件供应商
// 需要的 plugin-providers.json / plugin-auth.json / plugins.json / plugins 目录。
//
// 目标已存在的文件一律不覆盖：用户后来在 Perch 里改的供应商不能被一次重启
// 覆盖。完成写一枚 .perch-imported 标记，之后不再重复检查。日志只打数量，
// 不碰 key/账号。
func importProvidersFromDesktop() (int, error) {
	targetDir := PerchEngineDataDir()
	if targetDir == "" {
		return 0, nil
	}
	marker := filepath.Join(targetDir, ".perch-imported")
	if fi, err := os.Stat(marker); err == nil && !fi.IsDir() {
		return 0, nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return 0, nil
	}
	srcDir := magpieConfigDir(home)
	if fi, err := os.Stat(srcDir); err != nil || !fi.IsDir() {
		return 0, nil
	}
	if err := os.MkdirAll(targetDir, 0700); err != nil {
		return 0, err
	}

	files := []string{
		"providers.json",
		"plugin-providers.json",
		"plugin-auth.json",
		"plugins.json",
		"plugins.yml",
		"plugin-icons.json",
		"migrations.json",
	}
	for _, name := range files {
		if err := copyFileIfMissing(filepath.Join(srcDir, name), filepath.Join(targetDir, name)); err != nil {
			return 0, err
		}
	}
	if err := copyDirIfMissing(filepath.Join(srcDir, "plugins"), filepath.Join(targetDir, "plugins")); err != nil {
		return 0, err
	}

	n := countJSONEntries(filepath.Join(targetDir, "providers.json"))
	np := countJSONEntries(filepath.Join(targetDir, "plugin-providers.json"))
	if n > 0 || np > 0 {
		log.Printf("[gw] 已从桌面 magpie 只读导入 %d 个供应商、%d 个插件供应商到 Perch 引擎（只此一次）", n, np)
	}
	if err := os.WriteFile(marker, []byte("imported\n"), 0600); err != nil {
		return n, err
	}
	return n, nil
}

func countJSONEntries(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var byID map[string]json.RawMessage
	if json.Unmarshal(b, &byID) == nil {
		return len(byID)
	}
	var rows []json.RawMessage
	if json.Unmarshal(b, &rows) == nil {
		return len(rows)
	}
	return 0
}

func copyFileIfMissing(src, dst string) error {
	if fi, err := os.Stat(dst); err == nil && !fi.IsDir() {
		return nil
	}
	b, err := os.ReadFile(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return err
	}
	return os.WriteFile(dst, b, 0600)
}

func copyDirIfMissing(src, dst string) error {
	if fi, err := os.Stat(dst); err == nil && fi.IsDir() {
		return nil
	}
	if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
		return nil
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil || strings.HasPrefix(rel, "..") {
			return err
		}
		out := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(out, 0700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(out), 0700); err != nil {
			return err
		}
		return os.WriteFile(out, b, 0600)
	})
}

// ensureIsolated 启动/接上 Perch 自己的引擎。和 Ensure 的外部发现逻辑完全分开：
// 不 ping 3425，不找 Downloads 里的 magpie，也不停任何外部进程。
func (g *Gateway) ensureIsolated() error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.client != nil && gwPing(g.port, g.key) {
		return nil
	}
	key := g.key
	if key == "" {
		key = g.loadKey()
	}
	if !engineInstalled() {
		return gwErr(g, uimsg.New("gw.exeMissing",
			"网关引擎没有安装：先在这一页下载安装"))
	}
	if n, err := importProvidersFromDesktop(); err != nil {
		log.Printf("[gw] 供应商导入失败（继续启动空引擎）：%v", err)
	} else if n > 0 {
		log.Printf("[gw] 导入完成：%d 个供应商", n)
	}
	env, err := engineEnv(key)
	if err != nil {
		return gwErr(g, err)
	}
	exe := PerchEngineExe()
	var lastStart error
	for p := isolatedWebFirstPort; p < isolatedWebFirstPort+isolatedWebTries; p++ {
		args := engineStartArgs(p)
		cmd := exec.Command(exe, args...)
		cmd.Env = env
		cmd.Dir = filepath.Dir(exe)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		var out strings.Builder
		cmd.Stdout, cmd.Stderr = &out, &out
		if err := cmd.Start(); err != nil {
			lastStart = uimsg.Wrap(err, "gw.startFailed", "网关引擎启动失败："+err.Error(),
				map[string]string{"err": err.Error()})
			continue
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			if gwPing(p, key) {
				g.port, g.key = p, key
				g.client = gwClient()
				g.proc, g.ours = cmd.Process, true
				g.exe, g.lastErr = exe, ""
				log.Printf("[gw] 已启动 Perch 网关引擎 127.0.0.1:%d（pid=%d，gateway=%s）",
					p, cmd.Process.Pid, IsolatedGatewayAddr())
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
		lastStart = uimsg.NewParams("gw.startFailedDetail",
			fmt.Sprintf("网关引擎没能在 127.0.0.1:%d 起来：%s", p, strings.TrimSpace(msg)),
			map[string]string{"port": strconv.Itoa(p), "err": strings.TrimSpace(msg)})
	}
	if lastStart == nil {
		lastStart = uimsg.New("gw.startFailed", "网关引擎启动失败")
	}
	return gwErr(g, lastStart)
}
