package transcript

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// file 取/建一个文件的台账项。路径按大小写不敏感对齐（Windows），
// 超上限时淘汰最久没动的那一个。
func (tr *trace) file(path string) *FileTouch {
	key := strings.ToLower(filepath.Clean(path))
	t := tr.files[key]
	if t == nil {
		if len(tr.files) >= maxFiles {
			var oldestKey string
			var oldest string
			for k, v := range tr.files {
				if oldest == "" || v.At < oldest {
					oldest, oldestKey = v.At, k
				}
			}
			delete(tr.files, oldestKey)
		}
		t = &FileTouch{Path: path, Rel: tr.rel(path)}
		tr.files[key] = t
	}
	if t.Rel == "" {
		t.Rel = tr.rel(path)
	}
	return t
}

// touch 记一次文件动作。ops 去重、保留最后一次时间。
func (tr *trace) touch(path, op string, add, del int, at string) {
	t := tr.file(path)
	t.At = at
	if add > 0 || del > 0 {
		t.Add += add
		t.Del += del
	}
	for _, o := range t.Ops {
		if o == op {
			tr.dirtyF = true
			return
		}
	}
	t.Ops = append(t.Ops, op)
	tr.dirtyF = true
}

// recordChange 记一次 **Edit/Write 的结果**（成功或被拒绝都记）。
// 与 touch 分开：touch 是"碰过"（工具一调用就记），recordChange 才有
// 成败和可展示的正文 —— 预览的「改动」页读的就是后者。
func (tr *trace) recordChange(path, op string, add, del int, at string, ch FileChange) {
	t := tr.file(path)
	t.At = at
	if ch.OK {
		if add > 0 || del > 0 {
			t.Add += add
			t.Del += del
		}
	}
	seen := false
	for _, o := range t.Ops {
		if o == op {
			seen = true
			break
		}
	}
	if !seen {
		t.Ops = append(t.Ops, op)
	}
	ch.bytes = changeBytes(ch)
	t.Changes = append(t.Changes, ch)
	t.HasDiff = true
	if !ch.OK {
		if ch.Denied {
			t.State = "rejected"
		} else {
			t.State = "failed"
		}
	} else if _, err := os.Stat(path); os.IsNotExist(err) {
		t.State = "missing"
	} else {
		t.State = ""
	}
	tr.trimChanges(t)
	tr.trimDiffFiles(t)
	tr.dirtyF = true
}

func changeBytes(ch FileChange) int {
	n := len(ch.Content) + len(ch.Old) + len(ch.New)
	for _, h := range ch.Patch {
		for _, l := range h.Lines {
			n += len(l)
		}
	}
	return n
}

func (tr *trace) trimChanges(t *FileTouch) {
	for len(t.Changes) > maxChangesPerFile {
		t.Changes = t.Changes[1:]
	}
	total := 0
	for _, c := range t.Changes {
		total += c.bytes
	}
	for total > maxChangeBytesFile && len(t.Changes) > 1 {
		total -= t.Changes[0].bytes
		t.Changes = t.Changes[1:]
	}
}

// trimDiffFiles 只保留最近 maxDiffFiles 个文件的改动正文；超了就从最久没动
// 的那个开始清空。计数（add/del）和 ops 不受影响 —— 清掉的只是"点开能看的那几行"。
func (tr *trace) trimDiffFiles(keep *FileTouch) {
	n := 0
	for _, f := range tr.files {
		if f.HasDiff {
			n++
		}
	}
	for n > maxDiffFiles {
		var oldest *FileTouch
		for _, f := range tr.files {
			if !f.HasDiff || f == keep {
				continue
			}
			if oldest == nil || f.At < oldest.At {
				oldest = f
			}
		}
		if oldest == nil {
			return
		}
		oldest.Changes = nil
		oldest.HasDiff = false
		n--
	}
}

// fileChangeOf 把一次工具结果整理成可展示的改动。正文按 maxChangeText 截；
// 被拒绝的 Write/Edit 没有结果正文，用调用参数回放并明确标注"未落盘"。
func fileChangeOf(tool string, p pending, r map[string]json.RawMessage, at string,
	ok bool, errText string, hunks []FileHunk, add, del int, patchTrunc bool) FileChange {
	ch := FileChange{Tool: tool, At: at, OK: ok, Patch: hunks, Truncated: patchTrunc}
	if ok {
		ch.Add, ch.Del = add, del
	}
	// 没有落盘的原因分两类：用户/权限拒绝，还是工具自己报错。前者才是
	// "被拒绝"；后者（比如 old_string 找不到）只是失败。两种都不计入 ±N。
	failLabel := "失败，未落盘"
	if !ok && isUserRejection(errText) {
		ch.Denied = true
		failLabel = "被拒绝，未落盘"
	}
	switch tool {
	case "Write":
		s := ""
		if r != nil {
			if v, has := r["content"]; has {
				_ = json.Unmarshal(v, &s)
			}
		}
		if s == "" {
			s = p.content
		}
		var cut bool
		ch.Content, cut = cutUTF8(s, maxChangeText)
		ch.Truncated = ch.Truncated || cut
		if !ok {
			ch.Note = failLabel
		} else if len(s) == 0 {
			ch.Note = "写入内容为空"
		}
	case "Edit", "NotebookEdit":
		if len(hunks) == 0 {
			if p.old != "" || p.new != "" {
				ch.Old, _ = cutUTF8(p.old, maxChangeText)
				ch.New, _ = cutUTF8(p.new, maxChangeText)
				if !ok {
					ch.Note = failLabel
				} else {
					ch.Note = "这次编辑没有 structuredPatch，下面按调用参数回放（没有最终行号）"
				}
			} else if !ok {
				ch.Note = failLabel
			} else {
				ch.Note = "这次编辑没有可显示的差异"
			}
		} else if !ok {
			ch.Note = failLabel
		}
	}
	if !ok && errText != "" {
		n := clip(errText, 240)
		if ch.Note == "" {
			ch.Note = n
		} else {
			ch.Note += " · " + n
		}
	}
	return ch
}

// isUserRejection 认的是**实测见过的拒绝文案**（不是猜工具语义）：
//
//	The user doesn't want to proceed with this tool use. …
//	The user doesn't want to take this action.
//
// 工具自己报错（"String to replace not found"）不算拒绝 —— 两者都没落盘，
// 但在界面上要说不同的话。
func isUserRejection(s string) bool {
	s = strings.ToLower(s)
	return strings.Contains(s, "doesn't want to") ||
		strings.Contains(s, "does not want to") ||
		strings.Contains(s, "user rejected") ||
		strings.Contains(s, "tool use was rejected")
}

// readPatch 解 structuredPatch，并留一份有上限的 hunk 供预览。
// ±N 始终按**完整** patch 数，截断只影响"能看到的行"。
func readPatch(raw json.RawMessage) (hunks []FileHunk, add, del int, truncated bool) {
	if len(raw) == 0 {
		return
	}
	var all []FileHunk
	if json.Unmarshal(raw, &all) != nil {
		return
	}
	kept := 0
	for _, h := range all {
		for _, l := range h.Lines {
			if l == "" {
				continue
			}
			switch l[0] {
			case '+':
				add++
			case '-':
				del++
			}
		}
		if truncated {
			continue
		}
		n := len(h.Lines)
		if kept+n > maxPatchLines {
			n = maxPatchLines - kept
			if n < 0 {
				n = 0
			}
			truncated = true
		}
		if n > 0 {
			hh := h
			hh.Lines = append([]string{}, h.Lines[:n]...)
			hunks = append(hunks, hh)
			kept += n
		}
	}
	return
}

func (tr *trace) fileList() []FileTouch {
	out := make([]FileTouch, 0, len(tr.files))
	for _, f := range tr.files {
		out = append(out, *f)
	}
	// 最近动的在前
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// rel 把绝对路径压成相对 cwd 的形式 —— 面板里全是长绝对路径，噪音太大。
// cwd 之外的路径保持绝对（那不是"这个项目的文件"）。
func (tr *trace) rel(p string) string {
	if tr.cwd == "" {
		return p
	}
	r, err := filepath.Rel(tr.cwd, p)
	if err != nil || strings.HasPrefix(r, "..") {
		return p
	}
	return filepath.ToSlash(r)
}
