package ctl

import "strings"

// trimSpace 收紧控制消息里的文本字段。空串在多数消息里是"没给"的意思，
// 而前端偶尔会带空白 —— 两边按同一个口径判。
func trimSpace(s string) string { return strings.TrimSpace(s) }

// short 把 uuid 截成前 8 位 —— 日志里只要"能对上"就够，整条 uuid 是噪音。
// （同 internal/session 的日志 helper；那个包不导出。）
func short(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}
