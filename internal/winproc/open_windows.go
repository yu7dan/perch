package winproc

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// OpenPath 用系统默认方式打开一个路径（"在资源管理器里选中"= mode "reveal"）。
//
// 只用 explorer.exe 一个程序，**不经过 cmd.exe**：路径里出现 `&` 时
// `cmd /c start` 会把它当成命令分隔符，而会话的 cwd 是**从盘上读来的文本**，
// 不是我们能控制的常量。explorer 收的是 argv，没有第二层解析。
func OpenPath(mode, path string) {
	if path == "" {
		log.Printf("[perch] open 拿到空路径，忽略")
		return
	}
	if !filepath.IsAbs(path) {
		log.Printf("[perch] open 只接受绝对路径，拒绝 %q", path)
		return
	}
	if _, err := os.Stat(path); err != nil {
		log.Printf("[perch] open 目标不在了（%v），忽略：%s", err, path)
		return
	}
	args := []string{path}
	if mode == "reveal" {
		// `/select,<path>` 必须是**一个** argv —— 这是 explorer 的写法，
		// 中间那个逗号不是分隔符。
		args = []string{"/select," + path}
	}
	if err := exec.Command("explorer.exe", args...).Start(); err != nil {
		log.Printf("[perch] open 失败 mode=%s path=%s: %v", mode, path, err)
		return
	}
	log.Printf("[perch] open mode=%s path=%s", mode, path)
}
