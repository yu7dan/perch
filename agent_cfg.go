package main

// Agent 网关接线（总览 → Agent 名单 → 右侧配置抽屉）。
//
// 用户 2026-10-18 定：总览下面的 Agent 配置要能做到 magpie 的 Agents 页那套事。
// magpie 把它做完了（internal/agent），但那是 Go internal 包、绑着 magpie 的
// 全局状态，不能 import；正确做法是走它控制面的 HTTP（和网关页同一条路）：
//
//	GET  /api/state                   每个 agent 的 wired / drift / fields
//	POST /api/set                     {agent, field, value}；value 空 = 回默认
//	POST /api/agents/connect/{id}     接进 magpie 网关
//	POST /api/agents/disconnect/{id}  断开，恢复接之前的值
//	POST /api/agents/reapply/{id}     漂移了重新写一遍
//	POST /api/agents/keep/{id}        把现在的配置当成 magpie 写的（清掉漂移）
//	GET  /api/agents/preview/{id}     断开前先看会改哪些文件
//	GET  /api/drift                   谁漂了（抽屉开着时每 15 秒问一次）
//
// 边界：写操作只由用户点「接入 / 断开 / 改字段」触发；控制面没接上时按需
// 拉起（和打开网关页同一个行为）；日志只记 agent/字段名，不记值。

import (
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"strings"
)

func gwAgentPushErr(op, id string, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	log.Printf("[agentcfg] %s%s 失败：%s", op, agentLogID(id), msg)
	pushJSON(map[string]any{
		"type": "gw.agents", "op": op, "id": id, "err": msg, "at": nowISO(),
	})
}

func agentLogID(id string) string {
	if id == "" {
		return ""
	}
	return " " + id
}

// gwAgentPushState 从 /api/state（写操作返回的也是同一份 stateJSON）里只取
// agents 推给前端。形状不对就再问一次 —— 别让前端拿着半份数据猜。
func gwAgentPushState(op, id string, b []byte) {
	var st struct {
		Agents json.RawMessage `json:"agents"`
		Notice string          `json:"notice"`
	}
	if err := json.Unmarshal(b, &st); err != nil || len(st.Agents) == 0 ||
		string(st.Agents) == "null" {
		b2, err2 := gwAPI("GET", "/api/state", nil)
		if err2 != nil {
			gwAgentPushErr(op, id, err2)
			return
		}
		if err3 := json.Unmarshal(b2, &st); err3 != nil || len(st.Agents) == 0 ||
			string(st.Agents) == "null" {
			gwAgentPushErr(op, id, errors.New("magpie 没有返回 agent 列表"))
			return
		}
	}
	var rows []struct {
		ID    string `json:"id"`
		Wired bool   `json:"wired"`
	}
	_ = json.Unmarshal(st.Agents, &rows)
	wired := 0
	for _, r := range rows {
		if r.Wired {
			wired++
		}
	}
	log.Printf("[agentcfg] %s%s：%d 个 agent，已接网关 %d", op, agentLogID(id), len(rows), wired)
	pushJSON(map[string]any{
		"type": "gw.agents", "op": op, "id": id, "agents": st.Agents,
		"notice": st.Notice, "at": nowISO(),
	})
}

// gwAgentPrefetch 总览进入时的预取。只在用户以前用过网关（key 文件在）时才碰
// 控制面：这样名单上的网关绿点开机第一帧就是准的，又不会给从没用过网关的人
// 偷偷拉起一个进程。从没用过就静默返回 —— 不推错误，名单上不该因此变红。
func gwAgentPrefetch() {
	if !gwUsedBefore() {
		return
	}
	gwAgentState()
}

// gwAgentState 读整份 agent 接线状态。需要时才接/拉起控制面。
func gwAgentState() {
	if err := gwEnsure(); err != nil {
		gwAgentPushErr("state", "", err)
		return
	}
	b, err := gwAPI("GET", "/api/state", nil)
	if err != nil {
		gwAgentPushErr("state", "", err)
		return
	}
	gwAgentPushState("state", "", b)
}

// gwAgentSet 改一个字段。value 为空是 magpie 的「回到 agent 自己的默认」，
// 所以空值必须原样发过去（不能当成"没填"）。
func gwAgentSet(id, field, value string) {
	if id == "" || field == "" {
		gwAgentPushErr("set", id, errors.New("缺少 agent 或字段"))
		return
	}
	if err := gwEnsure(); err != nil {
		gwAgentPushErr("set", id, err)
		return
	}
	b, err := gwAPI("POST", "/api/set", map[string]any{
		"agent": id, "field": field, "value": value,
	})
	if err != nil {
		gwAgentPushErr("set", id, err)
		return
	}
	log.Printf("[agentcfg] 写入 %s.%s", id, field)
	gwAgentPushState("set", id, b)
}

// gwAgentAction 只放由 magpie 实现的动作。id 用 PathEscape：像 omp#work
// 这种带 # 的 id 原样拼进 URL 会被截断。
//
// keep 不是"写一遍"：magpie 的 a.Keep() 直接删掉 applied 记录，也就是把
// agent 现在这份配置认作 magpie 设的（漂移消失，断开也不会再还原它）。
// magpie 自己的界面只在 drift.kind == "replaced" 时提供它，Perch 照办。
func gwAgentAction(op, id string) {
	switch op {
	case "connect", "disconnect", "reapply", "keep":
	default:
		gwAgentPushErr(op, id, errors.New("不支持的 agent 动作"))
		return
	}
	if id == "" {
		gwAgentPushErr(op, id, errors.New("缺少 agent"))
		return
	}
	if err := gwEnsure(); err != nil {
		gwAgentPushErr(op, id, err)
		return
	}
	b, err := gwAPI("POST", "/api/agents/"+op+"/"+url.PathEscape(id), map[string]any{})
	if err != nil {
		gwAgentPushErr(op, id, err)
		return
	}
	log.Printf("[agentcfg] %s %s", op, id)
	gwAgentPushState(op, id, b)
}

// gwAgentPreview 断开前的 dry run：返回 {changes:[...], error?}，前端只展示，
// 不动任何文件。预览失败不阻止断开（magpie 自己也是这样：非 native agent
// 拿不到预览时照样给一个通用说明）。
func gwAgentPreview(id string) {
	if id == "" {
		gwAgentPushErr("preview", id, errors.New("缺少 agent"))
		return
	}
	if err := gwEnsure(); err != nil {
		gwAgentPushErr("preview", id, err)
		return
	}
	b, err := gwAPI("GET", "/api/agents/preview/"+url.PathEscape(id), nil)
	if err != nil {
		gwAgentPushErr("preview", id, err)
		return
	}
	if !json.Valid(b) {
		gwAgentPushErr("preview", id, errors.New("magpie 返回的预览不是 JSON"))
		return
	}
	// 预览理论上是个对象；null 会让前端分不清"没有预览"和"还在读"，统一成 {}。
	raw := strings.TrimSpace(string(b))
	if raw == "null" {
		raw = "{}"
	}
	pushJSON(map[string]any{
		"type": "gw.agent.preview", "id": id,
		"preview": json.RawMessage(raw), "at": nowISO(),
	})
}

// 上一次漂移轮询的错误；同样的错误只记一次，不然侧车被杀之后每 15 秒一条。
var gwDriftErr string

// gwAgentDrift 只问"谁漂了"：GET /api/drift 的形状是 {agentID: Drift}，
// 没漂移的 agent 不在里面。抽屉开着时前端每 15 秒问一次（和 magpie 自己的
// 窗口同一个节奏），这里只推原始映射，怎么合进名单由前端决定。
//
// 轮询绝不拉起控制面：没连上就安静返回（magpie 的前端同样是 catch 里直接
// return）。失败也不推错误 —— 后台噪声不该把抽屉里的正常内容换成红字。
func gwAgentDrift() {
	_, _, client, _ := gwConnState()
	if client == nil {
		return
	}
	b, err := gwAPI("GET", "/api/drift", nil)
	if err != nil {
		if err.Error() != gwDriftErr {
			gwDriftErr = err.Error()
			log.Printf("[agentcfg] drift 读取失败：%v", err)
		}
		return
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		if gwDriftErr != "magpie 返回的漂移列表不是对象" {
			gwDriftErr = "magpie 返回的漂移列表不是对象"
			log.Printf("[agentcfg] %s", gwDriftErr)
		}
		return
	}
	gwDriftErr = ""
	pushJSON(map[string]any{"type": "gw.agents.drift", "drift": m, "at": nowISO()})
}
