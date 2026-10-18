package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// ---------------------------------------------------------------------------
// 会话登记表：格子 ↔ 会话 ↔ 忙闲，三条信息一次拿全
//
// claude 自己会在 `<stateDir>\sessions\<pid>.json` 里写一条实时记录（实测）：
//
//	{"pid":27464,"sessionId":"a740f5fa-…","cwd":"…","kind":"interactive",
//	 "entrypoint":"cli","name":"ai-60","nameSource":"derived",
//	 "status":"idle","updatedAt":1792057767064,
//	 "messagingSocketPath":"\\\\.\\pipe\\LOCAL\\cc-msg-…",
//	 "peerFeatures":["notify_idle","artifact_yield"],"version":"2.1.299"}
//
// 三件事因此都不用猜：
//
//	① 格子↔会话关联  pid → sessions\<pid>.json → sessionId
//	   （比"给每格塞一个 --session-id"更好：对 --resume/--continue 一视同仁，
//	    也不会多出一个可能和真实状态不一致的第二事实源）
//	② 忙闲  status ∈ {busy, idle}，**实时更新**（写时会更新 updatedAt）
//	   idle = 这一轮跑完了、在等你。这是「需要你」最粗也最准的那一层，
//	   而且不依赖 hooks（hook 没起来时它也在）。
//	③ 会话自带的派生名 name（nameSource:"derived"）—— 将来做标签标题时有用。
//
// ⚠️ 一处诚实的更正（2026-10-16 更新）：titles.go 的注释里把形状写成
// `status:"waiting", waitingFor:"input needed"`。**`waitingFor` 确实没有**
// （两个真文件里都没有这个字段），但**取值确实有 `waiting` 这一态**：选择器或
// 权限框挂起的那一刻置上、答完立刻回 busy（实测记录见下面 idleHint）。
// 所以那份计划期的注释只对了字段、错了取值；而这里原来只按 busy/idle 两态处理，
// 把 `waiting` 当成了"未预期的取值"。遇到不认识的值仍然**原样透传**、不当它是错。
// ---------------------------------------------------------------------------

const (
	// 状态轮询比 hook 慢一点：它在盘上，而且只用于"粗粒度忙闲"，
	// 精确的轮次信号由 hook 负责。700ms 对人的感知来说足够快。
	statusPollEvery = 700 * time.Millisecond
)

type sessionReg struct {
	SessionID  string `json:"sessionId"`
	CWD        string `json:"cwd"`
	Status     string `json:"status"`
	Name       string `json:"name"`
	NameSource string `json:"nameSource"`
	Kind       string `json:"kind"`
	Entrypoint string `json:"entrypoint"`
	// 计划期文档里提到、实测文件里没出现过。留着但不依赖它。
	WaitingFor string `json:"waitingFor"`
}

func readSessionReg(stateDir string, pid int) (sessionReg, bool) {
	var r sessionReg
	p := filepath.Join(stateDir, "sessions", strconv.Itoa(pid)+".json")
	b, err := os.ReadFile(p)
	if err != nil {
		return r, false
	}
	if json.Unmarshal(b, &r) != nil {
		return r, false
	}
	return r, r.SessionID != ""
}

// startAgentStatusPoller 盯着每个活着的格子的登记表。
//
// 它同时承担**关联解析**：格子刚起来时 sessionID 是空的，登记表一出现就把它绑上。
// 用一个轮询而不是每个格子起一个 goroutine + 有限重试，是因为它天然自愈 ——
// claude 慢一两秒才写登记表、或者干脆重写了一遍，这里都能自然跟上。
func startAgentStatusPoller(push func(any)) {
	go func() {
		for {
			time.Sleep(statusPollEvery)
			for _, h := range tabs.live() {
				if h.pid == 0 {
					continue
				}
				reg, ok := readSessionReg(claudeStateDir, h.pid)
				if !ok {
					continue
				}
				// ① 关联：第一次拿到 sessionId 就绑上，并说清楚这件事发生了。
				// （正常情况下 hook 事件已经先绑好了，这里是兜底 + 补那个"派生名"。）
				// ⚠️ source 传空串：登记表这条路**没有** source 这个字段，而
				// 步 5 那条判据（judgeResume）也不依赖它 —— 它只看"请求的是不是
				// 这一条"。这条兜底路径同样受那条规则管（这是故意的：它比 hook
				// 只慢，先到的话照样可能写进一条错的记录）。
				if tabs.bindSession(h.id, reg.SessionID, reg.Name, "") {
					log.Printf("[agent t%d] 关联建立 pid=%d → session=%s（登记表，%s）",
						h.id, h.pid, reg.SessionID, reg.Kind)
				}
				// ② 忙闲：只在**变化**时说一句，否则 700ms 一次会把日志淹掉。
				if prev, changed := tabs.setStatus(h.id, reg.Status); changed {
					// 登记表只说“在等”，说不出是提问还是批准 —— 所以 state 是
					// waiting（泛化等待），不是 blocked；kind 由前端从转录里补。
					state := ""
					switch reg.Status {
					case "busy":
						state = agentStateWorking
					case "waiting":
						state = agentStateWaiting
					case "idle":
						state = agentStateDone
					}
					log.Printf("[agent t%d] status %s → %s state=%s evidence=%s session=%s（%s）",
						h.id, prev, reg.Status, orNone(state), agentEvidenceRegistry,
						short(reg.SessionID), idleHint(reg.Status))
					push(map[string]any{
						"type":     "agent",
						"tab":      h.id,
						"session":  reg.SessionID,
						"status":   reg.Status,
						"state":    state,
						"evidence": agentEvidenceRegistry,
						"name":     reg.Name,
					})
				}
			}
		}
	}()
}

// idleHint 把 status 翻译成"这对用户意味着什么" —— 日志里值得多这几个字，
// 因为 busy/idle 这两个词本身不说明"是不是在等我"。
//
// ⚠️ 2026-10-16 实测补上第三态：**`waiting` 是存在的**，而且它正是「需要你」最硬
// 的那一层 —— 官方、机器可读、≤700ms，不依赖 hook：
//
//	11:44:29 status busy → waiting      选择器刚画出来（提问型）
//	11:45:41 status waiting → busy      答完
//	12:43:38 status busy → waiting      权限框挂起（批准型，同一次里转录那条
//	                                     `tool Write permtest file` 也在同一秒到）
//	12:45:37 status busy → waiting      复现
//
// 也就是说 `waiting` = "我卡在用户身上了"，提问和批准**都是**。前两个月的注释
// 猜成"没有第三态、要等 manual 模式实测"，现在有数了。原来这里把它打成
// "未预期的取值"、前端两个读处也只认 busy/idle —— 等于把最硬的那条信号丢掉。
func idleHint(status string) string {
	switch status {
	case "idle":
		return "空闲：等你"
	case "busy":
		return "在跑"
	case "waiting":
		return "卡在等你：等回答/等批准"
	}
	return "未预期的取值"
}
