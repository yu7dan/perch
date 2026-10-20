package session

import "strings"

// short 把 uuid 截成前 8 位 —— 日志里只要"能对上"就够，整条 uuid 是噪音。
func short(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}

// clip 截断长文本，并把换行压成可见记号（否则一行日志会被撑成很多行）。
func clip(s string, n int) string {
	r := []rune(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " "))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "…"
}

// orNone 让日志里那个字段永远**有值**：空字符串在日志里和"这一行没打出来"
// 长得一样，而"source 是空的"（比如登记表那条兜底路径根本没有 source）
// 本身是一条要看得见的事实。
func orNone(s string) string {
	if s == "" {
		return "(未报)"
	}
	return s
}
