//go:build !windows

package main

// 开机启动只在 Windows 上做（Run 注册表项）。
func setAutoStart(bool) {}
