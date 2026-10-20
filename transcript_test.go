package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 这些用例只用**合成**的转录行，不读真实 agent home，也不改任何人的配置。
// 形状照我们实测过的 claude 转录（见 transcript.go 顶部那段注释）。

func feedLine(t *testing.T, tr *trace, line string) *ActItem {
	t.Helper()
	it := tr.consumeLine(line)
	if it == nil {
		t.Fatalf("consumeLine 没认出来：%s", line)
	}
	return it
}

func toolUseLine(id, name, input string) string {
	return `{"type":"assistant","timestamp":"2026-10-20T10:00:00.000Z","message":{"content":[` +
		`{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func toolResultLine(id, blockContent string, isError bool, result string) string {
	errField := ""
	if isError {
		errField = `,"is_error":true`
	}
	return `{"type":"user","timestamp":"2026-10-20T10:00:01.000Z",` +
		`"toolUseResult":` + result + `,"message":{"content":[` +
		`{"type":"tool_result","content":` + blockContent + `,"tool_use_id":"` + id + `"` + errField + `}]}}`
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func findTouch(t *testing.T, tr *trace, path string) *FileTouch {
	t.Helper()
	key := strings.ToLower(filepath.Clean(path))
	f := tr.files[key]
	if f == nil {
		t.Fatalf("台账里没有 %s（有 %d 个文件）", path, len(tr.files))
	}
	return f
}

func TestWriteSuccessKeepsContentAndCounts(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hello.txt")
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_1", "Write",
		`{"file_path":`+jsonString(path)+`,"content":"a\nb\n"}`))
	// 结果落盘之前先写文件：真实工具在结果回来时文件已经在盘上了。
	writeFile(t, path, "a\nb\n")
	feedLine(t, tr, toolResultLine("call_1", jsonString("File created successfully at: "+path), false,
		`{"type":"create","filePath":`+jsonString(path)+`,"content":"a\nb\n"}`))

	f := findTouch(t, tr, path)
	if !f.HasDiff || len(f.Changes) != 1 {
		t.Fatalf("改动没有留下：hasDiff=%v changes=%d", f.HasDiff, len(f.Changes))
	}
	if f.Add != 2 || f.Del != 0 {
		t.Fatalf("行数不对：+%d −%d（写的是 2 行）", f.Add, f.Del)
	}
	ch := f.Changes[0]
	if !ch.OK || ch.Tool != "Write" || ch.Content != "a\nb\n" {
		t.Fatalf("改动的正文/工具不对：%+v", ch)
	}
	if f.State != "" {
		t.Fatalf("文件在盘上，state 不该是 %q", f.State)
	}
}

func TestEditSuccessKeepsStructuredPatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "code.go")
	writeFile(t, path, "ctx\nnew\nextra\n")
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_2", "Edit",
		`{"file_path":`+jsonString(path)+`,"old_string":"old","new_string":"new\nextra"}`))
	feedLine(t, tr, toolResultLine("call_2", `"ok"`, false,
		`{"filePath":`+jsonString(path)+`,"oldString":"old","newString":"new\nextra",`+
			`"structuredPatch":[{"oldStart":1,"oldLines":2,"newStart":1,"newLines":3,`+
			`"lines":[" ctx","-old","+new","+extra"]}]}`))

	f := findTouch(t, tr, path)
	if f.Add != 2 || f.Del != 1 {
		t.Fatalf("±N 不对：+%d −%d", f.Add, f.Del)
	}
	ch := f.Changes[0]
	if len(ch.Patch) != 1 || len(ch.Patch[0].Lines) != 4 {
		t.Fatalf("structuredPatch 没留下：%+v", ch.Patch)
	}
	if ch.Patch[0].OldStart != 1 || ch.Patch[0].NewStart != 1 {
		t.Fatalf("hunk 行号不对：%+v", ch.Patch[0])
	}
}

func TestRejectedWriteUsesInputAndMarksState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blocked.txt") // 故意不创建：被拒绝，本来就没落盘
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_3", "Write",
		`{"file_path":`+jsonString(path)+`,"content":"secret\n"}`))
	feedLine(t, tr, toolResultLine("call_3",
		`"The user doesn't want to take this action."`, true,
		`"Error: The user doesn't want to take this action."`))

	f := findTouch(t, tr, path)
	if f.State != "rejected" {
		t.Fatalf("state 应该是 rejected，实际 %q", f.State)
	}
	if f.Add != 0 || f.Del != 0 {
		t.Fatalf("被拒绝的写入不该计入行数：+%d −%d", f.Add, f.Del)
	}
	ch := f.Changes[0]
	if ch.OK {
		t.Fatal("被拒绝的写入被记成了成功")
	}
	if ch.Content != "secret\n" {
		t.Fatalf("没有回放调用参数里的内容：%q", ch.Content)
	}
	if !strings.Contains(ch.Note, "被拒绝") || !strings.Contains(ch.Note, "doesn't") {
		t.Fatalf("note 没带上拒绝原因：%q", ch.Note)
	}
}

func TestRejectedEditKeepsOldAndNew(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "edit.txt")
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_4", "Edit",
		`{"file_path":`+jsonString(path)+`,"old_string":"old line","new_string":"new line"}`))
	feedLine(t, tr, toolResultLine("call_4", `"denied"`, true,
		`"Error: The user doesn't want to take this action."`))

	f := findTouch(t, tr, path)
	ch := f.Changes[0]
	if ch.OK || ch.Old != "old line" || ch.New != "new line" {
		t.Fatalf("被拒绝的 Edit 没保住 old/new：%+v", ch)
	}
	if len(ch.Patch) != 0 {
		t.Fatalf("没有 structuredPatch 时不该凭空造 patch：%+v", ch.Patch)
	}
}

func TestEditToolFailureIsFailedNotRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "edit.txt")
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_6", "Edit",
		`{"file_path":`+jsonString(path)+`,"old_string":"gone","new_string":"new"}`))
	feedLine(t, tr, toolResultLine("call_6",
		jsonString("<tool_use_error>String to replace not found in file.</tool_use_error>"), true,
		jsonString("Error: String to replace not found in file.")))

	f := findTouch(t, tr, path)
	if f.State != "failed" {
		t.Fatalf("工具报错应该是 failed，实际 %q", f.State)
	}
	ch := f.Changes[0]
	if ch.OK || ch.Denied {
		t.Fatalf("工具报错不是用户拒绝：ok=%v denied=%v", ch.OK, ch.Denied)
	}
	if !strings.Contains(ch.Note, "失败") || !strings.Contains(ch.Note, "not found") {
		t.Fatalf("note 不对：%q", ch.Note)
	}
}

func TestDiffCopyReportsFoundAndMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gone.txt")
	tr := newTrace(filepath.Join(dir, "t.jsonl"), dir)

	feedLine(t, tr, toolUseLine("call_5", "Write",
		`{"file_path":`+jsonString(path)+`,"content":"x\n"}`))
	writeFile(t, path, "x\n")
	feedLine(t, tr, toolResultLine("call_5", `"ok"`, false,
		`{"type":"create","filePath":`+jsonString(path)+`,"content":"x\n"}`))

	// 结果回来后文件被别的东西删掉了：diff 仍要能取到，同时明确 missing。
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	d := diffCopy(tr, path)
	if d == nil || !d.Found || !d.Missing {
		t.Fatalf("diffCopy 没报 found/missing：%+v", d)
	}
	if len(d.Changes) != 1 || d.Changes[0].Content != "x\n" {
		t.Fatalf("改动正文丢了：%+v", d.Changes)
	}
}

func TestCutUTF8DoesNotSplitRune(t *testing.T) {
	s := strings.Repeat("中", 10) // 每字 3 字节
	got, cut := cutUTF8(s, 10)   // 10 不是 rune 边界：要退到 9
	if !cut || got != strings.Repeat("中", 3)+"…" {
		t.Fatalf("切点不对：%q cut=%v", got, cut)
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
