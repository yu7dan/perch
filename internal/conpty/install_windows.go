//go:build windows

package conpty

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
)

// BundledVersion 是随包带的 ConPTY 版本（Windows Terminal 1.23.2510.08001；
// 取自 node-pty 1.1.0 的 third_party/conpty/1.23.251008001/win10-x64，与 Orca 同一份）。
const BundledVersion = "1.23.251008001"

//go:embed bin/conpty.dll
var conptyDLL []byte

//go:embed bin/OpenConsole.exe
var openConsoleExe []byte

// InstallBundled 把 conpty.dll 和 OpenConsole.exe 放到 <用户缓存目录>\Perch\conpty\<版本>\，
// 再切到它们。conpty.dll 会在**自己所在的目录**找 OpenConsole.exe，所以两个文件必须并排。
// 内容一样就不重写（OpenConsole 正被别的格子用着时也换不掉）。任何一步失败都返回错误、
// 继续用系统 ConPTY —— 能起格比用哪一份 ConPTY 更重要。
func InstallBundled() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "Perch", "conpty", BundledVersion)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	for _, f := range []struct {
		name string
		data []byte
	}{{"OpenConsole.exe", openConsoleExe}, {"conpty.dll", conptyDLL}} {
		p := filepath.Join(dir, f.name)
		if old, err := os.ReadFile(p); err == nil && bytes.Equal(old, f.data) {
			continue
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, f.data, 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(tmp, p); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("放 %s 失败：%w", p, err)
		}
	}
	dll := filepath.Join(dir, "conpty.dll")
	if err := UseBundled(dll); err != nil {
		return "", err
	}
	return dll, nil
}
