// Package session 拥有活状态：标签、会话身份、用户起的名字、hook/登记表两条
// 观察腿，以及续接护栏。
//
// 它不 import 界面、转录或控制协议；Wails 的流注册由组合根做，PTY 的字节循环
// 由 stream 包做（见 docs/ARCHITECTURE.md 的依赖方向）。
package session

import "github.com/yu7dan/perch/internal/agent"

// ResumeIntent 是「以什么姿态接上已有会话」。前端只声明意图，
// 翻译成命令行是 agent 自己的事（见 internal/agent 的 Def）。
type ResumeIntent = agent.ResumeIntent

// SpawnSpec 是一次建格请求。字段与 JSON tag 是控制协议的一部分，不许改。
type SpawnSpec struct {
	Agent  string       `json:"agent"`
	CWD    string       `json:"cwd"`
	Resume ResumeIntent `json:"resume"`
	// Target 说明这一格的**目标类型**（只在 Resume.Kind=="new" 时有意义）：
	//
	//	"project"   项目目录，CWD 必须有值且必须是池子里的项目
	//	"directory" 明确指定的其他目录（例如未归类的当前目录），CWD 必须有值
	//	"scratch"   无项目，落在默认工作区根目录；CWD 必须为空
	//	""          旧调用方，按 CWD 原样启动（不声明的项目目标）
	//
	// 它存在的理由：空 cwd 原来同时表示“没指定”和“默认目录”，前端一旦把旧
	// 选中值带进请求，后端只看到一个合法目录，分不出这是不是用户真正选的目标。
	// 显式 target 让“项目目标”必须带项目路径，缺了就拒绝，不再静默回落。
	Target string `json:"target,omitempty"`
	// PaneID：**冷恢复建出来的那一格**认领登记表里的旧身份时原样回传。
	// 0 / 缺省 = 这是一格全新的格子，paneId 由 Go 现发（见 panes.Store.NextID）。
	// 为什么要这个字段而不是"按顺序认领"：冷恢复的建格是**一次 burst**，
	// 中间还夹着"被拒了就重试"的格子 —— 按顺序认领在那种队列上会整体错位一格
	// （表现是"每格跑的都是隔壁的会话"，而日志全正常）。
	PaneID int `json:"paneId,omitempty"`
	// DegradedFrom：这一格是**降级**建出来的，原本要接的是这条会话（空 = 不是降级）。
	// 降级这个决定是前端做的（只有它知道拒绝码、也只有它知道两次重试都过了）——
	// 而它重建这一格时正好有一趟建格请求顺路回来，所以这件事就搭这趟车，
	// 不必再开一条 ctl 消息去说（多一条消息就多一个"它没到"的失败模式）。
	// 它只喂给 panes.Store.MarkDegraded 留一笔证据，**不参与任何判定**。
	DegradedFrom string `json:"degradedFrom,omitempty"`
}
