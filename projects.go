package main

// 项目池的旧名字接缝：类型与落盘在 internal/project，归属统计也已在那边
// （Stats/Wire/Audit）。root 只保留旧名字与「默认目录从设置注入」这一个接缝，
// 6a 会把调用点直接切到 internal/project。
//
// 三条设计口径（用户 2026-10-16 当面定的）见 internal/project 的包注释。

import (
	"time"

	"github.com/yu7dan/perch/internal/project"
)

// Project 是**落盘的那份形状**（定义在 internal/project）。
type Project = project.Project

// projectWire 是**发给前端的那份**（定义在 internal/project）。
type projectWire = project.Wire

// customDefaultCWD 把设置里的「默认目录」注入项目池；空串 = 用内置目录。
func customDefaultCWD() string {
	if prefsStore == nil {
		return ""
	}
	return prefsStore.Snapshot().DefaultCWD
}

// ---------------------------------------------------------------------------
// 默认工作区（Go 合成的，不进 projects.json）
//
// 用户的原话是"安装即存在、有不使用但必须有、删除只提示不阻拦"，像 Claude /
// Codex 桌面端各有一个不挂在任何项目下的默认落点。三条要求翻译成三条实现：
//   · 安装即存在 → 代码里就有（合成），不依赖任何一次写盘；
//   · 删不掉     → 它根本不在池子里，没有可删的记录（前端那颗「从列表移除」做灰）；
//   · 必须有     → 它永远是最后一行，新格没指定目录时也落在它这里。
// ---------------------------------------------------------------------------

const (
	sourceSynthetic = project.SourceSynthetic
	defaultWSName   = project.DefaultWSName
)

// 下面这几个是旧名字的接缝；实现在 internal/project，默认目录从设置注入。

func defaultWorkspacePath() (string, bool) {
	return project.DefaultWorkspacePath(customDefaultCWD)
}

func builtinDefaultWorkspacePath() (string, bool) {
	return project.BuiltinDefaultWorkspacePath()
}

func defaultWorkspaceCWD() string {
	return project.DefaultWorkspaceCWD(customDefaultCWD)
}

func ensureDefaultWorkspace() {
	project.EnsureDefaultWorkspace(customDefaultCWD)
}

func withDefaultWorkspace(projects []Project) []Project {
	return project.WithDefaultWorkspace(projects, customDefaultCWD)
}

type projectPool = project.Pool

func loadProjectPool() *projectPool { return project.Load() }

func pathKey(p string) string { return project.PathKey(p) }

func parseTS(s string) time.Time { return project.ParseTS(s) }

// 归属统计的旧名字接缝（实现在 internal/project/stats.go）。
func projectStats(sessions []claudeSession, projects []Project) (map[string]string, map[string]time.Time, map[string]int) {
	return project.Stats(sessions, projects)
}

func poolAudit(sessions []claudeSession, assign map[string]string, wire []projectWire) (sum, nUn, nMain, nAll int) {
	return project.Audit(sessions, assign, wire)
}

func wireProjects(projects []Project, recent map[string]time.Time, count map[string]int) []projectWire {
	return project.WireProjects(projects, recent, count)
}
