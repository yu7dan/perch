package botgroup

// 记忆圈（Bot Group C，2026-10-28；用户定：默认共享记忆、Manager 能看所有圈）。
//
//	共享记忆模式（默认）：全组一个圈「all」，所有成员都在里面。
//	纯调度模式：默认谁都不共享，只靠 Manager 发的任务包；成员可以在角色抽屉里加入小圈
//	          （Bot.Circles），同一个圈里的成员共享那一份。
//
// 正文是项目里的 markdown 文件：<项目>/.perch/botgroups/<组>/memory/<圈>.md。
// 写只经过 Perch（perch-bg memory add）：串行追加、每条带「谁 · 什么时候」，几个 Bot 同时写
// 不会互相覆盖。超过 MemoryMaxLines 行时把旧的一半挪进 memory/归档/，原文不丢。

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const MemoryMaxLines = 200

var circleNameRE = regexp.MustCompile(`^[\p{L}\p{N}_\-]{1,24}$`)

// CirclesOf：这个 Bot 能读 / 写哪些圈。Manager 能看所有圈（它是调度者）。
func CirclesOf(g Group, b Bot) []string {
	if g.MemoryMode != "dispatch" {
		return []string{"all"}
	}
	if b.Manager {
		return AllCircles(g)
	}
	return append([]string(nil), b.Circles...)
}

// AllCircles：这个组现在有的所有圈。
func AllCircles(g Group) []string {
	if g.MemoryMode != "dispatch" {
		return []string{"all"}
	}
	seen := map[string]bool{}
	var out []string
	for _, b := range g.Bots {
		for _, c := range b.Circles {
			if !seen[c] {
				seen[c] = true
				out = append(out, c)
			}
		}
	}
	sort.Strings(out)
	return out
}

func MemoryDir(g Group) string {
	return filepath.Join(g.Project, ".perch", "botgroups", g.ID, "memory")
}

func MemoryPath(g Group, circle string) string { return filepath.Join(MemoryDir(g), circle+".md") }

var memMu sync.Mutex

// MemoryAdd：成员 b 往圈 circle（空 = 它的第一个圈）追加一条。返回写进的圈。
func MemoryAdd(g Group, b Bot, circle, text string) (string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", fmt.Errorf("没有要记的内容")
	}
	can := CirclesOf(g, b)
	if circle == "" {
		if len(can) == 0 {
			return "", fmt.Errorf("纯调度模式下你不在任何记忆圈里（在角色抽屉里加入，或者让 Manager 把要点写进任务包）")
		}
		circle = can[0]
	}
	if !contains(can, circle) {
		return "", fmt.Errorf("你不在圈「%s」里（你在：%s）", circle, strings.Join(can, "、"))
	}
	who := "Manager"
	if !b.Manager {
		who = b.Role
	}
	memMu.Lock()
	defer memMu.Unlock()
	p := MemoryPath(g, circle)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if _, err := os.Stat(p); err != nil {
		head := fmt.Sprintf("# %s · 共享记忆（圈：%s）\n\n由 Perch 维护：每条都由 perch-bg memory add 追加，带「谁 · 什么时候」。\n\n", g.Name, circle)
		if err := os.WriteFile(p, []byte(head), 0o644); err != nil {
			return "", err
		}
	}
	line := fmt.Sprintf("- **%s** · %s：%s\n", who, time.Now().Format("01-02 15:04"), strings.ReplaceAll(text, "\n", " "))
	fh, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	_, err = fh.WriteString(line)
	fh.Close()
	if err == nil {
		rotateMemory(p)
	}
	return circle, err
}

// MemoryShow：成员 b 能读到的记忆（circle 空 = 它能读的全部圈）。
func MemoryShow(g Group, b Bot, circle string) (string, error) {
	can := CirclesOf(g, b)
	if circle != "" && !contains(can, circle) {
		return "", fmt.Errorf("你不在圈「%s」里（你在：%s）", circle, strings.Join(can, "、"))
	}
	list := can
	if circle != "" {
		list = []string{circle}
	}
	var sb strings.Builder
	for _, c := range list {
		data, err := os.ReadFile(MemoryPath(g, c))
		if err != nil {
			fmt.Fprintf(&sb, "（圈「%s」还没有内容）\n", c)
			continue
		}
		sb.Write(data)
		sb.WriteString("\n")
	}
	if sb.Len() == 0 {
		return "（你不在任何记忆圈里）", nil
	}
	return sb.String(), nil
}

// rotateMemory：超过上限就把条目的前一半挪进 归档/（不丢），文件里留后一半。
func rotateMemory(p string) {
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	var head, items []string
	for _, l := range lines {
		if strings.HasPrefix(l, "- ") {
			items = append(items, l)
		} else if len(items) == 0 {
			head = append(head, l)
		}
	}
	if len(items) <= MemoryMaxLines {
		return
	}
	cut := len(items) / 2
	arch := filepath.Join(filepath.Dir(p), "归档")
	_ = os.MkdirAll(arch, 0o755)
	name := strings.TrimSuffix(filepath.Base(p), ".md") + "-" + time.Now().Format("20060102-150405") + ".md"
	_ = os.WriteFile(filepath.Join(arch, name), []byte(strings.Join(items[:cut], "\n")+"\n"), 0o644)
	keep := append(head, fmt.Sprintf("（更早的 %d 条在 归档/%s）", cut, name), "")
	keep = append(keep, items[cut:]...)
	_ = os.WriteFile(p, []byte(strings.Join(keep, "\n")+"\n"), 0o644)
}

func ValidCircle(name string) bool { return circleNameRE.MatchString(name) }

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
