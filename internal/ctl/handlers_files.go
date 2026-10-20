package ctl

// 只读文件树的控制消息入口。真正的路径护栏、列目录、文本判定都在
// internal/files；这里只负责把项目池的根和前端推送接上。
//
//	fs.list  {root, path, req} → {type:"fs.list", req, root, path, entries, truncated}
//	fs.read  {root, path, req} → {type:"fs.read", req, root, path, rel, size,
//	                              text, truncated, binary, encoding}
//	出错一律走   {type:"fs.err", req, op, path, err}
//
// ⚠️ 不做 fs.write / fs.delete。文件的写入权在 agent 手里，这个模块只负责看；
// 哪天要加写，那是另一条腿，得有自己的确认与审计，别顺手挂在这里。

import (
	"errors"
	"log"

	"github.com/yu7dan/perch/internal/files"
	"github.com/yu7dan/perch/internal/project"
)

// filesRoots 是"哪些目录可以被文件树打开"的**唯一**来源。
// 项目池是用户亲手加进来的目录；默认工作区是 Go 合成的落点。别把
// "当前格的 cwd"加进来 —— cwd 可能在任何地方，而这条腿的边界必须由
// 用户显式收进池子的目录来定义。
func (s *Server) filesRoots() []string {
	var poolProjects []string
	if s.deps.Pool != nil {
		projects, _ := s.deps.Pool.Snapshot()
		for _, p := range projects {
			poolProjects = append(poolProjects, p.Path)
		}
	}
	var workspace []string
	if d, ok := project.DefaultWorkspacePath(s.customCWD); ok {
		workspace = append(workspace, d)
	}
	return files.AllowedRoots(poolProjects, workspace)
}

func (s *Server) fsService() *files.Service {
	return &files.Service{Roots: s.filesRoots}
}

// openPath 在系统里打开一个路径（卡片菜单里的"打开会话文件/在文件夹中显示/
// 打开工作目录"）。换协程：explorer 起进程不该拖住 ctl 收包。
func (s *Server) openPath(m *Msg) {
	go s.deps.UI.OpenPath(m.Mode, m.Path)
}

func (s *Server) fsListReq(m *Msg) {
	// 换协程 —— 网络盘上的 ReadDir 可能慢到秒级，不能把 ctl 的收包卡住。
	go s.fsList(m.Root, m.Path, m.Req)
}

func (s *Server) fsReadReq(m *Msg) {
	go s.fsRead(m.Root, m.Path, m.Req)
}

func (s *Server) fsList(root, dir string, req int) {
	if req == 0 {
		return
	}
	res, err := s.fsService().List(root, dir)
	if err != nil {
		if errors.Is(err, files.ErrRootNotAllowed) {
			log.Printf("[fs] 拒绝列出：根不在项目池里 root=%q dir=%q", root, dir)
		} else {
			log.Printf("[fs] 列目录失败 root=%s dir=%s err=%v", root, dir, err)
		}
		m := map[string]any{"type": "fs.err", "req": req, "op": "list", "path": dir}
		s.Push(withUIErr(m, err))
		return
	}
	log.Printf("[fs] list root=%s dir=%s entries=%d truncated=%v",
		root, res.Path, len(res.Entries), res.Truncated)
	s.Push(map[string]any{"type": "fs.list", "req": req, "root": root,
		"path": res.Path, "entries": res.Entries, "truncated": res.Truncated})
}

func (s *Server) fsRead(root, path string, req int) {
	if req == 0 {
		return
	}
	res, err := s.fsService().Read(root, path)
	if err != nil {
		if errors.Is(err, files.ErrRootNotAllowed) {
			log.Printf("[fs] 拒绝读取：根不在项目池里 root=%q path=%q", root, path)
		} else {
			log.Printf("[fs] 读文件失败 root=%s path=%s err=%v", root, path, err)
		}
		m := map[string]any{"type": "fs.err", "req": req, "op": "read", "path": path}
		s.Push(withUIErr(m, err))
		return
	}
	log.Printf("[fs] read root=%s path=%s size=%d text=%d truncated=%v binary=%v enc=%s",
		root, res.Path, res.Size, len(res.Text), res.Truncated, res.Binary, res.Encoding)
	s.Push(map[string]any{"type": "fs.read", "req": req, "root": root,
		"path": res.Path, "rel": res.Rel, "size": res.Size, "text": res.Text,
		"truncated": res.Truncated, "binary": res.Binary, "encoding": res.Encoding})
}
