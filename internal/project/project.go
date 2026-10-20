// Package project 是用户声明的项目池，以及「默认工作区」这个合成条目。
//
// 三条设计口径（都是用户 2026-10-16 当面定的）：
//
//	① **池子是用户声明的**，落盘在 %APPDATA%\Perch\projects.json。
//	   ⚠️ 绝不写进 Claude 自己的状态根 —— 我们的东西进去就是把两家的状态搅在一起。
//	② **归属是自适应的**（"它属于哪个工作区就属于哪个工作区"）——
//	   会话的 cwd 落在哪个项目目录之下（含自身）就归谁，取**最长匹配**；
//	   谁都不匹配 → 前端把它摆在「未归类」那一组。**没有任何手工归类动作**。
//	③ **只有一层包含**：项目 ⊃ 会话。单机、没有 SSH 目标、也没有 git worktree
//	   的概念。留后路即可：哪天要"一个项目下挂多个签出"，在项目上再加一层。
//
// 这个包不 import 会话/设置 store：默认目录从注入的 `customCWD` 读，
// 归属统计（Stats/Wire/Audit）跟着会话类型走，等 history 落地后再进来。
package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yu7dan/perch/internal/appdir"
	"github.com/yu7dan/perch/internal/uimsg"
)

// Project 是**落盘的那份形状**。算出来的东西（最近活动、会话数）不在这里 ——
// 混在一起就会把算出来的数一并写进文件，那种文件谁都不敢读。
type Project struct {
	Path string `json:"path"` // 目录绝对路径，项目的身份
	// Name 是**显示名**：默认取目录名，用户可以改。改它只改显示，
	// 磁盘上那个目录一个字都不动（用户会以为改了名就跑偏，所以写清）。
	Name   string `json:"name"`
	Source string `json:"source"` // "manual"（手加） | "adopted"（从「未归类」收编）
	Pinned bool   `json:"pinned"`
	// Order 只在同一个区（置顶区 / 自然区）里用手排。没有手排过的一律 0，
	// 于是自然区里就按"最近活动"排 —— 不维护一份会过期的顺序。
	Order   int    `json:"order"`
	AddedAt string `json:"addedAt"`
}

const (
	// SourceSynthetic 是合成的池子条目的 Source。落盘那份只会有 "manual" /
	// "adopted"，所以这个值同时是"这一条是合成出来的"的判据。
	SourceSynthetic = "synthetic"
	DefaultWSName   = "默认工作区"
	FileName        = "projects.json"
)

// Pool 是 projects.json 的持有者。零值不可用；用 Load 构造。
type Pool struct {
	mu       sync.Mutex
	file     string
	Projects []Project `json:"projects"`
	Roots    []string  `json:"roots"`
	// broken = "文件在、但解析不了"。这种情况下**一次都不许覆盖** ——
	// 池子是用户一个个手加出来的，一次坏写就全没了，比"报错"难看得多。
	broken bool
}

func filePath() (string, error) {
	return appdir.PerchFile(FileName)
}

// PathKey 是路径的**比较键**：Windows 上大小写不敏感、分隔符与 `.`/`..` 要先归一。
// 所有"这两个路径是不是同一个目录"的判断都必须走它 —— 直接比字符串会在
// `D:\a\b\` 与 `D:\A\B` 这种地方静默判成两个。
func PathKey(p string) string {
	return strings.ToLower(filepath.Clean(strings.TrimSpace(p)))
}

// ParseTS 宽松地解析时间戳。会话的 Updated 有两个来源（文件 mtime 与
// transcript 里的事件时间戳），精度不一样，所以按三种 layout 依次试。
func ParseTS(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

// Load 读项目池。拿不到配置目录时返回一份只读的空池（Roots 仍取主目录）。
func Load() *Pool {
	// Roots 是"去哪儿找项目"的起点（目前只随载荷一起发出去，前端还没有消费它）。
	// 默认取用户主目录 —— 不写死任何本机路径。
	p := &Pool{}
	if home, err := appdir.Home(); err == nil {
		p.Roots = []string{home}
	}
	f, err := filePath()
	if err != nil {
		log.Printf("[pool] 拿不到用户配置目录，池子这轮当作只读：%v", err)
		return p
	}
	p.file = f

	b, err := os.ReadFile(f)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("[pool] 读池子失败（当作空的，但**先不写**）：%v", err)
			p.broken = true
			return p
		}
		log.Printf("[pool] 还没有池子，先按空的来（第一次写入会建 %s）", f)
		return p
	}
	var disk struct {
		Projects []Project `json:"projects"`
		Roots    []string  `json:"roots"`
	}
	if err := json.Unmarshal(b, &disk); err != nil {
		p.broken = true
		log.Printf("[pool] ⚠️ 池子文件解析失败，**保持原样、一次都不覆盖**：%s（%v）", f, err)
		return p
	}
	if len(disk.Roots) > 0 {
		p.Roots = disk.Roots
	}
	p.Projects = disk.Projects
	log.Printf("[pool] 载入 %d 个项目 / %d 个根（%s）", len(p.Projects), len(p.Roots), f)
	return p
}

// saveLocked 必须持锁调用。原子写：先写 .tmp 再 rename ——
// 半截文件比旧文件糟得多，而 AppData 下的写随时可能被 AV / 同步工具撞上。
func (p *Pool) saveLocked() error {
	if p.broken {
		return uimsg.New("project.broken", "池子文件解析失败过，拒绝覆盖它")
	}
	if p.file == "" {
		return uimsg.New("project.noFile", "不知道池子写哪儿")
	}
	if err := os.MkdirAll(filepath.Dir(p.file), 0o755); err != nil {
		return saveFailed(err)
	}
	b, err := json.MarshalIndent(struct {
		Projects []Project `json:"projects"`
		Roots    []string  `json:"roots"`
	}{p.Projects, p.Roots}, "", "  ")
	if err != nil {
		return saveFailed(err)
	}
	b = append(b, '\n')
	tmp := p.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return saveFailed(err)
	}
	if err := os.Rename(tmp, p.file); err != nil {
		return saveFailed(err)
	}
	return nil
}

// saveFailed 把底层写盘错误包成带稳定 code 的消息；原文（通常是 OS 的
// 本地化错误）作为 params 一起带过去，前端拼进当前语言的句子里。
func saveFailed(err error) error {
	return uimsg.Wrap(err, "project.saveFailed", fmt.Sprintf("项目池没写成：%v", err),
		map[string]string{"err": err.Error()})
}

// Snapshot 返回项目与根的副本。
func (p *Pool) Snapshot() ([]Project, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Project, len(p.Projects))
	copy(out, p.Projects)
	roots := make([]string, len(p.Roots))
	copy(roots, p.Roots)
	return out, roots
}

func (p *Pool) findLocked(path string) int {
	k := PathKey(path)
	for i, pr := range p.Projects {
		if PathKey(pr.Path) == k {
			return i
		}
	}
	return -1
}

// Add 把一个目录收进池子。返回 (项目, 是不是新加的, 错误)。
// 重复添加**不是错误**：用户拖了两次、或者两个入口撞上了，都不该报错，
// 但必须让他知道"它本来就在"（前端拿 added=false 去说这句话）。
func (p *Pool) Add(path, name, source string) (Project, bool, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Project{}, false, uimsg.New("project.emptyPath", "空路径")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return Project{}, false, uimsg.Wrap(err, "project.badPath",
			fmt.Sprintf("这个路径看不懂：%v", err), map[string]string{"err": err.Error()})
	}
	if st, err := os.Stat(abs); err != nil {
		return Project{}, false, uimsg.Wrap(err, "project.unreadable",
			fmt.Sprintf("这个路径读不到：%v", err), map[string]string{"err": err.Error()})
	} else if !st.IsDir() {
		return Project{}, false, uimsg.New("project.notDir", "不是目录")
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(abs)
	}
	if source == "" {
		source = "manual"
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if i := p.findLocked(abs); i >= 0 {
		return p.Projects[i], false, nil
	}
	pr := Project{
		Path:    abs,
		Name:    name,
		Source:  source,
		AddedAt: time.Now().UTC().Format(time.RFC3339),
	}
	p.Projects = append(p.Projects, pr)
	if err := p.saveLocked(); err != nil {
		// 落盘失败就把内存也退回去：一个只活在内存里的池子，重开就没了，
		// 留着它只会让"刚才明明加上了"这件事变成谎话。
		p.Projects = p.Projects[:len(p.Projects)-1]
		return Project{}, false, err
	}
	return pr, true, nil
}

// Remove 只把项目**从池子里摘掉**，磁盘上一个字节都不动。
// （"删除到回收站"是另一个动作 —— 两者绝不能合成一个按钮。）
func (p *Pool) Remove(path string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(path)
	if i < 0 {
		return false, nil
	}
	gone := p.Projects[i]
	p.Projects = append(p.Projects[:i], p.Projects[i+1:]...)
	if err := p.saveLocked(); err != nil {
		p.Projects = append(p.Projects, Project{})
		copy(p.Projects[i+1:], p.Projects[i:])
		p.Projects[i] = gone
		return false, err
	}
	return true, nil
}

// SetPinned 切换置顶。
func (p *Pool) SetPinned(path string, on bool) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(path)
	if i < 0 {
		return false, nil
	}
	prev := p.Projects[i].Pinned
	p.Projects[i].Pinned = on
	if err := p.saveLocked(); err != nil {
		p.Projects[i].Pinned = prev
		return false, err
	}
	return true, nil
}

// Rename 改的是**显示名**。名字为空 = 恢复成目录名（这样"改回去"不需要用户
// 自己记得原来的目录名是什么）。
func (p *Pool) Rename(path, name string) (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := p.findLocked(path)
	if i < 0 {
		return false, nil
	}
	prev := p.Projects[i].Name
	if strings.TrimSpace(name) == "" {
		p.Projects[i].Name = filepath.Base(p.Projects[i].Path)
	} else {
		p.Projects[i].Name = strings.TrimSpace(name)
	}
	if err := p.saveLocked(); err != nil {
		p.Projects[i].Name = prev
		return false, err
	}
	return true, nil
}

// ---------------------------------------------------------------------------
// 默认工作区（Go 合成的，不进 projects.json）
//
// 用户的原话是"安装即存在、有不使用但必须有、删除只提示不阻拦"，像 Claude /
// Codex 桌面端各有一个不挂在任何项目下的默认落点。三条要求翻译成三条实现：
//   · 安装即存在 → 代码里就有（合成），不依赖任何一次写盘；
//   · 删不掉     → 它根本不在池子里，没有可删的记录（前端那颗「从列表移除」做灰）；
//   · 必须有     → 它永远是最后一行，新格没指定目录时也落在它这里。
//
// `customCWD` 是注入的"设置里的默认目录"。空串或目录此刻不在盘上时回落到内置
// 的 <用户主目录>\Documents\Perch。
// ---------------------------------------------------------------------------

// DefaultWorkspacePath 给出默认工作区**当前生效**的绝对路径。
// 第二返回值 false = 连内置路径都拿不到（用户主目录不可用），调用方一律按
// "没有它"处理。
func DefaultWorkspacePath(customCWD func() string) (string, bool) {
	if customCWD != nil {
		if p := strings.TrimSpace(customCWD()); p != "" {
			if fi, err := os.Stat(p); err == nil && fi.IsDir() {
				return p, true
			}
			customWarnOnce.Do(func() {
				log.Printf("[pool] 设置里的默认目录现在不可用（%s），这一轮回落到内置目录（设置本身保留）", p)
			})
		}
	}
	return BuiltinDefaultWorkspacePath()
}

// BuiltinDefaultWorkspacePath 是不带任何设置时的内置落点。
// 设置页的「恢复默认」和自定义目录失效时的回落都读它。
func BuiltinDefaultWorkspacePath() (string, bool) {
	p, ok := appdir.BuiltinDefaultWorkspace()
	if !ok {
		log.Printf("[pool] 默认工作区：拿不到用户主目录，这一轮不合成")
	}
	return p, ok
}

// 自定义默认目录不可用这件事会出现在每次调用里，只记一次 ——
// 它可能在挂上网络盘之后自己恢复，别把日志刷满。
var customWarnOnce sync.Once

// DefaultWorkspaceCWD 是「新格没指定目录时落在哪」。空串 = 拿不到，调用方退回
// 原来的默认目录（那种情况下少一个默认落点，不能连格都起不来）。
func DefaultWorkspaceCWD(customCWD func() string) string {
	p, ok := DefaultWorkspacePath(customCWD)
	if !ok {
		return ""
	}
	return p
}

// EnsureDefaultWorkspace 让那个目录真的存在 —— "安装即存在"要落到文件系统上，
// 否则新格落在它这里时 agent 会因为 cwd 不存在直接起不来。
// 建不出来**不拦任何事**（照旧没有这个落点而已），只记账。
func EnsureDefaultWorkspace(customCWD func() string) {
	path, ok := DefaultWorkspacePath(customCWD)
	if !ok {
		return
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		log.Printf("[pool] 默认工作区目录建不出来 path=%s err=%v（新格会落在别处，不拦）", path, err)
		return
	}
	log.Printf("[pool] 默认工作区 path=%s（合成的，不在 projects.json 里）", path)
}

// WithDefaultWorkspace 把合成的默认工作区并进这份池子**副本**里。
// 用户自己把同一个目录加进池子了就以他那条为准（那样它能改名、能移除 ——
// 是他自己加的东西，凭什么不让他动）。
func WithDefaultWorkspace(projects []Project, customCWD func() string) []Project {
	path, ok := DefaultWorkspacePath(customCWD)
	if !ok {
		return projects
	}
	for _, p := range projects {
		if PathKey(p.Path) == PathKey(path) {
			return projects
		}
	}
	out := make([]Project, 0, len(projects)+1)
	out = append(out, projects...)
	// ⚠️ 这一条**只是内存里的一份**：Snapshot() 的返回值，不是池子本身 ——
	// 谁都不许把它写回 projects.json（saveLocked 只写 Pool.Projects）。
	out = append(out, Project{Path: path, Name: DefaultWSName, Source: SourceSynthetic})
	return out
}
