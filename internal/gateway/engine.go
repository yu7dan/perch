package gateway

// Managed gateway engine (magpie headless CLI), not a Perch plugin.
//
// The engine runs as a private child process with its own data directory. Perch
// owns the UI and talks to the engine's loopback API; the engine's web page is
// never loaded, proxied or exposed. The gateway URL written into agent configs
// is stable across restarts because it is persisted in <data>/gateway.port.

import (
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/uimsg"
)

const (
	engineDirName  = "gateway"
	engineExeName  = "magpie.exe"
	engineDataName = "data"
	enginePortName = "gateway.port"
)

func engineRoot() (string, error) {
	d, err := appdir.LocalPerchDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, engineDirName), nil
}

// engineExePath is the only engine Perch will ever start. It deliberately does
// not scan PATH or the user's desktop magpie: the product owns one pinned,
// isolated engine.
func engineExePath() string {
	root, err := engineRoot()
	if err != nil {
		return ""
	}
	return filepath.Join(root, engineExeName)
}

func engineDataDir() string {
	root, err := engineRoot()
	if err != nil {
		return ""
	}
	return filepath.Join(root, engineDataName)
}

// Ensure starts the managed engine if it is not already answering. It never
// probes or launches the user's desktop magpie.
func (g *Gateway) Ensure() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.client != nil && gwPing(g.port, g.key) {
		return nil
	}
	if g.proc != nil {
		_ = g.proc.Kill()
		_, _ = g.proc.Wait()
		g.proc = nil
	}
	g.client = nil
	return g.startManagedEngine()
}

// StartEngine is the app-start path: start the engine and publish its status.
func (g *Gateway) StartEngine() {
	if err := g.Ensure(); err != nil {
		log.Printf("[gw] 引擎启动失败：%v", err)
		g.pushGW(uimsg.Fields(map[string]any{"connected": false, "at": nowISO()}, err))
		return
	}
	g.Refresh()
}

func freeLoopbackPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func loopbackPortFree(port int) bool {
	if port < 1024 || port > 65535 {
		return false
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func readEngineGatewayPort(dataDir string) int {
	b, err := os.ReadFile(filepath.Join(dataDir, enginePortName))
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if n < 1024 || n > 65535 {
		return 0
	}
	return n
}

// chooseEngineGatewayPort keeps the agent-facing URL stable. Only a port that
// is actually occupied is replaced; the previous one is persisted first.
func chooseEngineGatewayPort(dataDir string) (int, error) {
	if p := readEngineGatewayPort(dataDir); p != 0 && loopbackPortFree(p) {
		return p, nil
	}
	p, err := freeLoopbackPort()
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(dataDir, enginePortName),
		[]byte(fmt.Sprintf("%d\n", p)), 0o600); err != nil {
		return 0, err
	}
	return p, nil
}

// startManagedEngine starts the pinned headless engine and waits for its
// control plane. Caller holds g.mu.
func (g *Gateway) startManagedEngine() error {
	exe := engineExePath()
	if exe == "" {
		return uimsg.New("gw.engineMissing", "网关引擎没有安装")
	}
	if fi, err := os.Stat(exe); err != nil || fi.IsDir() {
		return uimsg.New("gw.engineMissing", "网关引擎没有安装")
	}
	// The engine has its own updater. v1 ships one pinned build and Perch does
	// not verify downloaded binaries, so updates stay off and any leftover
	// `.new` from an older run is discarded instead of being applied silently.
	// (Measured 2026-10-22: without this, every start downloaded a new engine.)
	_ = os.Remove(filepath.Join(filepath.Dir(exe), engineExeName+".new"))

	dataDir := engineDataDir()
	if dataDir == "" {
		return uimsg.New("gw.engineDataMissing", "拿不到网关数据目录")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return uimsg.Wrap(err, "gw.engineDataFailed", "创建网关数据目录失败："+err.Error(),
			map[string]string{"err": err.Error()})
	}
	ctl, err := freeLoopbackPort()
	if err != nil {
		return err
	}
	gwPort, err := chooseEngineGatewayPort(dataDir)
	if err != nil {
		return err
	}
	for gwPort == ctl {
		if ctl, err = freeLoopbackPort(); err != nil {
			return err
		}
	}
	key := g.key
	if key == "" {
		key = g.loadKey()
	}

	cmd := exec.Command(exe, "serve", fmt.Sprintf("--web=127.0.0.1:%d", ctl))
	cmd.Dir = filepath.Dir(exe)
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("MAGPIE_ADDR=127.0.0.1:%d", gwPort),
		"MAGPIE_WEB_KEY="+key,
		"XDG_CONFIG_HOME="+dataDir,
		"XDG_CACHE_HOME="+filepath.Join(dataDir, "cache"),
		"MAGPIE_NO_ACCOUNTS=1",
		"MAGPIE_PLUGIN_MARKET=off",
		"MAGPIE_NO_STATS=1",
		"MAGPIE_UPDATE_FEED=off",
		"DO_NOT_TRACK=1",
	)
	// The engine's stdout/stderr can contain a control-plane link with the key.
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if err := cmd.Start(); err != nil {
		return uimsg.Wrap(err, "gw.engineStartFailed", "网关引擎启动失败："+err.Error(),
			map[string]string{"err": err.Error()})
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if gwPing(ctl, key) {
			g.port, g.key = ctl, key
			g.client = gwClient()
			g.proc, g.ours = cmd.Process, true
			g.exe = exe
			g.dataDir = dataDir
			// XDG_CONFIG_HOME 就是 dataDir；引擎把 last-version / providers.json /
			// plugins.yml 直接写在这里，不是再套一层 magpie\。
			g.configDir = dataDir
			g.gatewayURL = fmt.Sprintf("http://127.0.0.1:%d", gwPort)
			g.lastErr = ""
			log.Printf("[gw] 已启动内置网关引擎 %s（控制面 %d，网关 %s，pid=%d）",
				filepath.Base(exe), ctl, g.gatewayURL, cmd.Process.Pid)
			return nil
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	return uimsg.NewParams("gw.engineStartTimeout",
		fmt.Sprintf("网关引擎没有在 127.0.0.1:%d 就绪", ctl),
		map[string]string{"port": strconv.Itoa(ctl)})
}
