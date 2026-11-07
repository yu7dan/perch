package main

import (
	"os"
	"strconv"
)

// devtoolsArgs 给自动验收开 WebView2 的调试端口：设了 PERCH_DEVTOOLS_PORT 才开，
// 平常启动不带任何额外参数。验收脚本经这个端口驱动真产品，跑和定稿模拟
// （spec/desk）同一套导览，再拿两边同一步的截图对比。
//
// ⚠️ 不能用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量：Wails 建 WebView2
// 环境前会把它清空（internal/webview2/webviewloader/env_create.go），只认
// application.WindowsOptions.AdditionalBrowserArgs。
func devtoolsArgs() []string {
	p, err := strconv.Atoi(os.Getenv("PERCH_DEVTOOLS_PORT"))
	if err != nil || p <= 0 || p > 65535 {
		return nil
	}
	return []string{"--remote-debugging-port=" + strconv.Itoa(p)}
}
