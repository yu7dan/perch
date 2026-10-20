package session

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// probeReadiness 在格子起来之后异步问 agent 自己的只读就绪状态。
//
// 只处理**有稳定只读命令**的 agent；其余靠首屏分类（前端 agent.readiness）。
// 不读凭据、不打印输出正文，只落分类。
func (m *Manager) probeReadiness(tab *Tab) {
	if m.agentState == nil || tab == nil {
		return
	}
	switch tab.Spec.Agent {
	case "cursor":
		go m.probeCursor(tab.Spec.Agent)
	}
}

// probeCursor 用 `cursor-agent whoami` 判断是否登录。
//
// 实测（2026-10-21，Windows）：未登录时输出 `Not logged in`；登录后输出账号
// （邮箱）。两种都只取**分类**，账号不进日志、不落盘。
func (m *Manager) probeCursor(agentID string) {
	exe, prefix := m.ResolveExe("cursor-agent")
	if strings.TrimSpace(exe) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	args := append(append([]string{}, prefix...), "whoami")
	out, err := exec.CommandContext(ctx, exe, args...).CombinedOutput()
	if ctx.Err() != nil {
		return // 超时/取消：不知道比猜一个强
	}
	text := strings.ToLower(strings.TrimSpace(string(out)))
	switch {
	case strings.Contains(text, "not logged in"), strings.Contains(text, "logged out"):
		m.agentState.RecordReadiness(agentID, "needs-login", "whoami")
	case err == nil && text != "":
		// whoami 正常返回账号 —— 分类要，正文丢。
		m.agentState.RecordReadiness(agentID, "ready", "whoami")
	}
}
