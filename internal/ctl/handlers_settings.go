package ctl

// 设置页的控制消息。设置的落盘与归在 internal/settings；本包只做编排
// （推载荷、默认目录变更后确保目录存在并重算池子）。
//
// ⚠️ 默认目录是**后端的事实**，不是前端的 localStorage：DefaultCWD()、
// 新格的实际 PTY cwd、合成的「默认工作区」、状态栏都从这一份读。前端那份
// 缓存只负责首帧和启动落点，Go 的载荷一到就以 Go 为准。

import (
	"errors"
	"log"

	"github.com/yu7dan/perch/internal/settings"
)

func (s *Server) handleSettings(m *Msg) {
	switch m.Type {
	case "settings.get":
		// 进设置页时问一次权威值；也用于 shell 载荷没到时的补读。
		s.pushSettings("")
	case "settings.set":
		if m.Settings == nil {
			return
		}
		s.applySettingsPatch(*m.Settings, "设置改动")
	case "settings.pickDefaultCWD":
		// 选默认工作目录。和 project.add 一样：系统选择器是**阻塞**的，
		// 必须换协程，否则整条 ctl 在对话框开着的时候停止收包。
		go s.pickDefaultCWD()
	}
}

func (s *Server) pickDefaultCWD() {
	sel, err := s.deps.UI.ChooseDirectory("新 agent 默认落在哪个目录？")
	if err != nil {
		if errors.Is(err, ErrPickerCancelled) {
			log.Printf("[settings] 默认目录选择器被取消（没有改动）")
			return
		}
		if errors.Is(err, ErrNoWindow) {
			s.pushSettings("窗口还没起来，选择器打不开")
			return
		}
		log.Printf("[settings] 默认目录选择器失败：%v", err)
		s.pushSettings("选择器打不开：" + err.Error())
		return
	}
	if trimSpace(sel) == "" {
		log.Printf("[settings] 默认目录选择器被取消（没有改动）")
		return
	}
	s.applySettingsPatch(settings.Patch{DefaultCWD: &sel}, "设置默认目录")
}
