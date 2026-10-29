//go:build !windows

package main

// 只有 Windows 的 WebView2 有「激活后输入法丢关联」的问题（见 ime_refocus_windows.go）。
var imeRefocusInterceptor func(hwnd uintptr, msg uint32, wParam, lParam uintptr) (uintptr, bool)
