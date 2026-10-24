//go:build windows

package main

import (
	"fmt"
	"log"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

// webView2Missing follows magpie's proven check: Wails already asked the
// registry; a missing key means "unknown", not "missing", because refusing
// to start a working app is worse than the old silent failure. A present
// key with an empty version is the definite "runtime not installed".
func webView2Missing(info map[string]any) bool {
	v, ok := info["WebView2"]
	return ok && fmt.Sprint(v) == ""
}

// webView2Check runs before app.Run. Without the runtime Wails would exit
// while making its first window, with nothing on screen to explain why.
// A native MessageBox is deliberate: it is available before any webview.
func webView2Check(app *application.App) bool {
	if !webView2Missing(app.Env.Info().PlatformInfo) {
		return true
	}
	log.Printf("[perch] 缺少 WebView2 Runtime；无法创建窗口。下载页：%s", webView2Page)
	if webView2Box(webView2Title, fmt.Sprintf(webView2Body, webView2Page)) == idYes {
		if err := windows.ShellExecute(0, windows.StringToUTF16Ptr("open"),
			windows.StringToUTF16Ptr(webView2Page), nil, nil, windows.SW_SHOWNORMAL); err != nil {
			log.Printf("[perch] 打开 WebView2 下载页失败：%v", err)
		}
	}
	return false
}

const (
	webView2Page  = "https://developer.microsoft.com/microsoft-edge/webview2/"
	webView2Title = "Perch needs WebView2"
	webView2Body  = "Perch's window needs Microsoft Edge WebView2 Runtime, which is not installed on this computer.\r\n\r\n" +
		"Install it from:\r\n%s\r\n\r\nor in a terminal:\r\nwinget install Microsoft.EdgeWebView2Runtime\r\n\r\n" +
		"Open the download page now?"
)

const (
	mbYesNo          = 0x00000004
	mbIconError      = 0x00000010
	mbSetForeground  = 0x00010000
	mbTopmost        = 0x00040000
	idYes            = 6
	webView2BoxStyle = mbYesNo | mbIconError | mbSetForeground | mbTopmost
)

var procMessageBoxW = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW")

func webView2Box(title, body string) int {
	r, _, _ := procMessageBoxW.Call(0,
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(body))),
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(title))),
		webView2BoxStyle)
	return int(r)
}
