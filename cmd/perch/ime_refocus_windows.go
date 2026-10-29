//go:build windows

package main

import (
	"log"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

// 切到别的应用再点回来，中文输入法的候选框会浮在屏幕 (0,0)，页面一个
// compositionstart 都收不到（按键是 229，字进不了输入框）。实测（2026-10-29，
// Win11 26200，微软拼音）：
//
//   - 文字焦点一直在终端的 textarea 上，原生焦点也在 WebView2 里，看上去都对；
//   - 页面里 blur 再 focus（Orca 只在 macOS 用的那招）、挪窗口 1px 都**没用**；
//   - 激活后过一会儿**再把焦点交给 WebView2 一次**就好了。
//
// Wails 在 WM_SETFOCUS 里会调 MoveFocus(PROGRAMMATIC)，但那一次太早：WebView2
// 自己随后的激活处理把输入法（TSF）和页面的关联弄丢了。同一现象的上游报告：
// tauri-apps/wry#1908、MicrosoftEdge/WebView2Feedback#5675（都未修）。
//
// 做法：主窗口一被激活，等 imeRefocusDelay，如果它**还在前台**，就在 UI 线程
// SetFocus(主窗口) —— 让 Wails 自己的 WM_SETFOCUS 再调一次 MoveFocus。
// MoveFocus(PROGRAMMATIC) 回到的是先前聚焦的元素，所以搜索框、重命名框不会被拽走。
// 不用 window.Focus()：它会先 SetForegroundWindow，用户这 150ms 里切走的话会被抢回前台。
const imeRefocusDelay = 150 * time.Millisecond

const (
	wmActivate  = 0x0006
	waInactive  = 0
	imeLogLimit = 3
)

var (
	user32                 = windows.NewLazySystemDLL("user32.dll")
	procGetForegroundWnd   = user32.NewProc("GetForegroundWindow")
	procSetFocus           = user32.NewProc("SetFocus")
	imeRefocusMainHwnd     atomic.Uintptr
	imeRefocusLogRemaining atomic.Int32
)

func init() { imeRefocusLogRemaining.Store(imeLogLimit) }

// imeRefocusInterceptor 挂在 application.Options.Windows.WndProcInterceptor 上，
// 只看、不吞消息（总是返回 false，Wails 照常处理）。
func imeRefocusInterceptor(hwnd uintptr, msg uint32, wParam, _ uintptr) (uintptr, bool) {
	if msg != wmActivate || wParam&0xffff == waInactive {
		return 0, false
	}
	// 进程里收到 WM_ACTIVATE 的只有主窗口（Wails 的消息窗口不会被激活）；第一次见到就记下来。
	if imeRefocusMainHwnd.Load() == 0 {
		imeRefocusMainHwnd.Store(hwnd)
	}
	if hwnd != imeRefocusMainHwnd.Load() {
		return 0, false
	}
	go func() {
		time.Sleep(imeRefocusDelay)
		application.InvokeAsync(func() {
			if fg, _, _ := procGetForegroundWnd.Call(); fg != hwnd {
				return
			}
			procSetFocus.Call(hwnd)
			if imeRefocusLogRemaining.Add(-1) >= 0 {
				log.Printf("[ime] 窗口激活后重新把焦点交给 WebView2（修输入法候选框跑到屏幕左上角）")
			}
		})
	}()
	return 0, false
}
