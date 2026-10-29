//go:build windows

package term

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/yu7dan/perch/internal/conpty"
)

// Session 包住 ConPTY，把「起一个真实终端」收敛成几个方法。
type Session struct {
	cpty *conpty.ConPty
	// wmu 串行化写入。**现在有两个 goroutine 会往同一个 PTY 写**：
	// 收包循环（用户键盘输入）和读循环（OSC 颜色查询的应答）。
	// 不串行化的话，一段按键可能被插进一条转义应答的中间，
	// 终端会把它解析成乱码 —— 而且这种交错极难复现。
	wmu sync.Mutex
}

// QuoteArg 按 Windows 命令行析取规则给单个参数加引号。
//
// ConPTY 的 Start 收的是**一整条命令行字符串**而不是 argv，
// 所以这里必须自己处理引号 —— 反斜杠和引号的交替规则是 cmd 的经典坑。
// 终局方案是永远不要走到这里（参数全部来自我们自己的描述符，不含用户输入），
// 但引号一定要写对，否则路径带空格的 agent 会静默起不来。
func QuoteArg(arg string) string {
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
			// 引号前的反斜杠要翻倍，再额外加一个转义引号本身
			b.WriteString(strings.Repeat(`\`, backslashes*2+1))
			backslashes = 0
			b.WriteByte('"')
		default:
			b.WriteString(strings.Repeat(`\`, backslashes))
			backslashes = 0
			b.WriteRune(r)
		}
	}
	// 结尾的反斜杠若不翻倍，会把收尾引号转义掉
	b.WriteString(strings.Repeat(`\`, backslashes*2))
	b.WriteByte('"')
	return b.String()
}

// BuildCommandLine 拼出 ConPTY 需要的一整条命令行。
func BuildCommandLine(exe string, args []string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, QuoteArg(exe))
	for _, a := range args {
		parts = append(parts, QuoteArg(a))
	}
	return strings.Join(parts, " ")
}

// Start 起一个 ConPTY。调用方负责 Close。
func Start(exe string, args []string, cwd string, env []string, cols, rows int) (*Session, error) {
	if !conpty.IsConPtyAvailable() {
		return nil, fmt.Errorf("ConPTY 不可用（需要 Windows 10 1809 及以上）")
	}
	cmdline := BuildCommandLine(exe, args)
	c, err := conpty.Start(
		cmdline,
		conpty.ConPtyDimensions(cols, rows),
		conpty.ConPtyWorkDir(cwd),
		conpty.ConPtyEnv(env),
	)
	if err != nil {
		return nil, fmt.Errorf("启动 %q 失败: %w", cmdline, err)
	}
	return &Session{cpty: c}, nil
}

func (p *Session) Read(b []byte) (int, error) { return p.cpty.Read(b) }

func (p *Session) Write(b []byte) (int, error) {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	return p.cpty.Write(b)
}
func (p *Session) Resize(cols, rows int) error { return p.cpty.Resize(cols, rows) }
func (p *Session) Close() error                { return p.cpty.Close() }
func (p *Session) Pid() int                    { return p.cpty.Pid() }
func (p *Session) Wait(ctx context.Context) (uint32, error) {
	return p.cpty.Wait(ctx)
}
