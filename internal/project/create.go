package project

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/yu7dan/perch/internal/uimsg"
)

// CreateFolder creates exactly one new directory under parent and returns its
// absolute path. It never overwrites an existing entry, never creates the
// parent, and never recursively deletes on failure.
//
// The returned path is also present when the target already exists (with a
// createExists error) so the UI can offer "add this existing folder instead"
// without making the user pick it again.
func CreateFolder(parent, name string) (string, error) {
	parent = strings.TrimSpace(parent)
	name = strings.TrimSpace(name)
	if parent == "" {
		return "", uimsg.New("project.createParentRequired", "先选择一个位置，再创建文件夹")
	}
	if name == "" {
		return "", uimsg.New("project.createNameEmpty", "文件夹名称不能为空")
	}
	if err := validateFolderName(name); err != nil {
		return "", err
	}
	abs, err := filepath.Abs(parent)
	if err != nil {
		return "", uimsg.Wrap(err, "project.createParentMissing",
			fmt.Sprintf("这个位置看不懂：%v", err), map[string]string{"err": err.Error()})
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", uimsg.Wrap(err, "project.createParentMissing",
			fmt.Sprintf("这个位置不存在或读不到：%v", err), map[string]string{"err": err.Error()})
	}
	if !st.IsDir() {
		return "", uimsg.New("project.createParentNotDir", "选择的位置不是文件夹")
	}

	dest := filepath.Join(abs, name)
	if st, err := os.Stat(dest); err == nil {
		if st.IsDir() {
			return dest, uimsg.New("project.createExists", "这个文件夹已经存在")
		}
		return dest, uimsg.New("project.createFileExists", "同名的文件已经存在，不能再建文件夹")
	} else if !os.IsNotExist(err) {
		return "", uimsg.Wrap(err, "project.createFailed",
			fmt.Sprintf("检查这个文件夹时失败：%v", err), map[string]string{"err": err.Error()})
	}
	if err := os.Mkdir(dest, 0o755); err != nil {
		return "", uimsg.Wrap(err, "project.createFailed",
			fmt.Sprintf("建文件夹失败：%v", err), map[string]string{"err": err.Error()})
	}
	return dest, nil
}

func validateFolderName(name string) error {
	if name == "." || name == ".." {
		return uimsg.NewParams("project.createInvalidName", "文件夹名称不能用：{name}",
			map[string]string{"name": name})
	}
	if strings.ContainsAny(name, `<>:"/\|?*`) || strings.IndexFunc(name, func(r rune) bool {
		return r < 32
	}) >= 0 {
		return uimsg.NewParams("project.createInvalidName", "文件夹名称含有不能用的字符：{name}",
			map[string]string{"name": name})
	}
	if strings.HasSuffix(name, " ") || strings.HasSuffix(name, ".") {
		return uimsg.NewParams("project.createInvalidName", "文件夹名称不能以空格或点结尾：{name}",
			map[string]string{"name": name})
	}
	if len([]rune(name)) > 240 {
		return uimsg.NewParams("project.createInvalidName", "文件夹名称太长：{name}",
			map[string]string{"name": name})
	}
	base := name
	if i := strings.IndexRune(base, '.'); i >= 0 {
		// Windows reserves device names with or without an extension.
		base = base[:i]
	}
	switch strings.ToUpper(strings.TrimSpace(base)) {
	case "CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return uimsg.NewParams("project.createInvalidName", "这个名称是 Windows 保留名：{name}",
			map[string]string{"name": name})
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return uimsg.NewParams("project.createInvalidName", "文件夹名称含有控制字符：{name}",
				map[string]string{"name": name})
		}
	}
	return nil
}
