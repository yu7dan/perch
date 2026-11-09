//go:build windows

package main

import (
	"log"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

var (
	procRegisterClassExW              = user32.NewProc("RegisterClassExW")
	procCreateWindowExW               = user32.NewProc("CreateWindowExW")
	procDestroyWindow                 = user32.NewProc("DestroyWindow")
	procDefWindowProcW                = user32.NewProc("DefWindowProcW")
	procSetWindowCompositionAttribute = user32.NewProc("SetWindowCompositionAttribute")
	procGetModuleHandleW              = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procDwmSetWindowAttribute         = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")
	procDwmExtendFrame                = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmExtendFrameIntoClientArea")
	procSendMessageW                  = user32.NewProc("SendMessageW")
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type accentPolicy struct {
	State     uint32
	Flags     uint32
	Gradient  uint32 // ABGR
	Animation uint32
}

type winCompAttrData struct {
	Attrib uint32
	Data   uintptr
	Size   uintptr
}

const (
	glassClass        = "PerchGlassPane"
	wsPopup           = 0x80000000
	wsExToolWindowG   = 0x00000080
	wsExNoActivate    = 0x08000000
	swHide            = 0
	wcaAccentPolicy   = 19
	accentAcrylicBlur = 4
)

var (
	glassClassOK bool
	// WM_NCACTIVATE 一律当「我是激活的」：系统的磨砂在不激活的窗口上会退成一块纯色，而这些小窗永远不激活。
	glassWndProc = syscall.NewCallback(func(h, msg, w, l uintptr) uintptr {
		if msg == 0x0086 { // WM_NCACTIVATE
			w = 1
		}
		r, _, _ := procDefWindowProcW.Call(h, msg, w, l)
		return r
	})
	glassClassPtr = windows.StringToUTF16Ptr(glassClass)
	glassTint     = map[uintptr]bool{}   // 小窗 → 现在是不是浅色的底
	glassCorner   = map[uintptr]uint32{} // 小窗 → 现在的 DWM 圆角设置
)

func glassRegister() bool {
	if glassClassOK {
		return true
	}
	inst, _, _ := procGetModuleHandleW.Call(0)
	wc := wndClassEx{WndProc: glassWndProc, Instance: inst, ClassName: glassClassPtr}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		log.Printf("[glass] 注册窗口类失败：%v", err)
		return false
	}
	glassClassOK = true
	return true
}

// 磨砂：客户区整个「延伸成玻璃」（不然没画的地方是一块黑），再开亚克力（糊开后面的东西 + 一点颗粒），底色几乎透明 ——
// 深浅由台面网页那层玻璃自己给。
// 试过的：① 不延伸客户区就开亚克力 → 一块不透明的黑；② Win11 的 DWMSBT 系统背景 → 不激活的窗口退成一块纯灰（这些小窗永远不激活）。
func glassAccent(h uintptr, light bool) {
	margins := [4]int32{-1, -1, -1, -1}
	procDwmExtendFrame.Call(h, uintptr(unsafe.Pointer(&margins)))
	// 圆角交给 DWM（8px）：自己用 SetWindowRgn 裁圆角，DWM 就不再给这扇窗画磨砂了（实测一块纯色）
	glassSetCorner(h, 2)       // DWMWCP_ROUND
	tint := uint32(0x10000000) // ABGR
	if light {
		tint = 0x10FFFFFF
	}
	ap := accentPolicy{State: accentAcrylicBlur, Flags: 0, Gradient: tint}
	d := winCompAttrData{Attrib: wcaAccentPolicy, Data: uintptr(unsafe.Pointer(&ap)), Size: unsafe.Sizeof(ap)}
	procSetWindowCompositionAttribute.Call(h, uintptr(unsafe.Pointer(&d)))
	glassTint[h] = light
}

func glassSetCorner(h uintptr, c uint32) {
	procDwmSetWindowAttribute.Call(h, 33, uintptr(unsafe.Pointer(&c)), 4) // DWMWA_WINDOW_CORNER_PREFERENCE
	glassCorner[h] = c
}

func glassCreate(light bool) uintptr {
	if !glassRegister() {
		return 0
	}
	inst, _, _ := procGetModuleHandleW.Call(0)
	h, _, err := procCreateWindowExW.Call(wsExToolWindowG|wsExNoActivate, uintptr(unsafe.Pointer(glassClassPtr)), 0, wsPopup,
		0, 0, 10, 10, 0, 0, inst, 0)
	if h == 0 {
		log.Printf("[glass] 建磨砂小窗失败：%v", err)
		return 0
	}
	glassAccent(h, light)
	return h
}

// glassPlace：摆到位置、放在台面窗口正下方，显示但不抢焦点。
// DWM 的圆角是 8px，块的圆角大（16px）：往里缩一点，小窗的角就整个藏在块的圆角里面，不会从块的角上露出去。
func glassPlace(h uintptr, main *application.WebviewWindow, x, y, w, ht, r int, light bool) {
	if glassTint[h] != light {
		glassAccent(h, light)
	}
	// 整屏那一块（r=0）不要圆角：铺满整屏的窗口四个角圆了，屏幕角上会露出四个小缺口
	c := uint32(1) // DWMWCP_DONOTROUND
	if r > 0 {
		c = 2
	}
	if glassCorner[h] != c {
		glassSetCorner(h, c)
	}
	in := 0
	if r > 8 {
		in = (r - 8 + 2) / 3
	}
	procSetWindowPos.Call(h, hwndOf(main), uintptr(x+in), uintptr(y+in), uintptr(w-2*in), uintptr(ht-2*in), swpNoActivate|0x0040) // SWP_SHOWWINDOW
}

func glassHide(h uintptr) { procShowWindow.Call(h, swHide) }

func glassDestroy(h uintptr) {
	procDestroyWindow.Call(h)
	delete(glassTint, h)
	delete(glassCorner, h)
}
