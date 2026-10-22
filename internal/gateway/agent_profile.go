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
	out, err := parseAgentModels(b)
	if err != nil {
		return nil, err
	}
	// 插件供应商（WorkBuddy）不在 /api/providers 的 providers 数组里：
	// 它们的模型在插件缓存 plugin-providers.json 中。只收已登录的条目，
	// 否则会把一堆点不动的模型塞给用户。
	out = append(out, pluginAgentModels(PerchEngineDataDir())...)
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
			ID      string `json:"id"`
			Name    string `json:"name"`
			Context int    `json:"context"`
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
				ID: id, Name: name, On: true, Context: m.Context,
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
	// 先 set（已有组），失败再 add（不存在的组）。引擎刚起/刚写插件缓存时
	// 数据可能还在落盘，给一次短暂重试；真正的坏模型仍然会失败。
	var lastErr error
	var lastOut string
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := run("group", "set", name, "models="+model); err == nil {
			lastErr = nil
			break
		}
		if out, err := run("group", "add", name, "models="+model, "routing=order"); err == nil {
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
	log.Printf("[gw] agent %s 的模型别名 %s → %s", name, alias, model)
	return nil
}
