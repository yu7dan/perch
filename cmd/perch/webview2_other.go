//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func webView2Check(*application.App) bool { return true }
