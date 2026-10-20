package dsh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	ProfileName = "dsh-tui"
	// TUIPackage 是 Orca 也用的那个社区终端界面包。它不是一个独立 CLI：
	// `dsh-tui` 启动器会 boot `dsh --profile dsh-tui`，TUI 本体是 profile 里
	// 的一个 bundle。官方 @deepseek-ai/dsh 目前没有交互式 TUI profile。
	TUIPackage = "@deepseek-harness-tui/dsh-tui"
	// HookBridge 是官方提供的 Claude Code hook 兼容桥。它把 Claude 形状的
	// SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop 事件
	// 接进 DSH；Orca 对 dsh 的状态就是用这一座桥。
	HookBridge = "@deepseek-ai/dsh-hooks-claude-code"
	// HookProtocol 是桥的 peer；pnpm 的 autoInstallPeers=false 不会自动装它，
	// 漏了它的症状是 DSH 启动时打印 "failed to import" 并且一条 hook 都不跑。
	HookProtocol = "@deepseek-ai/dsh-hook-protocol"

	HooksFileName = "dsh-hooks.json"
)

// Home 是 DSH 自己的 home：DSH_HOME 优先，否则 ~/.dsh（和 launcher 一致）。
func Home() string {
	if v := strings.TrimSpace(os.Getenv("DSH_HOME")); v != "" {
		return v
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".dsh")
	}
	return ".dsh"
}

func ProfileDir() string { return filepath.Join(Home(), "profiles", ProfileName) }

func ProfilePackagePath() string { return filepath.Join(ProfileDir(), "package.json") }

func HomePatchPath() string { return filepath.Join(Home(), "cordis.patch.yml") }

// HooksPath 是 Perch 自己的 hooks 配置文件。它不在 DSH home 里：DSH 只通过
// 托管块里的 configPath 读它，把 Perch 的生成物和用户的 DSH 配置分开。
func HooksPath(stateDir string) string { return filepath.Join(stateDir, HooksFileName) }

type profilePackage struct {
	Dependencies map[string]string `json:"dependencies"`
	DSH          struct {
		Profile struct {
			Bundles []string `json:"bundles"`
		} `json:"profile"`
	} `json:"dsh"`
}

func readProfile() (*profilePackage, error) {
	b, err := os.ReadFile(ProfilePackagePath())
	if err != nil {
		return nil, err
	}
	var p profilePackage
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// ProfileReady 判断 dsh-tui profile 是否已经初始化并装了终端界面。
// 只看文件，不调 dsh：Cards 每 2.5 秒都会问一次，不能在这里跑子进程。
func ProfileReady() bool {
	p, err := readProfile()
	if err != nil {
		return false
	}
	if _, ok := p.Dependencies[TUIPackage]; ok {
		return true
	}
	for _, b := range p.DSH.Profile.Bundles {
		if b == TUIPackage {
			return true
		}
	}
	return false
}

type bridgePackage struct {
	PeerDependencies map[string]string `json:"peerDependencies"`
}

func bridgePackagePath() string {
	return filepath.Join(ProfileDir(), "node_modules", "@deepseek-ai", "dsh-hooks-claude-code", "package.json")
}

func readBridgePackage() (*bridgePackage, error) {
	b, err := os.ReadFile(bridgePackagePath())
	if err != nil {
		return nil, err
	}
	var p bridgePackage
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// HooksReady 是“状态这条腿现在能不能用”的快速判据：
//  1. profile 里有终端界面，也有 hook 桥；
//  2. 桥的每个 peer 都在 profile 的 dependencies 里（pnpm autoInstallPeers=false）；
//  3. home patch 里有 Perch 的托管块，且块指向的 hooks 文件存在、5 个事件齐全。
//
// 它不检查 dsh 可执行文件；启动能力由 Cards 的另一条腿判断。
func HooksReady() bool {
	profile, err := readProfile()
	if err != nil {
		return false
	}
	if _, ok := profile.Dependencies[HookBridge]; !ok {
		return false
	}
	bridge, err := readBridgePackage()
	if err != nil {
		return false
	}
	for name := range bridge.PeerDependencies {
		if _, ok := profile.Dependencies[name]; !ok {
			return false
		}
	}
	patch, err := os.ReadFile(HomePatchPath())
	if err != nil {
		return false
	}
	hooksPath, found := ReadManagedHooksPath(string(patch))
	if !found || hooksPath == "" {
		return false
	}
	b, err := os.ReadFile(hooksPath)
	if err != nil {
		return false
	}
	return hooksJSONComplete(b)
}
