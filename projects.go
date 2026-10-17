package main

// ---------------------------------------------------------------------------
// 项目池（左栏那一轮 · L1）
//
// 这个产品的主角从"会话"换成了"项目"：用户在盘上指一个目录，那个目录成为
// 一个**项目**（左栏里的一行工作区），跑在它下面的会话自动归到它名下。
//
// 三条设计口径（都是用户 2026-10-16 当面定的）：
//
//	① **池子是用户声明的**，落盘在 %APPDATA%\Perch\projects.json。
//	   ⚠️ 绝不写进 Claude 自己的状态根（`claudeStateDir`）——
//	   我们的东西进去就是把两家的状态搅在一起。
//	② **归属是自适应的**（用户原话意的："它属于哪个工作区就属于哪个工作区"）——
//	   会话的 cwd 落在哪个项目目录之下（含自身）就归谁，取**最长匹配**；
//	   谁都不匹配 → 前端把它摆在「未归类」那一组。**没有任何手工归类动作**。
//	③ **只有一层包含**：项目 ⊃ 会话。Orca 那五层（Repo / Project /
//	   ProjectHostSetup / ProjectGroup / FolderWorkspace）里没有一层的对应物 ——
//	   我们单机、没有 SSH 目标、也没有 git worktree 的概念。留后路即可：
//	   哪天要"一个项目下挂多个签出"，在项目上再加一层，会话那一层不动。
//
// 与 Orca 的对照（那边怎么做的、我们抄了哪条）：见计划书 quiet-perching-twig.md
// 的「参考事实」。一句话 —— 池子 + 发现后确认是它的路子，我们照搬；但它的
// "移除只从列表摘掉、绝不碰磁盘"我们拆成了两个动作（移除 / 删除到回收站）。
// ---------------------------------------------------------------------------

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Project 是**落盘的那份形状**。算出来的东西（最近活动、会话数）不在这里 ——
// 见 projectWire。混在一起就会把算出来的数一并写进文件，那种文件谁都不敢读。
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

// projectWire 是**发给前端的那份**：落盘字段 + 算出来的两个数。
// 用嵌入而不是复制字段，是为了"落盘形状改了、wire 忘了改"这件事不可能发生。
type projectWire struct {
	Project
	Recent string `json:"recent"` // 组内最新活动（RFC3339，空 = 还没跑过）
	Count  int    `json:"count"`  // 主会话数（子代理不算 —— 那是派生出来的）
	// Synthetic = 「默认工作区」（见 defaultWorkspacePath）。
	// ⚠️ 这个字段**不在落盘的 Project 上**，因为合成的那个**从不落盘** ——
	// 它要是也写进 projects.json，"删不掉"就变成了"删了下次又回来"，
	// 而且用户手加的那个同名目录会和我们合成的那份打架（两份记录、一个路径）。
	// 所以它只活在这条 wire 上：前端只拿它决定"这一行不做改名/移除"。
	Synthetic bool `json:"synthetic,omitempty"`
}

// ---------------------------------------------------------------------------
// 默认工作区（Go 合成的，不进 projects.json）
//
// 用户的原话是"安装即存在、有不使用但必须有、删除只提示不阻拦"，像 Claude /
// Codex 桌面端各有一个不挂在任何项目下的默认落点。三条要求翻译成三条实现：
//   · 安装即存在 → 代码里就有（合成），不依赖任何一次写盘；
//   · 删不掉     → 它根本不在池子里，没有可删的记录（前端那颗「从列表移除」做灰）；
//   · 必须有     → 它永远是最后一行，新格没指定目录时也落在它这里。
// ---------------------------------------------------------------------------

const (
	// 合成的池子条目的 Source。落盘那份只会有 "manual" / "adopted"，
	// 所以这个值同时是"这一条是合成出来的"的判据（wireProjects 就靠它盖 Synthetic）。
	sourceSynthetic = "synthetic"
	defaultWSName   = "默认工作区"
	// <用户主目录>\Documents\Perch。
	// ⚠️ 中文 Windows 上资源管理器把 Documents 显示成「文档」，但**真实目录名仍是
	// Documents**（那个显示名在 desktop.ini 里，文件系统上没有"文档"这个目录）——
	// 拼"文档"会建出一个谁也看不见的新目录。
	defaultWSDir = "Perch"
)

// defaultWorkspacePath 给出默认工作区的绝对路径。
// 第二返回值 false = 拿不到用户主目录（连合成都不做），调用方一律按"没有它"处理。
func defaultWorkspacePath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		log.Printf("[pool] 默认工作区：拿不到用户主目录（err=%v），这一轮不合成", err)
		return "", false
	}
	return filepath.Join(home, "Documents", defaultWSDir), true
}

// defaultWorkspaceCWD 是「新格没指定目录时落在哪」。空串 = 拿不到，调用方退回原来的
// 默认目录（那种情况下少一个默认落点，不能连格都起不来）。
func defaultWorkspaceCWD() string {
	p, ok := defaultWorkspacePath()
	if !ok {
		return ""
	}
	return p
}

// ensureDefaultWorkspace 让那个目录真的存在 —— "安装即存在"要落到文件系统上，
// 否则新格落在它这里时 claude 会因为 cwd 不存在直接起不来。
// 建不出来**不拦任何事**（照旧没有这个落点而已），只记账。
func ensureDefaultWorkspace() {
	path, ok := defaultWorkspacePath()
	if !ok {
		return
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		log.Printf("[pool] 默认工作区目录建不出来 path=%s err=%v（新格会落在别处，不拦）", path, err)
		return
	}
	log.Printf("[pool] 默认工作区 path=%s（合成的，不在 projects.json 里）", path)
}

// withDefaultWorkspace 把合成的默认工作区并进这份池子**副本**里。
// 用户自己把同一个目录加进池子了就以他那条为准（那样它能改名、能移除 ——
// 是他自己加的东西，凭什么不让他动）。
func withDefaultWorkspace(projects []Project) []Project {
	path, ok := defaultWorkspacePath()
	if !ok {
		return projects
	}
	for _, p := range projects {
		if pathKey(p.Path) == pathKey(path) {
			return projects
		}
	}
	out := make([]Project, 0, len(projects)+1)
	out = append(out, projects...)
	// ⚠️ 这一条**只是内存里的一份**：snapshot() 的返回值,不是池子本身 ——
	// 谁都不许把它写回 projects.json（saveLocked 只写 pool.Projects）。
	out = append(out, Project{Path: path, Name: defaultWSName, Source: sourceSynthetic})
	return out
}

type projectPool struct {
	mu       sync.Mutex
	file     string
	Projects []Project `json:"projects"`
	Roots    []string  `json:"roots"`
	// broken = "文件在、但解析不了"。这种情况下**一次都不许覆盖** ——
	// 池子是用户一个个手加出来的，一次坏写就全没了，比"报错"难看得多。
	broken bool
}

const (
	poolDirName  = "Perch"
	poolFileName = "projects.json"
)

func poolFilePath() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, poolDirName, poolFileName), nil
}

// pathKey 是路径的**比较键**：Windows 上大小写不敏感、分隔符与 `.`/`..` 要先归一。
// 所有"这两个路径是不是同一个目录"的判断都必须走它 —— 直接比字符串会在
// `D:\a\b\` 与 `D:\A\B` 这种地方静默判成两个。
func pathKey(p string) string {
	return strings.ToLower(filepath.Clean(strings.TrimSpace(p)))
}

// parseTS 宽松地解析时间戳。会话的 Updated 有两个来源（文件 mtime 与
// transcript 里的事件时间戳），精度不一样，所以按三种 layout 依次试。
func parseTS(s string) time.Time {
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

func loadProjectPool() *projectPool {
	// Roots 是"去哪儿找项目"的起点（目前只随载荷一起发出去，前端还没有消费它）。
	// 默认取用户主目录 —— 不写死任何本机路径。
	p := &projectPool{}
	if home, err := os.UserHomeDir(); err == nil {
		p.Roots = []string{home}
	}
	f, err := poolFilePath()
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
func (p *projectPool) saveLocked() error {
	if p.broken {
		return errors.New("池子文件解析失败过，拒绝覆盖它")
	}
	if p.file == "" {
		return errors.New("不知道池子写哪儿")
	}
	if err := os.MkdirAll(filepath.Dir(p.file), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(struct {
		Projects []Project `json:"projects"`
		Roots    []string  `json:"roots"`
	}{p.Projects, p.Roots}, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := p.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p.file)
}

func (p *projectPool) snapshot() ([]Project, []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Project, len(p.Projects))
	copy(out, p.Projects)
	roots := make([]string, len(p.Roots))
	copy(roots, p.Roots)
	return out, roots
}

func (p *projectPool) findLocked(path string) int {
	k := pathKey(path)
	for i, pr := range p.Projects {
		if pathKey(pr.Path) == k {
			return i
		}
	}
	return -1
}

// add 把一个目录收进池子。返回 (项目, 是不是新加的, 错误)。
// 重复添加**不是错误**：用户拖了两次、或者两个入口撞上了，都不该报错，
// 但必须让他知道"它本来就在"（前端拿 added=false 去说这句话）。
func (p *projectPool) add(path, name, source string) (Project, bool, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return Project{}, false, errors.New("空路径")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return Project{}, false, err
	}
	if st, err := os.Stat(abs); err != nil {
		return Project{}, false, fmt.Errorf("这个路径读不到：%v", err)
	} else if !st.IsDir() {
		return Project{}, false, errors.New("不是目录")
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

// remove 只把项目**从池子里摘掉**，磁盘上一个字节都不动。
// （"删除到回收站"是另一个动作，见计划书 L2 —— 两者绝不能合成一个按钮。）
func (p *projectPool) remove(path string) (bool, error) {
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

func (p *projectPool) setPinned(path string, on bool) (bool, error) {
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

// rename 改的是**显示名**。名字为空 = 恢复成目录名（这样"改回去"不需要用户
// 自己记得原来的目录名是什么）。
func (p *projectPool) rename(path, name string) (bool, error) {
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
// 归属与排序：都从**同一遍**遍历里出来
// ---------------------------------------------------------------------------

// projectStats 一趟算完三件事：
//
//	assign  会话 id → 项目路径（不在表里的 = 未归类，前端摆到最后那一组）
//	recent  项目路径 → 组内最新活动时间（排序用）
//	count   项目路径 → 主会话数（子代理不算）
//
// 为什么必须一趟：三件事的归属判定是同一条规则（最长前缀匹配），
// 分三处写迟早会漂 —— 那样就会出现"这张卡显示在工作区 A 下、却算进了 B 的计数"。
func projectStats(sessions []Session, projects []Project) (map[string]string, map[string]time.Time, map[string]int) {
	type entry struct{ key, path string }
	// 先按路径长度倒序：第一个命中的就是最长匹配（`D:\w\a\b` 应该盖过 `D:\w\a`）
	keys := make([]entry, 0, len(projects))
	for _, pr := range projects {
		keys = append(keys, entry{pathKey(pr.Path), pr.Path})
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i].key) > len(keys[j].key) })

	assign := make(map[string]string, len(sessions))
	recent := make(map[string]time.Time, len(keys))
	count := make(map[string]int, len(keys))
	for _, s := range sessions {
		if s.Cwd == "" {
			continue
		}
		ck := pathKey(s.Cwd)
		for _, e := range keys {
			// 相等，或者落在它**下面**（必须带分隔符：`D:\w\ab` 不是 `D:\w\a` 的子目录，
			// 少了这个 `\` 就会把兄弟目录的会话算进来 —— 那种错很难看出来）。
			if ck != e.key && !strings.HasPrefix(ck, e.key+`\`) {
				continue
			}
			assign[s.ID] = e.path
			if t := parseTS(s.Updated); t.After(recent[e.path]) {
				recent[e.path] = t
			}
			if !s.Sidechain {
				count[e.path]++
			}
			break
		}
	}
	return assign, recent, count
}

// poolAudit 量那条不变量：**Σ各项目 + 未归类 == 主会话总数**。
//
// 为什么值得单独一个函数：这条等式要在**每一处**把池子推给前端的地方都成立
// （启动那份全量载荷、每次池子操作后的推回），两处各写一遍迟早会漂 —— 而它
// 一旦漂了就是"某条会话在界面上根本不存在"那种看不见的错。所以判据一处，
// 量出来的四个数也由这里一并给出，调用方只负责打印。
//
// ⚠️ 等式右边是**主会话**（子代理已排除），左边那三项也都是主会话口径。
// `assign` 这个 map 是**含**子代理的（它们的 cwd 也在场），别拿 len(assign) 去对。
func poolAudit(sessions []Session, assign map[string]string, wire []projectWire) (sum, nUn, nMain, nAll int) {
	nAll = len(sessions)
	for _, s := range sessions {
		if s.Sidechain {
			continue
		}
		nMain++
		if _, ok := assign[s.ID]; !ok {
			nUn++
		}
	}
	for _, w := range wire {
		sum += w.Count
	}
	return
}

// wireProjects 排出前端要的顺序：**置顶区永远在最前**（照 Orca 的 Pinned 分区
// `unshift` 到最前，build-rows.ts:138-143），其余按组内最近活动倒序，
// 没有活动就退回落盘时间；**合成的默认工作区永远排最后**（见下面那段）。
//
// 刻意不持久化"最近"这张表：两个参考实现都是现算的（Orca 的注释原话
// `Recent must be timestamp-based, not encounter order`），存下来只会多一个
// 会和事实不一致的东西。
func wireProjects(projects []Project, recent map[string]time.Time, count map[string]int) []projectWire {
	out := make([]projectWire, 0, len(projects))
	for _, pr := range projects {
		w := projectWire{Project: pr, Count: count[pr.Path], Synthetic: pr.Source == sourceSynthetic}
		if t := recent[pr.Path]; !t.IsZero() {
			w.Recent = t.UTC().Format(time.RFC3339)
		}
		out = append(out, w)
	}
	rank := func(w projectWire) time.Time {
		if t := parseTS(w.Recent); !t.IsZero() {
			return t
		}
		return parseTS(w.AddedAt)
	}
	/* 合成的默认工作区**先摘出来，排完再追加** —— 它就是最后一行。
	   为什么不参与排序：它不是一个用户攒出来的"项目"，而是"没归到别处的东西"的
	   落点（前端也把它画成末尾那一行、未归类那组紧跟在它下面）。让它跟着
	   "最近活动"在列表里上下跳，会让"未归类"那一组跟着它一起跳 —— 而那一组
	   恰恰是"这里有个目录还没被收进池子"的提示，位置必须稳定。 */
	real := make([]projectWire, 0, len(out))
	syn := make([]projectWire, 0, 1)
	for _, w := range out {
		if w.Synthetic {
			syn = append(syn, w)
			continue
		}
		real = append(real, w)
	}
	out = real
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Pinned != b.Pinned {
			return a.Pinned // 置顶的先出来
		}
		if a.Pinned && b.Pinned {
			if a.Order != b.Order {
				return a.Order < b.Order
			}
			return strings.ToLower(a.Name) < strings.ToLower(b.Name)
		}
		ta, tb := rank(a), rank(b)
		if !ta.Equal(tb) {
			return ta.After(tb)
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return append(out, syn...)
}
