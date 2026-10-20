package stream

import (
	"bytes"
	"fmt"
	"log"
	"strings"
)

// rawProbeLimit 是启动时原样打印的字节数上限。
//
// 为什么需要它：屏幕上"看起来不对"时，有两类完全不同的原因 ——
//
//	A. CLI 本来就发的是这些字符（那我们渲染是忠实的，要改的是别处）；
//	B. 我们的链路把字节改了（那是我们的 bug）。
//
// 从截图上分辨这两者是徒劳的。**先看 CLI 到底发了什么，一次就能定性。**
// 开场横幅很小、出现得很早，几 KB 足够覆盖。
//
// ⚠️ 2026-10-15 补：这个"只 dump 前 8000 字节"的闸门**自己把证据掐断过**。
// 排查「吉祥物反复出现」时，9 秒时探针数到回滚缓冲里有 1 个介绍框、现在有 6 个，
// 而中间那 5 个恰好全部发生在 8000 字节用完之后 —— 日志一片安静，说不清是什么
// 触发的。所以 8000 用完之后还有下面那条按**内容**触发的探针：不再限制总量，
// 而是只标记「这一帧的字节里含开场介绍框」。介绍框每被重画一次，回滚缓冲就多
// 一份，于是"什么时刻、因为什么又画了一帧"在日志里就是可数的一行行。
const rawProbeLimit = 8000

// bannerMark 是开场介绍框的判据：介绍框里最有辨识度、又不会出现在别处的字符串。
// （前端的 countBanners 用的是同一串，两边对得上。）
const bannerMark = "API Usage Billing"

// probeBytes 是诊断探针（保留理由见上面 rawProbeLimit 的注释）。
func probeBytes(tabID int, p []byte, rawLeft *int) {
	if *rawLeft > 0 {
		take := len(p)
		if take > *rawLeft {
			take = *rawLeft
		}
		*rawLeft -= take
		log.Printf("[raw t%d] %s", tabID, escapeBytes(p[:take]))
	} else if bytes.Contains(p, []byte(bannerMark)) {
		// 不打印整帧（TUI 重画很频繁，整个 dump 出来日志会失控），
		// 只留一行"这一帧里又有一份介绍框"。数行数 = 数份数。
		log.Printf("[banner t%d] 这一帧的字节里含开场介绍框（%d 字节）", tabID, len(p))
	}
}

// escapeBytes 把原始字节转成可读形式：控制字符和 ESC 显式标出，
// 其余字节原样保留（本来就是 UTF-8，块元素和中文都能直接看）。
func escapeBytes(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		switch {
		case c == 0x1b:
			sb.WriteString("<ESC>")
		case c == '\r':
			sb.WriteString("<CR>")
		case c == '\n':
			sb.WriteString("<LF>")
		case c < 0x20:
			fmt.Fprintf(&sb, "<%02X>", c)
		default:
			sb.WriteByte(c)
		}
	}
	return sb.String()
}
