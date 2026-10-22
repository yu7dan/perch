package dsh

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/winproc"
)

// EnsureHooks 把“状态”这条腿接到 DSH 上。当前产品主流程**不调用**它：
// Perch 不在安装后自动写用户 hooks，「接入状态」入口也已移除。保留给将来
// 真正需要时由用户显式触发的动作，别在启动/安装路径里接回来。
//
// 顺序是有原因的：
//  1. 先装桥、再装桥的 peer —— 桥的 package.json 是 peer 列表的权威来源；
//  2. 先写 hooks 文件，再写 home patch —— patch 指向一个不存在的文件时，桥会
//     静默地一条 hook 都不跑；
//  3. 最后用 HooksReady() 复核，而不是“命令退出 0 就算成”。
func EnsureHooks(stateDir, hookDir, hookExe string, logf func(string)) error {
	log := logf
	if log == nil {
		log = func(string) {}
	}
	if strings.TrimSpace(hookExe) == "" {
		return errors.New("找不到 perch-hook.exe：状态钩子无法接入")
	}
	if _, err := os.Stat(hookExe); err != nil {
		return fmt.Errorf("perch-hook.exe 不可用：%w", err)
	}
	if !ProfileReady() {
		return fmt.Errorf("dsh-TUI profile 还没有初始化：%s（先安装/运行一次 dsh-tui）", ProfileDir())
	}

	ver, err := dshVersion()
	if err != nil {
		return err
	}
	log("dsh 版本：" + ver)

	profile, err := readProfile()
	if err != nil {
		return fmt.Errorf("读取 dsh-tui profile 失败：%w", err)
	}
	if _, ok := profile.Dependencies[HookBridge]; !ok {
		log("安装状态钩子桥 " + HookBridge + "@" + ver + " …")
		if err := runDshPluginAdd(log, []string{HookBridge + "@" + ver}); err != nil {
			return err
		}
	}

	// 桥装好后重新读：peer 列表以磁盘上的 package.json 为准。
	profile, err = readProfile()
	if err != nil {
		return fmt.Errorf("读取 dsh-tui profile 失败：%w", err)
	}
	bridge, err := readBridgePackage()
	if err != nil {
		return fmt.Errorf("读取 hook 桥信息失败：%w", err)
	}
	var missing []string
	for name, rng := range bridge.PeerDependencies {
		if _, ok := profile.Dependencies[name]; ok {
			continue
		}
		spec := name
		if rng != "" && rng != "*" {
			spec += "@" + rng
		}
		missing = append(missing, spec)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		log(fmt.Sprintf("安装 hook 桥的 peer 依赖（%d 个；pnpm autoInstallPeers=false，必须显式装）…", len(missing)))
		if err := runDshPluginAdd(log, missing); err != nil {
			return err
		}
	}

	body, err := BuildHooksJSON(hookExe, hookDir)
	if err != nil {
		return fmt.Errorf("生成 DSH hook 配置失败：%w", err)
	}
	hooksPath := HooksPath(stateDir)
	if err := writeFileAtomic(hooksPath, body, 0o600); err != nil {
		return fmt.Errorf("写 DSH hook 配置失败：%w", err)
	}
	log("已写入 hooks 配置：" + hooksPath)

	patchPath := HomePatchPath()
	old, err := os.ReadFile(patchPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("读取 DSH home patch 失败：%w", err)
	}
	next, err := ApplyManagedPatch(string(old), hooksPath)
	if err != nil {
		return err
	}
	if next != string(old) {
		if err := writeFileAtomic(patchPath, []byte(next), 0o600); err != nil {
			return fmt.Errorf("写 DSH home patch 失败：%w", err)
		}
	}
	log("已在 " + patchPath + " 写入状态钩子挂载块")

	if !HooksReady() {
		return errors.New("状态钩子写入后复核失败（桥/peer/hooks 文件/home patch 至少有一项没落盘）")
	}
	return nil
}

// dshRuntime 找到“怎么跑 dsh CLI”：
//   - 原生 dsh.exe 直接跑；
//   - npm 的 dsh.cmd shim 解析到它背后的 bin.js，用 node 直接跑。
//
// 不走 cmd.exe /c 是为了绕开 Windows 对 `cmd /c "quoted path" args` 的引号
// 规则；shim 本身也是这么做的（它找 node 再跑 bin.js）。
func dshRuntime() (node, script, exe string, err error) {
	p, ok := winproc.FindExe("dsh")
	if !ok {
		return "", "", "", errors.New("找不到 dsh 命令：先安装 @deepseek-ai/dsh")
	}
	if strings.EqualFold(filepath.Ext(p), ".exe") {
		return "", "", p, nil
	}
	// npm shim 在 %APPDATA%\npm\dsh.cmd；包在它旁边的 node_modules 里。
	// 其他位置的 shim 也按同样的目录关系找一次。
	dir := filepath.Dir(p)
	candidate := filepath.Join(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
	if _, statErr := os.Stat(candidate); statErr != nil {
		return "", "", "", fmt.Errorf("找到 %s，但没有找到它背后的 dsh bin.js", p)
	}
	n, ok := findNode()
	if !ok {
		return "", "", "", errors.New("找不到 node.exe：DSH 需要 Node.js（安装配方会一并处理）")
	}
	return n, candidate, "", nil
}

func findNode() (string, bool) {
	if p, ok := winproc.FindExe("node"); ok {
		return p, true
	}
	var candidates []string
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		candidates = append(candidates, filepath.Join(pf, "nodejs", "node.exe"))
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		candidates = append(candidates,
			filepath.Join(local, "Programs", "nodejs", "node.exe"),
			filepath.Join(local, "Programs", "node", "node.exe"),
		)
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, true
		}
	}
	return "", false
}

var semverRE = regexp.MustCompile(`\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b`)

func dshVersion() (string, error) {
	node, script, exe, err := dshRuntime()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if exe != "" {
		cmd = exec.CommandContext(ctx, exe, "--version")
	} else {
		cmd = exec.CommandContext(ctx, node, script, "--version")
	}
	cmd.Env = childEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("dsh --version 失败：%w（%s）", err, compactOutput(out))
	}
	if m := semverRE.FindSubmatch(out); m != nil {
		return string(m[1]), nil
	}
	return "", fmt.Errorf("无法从 dsh --version 的输出里读到版本：%s", compactOutput(out))
}

func runDshPluginAdd(log func(string), pkgs []string) error {
	if len(pkgs) == 0 {
		return nil
	}
	if _, ok := winproc.FindExe("pnpm"); !ok {
		return errors.New("dsh plugin 需要 pnpm；先安装 pnpm（npm install -g pnpm@11）")
	}
	node, script, exe, err := dshRuntime()
	if err != nil {
		return err
	}
	args := []string{"plugin", "--profile", ProfileName, "add"}
	args = append(args, pkgs...)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if exe != "" {
		cmd = exec.CommandContext(ctx, exe, args...)
	} else {
		cmd = exec.CommandContext(ctx, node, append([]string{script}, args...)...)
	}
	cmd.Env = childEnv()
	cmd.Dir = Home()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.CombinedOutput()
	for i, line := range strings.Split(strings.TrimRight(string(out), "\r\n"), "\n") {
		if i >= 200 {
			log("…（输出已截断）")
			break
		}
		if line = strings.TrimRight(line, "\r"); line != "" {
			log(line)
		}
	}
	if err != nil {
		return fmt.Errorf("dsh plugin add 失败：%w", err)
	}
	return nil
}

// childEnv 给 dsh / pnpm / node 一条能互相找到的 PATH。
//
// Windows 的环境变量名大小写不敏感，直接往 os.Environ() 里再塞一条 PATH 可能
// 让原来的 Path 抢先；所以先把所有 PATH/Path 删掉，再加唯一一条。
func childEnv() []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+1)
	for _, e := range base {
		k, _, _ := strings.Cut(e, "=")
		if strings.EqualFold(k, "PATH") {
			continue
		}
		out = append(out, e)
	}
	var parts []string
	if appdata := os.Getenv("APPDATA"); appdata != "" {
		parts = append(parts, filepath.Join(appdata, "npm"))
	}
	if node, ok := findNode(); ok {
		parts = append(parts, filepath.Dir(node))
	}
	if p := os.Getenv("PATH"); p != "" {
		parts = append(parts, p)
	}
	out = append(out, "PATH="+strings.Join(parts, ";"))
	return out
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".perch-dsh-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func compactOutput(b []byte) string {
	s := strings.TrimSpace(strings.ReplaceAll(string(b), "\r\n", " | "))
	if len(s) > 300 {
		s = s[:300] + " …"
	}
	return s
}
