package gateway

// OpenCode 的 per-session 网关配置。
//
// OpenCode 会 merge OPENCODE_CONFIG 指向的 JSON 和它自己的配置。每格只写一份
// 很小的覆盖文件：加一个只指向 Perch 引擎的 perch provider，并把 model 设为
// perch/group/perch-opencode。不复制 ~/.config/opencode（几十 MB 的 node_modules
// 会让开格多等十几秒），真实配置、插件、历史都还在；data/state 也仍走用户自己的
// 目录。
//
// 模型名固定为 group/perch-opencode；换模型/档位只改网关里的这个组。

import (
	"fmt"
	"os"
	"path/filepath"
)

func OpenCodeProfileEnv(home, alias, model, effort string) (map[string]string, error) {
	if alias == "" {
		return nil, fmt.Errorf("OpenCode 缺少网关别名")
	}
	root, err := os.MkdirTemp("", "perch-opencode-*")
	if err != nil {
		return nil, fmt.Errorf("建 OpenCode 临时配置目录: %w", err)
	}
	cfg := map[string]any{
		"model": "perch/" + alias,
		"provider": map[string]any{
			"perch": map[string]any{
				"name": "Perch",
				"npm":  "@ai-sdk/openai-compatible",
				"options": map[string]any{
					"baseURL": IsolatedGatewayURL() + "/v1",
					"apiKey":  PerchLocalToken,
				},
				"models": map[string]any{
					alias: map[string]any{"name": "Perch"},
				},
			},
		},
	}
	p := filepath.Join(root, "opencode.json")
	if err := writeJSONFile(p, cfg); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	_ = home
	_ = model
	_ = effort
	return map[string]string{"OPENCODE_CONFIG": p}, nil
}
