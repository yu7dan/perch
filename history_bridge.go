package main

// 会话索引的旧名字接缝：实现在 internal/history，root 在 6a 收掉。

import (
	"github.com/yu7dan/perch/internal/history"
	"github.com/yu7dan/perch/internal/transcript"
)

type claudeSession = history.Session
type dayActivity = history.DayActivity
type historyItem = history.HistoryItem

// scanSessions 扫一遍 Claude 会话库。分类判据用 transcript.SystemTurn ——
// 和流水栏认同一批「不是你说的话」的条目。
func scanSessions(stateDir string) ([]claudeSession, []dayActivity) {
	return history.Scan(stateDir, transcript.SystemTurn)
}

// tailHistory 取一个会话最近的对话轮次（右侧历史流）。
func tailHistory(s claudeSession, stateDir string, keep int) []historyItem {
	return history.TailHistory(s, stateDir, keep)
}
