package main

/* C3：进程级 Job Object —— 应用一退，它拉起来的整棵树跟着走。

   问题（实测的，不是设想的；数据见下面"实测记录"）：perch.exe 被杀掉之后，
   **它那些格子的 claude 会被 ConPTY 的收尾顺带带走**（伪控制台关闭 → 附着在上面的
   进程结束），但**后代留下来了** —— 后台命令、dev server、`Start-Process` 拉起来的
   东西，一个都不少地活着。留着的后果不只是"多了几个进程"：

     · 每个残留进程还攥着它的工作目录和端口；
     · 如果它是个 agent 的子进程，它可能还在往会话文件里写
       —— 而"两个写者写同一份会话"正是会毁掉会话的那件事；
     · C2 的复接护栏（resume.go 的 sessionLiveElsewhere）看的是"那个 pid 还活着"，
       残留进程会让某条会话**永远接不上**，而界面上那一格早就没了。

   所以 C3 让"这个应用攥着的东西"有确定的边界：**应用走，它拉起来的整棵树跟着走**。

   ---------------------------------------------------------------------------
   做法：**给宿主进程自己**建一个 kill-on-close 的 job，然后把自己挂进去。

   这不是我自己想出来的形状 —— 是照 Orca 抄的（`config/patches/node-pty@1.1.0.patch`，
   `PtyAssignCurrentProcessToJob`，node-pty 打完补丁导出的三个 job 接口之一）。
   它的原话（patch :1165-1178）：

     Orca: put THIS process in a kill-on-close job, so its whole descendant tree
     dies with it.
     Why here and not per-pty: a per-pty job cannot carry KILL_ON_JOB_CLOSE,
     because its handle is released when the shell exits and that would reap
     whatever the user had backgrounded. This job's handle is released only when
     the process itself dies, so it reaps a crashed host without changing what a
     clean shell exit means. Children inherit job membership, so every pty the
     caller later spawns is covered without further work, and the per-pty jobs
     simply nest inside this one.
     The handle is deliberately never closed: it must outlive every caller, and
     process teardown is what releases it.

   两条关键点，都是我先想错、看了它才改的：

   ① **挂宿主，不挂子进程**。"子进程自动继承 job 归属"是系统的规矩，所以挂一次宿主
      就等于覆盖了此后所有格子、以及格子里的孙进程 —— 而且**没有竞态**。
      我原来的草案是"每起一个 claude 就 OpenProcess + AssignProcessToJobObject"，
      那要面对"进程起来到我们去 assign"之间的窗口：claude 若在那几毫秒里已经生了子进程，
      那些孙进程就漏在 job 外面。Orca 为了消掉同一个窗口，在 node-pty 里给
      CreateProcessW 加了 CREATE_SUSPENDED（patch :882-885），然后 assign 完再
      ResumeThread。挂宿主连这个都不需要 —— conpty 那边一行不改。

   ② **必须带 BREAKAWAY_OK**，不是我原来想的"只留 KILL_ON_JOB_CLOSE"。Orca 的原话
      （patch :1200-1201）：

        BREAKAWAY_OK for the same reason as the per-pty job: without it a child
        asking for CREATE_BREAKAWAY_FROM_JOB is refused outright.

      不设这个标志时，**一个显式请求脱离 job 的子进程会直接创建失败**
      （CreateProcess 返回 ERROR_ACCESS_DENIED）。那是一种会弄坏 agent 的坏法：
      工具链里跑一个安装器/更新器就起不来了，而且现场看起来像"某个命令莫名其妙没执行"。
      宁可留一条**明说过的**缝：显式脱离的进程活得下来（那也是今天的现状），
      也不要让正常的进程起不来。

      这一条不是照抄 —— `go run ./tools/jobtest`（同模块里的实测台）在本机量过：
        · `-nobreak`（只设 KILL_ON_JOB_CLOSE）→ 显式脱离的子进程
          `起不来: fork/exec C:\Windows\system32\cmd.exe: Access is denied.`
        · 照本文件（`|BREAKAWAY_OK`，实测 flags=0x2800）→ 它起得来、能在成员清单里
          **看不到**它（真的跑出去了），父进程退出后它是唯一活下来的那个。
      后一种也是 main.go 里「在 Windows Terminal 里打开」靠的东西。

   ⚠️ 这两个标志**相邻一个 bit**，方向相反，而且都在这个头里：

        JOB_OBJECT_LIMIT_BREAKAWAY_OK        = 0x00000800  // 允许子进程**显式**请求脱离
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000  // 子进程**一律静默**留在 job 外

      我第一版就是凭记忆把 BREAKAWAY_OK 写成 0x1000（见"实测记录"第 3 条），
      于是这个 job 变成了"谁都别进来"。所以本文件**一个手写常量都没有**：
      全部引用 golang.org/x/sys/windows 里和 SDK 头对得上的定义。

   ---------------------------------------------------------------------------
   实测记录（2026-10-16，Windows 11）：

   1. **A 面（不打补丁的现状）**：起 Perch → 格子里 `!Start-Process powershell
      -ArgumentList '-NoProfile','-c','Start-Sleep 400'`（脱离控制台的孙进程）
      → `taskkill /F /PID <Perch>`（**不带 /T**，带 /T 会替 job 把活干了，那是作弊）
      → 4 秒后：那格的 claude 没了（conhost 收尾带走），**那个 powershell 还活着**。

   2. **B 面（本改动）**：同样两步之后，那个 powershell **被带走了**。
      判据不是"我看到它没了"，而是"它在前一步是活着的、这一步没了" —— A/B 对照。
      完整那次（Perch=29316，格子 claude=30244/7324，孙进程=21632）：
        · 起 tab=2 时内核给的成员清单 13 个，里面有 **21632**（那个脱离控制台的孙进程）
          —— 这是"继承生效"的**正面**证据，不是靠"它后来死了"反推的；
        · 杀 Perch 后 5 秒：Perch / claude 30244 / claude 7324 / **21632** 全没了，
          只剩我自己那个 Claude Code 会话的 8216 —— 本轮**没有**任何需要手工按 pid 清理的东西。

   3. **关一格（`关格` 坐标见 renderGrid 那条日志）**：两格时点左边那格的 × →
      它的 claude 30244 死、**右边那格的 claude 7324 活着**、孙进程 21632 也活着
      （`收尾` 那条成员清单里仍有它）。也就是说"每格收尾归 ConPTY、job 只管宿主退出"
      这条分工是**量出来的**，不是设计文档里的一句话。
      ⚠️ 同一格里 `.cellhead .x` 的坐标随 N 变，N=1 是 1066,47、N=2 是 712,47/1066,47
      —— 拿一次量的数去点下一次的格子就是目测（这条已经写进 renderGrid 的日志）。

   4. **差点漏掉的那次**：第一版标志写错（= SILENT_BREAKAWAY_OK）时，B 面看起来
      "也还行"（claude 照样死，因为那是 conhost 干的），但那个孙进程**照样活着**。
      戳穿它的是本文件自带的观察腿：`C3 job 成员 1 个: [<Perch pid>]` ——
      成员清单里没有刚起来的 claude。**"挂上了"和"系统说挂上了"是两件事**，
      所以复核这一步（问内核要成员清单）不是装饰，是它把 bug 抓出来的。

   5. **断言单独量过一遍**：`go run ./tools/jobtest`（同模块子目录，照 tools/hookprobe 的先例）
      是个只干"建 job、挂自己、扔两种子进程"的实验台，用来量文件头 ② 和边界里
      那两条引自 Orca 的话（带 / 不带 BREAKAWAY_OK 的对照）。改这里之前先跑它。

   边界（写清楚，免得以后被当成漏做）：
     · 显式脱离的进程活得下来（见 ②）。Git Bash/MSYS 的子进程属于这一类：
       Orca 记下来的行为是 "Cygwin and MSYS request breakaway for every child
       whenever the job allows it"（patch :811-813）。
       ⚠️ 这一条是**照 Orca 记的，我们没有量过**：本机没装 Git for Windows
       （实测 `C:\Program Files\Git\bin\bash.exe` 不存在，而 claude 的 `!` 走的也是
       PowerShell —— `sleep 400 &` 那次报的就是 PowerShell 不认 `&`），所以这类进程
       眼下压根不会出现。等哪台机器上装了 Git Bash，要用 `go run ./tools/jobtest` 那一路
       法子重新量一遍，别把这条注释当结论。
     · 「在 Windows Terminal 里打开」（main.go 的 openInWindowsTerminal）是**交出去**，
       所以那边显式带 CREATE_BREAKAWAY_FROM_JOB —— 正是上面那个标志让它成为可能。
     · 每格收尾仍然由 ConPTY 负责（handleTab 的 `defer sess.Close()`）。Orca 另外给
       每格配了一个 job，做的是**另一件事**：一次系统调用精确杀掉一格整棵树
       （TerminateJobObject）+ 从内核拿那一格的进程清单。它刻意**不带** KILL_ON_JOB_CLOSE
       —— 原话（patch :900-904）："with that flag, closing the handle when the shell exits
       also kills whatever the user left running, so typing `exit` in a pane reaped a
       `start /b` server that used to survive. This job exists to make an EXPLICIT teardown
       exact, not to redefine what a clean exit means." 我们没做那一层：它要求 job 在
       CreateProcess **之前**就存在，也就是要求 conpty 支持 CREATE_SUSPENDED 并把进程句柄
       交出来 —— Orca 为此维护着一个 59KB 的 node-pty 补丁。C3 要的是"应用没了，别留孤儿"，
       这一层一个文件就够了。
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

// ownProcessTree 把**本进程**挂进 kill-on-close job，返回是否真的挂上了。
// 挂不上也照常跑（功能降级为"没有这层保证"），只把事实打进日志。
func ownProcessTree() bool {
	jobOnce.Do(func() {
		// 结构体尺寸自检：64 (BASIC_LIMIT) + 48 (IO_COUNTERS) + 4×8 = 144。
		// x/sys 的布局是对的（它有测试），留这一条只是为了把"结构体没对上"
		// 和"设标志失败"这两种失败在日志里分开 —— 它们看起来一样。
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
			// 没有标志的 job 是**光有名头的 job**：它不会在 Perch 退出时动手，
			// 留着它只会让人以为"已经有保护了"。所以关掉它，如实说没有。
			_ = windows.CloseHandle(h)
			log.Printf("[perch] C3 job：设 KILL_ON_JOB_CLOSE|BREAKAWAY_OK 失败: %v —— 已放弃，"+
				"agent 不会随 Perch 退出而死", err)
			return
		}
		if err := windows.AssignProcessToJobObject(h, windows.CurrentProcess()); err != nil {
			_ = windows.CloseHandle(h)
			// 最常见的一种：宿主自己已经在一个**不许嵌套**的外层 job 里
			// （Orca 记的情形：某些 EDR / 容器宿主）。Orca 对此也是"容忍失败、
			// 让调用方降级"（patch :923-928），不是硬失败。
			log.Printf("[perch] C3 job：把自己挂进 job 失败: %v%s —— 已放弃，"+
				"agent 不会随 Perch 退出而死", err, assignHint(err))
			return
		}
		// ⚠️ 刻意**不** CloseHandle：句柄必须活到进程退出（内核替我们关），
		// 那一刻 job 销毁 → 里面的进程全被终止。这就是"不需要 onExit 钩子"的全部秘密：
		// 能崩溃的清理代码不是清理代码。
		jobHandle, jobOwned = h, true
		log.Printf("[perch] C3 job：本进程已挂进 kill-on-close job handle=%v "+
			"标志=KILL_ON_JOB_CLOSE|BREAKAWAY_OK（句柄刻意留到进程退出）", h)
		// 复核：问内核要一份成员清单，里面**必须**有本进程。
		// 判据是它，不是"这两个调用都没报错" —— 第一版就是"没报错但没生效"，
		// 而那种状态和"生效了"在日志里长得一模一样（见文件头实测记录第 3 条）。
		logJobInventory("本进程挂载复核")
	})
	return jobOwned
}

// jobMembers 问内核要一份"这个 job 现在攥着哪些 pid"（Orca 的 listJobProcessIds 同一件事，
// patch :1127-1163：小缓冲区先试、ERROR_MORE_DATA 就放大重试）。
//
// 返回 nil = **问不到**（没建 job / 调用失败），这和"一个成员都没有"是两件事 ——
// 把两者混起来，最坏情况是把"问不到"读成"已经清干净了"。
func jobMembers() []int {
	h := jobHandle
	if h == 0 {
		return nil
	}
	// 一整个缓冲区装 JOBOBJECT_BASIC_PROCESS_ID_LIST（x/sys 没有这个结构体，自己排）：
	//   2 个 DWORD 表头（总数 / 本次填了几个）+ 紧跟其后的 pid 数组（ULONG_PTR，x64 8 字节）。
	// 用 []uint64 而不是 []byte：pid 槽要 8 字节对齐，而 uint64 切片的底层数组天然对齐，
	// 也让"表头 8 字节 + 每槽 8 字节"这层布局在代码里看得见。
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

// logJobInventory 把 job 成员清单打进日志。这是 C3 的**观察腿**：
// "子进程靠继承进来了没有""Git Bash/MSYS 的子进程有没有因为 BREAKAWAY_OK 跑出去"
// 只有问内核才知道（文件头第 3 条实测就是这条腿抓出来的）。
//
// 触发点是事件而不是轮询：轮询会把 WebView2 那二十来个渲染进程的进出也一起吼出来。
// 所以放在"格子起 / 格子收"这两个时刻，一次一行，还能顺带看见相邻格子留了什么。
func logJobInventory(why string) {
	if jobHandle == 0 {
		return
	}
	pids := jobMembers()
	if pids == nil {
		log.Printf("[perch] C3 job 成员清单：问不到（%s）", why)
		return
	}
	sort.Ints(pids)
	log.Printf("[perch] C3 job 成员 %d 个（%s）: %v", len(pids), why, pids)
}

// processTreeOwned：本进程是否真的被这个 job 攥着。给"要不要显式请求脱离"那种判断用
// （见 openInWindowsTerminal）。第一次调用会把 job 建起来，所以任何依赖它的地方
// 都必须是"这一层已经在跑"的时候 —— main 里在建窗口之前就调了。
func processTreeOwned() bool {
	ownProcessTree()
	return jobOwned
}

// handoffSysProcAttr 给「交出去」的子进程用的创建标志：让它显式脱离本进程的 job。
//
// 只有我们自己确实被 job 攥着时才带它（不在 job 里时这标志没有意义），
// 而它只在 job 允许 BREAKAWAY_OK 时才不会让 CreateProcess 直接失败 —— 两件事
// 都在本文件顶上定死了。见 main.go 的 openInWindowsTerminal。
func handoffSysProcAttr() *syscall.SysProcAttr {
	if !processTreeOwned() {
		return nil
	}
	return &syscall.SysProcAttr{CreationFlags: windows.CREATE_BREAKAWAY_FROM_JOB}
}

// assignHint 把挂载失败的 errno 翻成人话。**只解释最常见的那一种**，
// 其余原样留着 errno —— 让我编的解释盖掉真实错误是最坏的做法。
func assignHint(err error) string {
	if errno, ok := err.(syscall.Errno); ok && errno == syscall.ERROR_ACCESS_DENIED {
		return "（ERROR_ACCESS_DENIED：宿主自己已经在另一个不许嵌套的 job 里，" +
			"常见于某些 EDR / 容器宿主）"
	}
	return ""
}
