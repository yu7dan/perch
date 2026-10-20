package ctl

import (
	"errors"
	"log"

	"github.com/yu7dan/perch/internal/uimsg"
)

func (s *Server) handleProjects(m *Msg) {
	switch m.Type {
	case "project.add":
		s.projectAdd(m)
	case "project.remove":
		s.projectRemove(m)
	case "project.pin":
		s.projectPin(m)
	case "project.rename":
		s.projectRename(m)
	}
}

// projectAdd 加一个项目（左栏那一轮）。两种进法：
//   - 带 path —— 拖拽落进来的目录、或从「未归类」收编（source="adopted"）
//   - 不带 path —— 开**系统**的文件夹选择器让用户去指。
//
// 为什么用系统选择器而不是自己画目录树：用户要的动作是"指一个盘上的
// 目录"，系统那个里已经摆着他所有的快捷方式、能搜索、能新建文件夹 ——
// 我们画一个只会更差。
func (s *Server) projectAdd(m *Msg) {
	if s.deps.Pool == nil {
		m := map[string]any{"type": "pool"}
		s.Push(withUIErr(m, uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）")))
		return
	}
	if p := trimSpace(m.Path); p != "" {
		pr, added, err := s.deps.Pool.Add(p, m.Name, m.Source)
		if err != nil {
			log.Printf("[pool] 加项目失败 %s：%v", p, err)
			s.poolReply(err)
			return
		}
		log.Printf("[pool] 加项目 %q（%s）路径=%s 新增=%v", pr.Name, pr.Source, pr.Path, added)
		s.poolReply(nil)
		return
	}
	// ⚠️ 选择器是**阻塞**的（用户可能盯着它想很久），所以这条必须换协程，
	// 否则整条 ctl 会在对话框开着的时候停止收包 —— 那时连日志都进不来。
	// 代价是应答不能再用 c.Send（那是循环里那根），改走 Push：
	// 它自带锁，本来就是多协程在用的那条路（转录跟随器就在用）。
	go s.pickProject()
}

func (s *Server) pickProject() {
	sel, err := s.deps.UI.ChooseDirectory("把哪个目录收进 Perch？")
	if err != nil {
		// 取消在系统对话框实现里是**一个 error**（go-common-file-dialog
		// 的 ErrorCancelled 原文 "cancelled by user"），不是空路径。
		// 早先只判了空字符串，于是用户按取消会收到一条「项目池出错了」
		// 的 toast —— 取消是正常手势，不该报警。UI 适配层把取消归一成
		// ErrPickerCancelled，这里按语义判掉。
		if errors.Is(err, ErrPickerCancelled) {
			log.Printf("[pool] 选择器被取消（没有加任何项目）")
			return
		}
		log.Printf("[pool] 文件夹选择器失败：%v", err)
		s.poolReply(uimsg.Wrap(err, "pool.pickerFailed", "选择器打不开："+err.Error(),
			map[string]string{"err": err.Error()}))
		return
	}
	if trimSpace(sel) == "" {
		// 已经选了路径但返回空：按取消处理。**这不是错误** —— 不弹任何提示。
		log.Printf("[pool] 选择器被取消（没有加任何项目）")
		return
	}
	pr, added, err := s.deps.Pool.Add(sel, "", "manual")
	if err != nil {
		log.Printf("[pool] 加项目失败 %s：%v", sel, err)
		s.poolReply(err)
		return
	}
	log.Printf("[pool] 加项目 %q（选择器）路径=%s 新增=%v", pr.Name, pr.Path, added)
	s.poolReplyPicked(nil, pr.Path)
}

// projectRemove 只从池子里摘掉，**磁盘上一个字节都不动**（这一点必须做进
// UI 的措辞里：Orca 的 RemoveFolderDialog.tsx:101-104 原话就是
// "This only removes X from Orca. It is still on your disk."）。
// "删到回收站"是另一个动作，与这里绝不能合成一个按钮。
func (s *Server) projectRemove(m *Msg) {
	if s.deps.Pool == nil {
		return
	}
	if ok, err := s.deps.Pool.Remove(m.Path); err != nil {
		log.Printf("[pool] 移除失败 %s：%v", m.Path, err)
		s.poolReply(err)
	} else {
		log.Printf("[pool] 移除项目 %s（只从池子里摘掉，磁盘未动）命中=%v", m.Path, ok)
		s.poolReply(nil)
	}
}

func (s *Server) projectPin(m *Msg) {
	if s.deps.Pool == nil {
		return
	}
	if ok, err := s.deps.Pool.SetPinned(m.Path, m.On); err != nil {
		log.Printf("[pool] 置顶改动失败 %s：%v", m.Path, err)
		s.poolReply(err)
	} else {
		log.Printf("[pool] 置顶 %s = %v 命中=%v", m.Path, m.On, ok)
		s.poolReply(nil)
	}
}

// projectRename 改的是**显示名**，磁盘上那个目录不动。空名 = 恢复成目录名。
func (s *Server) projectRename(m *Msg) {
	if s.deps.Pool == nil {
		return
	}
	if ok, err := s.deps.Pool.Rename(m.Path, m.Name); err != nil {
		log.Printf("[pool] 改名失败 %s：%v", m.Path, err)
		s.poolReply(err)
	} else {
		log.Printf("[pool] 改名 %s → %q 命中=%v", m.Path, m.Name, ok)
		s.poolReply(nil)
	}
}
