package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 注入给 claude 的 hooks：让 agent **自己**告诉我们它在干什么
//
// 与其我们去 PTY 字节里认「它是不是在等人」，不如让它按事件说。第 0 步把这份
// 契约整个实测了一遍（-p 和 PTY 交互式两条路都验过），下面每条都是实测或从
// 安装的二进制的 JS bundle 里逐字查出来的，不是照文档猜的：
//
//  1. hook 走 **exec 形式**（`command` + `args`）→ **完全不过 shell**。
//     不过 shell 就没有引号解析、没有 Windows 上「装了 Git for Windows 就走
//     `bash -c`、否则走 powershell」这条歧义、也没有那个没验清楚的 `\`→`/` 改写。
//
//  2. `async: true` —— 观察型 hook 没有任何理由阻塞用户那一轮。实测 TUI 会把
//     "running Stop hook · 1s" 画在状态栏上（也就是 hook 耗时**用户看得见**），
//     同步跑的话光起一个 PowerShell 进程就是 272ms/轮。
//     实测结论：async **不会**吞掉 stdin —— 事件里 session_id/cwd/transcript_path
//     一个不少。
//
//  3. `timeout` 单位是**秒**（默认 600s）。显式设 5s：卡住的 hook 不该挂 10 分钟。
//
//  4. `onFailure` 默认 `continue`，且在 async/Stop 上被忽略 —— "hook 挂了不影响
//     agent" 是默认行为，不用额外声明。
//
// 订阅表刻意**不含** PostToolUse / 宽 matcher 的 PreToolUse：那是每次工具调用起一个
// 进程，而这一层要的是「这一轮的状态」。要「改动」的细粒度走 jsonl（store.go），不走 hook。
//
// 2026-10-19 加了两个**窄**例外（Wave 1：低延迟的“卡在等你”信号）：
//
//	PermissionRequest        批准框一出现就到（比 Notification 早、还带 tool_name）
//	PreToolUse(matcher=AskUserQuestion)  提问选择器一出现就到
//
// 这两个是交互点，不是背景观察，所以它们**同步**跑（不加 async）：观察进程只写
// 一行就退出（毫秒级），同步不会拖慢用户；而 async 会把“它到底卡住了没有”变成
// 一个事件到达前的猜测。matcher 是启动时写死的 —— 所以只订阅 AskUserQuestion，
// 不是每次工具调用都起进程（Orca 的 managed hook 也是同一组事件，见
// _ref\orca\fetched\src\main\claude\claude-managed-hook-events.ts:46-63）。
//
// ⚠️ 一条从自己代码里踩出来的设计教训：**每个格子一个事件文件，归属由文件名定**。
// 第一版所有格子共用一个文件、靠 session_id 反查格子，结果 SessionStart 比登记表
// 轮询早几百毫秒到达，那条事件就没主（日志里是 `[hook t0]`）。
// 而 --settings 本来就是**每格子一份**的 —— 那就顺手把路径写死进去。
// 现在"这条事件属于哪个格子"不依赖任何反查，race 从根上不存在。
// ---------------------------------------------------------------------------

const (
	// ⚠️ 文件名**写死在代码里**；构建脚本要产出一份同名的 exe 放在主程序旁边。
	// 少这个文件的症状是"hook 功能静默消失"（buildHookSettings 返回空串）。
	hookExeName = "perch-hook.exe"
	hookDirName = "hook-events"

	// 事件文件是**实时信号**不是历史，轮询要快；一次只加几百字节，代价可忽略。
	hookPollEvery = 300 * time.Millisecond
)

// hookEventTypes 是我们订阅的事件。挑的原则是「这一层只关心状态与轮次」：
//
//	SessionStart/SessionEnd —— 这个格子活了/死了
//	Stop                    —— 一轮跑完（带 last_assistant_message）
//	StopFailure             —— 非正常收尾（撞限额、鉴权失败…）：要人管
//	Notification            —— 官方的人机信号（permission_prompt / idle_prompt /
//	                           agent_needs_input / agent_completed / quota_* …）
//	SubagentStart/Stop      —— 「子代理」那一栏的数据源
//	PermissionRequest       —— 批准框出现（精确的 perm 等待）
//	PreToolUse              —— 只订阅 AskUserQuestion（精确的 ask 等待）
var hookEventTypes = []string{
	"SessionStart", "SessionEnd", "Stop", "StopFailure",
	"Notification", "SubagentStart", "SubagentStop",
	"PermissionRequest", "PreToolUse",
}

// hookSyncEvents 是**交互点**：事件本身就是“人现在要做决定”，观察不能让
// agent 抢在事件落地之前继续跑。其余订阅仍是 async（见文件头第 2 条）。
var hookSyncEvents = map[string]bool{
	"PermissionRequest": true,
	"PreToolUse":        true,
}

// hookMatchers 给 PreToolUse 收窄到提问工具。PermissionRequest 不加 matcher：
// 任何批准框都是“卡在等你”，都要看见。
var hookMatchers = map[string]string{
	"PreToolUse": "AskUserQuestion",
}

func hookDir() string { return filepath.Join(claudeStateDir, hookDirName) }

// hookEventsPathFor 每个格子一份事件文件。tag 形如 "t1"（标签）/"wt"（对比窗口）。
func hookEventsPathFor(tag string) string {
	return filepath.Join(hookDir(), tag+".jsonl")
}

// hookExePath 找 hook 接收器：和主程序同目录。
//
// ⚠️ 当前形态是两个产物并排构建（主程序 + 几 KB 的接收器）。以后可以把它
// go:embed 进主程序、启动时释放到状态目录 —— 否则"少一个 exe"就变成
// "功能静默消失"。
func hookExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	p := filepath.Join(filepath.Dir(exe), hookExeName)
	if fi, err := os.Stat(p); err != nil || fi.IsDir() {
		return ""
	}
	return p
}

// buildHookSettings 造那份 --settings。造不出来返回空串，调用方据此不注入。
//
// 关键性质（实测）：--settings 是**合并**不是替换 —— 用户自己 settings.json 里的
// env/model 照样生效，我们只是把 hooks 加上去。所以这条路径**不碰用户的任何配置文件**。
func buildHookSettings(tag string) string {
	exe := hookExePath()
	if exe == "" {
		return ""
	}
	hooks := make(map[string]any, len(hookEventTypes))
	// 大部分事件刻意**不加 matcher**：matcher 是启动时写死的，改订阅就得重开
	// 所有格子；而 notification_type 本来就在 payload 里，过滤放 Go 端改一次就生效。
	// 只有 PreToolUse 必须加 —— 见 hookMatchers。
	for _, e := range hookEventTypes {
		one := map[string]any{
			"type": "command",
			// exec 形式：command 是可执行文件本身，参数在 args 里 —— 不过 shell。
			"command": filepath.ToSlash(exe),
			"args":    []string{filepath.ToSlash(hookEventsPathFor(tag))},
			"timeout": 5,
		}
		if !hookSyncEvents[e] {
			one["async"] = true
		}
		entry := map[string]any{"hooks": []any{one}}
		if m := hookMatchers[e]; m != "" {
			entry["matcher"] = m
		}
		hooks[e] = []any{entry}
	}
	b, err := json.Marshal(map[string]any{"hooks": hooks})
	if err != nil {
		log.Printf("[hook] 造 --settings 失败: %v", err)
		return ""
	}
	return string(b)
}

// hookEvent 是我们真正要用的那几个字段（其余原样留着，前端想用可以直接拿）。
type hookEvent struct {
	HookEventName        string `json:"hook_event_name"`
	SessionID            string `json:"session_id"`
	TranscriptPath       string `json:"transcript_path"`
	CWD                  string `json:"cwd"`
	Source               string `json:"source"`                 // SessionStart: startup/resume/clear/compact/fork
	NotificationType     string `json:"notification_type"`      // Notification
	Message              string `json:"message"`                // Notification
	LastAssistantMessage string `json:"last_assistant_message"` // Stop
	AgentType            string `json:"agent_type"`             // 只有子代理里才有
	AgentID              string `json:"agent_id"`               // 只有子代理里才有
	Reason               string `json:"reason"`                 // StopFailure
	ToolName             string `json:"tool_name"`              // PreToolUse / PermissionRequest
}

// resetHookDir 启动时清空事件目录：这是**实时信号**不是历史，
// 上一次运行的事件不该在新的一次里重放。只删我们自己造的 *.jsonl。
func resetHookDir() {
	dir := hookDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[hook] 建事件目录失败: %v", err)
		return
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// startHookEventPoller 跟着"现在活着的那些格子"的事件文件走。
//
// 每个文件一个 offset，全程只在**追加**语义下工作；文件被截断（我们只在启动时
// 干过一次）也能自愈。格子关掉之后它的 offset 会被丢掉、文件留在盘上（下次启动清）。
func startHookEventPoller(push func(any)) {
	resetHookDir()
	go func() {
		offs := map[string]int64{}
		carry := map[string]string{}
		for {
			time.Sleep(hookPollEvery)
			// 目标集合 = 活着的标签 + 对比窗口（它不是标签，用固定 tag）。
			targets := map[string]int{}
			for _, v := range tabs.live() {
				targets[hookEventsPathFor(fmt.Sprintf("t%d", v.id))] = v.id
			}
			targets[hookEventsPathFor("wt")] = 0

			for path, tabID := range targets {
				fi, err := os.Stat(path)
				if err != nil {
					delete(offs, path)
					delete(carry, path)
					continue
				}
				off := offs[path]
				if fi.Size() < off {
					off, carry[path] = 0, ""
				}
				if fi.Size() == off {
					continue
				}
				f, err := os.Open(path)
				if err != nil {
					continue
				}
				if _, err := f.Seek(off, io.SeekStart); err != nil {
					f.Close()
					continue
				}
				b, rerr := io.ReadAll(f)
				f.Close()
				if rerr != nil {
					continue
				}
				offs[path] = off + int64(len(b))
				buf := carry[path] + string(b)
				for {
					i := strings.IndexByte(buf, '\n')
					if i < 0 {
						break
					}
					line, rest := buf[:i], buf[i+1:]
					buf = rest
					handleHookLine(line, tabID, push)
				}
				carry[path] = buf
			}
		}
	}()
}

// handleHookLine 解析一行事件并处理。tabID 来自**文件名**，是硬归属；
// 查不到格子（=0）时再退回 session 反查（比如对比窗口那条）。
func handleHookLine(line string, tabID int, push func(any)) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	// 接收器写的是 "<HH:MM:SS.mmm> <json>" —— 从第一个 '{' 起就是原文
	i := strings.IndexByte(line, '{')
	if i < 0 {
		return
	}
	var ev hookEvent
	if json.Unmarshal([]byte(line[i:]), &ev) != nil {
		return
	}
	tab := tabID
	if tab == 0 {
		tab = tabs.tabForSession(ev.SessionID)
	}
	// 顺带把关联钉下来：事件里的 session_id 是**第一时间**到达的那个，
	// 比登记表轮询还早。绑定只在第一次生效，所以它和登记表那条路不会打架。
	if tab != 0 && ev.SessionID != "" && tabs.bindSession(tab, ev.SessionID, "", ev.Source) {
		log.Printf("[agent t%d] 关联建立 session=%s（来自 hook 事件，比登记表更早）", tab, ev.SessionID)
	}

	switch ev.HookEventName {
	case "Stop":
		log.Printf("[hook t%d] Stop session=%s 最后一句=%q", tab, short(ev.SessionID), clip(ev.LastAssistantMessage, 120))
		// 「这一格说过话」的唯一证据（见 panes.Pane.Spoke）：一轮跑完 = 这条会话
		// 有内容，盘上那份 jsonl 于是开始存在。冷恢复靠它分辨"上次这条会话丢了"
		// 和"上一格压根没说过话"—— 后者安安静静地开新格，别吓唬用户。
		if id := paneIDFor(tab); id > 0 {
			panes.markSpoke(id, "一轮跑完 tab="+itoa(tab))
		}
	case "Notification":
		// 「需要你」的正主：官方的人机信号，类型就在 payload 里。
		log.Printf("[hook t%d] Notification type=%s session=%s msg=%q",
			tab, ev.NotificationType, short(ev.SessionID), clip(ev.Message, 120))
	case "SessionStart":
		log.Printf("[hook t%d] SessionStart source=%s session=%s cwd=%s", tab, ev.Source, short(ev.SessionID), ev.CWD)
		// transcript_path 是**路径的权威来源**：不要自己去 projects\<有损slug>\ 下面拼
		// （那个 slug 中文和连字符都还原不回来）。「改动/流水」那条腿就跟着这个文件走。
		if tab != 0 {
			tabs.setTranscript(tab, ev.TranscriptPath)
		}
	case "SessionEnd":
		log.Printf("[hook t%d] SessionEnd session=%s", tab, short(ev.SessionID))
	case "StopFailure":
		log.Printf("[hook t%d] StopFailure session=%s reason=%q", tab, short(ev.SessionID), clip(ev.Reason, 120))
		// 非正常收尾也算"说过话"：撞限额/鉴权失败之前那一轮是真跑过的，
		// 转录也在盘上。Orca 把 interrupted turn 明确算作可续
		// （resume-sleeping-agent-session.ts:182-183），我们这里同一件事的另一半。
		if id := paneIDFor(tab); id > 0 {
			panes.markSpoke(id, "非正常收尾 tab="+itoa(tab))
		}
	case "PermissionRequest":
		// 批准框出现：比 Notification(permission_prompt) 早，而且 tool_name 直接
		// 告诉我们批的是什么。State 是 waiting（批准），不是 blocked（提问卡片）。
		log.Printf("[hook t%d] PermissionRequest tool=%s session=%s", tab, orNone(ev.ToolName), short(ev.SessionID))
	case "PreToolUse":
		// 只订阅了 AskUserQuestion（matcher 写死在 --settings 里）。这条就是
		// “提问卡片刚画出来”的第一手证据；State 用 blocked（具体提问）。
		log.Printf("[hook t%d] PreToolUse tool=%s session=%s", tab, orNone(ev.ToolName), short(ev.SessionID))
	case "SubagentStart", "SubagentStop":
		log.Printf("[hook t%d] %s agent_id=%s agent_type=%s", tab, ev.HookEventName, short(ev.AgentID), ev.AgentType)
	default:
		log.Printf("[hook t%d] %s session=%s", tab, ev.HookEventName, short(ev.SessionID))
	}

	push(map[string]any{
		"type":    "hook",
		"event":   ev.HookEventName,
		"tab":     tab,
		"session": ev.SessionID,
		"ntype":   ev.NotificationType,
		"msg":     ev.Message,
		"last":    ev.LastAssistantMessage,
		"agent":   ev.AgentID,
		"agt":     ev.AgentType,
		"reason":  ev.Reason,
		"source":  ev.Source,
		"tool":    ev.ToolName,
		// 证据来源：前端拿它区分“活事件”和冷恢复时的重放（见 80-live.js
		// 的 restoredUnconfirmed）。hook 永远算活事件。
		"evidence": agentEvidenceHook,
	})
}

// short 把 uuid 截成前 8 位 —— 日志里只要"能对上"就够，整条 uuid 是噪音。
func short(s string) string {
	if len(s) <= 8 {
		return s
	}
	return s[:8]
}

// clip 截断长文本，并把换行压成可见记号（否则一行日志会被撑成很多行）。
func clip(s string, n int) string {
	r := []rune(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", " "), "\n", " "))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "…"
}
