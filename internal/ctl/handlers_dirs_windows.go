//go:build windows

package ctl

import (
	"strings"

	"golang.org/x/sys/windows"
)

func listDrives() []dirEntry {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var out []dirEntry
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		// 光驱 / 断开的网络盘不列：点进去只会是一句「设备未就绪」。
		t := windows.GetDriveType(windows.StringToUTF16Ptr(root))
		if t == windows.DRIVE_NO_ROOT_DIR || t == windows.DRIVE_CDROM || t == windows.DRIVE_UNKNOWN {
			continue
		}
		out = append(out, dirEntry{Name: root, Path: root})
	}
	return out
}

// 常用位置用系统的已知文件夹（桌面 / 文档可能被 OneDrive 重定向过，别自己拼 %USERPROFILE%\Desktop）。
func browsePlaces() []dirEntry {
	var out []dirEntry
	for _, k := range []struct {
		name string
		id   *windows.KNOWNFOLDERID
	}{{"桌面", windows.FOLDERID_Desktop}, {"文档", windows.FOLDERID_Documents}, {"下载", windows.FOLDERID_Downloads}} {
		if p, err := windows.KnownFolderPath(k.id, 0); err == nil && p != "" {
			out = append(out, dirEntry{Name: k.name, Path: p})
		}
	}
	return out
}

func hiddenDir(full, name string) bool {
	if strings.HasPrefix(name, "$") {
		return true
	}
	p, err := windows.UTF16PtrFromString(full)
	if err != nil {
		return false
	}
	a, err := windows.GetFileAttributes(p)
	if err != nil {
		return false
	}
	return a&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) != 0
}
