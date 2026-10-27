package ctl

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/yu7dan/perch/internal/project"
	"github.com/yu7dan/perch/internal/uimsg"
	"github.com/yu7dan/perch/internal/workspacebrief"
)

// handleWorkspaceBrief owns the project-scoped shared brief. The frontend sends
// a project root (or the synthetic default project root); this layer refuses
// arbitrary paths before they reach the file writer.
func (s *Server) handleWorkspaceBrief(m *Msg) {
	root, err := s.briefRoot(m.Path)
	if err != nil {
		s.pushBrief(nil, "", err)
		return
	}
	switch m.Type {
	case "workspace.brief.get":
		content, exists, err := workspacebrief.Read(root)
		if err != nil {
			s.pushBrief(nil, root, uimsg.Wrap(err, "brief.readFailed",
				"工作区 brief 读不出来："+err.Error(), map[string]string{"err": err.Error()}))
			return
		}
		s.pushBrief(&briefPayload{
			root: root, content: content, exists: exists,
		}, root, nil)
		log.Printf("[workspacebrief] 读取 project=%s exists=%v bytes=%d", root, exists, len(content))
	case "workspace.brief.set":
		res, err := workspacebrief.Set(root, m.Content)
		if err != nil {
			s.pushBrief(nil, root, briefWriteErr(err))
			log.Printf("[workspacebrief] 写入失败 project=%s bytes=%d err=%v", root, len(m.Content), err)
			return
		}
		s.pushBrief(&briefPayload{
			root: root, content: res.Content, exists: true,
			agentsPath: res.AgentsPath,
		}, root, nil)
		log.Printf("[workspacebrief] 写入 project=%s bytes=%d agents=%s", root, len(res.Content), res.AgentsPath)
	}
}

type briefPayload struct {
	root       string
	content    string
	exists     bool
	agentsPath string
}

func (s *Server) pushBrief(p *briefPayload, root string, err error) {
	out := map[string]any{
		"type": "workspace.brief",
		"ok":   err == nil,
	}
	if root != "" {
		out["path"] = root
		out["agentsPath"] = workspacebrief.AgentsPath(root)
	}
	if p != nil {
		out["path"] = p.root
		out["content"] = p.content
		out["exists"] = p.exists
		out["agentsPath"] = p.agentsPath
	}
	withUIErr(out, err)
	s.Push(out)
}

func briefWriteErr(err error) error {
	switch {
	case errors.Is(err, workspacebrief.ErrMalformedAgents):
		return uimsg.New("brief.malformedAgents",
			"AGENTS.md 里的 Perch 标记段不完整（只有开始或只有结束）；先修好它，或删掉那一半再保存。")
	case errors.Is(err, workspacebrief.ErrTooLarge):
		return uimsg.NewParams("brief.tooLarge",
			fmt.Sprintf("工作区 brief 太长（上限 %d KiB）。", workspacebrief.MaxBytes/1024),
			map[string]string{"kb": fmt.Sprintf("%d", workspacebrief.MaxBytes/1024)})
	default:
		return uimsg.Wrap(err, "brief.saveFailed",
			"工作区 brief 没写进去："+err.Error(), map[string]string{"err": err.Error()})
	}
}

// briefRoot accepts only a real project root or the effective default project
// root. A subdirectory or an arbitrary folder must be added as a project first.
func (s *Server) briefRoot(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", uimsg.New("brief.rootRequired", "没有指定项目目录。")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return "", uimsg.Wrap(err, "brief.badPath", "项目路径看不懂。", map[string]string{"err": err.Error()})
	}
	fi, err := os.Stat(abs)
	if err != nil || !fi.IsDir() {
		return "", uimsg.New("brief.rootMissing", "这个项目目录不在盘上，或者不是一个文件夹。")
	}
	key := project.PathKey(abs)
	if s.deps.DefaultCWD != nil && project.PathKey(s.deps.DefaultCWD()) == key {
		return abs, nil
	}
	if s.deps.Pool != nil {
		projects, _ := s.deps.Pool.Snapshot()
		for _, p := range projects {
			if project.PathKey(p.Path) == key {
				return abs, nil
			}
		}
	}
	return "", uimsg.New("brief.rootNotProject", "这个目录不是 Perch 里的项目；先把文件夹添加为项目。")
}
