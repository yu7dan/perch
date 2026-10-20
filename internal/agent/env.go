package agent

import (
	"os"
	"sort"
	"strings"
)

// envBlocked 列出**绝不能从宿主继承**的终端呈现类变量。
//
// 规则的由来：宿主自己可能就是一个 agent 会话，它的环境是
// 「我是谁、我在什么终端里」的**第一人称描述** —— 对子进程来说这些描述全是
// 谎话，而且会实质改变子 agent 的行为。我们已经在这上面栽过两次：
//
//   - CLAUDE_CODE_CHILD_SESSION 之类 → 子 claude 认为自己是子会话，
//     **历史根本不落盘**，直接毁掉「续接」这个核心功能。
//   - NO_COLOR=1 → 子 claude 认为终端不支持颜色，**关掉全部颜色输出**。
//     表现是：开场横幅的吉祥物从 #D97757 橙色变成纯白，整个终端黑白一片。
//
// 两次都是「宿主的环境泄漏进了子 agent」。补一个删一个的写法永远补不完，
// 所以这里把**终端呈现相关的一整类**显式列出并整类剥掉，
// 再由我们在下面按事实重新声明。
var envBlocked = map[string]bool{
	"NO_COLOR": true, "FORCE_COLOR": true,
	"CLICOLOR": true, "CLICOLOR_FORCE": true,
	"TERM": true, "COLORTERM": true, "COLORFGBG": true,
	"TERM_PROGRAM": true, "TERM_PROGRAM_VERSION": true,
	// 下面这些是在**别的终端里**才成立的标识。宿主如果跑在 Windows Terminal
	// 里，它们就会漏进来，让子 claude 以为自己在 WT 里（进而期待 WT 才有的能力）。
	"WT_SESSION": true, "WT_PROFILE_ID": true,
	"VTE_VERSION": true, "KITTY_WINDOW_ID": true,
	"ITERM_SESSION_ID": true, "ITERM_PROFILE": true,
	"WEZTERM_PANE": true, "WEZTERM_EXECUTABLE": true,
}

// BuildEnv 从父进程环境出发，剥掉不该继承的，再**按事实**重新声明终端身份。
// extra 是 agent 自己那份（claude 要 CLAUDE_CONFIG_DIR，pi 要 PI_CODING_AGENT_DIR）——
// 从外面传进来，因为这个函数不该知道有几个 agent。
func BuildEnv(extra map[string]string) []string {
	parent := os.Environ()
	// Windows 的环境变量名**大小写不敏感**：父进程里有 `Path`，extra 里再塞
	// 一条 `PATH` 不会覆盖它，两个键都会传下去，最后用哪条取决于接收方。
	// 表现是“我们明明加了 PATH，子进程还是找不到 node/npm”。所以 extra 里
	// 出现的键要先从父环境里按大小写不敏感地删掉。
	extraKeys := make(map[string]bool, len(extra))
	for k := range extra {
		extraKeys[strings.ToUpper(k)] = true
	}
	out := make([]string, 0, len(parent)+len(extra)+8)
	for _, e := range parent {
		k, _, _ := strings.Cut(e, "=")
		if strings.HasPrefix(k, "CLAUDE") || envBlocked[strings.ToUpper(k)] || extraKeys[strings.ToUpper(k)] {
			continue
		}
		out = append(out, e)
	}
	// 排序只为让日志/调试时两次运行的顺序一致（map 遍历顺序是随机的）。
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return append(out,
		// 下面这几条是**我们对"自己是什么终端"的事实声明**，不是从宿主抄来的。
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=perch",
		// fg;bg 的 0-15 索引形式。有些工具只认这个、不做 OSC 查询。
		// 我们的主题是深底 + 白字 → 15;0。底色 2026-10-15 改成 #0a0a0a 后
		// **这条不用动**：索引 0 就是"黑"，任何近黑底都对得上。
		"COLORFGBG=15;0",
		// 兜底再声明一次"要颜色"，24-bit。有它就不怕上游再塞进别的禁色变量。
		"FORCE_COLOR=3",
	)
}
