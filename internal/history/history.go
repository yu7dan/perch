// Package history 是 Claude 会话库的只读索引：扫 transcripts、聚合日活、
// 取一个会话最近的历史轮次。
//
// 数据来源完全按已批准计划里的原则：
//
//  1. **绝不反解目录名**。`C--Users-someone-my-project` 这种编码是有损的
//     （中文、连字符都还原不回来），只能当定位用的 key；真正的 cwd 一律
//     从文件**内容**里读。
//  2. 标题走四级降级：aiTitle → slug → 第一条 user 文本 → 会话 ID。
//     这个 fork 的 ai-title 事件是现成的好标题，先吃满。
//  3. 只做 O(1) 次全文件扫描，且用 bytes.Contains 做前置过滤 ——
//     主会话文件 5.5MB，13 个文件全量 JSON 解析是几秒级，过滤后是毫秒级。
//
// 「这一行到底是不是用户说的话」的判据在 transcript 包（SystemTurn）。本包不
// import 它：Scan 收一个注入的分类函数，于是 history 保持为叶子包，两边也不会
// 各写一份名单。
package history

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

type Session struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Slug    string `json:"slug"`
	Cwd     string `json:"cwd"`
	Project string `json:"project"` // 编码目录名：仅用于定位，不展示
	// Path 是这份会话文件的绝对路径。C2 的卡片菜单要"打开会话文件 / 在文件夹中
	// 显示"就得有它 —— 从前端拼不出来：项目目录名是有损 slug（见 transcript
	// 包的说明），子代理还多一层 subagents\。
	Path       string `json:"path"`
	Branch     string `json:"branch"`
	Permission string `json:"permission"`
	Preview    string `json:"preview"`
	Updated    string `json:"updated"`
	Agents     int    `json:"agents"` // 子代理会话数 = 卡片上那一排小胶囊
	Turns      int    `json:"turns"`
	Bytes      int64  `json:"bytes"`
	Sidechain  bool   `json:"sidechain"` // 子代理会话
	Parent     string `json:"parent"`    // 子代理所属主会话 ID
	AgentName  string `json:"agentName"`
	AgentType  string `json:"agentType"` // 例如 general-purpose
	// C7：子代理"停下来了"这件事要分成**已完成**和**被中断（已关闭）**两种，
	// 材料只有一样：文件**最后一条事件**是什么。
	//
	// ⚠️ 这一对字段的**可靠程度是单向的**，别读成"能分辨这两种结局"。
	// 本机全量扫过 37 份子代理会话文件（2026-10-16 00:56）：末条是 tool_result 的
	// **32 份**、是收尾 assistant 文本的 3 份、是悬空 tool_use 的只有 2 份。
	// 而且 01:01 那次又量到：**关格子软杀掉的子代理，它的工具调用会拿到一个
	// tool_result**（PTY 一关，正在跑的命令就中断返回了；实测 a321f9d6 那份：
	// tool_use 16:59:54 → tool_result 17:01:14.306，被杀前 0.7 秒落盘）。
	// 会留下悬空 tool_use 的是**硬杀**（进程树瞬间没了，来不及写结果）。
	// 所以"正常收尾"和"被软杀掉"在文件里**长得一模一样**。LastTool 只能当
	// **单边**证据用：
	//
	//   LastTool == true  → 一次工具调用没拿到结果 = 写者消失了 → 被打断（站得住）
	//   LastTool == false → **不是**"它正常收完了"，只是"我这儿看不出被打断"
	//
	// 而我原来在注释里写的"正常收尾以一句 assistant 文本结束"是**错的** ——
	// 那种收尾只占 3/37（大概是真写了最后总结的那几次）。谁要用这两个字段，
	// 先把上面那份分布读一遍。前端的判据顺序见 index.html 的 subStateOf。
	//
	// ⚠️ 这也是**对文件的推断**，不是"亲眼看着"（hook 的 SubagentStop 才是后者）。
	// 所以用它的时候必须先过一遍"还在不在写"：一个正在跑的子代理，两次工具调用
	// 之间也长这样。
	// 只在**子代理会话**上算（见 indexSession 的 sidechain 参数）：主会话没有这个
	// 用途，而它是每次刷新都要全量扫的热路径。
	LastKind string `json:"lastKind"` // 末尾事件的 type（"assistant" / "user"）
	LastTool bool   `json:"lastTool"` // 末尾那条事件是一次**没拿到结果**的工具调用

	// days 是这一份文件里每个**本地日期**的用户轮次数（day → 轮次）。
	// 它不落盘、也不发给前端 —— Scan 把它聚合进 DayActivity，总览的热力图读的是
	// 那一份聚合。放在 Session 上只是为了**同一次扫描**里顺手算掉：为了日活再把
	// 这些 jsonl 读一遍是纯浪费（总量 140MB+）。
	days map[string]int
	// tokens 同理：每个本地日期这份文件里的回复用量（按 message.id 去重后），
	// 只为聚合进 DayActivity。
	tokens map[string]*dayTokens
}

type dayTokens struct {
	use     TokenUse
	replies int
	models  map[string]int64
}

// DayActivity 是总览热力图的一格：本地日期 + 当天的轮次 + 当天有几个会话写过东西，
// 以及当天回复的 token 用量（2026-10-28 起从会话文件里数，不再问网关）。
// 只包含**有轮次或有回复**的日期；前端按 53 周铺格子，查不到就是 0。
type DayActivity struct {
	Day      string   `json:"day"`      // 本地日期 YYYY-MM-DD
	Turns    int      `json:"turns"`    // 主会话 + 子代理的用户轮次
	Sessions int      `json:"sessions"` // 当天有轮次的会话/子代理文件数
	Replies  int      `json:"replies"`  // 当天的回复数（按 message.id 去重）
	Tokens   TokenUse `json:"tokens"`
	// Models 是当天每个模型经手的 token 总量（输入 + 输出 + 缓存读写）。
	Models map[string]int64 `json:"models,omitempty"`
}

type HistoryItem struct {
	Role string `json:"role"`
	At   string `json:"at"`
	Text string `json:"text"`
}

// maxLine 是单行 JSON 的上限。attachment / file-history-snapshot 事件
// 里会内嵌整份文件内容，实测单行能到几 MB，默认的 64KB scanner 会直接报
// ErrTooLong 并**静默丢掉后面所有行** —— 那是很难查的错。
const maxLine = 24 << 20

// extractText 从一条事件里抠出人类可读文本。
//
// message.content 在这个 fork 里**两种形状都出现过**：主线是 string，
// 但也有 array of blocks。上游 Claude Code 是 array。两种都得吃，
// 否则换个版本就整个历史流空白。
func extractText(line []byte) string {
	var ev struct {
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
		LastPrompt string `json:"lastPrompt"`
	}
	if err := json.Unmarshal(line, &ev); err != nil {
		return ""
	}
	if ev.Message == nil {
		return ""
	}
	raw := bytes.TrimSpace(ev.Message.Content)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return cleanText(s)
		}
		return ""
	}
	if raw[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &blocks) == nil {
			for _, b := range blocks {
				if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
					return cleanText(b.Text)
				}
			}
		}
	}
	return ""
}

// cleanText 去掉终端控制序列和换行，让卡片上那一行是干净的一句话。
func cleanText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == 0x1b: // ESC：吃掉整个 CSI/OSC 序列
			i++
			if i < len(s) && s[i] == '[' {
				for i+1 < len(s) && (s[i+1] < 0x40 || s[i+1] > 0x7e) {
					i++
				}
				i++
			}
		case c == '\r' || c == '\n' || c == '\t':
			b.WriteByte(' ')
		case c < 0x20:
			// 其它控制字符丢掉
		default:
			b.WriteByte(c)
		}
	}
	return strings.TrimSpace(strings.Join(strings.Fields(b.String()), " "))
}

func stringField(line []byte, key string) string {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(line, &m); err != nil {
		return ""
	}
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return cleanText(s)
	}
	return ""
}

// localDay 把事件时间戳折成**本地**日期 YYYY-MM-DD。
// 解析不了就退回字符串前 10 位（那是 UTC 的日期，只作为兜底 —— 别把它当口径）。
func localDay(v string) string {
	if v == "" {
		return ""
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t.Local().Format("2006-01-02")
	}
	if len(v) >= 10 {
		return v[:10]
	}
	return ""
}

func clamp(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
