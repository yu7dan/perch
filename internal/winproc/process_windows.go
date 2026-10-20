package winproc

/* 一格还活着吗 —— 全项目唯一一次"问系统"。

   C2 的复接护栏必须把两种情况分开：

     · 这条会话正被另一个格子跑着 → 接上去就是**两个 claude 往同一份 jsonl 里写**，
       会把会话写坏（这是复接唯一的真实风险）；
     · 那一格的 claude 早就退出了，只是格子还留在界面上 → 这条会话**可以**接。

   只判"这个 session 绑过格子没有"会把后者一起拦死，而用户没有任何绕开的办法
   （那一格看起来就是"停着的"）。Orca 的判据是**租约已释放**才算可接
   （structured-agent-session-resume-eligibility.ts:16-18：
   `isResumable…= agentSessionLeaseIsReleased(record.lease)`），我们这边能对应上
   的事实就是"那个 pid 还在不在"。

   实现上用 SYNCHRONIZE 权限开个句柄 + WaitForSingleObject(h, 0)：进程还在 =
   WAIT_TIMEOUT。这是**不等的等**（超时 0，立刻返回），所以它比 os.FindProcess
   那类"永远成功"的假判据真，也不占一个协程。pid 被回收的窗口极小，而且最坏后果
   只是"多拦一次、日志里把原因说清"。
*/

import "syscall"

const (
	processSynchronize = 0x00100000
	waitTimeout        = 258 // WAIT_TIMEOUT：句柄还没被 signaled = 进程还活着
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess         = kernel32.NewProc("OpenProcess")
	procWaitForSingleObject = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
)

// Alive 问系统这个 pid 还在不在。打不开句柄一律当"没在跑"。
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, _, _ := procOpenProcess.Call(processSynchronize, 0, uintptr(pid))
	if h == 0 {
		// 打不开：pid 已经没了（ERROR_INVALID_PARAMETER），或者权限不够。
		// 两种都当"没在跑"—— 权限不够时那一格也不是我们能判的，而 std 里没有
		// 更弱的问法（PROCESS_QUERY_LIMITED_INFORMATION 也一样要权限）。
		return false
	}
	defer procCloseHandle.Call(h)
	r, _, _ := procWaitForSingleObject.Call(h, 0)
	return r == waitTimeout
}
