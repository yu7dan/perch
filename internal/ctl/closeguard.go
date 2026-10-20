package ctl

import (
	"log"
	"sync/atomic"
	"time"
)

// CloseGuard 是关窗确认的三个状态。零值 = 还没问过 / 刚被取消。
//
//	confirmed  前端已确认，这次 WindowClosing 直接放行
//	askAt      上一次问前端的时刻（UnixNano）。30s 没有答复就放行，
//	           避免一个卡死的前端把窗口锁住
type CloseGuard struct {
	confirmed atomic.Bool
	askAt     atomic.Int64
}

// Confirm 是前端确认关闭（window.close）。
func (g *CloseGuard) Confirm() {
	g.confirmed.Store(true)
	g.askAt.Store(0)
}

// Cancel 是用户取消了确认框。窗口留着，下一次关窗可以再问。
func (g *CloseGuard) Cancel() {
	g.askAt.Store(0)
}

// ShouldAsk 决定这次 WindowClosing 要不要拦下来先问前端。
// 返回 cancel = 拦下这次关闭，emit = 发 perch:close-request 让前端弹确认框。
//
// confirmEnabled 来自设置里的「关闭窗口前确认」；connected = ctl 通道在不在。
// 前端不在（启动最初一两秒/崩了）时放行 —— 确认是为了防手滑，不是为了锁死窗口。
func (g *CloseGuard) ShouldAsk(confirmEnabled, connected bool) (cancel, emit bool) {
	if g.confirmed.Load() {
		return false, false
	}
	if !confirmEnabled {
		return false, false
	}
	if !connected {
		log.Printf("[settings] 关窗确认：前端控制通道不在，直接放行（不能把窗口锁死）")
		return false, false
	}
	now := time.Now()
	if last := g.askAt.Load(); last != 0 && now.Sub(time.Unix(0, last)) > 30*time.Second {
		log.Printf("[settings] 关窗确认：问了 30s 没有答复，放行这一次关闭")
		return false, false
	}
	if g.askAt.CompareAndSwap(0, now.UnixNano()) {
		log.Printf("[settings] 关窗确认：窗口要关，先问前端（确认框）")
	}
	return true, true
}
