package ctl

import "log"

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
	case "install.magpie":
		// 网关页的「下载并安装 magpie」。和 agent 安装共用同一条流式通道
		// （install.start/log/done，id=magpie），装完 finishInstall 会自动
		// 接网关 —— 用户不需要再点「连接」。
		log.Printf("[install] 用户请求安装 magpie（官方 release）")
		go s.deps.Installer.Start("magpie")
	case "install.cancel":
		id := trimSpace(m.ID)
		log.Printf("[install] 用户取消安装 agent=%s", id)
		go s.deps.Installer.Cancel(id)
	}
}
