package agent

import "strconv"

// BotConfig 是 Bot Group 里一个角色自己的启动配置（角色配置抽屉里设的）。
// 空字段 = 跟随 agent 自己 / 「设置 › 模型」里给这个 agent 配的。
type BotConfig struct {
	Model      string
	Effort     string
	Permission string // "" | read-only | workspace-write | full-access
}

// 能按格设的项（前端 BG_CFG_CAPS 照这张表把不支持的项做灰，两边要一起改）：
//
//	Claude / Codex：模型、强度、权限；
//	OpenCode：模型（-m provider/model）、权限（只读 = --agent plan，完全访问 = --auto，工作区 = 它自己的默认）；
//	Pi：模型（--model）、强度（--thinking）、权限只有只读（--tools read,grep,find,ls）—— Pi 本来就不问，工作区 = 完全访问。
//
// BotLaunch 把一个 Bot 的配置翻译成这一次启动的 env / 参数。它排在「模型提供商」的
// 注入之后，所以同一项以 Bot 的为准：
//
//	Claude：模型 / 强度走 --settings 的 env（ANTHROPIC_MODEL / CLAUDE_CODE_EFFORT_LEVEL），
//	        权限是 --permission-mode（只读 = plan，工作区 = acceptEdits，完全访问 = bypassPermissions）；
//	Codex： 全是顶层 -c 覆盖（app-server 和 TUI 都拿到同一组），后写的盖过先写的。
func BotLaunch(agentID string, c BotConfig) (env map[string]string, args []string) {
	env = map[string]string{}
	switch agentID {
	case "claude":
		if c.Model != "" {
			env["ANTHROPIC_MODEL"] = c.Model
		}
		if c.Effort != "" {
			env["CLAUDE_CODE_EFFORT_LEVEL"] = c.Effort
		}
		switch c.Permission {
		case "read-only":
			args = append(args, "--permission-mode", "plan")
		case "workspace-write":
			args = append(args, "--permission-mode", "acceptEdits")
		case "full-access":
			args = append(args, "--permission-mode", "bypassPermissions")
		}
	case "opencode":
		if c.Model != "" {
			args = append(args, "-m", c.Model)
		}
		switch c.Permission {
		case "read-only":
			args = append(args, "--agent", "plan")
		case "full-access":
			args = append(args, "--auto")
		}
	case "pi":
		if c.Model != "" {
			args = append(args, "--model", c.Model)
		}
		if c.Effort != "" {
			args = append(args, "--thinking", c.Effort)
		}
		if c.Permission == "read-only" {
			args = append(args, "--tools", "read,grep,find,ls")
		}
	case "codex":
		if c.Model != "" {
			args = append(args, "-c", "model="+strconv.Quote(c.Model))
		}
		if c.Effort != "" {
			e := c.Effort
			if e == "max" {
				e = "xhigh"
			}
			args = append(args, "-c", "model_reasoning_effort="+strconv.Quote(e))
		}
		switch c.Permission {
		case "read-only":
			args = append(args, "-c", `sandbox_mode="read-only"`, "-c", `approval_policy="on-request"`)
		case "workspace-write":
			args = append(args, "-c", `sandbox_mode="workspace-write"`, "-c", `approval_policy="on-request"`)
		case "full-access":
			args = append(args, "-c", `sandbox_mode="danger-full-access"`, "-c", `approval_policy="never"`)
		}
	}
	return env, args
}
