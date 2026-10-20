package main

// 这一层只是把旧名字接到 internal/winproc；root 在 6b 收掉。

import (
	"syscall"

	"github.com/yu7dan/perch/internal/winproc"
)

const instanceMutexName = winproc.InstanceMutexName

func processAlive(pid int) bool { return winproc.Alive(pid) }

func acquireInstanceLock(name string) (bool, error) { return winproc.AcquireInstanceLock(name) }

func ownProcessTree() bool { return winproc.OwnProcessTree() }

func logJobInventory(why string) { winproc.LogJobInventory(why) }

func processTreeOwned() bool { return winproc.ProcessTreeOwned() }

func handoffSysProcAttr() *syscall.SysProcAttr { return winproc.HandoffSysProcAttr() }

func openPath(mode, path string) { winproc.OpenPath(mode, path) }

func findAgentExe(bin string) (string, bool) { return winproc.FindExe(bin) }

func resolveAgentExe(bin string) (string, []string) { return winproc.ResolveExe(bin) }

func wrapShim(p string) (string, []string) { return winproc.WrapShim(p) }

func probeAgentVersion(bin string) string { return winproc.ProbeVersion(bin) }

func reloadPathFromRegistry() { winproc.ReloadPathFromRegistry() }
