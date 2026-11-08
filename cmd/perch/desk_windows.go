//go:build windows

package main

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

const (
	wmSettingChange     = 0x001A
	spiSetDeskWallpaper = 0x0014
)

// deskWallpaperPath 返回当前桌面壁纸的文件。注册表里的 WallPaper 是用户选的那张；
// 幻灯片 / Spotlight 时它可能是空的或指向已删除的文件，那就退到系统转码后的那份
// （%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper，没有扩展名）。
func deskWallpaperPath() string {
	if k, err := registry.OpenKey(registry.CURRENT_USER, `Control Panel\Desktop`, registry.QUERY_VALUE); err == nil {
		v, _, err := k.GetStringValue("WallPaper")
		k.Close()
		if err == nil && v != "" {
			if st, err := os.Stat(v); err == nil && !st.IsDir() {
				return v
			}
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		t := filepath.Join(home, "AppData", "Roaming", "Microsoft", "Windows", "Themes", "TranscodedWallpaper")
		if st, err := os.Stat(t); err == nil && !st.IsDir() {
			return t
		}
	}
	return ""
}

// perchWndProc 是整个应用的窗口过程钩子：先看是不是「壁纸换了」的广播，
// 再交给输入法那一条（ime_refocus_windows.go）。都不吞消息。
func perchWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) (uintptr, bool) {
	if msg == wmSettingChange && wParam == spiSetDeskWallpaper {
		deskWallpaperChanged()
	}
	// 台面被点到前面：贴在块里的别人的窗口要回到台面之上（desk_native.go）
	if msg == wmActivate && wParam&0xFFFF != 0 && deskNativeRef != nil && hwnd == hwndOf(deskNativeRef.main) {
		go deskNativeRef.onMainActivated()
	}
	return imeRefocusInterceptor(hwnd, msg, wParam, lParam)
}
