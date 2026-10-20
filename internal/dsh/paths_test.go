package dsh

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestProfileAndHooksReady(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DSH_HOME", home)

	profile := profilePackage{
		Dependencies: map[string]string{
			TUIPackage:   "0.16.1",
			HookBridge:   "0.2.1-rc.2",
			HookProtocol: "0.2.1-rc.2",
		},
	}
	profile.DSH.Profile.Bundles = []string{"@deepseek-ai/dsh-base", TUIPackage}
	b, _ := json.Marshal(profile)
	writeTestFile(t, ProfilePackagePath(), b)

	bridge := bridgePackage{PeerDependencies: map[string]string{
		HookProtocol: "0.2.1-rc.2",
	}}
	bb, _ := json.Marshal(bridge)
	writeTestFile(t, bridgePackagePath(), bb)

	stateDir := t.TempDir()
	hooksPath := HooksPath(stateDir)
	hooks, err := BuildHooksJSON(`C:\perch-hook.exe`, filepath.Join(stateDir, "hook-events"))
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, hooksPath, hooks)

	patch, err := ApplyManagedPatch("[]\n", hooksPath)
	if err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, HomePatchPath(), []byte(patch))

	if !ProfileReady() {
		t.Fatal("ProfileReady should be true")
	}
	if !HooksReady() {
		t.Fatal("HooksReady should be true")
	}

	// Removing a peer makes the bridge unloadable at runtime; HooksReady must say so.
	profile.Dependencies = map[string]string{TUIPackage: "0.16.1", HookBridge: "0.2.1-rc.2"}
	b, _ = json.Marshal(profile)
	writeTestFile(t, ProfilePackagePath(), b)
	if HooksReady() {
		t.Fatal("HooksReady should be false when a bridge peer is missing")
	}
}

func TestProfileReadyFalseWithoutTUIPackage(t *testing.T) {
	t.Setenv("DSH_HOME", t.TempDir())
	profile := profilePackage{Dependencies: map[string]string{}}
	b, _ := json.Marshal(profile)
	writeTestFile(t, ProfilePackagePath(), b)
	if ProfileReady() {
		t.Fatal("ProfileReady should be false without the TUI package")
	}
}

func TestHooksReadyFalseWithoutManagedBlock(t *testing.T) {
	t.Setenv("DSH_HOME", t.TempDir())
	if HooksReady() {
		t.Fatal("HooksReady should be false with no profile and no patch")
	}
}
