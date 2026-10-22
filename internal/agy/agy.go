// Package agy 接入 Antigravity CLI 的**生命周期钩子**。
//
// 为什么不用标题：实测（2026-10-21，隔离 HOME 起 agy）它的 OSC 标题就是
// 可执行文件路径（`"C:\...\agy.exe"`），既没有忙闲词，也没有 `agy` token ——
// Orca 那套标题阶梯在这个版本上没有信号可用。agy 自己提供 hooks.json
// （SessionStart / PreInvocation / Stop），这才是它的结构化状态源。
//
// 只写 `~/.gemini/config/hooks.json` 里**一个命名条目** `perch-status`：
//
//	· 其它条目原样保留（用户/插件的 hook 不能被我们吃掉）；
//	· 写入前备份 hooks.json；
//	· 坏 JSON 直接报错、不覆盖 —— 用户得先修自己的文件；
//	· 只订阅 SessionStart / PreInvocation / Stop。**不订阅 PreToolUse**：
//	  agy 的 PreToolUse 是权限门，空输出可能改变默认 allow/ask 决策，
//	  观察型 hook 绝不能替用户放行。等待（permission）因此仍不可见。
package agy

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const HookName = "perch-status"

// hookEvents 只收这三条。Stop 的输出是 `{}`（非 continue）→ 允许停止；
// PreInvocation/SessionStart 的 `{}` 等于不注入任何步骤。
var hookEvents = []string{"SessionStart", "PreInvocation", "Stop"}

// ConfigDir 是 agy 的全局定制根（docs/json_configs.md：`~/.gemini/config/`）。
func ConfigDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini", "config")
}

func HooksPath() string {
	dir := ConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "hooks.json")
}

// HookCommand 是写进 hooks.json 的那条命令。agy 在 Windows 上用 `cmd /c`
// 执行它，所以可执行文件路径必须带引号；参数里的事件名是固定枚举。
func HookCommand(hookExe, hookDir, event string) string {
	// ⚠️ 不能用 %q：Go 的字符串引号会把 Windows 路径里的反斜杠再转义一遍
	// （C:\\Perch\\…），cmd 收到的就是两个反斜杠。这里只要普通的双引号。
	return `"` + hookExe + `" --agy "` + hookDir + `" ` + event
}

// HooksReady 只回答“我们的条目在不在、三条事件齐不齐”。
// 它不验证 exe 路径 —— 目录换了之后 Ready 仍为 true，真正跑一次事件才算验证；
// UI 把它当“已安装”，不是“已收到事件”。
func HooksReady() bool {
	b, err := os.ReadFile(HooksPath())
	if err != nil {
		return false
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(b, &all) != nil {
		return false
	}
	raw, ok := all[HookName]
	if !ok {
		return false
	}
	var one map[string]json.RawMessage
	if json.Unmarshal(raw, &one) != nil {
		return false
	}
	for _, ev := range hookEvents {
		entry, ok := one[ev]
		if !ok || len(entry) == 0 || string(entry) == "null" {
			return false
		}
	}
	return true
}

// EnsureHooks 写入/更新 `perch-status` 条目。当前产品主流程**不调用**它 ——
// Perch 不自动改用户 hooks，「接入状态」入口也已移除；保留给将来真正需要时
// 由用户显式触发的动作，别在启动/安装路径里接回来。
func EnsureHooks(hookExe, hookDir string, logf func(string)) error {
	if strings.TrimSpace(hookExe) == "" {
		return fmt.Errorf("perch-hook.exe 不在主程序旁边")
	}
	if strings.TrimSpace(hookDir) == "" {
		return fmt.Errorf("hook 事件目录为空")
	}
	path := HooksPath()
	if path == "" {
		return fmt.Errorf("拿不到用户主目录")
	}
	if logf == nil {
		logf = func(string) {}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("建配置目录: %w", err)
	}

	all := map[string]json.RawMessage{}
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &all); err != nil {
			return fmt.Errorf("hooks.json 不是合法 JSON（不改动它）：%w", err)
		}
		// 有内容才备份；空文件/不存在没有可丢的东西。
		bak := fmt.Sprintf("%s.bak-%d", path, time.Now().Unix())
		if err := os.WriteFile(bak, b, 0o600); err != nil {
			return fmt.Errorf("备份 hooks.json: %w", err)
		}
		logf("已备份原 hooks.json → " + bak)
	} else if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("读 hooks.json: %w", err)
	}

	entry := map[string]any{}
	for _, ev := range hookEvents {
		entry[ev] = []any{map[string]any{
			"type":    "command",
			"command": HookCommand(hookExe, hookDir, ev),
			"timeout": 5,
		}}
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	all[HookName] = raw

	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".hooks-*.tmp")
	if err != nil {
		return fmt.Errorf("建临时文件: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return fmt.Errorf("写临时文件: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tmpName, 0o600)
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("落盘 hooks.json: %w", err)
	}
	logf("已写入 " + path + "（条目 " + HookName + "：SessionStart / PreInvocation / Stop）")
	return nil
}
