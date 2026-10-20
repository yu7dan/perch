package winproc

// Agent 可执行文件的发现、解析与版本探测。
//
// 这里是**唯一一张候选表**：名单探测（装没装）、运行时启动（用哪个 exe）、
// 安装后的版本探测都必须走它。分开写两份规则，迟早会出现名单显示已安装、
// 点开却报 "The system cannot find the file specified"。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// agentExeHints：有些 agent 的官方安装器**不写 PATH**，但落点是固定的。
// Codex 就是这一类：install.ps1 把 exe 放在
//
//	%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//
// 那是一枚指向 ~\.codex\packages\standalone\current\bin 的 junction；
// GUI 进程的 PATH 通常比终端里短，所以 exec.LookPath 找不到它。
func agentExeHints(bin, home, local string) []string {
	switch strings.ToLower(strings.TrimSpace(bin)) {
	case "pi":
		// Pi 的安装脚本把二进制放在 ~/.local/pi/pi.exe（不在 PATH，也不在
		// ~/.local/bin）。实测 1.2.0。
		out := []string{filepath.Join(home, ".local", "pi", "pi.exe")}
		if local != "" {
			out = append(out, filepath.Join(local, "Programs", "pi", "pi.exe"))
		}
		return out
	case "codex":
		out := []string{
			filepath.Join(home, ".codex", "packages", "standalone", "current", "bin", "codex.exe"),
		}
		if local != "" {
			out = append([]string{
				filepath.Join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
			}, out...)
		}
		return out
	case "agy":
		// Antigravity CLI 的官方安装脚本落在 %LOCALAPPDATA%\agy\bin，并把
		// 这个目录写进用户 PATH。GUI 进程启动时 PATH 可能还是旧的，所以
		// 这里也列上，安装完不用重启 Perch。
		if local == "" {
			return nil
		}
		return []string{
			filepath.Join(local, "agy", "bin", "agy.exe"),
			filepath.Join(local, "Programs", "agy", "agy.exe"),
		}
	}
	return nil
}

// FindExe 找 agent 的可执行文件，返回**真实路径**；找不到返回 ok=false。
func FindExe(bin string) (string, bool) {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return "", false
	}
	home, _ := os.UserHomeDir()
	local := os.Getenv("LOCALAPPDATA")
	appdata := os.Getenv("APPDATA")
	// ⚠️ 顺序必须是「真 Windows 可执行 → .cmd → 无扩展名」。
	// npm 在 Windows 上会同时写三份 shim：opencode（Git Bash 用的 shell 脚本）、
	// opencode.cmd、opencode.ps1。无扩展名那份**存在但不是 Win32 程序**，排在
	// 前面会被选中，ConPTY 直接报 "%1 is not a valid Win32 application"。
	names := []string{bin + ".exe", bin + ".cmd", bin}
	var cands []string
	for _, n := range names {
		cands = append(cands,
			filepath.Join(home, ".local", n),
			filepath.Join(home, ".local", "bin", n),
		)
		if local != "" {
			cands = append(cands,
				filepath.Join(local, "Programs", bin, n),
				filepath.Join(local, bin, n),
			)
		}
		if appdata != "" {
			cands = append(cands, filepath.Join(appdata, "npm", n))
		}
	}
	cands = append(cands, agentExeHints(bin, home, local)...)
	for _, p := range cands {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p, true
		}
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}
	return "", false
}

// ResolveExe 找一个 agent 的可执行文件，并处理 Windows 的 .cmd shim：
// npm 装出来的是 <bin>.cmd，ConPTY 不能直接启动它，要经 cmd.exe /c。
func ResolveExe(bin string) (string, []string) {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return "", nil
	}
	if p, ok := FindExe(bin); ok {
		return WrapShim(p)
	}
	return bin, nil
}

// WrapShim 把 .cmd/.bat 包成 cmd.exe /c 的调用。
func WrapShim(p string) (string, []string) {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".cmd", ".bat":
		return "cmd.exe", []string{"/c", p}
	}
	return p, nil
}

// ReloadPathFromRegistry 把机器级 + 用户级的 PATH 重新读进本进程。
// 安装脚本（以及 winget）写的是注册表；os.Getenv 在进程启动后就冻住了。
func ReloadPathFromRegistry() {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command",
		`[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil {
		return
	}
	p := strings.TrimSpace(strings.TrimRight(string(out), "\r\n"))
	if p != "" {
		_ = os.Setenv("PATH", p)
	}
}

// ProbeVersion 跑一次 --version，给安装结果留一条可核对的证据。
// 有些 CLI 没有这个参数、或者会起 TUI —— 6 秒拿不到就放弃，不拖住收尾。
func ProbeVersion(bin string) string {
	exe, prefix := ResolveExe(bin)
	if exe == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	args := append(append([]string{}, prefix...), "--version")
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.Output()
	if err != nil && len(out) == 0 {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}
