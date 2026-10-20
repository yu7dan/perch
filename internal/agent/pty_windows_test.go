//go:build windows

package agent

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/UserExistsError/conpty"
)

// 真机测试需要一个真实终端来跑 TUI。生产代码里这层归宿主（Perch 的
// pty_windows.go）；这里给 opt-in 的集成测试留一份最小实现。

type testPTY struct {
	cpty *conpty.ConPty
	wmu  sync.Mutex
}

func (p *testPTY) Read(b []byte) (int, error) { return p.cpty.Read(b) }
func (p *testPTY) Write(b []byte) (int, error) {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	return p.cpty.Write(b)
}
func (p *testPTY) Close() error { return p.cpty.Close() }
func (p *testPTY) Pid() int     { return p.cpty.Pid() }
func (p *testPTY) Wait(ctx context.Context) (uint32, error) {
	return p.cpty.Wait(ctx)
}

func startPTY(exe string, args []string, cwd string, env []string, cols, rows int) (*testPTY, error) {
	if !conpty.IsConPtyAvailable() {
		return nil, fmt.Errorf("ConPTY 不可用")
	}
	c, err := conpty.Start(
		testCommandLine(exe, args),
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return nil, fmt.Errorf("启动 %q 失败: %w", exe, err)
	}
	return &testPTY{cpty: c}, nil
}

func testCommandLine(exe string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, testQuoteArg(exe))
	for _, a := range args {
		parts = append(parts, testQuoteArg(a))
	}
	return strings.Join(parts, " ")
}

func testQuoteArg(arg string) string {
	if arg == "" {
		return `""`
	}
	if !strings.ContainsAny(arg, " \t\n\v\"") {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	backslashes := 0
	for _, r := range arg {
		switch r {
		case '\\':
			backslashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, backslashes*2+1))
			backslashes = 0
			b.WriteByte('"')
		default:
			b.WriteString(strings.Repeat(`\`, backslashes))
			backslashes = 0
			b.WriteRune(r)
		}
	}
	b.WriteString(strings.Repeat(`\`, backslashes*2))
	b.WriteByte('"')
	return b.String()
}
