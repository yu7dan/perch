package main

/* 台面上的「外来窗口」（0.1.1 M4）。

   · 网页块 = Perch 自己开的一个 WebView2 窗口（无边框、不进任务栏、挂在主窗口名下 → 永远在台面之上），
     贴在块的身体上。地址栏、后退、刷新是台面画的；页面换了，窗口里注一句脚本把地址和标题报回来
     （chrome.webview.postMessage → RawMessageHandler → perch:web-url）。登录状态和主窗口同一个 WebView2 环境，会记住。
   · 应用块 = 别的程序**自己的窗口**：从开始菜单启动（explorer shell:AppsFolder\<id>），认出新冒出来的那个顶层窗口，
     摆到块的身体上。**不挂在主窗口名下**：owner 被销毁时系统会连带销毁被拥有的窗口，Perch 一退（或崩）别人的窗口跟着没了，
     那是丢用户数据的事。所以只摆位置，台面被点到前面时把主窗口压回它们下面（raise）。
     认不出窗口 / 摆不动（管理员权限、全屏游戏）就报回去，台面提示「收起 Perch 后单独打开」。
   · 前端每次摆好台面就把这些块的位置（CSS 像素、相对主窗口客户区）和该不该露出来报上来（perch:native-place）。
     「不露」：网页窗口藏起来；应用窗口放到主窗口**后面**（不藏不最小化：Perch 万一这时退了，它照样在、任务栏里也在）。
   · 收起 Perch：网页窗口藏起，应用窗口最小化（任务栏里点得回来）；回到台面再按原样摆回去。

   ⚠️ 事件名分两套：前端 → Go（perch:web-open …）和 Go → 前端（perch:web-url …）不重名 ——
   window.EmitEvent 发的是应用级事件，同名会回到这里的监听器（desk.go 文件头那条）。 */

import (
	"encoding/json"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

type nativePlace struct {
	X, Y, W, H float64
	Show       bool
}

type deskNative struct {
	app  *application.App
	main *application.WebviewWindow

	mu     sync.Mutex
	webs   map[string]*application.WebviewWindow
	apps   map[string]uintptr // 块 id → 别人的窗口
	place  map[string]nativePlace
	dpr    float64
	stowed bool
	minned map[uintptr]bool // 收起时被我们最小化的
}

var deskNativeRef *deskNative

func newDeskNative(app *application.App, main *application.WebviewWindow) *deskNative {
	d := &deskNative{app: app, main: main, webs: map[string]*application.WebviewWindow{}, apps: map[string]uintptr{},
		place: map[string]nativePlace{}, dpr: 1, minned: map[uintptr]bool{}}
	deskNativeRef = d
	app.Event.On("perch:web-open", func(e *application.CustomEvent) { d.webOpen(e.Data) })
	app.Event.On("perch:web-nav", func(e *application.CustomEvent) { d.webNav(e.Data) })
	app.Event.On("perch:native-place", func(e *application.CustomEvent) { d.placeAll(e.Data) })
	app.Event.On("perch:native-close", func(e *application.CustomEvent) { d.closeOne(strField(e.Data, "id"), false) })
	app.Event.On("perch:app-launch", func(e *application.CustomEvent) { d.appLaunch(e.Data) })
	app.Event.On("perch:app-pop", func(e *application.CustomEvent) { d.closeOne(strField(e.Data, "id"), true) })
	app.Event.On("perch:app-outside", func(e *application.CustomEvent) { nativeLaunch(strField(e.Data, "app")) })
	app.Event.On("perch:apps-get", func(e *application.CustomEvent) { go d.sendApps(boolField(e.Data, "fresh")) })
	// 主窗口关掉：网页窗口跟着关（不然 Wails 认为还有窗口、进程不退）；别人的应用窗口原样留着
	main.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { d.shutdown() })
	return d
}

func strField(data any, key string) string {
	if arr, ok := data.([]any); ok && len(arr) == 1 {
		data = arr[0]
	}
	if m, ok := data.(map[string]any); ok {
		if s, ok := m[key].(string); ok {
			return s
		}
	}
	return ""
}

func boolField(data any, key string) bool {
	if arr, ok := data.([]any); ok && len(arr) == 1 {
		data = arr[0]
	}
	if m, ok := data.(map[string]any); ok {
		b, _ := m[key].(bool)
		return b
	}
	return false
}

// ---- 网页块 ----

func (d *deskNative) webOpen(data any) {
	id, url := strField(data, "id"), strField(data, "url")
	if id == "" || !strings.HasPrefix(url, "http") {
		return
	}
	d.mu.Lock()
	if w := d.webs[id]; w != nil {
		d.mu.Unlock()
		w.SetURL(url)
		return
	}
	d.mu.Unlock()
	w := d.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:      "web-" + id,
		Title:     "Perch 网页",
		Width:     640,
		Height:    480,
		Frameless: true,
		Hidden:    true,
		URL:       url,
		Windows:   application.WindowsWindow{HiddenOnTaskbar: true, DisableFramelessWindowDecorations: true},
	})
	w.OnWindowEvent(events.Windows.WebViewNavigationCompleted, func(*application.WindowEvent) {
		// 页面换了：让页面自己把地址和标题报回来（chrome.webview.postMessage）。单页应用换地址不触发这个事件，
		// 所以注一个每秒看一眼的小钟（每个文档只注一次）。
		// ⚠️ 外站页面永远不会发「运行时就绪」，ExecJS 会一直排队 —— 先替它说一声就绪，排着的脚本才会跑。
		w.HandleMessage("wails:runtime:ready")
		w.ExecJS(navReportJS)
	})
	d.mu.Lock()
	d.webs[id] = w
	p, ok := d.place[id]
	d.mu.Unlock()
	nativeSetOwner(w, d.main)
	if ok {
		d.applyWeb(w, p)
	}
	log.Printf("[desk] 网页块 %s 打开 %s", id, url)
}

func (d *deskNative) webNav(data any) {
	id, op, url := strField(data, "id"), strField(data, "op"), strField(data, "url")
	d.mu.Lock()
	w := d.webs[id]
	d.mu.Unlock()
	if w == nil {
		return
	}
	switch op {
	case "go":
		if strings.HasPrefix(url, "http") {
			w.SetURL(url)
		}
	case "back":
		w.ExecJS("history.back()")
	case "fwd":
		w.ExecJS("history.forward()")
	case "reload":
		w.ExecJS("location.reload()")
	}
}

const navReportJS = `(function(){if(window.__perchNav)return;var last="";function r(){var k=location.href+"\n"+document.title;if(k===last)return;last=k;try{chrome.webview.postMessage("perch:nav:"+JSON.stringify({u:location.href,t:document.title}))}catch(e){}}window.__perchNav=setInterval(r,1000);r()})()`

// onRawMessage：网页窗口里那一句 postMessage。只认「perch:nav:」，别的一律不理（外站页面能发任何东西）。
func (d *deskNative) onRawMessage(win application.Window, msg string) {
	if !strings.HasPrefix(msg, "perch:nav:") {
		return
	}
	name := win.Name()
	if !strings.HasPrefix(name, "web-") {
		return
	}
	var nav struct {
		U string `json:"u"`
		T string `json:"t"`
	}
	if json.Unmarshal([]byte(strings.TrimPrefix(msg, "perch:nav:")), &nav) != nil {
		return
	}
	d.main.EmitEvent("perch:web-url", map[string]string{"id": strings.TrimPrefix(name, "web-"), "url": nav.U, "title": nav.T})
}

// ---- 摆位置 ----

func (d *deskNative) placeAll(data any) {
	if arr, ok := data.([]any); ok && len(arr) == 1 {
		data = arr[0]
	}
	m, _ := data.(map[string]any)
	if m == nil {
		return
	}
	dpr, _ := m["dpr"].(float64)
	items, _ := m["items"].([]any)
	next := map[string]nativePlace{}
	for _, it := range items {
		o, _ := it.(map[string]any)
		id, _ := o["id"].(string)
		if id == "" {
			continue
		}
		f := func(k string) float64 { v, _ := o[k].(float64); return v }
		show, _ := o["show"].(bool)
		next[id] = nativePlace{X: f("x"), Y: f("y"), W: f("w"), H: f("h"), Show: show}
	}
	d.mu.Lock()
	if dpr > 0 {
		d.dpr = dpr
	}
	d.place = next
	webs := map[string]*application.WebviewWindow{}
	for k, v := range d.webs {
		webs[k] = v
	}
	apps := map[string]uintptr{}
	for k, v := range d.apps {
		apps[k] = v
	}
	stowed := d.stowed
	d.mu.Unlock()
	if stowed {
		return
	}
	for id, w := range webs {
		d.applyWeb(w, next[id]) // 不在清单里 = 零值 = 不露
	}
	for id, h := range apps {
		d.applyApp(id, h, next[id])
	}
	nativeRaiseOver(d.main, d.appList())
}

func (d *deskNative) screenRect(p nativePlace) (x, y, w, h int) {
	d.mu.Lock()
	dpr := d.dpr
	d.mu.Unlock()
	ox, oy := nativeClientOrigin(d.main)
	r := func(v float64) int { return int(math.Round(v * dpr)) }
	return ox + r(p.X), oy + r(p.Y), r(p.W), r(p.H)
}

func (d *deskNative) applyWeb(w *application.WebviewWindow, p nativePlace) {
	if !p.Show || p.W < 20 || p.H < 20 {
		if w.IsVisible() {
			w.Hide()
		}
		return
	}
	x, y, ww, hh := d.screenRect(p)
	nativeMove(w, x, y, ww, hh)
	if !w.IsVisible() {
		w.Show()
		nativeMove(w, x, y, ww, hh)
	}
}

func (d *deskNative) applyApp(id string, h uintptr, p nativePlace) {
	if !nativeIsWindow(h) {
		d.mu.Lock()
		delete(d.apps, id)
		d.mu.Unlock()
		log.Printf("[desk] 应用块 %s 的窗口已经没了", id)
		d.main.EmitEvent("perch:app-state", map[string]any{"id": id, "gone": true})
		return
	}
	if !p.Show || p.W < 20 || p.H < 20 {
		nativeSendBehind(h, d.main)
		return
	}
	x, y, ww, hh := d.screenRect(p)
	if !nativeMoveForeign(h, x, y, ww, hh) {
		log.Printf("[desk] 应用块 %s 摆不动（权限不够？）", id)
		return
	}
	d.reportMinSize(id, h, ww, hh)
}

// reportMinSize：程序自己有最小尺寸（计算器就不肯比 500 高），摆完比要的大就告诉台面，让块长到装得下。
func (d *deskNative) reportMinSize(id string, h uintptr, ww, hh int) {
	go d.checkMinSize(id, h, ww, hh)
}

// 商店应用（ApplicationFrameHost）是异步改尺寸的：刚摆完量到的还是旧尺寸，等一会儿再量。
func (d *deskNative) checkMinSize(id string, h uintptr, ww, hh int) {
	time.Sleep(500 * time.Millisecond)
	aw, ah := nativeWindowSize(h)
	if aw <= ww+2 && ah <= hh+2 {
		return
	}
	d.mu.Lock()
	dpr := d.dpr
	d.mu.Unlock()
	d.main.EmitEvent("perch:app-minsize", map[string]any{"id": id, "w": math.Ceil(float64(aw) / dpr), "h": math.Ceil(float64(ah) / dpr)})
}

func (d *deskNative) appList() []uintptr {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []uintptr
	for id, h := range d.apps {
		if p, ok := d.place[id]; ok && p.Show {
			out = append(out, h)
		}
	}
	return out
}

// onMainActivated：台面被点到前面了 —— 主窗口压回贴着的应用窗口下面（它们在块里，本该在台面之上）。
func (d *deskNative) onMainActivated() {
	d.mu.Lock()
	stowed := d.stowed
	d.mu.Unlock()
	if stowed {
		return
	}
	// 激活这件事本身还会再把主窗口往前挪一次（实测：回到台面后立刻压回去，过一会儿主窗口又在上面）—— 稍后再压一次
	nativeRaiseOver(d.main, d.appList())
	time.AfterFunc(250*time.Millisecond, func() { nativeRaiseOver(d.main, d.appList()) })
}

// ---- 应用块 ----

func (d *deskNative) appLaunch(data any) {
	id, appID, exe, name := strField(data, "id"), strField(data, "app"), strField(data, "exe"), strField(data, "name")
	if id == "" || appID == "" {
		return
	}
	go func() {
		h, why := nativeLaunchAndFind(appID, exe)
		if h == 0 {
			log.Printf("[desk] 应用块 %s「%s」没贴上：%s", id, name, why)
			d.main.EmitEvent("perch:app-state", map[string]any{"id": id, "ok": false, "why": why})
			return
		}
		d.mu.Lock()
		d.apps[id] = h
		p, ok := d.place[id]
		d.mu.Unlock()
		nativeRestoreIfNeeded(h)
		if ok {
			x, y, ww, hh := d.screenRect(p)
			d.reportMinSize(id, h, ww, hh)
			if !nativeMoveForeign(h, x, y, ww, hh) {
				d.mu.Lock()
				delete(d.apps, id)
				d.mu.Unlock()
				d.main.EmitEvent("perch:app-state", map[string]any{"id": id, "ok": false, "why": "denied"})
				return
			}
		}
		log.Printf("[desk] 应用块 %s「%s」贴上了窗口 %#x（%s）", id, name, h, nativeWindowTitle(h))
		d.main.EmitEvent("perch:app-state", map[string]any{"id": id, "ok": true, "title": nativeWindowTitle(h), "hwnd": float64(h)})
	}()
}

// closeOne：关块（网页窗口关掉；应用窗口请它自己关，它要问存不存盘就让它问）；pop = 应用弹出成普通窗口（只是不再贴着）。
func (d *deskNative) closeOne(id string, pop bool) {
	d.mu.Lock()
	w := d.webs[id]
	h := d.apps[id]
	delete(d.webs, id)
	delete(d.apps, id)
	delete(d.place, id)
	d.mu.Unlock()
	if w != nil {
		w.Close()
	}
	if h != 0 {
		if pop {
			nativePopOut(h)
			log.Printf("[desk] 应用块 %s 弹出成普通窗口", id)
		} else {
			nativePostClose(h)
			log.Printf("[desk] 应用块 %s 关掉：请窗口自己关", id)
		}
	}
}

// ---- 收起 / 回来 ----

func (d *deskNative) stow() {
	d.mu.Lock()
	d.stowed = true
	webs := make([]*application.WebviewWindow, 0, len(d.webs))
	for _, w := range d.webs {
		webs = append(webs, w)
	}
	var apps []uintptr
	for _, h := range d.apps {
		apps = append(apps, h)
	}
	d.mu.Unlock()
	for _, w := range webs {
		w.Hide()
	}
	for _, h := range apps {
		if nativeMinimize(h) {
			d.mu.Lock()
			d.minned[h] = true
			d.mu.Unlock()
		}
	}
}

func (d *deskNative) unstow() {
	d.mu.Lock()
	d.stowed = false
	minned := d.minned
	d.minned = map[uintptr]bool{}
	d.mu.Unlock()
	for h := range minned {
		nativeRestoreIfNeeded(h)
	}
	// 前端回到台面后会再报一次位置；这里先按上一次的摆好
	d.mu.Lock()
	place := d.place
	dpr := d.dpr
	d.mu.Unlock()
	items := []any{}
	for id, p := range place {
		items = append(items, map[string]any{"id": id, "x": p.X, "y": p.Y, "w": p.W, "h": p.H, "show": p.Show})
	}
	time.AfterFunc(150*time.Millisecond, func() { d.placeAll(map[string]any{"dpr": dpr, "items": items}) })
	time.AfterFunc(600*time.Millisecond, func() { nativeRaiseOver(d.main, d.appList()) })
}

func (d *deskNative) shutdown() {
	d.mu.Lock()
	webs := d.webs
	d.webs = map[string]*application.WebviewWindow{}
	d.mu.Unlock()
	for _, w := range webs {
		w.Close()
	}
}

// ---- 开始菜单的应用 ----

func (d *deskNative) sendApps(fresh bool) {
	list, loading := nativeAppList(fresh, func(list []nativeApp) {
		d.main.EmitEvent("perch:apps", map[string]any{"apps": list, "loading": false})
	})
	d.main.EmitEvent("perch:apps", map[string]any{"apps": list, "loading": loading})
}

type nativeApp struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Exe  string `json:"exe,omitempty"`
	Icon string `json:"icon,omitempty"` // 图标文件名（/__desk/appicon/<icon>）
}
