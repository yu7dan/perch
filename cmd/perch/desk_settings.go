package main

import (
	"log"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/yu7dan/perch/internal/settings"
)

/* 台面设置里要 Go 落实的三样（设置 › 通用 / 台面）：
   全局快捷键  —— 在别的软件里按一下：收着就回到台面；台面在后面就叫到前面；台面就在眼前就收起。
   开机启动    —— HKCU\Software\Microsoft\Windows\CurrentVersion\Run 里的一项（desk_autostart_*.go）。
   铺在哪块屏  —— 默认主显示器；设置里选了别的，就挪过去再铺满。 */

type deskSettings struct {
	app    *application.App
	stow   *deskStow
	hotkey string
	bound  bool // 真的向系统注册了（测试实例只记不注册）
}

func newDeskSettings(app *application.App, stow *deskStow) *deskSettings {
	return &deskSettings{app: app, stow: stow}
}

// apply 在启动时跑一次（old 为零值），之后每次设置改了跑一次。
func (d *deskSettings) apply(old, next settings.Settings) {
	if next.Hotkey != d.hotkey {
		d.setHotkey(next.Hotkey)
	}
	if next.AutoStart != old.AutoStart || old == (settings.Settings{}) {
		setAutoStart(next.AutoStart)
	}
	if next.Screen != old.Screen {
		d.moveToScreen(next.Screen)
	}
	if deskNativeRef != nil {
		first := old == (settings.Settings{})
		deskNativeRef.setHideOthers(next.HideOthers)
		if first || (next.HideOthers && !old.HideOthers) {
			// 启动时台面铺开（或刚打开这个开关）：后面的窗口先收起来
			time.AfterFunc(600*time.Millisecond, func() { deskNativeRef.summon("台面铺开") })
		}
	}
}

func (d *deskSettings) setHotkey(accel string) {
	if d.hotkey != "" && d.bound {
		if err := d.app.GlobalShortcut.Unregister(d.hotkey); err != nil {
			log.Printf("[desk] 注销全局快捷键 %s 失败：%v", d.hotkey, err)
		}
	}
	d.hotkey, d.bound = "", false
	if accel == "" {
		log.Printf("[desk] 全局快捷键：关闭")
		return
	}
	// 测试实例（摆在屏幕外的普通窗口）不抢全局快捷键：那是正在用电脑的人的键。
	if _, _, _, _, test := deskWindowRect(); test {
		log.Printf("[desk] 全局快捷键 %s：测试实例不注册", accel)
		d.hotkey = accel
		return
	}
	if err := d.app.GlobalShortcut.Register(accel, d.stow.toggle); err != nil {
		// 常见原因：别的软件已经占了这个组合。设置里照样记着，下次启动再试。
		log.Printf("[desk] 全局快捷键 %s 注册失败（可能被别的软件占了）：%v", accel, err)
		return
	}
	d.hotkey, d.bound = accel, true
	log.Printf("[desk] 全局快捷键：%s = 呼出 / 收起 Perch", accel)
}

// screens 是设置页「铺在哪块显示器上」的选项。
func (d *deskSettings) screens() []map[string]any {
	out := []map[string]any{}
	if d.app.Screen == nil {
		return out
	}
	for _, s := range d.app.Screen.GetAll() {
		out = append(out, map[string]any{
			"id": s.ID, "name": strings.TrimSpace(s.Name), "primary": s.IsPrimary,
			"w": s.Size.Width, "h": s.Size.Height, "scale": s.ScaleFactor,
		})
	}
	return out
}

func (d *deskSettings) moveToScreen(id string) {
	if _, _, _, _, test := deskWindowRect(); test {
		return // 测试实例是摆在指定位置的普通窗口，不挪
	}
	var target *application.Screen
	if id != "" {
		target = d.app.Screen.GetByID(id)
	}
	if target == nil {
		target = d.app.Screen.GetPrimary()
	}
	if target == nil {
		return
	}
	w := d.stow.main
	w.UnFullscreen()
	w.SetScreen(target)
	w.Fullscreen()
	log.Printf("[desk] 台面铺到显示器 %s（%s）", target.Name, target.ID)
	deskFixFill(w, "铺到显示器")
}

// deskFixFill：等「全屏」落定后量一下窗口，没正好铺满那块屏就摆正（见 nativeFillMonitor）。
func deskFixFill(w *application.WebviewWindow, why string) {
	for _, ms := range []time.Duration{300, 1200} {
		time.AfterFunc(ms*time.Millisecond, func() {
			if _, _, _, _, test := deskWindowRect(); test {
				return
			}
			if fixed, b, m := nativeFillMonitor(w); fixed {
				log.Printf("[desk] 台面窗口没铺正（%d,%d-%d,%d），摆回整块屏 %d,%d-%d,%d（%s）", b.L, b.T, b.R, b.B, m.L, m.T, m.R, m.B, why)
			}
		})
	}
}

// toggle 是全局快捷键的动作：收着 → 回来；在后面 → 叫到前面；就在眼前 → 收起（收起要知道按钮摆哪，交给页面）。
func (s *deskStow) toggle() {
	s.mu.Lock()
	stowed := s.stowed
	s.mu.Unlock()
	switch {
	case stowed:
		s.unstow()
	case !s.main.IsVisible() || !s.main.IsFocused():
		if deskNativeRef != nil {
			deskNativeRef.summon("全局快捷键")
		}
		s.main.Show()
		s.main.Focus()
		log.Printf("[desk] 全局快捷键：把台面叫到前面")
	default:
		s.main.EmitEvent("perch:hotkey-stow", nil)
	}
}
