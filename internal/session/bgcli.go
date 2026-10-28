package session

// perch-bg 命令行的安装（Bot Group C，2026-10-28）：和 hook 接收器同一个做法。
//
// 成员格的 PATH 里只加一个目录：<用户缓存目录>\Perch\bin（隔离测试实例里是它自己的 LOCALAPPDATA）。
// 发行版把 perch-bg.exe 内嵌在主程序里，启动时释放到那里；开发构建从主程序旁边
// （build\perch-bg.exe）复制过去 —— 不把整个 build 目录暴露给 agent。
// 内容相同就不重写；先写临时文件再 rename，避免 agent 跑到半截的 exe。

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
)

const BgCLIName = "perch-bg.exe"

// InstallBgCLI 放好 perch-bg.exe，返回它所在的目录（要加进成员格 PATH 的那个）。
// embedded 为空 = 开发构建，从主程序旁边找。找不到返回空串（成员格照样起，只是 perch-bg 不可用）。
func InstallBgCLI(embedded []byte) string {
	data := embedded
	if len(data) == 0 {
		exe, err := os.Executable()
		if err != nil {
			return ""
		}
		data, err = os.ReadFile(filepath.Join(filepath.Dir(exe), BgCLIName))
		if err != nil {
			log.Printf("[perch] 没找到 %s（Bot Group 的派活命令不可用）：%v", BgCLIName, err)
			return ""
		}
	}
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(base, "Perch", "bin")
	p := filepath.Join(dir, BgCLIName)
	if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, data) {
		return dir
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return ""
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		// 有 agent 正开着它（Windows 不让换正在运行的 exe）：旧的那份还能用
		log.Printf("[perch] 更新 %s 没成（可能正在被用）：%v", p, err)
		return dir
	}
	log.Printf("[perch] 已放好派活命令：%s", p)
	return dir
}
