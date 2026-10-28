//go:build perch_embedded_hook

package main

import _ "embed"

// 单文件发行版：构建脚本先把 perch-bg.exe 放到 hookbin/，和 hook 接收器一起嵌进来
// （同一个构建标签：发行版要么都嵌、要么都不嵌）。
//
//go:embed hookbin/perch-bg.exe
var embeddedBgCLI []byte
