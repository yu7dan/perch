package ctl

import (
	"github.com/yu7dan/perch/internal/session"
	"github.com/yu7dan/perch/internal/settings"
)

// Msg 是 ctl 通道上的一条控制消息。字段与 JSON tag 是前后端协议的一部分：
// 改名/改形状等于改产品行为，结构整理时一律原样保留。
type Msg struct {
	Type string             `json:"type"`
	Cols int                `json:"cols"`
	Rows int                `json:"rows"`
	Msg  string             `json:"msg"`
	Spec *session.SpawnSpec `json:"spec,omitempty"`
	// attention 用：On = 开始/停止闪任务栏，Why 只为了日志能回答"为什么开始/停了"。
	On  bool   `json:"on"`
	Why string `json:"why"`
	// acts.snapshot 用：要哪一格的流水。
	Tab int `json:"tab"`
	// pane.close / pane.forget 用：那一格的 paneId（登记表的身份，不是 tab id ——
	// tab id 每次启动重发，见 panes.Pane 的说明）。close 只打标记，forget 才删。
	Pane int `json:"pane"`
	// Req：建格请求的**令牌**，原样带回 tab.ok（成功和拒绝两条路都带）。
	//
	// ⚠️ 为什么非要有它：前端原来靠"在 TAB_LIST 里找一个 id=0 且还在等应答的标签"
	// 来配对，单发时成立；而冷恢复是 burst，中间还夹着"被拒→重试"的格子 ——
	// pane1 重试时又把自己标成"还在等"，于是 pane2 起**整批错位一格**
	// （表现是"每格跑的都是隔壁的会话"，日志全正常）。令牌让配对变成一一对应。
	Req int `json:"req,omitempty"`
	// open 用：在系统里打开一个路径（Mode "reveal" = 在资源管理器里选中它）。
	// 路径由索引器给出（卡片上那份会话文件的绝对路径 / 它的 cwd），
	// Go 侧仍然要复核（绝对路径 + 存在），见 winproc.OpenPath。
	Mode string `json:"mode"`
	Path string `json:"path"`
	// fs.list / fs.read 用：Root 是**文件树根**（必须是项目池里的目录）。
	// Path 是根下面要列/要读的那个路径；Req 是令牌，原样带回。
	// 护栏见 internal/files —— 只读、包含性检查、大小上限，都在 Go 侧。
	Root string `json:"root"`
	// project.* 用：Path 是项目的身份（目录绝对路径）；Name 只在 rename /
	// add 时给（空 = 恢复目录名 / 取目录名）；Source 只在 add 时给。
	Name   string `json:"name"`
	Source string `json:"source"`
	// title.set 用：会话 id（= 盘上那份 .jsonl 的文件名）。
	// 左栏那条改名路**手里就有 id**（不像标签那条路只有一个 pid，得靠
	// sessions\<pid>.json 反查 —— 理由见 session.TitleStore），
	// 所以直接带 id 过来，少一次反查、也少一个"查不到"的失败模式。
	ID string `json:"id"`
	// open.url 用：在系统浏览器里打开一个 http(s) 地址（Agent 名单的下载页）。
	// 只认 http/https —— 别的 scheme 会让"打开下载页"变成一条可执行动作。
	URL string `json:"url"`
	// settings.set 用：只带用户真的改了的字段（指针 = 这条请求提没提到它）。
	// false / 0 / 空串都是合法值，所以不能用零值判断缺省。
	Settings *settings.Patch `json:"settings,omitempty"`
	// gw.* 用：控制面的读写参数。
	//   Period  today / 7d / 30d / all
	//   Preset  供应商预设 id
	//   Key     供应商 API key —— **只在内存里过一次**，不落日志、不回显
	//   From    分组改名前的 id
	//   Members 分组成员（provider/model）
	//   Plugin  插件 npm 包名；Op 是 add/remove/update/upgrade/off
	//   User    额度卡片的账号
	Period  string   `json:"period,omitempty"`
	Preset  string   `json:"preset,omitempty"`
	Key     string   `json:"key,omitempty"`
	From    string   `json:"from,omitempty"`
	Members []string `json:"members,omitempty"`
	Plugin  string   `json:"plugin,omitempty"`
	Op      string   `json:"op,omitempty"`
	User    string   `json:"user,omitempty"`
	Offset  int      `json:"offset,omitempty"`
	// 供应商编辑（gw.provider.save 且带 id、不带 preset）：三个接入点。
	// 用指针是为了把「没发」和「发来空串（清空这个接入点）」分开 ——
	// 值类型 + omitempty 会让"清空"变成静默无效。
	Chat      *string `json:"chat,omitempty"`
	Responses *string `json:"responses,omitempty"`
	Anthropic *string `json:"anthropic,omitempty"`
	// gw.provider.arrange：开关着的供应商的新顺序（id 列表，靠上的先用）。
	Order []string `json:"order,omitempty"`
	// gw.agent.set 用：Field 是 /api/state 里字段的 key，Value 是选项值。
	// 空串是**有效值** —— magpie 用它把字段还原成 agent 自己的默认，所以
	// Value 不套 omitempty：别让"清空"在编码这一层变成静默无效。
	Field string `json:"field,omitempty"`
	Value string `json:"value"`
	// agent.profile.set 用：effort 是网关路由组固定的档位（high/xhigh/...），
	// 空串 = 不固定，用模型自己的默认。Value 仍然是模型 id。
	Effort string `json:"effort,omitempty"`
	// agent.profile.save/use/delete 用：配置方案的名字。
	// （不能用 Name：那是 project.rename 的字段。）
	SetName string `json:"setName,omitempty"`
	// agent.profile.tier 用：Claude 的 opus/sonnet/haiku/fable。
	Tier string `json:"tier,omitempty"`
	// agent.profile.models 用：这个 agent 的模型选择器里要收起的模型 id。
	Hidden []string `json:"hidden,omitempty"`
}
