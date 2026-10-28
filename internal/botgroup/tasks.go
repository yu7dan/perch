package botgroup

// 任务账本（Bot Group C，2026-10-28）。
//
// 一件任务 = 谁派给谁的一件事。它只追加不改写：状态每变一次就往
// <数据目录>/botgroups/<组>/tasks.jsonl 追加一行，读的时候同一个 id 取最后一行 ——
// 和事件流一样，崩溃最多丢最后一行，不会把账本写坏。
//
// 状态：
//
//	queued    排着（对方手上有别的事 / 还没起来）
//	paused    组按了「全部暂停」，恢复后照原序送
//	blocked   过不了策略守卫，等你决定（放行 / 取消）
//	delivered 已经送进对方的终端
//	working   对方收到后开始干了（状态变忙）
//	waiting   对方停在批准 / 提问 / 启动门上
//	review    交回了，派活人写过验收标准，等它验收
//	done      完成（显式交回或自动交回）
//	failed    对方格子停了两次接不上
//	cancelled 你取消了

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Task struct {
	ID     string   `json:"id"`
	From   string   `json:"from"` // 派活人（Bot id；Manager 是 "manager"）
	To     string   `json:"to"`
	Parent string   `json:"parent,omitempty"`
	Depth  int      `json:"depth"`
	Text   string   `json:"text"`
	Accept string   `json:"accept,omitempty"`
	Files  []string `json:"files,omitempty"`
	Status string   `json:"status"`
	Reason string   `json:"reason,omitempty"` // blocked 的原因码（refused:depth / refused:pingpong / refused:budget …）
	Result string   `json:"result,omitempty"`
	Auto   bool     `json:"auto,omitempty"` // 自动交回（这一轮结束了没跑 perch-bg done）
	Branch string   `json:"branch,omitempty"`
	Commit string   `json:"commit,omitempty"`
	Dirty  int      `json:"dirty,omitempty"` // 交回时 worktree 里还没提交的改动数
	RID    string   `json:"rid,omitempty"`   // 请求 id：同一条命令重试时按它去重
	Tries  int      `json:"tries,omitempty"` // 送达失败（格子停了）的次数
	Cc     bool     `json:"cc,omitempty"`    // Bot 直接派的：抄送过 Manager
	At     string   `json:"at"`              // 建的时间
	Upd    string   `json:"upd"`             // 最后一次变化
	Deliv  string   `json:"deliv,omitempty"` // 送达的时间（自动交回只认这之后的回复）
	Sent   bool     `json:"sent,omitempty"`  // 结果已经送回派活人
}

// Active 是「在对方手上」的几种状态：一个 Bot 同一时刻只有一件。
func (t Task) Active() bool {
	switch t.Status {
	case "delivered", "working", "waiting":
		return true
	}
	return false
}

// Open 是还没有结果的几种状态。
func (t Task) Open() bool {
	switch t.Status {
	case "done", "failed", "cancelled":
		return false
	}
	return true
}

// Title 是任务正文的第一行（截短），给交接链 / 过程流用。
func (t Task) Title() string {
	line, _, _ := strings.Cut(strings.TrimSpace(t.Text), "\n")
	r := []rune(line)
	if len(r) > 60 {
		return string(r[:60]) + "…"
	}
	return line
}

// Ledger 是所有组的任务账本（每个组一份文件，懒加载）。
type Ledger struct {
	mu    sync.Mutex
	dir   string
	tasks map[string]map[string]*Task // 组 → id → 最新状态
	seq   map[string]int
	rids  map[string]map[string]string // 组 → 请求 id → 任务 id
}

func NewLedger(dir string) *Ledger {
	return &Ledger{dir: dir, tasks: map[string]map[string]*Task{}, seq: map[string]int{}, rids: map[string]map[string]string{}}
}

func (l *Ledger) path(gid string) string {
	return filepath.Join(l.dir, "botgroups", gid, "tasks.jsonl")
}

func (l *Ledger) loadLocked(gid string) map[string]*Task {
	if m, ok := l.tasks[gid]; ok {
		return m
	}
	m := map[string]*Task{}
	rid := map[string]string{}
	l.tasks[gid], l.rids[gid] = m, rid
	if l.dir == "" {
		return m
	}
	f, err := os.Open(l.path(gid))
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var t Task
		if json.Unmarshal(sc.Bytes(), &t) != nil || t.ID == "" {
			continue
		}
		cp := t
		m[t.ID] = &cp
		if t.RID != "" {
			rid[t.RID] = t.ID
		}
		if n, err := strconv.Atoi(strings.TrimPrefix(t.ID, "T")); err == nil && n > l.seq[gid] {
			l.seq[gid] = n
		}
	}
	return m
}

func (l *Ledger) writeLocked(gid string, t *Task) error {
	t.Upd = time.Now().UTC().Format(time.RFC3339Nano)
	if l.dir == "" {
		return nil
	}
	p := l.path(gid)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	fh, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer fh.Close()
	b, _ := json.Marshal(t)
	_, err = fh.Write(append(b, '\n'))
	return err
}

// ByRID：同一个请求 id 之前建过的任务（重试去重）。
func (l *Ledger) ByRID(gid, rid string) (Task, bool) {
	if rid == "" {
		return Task{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.loadLocked(gid)
	if id, ok := l.rids[gid][rid]; ok && m[id] != nil {
		return *m[id], true
	}
	return Task{}, false
}

// Add 记一件新任务（分配 id）。
func (l *Ledger) Add(gid string, t Task) (Task, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.loadLocked(gid)
	l.seq[gid]++
	t.ID = "T" + strconv.Itoa(l.seq[gid])
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if t.At == "" {
		t.At = now
	}
	cp := t
	if err := l.writeLocked(gid, &cp); err != nil {
		l.seq[gid]--
		return Task{}, err
	}
	m[cp.ID] = &cp
	if cp.RID != "" {
		l.rids[gid][cp.RID] = cp.ID
	}
	return cp, nil
}

// Update 改一件任务（f 里改字段），落一行。返回改完的拷贝。
func (l *Ledger) Update(gid, id string, f func(*Task)) (Task, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.loadLocked(gid)
	t := m[id]
	if t == nil {
		return Task{}, fmt.Errorf("没有任务 %s", id)
	}
	cp := *t
	f(&cp)
	if err := l.writeLocked(gid, &cp); err != nil {
		return Task{}, err
	}
	*t = cp
	return cp, nil
}

func (l *Ledger) Get(gid, id string) (Task, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.loadLocked(gid)[id]
	if t == nil {
		return Task{}, false
	}
	return *t, true
}

// List 返回一个组的全部任务，按 id 顺序。
func (l *Ledger) List(gid string) []Task {
	l.mu.Lock()
	defer l.mu.Unlock()
	m := l.loadLocked(gid)
	out := make([]Task, 0, len(m))
	for _, t := range m {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool { return taskNum(out[i].ID) < taskNum(out[j].ID) })
	return out
}

func taskNum(id string) int { n, _ := strconv.Atoi(strings.TrimPrefix(id, "T")); return n }

// Drop 删掉一个组的账本（删组时）。
func (l *Ledger) Drop(gid string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.tasks, gid)
	delete(l.rids, gid)
	delete(l.seq, gid)
	if l.dir != "" {
		_ = os.Remove(l.path(gid))
	}
}

// ---- 策略守卫 ----

// 上限（架构页第六节 + 第十一节第 5 条）。
const (
	MaxDepth    = 6 // 一件事最多转手 6 次
	MaxFanout   = 4 // 一件任务最多派出 4 个子任务
	MaxQueued   = 3 // 一个 Bot 最多 3 件在排
	PingPongMax = 3 // 同一件事在两个 Bot 之间来回 3 次就停
)

// Verdict 是一次派活过关的结果。Code 为空 = 放行；refused:* 直接拒（告诉 agent 为什么）；
// ask:* 记成 blocked、在群里问你。
type Verdict struct {
	Code string
	Msg  string
}

// CheckHandoff：组员 from 想把一件事派给 to（parent 是它手上那件，可空）。
// usedK / capK 是这个组已用的 / 上限的 k tokens。
func CheckHandoff(g Group, tasks []Task, from, to string, parent *Task, usedK, capK int) Verdict {
	if bot(g, from) == nil {
		return Verdict{"refused:who", "你不是这个组的成员"}
	}
	tb := bot(g, to)
	if tb == nil {
		return Verdict{"refused:target", "组里没有「" + to + "」。现有成员：" + roster(g)}
	}
	if tb.ID == from {
		return Verdict{"refused:self", "不能派给自己"}
	}
	depth := 1
	if parent != nil {
		depth = parent.Depth + 1
		n := 0
		for _, t := range tasks {
			if t.Parent == parent.ID && t.Status != "cancelled" {
				n++
			}
		}
		if n >= MaxFanout {
			return Verdict{"refused:fanout", fmt.Sprintf("%s 已经派出 %d 件子任务（上限 %d），先等它们交回", parent.ID, n, MaxFanout)}
		}
	}
	queued := 0
	for _, t := range tasks {
		if t.To == tb.ID && (t.Status == "queued" || t.Status == "paused") {
			queued++
		}
	}
	if queued >= MaxQueued {
		return Verdict{"refused:busy", fmt.Sprintf("「%s」手上已经排了 %d 件（上限 %d），先等它做完", tb.Role, queued, MaxQueued)}
	}
	if depth > MaxDepth {
		return Verdict{"ask:depth", fmt.Sprintf("这件事已经转手 %d 次（上限 %d）", depth-1, MaxDepth)}
	}
	if parent != nil && pingPong(tasks, parent, from, tb.ID) >= PingPongMax {
		return Verdict{"ask:pingpong", fmt.Sprintf("这件事在「%s」和「%s」之间来回了 %d 次", roleOf(g, from), tb.Role, PingPongMax)}
	}
	if capK > 0 && usedK >= capK {
		return Verdict{"ask:budget", fmt.Sprintf("预算已经用完（%dk / %dk）", usedK, capK)}
	}
	return Verdict{}
}

// pingPong：沿着父任务往上数，a↔b 之间来回了几次（这一手算一次）。
func pingPong(tasks []Task, parent *Task, a, b string) int {
	byID := map[string]Task{}
	for _, t := range tasks {
		byID[t.ID] = t
	}
	n := 1
	cur := *parent
	for i := 0; i < MaxDepth+2; i++ {
		if (cur.From == a && cur.To == b) || (cur.From == b && cur.To == a) {
			n++
		} else {
			break
		}
		p, ok := byID[cur.Parent]
		if !ok {
			break
		}
		cur = p
	}
	return n
}

func bot(g Group, idOrRole string) *Bot {
	key := strings.TrimSpace(strings.TrimPrefix(idOrRole, "@"))
	for i := range g.Bots {
		b := &g.Bots[i]
		if b.ID == key || strings.EqualFold(b.Role, key) || (b.Manager && strings.EqualFold(key, "manager")) {
			return b
		}
	}
	return nil
}

// Bot 按 id 或角色名找成员（「审阅」「@审阅」「b3」「Manager」都认）。
func (g Group) Bot(idOrRole string) (Bot, bool) {
	if b := bot(g, idOrRole); b != nil {
		return *b, true
	}
	return Bot{}, false
}

func roleOf(g Group, id string) string {
	if b := bot(g, id); b != nil {
		if b.Manager {
			return "Manager"
		}
		return b.Role
	}
	return id
}

func roster(g Group) string {
	var parts []string
	for _, b := range g.Bots {
		if b.Manager {
			parts = append(parts, "Manager")
		} else {
			parts = append(parts, b.Role)
		}
	}
	return strings.Join(parts, "、")
}
