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
//   - 引擎进程的 USERPROFILE/HOME 也指向 Perch 自己的沙盒；magpie 的
//     Agent.Path（~/.gemini、~/.cursor、~/.pi 等）因此全部落在沙盒里。
//   - 沙盒启动前从桌面只读 seed 需要的 agent 配置：agy 的 settings、
//     WorkBuddy 桌面登录态等；之后 magpie 的通用 agent 接入只写沙盒。
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

// EngineHomeEnv 是引擎沙盒对应的“用户目录”环境。magpie 的 Agent.Path 和
// 大多数 CLI 都按 USERPROFILE/HOME 展开，所以由 Perch 直接启动的 agent
// （agy 等）必须带这组变量，才能和引擎读到同一份沙盒配置。
func EngineHomeEnv() map[string]string {
	home := PerchEngineHomeDir()
	if home == "" {
		return nil
	}
	return map[string]string{
		"USERPROFILE":      home,
		"HOME":             home,
		"APPDATA":          filepath.Join(home, "appdata"),
		"LOCALAPPDATA":     filepath.Join(home, "localappdata"),
		"XDG_CONFIG_HOME":  filepath.Join(home, ".config"),
		"XDG_CACHE_HOME":   filepath.Join(home, ".cache"),
		"XDG_DATA_HOME":    filepath.Join(home, ".local", "share"),
		"DSH_HOME":         filepath.Join(home, ".dsh"),
		"QODER_CONFIG_DIR": filepath.Join(home, ".qoder"),
	}
}

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

// desktopNodePath 返回真实用户环境里的 npm/node 目录，用来垫在引擎 PATH
// 前面。GUI 进程的 PATH 通常只有系统项，npm 装的 CLI 会因此“像没装”。
func desktopNodePath(realHome string) string {
	var dirs []string
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		for _, have := range dirs {
			if strings.EqualFold(have, p) {
				return
			}
		}
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			dirs = append(dirs, p)
		}
	}
	add(filepath.Join(realHome, "AppData", "Roaming", "npm"))
	add(filepath.Join(os.Getenv("ProgramFiles"), "nodejs"))
	add(filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "nodejs"))
	add(filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "node"))
	if node, err := exec.LookPath("node"); err == nil {
		add(filepath.Dir(node))
	}
	return strings.Join(dirs, ";")
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

// desktopBunPath 是桌面 magpie 已下载的 Bun（当前版本）。插件供应商的
// 插件宿主要在 Bun 上跑；Perch 引擎的数据目录里没有 Bun 时会去 GitHub
// 下载，在只走本地代理的网络里会卡到请求超时。直接借用桌面这份，不复制，
// 省下 ~90MB 磁盘，也跟着桌面 magpie 的升级走。"" 表示没有可用的。
func desktopBunPath(home string) string {
	root := filepath.Join(magpieCacheDir(home), "bun")
	b, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err != nil {
		return ""
	}
	var st struct {
		Current string `json:"current"`
	}
	if json.Unmarshal(b, &st) != nil {
		return ""
	}
	v := strings.TrimSpace(st.Current)
	if v == "" || strings.ContainsAny(v, `/\`) || strings.Contains(v, "..") {
		return ""
	}
	exe := filepath.Join(root, v, "magpie-bun.exe")
	if fi, err := os.Stat(exe); err != nil || fi.IsDir() {
		return ""
	}
	return exe
}

// engineEnv 构造引擎子进程的环境：先继承，再把整个用户目录和 agent 的
// 配置目录换到沙盒。不设置 PATH，agent 二进制仍然能被探测到；但它们读写
// 配置时只会碰沙盒。桌面端需要的登录态/配置由 seedEngineAgentConfigs 只读带入。
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
		filepath.Join(home, ".dsh-tui"),
		filepath.Join(home, ".gemini"),
		filepath.Join(home, ".pi"),
		filepath.Join(home, ".cursor"),
		filepath.Join(home, ".qoder"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0700); err != nil {
			return nil, uimsg.Wrap(err, "gw.engineHomeFailed", "建不了网关引擎隔离目录："+err.Error(),
				map[string]string{"err": err.Error()})
		}
	}
	seedEngineAgentConfigs(home)
	m := make(map[string]string, len(os.Environ())+12)
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	// USERPROFILE/HOME 也进沙盒：magpie 的 Agent.Path 全部按它展开，
	// 这样通用 agent 接入不会碰桌面配置。WorkBuddy 登录态和 agy 等
	// 需要的配置在 seedEngineAgentConfigs 里只读搬进来。
	m["USERPROFILE"] = home
	m["HOME"] = home
	m["APPDATA"] = appdata
	m["LOCALAPPDATA"] = localappdata
	m["XDG_CONFIG_HOME"] = filepath.Join(home, ".config")
	m["XDG_CACHE_HOME"] = filepath.Join(home, ".cache")
	m["XDG_DATA_HOME"] = filepath.Join(home, ".local", "share")
	m["CLAUDE_CONFIG_DIR"] = filepath.Join(home, ".claude")
	m["CODEX_HOME"] = filepath.Join(home, ".codex")
	m["DSH_HOME"] = filepath.Join(home, ".dsh")
	m["QODER_CONFIG_DIR"] = filepath.Join(home, ".qoder")
	// 不能设 1：magpie 的账号发现一旦关闭，plugin-auth.json 也会被跳过，
	// WorkBuddy 插件供应商就不会出现在 /v1/models。agent 的目录已隔开，
	// 这里显式写 0，避免父进程环境里带进来的 1 生效。
	m["MAGPIE_NO_ACCOUNTS"] = "0"
	m["MAGPIE_ADDR"] = IsolatedGatewayAddr()
	m["MAGPIE_WEB_KEY"] = key
	// 插件宿主用桌面 magpie 已下载的 Bun，避免引擎自己去 GitHub 下载。
	// 用户显式设了 MAGPIE_BUN 就尊重用户的。
	if strings.TrimSpace(m["MAGPIE_BUN"]) == "" {
		if realHome, err := os.UserHomeDir(); err == nil && realHome != "" {
			if bun := desktopBunPath(realHome); bun != "" {
				m["MAGPIE_BUN"] = bun
			}
		}
	}
	// npm 全局安装的 CLI（Copilot 等）在 %APPDATA%\npm，GUI 进程的 PATH
	// 常常没有它；magpie 的 detect 和 dsh-tui 都按 PATH 找。
	// Windows 的环境变量名大小写不敏感，os.Environ 可能给的是 "Path"；
	// 先合并成唯一的 "PATH"，否则我们新加的那条会被旧值盖掉。
	var curPath string
	for k, v := range m {
		if strings.EqualFold(k, "PATH") {
			curPath = v
			if k != "PATH" {
				delete(m, k)
			}
		}
	}
	if realHome, err := os.UserHomeDir(); err == nil && realHome != "" {
		if p := desktopNodePath(realHome); p != "" {
			curPath = p + ";" + curPath
		}
	}
	if curPath != "" {
		m["PATH"] = curPath
	}
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out, nil
}

// seedEngineAgentConfigs 把桌面端只读的 agent 配置搬进 Perch home。
// magpie 的 Agent.Path 全部按 USERPROFILE 展开，所以 seed 之后它的通用
// agent 接入只会写 Perch home。只复制/更新需要的这些，不动真实文件。
func seedEngineAgentConfigs(home string) {
	realHome, err := os.UserHomeDir()
	if err != nil || realHome == "" || samePath(realHome, home) {
		return
	}
	// WorkBuddy 插件从桌面 app 的登录文件读登录态。
	authSrc := filepath.Join(realHome, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth")
	authDst := filepath.Join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth")
	for _, name := range []string{"workbuddy-desktop.info", "workbuddy-desktop-ai.info"} {
		if copyFileIfNewer(filepath.Join(authSrc, name), filepath.Join(authDst, name)) {
			log.Printf("[gw] 已从桌面 seed WorkBuddy 登录态 %s", name)
		}
	}
	// Antigravity CLI 的 settings（custom models / trusted workspaces）。
	if err := copyDirIfMissing(
		filepath.Join(realHome, ".gemini", "antigravity-cli"),
		filepath.Join(home, ".gemini", "antigravity-cli"),
	); err == nil {
		log.Printf("[gw] 已 seed Antigravity CLI 配置")
	}
	// Pi 的 agent 目录也先带上；网关设置仍由 magpie 写进 Perch home。
	_ = copyDirIfMissing(
		filepath.Join(realHome, ".pi", "agent"),
		filepath.Join(home, ".pi", "agent"),
	)
	// DSH 的 profile（含 TUI 和 hook 桥）和登录态：引擎会往同一个 home
	// 写自己的 provider/模型；Perch 的 dsh-tui 也按这个 DSH_HOME 启动。
	// profile 里的 node_modules 比较大，只在沙盒还没有时复制一次。
	for _, name := range []string{
		"config.yaml", "cordis.patch.yml", "settings.yaml",
		".env", ".credentials.yaml", ".anonymous-user-id",
	} {
		_ = copyFileIfMissing(
			filepath.Join(realHome, ".dsh", name),
			filepath.Join(home, ".dsh", name),
		)
	}
	_ = copyDirIfMissing(
		filepath.Join(realHome, ".dsh", "profiles"),
		filepath.Join(home, ".dsh", "profiles"),
	)
	// pnpm 的 .modules.yaml 里记着虚拟商店的绝对路径。整目录复制到沙盒后
	// 它仍指向真实 ~/.dsh，`dsh plugin add` 会拒绝运行；只改沙盒这一份的
	// virtualStoreDir，真实目录不动。
	fixSandboxPnpmModules(home)
	// dsh-tui 的首次引导只看 ~/.dsh-tui/onboarding.json；沙盒里没有这份
	// 记录时会在第一次开格弹 4 步向导。网关已经由 magpie 配好，这里只让
	// 沙盒里的 TUI 跳过引导，不动真实目录。
	onboarding := filepath.Join(home, ".dsh-tui", "onboarding.json")
	realOnboarding := filepath.Join(realHome, ".dsh-tui", "onboarding.json")
	if _, err := os.Stat(onboarding); os.IsNotExist(err) {
		if b, rerr := os.ReadFile(realOnboarding); rerr == nil {
			_ = os.MkdirAll(filepath.Dir(onboarding), 0700)
			_ = os.WriteFile(onboarding, b, 0600)
		} else {
			_ = os.MkdirAll(filepath.Dir(onboarding), 0700)
			_ = os.WriteFile(onboarding, []byte("{\"completed\":true,\"version\":1}\n"), 0600)
		}
	}
	seedGenericAgentConfigs(realHome, home)
}

// seedGenericAgentConfigs 把 magpie 能接线的通用 CLI 的登录态/配置带进
// 沙盒。只在这些 agent 已被引擎接网关后，EngineDef 才会把启动目录换到
// 沙盒；seed 是为了那时它们仍认得自己的账号和本地设置。
// 目标已存在的文件/目录一律不覆盖，用户后来在 Perch 里的修改不会被重启冲掉。
func seedGenericAgentConfigs(realHome, home string) {
	// 这些目录里是各自的 auth/插件/本地设置，通常很小；已有就完全不碰。
	// 先整目录再补单文件：先补文件会提前建出父目录，让整目录复制误以为
	// 目标已经存在而跳过其余文件。
	dirs := []string{
		".copilot",
		".qoder",
	}
	for _, rel := range dirs {
		_ = copyDirIfMissing(
			filepath.Join(realHome, filepath.FromSlash(rel)),
			filepath.Join(home, filepath.FromSlash(rel)),
		)
	}
	files := []string{
		".copilot/settings.json",
		".copilot/config.json",
		".qoder/settings.json",
	}
	for _, rel := range files {
		_ = copyFileIfMissing(
			filepath.Join(realHome, filepath.FromSlash(rel)),
			filepath.Join(home, filepath.FromSlash(rel)),
		)
	}
}

// fixSandboxPnpmModules 把沙盒 DSH profile 里 pnpm 记录的 virtualStoreDir
// 指回沙盒自己。node_modules 是 hoisted 的真实文件，只有这个绝对路径会让
// pnpm 误以为依赖来自真实的 ~/.dsh。
func fixSandboxPnpmModules(home string) {
	p := filepath.Join(home, ".dsh", "profiles", "dsh-tui", "node_modules", ".modules.yaml")
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return
	}
	want := filepath.Join(filepath.Dir(p), ".pnpm")
	if cur, _ := m["virtualStoreDir"].(string); samePath(cur, want) {
		return
	}
	m["virtualStoreDir"] = want
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(p, append(out, '\n'), 0600)
}

func samePath(a, b string) bool {
	aa, errA := filepath.Abs(a)
	bb, errB := filepath.Abs(b)
	return errA == nil && errB == nil && strings.EqualFold(aa, bb)
}

// copyFileIfNewer 在目标缺失或比源旧时复制；返回是否真的写了目标。
func copyFileIfNewer(src, dst string) bool {
	si, err := os.Stat(src)
	if err != nil || si.IsDir() {
		return false
	}
	if di, err := os.Stat(dst); err == nil && !di.IsDir() && !si.ModTime().After(di.ModTime()) {
		return false
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return false
	}
	return os.WriteFile(dst, b, 0600) == nil
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
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return 0, nil
	}
	srcDir := magpieConfigDir(home)
	if fi, err := os.Stat(srcDir); err != nil || !fi.IsDir() {
		return 0, nil
	}
	// 模型列表缓存（providers-state.json）也带上：provider 的 key 在
	// providers.json 里，但首次启动不会主动重拉所有模型；没有这份缓存，
	// 用户会看到 DeepSeek 这类供应商有 key 但 0 个模型，Agent 里选不了。
	// 缓存按目标缺失才复制，之后在 Perch 里的刷新不会被覆盖。
	_ = copyFileIfMissing(
		filepath.Join(magpieCacheDir(home), "providers-state.json"),
		filepath.Join(targetDir, "cache", "providers-state.json"),
	)
	if fi, err := os.Stat(marker); err == nil && !fi.IsDir() {
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
