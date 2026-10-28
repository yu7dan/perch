package botgroup

import (
	"os/exec"
	"syscall"
)

// hideWindow：GUI 进程起 git 时不弹黑窗口（CREATE_NO_WINDOW）。
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
