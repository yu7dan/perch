// OSC 颜色查询应答。
//
// 移植自 Orca 的 src/shared/terminal-osc-color-reply.ts（MIT）。
// 保留它的三个关键设计决定，理由见下。
package term

import (
	"bytes"
	"fmt"
	"strings"
	"sync/atomic"
)

// 终端程序（Claude Code 就在其中）会问「你的前景/背景是什么颜色」：
//
//	ESC ] 1 1 ; ? BEL        问背景色
//	ESC ] 1 0 ; ? BEL        问前景色
//	ESC ] 1 0 ; ? ; ? BEL    两个一起问
//
// 真终端（Windows Terminal、iTerm、Ghostty）会回一条：
//
//	ESC ] 1 1 ; rgb:RRRR/GGGG/BBBB ESC \
//
// 程序据此决定自己的主题（深底还是浅底、用哪套强调色）。
// **没人回答，它就只能猜；猜不中的代价就是退回无色/单色渲染。**
// 这是「终端能力对齐」里最容易被忽略、但视觉影响最大的一条。
//
// Orca 把这件事放在**主进程的原始字节流**里做，不在 renderer 里 ——
// 因为这条查询可能在渲染器存在之前就到了（原注释：for answering OSC 10/11
// before (or without) a renderer）。我们的结构一样：在 PTY 读循环里做。
const (
	oscIntroducer = "\x1b]"
	oscStringTerm = "\x1b\\" // ST，另一种合法终止符（BEL 是 0x07）
	oscBEL        = 0x07
)

// 我们声明的终端颜色，**必须与 00-base.css 的 --term-bg / --term-fg、
// 10-term.js 的 xterm theme 是同一组值**，否则 agent 会按错误的底色选色
// （它据此决定用深底还是浅底、挑哪套强调色）。
//
// 2026-10-15：深色底由 Orca 的 #282c34 改为与应用画布相同的 #0a0a0a。
// 2026-10-28：有了浅色主题。前端解析出有效明暗后发 term.theme 过来（SetLight），
// 这里和 COLORFGBG 一起跟着换；浅色前景取 Orca「Builtin Tango Light」的 #2e3434，
// 底色是我们的画布 #f9fafb（方案 C）。
//
// ⚠️ 探针事实：本机 claude.exe 至今**没有**发过 OSC 10/11 查询
// （internal/stream/serve.go 里 20 秒后的 `[osc] 这段时间收到的查询统计` 一直是 map[]）。
// 所以这条是"保持正确"，不是在修一个正在发生的问题 —— 但哪天某个 agent
// 开始问了，它必须拿到当前主题的那个值。
const (
	darkForeground  = "#ffffff"
	darkBackground  = "#0a0a0a"
	lightForeground = "#2e3434"
	lightBackground = "#f9fafb"
)

var termLight atomic.Bool

// SetLight 记下界面当前的有效明暗（前端解析完 system 之后告诉我们）。
func SetLight(on bool) { termLight.Store(on) }

// Light 报告当前是不是浅色。
func Light() bool { return termLight.Load() }

// Colors 返回当前主题下声明给 agent 的前景 / 背景色。
func Colors() (fg, bg string) {
	if termLight.Load() {
		return lightForeground, lightBackground
	}
	return darkForeground, darkBackground
}

// ColorFGBG 是 COLORFGBG 的 fg;bg 索引形式：深色 = 白字黑底 15;0，浅色 = 黑字白底 0;15。
// 只影响**之后**起的进程 —— 环境变量没法改给已经在跑的 agent。
func ColorFGBG() string {
	if termLight.Load() {
		return "0;15"
	}
	return "15;0"
}

// oscColorQueries **必须按长度降序**排列：`ESC]10;?` 是 `ESC]10;?;?` 的前缀，
// 短的那个排前面会把长的截断成「查前景」而漏掉背景。
var oscColorQueries = []struct {
	seq string
	fg  bool
	bg  bool
}{
	{"\x1b]10;?;?", true, true},
	{"\x1b]11;?", false, true},
	{"\x1b]10;?", true, false},
}

// maxCarry 限制跨读块保留的字节数。查询本身只有几个字节，
// 留这么多足够覆盖任何切分位置，同时防住病态输入把内存撑大。
const maxCarry = 128

// OSCResponder 在输出字节流里找颜色查询，产出要写回 PTY 的应答。
//
// 它必须是有状态的：PTY 的读块边界和转义序列边界**没有任何关系**，
// `ESC]11;?` 完全可能被切成 `ESC]1` + `1;?BEL`。
type OSCResponder struct {
	carry []byte
	seen  map[string]int // 探针：统计收到过哪几种查询
}

// NewOSCResponder 建一个带探针统计的应答器。
func NewOSCResponder() *OSCResponder {
	return &OSCResponder{seen: map[string]int{}}
}

// Scan 吃掉一块输出，返回应当写回 PTY 的应答串（可能是 0 条或多条）。
func (r *OSCResponder) Scan(chunk []byte) []string {
	data := chunk
	if len(r.carry) > 0 {
		merged := make([]byte, 0, len(r.carry)+len(chunk))
		merged = append(merged, r.carry...)
		merged = append(merged, chunk...)
		data = merged
	}
	r.carry = nil

	var replies []string
	i := 0
	for {
		j := bytes.Index(data[i:], []byte(oscIntroducer))
		if j < 0 {
			// 末尾孤零零一个 ESC，可能是被切断的引导符
			if len(data) > 0 && data[len(data)-1] == 0x1b {
				r.carry = []byte{0x1b}
			}
			return replies
		}
		start := i + j
		matched := false
		for _, q := range oscColorQueries {
			if !bytes.HasPrefix(data[start:], []byte(q.seq)) {
				continue
			}
			end := start + len(q.seq)
			switch {
			case end < len(data) && data[end] == oscBEL:
				end++
			case end+1 < len(data) && data[end] == 0x1b && data[end+1] == '\\':
				end += 2
			case end >= len(data) || (data[end] == 0x1b && end+1 >= len(data)):
				// 终止符还没收到，整条留到下一块再判
				r.carry = append([]byte(nil), data[start:]...)
				if len(r.carry) > maxCarry {
					r.carry = nil
				}
				return replies
			default:
				continue // 这条不是查询，换下一种形式试
			}
			fg, bg := Colors()
			if q.fg {
				replies = append(replies, OSCReply(10, fg))
				r.seen["10"]++
			}
			if q.bg {
				replies = append(replies, OSCReply(11, bg))
				r.seen["11"]++
			}
			i = end
			matched = true
			break
		}
		if !matched {
			i = start + len(oscIntroducer)
		}
	}
}

// Seen 返回探针统计的副本（收到过哪几种查询、各几次）。
func (r *OSCResponder) Seen() map[string]int {
	out := make(map[string]int, len(r.seen))
	for k, v := range r.seen {
		out[k] = v
	}
	return out
}

// OSCReply 拼一条 `ESC] <slot> ; rgb:RRRR/GGGG/BBBB ESC\`。
//
// 注意终止符用 **ST（ESC \）而不是 BEL** —— Orca 也用的是 ST。
// 两种都合法，但 ST 不会和「响铃」这件事混淆（有些程序把 BEL 当提示音处理）。
func OSCReply(slot int, hexColor string) string {
	return fmt.Sprintf("\x1b]%d;%s%s", slot, OSCRGB(hexColor), oscStringTerm)
}

// OSCRGB 把 #RRGGBB 转成 `rgb:RRRR/GGGG/BBBB`。
//
// 每个通道是 **16 位**，而我们的主题是 8 位十六进制，所以要把每个字节**重复一次**
// （0x28 → "2828"）。写成 `rgb:28/2c/34` 是不合规范的，会被严格的解析器拒绝 ——
// Orca 的 byteHexToWord() 做的就是这件事。
func OSCRGB(hexColor string) string {
	h := strings.TrimPrefix(strings.TrimSpace(hexColor), "#")
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 {
		return ""
	}
	w := func(i int) string { return h[i : i+2] }
	return "rgb:" + w(0) + w(0) + "/" + w(2) + w(2) + "/" + w(4) + w(4)
}
