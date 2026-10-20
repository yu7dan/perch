package session

// ---------------------------------------------------------------------------
// 用户给会话起的名字
//
// Orca 把用户起的名字放在两处**内存态**里，都随工作区状态走、不与会话本身绑定：
//   - 标签的 customTitle（components/tab-bar/use-sortable-tab-rename.ts，
//     提交时调 onSetCustomTitle(tabId, trimmed | null)）
//   - 面板的 paneTitles（terminal-pane/use-terminal-pane-title-state.ts:26，
//     `useState<Record<number, string>>({})` —— 初值是空对象）
//
// 我们的形态不一样：**会话是我们长期的资产**（手上那些会话动辄上千轮），
// 名字理应跟着会话走 —— 换台机器、重开一次、从别的入口进来，它都该还在。
// 所以这里以 **sessionId 为键**落到状态目录下的 titles.json，
// 而不是挂在标签/面板这种"当前这一屏的摆设"上。
//
// 键用 sessionId 而不是 cwd 或标签序号：sessionId 是盘上 .jsonl 的文件名，
// 是两个 agent 都认的、稳定且唯一的标识。
// ---------------------------------------------------------------------------

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TitleStore 是 titles.json 的内存副本 + 落盘器。
type TitleStore struct {
	mu   sync.Mutex
	path string
	m    map[string]string
}

// LoadTitleStore 读一张已有的名字表。文件不存在是**正常路径**（第一次运行），
// 不是错误 —— 别在这里 log 一行看似失败的东西。
func LoadTitleStore(path string) *TitleStore {
	t := &TitleStore{path: path, m: map[string]string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return t
	}
	if err := json.Unmarshal(b, &t.m); err != nil {
		// 文件坏了就从空表开始，但要说出来 —— 否则"名字全没了"会变成一桩悬案。
		log.Printf("[title] %s 解析失败，从空表开始: %v", path, err)
		t.m = map[string]string{}
	}
	log.Printf("[title] 读到 %d 个会话名（%s）", len(t.m), path)
	return t
}

// Snapshot 返回名字表的一份副本。
func (t *TitleStore) Snapshot() map[string]string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]string, len(t.m))
	for k, v := range t.m {
		out[k] = v
	}
	return out
}

// Set 写入一个名字；name 为空 = **删掉**这个名字，让会话回到 agent 自己写的标题。
// （Orca 的语义：trim 后为空 → onSetCustomTitle(…, null) / removePaneTitle，
// 见 use-sortable-tab-rename.ts:38-41 与 use-terminal-pane-context-actions.ts:58-66。）
func (t *TitleStore) Set(sessionID, name string) error {
	name = strings.TrimSpace(name)
	t.mu.Lock()
	defer t.mu.Unlock()
	if name == "" {
		if _, ok := t.m[sessionID]; !ok {
			return nil // 本来就没名字，不用写盘
		}
		delete(t.m, sessionID)
	} else {
		if t.m[sessionID] == name {
			return nil // 没变，别白白写盘
		}
		t.m[sessionID] = name
	}
	// 先写临时文件再改名：直接覆盖的话，写一半断电/被杀，下次启动
	// **整张表**都会被那个半个 JSON 判为坏文件丢掉，而不是只丢一条。
	b, err := json.MarshalIndent(t.m, "", "  ")
	if err != nil {
		return err
	}
	tmp := t.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, t.path)
}

// SessionIDForPID 反查「这个 pid 跑的是哪个会话」。
//
// 这是"名字跟着会话走"这条链子上唯一缺的一环，而它**只有我们这个形态**才需要：
// 标签和面板活在内存里，会话活在盘上，把两者接起来的只有 Claude 的实时登记表：
//
//	ConPTY 子进程 pid → <stateDir>\sessions\<pid>.json → sessionId
//
// 注意这里**没有**去猜、也没有去反解项目目录名（那是有损编码）——
// 只是读一个 pid 命名的文件。Pi 那边没有登记表，将来要用它自己的会话文件兜底。
func SessionIDForPID(stateDir string, pid int) string {
	p := filepath.Join(stateDir, "sessions", strconv.Itoa(pid)+".json")
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	var rec struct {
		SessionID string `json:"sessionId"`
		PID       int    `json:"pid"`
	}
	if err := json.Unmarshal(b, &rec); err != nil {
		return ""
	}
	return rec.SessionID
}

// ApplyRename 把「用户在标签上起的名字」落到它真正的主语 —— 会话 —— 上。
//
// pid→sessionId 的登记表**不是**在 PTY 一起来就有的：claude 自己要过一小会儿
// 才把它写出来。用户能点到重命名至少也是窗口起来之后，正常都在；但"正常都在"
// 不是"一定在"，所以这里给一个有界的重试，而不是一次查不到就丢掉用户输入。
const (
	renameResolveTries    = 6
	renameResolveInterval = 250 * time.Millisecond
)

func ApplyRename(stateDir string, titles *TitleStore, pid int, name string) {
	go func() {
		var sid string
		for i := 0; i < renameResolveTries; i++ {
			if sid = SessionIDForPID(stateDir, pid); sid != "" {
				break
			}
			time.Sleep(renameResolveInterval)
		}
		if sid == "" {
			log.Printf("[title] pid=%d 查不到会话（sessions\\%d.json 还没落盘），这个名字只留在标签上、没落盘",
				pid, pid)
			return
		}
		if err := titles.Set(sid, name); err != nil {
			log.Printf("[title] 写 titles.json 失败: %v", err)
			return
		}
		if strings.TrimSpace(name) == "" {
			log.Printf("[title] 会话 %s (pid=%d) 的名字已清除，回到 agent 自己写的标题", sid, pid)
		} else {
			log.Printf("[title] 会话 %s (pid=%d) 命名为 %q", sid, pid, strings.TrimSpace(name))
		}
	}()
}
