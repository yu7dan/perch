package session

// Claude Code 的 --settings 是**追加设置**，它的 env 块会压过用户
// settings.json 里的同名变量。Perch 用它把网关地址/模型注入到**这一格**，
// 不写用户的任何配置文件。
//
// 原来的 hooks 设置也必须保留：这里只合并 env，不动 hooks。

import (
	"encoding/json"
	"os"
	"path/filepath"
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
// 文件路径没有这个问题；文件里只有 hooks 和网关地址/模型，没有密钥。
// 写失败返回空串，调用方继续用原来的内联串。
func writeClaudeSettings(tag, body string) string {
	dir := filepath.Join(os.TempDir(), "perch-claude-settings")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return ""
	}
	p := filepath.Join(dir, tag+".json")
	if err := os.WriteFile(p, []byte(body), 0600); err != nil {
		return ""
	}
	return p
}
