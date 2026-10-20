package transcript

import (
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

// pending 是一次工具调用里、结果还没回来时需要留着的那些参数。
type pending struct {
	tool string
	path string

	// 工具调用参数里能拿来展示的那部分（被拒绝时结果里没有正文，只能用它们）：
	// Write 的 content、Edit 的 old_string/new_string。都按 maxPendingToolText 截过。
	content string
	old     string
	new     string
}

// trace 是一格转录跟随中的全部内存态。它只被跟随协程读写 —— 没有锁，
// 因为没有任何别的协程直接碰它（取快照走请求通道，见 Follower.Acts）。
type trace struct {
	path string
	cwd  string
	off  int64
	buf  string

	files  map[string]*FileTouch
	acts   []ActItem
	byID   map[string]int // ActItem.ID → acts 下标
	wait   map[string]pending
	dirtyF bool
	seq    int // 给没有 id 的条目发号（见 append）

	// 第一次读盘（可能是恢复的会话，历史很长）：只把**最后 30 条**流水推给前端。
	// 全推会把刚打开的界面淹掉，而且那些是过去的事。
	first bool

	// 上一个压缩点的回合号（0 = 还没有过）。只为了算出"距上次压缩几个回合"，
	// 见 consumeCompact。**不是**"吞了几回合"。
	lastCompactTurn int
}

func newTrace(path, cwd string) *trace {
	return &trace{
		path: path, cwd: cwd,
		files: map[string]*FileTouch{},
		byID:  map[string]int{},
		wait:  map[string]pending{},
		first: true,
	}
}

// snapReq 是"把某一格**现在**的流水给我一份副本"的一次性请求。
//
// 为什么是 channel 而不是一张加了锁的注册表：流水的内存态（acts/off/buf/byID）
// 只属于跟随那个 goroutine。共享它要么在持锁时推送（Send 是排队不拷贝，
// 但仍然是在锁里做 I/O），要么把整个 poll 拆成"锁内算、锁外推"。
// 也不能改成"收到请求就重读一遍转录"—— 实测那个会话的转录是 44MB，
// 一次完整解析够呛。带 reply 通道的请求把这两个代价都省掉，且零共享状态。
type snapReq struct {
	tab int
	ch  chan []ActItem
}

// actsCopy 取一份副本。**任何情况下都返回非 nil** —— nil 在这条协议里专门表示
// "没问到"（见 Follower.Acts），调用方拿它决定"要不要覆盖前端已有的列表"。
//
// ⚠️ 这里踩过一次：原来写的是 `append([]ActItem(nil), tr.acts...)`，看着像
// "给我一份空切片"，但**空 + append 出来就是 nil**（append 到 nil 切片、零个元素，
// 结果仍是 nil）。于是"这一格确实还没有流水"被当成"没问到"，
// 日志里写着"超时/没被取走"而实际上回复是**即时**到的 —— 一条假的超时。
// 空和非空必须在这里分清，不能在调用方靠 nil 猜。
func actsCopy(tr *trace) []ActItem {
	if tr == nil || len(tr.acts) == 0 {
		return []ActItem{}
	}
	return append([]ActItem{}, tr.acts...)
}

// diffReq 是"把某一格记到的某个文件的改动给我一份"的一次性请求。
// 和 Acts 同一个理由走 channel：改动正文只属于跟随协程，不共享。
type diffReq struct {
	tab  int
	path string
	ch   chan *DiffReply
}

// DiffReply 是一次改动正文请求的应答。
type DiffReply struct {
	Path    string       `json:"path"`
	Rel     string       `json:"rel,omitempty"`
	Found   bool         `json:"found"`
	Missing bool         `json:"missing,omitempty"`
	State   string       `json:"state,omitempty"`
	Add     int          `json:"add,omitempty"`
	Del     int          `json:"del,omitempty"`
	Changes []FileChange `json:"changes,omitempty"`
}

// filesReq 是"把某一格现在的文件台账给我一份"的请求。页面重载后前端是空的，
// 而跟随器那边的 first 早已是 false —— 不补这一次，「碰过的」会空到下一次
// 有新动作（和新格启动时 asks acts.snapshot 是同一条理由）。
type filesReq struct {
	tab int
	ch  chan []FileTouch
}

func filesCopy(tr *trace) []FileTouch {
	if tr == nil {
		return []FileTouch{}
	}
	return tr.fileList()
}

// diffCopy 在跟随协程里取值。大小写不敏感按 Clean 后的路径对齐 —— 前端
// 从文件树/台账拿到的路径可能只差一个盘符大小写。
func diffCopy(tr *trace, path string) *DiffReply {
	if tr == nil {
		return &DiffReply{Path: path, Found: false}
	}
	key := strings.ToLower(filepath.Clean(path))
	f := tr.files[key]
	if f == nil {
		return &DiffReply{Path: path, Found: false}
	}
	out := &DiffReply{
		Path: f.Path, Rel: f.Rel, Found: true,
		State: f.State, Add: f.Add, Del: f.Del,
	}
	if len(f.Changes) > 0 {
		out.Changes = append([]FileChange{}, f.Changes...)
	}
	if _, err := os.Stat(f.Path); os.IsNotExist(err) {
		out.Missing = true
	}
	return out
}

// Follower 是转录跟随器。活格子名单（Live）与推送（Push）由调用方注入；
// 构造之后调一次 Start，它就在自己的协程里每 400ms 走一格。
//
// 零值不可用：用 New 构造。
type Follower struct {
	live func() []View
	push func(any)

	traceAsk chan snapReq
	diffAsk  chan diffReq
	filesAsk chan filesReq

	started sync.Once
}

func New(live func() []View, push func(any)) *Follower {
	return &Follower{
		live:     live,
		push:     push,
		traceAsk: make(chan snapReq, 8),
		diffAsk:  make(chan diffReq, 8),
		filesAsk: make(chan filesReq, 8),
	}
}

// Start 起跟随协程。重复调用是无操作。
func (f *Follower) Start() {
	f.started.Do(func() { go f.run() })
}

// Acts 向跟随器要一份流水副本，带超时（它可能在长读盘）。
// 超时返回 nil 而且要**和"确实是空的"区分开**：nil 表示没问到，调用方别拿它
// 去替换前端的列表（那会把已有的内容抹掉）。
func (f *Follower) Acts(tab int, wait time.Duration) []ActItem {
	if f == nil {
		return nil
	}
	req := snapReq{tab: tab, ch: make(chan []ActItem, 1)}
	select {
	case f.traceAsk <- req:
	case <-time.After(wait):
		return nil
	}
	select {
	case items := <-req.ch:
		return items
	case <-time.After(wait):
		return nil
	}
}

// Files 向跟随器要一份文件台账副本。nil = 没问到（同 Acts）。
func (f *Follower) Files(tab int, wait time.Duration) []FileTouch {
	if f == nil {
		return nil
	}
	req := filesReq{tab: tab, ch: make(chan []FileTouch, 1)}
	select {
	case f.filesAsk <- req:
	case <-time.After(wait):
		return nil
	}
	select {
	case files := <-req.ch:
		return files
	case <-time.After(wait):
		return nil
	}
}

// Diff 向跟随器要一份某文件的改动副本。nil = 没问到（超时/跟随器不在）；
// 调用方要把它和"确实没有改动"（Found=false 的非 nil 回复）分开。
func (f *Follower) Diff(tab int, path string, wait time.Duration) *DiffReply {
	if f == nil {
		return nil
	}
	req := diffReq{tab: tab, path: path, ch: make(chan *DiffReply, 1)}
	select {
	case f.diffAsk <- req:
	case <-time.After(wait):
		return nil
	}
	select {
	case d := <-req.ch:
		return d
	case <-time.After(wait):
		return nil
	}
}

func (f *Follower) run() {
	traces := map[int]*trace{}
	for {
		// 睡 400ms，但**可以被一条快照请求叫醒**：页面重载之后下段要立刻有东西，
		// 而那一刻跟随器的 first 早就是 false，它不会自己重推（见 Acts）。
		select {
		case req := <-f.traceAsk:
			req.ch <- actsCopy(traces[req.tab])
		case req := <-f.diffAsk:
			req.ch <- diffCopy(traces[req.tab], req.path)
		case req := <-f.filesAsk:
			req.ch <- filesCopy(traces[req.tab])
		case <-time.After(transcriptPollEvery):
		}
		live := map[int]View{}
		if f.live != nil {
			for _, v := range f.live() {
				if v.Transcript != "" {
					live[v.ID] = v
				}
			}
		}
		// 格子关掉了就丢掉它的跟随状态（文件留着，那是 claude 的资产）
		for id := range traces {
			if _, ok := live[id]; !ok {
				delete(traces, id)
			}
		}
		for id, v := range live {
			tr := traces[id]
			if tr == nil || tr.path != v.Transcript {
				tr = newTrace(v.Transcript, v.CWD)
				traces[id] = tr
				log.Printf("[trace t%d] 开始跟随 %s（cwd=%s）", id, v.Transcript, v.CWD)
			}
			// 一格的一行坏数据**不许**带走整条腿。这个协程一死，「流水」和
			// 「改动」两条腿一起静默停更，而界面上完全看不出来（用户看到的
			// 是"它不动了"，不是"报错了"）—— 刚才那个 index out of range
			// 就是这么白白活了一轮次的。所以这里兜住、**大声记一笔**、
			// 下一轮接着干；不静默、也不让一个格子拖垮别的格子。
			func() {
				defer func() {
					if r := recover(); r != nil {
						log.Printf("[trace t%d] ⚠️ poll 崩了，跳这一轮（跟随协程保住）: %v\n%s", id, r, debug.Stack())
					}
				}()
				tr.poll(id, f.push)
			}()
		}
	}
}

func (tr *trace) poll(tabID int, push func(any)) {
	fi, err := os.Stat(tr.path)
	if err != nil {
		return
	}
	if fi.Size() < tr.off { // 被截断/换文件
		tr.off, tr.buf = 0, ""
	}
	if fi.Size() == tr.off {
		return
	}
	readStart := time.Now()
	f, err := os.Open(tr.path)
	if err != nil {
		return
	}
	if _, err := f.Seek(tr.off, io.SeekStart); err != nil {
		f.Close()
		return
	}
	b, rerr := io.ReadAll(f) // 读尾巴：一次最多几 MB，够用
	f.Close()
	if rerr != nil {
		return
	}
	// ⚠️ 初次读盘可能是**整份**（长会话实测 44MB），这期间跟随协程无法应答
	// traceAsk —— 页面重载时那次补发快照正好撞上就会"超时"。所以把时长量出来：
	// 它是我唯一需要知道"要不要给快照更长的等待 / 要不要分块读"的数字。
	if tr.first {
		readMS := time.Since(readStart).Milliseconds()
		if readMS > 300 {
			log.Printf("[trace t%d] 初次读入用掉 %dms / %d 字节（这期间快照请求应答不了）", tabID, readMS, len(b))
		}
	}
	tr.off += int64(len(b))
	tr.buf += string(b)

	var newActs []ActItem
	for {
		i := strings.IndexByte(tr.buf, '\n')
		if i < 0 {
			break
		}
		line := tr.buf[:i]
		tr.buf = tr.buf[i+1:]
		if a := tr.consumeLine(line); a != nil {
			newActs = append(newActs, *a)
		}
	}

	// 第一次读盘：只推最后 30 条（历史的长度可能上千）
	firstRead := tr.first
	if tr.first {
		tr.first = false
		n := len(newActs)
		if n > 30 {
			newActs = newActs[n-30:]
		}
		log.Printf("[trace t%d] 初次读入：流水 %d 条（推最后 %d 条）改动文件 %d 个",
			tabID, n, len(newActs), len(tr.files))
	}

	if len(newActs) > 0 {
		// 日志里留一行：这条腿**自己**在动（前端还没画，日志是唯一的证据）
		last := newActs[len(newActs)-1]
		log.Printf("[trace t%d] 流水 +%d 条（末条 %s %s）%s", tabID, len(newActs), last.Kind, clip(last.Text, 70),
			map[bool]string{true: "（整份替换）", false: ""}[firstRead])
		// ⚠️ 初次读入必须是**整份替换**，不能当追加推：新开一条跟随 = 换了一份转录
		// （/clear、resume、或者页面重载后补发），而前端那份列表还是**上一个会话**的。
		// 追加会把两个会话的条目混在一起（而且没有 id 的 prompt/text/system
		// 永远只能追加 —— 重放一次就是整份重复）。
		push(map[string]any{"type": "acts", "tab": tabID, "items": newActs, "replace": firstRead})
	}
	if tr.dirtyF {
		tr.dirtyF = false
		files := tr.fileList()
		add, del := 0, 0
		for _, f := range files {
			add += f.Add
			del += f.Del
		}
		top := ""
		if len(files) > 0 {
			top = " 最新=" + files[0].Rel + "[" + strings.Join(files[0].Ops, "+") + "+" +
				strconv.Itoa(files[0].Add) + "/−" + strconv.Itoa(files[0].Del) + "]"
		}
		log.Printf("[trace t%d] 改动台账 %d 个文件（+%d/−%d）%s", tabID, len(files), add, del, top)
		push(map[string]any{"type": "files", "tab": tabID, "files": files})
	}
}
