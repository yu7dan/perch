//go:build !perch_embedded_hook

package main

// Development builds keep using build\perch-hook.exe next to perch.exe.
var embeddedHook []byte
