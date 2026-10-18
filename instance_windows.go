package main

/* ---------------------------------------------------------------------------
   单实例闸（冷恢复 · 步 7）—— "这台机器上只有一个我"
   ---------------------------------------------------------------------------
   为什么非要有它：冷恢复是"每一格各按记录里的 id 起一条 `--resume <id>`"，
   而护栏（resume.go 的 resumeRefusal）在两个实例同时启动的那一两秒里是**空的** ——
   `sessionLiveElsewhere` 靠的是 claude 自己写的 `sessions\<pid>.json`，而那时
   两边都还没写出来；`tabs.bySession` 更是各看各的。于是两个实例会各自接到同一条
   会话上：**两个写者写一份 jsonl** —— 这是整个设计里唯一不可逆的失败。

   第二条同样硬的理由：`panes.json` 是**整份重写**的（见 panes.go 的 writeLocked）。
   第二个实例哪怕一格都不恢复，它建完自己那一格也会把整份文件按"我知道的那几条"
   写回去 —— 第一个实例的 8 个座位会**静默地变成 1 个**（下一次冷恢复少 7 格，
   而且不报错）。所以拿不到锁的那个实例不只是"跳过恢复"，它的登记表**按只读**
   对待（见 main.go 里 panes.setReadOnly 那一句）。

   ⚠️ 为什么不用 Wails 的 `application.SingleInstance`（beta.24 有这个选项）：
     ① 它的 Windows 实现是**用 `CreateMutex` 返回的 error 判断"是不是已经有人"**
        （single_instance_windows.go 的 acquire）—— 而 Win32 那边"已经存在"是
        **调用成功 + GetLastError()=ERROR_ALREADY_EXISTS**，不是失败。拿 error 判
        会得到"没人"，也就是说那道闸在 Windows 上可能根本没关上。
        （这是读源码得出的判断，我们**没有**去实测它 —— 实测的代价是再造一个
        "两个实例同时接一条会话"的场景，而那正是这一步要防的事。）
     ② 语义也不同：它让第二个实例**直接退出**并把窗口抢到前台；我们要的是
        "第二个实例活着（用户看得见、能自己关掉它），但一个共享字节都不碰"。
     与其借一个判据不明、行为又不合的东西，不如自己写这二十来行 —— 判据是
     Win32 文档里写死的那一条，且**内核负责释放**（见下）。

   为什么用**具名互斥体**而不是锁文件：互斥体是内核对象，进程一死就没人持有了
   （哪怕被 taskkill /F 硬杀），所以不存在"陈旧锁 + 判断持有者还活着没有"那一类
   问题 —— 而那个判断正是这个项目里反复踩过的一类坑（登记表残留、pid 复用）。
   `Local\` 前缀 = 按登录会话隔离：同一台机器上另一个用户跑他自己的那份，互不干扰。
   --------------------------------------------------------------------------- */

import (
	"fmt"
	"syscall"
	"unsafe"
)

// instanceMutexName 是这道闸的名字。改它等于换一把锁：老进程持着旧名字的锁时，
// 新版本会认为"没人跑"而放行两个实例 —— 所以它只在**语义真的变了**的时候才动。
const instanceMutexName = `Local\Perch.AgentTermGateway`

// errorAlreadyExists = ERROR_ALREADY_EXISTS。Win32 用它表示
// "这个名字的互斥体刚刚就在那儿了"（而不是"创建失败"）。
const errorAlreadyExists = 183

// instanceHandle 持有**第一个**实例的那把锁。留着它只是为了让"谁持有着"这件事
// 有一个明确的归属；进程退出时内核自动释放，我们不需要（也不能可靠地）自己清理。
var instanceHandle syscall.Handle

// ⚠️ `kernel32` 这个 LazyDLL 已经由 process_windows.go 声明了（processAlive 在用），
// 这里只加一个 proc —— 再声明一个 kernel32 就是重复定义，编译不过。
// （包级变量的初始化顺序由**依赖关系**决定，不由文件顺序决定，所以这里能用它。）
var procCreateMutex = kernel32.NewProc("CreateMutexW")

/*
	 acquireInstanceLock 问一句"这台机器（这个登录会话）上是不是已经有一个我在跑"。

		第一个实例  → (true, nil)  —— 锁在手上，直到进程结束
		第二个实例  → (false, nil) —— 没拿到锁，而且**不会**去等、不会去抢
		出错了      → (false, err) —— 判不出来的时候按"第一个"走？**不**：
		              调用方把 error 也当成"别碰共享状态"（见 main()），因为
		              "判不出来"和"已经有别人"这两件事的代价完全不对称：
		              误判成第二个最多是"这一轮不恢复"，误判成第一个可能毁掉会话。

⚠️ 第二个实例**也要把这个句柄关掉**：它没持有锁，但留着句柄等于给那个内核对象
多挂一个引用（不算持有，但白占一个句柄，而且会让"没人持有"这件事变得难解释）。
*/
func acquireInstanceLock(name string) (bool, error) {
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
