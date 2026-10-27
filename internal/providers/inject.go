package providers

// 把一个 agent 的配置变成「这一个进程」的启动参数。
//
// 规矩（和原来网关那一版一样）：
//   - 只动 Perch 起的这一格；不写 ~/.claude、~/.codex、~/.pi、opencode 的全局配置；
//   - 用户选了提供商、但这个 agent 接不上它（协议不对 / 缺模型）就**报错不启动**，
//     不能静默回退到 agent 自己的登录 —— 那样用户看到的是一串 401，而不是原因。
//   - key 尽量不落文件：Codex 走 env_key，Pi 用 "$VAR" 插值，OpenCode 用
//     "{env:VAR}"；只有 Claude 的 --settings 文件里会写 key（Claude 自己的
//     settings.json env 会盖过进程环境，只有 --settings 压得住它，见 spawn.go）。

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// KeyEnv 是注入给 agent 进程的那个 key 变量名（Codex / Pi / OpenCode 从它读）。
const KeyEnv = "PERCH_PROVIDER_KEY"

// Protocols 返回这个 agent 能吃的协议；空 = Perch 不替它接提供商（只能写环境变量）。
func Protocols(agentID string) []string {
	switch agentID {
	case "claude":
		return []string{"anthropic"}
	case "codex":
		return []string{"openai"}
	case "pi", "opencode":
		return []string{"openai", "anthropic"}
	}
	return nil
}

// Launch 是注入结果：环境变量（Claude 的会被并进 --settings）和额外参数。
type Launch struct {
	Env  map[string]string
	Args []string
}

// Build 按 agent 生成注入。home 是用户主目录（Pi 要复制它的配置目录）。
func Build(agentID string, r Resolved, home string) (Launch, error) {
	out := Launch{Env: map[string]string{}}
	for k, v := range r.Env {
		out.Env[k] = v
	}
	p := r.Provider
	if p == nil {
		// 没选提供商：只有原始环境变量（和 Claude / Codex 的推理强度）。
		applyEffort(agentID, r.Effort, &out)
		return out, nil
	}
	switch agentID {
	case "claude":
		if p.Anthropic == "" {
			return out, fmt.Errorf("提供商「%s」没有 Anthropic 接口，Claude Code 接不上它", p.Name)
		}
		out.Env["ANTHROPIC_BASE_URL"] = p.Anthropic
		out.Env["ANTHROPIC_AUTH_TOKEN"] = r.Key
		// 用户自己的 settings.json 可能还留着别的 key / 档位映射（比如以前接网关时写的
		// deepseek/... 别名）。--settings 的 env 优先级更高，置空就把它们压掉，
		// 档位回到 Claude Code 的默认模型名。
		out.Env["ANTHROPIC_API_KEY"] = ""
		for _, k := range []string{"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
			"ANTHROPIC_MODEL", "CLAUDE_CODE_MODEL_CAPABILITIES"} {
			if _, set := r.Env[k]; !set {
				out.Env[k] = ""
			}
		}
		if r.Model != "" {
			out.Env["ANTHROPIC_MODEL"] = r.Model
		}
	case "codex":
		if p.OpenAI == "" {
			return out, fmt.Errorf("提供商「%s」没有 OpenAI 兼容接口，Codex 接不上它", p.Name)
		}
		out.Env[KeyEnv] = r.Key
		out.Args = append(out.Args,
			"-c", `model_provider="perch"`,
			"-c", "model_providers.perch.name="+tomlString("Perch · "+p.Name),
			"-c", "model_providers.perch.base_url="+tomlString(p.OpenAI),
			"-c", `model_providers.perch.wire_api="responses"`,
			"-c", `model_providers.perch.env_key="`+KeyEnv+`"`,
		)
		if r.Model != "" {
			out.Args = append(out.Args, "-c", "model="+tomlString(r.Model))
		}
	case "pi":
		if r.Model == "" {
			return out, fmt.Errorf("Pi 要指定一个模型才能接提供商「%s」", p.Name)
		}
		env, err := piProfile(home, p, r.Model)
		if err != nil {
			return out, err
		}
		for k, v := range env {
			out.Env[k] = v
		}
		out.Env[KeyEnv] = r.Key
	case "opencode":
		if r.Model == "" {
			return out, fmt.Errorf("OpenCode 要指定一个模型才能接提供商「%s」", p.Name)
		}
		env, err := openCodeProfile(p, r.Model)
		if err != nil {
			return out, err
		}
		for k, v := range env {
			out.Env[k] = v
		}
		out.Env[KeyEnv] = r.Key
	default:
		return out, fmt.Errorf("Perch 还不能替 %s 接提供商；请改用环境变量", agentID)
	}
	applyEffort(agentID, r.Effort, &out)
	return out, nil
}

func applyEffort(agentID, effort string, out *Launch) {
	if effort == "" {
		return
	}
	switch agentID {
	case "claude":
		// max 只有 env 给得了（见 claude-code-effort-level-semantics）。
		out.Env["CLAUDE_CODE_EFFORT_LEVEL"] = effort
	case "codex":
		e := effort
		if e == "max" {
			e = "xhigh"
		}
		out.Args = append(out.Args, "-c", "model_reasoning_effort="+tomlString(e))
	}
}

// tomlString 把一个值写成 TOML 基本字符串（Codex 的 -c 按 TOML 解析右值）。
func tomlString(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "\t", `\t`)
	return `"` + r.Replace(v) + `"`
}

// piProfile 给这一格复制一份 Pi 的 agent 目录（保留用户的扩展 / 技能），在
// models.json 里加一个 perch provider，并让 settings 默认用它。真实 ~/.pi 只读。
// key 写成 "$PERCH_PROVIDER_KEY"（Pi 的 models.json 支持环境变量插值），不落盘。
func piProfile(home string, p *Provider, model string) (map[string]string, error) {
	if home == "" {
		return nil, fmt.Errorf("无法确定用户主目录")
	}
	dir, err := os.MkdirTemp("", "perch-pi-*")
	if err != nil {
		return nil, fmt.Errorf("建 Pi 临时配置目录: %w", err)
	}
	if err := copyDir(filepath.Join(home, ".pi", "agent"), dir); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	settings := map[string]any{}
	if b, err := os.ReadFile(filepath.Join(dir, "settings.json")); err == nil {
		_ = json.Unmarshal(b, &settings)
	}
	settings["defaultProvider"] = "perch"
	settings["defaultModel"] = model
	if err := writeJSON(filepath.Join(dir, "settings.json"), settings); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	api, base := "openai-completions", p.OpenAI
	if base == "" {
		api, base = "anthropic-messages", p.Anthropic
	}
	models := map[string]any{}
	if b, err := os.ReadFile(filepath.Join(dir, "models.json")); err == nil {
		_ = json.Unmarshal(b, &models)
	}
	provs, _ := models["providers"].(map[string]any)
	if provs == nil {
		provs = map[string]any{}
	}
	provs["perch"] = map[string]any{
		"name":    "Perch · " + p.Name,
		"api":     api,
		"baseUrl": base,
		"apiKey":  "$" + KeyEnv,
		"models": []any{map[string]any{
			"id":        model,
			"name":      model,
			"input":     []string{"text"},
			"reasoning": true,
		}},
	}
	models["providers"] = provs
	if err := writeJSON(filepath.Join(dir, "models.json"), models); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	return map[string]string{"PI_CODING_AGENT_DIR": dir}, nil
}

// openCodeProfile 写一份很小的覆盖文件（OPENCODE_CONFIG 会和用户自己的配置合并）：
// 加一个 perch provider，把 model 设成 perch/<model>。不复制 ~/.config/opencode
// （几十 MB 的 node_modules 会让开格多等十几秒）。key 用 "{env:VAR}" 引用。
func openCodeProfile(p *Provider, model string) (map[string]string, error) {
	root, err := os.MkdirTemp("", "perch-opencode-*")
	if err != nil {
		return nil, fmt.Errorf("建 OpenCode 临时配置目录: %w", err)
	}
	npm, base := "@ai-sdk/openai-compatible", p.OpenAI
	if base == "" {
		// @ai-sdk/anthropic 的 baseURL 默认就是 https://api.anthropic.com/v1。
		npm, base = "@ai-sdk/anthropic", p.Anthropic+"/v1"
	}
	cfg := map[string]any{
		"model": "perch/" + model,
		"provider": map[string]any{
			"perch": map[string]any{
				"name": "Perch · " + p.Name,
				"npm":  npm,
				"options": map[string]any{
					"baseURL": base,
					"apiKey":  "{env:" + KeyEnv + "}",
				},
				"models": map[string]any{model: map[string]any{"name": model}},
			},
		},
	}
	path := filepath.Join(root, "opencode.json")
	if err := writeJSON(path, cfg); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	return map[string]string{"OPENCODE_CONFIG": path}, nil
}

func copyDir(src, dst string) error {
	fi, err := os.Stat(src)
	if err != nil || !fi.IsDir() {
		return nil // 没有真实配置就从空目录开始
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil || rel == "." || strings.Contains(filepath.ToSlash(rel), "../") || rel == ".." {
			return err
		}
		out := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(out, 0o700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, cerr := io.Copy(w, in)
		if werr := w.Close(); cerr == nil {
			cerr = werr
		}
		return cerr
	})
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}
