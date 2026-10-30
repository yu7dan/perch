package ctl

import (
	"errors"
	"log"
	"strings"

	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/uimsg"
)

func (s *Server) handleProjects(m *Msg) {
	switch m.Type {
	case "project.pick":
		s.projectPick(m)
	case "project.add":
		s.projectAdd(m)
	case "project.create":
		s.projectCreate(m)
	case "project.remove":
		s.projectRemove(m)
	case "project.pin":
		s.projectPin(m)
	case "project.rename":
		s.projectRename(m)
	}
}

// projectPick only asks the user for a folder. It deliberately does not touch
// the pool: the UI shows a confirmation step, and only "Add" may mutate state.
// The reply carries the request token, so a cancelled picker is a normal,
// correlated answer instead of a missing frame the frontend has to time out.
func (s *Server) projectPick(m *Msg) {
	if s.deps.UI == nil {
		s.pushProjectPicked(m.Req, "", true, ErrNoWindow)
		return
	}
	title := strings.TrimSpace(m.Msg)
	if title == "" {
		title = "选择一个文件夹"
	}
	// The picker blocks for as long as the user stares at it. Run it off the
	// ctl receive loop; otherwise tab.new answers would queue behind it.
	go s.pickProject(m.Req, title)
}

func (s *Server) pickProject(req int, title string) {
	sel, err := s.deps.UI.ChooseDirectory(title)
	if err != nil {
		if errors.Is(err, ErrPickerCancelled) {
			log.Printf("[pool] 选择器被取消（req=%d，没有加任何项目）", req)
			s.pushProjectPicked(req, "", true, nil)
			return
		}
		log.Printf("[pool] 文件夹选择器失败 req=%d：%v", req, err)
		s.pushProjectPicked(req, "", false, uimsg.Wrap(err, "pool.pickerFailed",
			"选择器打不开："+err.Error(), map[string]string{"err": err.Error()}))
		return
	}
	if strings.TrimSpace(sel) == "" {
		log.Printf("[pool] 选择器返回空路径 req=%d（按取消处理）", req)
		s.pushProjectPicked(req, "", true, nil)
		return
	}
	log.Printf("[pool] 选择器返回 req=%d path=%s（尚未写项目池）", req, sel)
	s.pushProjectPicked(req, sel, false, nil)
}

func (s *Server) pushProjectPicked(req int, path string, canceled bool, err error) {
	m := map[string]any{
		"type":     "project.picked",
		"req":      req,
		"path":     path,
		"canceled": canceled,
	}
	s.Push(withUIErr(m, err))
}

// projectAdd adds an already-chosen path. The old no-path form (open picker,
// add immediately, then hope a pool snapshot updates the card) is gone: pick
// and add are separate decisions now.
func (s *Server) projectAdd(m *Msg) {
	if s.deps.Pool == nil {
		s.pushProjectResult(m.Req, "add", nil, map[string]any{"path": m.Path},
			uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）"))
		return
	}
	path := strings.TrimSpace(m.Path)
	if path == "" {
		s.pushProjectResult(m.Req, "add", nil, nil,
			uimsg.New("project.pathRequired", "没有选择要加入的文件夹"))
		return
	}
	pr, added, err := s.deps.Pool.Add(path, m.Name, m.Source)
	if err != nil {
		log.Printf("[pool] 加项目失败 req=%d %s：%v", m.Req, path, err)
		s.pushProjectResult(m.Req, "add", nil, map[string]any{"path": path}, err)
		return
	}
	log.Printf("[pool] 加项目 %q（%s）路径=%s 新增=%v req=%d", pr.Name, pr.Source, pr.Path, added, m.Req)
	s.pushProjectResult(m.Req, "add", &pr, map[string]any{
		"path": pr.Path, "added": added, "created": false,
	}, nil)
	if added {
		s.refreshPoolAsync("加项目")
	}
}

// projectCreate creates one empty directory under parent and then adds it.
// It never overwrites and never deletes on a later persistence failure: the
// folder is a user artifact once created, and we say so instead of silently
// rolling it back.
func (s *Server) projectCreate(m *Msg) {
	if s.deps.Pool == nil {
		s.pushProjectResult(m.Req, "create", nil, map[string]any{"path": m.Path},
			uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）"))
		return
	}
	path, err := project.CreateFolder(m.Path, m.Name)
	if err != nil {
		log.Printf("[pool] 建文件夹失败 req=%d parent=%s name=%q：%v", m.Req, m.Path, m.Name, err)
		extra := map[string]any{"created": false}
		if path != "" {
			extra["path"] = path
		}
		s.pushProjectResult(m.Req, "create", nil, extra, err)
		return
	}
	pr, added, addErr := s.deps.Pool.Add(path, m.Name, "manual")
	if addErr != nil {
		// The directory exists now; do not remove it. Tell the UI both facts
		// so it can offer "add the existing folder" as a retry.
		log.Printf("[pool] 文件夹已建但加入池子失败 path=%s：%v", path, addErr)
		s.pushProjectResult(m.Req, "create", nil, map[string]any{
			"path": path, "created": true, "added": false,
		}, addErr)
		return
	}
	log.Printf("[pool] 新建并添加项目 %q 路径=%s 新增=%v req=%d", pr.Name, pr.Path, added, m.Req)
	s.pushProjectResult(m.Req, "create", &pr, map[string]any{
		"path": pr.Path, "created": true, "added": added,
	}, nil)
	if added {
		s.refreshPoolAsync("新建项目文件夹")
	}
}

// projectRemove only removes the pool record; the directory is never touched.
func (s *Server) projectRemove(m *Msg) {
	if s.deps.Pool == nil {
		s.pushProjectResult(m.Req, "remove", nil, map[string]any{"path": m.Path},
			uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）"))
		return
	}
	ok, err := s.deps.Pool.Remove(m.Path)
	if err != nil {
		log.Printf("[pool] 移除失败 %s：%v", m.Path, err)
		s.pushProjectResult(m.Req, "remove", nil, map[string]any{"path": m.Path, "removed": false}, err)
		return
	}
	log.Printf("[pool] 移除项目 %s（只从池子里摘掉，磁盘未动）命中=%v req=%d", m.Path, ok, m.Req)
	s.pushProjectResult(m.Req, "remove", nil, map[string]any{"path": m.Path, "removed": ok, "hidden": s.deps.Pool.HiddenDirs()}, nil)
	if ok {
		s.refreshPoolAsync("移除项目")
	}
}

func (s *Server) projectPin(m *Msg) {
	if s.deps.Pool == nil {
		s.pushProjectResult(m.Req, "pin", nil, map[string]any{"path": m.Path},
			uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）"))
		return
	}
	ok, err := s.deps.Pool.SetPinned(m.Path, m.On)
	if err != nil {
		log.Printf("[pool] 置顶改动失败 %s：%v", m.Path, err)
		s.pushProjectResult(m.Req, "pin", nil, map[string]any{"path": m.Path, "pinned": !m.On}, err)
		return
	}
	var pr *project.Project
	if p, found := s.deps.Pool.Get(m.Path); found {
		pr = &p
	}
	log.Printf("[pool] 置顶 %s = %v 命中=%v req=%d", m.Path, m.On, ok, m.Req)
	extra := map[string]any{"path": m.Path, "pinned": m.On}
	if pr != nil {
		extra["name"] = pr.Name
	}
	s.pushProjectResult(m.Req, "pin", pr, extra, nil)
	if ok {
		s.refreshPoolAsync("置顶项目")
	}
}

// projectRename changes the display name only. Empty name restores the folder
// basename (see Pool.Rename); the directory itself is untouched.
func (s *Server) projectRename(m *Msg) {
	if s.deps.Pool == nil {
		s.pushProjectResult(m.Req, "rename", nil, map[string]any{"path": m.Path},
			uimsg.New("pool.unavailableRead", "项目池不可用（读配置目录失败）"))
		return
	}
	ok, err := s.deps.Pool.Rename(m.Path, m.Name)
	if err != nil {
		log.Printf("[pool] 改名失败 %s：%v", m.Path, err)
		s.pushProjectResult(m.Req, "rename", nil, map[string]any{"path": m.Path}, err)
		return
	}
	var pr *project.Project
	if p, found := s.deps.Pool.Get(m.Path); found {
		pr = &p
	}
	log.Printf("[pool] 改名 %s → %q 命中=%v req=%d", m.Path, m.Name, ok, m.Req)
	extra := map[string]any{"path": m.Path}
	if pr != nil {
		extra["name"] = pr.Name
	}
	s.pushProjectResult(m.Req, "rename", pr, extra, nil)
	if ok {
		s.refreshPoolAsync("项目改名")
	}
}

// pushProjectResult is the immediate acknowledgement for every project write.
// The heavy pool snapshot (counts/assignment) follows asynchronously; the UI
// can insert a row, select it, and enable the next step without waiting for a
// 176-session scan.
func (s *Server) pushProjectResult(req int, op string, pr *project.Project,
	extra map[string]any, err error) {
	m := map[string]any{
		"type": "project.result",
		"req":  req,
		"op":   op,
		"ok":   err == nil,
	}
	if pr != nil {
		m["project"] = project.Wire{Project: *pr}
	}
	// Monotonic pool revision: the UI refuses a full pool snapshot older than
	// the last project.result it applied. Without it, a 12s background scan
	// started before a second add could erase that add's row when it lands.
	if err == nil && s.deps.Pool != nil {
		m["rev"] = s.deps.Pool.Rev()
	}
	for k, v := range extra {
		m[k] = v
	}
	s.Push(withUIErr(m, err))
}
