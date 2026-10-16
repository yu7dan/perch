package main

import (
	"os"
	"sort"
	"strings"
)

// 从 _spike\term\main.go 逐字拷来。存在的理由见那边的注释：
// 宿主自己就是一个 Claude Code 会话，它的 CLAUDE* 环境对子进程全是谎话，
// 而且实测栽过两次（CLAUDE_CODE_CHILD_SESSION 让历史不落盘、NO_COLOR 让整个终端黑白）。
var envBlocked = map[string]bool{
	"NO_COLOR": true, "FORCE_COLOR": true,
	"CLICOLOR": true, "CLICOLOR_FORCE": true,
	"TERM": true, "COLORTERM": true, "COLORFGBG": true,
	"TERM_PROGRAM": true, "TERM_PROGRAM_VERSION": true,
	"WT_SESSION": true, "WT_PROFILE_ID": true,
	"VTE_VERSION": true, "KITTY_WINDOW_ID": true,
	"ITERM_SESSION_ID": true, "ITERM_PROFILE": true,
	"WEZTERM_PANE": true, "WEZTERM_EXECUTABLE": true,
}

func buildEnv(extra map[string]string) []string {
	parent := os.Environ()
	out := make([]string, 0, len(parent)+len(extra)+8)
	for _, e := range parent {
		k, _, _ := strings.Cut(e, "=")
		if strings.HasPrefix(k, "CLAUDE") || envBlocked[strings.ToUpper(k)] {
			continue
		}
		out = append(out, e)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return append(out,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"TERM_PROGRAM=ai-workbench",
		"COLORFGBG=15;0",
		"FORCE_COLOR=3",
	)
}
