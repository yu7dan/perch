//go:build !windows

package providers

import (
	"encoding/base64"
	"fmt"
	"strings"
)

// 非 Windows（目前只有测试和 macOS 移植在用）：没有 DPAPI，只做 base64 并标明
// "plain:"，让人一眼看出它没加密。macOS 正式版要换成钥匙串。
const secretPrefix = "plain:"

func sealSecret(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	return secretPrefix + base64.StdEncoding.EncodeToString([]byte(plain)), nil
}

func openSecret(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}
	if !strings.HasPrefix(sealed, secretPrefix) {
		return "", fmt.Errorf("未知的密钥格式")
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(sealed, secretPrefix))
	return string(b), err
}
