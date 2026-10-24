package agent

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/transcript"
)

// ---------------------------------------------------------------------------
// Pi 适配器（1.4.x）
//
// 机制选的是 **每格一个扩展**，而不是 RPC/JSON 模式：
//
//	pi -e <observer.ts>   → 扩展在 TUI 进程里订阅生命周期
//	                      → 追加写 PERCH_PI_EVENTS 指定的 JSONL
//	                      → Go 侧 tail 这个文件，归一化成 agentEvent
//
// 为什么不走 `--mode json` / `--mode rpc`：那两条是**无界面**入口，会取代 TUI；
// 而 Perch 要的正是“用户继续用 Pi 自己的终端界面，我们在旁边看状态”。
//
// 每格一份事件文件（同 hooks 的理由）：归属由文件名定，不做 session 反查，
// 也就没有“SessionStart 比登记表早到、事件没主”的竞态。
//
// 扩展源码在仓库的 internal/agent/pi/observer.ts，go:embed 进二进制、启动时释放到
// %APPDATA%\Perch\pi-ext\perch-observer.ts；用户目录里那份是派生物，不是配置。
// ---------------------------------------------------------------------------

const (
	piPollEvery      = 200 * time.Millisecond
	piExtDirName     = "pi-ext"
	piEventsDirName  = "pi-events"
	piToolsDirName   = "pi-tools"
	piSessionDirName = "pi-sessions"
)

//go:embed pi/observer.ts
var piObserverSource string

func piDef() Def {
	d := GenericDef("pi")
	// 续接参数走这里（和 Claude 的 Args 同一个位置）；扩展参数在 Prepare 里追加。
	d.Args = func(r ResumeIntent, _ string) []string {
		switch r.Kind {
		case "latest":
			return []string{"--continue"}
		case "exact":
			if r.ID != "" {
				// ⚠️ 用 --session-id 而不是 --session：后者“先在本项目找，找不到
				// 就提出 fork 一个跨项目匹配”，那是一个**交互式提问**，会把格子
				// 停在没人能回答的菜单上。--session-id 是确定的：本项目里有这条
				// 就打开，没有就用这个 id 建一条（实测 1.4.x，docs/cli.md:90-93）。
				return []string{"--session-id", r.ID}
			}
		case "fork":
			if r.ID != "" {
				return []string{"--fork", r.ID}
			}
		}
		// "new"：裸启动就是新会话。
		return nil
	}
	d.Prepare = preparePi
	return d
}

func piDataDir() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, DataDirName), nil
}

// piToolsBinDir 是 Perch 自己的 Pi 工具缓存。
//
// Pi 1.4.0 在启动时找不到 fd/ripgrep 会去 GitHub 下载；它的超时是 10s+
// 并且会把 TUI 卡在 “Downloading...” 上。fd/rg 是 Pi 的通用工具依赖，
// 放在 Perch 这边缓存一次，后面每个格子都从 PATH 直接命中，不再重复下载。
func piToolsBinDir() (string, error) {
	base, err := piDataDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, piToolsDirName, "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func piSessionDir() (string, error) {
	base, err := piDataDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, piSessionDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func piStableSessionRoot() (string, bool) {
	base, err := piDataDir()
	if err != nil {
		return "", false
	}
	dir := filepath.Join(base, piSessionDirName)
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		return "", false
	}
	return dir, true
}

// ensurePiTools 尝试从本机已有的 Pi 目录/系统 PATH 取 fd、rg，放进 Perch
// 的共享缓存。找不到就返回 ready=false，让 Pi 自己按原逻辑处理（首次安装）。
func ensurePiTools() (dir string, ready bool) {
	dir, err := piToolsBinDir()
	if err != nil {
		return "", false
	}
	ready = true
	for _, item := range []struct {
		name string
		file string
	}{
		{name: "fd", file: "fd.exe"},
		{name: "rg", file: "rg.exe"},
	} {
		dst := filepath.Join(dir, item.file)
		if fileExists(dst) {
			continue
		}
		src := findPiTool(item.name, item.file)
		if src != "" {
			if err := copyPiTool(src, dst); err == nil {
				log.Printf("[pi] 工具已缓存 %s → %s", item.name, dst)
				continue
			} else {
				log.Printf("[pi] 缓存 %s 失败: %v", item.name, err)
			}
		}
		ready = false
	}
	return dir, ready
}

func findPiTool(name, file string) string {
	names := []string{name}
	if filepath.Ext(name) == "" {
		names = append(names, name+".exe")
	}
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil && !isDir(p) {
			return p
		}
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".pi", "agent", "bin", file),
	}
	// 兼容旧版 Perch 为 Pi 生成的临时 profile：这些目录里有 Pi 自己下载
	// 过的 fd/rg。只在共享缓存缺失时迁移一次，之后完全不依赖临时目录。
	if matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "perch-pi-*", "bin", file)); len(matches) > 0 {
		candidates = append(candidates, matches...)
	}
	for _, p := range candidates {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

func copyPiTool(src, dst string) error {
	if filepath.Clean(src) == filepath.Clean(dst) {
		return nil
	}
	// Same-volume hardlinks are instant; fall back to a copy on other volumes.
	_ = os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(dst)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return nil
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// ensurePiObserver 把二进制里的扩展释放到磁盘。
//
// 每次都对比内容：升级 Perch 后扩展跟着更新，不会出现“二进制是新的、盘上的
// 扩展还是旧的”这种最难查的半新半旧状态。先写临时文件再 rename，避免 Pi 在
// 启动窗口里读到半截源码。
func ensurePiObserver() (string, error) {
	base, err := piDataDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, piExtDirName)
	path := filepath.Join(dir, "perch-observer.ts")
	if b, err := os.ReadFile(path); err == nil && string(b) == piObserverSource {
		return path, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(piObserverSource), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return path, nil
}

func preparePi(tag string, tabID int, _ string, _ []string) (map[string]string, []string, func(context.Context), error) {
	ext, err := ensurePiObserver()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("准备 Pi 观察扩展: %w", err)
	}
	base, err := piDataDir()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("找 Pi 事件目录: %w", err)
	}
	dir := filepath.Join(base, piEventsDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, nil, fmt.Errorf("建 Pi 事件目录: %w", err)
	}
	path := filepath.Join(dir, tag+".jsonl")
	// 实时信号不是历史：每次开格清空（同 hooks.resetHookDir）。
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("清空 Pi 事件文件: %w", err)
	}
	_ = f.Close()

	// npm 全局装的是 pi.cmd，shim 里还要找 node；GUI 进程的 PATH 往往比
	// 终端短（这台机器上就是 Program Files\nodejs 不在 PATH 里），必须自己补，
	// 否则 Pi 一起来就退出，终端只留下一行「Process exited」。
	//
	// 另外把 Perch 共享的 fd/rg 目录放到 PATH 最前：Pi 启动时会先查 PATH，
	// 命中就不再去 GitHub 下载（下载超时会把 TUI 卡住十几秒）。
	toolsDir, toolsReady := ensurePiTools()
	childPath := dshChildPath()
	if toolsDir != "" {
		childPath = toolsDir + ";" + childPath
	}
	env := map[string]string{
		"PERCH_PI_EVENTS": path,
		"PATH":            childPath,
	}
	// Pi 自己的 session 目录必须稳定：否则每一格都在临时 profile 里落盘，
	// 关格后 piSessionFileExists 在真实 ~/.pi 下找不到，续接就静默失败。
	if sessionDir, err := piSessionDir(); err == nil {
		env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir
	}
	// 工具齐了就关掉 Pi 启动时的自动网络刷新；模型请求不受影响，但少一次
	// 与网关启动争网络的 catalog refresh。工具缺失时保留原逻辑，让 Pi 自己补。
	if toolsReady {
		env["PI_OFFLINE"] = "1"
	}
	args := []string{"-e", ext}
	log.Printf("[pi %s] 观察扩展=%s 事件=%s 工具=%s 就绪=%v", tag, ext, path, toolsDir, toolsReady)
	observe := func(ctx context.Context) {
		observePi(ctx, tabID, path, piPollEvery, emitAgentStatus)
	}
	return env, args, observe, nil
}

// piEvent 是 observer.ts 写出的记录。字段只增不改（v1）。
type piEvent struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	State   string `json:"state"` // working|blocked|waiting|done（见 observer.ts）
	Session string `json:"session"`
	Kind    string `json:"kind"`
	Text    string `json:"text"`
	Name    string `json:"name"`
	Reason  string `json:"reason"`
	Aborted bool   `json:"aborted"`
	At      int64  `json:"at"`

	// v2：流水/改动（见 observer.ts 顶部）。ID 是工具调用 id 或消息块 id。
	ID   string `json:"id"`
	Tool string `json:"tool"`
	Path string `json:"path"`
	Op   string `json:"op"`
	OK   *bool  `json:"ok"`
}

// observePi tail 一个格子的 JSONL。语义与 hooks 的轮询一致：
// 只追加、文件被截断就从头读、最后一行没写完就留到下一次。
func observePi(ctx context.Context, tabID int, path string, every time.Duration, sink func(agentEvent)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	var off int64
	var carry string
	// name 只是顺带记下：Pi 的 /name 改的是会话显示名，不是状态。
	// 把它塞进**下一条** status 事件（emitAgentStatus 只认状态变化，
	// 单发一条没有 status 的 agent 消息会把前端 v.st 清成 ""）。
	st := &piPaneState{flow: newPiFlow()}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		if fi.Size() < off {
			off, carry = 0, ""
		}
		if fi.Size() == off {
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			_ = f.Close()
			continue
		}
		b, rerr := io.ReadAll(f)
		_ = f.Close()
		if rerr != nil {
			continue
		}
		off += int64(len(b))
		buf := carry + string(b)
		for {
			i := strings.IndexByte(buf, '\n')
			if i < 0 {
				break
			}
			line := buf[:i]
			buf = buf[i+1:]
			handlePiLine(tabID, line, st, sink)
		}
		carry = buf
	}
}

// piPaneState 是一次观察里的格内上下文：显示名 + 流水/改动。
type piPaneState struct {
	name string
	flow *piFlow
}

// piFlow 是扩展直接推来的流水/改动。它和 transcript.Follower 是**两条互斥的
// 腿**：Pi 的 session jsonl 在当前版本/Home 下实测没有落盘，所以 Pi 这条腿
// 不跟文件，改用扩展已经看见的 message/tool 生命周期。
type piFlow struct {
	started  bool
	acts     []transcript.ActItem
	byID     map[string]int
	files    map[string]*transcript.FileTouch
	filesSig string
	seq      int
}

func newPiFlow() *piFlow {
	return &piFlow{byID: map[string]int{}, files: map[string]*transcript.FileTouch{}}
}

func (f *piFlow) reset(tabID int) {
	f.started = false
	f.acts = nil
	f.byID = map[string]int{}
	f.files = map[string]*transcript.FileTouch{}
	f.filesSig = ""
	host.Push(map[string]any{"type": "acts", "tab": tabID, "items": []transcript.ActItem{}, "replace": true})
	host.Push(map[string]any{"type": "files", "tab": tabID, "files": []transcript.FileTouch{}})
}

func (f *piFlow) put(tabID int, it transcript.ActItem) {
	if f == nil {
		return
	}
	if it.ID == "" {
		f.seq++
		it.ID = fmt.Sprintf("pi:%d", f.seq)
	}
	if idx, ok := f.byID[it.ID]; ok {
		// 原地更新：工具先由 tool_execution_start 出现，结果再由 act_update 补。
		old := &f.acts[idx]
		if it.Kind != "" {
			old.Kind = it.Kind
		}
		if it.Tool != "" {
			old.Tool = it.Tool
		}
		if it.Text != "" {
			old.Text = it.Text
		}
		if it.Path != "" {
			old.Path = it.Path
		}
		if it.OK != nil {
			old.OK = it.OK
		}
		it = *old
	} else {
		if it.At == "" {
			it.At = time.Now().Format(time.RFC3339)
		}
		f.acts = append(f.acts, it)
		if len(f.acts) > 300 {
			drop := len(f.acts) - 300
			f.acts = append([]transcript.ActItem(nil), f.acts[drop:]...)
			f.byID = map[string]int{}
			for i, a := range f.acts {
				f.byID[a.ID] = i
			}
		} else {
			f.byID[it.ID] = len(f.acts) - 1
		}
	}
	replace := !f.started
	f.started = true
	host.Push(map[string]any{"type": "acts", "tab": tabID, "items": []transcript.ActItem{it}, "replace": replace})
}

func (f *piFlow) file(tabID int, path, op string) {
	if f == nil || strings.TrimSpace(path) == "" {
		return
	}
	key := strings.ToLower(filepath.Clean(path))
	t := f.files[key]
	if t == nil {
		t = &transcript.FileTouch{Path: path}
		f.files[key] = t
	}
	if t.At == "" {
		t.At = time.Now().Format(time.RFC3339)
	}
	found := false
	for _, o := range t.Ops {
		if o == op {
			found = true
			break
		}
	}
	if !found && op != "" {
		t.Ops = append(t.Ops, op)
	}
	f.pushFiles(tabID)
}

func (f *piFlow) pushFiles(tabID int) {
	list := make([]transcript.FileTouch, 0, len(f.files))
	keys := make([]string, 0, len(f.files))
	for k := range f.files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		list = append(list, *f.files[k])
	}
	sig := mustJSON(list)
	if sig == f.filesSig {
		return
	}
	f.filesSig = sig
	host.Push(map[string]any{"type": "files", "tab": tabID, "files": list})
}

func handlePiLine(tabID int, line string, st *piPaneState, sink func(agentEvent)) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	var ev piEvent
	if json.Unmarshal([]byte(line), &ev) != nil {
		return
	}

	// session 是这一格的身份：session_start 和每条 status 都带它。
	// 绑定/改写只在第一次或换会话时生效，和 OpenCode 走同一个口。
	if ev.Session != "" {
		bindObservedSession(tabID, ev.Session, "pi")
	}

	switch ev.Type {
	case "session_start":
		if st.flow != nil {
			st.flow.reset(tabID)
		}
		log.Printf("[pi t%d] session_start reason=%s session=%s",
			tabID, OrNone(ev.Reason), Short(ev.Session))
		return
	case "act":
		at := ""
		if ev.At > 0 {
			at = time.UnixMilli(ev.At).Format(time.RFC3339)
		}
		if ev.Kind == "prompt" {
			host.NoteActivity(tabID, false)
		} else if ev.Kind != "" {
			host.NoteActivity(tabID, true)
		}
		st.flow.put(tabID, transcript.ActItem{
			ID: ev.ID, Kind: ev.Kind, Tool: ev.Tool, Text: ev.Text,
			Path: ev.Path, OK: ev.OK, At: at,
		})
		return
	case "act_update":
		host.NoteActivity(tabID, true)
		st.flow.put(tabID, transcript.ActItem{
			ID: ev.ID, Text: ev.Text, Path: ev.Path, OK: ev.OK,
		})
		return
	case "file":
		st.flow.file(tabID, ev.Path, ev.Op)
		return
	case "name":
		// 名字不是状态：**不能**单独推一条没有 status 的 agent 消息 ——
		// 前端 applyAgent 会执行 v.st = m.status || ""，把忙/闲清空。
		// 记在这里，跟下一条 status 一起发。空名字 = 用户清掉了显示名。
		st.name = ev.Name
		log.Printf("[pi t%d] 名字 → %q", tabID, Clip(ev.Name, 80))
		return
	case "status":
	default:
		return
	}

	if ev.Status != "busy" && ev.Status != "idle" && ev.Status != "waiting" {
		return
	}
	out := agentEvent{
		V: 1, Tab: tabID, Agent: "pi", Event: "status",
		Status: ev.Status, State: ev.State, Kind: ev.Kind, Text: ev.Text,
		Session: ev.Session, Name: st.name, Evidence: EvidenceExtension,
	}
	// 观察扩展只写它确定的部分（比如提问工具会给 state=blocked）；
	// 剩下的 working/done 从这里按 status 补齐，UI 不需要猜。
	normalizeAgentEvent(&out)
	sink(out)
}

// piSessionRoot 找 Pi 的会话目录（<root>/--<项目路径>--/<时间戳>_<id>.jsonl）。
//
// 解析顺序照 Pi 自己的优先级（docs/environment-variables.md、docs/settings.md）：
//
//	--session-dir（我们不传，Perch 永远走默认）> PI_CODING_AGENT_SESSION_DIR
//	> settings.json 的 sessionDir > <agent-dir>/sessions
//
// 相对路径按 Pi 的规则从**工作目录**解析。读 settings.json 是只读的；
// 解析不了就退回默认目录 —— 找不到会话文件只会让冷恢复降级成新会话，
// 不会写任何东西。
func piSessionRoot(cwd string) string {
	if v := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_SESSION_DIR")); v != "" {
		if filepath.IsAbs(v) || cwd == "" {
			return v
		}
		return filepath.Join(cwd, v)
	}
	// Perch 启动的 Pi 用共享 session 目录；子进程的 env 不会回流到 Go，
	// 所以这里也要认这份稳定目录，否则关格后找不到会话文件。只有目录里
	// 已经有内容时才优先使用它，避免把用户原本 ~/.pi 下的会话遮住。
	if dir, ok := piStableSessionRoot(); ok {
		return dir
	}
	agentDir := strings.TrimSpace(os.Getenv("PI_CODING_AGENT_DIR"))
	if agentDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			agentDir = filepath.Join(home, ".pi", "agent")
		}
	}
	if agentDir == "" {
		return ""
	}
	if b, err := os.ReadFile(filepath.Join(agentDir, "settings.json")); err == nil {
		var s struct {
			SessionDir string `json:"sessionDir"`
		}
		if json.Unmarshal(b, &s) == nil {
			if v := strings.TrimSpace(s.SessionDir); v != "" {
				if filepath.IsAbs(v) || cwd == "" {
					return v
				}
				return filepath.Join(cwd, v)
			}
		}
	}
	return filepath.Join(agentDir, "sessions")
}

// piSessionFileExists：这条 Pi 会话在盘上还有没有。
//
// 项目目录名是有损 slug（`C:\a\b` → `--C--a-b--`），不从 cwd 反推 ——
// 只 glob 一层项目目录。找到的是**文件名以 _<id>.jsonl 结尾**的文件；
// Pi 默认命名是 <时间戳>_<session-id>.jsonl（实测 1.4.x）。
func piSessionFileExists(cwd, id string) bool {
	if !SafeSessionID(id) {
		return false
	}
	root := piSessionRoot(cwd)
	if root == "" {
		return false
	}
	m, err := filepath.Glob(filepath.Join(root, "*", "*_"+id+".jsonl"))
	if err != nil {
		return false
	}
	// Pi 一启动就会写一条 session 文件，零轮次也有文件 —— 关格/续接不能被
	// "文件存在"骗过去。只有真的出现过 user/assistant 消息才算一条会话。
	for _, p := range m {
		if b, err := os.ReadFile(p); err == nil &&
			(bytes.Contains(b, []byte(`"role":"user"`)) || bytes.Contains(b, []byte(`"role":"assistant"`))) {
			return true
		}
	}
	return false
}

// SessionFileExistsFor：冷恢复/续接护栏的 agent 分派口。
// 这里回答所有“有自己会话文件”的 agent；Claude 由宿主自己判（它的 projects
// 目录在 Perch 的 stateDir 下）。
func SessionFileExistsFor(name, cwd, id string) bool {
	if !SafeSessionID(id) {
		return false
	}
	switch name {
	case "pi":
		return PiSessionFileExists(cwd, id)
	case "codex":
		return CodexSessionFileExists(cwd, id)
	case "qoder":
		return anyExisting(qoderCandidates(cwd, id))
	case "copilot":
		return anyExisting(copilotCandidates(cwd, id))
	case "dsh":
		return dshSessionPath(cwd, id) != ""
	case "cursor":
		return anyExisting(cursorCandidates(cwd, id))
	case "agy":
		return agySessionPath(id) != ""
	case "opencode":
		return openCodeSessionExists(id)
	}
	return false
}

// anyExisting 过滤 glob 结果：候选列表本身可能包含不存在的路径
// （copilot 的 exact 路径不经过 glob，直接拼出来）。
func anyExisting(paths []string) bool {
	for _, p := range paths {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return true
		}
	}
	return false
}

// agySessionPath 按 conversation id 找 Antigravity 的转录。
// agy 的续接参数是 --conversation <id>，所以这个 id 就是 brain 目录名。
func agySessionPath(id string) string {
	if !SafeSessionID(id) {
		return ""
	}
	home := agentHome("agy")
	if home == "" {
		return ""
	}
	root := filepath.Join(home, ".gemini", "antigravity-cli", "brain", id,
		".system_generated", "logs")
	for _, name := range []string{"transcript_full.jsonl", "transcript.jsonl"} {
		p := filepath.Join(root, name)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// PiSessionFileExists：这条 Pi 会话在盘上还有没有（给宿主的分派口）。
func PiSessionFileExists(cwd, id string) bool { return piSessionFileExists(cwd, id) }

// CodexSessionFileExists：这条 Codex 会话在盘上还有没有（给宿主的分派口）。
func CodexSessionFileExists(cwd, id string) bool { return codexSessionFileExists(cwd, id) }

// bindObservedSession 是“外部状态源报告了会话身份”的统一入口。
// agent 只用于日志措辞；bind/rebind 的语义见宿主的 TabManager。
func bindObservedSession(tabID int, sid, agent string) {
	if host.BindSession(tabID, sid, "", agent) {
		log.Printf("[agent t%d] 关联建立 session=%s（%s）", tabID, Short(sid), agent)
		return
	}
	if host.RebindSession(tabID, sid, "", agent) {
		log.Printf("[agent t%d] 会话改写 session=%s（%s）", tabID, Short(sid), agent)
	}
}
