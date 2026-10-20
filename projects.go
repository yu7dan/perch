package main

// 项目池的旧名字接缝：类型与落盘在 internal/project，归属统计也已在那边
// （Stats/Wire/Audit）。root 只保留「默认目录从设置注入」这一个接缝与
// defaultCWD 用到的那两个函数；6b 会把它们收进组合根。
//
// 三条设计口径（用户 2026-10-16 当面定的）见 internal/project 的包注释。

import "github.com/yu7dan/perch/internal/project"

// customDefaultCWD 把设置里的「默认目录」注入项目池；空串 = 用内置目录。
func customDefaultCWD() string {
	if prefsStore == nil {
		return ""
	}
	return prefsStore.Snapshot().DefaultCWD
}

// 默认工作区（Go 合成的，不进 projects.json）：
// 安装即存在、有不使用但必须有、删除只提示不阻拦。它不在池子里，
// 所以合成条目只在内存里出现（见 project.WithDefaultWorkspace）。

func defaultWorkspaceCWD() string {
	return project.DefaultWorkspaceCWD(customDefaultCWD)
}

func ensureDefaultWorkspace() {
	project.EnsureDefaultWorkspace(customDefaultCWD)
}

type projectPool = project.Pool

func loadProjectPool() *projectPool { return project.Load() }
