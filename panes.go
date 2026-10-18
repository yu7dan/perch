package main

/* ---------------------------------------------------------------------------
   格子登记表（冷恢复 · C1）—— "上次开了哪几格、各跑哪条会话"
   ---------------------------------------------------------------------------
   没有它的时候：**关掉再开＝一格全新空会话**。格子身份（sessionID /
   transcript / cwd）每天都拿到、但一个字节都不落盘，于是用户回来既不知道
   上次做到哪，也不知道怎么接上。

   它记的是**意图**，不是运行状态：`{paneId, agent, cwd, sessionId}`。
   命令行由 agentDefs.Args 现翻译（claude → `--resume <id>`），所以这张表
   里**没有一个字节**是 claude 的私事。

   ⚠️ 三样东西**刻意不落盘**：
     · status / 忙闲 / 未读 —— 状态一秒一变，存进来就是第二份必然会漂的事实；
       而且"重启后不许假装在跑"（Orca 的 restoredUnconfirmed 三条不变量）
       对我们**不需要实现**：状态一个字节都没存过，重启后无从假装。
     · 用户起的名字 —— titles.json 已经是唯一一份事实（见 titles.go）。
     · 会话正文 —— 那是转录文件的事（我们连解析都不做，判"在不在"只 glob）。

   与 projects.go 的四处刻意不同（都是评审挑出来的，各有代价）：
     ① **坏文件不是永久拒写，而是改名留证后开新的**。池子是用户一件件攒的
        （不可再生）；这份记录是**派生状态** —— 它记的事实（会话 id、cwd）
        在会话库里、在盘的 mtime 里都还在。永久只读 = 冷恢复永久失效，
        而且只有日志一行，那个代价比"少数几条记不下"大得多。
        只有 `version` 比我们新（我们比写它的程序旧）才真只读。
     ② **节流用 leading-edge + 关窗同步 flush**（不是后沿去抖）。建格到绑上
        身份之间只有 1–3 秒，正是最脆的窗口；后沿去抖会把写入一直往后推，
        "刚好在这个窗口里被关掉"就什么都没留下 —— Orca 的原话是
        `an isolated change is written on the next turn … cannot postpone it`
        （server-persistence.ts:95-96）。
     ③ **关格 ≠ 删记录**。用户点格子头的 × = **关掉这个 agent 的运行**
        （`Closed:true`，记录留着，重启后也不自动拉起，只以「已关闭」出现在
        左栏，点一下在原座位接上）；只有「结束这个 agent」才发 forget。
        格子因为别的原因消失（进程挂了、流断了、窗口关了）**一行都不许动** ——
        "记录是证据，不是垃圾"（Orca ③）。
        ⚠️ 只有一条窄到不能再窄的例外：冷恢复时发现**两条记录指着同一条会话**
        （见 restorePlan / pruneDup）。那不是"证据"，是一份自相矛盾的记录 ——
        同一条会话不可能同时被两格接上，留着它等于每次重启都重新判定一个
        永远不会被认领的座位。除它之外，任何"顺手清理"都是错的。
     ④ **paneId 从盘上最大的那个往后发**，不是从 1 开始。冷恢复认领的是**旧**
        id（比如 3）；计数器要是也从 1 开始发，下一次新建的格子也叫 3，
        盘上就出现两条 id=3 的记录，而且不报错（见 nextID）。
   --------------------------------------------------------------------------- */

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Pane 是**落盘的那份形状**。算出来的东西（这一格现在跑着没有、是哪条会话在跑）
// 一律不在这里 —— 那是每次冷恢复现算的（见 resume.go 的护栏与 status.go 的登记表）。
type Pane struct {
	// PaneID 是这一格的**身份**：跨重启不变，由 Go 发（见 nextID / claim）。
	// ⚠️ 它**不是** tab id —— tab id 每次启动重新发（1、2、3…），
	// 拿它当身份的话，重启后 1 号格就会继承上次 1 号格的会话（那正是"接错会话"）。
	PaneID int    `json:"paneId"`
	Agent  string `json:"agent"`
	CWD    string `json:"cwd"` // **生效值**（spec 里空串时是 defaultCWD() 那个），不是原始意图
	// SessionID 为空 = "这一格开着，但还没绑上任何会话" —— 那也是一件事实
	// （重启时它意味着"这一格的座位还在"），所以**空也记**。
	SessionID  string `json:"sessionId,omitempty"`
	Transcript string `json:"transcript,omitempty"`
	LastSeenAt string `json:"lastSeenAt"`
	// Spoke：这条会话**真的说过话**（至少一轮跑完）。
	//
	// ⚠️ 为什么这件事非记不可，而且非记在盘上不可：没说过话的格子**盘上根本没有
	// jsonl**（实测 2026-10-16：`SessionStart` 报了 session id，项目目录里却是空的；
	// 只有格内 `/exit` 优雅退出时才落一份 2KB 的零轮次文件）。所以重启时"会话文件
	// 不在了"这一个事实**分不出两件完全相反的事**：
	//
	//	(a) 这一格上次压根没说话 → 什么都没丢，安静地开新格就是（别吓唬用户）；
	//	(b) 说过话、转录却没了（删了/过了保留期）→ 这是真的丢了东西，要说出来。
	//
	// 判据本来该像 Orca 那样从文件里数（`messageCount > 0`，
	// ai-vault-types.ts:177-190："resuming a zero-turn transcript lands in an empty
	// session"）—— 而我们的文件恰恰在那时**不在**，所以只能在这里记一笔。
	// 写它的是 hooks.go 的 Stop/StopFailure（那是"一轮跑完"的官方信号）。
	Spoke bool `json:"spoke,omitempty"`
	// MismatchAt：**续接落空**时的那一笔（"我请求的是 X、实际来的是 Y"）。
	// 留在记录里而不是只打一行日志：下一条记录要能看出"这一格上次没接上"，
	// 而日志是会滚掉的。写它的是 hooks.go 的证据规则（步 5）。
	MismatchAt string `json:"mismatchAt,omitempty"`
	/* DegradedFrom / DegradedAt：这一格的记录**最近一次**是"降级"来的。

	   ⚠️ 它和 MismatchAt 的区别只有一个字：**知不知情**。
	     mismatch   请求 exact X、回来的却是 Y —— 我们**没搞懂**发生了什么，
	                所以记录里那条 id **一个字都不改**（X 是证据）。
	     degrade    请求 exact X，被护栏拒了（或盘上找不到），**我们主动**把这一格
	                改成起一条新会话 —— 这是知情地换目标，所以记录必须跟着走到
	                新会话，否则它就成了一条假的意图（下次重开会一直去接一条
	                我们早就放弃了的会话）。

	   那为什么还要留一笔旧的：因为降级唯一的出口是**格内横幅**，而横幅点一下就
	   收掉了。收掉之后，从盘上再也看不出"这一格原本要接的是另一条会话" ——
	   用户过几天回来，只会看到这一格跑着一条他没印象的会话，而记录长得跟他自己
	   开的格子一模一样。留一笔 = 把那条横幅说过的话留在证据里。

	   ⚠️ 这是**历史**，不是**状态**：写下来就一直留着（**不自动清**），下一次真的
	   又降级才覆盖（带新时间戳）。理由很具体：降级之后记录就指向新会话了，
	   下一次重开接的正是它、而且会**接上**（evMatched）—— 要是照 mismatchAt 那条
	   "证实即清"的规则走，这一笔活不过下一次重启，等于白写。 */
	DegradedFrom string `json:"degradedFrom,omitempty"`
	DegradedAt   string `json:"degradedAt,omitempty"`

	/* Closed：用户**关掉了这一格的运行**（点格子头的 ×），但没说要结束这个
	   agent —— 记录留着，重启后**不自动拉起**（不占座位），只以「已关闭」
	   出现在左栏工作区里；点它 = 同一个 paneId 接上同一条会话。

	   ⚠️ 它和 forget 的分工是这一轮最要紧的一条：× 是"我现在不需要它开着"，
	   forget 是"我不要这个 agent 了"（菜单里的「结束这个 agent」）。以前 × 直接
	   发 forget，于是"关掉面板里那格"等于"把它从工作区里删掉" —— 用户报的那个
	   bug 就是这么来的。留着 Closed 这条记录，那格下次还在。
	   ⚠️ 它**不是运行状态**（不违反"状态不落盘"）：它是用户的一次**意图**
	   （"先收起来"），和 Pane 记的其它东西同一性质。 */
	Closed bool `json:"closed,omitempty"`
}

const (
	paneStoreFile    = "panes.json"
	paneStoreVersion = 1
	/* leading-edge 节流窗：一次变化**立刻写**，250ms 内的后续变化合并成一次补写。
	   这个数只跟"建格 → 绑上身份"那 1–3 秒有关，不跟人机交互有关 ——
	   所以它比任何"防抖"都短（防抖是**推迟**，而这里最怕的正是推迟）。 */
	paneFlushWindow = 250 * time.Millisecond
)

type paneStore struct {
	mu      sync.Mutex
	file    string
	Panes   []Pane `json:"panes"`
	Version int    `json:"version"`

	// readOnly = 文件里的 version 比我们新。这时候**一次都不许覆盖** ——
	// 新版本可能加了字段，我们写回去就是把它悄悄删了。
	readOnly bool

	// dirty：内存比盘上新。next：下一个要发的 paneId。
	dirty bool
	next  int

	// leading-edge 节流（见 paneFlushWindow）
	lastFlush  time.Time
	timer      *time.Timer
	pendingWhy string

	// forgetting：**本次**写入是 forget 触发的 —— 只有它允许把记录数写成 0
	// （见 writeLocked 里那条断言）。
	forgetting bool
}

func paneStoreFilePath() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	// 与池子同一个目录（%APPDATA%\Perch）。**绝不**写进 claudeStateDir ——
	// 那是 claude 自己的状态根，两家状态不许搅在一起（projects.go:11-13 同款理由）。
	return filepath.Join(d, poolDirName, paneStoreFile), nil
}

// loadPaneStore 读登记表。三条出口：
//
//	文件不在            → 空表（第一次写入会建它）
//	文件在、但解析不了  → **改名留证**（panes.json.bad-<ts>）后开新的（见文件头 ①）
//	version 比我们新    → 只读（只有这一种情况真只读）
func loadPaneStore() *paneStore {
	p := &paneStore{Version: paneStoreVersion}
	f, err := paneStoreFilePath()
	if err != nil {
		p.readOnly = true
		log.Printf("[panes] 拿不到用户配置目录，这轮按只读：%v", err)
		return p
	}
	p.file = f

	b, err := os.ReadFile(f)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			p.readOnly = true
			log.Printf("[panes] 读登记表失败，这轮按只读（**不拿它去覆盖任何东西**）：%v", err)
			return p
		}
		log.Printf("[panes] 还没有登记表，先按空的来（第一次落盘会建 %s）", f)
		return p
	}
	var disk struct {
		Panes   []Pane `json:"panes"`
		Version int    `json:"version"`
	}
	if err := json.Unmarshal(b, &disk); err != nil {
		bad := f + ".bad-" + time.Now().Format("20060102-150405")
		if rerr := os.Rename(f, bad); rerr != nil {
			p.readOnly = true
			log.Printf("[panes] ⚠️ 登记表解析失败（%v），而改名留证也失败（%v）→ 这轮只读", err, rerr)
			return p
		}
		log.Printf("[panes] ⚠️ 登记表解析失败（%v）→ 已改名留证 %s，本轮起用新的（冷恢复这一轮会少几条，不是永久只读）",
			err, filepath.Base(bad))
		return p
	}
	if disk.Version > paneStoreVersion {
		p.readOnly = true
		log.Printf("[panes] ⚠️ 登记表版本比我们新（v%d > v%d）→ 只读，一次都不覆盖（子集写回去会删掉新版的字段）",
			disk.Version, paneStoreVersion)
		return p
	}
	p.Panes = disk.Panes
	log.Printf("[panes] 载入 %d 条格子记录（%s）", len(p.Panes), f)
	return p
}

func (p *paneStore) findLocked(id int) int {
	for i := range p.Panes {
		if p.Panes[i].PaneID == id {
			return i
		}
	}
	return -1
}

// nextID 发一个新的 paneId：**从盘上最大的那个往后发**（见文件头 ④）。
func (p *paneStore) nextID() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.next <= 0 {
		p.next = 1
		for _, x := range p.Panes {
			if x.PaneID >= p.next {
				p.next = x.PaneID + 1
			}
		}
	}
	id := p.next
	p.next++
	return id
}

// claim 让"冷恢复建出来的这一格"认领记录里的旧 paneId（前端把它原样回传，
// 见 main.go 的 spawnSpec.PaneID）。记录里没有这个 id 也**认**：那说明前端
// 手里那份和盘上不一样（比如盘上那条刚被 forget），此时宁可让它活着，
// 也不要静默把它换成别的身份 —— 换身份就是"接错会话"。
func (p *paneStore) claim(id int, why string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id <= 0 {
		return
	}
	/* 游标可能是**第一次**在这里被碰到（冷恢复的 claim 比任何 nextID 都早）。
	   初始化必须扫全表，不能只按 id+1 设：盘上可能有比 id **更大**的记录
	   （典型是一条「已关闭」的），只按 id+1 设游标，nextID 之后会把它再发一次
	   —— 新格会占用/覆盖那条已关闭 agent 的身份。
	   2026-10-17 实测：冷恢复 claim(42) 把游标设成 43，盘上还有已关闭的 44，
	   于是新开的两个格拿到 43、44；pane 44 那条「ai工作台 · 已关闭」的记录
	   被新会话整个盖掉（sessionId/cwd 全变了，Closed:true 还挂着）。 */
	if p.next <= 0 {
		p.next = 1
		for _, x := range p.Panes {
			if x.PaneID >= p.next {
				p.next = x.PaneID + 1
			}
		}
	}
	if id >= p.next {
		// 别让 nextID 以后又发一个同一个号（那会出现两条同 id 的记录）
		p.next = id + 1
	}
	i := p.findLocked(id)
	if i < 0 {
		log.Printf("[panes] 认领了一个盘上没有的 paneId=%d（%s）—— 照用，不换身份", id, why)
		return
	}
	/* 认领 = 这个座位又活过来了：把「已关闭」撤掉，否则下一次重启会把它当成
	   "用户不要它开着"而跳过，用户明明刚把它接上。 */
	if p.Panes[i].Closed {
		p.Panes[i].Closed = false
		p.Panes[i].LastSeenAt = time.Now().UTC().Format(time.RFC3339)
		p.dirty = true
		p.scheduleLocked("重新接上 pane=" + itoa(id) + "（" + why + "）")
		log.Printf("[panes] pane=%d 重新活过来（%s）—— 「已关闭」撤掉", id, why)
	}
}

// bind 记下/更新一格的记录（建格、绑上身份、拿到转录路径都走它）。
//
// ⚠️ 空值一律**不覆盖**：SessionID / Transcript 是"晚一点才知道"的那部分，
// 用空串去盖会把已经知道的身份抹掉（这一轮最贵的一种错就是"接错会话"）。
// 所以签名里没有"改哪一条"的裁剪空间，调用方只能往里放非空值。
func (p *paneStore) bind(id int, agent, cwd, sessionID, transcript, why string) {
	if id <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 {
		p.Panes = append(p.Panes, Pane{PaneID: id})
		i = len(p.Panes) - 1
	}
	cur := &p.Panes[i]
	/* 有活着的运行在写这条记录 ⇒ 它不可能是「已关闭」。正常路径上 claim 已经
	   撤过（冷恢复）；这里是兜底：万一 nextID 发了一个盘上已有的号（见 claim
	   里 2026-10-17 那次实测），留下的就会是"Closed:true 却正在跑" —— 重启
	   不恢复，用户刚建的那一格凭空消失。 */
	if cur.Closed {
		cur.Closed = false
		log.Printf("[panes] pane=%d 有运行在写、却还挂着「已关闭」—— 撤掉（%s）", id, why)
	}
	if agent != "" {
		cur.Agent = agent
	}
	if cwd != "" {
		cur.CWD = cwd
	}
	if sessionID != "" {
		// 换了一条会话 = 这个座位换人了：`Spoke` 说的是**当前这条会话**的事，
		// 必须跟着归零（不然新会话会被上一条的"说过话"顶着，重启时白出一条
		// "会话丢了"的横幅）。同一个 id 重复到达（resume/compact 的 SessionStart）
		// 不算换人。
		if cur.SessionID != "" && cur.SessionID != sessionID {
			cur.Spoke = false
		}
		cur.SessionID = sessionID
	}
	if transcript != "" {
		cur.Transcript = transcript
	}
	cur.LastSeenAt = time.Now().UTC().Format(time.RFC3339)
	p.dirty = true
	p.scheduleLocked(why)
}

// forget 是**唯一**一条用户能触发的删除路径：他在界面上显式关掉那一格。
// 别的原因造成的消失（进程挂了、流断了、窗口关了）都不许走这里。
// （程序自己摘记录的另一条路只有 pruneDup —— 冷恢复发现两条记录指着同一条会话。）
func (p *paneStore) forget(id int, why string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 {
		return false
	}
	gone := p.Panes[i]
	p.Panes = append(p.Panes[:i], p.Panes[i+1:]...)
	p.dirty = true
	p.forgetting = true
	// 用户动作**立刻**写（不等节流窗）：他刚关掉一格，下一秒可能就把窗口关了。
	p.writeLocked("forget pane=" + itoa(id) + "（" + why + "）")
	p.forgetting = false
	log.Printf("[panes] 摘掉 pane=%d（%s）session=%s —— 磁盘上那条会话文件**一个字没动**",
		id, why, clip(gone.SessionID, 36))
	return true
}

/*
markClosed 记下"用户把这一格关了、但没说要结束这个 agent"（× 那条路）。

	和 forget 的区别是本轮的核心约定：
	  markClosed  记录还在（Closed:true），重启**不自动拉起**，左栏列出「已关闭」；
	  forget      记录没了，重启连这一行都不出现。
	两边都**不碰磁盘上的会话文件**。

	⚠️ 用户动作**立刻写**（同 forget）：他刚关掉一格，下一秒可能就把窗口关了；
	走节流窗的话"关掉后马上退出"会把 Closed 漏掉，下次启动它又自动拉起来了。
*/
func (p *paneStore) markClosed(id int, why string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if id <= 0 {
		return false
	}
	i := p.findLocked(id)
	if i < 0 {
		return false
	}
	p.Panes[i].Closed = true
	p.Panes[i].LastSeenAt = time.Now().UTC().Format(time.RFC3339)
	// 已经是 Closed 也写一遍：可能是上一次写失败了，而这一次用户又点了一次关闭。
	p.dirty = true
	p.writeLocked("关格保留记录 pane=" + itoa(id) + "（" + why + "）")
	log.Printf("[panes] 记为已关闭 pane=%d（%s）session=%s —— 记录留着，重启不自动拉起",
		id, why, clip(p.Panes[i].SessionID, 36))
	return true
}

// markSpoke 记下"这一格真的说过话"（至少一轮跑完）。
//
// ⚠️ 只写一次：一个会话里每一轮跑完都会来喊一声，而这件事一旦为真是**单调**的 ——
// 反复落盘只是白写（节流窗能合并，但没必要连窗口都占）。
// ⚠️ 不落盘的代价见 Pane.Spoke 那段：重启时"文件不在"就分不出"没说过话"和"说过话、
// 转录没了"，而这两件事一个该安静、一个该出声。
func (p *paneStore) markSpoke(id int, why string) {
	if id <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 {
		return
	}
	if p.Panes[i].Spoke {
		return
	}
	p.Panes[i].Spoke = true
	p.dirty = true
	p.scheduleLocked(why)
}

/*
markMismatch 记下**续接落空**那一笔："我请求的是 X，实际起来的是 Y"。

	写它的是 hooks.go 那条证据规则（步 5），判据见 main.go 的 judgeResume。

	⚠️ 它**只写这一个字段** —— `SessionID` 一个字都不许动，这正是"记录是证据，
	不是垃圾"这条约束的落点。落空时那条会话在盘上多半好好的（我们只是没接上它），
	要是把它改成"实际起来的 Y"，下一条记录就变成"这一格上次跑的是 Y" ——
	一句**假的**话，而且从此再也不会去试 X。留着 X + `MismatchAt`，
	下一次冷恢复照旧去接 X；接上了就把这笔落空撤掉（见 clearMismatch）。

	⚠️ 为什么非落盘不可：横幅只在**那一次运行**里出得来（见 index.html 的
	showCellBanner），而这笔"上次没接上"要留在盘上，日志滚掉之后还能查。
*/
func (p *paneStore) markMismatch(id int, want, got, why string) {
	if id <= 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	cur := &p.Panes[i]
	cur.MismatchAt = now
	cur.LastSeenAt = now
	p.dirty = true
	p.scheduleLocked(fmt.Sprintf("续接落空 pane=%d 请求=%s 实际=%s（%s）", id, short(want), short(got), why))
}

// clearMismatch 撤掉上一次记的那笔落空：这一次**带着证据**接上了。
//
// ⚠️ 不撤就是一个会永久骗人的状态：盘上一直躺着"上次没接上"，而事实已经翻篇 ——
// 下一次冷恢复看到它，人类看到的是一句和自己记忆矛盾的话。
// 返回是否真的撤掉过（写日志用；没有那笔就什么都不做，不落盘）。
func (p *paneStore) clearMismatch(id int, why string) bool {
	if id <= 0 {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 || p.Panes[i].MismatchAt == "" {
		return false
	}
	p.Panes[i].MismatchAt = ""
	p.Panes[i].LastSeenAt = time.Now().UTC().Format(time.RFC3339)
	p.dirty = true
	p.scheduleLocked(why)
	return true
}

/*
markDegraded 记一笔"这一格是从哪条会话降级下来的"（见 Pane.DegradedFrom）。

	两层调用者都可能来：①降级是**前端**决定的（它拿到了拒绝码、重试也过了、于是
	同一格改起新会话），它把旧目标放进 spec.degradedFrom 一起送回来 —— 那一下
	`tabs.create` 正好是这一格被认领的时刻，所以这一笔就落在那里（见 main.go 的
	tab.new）；②写的是**历史**，所以它和 MismatchAt 不一样：不自动清，下次真降级
	就覆盖。

	⚠️ SessionID 在这里**一个字都不动**：降级之后这条记录指向的是新会话，而新会话
	的 id 是 bindSession 按步 5 那条规则写进去的（`new` 意图 = 没有承诺，来的就记）
	—— 两条路各写各的字段，谁也不覆盖谁。
*/
func (p *paneStore) markDegraded(id int, from, why string) {
	if id <= 0 || from == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(id)
	if i < 0 {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	cur := &p.Panes[i]
	// 已经记过同一条就只更新时间：反复重启反复降级，不该攒出一串重复
	// （字段只有一个，覆盖 = 只留"最近一次"）。
	cur.DegradedFrom = from
	cur.DegradedAt = now
	cur.LastSeenAt = now
	p.dirty = true
	p.scheduleLocked(fmt.Sprintf("降级留证 pane=%d 原本要接=%s（%s）", id, short(from), why))
}

// snapshot 给一份副本（冷恢复那条路用它排座位序：**落盘的数组顺序就是座位序**）。
func (p *paneStore) snapshot() []Pane {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Pane, len(p.Panes))
	copy(out, p.Panes)
	return out
}

func (p *paneStore) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.Panes)
}

/*
setReadOnly 把整份登记表按只读对待（冷恢复 · 步 7 的单实例闸）。

	为什么第二个实例必须只读：`writeLocked` 是**整份重写**（.tmp + rename，见文
	件头）。第二个实例哪怕一格都不恢复，它建完自己那一格也会带着"我知道的那几
	条"把文件写回去 —— 第一个实例摆好的 8 个座位会**静默地变成 1 个**：下一次冷
	恢复少 7 格，而且不报错。这不是"少恢复一点"，这是**丢用户的座位**，且症状
	出现在下一次启动、离原因隔着一整次运行。

	和 loadPaneStore 里那两处只读的区别：那两处是"盘上的东西我看不懂，不敢覆盖"，
	这里是"盘上的东西别人正在用，轮不到我写"。三种情况在 scheduleLocked /
	writeLocked 里走的是同一条路（readOnly=true 就不写），所以只需要在这里置位
	—— 不另开一个字段，免得将来有人只改了一边。

	⚠️ 只读**不影响读**：这一份内存里的记录还是那份真记录，UI 照样能列出座位、
	用户在第二个实例里照样能开新格（只是关掉它以后那些新格不进记录）。
*/
func (p *paneStore) setReadOnly(why string) {
	p.mu.Lock()
	if p.readOnly {
		p.mu.Unlock()
		return
	}
	p.readOnly = true
	p.mu.Unlock()
	log.Printf("[panes] 登记表按**只读**对待（%s）—— 一整轮都不会往 %s 写一个字节", why, p.file)
}

// ---------------------------------------------------------------------------
// 冷恢复的那一次判定（步 3）
// ---------------------------------------------------------------------------

// PaneView 是发给**前端**的形状：记录里那几样 + 这一次算出来的判定。
type PaneView struct {
	PaneID    int    `json:"paneId"`
	Agent     string `json:"agent"`
	CWD       string `json:"cwd"`
	SessionID string `json:"sessionId,omitempty"`
	// LastSeenAt：左栏「已关闭」那一行要显示"多久以前"（同 agent 行的 .tm）。
	LastSeenAt string `json:"lastSeenAt,omitempty"`
	/* OnDisk：**只对 closed 有意义** —— 它上次那条会话在盘上还在不在。
	   用户点一个「已关闭」的 agent 时，前端靠它先说清楚"为什么点了可能接不上"：
	   零轮次的会话**盘上根本没有 jsonl**（见 Pane.Spoke 那段），直接点过去只会
	   收到一句"盘上找不到这条会话"，用户不知道自己做错了什么。 */
	OnDisk bool `json:"onDisk,omitempty"`
	// Verdict ∈ {ok, no_session, no_id, dup, closed}
	Verdict string `json:"verdict"`
	// Closed：用户上次把它关了（×）。这一条**不占座位**（重启不自动拉起），
	// 但前端要把它列进左栏工作区里「已关闭」那一档 —— 点它才接上。
	// 单独一个字段而不是让前端从 verdict 里认：verdict 是"这一轮怎么摆"，
	// 而"它被关过"是记录自己的事实（同 Spoke 的理由）。
	Closed bool `json:"closed,omitempty"`
	// Spoke：这一格上次**说过话**（见 Pane.Spoke）。前端只用它一件事：
	// `no_session` 的格子要不要出"上次那条会话找不到了"的横幅 ——
	// 没说过话就没丢东西，别拿同一句话说给一个什么都没干过的格子听。
	Spoke bool `json:"spoke,omitempty"`
	// Resume 是这一格该用什么**姿态**起：ok → exact（`--resume <id>`），
	// 其余 → new。由 Go 给，而不是让前端从 verdict 自己推：把意图翻译成命令行
	// 是 agentDefs 的事，前端多推一次就多一份迟早会漂的规则
	// （和 spawnSpec.PaneID 为什么不按顺序认领是同一个理由）。
	Resume resumeIntent `json:"resume"`
}

type restorePlan struct {
	Views  []PaneView
	Counts map[string]int
	// Dups 是要被摘掉的那几条（同一条会话的**第二条起**，见 pruneDup）。
	Dups []int
}

/*
restorePlan 回答一个问题：**上一轮的座位，这一轮该怎么摆**。

	五条判定（逐条算，顺序有讲究）：
	  closed      用户上次**关掉了这一格的运行**（Closed，见 Pane.Closed）。
	              **没有座位**（不自动拉起），但清单里留着 —— 前端要把它列成
	              「已关闭」那一行，点一下才接上。它也不参与 dup 判定：
	              一条没人在跑的会话不占座位，谈不上"两格一起写"。
	  no_id       记录里没有 sessionId —— 那一格上次**开着、但还没绑上会话**。
	              座位照样起（新会话）：没 id 不等于没座位。
	  no_session  盘上找不到那份 jsonl（用户删了 / 会话在别的机器上 / 它是子代理）。
	              ⚠️ 座位**照样起**，降级成新会话 —— "宁可不续不可续错"降的是**续接**，
	              不是座位：座位序是用户摆的，抽掉一格会让后面每一格都换位置，
	              而"格数与座位序与上次一致"正是这一轮验收里的一条。
	  dup         和**前面**某条记录指着同一条会话。同一条会话不可能同时被两格接上
	              （两个写者写一份 jsonl 是全项目唯一不可逆的失败），所以它**没有座位**。
	  ok          原样接回（exact）。
	  ⚠️ 先判 no_id、再判 no_session，最后才是 ok/dup —— "有没有 id"比"文件在不在"更根本。

	⚠️ 只判定：不起进程、不改记录（唯一的写是摘 dup，见 pruneDup）。真正建格是前端
	拿着这份清单做**一次 burst**（步 4），每一格照旧走 resumeRefusal 那道护栏
	—— 这里给的 ok 只是"盘上的事实说得通"，不是"现在放行"。
	⚠️ 盘上的 glob（sessionFileExists）一律在**锁外**做：盘慢，而
	tabManager 那边正等着同一把锁。snapshot() 就是为此存在的。
*/
func (p *paneStore) restorePlan() restorePlan {
	snap := p.snapshot()
	// Views 从空切片起：nil 会序列化成 `null`，"零条"和"没有这个字段"在线上
	// 是两件不同的事（[[live-list-must-anchor-by-id]] 里那条老账）。
	plan := restorePlan{Views: []PaneView{}, Counts: map[string]int{}}
	// seen：sessionId → 已经认下的那个代表（paneId）。dup 是从**第二条起**算的。
	seen := map[string]int{}
	for _, r := range snap {
		v := ""
		onDisk := false
		switch {
		case r.Closed:
			// 用户关掉的：不占座位、不参与 dup。盘上的存在性仍然要看一眼 ——
			// 它不参与"这一轮接谁"，但决定左栏那一行该怎么提醒用户（见 PaneView.OnDisk）。
			v = "closed"
			if strings.TrimSpace(r.SessionID) != "" {
				onDisk = sessionFileExistsFor(r.Agent, r.CWD, r.SessionID)
			}
		case strings.TrimSpace(r.SessionID) == "":
			v = "no_id"
		case !sessionFileExistsFor(r.Agent, r.CWD, r.SessionID):
			v = "no_session"
		default:
			if rep, isDup := seen[r.SessionID]; isDup {
				v = "dup"
				plan.Dups = append(plan.Dups, r.PaneID)
				log.Printf("[panes] 冷恢复撞见重复记录：pane=%d 与 pane=%d 指着同一条会话（session=%s）—— 认前者当代表，后者没有座位（同一条会话不能两格一起写）",
					r.PaneID, rep, clip(r.SessionID, 36))
			} else {
				seen[r.SessionID] = r.PaneID
				v = "ok"
			}
		}
		plan.Counts[v]++
		rv := resumeIntent{Kind: "new"}
		if v == "ok" {
			rv = resumeIntent{Kind: "exact", ID: r.SessionID}
		}
		plan.Views = append(plan.Views, PaneView{
			PaneID: r.PaneID, Agent: r.Agent, CWD: r.CWD,
			SessionID: r.SessionID, Verdict: v, Resume: rv, Spoke: r.Spoke,
			Closed: r.Closed, LastSeenAt: r.LastSeenAt, OnDisk: onDisk,
		})
	}
	if len(plan.Dups) > 0 {
		p.pruneDup(plan.Dups)
	}
	// 这一行是步 3 的唯一判据（计数）+ 座位序（步 4 建格要按它，前端的日志
	// 是同一件事在**线上**的证据，两条对得上才说明载荷没走样）。
	log.Printf("[panes] 冷恢复：%d 条候选（ok=%d no_session=%d no_id=%d dup=%d closed=%d）",
		len(plan.Views), plan.Counts["ok"], plan.Counts["no_session"], plan.Counts["no_id"],
		plan.Counts["dup"], plan.Counts["closed"])
	if len(plan.Views) > 0 {
		parts := make([]string, 0, len(plan.Views))
		for _, v := range plan.Views {
			// closed 那几条多报一件事：盘上还有没有会话文件（决定左栏怎么提醒用户）。
			extra := ""
			if v.Closed && v.SessionID != "" && !v.OnDisk {
				extra = ",无文件"
			}
			parts = append(parts, fmt.Sprintf("pane=%d:%s(%s%s)", v.PaneID, v.Verdict, v.Agent, extra))
		}
		log.Printf("[panes] 冷恢复座位序：%s", strings.Join(parts, " "))
	}
	return plan
}

// pruneDup 摘掉"同一条会话的第二条起"那几条记录。单独一个方法而不是让调用方
// 拼一次 forget，因为它和 forget 是**两种完全不同**的删除理由：
//
//	forget   是**用户的动作**（他关掉了那一格）—— 他说了算；
//	pruneDup 是**记录自己矛盾**（一条会话占了两个座位）—— 那不是一条能成立的
//	说法，留着它的代价是每次重启都要重新判定一个永远不会被认领的座位，
//	而且用户会看见两个"上次开着"的坑里只有一个真的开着。
//
// ⚠️ 名单**只能**来自 restorePlan 的 seen 表（那是唯一算过"谁是代表"的地方）。
// 摘之前每一条都落日志，和 forget 一样带那句"磁盘上那个会话文件一个字没动"。 */
func (p *paneStore) pruneDup(ids []int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, id := range ids {
		i := p.findLocked(id)
		if i < 0 {
			continue
		}
		gone := p.Panes[i]
		p.Panes = append(p.Panes[:i], p.Panes[i+1:]...)
		n++
		log.Printf("[panes] 摘掉重复记录 pane=%d（session=%s）—— 磁盘上那个会话文件**一个字没动**",
			id, clip(gone.SessionID, 36))
	}
	if n == 0 {
		return
	}
	p.dirty = true
	// forgetting：这次写**允许**记录数为 0（见 writeLocked 里那条断言）——
	// 摘记录本来就该让条数变小，而那条断言是防"凭空少"的，不是防"摘"的。
	p.forgetting = true
	p.writeLocked("冷恢复摘掉重复记录 " + itoa(n) + " 条")
	p.forgetting = false
}

// scheduleLocked 必须持锁调用。leading-edge：**第一次变化立刻写**，
// 窗口内的后续变化合并成一次补写（只留一个定时器）。
func (p *paneStore) scheduleLocked(why string) {
	if p.readOnly || p.file == "" {
		return
	}
	if time.Since(p.lastFlush) >= paneFlushWindow {
		p.writeLocked(why)
		return
	}
	p.pendingWhy = why
	if p.timer != nil {
		p.timer.Stop()
	}
	p.timer = time.AfterFunc(paneFlushWindow, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.timer = nil
		if p.dirty {
			p.writeLocked("节流窗口到点（窗口内最后一次=" + p.pendingWhy + "）")
		}
	})
}

// flushSync 同步写一遍（关窗 / 进程收尾那条路）。
//
// ⚠️ 它**只写内存里已经有的那份** —— 绝不许从 tabs.live() 现取（Wails 的关停
// 顺序是先跑 streams.close、再跑 OnShutdown，那时每一格的 `defer tabs.drop`
// 都已经执行完了，从那里取会得到一张空表）。理由见文件头第 ③ 条。
func (p *paneStore) flushSync(why string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if !p.dirty {
		log.Printf("[panes] 收尾不写（内存没有新变化，盘上已是 %d 条）：%s", len(p.Panes), why)
		return
	}
	p.writeLocked(why)
}

// writeLocked 必须持锁调用。原子写（.tmp + rename）—— 半截文件比旧文件糟得多。
func (p *paneStore) writeLocked(why string) {
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
	if p.readOnly {
		log.Printf("[panes] 这次不写（只读：版本过新或读盘失败过）：%s", why)
		return
	}
	if p.file == "" {
		return
	}
	if !p.dirty {
		return
	}
	/* ⚠️ **第 ③ 条约束的自证**：内存里一条记录都没有、而这次又不是 forget 触发的
	   ⇒ **拒写**。为什么值得写死一条断言：Wails 的关停顺序是 streams.close 先跑
	   （application.go:74-79 vs :199-200，任务按注册序），于是 `handleTab` 的
	   `defer tabs.drop` 会对**每一格**先执行一遍；哪天有人在 drop 里顺手删了记录，
	   关窗那一刻写下去的就是 `{"panes":[]}` —— 恢复能力被自己抹掉，**而且不报错**。
	   这条断言就是那个 bug 的探针：它一响，说明有人让记录凭空少了。 */
	if len(p.Panes) == 0 && !p.forgetting {
		log.Printf("[panes] ⚠️ 拒写：内存里 0 条记录，而本次触发=%s **不是** forget —— 记录不该凭空少（见 panes.go 顶部第 ③ 条）", why)
		return
	}
	t0 := time.Now()
	b, err := json.MarshalIndent(struct {
		Panes   []Pane `json:"panes"`
		Version int    `json:"version"`
	}{p.Panes, paneStoreVersion}, "", "  ")
	if err != nil {
		log.Printf("[panes] 序列化失败（不写，下次再试）：%v", err)
		return
	}
	b = append(b, '\n')
	if err := os.MkdirAll(filepath.Dir(p.file), 0o755); err != nil {
		log.Printf("[panes] 建目录失败（不写）：%v", err)
		return
	}
	tmp := p.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Printf("[panes] 写临时文件失败（不写，盘上那份没动）：%v", err)
		return
	}
	if err := os.Rename(tmp, p.file); err != nil {
		log.Printf("[panes] rename 失败（盘上那份没动）：%v", err)
		return
	}
	p.dirty = false
	p.lastFlush = time.Now()
	// 每次落盘留一行：**触发原因**是这一块唯一的证据 —— "怎么少了一条/怎么没写"
	// 这类问题全靠它：把事实回传到日志，先看字节再看像素。
	log.Printf("[panes] 落盘 %d 条（触发=%s）path=%s 用时=%s",
		len(p.Panes), why, p.file, time.Since(t0).Round(time.Millisecond))
}

// paneStoreWarn 是给 main() 用的一行启动事实：这一轮到底能不能记。
func paneStoreWarn(p *paneStore) {
	if p == nil {
		return
	}
	if p.readOnly {
		log.Printf("[panes] 登记表这轮**只读** —— 冷恢复会照常读，但这一轮的格子变动记不下来")
		return
	}
	if n := p.count(); n > 0 {
		log.Printf("[panes] 冷恢复输入：%d 条候选（步 3 才判它们谁还能接上）", n)
	} else {
		log.Printf("[panes] 冷恢复输入：0 条（第一次跑，或上次关窗时确实是空的）")
	}
}
