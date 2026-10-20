package winproc

/* ---------------------------------------------------------------------------
   单实例闸（冷恢复 · 步 7）—— "这台机器上只有一个我"
   ---------------------------------------------------------------------------
   为什么非要有它：冷恢复是"每一格各按记录里的 id 起一条 `--resume <id>`"，
   而护栏（session 的 resumeRefusal）在两个实例同时启动的那一两秒里是**空的** ——
   `sessionLiveElsewhere` 靠的是 claude 自己写的 `sessions\<pid>.json`，而那时
   两边都还没写出来；`tabs.bySession` 更是各看各的。于是两个实例会各自接到同一条
   会话上：**两个写者写一份 jsonl** —— 这是整个设计里唯一不可逆的失败。

   第二条同样硬的理由：`panes.json` 是**整份重写**的。第二个实例哪怕一格都不恢复，
   它建完自己那一格也会把整份文件按"我知道的那几条"写回去 —— 第一个实例的 8 个
   座位会**静默地变成 1 个**。所以拿不到锁的那个实例不只是"跳过恢复"，它的登记表
   **按只读**对待。

   ⚠️ 为什么不用 Wails 的 `application.SingleInstance`（beta.24 有这个选项）：
     ① 它的 Windows 实现是**用 `CreateMutex` 返回的 error 判断"是不是已经有人"**
        （single_instance_windows.go 的 acquire）—— 而 Win32 那边"已经存在"是
        **调用成功 + GetLastError()=ERROR_ALREADY_EXISTS**，不是失败。拿 error 判
        会得到"没人"，也就是说那道闸在 Windows 上可能根本没关上。
     ② 语义也不同：它让第二个实例**直接退出**并把窗口抢到前台；我们要的是
        "第二个实例活着（用户看得见、能自己关掉它），但一个共享字节都不碰"。

   为什么用**具名互斥体**而不是锁文件：互斥体是内核对象，进程一死就没人持有了
   （哪怕被 taskkill /F 硬杀），所以不存在"陈旧锁 + 判断持有者还活着没有"那一类
   问题。`Local\` 前缀 = 按登录会话隔离。
   --------------------------------------------------------------------------- */

import (
	"fmt"
	"syscall"
	"unsafe"
)

// InstanceMutexName 是这道闸的名字。改它等于换一把锁：老进程持着旧名字的锁时，
// 新版本会认为"没人跑"而放行两个实例 —— 所以它只在**语义真的变了**的时候才动。
const InstanceMutexName = `Local\Perch.AgentTermGateway`

// errorAlreadyExists = ERROR_ALREADY_EXISTS。
const errorAlreadyExists = 183

// instanceHandle 持有**第一个**实例的那把锁。进程退出时内核自动释放。
var instanceHandle syscall.Handle

var procCreateMutex = kernel32.NewProc("CreateMutexW")

/*
	AcquireInstanceLock 问一句"这台机器（这个登录会话）上是不是已经有一个我在跑"。

		第一个实例  → (true, nil)  —— 锁在手上，直到进程结束
		第二个实例  → (false, nil) —— 没拿到锁，而且**不会**去等、不会去抢
		出错了      → (false, err) —— 判不出来时调用方也按"别碰共享状态"处理

⚠️ 第二个实例**也要把这个句柄关掉**：它没持有锁，但留着句柄等于给那个内核对象
多挂一个引用。
*/
func AcquireInstanceLock(name string) (bool, error) {
	n, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return false, err
	}
	// 参数：lpMutexAttributes=nil、bInitialOwner=false（我们不要求拥有权，
	// 只要"这个名字有没有人占着"这一个事实）、lpName=名字。
	h, _, e := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(n)))
	if h == 0 {
		return false, fmt.Errorf("CreateMutex(%s) 失败: %v", name, e)
	}
	if errno, ok := e.(syscall.Errno); ok && errno == errorAlreadyExists {
		_ = syscall.CloseHandle(syscall.Handle(h))
		return false, nil
	}
	instanceHandle = syscall.Handle(h)
	return true, nil
}
