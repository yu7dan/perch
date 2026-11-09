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
	"github.com/wailsapp/wails/v3/pkg/events"
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
        前端  → perch:orb-state {...}       在跑 / 等你 / 气泡（Wails 的事件本来就广播到每个窗口，按钮页直接收）
        按钮  → perch:orb-click              回到台面
        按钮  → perch:orb-moved {x,y}        拖完的新位置（主窗口记下来）
        Go    → perch:unstowed {x,y}         告诉主窗口已经回来了（顺带按钮位置）
        Go    → perch:orb-shown              按钮窗口复位了（页面回到初始样子）

   ⚠️ 别在 Go 里「转发」前端的事件：window.EmitEvent 发的也是应用级事件，会再回到同名监听器
   手里 —— 2026-11-08 实测一个转发器自己转自己，几十秒里起了 3.9 亿个 goroutine，进程内存耗尽崩掉。 */

const deskWallpaperRoute = "/__desk/wallpaper"
const deskAppIconRoute = "/__desk/appicon/"

// deskMiddleware 只接管壁纸这一条路由，其余请求照常交给内嵌资产。
func deskMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// /__desk/appicon/<md5>.png：启动台里每个应用自己的图标（desk_native_windows.go 扫开始菜单时存的）
		if strings.HasPrefix(r.URL.Path, deskAppIconRoute) {
			if p := appIconPath(strings.TrimPrefix(r.URL.Path, deskAppIconRoute)); p != "" {
				w.Header().Set("Cache-Control", "max-age=86400")
				http.ServeFile(w, r, p)
				return
			}
			http.NotFound(w, r)
			return
		}
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
		// 透明：台面浮在桌面上，块之外透出来的就是真桌面（壁纸、图标），不去读壁纸文件贴进来
		BackgroundType: application.BackgroundTypeTransparent,
		// 拖文件进台面（比如拖一个文件夹进来当项目）由前端按落点决定怎么处理。
		EnableFileDrop: true,
		URL:            "/",
	}
	if x, y, w, h, ok := deskWindowRect(); ok {
		o.StartState = application.WindowStateNormal
		o.InitialPosition = application.WindowXY
		o.X, o.Y, o.Width, o.Height = x, y, w, h
		// 测试实例摆在屏幕外：透明窗口在屏幕外不出帧，调试端口截图会一直等（实测卡死）。测试实例用不透明窗口，
		// 页面那边看到自己在屏幕外，会把壁纸画上当背景（只为截图对照，37/30 的 applyCfg）。
		o.BackgroundType = application.BackgroundTypeSolid
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

	mu     sync.Mutex
	orb    *application.WebviewWindow
	stowed bool
	x      int
	y      int
	w      int
}

func newDeskStow(app *application.App, main *application.WebviewWindow) *deskStow {
	d := &deskStow{app: app, main: main, w: orbSize}
	app.Event.On("perch:stow", func(e *application.CustomEvent) { d.stow(e.Data) })
	app.Event.On("perch:orb-click", func(*application.CustomEvent) { d.unstow() })
	app.Event.On("perch:orb-moved", func(e *application.CustomEvent) { d.moved(e.Data) })
	app.Event.On("perch:orb-bounds", func(e *application.CustomEvent) { d.bounds(e.Data) })
	// 关掉主窗口 = 退出 Perch。按钮窗口（哪怕藏着）也算一个窗口：它在，Wails 就不认为
	// 「最后一个窗口关了」，进程会带着它一直活着（2026-11-08 测试实例攒下了四个）。
	// 关窗确认那道 hook 在监听器之前跑，被取消的关闭走不到这里。
	main.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		d.mu.Lock()
		orb := d.orb
		d.orb = nil
		d.mu.Unlock()
		if orb != nil {
			orb.Close()
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
			// 不要系统给无边框窗口加的装饰（1px 边框、圆角、阴影、延伸进来的标题栏 —— 透明底上会露出一个框和一颗 ×）
			Windows: application.WindowsWindow{HiddenOnTaskbar: true, DisableFramelessWindowDecorations: true},
		})
	}
	orb := d.orb
	d.w = orbSize
	d.stowed = true
	ox, oy := d.x, d.y
	d.mu.Unlock()
	orb.SetSize(orbSize, orbSize)
	orb.SetPosition(ox, oy)
	d.main.Hide()
	if deskNativeRef != nil {
		deskNativeRef.stow()
		deskNativeRef.dismiss("收起台面")
	}
	if deskGlassRef != nil {
		deskGlassRef.stow()
	}
	orb.Show()
	// 按钮窗口是复用的：上一次收着时它可能正加宽着（提示 / 气泡），先让页面回到初始样子。
	orb.EmitEvent("perch:orb-shown", map[string]int{"x": ox, "y": oy})
	log.Printf("[desk] 收起：主窗口藏起，悬浮按钮在 %d,%d", ox, oy)
}

func (d *deskStow) unstow() {
	d.mu.Lock()
	orb := d.orb
	x, y := d.x, d.y
	d.stowed = false
	d.mu.Unlock()
	if orb != nil {
		orb.Hide()
	}
	if deskNativeRef != nil {
		deskNativeRef.unstow()
		deskNativeRef.summon("回到台面")
	}
	if deskGlassRef != nil {
		deskGlassRef.unstow()
	}
	d.main.Show()
	d.main.Focus()
	deskFixFill(d.main, "回到台面")
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

// bounds：按钮页面一次给出窗口该在的位置和大小（加宽 / 收窄 / 拖动都走这一条，SetBounds 一次摆好，不跳）。
func (d *deskStow) bounds(data any) {
	x, okx := intField(data, "x")
	y, oky := intField(data, "y")
	w, okw := intField(data, "w")
	h, okh := intField(data, "h")
	if !okx || !oky || !okw || !okh || w < 40 || h < 40 || w > 800 || h > 400 {
		return
	}
	d.mu.Lock()
	orb := d.orb
	stowed := d.stowed
	d.w = w
	d.mu.Unlock()
	if orb == nil || !stowed {
		return
	}
	orb.SetBounds(application.Rect{X: x, Y: y, Width: w, Height: h})
}
