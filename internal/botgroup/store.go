// Package botgroup 是 Bot Group 的数据层（2026-10-28，阶段 B）。
//
// 一个 Bot Group = 一个目标下的一组 Bot：Manager 负责拆任务、盯进度，其余 Bot 各管一个
// 方向。每个 Bot 背后是一个**真实的 agent 格**（PaneID），只是不出现在 Workspaces 里。
// 组可以从某个 Agent 衍生（那个 Agent 直接当 Manager，上下文最全），也可以独立创建。
//
// 落盘：
//   - %APPDATA%\Perch\botgroups.json —— 组、Bot（小、整份重写、原子 rename）；
//   - %APPDATA%\Perch\botgroups\<组>\events.jsonl —— 过程流，**只追加**，事件带递增 id，
//     前端按 id 续读，不按条数（见 live-list-must-anchor-by-id）。
//   - <项目>\.perch\botgroups\<组>\brief.md —— 共享记忆，放在项目里，Bot 们都读得到
//     （注入到各个 Bot 的启动参数是阶段 C 的事）。
package botgroup

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FileName 是组清单的文件名（在 Perch 的数据目录下）。
const FileName = "botgroups.json"

// Source 说明这个组从哪来。
type Source struct {
	Kind   string `json:"kind"`             // "derived"（从某个 Agent 衍生）| "standalone"
	PaneID int    `json:"paneId,omitempty"` // 衍生时：原 Agent 的格子（它直接当 Manager）
	Agent  string `json:"agent,omitempty"`  // 衍生时：原 Agent 是哪个 agent
	Title  string `json:"title,omitempty"`  // 衍生时：原 Agent 当时的标题（给人认）
}

// Bot 是组里的一个成员。Manager 也是一个 Bot（Manager=true）。
type Bot struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	Agent     string `json:"agent"`
	PaneID    int    `json:"paneId,omitempty"` // 0 = 格子还没起来
	Manager   bool   `json:"manager,omitempty"`
	Task      string `json:"task,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// Group 是一个 Bot Group。
type Group struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Goal      string `json:"goal,omitempty"`
	Project   string `json:"project"` // 项目目录（Bot 们都在这里干活）
	Source    Source `json:"source"`
	Bots      []Bot  `json:"bots"`
	CreatedAt string `json:"createdAt"`
	Brief     string `json:"brief,omitempty"` // 共享记忆文件的路径
}

// Event 是过程流里的一条。ID 在组内单调递增。
type Event struct {
	ID    int64  `json:"id"`
	TS    string `json:"ts"`
	Bot   string `json:"bot,omitempty"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Text  string `json:"text,omitempty"`
}

// EventKinds 是过程流认识的事件种类（前端按它画符号；不认识的一律不收）。
var EventKinds = map[string]bool{
	"created": true, "started": true, "working": true, "waiting": true, "idle": true,
	"stopped": true, "msg": true, "handoff": true, "artifact": true, "commit": true,
	"test": true, "fail": true, "retry": true, "review": true, "approval": true, "memory": true,
}

type file struct {
	Version int     `json:"version"`
	Groups  []Group `json:"groups"`
}

// Store 持有组清单和事件日志。零值不可用；用 Load 构造。
type Store struct {
	mu     sync.Mutex
	dir    string // Perch 数据目录
	f      file
	seq    map[string]int64 // 组 → 最后一条事件 id（懒加载）
	broken bool
}

// Load 读组清单。dir 为空 = 只活在内存里（测试 / 拿不到数据目录）。
func Load(dir string) *Store {
	s := &Store{dir: dir, f: file{Version: 1}, seq: map[string]int64{}}
	if dir == "" {
		return s
	}
	b, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.broken = true
			log.Printf("[botgroup] ⚠️ 读组清单失败（保持原样、不覆盖）：%v", err)
		}
		return s
	}
	if err := json.Unmarshal(b, &s.f); err != nil {
		s.broken = true
		log.Printf("[botgroup] ⚠️ 组清单解析失败，保持原样、一次都不覆盖：%v", err)
		return s
	}
	log.Printf("[botgroup] 载入 %d 个组", len(s.f.Groups))
	return s
}

// List 返回所有组（拷贝）。
func (s *Store) List() []Group {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Group, len(s.f.Groups))
	for i, g := range s.f.Groups {
		g.Bots = append([]Bot(nil), g.Bots...)
		out[i] = g
	}
	return out
}

// BotInput 是建组时的一个 Bot。
type BotInput struct {
	Role  string `json:"role"`
	Agent string `json:"agent"`
	Task  string `json:"task,omitempty"`
}

// CreateInput 是建组请求。衍生时给 SourcePane / SourceAgent（原 Agent 当 Manager）；
// 独立创建时给 ManagerAgent（新起一个 Manager 格）。
type CreateInput struct {
	Name         string     `json:"name"`
	Goal         string     `json:"goal"`
	Project      string     `json:"project"`
	SourcePane   int        `json:"sourcePane,omitempty"`
	SourceAgent  string     `json:"sourceAgent,omitempty"`
	SourceTitle  string     `json:"sourceTitle,omitempty"`
	ManagerAgent string     `json:"managerAgent,omitempty"`
	Bots         []BotInput `json:"bots"`
}

// Create 建一个组。Manager 是第一个 Bot：衍生时直接绑上原 Agent 的格子。
func (s *Store) Create(in CreateInput) (Group, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return Group{}, fmt.Errorf("Bot Group 需要一个名称")
	}
	proj := strings.TrimSpace(in.Project)
	if proj == "" {
		return Group{}, fmt.Errorf("Bot Group 需要一个项目目录")
	}
	if fi, err := os.Stat(proj); err != nil || !fi.IsDir() {
		return Group{}, fmt.Errorf("项目目录不存在：%s", proj)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	g := Group{
		ID: "g" + strconv.FormatInt(time.Now().UnixMilli(), 36), Name: name,
		Goal: strings.TrimSpace(in.Goal), Project: proj, CreatedAt: now,
	}
	mgr := Bot{ID: "manager", Role: "Manager", Manager: true, CreatedAt: now}
	if in.SourcePane > 0 {
		if in.SourceAgent == "" {
			return Group{}, fmt.Errorf("衍生时要知道原 Agent 是哪个 agent")
		}
		g.Source = Source{Kind: "derived", PaneID: in.SourcePane, Agent: in.SourceAgent, Title: strings.TrimSpace(in.SourceTitle)}
		mgr.Agent, mgr.PaneID = in.SourceAgent, in.SourcePane
	} else {
		if in.ManagerAgent == "" {
			return Group{}, fmt.Errorf("独立创建时要给 Manager 选一个 agent")
		}
		g.Source = Source{Kind: "standalone"}
		mgr.Agent = in.ManagerAgent
	}
	g.Bots = append(g.Bots, mgr)
	for i, b := range in.Bots {
		role := strings.TrimSpace(b.Role)
		if role == "" || b.Agent == "" {
			return Group{}, fmt.Errorf("第 %d 个 Bot 缺少角色或 agent", i+1)
		}
		g.Bots = append(g.Bots, Bot{ID: fmt.Sprintf("b%d", i+1), Role: role, Agent: b.Agent,
			Task: strings.TrimSpace(b.Task), CreatedAt: now})
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return Group{}, fmt.Errorf("botgroups.json 解析失败，为了不覆盖它，这次没有保存")
	}
	if in.SourcePane > 0 {
		if gid, _, ok := s.groupOfPaneLocked(in.SourcePane); ok {
			return Group{}, fmt.Errorf("这个 Agent 已经是 Bot Group %s 的成员", gid)
		}
	}
	g.Brief = briefPath(proj, g.ID)
	s.f.Groups = append(s.f.Groups, g)
	if err := s.saveLocked(); err != nil {
		s.f.Groups = s.f.Groups[:len(s.f.Groups)-1]
		return Group{}, err
	}
	if err := writeBrief(g); err != nil {
		log.Printf("[botgroup] 共享记忆没写成（组照样建）：%v", err)
	}
	return g, nil
}

// BindPane 记下某个 Bot 的格子（格子起来、拿到 paneId 之后调）。
func (s *Store) BindPane(gid, botID string, paneID int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for gi := range s.f.Groups {
		if s.f.Groups[gi].ID != gid {
			continue
		}
		for bi := range s.f.Groups[gi].Bots {
			if s.f.Groups[gi].Bots[bi].ID == botID {
				s.f.Groups[gi].Bots[bi].PaneID = paneID
				return s.saveLocked()
			}
		}
		return fmt.Errorf("组 %s 里没有 Bot %s", gid, botID)
	}
	return fmt.Errorf("找不到组 %s", gid)
}

// GroupOfPane 告诉你一个格子属于哪个组 / 哪个 Bot。
func (s *Store) GroupOfPane(paneID int) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.groupOfPaneLocked(paneID)
}

func (s *Store) groupOfPaneLocked(paneID int) (string, string, bool) {
	if paneID <= 0 {
		return "", "", false
	}
	for _, g := range s.f.Groups {
		for _, b := range g.Bots {
			if b.PaneID == paneID {
				return g.ID, b.ID, true
			}
		}
	}
	return "", "", false
}

// Delete 删掉一个组的记录和它的过程流（Bot 的格子由调用方决定关不关）。
// 共享记忆 brief.md 在项目里，属于用户的文件，不删。
func (s *Store) Delete(gid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.f.Groups[:0]
	found := false
	for _, g := range s.f.Groups {
		if g.ID == gid {
			found = true
			continue
		}
		out = append(out, g)
	}
	if !found {
		return fmt.Errorf("找不到组 %s", gid)
	}
	s.f.Groups = out
	delete(s.seq, gid)
	if s.dir != "" {
		_ = os.RemoveAll(filepath.Join(s.dir, "botgroups", gid))
	}
	return s.saveLocked()
}

// ---- 过程流 ----

// Append 记一条事件，返回带上 id / 时间的那条。
func (s *Store) Append(gid string, e Event) (Event, error) {
	if !EventKinds[e.Kind] {
		return e, fmt.Errorf("不认识的事件种类 %q", e.Kind)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasGroupLocked(gid) {
		return e, fmt.Errorf("找不到组 %s", gid)
	}
	last, err := s.lastIDLocked(gid)
	if err != nil {
		return e, err
	}
	e.ID = last + 1
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339)
	}
	s.seq[gid] = e.ID
	if s.dir == "" {
		return e, nil
	}
	p := s.eventsPath(gid)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return e, err
	}
	fh, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return e, err
	}
	defer fh.Close()
	b, _ := json.Marshal(e)
	_, err = fh.Write(append(b, '\n'))
	return e, err
}

// Events 返回 id > since 的事件（最多 limit 条，取最新的那一段）。
func (s *Store) Events(gid string, since int64, limit int) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dir == "" {
		return nil
	}
	all := readEvents(s.eventsPath(gid))
	out := all[:0]
	for _, e := range all {
		if e.ID > since {
			out = append(out, e)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func (s *Store) hasGroupLocked(gid string) bool {
	for _, g := range s.f.Groups {
		if g.ID == gid {
			return true
		}
	}
	return false
}

func (s *Store) lastIDLocked(gid string) (int64, error) {
	if v, ok := s.seq[gid]; ok {
		return v, nil
	}
	var last int64
	if s.dir != "" {
		for _, e := range readEvents(s.eventsPath(gid)) {
			if e.ID > last {
				last = e.ID
			}
		}
	}
	s.seq[gid] = last
	return last, nil
}

func (s *Store) eventsPath(gid string) string {
	return filepath.Join(s.dir, "botgroups", gid, "events.jsonl")
}

func readEvents(path string) []Event {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Event
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var e Event
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.ID > 0 {
			out = append(out, e)
		}
	}
	return out
}

func (s *Store) saveLocked() error {
	if s.dir == "" {
		return nil
	}
	b, err := json.MarshalIndent(s.f, "", "  ")
	if err != nil {
		return err
	}
	p := filepath.Join(s.dir, FileName)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// ---- 共享记忆 ----

func briefPath(project, gid string) string {
	return filepath.Join(project, ".perch", "botgroups", gid, "brief.md")
}

// writeBrief 建组时写一份起始的共享记忆（已存在就不动 —— 那是用户 / Bot 写过的东西）。
func writeBrief(g Group) error {
	p := g.Brief
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", g.Name)
	if g.Goal != "" {
		fmt.Fprintf(&b, "## 目标\n\n%s\n\n", g.Goal)
	}
	b.WriteString("## 成员\n\n")
	for _, bot := range g.Bots {
		task := ""
		if bot.Task != "" {
			task = " —— " + bot.Task
		}
		fmt.Fprintf(&b, "- **%s**（%s）%s\n", bot.Role, bot.Agent, task)
	}
	b.WriteString("\n## 共享记忆\n\n（Manager 和各个 Bot 在这里记下决定、约定和交接要点。）\n")
	return os.WriteFile(p, []byte(b.String()), 0o644)
}

// MaxBots 是一个组里 Bot 的上限（不算 Manager），和前端车道色的数目一致。
const MaxBots = 6

// AddBot 给已有的组再加一个 Bot（页头「加 Bot」）。id 接着往下编（b1、b2…，删过的不复用）。
func (s *Store) AddBot(gid string, in BotInput) (Bot, error) {
	role := strings.TrimSpace(in.Role)
	if role == "" || in.Agent == "" {
		return Bot{}, fmt.Errorf("新 Bot 缺少角色或 agent")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return Bot{}, fmt.Errorf("botgroups.json 解析失败，为了不覆盖它，这次没有保存")
	}
	for gi := range s.f.Groups {
		g := &s.f.Groups[gi]
		if g.ID != gid {
			continue
		}
		n, top := 0, 0
		for _, b := range g.Bots {
			if b.Manager {
				continue
			}
			n++
			if v, err := strconv.Atoi(strings.TrimPrefix(b.ID, "b")); err == nil && v > top {
				top = v
			}
		}
		if n >= MaxBots {
			return Bot{}, fmt.Errorf("每个组最多 %d 个 Bot", MaxBots)
		}
		b := Bot{ID: fmt.Sprintf("b%d", top+1), Role: role, Agent: in.Agent,
			Task: strings.TrimSpace(in.Task), CreatedAt: time.Now().UTC().Format(time.RFC3339)}
		g.Bots = append(g.Bots, b)
		if err := s.saveLocked(); err != nil {
			g.Bots = g.Bots[:len(g.Bots)-1]
			return Bot{}, err
		}
		return b, nil
	}
	return Bot{}, fmt.Errorf("找不到组 %s", gid)
}
