package ctl

import (
	"log"
)

// 安装动作全部换协程：npm / irm 可能跑几分钟，不能卡住 ctl 收包。
// 流式进度（install.start/log/done）由安装器自己推。

func (s *Server) handleInstall(m *Msg) {
	switch m.Type {
	case "install.agent":
		// 用户点下「安装」之后才跑官方命令。
		id := trimSpace(m.ID)
		if id == "" {
			return
		}
		log.Printf("[install] 用户请求安装 agent=%s", id)
		go s.deps.Installer.Start(id)
	case "install.cancel":
		id := trimSpace(m.ID)
		log.Printf("[install] 用户取消安装 agent=%s", id)
		go s.deps.Installer.Cancel(id)
	}
}
