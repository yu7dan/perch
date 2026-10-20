package ctl

import "log"

func (s *Server) handleWindow(m *Msg) {
	switch m.Type {
	case "attention":
		// 「需要你」送到窗口之外的那一层：闪任务栏。
		//
		// 为什么这件事必须由 Go 做：应用内的描边脉冲/徽标都在我们自己的窗口里，
		// 用户在浏览器里时一个都看不见 —— 系统层只剩这一个手段。Wails 在
		// Windows 上就是 `w32.FlashWindow(hwnd, enabled)`。语义：true 会
		// **一直闪到窗口被激活**，所以"停"要显式发。
		//
		// 判据在前端（窗口不在前台 + 存在未读），Go 这边不做判断 ——
		// 它只管"闪"与"别闪"，这是唯一不需要知道"未读"是什么的一侧。
		if s.deps.UI == nil {
			log.Printf("[web] attention 要闪任务栏，但主窗口还没拿到（%s）", m.Why)
			return
		}
		s.deps.UI.Flash(m.On)
		log.Printf("[web] 任务栏闪烁 %v（%s）", m.On, m.Why)
	case "window.close":
		// 前端确认过了（设置页的「关闭窗口前确认」）。置位后 WindowClosing
		// 那道 hook 直接放行，走 Wails 默认的关窗路。
		s.guard.Confirm()
		log.Printf("[settings] 关窗确认：用户确认关闭，放行")
		s.deps.UI.CloseWindow()
	case "window.close.cancel":
		s.guard.Cancel()
		log.Printf("[settings] 关窗确认：用户取消，窗口留着")
	}
}
