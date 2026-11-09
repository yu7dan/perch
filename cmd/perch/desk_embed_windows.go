//go:build windows

package main

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var (
	procGetCursorPos               = user32.NewProc("GetCursorPos")
	procGetAsyncKeyState           = user32.NewProc("GetAsyncKeyState")
	procSetLayeredWindowAttributes = user32.NewProc("SetLayeredWindowAttributes")
)

const (
	wsExLayered     = 0x00080000
	wsExTransparent = 0x00000020
	lwaAlpha        = 0x2
)

func nativeCursorPos() (int, int, bool) {
	var p struct{ X, Y int32 }
	if r, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&p))); r == 0 {
		return 0, 0, false
	}
	return int(p.X), int(p.Y), true
}

// 左键（逻辑左键：左右手互换了也是「主键」）现在是不是按着
func nativeLButtonDown() bool {
	r, _, _ := procGetAsyncKeyState.Call(0x01)
	return r&0x8000 != 0
}

// nativeClickThrough：整扇窗口点得穿 / 点不穿。WS_EX_TRANSPARENT 要配 WS_EX_LAYERED 才对别的进程的窗口生效；
// 分层窗口不设一次 SetLayeredWindowAttributes 就整个不画 —— 设成不透明（alpha 255），画面交给 WebView2 自己的透明。
// 切回点不穿时只摘 TRANSPARENT，LAYERED 留着（来回加减分层会闪一下）。
func nativeClickThrough(w *application.WebviewWindow, on bool) {
	h := hwndOf(w)
	if h == 0 {
		return
	}
	ex, _, _ := procGetWindowLongPtr.Call(h, gwlExStyle)
	if on {
		if ex&wsExLayered == 0 {
			procSetWindowLongPtr.Call(h, gwlExStyle, ex|wsExLayered)
			procSetLayeredWindowAttributes.Call(h, 0, 255, lwaAlpha)
		}
		ex, _, _ = procGetWindowLongPtr.Call(h, gwlExStyle)
		procSetWindowLongPtr.Call(h, gwlExStyle, ex|wsExTransparent)
	} else {
		procSetWindowLongPtr.Call(h, gwlExStyle, ex&^wsExTransparent)
	}
}
