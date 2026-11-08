//go:build !windows

package ctl

import (
	"os"
	"path/filepath"
	"strings"
)

func listDrives() []dirEntry { return []dirEntry{{Name: "/", Path: "/"}} }

func browsePlaces() []dirEntry {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return []dirEntry{{Name: "主目录", Path: home}, {Name: "桌面", Path: filepath.Join(home, "Desktop")}}
}

func hiddenDir(_, name string) bool { return strings.HasPrefix(name, ".") }
