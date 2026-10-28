package botbus

// 剧本 agent（借 LayerFS 的 scenarios）：不调模型，按剧本一步步像 perch-bg 那样调总线，
// 每一步写明期望的结果码；前端执行器也模拟掉（收到 bg.deliver 就回执 bg.delivered）。
// 编排逻辑（派活、送达、自动交回、去重、拦截、暂停、验收、抄送）都在这里回归。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yu7dan/perch/internal/botgroup"
	"github.com/yu7dan/perch/internal/transcript"
)

type rig struct {
	t      *testing.T
	store  *botgroup.Store
	co     *botgroup.Coordinator
	bus    *Server
	gid    string
	tok    map[string]string // bot id → 口令
	tab    map[string]int
	mu     sync.Mutex
	inbox  map[string][]botgroup.Delivery // bot id → 送到它终端里的东西
	events []botgroup.Event
}

func newRig(t *testing.T) *rig {
	dir, proj := t.TempDir(), t.TempDir()
	r := &rig{t: t, store: botgroup.Load(dir), tok: map[string]string{}, tab: map[string]int{}, inbox: map[string][]botgroup.Delivery{}}
	r.co = botgroup.NewCoordinator(botgroup.CoordDeps{Store: r.store, Ledger: botgroup.NewLedger(dir), Push: r.onPush})
	r.co.AutoReturnDelay = 30 * time.Millisecond
	bus, err := Start(r.co)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bus.Close)
	r.bus = bus
	r.co.SetBusURL(bus.URL)
	g, err := r.store.Create(botgroup.CreateInput{Name: "测试组", Project: proj, ManagerAgent: "claude",
		Bots: []botgroup.BotInput{{Role: "开发", Agent: "codex"}, {Role: "审阅", Agent: "pi"}, {Role: "测试", Agent: "claude"}}})
	if err != nil {
		t.Fatal(err)
	}
	r.gid = g.ID
	for i, b := range g.Bots {
		r.tab[b.ID] = 10 + i
		env := r.co.BotEnv(10+i, g.ID, b.ID)
		r.tok[b.ID] = env["PERCH_BG_TOKEN"]
	}
	return r
}

// onPush 模拟前端：bg.deliver 立刻「粘贴」进对方终端并回执。
func (r *rig) onPush(v any) {
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	switch m["type"] {
	case "bg.deliver":
		d := m["delivery"].(botgroup.Delivery)
		r.mu.Lock()
		r.inbox[d.Bot] = append(r.inbox[d.Bot], d)
		r.mu.Unlock()
		go r.co.Delivered(d.Group, d.Key)
	case "botgroup.event":
		r.mu.Lock()
		r.events = append(r.events, m["event"].(botgroup.Event))
		r.mu.Unlock()
	}
}

func (r *rig) call(bot, op string, body map[string]string, hdr ...string) botgroup.Reply {
	r.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, r.bus.URL+"/v1/"+op, bytes.NewReader(b))
	req.Header.Set("X-Perch-Token", r.tok[bot])
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	var rp botgroup.Reply
	_ = json.NewDecoder(resp.Body).Decode(&rp)
	return rp
}

func (r *rig) want(bot, op string, body map[string]string, code string) botgroup.Reply {
	r.t.Helper()
	rp := r.call(bot, op, body)
	if !strings.HasPrefix(rp.Code, code) {
		r.t.Fatalf("%s %s %v：结果码 %q（%s），期望 %q", bot, op, body, rp.Code, rp.Msg, code)
	}
	return rp
}

func (r *rig) task(id string) botgroup.Task {
	for _, x := range r.ledger().List(r.gid) {
		if x.ID == id {
			return x
		}
	}
	r.t.Fatalf("没有任务 %s", id)
	return botgroup.Task{}
}

func (r *rig) ledger() *botgroup.Ledger { return r.co.LedgerForTest() }

func (r *rig) waitStatus(id, st string) botgroup.Task {
	r.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if t := r.task(id); t.Status == st {
			return t
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatalf("%s 没变成 %s（现在 %s）", id, st, r.task(id).Status)
	return botgroup.Task{}
}

func (r *rig) inboxOf(bot string) []botgroup.Delivery {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]botgroup.Delivery(nil), r.inbox[bot]...)
}

func (r *rig) waitInbox(bot string, n int) []botgroup.Delivery {
	r.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if in := r.inboxOf(bot); len(in) >= n {
			return in
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatalf("%s 收件箱不到 %d 条：%v", bot, n, r.inboxOf(bot))
	return nil
}

// 一轮：agent 收到任务后开始干（忙）、说一句话、结束（闲）。
func (r *rig) turn(bot, say string) {
	tab := r.tab[bot]
	r.co.OnStatus(tab, "idle", "busy")
	time.Sleep(5 * time.Millisecond)
	r.co.Observe(map[string]any{"type": "acts", "tab": tab, "items": []transcript.ActItem{{ID: "x" + say, Kind: "text", Text: say, At: time.Now().UTC().Format(time.RFC3339Nano), Cum: 12000}}})
	r.co.OnStatus(tab, "busy", "idle")
}

func TestScenarioHandoffAutoReturn(t *testing.T) {
	r := newRig(t)
	r.want("manager", "ping", nil, "ok:pong")
	rp := r.want("manager", "handoff", map[string]string{"to": "开发", "task": "修 IME 候选窗", "rid": "r1"}, "ok:queued")
	if !strings.Contains(rp.Msg, "T1") {
		t.Fatalf("回答里没有任务号：%s", rp.Msg)
	}
	in := r.waitInbox("b1", 1)
	if !strings.Contains(in[0].Text, "[Perch · 任务 T1 · 来自 Manager]") || !strings.Contains(in[0].Text, "修 IME 候选窗") {
		t.Fatalf("送达的任务包不对：%q", in[0].Text)
	}
	r.waitStatus("T1", "delivered")
	// 同一条命令重试（同一个请求 id）：不派第二份
	r.want("manager", "handoff", map[string]string{"to": "开发", "task": "修 IME 候选窗", "rid": "r1"}, "ok:dup")
	// 开发干了一轮，没跑 perch-bg done → 自动交回，最后一句话送回 Manager
	r.turn("b1", "改好了：按行高算偏移，12/12 通过")
	done := r.waitStatus("T1", "done")
	if !done.Auto || !strings.Contains(done.Result, "12/12") {
		t.Fatalf("自动交回不对：%+v", done)
	}
	back := r.waitInbox("manager", 1)
	if !strings.Contains(back[0].Text, "T1 交回") || !strings.Contains(back[0].Text, "自动交回") {
		t.Fatalf("送回 Manager 的结果不对：%q", back[0].Text)
	}
}

func TestScenarioExplicitDoneCcReviewReject(t *testing.T) {
	r := newRig(t)
	r.want("manager", "handoff", map[string]string{"to": "开发", "task": "实现预选项目", "accept": "单项目预选、多项目空选", "rid": "a"}, "ok:queued")
	r.waitInbox("b1", 1)
	r.co.OnStatus(r.tab["b1"], "idle", "busy")
	// 开发直接把一部分派给测试（Bot 之间能直接派活，抄送 Manager）
	r.want("b1", "handoff", map[string]string{"to": "测试", "task": "补回归用例", "rid": "b"}, "ok:queued")
	r.waitInbox("b3", 1)
	if r.task("T2").Parent != "T1" || r.task("T2").Depth != 2 || !r.task("T2").Cc {
		t.Fatalf("子任务的父 / 深度 / 抄送不对：%+v", r.task("T2"))
	}
	r.want("b1", "done", map[string]string{"summary": "做完了，见 81b-new-agent.js", "rid": "c"}, "ok:review")
	back := r.waitInbox("manager", 1)
	if !strings.Contains(back[0].Text, "（抄送）") || !strings.Contains(back[0].Text, "等你验收") {
		t.Fatalf("Manager 收到的不对（要带抄送和验收提示）：%q", back[0].Text)
	}
	// Manager 退回 → 原来的人重做（深度不加）
	r.want("manager", "review", map[string]string{"task": "T1", "reject": "多项目时也预选了，不对", "rid": "d"}, "ok:rejected")
	again := r.waitInbox("b1", 2)
	if !strings.Contains(again[1].Text, "【退回】多项目时也预选了") {
		t.Fatalf("退回的任务包不对：%q", again[1].Text)
	}
	if r.task("T1").Depth != 1 {
		t.Fatal("退回不该加深度")
	}
}

func TestScenarioGuards(t *testing.T) {
	r := newRig(t)
	r.want("manager", "handoff", map[string]string{"to": "Manager", "task": "x", "rid": "1"}, "refused:self")
	r.want("manager", "handoff", map[string]string{"to": "运维", "task": "x", "rid": "2"}, "refused:target")
	r.want("b2", "done", map[string]string{"rid": "3"}, "refused:none")
	// 来回踢：开发 ↔ 审阅 之间来回 3 次 → 被拦、问用户
	r.want("manager", "handoff", map[string]string{"to": "开发", "task": "写", "rid": "4"}, "ok:queued")
	r.waitInbox("b1", 1)
	r.want("b1", "handoff", map[string]string{"to": "审阅", "task": "看看", "rid": "5"}, "ok:queued")
	r.waitInbox("b2", 1)
	r.want("b2", "handoff", map[string]string{"to": "开发", "task": "再改", "rid": "6"}, "ok:queued")
	r.co.Delivered(r.gid, "task:T3") // 开发手上还压着 T1：手动把 T3 标成在它手上，模拟它接着做
	rp := r.want("b1", "handoff", map[string]string{"to": "审阅", "task": "再看", "parent": "T3", "rid": "7"}, "queued:blocked")
	if !strings.Contains(rp.Msg, "来回") {
		t.Fatalf("被拦的原因不对：%s", rp.Msg)
	}
	tid := ""
	for _, x := range r.ledger().List(r.gid) {
		if x.Status == "blocked" {
			tid = x.ID
		}
	}
	if err := r.co.Answer(r.gid, tid, "allow"); err != nil {
		t.Fatal(err)
	}
	if st := r.task(tid).Status; st != "queued" && st != "delivered" {
		t.Fatalf("放行之后应该排着 / 送达，现在 %s", st)
	}
}

func TestScenarioPauseResume(t *testing.T) {
	r := newRig(t)
	if err := r.co.SetPaused(r.gid, true); err != nil {
		t.Fatal(err)
	}
	r.want("manager", "handoff", map[string]string{"to": "审阅", "task": "看 diff", "rid": "p1"}, "paused")
	time.Sleep(50 * time.Millisecond)
	if len(r.inboxOf("b2")) != 0 {
		t.Fatal("暂停时不该送达")
	}
	if err := r.co.SetPaused(r.gid, false); err != nil {
		t.Fatal(err)
	}
	r.waitInbox("b2", 1)
	r.waitStatus("T1", "delivered")
}

func TestScenarioBusRefusesBrowsersAndBadTokens(t *testing.T) {
	r := newRig(t)
	if rp := r.call("manager", "ping", nil, "Origin", "https://evil.example"); rp.Code != "refused:origin" {
		t.Fatalf("带 Origin 的请求应该被拒：%+v", rp)
	}
	r.tok["manager"] = "nope"
	if rp := r.call("manager", "ping", nil); rp.Code != "refused:token" {
		t.Fatalf("错口令应该被拒：%+v", rp)
	}
}

func TestScenarioMemory(t *testing.T) {
	r := newRig(t)
	r.want("b1", "memory.add", map[string]string{"text": "多行偏移按行高算", "rid": "m1"}, "ok:memory")
	rp := r.want("b2", "memory.show", nil, "ok:memory")
	if !strings.Contains(rp.Msg, "**开发**") || !strings.Contains(rp.Msg, "多行偏移按行高算") {
		t.Fatalf("共享记忆读不到别人写的：%s", rp.Msg)
	}
	// 纯调度：默认谁都不共享
	mode := "dispatch"
	if _, err := r.store.UpdateGroup(r.gid, botgroup.GroupPatch{MemoryMode: &mode}); err != nil {
		t.Fatal(err)
	}
	r.want("b1", "memory.add", map[string]string{"text": "x", "rid": "m2"}, "refused:memory")
	if _, err := r.store.SetCircles(r.gid, "b1", []string{"前端"}); err != nil {
		t.Fatal(err)
	}
	r.want("b1", "memory.add", map[string]string{"text": "只在前端圈里", "rid": "m3"}, "ok:memory")
	r.want("b2", "memory.show", map[string]string{"circle": "前端"}, "refused:memory")
	if rp := r.want("manager", "memory.show", map[string]string{"circle": "前端"}, "ok:memory"); !strings.Contains(rp.Msg, "只在前端圈里") {
		t.Fatalf("Manager 应该能看所有圈：%s", rp.Msg)
	}
}
