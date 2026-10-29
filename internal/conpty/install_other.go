//go:build !windows

package conpty

import "errors"

// InstallBundled 只在 Windows 上有意义。
func InstallBundled() (string, error) { return "", errors.New("bundled ConPTY is Windows-only") }

// Bundled 只在 Windows 上有意义。
func Bundled() bool { return false }
