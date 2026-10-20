package project

import (
	"sort"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/history"
)

// Wire 是**发给前端的那份**：落盘字段 + 算出来的两个数。
// 用嵌入而不是复制字段，是为了"落盘形状改了、wire 忘了改"这件事不可能发生。
type Wire struct {
	Project
	Recent string `json:"recent"` // 组内最新活动（RFC3339，空 = 还没跑过）
	Count  int    `json:"count"`  // 主会话数（子代理不算 —— 那是派生出来的）
	// Synthetic = 「默认工作区」（见 DefaultWorkspacePath）。
	// ⚠️ 这个字段**不在落盘的 Project 上**，因为合成的那个**从不落盘** ——
	// 它要是也写进 projects.json，"删不掉"就变成了"删了下次又回来"，
	// 而且用户手加的那个同名目录会和我们合成的那份打架（两份记录、一个路径）。
	// 所以它只活在这条 wire 上：前端只拿它决定"这一行不做改名/移除"。
	Synthetic bool `json:"synthetic,omitempty"`
}

// Stats 一趟算完三件事：
//
//	assign  会话 id → 项目路径（不在表里的 = 未归类，前端摆到最后那一组）
//	recent  项目路径 → 组内最新活动时间（排序用）
//	count   项目路径 → 主会话数（子代理不算）
//
// 为什么必须一趟：三件事的归属判定是同一条规则（最长前缀匹配），
// 分三处写迟早会漂 —— 那样就会出现"这张卡显示在工作区 A 下、却算进了 B 的计数"。
func Stats(sessions []history.Session, projects []Project) (map[string]string, map[string]time.Time, map[string]int) {
	type entry struct{ key, path string }
	// 先按路径长度倒序：第一个命中的就是最长匹配（`D:\w\a\b` 应该盖过 `D:\w\a`）
	keys := make([]entry, 0, len(projects))
	for _, pr := range projects {
		keys = append(keys, entry{PathKey(pr.Path), pr.Path})
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i].key) > len(keys[j].key) })

	assign := make(map[string]string, len(sessions))
	recent := make(map[string]time.Time, len(keys))
	count := make(map[string]int, len(keys))
	for _, s := range sessions {
		if s.Cwd == "" {
			continue
		}
		ck := PathKey(s.Cwd)
		for _, e := range keys {
			// 相等，或者落在它**下面**（必须带分隔符：`D:\w\ab` 不是 `D:\w\a` 的子目录，
			// 少了这个 `\` 就会把兄弟目录的会话算进来 —— 那种错很难看出来）。
			if ck != e.key && !strings.HasPrefix(ck, e.key+`\`) {
				continue
			}
			assign[s.ID] = e.path
			if t := ParseTS(s.Updated); t.After(recent[e.path]) {
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

// Audit 量那条不变量：**Σ各项目 + 未归类 == 主会话总数**。
//
// 为什么值得单独一个函数：这条等式要在**每一处**把池子推给前端的地方都成立
// （启动那份全量载荷、每次池子操作后的推回），两处各写一遍迟早会漂 —— 而它
// 一旦漂了就是"某条会话在界面上根本不存在"那种看不见的错。所以判据一处，
// 量出来的四个数也由这里一并给出，调用方只负责打印。
//
// ⚠️ 等式右边是**主会话**（子代理已排除），左边那三项也都是主会话口径。
// `assign` 这个 map 是**含**子代理的（它们的 cwd 也在场），别拿 len(assign) 去对。
func Audit(sessions []history.Session, assign map[string]string, wire []Wire) (sum, nUn, nMain, nAll int) {
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

// WireProjects 排出前端要的顺序：**置顶区永远在最前**（照 Orca 的 Pinned 分区
// `unshift` 到最前，build-rows.ts:138-143），其余按组内最近活动倒序，
// 没有活动就退回落盘时间；**合成的默认工作区永远排最后**（见下面那段）。
//
// 刻意不持久化"最近"这张表：两个参考实现都是现算的（Orca 的注释原话
// `Recent must be timestamp-based, not encounter order`），存下来只会多一个
// 会和事实不一致的东西。
func WireProjects(projects []Project, recent map[string]time.Time, count map[string]int) []Wire {
	out := make([]Wire, 0, len(projects))
	for _, pr := range projects {
		w := Wire{Project: pr, Count: count[pr.Path], Synthetic: pr.Source == SourceSynthetic}
		if t := recent[pr.Path]; !t.IsZero() {
			w.Recent = t.UTC().Format(time.RFC3339)
		}
		out = append(out, w)
	}
	rank := func(w Wire) time.Time {
		if t := ParseTS(w.Recent); !t.IsZero() {
			return t
		}
		return ParseTS(w.AddedAt)
	}
	/* 合成的默认工作区**先摘出来，排完再追加** —— 它就是最后一行。
	   为什么不参与排序：它不是一个用户攒出来的"项目"，而是"没归到别处的东西"的
	   落点（前端也把它画成末尾那一行、未归类那组紧跟在它下面）。让它跟着
	   "最近活动"在列表里上下跳，会让"未归类"那一组跟着它一起跳 —— 而那一组
	   恰恰是"这里有个目录还没被收进池子"的提示，位置必须稳定。 */
	real := make([]Wire, 0, len(out))
	syn := make([]Wire, 0, 1)
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
