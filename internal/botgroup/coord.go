package botgroup

// 协调器（Bot Group C，2026-10-28；架构页 arch-botgroup-c.html）。
//
// agent 之间从不直接对话。agent 跑 perch-bg → Bot Bus（internal/botbus）→ 这里：认人、过策略守卫、
// 记账（Ledger）、在对方空闲时送达（推 bg.deliver 给前端，前端在对方空闲时粘贴进它的终端，
// 回执 bg.delivered）、把事情记进过程流并推给界面。
//
// 几条硬规矩（架构页第十一节）：
//   - 投递归这里：前端只执行。没回执就重推，页面重载后重推。
//   - 一个 Bot 同一时刻只拿一件任务，做完（交回 / 自动交回）才送下一件。
//   - 自动交回：已送达的任务，对方这一轮结束了（状态忙 → 闲）却没交回，就把它这一轮最后一段
//     回复当结果交回去。只读的 Bot 根本跑不了命令，全靠这一条。
//   - Bot 直接派活会抄送 Manager：抄送附在下一条送给 Manager 的消息前面，不单独打断它。

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/yu7dan/perch/internal/transcript"
)

// Ident 是一个格子在组里的身份。
type Ident struct {
	Group string `json:"group"`
	Bot   string `json:"bot"`
}

func (i Ident) key() string { return i.Group + "/" + i.Bot }

// CoordDeps 是协调器的外部世界。
type CoordDeps struct {
	Store  *Store
	Ledger *Ledger
	Push   func(any)
	Lang   func() string // "zh" / "en"；nil = 中文
}

type tabSeen struct {
	lastText   string
	lastTextAt time.Time
	cum        int
}

// Coordinator 见文件头。零值不可用；用 NewCoordinator。
type Coordinator struct {
	d CoordDeps

	mu       sync.Mutex
	busURL   string
	tokens   map[string]Ident  // 口令 → 身份
	botTok   map[string]string // 身份 → 现在有效的口令（一个 Bot 只认最新那个）
	tabOf    map[int]Ident
	identTab map[string]int
	seen     map[int]*tabSeen
	status   map[int]string
	pushed   map[string]time.Time // 送出去还没回执的：投递 key → 推的时间
	cc       map[string][]string  // 组 → 还没捎给 Manager 的抄送
	stop     chan struct{}

	// AutoReturnDelay：状态变闲之后再等多久才自动交回（等转录把最后一段写完）。测试里改小。
	AutoReturnDelay time.Duration
	// ResendAfter：推出去多久没回执就重推。
	ResendAfter time.Duration
}

func NewCoordinator(d CoordDeps) *Coordinator {
	return &Coordinator{d: d,
		tokens: map[string]Ident{}, botTok: map[string]string{}, tabOf: map[int]Ident{}, identTab: map[string]int{},
		seen: map[int]*tabSeen{}, status: map[int]string{}, pushed: map[string]time.Time{}, cc: map[string][]string{},
		stop: make(chan struct{}), AutoReturnDelay: 2500 * time.Millisecond, ResendAfter: 10 * time.Second}
}

// Run 起后台的重推循环（没回执的投递定时再推一次）。
func (c *Coordinator) Run() {
	go func() {
		t := time.NewTicker(3 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-c.stop:
				return
			case <-t.C:
				c.resendStale()
			}
		}
	}()
}

func (c *Coordinator) Close() { close(c.stop) }

func (c *Coordinator) SetBusURL(u string) {
	c.mu.Lock()
	c.busURL = u
	c.mu.Unlock()
}

func (c *Coordinator) zh() bool { return c.d.Lang == nil || c.d.Lang() != "en" }

func (c *Coordinator) push(v any) {
	if c.d.Push != nil {
		c.d.Push(v)
	}
}

// ---- 格子：起格时发口令、记下格子是谁 ----

// BotEnv 在一个 Bot 的格子起来时调（session 起格那一刻）：发一个新口令（旧的作废），
// 返回要放进这一格环境里的变量。
func (c *Coordinator) BotEnv(tabID int, gid, botID string) map[string]string {
	if _, ok := c.d.Store.Get(gid); !ok {
		return nil
	}
	id := Ident{gid, botID}
	tok := newToken()
	c.mu.Lock()
	if old := c.botTok[id.key()]; old != "" {
		delete(c.tokens, old)
	}
	c.tokens[tok] = id
	c.botTok[id.key()] = tok
	if old, ok := c.identTab[id.key()]; ok && old != tabID {
		delete(c.tabOf, old)
	}
	c.tabOf[tabID] = id
	c.identTab[id.key()] = tabID
	url := c.busURL
	c.mu.Unlock()
	if url == "" {
		return nil
	}
	return map[string]string{"PERCH_BG_URL": url, "PERCH_BG_TOKEN": tok}
}

// TabClosed：格子关了，口令作废。
func (c *Coordinator) TabClosed(tabID int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id, ok := c.tabOf[tabID]
	if !ok {
		return
	}
	delete(c.tabOf, tabID)
	delete(c.seen, tabID)
	delete(c.status, tabID)
	if c.identTab[id.key()] == tabID {
		delete(c.identTab, id.key())
		if tok := c.botTok[id.key()]; tok != "" {
			delete(c.tokens, tok)
			delete(c.botTok, id.key())
		}
	}
}

// Who：口令是谁的（Bus 用）。
func (c *Coordinator) Who(token string) (Ident, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id, ok := c.tokens[token]
	return id, ok
}

// ---- 旁听：每格的最后一段回复、token 累计；忙闲变化 ----

// Observe 旁听推给前端的每一条消息（ctl 的推送出口上挂着它），只认 acts。
func (c *Coordinator) Observe(v any) {
	m, ok := v.(map[string]any)
	if !ok || m["type"] != "acts" {
		return
	}
	tab, _ := m["tab"].(int)
	items, _ := m["items"].([]transcript.ActItem)
	if tab <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, isBot := c.tabOf[tab]; !isBot {
		return
	}
	s := c.seen[tab]
	if s == nil || m["replace"] == true {
		s = &tabSeen{}
		c.seen[tab] = s
	}
	for _, it := range items {
		if it.Cum > s.cum {
			s.cum = it.Cum
		}
		if it.Kind == "text" && strings.TrimSpace(it.Text) != "" {
			at, err := time.Parse(time.RFC3339Nano, it.At)
			if err != nil {
				at = time.Now()
			}
			if !at.Before(s.lastTextAt) {
				s.lastText, s.lastTextAt = it.Text, at
			}
		}
	}
}

// UsedK：一个组已用的 k tokens（各 Bot 格子的累计之和）。
func (c *Coordinator) UsedK(gid string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for tab, id := range c.tabOf {
		if id.Group == gid && c.seen[tab] != nil {
			n += c.seen[tab].cum
		}
	}
	return n / 1000
}

// OnStatus 在一格的忙闲变了的时候调（session.Manager.SetStatus 的回调；所有 agent 都经过它）。
func (c *Coordinator) OnStatus(tabID int, prev, now string) {
	c.mu.Lock()
	id, ok := c.tabOf[tabID]
	c.status[tabID] = now
	c.mu.Unlock()
	if !ok {
		return
	}
	t, ok := c.activeTask(id)
	if !ok {
		if now == "idle" {
			c.Pump(id.Group)
		}
		return
	}
	switch now {
	case "busy":
		if t.Status == "delivered" || t.Status == "waiting" {
			c.setStatus(id.Group, t.ID, "working", "")
		}
	case "waiting":
		c.setStatus(id.Group, t.ID, "waiting", "")
	case "idle":
		if prev != "busy" && prev != "waiting" {
			return
		}
		// 这一轮结束了：等转录把最后一段写完，还没交回就自动交回。
		go func(tid string) {
			time.Sleep(c.AutoReturnDelay)
			c.mu.Lock()
			still := c.status[tabID] == "idle"
			c.mu.Unlock()
			cur, ok := c.d.Ledger.Get(id.Group, tid)
			if !still || !ok || !cur.Active() || cur.Deliv == "" {
				return
			}
			c.autoReturn(id, tabID, cur)
		}(t.ID)
	}
}

func (c *Coordinator) autoReturn(id Ident, tabID int, t Task) {
	deliv, _ := time.Parse(time.RFC3339Nano, t.Deliv)
	c.mu.Lock()
	s := c.seen[tabID]
	text := ""
	if s != nil && s.lastTextAt.After(deliv) {
		text = s.lastText
	}
	c.mu.Unlock()
	if strings.TrimSpace(text) == "" {
		text = c.tr("（这一轮没有文字回复）", "(no text reply this turn)")
	}
	log.Printf("[botgroup] %s 自动交回 %s（这一轮结束了没跑 perch-bg done）", id.key(), t.ID)
	c.finish(id.Group, t, text, true, nil)
}

// ---- 投递 ----

// activeTask：这个 Bot 手上那件（已送达 / 在做 / 在等你）。
func (c *Coordinator) activeTask(id Ident) (Task, bool) {
	for _, t := range c.d.Ledger.List(id.Group) {
		if t.To == id.Bot && t.Active() {
			return t, true
		}
	}
	return Task{}, false
}

// Delivery 是推给前端的一次投递：前端在对方空闲时把 Text 粘贴进它的终端，送完回执 bg.delivered。
type Delivery struct {
	Group string `json:"group"`
	Bot   string `json:"bot"`
	Key   string `json:"key"`  // 「task:T7」= 送任务；「result:T7」= 把 T7 的结果送回派活人
	Kind  string `json:"kind"` // task | result
	Task  string `json:"task"`
	Text  string `json:"text"`
}

// Pump 看看这个组还有什么该送：每个 Bot 手上空着就送它排着的第一件；做完的结果送回派活人。
func (c *Coordinator) Pump(gid string) {
	g, ok := c.d.Store.Get(gid)
	if !ok || g.Paused {
		return
	}
	tasks := c.d.Ledger.List(gid)
	busy := map[string]bool{}
	for _, t := range tasks {
		if t.Active() {
			busy[t.To] = true
		}
	}
	for _, t := range tasks {
		switch {
		case t.Status == "queued" && !busy[t.To]:
			busy[t.To] = true
			c.offer(Delivery{Group: gid, Bot: t.To, Key: "task:" + t.ID, Kind: "task", Task: t.ID, Text: c.taskText(g, t)})
		case (t.Status == "done" || t.Status == "review" || t.Status == "failed" || t.Status == "cancelled") && !t.resultSent():
			c.offer(Delivery{Group: gid, Bot: t.From, Key: "result:" + t.ID, Kind: "result", Task: t.ID, Text: c.resultText(g, t)})
		}
	}
}

func (t Task) resultSent() bool { return t.Sent }

func (c *Coordinator) offer(d Delivery) {
	c.mu.Lock()
	if at, ok := c.pushed[d.Key]; ok && time.Since(at) < c.ResendAfter {
		c.mu.Unlock()
		return
	}
	c.pushed[d.Key] = time.Now()
	// 抄送捎带：送给 Manager 的消息前面附上它没看到的直接派活
	if g, ok := c.d.Store.Get(d.Group); ok {
		if mb, ok := g.Bot("manager"); ok && mb.ID == d.Bot && len(c.cc[d.Group]) > 0 {
			d.Text = c.tr("（抄送）", "(cc) ") + strings.Join(c.cc[d.Group], "；") + "\n\n" + d.Text
		}
	}
	c.mu.Unlock()
	c.push(map[string]any{"type": "bg.deliver", "delivery": d})
}

func (c *Coordinator) resendStale() {
	c.mu.Lock()
	var groups []string
	seen := map[string]bool{}
	for k, at := range c.pushed {
		if time.Since(at) >= c.ResendAfter {
			delete(c.pushed, k)
		}
	}
	c.mu.Unlock()
	for _, g := range c.d.Store.List() {
		if !seen[g.ID] {
			seen[g.ID] = true
			groups = append(groups, g.ID)
		}
	}
	for _, gid := range groups {
		c.Pump(gid)
	}
}

// Resend：前端重新连上 / 页面重载了 —— 所有没回执的都再推一遍。
func (c *Coordinator) Resend() {
	c.mu.Lock()
	c.pushed = map[string]time.Time{}
	c.mu.Unlock()
	for _, g := range c.d.Store.List() {
		c.Pump(g.ID)
	}
}

// Delivered：前端回执（已经粘贴进对方的终端）。
func (c *Coordinator) Delivered(gid, key string) {
	kind, tid, _ := strings.Cut(key, ":")
	c.mu.Lock()
	delete(c.pushed, key)
	if kind == "result" {
		if g, ok := c.d.Store.Get(gid); ok {
			if mb, ok := g.Bot("manager"); ok {
				if t, ok := c.d.Ledger.Get(gid, tid); ok && t.From == mb.ID {
					delete(c.cc, gid)
				}
			}
		}
	}
	c.mu.Unlock()
	switch kind {
	case "task":
		c.update(gid, tid, func(t *Task) {
			if t.Status == "queued" {
				t.Status = "delivered"
				t.Deliv = time.Now().UTC().Format(time.RFC3339Nano)
			}
		})
	case "result":
		c.update(gid, tid, func(t *Task) {
			t.Sent = true
		})
		c.Pump(gid)
	}
}

// DeliverFailed：前端起不来对方的格子（两次）。任务失败，结果（失败）送回派活人。
func (c *Coordinator) DeliverFailed(gid, key, why string) {
	kind, tid, _ := strings.Cut(key, ":")
	c.mu.Lock()
	delete(c.pushed, key)
	c.mu.Unlock()
	if kind != "task" {
		return
	}
	t, ok := c.d.Ledger.Get(gid, tid)
	if !ok || !t.Open() {
		return
	}
	t.Tries++
	if t.Tries < 2 {
		c.update(gid, tid, func(x *Task) { x.Tries = t.Tries })
		return
	}
	c.finishStatus(gid, t, "failed", c.tr("对方的格子起不来："+why, "could not start the assignee: "+why))
}

// ---- 命令（Bus 进来的）----

// Reply 是一条 perch-bg 命令的回答。
type Reply struct {
	Code string `json:"code"`
	Msg  string `json:"msg"`
	Data any    `json:"data,omitempty"`
}

// Handle 是 Bus 进来的一条命令。
func (c *Coordinator) Handle(id Ident, op string, body map[string]string) Reply {
	g, ok := c.d.Store.Get(id.Group)
	if !ok {
		return Reply{"refused:group", c.tr("这个组已经不在了", "this group no longer exists"), nil}
	}
	me, ok := g.Bot(id.Bot)
	if !ok {
		return Reply{"refused:who", c.tr("你已经不在这个组里了", "you are no longer in this group"), nil}
	}
	switch op {
	case "ping":
		return Reply{"ok:pong", c.tr(fmt.Sprintf("Perch 在线：你是「%s」的「%s」", g.Name, roleName(me)), fmt.Sprintf("Perch is here: you are %s in %s", roleName(me), g.Name)), nil}
	case "team":
		return Reply{"ok:team", c.teamText(g), nil}
	case "tasks":
		return Reply{"ok:tasks", c.tasksText(g, me), nil}
	case "handoff":
		return c.handoff(g, me, body)
	case "done":
		return c.done(g, me, body)
	case "review":
		return c.review(g, me, body)
	case "memory.add":
		circle, err := MemoryAdd(g, me, body["circle"], body["text"])
		if err != nil {
			return Reply{"refused:memory", err.Error(), nil}
		}
		c.event(g.ID, Event{Bot: me.ID, Kind: "memory", Title: c.tr("记忆更新 · "+circle, "memory · "+circle), Text: body["text"]})
		return Reply{"ok:memory", c.tr("记进了圈「"+circle+"」", "saved to circle "+circle), nil}
	case "memory.show":
		txt, err := MemoryShow(g, me, body["circle"])
		if err != nil {
			return Reply{"refused:memory", err.Error(), nil}
		}
		return Reply{"ok:memory", txt, nil}
	}
	return Reply{"refused:op", c.tr("不认识的命令 "+op, "unknown command "+op), nil}
}

func (c *Coordinator) handoff(g Group, me Bot, body map[string]string) Reply {
	if t, ok := c.d.Ledger.ByRID(g.ID, body["rid"]); ok {
		return Reply{"ok:dup", c.tr(fmt.Sprintf("这条命令刚才已经派过了：%s → %s", t.ID, c.role(g, t.To)), "already handed off as "+t.ID), map[string]any{"task": t.ID}}
	}
	to, ok := g.Bot(body["to"])
	text := strings.TrimSpace(body["task"])
	if text == "" {
		return Reply{"refused:usage", c.tr("要说清楚派什么：--task \"…\"", "say what to do: --task \"…\""), nil}
	}
	tasks := c.d.Ledger.List(g.ID)
	var parent *Task
	if pid := body["parent"]; pid != "" {
		if p, ok := c.d.Ledger.Get(g.ID, pid); ok {
			parent = &p
		}
	} else if p, ok := c.activeTask(Ident{g.ID, me.ID}); ok {
		parent = &p
	}
	capK := g.Budget
	if capK <= 0 {
		capK = DefaultBudget
	}
	v := CheckHandoff(g, tasks, me.ID, body["to"], parent, c.UsedK(g.ID), capK)
	if strings.HasPrefix(v.Code, "refused:") {
		return Reply{v.Code, v.Msg, nil}
	}
	if !ok {
		return Reply{"refused:target", c.tr("组里没有「"+body["to"]+"」", "no member "+body["to"]), nil}
	}
	t := Task{From: me.ID, To: to.ID, Text: text, Accept: strings.TrimSpace(body["accept"]), RID: body["rid"], Depth: 1, Status: "queued"}
	if f := strings.TrimSpace(body["files"]); f != "" {
		t.Files = splitList(f)
	}
	if parent != nil {
		t.Parent, t.Depth = parent.ID, parent.Depth+1
	}
	if !me.Manager {
		t.Cc = true
	}
	switch {
	case strings.HasPrefix(v.Code, "ask:"):
		t.Status, t.Reason = "blocked", v.Code
	case g.Paused:
		t.Status = "paused"
	}
	t, err := c.d.Ledger.Add(g.ID, t)
	if err != nil {
		return Reply{"refused:io", err.Error(), nil}
	}
	c.push(map[string]any{"type": "task.update", "group": g.ID, "task": t})
	c.event(g.ID, Event{Bot: me.ID, Kind: "handoff", Title: c.tr(fmt.Sprintf("交接 → %s · %s", roleName(to), t.ID), fmt.Sprintf("handoff → %s · %s", roleName(to), t.ID)), Text: text})
	if t.Cc {
		c.mu.Lock()
		c.cc[g.ID] = append(c.cc[g.ID], fmt.Sprintf("%s 把 %s 派给了 %s：%s", roleName(me), t.ID, roleName(to), t.Title()))
		c.mu.Unlock()
	}
	switch t.Status {
	case "blocked":
		c.event(g.ID, Event{Bot: me.ID, Kind: "blocked", Title: c.tr("被拦 · "+t.ID, "held · "+t.ID), Text: v.Msg})
		return Reply{"queued:blocked", c.tr(v.Msg+"。已经停下来问用户，用户决定后会送达或告诉你", v.Msg+". Asked the user; you will hear back"), map[string]any{"task": t.ID}}
	case "paused":
		return Reply{"paused", c.tr(fmt.Sprintf("组现在是「全部暂停」：%s 先排着，恢复后送给「%s」", t.ID, roleName(to)), "group is paused: "+t.ID+" waits"), map[string]any{"task": t.ID}}
	}
	c.Pump(g.ID)
	return Reply{"ok:queued", c.tr(fmt.Sprintf("已派给「%s」（%s），它空闲时送达；它交回时结果会送到你这里", roleName(to), t.ID), fmt.Sprintf("handed to %s (%s); the result comes back to you", roleName(to), t.ID)), map[string]any{"task": t.ID}}
}

func (c *Coordinator) done(g Group, me Bot, body map[string]string) Reply {
	var t Task
	var ok bool
	if tid := body["task"]; tid != "" {
		t, ok = c.d.Ledger.Get(g.ID, tid)
		if ok && t.To != me.ID {
			return Reply{"refused:task", c.tr(tid+" 不在你手上", tid+" is not yours"), nil}
		}
	} else {
		t, ok = c.activeTask(Ident{g.ID, me.ID})
	}
	if !ok {
		return Reply{"refused:none", c.tr("你手上现在没有任务（用户直接发给你的消息不用交回，直接回复就行）", "you have no task right now"), nil}
	}
	if !t.Open() {
		return Reply{"ok:dup", c.tr(t.ID+" 已经交回过了", t.ID+" was already returned"), nil}
	}
	var files []string
	if f := strings.TrimSpace(body["files"]); f != "" {
		files = splitList(f)
	}
	summary := strings.TrimSpace(body["summary"])
	if summary == "" {
		summary = c.tr("（没写总结）", "(no summary)")
	}
	t = c.finish(g.ID, t, summary, false, files)
	if t.Status == "review" {
		return Reply{"ok:review", c.tr(fmt.Sprintf("%s 交回了，等「%s」验收", t.ID, c.role(g, t.From)), t.ID+" returned; waiting for review"), nil}
	}
	return Reply{"ok:done", c.tr(fmt.Sprintf("%s 交回了，结果会送给「%s」", t.ID, c.role(g, t.From)), t.ID+" returned to "+c.role(g, t.From)), nil}
}

// review：派活人验收（--pass 通过 / --reject "意见" 退回给原来的人重做，深度不加）。
func (c *Coordinator) review(g Group, me Bot, body map[string]string) Reply {
	t, ok := c.d.Ledger.Get(g.ID, body["task"])
	if !ok || t.Status != "review" || t.From != me.ID {
		return Reply{"refused:review", c.tr("没有等你验收的这件任务", "no such task waiting for your review"), nil}
	}
	if reason := strings.TrimSpace(body["reject"]); reason != "" {
		c.update(g.ID, t.ID, func(x *Task) {
			x.Status, x.Deliv, x.Auto = "queued", "", false
			x.Text = x.Text + "\n\n" + c.tr("【退回】", "[returned] ") + reason
			x.Sent = false
		})
		c.event(g.ID, Event{Bot: me.ID, Kind: "handoff", Title: c.tr("退回 → "+c.role(g, t.To)+" · "+t.ID, "rejected → "+t.ID), Text: reason})
		c.Pump(g.ID)
		return Reply{"ok:rejected", c.tr(t.ID+" 退回给「"+c.role(g, t.To)+"」重做", t.ID+" sent back"), nil}
	}
	c.update(g.ID, t.ID, func(x *Task) { x.Status = "done" })
	c.event(g.ID, Event{Bot: me.ID, Kind: "review", Title: c.tr("验收通过 · "+t.ID, "accepted · "+t.ID)})
	return Reply{"ok:accepted", c.tr(t.ID+" 验收通过", t.ID+" accepted"), nil}
}

// finish：交回（显式或自动）。有验收标准 → review，否则 done；记下分支 / 提交；结果送回派活人；
// 这个 Bot 空出来了，送它排着的下一件。
func (c *Coordinator) finish(gid string, t Task, result string, auto bool, files []string) Task {
	g, _ := c.d.Store.Get(gid)
	b, _ := g.Bot(t.To)
	st := "done"
	if t.Accept != "" {
		st = "review"
	}
	out, err := c.d.Ledger.Update(gid, t.ID, func(x *Task) {
		x.Status, x.Result, x.Auto = st, result, auto
		if len(files) > 0 {
			x.Files = files
		}
		if b.Worktree != "" {
			x.Branch = b.Branch
			x.Commit, x.Dirty = HeadInfo(b.Worktree)
		}
	})
	if err != nil {
		return t
	}
	title := c.tr("交回 · "+t.ID, "returned · "+t.ID)
	if auto {
		title += c.tr("（自动）", " (auto)")
	}
	c.event(gid, Event{Bot: t.To, Kind: "return", Title: title, Text: clipText(result, 400)})
	c.push(map[string]any{"type": "task.update", "group": gid, "task": out})
	c.Pump(gid)
	return out
}

func (c *Coordinator) finishStatus(gid string, t Task, status, why string) {
	out, err := c.d.Ledger.Update(gid, t.ID, func(x *Task) { x.Status, x.Result = status, why })
	if err != nil {
		return
	}
	c.event(gid, Event{Bot: t.To, Kind: "fail", Title: c.tr("任务没完成 · "+t.ID, "task failed · "+t.ID), Text: why})
	c.push(map[string]any{"type": "task.update", "group": gid, "task": out})
	c.Pump(gid)
}

// ---- 你在群里的决定（被拦的放行 / 取消；全部暂停）----

// Answer：被拦的那件，你点了「放行」或「取消」。
func (c *Coordinator) Answer(gid, tid, action string) error {
	t, ok := c.d.Ledger.Get(gid, tid)
	if !ok || t.Status != "blocked" {
		return fmt.Errorf("%s 不是在等你决定的任务", tid)
	}
	if action == "allow" {
		g, _ := c.d.Store.Get(gid)
		st := "queued"
		if g.Paused {
			st = "paused"
		}
		c.update(gid, tid, func(x *Task) { x.Status, x.Reason = st, "allowed" })
		c.event(gid, Event{Bot: "you", Kind: "resumed", Title: c.tr("你放行了 "+tid, "you allowed "+tid)})
		c.Pump(gid)
		return nil
	}
	c.finishStatus(gid, t, "cancelled", c.tr("用户取消了这件任务", "the user cancelled this task"))
	return nil
}

// SetPaused：全部暂停 / 恢复。暂停时新派的先排着、已经在做的那一轮不打断；恢复后照原序送。
func (c *Coordinator) SetPaused(gid string, paused bool) error {
	if _, err := c.d.Store.UpdateGroup(gid, GroupPatch{Paused: &paused}); err != nil {
		return err
	}
	for _, t := range c.d.Ledger.List(gid) {
		switch {
		case paused && t.Status == "queued":
			c.update(gid, t.ID, func(x *Task) { x.Status = "paused" })
		case !paused && t.Status == "paused":
			c.update(gid, t.ID, func(x *Task) { x.Status = "queued" })
		}
	}
	kind, title := "paused", c.tr("全部暂停", "all paused")
	if !paused {
		kind, title = "resumed", c.tr("恢复派送", "resumed")
	}
	c.event(gid, Event{Bot: "you", Kind: kind, Title: title})
	if !paused {
		c.Pump(gid)
	}
	return nil
}

// ---- 文字：送达的任务包、送回的结果、开场说明、团队、任务清单 ----

func (c *Coordinator) taskText(g Group, t Task) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, c.tr("[Perch · 任务 %s · 来自 %s]\n", "[Perch · task %s · from %s]\n"), t.ID, c.role(g, t.From))
	sb.WriteString(t.Text)
	if t.Accept != "" {
		fmt.Fprintf(&sb, c.tr("\n验收标准：%s", "\nAcceptance: %s"), t.Accept)
	}
	if len(t.Files) > 0 {
		fmt.Fprintf(&sb, c.tr("\n相关文件：%s", "\nFiles: %s"), strings.Join(t.Files, "、"))
	}
	sb.WriteString(c.tr("\n做完运行：perch-bg done --summary \"<结果>\"（不运行也会在这一轮结束时自动交回）",
		"\nWhen done run: perch-bg done --summary \"<result>\" (otherwise it is returned automatically when this turn ends)"))
	return sb.String()
}

func (c *Coordinator) resultText(g Group, t Task) string {
	var sb strings.Builder
	head := map[string]string{"done": c.tr("交回", "returned"), "review": c.tr("交回 · 等你验收", "returned · needs your review"),
		"failed": c.tr("没完成", "failed"), "cancelled": c.tr("已取消", "cancelled")}[t.Status]
	auto := ""
	if t.Auto {
		auto = c.tr("（自动交回：它这一轮结束了没跑 perch-bg done，下面是它最后的回复）", " (auto-returned: its last reply)")
	}
	fmt.Fprintf(&sb, c.tr("[Perch · %s %s · 来自 %s]%s\n", "[Perch · %s %s · from %s]%s\n"), t.ID, head, c.role(g, t.To), auto)
	sb.WriteString(t.Result)
	if t.Branch != "" {
		fmt.Fprintf(&sb, c.tr("\n分支：%s · 提交 %s", "\nBranch: %s · commit %s"), t.Branch, t.Commit)
		if t.Dirty > 0 {
			fmt.Fprintf(&sb, c.tr("（还有 %d 个没提交的改动）", " (%d uncommitted changes)"), t.Dirty)
		}
	}
	if t.Status == "review" {
		fmt.Fprintf(&sb, c.tr("\n验收标准：%s\n通过：perch-bg review --task %s --pass yes　退回：perch-bg review --task %s --reject \"<意见>\"",
			"\nAcceptance: %s\nAccept: perch-bg review --task %s --pass yes   Reject: perch-bg review --task %s --reject \"<why>\""), t.Accept, t.ID, t.ID)
	}
	return sb.String()
}

// Intro 是一个 Bot 收到第一条消息时附在前面的开场说明（团队、分工、工作目录、记忆、命令）。
func (c *Coordinator) Intro(g Group, b Bot) string {
	var sb strings.Builder
	if c.zh() {
		fmt.Fprintf(&sb, "[Perch Bot Group「%s」] 你在团队里担任「%s」（%s）。目标：%s\n", g.Name, roleName(b), b.Agent, dash(g.Goal))
		sb.WriteString("团队：" + c.rosterLine(g) + "\n")
		if b.Instructions != "" {
			sb.WriteString("你的分工：" + b.Instructions + "\n")
		}
		if b.Manager {
			sb.WriteString("你是调度者：把目标拆成任务，用 perch-bg handoff 派给合适的成员；成员交回后你验收、安排合并，最后在群里向用户汇报。尽量不要自己动手做成员该做的事。\n")
		}
		if b.Worktree != "" {
			fmt.Fprintf(&sb, "你的工作目录：%s（分支 %s）。只在这里改、改完提交；合并由 Manager 安排。\n", b.Worktree, b.Branch)
		} else if b.Manager && g.Worktrees {
			sb.WriteString("每个成员在自己的 git worktree 里干活（分支 bg/" + g.ID + "/<成员 id>），交回时会附上分支和提交；合并用 git merge，冲突归合并的人。\n")
		}
		if cs := CirclesOf(g, b); len(cs) > 0 {
			var ps []string
			for _, cc := range cs {
				ps = append(ps, MemoryPath(g, cc))
			}
			sb.WriteString("共享记忆：" + strings.Join(ps, "、") + "（开工前读；决定 / 约定用 perch-bg memory add \"…\" 记进去）\n")
		}
		sb.WriteString("和团队协作只用 perch-bg 命令：perch-bg team｜perch-bg handoff --to <角色> --task \"…\" [--accept \"验收标准\"]｜perch-bg done --summary \"…\"｜perch-bg tasks｜perch-bg memory add \"…\"\n")
		sb.WriteString("收到的任务以「[Perch · 任务 T…]」开头，做完运行 perch-bg done；用户直接发给你的消息直接回复即可。")
		return sb.String()
	}
	fmt.Fprintf(&sb, "[Perch Bot Group %q] You are %s (%s) on this team. Goal: %s\n", g.Name, roleName(b), b.Agent, dash(g.Goal))
	sb.WriteString("Team: " + c.rosterLine(g) + "\n")
	if b.Instructions != "" {
		sb.WriteString("Your part: " + b.Instructions + "\n")
	}
	if b.Manager {
		sb.WriteString("You coordinate: split the goal into tasks and hand them to members with perch-bg handoff; review what they return, arrange merges, and report to the user in the group.\n")
	}
	if b.Worktree != "" {
		fmt.Fprintf(&sb, "Your working directory: %s (branch %s). Change and commit only here; the Manager arranges merges.\n", b.Worktree, b.Branch)
	}
	if cs := CirclesOf(g, b); len(cs) > 0 {
		var ps []string
		for _, cc := range cs {
			ps = append(ps, MemoryPath(g, cc))
		}
		sb.WriteString("Shared memory: " + strings.Join(ps, ", ") + " (read before you start; record decisions with perch-bg memory add \"…\")\n")
	}
	sb.WriteString("Work with the team only through perch-bg: team | handoff --to <role> --task \"…\" | done --summary \"…\" | tasks | memory add \"…\"")
	return sb.String()
}

func (c *Coordinator) rosterLine(g Group) string {
	var parts []string
	for _, b := range g.Bots {
		parts = append(parts, roleName(b)+"("+b.Agent+")")
	}
	return strings.Join(parts, "、")
}

func (c *Coordinator) teamText(g Group) string {
	tasks := c.d.Ledger.List(g.ID)
	var sb strings.Builder
	for _, b := range g.Bots {
		state := c.botState(g.ID, b.ID)
		cur := ""
		for _, t := range tasks {
			if t.To == b.ID && t.Active() {
				cur = " · " + t.ID + " " + t.Title()
			}
		}
		fmt.Fprintf(&sb, "%s（%s）%s%s\n", roleName(b), b.Agent, state, cur)
		if b.Instructions != "" {
			sb.WriteString("    " + clipText(b.Instructions, 80) + "\n")
		}
	}
	return strings.TrimRight(sb.String(), "\n")
}

func (c *Coordinator) tasksText(g Group, me Bot) string {
	var mine, sent []string
	for _, t := range c.d.Ledger.List(g.ID) {
		if !t.Open() && t.resultSent() {
			continue
		}
		line := fmt.Sprintf("%s [%s] %s", t.ID, t.Status, t.Title())
		if t.To == me.ID {
			mine = append(mine, line+c.tr("（来自 "+c.role(g, t.From)+"）", " (from "+c.role(g, t.From)+")"))
		}
		if t.From == me.ID {
			sent = append(sent, line+c.tr("（给 "+c.role(g, t.To)+"）", " (to "+c.role(g, t.To)+")"))
		}
	}
	out := c.tr("我手上：", "Mine: ") + orNone(mine, c.tr("没有", "none")) + "\n" + c.tr("我派出去的：", "Sent: ") + orNone(sent, c.tr("没有", "none"))
	return out
}

func (c *Coordinator) botState(gid, botID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	tab, ok := c.identTab[gid+"/"+botID]
	if !ok {
		return c.tr("没起来", "not started")
	}
	return map[string]string{"busy": c.tr("在干活", "working"), "waiting": c.tr("在等用户", "waiting for the user"), "idle": c.tr("空闲", "idle")}[c.status[tab]]
}

// ---- 小工具 ----

func (c *Coordinator) setStatus(gid, tid, st, reason string) {
	c.update(gid, tid, func(t *Task) {
		t.Status = st
		if reason != "" {
			t.Reason = reason
		}
	})
}

func (c *Coordinator) update(gid, tid string, f func(*Task)) {
	t, err := c.d.Ledger.Update(gid, tid, f)
	if err == nil {
		c.push(map[string]any{"type": "task.update", "group": gid, "task": t})
	}
}

func (c *Coordinator) event(gid string, e Event) {
	ev, err := c.d.Store.Append(gid, e)
	if err != nil {
		log.Printf("[botgroup] 记事件失败：%v", err)
		return
	}
	c.push(map[string]any{"type": "botgroup.event", "group": gid, "event": ev})
}

func (c *Coordinator) role(g Group, id string) string { return roleOf(g, id) }

func (c *Coordinator) tr(zh, en string) string {
	if c.zh() {
		return zh
	}
	return en
}

func roleName(b Bot) string {
	if b.Manager {
		return "Manager"
	}
	return b.Role
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '，' || r == '、' }) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func clipText(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return string(r)
}

func orNone(xs []string, none string) string {
	if len(xs) == 0 {
		return none
	}
	return "\n  " + strings.Join(xs, "\n  ")
}

func dash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func newToken() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// LedgerForTest 给剧本测试读账本用。
func (c *Coordinator) LedgerForTest() *Ledger { return c.d.Ledger }

// Tasks：一个组的任务（没完成的全给，完成的取最近的），给界面画交接链 / 过程流。
func (c *Coordinator) Tasks(gid string, limit int) []Task {
	all := c.d.Ledger.List(gid)
	if len(all) <= limit {
		return all
	}
	var open, closed []Task
	for _, t := range all {
		if t.Open() {
			open = append(open, t)
		} else {
			closed = append(closed, t)
		}
	}
	if n := limit - len(open); n > 0 && len(closed) > n {
		closed = closed[len(closed)-n:]
	} else if n <= 0 {
		closed = nil
	}
	return append(closed, open...)
}

// PrepareWorktrees 给组里该有 worktree 的 Bot 建好，返回新建了几个。
func (c *Coordinator) PrepareWorktrees(gid string) int {
	g, ok := c.d.Store.Get(gid)
	if !ok || !g.Worktrees {
		return 0
	}
	n := 0
	for _, b := range g.Bots {
		if !WantsWorktree(g, b) || b.Worktree != "" {
			continue
		}
		path, branch, err := EnsureWorktree(g, b)
		if err != nil {
			log.Printf("[botgroup] %s/%s 建 worktree 失败（它就用项目目录）：%v", gid, b.ID, err)
			continue
		}
		if err := c.d.Store.SetWorktree(gid, b.ID, path, branch); err == nil {
			log.Printf("[botgroup] %s/%s 的 worktree：%s（分支 %s）", gid, b.ID, path, branch)
			n++
		}
	}
	return n
}

// DropGroup：组删了 —— 账本一起删、那个组的口令作废。
func (c *Coordinator) DropGroup(gid string) {
	c.d.Ledger.Drop(gid)
	c.mu.Lock()
	for tok, id := range c.tokens {
		if id.Group == gid {
			delete(c.tokens, tok)
			delete(c.botTok, id.key())
		}
	}
	delete(c.cc, gid)
	c.mu.Unlock()
}
