package main

// ---------------------------------------------------------------------------
// 应用设置（设置页 · 第一批）
//
// 这里只放**Perch 自己**的偏好：默认工作目录、终端外观、关窗/结束 agent 的
// 确认、启动落点。agent 自己的配置（模型、网关、权限…）一律不进来 ——
// 那是 magpie / agent 配置抽屉的事，两家的状态不能搅在一起。
//
// 落盘位置和项目池同一层：%APPDATA%\Perch\settings.json。
// 和 projects.json 一样走「先写 .tmp 再 rename」的原子写，并且**解析失败就
// 拒绝覆盖** —— 一份读不动的小配置不值得用一次坏写去换。
//
// ⚠️ 默认目录是**后端的事实**，不是前端的 localStorage：defaultCWD()、新格的
// 实际 PTY cwd、合成的「默认工作区」、状态栏都从这一份读。前端那份缓存只负责
// 首帧和启动落点，Go 的载荷一到就以 Go 为准（见 05-prefs.js）。
// ---------------------------------------------------------------------------

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
)

const settingsFileName = "settings.json"

// 字号的可选范围。设置页给的是 12–18 六档；这里夹住手改配置时的越界值，
// 不让人把终端弄成 2px 或 200px（xterm 在那种尺寸下会算出荒唐的列数）。
const (
	termFontSizeMin = 12
	termFontSizeMax = 18
)

// appSettings 是**落盘的形状**，也是发给前端的形状。字段少、全是标量 ——
// 这种配置最怕"两边各有一份默认值"，所以默认值只在 settingsDefaults 里写一次。
type appSettings struct {
	// DefaultCWD 是用户选的默认工作目录；空串 = 用内置的
	// <用户主目录>\Documents\Perch。存的是**原始选择**，目录暂时不在盘上
	// （网络盘没挂、被删了）不抹掉它，只回落到内置目录并在设置页里说明。
	DefaultCWD string `json:"defaultCwd"`
	// TermFontSize 是终端字号；TermFontFamily 是 "cascadia" | "jetbrains"。
	TermFontSize   int    `json:"termFontSize"`
	TermFontFamily string `json:"termFontFamily"`
	// StartView 是下次启动先落在哪："dash" | "workspace"。
	StartView string `json:"startView"`
	// DefaultAgent 是「新开一格」默认用谁；空 = 自动（优先有状态能力的已安装
	// agent，见 assets/js/30-pages.js 的 defaultAgentId）。存的是 agent id，
	// 不是名字 —— 名字会变，id 不会。
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

func settingsDefaults() appSettings {
	return appSettings{
		TermFontSize:     14,
		TermFontFamily:   "cascadia",
		StartView:        "dash",
		NewAgentShortcut: "Ctrl+Alt+N",
		ConfirmClose:     true,
		ConfirmEndAgent:  true,
	}
}

// normalize 把任何来源的值收进可接受的形状。空/非法值一律落回默认，
// 不报错 —— 一份手改坏了的配置不该让整个设置页打不开。
func (s appSettings) normalize() appSettings {
	d := settingsDefaults()
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
	// 只认能启动的 agent id。空串是合法值 = 自动；认不出的（手改配置/卸载了）
	// 落回自动 —— 别把一个不存在的 agent 当成“设置过”。
	s.DefaultAgent = strings.ToLower(strings.TrimSpace(s.DefaultAgent))
	if s.DefaultAgent != "" {
		if _, ok := agentDefs[s.DefaultAgent]; !ok {
			s.DefaultAgent = ""
		}
	}
	// 快捷键：能规范化就规范化，规范化不了就**关掉**（不落回默认键 ——
	// 一个手改坏的字符串不该悄悄变成一个会吃终端按键的组合键）。
	if v, ok := normalizeShortcut(s.NewAgentShortcut); ok {
		s.NewAgentShortcut = v
	} else {
		s.NewAgentShortcut = ""
	}
	return s
}

// shortcutKeyPattern 是主键的白名单：字母、数字、F1-F12。
// 故意不收空格/方向键/Tab/Enter：那些是终端的日常输入，壳层不该抢。
var shortcutKeyPattern = regexp.MustCompile(`^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$`)

// normalizeShortcut 把快捷键收成规范形状（修饰键 Ctrl→Alt→Shift，主键大写）。
// 空串是合法值 = 关闭；其余不合法的返回 ok=false，由调用方决定怎么落。
func normalizeShortcut(raw string) (string, bool) {
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

// settingsPatch 是 ctl 的 "settings.set" 带来的增量。指针 = "这条请求有没有
// 提到这个字段"：false / 0 / 空串都是**合法值**，不能用零值判断缺省。
type settingsPatch struct {
	DefaultCWD       *string `json:"defaultCwd,omitempty"`
	TermFontSize     *int    `json:"termFontSize,omitempty"`
	TermFontFamily   *string `json:"termFontFamily,omitempty"`
	StartView        *string `json:"startView,omitempty"`
	DefaultAgent     *string `json:"defaultAgent,omitempty"`
	NewAgentShortcut *string `json:"newAgentShortcut,omitempty"`
	ConfirmClose     *bool   `json:"confirmClose,omitempty"`
	ConfirmEndAgent  *bool   `json:"confirmEndAgent,omitempty"`
}

func (p settingsPatch) empty() bool {
	return p.DefaultCWD == nil && p.TermFontSize == nil && p.TermFontFamily == nil &&
		p.StartView == nil && p.DefaultAgent == nil && p.NewAgentShortcut == nil &&
		p.ConfirmClose == nil && p.ConfirmEndAgent == nil
}

type settingsStore struct {
	mu     sync.Mutex
	file   string
	cur    appSettings
	broken bool // 文件在、但解析不了：一次都不许覆盖
}

func settingsFilePath() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, poolDirName, settingsFileName), nil
}

func loadSettingsStore() *settingsStore {
	s := &settingsStore{cur: settingsDefaults()}
	f, err := settingsFilePath()
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
	cur := settingsDefaults()
	if err := json.Unmarshal(b, &cur); err != nil {
		s.broken = true
		log.Printf("[settings] ⚠️ 设置文件解析失败，**保持原样、一次都不覆盖**：%s（%v）", f, err)
		return s
	}
	cur = cur.normalize()
	s.cur = cur
	log.Printf("[settings] 载入：默认目录=%s 字号=%d 字体=%s 启动=%s 默认 agent=%s 快捷键=%s 关窗确认=%v 结束确认=%v（%s）",
		pick(cur.DefaultCWD, "(内置)"), cur.TermFontSize, cur.TermFontFamily,
		cur.StartView, pick(cur.DefaultAgent, "(自动)"), pick(cur.NewAgentShortcut, "(关闭)"),
		cur.ConfirmClose, cur.ConfirmEndAgent, f)
	return s
}

func pick(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

func (s *settingsStore) snapshot() appSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// patch 应用一份增量并落盘。写盘失败就把内存也退回旧值 —— 界面不能挂着一份
// 盘上不存在的设置（那种"我明明改过、下次又变回去"的悬案最难查）。
func (s *settingsStore) patch(p settingsPatch) (appSettings, error) {
	if p.empty() {
		return s.snapshot(), nil
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
	if p.DefaultAgent != nil {
		v := strings.ToLower(strings.TrimSpace(*p.DefaultAgent))
		if v != "" {
			if _, ok := agentDefs[v]; !ok {
				return old, fmt.Errorf("不认识这个 agent：%s", v)
			}
		}
		next.DefaultAgent = v
	}
	if p.NewAgentShortcut != nil {
		v, ok := normalizeShortcut(*p.NewAgentShortcut)
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
	next = next.normalize()
	if next == old {
		return old, nil
	}
	if err := s.saveLocked(next); err != nil {
		return old, err
	}
	s.cur = next
	return next, nil
}

// saveLocked 必须持锁调用。原子写，理由同 projects.go 的 saveLocked。
func (s *settingsStore) saveLocked(next appSettings) error {
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

// defaultCWDUnavailable 说明用户选的那个目录**此刻**不在盘上（不是配置坏了）。
// 设置页拿它显示一条说明；defaultWorkspacePath() 拿它决定回不回落。
func (s *settingsStore) defaultCWDUnavailable() bool {
	st := s.snapshot()
	if strings.TrimSpace(st.DefaultCWD) == "" {
		return false
	}
	fi, err := os.Stat(st.DefaultCWD)
	return err != nil || !fi.IsDir()
}

func (s *settingsStore) filePath() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file
}

// settingsWire 是发给前端的整份读数。除了落盘的七项，还带上**算出来的**三样：
//
//	· cwd             当前生效的默认工作目录（自定义失效时是内置那个）
//	· builtinCwd      内置默认目录，设置页拿它写"恢复默认"的说明
//	· defaultCwdMissing 用户选的目录此刻不在盘上（不代表配置坏了）
//
// 这三个数都由 Go 现算：前端自己拼路径会在「文档/Documents」这种地方分叉。
func settingsWire(errMsg string) map[string]any {
	m := map[string]any{"type": "settings"}
	if prefsStore == nil {
		m["settings"] = settingsDefaults()
		m["err"] = "设置存储没起来（拿不到用户配置目录）"
		return m
	}
	st := prefsStore.snapshot()
	builtin, _ := builtinDefaultWorkspacePath()
	m["settings"] = st
	m["cwd"] = defaultCWD()
	m["builtinCwd"] = builtin
	m["defaultCwdMissing"] = prefsStore.defaultCWDUnavailable()
	if errMsg != "" {
		m["err"] = errMsg
	}
	return m
}

func pushSettings(errMsg string) {
	pushJSON(settingsWire(errMsg))
}

// applySettingsPatch 是 settings.set / settings.pickDefaultCWD 的共同落点。
// 默认目录一变，还要做两件事：确保新目录存在（新格要落在里面），并把池子
// 重算一遍（合成的「默认工作区」那一行跟着换路径）。
func applySettingsPatch(p settingsPatch, why string) {
	if prefsStore == nil {
		pushSettings("设置存储没起来（拿不到用户配置目录）")
		return
	}
	old := prefsStore.snapshot()
	next, err := prefsStore.patch(p)
	if err != nil {
		log.Printf("[settings] %s 失败：%v（保持原值）", why, err)
		pushSettings(err.Error())
		return
	}
	log.Printf("[settings] %s：默认目录=%s 字号=%d 字体=%s 启动=%s 默认 agent=%s 快捷键=%s 关窗确认=%v 结束确认=%v",
		why, pick(next.DefaultCWD, "(内置)"), next.TermFontSize, next.TermFontFamily,
		next.StartView, pick(next.DefaultAgent, "(自动)"), pick(next.NewAgentShortcut, "(关闭)"),
		next.ConfirmClose, next.ConfirmEndAgent)
	pushSettings("")
	if next.DefaultCWD != old.DefaultCWD {
		ensureDefaultWorkspace()
		poolReply("")
	}
}
