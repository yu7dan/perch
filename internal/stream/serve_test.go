package stream

import (
	"encoding/json"
	"io"
	"testing"
)

// scriptedConn 按顺序吐出预置帧，然后报 EOF。不碰任何真实流。
type scriptedConn struct {
	frames [][]byte
	i      int
}

func (c *scriptedConn) Send([]byte) error { return nil }
func (c *scriptedConn) Close() error      { return nil }
func (c *scriptedConn) Receive() ([]byte, error) {
	if c.i >= len(c.frames) {
		return nil, io.EOF
	}
	f := c.frames[c.i]
	c.i++
	return f, nil
}

func ctrlFrame(v any) []byte {
	b, _ := json.Marshal(v)
	return append([]byte{CtrlPrefix}, b...)
}

// 握手只认 resize，但**不许吃掉**别的帧：它们要按原顺序交还给收包循环。
// 这是 2026-10-15 那个"整条前端→后端通道看起来是死的"的直接回归测试。
func TestAwaitInitialSizePreservesPendingFrames(t *testing.T) {
	conn := &scriptedConn{frames: [][]byte{
		ctrlFrame(map[string]any{"type": "log", "msg": "fit=..."}),
		[]byte("keystrokes"),
		ctrlFrame(map[string]any{"type": "resize", "cols": 101, "rows": 37}),
	}}
	s := New(conn, Callbacks{})
	defer s.Close()

	cols, rows, pending, err := s.AwaitInitialSize()
	if err != nil {
		t.Fatalf("AwaitInitialSize: %v", err)
	}
	if cols != 101 || rows != 37 {
		t.Fatalf("尺寸 = %dx%d，要 101x37", cols, rows)
	}
	if len(pending) != 2 {
		t.Fatalf("pending = %d 帧，要 2 帧", len(pending))
	}
	if pending[0][0] != CtrlPrefix || string(pending[1]) != "keystrokes" {
		t.Fatalf("pending 顺序/内容变了：%q / %q", pending[0], pending[1])
	}
}

// 读协程关掉通道时，握手要返回错误而不是永远等（否则这一格没有 PTY）。
func TestAwaitInitialSizeReportsClosedStream(t *testing.T) {
	s := New(&scriptedConn{}, Callbacks{})
	defer s.Close()
	if _, _, _, err := s.AwaitInitialSize(); err == nil {
		t.Fatal("空流应返回错误")
	}
}
