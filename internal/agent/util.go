package agent

import "strings"

// DataDirName 是 Perch 在用户配置目录下的数据目录名。
const DataDirName = "Perch"

// OrNone 让日志里那个字段永远**有值**：空字符串在日志里和"这一行没打出来"
// 看起来一样，写个 "-" 才能区分。
func OrNone(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// Short 把 uuid 截成前 8 位 —— 日志里只要"能对上"就够。
func Short(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}

// Clip 截断长文本，并把换行压成可见记号（否则一行日志会被撑成很多行）。
func Clip(s string, n int) string {
	r := []rune(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " "))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "…"
}

// SafeSessionID 是**白名单**。id 有两个去处：原样进命令行（以 - 开头会变成
// 另一个开关）、拿去拼盘上的路径做 glob（.. / / \ * ? 都是路径或通配符语法）。
func SafeSessionID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			return false
		}
	}
	return true
}
