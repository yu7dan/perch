// Package agenttrust 在起格前替用户预先信任 agent 要进的那个文件夹（设置 › 预先信任 agent 的工作文件夹）。
//
// 为什么要它（2026-10-29 Bot Group 实测）：Claude 2.x 在没信任过的文件夹首启时停在
// 「Quick safety check」，默认选中的是「No, exit」—— Perch 往里送的第一段文字带着回车，
// 格子当场退出。每个 Bot 的 git worktree 都是新文件夹，于是每个成员都要先点一次信任。
//
// 做法照搬 Orca（agent-trust-presets.ts / claude-folder-trust-file.ts / qoder/workspace-trust.ts）：
// 写进 agent 自己「点了信任之后」会写的那个位置，只追加这一个文件夹，其余键原样保留：
//
//	claude  <CLAUDE_CONFIG_DIR 或用户主目录>\.claude.json 的 projects["D:/x/y"].hasTrustDialogAccepted
//	        （有旧版 .config.json 就写它）；和 Claude 抢同一把锁：<文件>.lock 目录
//	qoder   ~\.qoder\settings.json 的 permissions.trustDirectories（文件不在就不建 —— 那是没登录过）
//	agy     ~\.gemini\antigravity-cli\settings.json 的 trustedWorkspaces（精确路径，不继承子目录）
//
// 护栏：用户主目录、盘符根、主目录的上级一律不写（Claude / Qoder 的信任会继承到子目录，
// 信任了主目录等于信任了整台机器）；文件读不动、不是 JSON、形状不对就不碰；锁被占着就放弃，
// 让 agent 自己问。所有失败都只是「这次没预写」，不会挡住起格。
package agenttrust

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Outcome 是一次预写的结果，只用来记日志。
type Outcome string

const (
	Granted     Outcome = "granted"     // 写进去了
	Unchanged   Outcome = "unchanged"   // 本来就信任了 / 这个 agent 不需要
	Missing     Outcome = "missing"     // 配置文件不在（没登录过之类），不替它建
	Unreadable  Outcome = "unreadable"  // 读不动或形状不对，不碰
	Locked      Outcome = "locked"      // agent 正拿着锁
	TooBroad    Outcome = "too-broad"   // 主目录 / 盘符根，不写
	Unsupported Outcome = "unsupported" // 这个 agent 没有文件夹信任这回事
)

// Supported 报告这个 agent 有没有可预写的文件夹信任。
func Supported(agent string) bool {
	switch agent {
	case "claude", "qoder", "agy":
		return true
	}
	return false
}

// Grant 预先信任 folder。env 是这一格的额外环境（会覆盖进程环境，比如 CLAUDE_CONFIG_DIR）。
func Grant(agent, folder string, env map[string]string) (Outcome, error) {
	if !Supported(agent) {
		return Unsupported, nil
	}
	getenv := func(k string) string {
		if v, ok := env[k]; ok {
			return v
		}
		return os.Getenv(k)
	}
	home := getenv("USERPROFILE")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	abs, err := filepath.Abs(folder)
	if err != nil || folder == "" {
		return Unreadable, fmt.Errorf("文件夹路径不对：%q", folder)
	}
	if tooBroad(abs, home) {
		return TooBroad, nil
	}
	switch agent {
	case "claude":
		return grantClaude(claudeConfigFile(getenv("CLAUDE_CONFIG_DIR"), getenv("CLAUDE_CODE_CUSTOM_OAUTH_URL"), home), forms(abs))
	case "qoder":
		return grantList(filepath.Join(home, ".qoder", "settings.json"), []string{"permissions", "trustDirectories"}, canonical(abs), false)
	case "agy":
		return grantList(filepath.Join(home, ".gemini", "antigravity-cli", "settings.json"), []string{"trustedWorkspaces"}, canonical(abs), true)
	}
	return Unsupported, nil
}

// tooBroad：主目录、它的上级、盘符根。
func tooBroad(abs, home string) bool {
	p := strings.ToLower(filepath.Clean(abs))
	if filepath.VolumeName(p)+`\` == p || p == filepath.VolumeName(p) {
		return true
	}
	if home == "" {
		return false
	}
	h := strings.ToLower(filepath.Clean(home))
	return p == h || strings.HasPrefix(h, strings.TrimRight(p, `\`)+`\`)
}

func canonical(abs string) string {
	if r, err := filepath.EvalSymlinks(abs); err == nil {
		return r
	}
	return abs
}

// forms：Claude 存的是解析后的路径，分隔符用 /。原样和解析掉链接的两种都写上。
func forms(abs string) []string {
	keys := []string{claudeKey(abs)}
	if r := canonical(abs); claudeKey(r) != keys[0] {
		keys = append(keys, claudeKey(r))
	}
	return keys
}

func claudeKey(p string) string { return strings.ReplaceAll(filepath.Clean(p), `\`, "/") }

// claudeConfigFile：Claude 先认 <配置目录>\.config.json（旧版），否则 <CLAUDE_CONFIG_DIR 或主目录>\.claude.json。
func claudeConfigFile(configDir, customOAuth, home string) string {
	legacyDir := configDir
	if legacyDir == "" {
		legacyDir = filepath.Join(home, ".claude")
	}
	if legacy := filepath.Join(legacyDir, ".config.json"); fileExists(legacy) {
		return legacy
	}
	name := ".claude.json"
	if customOAuth != "" {
		name = ".claude-custom-oauth.json"
	}
	if configDir != "" {
		return filepath.Join(configDir, name)
	}
	return filepath.Join(home, name)
}

func grantClaude(file string, keys []string) (Outcome, error) {
	return update(file, true, func(cfg map[string]any) (bool, bool) {
		projects := map[string]any{}
		if v, ok := cfg["projects"]; ok {
			m, ok := v.(map[string]any)
			if !ok {
				return false, false
			}
			projects = m
		}
		for _, k := range keys {
			if e, ok := projects[k].(map[string]any); ok && e["hasTrustDialogAccepted"] == true {
				return false, true
			}
		}
		for _, k := range keys {
			if e, ok := projects[k].(map[string]any); ok {
				e["hasTrustDialogAccepted"] = true
			} else {
				projects[k] = map[string]any{"hasTrustDialogAccepted": true}
			}
		}
		cfg["projects"] = projects
		return true, true
	})
}

// grantList 往 JSON 里某个字符串数组追加一项。createFile = 文件不在时要不要建（agy 建，Qoder 不建）。
func grantList(file string, path []string, value string, createFile bool) (Outcome, error) {
	if !fileExists(file) {
		if !createFile {
			return Missing, nil
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return Unreadable, err
		}
		if err := os.WriteFile(file, []byte("{}\n"), 0o644); err != nil {
			return Unreadable, err
		}
	}
	return update(file, false, func(cfg map[string]any) (bool, bool) {
		parent := cfg
		for _, k := range path[:len(path)-1] {
			v, ok := parent[k]
			if !ok {
				m := map[string]any{}
				parent[k] = m
				parent = m
				continue
			}
			m, ok := v.(map[string]any)
			if !ok {
				return false, false
			}
			parent = m
		}
		last := path[len(path)-1]
		var list []any
		if v, ok := parent[last]; ok {
			l, ok := v.([]any)
			if !ok {
				return false, false
			}
			list = l
		}
		for _, x := range list {
			if s, ok := x.(string); ok && strings.EqualFold(filepath.Clean(s), filepath.Clean(value)) {
				return false, true
			}
		}
		parent[last] = append(list, value)
		return true, true
	})
}

// update：读 → 改 → 原子写。change 返回 (changed, ok)；ok=false 表示形状不对，不碰。
// withLock = 和 Claude 抢同一把锁（proper-lockfile：<文件>.lock 是个目录，mkdir 成功就是拿到了）。
func update(file string, withLock bool, change func(map[string]any) (bool, bool)) (Outcome, error) {
	probe, out, err := read(file)
	if out != "" {
		return out, err
	}
	if changed, ok := change(probe); !ok {
		return Unreadable, nil
	} else if !changed {
		return Unchanged, nil
	}
	if withLock {
		lock := file + ".lock"
		got := false
		for i, wait := 0, 50*time.Millisecond; i < 5; i, wait = i+1, wait*2 {
			if err := os.Mkdir(lock, 0o755); err == nil {
				got = true
				break
			}
			if wait > 250*time.Millisecond {
				wait = 250 * time.Millisecond
			}
			time.Sleep(wait)
		}
		if !got {
			return Locked, nil
		}
		defer os.Remove(lock)
	}
	// 锁里再读一遍：probe 之后 agent 可能刚写过
	cur, out, err := read(file)
	if out != "" {
		return out, err
	}
	changed, ok := change(cur)
	if !ok {
		return Unreadable, nil
	}
	if !changed {
		return Unchanged, nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cur); err != nil {
		return Unreadable, err
	}
	st, err := os.Stat(file)
	if err != nil {
		return Unreadable, err
	}
	tmp := fmt.Sprintf("%s.perch-trust-%d.tmp", file, time.Now().UnixNano())
	if err := os.WriteFile(tmp, buf.Bytes(), st.Mode().Perm()); err != nil {
		return Unreadable, err
	}
	var rerr error
	for i := 0; i < 5; i++ {
		if rerr = os.Rename(tmp, file); rerr == nil {
			return Granted, nil
		}
		time.Sleep(time.Duration(40*(i+1)) * time.Millisecond) // Windows：别的进程正开着它
	}
	_ = os.Remove(tmp)
	return Unreadable, rerr
}

func read(file string) (map[string]any, Outcome, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, Missing, nil
		}
		return nil, Unreadable, err
	}
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber() // 大整数（时间戳、计数）原样写回，不变成浮点
	var cfg map[string]any
	if err := dec.Decode(&cfg); err != nil || cfg == nil {
		return nil, Unreadable, nil
	}
	return cfg, "", nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}
