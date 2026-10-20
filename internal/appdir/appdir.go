// Package appdir 管 Perch 自己的落点，以及 Claude 状态根的取法。
//
// 这里只回答"路径在哪"，不读写业务数据。所有路径都从系统目录/环境变量现算，
// 代码里不写死任何本机绝对路径。
package appdir

import (
	"os"
	"path/filepath"
	"strings"
)

// PerchDirName 是 %APPDATA% 下属于 Perch 的那一层目录名。
const PerchDirName = "Perch"

// Home 返回用户主目录。拿不到时返回错误，调用方决定怎么兜底。
func Home() (string, error) {
	return os.UserHomeDir()
}

// HomeOrDot 是"拿不到主目录就直接落在当前目录"的最后兜底。
func HomeOrDot() string {
	if home, err := Home(); err == nil {
		return home
	}
	return "."
}

// ConfigDir 返回系统的用户配置目录（Windows 上是 %APPDATA%）。
func ConfigDir() (string, error) {
	return os.UserConfigDir()
}

// PerchDir 返回 %APPDATA%\Perch；不保证目录已经存在。
func PerchDir() (string, error) {
	d, err := ConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, PerchDirName), nil
}

// PerchFile 返回 %APPDATA%\Perch 下某个文件的完整路径。
func PerchFile(name string) (string, error) {
	d, err := PerchDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, name), nil
}

// ClaudeState 是 Claude Code 自己的状态根：环境里有 CLAUDE_CONFIG_DIR 就用它，
// 否则 <用户主目录>\.claude。拿不到主目录时退回相对路径。
func ClaudeState() string {
	if v := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); v != "" {
		return v
	}
	if home, err := Home(); err == nil {
		return filepath.Join(home, ".claude")
	}
	return ".claude"
}

// BuiltinDefaultWorkspace 是不带任何设置时的默认工作区：<用户主目录>\Documents\Perch。
// 第二个返回值 false = 拿不到主目录，调用方按"没有它"处理。
//
// ⚠️ 中文 Windows 上资源管理器把 Documents 显示成「文档」，但真实目录名仍是
// Documents（显示名在 desktop.ini 里）；拼「文档」会建出一个谁也看不见的新目录。
func BuiltinDefaultWorkspace() (string, bool) {
	home, err := Home()
	if err != nil || home == "" {
		return "", false
	}
	return filepath.Join(home, "Documents", PerchDirName), true
}
