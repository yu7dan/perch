//go:build windows

package main

import "github.com/yu7dan/perch/internal/term"

// 这一层只是把旧名字接到 internal/term；实现已经搬走，root 在 6b 收掉。
type ptySession = term.Session

func startPTY(exe string, args []string, cwd string, env []string, cols, rows int) (*ptySession, error) {
	return term.Start(exe, args, cwd, env, cols, rows)
}
