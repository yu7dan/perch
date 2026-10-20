// Package transcript 跟着 Claude 的转录文件走，产出「流水」和「改动」两条数据腿。
//
// 为什么是**跟着文件**而不是从 PTY 字节里认：jsonl 是 claude 自己写的、
// 结构化的、而且带结论（成了没有、加了几行减了几行）。字节那一侧只能猜。
// 路径来自 hook 的 SessionStart（payload 里有 transcript_path），
// 所以不需要反解 projects\<有损slug>\ 那层编码。
//
// 形状全部是**对我自己的真转录实测出来的**（不是查文档），关键三条：
//
//	调用：{"type":"assistant","message":{"content":[{"type":"tool_use",
//	        "name":"Edit","input":{"file_path":…,"old_string":…,"new_string":…}}]}}
//	结果：{"type":"user","toolUseResult":{…},"message":{"content":[
//	        {"type":"tool_result","tool_use_id":"call_00_…"}]}}
//
// ⚠️ 这两行是**不同的行**，而且后者字符串里没有 `"tool_use"` 这个带闭合引号的
// 片段（它是 `"tool_use_id"`）—— 我第一次探针按 `"tool_use"` 过滤时，
// 只捞到调用、一条结果都没捞到，差点据此以为"结果里没有可用信息"。
//
// 结果的形状按工具分（实测）：
//
//	Write  {"type":"create","filePath":…,"content":…}
//	Edit   {filePath,oldString,newString,originalFile,structuredPatch,userModified}
//	Read   {filenames,mode,numFiles,numLines,totalLines}
//	Bash   {interrupted,stdout,stderr,persistedOutputPath,persistedOutputSize}
//	Agent  {agentId,description,prompt,resolvedModel,status,outputFile}
//	AskUserQuestion {questions,answers,annotations}
//
// 其中 Edit 的 structuredPatch 是**标准 unified diff**
// （{oldStart,oldLines,newStart,newLines,lines:[" 上下文","-旧","+新"]}），
// 数前缀就是 git 那种 ±N —— 不用自己去 diff 两份文本。
//
// 本包不 import 任何领域包：活格子的名单由调用方以 Live 函数注入，推送走注入的
// Push。跟随器的内存态只属于它自己的协程，取快照走请求通道（见 Follower.Acts）。
package transcript

import "time"

const (
	// 转录是**追加**写的，跟着读很便宜；400ms 一次对"看着它干活"足够。
	transcriptPollEvery = 400 * time.Millisecond

	// 内存里保留的流水条数（超了从头砍）。前端也只渲染一屏。
	maxActs = 300
	// 改动台账每个格子最多记这么多文件（按最后一次动作时间淘汰）。
	maxFiles = 200

	// 「改动」正文的保留上限。文件列表会跟着每 400ms 的轮询推送，所以**大块
	// diff 不挂在 FileTouch 的 JSON 上**，只在文件预览按需取（trace.diff）；
	// 但内存里仍要留一份，否则点了文件只能看到 ±N 却看不到改了哪几行。
	// 三道上限一起用：单次改动、单文件、整格。
	maxChangeText      = 16 * 1024 // 单次改动可展示正文的字节数
	maxPatchLines      = 500       // 单次改动保留的 diff 行数（含上下文）
	maxChangesPerFile  = 4
	maxChangeBytesFile = 48 * 1024
	maxDiffFiles       = 60 // 整格最多保留多少个文件的改动正文
	maxPendingToolText = 32 * 1024
)

// View 是跟随器需要知道的活格子：id、转录路径、cwd。
// 调用方从自己的标签管理器里映射出来 —— 本包不认识 session.Tab。
type View struct {
	ID         int
	Transcript string
	CWD        string
}

// FileHunk 是一次编辑里的一段 unified diff（形状照 claude 转录的
// structuredPatch：{oldStart,oldLines,newStart,newLines,lines}）。
type FileHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

// FileChange 是一次**可展示**的改动。文件列表只带 HasDiff/State 这种轻标记，
// 真正的 diff 正文按需由 trace.diff 取（见 maxChangeText 上面那段）。
type FileChange struct {
	Tool string `json:"tool"` // Edit | Write | NotebookEdit
	At   string `json:"at,omitempty"`
	OK   bool   `json:"ok"`
	Add  int    `json:"add,omitempty"`
	Del  int    `json:"del,omitempty"`

	Patch []FileHunk `json:"patch,omitempty"`

	// Write 的整份内容（成功时用结果里的，被拒绝时用调用参数里的）。
	Content string `json:"content,omitempty"`
	// Edit 被拒绝时没有 structuredPatch：拿调用参数里的旧/新串兜底。
	Old string `json:"old,omitempty"`
	New string `json:"new,omitempty"`

	// 被拒绝/没产生差异/没有 diff 可展示时的一句话。
	Note string `json:"note,omitempty"`
	// 失败是不是"用户/权限拒绝"（而不是工具报错）。两者都没有落盘，
	// 但界面上分得开：「被拒绝」和「工具失败」不该长成同一句话。
	Denied bool `json:"denied,omitempty"`
	// 正文被 maxChangeText / maxPatchLines 砍过（前端要如实说）。
	Truncated bool `json:"truncated,omitempty"`

	// 内存记账用（不发给前端）：这条改动占了多少字节。
	bytes int
}

// FileTouch 是一个被这个会话碰过的文件。
type FileTouch struct {
	Path string   `json:"path"`
	Rel  string   `json:"rel"` // 相对会话 cwd（展示用；cwd 外的仍是绝对路径）
	Ops  []string `json:"ops"` // "read" | "edit" | "write"，去重
	Add  int      `json:"add"`
	Del  int      `json:"del"`
	At   string   `json:"at"`

	// 预览用轻标记：有没有可展示的改动；最后一次改动是不是被拒绝 / 文件
	// 现在是不是已经不在盘上。正文不在这里（见 FileChange 上面那段）。
	HasDiff bool         `json:"hasDiff,omitempty"`
	State   string       `json:"state,omitempty"` // "" | "rejected" | "missing"
	Changes []FileChange `json:"-"`
}

// ActItem 是流水里的一条。ID 用于**原地更新**（工具先出现、结果后到），
// 也用于前端按 id 定位"我画到哪了"（见 index.html 的 flowLastId）。
//
// ⚠️ **每一条都必须有 ID**，不只是工具调用。第一版只在 tool_use 上填 id，
// prompt/text/system 都是空串 —— 前端那个"追加游标"于是锚不住：
// 它按 id 找上一帧画到的那条，找不到就当"整份重建"，每来一条新内容
// 整个列表重画一遍。日志当场露出来了：`流水 +1 条` 而前端写着 `追加5 条 共5 条`
// （5 = 已有 4 条被重新追加了一遍），屏上是重复的对话。
// 所以 id 在这里补齐：`s<序号>`，进程内递增、只增不减，前端当成身份用。
type ActItem struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"` // "prompt" | "text" | "thinking" | "tool" | "system" | "compact"
	Tool  string `json:"tool,omitempty"`
	Text  string `json:"text"`
	Path  string `json:"path,omitempty"`
	Rel   string `json:"rel,omitempty"`
	Add   int    `json:"add,omitempty"`
	Del   int    `json:"del,omitempty"`
	OK    *bool  `json:"ok,omitempty"` // nil = 还在跑
	Agent string `json:"agent,omitempty"`
	At    string `json:"at"`

	// **只有 AskUserQuestion 会有**（别的工具没有，所以 omitempty）。
	//
	// Qs 是问题与选项本身 —— 待答期间前端画的就是它。**这一条能存在，
	// 是因为转录跟着读**：问题在转录里就是一条普通 tool_use，input 完整
	// （含每个选项的 description/preview），不需要 hook、也不需要屏幕解析。
	//
	// Answers 是"用户选了哪个"，key 是**问题的原文**、value 是选中的 label
	// （形状取自工具自己的 output schema：answers 是 string→string 的 object）。
	// 它只在结果落盘之后才有 —— 而"有没有结果"这件事**不用看它**：
	// `OK == nil` 就是还在等你答（见上面 OK 那行的定义）。
	Qs      []QAsk            `json:"qs,omitempty"`
	Answers map[string]string `json:"answers,omitempty"`

	/* **正文被截断时才有**：原文总**字符**数（前端照它说"这里只显示了前 N 字"）。
	   为什么要有它：只留一个没头没尾的 `…`，读的人分不清那是作者写的还是我们砍的
	   （实测就是被当成"作者就这么写的"）。0/缺省 = 没截。见 msgText。 */
	FullLen int `json:"fullLen,omitempty"`

	/* **只有 Kind=="compact" 会有**（同上，omitempty）。

	   Turn 是这次压缩发生在**这个会话的第几回合**（转录顶层
	   `turnPosition.turnIndex`，实测 41/42 条压缩行都有它，且逐条递增）；
	   Swallowed 是它跟**上一个**压缩点之间隔了几个回合（第一个压缩点没有值）。
	   —— 两个都是**转录里真有的数**。

	   ⚠️ 别把它们理解成"这次吞了 N 轮对话"：转录里**没有**那个数。
	   实测 42 条压缩行：`summarizedTurnPromptUuids` 要么 1 个（31 条）要么
	   压根没有（11 条），`compact_metadata` **一次都没出现**。
	   所以这里只报能看见的（第几回合 / 距上次几个回合），不编 token、不编回合数。 */
	Turn      int `json:"turn,omitempty"`
	Swallowed int `json:"swallowed,omitempty"`
}

// QOpt 是 AskUserQuestion 的一个选项。
//
// ⚠️ Prev 是**多行**的：它画的是"影响面"那种对齐块（✓/✗ 缩进列表），
// 所以它截断用的是 cutRunes 而**不是** clip —— clip 会把换行压成空格，
// 正好毁掉 preview 唯一的用处（clip 是给日志写的，见 internal/session/hooks.go）。
type QOpt struct {
	Label string `json:"label"`
	Desc  string `json:"desc,omitempty"`
	Prev  string `json:"prev,omitempty"`
}

// QAsk 是 AskUserQuestion 的一问。
type QAsk struct {
	Q      string `json:"q"`
	Header string `json:"header,omitempty"`
	Multi  bool   `json:"multi,omitempty"` // multiSelect：可以多选
	Opts   []QOpt `json:"opts,omitempty"`
}
