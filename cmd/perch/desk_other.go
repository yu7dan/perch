//go:build !windows

package main

// 壁纸与窗口过程钩子只在 Windows 上有意义；别的平台没有壁纸可读，台面退回渐变背景。
func deskWallpaperPath() string { return "" }

var perchWndProc func(hwnd uintptr, msg uint32, wParam, lParam uintptr) (uintptr, bool)
