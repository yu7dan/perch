//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

// autostartName 是 Run 里那一项的名字。测试实例（perch.termtest.exe）用另一个名字，
// 绝不去改真 Perch 的那一项。
func autostartName(exe string) string {
	if strings.Contains(strings.ToLower(filepath.Base(exe)), "termtest") {
		return "Perch (termtest)"
	}
	return "Perch"
}

func setAutoStart(on bool) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	name := autostartName(exe)
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		log.Printf("[desk] 开机启动：打不开注册表 Run 键：%v", err)
		return
	}
	defer k.Close()
	if on {
		want := `"` + exe + `"`
		if cur, _, err := k.GetStringValue(name); err == nil && cur == want {
			return
		}
		if err := k.SetStringValue(name, want); err != nil {
			log.Printf("[desk] 开机启动：写不进去：%v", err)
			return
		}
		log.Printf("[desk] 开机启动：开（%s = %s）", name, want)
		return
	}
	if _, _, err := k.GetStringValue(name); err != nil {
		return // 本来就没有
	}
	if err := k.DeleteValue(name); err != nil {
		log.Printf("[desk] 开机启动：删不掉：%v", err)
		return
	}
	log.Printf("[desk] 开机启动：关（删掉 %s）", name)
}
