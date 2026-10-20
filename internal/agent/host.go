package agent

import (
	"os/exec"
	"path/filepath"
	"strings"
)

// Host 是适配器需要从宿主（Perch 主程序）拿到的最小表面。
//
// 适配器不直接碰标签表、不直接推前端消息：这样它们能在测试里单独跑，
// 也让 agent 集合和窗口/会话管理的边界保持清楚。
type Host interface {
	BindSession(tabID int, sid, name, agent string) bool
	RebindSession(tabID int, sid, name, agent string) bool
	SetStatus(tabID int, status string) (prev string, changed bool)
	Push(v any)
	// ResolveExe 找 agent 的可执行文件，并处理 Windows 的 .cmd/.bat shim。
	ResolveExe(bin string) (string, []string)
}

var host Host = defaultHost{}

// SetHost 由主程序在 init 里调用。测试不调用时用 defaultHost：会话/状态
// 写入是无操作，但可执行文件仍能按 PATH 解析。
func SetHost(h Host) {
	if h != nil {
		host = h
	}
}

type defaultHost struct{}

func (defaultHost) BindSession(int, string, string, string) bool { return false }
func (defaultHost) RebindSession(int, string, string, string) bool {
	return false
}
func (defaultHost) SetStatus(int, string) (string, bool) { return "", false }
func (defaultHost) Push(any)                             {}

func (defaultHost) ResolveExe(bin string) (string, []string) {
	bin = strings.TrimSpace(bin)
	if bin == "" {
		return "", nil
	}
	p, err := exec.LookPath(bin)
	if err != nil {
		return bin, nil
	}
	switch strings.ToLower(filepath.Ext(p)) {
	case ".cmd", ".bat":
		return "cmd.exe", []string{"/c", p}
	}
	return p, nil
}
