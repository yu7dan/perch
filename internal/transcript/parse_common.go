package transcript

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// newID 给没有自带 id 的条目发一个进程内唯一 id。
// 前缀和 Claude 的 "s" / tool_use_id 不会撞；同一份转录重放两次得到同一批 id。
func (tr *trace) newID(prefix string) string {
	tr.seq++
	return prefix + strconv.Itoa(tr.seq)
}

// nowAt 给没有时间戳的转录（Cursor 实测没有）补一个本地时间，
// 否则右栏那一列会一直是空的。它只影响展示，不参与任何判据。
func nowAt() string { return time.Now().Format(time.RFC3339) }

// decodeAnyInput 接受两种参数形状：
//   - 已经是对象（Claude/DSH/Pi 的 arguments 数组）
//   - 是一段 JSON **字符串**（Codex 的 function_call.arguments 实测是字符串）
func decodeAnyInput(raw json.RawMessage) toolInput {
	if len(raw) == 0 || string(raw) == "null" {
		return toolInput{}
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return decodeInput(json.RawMessage(strings.TrimSpace(s)))
	}
	return decodeInput(raw)
}

// firstStr 按顺序返回第一个非空字符串字段。
func (t toolInput) firstStr(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(t.str(k)); v != "" {
			return v
		}
	}
	return ""
}

// pathOf 从各家工具参数里找“它在动哪个文件”。键名全部来自实测的转录。
// commandOf 处理 command 既可能是字符串、也可能是 argv 数组（Codex 的
// shell/exec 实测两种都有）。
func (t toolInput) commandOf(keys ...string) string {
	for _, k := range keys {
		raw, ok := t[k]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) == nil && strings.TrimSpace(s) != "" {
			return s
		}
		var arr []string
		if json.Unmarshal(raw, &arr) == nil && len(arr) > 0 {
			return strings.Join(arr, " ")
		}
	}
	return ""
}

func (t toolInput) pathOf() string {
	return t.firstStr(
		"file_path", "filePath", "path", "Path", "notebook_path", "target_file",
		"TargetFile", "filename", "fileName", "file", "absolute_path", "uri",
	)
}

func cleanQuoted(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return strings.TrimSpace(s[1 : len(s)-1])
	}
	return s
}

// fileOpGeneric 是 fileOp 的“多 agent 版”：名字大小写不敏感，覆盖实测到的
// 各家工具名。认不出就是非文件工具 —— 不猜。
func fileOpGeneric(tool string) (string, bool) {
	n := strings.ToLower(strings.TrimSpace(tool))
	n = strings.NewReplacer("_", "", "-", "", " ", "").Replace(n)
	switch n {
	case "read", "readfile", "readfiletool", "view", "viewfile", "openfile", "cat":
		return "read", true
	case "write", "writefile", "createfile", "create", "savefile", "writefiletool":
		return "write", true
	case "edit", "editfile", "strreplaceeditor", "replaceinfile", "multiedit",
		"notebookedit", "applypatch", "patch", "updatefile", "deletefile":
		return "edit", true
	}
	return "", false
}

func toolBase(path string) string {
	if path == "" {
		return ""
	}
	return filepath.Base(path)
}

// describeAnyTool 给一条工具调用写一句“它在干什么”，并返回主动作路径。
// 返回的 paths 是**所有**被它碰到的文件（apply_patch 一次可以改多个）。
func describeAnyTool(tool string, in toolInput) (text, path string, paths []string) {
	name := strings.TrimSpace(tool)
	low := strings.ToLower(name)
	compact := strings.NewReplacer("_", "", "-", "", " ", "").Replace(low)
	inPath := in.pathOf()

	switch {
	case strings.Contains(compact, "applypatch"), compact == "patch", strings.Contains(compact, "updatefile"):
		patch := in.firstStr("input", "patch", "diff", "content", "command")
		paths = patchFilePaths(patch)
		if len(paths) > 0 {
			if len(paths) == 1 {
				return name + " " + toolBase(paths[0]), paths[0], paths
			}
			return name + " " + strconv.Itoa(len(paths)) + " 个文件", paths[0], paths
		}
		return name, "", nil
	case strings.Contains(compact, "runcommand"), compact == "shell", compact == "bash",
		compact == "powershell", compact == "terminal", compact == "execute", compact == "command":
		c := cleanQuoted(in.commandOf("command", "CommandLine", "cmd", "script", "code"))
		if i := strings.IndexByte(c, '\n'); i >= 0 {
			c = c[:i]
		}
		if c != "" {
			return clip(c, 120), "", nil
		}
		if d := cleanQuoted(in.str("description")); d != "" {
			return d, "", nil
		}
		if d := cleanQuoted(in.str("toolSummary")); d != "" {
			return d, "", nil
		}
		return name, "", nil
	case strings.Contains(compact, "readfile") || compact == "read" || compact == "view":
		if inPath != "" {
			return name + " " + toolBase(inPath), inPath, []string{inPath}
		}
		return name, "", nil
	case strings.Contains(compact, "writefile") || compact == "write" || compact == "createfile":
		if inPath != "" {
			return name + " " + toolBase(inPath), inPath, []string{inPath}
		}
		return name, "", nil
	case strings.Contains(compact, "editfile") || compact == "edit" || compact == "strreplaceeditor":
		if inPath != "" {
			return name + " " + toolBase(inPath), inPath, []string{inPath}
		}
		return name, "", nil
	case compact == "grep" || compact == "grepsearch" || compact == "search" || compact == "find":
		if p := in.firstStr("pattern", "query"); p != "" {
			return name + " " + clip(p, 80), "", nil
		}
		return name, "", nil
	case compact == "glob" || compact == "listdir" || compact == "listdirectory" || compact == "findfiles":
		if p := in.firstStr("pattern", "query", "path", "Path"); p != "" {
			return name + " " + clip(p, 80), "", nil
		}
		return name, "", nil
	case compact == "agent" || compact == "task" || compact == "subagent":
		d := in.firstStr("description", "subagent_type", "agent")
		return "子代理：" + clip(d, 100), "", nil
	}

	if inPath != "" {
		return name + " " + toolBase(inPath), inPath, []string{inPath}
	}
	// 有些工具用 toolSummary 自带人类可读的一句话（Antigravity 的 run_command）。
	if d := cleanQuoted(in.firstStr("description", "toolSummary")); d != "" {
		return name + "：" + clip(d, 100), "", nil
	}
	return name, "", nil
}

// patchFilePaths 从 apply_patch 的文本里取文件。实测 Codex 的形状：
//
//	*** Begin Patch
//	*** Update File: C:\x\a.ts
//	*** Add File: b.ts
//	*** Delete File: c.ts
//
// 也接受 unified diff 的 `+++ b/path`（其它工具的写法）。
func patchFilePaths(patch string) []string {
	if strings.TrimSpace(patch) == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		p = strings.TrimSpace(strings.Trim(p, `"'`))
		if p == "" || seen[strings.ToLower(p)] {
			return
		}
		seen[strings.ToLower(p)] = true
		out = append(out, p)
	}
	for _, line := range strings.Split(patch, "\n") {
		s := strings.TrimSpace(line)
		for _, prefix := range []string{"*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"} {
			if strings.HasPrefix(s, prefix) {
				add(strings.TrimSpace(strings.TrimPrefix(s, prefix)))
			}
		}
		if strings.HasPrefix(s, "+++ ") {
			p := strings.TrimSpace(strings.TrimPrefix(s, "+++ "))
			p = strings.TrimPrefix(p, "b/")
			if p != "/dev/null" {
				add(p)
			}
		}
	}
	return out
}

// pushWait 记一条“调用已经出现、结果还没回来”的工具。id 为空时由调用方
// 先用 newID 补齐，再从这里放进 FIFO —— 结果那边靠顺序取。
func (tr *trace) pushWait(id, tool, path string, in toolInput) {
	pd := pending{tool: tool, path: path}
	if _, isFile := fileOpGeneric(tool); isFile {
		// 失败/被拒绝时结果里没有正文；先把调用参数留一份（有上限）。
		pd.content, _ = cutUTF8(in.firstStr("content", "text", "new_string", "newString"), maxPendingToolText)
		pd.old, _ = cutUTF8(in.firstStr("old_string", "oldString", "oldText"), maxPendingToolText)
		pd.new, _ = cutUTF8(in.firstStr("new_string", "newString", "newText"), maxPendingToolText)
		if pd.content == "" {
			pd.content, _ = cutUTF8(in.firstStr("input", "patch"), maxPendingToolText)
		}
	}
	tr.wait[id] = pd
	tr.waitOrder = append(tr.waitOrder, id)
	if len(tr.waitOrder) > 600 {
		tr.waitOrder = tr.waitOrder[len(tr.waitOrder)-600:]
	}
}

// takeWait 取一条待回结果的调用：有 id 用 id；否则从头取 FIFO 里还活着的那条。
func (tr *trace) takeWait(id string) (string, pending, bool) {
	if id != "" {
		if p, ok := tr.wait[id]; ok {
			delete(tr.wait, id)
			return id, p, true
		}
	}
	for len(tr.waitOrder) > 0 {
		head := tr.waitOrder[0]
		tr.waitOrder = tr.waitOrder[1:]
		if p, ok := tr.wait[head]; ok {
			delete(tr.wait, head)
			return head, p, true
		}
	}
	return "", pending{}, false
}

// appendTool 落一条工具调用。id 为空时自己发号；参数里的文件立刻记进台账
// （结果回来前就是“碰过”，回来后再补成败）。
func (tr *trace) appendTool(id, tool string, in toolInput, at string) *ActItem {
	text, path, paths := describeAnyTool(tool, in)
	if id == "" {
		id = tr.newID("a")
	}
	it := ActItem{ID: id, Kind: "tool", Tool: tool, Text: text, Path: path, At: at}
	if path != "" {
		it.Rel = tr.rel(path)
	}
	if op, isFile := fileOpGeneric(tool); isFile {
		for _, p := range paths {
			tr.touch(p, op, 0, 0, at)
		}
		if path != "" {
			tr.touch(path, op, 0, 0, at)
		}
	}
	p := tr.append(it)
	tr.pushWait(p.ID, tool, path, in)
	return p
}

// finishAnyTool 是 Claude 之外那几条腿的“工具返回”：原地更新那一条流水，
// 并把文件台账补上（没有 structuredPatch 时只记“碰过”，不编 ±N）。
func (tr *trace) finishAnyTool(id string, p pending, ok bool, out string, at string) *ActItem {
	idx, has := tr.byID[id]
	if !has || id == "" {
		return nil
	}
	it := &tr.acts[idx]
	it.OK = &ok
	if p.tool == "" {
		p.tool = it.Tool
	}
	if p.path == "" {
		p.path = it.Path
	}
	if op, isFile := fileOpGeneric(p.tool); isFile && p.path != "" {
		if op == "read" {
			// 读不是改动：只记“碰过”，不进「改动」正文。
			tr.touch(p.path, op, 0, 0, at)
		} else {
			ch := FileChange{Tool: p.tool, At: at, OK: ok}
			if op == "write" {
				ch.Content = p.content
			} else if op == "edit" {
				ch.Old, ch.New = p.old, p.new
				if strings.TrimSpace(ch.Old) == "" && strings.TrimSpace(ch.New) == "" {
					ch.Content = p.content // apply_patch 的补丁正文
				}
			}
			if !ok {
				ch.Note = clip(out, 300)
			}
			tr.recordChange(p.path, op, 0, 0, at, ch)
		}
	}
	if it.Text == "" {
		it.Text = it.Tool
	}
	return it
}
