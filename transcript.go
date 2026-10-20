package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// ---------------------------------------------------------------------------
// 跟着转录文件走：「改动」和「流水」的数据腿
//
// 为什么是**跟着文件**而不是从 PTY 字节里认：jsonl 是 claude 自己写的、
// 结构化的、而且带结论（成了没有、加了几行减了几行）。字节那一侧只能猜。
// 路径来自 hook 的 SessionStart（payload 里有 transcript_path），
// 所以不需要反解 projects\<有损slug>\ 那层编码。
//
// 形状全部是**对我自己的真转录实测出来的**（不是查文档），关键三条：
//
//	调用：{"type":"assistant","message":{"content":[{"type":"tool_use",
//	        "name":"Edit","input":{"file_path":…,"old_string":…,"new_string":…}}]}}
//	结果：{"type":"user","toolUseResult":{…},"message":{"content":[
//	        {"type":"tool_result","tool_use_id":"call_00_…"}]}}
//
// ⚠️ 这两行是**不同的行**，而且后者字符串里没有 `"tool_use"` 这个带闭合引号的
// 片段（它是 `"tool_use_id"`）—— 我第一次探针按 `"tool_use"` 过滤时，
// 只捞到调用、一条结果都没捞到，差点据此以为"结果里没有可用信息"。
//
// 结果的形状按工具分（实测）：
//
//	Write  {"type":"create","filePath":…,"content":…}
//	Edit   {filePath,oldString,newString,originalFile,structuredPatch,userModified}
//	Read   {filenames,mode,numFiles,numLines,totalLines}
//	Bash   {interrupted,stdout,stderr,persistedOutputPath,persistedOutputSize}
//	Agent  {agentId,description,prompt,resolvedModel,status,outputFile}
//	AskUserQuestion {questions,answers,annotations}
//
// 其中 Edit 的 structuredPatch 是**标准 unified diff**
// （{oldStart,oldLines,newStart,newLines,lines:[" 上下文","-旧","+新"]}），
// 数前缀就是 git 那种 ±N —— 不用自己去 diff 两份文本。
// ---------------------------------------------------------------------------

const (
	// 转录是**追加**写的，跟着读很便宜；400ms 一次对"看着它干活"足够。
	transcriptPollEvery = 400 * time.Millisecond

	// 内存里保留的流水条数（超了从头砍）。前端也只渲染一屏。
	maxActs = 300
	// 改动台账每个格子最多记这么多文件（按最后一次动作时间淘汰）。
	maxFiles = 200

	// 「改动」正文的保留上限。文件列表会跟着每 400ms 的轮询推送，所以**大块
	// diff 不挂在 FileTouch 的 JSON 上**，只在文件预览按需取（trace.diff）；
	// 但内存里仍要留一份，否则点了文件只能看到 ±N 却看不到改了哪几行。
	// 三道上限一起用：单次改动、单文件、整格。
	maxChangeText      = 16 * 1024 // 单次改动可展示正文的字节数
	maxPatchLines      = 500       // 单次改动保留的 diff 行数（含上下文）
	maxChangesPerFile  = 4
	maxChangeBytesFile = 48 * 1024
	maxDiffFiles       = 60 // 整格最多保留多少个文件的改动正文
	maxPendingToolText = 32 * 1024
)

// FileHunk 是一次编辑里的一段 unified diff（形状照 claude 转录的
// structuredPatch：{oldStart,oldLines,newStart,newLines,lines}）。
type FileHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// FileChange 是一次**可展示**的改动。文件列表只带 HasDiff/State 这种轻标记，
// 真正的 diff 正文按需由 trace.diff 取（见 maxChangeText 上面那段）。
type FileChange struct {
	Tool string `json:"tool"` // Edit | Write | NotebookEdit
	At   string `json:"at,omitempty"`
	OK   bool   `json:"ok"`
	Add  int    `json:"add,omitempty"`
	Del  int    `json:"del,omitempty"`

	Patch []FileHunk `json:"patch,omitempty"`

	// Write 的整份内容（成功时用结果里的，被拒绝时用调用参数里的）。
	Content string `json:"content,omitempty"`
	// Edit 被拒绝时没有 structuredPatch：拿调用参数里的旧/新串兜底。
	Old string `json:"old,omitempty"`
	New string `json:"new,omitempty"`

	// 被拒绝/没产生差异/没有 diff 可展示时的一句话。
	Note string `json:"note,omitempty"`
	// 失败是不是"用户/权限拒绝"（而不是工具报错）。两者都没有落盘，
	// 但界面上分得开：「被拒绝」和「工具失败」不该长成同一句话。
	Denied bool `json:"denied,omitempty"`
	// 正文被 maxChangeText / maxPatchLines 砍过（前端要如实说）。
	Truncated bool `json:"truncated,omitempty"`

	// 内存记账用（不发给前端）：这条改动占了多少字节。
	bytes int
}

// FileTouch 是一个被这个会话碰过的文件。
type FileTouch struct {
	Path string   `json:"path"`
	Rel  string   `json:"rel"` // 相对会话 cwd（展示用；cwd 外的仍是绝对路径）
	Ops  []string `json:"ops"` // "read" | "edit" | "write"，去重
	Add  int      `json:"add"`
	Del  int      `json:"del"`
	At   string   `json:"at"`

	// 预览用轻标记：有没有可展示的改动；最后一次改动是不是被拒绝 / 文件
	// 现在是不是已经不在盘上。正文不在这里（见 FileChange 上面那段）。
	HasDiff bool         `json:"hasDiff,omitempty"`
	State   string       `json:"state,omitempty"` // "" | "rejected" | "missing"
	Changes []FileChange `json:"-"`
}

// ActItem 是流水里的一条。ID 用于**原地更新**（工具先出现、结果后到），
// 也用于前端按 id 定位"我画到哪了"（见 index.html 的 flowLastId）。
//
// ⚠️ **每一条都必须有 ID**，不只是工具调用。第一版只在 tool_use 上填 id，
// prompt/text/system 都是空串 —— 前端那个"追加游标"于是锚不住：
// 它按 id 找上一帧画到的那条，找不到就当"整份重建"，每来一条新内容
// 整个列表重画一遍。日志当场露出来了：`流水 +1 条` 而前端写着 `追加5 条 共5 条`
// （5 = 已有 4 条被重新追加了一遍），屏上是重复的对话。
// 所以 id 在这里补齐：`s<序号>`，进程内递增、只增不减，前端当成身份用。
type ActItem struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // "prompt" | "text" | "thinking" | "tool" | "system" | "compact"
	Tool  string `json:"tool,omitempty"`
	Text  string `json:"text"`
	Path  string `json:"path,omitempty"`
	Rel   string `json:"rel,omitempty"`
	Add   int    `json:"add,omitempty"`
	Del   int    `json:"del,omitempty"`
	OK    *bool  `json:"ok,omitempty"` // nil = 还在跑
	Agent string `json:"agent,omitempty"`
	At    string `json:"at"`

	// **只有 AskUserQuestion 会有**（别的工具没有，所以 omitempty）。
	//
	// Qs 是问题与选项本身 —— 待答期间前端画的就是它。**这一条能存在，
	// 是因为转录跟着读**：问题在转录里就是一条普通 tool_use，input 完整
	// （含每个选项的 description/preview），不需要 hook、也不需要屏幕解析。
	//
	// Answers 是"用户选了哪个"，key 是**问题的原文**、value 是选中的 label
	// （形状取自工具自己的 output schema：answers 是 string→string 的 object）。
	// 它只在结果落盘之后才有 —— 而"有没有结果"这件事**不用看它**：
	// `OK == nil` 就是还在等你答（见上面 OK 那行的定义）。
	Qs      []QAsk            `json:"qs,omitempty"`
	Answers map[string]string `json:"answers,omitempty"`

	/* **正文被截断时才有**：原文总**字符**数（前端照它说"这里只显示了前 N 字"）。
	   为什么要有它：只留一个没头没尾的 `…`，读的人分不清那是作者写的还是我们砍的
	   （实测就是被当成"作者就这么写的"）。0/缺省 = 没截。见 msgText。 */
	FullLen int `json:"fullLen,omitempty"`

	/* **只有 Kind=="compact" 会有**（同上，omitempty）。

	   Turn 是这次压缩发生在**这个会话的第几回合**（转录顶层
	   `turnPosition.turnIndex`，实测 41/42 条压缩行都有它，且逐条递增）；
	   Swallowed 是它跟**上一个**压缩点之间隔了几个回合（第一个压缩点没有值）。
	   —— 两个都是**转录里真有的数**。

	   ⚠️ 别把它们理解成"这次吞了 N 轮对话"：转录里**没有**那个数。
	   实测 42 条压缩行：`summarizedTurnPromptUuids` 要么 1 个（31 条）要么
	   压根没有（11 条），`compact_metadata` **一次都没出现**。
	   所以这里只报能看见的（第几回合 / 距上次几个回合），不编 token、不编回合数。 */
	Turn      int `json:"turn,omitempty"`
	Swallowed int `json:"swallowed,omitempty"`
}

// QOpt 是 AskUserQuestion 的一个选项。
//
// ⚠️ Prev 是**多行**的：它画的是"影响面"那种对齐块（✓/✗ 缩进列表），
// 所以它截断用的是 cutRunes 而**不是** clip —— clip 会把换行压成空格，
// 正好毁掉 preview 唯一的用处（clip 是给日志写的，见 hooks.go:291）。
type QOpt struct {
	Label string `json:"label"`
	Desc  string `json:"desc,omitempty"`
	Prev  string `json:"prev,omitempty"`
}

// QAsk 是 AskUserQuestion 的一问。
type QAsk struct {
	Q      string `json:"q"`
	Header string `json:"header,omitempty"`
	Multi  bool   `json:"multi,omitempty"` // multiSelect：可以多选
	Opts   []QOpt `json:"opts,omitempty"`
}

type pending struct {
	tool string
	path string

	// 工具调用参数里能拿来展示的那部分（被拒绝时结果里没有正文，只能用它们）：
	// Write 的 content、Edit 的 old_string/new_string。都按 maxPendingToolText 截过。
	content string
	old     string
	new     string
}

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

var traceAsk = make(chan snapReq, 8)

// actsCopy 取一份副本。**任何情况下都返回非 nil** —— nil 在这条协议里专门表示
// "没问到"（见 actSnapshot），调用方拿它决定"要不要覆盖前端已有的列表"。
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

// actSnapshot 向跟随器要一份副本，带超时（它可能在长读盘）。
// 超时返回 nil 而且要**和"确实是空的"区分开**：nil 表示没问到，调用方别拿它
// 去替换前端的列表（那会把已有的内容抹掉）。
func actSnapshot(tab int, wait time.Duration) []ActItem {
	req := snapReq{tab: tab, ch: make(chan []ActItem, 1)}
	select {
	case traceAsk <- req:
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

// diffReq 是"把某一格记到的某个文件的改动给我一份"的一次性请求。
// 和 actSnapshot 同一个理由走 channel：改动正文只属于跟随协程，不共享。
type diffReq struct {
	tab  int
	path string
	ch   chan *diffReply
}

type diffReply struct {
	Path    string       `json:"path"`
	Rel     string       `json:"rel,omitempty"`
	Found   bool         `json:"found"`
	Missing bool         `json:"missing,omitempty"`
	State   string       `json:"state,omitempty"`
	Add     int          `json:"add,omitempty"`
	Del     int          `json:"del,omitempty"`
	Changes []FileChange `json:"changes,omitempty"`
}

var diffAsk = make(chan diffReq, 8)

// filesReq 是"把某一格现在的文件台账给我一份"的请求。页面重载后前端是空的，
// 而跟随器那边的 first 早已是 false —— 不补这一次，「碰过的」会空到下一次
// 有新动作（和新格启动时 asks acts.snapshot 是同一条理由）。
type filesReq struct {
	tab int
	ch  chan []FileTouch
}

var filesAsk = make(chan filesReq, 8)

func filesSnapshot(tab int, wait time.Duration) []FileTouch {
	req := filesReq{tab: tab, ch: make(chan []FileTouch, 1)}
	select {
	case filesAsk <- req:
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

func filesCopy(tr *trace) []FileTouch {
	if tr == nil {
		return []FileTouch{}
	}
	return tr.fileList()
}

// diffSnapshot 向跟随器要一份某文件的改动副本。nil = 没问到（超时/跟随器
// 不在）；调用方要把它和"确实没有改动"（Found=false 的非 nil 回复）分开。
func diffSnapshot(tab int, path string, wait time.Duration) *diffReply {
	req := diffReq{tab: tab, path: path, ch: make(chan *diffReply, 1)}
	select {
	case diffAsk <- req:
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

// diffCopy 在跟随协程里取值。大小写不敏感按 Clean 后的路径对齐 —— 前端
// 从文件树/台账拿到的路径可能只差一个盘符大小写。
func diffCopy(tr *trace, path string) *diffReply {
	if tr == nil {
		return &diffReply{Path: path, Found: false}
	}
	key := strings.ToLower(filepath.Clean(path))
	f := tr.files[key]
	if f == nil {
		return &diffReply{Path: path, Found: false}
	}
	out := &diffReply{
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

func startTranscriptFollower(push func(any)) {
	go func() {
		traces := map[int]*trace{}
		for {
			// 睡 400ms，但**可以被一条快照请求叫醒**：页面重载之后下段要立刻有东西，
			// 而那一刻跟随器的 first 早就是 false，它不会自己重推（见 actSnapshot）。
			select {
			case req := <-traceAsk:
				req.ch <- actsCopy(traces[req.tab])
			case req := <-diffAsk:
				req.ch <- diffCopy(traces[req.tab], req.path)
			case req := <-filesAsk:
				req.ch <- filesCopy(traces[req.tab])
			case <-time.After(transcriptPollEvery):
			}
			live := map[int]tabView{}
			for _, v := range tabs.Live() {
				if v.Transcript != "" {
					live[v.ID] = v
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
					tr.poll(id, push)
				}()
			}
		}
	}()
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
				itoa(files[0].Add) + "/−" + itoa(files[0].Del) + "]"
		}
		log.Printf("[trace t%d] 改动台账 %d 个文件（+%d/−%d）%s", tabID, len(files), add, del, top)
		push(map[string]any{"type": "files", "tab": tabID, "files": files})
	}
}

// consumeLine 吃一行，返回**新增或更新后**的流水条（没有就返回 nil）。
// 返回值既用于"追加"，也用于"原地更新"—— 前端按 id 覆盖。
func (tr *trace) consumeLine(line string) *ActItem {
	if !strings.Contains(line, `"type":`) {
		return nil
	}
	var ev struct {
		Type          string          `json:"type"`
		Timestamp     string          `json:"timestamp"`
		Message       json.RawMessage `json:"message"`
		ToolUseResult json.RawMessage `json:"toolUseResult"`

		// 上下文压缩那三个字段（只有压缩行有，见 consumeCompact）
		IsCompactSummary bool `json:"isCompactSummary"`
		TurnPosition     *struct {
			PromptIndex int `json:"promptIndex"`
			TurnIndex   int `json:"turnIndex"`
		} `json:"turnPosition"`
	}
	if json.Unmarshal([]byte(line), &ev) != nil {
		return nil
	}
	switch ev.Type {
	case "assistant":
		return tr.consumeAssistant(ev.Message, ev.Timestamp)
	case "user":
		// ⚠️ 压缩行**也是 user 轮的形状**，而且消息体比普通提问大一个量级
		// （实测 17–26KB vs 几百字），所以从前它整段以"你说的话"的样子
		// 混进流水、还占掉了「N 轮」里的一轮。判据放在这里、**先于**其它两条。
		if ev.IsCompactSummary {
			turn := 0
			if ev.TurnPosition != nil {
				turn = ev.TurnPosition.TurnIndex
			}
			return tr.consumeCompact(ev.Message, ev.Timestamp, turn)
		}
		if len(ev.ToolUseResult) > 0 {
			return tr.consumeResult(ev.Message, ev.ToolUseResult, ev.Timestamp)
		}
		return tr.consumePrompt(ev.Message, ev.Timestamp)
	}
	return nil
}

func (tr *trace) consumeAssistant(raw json.RawMessage, at string) *ActItem {
	var msg struct {
		Content []struct {
			Type  string          `json:"type"`
			Text  string          `json:"text"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	var last *ActItem
	for _, b := range msg.Content {
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			txt, full := msgText(b.Text)
			last = tr.append(ActItem{Kind: "text", Text: txt, FullLen: full, At: at})
		case "thinking":
			// 思考过程也是流水的一部分（用户能看出"它在想"还是在"卡着"）
			last = tr.append(ActItem{Kind: "thinking", Text: "思考…", At: at})
		case "tool_use":
			in := decodeInput(b.Input)
			it := ActItem{ID: b.ID, Kind: "tool", Tool: b.Name, At: at}
			it.Text, it.Path = describeTool(b.Name, in)
			if it.Path != "" {
				it.Rel = tr.rel(it.Path)
			}
			if b.Name == "Agent" || b.Name == "Task" {
				it.Agent = in.str("description")
			}
			if b.Name == "AskUserQuestion" {
				it.Qs = readQuestions(in)
				// 落一行事实：这条流水是「它在等你答」的**唯一**证据来源，
				// 而"到底带出来几问几选项"只有日志说得清（前端画出来不一定在屏幕上）。
				log.Printf("[trace] AskUserQuestion 提问：%d 问，%s（待答 —— 就等它的 tool_result）",
					len(it.Qs), askShape(it.Qs))
			}
			// 被拒绝的 Write/Edit 在结果里没有正文，只能靠调用参数回放 ——
			// 所以这里先把它们截断后留在 pending 里（上限见 maxPendingToolText）。
			pd := pending{tool: b.Name, path: it.Path}
			if _, isFile := fileOp(b.Name); isFile {
				pd.content, _ = cutUTF8(in.str("content"), maxPendingToolText)
				pd.old, _ = cutUTF8(in.str("old_string"), maxPendingToolText)
				pd.new, _ = cutUTF8(in.str("new_string"), maxPendingToolText)
			}
			tr.wait[b.ID] = pd
			// 文件类工具先记一笔"碰过"（成败和 ±N 等结果回来再补）
			if op, ok := fileOp(b.Name); ok && it.Path != "" {
				tr.touch(it.Path, op, 0, 0, at)
			}
			last = tr.append(it)
		}
	}
	return last
}

func (tr *trace) consumePrompt(raw json.RawMessage, at string) *ActItem {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	txt := textOf(msg.Content)
	if strings.TrimSpace(txt) == "" {
		return nil
	}
	// 壳层塞进 user 轮的那些东西不是"你说的话"（理由见 systemTurn）。
	// 不分类的话「流水」里会混进一屏看起来像你在说话的系统条目 ——
	// 实测：本会话自己的转录里 `system-reminder` 出现 2814 次，
	// 它们全都是以 user 轮的形状落盘的。
	if label, drop := systemTurn(txt); drop {
		return nil
	} else if label != "" {
		return tr.append(ActItem{Kind: "system", Text: label, At: at})
	}
	ptxt, pfull := msgText(txt)
	return tr.append(ActItem{Kind: "prompt", Text: ptxt, FullLen: pfull, At: at})
}

/*
consumeCompact 吃一条**上下文压缩**行。

	这是 Claude Code 自带的机制，发生在**一个会话文件的内部**：把此前若干回合
	折成一页摘要落进转录（`isCompactSummary:true`、`isVisibleInTranscriptOnly:true`，
	`message.content` 是**字符串**而不是块数组）。它**不是**一次新的会话 ——
	所以它在界面上是**会话内部的节点**，不是左边栏的一行、也不算一轮。

	为什么它非要单独一条 Kind：从前它走 consumePrompt，于是那 17–26KB 的摘要
	以"你说的一大段话"的样子占满流水，还把 store.go 的「N 轮」抬高一格
	（那一行同样是 `"type":"user"`）。界面上看着就是"用户打了 2 万字"。

	⚠️ **不画 token 数**。计划书里那张 `98k → 21k` 的图是照 Orca 的形态画的，
	落地时按实测降级了：本机 42 条压缩行里 `compact_metadata` **一次都没出现**。
	`summarizedTurnPromptUuids` 也不是"吞了几回合"的清单（1 个 / 没有）。
	所以这里只报两个转录里真有的数：**第几回合**、**距上次压缩几个回合**。
*/
func (tr *trace) consumeCompact(raw json.RawMessage, at string, turn int) *ActItem {
	var msg struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	txt := textOf(msg.Content)
	if strings.TrimSpace(txt) == "" {
		return nil
	}
	txt, full := msgText(txt)
	it := ActItem{Kind: "compact", Text: txt, FullLen: full, At: at, Turn: turn}
	// 回合号偶尔缺失（实测 1/42），缺了就两个数都不报 —— 不猜。
	// 也要求递增：同一份转录被整读两遍、或者反过来拿到旧的一行时，
	// 相减会得到负数或负数长度的"距离"，那种数不如不显示。
	if turn > 0 && tr.lastCompactTurn > 0 && turn > tr.lastCompactTurn {
		it.Swallowed = turn - tr.lastCompactTurn
	}
	if turn > 0 {
		tr.lastCompactTurn = turn
	}
	// 一行事实：几个压缩点、各在第几回合、摘要多大（前端画出来不一定在屏幕上）。
	// 这条日志也是"`N 轮` 有没有被压缩行抬高"的对照物。
	pos, dist := "回合未知", ""
	if it.Turn > 0 {
		pos = "第 " + itoa(it.Turn) + " 回合"
	}
	if it.Swallowed > 0 {
		dist = "，距上次 " + itoa(it.Swallowed) + " 回合"
	}
	cut := ""
	size := full
	if size > 0 {
		cut = "，截到 " + itoa(msgMax) + " 字送出"
	} else {
		size = len([]rune(txt)) // full==0 表示没截，txt 就是原文
	}
	log.Printf("[trace] 上下文压缩点：%s%s，摘要 %d 字%s", pos, dist, size, cut)
	return tr.append(it)
}

// systemTurn 认出"以 user 轮的形状出现、但不是用户说的话"的那些条目。
//
// ⚠️ 它是**按形状**认的，不是按一张写死的名单：转录里没有任何字段标着
// "这条是系统消息"（实测过，它就是普通的 type=user），而这类包装会跟着
// claude 的版本增加（task-notification / cross-session-message / … 都是这条路的）。
// 所以判据收在"整条文本以一个形如 <tag …> 的标签开头"这一点上。
// 代价：你**手打**一段以 `<` 开头的 XML 也会被归成系统条目 ——
// 不影响读（正文照样在），只是那一行的字形和标签换了个说法。
//
// 返回 (标签, 丢掉)。丢掉的那几个是**只给模型看**的（提醒、命令回显），
// 混在"你说过什么"里只会把这一栏变成噪音。
// proseWrappers 是"白话在前、标签在后"那类包装的开头。
//
// 它是**名单**不是判据 —— 白话没有形状可认，而这类包装会跟着 harness 版本增加。
// 漏掉一条的代价可控：那一行还按 prompt 显示（看得见，只是标签不对），不会丢内容。
var proseWrappers = []struct{ prefix, label string }{
	{"Another Claude session sent a message:", "跨会话消息"},
}

func systemTurn(txt string) (label string, drop bool) {
	s := strings.TrimSpace(txt)
	// 第一类形状：**先一行白话、下一行才是标签**。实测（对应 SubagentStop
	// agent_id=a3e601df 那条）原文是：
	//     Another Claude session sent a message:
	//     <agent-message from="a3e601dfd9259f93a">
	//     [Subagent hand-back] …（子代理的最终报告）
	// 只按"以 < 开头"去认的话，这一整段会当成**你自己说的**一句话落进流水
	// （实测就是这么混进来的：一行 300 字的 prompt）。
	// 所以白话前缀必须排在标签判据**前面** —— 它的第一个字符不是 '<'。
	for _, w := range proseWrappers {
		if !strings.HasPrefix(s, w.prefix) {
			continue
		}
		// 框里那行能进一步说清"是谁"：子代理交回报告、和别的会话发来的消息，
		// 走的是同一层包装，脸一样、牌子不一样。认不出来就退回宽的那个说法 ——
		// 错的只是**谁**，不会错成"你在说话"。
		// 正文刻意不进流水：它可能是几千 token 的长报告，而这一栏是
		// "一眼看过去发生了什么"，不是阅读器（正文在终端里本来就在）。
		if strings.Contains(s, "Subagent hand-back") {
			return "子代理回报", false
		}
		return w.label, false
	}
	if !strings.HasPrefix(s, "<") {
		return "", false
	}
	end := strings.IndexAny(s, "> \n\t")
	if end < 6 || end > 40 { // <6 的是 <b> 这种，40 以上不像标签了
		return "", false
	}
	name := s[1:end]
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return "", false
		}
	}
	switch name {
	case "system-reminder", "command-name", "command-message",
		"local-command-stdout", "local-command-caveat":
		return "", true
	case "task-notification":
		return "任务通知", false
	case "cross-session-message":
		return "跨会话消息", false
	}
	return name, false
}

// consumeResult 处理工具返回。这是"成了没有 / 加了几行"的唯一来源。
func (tr *trace) consumeResult(raw, res json.RawMessage, at string) *ActItem {
	// 先把这个结果对应到哪次调用（tool_use_id 在 message.content[] 里）
	var msg struct {
		Content []struct {
			Type      string          `json:"type"`
			ToolUseID string          `json:"tool_use_id"`
			IsError   bool            `json:"is_error"`
			Content   json.RawMessage `json:"content"`
		} `json:"content"`
	}
	_ = json.Unmarshal(raw, &msg)
	var id string
	sawErr := false
	errText := ""
	for _, b := range msg.Content {
		if b.Type == "tool_result" && b.ToolUseID != "" {
			id = b.ToolUseID
			if b.IsError {
				sawErr = true
				errText = strings.TrimSpace(textOf(b.Content))
			}
			break
		}
	}

	var r map[string]json.RawMessage
	resText := ""
	if json.Unmarshal(res, &r) != nil {
		// 工具报错时 toolUseResult 可能直接是一段字符串（实测形状：
		// "Error: Exit code 2\n…"）。它不是对象，别当成"结果里什么都没有"。
		var s string
		if json.Unmarshal(res, &s) == nil {
			resText = strings.TrimSpace(s)
		}
		r = nil
	}
	if errText == "" {
		errText = resText
	}

	// ±N：Edit 的结果里是标准 unified diff。readPatch 同时留一份**有上限**的
	// 可展示 hunk（原来的 countPatch 只数数，正文被丢掉了 —— 这正是
	// "点开文件看不到改了什么"的根因）。
	hunks, add, del, patchTrunc := readPatch(r["structuredPatch"])
	ok := !sawErr
	// Bash：interrupted 表示被打断（不算成功）
	if v, has := r["interrupted"]; has {
		var b bool
		if json.Unmarshal(v, &b) == nil && b {
			ok = false
			if errText == "" {
				errText = "被打断"
			}
		}
	}
	// Write 的 content：行数就是新增。
	// ⚠️ 尾换行不算额外一行 —— 实测写出来的文件是 "a\nB\nc\n"（6 字节、3 个 LF），
	// 而 `Count("\n")+1` 会数成 4。第一次跑就是这么错的，对着真文件核才看出来。
	if v, has := r["content"]; has && r["type"] != nil {
		var s string
		if json.Unmarshal(v, &s) == nil && add == 0 {
			add = strings.Count(s, "\n")
			if s != "" && !strings.HasSuffix(s, "\n") {
				add++
			}
		}
	}

	// 更新台账（文件路径优先用结果里的 filePath/filenames，比调用参数更权威）
	path := ""
	for _, k := range []string{"filePath", "notebookPath"} {
		if v, has := r[k]; has {
			_ = json.Unmarshal(v, &path)
		}
	}
	if path == "" {
		if v, has := r["filenames"]; has {
			var fs []string
			if json.Unmarshal(v, &fs) == nil && len(fs) > 0 {
				path = fs[0]
			}
		}
	}
	p := tr.wait[id]
	tool := p.tool
	if path == "" {
		path = p.path
	}
	if tool == "" && r["structuredPatch"] != nil {
		tool = "Edit"
	}
	// 文件类工具成功时结果一定是对象；拿到的是字符串 = 失败（即使
	// tool_result 那一块漏了 is_error，也不能把一次报错记成"已落盘"）。
	if r == nil && resText != "" {
		if _, isFile := fileOp(tool); isFile {
			ok = false
		}
	}

	// 文件类工具：Read 不参与改动正文。
	if op, isFile := fileOp(tool); isFile && path != "" {
		if op == "read" {
			if ok && (add > 0 || del > 0) {
				tr.touch(path, op, add, del, at)
			}
		} else {
			tr.recordChange(path, op, add, del, at, fileChangeOf(tool, p, r, at, ok, errText,
				hunks, add, del, patchTrunc))
		}
	}
	// 「子代理」：Agent 工具的结果里带 agentId，直接对上 subagents\agent-<id>.jsonl。
	// 这个 id 也是 hook 的 SubagentStart/Stop 报的那个 agent_id —— 所以把它落在
	// 流水条上，前端就能把"转录里的描述/结果"和"hook 报的类型/存活"对上，
	// 而且以后要跟着**子代理自己**的转录看它干了什么，入口也是这一个 id。
	var agentID string
	if v, has := r["agentId"]; has {
		if json.Unmarshal(v, &agentID) != nil {
			agentID = ""
		}
		if agentID != "" {
			log.Printf("[trace] Agent 子会话 agentId=%s（%s）", short(agentID), clip(p.path, 80))
		}
	}
	// AskUserQuestion 的答案：map[**问题原文**]选中的 label（形状取自工具自己的
	// output schema）。它和"有没有结果"是**两件事** —— 结果本身由下面的 OK 表达，
	// 这里只补上"选了哪个"，好在"已答"那一态里把那句话说完整。
	var answers map[string]string
	if v, has := r["answers"]; has {
		_ = json.Unmarshal(v, &answers)
	}

	delete(tr.wait, id)

	// 原地更新那条流水（前端按 id 覆盖）
	if idx, has := tr.byID[id]; has && id != "" {
		it := &tr.acts[idx]
		it.OK = &ok
		if add > 0 || del > 0 {
			it.Add, it.Del = add, del
		}
		if agentID != "" {
			it.Agent = agentID
		}
		if len(answers) > 0 {
			it.Answers = answers
			// 按**问题的顺序**取第一条来记 —— map 的遍历顺序是随机的，
			// 直接 range 每次打出的可能是不同的一条，"验一遍"就对不上。
			first := ""
			if len(it.Qs) > 0 {
				first = "（" + clip(answers[it.Qs[0].Q], 60) + "）"
			}
			log.Printf("[trace] AskUserQuestion 已答 %d 问%s（OK=%v）", len(answers), first, ok)
		}
		if it.Text == "" {
			it.Text = tool
		}
		return it
	}
	return nil
}

// file 取/建一个文件的台账项。路径按大小写不敏感对齐（Windows），
// 超上限时淘汰最久没动的那一个。
func (tr *trace) file(path string) *FileTouch {
	key := strings.ToLower(filepath.Clean(path))
	t := tr.files[key]
	if t == nil {
		if len(tr.files) >= maxFiles {
			var oldestKey string
			var oldest string
			for k, v := range tr.files {
				if oldest == "" || v.At < oldest {
					oldest, oldestKey = v.At, k
				}
			}
			delete(tr.files, oldestKey)
		}
		t = &FileTouch{Path: path, Rel: tr.rel(path)}
		tr.files[key] = t
	}
	if t.Rel == "" {
		t.Rel = tr.rel(path)
	}
	return t
}

// touch 记一次文件动作。ops 去重、保留最后一次时间。
func (tr *trace) touch(path, op string, add, del int, at string) {
	t := tr.file(path)
	t.At = at
	if add > 0 || del > 0 {
		t.Add += add
		t.Del += del
	}
	for _, o := range t.Ops {
		if o == op {
			tr.dirtyF = true
			return
		}
	}
	t.Ops = append(t.Ops, op)
	tr.dirtyF = true
}

// recordChange 记一次 **Edit/Write 的结果**（成功或被拒绝都记）。
// 与 touch 分开：touch 是"碰过"（工具一调用就记），recordChange 才有
// 成败和可展示的正文 —— 预览的「改动」页读的就是后者。
func (tr *trace) recordChange(path, op string, add, del int, at string, ch FileChange) {
	t := tr.file(path)
	t.At = at
	if ch.OK {
		if add > 0 || del > 0 {
			t.Add += add
			t.Del += del
		}
	}
	seen := false
	for _, o := range t.Ops {
		if o == op {
			seen = true
			break
		}
	}
	if !seen {
		t.Ops = append(t.Ops, op)
	}
	ch.bytes = changeBytes(ch)
	t.Changes = append(t.Changes, ch)
	t.HasDiff = true
	if !ch.OK {
		if ch.Denied {
			t.State = "rejected"
		} else {
			t.State = "failed"
		}
	} else if _, err := os.Stat(path); os.IsNotExist(err) {
		t.State = "missing"
	} else {
		t.State = ""
	}
	tr.trimChanges(t)
	tr.trimDiffFiles(t)
	tr.dirtyF = true
}

func changeBytes(ch FileChange) int {
	n := len(ch.Content) + len(ch.Old) + len(ch.New)
	for _, h := range ch.Patch {
		for _, l := range h.Lines {
			n += len(l)
		}
	}
	return n
}

func (tr *trace) trimChanges(t *FileTouch) {
	for len(t.Changes) > maxChangesPerFile {
		t.Changes = t.Changes[1:]
	}
	total := 0
	for _, c := range t.Changes {
		total += c.bytes
	}
	for total > maxChangeBytesFile && len(t.Changes) > 1 {
		total -= t.Changes[0].bytes
		t.Changes = t.Changes[1:]
	}
}

// 改动正文只保留最近 maxDiffFiles 个文件；超了就从最久没动的那个开始清空。
// 计数（add/del）和 ops 不受影响 —— 清掉的只是"点开能看的那几行"。
func (tr *trace) trimDiffFiles(keep *FileTouch) {
	n := 0
	for _, f := range tr.files {
		if f.HasDiff {
			n++
		}
	}
	for n > maxDiffFiles {
		var oldest *FileTouch
		for _, f := range tr.files {
			if !f.HasDiff || f == keep {
				continue
			}
			if oldest == nil || f.At < oldest.At {
				oldest = f
			}
		}
		if oldest == nil {
			return
		}
		oldest.Changes = nil
		oldest.HasDiff = false
		n--
	}
}

// fileChangeOf 把一次工具结果整理成可展示的改动。正文按 maxChangeText 截；
// 被拒绝的 Write/Edit 没有结果正文，用调用参数回放并明确标注"未落盘"。
func fileChangeOf(tool string, p pending, r map[string]json.RawMessage, at string,
	ok bool, errText string, hunks []FileHunk, add, del int, patchTrunc bool) FileChange {
	ch := FileChange{Tool: tool, At: at, OK: ok, Patch: hunks, Truncated: patchTrunc}
	if ok {
		ch.Add, ch.Del = add, del
	}
	// 没有落盘的原因分两类：用户/权限拒绝，还是工具自己报错。前者才是
	// "被拒绝"；后者（比如 old_string 找不到）只是失败。两种都不计入 ±N。
	failLabel := "失败，未落盘"
	if !ok && isUserRejection(errText) {
		ch.Denied = true
		failLabel = "被拒绝，未落盘"
	}
	switch tool {
	case "Write":
		s := ""
		if r != nil {
			if v, has := r["content"]; has {
				_ = json.Unmarshal(v, &s)
			}
		}
		if s == "" {
			s = p.content
		}
		var cut bool
		ch.Content, cut = cutUTF8(s, maxChangeText)
		ch.Truncated = ch.Truncated || cut
		if !ok {
			ch.Note = failLabel
		} else if len(s) == 0 {
			ch.Note = "写入内容为空"
		}
	case "Edit", "NotebookEdit":
		if len(hunks) == 0 {
			if p.old != "" || p.new != "" {
				ch.Old, _ = cutUTF8(p.old, maxChangeText)
				ch.New, _ = cutUTF8(p.new, maxChangeText)
				if !ok {
					ch.Note = failLabel
				} else {
					ch.Note = "这次编辑没有 structuredPatch，下面按调用参数回放（没有最终行号）"
				}
			} else if !ok {
				ch.Note = failLabel
			} else {
				ch.Note = "这次编辑没有可显示的差异"
			}
		} else if !ok {
			ch.Note = failLabel
		}
	}
	if !ok && errText != "" {
		n := clip(errText, 240)
		if ch.Note == "" {
			ch.Note = n
		} else {
			ch.Note += " · " + n
		}
	}
	return ch
}

// isUserRejection 认的是**实测见过的拒绝文案**（不是猜工具语义）：
//
//	The user doesn't want to proceed with this tool use. …
//	The user doesn't want to take this action.
//
// 工具自己报错（"String to replace not found"）不算拒绝 —— 两者都没落盘，
// 但在界面上要说不同的话。
func isUserRejection(s string) bool {
	s = strings.ToLower(s)
	return strings.Contains(s, "doesn't want to") ||
		strings.Contains(s, "does not want to") ||
		strings.Contains(s, "user rejected") ||
		strings.Contains(s, "tool use was rejected")
}

// readPatch 解 structuredPatch，并留一份有上限的 hunk 供预览。
// ±N 始终按**完整** patch 数，截断只影响"能看到的行"。
func readPatch(raw json.RawMessage) (hunks []FileHunk, add, del int, truncated bool) {
	if len(raw) == 0 {
		return
	}
	var all []FileHunk
	if json.Unmarshal(raw, &all) != nil {
		return
	}
	kept := 0
	for _, h := range all {
		for _, l := range h.Lines {
			if l == "" {
				continue
			}
			switch l[0] {
			case '+':
				add++
			case '-':
				del++
			}
		}
		if truncated {
			continue
		}
		n := len(h.Lines)
		if kept+n > maxPatchLines {
			n = maxPatchLines - kept
			if n < 0 {
				n = 0
			}
			truncated = true
		}
		if n > 0 {
			hh := h
			hh.Lines = append([]string{}, h.Lines[:n]...)
			hunks = append(hunks, hh)
			kept += n
		}
	}
	return
}

// cutUTF8 按字节上限截，退到合法的 rune 边界。返回 (截后文本, 有没有截)。
func cutUTF8(s string, max int) (string, bool) {
	if max <= 0 || len(s) <= max {
		return s, false
	}
	i := max
	for i > 0 && !utf8.RuneStart(s[i]) {
		i--
	}
	return s[:i] + "…", true
}

func (tr *trace) append(it ActItem) *ActItem {
	// 没有 id 的（prompt/text/system/thinking）补一个。前缀 "s" 和 tool_use_id
	// （`call_00_…`）不会撞；序号只增不减，所以同一份转录读两次得到同一批 id。
	if it.ID == "" {
		tr.seq++
		it.ID = "s" + itoa(tr.seq)
	}
	tr.acts = append(tr.acts, it)
	/* ⚠️ 砍头和取下标**顺序不能反**。原来写的是先 `idx = len(acts)-1`、砍完再
	   `return &tr.acts[idx]` —— 砍之前 idx=300，砍完这个切片只剩 300 个元素
	   （下标 0..299），`tr.acts[300]` 当场 **index out of range [300] with length 300**，
	   跟随协程**整个死掉**：从此这一格的「流水/改动」两条腿一起静默停更，
	   界面上什么都看不出来（日志里那串 panic 是唯一的痕迹）。
	   它平时不出现，是因为要一条会话攒到 300 条以上才踩得到 —— 我灌了 320 条
	   一次性读入，才把它炸出来（负结果也是证据）。 */
	if len(tr.acts) > maxActs {
		drop := len(tr.acts) - maxActs
		tr.acts = append([]ActItem(nil), tr.acts[drop:]...)
		// 下标全变了：重建（比记一堆偏移简单，而且只在砍的时候发生）
		tr.byID = map[string]int{}
		for i, a := range tr.acts {
			tr.byID[a.ID] = i
		}
		// 砍的是**头**，新来的那条（也就是 return 的那条）永远还在最后。
		return &tr.acts[len(tr.acts)-1]
	}
	idx := len(tr.acts) - 1
	tr.byID[it.ID] = idx
	return &tr.acts[idx]
}

func (tr *trace) fileList() []FileTouch {
	out := make([]FileTouch, 0, len(tr.files))
	for _, f := range tr.files {
		out = append(out, *f)
	}
	// 最近动的在前
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// rel 把绝对路径压成相对 cwd 的形式 —— 面板里全是长绝对路径，噪音太大。
// cwd 之外的路径保持绝对（那不是"这个项目的文件"）。
func (tr *trace) rel(p string) string {
	if tr.cwd == "" {
		return p
	}
	r, err := filepath.Rel(tr.cwd, p)
	if err != nil || strings.HasPrefix(r, "..") {
		return p
	}
	return filepath.ToSlash(r)
}

// decodeInput 把工具参数解成好查的小对象（值都当字符串用，够 describeTool 用）。
type toolInput map[string]json.RawMessage

func decodeInput(raw json.RawMessage) toolInput {
	var m toolInput
	if json.Unmarshal(raw, &m) != nil {
		return toolInput{}
	}
	return m
}

func (t toolInput) str(k string) string {
	v, ok := t[k]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(v, &s) == nil {
		return s
	}
	return ""
}

// describeTool 给一条工具调用写一句"它在干什么"，并返回要记进台账的路径。
func describeTool(name string, in toolInput) (text, path string) {
	switch name {
	case "Read", "Edit", "Write", "NotebookEdit":
		path = in.str("file_path")
		if path == "" {
			path = in.str("notebook_path")
		}
		return name + " " + filepath.Base(path), path
	case "PowerShell", "Bash":
		c := strings.TrimSpace(in.str("command"))
		if i := strings.IndexByte(c, '\n'); i >= 0 {
			c = c[:i]
		}
		d := in.str("description")
		if d != "" {
			return d, ""
		}
		return clip(c, 120), ""
	case "Grep":
		return "Grep " + in.str("pattern"), ""
	case "Glob":
		return "Glob " + in.str("pattern"), ""
	case "Agent", "Task":
		d := in.str("description")
		if d == "" {
			d = in.str("subagent_type")
		}
		return "子代理：" + clip(d, 100), ""
	case "AskUserQuestion":
		// **把问题本身带出来**，而不是留一个"提问"就完事：
		// 「需要你」那一行要回答"它在问我什么"，光说"它在提问"等于没说。
		// 形状实测：input 是 {questions:[{question,header,options,multiSelect}]}。
		// （选项本身不在这里 —— 它挂在 ActItem.Qs 上，见 consumeAssistant。）
		qs := readQuestions(in)
		if len(qs) == 0 {
			return "提问", ""
		}
		if len(qs) > 1 {
			return "提问：" + clip(qs[0].Q, 100) + "（" + itoa(len(qs)) + " 个问题）", ""
		}
		return "提问：" + clip(qs[0].Q, 100), ""
	case "TodoWrite":
		return "更新待办", ""
	}
	return name, ""
}

// readQuestions 从 AskUserQuestion 的入参里把**问题和选项都**读出来。
//
// 它原来是 firstQuestion，只取第一问的原文和问题数 —— 选项全扔了。
// 「收起后进群组」那一轮要的正是选项（要点、要看 description/preview），
// 而转录里本来就有，扔掉它等于把已经到手的东西再丢一次。
//
// 形状是本机实测的（不是查文档）：
//
//	input = {"questions":[{"question":…,"header":…,"multiSelect":false,
//	                       "options":[{"label":…,"description":…,"preview":…}]}]}
//
// 两个字段都可能缺：question 空时退回 header（问题原文为空的那一行，
// 前端画出来会是一行空白）；两个都空的那一问仍然**保留**（它的 options 可能有用），
// 只是没有标题。
func readQuestions(in toolInput) []QAsk {
	raw := in["questions"]
	if len(raw) == 0 {
		return nil
	}
	var qs []struct {
		Question    string `json:"question"`
		Header      string `json:"header"`
		MultiSelect bool   `json:"multiSelect"`
		Options     []struct {
			Label       string `json:"label"`
			Description string `json:"description"`
			Preview     string `json:"preview"`
		} `json:"options"`
	}
	if json.Unmarshal(raw, &qs) != nil || len(qs) == 0 {
		return nil
	}
	out := make([]QAsk, 0, len(qs))
	for _, q := range qs {
		qk := QAsk{Q: strings.TrimSpace(q.Question), Header: strings.TrimSpace(q.Header),
			Multi: q.MultiSelect}
		if qk.Q == "" {
			qk.Q = qk.Header
		}
		for _, o := range q.Options {
			op := QOpt{Label: o.Label, Desc: clip(o.Description, 600),
				Prev: cutRunes(o.Preview, qPreviewMax)}
			if op.Label == "" && op.Desc == "" && op.Prev == "" {
				continue // 空选项画出来是一条没有字的行，不如不要
			}
			qk.Opts = append(qk.Opts, op)
		}
		out = append(out, qk)
	}
	return out
}

// askShape 给日志用：每问几个选项，按问题顺序连起来（"每问 3/2 个选项"）。
func askShape(qs []QAsk) string {
	if len(qs) == 0 {
		return "没读到问题（input 形状变了？）"
	}
	parts := make([]string, 0, len(qs))
	for _, q := range qs {
		parts = append(parts, itoa(len(q.Opts)))
	}
	return "每问 " + strings.Join(parts, "/") + " 个选项"
}

// qPreviewMax 一个 preview 最多带多少字符。
//
// 为什么要有上限：preview 是**逐字节进每一帧推送**的（流水是增量推、但同一条
// 改动会重推），而它是人写的排版块，没有天然上界。Orca 那边给的量级是 16000
// （它整个 interactivePrompt 的上限）。我们这里一条流水会发给**所有**格子视图，
// 所以按"一屏最多看清多少"来定，而不是照抄它的 16000：1200 字符大约是一整块
// 影响面列表，再多本来也读不完。
const qPreviewMax = 1200

// cutRunes 按**字符**截断，但**保留换行**。
//
// ⚠️ 它和 clip 是两件事，不能互相顶替：clip 把 \r\n 和 \n 压成空格（它服务的
// 是"一行日志"），而 preview 的价值**恰恰在那些换行**（✓/✗ 的对齐块）。
// 用 clip 截 preview 会把整个块压成一行，看着"还有内容"，其实已经废了 ——
// 属于看起来正常、内容不对的那类错。
func cutRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

/*
msgMax 是**进流水那条路**给单条正文的上限（字符）。

	原来两处写的是 `clip(x, 300)` —— 300 字，而且 clip 把换行压成空格。实测
	（2026-10-16）：一条 1961 字、17 个换行的回答，到前端只剩 300 字、还并成了
	一行 —— **85% 的内容根本没送出去**。那不是"没显示"，是"没有"。用户报的
	"上面文字多的时候下面被吞掉"就是它（300 对正文来说低得离谱）。

	为什么不干脆**不截**：每条新内容只推**新增的那一条**（见 poll 里 push 的是
	newActs），所以实时那一路的成本只跟单条大小成正比；真正花钱的是**快照** ——
	`acts.snapshot` 会把内存里**全部**流水序列化一遍（保留上限 maxActs=300），
	而页面重载、以及"进群组时对每一格各要一份"都会走它 ⇒ 一条 5MB 的回答在那
	一刻是 5MB × N 格，前端还会把它整段 md() 进 DOM。那不是慢，是界面卡死。

	8000 这个档：正常回答 500–3000 字，够装下；真超了也**不许静默** ——
	带上 FullLen（原文总字数），前端照实说"这里只显示了前 8000"。
*/
const msgMax = 8000

// msgText 给正文（agent 的话 / 你的话）用：**保留换行**地截，并回报原文总字数
// （0 = 没截）。⚠️ 不能用 clip：它把 \r\n 换成空格，那是给"一行日志"写的。
func msgText(s string) (string, int) {
	r := []rune(s)
	if len(r) <= msgMax {
		return s, 0
	}
	return string(r[:msgMax]) + "…", len(r)
}

// fileOp 把工具名映射成台账里的动作类型。不是文件类工具就返回 false。
func fileOp(tool string) (string, bool) {
	switch tool {
	case "Read":
		return "read", true
	case "Edit", "NotebookEdit":
		return "edit", true
	case "Write":
		return "write", true
	}
	return "", false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// textOf 抠出 message.content 里的文本（string 和 array of blocks 两种形状都吃，
// 上游两种都出现过 —— 见 store.go 的同一条教训）。
func textOf(raw json.RawMessage) string {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 {
		return ""
	}
	if b[0] == '"' {
		var s string
		if json.Unmarshal(b, &s) == nil {
			return s
		}
		return ""
	}
	if b[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(b, &blocks) == nil {
			var sb strings.Builder
			for _, x := range blocks {
				if x.Type == "text" && strings.TrimSpace(x.Text) != "" {
					sb.WriteString(x.Text)
				}
			}
			return sb.String()
		}
	}
	return ""
}
