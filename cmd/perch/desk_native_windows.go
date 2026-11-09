//go:build windows

package main

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

//go:embed desk_apps.ps1
var deskAppsScript string

var (
	procSetWindowLongPtr       = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos           = user32.NewProc("SetWindowPos")
	procClientToScreen         = user32.NewProc("ClientToScreen")
	procIsWindow               = user32.NewProc("IsWindow")
	procIsWindowVisible        = user32.NewProc("IsWindowVisible")
	procIsIconic               = user32.NewProc("IsIconic")
	procIsZoomed               = user32.NewProc("IsZoomed")
	procShowWindow             = user32.NewProc("ShowWindow")
	procPostMessage            = user32.NewProc("PostMessageW")
	procGetWindowTextW         = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW   = user32.NewProc("GetWindowTextLengthW")
	procGetWindowLongPtr       = user32.NewProc("GetWindowLongPtrW")
	procGetWindow              = user32.NewProc("GetWindow")
	procEnumWindows            = user32.NewProc("EnumWindows")
	procGetWindowThreadProcess = user32.NewProc("GetWindowThreadProcessId")
	procSetForegroundWindow    = user32.NewProc("SetForegroundWindow")
	procGetWindowRect          = user32.NewProc("GetWindowRect")
	procGetClassNameW          = user32.NewProc("GetClassNameW")
	procDwmGetWindowAttribute  = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmGetWindowAttribute")
)

const (
	gwlpHwndParent    = ^uintptr(7)  // -8
	gwlExStyle        = ^uintptr(19) // -20
	wsExToolWindow    = 0x00000080
	gwOwner           = 4
	swpNoSize         = 0x0001
	swpNoMove         = 0x0002
	swpNoZOrder       = 0x0004
	swpNoActivate     = 0x0010
	swpNoOwnerZOrder  = 0x0200
	swShowNoActivate  = 4
	swShowMinNoActive = 7
	swRestore         = 9
	wmClose           = 0x0010
	dwmwaCloaked      = 14
	hwndTop           = 0
)

func hwndOf(w *application.WebviewWindow) uintptr {
	if w == nil {
		return 0
	}
	return uintptr(w.NativeWindow())
}

type point struct{ X, Y int32 }
type rect struct{ L, T, R, B int32 }

func nativeClientOrigin(main *application.WebviewWindow) (int, int) {
	p := point{}
	procClientToScreen.Call(hwndOf(main), uintptr(unsafe.Pointer(&p)))
	return int(p.X), int(p.Y)
}

// 网页窗口挂在主窗口名下（同一个进程，安全）：永远在台面之上，台面最小化它跟着。
func nativeSetOwner(w, main *application.WebviewWindow) {
	procSetWindowLongPtr.Call(hwndOf(w), gwlpHwndParent, hwndOf(main))
}

func nativeMove(w *application.WebviewWindow, x, y, ww, hh int) {
	procSetWindowPos.Call(hwndOf(w), 0, uintptr(x), uintptr(y), uintptr(ww), uintptr(hh), swpNoActivate|swpNoZOrder|swpNoOwnerZOrder)
}

func nativeIsWindow(h uintptr) bool { r, _, _ := procIsWindow.Call(h); return r != 0 }

func nativeMoveForeign(h uintptr, x, y, ww, hh int) bool {
	if r, _, _ := procIsZoomed.Call(h); r != 0 {
		procShowWindow.Call(h, swRestore)
	}
	r, _, _ := procSetWindowPos.Call(h, 0, uintptr(x), uintptr(y), uintptr(ww), uintptr(hh), swpNoActivate|swpNoZOrder)
	return r != 0
}

// 不露的应用窗口：放到主窗口后面（不藏、不最小化 —— Perch 这时万一退了，它照样在）。
func nativeSendBehind(h uintptr, main *application.WebviewWindow) {
	procSetWindowPos.Call(h, hwndOf(main), 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

// 贴着的应用窗口要在台面之上：逐个提到最上面（不激活），主窗口再压到它们下面。
func nativeRaiseOver(main *application.WebviewWindow, hs []uintptr) {
	if len(hs) == 0 {
		return
	}
	for _, h := range hs {
		procSetWindowPos.Call(h, hwndTop, 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
	}
	procSetWindowPos.Call(hwndOf(main), hs[0], 0, 0, 0, 0, swpNoMove|swpNoSize|swpNoActivate)
}

func nativeRestoreIfNeeded(h uintptr) {
	if r, _, _ := procIsIconic.Call(h); r != 0 {
		procShowWindow.Call(h, swShowNoActivate)
	}
	if r, _, _ := procIsZoomed.Call(h); r != 0 {
		procShowWindow.Call(h, swRestore)
	}
}

func nativeMinimize(h uintptr) bool {
	if !nativeIsWindow(h) {
		return false
	}
	if r, _, _ := procIsIconic.Call(h); r != 0 {
		return false
	}
	procShowWindow.Call(h, swShowMinNoActive)
	return true
}

// 弹出成普通窗口：不再贴着，往旁边挪一点、拿到前台，让人看得出它「出来了」。
func nativePopOut(h uintptr) {
	r := rect{}
	procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	procSetWindowPos.Call(h, hwndTop, uintptr(r.L+40), uintptr(r.T+40), 0, 0, swpNoSize)
	procSetForegroundWindow.Call(h)
}

func nativeWindowSize(h uintptr) (int, int) {
	r := rect{}
	procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return int(r.R - r.L), int(r.B - r.T)
}

func nativePostClose(h uintptr) { procPostMessage.Call(h, wmClose, 0, 0) }

func nativeWindowTitle(h uintptr) string {
	n, _, _ := procGetWindowTextLengthW.Call(h)
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	procGetWindowTextW.Call(h, uintptr(unsafe.Pointer(&buf[0])), n+1)
	return syscall.UTF16ToString(buf)
}

func nativeWindowClass(h uintptr) string {
	buf := make([]uint16, 128)
	n, _, _ := procGetClassNameW.Call(h, uintptr(unsafe.Pointer(&buf[0])), 128)
	return syscall.UTF16ToString(buf[:n])
}

func nativeWindowExe(h uintptr) (string, uint32) {
	var pid uint32
	procGetWindowThreadProcess.Call(h, uintptr(unsafe.Pointer(&pid)))
	ph, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", pid
	}
	defer windows.CloseHandle(ph)
	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(ph, 0, &buf[0], &n) != nil {
		return "", pid
	}
	return filepath.Base(syscall.UTF16ToString(buf[:n])), pid
}

// 像个「应用窗口」的顶层窗口：看得见、有标题、不是工具窗、没有 owner、没被 DWM 藏着（商店应用的后台窗口是 cloaked 的）。
//
// ⚠️ 回调只建一次：syscall.NewCallback 建出来的回调永不释放，一个进程最多两千来个，用完就 panic
// （「too many callback functions」）—— 认窗口时每 300ms 列一次顶层窗口，开十几次应用就会把 Perch 带走。
var (
	enumMu  sync.Mutex
	enumOut []uintptr
	enumCB  = syscall.NewCallback(func(h, _ uintptr) uintptr {
		if r, _, _ := procIsWindowVisible.Call(h); r == 0 {
			return 1
		}
		if n, _, _ := procGetWindowTextLengthW.Call(h); n == 0 {
			return 1
		}
		if ex, _, _ := procGetWindowLongPtr.Call(h, gwlExStyle); ex&wsExToolWindow != 0 {
			return 1
		}
		if o, _, _ := procGetWindow.Call(h, gwOwner); o != 0 {
			return 1
		}
		var cloaked uint32
		procDwmGetWindowAttribute.Call(h, dwmwaCloaked, uintptr(unsafe.Pointer(&cloaked)), 4)
		if cloaked != 0 {
			return 1
		}
		enumOut = append(enumOut, h)
		return 1
	})
)

func nativeTopWindows() []uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumOut = nil
	procEnumWindows.Call(enumCB, 0)
	out := enumOut
	enumOut = nil
	return out
}

// nativeLaunch：照开始菜单那样打开（桌面程序、商店应用都走 AppsFolder）。
func nativeLaunch(appID string) {
	if appID == "" || strings.ContainsAny(appID, "\r\n\"") {
		return
	}
	cmd := exec.Command("explorer.exe", `shell:AppsFolder\`+appID)
	if err := cmd.Start(); err != nil {
		log.Printf("[desk] 打开应用 %s 失败：%v", appID, err)
		return
	}
	go cmd.Wait()
}

/*
nativeLaunchAndFind：打开一个应用，认出它的窗口。

	启动走 explorer，拿不到进程号 —— 认「打开之后新冒出来的顶层窗口」（有 exe 名就只认那个 exe 的）；
	15 秒没冒新窗口、而它本来就开着（单实例程序只会把旧窗口叫到前面），就认那个 exe 已有的窗口。
*/
func nativeLaunchAndFind(appID, exeHint string) (uintptr, string) {
	self := uint32(os.Getpid())
	before := map[uintptr]bool{}
	for _, h := range nativeTopWindows() {
		before[h] = true
	}
	nativeLaunch(appID)
	// 资源管理器自己冒出来的窗口（比如「找不到这个应用」的提示框）不是它；除非开的就是资源管理器
	wantExplorer := strings.EqualFold(exeHint, "explorer.exe") || strings.Contains(strings.ToLower(appID), "explorer")
	match := func(h uintptr) bool {
		exe, pid := nativeWindowExe(h)
		if pid == self || nativeWindowClass(h) == "#32770" {
			return false
		}
		if !wantExplorer && strings.EqualFold(exe, "explorer.exe") {
			return false
		}
		return exeHint == "" || strings.EqualFold(exe, exeHint)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		for _, h := range nativeTopWindows() {
			if !before[h] && match(h) {
				time.Sleep(400 * time.Millisecond) // 让它先把自己摆好（启动时很多程序会自己挪一次）
				if nativeIsWindow(h) {
					return h, ""
				}
			}
		}
	}
	if exeHint != "" {
		for _, h := range nativeTopWindows() {
			if match(h) {
				return h, ""
			}
		}
	}
	return 0, "nowindow"
}

// ---- 应用清单（开始菜单）：缓存在 %LOCALAPPDATA%\Perch\apps ----

var appsScan struct {
	sync.Mutex
	running bool
	list    []nativeApp
	at      time.Time
}

func appsDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(base, "Perch", "apps")
}

func appIconPath(name string) string {
	if len(name) != 36 || !strings.HasSuffix(name, ".png") || strings.Trim(name[:32], "0123456789abcdef") != "" {
		return ""
	}
	return filepath.Join(appsDir(), "icons", name)
}

// nativeAppList：有缓存先给缓存（旧了就后台重扫，扫完 done）；没有就后台扫，loading=true。
func nativeAppList(fresh bool, done func([]nativeApp)) ([]nativeApp, bool) {
	appsScan.Lock()
	if appsScan.list == nil {
		if b, err := os.ReadFile(filepath.Join(appsDir(), "list.json")); err == nil {
			var l []nativeApp
			if json.Unmarshal(b, &l) == nil {
				appsScan.list = l
				if fi, err := os.Stat(filepath.Join(appsDir(), "list.json")); err == nil {
					appsScan.at = fi.ModTime()
				}
			}
		}
	}
	list := appsScan.list
	stale := list == nil || fresh || time.Since(appsScan.at) > 6*time.Hour
	start := stale && !appsScan.running
	if start {
		appsScan.running = true
	}
	appsScan.Unlock()
	if start {
		go func() {
			l := scanApps()
			appsScan.Lock()
			appsScan.running = false
			if l != nil {
				appsScan.list, appsScan.at = l, time.Now()
			}
			out := appsScan.list
			appsScan.Unlock()
			if out != nil {
				done(out)
			}
		}()
	}
	return list, list == nil
}

func scanApps() []nativeApp {
	dir := appsDir()
	if dir == "" {
		return nil
	}
	_ = os.MkdirAll(filepath.Join(dir, "icons"), 0o755)
	t0 := time.Now()
	u := utf16.Encode([]rune(deskAppsScript))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.Env = append(os.Environ(), "PERCH_APPICON_DIR="+filepath.Join(dir, "icons"))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		log.Printf("[desk] 读开始菜单失败：%v", err)
		return nil
	}
	s := strings.TrimSpace(strings.TrimPrefix(string(out), "\ufeff"))
	var l []nativeApp
	if json.Unmarshal([]byte(s), &l) != nil {
		log.Printf("[desk] 开始菜单清单看不懂（%d 字节）", len(s))
		return nil
	}
	_ = os.WriteFile(filepath.Join(dir, "list.json"), []byte(s), 0o644)
	log.Printf("[desk] 开始菜单：%d 个应用（%.1fs）", len(l), time.Since(t0).Seconds())
	return l
}
