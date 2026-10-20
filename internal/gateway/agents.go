package gateway

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
	"log"
	"net/url"
	"strings"

	"github.com/yu7dan/perch/internal/uimsg"
)

func (g *Gateway) agentPushErr(op, id string, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	log.Printf("[agentcfg] %s%s 失败：%s", op, agentLogID(id), msg)
	m := map[string]any{"type": "gw.agents", "op": op, "id": id, "at": nowISO()}
	g.emit(uimsg.Fields(m, err))
}

func agentLogID(id string) string {
	if id == "" {
		return ""
	}
	return " " + id
}

// agentPushState 从 /api/state（写操作返回的也是同一份 stateJSON）里只取
// agents 推给前端。形状不对就再问一次 —— 别让前端拿着半份数据猜。
func (g *Gateway) agentPushState(op, id string, b []byte) {
	var st struct {
		Agents json.RawMessage `json:"agents"`
		Notice string          `json:"notice"`
	}
	if err := json.Unmarshal(b, &st); err != nil || len(st.Agents) == 0 ||
		string(st.Agents) == "null" {
		b2, err2 := g.API("GET", "/api/state", nil)
		if err2 != nil {
			g.agentPushErr(op, id, err2)
			return
		}
		if err3 := json.Unmarshal(b2, &st); err3 != nil || len(st.Agents) == 0 ||
			string(st.Agents) == "null" {
			g.agentPushErr(op, id, uimsg.New("gw.agentListMissing", "magpie 没有返回 agent 列表"))
			return
		}
	}
	// 保留 magpie 的原始行（抽屉的字段/漂移/图标都在里面），只补一个
	// **上游没说**的已知边界：普通 Cursor CLI 不能接（见 AgentAction 的 preflight）。
	// 用 map 而不是结构体，免得以后 magpie 加字段被我们吃掉。
	var rows []map[string]json.RawMessage
	_ = json.Unmarshal(st.Agents, &rows)
	wired := 0
	launches := make(map[string]string, len(rows))
	for _, r := range rows {
		var rid string
		_ = json.Unmarshal(r["id"], &rid)
		var w bool
		_ = json.Unmarshal(r["wired"], &w)
		if w {
			wired++
		}
		var launch string
		_ = json.Unmarshal(r["launch"], &launch)
		if launch != "" {
			launches[rid] = launch
		}
		if _, ok := r["connectable"]; !ok && rid == "cursor" {
			r["connectable"] = json.RawMessage("false")
		}
	}
	agentsJSON, _ := json.Marshal(rows)
	// 启动环境只认最新一份 state：断开 agy 后，旧的 launch 不能继续被
	// 下一次开格捡到。
	g.setAgentLaunch(launches)
	log.Printf("[agentcfg] %s%s：%d 个 agent，已接网关 %d", op, agentLogID(id), len(rows), wired)
	g.emit(map[string]any{
		"type": "gw.agents", "op": op, "id": id, "agents": json.RawMessage(agentsJSON),
		"notice": st.Notice, "at": nowISO(),
	})
}

// agentConnectable 是 connect 之前的只读预检：magpie 的 state 行里有
// connectable 就用它；没有的话按已知上游边界判（普通 Cursor CLI）。
// 预检失败（读不到 state）不阻塞 —— 让 POST 去回答，错误会被分类。
func (g *Gateway) agentConnectable(id string) (bool, bool) {
	b, err := g.API("GET", "/api/state", nil)
	if err != nil {
		return false, false
	}
	var st struct {
		Agents []struct {
			ID          string `json:"id"`
			Connectable *bool  `json:"connectable"`
		} `json:"agents"`
	}
	if json.Unmarshal(b, &st) != nil {
		return false, false
	}
	for _, r := range st.Agents {
		if r.ID != id {
			continue
		}
		if r.Connectable != nil {
			return *r.Connectable, true
		}
		if id == "cursor" {
			// 实测（2026-10-21）：magpie 的 cursor agent 只有 model=auto，
			// connect() 直接返回 "Cursor CLI can't be connected to magpie"。
			return false, true
		}
		return true, true
	}
	return false, true // 列表里没有它 = 不是 magpie 管的 agent
}

// AgentPrefetch 总览进入时的预取。只在用户以前用过网关（key 文件在）时才碰
// 控制面：这样名单上的网关绿点开机第一帧就是准的，又不会给从没用过网关的人
// 偷偷拉起一个进程。从没用过就静默返回 —— 不推错误，名单上不该因此变红。
func (g *Gateway) AgentPrefetch() {
	if !g.UsedBefore() {
		return
	}
	g.AgentState()
}

// AgentState 读整份 agent 接线状态。需要时才接/拉起控制面。
func (g *Gateway) AgentState() {
	if err := g.Ensure(); err != nil {
		g.agentPushErr("state", "", err)
		return
	}
	b, err := g.API("GET", "/api/state", nil)
	if err != nil {
		g.agentPushErr("state", "", err)
		return
	}
	g.agentPushState("state", "", b)
}

// AgentSet 改一个字段。value 为空是 magpie 的「回到 agent 自己的默认」，
// 所以空值必须原样发过去（不能当成"没填"）。
func (g *Gateway) AgentSet(id, field, value string) {
	if id == "" || field == "" {
		g.agentPushErr("set", id, uimsg.New("gw.missingAgentField", "缺少 agent 或字段"))
		return
	}
	if err := g.Ensure(); err != nil {
		g.agentPushErr("set", id, err)
		return
	}
	b, err := g.API("POST", "/api/set", map[string]any{
		"agent": id, "field": field, "value": value,
	})
	if err != nil {
		g.agentPushErr("set", id, err)
		return
	}
	log.Printf("[agentcfg] 写入 %s.%s", id, field)
	g.agentPushState("set", id, b)
}

// AgentAction 只放由 magpie 实现的动作。id 用 PathEscape：像 omp#work
// 这种带 # 的 id 原样拼进 URL 会被截断。
//
// keep 不是"写一遍"：magpie 的 a.Keep() 直接删掉 applied 记录，也就是把
// agent 现在这份配置认作 magpie 设的（漂移消失，断开也不会再还原它）。
// magpie 自己的界面只在 drift.kind == "replaced" 时提供它，Perch 照办。
func (g *Gateway) AgentAction(op, id string) {
	switch op {
	case "connect", "disconnect", "reapply", "keep":
	default:
		g.agentPushErr(op, id, uimsg.New("gw.unsupportedAction", "不支持的 agent 动作"))
		return
	}
	if id == "" {
		g.agentPushErr(op, id, uimsg.New("gw.missingAgent", "缺少 agent"))
		return
	}
	if err := g.Ensure(); err != nil {
		g.agentPushErr(op, id, err)
		return
	}
	// 接入前先读一次只读 state：magpie 明确不能接的 agent（普通 Cursor CLI）
	// **不发 POST**。用户看到的是一句解释，而不是一个 HTTP 400 正文。
	if op == "connect" {
		if ok, known := g.agentConnectable(id); known && !ok {
			text := "magpie 不能接入这个 agent（该 agent 没有可路由的 provider 选项）"
			if id == "cursor" {
				text = "magpie 不能接入普通 Cursor CLI（Cursor CLI can't be connected to magpie）"
			}
			g.agentPushErr(op, id, uimsg.New("gw.agentNotConnectable", text))
			return
		}
	}
	b, err := g.API("POST", "/api/agents/"+op+"/"+url.PathEscape(id), map[string]any{})
	if err != nil {
		g.agentPushErr(op, id, err)
		return
	}
	log.Printf("[agentcfg] %s %s", op, id)
	g.agentPushState(op, id, b)
}

// AgentPreview 断开前的 dry run：返回 {changes:[...], error?}，前端只展示，
// 不动任何文件。预览失败不阻止断开（magpie 自己也是这样：非 native agent
// 拿不到预览时照样给一个通用说明）。
func (g *Gateway) AgentPreview(id string) {
	if id == "" {
		g.agentPushErr("preview", id, uimsg.New("gw.missingAgent", "缺少 agent"))
		return
	}
	if err := g.Ensure(); err != nil {
		g.agentPushErr("preview", id, err)
		return
	}
	b, err := g.API("GET", "/api/agents/preview/"+url.PathEscape(id), nil)
	if err != nil {
		g.agentPushErr("preview", id, err)
		return
	}
	if !json.Valid(b) {
		g.agentPushErr("preview", id, uimsg.New("gw.previewNotJSON", "magpie 返回的预览不是 JSON"))
		return
	}
	// 预览理论上是个对象；null 会让前端分不清"没有预览"和"还在读"，统一成 {}。
	raw := strings.TrimSpace(string(b))
	if raw == "null" {
		raw = "{}"
	}
	g.emit(map[string]any{
		"type": "gw.agent.preview", "id": id,
		"preview": json.RawMessage(raw), "at": nowISO(),
	})
}

// AgentDrift 只问"谁漂了"：GET /api/drift 的形状是 {agentID: Drift}，
// 没漂移的 agent 不在里面。抽屉开着时前端每 15 秒问一次（和 magpie 自己的
// 窗口同一个节奏），这里只推原始映射，怎么合进名单由前端决定。
//
// 轮询绝不拉起控制面：没连上就安静返回（magpie 的前端同样是 catch 里直接
// return）。失败也不推错误 —— 后台噪声不该把抽屉里的正常内容换成红字。
func (g *Gateway) AgentDrift() {
	_, _, client, _ := g.connState()
	if client == nil {
		return
	}
	b, err := g.API("GET", "/api/drift", nil)
	if err != nil {
		if err.Error() != g.driftErr {
			g.driftErr = err.Error()
			log.Printf("[agentcfg] drift 读取失败：%v", err)
		}
		return
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		if g.driftErr != "magpie 返回的漂移列表不是对象" {
			g.driftErr = "magpie 返回的漂移列表不是对象"
			log.Printf("[agentcfg] %s", g.driftErr)
		}
		return
	}
	g.driftErr = ""
	g.emit(map[string]any{"type": "gw.agents.drift", "drift": m, "at": nowISO()})
}
