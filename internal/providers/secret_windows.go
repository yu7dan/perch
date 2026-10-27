//go:build windows

package providers

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 密钥落盘用 Windows DPAPI（CryptProtectData，当前用户范围）：只有同一个 Windows
// 账户在这台机器上解得开，拷走 providers.json 也没用。盘上的形状是
// "dpapi:<base64>"；读不出（换了账户 / 文件被拷到别处）就当没有 key，不报错崩溃。

const secretPrefix = "dpapi:"

var secretEntropy = []byte("perch.providers.v1")

func sealSecret(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	in := blob([]byte(plain))
	ent := blob(secretEntropy)
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", fmt.Errorf("DPAPI 加密失败: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	b := unsafe.Slice(out.Data, out.Size)
	return secretPrefix + base64.StdEncoding.EncodeToString(b), nil
}

func openSecret(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	if !strings.HasPrefix(sealed, secretPrefix) {
		return "", fmt.Errorf("未知的密钥格式")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(sealed, secretPrefix))
	if err != nil {
		return "", fmt.Errorf("密钥不是合法的 base64: %w", err)
	}
	in := blob(raw)
	ent := blob(secretEntropy)
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return "", fmt.Errorf("DPAPI 解密失败（换了 Windows 账户？）: %w", err)
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return string(unsafe.Slice(out.Data, out.Size)), nil
}

func blob(b []byte) windows.DataBlob {
	if len(b) == 0 {
		return windows.DataBlob{}
	}
	return windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}
