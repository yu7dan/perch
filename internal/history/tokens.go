package history

import (
	"bytes"
	"encoding/json"
)

// 总览的 token 读数（2026-10-28）：不再问网关，直接从会话文件里数。
//
// 每条 assistant 事件的 message 里带着这一次回复的 usage 和 model。一次回复会按
// 内容块拆成好几行写出来（thinking / text / tool_use 各一行），**同一个 message.id
// 会出现多次** —— 所以按 id 去重、取最后一次（最后一行的 usage 最完整）。
//
// 解析只抠两小段，不整行反序列化：会话文件总量上百 MB，整行 json.Unmarshal
// 会把这条热路径拖慢一个数量级（见 scan.go 文件头"靠 bytes.Contains 前置过滤"）。

// TokenUse 是一次回复的用量。
type TokenUse struct {
	In         int64 `json:"in"`         // 未命中缓存的输入
	Out        int64 `json:"out"`        // 输出（含思考）
	CacheRead  int64 `json:"cacheRead"`  // 命中缓存读出的输入
	CacheWrite int64 `json:"cacheWrite"` // 写入缓存的输入
}

// Total 是这次回复经手的全部 token。
func (u TokenUse) Total() int64 { return u.In + u.Out + u.CacheRead + u.CacheWrite }

func (u *TokenUse) add(v TokenUse) {
	u.In += v.In
	u.Out += v.Out
	u.CacheRead += v.CacheRead
	u.CacheWrite += v.CacheWrite
}

// assistantUsage 从一行 assistant 事件里取 message.id、model 和 usage。
func assistantUsage(line []byte) (id, model string, u TokenUse, ok bool) {
	mi := bytes.Index(line, []byte(`"message":{`))
	if mi < 0 {
		return "", "", u, false
	}
	msg := line[mi:]
	id = quotedAfter(msg, `"id":"`)
	model = quotedAfter(msg, `"model":"`)
	ui := bytes.Index(msg, []byte(`"usage":{`))
	if id == "" || ui < 0 {
		return "", "", u, false
	}
	obj := balancedObject(msg[ui+len(`"usage":`):])
	if obj == nil {
		return "", "", u, false
	}
	var raw struct {
		In         int64 `json:"input_tokens"`
		Out        int64 `json:"output_tokens"`
		CacheRead  int64 `json:"cache_read_input_tokens"`
		CacheWrite int64 `json:"cache_creation_input_tokens"`
	}
	if json.Unmarshal(obj, &raw) != nil {
		return "", "", u, false
	}
	return id, model, TokenUse{In: raw.In, Out: raw.Out, CacheRead: raw.CacheRead, CacheWrite: raw.CacheWrite}, true
}

// quotedAfter 取 key 之后到下一个未转义引号之前的那段（只用于 id / model 这类
// 不含转义的短值）。
func quotedAfter(b []byte, key string) string {
	i := bytes.Index(b, []byte(key))
	if i < 0 {
		return ""
	}
	rest := b[i+len(key):]
	j := bytes.IndexByte(rest, '"')
	if j < 0 || j > 200 {
		return ""
	}
	return string(rest[:j])
}

// balancedObject 返回 b 开头那个 {...} 对象（按引号与转义正确跳过字符串）。
func balancedObject(b []byte) []byte {
	if len(b) == 0 || b[0] != '{' {
		return nil
	}
	depth, inStr, esc := 0, false, false
	for i, c := range b {
		switch {
		case esc:
			esc = false
		case inStr && c == '\\':
			esc = true
		case c == '"':
			inStr = !inStr
		case inStr:
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return b[:i+1]
			}
		}
	}
	return nil
}
