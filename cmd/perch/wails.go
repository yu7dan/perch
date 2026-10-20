package main

// Wails 适配层：internal/stream 与 internal/ctl 都不认识 Wails，这里把
// 它们的 Conn / UI 接口接到 *application.StreamConn 与窗口上。

import (
	"errors"
	"io"
	"log"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/yu7dan/perch/internal/ctl"
	"github.com/yu7dan/perch/internal/winproc"
)

// pushRelay 让"控制通道还没构造好"与"后台协程已经在推消息"这两件事共存。
// 所有出站推送都先拿 relay；ctl.Server 构造后 Set 一次。
type pushRelay struct {
	mu  sync.RWMutex
	srv *ctl.Server
}

func (p *pushRelay) Push(v any) {
	p.mu.RLock()
	s := p.srv
	p.mu.RUnlock()
	if s != nil {
		s.Push(v)
	}
}

func (p *pushRelay) Set(s *ctl.Server) {
	p.mu.Lock()
	p.srv = s
	p.mu.Unlock()
}

func (p *pushRelay) Server() *ctl.Server {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.srv
}

// wailsConn 把 Wails 的流适配成 stream.Conn。
//
// ⚠️ 归一化放在这里，不放进 stream：`ErrStreamClosed` 是正常关格（前端关标签 /
// 页面重载 / 关窗）的唯一结果，stream 只该看到 io.EOF，否则它会把每次关格都
// 当成真错误记一行 —— 读日志的人很快就会不看日志了。
type wailsConn struct{ c *application.StreamConn }

func (w wailsConn) Send(b []byte) error { return w.c.Send(b) }

func (w wailsConn) Receive() ([]byte, error) {
	b, err := w.c.Receive()
	if errors.Is(err, application.ErrStreamClosed) {
		return b, io.EOF
	}
	return b, err
}

func (w wailsConn) Close() error { return w.c.Close() }

// systemUI 是 ctl.UI 的 Wails 实现（打开网页 / 选目录 / 打开路径 /
// 闪任务栏 / 关窗）。窗口是建好之后才有的，所以这里持有指针而不是值。
type systemUI struct {
	app *application.App
	win *application.WebviewWindow
}

func (u *systemUI) OpenURL(url string) error {
	if u.app == nil {
		return ctl.ErrNoWindow
	}
	return u.app.Browser.OpenURL(url)
}

// ChooseDirectory 打开系统文件夹选择器。取消在 go-common-file-dialog 里是
// **一个 error**（原文 "cancelled by user"），这里归一成 ctl.ErrPickerCancelled：
// 编排层按语义判"取消"，不去猜错误文案。
func (u *systemUI) ChooseDirectory(title string) (string, error) {
	if u.app == nil {
		return "", ctl.ErrNoWindow
	}
	sel, err := u.app.Dialog.OpenFile().
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

func (u *systemUI) OpenPath(mode, path string) { winproc.OpenPath(mode, path) }

func (u *systemUI) Flash(on bool) {
	if u.win == nil {
		log.Printf("[web] attention 要闪任务栏，但主窗口还没拿到")
		return
	}
	u.win.Flash(on)
}

func (u *systemUI) CloseWindow() {
	if u.win != nil {
		u.win.Close()
	}
}

func (u *systemUI) EmitCloseRequest() {
	if u.win != nil {
		u.win.EmitEvent("perch:close-request")
	}
}
