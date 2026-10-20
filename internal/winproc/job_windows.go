package winproc

/* C3：进程级 Job Object —— 应用一退，它拉起来的整棵树跟着走。

   问题（实测的，不是设想的）：perch.exe 被杀掉之后，**它那些格子的 claude 会被
   ConPTY 的收尾顺带带走**（伪控制台关闭 → 附着在上面的进程结束），但**后代留下来了**
   —— 后台命令、dev server、`Start-Process` 拉起来的东西，一个都不少地活着。

   做法：**给宿主进程自己**建一个 kill-on-close 的 job，然后把自己挂进去。
   两条关键点：
   ① **挂宿主，不挂子进程**。子进程自动继承 job 归属，挂一次宿主就覆盖此后所有格子，
      而且没有竞态。
   ② **必须带 BREAKAWAY_OK**。不设这个标志时，一个显式请求脱离 job 的子进程会直接
      创建失败（CreateProcess 返回 ERROR_ACCESS_DENIED）。

   ⚠️ 这两个标志**相邻一个 bit**，方向相反：
        JOB_OBJECT_LIMIT_BREAKAWAY_OK        = 0x00000800
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000
      所以本文件**一个手写常量都没有**：全部引用 golang.org/x/sys/windows 里的定义。

   边界：
     · 显式脱离的进程活得下来。Git Bash/MSYS 的子进程属于这一类。
     · 「在 Windows Terminal 里打开」是**交出去**，所以显式带
       CREATE_BREAKAWAY_FROM_JOB。
     · 每格收尾仍由 ConPTY 负责；本 job 只负责宿主退出时带走整棵树。
*/

import (
	"log"
	"sort"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	jobOnce   sync.Once
	jobHandle windows.Handle
	jobOwned  bool
)

// OwnProcessTree 把**本进程**挂进 kill-on-close job，返回是否真的挂上了。
// 挂不上也照常跑（功能降级为"没有这层保证"），只把事实打进日志。
func OwnProcessTree() bool {
	jobOnce.Do(func() {
		// 结构体尺寸自检：64 (BASIC_LIMIT) + 48 (IO_COUNTERS) + 4×8 = 144。
		if n := unsafe.Sizeof(windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}); n != 144 {
			log.Printf("[perch] C3 job：结构体尺寸自检不过（%d ≠ 144）—— **不建 job**", n)
			return
		}
		h, err := windows.CreateJobObject(nil, nil) // 匿名 job：名字传 nil
		if err != nil {
			log.Printf("[perch] C3 job：CreateJobObject 失败: %v", err)
			return
		}
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
			windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK
		if _, err := windows.SetInformationJobObject(h,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info))); err != nil {
			// 没有标志的 job 是**光有名头的 job**：它不会在 Perch 退出时动手。
			_ = windows.CloseHandle(h)
			log.Printf("[perch] C3 job：设 KILL_ON_JOB_CLOSE|BREAKAWAY_OK 失败: %v —— 已放弃，"+
				"agent 不会随 Perch 退出而死", err)
			return
		}
		if err := windows.AssignProcessToJobObject(h, windows.CurrentProcess()); err != nil {
			_ = windows.CloseHandle(h)
			// 最常见的一种：宿主自己已经在一个**不许嵌套**的外层 job 里。
			log.Printf("[perch] C3 job：把自己挂进 job 失败: %v%s —— 已放弃，"+
				"agent 不会随 Perch 退出而死", err, assignHint(err))
			return
		}
		// ⚠️ 刻意**不** CloseHandle：句柄必须活到进程退出（内核替我们关），
		// 那一刻 job 销毁 → 里面的进程全被终止。
		jobHandle, jobOwned = h, true
		log.Printf("[perch] C3 job：本进程已挂进 kill-on-close job handle=%v "+
			"标志=KILL_ON_JOB_CLOSE|BREAKAWAY_OK（句柄刻意留到进程退出）", h)
		// 复核：问内核要一份成员清单，里面**必须**有本进程。
		LogJobInventory("本进程挂载复核")
	})
	return jobOwned
}

// JobMembers 问内核要一份"这个 job 现在攥着哪些 pid"。
// 返回 nil = **问不到**（没建 job / 调用失败），这和"一个成员都没有"是两件事。
func JobMembers() []int {
	h := jobHandle
	if h == 0 {
		return nil
	}
	// 一整个缓冲区装 JOBOBJECT_BASIC_PROCESS_ID_LIST（x/sys 没有这个结构体，自己排）：
	//   2 个 DWORD 表头（总数 / 本次填了几个）+ 紧跟其后的 pid 数组（ULONG_PTR，x64 8 字节）。
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
		// 小端：低 32 位是 NumberOfAssignedProcesses，高 32 位是 NumberOfProcessIdsInList。
		n := int(buf[0] >> 32)
		if n > capacity {
			n = capacity
		}
		pids := make([]int, 0, n)
		for i := 0; i < n; i++ {
			pids = append(pids, int(buf[1+i]))
		}
		return pids
	}
	return nil
}

// LogJobInventory 把 job 成员清单打进日志。这是 C3 的**观察腿**。
// 触发点是事件而不是轮询：轮询会把 WebView2 那二十来个渲染进程的进出也一起吼出来。
func LogJobInventory(why string) {
	if jobHandle == 0 {
		return
	}
	pids := JobMembers()
	if pids == nil {
		log.Printf("[perch] C3 job 成员清单：问不到（%s）", why)
		return
	}
	sort.Ints(pids)
	log.Printf("[perch] C3 job 成员 %d 个（%s）: %v", len(pids), why, pids)
}

// ProcessTreeOwned：本进程是否真的被这个 job 攥着。
// 第一次调用会把 job 建起来，所以任何依赖它的地方都必须是"这一层已经在跑"的时候。
func ProcessTreeOwned() bool {
	OwnProcessTree()
	return jobOwned
}

// HandoffSysProcAttr 给「交出去」的子进程用的创建标志：让它显式脱离本进程的 job。
// 只有我们自己确实被 job 攥着时才带它。
func HandoffSysProcAttr() *syscall.SysProcAttr {
	if !ProcessTreeOwned() {
		return nil
	}
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_BREAKAWAY_FROM_JOB}
}

// assignHint 把挂载失败的 errno 翻成人话。**只解释最常见的那一种**。
func assignHint(err error) string {
	if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_ACCESS_DENIED {
		return "（ERROR_ACCESS_DENIED：宿主自己已经在另一个不许嵌套的 job 里，" +
			"常见于某些 EDR / 容器宿主）"
	}
	return ""
}
