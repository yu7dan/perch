package main

/* 真毛玻璃（用户 2026-11-09：深色、浅色都要）。

   台面窗口是透明的：网页里的 backdrop-filter 只能糊网页自己画的东西，糊不到窗口后面的桌面。
   所以每一块「玻璃」（块、Dock、收起的标签、浮层……）后面垫一扇系统的磨砂小窗：
   无边框、不进任务栏、不抢焦点、什么都不画，开着 Windows 的 blur-behind，摆在台面窗口**正下方**。
   台面窗口透明的地方就透出它 —— 它后面的桌面是真的被系统糊开的（动态壁纸也一样）。

   位置由页面报（perch:glass，CSS 像素、相对主窗口客户区、带圆角），这里换成屏幕像素、按圆角裁好、压在主窗口下面。
   收起台面时全藏起来；屏幕外的测试实例不垫（窗口不透明，垫了也看不见）。 */

import (
	"math"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type glassItem struct{ X, Y, W, H, R float64 }

type deskGlass struct {
	main *application.WebviewWindow

	mu     sync.Mutex
	panes  []uintptr // 小窗池（按需建、多了的藏起来）
	shown  int
	last   []glassItem
	dpr    float64
	light  bool
	stowed bool
}

var deskGlassRef *deskGlass

func newDeskGlass(app *application.App, main *application.WebviewWindow) *deskGlass {
	g := &deskGlass{main: main, dpr: 1}
	deskGlassRef = g
	app.Event.On("perch:glass", func(e *application.CustomEvent) { g.place(e.Data) })
	return g
}

func (g *deskGlass) place(data any) {
	if _, _, _, _, test := deskWindowRect(); test {
		return
	}
	if arr, ok := data.([]any); ok && len(arr) == 1 {
		data = arr[0]
	}
	m, _ := data.(map[string]any)
	if m == nil {
		return
	}
	dpr, _ := m["dpr"].(float64)
	light, _ := m["light"].(bool)
	raw, _ := m["items"].([]any)
	items := make([]glassItem, 0, len(raw))
	for _, it := range raw {
		o, _ := it.(map[string]any)
		f := func(k string) float64 { v, _ := o[k].(float64); return v }
		if f("w") < 8 || f("h") < 8 {
			continue
		}
		items = append(items, glassItem{f("x"), f("y"), f("w"), f("h"), f("r")})
	}
	g.mu.Lock()
	if dpr > 0 {
		g.dpr = dpr
	}
	g.last, g.light = items, light
	stowed := g.stowed
	g.mu.Unlock()
	if !stowed {
		application.InvokeSync(func() { g.apply() })
	}
}

// apply 只在 UI 线程上跑（小窗要建在有消息循环的线程上）。
func (g *deskGlass) apply() {
	g.mu.Lock()
	items, dpr, light := g.last, g.dpr, g.light
	g.mu.Unlock()
	ox, oy := nativeClientOrigin(g.main)
	r := func(v float64) int { return int(math.Round(v * dpr)) }
	for len(g.panes) < len(items) {
		h := glassCreate(light)
		if h == 0 {
			break
		}
		g.panes = append(g.panes, h)
	}
	n := 0
	for i, it := range items {
		if i >= len(g.panes) {
			break
		}
		glassPlace(g.panes[i], g.main, ox+r(it.X), oy+r(it.Y), r(it.W), r(it.H), r(it.R), light)
		n++
	}
	for i := n; i < len(g.panes); i++ {
		glassHide(g.panes[i])
	}
	g.mu.Lock()
	g.shown = n
	g.mu.Unlock()
}

func (g *deskGlass) stow() {
	g.mu.Lock()
	g.stowed = true
	g.mu.Unlock()
	application.InvokeSync(func() {
		for _, h := range g.panes {
			glassHide(h)
		}
	})
}

func (g *deskGlass) unstow() {
	g.mu.Lock()
	g.stowed = false
	g.mu.Unlock()
	application.InvokeSync(func() { g.apply() })
}

// raise：台面窗口的 z 序变了（被点到前面）以后，小窗要紧跟在它下面。
func (g *deskGlass) raise() {
	g.mu.Lock()
	stowed := g.stowed
	g.mu.Unlock()
	if !stowed {
		application.InvokeSync(func() { g.apply() })
	}
}

func (g *deskGlass) shutdown() {
	application.InvokeSync(func() {
		for _, h := range g.panes {
			glassDestroy(h)
		}
		g.panes = nil
	})
}
