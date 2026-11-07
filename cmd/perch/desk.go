package main

import (
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

/* 台面（0.1.1）在 Go 这边只有三件事，都是前端自己做不到的：

   1. 桌面壁纸：前端拿不到本机文件，这里经资产服务器的一条私有路由
      `/__desk/wallpaper` 把当前壁纸原样吐出去；壁纸换了（系统广播
      WM_SETTINGCHANGE / SPI_SETDESKWALLPAPER）就发 `perch:wallpaper`，前端换个
      查询参数重新拉一次。
   2. 主窗口铺满主屏（全屏、无边框）。测试实例可以用 PERCH_WINDOW_RECT="x,y,w,h"
      改成普通窗口摆到指定位置（放到屏幕外，不打扰正在用电脑的人）。
   3. 收起：主窗口藏起来（不是最小化，回来是瞬间的），换一个总在最前、透明底、
      不占任务栏的小窗口（悬浮按钮 /orb.html）。两边经 Wails 事件说话：
        前端  → perch:stow {x,y}            收起，按钮摆在 x,y
        前端  → perch:orb-state {...}       在跑 / 等你 / 气泡，转给按钮窗口
        按钮  → perch:orb-click              回到台面
        按钮  → perch:orb-moved {x,y}        拖完的新位置（主窗口记下来）
        Go    → perch:unstowed {x,y}         告诉主窗口已经回来了（顺带按钮位置） */

const deskWallpaperRoute = "/__desk/wallpaper"

// deskMiddleware 只接管壁纸这一条路由，其余请求照常交给内嵌资产。
func deskMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != deskWallpaperRoute {
			next.ServeHTTP(w, r)
			return
		}
		p := deskWallpaperPath()
		if p == "" {
			http.NotFound(w, r)
			return
		}
		f, err := os.Open(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		// TranscodedWallpaper 没有扩展名：按内容判断类型，别让 WebView 当成下载。
		head := make([]byte, 512)
		n, _ := f.Read(head)
		ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(p)))
		if ct == "" {
			ct = http.DetectContentType(head[:n])
		}
		_, _ = f.Seek(0, 0)
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, "", time.Time{}, f)
	})
}

var lastWallpaperPing atomic.Int64

// deskWallpaperChanged 由窗口过程在收到「壁纸换了」的广播时调用。每个顶层窗口都会
// 收到一份，所以 300ms 内只发一次。
func deskWallpaperChanged() {
	now := time.Now().UnixMilli()
	if now-lastWallpaperPing.Swap(now) < 300 {
		return
	}
	if app := application.Get(); app != nil {
		log.Printf("[desk] 桌面壁纸换了：%s", deskWallpaperPath())
		app.Event.Emit("perch:wallpaper", now)
	}
}

// deskWindowRect 读 PERCH_WINDOW_RECT="x,y,w,h"（测试实例用）；没设返回 ok=false。
func deskWindowRect() (x, y, w, h int, ok bool) {
	parts := strings.Split(os.Getenv("PERCH_WINDOW_RECT"), ",")
	if len(parts) != 4 {
		return 0, 0, 0, 0, false
	}
	v := make([]int, 4)
	for i, s := range parts {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err != nil {
			return 0, 0, 0, 0, false
		}
		v[i] = n
	}
	if v[2] < 400 || v[3] < 300 {
		return 0, 0, 0, 0, false
	}
	return v[0], v[1], v[2], v[3], true
}

// deskMainWindowOptions：台面窗口无边框、铺满主屏（全屏，盖住任务栏 —— 台面本身就是
// 一整张盖住桌面的面板；暂时不用就「收起」成悬浮按钮）。
//
// ⚠️ 不要设 DisableFramelessWindowDecorations：那个开关会连 Win11 的阴影一起去掉，
// 普通窗口模式（测试实例）下就成了贴死的方片。
func deskMainWindowOptions() application.WebviewWindowOptions {
	o := application.WebviewWindowOptions{
		Title:      "Perch",
		Width:      1440,
		Height:     900,
		Frameless:  true,
		StartState: application.WindowStateFullscreen,
		// 拖文件进台面（比如拖一个文件夹进来当项目）由前端按落点决定怎么处理。
		EnableFileDrop: true,
		URL:            "/",
	}
	if x, y, w, h, ok := deskWindowRect(); ok {
		o.StartState = application.WindowStateNormal
		o.InitialPosition = application.WindowXY
		o.X, o.Y, o.Width, o.Height = x, y, w, h
		log.Printf("[desk] PERCH_WINDOW_RECT：普通窗口 %d,%d %dx%d（测试用）", x, y, w, h)
	}
	return o
}

// orbSize 是悬浮按钮窗口的边长。按钮本身 64px，四周留出光环、角标和跳一下的余量。
// 提示和气泡要往旁边伸，那时由按钮页面自己请求加宽（perch:orb-size）。
const orbSize = 92

type deskStow struct {
	app  *application.App
	main *application.WebviewWindow

	mu  sync.Mutex
	orb *application.WebviewWindow
	x   int
	y   int
	w   int
}

func newDeskStow(app *application.App, main *application.WebviewWindow) *deskStow {
	d := &deskStow{app: app, main: main, w: orbSize}
	app.Event.On("perch:stow", func(e *application.CustomEvent) { d.stow(e.Data) })
	app.Event.On("perch:orb-click", func(*application.CustomEvent) { d.unstow() })
	app.Event.On("perch:orb-moved", func(e *application.CustomEvent) { d.moved(e.Data) })
	app.Event.On("perch:orb-size", func(e *application.CustomEvent) { d.resize(e.Data) })
	app.Event.On("perch:orb-state", func(e *application.CustomEvent) {
		d.mu.Lock()
		orb := d.orb
		d.mu.Unlock()
		if orb != nil {
			orb.EmitEvent("perch:orb-state", e.Data)
		}
	})
	return d
}

func intField(data any, key string) (int, bool) {
	m, ok := data.(map[string]any)
	if !ok {
		return 0, false
	}
	switch v := m[key].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	}
	return 0, false
}

func (d *deskStow) stow(data any) {
	x, okx := intField(data, "x")
	y, oky := intField(data, "y")
	d.mu.Lock()
	if okx && oky {
		d.x, d.y = x, y
	}
	if d.orb == nil {
		d.orb = d.app.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:            "orb",
			Title:           "Perch",
			Width:           orbSize,
			Height:          orbSize,
			Frameless:       true,
			AlwaysOnTop:     true,
			DisableResize:   true,
			BackgroundType:  application.BackgroundTypeTransparent,
			InitialPosition: application.WindowXY,
			X:               d.x,
			Y:               d.y,
			URL:             "/orb.html",
			Windows:         application.WindowsWindow{HiddenOnTaskbar: true},
		})
	}
	orb := d.orb
	d.w = orbSize
	ox, oy := d.x, d.y
	d.mu.Unlock()
	orb.SetSize(orbSize, orbSize)
	orb.SetPosition(ox, oy)
	d.main.Hide()
	orb.Show()
	log.Printf("[desk] 收起：主窗口藏起，悬浮按钮在 %d,%d", ox, oy)
}

func (d *deskStow) unstow() {
	d.mu.Lock()
	orb := d.orb
	x, y := d.x, d.y
	d.mu.Unlock()
	if orb != nil {
		orb.Hide()
	}
	d.main.Show()
	d.main.Focus()
	d.main.EmitEvent("perch:unstowed", map[string]int{"x": x, "y": y})
	log.Printf("[desk] 回到台面")
}

func (d *deskStow) moved(data any) {
	x, okx := intField(data, "x")
	y, oky := intField(data, "y")
	if !okx || !oky {
		return
	}
	d.mu.Lock()
	d.x, d.y = x, y
	d.mu.Unlock()
}

// resize：按钮页面要显示提示 / 气泡时请求加宽，「往屏幕里面」伸 —— 贴右边时窗口
// 左边往左挪，贴左边时只把右边往外伸。
func (d *deskStow) resize(data any) {
	w, ok := intField(data, "w")
	if !ok {
		return
	}
	left, _ := intField(data, "left")
	d.mu.Lock()
	orb := d.orb
	if orb == nil {
		d.mu.Unlock()
		return
	}
	if w < orbSize {
		w = orbSize
	}
	x := d.x
	if left == 1 {
		x = d.x - (w - orbSize)
	}
	d.w = w
	d.mu.Unlock()
	orb.SetSize(w, orbSize)
	orb.SetPosition(x, d.y)
}
