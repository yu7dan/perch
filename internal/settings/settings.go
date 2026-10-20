// Package settings 是 Perch 自己的偏好设置：落盘、归一化、增量修改。
//
// 这里只放**Perch 自己**的偏好：默认工作目录、终端外观、关窗/结束 agent 的
// 确认、启动落点。agent 自己的配置（模型、网关、权限…）一律不进来 ——
// 那是 magpie / agent 配置抽屉的事，两家的状态不能搅在一起。
//
// 落盘位置和项目池同一层：%APPDATA%\Perch\settings.json。
// 和 projects.json 一样走「先写 .tmp 再 rename」的原子写，并且**解析失败就
// 拒绝覆盖** —— 一份读不动的小配置不值得用一次坏写去换。
//
// ⚠️ 默认目录是**后端的事实**，不是前端的 localStorage：新格的实际 PTY cwd、
// 合成的「默认工作区」、状态栏都从这一份读。前端那份缓存只负责首帧和启动
// 落点，Go 的载荷一到就以 Go 为准。
//
// 这个包不 import project / gateway：设置只管自己的形状；"改了默认目录要
// 确保目录存在、重算池子"之类的编排属于上层。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/yu7dan/perch/internal/agentcatalog"
	"github.com/yu7dan/perch/internal/appdir"
)

const FileName = "settings.json"

// 字号的可选范围。设置页给的是 12–18 六档；这里夹住手改配置时的越界值，
// 不让人把终端弄成 2px 或 200px（xterm 在那种尺寸下会算出荒唐的列数）。
const (
	termFontSizeMin = 12
	termFontSizeMax = 18
)

// Settings 是**落盘的形状**，也是发给前端的形状。字段少、全是标量 ——
// 这种配置最怕"两边各有一份默认值"，所以默认值只在 Defaults 里写一次。
type Settings struct {
	// DefaultCWD 是用户选的默认工作目录；空串 = 用内置的
	// <用户主目录>\Documents\Perch。存的是**原始选择**，目录暂时不在盘上
	// （网络盘没挂、被删了）不抹掉它，只回落到内置目录并在设置页里说明。
	DefaultCWD string `json:"defaultCwd"`
	// TermFontSize 是终端字号；TermFontFamily 是 "cascadia" | "jetbrains"。
	TermFontSize   int    `json:"termFontSize"`
	TermFontFamily string `json:"termFontFamily"`
	// StartView 是下次启动先落在哪："dash" | "workspace"。
	StartView string `json:"startView"`
	// Language 是界面语言："auto"（跟随系统）| "en" | "zh"。只影响 Perch
	// 自己的 UI 文案，不碰 agent 输出，也不改 magpie 页面自己的语言。
	Language string `json:"language"`
	// DefaultAgent 是「新开一格」默认用谁；空 = 自动（优先有状态能力的已安装
	// agent）。存的是 agent id，不是名字 —— 名字会变，id 不会。
	DefaultAgent string `json:"defaultAgent"`
	// NewAgentShortcut 是应用内「新建格」的快捷键，规范形状如 "Ctrl+Alt+N"；
	// 空串 = 关闭。只收带 Ctrl/Alt 的组合（裸键会在终端里吃掉普通输入），
	// 主键只认 A-Z / 0-9 / F1-F12。录制器在前端，Go 这边再校一遍 ——
	// settings.json 是手改得动的，不能只信前端。
	NewAgentShortcut string `json:"newAgentShortcut"`
	// 两个确认默认**开**（Orca 的默认也是 false = 不跳过确认）：
	// 关窗会带走所有正在跑的 agent，结束 agent 会删掉它的座位记录。
	ConfirmClose    bool `json:"confirmClose"`
	ConfirmEndAgent bool `json:"confirmEndAgent"`
}

// Defaults 是全部默认值；任何其它地方都不许再写一份。
func Defaults() Settings {
	return Settings{
		TermFontSize:     14,
		TermFontFamily:   "cascadia",
		StartView:        "dash",
		Language:         "auto",
		NewAgentShortcut: "Ctrl+Alt+N",
		ConfirmClose:     true,
		ConfirmEndAgent:  true,
	}
}

// Normalize 把任何来源的值收进可接受的形状。空/非法值一律落回默认，
// 不报错 —— 一份手改坏了的配置不该让整个设置页打不开。
func (s Settings) Normalize() Settings {
	d := Defaults()
	s.DefaultCWD = filepath.Clean(strings.TrimSpace(s.DefaultCWD))
	if s.DefaultCWD == "." || s.DefaultCWD == "" {
		s.DefaultCWD = ""
	}
	if s.TermFontSize < termFontSizeMin || s.TermFontSize > termFontSizeMax {
		s.TermFontSize = d.TermFontSize
	}
	switch strings.ToLower(strings.TrimSpace(s.TermFontFamily)) {
	case "cascadia":
		s.TermFontFamily = "cascadia"
	case "jetbrains", "jetbrains-mono", "jetbrainsmono":
		s.TermFontFamily = "jetbrains"
	default:
		s.TermFontFamily = d.TermFontFamily
	}
	switch strings.ToLower(strings.TrimSpace(s.StartView)) {
	case "workspace":
		s.StartView = "workspace"
	case "dash":
		s.StartView = "dash"
	default:
		s.StartView = d.StartView
	}
	// 语言只收 auto/en/zh；旧设置文件没有这个字段时落回 auto（跟随系统）。
	switch strings.ToLower(strings.TrimSpace(s.Language)) {
	case "auto":
		s.Language = "auto"
	case "en":
		s.Language = "en"
	case "zh":
		s.Language = "zh"
	default:
		s.Language = d.Language
	}
	// 只认能启动的 agent id。空串是合法值 = 自动；认不出的（手改配置/卸载了）
	// 落回自动 —— 别把一个不存在的 agent 当成“设置过”。
	//
	// ⚠️ 用静态 Has()，不调 agentcatalog.Defs()：加载设置绝不能触发 Host/Exe
	// 探测，否则设置就成了启动顺序的隐式依赖。
	s.DefaultAgent = strings.ToLower(strings.TrimSpace(s.DefaultAgent))
	if s.DefaultAgent != "" && !agentcatalog.Has(s.DefaultAgent) {
		s.DefaultAgent = ""
	}
	// 快捷键：能规范化就规范化，规范化不了就**关掉**（不落回默认键 ——
	// 一个手改坏的字符串不该悄悄变成一个会吃终端按键的组合键）。
	if v, ok := NormalizeShortcut(s.NewAgentShortcut); ok {
		s.NewAgentShortcut = v
	} else {
		s.NewAgentShortcut = ""
	}
	return s
}

// shortcutKeyPattern 是主键的白名单：字母、数字、F1-F12。
// 故意不收空格/方向键/Tab/Enter：那些是终端的日常输入，壳层不该抢。
var shortcutKeyPattern = regexp.MustCompile(`^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$`)

// NormalizeShortcut 把快捷键收成规范形状（修饰键 Ctrl→Alt→Shift，主键大写）。
// 空串是合法值 = 关闭；其余不合法的返回 ok=false，由调用方决定怎么落。
func NormalizeShortcut(raw string) (string, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", true
	}
	parts := strings.Split(s, "+")
	if len(parts) < 2 {
		return "", false
	}
	key := strings.ToUpper(strings.TrimSpace(parts[len(parts)-1]))
	if !shortcutKeyPattern.MatchString(key) {
		return "", false
	}
	mods := map[string]bool{}
	for _, p := range parts[:len(parts)-1] {
		var m string
		switch strings.ToLower(strings.TrimSpace(p)) {
		case "ctrl":
			m = "Ctrl"
		case "alt":
			m = "Alt"
		case "shift":
			m = "Shift"
		default:
			return "", false
		}
		if mods[m] { // "Ctrl+Ctrl+N" 这种重复修饰键也不收
			return "", false
		}
		mods[m] = true
	}
	if !mods["Ctrl"] && !mods["Alt"] {
		return "", false
	}
	out := make([]string, 0, 4)
	for _, m := range []string{"Ctrl", "Alt", "Shift"} {
		if mods[m] {
			out = append(out, m)
		}
	}
	out = append(out, key)
	return strings.Join(out, "+"), true
}

// Patch 是 ctl 的 "settings.set" 带来的增量。指针 = "这条请求有没有
// 提到这个字段"：false / 0 / 空串都是**合法值**，不能用零值判断缺省。
type Patch struct {
	DefaultCWD       *string `json:"defaultCwd,omitempty"`
	TermFontSize     *int    `json:"termFontSize,omitempty"`
	TermFontFamily   *string `json:"termFontFamily,omitempty"`
	StartView        *string `json:"startView,omitempty"`
	Language         *string `json:"language,omitempty"`
	DefaultAgent     *string `json:"defaultAgent,omitempty"`
	NewAgentShortcut *string `json:"newAgentShortcut,omitempty"`
	ConfirmClose     *bool   `json:"confirmClose,omitempty"`
	ConfirmEndAgent  *bool   `json:"confirmEndAgent,omitempty"`
}

// Empty 表示这条请求什么都没提。
func (p Patch) Empty() bool {
	return p.DefaultCWD == nil && p.TermFontSize == nil && p.TermFontFamily == nil &&
		p.StartView == nil && p.Language == nil && p.DefaultAgent == nil &&
		p.NewAgentShortcut == nil && p.ConfirmClose == nil && p.ConfirmEndAgent == nil
}

// Store 是设置文件的持有者。零值不可用；用 Load 构造。
type Store struct {
	mu     sync.Mutex
	file   string
	cur    Settings
	broken bool // 文件在、但解析不了：一次都不许覆盖
}

// Load 读设置文件。拿不到配置目录、文件不存在、解析失败都有各自的落点：
// 前两种退回默认（并在第一次改动时创建），解析失败则内存保持默认但
// **永远不许覆盖**盘上那份。
func Load() *Store {
	s := &Store{cur: Defaults()}
	f, err := filePath()
	if err != nil {
		log.Printf("[settings] 拿不到用户配置目录，设置这轮只活在内存里：%v", err)
		return s
	}
	s.file = f
	b, err := os.ReadFile(f)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.broken = true
			log.Printf("[settings] ⚠️ 读设置失败（保持原样、不覆盖）：%s（%v）", f, err)
			return s
		}
		log.Printf("[settings] 还没有设置文件，用默认值（第一次改动会建 %s）", f)
		return s
	}
	// 先在默认值上解：文件里缺的字段自动保留默认（尤其是两个默认为 true 的确认）。
	cur := Defaults()
	if err := json.Unmarshal(b, &cur); err != nil {
		s.broken = true
		log.Printf("[settings] ⚠️ 设置文件解析失败，**保持原样、一次都不覆盖**：%s（%v）", f, err)
		return s
	}
	cur = cur.Normalize()
	s.cur = cur
	log.Printf("[settings] 载入：默认目录=%s 字号=%d 字体=%s 启动=%s 默认 agent=%s 快捷键=%s 关窗确认=%v 结束确认=%v（%s）",
		pick(cur.DefaultCWD, "(内置)"), cur.TermFontSize, cur.TermFontFamily,
		cur.StartView, pick(cur.DefaultAgent, "(自动)"), pick(cur.NewAgentShortcut, "(关闭)"),
		cur.ConfirmClose, cur.ConfirmEndAgent, f)
	return s
}

func filePath() (string, error) {
	return appdir.PerchFile(FileName)
}

func pick(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

// Snapshot 返回当前设置的一份值拷贝。
func (s *Store) Snapshot() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Patch 应用一份增量并落盘。写盘失败就把内存也退回旧值 —— 界面不能挂着一份
// 盘上不存在的设置（那种"我明明改过、下次又变回去"的悬案最难查）。
func (s *Store) Patch(p Patch) (Settings, error) {
	if p.Empty() {
		return s.Snapshot(), nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.cur
	next := s.cur

	if p.DefaultCWD != nil {
		v := strings.TrimSpace(*p.DefaultCWD)
		if v != "" {
			abs, err := filepath.Abs(v)
			if err != nil {
				return old, fmt.Errorf("这个路径看不懂：%v", err)
			}
			fi, err := os.Stat(abs)
			if err != nil || !fi.IsDir() {
				return old, errors.New("这个目录不存在，或者不是一个文件夹")
			}
			v = abs
		}
		next.DefaultCWD = v
	}
	if p.TermFontSize != nil {
		next.TermFontSize = *p.TermFontSize
	}
	if p.TermFontFamily != nil {
		next.TermFontFamily = *p.TermFontFamily
	}
	if p.StartView != nil {
		next.StartView = *p.StartView
	}
	if p.Language != nil {
		next.Language = *p.Language
	}
	if p.DefaultAgent != nil {
		v := strings.ToLower(strings.TrimSpace(*p.DefaultAgent))
		if v != "" && !agentcatalog.Has(v) {
			return old, fmt.Errorf("不认识这个 agent：%s", v)
		}
		next.DefaultAgent = v
	}
	if p.NewAgentShortcut != nil {
		v, ok := NormalizeShortcut(*p.NewAgentShortcut)
		if !ok {
			return old, errors.New("快捷键格式不对：需要 Ctrl 或 Alt + 字母、数字或 F1–F12")
		}
		next.NewAgentShortcut = v
	}
	if p.ConfirmClose != nil {
		next.ConfirmClose = *p.ConfirmClose
	}
	if p.ConfirmEndAgent != nil {
		next.ConfirmEndAgent = *p.ConfirmEndAgent
	}
	next = next.Normalize()
	if next == old {
		return old, nil
	}
	if err := s.saveLocked(next); err != nil {
		return old, err
	}
	s.cur = next
	return next, nil
}

// saveLocked 必须持锁调用。原子写：先写 .tmp 再 rename。
func (s *Store) saveLocked(next Settings) error {
	if s.broken {
		return errors.New("设置文件解析失败过，拒绝覆盖它（先修好或删掉它）")
	}
	if s.file == "" {
		return errors.New("不知道设置写哪儿（拿不到用户配置目录）")
	}
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// DefaultCWDUnavailable 说明用户选的那个目录**此刻**不在盘上（不是配置坏了）。
// 设置页拿它显示一条说明；默认工作区拿它决定回不回落。
func (s *Store) DefaultCWDUnavailable() bool {
	st := s.Snapshot()
	if strings.TrimSpace(st.DefaultCWD) == "" {
		return false
	}
	fi, err := os.Stat(st.DefaultCWD)
	return err != nil || !fi.IsDir()
}

// FilePath 是落盘位置；测试与诊断用。
func (s *Store) FilePath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file
}
