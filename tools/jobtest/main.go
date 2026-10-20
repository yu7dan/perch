// jobtest —— 把 job_windows.go 里那两条"引自 Orca 的断言"在我们这台机器上量一遍。
//
// 为什么要单开一个程序（照本仓库 tools/hookprobe 的先例，同模块的子目录）：这两条断言
// 只能在一个**自己已经在 job 里**的进程上验，而主程序不是能随手改参数的实验台。
// 这个程序干的事和 C3 开头那段一模一样（建 job、挂自己），然后往上面扔两种子进程。
//
//	go run ./tools/jobtest           # 照 C3：KILL_ON_JOB_CLOSE | BREAKAWAY_OK
//	go run ./tools/jobtest -nobreak  # C3 的第一版：只设 KILL_ON_JOB_CLOSE
//
// 判据（父进程退出后由外面数）：
//
//	① plain 子进程必须死 —— job 的 kill-on-close 生效；
//	② breakaway 子进程（显式 CREATE_BREAKAWAY_FROM_JOB）在带 BREAKAWAY_OK 时
//	   **起得来**、父进程死后**还活着** —— 这就是「在 Windows Terminal 里打开」
//	   那条路靠的东西（cmd/perch/main.go 的 openInWindowsTerminal），也是那个标志存在的理由；
//	③ 换成 -nobreak：同一个 breakaway 子进程**根本起不来**（CreateProcess 直接
//	   ERROR_ACCESS_DENIED）。这一条是"不能只留 KILL_ON_JOB_CLOSE"的实证 ——
//	   没有它，工具链里任何一个显式请求脱离的进程都会静默失败。
package main

import (
	"flag"
	"fmt"
	"os/exec"
	"sort"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const jobObjectBasicProcessIdList = 3

func main() {
	nobreak := flag.Bool("nobreak", false, "只设 KILL_ON_JOB_CLOSE（不给 BREAKAWAY_OK）")
	flag.Parse()

	flags := uint32(windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
	if !*nobreak {
		flags |= windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK
	}
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		fmt.Println("CreateJobObject:", err)
		return
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = flags
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		fmt.Println("SetInformationJobObject:", err)
		return
	}
	if err := windows.AssignProcessToJobObject(h, windows.CurrentProcess()); err != nil {
		fmt.Println("AssignProcessToJobObject:", err)
		return
	}
	fmt.Printf("job flags=0x%x 成员=%v\n", flags, members(h))

	// 两种子进程，命令一样、只差一个创建标志。ping 只为了"活够久"。
	plain := spawn(false)
	brk := spawn(true)
	time.Sleep(1500 * time.Millisecond)
	fmt.Printf("plain pid=%v breakaway pid=%v\n", plain, brk)
	fmt.Printf("成员=%v\n", members(h))
	fmt.Println("父进程现在退出 —— job 销毁，成员应当被全部终止（跑出去的那个除外）")
	time.Sleep(300 * time.Millisecond)
}

// spawn 起一个 `cmd /c ping -n 60 127.0.0.1`，可选显式请求脱离本进程的 job。
// 返回 pid 或者错误文字（用 any 只是为了两边都能直接打进日志）：
// 在 -nobreak 那一轮里，那个**错误本身就是结论**。
func spawn(breakaway bool) any {
	cmd := exec.Command("cmd.exe", "/c", "ping -n 60 127.0.0.1")
	attr := &syscall.SysProcAttr{HideWindow: true}
	if breakaway {
		attr.CreationFlags = windows.CREATE_BREAKAWAY_FROM_JOB
	}
	cmd.SysProcAttr = attr
	if err := cmd.Start(); err != nil {
		return "起不来: " + err.Error()
	}
	return cmd.Process.Pid
}

// members 问内核要 job 成员清单（和 job_windows.go 里同一套，独立抄一份是为了
// 这个程序不依赖被测代码 —— 用它自己的观察腿去量被测对象）。
func members(h windows.Handle) []int {
	capacity := 64
	for attempt := 0; attempt < 8; attempt++ {
		buf := make([]uint64, 1+capacity)
		var retlen uint32
		err := windows.QueryInformationJobObject(h, windows.JobObjectBasicProcessIdList,
			uintptr(unsafe.Pointer(&buf[0])), uint32(len(buf)*8), &retlen)
		if err != nil {
			if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_MORE_DATA {
				capacity *= 4
				continue
			}
			return nil
		}
		n := int(buf[0] >> 32)
		if n > capacity {
			n = capacity
		}
		pids := make([]int, 0, n)
		for i := 0; i < n; i++ {
			pids = append(pids, int(buf[1+i]))
		}
		sort.Ints(pids)
		return pids
	}
	return nil
}
