package gateway

// Agent 会话级的网关注入（Phase 2）。
//
// 和 magpie 的 /api/agents/connect 完全不同：那条路会把地址/模型写进
// ~/.claude/settings.json、~/.codex/config.toml；这里只给**这一格**注入：
//   - Claude：--settings 的 env 块（override 用户 settings 里的同名 env），
//     模型名固定成 group/perch-claude 这个稳定别名；
//   - Codex：-c 覆盖，模型名固定成 group/perch-codex。
// 换模型 = 改网关里这个 group 的目标，运行中的会话下一轮就生效，不重启。
// 用户的全局配置、桌面端都不受影响。

import (
	"fmt"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/yu7dan/perch/internal/uimsg"
)

// PerchLocalToken 是本机回环网关的占位 token。magpie 信任 127.0.0.1
// 的回环请求；真实 key 不需要进 agent 配置。
const PerchLocalToken = "perch-local"

// ClaudeProfileEnv 是写进 --settings 的 env 块的一组覆盖值。
func ClaudeProfileEnv(alias string) map[string]string {
	return map[string]string{
		"ANTHROPIC_BASE_URL":             IsolatedGatewayURL(),
		"ANTHROPIC_AUTH_TOKEN":           PerchLocalToken,
		"ANTHROPIC_MODEL":                alias,
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   alias,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": alias,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  alias,
		"ANTHROPIC_DEFAULT_FABLE_MODEL":  alias,
		"ANTHROPIC_SMALL_FAST_MODEL":     alias,
	}
}

// CodexProfileArgs 是 codex 的顶层 -c 覆盖。args 里不带 key 的真实值。
func CodexProfileArgs(alias string) []string {
	base := IsolatedGatewayURL() + "/v1"
	return []string{
		"-c", fmt.Sprintf("model=%q", alias),
		"-c", `model_provider="perch"`,
		"-c", `model_providers.perch.name="Perch"`,
		"-c", fmt.Sprintf("model_providers.perch.base_url=%q", base),
		"-c", `model_providers.perch.wire_api="responses"`,
		"-c", fmt.Sprintf("model_providers.perch.experimental_bearer_token=%q", PerchLocalToken),
	}
}

// EnsureAgentGroup 在 Perch 引擎里建/改这个 agent 的稳定别名组。
// 组名 = alias 去掉 "group/"。模型必须是引擎目录里已有的 provider/model。
func (g *Gateway) EnsureAgentGroup(alias, model string) error {
	alias = strings.TrimSpace(alias)
	model = strings.TrimSpace(model)
	if !strings.HasPrefix(alias, "group/") || model == "" {
		return uimsg.New("gw.agentProfileBad", "agent 配置缺少模型别名或模型")
	}
	if !g.Isolated() {
		return uimsg.New("gw.agentProfileMode", "agent 配置只在 Perch 自己的网关引擎下生效")
	}
	if err := g.Ensure(); err != nil {
		return err
	}
	_, key, _, _ := g.connState()
	if key == "" {
		return uimsg.New("gw.agentProfileKey", "网关引擎还没准备好")
	}
	env, err := engineEnv(key)
	if err != nil {
		return err
	}
	name := strings.TrimPrefix(alias, "group/")
	exe := PerchEngineExe()
	run := func(args ...string) (string, error) {
		cmd := exec.Command(exe, args...)
		cmd.Env = env
		cmd.Dir = filepath.Dir(exe)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		b, err := cmd.CombinedOutput()
		msg := strings.ReplaceAll(string(b), key, "***")
		if err != nil {
			return msg, err
		}
		return msg, nil
	}
	// 先 set（已有组），失败再 add（不存在的组）。
	if _, err := run("group", "set", name, "models="+model); err != nil {
		if out, err2 := run("group", "add", name, "models="+model, "routing=order"); err2 != nil {
			tail := strings.TrimSpace(out)
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			log.Printf("[gw] agent group %s 设置失败：%v / %s", name, err2, tail)
			return uimsg.NewParams("gw.agentProfileFailed",
				fmt.Sprintf("网关路由组 %s 设置失败：%s", name, tail),
				map[string]string{"group": name, "err": tail})
		}
	}
	log.Printf("[gw] agent %s 的模型别名 %s → %s", name, alias, model)
	return nil
}
