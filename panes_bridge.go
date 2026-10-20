package main

// 格子登记表的旧名字接缝：实现在 internal/panes，root 在 6b 收掉。

import (
	"log"

	"github.com/yu7dan/perch/internal/appdir"
	panespkg "github.com/yu7dan/perch/internal/panes"
)

type paneStore = panespkg.Store

const paneStoreFile = "panes.json"

// loadPaneStore 算出落点（%APPDATA%\Perch\panes.json）再交给 panes.Load。
// 与池子同一个目录，**绝不**写进 claude 的状态根（两家状态不许搅在一起）。
func loadPaneStore() *paneStore {
	f, err := appdir.PerchFile(paneStoreFile)
	if err != nil {
		log.Printf("[panes] 拿不到用户配置目录：%v", err)
		return panespkg.Load("", true)
	}
	return panespkg.Load(f, false)
}
