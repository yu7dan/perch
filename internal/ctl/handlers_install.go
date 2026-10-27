package ctl

import (
	"log"
	"os"
	"time"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

// 安装动作全部换协程：npm / irm 可能跑几分钟，不能卡住 ctl 收包。
// 流式进度（install.start/log/done）由安装器自己推。

func (s *Server) handleInstall(m *Msg) {
	switch m.Type {
	case "agent.setup":
		// “只启动”那一类的升级动作（目前只有 dsh）：装官方 hook 桥 /
		// profile peer / home patch。和安装一样是用户点一次才跑。
		id := trimSpace(m.ID)
		if id == "" || s.deps.SetupAgent == nil {
			return
		}
		log.Printf("[agent] 用户请求接入状态 agent=%s", id)
		go s.setupAgent(id)
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

// setupAgent 跑一次“只启动 → 接入状态”。它复用安装面板的流式通道，
// 因为用户看到的是同一类事：Perch 在替他把东西装好、日志要能看见。
// 结束后重新扫一遍名单：caps/Setup 会随钩子是否就绪翻转。
func (s *Server) setupAgent(id string) {
	logf := func(line string) {
		s.Push(map[string]any{"type": "install.log", "id": id, "line": line})
	}
	s.Push(map[string]any{
		"type": "install.start", "id": id, "source": "Perch 状态接入",
		"at": time.Now().UnixMilli(),
	})
	start := time.Now()
	err := s.deps.SetupAgent(id, logf)
	if err != nil {
		logf("失败：" + err.Error())
	}
	home, _ := os.UserHomeDir()
	cat := agentcatalog.Cards(home)
	s.Push(map[string]any{"type": "catalog", "catalog": cat})
	done := map[string]any{
		"type": "install.done", "id": id, "ok": err == nil, "code": 0,
		"elapsedMs": time.Since(start).Milliseconds(),
	}
	if err != nil {
		done["err"] = err.Error()
	}
	s.Push(done)
}
