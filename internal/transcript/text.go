package transcript

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// cutUTF8 按字节上限截，退到合法的 rune 边界。返回 (截后文本, 有没有截)。
func cutUTF8(s string, max int) (string, bool) {
	if max <= 0 || len(s) <= max {
		return s, false
	}
	i := max
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i] + "…", true
}

// cutRunes 按**字符**截断，但**保留换行**。
//
// ⚠️ 它和 clip 是两件事，不能互相顶替：clip 把 \r\n 和 \n 压成空格（它服务的
// 是"一行日志"），而 preview 的价值**恰恰在那些换行**（✓/✗ 的对齐块）。
// 用 clip 截 preview 会把整个块压成一行，看着"还有内容"，其实已经废了 ——
// 属于看起来正常、内容不对的那类错。
func cutRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

/*
msgMax 是**进流水那条路**给单条正文的上限（字符）。

	原来两处写的是 `clip(x, 300)` —— 300 字，而且 clip 把换行压成空格。实测
	（2026-10-16）：一条 1961 字、17 个换行的回答，到前端只剩 300 字、还并成了
	一行 —— **85% 的内容根本没送出去**。那不是"没显示"，是"没有"。用户报的
	"上面文字多的时候下面被吞掉"就是它（300 对正文来说低得离谱）。

	为什么不干脆**不截**：每条新内容只推**新增的那一条**（见 poll 里 push 的是
	newActs），所以实时那一路的成本只跟单条大小成正比；真正花钱的是**快照** ——
	`acts.snapshot` 会把内存里**全部**流水序列化一遍（保留上限 maxActs=300），
	而页面重载、以及"进群组时对每一格各要一份"都会走它 ⇒ 一条 5MB 的回答在那
	一刻是 5MB × N 格，前端还会把它整段 md() 进 DOM。那不是慢，是界面卡死。

	8000 这个档：正常回答 500–3000 字，够装下；真超了也**不许静默** ——
	带上 FullLen（原文总字数），前端照实说"这里只显示了前 8000"。
*/
const msgMax = 8000

// msgText 给正文（agent 的话 / 你的话）用：**保留换行**地截，并回报原文总字数
// （0 = 没截）。⚠️ 不能用 clip：它把 \r\n 换成空格，那是给"一行日志"写的。
func msgText(s string) (string, int) {
	r := []rune(s)
	if len(r) <= msgMax {
		return s, 0
	}
	return string(r[:msgMax]) + "…", len(r)
}

// textOf 抠出 message.content 里的文本（string 和 array of blocks 两种形状都吃，
// 上游两种都出现过 —— 见 internal/history 的同一条教训）。
func textOf(raw json.RawMessage) string {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 {
		return ""
	}
	if b[0] == '"' {
		var s string
		if json.Unmarshal(b, &s) == nil {
			return s
		}
		return ""
	}
	if b[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(b, &blocks) == nil {
			var sb strings.Builder
			for _, x := range blocks {
				if x.Type == "text" && strings.TrimSpace(x.Text) != "" {
					sb.WriteString(x.Text)
				}
			}
			return sb.String()
		}
	}
	return ""
}

// clip 截断长文本，并把换行压成可见记号（否则一行日志会被撑成很多行）。
func clip(s string, n int) string {
	r := []rune(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " "))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "…"
}

// short 把 uuid 截成前 8 位 —— 日志里只要"能对上"就够，整条 uuid 是噪音。
func short(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}
