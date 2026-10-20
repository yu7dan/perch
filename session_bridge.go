package main

// 会话层的旧名字接缝：实现在 internal/session，root 在 6b 收掉。

import (
	"strings"

	"github.com/yu7dan/perch/internal/session"
)

type spawnSpec = session.SpawnSpec
type tabHost = session.Tab
type tabManager = session.Manager
type tabView = session.LiveTab
type titleStore = session.TitleStore
type refusal = session.Refusal

const sessionHookExeName = session.HookExeName

// loadTitleStore 只算名字表的落点；读写都在 session.TitleStore。
func loadTitleStore(path string) *titleStore { return session.LoadTitleStore(path) }

// newSessionManager 是组合根的会话构造函数：宿主能力在这里一次性注入。
// ⚠️ 必须在 agent.SetHost 之前调用（Host 收的就是它），Defs 要等 SetHost 之后。
func newSessionManager() *tabManager {
	return session.New(session.Deps{
		StateDir:     claudeStateDir,
		Panes:        panes,
		Titles:       titlesStore,
		DefaultCWD:   defaultCWD,
		ResolveExe:   resolveAgentExe,
		ProcessAlive: processAlive,
		Push:         pushJSON,
		Caps:         capsForAgent,
	})
}

// resumeRefusal 返回 nil = 放行。
func resumeRefusal(spec spawnSpec) *refusal { return tabs.ResumeRefusal(spec) }

// sessionFileExistsFor 是冷恢复/续接护栏的 agent 分派口。
func sessionFileExistsFor(agentName, cwd, id string) bool {
	return tabs.SessionFileExistsFor(agentName, cwd, id)
}

// effectiveCWD 是一份 spec 的**生效 cwd** = 落盘那份记录里该记的值。
func effectiveCWD(spec spawnSpec) string { return tabs.EffectiveCWD(spec) }

// buildHookSettings 造那份只对一格生效的 --settings。
func buildHookSettings(tag string) string { return session.BuildHookSettings(claudeStateDir, tag) }

func hookExePath() string { return session.HookExePath() }

func hookDir() string { return session.HookDir(claudeStateDir) }

func hookEventCount() int { return len(session.HookEventTypes) }

// applyRename 把标签上的改名落到会话（pid → sessionId 反查在 session 里）。
func applyRename(stateDir string, titles *titleStore, pid int, name string) {
	session.ApplyRename(stateDir, titles, pid, name)
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
