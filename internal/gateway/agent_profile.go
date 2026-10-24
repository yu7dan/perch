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
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/yu7dan/perch/internal/uimsg"
)

// PerchLocalToken 是本机回环网关的占位 token。magpie 信任 127.0.0.1
// 的回环请求；真实 key 不需要进 agent 配置。
const PerchLocalToken = "perch-local"

// AgentModel 是 Agent UI 的模型目录一行（来自引擎的 /api/providers）。
type AgentModel struct {
	Provider     string   `json:"provider"`
	ProviderName string   `json:"providerName"`
	Icon         string   `json:"icon,omitempty"`
	ID           string   `json:"id"` // provider/model
	Name         string   `json:"name"`
	On           bool     `json:"on"`
	Efforts      []string `json:"efforts,omitempty"`
	Context      int      `json:"context,omitempty"`
}

// AgentModels 读引擎的供应商/模型目录。它会让 Ensure 确保引擎已起 ——
// 调用点在用户打开 Agent 模型选择器/总览 Agent 区，属于用户动作。
func (g *Gateway) AgentModels() ([]AgentModel, error) {
	if err := g.Ensure(); err != nil {
		return nil, err
	}
	b, err := g.API("GET", "/api/providers", nil)
	if err != nil {
		return nil, err
	}
	b = g.seedProviderModels(b)
	out, err := parseAgentModels(b)
	if err != nil {
		return nil, err
	}
	// 插件供应商（WorkBuddy）的模型通常已经在 /api/providers 里了；插件缓存
	// plugin-providers.json 是兜底（例如插件刚登录、引擎还没刷新目录时）。
	// 按 id 去重，别在模型选择器里出现两份 WorkBuddy。
	seen := make(map[string]bool, len(out))
	for _, m := range out {
		seen[strings.ToLower(m.ID)] = true
	}
	for _, m := range pluginAgentModels(PerchEngineDataDir()) {
		if seen[strings.ToLower(m.ID)] {
			continue
		}
		seen[strings.ToLower(m.ID)] = true
		out = append(out, m)
	}
	sortAgentModels(out)
	return out, nil
}

func pluginAgentModels(dir string) []AgentModel {
	if dir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "plugin-providers.json"))
	if err != nil {
		return nil
	}
	var rows []struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Icon     string `json:"icon"`
		SignedIn bool   `json:"signedIn"`
		AuthType string `json:"authType"`
		Models   []struct {
			ID      string   `json:"id"`
			Name    string   `json:"name"`
			Context int      `json:"context"`
			Efforts []string `json:"efforts"`
		} `json:"models"`
	}
	if json.Unmarshal(b, &rows) != nil {
		return nil
	}
	var out []AgentModel
	for _, p := range rows {
		if !p.SignedIn && p.AuthType == "" {
			continue
		}
		for _, m := range p.Models {
			id := m.ID
			if !strings.HasPrefix(id, p.ID+"/") {
				id = p.ID + "/" + id
			}
			name := m.Name
			if name == "" {
				name = m.ID
			}
			out = append(out, AgentModel{
				Provider: p.ID, ProviderName: p.Name, Icon: p.Icon,
				ID: id, Name: name, On: true, Efforts: m.Efforts, Context: m.Context,
			})
		}
	}
	return out
}

func sortAgentModels(out []AgentModel) {
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProviderName != out[j].ProviderName {
			return out[i].ProviderName < out[j].ProviderName
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
}

// seedProviderModels 只在 Perch 引擎的第一次 Agent 模型目录请求时跑：
// 从桌面 magpie 导入的 API-key 供应商可能有 key、有地址，但模型列表是空的
// （模型列表是缓存/点过刷新才有的）。不补这一下，Agent 里看得到 DeepSeek
// 却选不了任何模型。刷新失败只记日志，不挡 Agent 区；标记文件保证只试一次，
// 用户之后清空模型列表不会被自动塞回去。
func (g *Gateway) seedProviderModels(b []byte) []byte {
	dir := PerchEngineDataDir()
	if dir == "" {
		return b
	}
	marker := filepath.Join(dir, ".perch-models-seeded")
	if _, err := os.Stat(marker); err == nil {
		return b
	}
	var res struct {
		Providers []struct {
			ID     string            `json:"id"`
			Models []json.RawMessage `json:"models"`
		} `json:"providers"`
	}
	if json.Unmarshal(b, &res) != nil {
		return b
	}
	refreshed := 0
	for _, p := range res.Providers {
		if p.ID == "" || len(p.Models) > 0 {
			continue
		}
		if _, err := g.API("POST", "/api/provider/models", map[string]string{"id": p.ID}); err != nil {
			log.Printf("[gw] 供应商 %s 的模型列表刷新失败：%v", p.ID, err)
			continue
		}
		refreshed++
		log.Printf("[gw] 已刷新供应商 %s 的模型列表", p.ID)
	}
	if err := os.WriteFile(marker, []byte("seeded\n"), 0600); err != nil {
		log.Printf("[gw] 写模型列表标记失败：%v", err)
	}
	if refreshed == 0 {
		return b
	}
	if nb, err := g.API("GET", "/api/providers", nil); err == nil {
		return nb
	}
	return b
}

func parseAgentModels(b []byte) ([]AgentModel, error) {
	var res struct {
		Providers []struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Icon   string `json:"icon"`
			Models []struct {
				ID      string   `json:"id"`
				Name    string   `json:"name"`
				On      bool     `json:"on"`
				Efforts []string `json:"efforts"`
				Context int      `json:"context"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(b, &res); err != nil {
		return nil, uimsg.Wrap(err, "gw.modelsBad", "网关模型目录格式不对："+err.Error(),
			map[string]string{"err": err.Error()})
	}
	out := make([]AgentModel, 0)
	for _, p := range res.Providers {
		for _, m := range p.Models {
			id := m.ID
			if !strings.HasPrefix(id, p.ID+"/") {
				id = p.ID + "/" + id
			}
			name := m.Name
			if name == "" {
				name = m.ID
			}
			out = append(out, AgentModel{
				Provider: p.ID, ProviderName: p.Name, Icon: p.Icon,
				ID: id, Name: name, On: m.On, Efforts: m.Efforts, Context: m.Context,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProviderName != out[j].ProviderName {
			return out[i].ProviderName < out[j].ProviderName
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// ClaudeTierAlias 是一个档位自己的稳定组别名，例如
// group/perch-claude-opus。换这一档的模型只改这个组。
func ClaudeTierAlias(mainAlias, tier string) string {
	tier = strings.ToLower(strings.TrimSpace(tier))
	var b strings.Builder
	for _, r := range tier {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	t := strings.Trim(b.String(), "-")
	if t == "" {
		t = "tier"
	}
	return mainAlias + "-" + t
}

// ClaudeTierEnvKey 是 Claude Code 读取某个档位模型的环境变量。
// 不认识的档位返回 ""。
func ClaudeTierEnvKey(tier string) string {
	switch strings.ToLower(strings.TrimSpace(tier)) {
	case "opus":
		return "ANTHROPIC_DEFAULT_OPUS_MODEL"
	case "sonnet":
		return "ANTHROPIC_DEFAULT_SONNET_MODEL"
	case "haiku":
		return "ANTHROPIC_DEFAULT_HAIKU_MODEL"
	case "fable":
		return "ANTHROPIC_DEFAULT_FABLE_MODEL"
	}
	return ""
}

// ClaudeProfileEnv 是写进 --settings 的 env 块的一组覆盖值。默认所有
// 档位跟随主模型；配置了单独档位的在 main 里覆盖对应键。
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

// AgentEfforts 是网关组成员能固定的推理档位，和 magpie 的
// provider.MemberEfforts 一致（低 → 高）。
var AgentEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// agentGroupTarget 把模型和档位拼成 magpie 的组成员写法：model:high。
// 空档位就是模型本身；非法档位直接拒绝，别让 group set 静默失败。
func agentGroupTarget(model, effort string) (string, error) {
	model = strings.TrimSpace(model)
	effort = strings.ToLower(strings.TrimSpace(effort))
	if model == "" {
		return "", uimsg.New("gw.agentProfileBad", "agent 配置缺少模型别名或模型")
	}
	if effort == "" {
		return model, nil
	}
	for _, e := range AgentEfforts {
		if e == effort {
			return model + ":" + effort, nil
		}
	}
	return "", uimsg.NewParams("gw.agentProfileEffort",
		fmt.Sprintf("不支持的档位：%s", effort),
		map[string]string{"effort": effort})
}

// EnsureAgentGroup 在 Perch 引擎里建/改这个 agent 的稳定别名组。
// 组名 = alias 去掉 "group/"。模型必须是引擎目录里已有的 provider/model；
// 档位用组成员后缀固定（model:high），下一轮请求生效，不用重启。
func (g *Gateway) EnsureAgentGroup(alias, model, effort string) error {
	alias = strings.TrimSpace(alias)
	model = strings.TrimSpace(model)
	if !strings.HasPrefix(alias, "group/") {
		return uimsg.New("gw.agentProfileBad", "agent 配置缺少模型别名或模型")
	}
	target, err := agentGroupTarget(model, effort)
	if err != nil {
		return err
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
	// 先 set（已有组），失败再 add（不存在的组）。引擎刚起/刚写插件缓存时
	// 数据可能还在落盘，给一次短暂重试；真正的坏模型仍然会失败。
	var lastErr error
	var lastOut string
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := run("group", "set", name, "models="+target); err == nil {
			lastErr = nil
			break
		}
		if out, err := run("group", "add", name, "models="+target, "routing=order"); err == nil {
			lastErr = nil
			break
		} else {
			lastErr, lastOut = err, out
		}
		time.Sleep(250 * time.Millisecond)
	}
	if lastErr != nil {
		tail := strings.TrimSpace(lastOut)
		if len(tail) > 300 {
			tail = tail[len(tail)-300:]
		}
		log.Printf("[gw] agent group %s 设置失败：%v / %s", name, lastErr, tail)
		return uimsg.NewParams("gw.agentProfileFailed",
			fmt.Sprintf("网关路由组 %s 设置失败：%s", name, tail),
			map[string]string{"group": name, "err": tail})
	}
	log.Printf("[gw] agent %s 的模型别名 %s → %s", name, alias, target)
	return nil
}
