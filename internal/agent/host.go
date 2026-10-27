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
	// HookSettings 造一份 Claude 形状的 hooks 配置（含本格的事件文件路径）。
	// Qoder 用 --settings 接这份配置；它和 Claude 一样是**合并**，不碰用户文件。
	HookSettings(tag string) string
	// NoteActivity 记下这一格真的有对话。OpenCode/Pi 这类没有 Claude 形状
	// hooks 的 agent，关格时后端只能靠它区分“空开合”和“说过话的已关闭”。
	NoteActivity(tabID int, spoke bool)
	// ResumeSessionOf 返回这一格**启动时请求接上的**会话 id（exact/fork）。
	// OpenCode 冷恢复时 TUI 回到那条会话但 active 可能还是空的；流水得先按
	// 这个 id 去读历史，不能等用户再发一条提示才长出来。
	ResumeSessionOf(tabID int) string
}

var host Host = defaultHost{}

// SetHost 由组合根（cmd/perch）在构造会话表之后调用 —— 这是整个程序里
// **唯一**保留的组合期注入点。测试不调用时用 defaultHost：会话/状态写入是
// 无操作，但可执行文件仍能按 PATH 解析。
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
func (defaultHost) HookSettings(string) string           { return "" }
func (defaultHost) NoteActivity(int, bool)               {}
func (defaultHost) ResumeSessionOf(int) string           { return "" }

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
