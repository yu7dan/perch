package gateway

// 接线 agent 的启动环境。
//
// magpie 的 /api/state 对 agy 这类 agent 会带一条 launch 命令：
//
//	$env:GEMINI_API_KEY="…"; $env:GOOGLE_GEMINI_BASE_URL="…"; agy --model 'magpie/…'
//
// 这不是给 Perch 拿去执行的脚本 —— 我们只认其中**固定形状**的两个环境变量
// 和 --model，解析成结构化数据再交给启动路径。形状不认识就返回 false，
// 绝不把远端字符串整条交给 shell。
//
// 为什么需要它：agy 接上网关后 modelProvider="gemini" 写在 settings.json，
// 而网关地址/密钥只能从环境变量拿；少了它们 agy 一启动就退出。

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

var agyLaunchRe = regexp.MustCompile(
	`^\$env:GEMINI_API_KEY="([^"]+)";\s*` +
		`\$env:GOOGLE_GEMINI_BASE_URL="([^"]+)";\s*` +
		`agy --model '(.*)'$`)

// ParseAgentLaunch 把 magpie 的 agy 启动命令解析成 env/args。
// 只接受 http(s) 的 base URL；model 里的两个单引号是 PowerShell 的转义。
func ParseAgentLaunch(raw string) (env map[string]string, args []string, ok bool) {
	m := agyLaunchRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return nil, nil, false
	}
	key, base, model := m[1], m[2], strings.ReplaceAll(m[3], "''", "'")
	if key == "" || model == "" {
		return nil, nil, false
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return nil, nil, false
	}
	return map[string]string{
		"GEMINI_API_KEY":         key,
		"GOOGLE_GEMINI_BASE_URL": base,
	}, []string{"--model", model}, true
}

// Launch 返回 current agent 的启动环境与参数。没接线/没读到/形状不认识
// 都返回 false，调用方退回通用启动。
//
// 冷启动/恢复格子时 /api/state 可能还没到总览的预取里；如果控制面已经连着，
// 这里同步补问一次。不在这里 Ensure —— 启动一个没接网关的 agent 不该顺带
// 拉起一个 magpie 进程。
func (g *Gateway) Launch(id string) (map[string]string, []string, bool) {
	if id == "" {
		return nil, nil, false
	}
	raw := g.launchRaw(id)
	if raw == "" {
		if _, _, client, _ := g.connState(); client != nil {
			// 最多等 2 秒：面板/恢复格子不能被一个卡住的控制面拖 20 秒。
			// 晚到的结果仍然写回 map，下一次开格就能用上。
			done := make(chan struct{})
			go func() {
				if b, err := g.API("GET", "/api/state", nil); err == nil {
					g.storeLaunches(b)
				}
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
			}
			raw = g.launchRaw(id)
		}
	}
	return ParseAgentLaunch(raw)
}

func (g *Gateway) launchRaw(id string) string {
	g.launchMu.Lock()
	defer g.launchMu.Unlock()
	return g.agentLaunch[id]
}

// storeLaunches 从一份 /api/state 里取 launch（形状与 agents.go 的一致）。
func (g *Gateway) storeLaunches(b []byte) {
	var st struct {
		Agents []struct {
			ID     string `json:"id"`
			Launch string `json:"launch"`
		} `json:"agents"`
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return
	}
	next := make(map[string]string, len(st.Agents))
	for _, a := range st.Agents {
		if a.Launch != "" {
			next[a.ID] = a.Launch
		}
	}
	g.setAgentLaunch(next)
}

// setAgentLaunch 用最新一份 /api/state 整份替换 launch 表：断开接线后
// 上一次的 launch 不能继续生效。
func (g *Gateway) setAgentLaunch(next map[string]string) {
	if next == nil {
		next = map[string]string{}
	}
	g.launchMu.Lock()
	g.agentLaunch = next
	g.launchMu.Unlock()
}
