package main

// 安装器的旧名字接缝：执行在 internal/install，root 在 6b 收掉。

import (
	"os"

	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/install"
	"github.com/yu7dan/perch/internal/winproc"
)

var installer = install.New(install.Deps{
	Push: pushJSON,
	Cards: func() []agentcatalog.Card {
		home, _ := os.UserHomeDir()
		return scanAgentCatalog(home)
	},
	MergeCalls:   mergeCatalogCalls,
	ReloadPath:   winproc.ReloadPathFromRegistry,
	ProbeVersion: winproc.ProbeVersion,
	Home:         os.UserHomeDir,
	OnInstalled: func(id string, ok bool) {
		// 装完 magpie 自动接入控制面（用户 2026-10-17 定的）。
		if id == "magpie" && ok {
			go gwConnect()
		}
	},
})
