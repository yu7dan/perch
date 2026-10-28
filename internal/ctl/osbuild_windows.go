//go:build windows

package ctl

import "golang.org/x/sys/windows"

// osBuild 是 Windows 的内部版本号（26200 之类）。前端拿它填 xterm 的 windowsPty，
// xterm 按它决定 ConPTY 下的重排 / 折行规则（Orca windows-pty-compatibility.ts 同一做法）。
func osBuild() int {
	return int(windows.RtlGetVersion().BuildNumber)
}
