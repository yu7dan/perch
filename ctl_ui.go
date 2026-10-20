package main

// ctl.UI 的 Wails 实现。internal/ctl 不认识 Wails：它只声明"打开网页 /
// 选目录 / 打开路径 / 闪任务栏 / 关窗"这五个动作，这里用 globalApp /
// mainWindow 把它们接上。6b 把组合根搬进 cmd/perch 时，这个文件原样跟过去。

import (
	"log"
	"strings"

	"github.com/yu7dan/perch/internal/ctl"
)

type wailsUI struct{}

func (wailsUI) OpenURL(url string) error {
	if globalApp == nil {
		return ctl.ErrNoWindow
	}
	return globalApp.Browser.OpenURL(url)
}

// ChooseDirectory 打开系统文件夹选择器。取消在 go-common-file-dialog 里是
// **一个 error**（原文 "cancelled by user"），这里归一成 ctl.ErrPickerCancelled：
// 编排层按语义判"取消"，不去猜错误文案。
func (wailsUI) ChooseDirectory(title string) (string, error) {
	if globalApp == nil {
		return "", ctl.ErrNoWindow
	}
	sel, err := globalApp.Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		SetTitle(title).
		PromptForSingleSelection()
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "cancel") {
			return "", ctl.ErrPickerCancelled
		}
		return "", err
	}
	return sel, nil
}

func (wailsUI) OpenPath(mode, path string) { openPath(mode, path) }

func (wailsUI) Flash(on bool) {
	if mainWindow == nil {
		log.Printf("[web] attention 要闪任务栏，但主窗口还没拿到")
		return
	}
	mainWindow.Flash(on)
}

func (wailsUI) CloseWindow() {
	if mainWindow != nil {
		mainWindow.Close()
	}
}

func (wailsUI) EmitCloseRequest() {
	if mainWindow != nil {
		mainWindow.EmitEvent("perch:close-request")
	}
}
