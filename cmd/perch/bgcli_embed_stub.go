//go:build !perch_embedded_hook

package main

// 开发构建：用 build\perch-bg.exe（主程序旁边那一份），见 session.InstallBgCLI。
var embeddedBgCLI []byte
