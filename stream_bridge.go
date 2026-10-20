package main

// 标签流的旧名字接缝：流的一生在 internal/stream，Wails 适配留在这里
// （6b 搬进 cmd/perch）。stream 不认识 Wails。

import (
	"errors"
	"io"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/yu7dan/perch/internal/stream"
)

const ctrlPrefix = stream.CtrlPrefix

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
