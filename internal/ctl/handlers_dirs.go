package ctl

import (
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// dir.browse 是台面「选文件夹」窗口的数据腿（0.1.1）：在盘上任意位置挑一个已有的
// 文件夹，或者进到某个位置新建一个。只回**子文件夹的名字和路径**，不读文件、不回文件名 ——
// 这一条路的用途就是"挑个位置"，比 fs.list（项目里的文件树）宽，但看到的东西少得多。
//
//	{type:"dir.browse", req, path}   path 空 = 「此电脑」：盘符 + 常用位置
//	→ {type:"dir.browse", req, path, dirs:[{name,path}], places:[{name,path}], err?}
//
// 隐藏 / 系统文件夹（$Recycle.Bin、System Volume Information……）不列：那不是用户会
// 拿来放项目的地方，列出来只会让人点进去碰一鼻子「拒绝访问」。

const maxBrowseDirs = 2000

type dirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (s *Server) dirBrowse(m *Msg) {
	go func() {
		path := strings.TrimSpace(m.Path)
		out := map[string]any{"type": "dir.browse", "req": m.Req, "path": path, "places": browsePlaces()}
		if path == "" {
			out["dirs"] = listDrives()
			s.Push(out)
			return
		}
		abs, err := filepath.Abs(path)
		if err == nil {
			path = abs
		}
		out["path"] = path
		ents, err := os.ReadDir(path)
		if err != nil {
			log.Printf("[dirs] 列不出 %s：%v", path, err)
			out["dirs"] = []dirEntry{}
			out["err"] = err.Error()
			s.Push(out)
			return
		}
		dirs := make([]dirEntry, 0, len(ents))
		for _, e := range ents {
			full := filepath.Join(path, e.Name())
			if !e.IsDir() {
				// 指向文件夹的符号链接 / 联接点也算文件夹（用户的工作区常放在联接点后面）。
				if e.Type()&os.ModeSymlink == 0 {
					continue
				}
				if st, err := os.Stat(full); err != nil || !st.IsDir() {
					continue
				}
			}
			if hiddenDir(full, e.Name()) {
				continue
			}
			dirs = append(dirs, dirEntry{Name: e.Name(), Path: full})
			if len(dirs) >= maxBrowseDirs {
				out["truncated"] = true
				break
			}
		}
		sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name) })
		out["dirs"] = dirs
		s.Push(out)
	}()
}
