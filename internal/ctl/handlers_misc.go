package ctl

import (
	"log"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/term"
	"github.com/yu7dan/perch/internal/uimsg"
)

// 页面级事实、快照补发与系统打开地址。它们不归标签/文件/设置任何一域，
// 但都必须走同一条 ctl 推送。

func (s *Server) handleMisc(m *Msg) {
	switch m.Type {
	case "log":
		// 页面级事实（没有标签归属的那些）走这条 —— 它比任何标签流命都长，
		// 页面刚起来还没标签时也能落日志。
		log.Printf("[web] %s", m.Msg)
	case "term.theme":
		// 前端解析出的有效明暗（system 已经按 Windows 设置落成 dark/light）。
		// 只影响之后的 OSC 10/11 应答和新起进程的 COLORFGBG。
		light := m.Msg == "light"
		term.SetLight(light)
		log.Printf("[theme] 终端明暗 → %s", m.Msg)
	case "acts.snapshot":
		s.actsSnapshot(m)
	case "files.snapshot":
		s.filesSnapshot(m)
	case "trace.diff":
		s.traceDiff(m)
	case "open.url":
		// Agent 名单的「下载」= 打开官方安装页（**不是**替用户跑安装脚本）。
		// 只放 http/https：别的 scheme 会把一个"看网页"的按钮变成可执行动作。
		u := trimSpace(m.URL)
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			log.Printf("[web] 拒绝打开非 http(s) 地址：%q", u)
			return
		}
		go func(u string) {
			if s.deps.UI == nil {
				return
			}
			if err := s.deps.UI.OpenURL(u); err != nil {
				log.Printf("[web] 打开下载页失败 %s：%v", u, err)
			} else {
				log.Printf("[web] 打开下载页 %s", u)
			}
		}(u)
	}
}

// actsSnapshot 页面重载后补一次首帧。
//
// 为什么需要它：跟随器只在**初次读入**时推整份（见 transcript 的 firstRead），
// 页面一重载它那边的 first 早就是 false 了 —— 不补这一次，下段（实时对话流）
// 会空白到下一次有新内容为止，而"这一格其实跑了一个小时"这件事前端无从得知。
func (s *Server) actsSnapshot(m *Msg) {
	if m.Tab <= 0 || s.deps.Transcript == nil {
		return
	}
	items := s.deps.Transcript.Acts(m.Tab, 2*time.Second)
	if items == nil {
		log.Printf("[ctl] 补发流水快照 tab=%d 超时/没被取走，跳过（不拿 nil 去替换前端已有的列表）", m.Tab)
		return
	}
	s.Push(map[string]any{"type": "acts", "tab": m.Tab, "items": items, "replace": true})
	log.Printf("[ctl] 补发流水快照 tab=%d（%d 条）", m.Tab, len(items))
}

// filesSnapshot 页面重载后补一次「碰过的」：跟随器的首次整份推送只发生一次，
// 前端刷新之后不补就会一直空着（直到下一次文件动作）。
func (s *Server) filesSnapshot(m *Msg) {
	if m.Tab <= 0 || s.deps.Transcript == nil {
		return
	}
	files := s.deps.Transcript.Files(m.Tab, 2*time.Second)
	if files == nil {
		log.Printf("[ctl] 补发文件台账 tab=%d 超时/没被取走，跳过", m.Tab)
		return
	}
	s.Push(map[string]any{"type": "files", "tab": m.Tab, "files": files})
	log.Printf("[ctl] 补发文件台账 tab=%d（%d 个）", m.Tab, len(files))
}

// traceDiff 文件预览的「改动」页：按需取**这一格**记到的某个文件的 diff 正文。
// 正文不挂在每 400ms 的 files 推送里（见 transcript 的 maxChangeText），
// 所以单独走一次请求；跟随器不在/超时就明确回 err，不让前端一直转圈。
func (s *Server) traceDiff(m *Msg) {
	if m.Tab <= 0 || trimSpace(m.Path) == "" || s.deps.Transcript == nil {
		return
	}
	d := s.deps.Transcript.Diff(m.Tab, m.Path, 2*time.Second)
	out := map[string]any{"type": "diff", "tab": m.Tab, "req": m.Req, "path": m.Path}
	var uiErr error
	if d == nil {
		uiErr = uimsg.New("diff.timeout", "超时（转录跟随器没有应答）")
	} else {
		out["found"] = d.Found
		out["missing"] = d.Missing
		out["state"] = d.State
		out["rel"] = d.Rel
		out["add"] = d.Add
		out["del"] = d.Del
		out["changes"] = d.Changes
	}
	s.Push(withUIErr(out, uiErr))
	if d == nil {
		log.Printf("[trace] 改动正文请求超时 tab=%d path=%s", m.Tab, m.Path)
	} else {
		log.Printf("[trace] 改动正文 tab=%d path=%s found=%v 条=%d 缺=%v",
			m.Tab, m.Path, d.Found, len(d.Changes), d.Missing)
	}
}
