// Package dsh 是 DeepSeek Harness 的终端接入层。
//
// dsh 是“官方没有独立 TUI”的那一类：官方的 @deepseek-ai/dsh 只有 web /
// headless / sdk 等 profile，交互式终端由社区的 @deepseek-harness-tui/dsh-tui
// 以 dsh profile 的形式提供。Orca 对这一类的处理是：
//
//   - 启动 dsh-tui（它总是 boot dsh --profile dsh-tui）；
//   - 通过官方桥 @deepseek-ai/dsh-hooks-claude-code 把 Claude 形状的 hook
//     事件接出来，状态/等待由 hook 提供，终端标题只负责识别 agent。
//
// 本包只做“Perch 这边的那一半”：把 hooks 配置写进 $DSH_HOME/cordis.patch.yml
// 的托管块、生成 hook 事件配置、把桥和它的 peer 装进 dsh-tui profile。
// 启动参数与终端标题在 internal/agent 与前端各自处理。
package dsh

import (
	"errors"
	"strings"
)

// 托管块标记。和 Orca 一样只动自己的区域：块外的一个字节都不改。
const (
	ManagedStartMarker = "# >>> perch-managed-dsh-hooks (managed by Perch; do not edit) >>>"
	ManagedEndMarker   = "# <<< perch-managed-dsh-hooks <<<"
	ManagedRowID       = "perch-agent-hooks"
)

// ErrUnappendablePatch：文件是非空 flow-style 序列（[a, b]）。YAML 不允许在
// flow 序列后面再追加 block 条目；强行写会把用户自己的 patch 层也变成无法解析
// 的文件，所以这里拒绝，而不是“尽量试试”。
var ErrUnappendablePatch = errors.New("DSH 的 cordis.patch.yml 是非空 flow-style 序列（[...]）；请先改成 block 序列（每行一个 `- ` 条目），Perch 才能安全追加状态钩子")

type patchRegion struct{ start, end int }

func splitPatchLines(text string) []string { return strings.Split(text, "\n") }

// normalizeNewlines 让托管块的判断不受 CRLF 影响，同时记住原文件的换行风格。
func normalizeNewlines(text string) (body, newline string) {
	if strings.Contains(text, "\r\n") {
		return strings.ReplaceAll(text, "\r\n", "\n"), "\r\n"
	}
	return text, "\n"
}

func restoreNewlines(text, newline string) string {
	if newline == "\n" {
		return text
	}
	return strings.ReplaceAll(text, "\n", newline)
}

// findManagedRegion 找最近一个 START 与它后面的 END。
//
// 为什么不取第一个 START：中断的写入可能留下一个没有 END 的孤儿 START。
// 拿它和后面另一块的 END 配对，会把中间所有用户行一起吞掉。向前走、每次
// START 重置候选，孤儿就永远不会被配对，只剩一行无作用的注释。
func findManagedRegion(text string) (patchRegion, bool) {
	start := -1
	for i, line := range splitPatchLines(text) {
		t := strings.TrimSpace(line)
		if t == ManagedStartMarker {
			start = i
		} else if t == ManagedEndMarker && start != -1 {
			return patchRegion{start: start, end: i}, true
		}
	}
	return patchRegion{}, false
}

func yamlQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func unquoteYAML(value string) string {
	t := strings.TrimSpace(value)
	if len(t) >= 2 && t[0] == '\'' && t[len(t)-1] == '\'' {
		return strings.ReplaceAll(t[1:len(t)-1], "''", "'")
	}
	if len(t) >= 2 && t[0] == '"' && t[len(t)-1] == '"' {
		return t[1 : len(t)-1]
	}
	return t
}

func buildManagedBlock(hooksPath string) []string {
	return []string{
		ManagedStartMarker,
		"- insert:",
		"    - id: " + ManagedRowID,
		"      name: '@deepseek-ai/dsh-hooks-claude-code'",
		"      config:",
		"        configPath: " + yamlQuote(hooksPath),
		ManagedEndMarker,
	}
}

// ReadManagedHooksPath 返回托管块当前指向的 configPath。
//
// found=false 表示文件里没有 Perch 的块；found=true 而 path="" 表示块在、
// 但里面没有 configPath（被手改坏了）。
func ReadManagedHooksPath(text string) (path string, found bool) {
	region, ok := findManagedRegion(text)
	if !ok {
		return "", false
	}
	lines := splitPatchLines(text)
	for _, line := range lines[region.start+1 : region.end] {
		m := strings.TrimSpace(line)
		if strings.HasPrefix(m, "configPath:") {
			return unquoteYAML(strings.TrimSpace(strings.TrimPrefix(m, "configPath:"))), true
		}
	}
	return "", true
}

func isBlank(line string) bool   { return strings.TrimSpace(line) == "" }
func isComment(line string) bool { return strings.HasPrefix(strings.TrimSpace(line), "#") }

func documentBody(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if !isBlank(line) && !isComment(line) {
			out = append(out, line)
		}
	}
	return out
}

func withoutTrailingComment(line string) string {
	if i := strings.IndexByte(line, '#'); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
}

func isEmptyFlowDocument(lines []string) bool {
	body := documentBody(lines)
	return len(body) == 1 && withoutTrailingComment(body[0]) == "[]"
}

// isUnappendable 只拒绝**非空** flow 序列。空序列 `[]`（带不带行尾注释）是可
// 以安全去掉再追加的，DSH 新建的 patch 文件默认就是它。
func isUnappendable(text string) bool {
	body := documentBody(splitPatchLines(text))
	return len(body) > 0 && strings.HasPrefix(strings.TrimSpace(body[0]), "[") && !isEmptyFlowDocument(splitPatchLines(text))
}

func withoutTrailingBlanks(lines []string) []string {
	end := len(lines) - 1
	for end >= 0 && isBlank(lines[end]) {
		end--
	}
	return lines[:end+1]
}

func joinPreservingTrailingNewline(lines []string) string {
	text := strings.Join(lines, "\n")
	if text == "" || strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}

// ApplyManagedPatch 在文件末尾写入/替换 Perch 的托管块。块外的内容原样保留。
func ApplyManagedPatch(text, hooksPath string) (string, error) {
	norm, newline := normalizeNewlines(text)
	lines := splitPatchLines(norm)
	block := buildManagedBlock(hooksPath)

	if region, ok := findManagedRegion(norm); ok {
		out := make([]string, 0, len(lines)+len(block))
		out = append(out, lines[:region.start]...)
		out = append(out, block...)
		out = append(out, lines[region.end+1:]...)
		return restoreNewlines(joinPreservingTrailingNewline(out), newline), nil
	}
	if isUnappendable(norm) {
		return "", ErrUnappendablePatch
	}

	kept := make([]string, len(lines))
	copy(kept, lines)
	if isEmptyFlowDocument(kept) {
		// `[]` 后面直接跟 `- ` 是解析错误。只去掉这个 token，行尾注释留着。
		for i, line := range kept {
			if withoutTrailingComment(line) == "[]" {
				kept[i] = line[strings.Index(line, "[]")+2:]
			}
		}
	}
	kept = withoutTrailingBlanks(kept)
	out := make([]string, 0, len(kept)+len(block))
	out = append(out, kept...)
	out = append(out, block...)
	return restoreNewlines(joinPreservingTrailingNewline(out), newline), nil
}

// RemoveManagedPatch 删掉 Perch 的托管块；如果删完只剩注释/空行，就补回 `[]`，
// 否则 DSH 拿到的是一份“只有注释、没有条目”的无效 patch 文件。
func RemoveManagedPatch(text string) (string, bool) {
	norm, newline := normalizeNewlines(text)
	region, ok := findManagedRegion(norm)
	if !ok {
		return text, false
	}
	lines := splitPatchLines(norm)
	kept := make([]string, 0, len(lines))
	kept = append(kept, lines[:region.start]...)
	kept = append(kept, lines[region.end+1:]...)
	kept = withoutTrailingBlanks(kept)

	onlyComments := true
	for _, line := range kept {
		if !isBlank(line) && !isComment(line) {
			onlyComments = false
			break
		}
	}
	if onlyComments {
		kept = append(kept, "[]")
	}
	return restoreNewlines(joinPreservingTrailingNewline(kept), newline), true
}
