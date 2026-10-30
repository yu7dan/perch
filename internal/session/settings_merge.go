package session

// Claude Code 的 --settings 是**追加设置**，它的 env 块会压过用户
// settings.json 里的同名变量。Perch 用它把模型提供商的地址/模型注入到**这一格**，
// 不写用户的任何配置文件。
//
// 原来的 hooks 设置也必须保留：这里只合并 env，不动 hooks。

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
)

func mergeSettingsEnv(settings string, env map[string]string) string {
	m := map[string]any{}
	if settings != "" {
		if err := json.Unmarshal([]byte(settings), &m); err != nil {
			m = map[string]any{}
		}
	}
	cur, _ := m["env"].(map[string]any)
	if cur == nil {
		cur = map[string]any{}
	}
	for k, v := range env {
		cur[k] = v
	}
	m["env"] = cur
	b, err := json.Marshal(m)
	if err != nil {
		return settings
	}
	return string(b)
}

// writeClaudeSettings 把合并后的 --settings 写成这一格专属的文件。
// 走文件而不是命令行里的 JSON 字符串：Windows 的参数转义对 JSON 很脆，
// 文件路径没有这个问题。⚠️ 2026-10-28 起选了提供商的 Claude 格，这份文件里
// 会有那把 key（ANTHROPIC_AUTH_TOKEN）：Claude 自己 settings.json 的 env 会盖过进程
// 环境，只有 --settings 压得住。
//
// 放在 %APPDATA%\Perch\claude-settings（不是 %TEMP%）：原来按「tN.json」放在共享的
// 临时目录里，同时开两个 Perch 会互相覆盖对方格子的文件，带 key 的文件格子关了也不删。
// 现在每个 Perch 用自己的目录、0600，流一结束就删（Running.StopObserve），启动时清空残留。
// 写失败返回空串，调用方继续用原来的内联串。
func writeClaudeSettings(tag, body string) string {
	dir := claudeSettingsDir()
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return ""
	}
	p := filepath.Join(dir, tag+".json")
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		return ""
	}
	return p
}

// claudeSettingsDir 是这个 Perch 实例放「每格 --settings」的目录。
func claudeSettingsDir() string {
	d, err := appdir.PerchDir()
	if err != nil {
		return ""
	}
	return filepath.Join(d, "claude-settings")
}

// resetClaudeSettingsDir 启动时清掉上一次运行留下的每格设置文件（里面可能有 key），
// 连同旧版本放在 %TEMP%\perch-claude-settings 里的那一批。
// 旧目录是所有 Perch 共用的，另一个还开着的旧版本的格子可能正用着里面的文件，
// 所以那边只删一天以前的。
func resetClaudeSettingsDir() {
	legacy := filepath.Join(os.TempDir(), "perch-claude-settings")
	for _, dir := range []string{claudeSettingsDir(), legacy} {
		if dir == "" {
			continue
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		n := 0
		for _, e := range ents {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			if dir == legacy {
				if info, err := e.Info(); err != nil || time.Since(info.ModTime()) < 24*time.Hour {
					continue
				}
			}
			if os.Remove(filepath.Join(dir, e.Name())) == nil {
				n++
			}
		}
		if n > 0 {
			log.Printf("[perch] 清掉 %d 份上次留下的格子设置文件（%s）", n, dir)
		}
	}
}
