package main

/* 沉浸 / 嵌入（用户 2026-11-09 第三轮定；页面那边见 assets/js/41-desk-embed.js）。

   嵌入时只有块、Dock、浮层这些归 Perch，其余地方归桌面：能点桌面图标、开文件。
   页面报「归 Perch 的地方」（perch:hit，CSS 像素、相对客户区；要整块屏时 full=true），
   这里每 16ms 看一眼鼠标：在那些地方里面 → 台面窗口照常接鼠标；在外面 → 窗口切成点得穿（WS_EX_LAYERED|WS_EX_TRANSPARENT），
   点击直接落到后面的桌面 / 程序上。按着左键的时候不切（拖块、从托盘拖 Agent 出来，半路不能把拖拽丢了）。

   没用 SetWindowRgn 把窗口裁成那几块：裁掉的地方连块的阴影一起切掉，边缘一刀齐。 */

import (
	"log"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type hitRect struct{ X, Y, W, H float64 }

type deskEmbed struct {
	main *application.WebviewWindow

	mu    sync.Mutex
	on    bool
	full  bool
	rects []hitRect
	dpr   float64
	stop  chan struct{}
}

var deskEmbedRef *deskEmbed

func newDeskEmbed(app *application.App, main *application.WebviewWindow) *deskEmbed {
	e := &deskEmbed{main: main, dpr: 1}
	deskEmbedRef = e
	app.Event.On("perch:embed", func(ev *application.CustomEvent) { e.set(boolField(unwrapEvent(ev.Data), "on")) })
	app.Event.On("perch:hit", func(ev *application.CustomEvent) { e.hits(unwrapEvent(ev.Data)) })
	return e
}

func unwrapEvent(data any) any {
	if arr, ok := data.([]any); ok && len(arr) == 1 {
		return arr[0]
	}
	return data
}

func (e *deskEmbed) isOn() bool {
	if e == nil {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.on
}

func (e *deskEmbed) set(on bool) {
	if _, _, _, _, test := deskWindowRect(); test {
		return // 屏幕外的测试实例不嵌入
	}
	e.mu.Lock()
	if e.on == on {
		e.mu.Unlock()
		return
	}
	e.on = on
	if on {
		e.full, e.rects = true, nil // 页面报上第一帧之前，整块屏先照常归 Perch
		e.stop = make(chan struct{})
		go e.loop(e.stop)
	} else if e.stop != nil {
		close(e.stop)
		e.stop = nil
	}
	e.mu.Unlock()
	if on {
		log.Printf("[desk] 嵌入桌面：块和 Dock 之外的地方归桌面")
	} else {
		e.setThrough(false)
		log.Printf("[desk] 回到沉浸：台面盖住整块屏")
		if deskNativeRef != nil {
			deskNativeRef.summon("回到沉浸")
		}
	}
}

func (e *deskEmbed) hits(data any) {
	m, _ := data.(map[string]any)
	if m == nil {
		return
	}
	dpr, _ := m["dpr"].(float64)
	full, _ := m["full"].(bool)
	raw, _ := m["items"].([]any)
	rs := make([]hitRect, 0, len(raw))
	for _, it := range raw {
		o, _ := it.(map[string]any)
		f := func(k string) float64 { v, _ := o[k].(float64); return v }
		rs = append(rs, hitRect{f("x"), f("y"), f("w"), f("h")})
	}
	e.mu.Lock()
	if dpr > 0 {
		e.dpr = dpr
	}
	e.full, e.rects = full, rs
	e.mu.Unlock()
}

func (e *deskEmbed) loop(stop chan struct{}) {
	t := time.NewTicker(16 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		if nativeLButtonDown() {
			continue
		}
		cx, cy, ok := nativeCursorPos()
		if !ok {
			continue
		}
		ox, oy := nativeClientOrigin(e.main)
		e.mu.Lock()
		x, y := float64(cx-ox)/e.dpr, float64(cy-oy)/e.dpr
		inside := e.full
		for _, r := range e.rects {
			if inside {
				break
			}
			inside = x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
		}
		e.mu.Unlock()
		// 每次都问窗口本身，不记在自己这儿：激活、挪位置这些时候窗口样式会被别人改回去（实测点一下块再点桌面，
		// 记着的「已经点得穿」和窗口真实样式对不上，后面就一直点不穿了）
		if want := !inside; want != nativeIsClickThrough(e.main) {
			e.setThrough(want)
		}
	}
}

func (e *deskEmbed) setThrough(on bool) {
	application.InvokeSync(func() { nativeClickThrough(e.main, on) })
	if on {
		// 鼠标是「穿出去」的，网页收不到 mouseleave：告诉它一声，好把悬停才出来的东西（顶上的 Perch 标和时间）收回去
		e.main.EmitEvent("perch:hit-out", nil)
	}
}
