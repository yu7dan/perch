//go:build perch_embedded_hook

package main

import _ "embed"

// Build scripts place the freshly built hook receiver here before building
// the single-file release. The file is generated and gitignored.
//
//go:embed hookbin/perch-hook.exe
var embeddedHook []byte
