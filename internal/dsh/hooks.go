package dsh

import (
	"bytes"
	"encoding/json"
	"strings"
)

// HookEvents 是官方桥真正支持的事件子集（Orca 的 hook-settings.ts 同一份）。
// 桥不认识 Notification / PermissionRequest；等待状态从 ask_user_question 的
// PreToolUse 里读（见前端 80-live.js 的 DSH 分支）。
var HookEvents = []string{
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
}

type hookCommand struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

type hookGroup struct {
	Hooks []hookCommand `json:"hooks"`
}

type hooksFile struct {
	Hooks map[string][]hookGroup `json:"hooks"`
}

// psQuote 生成 PowerShell 单引号字符串。桥的 command 走 DSH 的 shell 执行
// （Windows 上是 PowerShell），所以命令必须写成 `& 'exe' 'arg'`；光把路径
// 加引号在 PowerShell 里只是打印一个字符串，不会执行 —— 这个坑实测过。
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// BuildHooksJSON 生成 Perch 的 DSH hook 配置。
//
// 每个格子一个事件文件由接收器按环境变量 PERCH_AGENT_PANE 分流：hook 配置是
// 全局一份，不能像 Claude 的 --settings 那样把每个格子的路径写死。环境变量名
// 故意不含 KEY/TOKEN/SECRET/PASSWORD —— DSH 的 shell executor 会把含这些词
// 的变量剥掉（Orca 的 dsh-hook.cmd 里同一发现）。
func BuildHooksJSON(hookExe, hookDir string) ([]byte, error) {
	command := "& " + psQuote(hookExe) + " " + psQuote(hookDir) + " --pane"
	hooks := make(map[string][]hookGroup, len(HookEvents))
	for _, e := range HookEvents {
		hooks[e] = []hookGroup{{
			Hooks: []hookCommand{{
				Type:    "command",
				Command: command,
				// 接收器是一个本地小 exe；5 秒足够，卡住也不该拖住 agent 一轮。
				Timeout: 5,
			}},
		}}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	// command 里有 PowerShell 的 `&`；默认的 HTML 转义会写成 &。
	// JSON 解析回来虽然一样，但配置文件是给人审计的，保持可读。
	enc.SetEscapeHTML(false)
	if err := enc.Encode(hooksFile{Hooks: hooks}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func hooksJSONComplete(b []byte) bool {
	var f hooksFile
	if json.Unmarshal(b, &f) != nil {
		return false
	}
	for _, e := range HookEvents {
		groups := f.Hooks[e]
		if len(groups) == 0 {
			return false
		}
		hasCommand := false
		for _, g := range groups {
			for _, h := range g.Hooks {
				if h.Type == "command" && strings.TrimSpace(h.Command) != "" {
					hasCommand = true
				}
			}
		}
		if !hasCommand {
			return false
		}
	}
	return true
}
