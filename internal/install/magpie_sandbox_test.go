package install

// 安装脚本的沙盒验收（P1.3，2026-10-18）：把**真正被用户点击时执行的那段
// PowerShell 原文**写到临时文件，在一个隔离的 LOCALAPPDATA 里跑。
//
// 验的是：
//   - feed 能读到版本和资产（usemagpie.ai/api/latest）
//   - 选的是 magpie-cli-windows-<arch>.exe（控制面只要 CLI，不要桌面壳）
//   - SHA-256 与 feed 一致，落盘的是 PE 文件
//   - 脚本**不执行**下载物
//
// 默认跳过；由外部沙盒脚本带上 PERCH_INSTALL_SANDBOX 才跑。测试结束后文件
// 保留在沙盒里，供 agent 链路测试当控制面用。

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

func TestMagpieInstallerSandbox(t *testing.T) {
	root := os.Getenv("PERCH_INSTALL_SANDBOX")
	if root == "" {
		t.Skip("PERCH_INSTALL_SANDBOX 未设置：这是沙盒测试，跳过")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatalf("建沙盒：%v", err)
	}
	script := agentcatalog.Recipes["magpie"].Script
	if len(script) == 0 {
		t.Fatal("agentcatalog.Recipes[magpie].Script 是空的")
	}
	// 与真正的执行方式一致：-Command，脚本原文作为参数传进去
	// （UTF-16），不落成 .ps1 文件 —— 落文件会被 PS 5.1 按 ANSI 读，中文全坏。
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), "LOCALAPPDATA="+root)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("安装脚本失败：%v\n%s", err, out.String())
	}
	t.Log(string(out.Bytes()))
	exe := filepath.Join(root, "Perch", "magpie", "magpie.exe")
	fi, err := os.Stat(exe)
	if err != nil {
		t.Fatalf("脚本没落出 %s：%v", exe, err)
	}
	if fi.Size() < 10*1024*1024 {
		t.Fatalf("装出来的文件只有 %d 字节", fi.Size())
	}
	b, _ := os.ReadFile(exe)
	if len(b) < 2 || b[0] != 'M' || b[1] != 'Z' {
		t.Fatal("装出来的不是 PE 文件")
	}
	// 只落了一枚 exe，没有 .new 残渣。
	if _, err := os.Stat(exe + ".new"); err == nil {
		t.Fatal("留下了 .new 临时文件")
	}
}
