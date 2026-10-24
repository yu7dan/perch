package main

import _ "embed"

// The app icon is used for the window/taskbar by Wails. The Explorer/shell
// icon and version metadata come from resource_windows_amd64.syso, generated
// by scripts/build.ps1.
//
//go:embed appicon.png
var appIcon []byte
