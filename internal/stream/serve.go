// Package stream 拥有一条 agent 标签流的一生：首帧尺寸握手、PTY → 前端的
// 字节转发、前端 → PTY 的输入与四个控制帧、进程退出后关流。
//
// 它不 import Wails、session、term 或 ctl：
//   - 传输层只认 Conn（Send/Receive/Close）；
//   - 终端只认 Terminal（Read/Write/Resize/Pid/Wait）；
//   - open-wt / rename / log 三个控制帧交给注入的 Callbacks；
//   - OSC 10/11 颜色应答器由 NewOSC 注入（接口只有 Scan/Seen）。
//
// 两条实测约束写在这里，改代码前先读：
//
//  1. **读 conn 的只能有一个 goroutine**。Receive 内部是 sync.Cond，两个读者会把
//     帧随机分走（键盘字节被偷走那种错）。所以读全部集中在 readLoop，处理逻辑
//     只从 frames 通道拿帧。
//  2. **Send 是排队不是拷贝**。交出去的切片在送达前不能被下一次 Read 覆盖 ——
//     所以每帧都复制一份（见 pump 里的 frame := make(...)）。
package stream

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"time"
)

// CtrlPrefix 是控制帧的起始字节。
// xterm 的键盘输入只会产生 0x00–0x7F 的字节，0xFF 不可能出现在真实终端输入里，
// 所以用它来区分「控制帧」和「原样透传的终端输入」。
const CtrlPrefix = 0xFF

// Conn 是标签流的传输层。Wails 的 *application.StreamConn 由调用方适配成它
// （并负责把 ErrStreamClosed 归一成 io.EOF）。
type Conn interface {
	Send([]byte) error
	Receive() ([]byte, error)
	Close() error
}

// Terminal 是一条已经起来的 PTY。term.Session 直接满足它。
type Terminal interface {
	Read([]byte) (int, error)
	Write([]byte) (int, error)
	Resize(cols, rows int) error
	Pid() int
	Wait(ctx context.Context) (uint32, error)
}

// OSC 是颜色查询应答器需要的那两个方法（实现见 internal/term）。
type OSC interface {
	Scan(chunk []byte) []string
	Seen() map[string]int
}

// Callbacks 是流自己不该知道的领域动作。nil 一律当"没有这个动作"。
type Callbacks struct {
	TabID  int
	OpenWT func()                     // open-wt：在 Windows Terminal 里打开这一格
	Rename func(pid int, name string) // rename：用户给这一格起了名字
	Log    func(msg string)           // log：页面回传的渲染层事实
	NewOSC func() OSC                 // nil = 不应答 OSC 10/11
	// ExitNotice 是进程退出时写进 PTY 的那句话（不带前缀/颜色）。
	// 空 = 内置中文兜底。组合根按当前界面语言注入，stream 不认识设置。
	ExitNotice string
}

// ctrlMsg 是标签流里会出现的控制帧字段。ctl 的完整协议另有更大的结构；
// json.Unmarshal 会忽略多余字段，所以两边不必共用一个类型。
type ctrlMsg struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Msg  string `json:"msg"`
}

const (
	// 前端在 stream.onopen 里就会发第一帧 resize，所以正常路径下这里是零等待。
	// 兜底：1.5 秒还没等到（比如前端 fit 失败 / 格子是隐藏的）就用 80x24 起，
	// 宁可难看也别卡死。副作用：真正的那一帧尺寸到了会走 Resize，CLI 会重画
	// 开场界面（老那一份进回滚缓冲）—— 这是兜底本来就要付的代价。
	initialSizeTimeout = 1500 * time.Millisecond
	initialCols        = 80
	initialRows        = 24
)

const exitNotice = "进程已退出"

// exitBytes 是写进 PTY 的退出提示。颜色固定用黄：它是"这一格停了"，
// 不是错误（错误走红色）。
func (s *Server) exitBytes() []byte {
	word := s.cb.ExitNotice
	if word == "" {
		word = exitNotice
	}
	return []byte("\r\n\x1b[33m[perch] " + word + "\x1b[0m\r\n")
}

type frame struct {
	data []byte
	err  error
}

// Server 是一条标签流的生命周期。零值不可用；用 New 构造。
// AwaitInitialSize 会启动唯一的读协程；Serve 接管终端与收包循环。
type Server struct {
	conn Conn
	cb   Callbacks

	done chan struct{}
	once sync.Once // Close
	read sync.Once // 读协程只起一次

	frames chan frame
}

func New(conn Conn, cb Callbacks) *Server {
	return &Server{
		conn:   conn,
		cb:     cb,
		done:   make(chan struct{}),
		frames: make(chan frame, 1),
	}
}

// Close 让读协程撤出来。重复调用是无操作。它不关 conn —— 那是调用方的事
// （顺序：先让本函数返回、再 Close 流，读协程才醒得过来）。
func (s *Server) Close() {
	s.once.Do(func() { close(s.done) })
}

// AwaitInitialSize 等前端把它 fit 出来的列宽行数报上来。
//
// 为什么必须等：终端进程的**第一个字节**就决定了它按多少列画屏。
// 原来这里写死 120x30 起 PTY，前端 fit 到 60 列之后再 resize —— 但那时
// CLI 已经按 120 列画完一整屏了；xterm 收到 resize 会把已有内容按新宽度
// **折行重排**，于是屏幕上出现 "C / de / Claude Code v" 这种交错重影，
// 且这段脏内容永久留在回滚缓冲里。这类问题在截图上看起来像"渲染 bug"，
// 根因却在启动时序上。
//
// ⚠️ 握手里非 resize 的控制帧**不能吃掉**，按原顺序放进 pending 交还给
// 收包循环：前端启动那一刻连着发好几条（fit 读数、fontprobe、dpr…），而且
// 发消息是事件驱动的 —— onopen 那批被吃掉之后，除非尺寸/内容再变，它不会再发。
// 于是握手一旦超时，整条前端→后端通道看起来就是死的。
func (s *Server) AwaitInitialSize() (int, int, [][]byte, error) {
	s.startReader()
	var pending [][]byte
	timer := time.NewTimer(initialSizeTimeout)
	defer timer.Stop()
	for {
		select {
		case f, ok := <-s.frames:
			if !ok { // 读协程退出了（接收报错），等价于原来的 Receive 报错
				return 0, 0, nil, io.EOF
			}
			if f.err != nil {
				return 0, 0, nil, f.err
			}
			data := f.data
			if len(data) == 0 {
				continue
			}
			if data[0] == CtrlPrefix {
				var m ctrlMsg
				if json.Unmarshal(data[1:], &m) == nil && m.Type == "resize" && m.Cols > 0 && m.Rows > 0 {
					log.Printf("[perch] 前端报尺寸 %dx%d，按此启动 PTY", m.Cols, m.Rows)
					return m.Cols, m.Rows, pending, nil
				}
			}
			pending = append(pending, data)
		case <-timer.C:
			// 一寸都没报（不是"fit 失败"，而是**一个字节都没来**）——前端发消息是
			// 事件驱动的，隐藏的格子报不出尺寸，也就什么都不会发。这里必须起，
			// 否则这一格永远没有 PTY。
			log.Printf("[perch] 前端 %v 内未报尺寸，按 %dx%d 兜底启动（其间收到 %d 帧，转交收包循环）",
				initialSizeTimeout, initialCols, initialRows, len(pending))
			return initialCols, initialRows, pending, nil
		}
	}
}

// Serve 接管一条已经起来的终端：转发 PTY 输出、把输入与控制帧写回去，
// 并在进程退出时关流。pending 是握手里攒下的帧（原顺序）。
func (s *Server) Serve(t Terminal, pending [][]byte) {
	// 「这一格停了」的唯一可靠信号。
	// 2026-10-17 实测：格内 /exit 之后 claude.exe 已经没了（Get-CimInstance 查不到），
	// 而 ConPTY 的读循环**一条错误都没报** —— conhost 还活着、管道两端都还在我们
	// 手里，EOF 不会来。所以得问**进程本身**（Wait 每 1s 看一次 WAIT_TIMEOUT）。
	// 它退了就关流：前端 onclose → connDown → 行翻「已停止」+ ▶。
	go func() {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() { <-s.done; cancel() }() // 本函数收尾（关格/关窗）就把等待撤掉
		if _, werr := t.Wait(ctx); werr != nil {
			return // 是我们自己收的尾，不是进程退出
		}
		log.Printf("[perch] tab=%d pid=%d 进程已退出，关流", s.cb.TabID, t.Pid())
		_ = s.conn.Send(s.exitBytes())
		_ = s.conn.Close() // 让收包循环醒过来、前端看到 onclose
	}()

	// ConPTY -> 前端：原样转发字节，不做任何字符串转换。
	// string(bytes) 会把被切在两个读块之间的 UTF-8 序列打断 ——
	// 而这个场景满地中文。
	go s.pump(t)

	// 握手里攒下的帧走**同一条**路径。
	for _, data := range pending {
		if s.handle(t, data) {
			return
		}
	}
	// 通道由读协程关：它把 Receive 的错先当一帧发出来再 close，
	// 所以这里的 `!ok` 是防御性的（真有那一天说明那条约定被改了）。
	for f := range s.frames {
		if f.err != nil {
			// 读到这儿只有一个成因：这条流关了（前端关标签 / 页面重载 / 窗口关掉）。
			// 适配层已经把 ErrStreamClosed 归一成 io.EOF —— 正常关格不打日志：
			// 每次关格一条像报错的行，读日志的人很快就会不看日志了。
			if !errors.Is(f.err, io.EOF) {
				log.Printf("[perch] tab=%d 读帧中断: %v", s.cb.TabID, f.err)
			}
			return
		}
		if s.handle(t, f.data) {
			return
		}
	}
}

func (s *Server) startReader() {
	s.read.Do(func() { go s.readLoop() })
}

// readLoop 是全程**唯一**的 Receive 调用者（见包注释）。
func (s *Server) readLoop() {
	defer close(s.frames)
	for {
		data, err := s.conn.Receive()
		if err != nil {
			s.sendFrame(frame{err: err})
			return
		}
		if !s.sendFrame(frame{data: data}) {
			return
		}
	}
}

// sendFrame 的 done 分支是**防泄漏**的：消费方提前 return 时，读协程可能正卡在
// 塞帧上 —— 那时它不在 Receive 里，Close 叫不醒它。
func (s *Server) sendFrame(f frame) bool {
	select {
	case s.frames <- f:
		return true
	case <-s.done:
		return false
	}
}

func (s *Server) pump(t Terminal) {
	buf := make([]byte, 32*1024)
	// OSC 10/11 颜色查询应答。必须在**原始字节**这一层做，
	// 因为查询可能早于任何渲染器到达（见 internal/term 的说明）。
	var osc OSC
	if s.cb.NewOSC != nil {
		osc = s.cb.NewOSC()
	}
	probeDone := false
	probeUntil := time.Now().Add(20 * time.Second)
	rawLeft := rawProbeLimit
	for {
		n, rerr := t.Read(buf)
		if n > 0 {
			probeBytes(s.cb.TabID, buf[:n], &rawLeft)
			if osc != nil {
				for _, reply := range osc.Scan(buf[:n]) {
					log.Printf("[osc] 回答颜色查询: %q", reply)
					if _, werr := t.Write([]byte(reply)); werr != nil {
						log.Printf("[osc] 写回应答失败: %v", werr)
					}
				}
				if !probeDone && time.Now().After(probeUntil) {
					probeDone = true
					log.Printf("[osc] 这段时间收到的查询统计: %v", osc.Seen())
				}
			}
			// ⚠️ Send 是「排队」不是「拷贝」（Wails v3 stream.go 的注释写得很直白）。
			// buf 是每轮 Read 复用的 —— 直接 Send(buf[:n]) 等于把一块马上会被覆盖的
			// 内存交出去，症状是同一个字节流每次跑出来都不一样（开场横幅里的 SGR
			// 被当正文打出来、吉祥物位置随机漂移）。
			// 修法：按帧复制。一次 PTY 读块多一次分配，换来"交出去的内存归对方"。
			frame := make([]byte, n)
			copy(frame, buf[:n])
			if serr := s.conn.Send(frame); serr != nil {
				return
			}
		}
		if rerr != nil {
			_ = s.conn.Send(s.exitBytes())
			_ = s.conn.Close() // 让收包循环立刻醒过来
			return
		}
	}
}

// handle 处理一帧前端数据。抽成方法是为了让握手里攒下的帧走同一条路径。
// 返回 true = 终端写失败，调用方该收尾了。
func (s *Server) handle(t Terminal, data []byte) (stop bool) {
	if len(data) == 0 {
		return false
	}
	if data[0] == CtrlPrefix {
		var m ctrlMsg
		if json.Unmarshal(data[1:], &m) == nil {
			switch m.Type {
			case "resize":
				if m.Cols > 0 && m.Rows > 0 {
					if err := t.Resize(m.Cols, m.Rows); err != nil {
						log.Printf("[perch] resize %dx%d 失败: %v", m.Cols, m.Rows, err)
					}
				}
			case "open-wt":
				if s.cb.OpenWT != nil {
					s.cb.OpenWT()
				}
			case "rename":
				// 用户给这个面板起了个名字。名字的主语是**会话**，不是面板 ——
				// 面板在内存里，会话在盘上。这里只把 pid 交出去，反查和落盘都在
				// 回调那边做（反查有重试，可能等上一两秒）。
				if s.cb.Rename != nil {
					s.cb.Rename(t.Pid(), m.Msg)
				}
			case "log":
				// 前端把渲染层的事实（fit 结果 / 元素尺寸 / dpr）回传到服务端日志 ——
				// 页面里没有控制台可看，这是唯一能拿到的真相。
				if s.cb.Log != nil {
					s.cb.Log(m.Msg)
				}
			}
		}
		return false
	}
	if _, werr := t.Write(data); werr != nil {
		return true
	}
	return false
}
