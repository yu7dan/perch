//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// 台面只在 Windows 上贴外来窗口；别的平台全是空实现（编译得过就行）。

func nativeClientOrigin(*application.WebviewWindow) (int, int)  { return 0, 0 }
func nativeSetOwner(_, _ *application.WebviewWindow)            {}
func nativeMove(*application.WebviewWindow, int, int, int, int) {}
func nativeIsWindow(uintptr) bool                               { return false }
func nativeMoveForeign(uintptr, int, int, int, int) bool        { return false }
func nativeSendBehind(uintptr, *application.WebviewWindow)      {}
func nativeRaiseOver(*application.WebviewWindow, []uintptr)     {}
func nativeRestoreIfNeeded(uintptr)                             {}
func nativeMinimize(uintptr) bool                               { return false }
func nativePopOut(uintptr)                                      {}
func nativePostClose(uintptr)                                   {}
func nativeWindowTitle(uintptr) string                          { return "" }
func nativeLaunch(string)                                       {}
func nativeLaunchAndFind(string, string) (uintptr, string)      { return 0, "unsupported" }
func nativeAppList(bool, func([]nativeApp)) ([]nativeApp, bool) { return []nativeApp{}, false }
func appIconPath(string) string                                 { return "" }
func nativeWindowSize(uintptr) (int, int)                       { return 0, 0 }

type rect struct{ L, T, R, B int32 }

func nativeFillMonitor(*application.WebviewWindow) (bool, rect, rect) { return false, rect{}, rect{} }
func nativeHideOthers(map[uintptr]bool) []uintptr                     { return nil }
func nativeRestoreOthers([]uintptr)                                   {}

func glassCreate(bool) uintptr                                                      { return 0 }
func glassPlace(uintptr, *application.WebviewWindow, int, int, int, int, int, bool) {}
func glassHide(uintptr)                                                             {}
func glassDestroy(uintptr)                                                          {}

func nativeCursorPos() (int, int, bool)                    { return 0, 0, false }
func nativeIsClickThrough(*application.WebviewWindow) bool { return false }
func nativeLButtonDown() bool                              { return false }
func nativeClickThrough(*application.WebviewWindow, bool)  {}
