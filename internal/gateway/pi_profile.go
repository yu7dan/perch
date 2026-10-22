package gateway

// Pi 的 per-session 网关配置。
//
// Pi 不读 Claude 那样的 --settings，也没有能把 base URL 写在命令行的参数；
// 它从 PI_CODING_AGENT_DIR 指向的目录读 settings.json + models.json。Perch
// 因此给每一格复制一份 Pi 的 agent 目录（保留用户的 extensions/skills），
// 在 models.json 里加一个只指向 Perch 引擎的 provider，并让 settings 默认
// 使用它。真实 ~/.pi 目录只读，不会被写。
//
// 模型名固定为 group/perch-pi；换模型/档位只改网关里的这个组，下一轮生效。

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// PiProfileEnv 生成一份这一格专属的 Pi 配置目录，返回要注入的环境。
func PiProfileEnv(home, alias, model, effort string) (map[string]string, error) {
	if alias == "" {
		return nil, fmt.Errorf("Pi 缺少网关别名")
	}
	src := filepath.Join(home, ".pi", "agent")
	dir, err := os.MkdirTemp("", "perch-pi-*")
	if err != nil {
		return nil, fmt.Errorf("建 Pi 临时配置目录: %w", err)
	}
	if err := copyPiAgentDir(src, dir); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}

	// settings.json：保留用户其它设置，只把默认 provider/model 指向 Perch。
	settings := map[string]any{}
	if b, err := os.ReadFile(filepath.Join(dir, "settings.json")); err == nil {
		_ = json.Unmarshal(b, &settings)
	}
	settings["defaultProvider"] = "perch"
	settings["defaultModel"] = alias
	if err := writeJSONFile(filepath.Join(dir, "settings.json"), settings); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}

	// models.json：保留用户已有的 providers，新增/覆盖 perch。
	models := map[string]any{}
	if b, err := os.ReadFile(filepath.Join(dir, "models.json")); err == nil {
		_ = json.Unmarshal(b, &models)
	}
	providers, _ := models["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
	}
	providers["perch"] = map[string]any{
		"name":    "Perch",
		"api":     "openai-completions",
		"baseUrl": IsolatedGatewayURL() + "/v1",
		"apiKey":  PerchLocalToken,
		"compat":  map[string]any{"sendSessionAffinityHeaders": true},
		"models": []any{map[string]any{
			"id":            alias,
			"name":          "Perch",
			"contextWindow": 1_000_000,
			"maxTokens":     32_768,
			"input":         []string{"text"},
			"reasoning":     true,
		}},
	}
	models["providers"] = providers
	if err := writeJSONFile(filepath.Join(dir, "models.json"), models); err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	_ = model
	_ = effort
	return map[string]string{"PI_CODING_AGENT_DIR": dir}, nil
}

func copyPiAgentDir(src, dst string) error {
	fi, err := os.Stat(src)
	if err != nil || !fi.IsDir() {
		return nil // 没有真实 Pi 配置就从空目录开始
	}
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil || rel == "." || hasDotDot(rel) {
			return err
		}
		out := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(out, 0700)
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(filepath.Dir(out), 0700); err != nil {
			return err
		}
		w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, cerr := io.Copy(w, in)
		werr := w.Close()
		if cerr != nil {
			return cerr
		}
		return werr
	})
}

func hasDotDot(rel string) bool {
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return true
		}
	}
	return false
}

func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0600)
}
