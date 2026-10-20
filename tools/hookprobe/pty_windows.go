//go:build windows

package main

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/UserExistsError/conpty"
)

// 从主程序的 pty_windows.go 逐字拷来（探针不重写已有一遍的代码）。
type ptySession struct {
	cpty *conpty.ConPty
	wmu  sync.Mutex
}

func quoteArg(arg string) string {
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

func buildCommandLine(exe string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, quoteArg(exe))
	for _, a := range args {
		parts = append(parts, quoteArg(a))
	}
	return strings.Join(parts, " ")
}

func startPTY(exe string, args []string, cwd string, env []string, cols, rows int) (*ptySession, error) {
	if !conpty.IsConPtyAvailable() {
		return nil, fmt.Errorf("ConPTY 不可用")
	}
	cmdline := buildCommandLine(exe, args)
	c, err := conpty.Start(
		cmdline,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return nil, fmt.Errorf("启动 %q 失败: %w", cmdline, err)
	}
	return &ptySession{cpty: c}, nil
}

func (p *ptySession) Read(b []byte) (int, error) { return p.cpty.Read(b) }

func (p *ptySession) Write(b []byte) (int, error) {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	return p.cpty.Write(b)
}
func (p *ptySession) Close() error { return p.cpty.Close() }
func (p *ptySession) Pid() int     { return p.cpty.Pid() }
func (p *ptySession) Wait(ctx context.Context) (uint32, error) {
	return p.cpty.Wait(ctx)
}
