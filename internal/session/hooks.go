package session

// ---------------------------------------------------------------------------
// 注入给 claude 的 hooks：让 agent **自己**告诉我们它在干什么
//
// 与其我们去 PTY 字节里认「它是不是在等人」，不如让它按事件说。第 0 步把这份
// 契约整个实测了一遍（-p 和 PTY 交互式两条路都验过），下面每条都是实测或从
// 安装的二进制的 JS bundle 里逐字查出来的，不是照文档猜的：
//
//  1. hook 走 **exec 形式**（`command` + `args`）→ **完全不过 shell**。
//     不过 shell 就没有引号解析、没有 Windows 上「装了 Git for Windows 就走
//     `bash -c`、否则走 powershell」这条歧义。
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
// 订阅表刻意**保持收敛**：PreToolUse 只收 AskUserQuestion（不是宽 matcher）；
// 每次工具调用的事件只收 PostToolUse / PostToolUseFailure（只用来销账）。
// 要「改动」的细粒度走 jsonl，不走 hook。
//
// 2026-10-19 Wave 1 加了两个**窄**例外（低延迟的“卡在等你”信号）：
//
//	PermissionRequest        批准框一出现就到（比 Notification 早、还带 tool_name）
//	PreToolUse(matcher=AskUserQuestion)  提问选择器一出现就到
//
// 这两个是交互点，不是背景观察，所以它们**同步**跑（不加 async）。
//
// 2026-10-19 Wave 2 又补了**收尾**的一组（Orca 的 managed hook 同一组事件，
// src/main/claude/claude-managed-hook-events.ts:9-72）：
//
//	PostToolUse / PostToolUseFailure（matcher=*，async）
//	    工具返回 = 这次等待有结局。
//	UserPromptSubmit（async）    用户又发了提示 ⇒ 之前那条等待一定是旧账
//	PostCompact（async）         手动 /compact 结束时不发 Stop（Orca STA-2915）
//
// ⚠️ 一条从自己代码里踩出来的设计教训：**每个格子一个事件文件，归属由文件名定**。
// 第一版所有格子共用一个文件、靠 session_id 反查格子，结果 SessionStart 比登记表
// 轮询早几百毫秒到达，那条事件就没主（日志里是 `[hook t0]`）。
// 而 --settings 本来就是**每格子一份**的 —— 那就顺手把路径写死进去。
// ---------------------------------------------------------------------------

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/agent"
)

const (
	// ⚠️ 文件名**写死在代码里**；构建脚本要产出一份同名的 exe 放在主程序旁边。
	// 少这个文件的症状是"hook 功能静默消失"（BuildHookSettings 返回空串）。
	HookExeName = "perch-hook.exe"
	HookDirName = "hook-events"

	// 事件文件是**实时信号**不是历史，轮询要快；一次只加几百字节，代价可忽略。
	hookPollEvery = 300 * time.Millisecond
)

// HookEventTypes 是我们订阅的事件。挑的原则是「这一层只关心状态与轮次」：
//
//	SessionStart/SessionEnd —— 这个格子活了/死了
//	Stop                    —— 一轮跑完（带 last_assistant_message）
//	StopFailure             —— 非正常收尾（撞限额、鉴权失败…）：要人管
//	Notification            —— 官方的人机信号（permission_prompt / idle_prompt /
//	                           agent_needs_input / agent_completed / quota_* …）
//	SubagentStart/Stop      —— 「子代理」那一栏的数据源
//	PermissionRequest       —— 批准框出现（精确的 perm 等待）
//	PreToolUse              —— 只订阅 AskUserQuestion（精确的 ask 等待）
//	PostToolUse/PostToolUseFailure —— 工具返回：这次等待有结局（销账）
//	UserPromptSubmit        —— 用户发了新提示：之前的等待是旧账（销账）
//	PostCompact             —— 手动 /compact 结束，可能不发 Stop（销账）
var HookEventTypes = []string{
	"SessionStart", "SessionEnd", "Stop", "StopFailure",
	"UserPromptSubmit", "Notification", "SubagentStart", "SubagentStop",
	"PermissionRequest", "PreToolUse", "PostToolUse", "PostToolUseFailure",
	"PostCompact",
}

// hookSyncEvents 是**交互点**：事件本身就是“人现在要做决定”，观察不能让
// agent 抢在事件落地之前继续跑。其余订阅仍是 async（见文件头第 2 条）。
var hookSyncEvents = map[string]bool{
	"PermissionRequest": true,
	"PreToolUse":        true,
}

// hookMatchers 给 PreToolUse 收窄到提问工具。PermissionRequest 不加 matcher：
// 任何批准框都是“卡在等你”，都要看见。
//
// PostToolUse/PostToolUseFailure 用 "*"（Orca 同款）：它们的作用是「任何工具
// 返回都来报告一声」，好让先前那条等待销账。
var hookMatchers = map[string]string{
	"PreToolUse":         "AskUserQuestion",
	"PostToolUse":        "*",
	"PostToolUseFailure": "*",
}

// HookDir 是 hook 事件目录（在 Claude 状态根下）。
func HookDir(stateDir string) string { return filepath.Join(stateDir, HookDirName) }

// HookEventsPathFor 每个格子一份事件文件。tag 形如 "t1"（标签）/"wt"（对比窗口）。
func HookEventsPathFor(stateDir, tag string) string {
	return filepath.Join(HookDir(stateDir), tag+".jsonl")
}

// ExtractedHookPath 是单文件发行版释放 hook 接收器的位置：
// %LOCALAPPDATA%\Perch\bin\perch-hook.exe。用户下载目录里只留一个 Perch.exe。
func ExtractedHookPath() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "Perch", "bin", HookExeName), nil
}

// InstallEmbeddedHook 把主程序里嵌入的 hook 接收器释放出来。内容相同就
// 不重复写；先写临时文件再 rename，避免 hook 读到半截 exe。
func InstallEmbeddedHook(data []byte) (string, error) {
	if len(data) == 0 {
		return HookExePath(), nil
	}
	p, err := ExtractedHookPath()
	if err != nil {
		return "", err
	}
	if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, data) {
		return p, nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	log.Printf("[perch] 已释放内嵌 hook 接收器：%s", p)
	return p, nil
}

// HookExePath 找 hook 接收器。
//
// 开发构建优先用主程序旁边的 build\perch-hook.exe；单文件发行版旁边没有
// 第二个文件，于是用 InstallEmbeddedHook 释放到 %LOCALAPPDATA%\Perch\bin。
func HookExePath() string {
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), HookExeName)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	if p, err := ExtractedHookPath(); err == nil {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// BuildHookSettings 造那份 --settings。造不出来返回空串，调用方据此不注入。
//
// 关键性质（实测）：--settings 是**合并**不是替换 —— 用户自己 settings.json 里的
// env/model 照样生效，我们只是把 hooks 加上去。所以这条路径**不碰用户的任何配置文件**。
func BuildHookSettings(stateDir, tag string) string {
	exe := HookExePath()
	if exe == "" {
		return ""
	}
	hooks := make(map[string]any, len(HookEventTypes))
	// 大部分事件刻意**不加 matcher**：matcher 是启动时写死的，改订阅就得重开
	// 所有格子；而 notification_type 本来就在 payload 里，过滤放 Go 端改一次就生效。
	// 只有 PreToolUse 必须加 —— 见 hookMatchers。
	for _, e := range HookEventTypes {
		one := map[string]any{
			"type": "command",
			// exec 形式：command 是可执行文件本身，参数在 args 里 —— 不过 shell。
			"command": filepath.ToSlash(exe),
			"args":    []string{filepath.ToSlash(HookEventsPathFor(stateDir, tag))},
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
	ToolName             string `json:"tool_name"`              // PreToolUse / PermissionRequest / PostToolUse
	ToolUseID            string `json:"tool_use_id"`            // 工具调用的身份：销等待时靠它对准
	Trigger              string `json:"trigger"`                // PostCompact: manual / auto
}

// resetHookDir 启动时清空事件目录：这是**实时信号**不是历史，
// 上一次运行的事件不该在新的一次里重放。只删我们自己造的 *.jsonl。
func resetHookDir(stateDir string) {
	dir := HookDir(stateDir)
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

// StartHookPoller 跟着"现在活着的那些格子"的事件文件走。
//
// 每个文件一个 offset，全程只在**追加**语义下工作；文件被截断（我们只在启动时
// 干过一次）也能自愈。格子关掉之后它的 offset 会被丢掉、文件留在盘上（下次启动清）。
func (m *Manager) StartHookPoller() {
	resetHookDir(m.stateDir)
	go func() {
		offs := map[string]int64{}
		carry := map[string]string{}
		for {
			time.Sleep(hookPollEvery)
			// 目标集合 = 活着的标签 + 对比窗口（它不是标签，用固定 tag）。
			targets := map[string]int{}
			for _, v := range m.Live() {
				targets[HookEventsPathFor(m.stateDir, fmt.Sprintf("t%d", v.ID))] = v.ID
			}
			targets[HookEventsPathFor(m.stateDir, "wt")] = 0

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
					m.handleHookLine(line, tabID)
				}
				carry[path] = buf
			}
		}
	}()
}

// handleHookLine 解析一行事件并处理。tabID 来自**文件名**，是硬归属；
// 查不到格子（=0）时再退回 session 反查（比如对比窗口那条）。
func (m *Manager) handleHookLine(line string, tabID int) {
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
		tab = m.TabForSession(ev.SessionID)
	}
	agentType := m.AgentForTab(tab)
	// 顺带把关联钉下来：事件里的 session_id 是**第一时间**到达的那个，
	// 比登记表轮询还早。绑定只在第一次生效，所以它和登记表那条路不会打架。
	if tab != 0 && ev.SessionID != "" && m.BindSession(tab, ev.SessionID, "", ev.Source) {
		log.Printf("[agent t%d] 关联建立 session=%s（来自 hook 事件，比登记表更早）", tab, ev.SessionID)
	}

	switch ev.HookEventName {
	case "Stop":
		log.Printf("[hook t%d] Stop session=%s 最后一句=%q", tab, short(ev.SessionID), clip(ev.LastAssistantMessage, 120))
		// 「这一格说过话」的唯一证据（见 panes.Pane.Spoke）：一轮跑完 = 这条会话
		// 有内容，盘上那份 jsonl 于是开始存在。冷恢复靠它分辨"上次这条会话丢了"
		// 和"上一格压根没说过话"—— 后者安安静静地开新格，别吓唬用户。
		if id := m.PaneIDFor(tab); id > 0 && m.panes != nil {
			m.panes.MarkSpoke(id, "一轮跑完 tab="+strconv.Itoa(tab))
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
			m.SetTranscript(tab, ev.TranscriptPath)
		}
	case "SessionEnd":
		log.Printf("[hook t%d] SessionEnd session=%s", tab, short(ev.SessionID))
	case "StopFailure":
		log.Printf("[hook t%d] StopFailure session=%s reason=%q", tab, short(ev.SessionID), clip(ev.Reason, 120))
		// 非正常收尾也算"说过话"：撞限额/鉴权失败之前那一轮是真跑过的，
		// 转录也在盘上。Orca 把 interrupted turn 明确算作可续
		// （resume-sleeping-agent-session.ts:182-183），我们这里同一件事的另一半。
		if id := m.PaneIDFor(tab); id > 0 && m.panes != nil {
			m.panes.MarkSpoke(id, "非正常收尾 tab="+strconv.Itoa(tab))
		}
	case "PermissionRequest":
		// 批准框出现：比 Notification(permission_prompt) 早，而且 tool_name 直接
		// 告诉我们批的是什么。State 是 waiting（批准），不是 blocked（提问卡片）。
		log.Printf("[hook t%d] PermissionRequest tool=%s session=%s", tab, orNone(ev.ToolName), short(ev.SessionID))
	case "PreToolUse":
		// 只订阅了 AskUserQuestion（matcher 写死在 --settings 里）。这条就是
		// “提问卡片刚画出来”的第一手证据；State 用 blocked（具体提问）。
		log.Printf("[hook t%d] PreToolUse tool=%s session=%s", tab, orNone(ev.ToolName), short(ev.SessionID))
	case "PostToolUse", "PostToolUseFailure":
		// 一次工具调用一行。日志会变密 —— 但这是验证“等待真的销掉了”的唯一
		// 字节证据（前端那行 销未读 靠它触发），先留着。
		log.Printf("[hook t%d] %s tool=%s agent=%s session=%s",
			tab, ev.HookEventName, orNone(ev.ToolName), orNone(ev.AgentID), short(ev.SessionID))
	case "UserPromptSubmit":
		// ⚠️ 不记 prompt 文本（用户定的隐私边界）：只记“用户发了一轮”。
		log.Printf("[hook t%d] UserPromptSubmit session=%s", tab, short(ev.SessionID))
		// 用户按下发送 = 这条会话已经有内容，哪怕这一轮还没跑完/失败了；
		// 关格时靠它决定记录留不留。
		if id := m.PaneIDFor(tab); id > 0 && m.panes != nil {
			m.panes.MarkTalked(id, "用户已发提示 tab="+strconv.Itoa(tab))
			// dsh 的错误轮不会发 Stop（实测 0.2.1-rc.2）。如果只在 Stop 记
			// Spoke，用户发了提示但这一轮失败的格子会被冷恢复误判成“从没说过话”
			// 而开新会话。用户按下发送本身就是这条会话有内容的最早证据。
			if agentType == "dsh" {
				m.panes.MarkSpoke(id, "dsh 用户已发提示 tab="+strconv.Itoa(tab))
			}
		}
	case "PostCompact":
		log.Printf("[hook t%d] PostCompact trigger=%s session=%s", tab, orNone(ev.Trigger), short(ev.SessionID))
	case "SubagentStart", "SubagentStop":
		log.Printf("[hook t%d] %s agent_id=%s agent_type=%s", tab, ev.HookEventName, short(ev.AgentID), ev.AgentType)
	default:
		log.Printf("[hook t%d] %s session=%s", tab, ev.HookEventName, short(ev.SessionID))
	}

	m.Push(map[string]any{
		"type":      "hook",
		"event":     ev.HookEventName,
		"agentType": agentType,
		"tab":       tab,
		"session":   ev.SessionID,
		"ntype":     ev.NotificationType,
		"msg":       ev.Message,
		"last":      ev.LastAssistantMessage,
		"agent":     ev.AgentID,
		"agt":       ev.AgentType,
		"reason":    ev.Reason,
		"source":    ev.Source,
		"tool":      ev.ToolName,
		"tid":       ev.ToolUseID,
		"trigger":   ev.Trigger,
		// 证据来源：前端拿它区分“活事件”和冷恢复时的重放（见 80-live.js
		// 的 restoredUnconfirmed）。hook 永远算活事件。
		"evidence": agent.EvidenceHook,
	})
}
