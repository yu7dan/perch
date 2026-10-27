package agent

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Found 是“这一格的转录文件在哪、是什么格式”。
//
// Format:
//   - "" / "jsonl"：纯 JSONL
//   - "zstd"：追加写的 zstd 帧流（DSH 的 session.v4.jsonl.zstd），解压后是 JSONL
type Found struct {
	Path   string
	Format string
}

// transcriptClaims 让“没有会话 id、只能找最新文件”的 agent（agy/cursor/qoder/
// copilot 首轮之前）不会把同一个文件分给两格。格关掉时 ReleaseTranscripts。
var transcriptClaims = struct {
	sync.Mutex
	byPath map[string]int
	byTab  map[int]string
}{byPath: map[string]int{}, byTab: map[int]string{}}

// ClaimTranscript 把一个文件绑给一格；已被别的活格占了就返回 false。
func ClaimTranscript(tabID int, path string) bool {
	if tabID <= 0 || path == "" {
		return false
	}
	key := strings.ToLower(filepath.Clean(path))
	transcriptClaims.Lock()
	defer transcriptClaims.Unlock()
	if owner, ok := transcriptClaims.byPath[key]; ok && owner != tabID {
		return false
	}
	if old := transcriptClaims.byTab[tabID]; old != "" && old != key {
		delete(transcriptClaims.byPath, old)
	}
	transcriptClaims.byPath[key] = tabID
	transcriptClaims.byTab[tabID] = key
	return true
}

// ReleaseTranscripts 在格子关掉时放掉它的认领，让下一格能接上同一个文件
// （冷恢复的 agy/cursor 会继续写同一个转录）。
func ReleaseTranscripts(tabID int) {
	transcriptClaims.Lock()
	defer transcriptClaims.Unlock()
	if key := transcriptClaims.byTab[tabID]; key != "" {
		delete(transcriptClaims.byPath, key)
		delete(transcriptClaims.byTab, tabID)
	}
}

// TranscriptFor 是“这一格该跟哪个文件”的唯一答案。
//
// 有会话 id 的 agent 按 id 精确找；没有的（agy/cursor 启动时拿不到 id）按
// “这一格起来之后写的、还没被别的格认领的最新文件”找。找不到就返回空 ——
// 右栏空着是诚实的，接错文件才是错的。
func TranscriptFor(tabID int, id, cwd, sessionID string, startedAt time.Time) Found {
	switch id {
	case "", "claude", "opencode":
		// Claude 的路径来自 hook（SessionStart）；OpenCode 从 HTTP 推送。
		return Found{}
	case "codex":
		if p := codexSessionPath(cwd, sessionID); p != "" {
			return Found{Path: p}
		}
	case "pi":
		if p := piSessionPath(cwd, sessionID); p != "" {
			return Found{Path: p}
		}
	case "qoder":
		return findNewest(tabID, startedAt, qoderCandidates(cwd, sessionID), "")
	case "copilot":
		return findNewest(tabID, startedAt, copilotCandidates(cwd, sessionID), "")
	case "dsh":
		if p := dshSessionPath(cwd, sessionID); p != "" {
			return Found{Path: p, Format: "zstd"}
		}
	case "agy":
		return findNewest(tabID, startedAt, agyCandidates(), "")
	case "cursor":
		return findNewest(tabID, startedAt, cursorCandidates(cwd, sessionID), "")
	}
	return Found{}
}

func findNewest(tabID int, startedAt time.Time, paths []string, format string) Found {
	type cand struct {
		path string
		mod  time.Time
	}
	list := make([]cand, 0, len(paths))
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() {
			continue
		}
		// 这一格起来之前就停笔的文件不是它的。给 2s 余量：写文件和建格
		// 是两条腿，测试里见过“先写、后拿到 tab id”的先后差。
		if !startedAt.IsZero() && fi.ModTime().Before(startedAt.Add(-2*time.Second)) {
			continue
		}
		list = append(list, cand{p, fi.ModTime()})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].mod.After(list[j].mod) })
	for _, c := range list {
		if ClaimTranscript(tabID, c.path) {
			return Found{Path: c.path, Format: format}
		}
	}
	return Found{}
}

// agentHome 是 agent 写会话/转录文件的那个 home：所有 agent 都跑在用户
// 真实的主目录里，和启动时是同一份。
func agentHome() string {
	home, _ := os.UserHomeDir()
	return home
}

func globFiles(patterns ...string) []string {
	var out []string
	for _, pat := range patterns {
		m, err := filepath.Glob(pat)
		if err != nil {
			continue
		}
		out = append(out, m...)
	}
	return out
}

// codexSessionPath 精确按 thread id 找 rollout（实测：
// ~/.codex/sessions/<年>/<月>/<日>/rollout-<时间戳>-<id>.jsonl）。
func codexSessionPath(cwd, id string) string {
	if !SafeSessionID(id) {
		return ""
	}
	root := codexHome(cwd)
	if root == "" {
		return ""
	}
	m := globFiles(
		filepath.Join(root, "sessions", "*", "*", "*", "rollout-*-"+id+".jsonl"),
		filepath.Join(root, "archived_sessions", "rollout-*-"+id+".jsonl"),
		filepath.Join(root, "archived_sessions", "*", "rollout-*-"+id+".jsonl"),
	)
	if len(m) == 0 {
		return ""
	}
	sort.Strings(m)
	return m[len(m)-1]
}

// piSessionPath 精确按 session id 找（<root>/<项目 slug>/<时间戳>_<id>.jsonl）。
func piSessionPath(cwd, id string) string {
	if !SafeSessionID(id) {
		return ""
	}
	root := piSessionRoot(cwd)
	if root == "" {
		return ""
	}
	m := globFiles(filepath.Join(root, "*", "*_"+id+".jsonl"))
	if len(m) == 0 {
		return ""
	}
	sort.Strings(m)
	return m[len(m)-1]
}

func qoderCandidates(cwd, id string) []string {
	home := agentHome()
	if home == "" {
		return nil
	}
	if SafeSessionID(id) {
		return globFiles(
			filepath.Join(home, ".qoder", "projects", "*", id+".jsonl"),
			filepath.Join(home, ".qoder-cn", "projects", "*", id+".jsonl"),
		)
	}
	// 还没有 session id：只在这个 cwd 的项目目录里找（qoder 的 slug 和
	// Claude 一样，把 : 和 \ 都换成 -）。
	slug := pathSlug(cwd, true)
	return globFiles(
		filepath.Join(home, ".qoder", "projects", slug, "*.jsonl"),
		filepath.Join(home, ".qoder-cn", "projects", slug, "*.jsonl"),
	)
}

func copilotCandidates(cwd, id string) []string {
	home := agentHome()
	if home == "" {
		return nil
	}
	root := filepath.Join(home, ".copilot", "session-state")
	if SafeSessionID(id) {
		return []string{filepath.Join(root, id, "events.jsonl")}
	}
	return globFiles(filepath.Join(root, "*", "events.jsonl"))
}

func dshSessionPath(cwd, id string) string {
	if !SafeSessionID(id) {
		return ""
	}
	home := agentHome()
	if home == "" {
		return ""
	}
	m := globFiles(filepath.Join(home, ".dsh", "sessions", "*", id, "session.v4.jsonl.zstd"))
	if len(m) == 0 {
		return ""
	}
	return m[0]
}

func agyCandidates() []string {
	home := agentHome()
	if home == "" {
		return nil
	}
	root := filepath.Join(home, ".gemini", "antigravity-cli", "brain")
	// 同一会话有两个文件；transcript_full 更完整。两个都列出来，按 mtime 选。
	return globFiles(
		filepath.Join(root, "*", ".system_generated", "logs", "transcript_full.jsonl"),
		filepath.Join(root, "*", ".system_generated", "logs", "transcript.jsonl"),
	)
}

func cursorCandidates(cwd, id string) []string {
	homes := []string{agentHome()}
	if real, err := os.UserHomeDir(); err == nil && real != homes[0] {
		homes = append(homes, real)
	}
	var out []string
	slug := pathSlug(cwd, false)
	for _, home := range homes {
		if home == "" {
			continue
		}
		root := filepath.Join(home, ".cursor", "projects")
		if SafeSessionID(id) {
			out = append(out, globFiles(filepath.Join(root, "*", "agent-transcripts", id, "*.jsonl"))...)
			continue
		}
		if slug != "" {
			out = append(out, globFiles(filepath.Join(root, slug, "agent-transcripts", "*", "*.jsonl"))...)
		}
		// 项目目录名和 cwd 的 slug 对不上时（Cursor 的编码改过版本），
		// 退回“所有项目”里找最新；认领机制会防止两格抢同一个。
		out = append(out, globFiles(filepath.Join(root, "*", "agent-transcripts", "*", "*.jsonl"))...)
	}
	return out
}

// pathSlug 把 cwd 变成各家的项目目录名：
//   - colonDash=true（Qoder/Claude）：`C:\a\b` → `C--a-b`
//   - colonDash=false（Cursor）：`C:\a\b` → `C-a-b`
func pathSlug(cwd string, colonDash bool) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	s := filepath.Clean(cwd)
	if colonDash {
		s = strings.ReplaceAll(s, ":", "-")
	} else {
		s = strings.ReplaceAll(s, ":", "")
	}
	s = strings.ReplaceAll(s, `\`, "-")
	s = strings.ReplaceAll(s, "/", "-")
	s = strings.Trim(s, "-")
	return s
}
