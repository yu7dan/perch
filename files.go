package main

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
)

type fsEntry = files.Entry
type fsListResult = files.ListResult
type fsReadResult = files.ReadResult

// fsAllowedRoots 是"哪些目录可以被文件树打开"的**唯一**来源。
// 项目池是用户亲手加进来的目录；默认工作区是 Go 合成的落点。别把
// "当前格的 cwd"加进来 —— cwd 可能在任何地方，而这条腿的边界必须由
// 用户显式收进池子的目录来定义。
func fsAllowedRoots() []string {
	var poolProjects []string
	if pool != nil {
		projects, _ := pool.Snapshot()
		for _, p := range projects {
			poolProjects = append(poolProjects, p.Path)
		}
	}
	var workspace []string
	if d, ok := defaultWorkspacePath(); ok {
		workspace = append(workspace, d)
	}
	return files.AllowedRoots(poolProjects, workspace)
}

func fsService() *files.Service {
	return &files.Service{Roots: fsAllowedRoots}
}

func fsListReq(root, dir string, req int) {
	if req == 0 {
		return
	}
	res, err := fsService().List(root, dir)
	if err != nil {
		if errors.Is(err, files.ErrRootNotAllowed) {
			log.Printf("[fs] 拒绝列出：根不在项目池里 root=%q dir=%q", root, dir)
		} else {
			log.Printf("[fs] 列目录失败 root=%s dir=%s err=%v", root, dir, err)
		}
		pushJSON(map[string]any{"type": "fs.err", "req": req, "op": "list",
			"path": dir, "err": err.Error()})
		return
	}
	log.Printf("[fs] list root=%s dir=%s entries=%d truncated=%v",
		root, res.Path, len(res.Entries), res.Truncated)
	pushJSON(map[string]any{"type": "fs.list", "req": req, "root": root,
		"path": res.Path, "entries": res.Entries, "truncated": res.Truncated})
}

func fsReadReq(root, path string, req int) {
	if req == 0 {
		return
	}
	res, err := fsService().Read(root, path)
	if err != nil {
		if errors.Is(err, files.ErrRootNotAllowed) {
			log.Printf("[fs] 拒绝读取：根不在项目池里 root=%q path=%q", root, path)
		} else {
			log.Printf("[fs] 读文件失败 root=%s path=%s err=%v", root, path, err)
		}
		pushJSON(map[string]any{"type": "fs.err", "req": req, "op": "read",
			"path": path, "err": err.Error()})
		return
	}
	log.Printf("[fs] read root=%s path=%s size=%d text=%d truncated=%v binary=%v enc=%s",
		root, res.Path, res.Size, len(res.Text), res.Truncated, res.Binary, res.Encoding)
	pushJSON(map[string]any{"type": "fs.read", "req": req, "root": root,
		"path": res.Path, "rel": res.Rel, "size": res.Size, "text": res.Text,
		"truncated": res.Truncated, "binary": res.Binary, "encoding": res.Encoding})
}
