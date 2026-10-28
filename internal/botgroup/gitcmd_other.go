//go:build !windows

package botgroup

import "os/exec"

func hideWindow(*exec.Cmd) {}
