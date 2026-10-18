package main

// magpie 本体的版本与更新。
//
// 不自己读 feed、不自己下载 —— magpie 本身就有完整的更新器（internal/gui/
// update.go），控制面把状态和动作都放在 /api/update 上：
//
//	GET  /api/update          {state, current, latest, done, total, error, …}
//	POST /api/update/check    检查并开始下载
//	POST /api/update/install  装好并重启（web 版按原参数、原 key re-exec）
//
// 所以 Perch 只做两件事：把 current / latest 显示出来；用户点「更新」时
// 驱动这条已有的链路。**绝不**替用户静默更新，也不碰桌面 magpie ——
// restartToUpdate 对 `magpie web` 是原地 re-exec，桌面那个进程不受影响。
//
// 一个必须自己接住的细节：re-exec 之后控制面换了 PID。Perch 退出时要收的
// 是**新的**那个进程，否则会留下一个没人管的 sidecar。所以更新完成后按端口
// 重新认领（只认原来就是 Perch 拉起的那个）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type gwUpdateInfo struct {
	State   string `json:"state"` // checking | latest | downloading | ready | available | source | error | blocked
	Current string `json:"current"`
	Latest  string `json:"latest"`
	URL     string `json:"url"`
	Stuck   string `json:"stuck"`
	Error   string `json:"error"`
	Retry   bool   `json:"retry"`
	Done    int64  `json:"done"`
	Total   int64  `json:"total"`
}

var (
	gwUpdMu   sync.Mutex // TryLock：同一时间只允许一条更新链路
	gwUpdLast string     // 上一次推给前端的原始状态，进度没变就不重复推
)

func gwUpdateRead() (json.RawMessage, *gwUpdateInfo, error) {
	b, err := gwAPI("GET", "/api/update", nil)
	if err != nil {
		return nil, nil, err
	}
	var u gwUpdateInfo
	if err := json.Unmarshal(b, &u); err != nil {
		return nil, nil, errors.New("magpie 返回的更新状态不是 JSON")
	}
	return json.RawMessage(b), &u, nil
}

func gwUpdatePush(op string, raw json.RawMessage, busy, errMsg string, updated bool) {
	m := map[string]any{
		"type": "magpie.update", "op": op, "busy": busy, "at": nowISO(),
	}
	if len(raw) > 0 {
		m["update"] = raw
	}
	if errMsg != "" {
		m["err"] = errMsg
	}
	if updated {
		m["updated"] = true
	}
	pushJSON(m)
}

// gwMagpieUpdateGet 只读版本状态。控制面没接上就安静返回 —— 网关页自己会
// 接入，没接上时不该因为一次轮询去拉起进程，也不该在页面上留一条红字。
func gwMagpieUpdateGet() {
	_, _, client, _ := gwConnState()
	if client == nil {
		return
	}
	raw, _, err := gwUpdateRead()
	if err != nil {
		gwUpdatePush("get", nil, "", err.Error(), false)
		return
	}
	gwUpdatePush("get", raw, "", "", false)
}

// gwMagpieUpdateInstall 是「更新」按钮的全部：需要时先让它检查/下载，等到
// ready 再 install；装完等新进程应答，认领 PID，最后把新状态推回去。
func gwMagpieUpdateInstall() {
	if !gwUpdMu.TryLock() {
		return // 已经有一条在跑
	}
	defer gwUpdMu.Unlock()
	gwUpdLast = ""

	if err := gwEnsure(); err != nil {
		gwUpdatePush("install", nil, "", err.Error(), false)
		return
	}
	port, key, _, ours := gwConnState()
	raw, u, err := gwUpdateRead()
	if err != nil {
		gwUpdatePush("install", nil, "", err.Error(), false)
		return
	}
	if u.Latest == "" || u.Latest == u.Current {
		gwUpdatePush("install", raw, "", "", false)
		return
	}

	// 1) 还没准备好就先检查（magpie 会自己下载到 ready）。
	if u.State != "ready" {
		raw, u, err = gwUpdatePrepare(raw, u)
		if err != nil {
			gwUpdatePush("install", raw, "", err.Error(), false)
			return
		}
		if u.State != "ready" {
			gwUpdatePush("install", raw, "", "没有拿到可安装的更新（状态："+u.State+"）", false)
			return
		}
	}

	// 2) 记住旧进程（只有 Perch 拉起的才在退出时收；外部的保持运行）。
	var old *os.Process
	if ours {
		gwConn.mu.Lock()
		old = gwConn.proc
		gwConn.mu.Unlock()
	}

	gwUpdatePush("install", raw, "restarting", "", false)
	if _, err := gwAPI("POST", "/api/update/install", map[string]any{"when": "now"}); err != nil {
		gwUpdatePush("install", raw, "", "magpie 没有接受更新："+err.Error(), false)
		return
	}

	// 3) 等旧进程退出。web 版由 Web.Wait 原地 re-exec，退出是重启的一部分。
	if old != nil {
		done := make(chan struct{})
		go func() { _, _ = old.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			log.Printf("[magpie] 更新：旧控制面 30 秒内没有退出，继续等新版本应答")
		}
	} else {
		time.Sleep(1 * time.Second)
	}

	// 4) 等新版本真的应答：只看 ping 不够 —— 旧进程可能还活着，所以还要看
	//    current 变了（或 latest 变空，说明已经是最新）。
	back, now := false, *u
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if gwPing(port, key) {
			if r2, u2, err := gwUpdateRead(); err == nil {
				raw, now, back = r2, *u2, true
				if now.Current != u.Current || now.Latest == "" || now.Latest == now.Current {
					break
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
		back = false
	}
	if !back {
		gwUpdatePush("install", raw, "", "更新后控制面没有恢复应答；重启 Perch 或重开网关页再试", false)
		return
	}

	// 5) re-exec 换了 PID：原来是我们拉起的那份，现在按端口认领新的。
	if ours {
		if p := gwPortOwner(port); p != nil {
			gwConn.mu.Lock()
			gwConn.proc, gwConn.ours = p, true
			gwConn.mu.Unlock()
		} else {
			log.Printf("[magpie] 更新：没能按端口 %d 认领新控制面；退出 Perch 时它可能留下", port)
		}
	}
	gwConn.mu.Lock()
	gwConn.client = gwClient() // 丢掉指向旧进程的连接池
	gwConn.mu.Unlock()

	log.Printf("[magpie] 已更新到 %s（控制面端口 %d，%s）", now.Current, port, map[bool]string{true: "Perch 拉起", false: "外部进程"}[ours])
	gwUpdatePush("install", raw, "", "", true)
	gwRefresh()
}

// gwUpdatePrepare 把状态推到 ready：必要时 POST /api/update/check，然后每
// 2 秒读一次，直到 ready / 终态。进度只在原始 JSON 变了时推。
func gwUpdatePrepare(raw json.RawMessage, u *gwUpdateInfo) (json.RawMessage, *gwUpdateInfo, error) {
	if u.State != "downloading" && u.State != "checking" {
		b, err := gwAPI("POST", "/api/update/check", map[string]any{})
		if err != nil {
			return raw, u, errors.New("magpie 检查更新失败：" + err.Error())
		}
		raw = json.RawMessage(b)
		var u2 gwUpdateInfo
		if err := json.Unmarshal(b, &u2); err == nil {
			u = &u2
		}
		gwUpdLast = ""
	}
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		if u.State == "ready" {
			return raw, u, nil
		}
		switch u.State {
		case "error":
			return raw, u, errors.New(firstNonEmpty(u.Error, "下载更新失败"))
		case "blocked":
			return raw, u, errors.New(firstNonEmpty(u.Stuck, u.Error, "这个版本在这台电脑上无法启动"))
		case "available":
			return raw, u, errors.New(firstNonEmpty(u.Stuck, "magpie 需要从发布页手动更新"))
		case "latest":
			return raw, u, nil
		}
		sig := string(raw)
		if sig != gwUpdLast {
			gwUpdLast = sig
			busy := "downloading"
			if u.State == "checking" {
				busy = "checking"
			}
			gwUpdatePush("install", raw, busy, "", false)
		}
		time.Sleep(2 * time.Second)
		r2, u2, err := gwUpdateRead()
		if err != nil {
			continue // 下载中偶发读失败不值得中止整条链路
		}
		raw, u = r2, u2
	}
	return raw, u, errors.New("等了 15 分钟更新仍未就绪")
}

// gwPortOwner 找监听某个端口的进程。只在更新后认领新 sidecar 时用：
// re-exec 之后原来那份 *os.Process 指向的已经是退出进程。
func gwPortOwner(port int) *os.Process {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	ps := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command",
		fmt.Sprintf(`(Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue | `+
			`Select-Object -First 1 -ExpandProperty OwningProcess)`, port))
	ps.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := ps.Output()
	if err != nil {
		return nil
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 0 {
		return nil
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return nil
	}
	return p
}
