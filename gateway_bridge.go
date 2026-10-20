package main

// 网关的旧名字接缝：实现在 internal/gateway，root 在 6b 收掉。

import (
	"net/http"

	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/gateway"
)

type magpieSnap = gateway.Snapshot
type agentCard = agentcatalog.Card

// gw 是唯一的网关实例；pushJSON 是 root 的前端推送函数。
var gw = gateway.New(pushJSON)

// scanAgentCatalog 是本机探测的入口；清单、能力、配方、Exe 发现全在
// internal/agentcatalog。
func scanAgentCatalog(home string) []agentCard { return agentcatalog.Cards(home) }

func magpieSnapshot() *magpieSnap { return gw.Snapshot() }

func startMagpieWatcher(push func(any)) {
	// push 已由 New(pushJSON) 注入；保留参数只为兼容调用点。
	gw.StartWatcher()
}

func gwConnect() { gw.Connect() }
func gwStop()    { gw.Stop() }
func gwProbe()   { gw.Probe() }
func gwUIStart() { gw.StartUI() }

func gwUIHandler(assets http.Handler) http.Handler { return gw.UIHandler(assets) }

// mergeCatalogCalls 把“今日经过网关”的读数保留下来：刚扫出来的名单没有
// calls，直接推给前端会让所有 agent 的今日流量闪成 0。
func mergeCatalogCalls(cat []agentCard) {
	s := magpieSnapshot()
	if s == nil {
		return
	}
	byID := map[string]int{}
	for _, a := range s.Catalog {
		byID[a.ID] = a.Calls
	}
	for i := range cat {
		cat[i].Calls = byID[cat[i].ID]
	}
}
