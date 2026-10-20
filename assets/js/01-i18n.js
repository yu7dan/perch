"use strict";
/* 01-i18n.js —— Perch 自己的界面语言（不是 agent 输出，也不是 magpie 页面）。

   范围：只翻译 Perch 应用层 DOM 与 Perch 生成的用户可见文案；终端内容、
   agent 名称/模型/路径、magpie iframe 自己的 UI 都不在这里。

   两份事实：
     · Go 的 settings.language 是权威（auto / en / zh）；
     · localStorage 里的 settings 缓存只负责**首帧**，让刷新/启动时先按
       上次语言画一帧，等 Go 的 settings 载荷到了再以它为准。

   语言切换不重启：静态节点走 data-i18n，动态区域由 onLocaleChanged
   （85-settings.js）重画。缺失 key 先回退英文，再回退中文，最后才显示 key。

   ⚠️ 全局翻译函数叫 t()，而别的脚本里大量有 `const t = activeTab` 这类
   局部变量。**在要调用全局 t() 的函数里，先把局部 t 改名**（例如 tab），
   否则拿到的是标签对象、调用时报 "t is not a function"。 */

const PERCH_I18N = {
  en: {
    "app.title": "Perch",
    "app.nameTitle": "Perch",

    "nav.overview": "Overview",
    "nav.workspace": "Workspace",
    "nav.settings": "Settings",

    "dash.tab.overview": "Overview",
    "dash.tab.gateway": "Gateway",
    "dash.tabs.aria": "Overview sections",
    "dash.refresh.title": "Rescan the session library (turns and active days update)",

    "dash.wd.mon": "Mon",
    "dash.wd.wed": "Wed",
    "dash.wd.fri": "Fri",
    "dash.wd.sun": "Sun",
    "dash.kpi.panes": "{n} panes",
    "dash.kpi.panesOne": "{n} pane",
    "dash.kpi.running": "Running",
    "dash.kpi.runningSub": "{panes} panes · {need} waiting for you",
    "dash.kpi.runningSubOne": "{n} pane · {need} waiting for you",
    "dash.kpi.turnsToday": "Turns today",
    "dash.kpi.turnsSub": "{week} in the last 7 days · {days} active days",
    "dash.kpi.requestsToday": "Requests today",
    "dash.kpi.failed": "{n} failed",
    "dash.kpi.failedRetried": "{n} failed · {retried} retried",
    "dash.kpi.gatewayDown": "Gateway not running",
    "dash.kpi.cacheHit": "Cache hit",
    "dash.kpi.cacheSub": "cache read {read} / prompt {prompt}",
    "dash.kpi.context": "Context",
    "dash.kpi.noRequests": "No requests yet",
    "dash.kpi.windowUnknown": "Window unknown · {model}",
    "dash.kpi.outputSpeed": "Output speed",
    "dash.kpi.avgFirstToken": "avg first token {ttft}",

    "dash.heat.title": "Daily activity",
    "dash.heat.metricAria": "Heatmap metric",
    "dash.heat.turns": "Turns",
    "dash.heat.calls": "Requests",
    "dash.heat.less": "Less",
    "dash.heat.more": "More",
    "dash.heat.pending": "Waiting for magpie readings",
    "dash.heat.down": "Gateway not running — switch back to Turns to see local sessions",
    "dash.heat.callsSub": "{total} requests · {days} active days · from magpie",
    "dash.heat.callsSubOne": "{n} request · {days} active days · from magpie",
    "dash.heat.noCalls": "No gateway requests yet",
    "dash.heat.turnsSub": "{total} turns · {days} active days · includes subagents",
    "dash.heat.turnsSubOne": "{n} turn · {days} active days · includes subagents",
    "dash.heat.noTurns": "No turn data yet",

    "dash.mix.title": "Tokens today",
    "dash.mix.cache": "Cache read",
    "dash.mix.input": "Input",
    "dash.mix.output": "Output",
    "dash.mix.write": "Cache write",
    "dash.mix.pending": "Waiting for magpie readings",
    "dash.mix.total": "{n} tokens total",
    "dash.mix.noUsage": "No usage today",
    "dash.mix.cost": "Cost ${n}",
    "dash.mix.empty": "No requests have gone through the gateway today.",

    "dash.lat.title": "Recent request latency",
    "dash.lat.note": "Bar height = latency",
    "dash.lat.sub": "{n} recent · avg {ms}ms",
    "dash.lat.noRequests": "No requests yet today",

    "dash.status.workspace": "Workspace",
    "dash.status.runningLabel": "Running",
    "dash.status.panesUnit": "panes",
    "dash.status.panesUnitOne": "pane",
    "dash.status.need": "Waiting for you {n}",
    "dash.status.projectsUnit": "projects",
    "dash.status.projectsUnitOne": "project",
    "dash.status.enter": "Open workspace",
    "dash.status.new": "New workspace",
    "dash.railDivider.title": "Drag to resize the left column",

    "dash.need.title": "Waiting for you",
    "dash.need.empty": "No panes are waiting for you right now.<br>Finished turns, open questions, and permission requests all show up here.",
    "dash.need.capWaiting": "Waiting for you · {n}",
    "dash.need.capIdle": "Idle · {n} panes (none waiting right now)",
    "dash.need.capIdleOne": "Idle · {n} pane (none waiting right now)",

    "dash.live.title": "Live",
    "dash.live.pending": "Waiting for magpie readings",
    "dash.live.processing": "Processing {n} requests",
    "dash.live.processingOne": "Processing {n} request",
    "dash.live.idleRecent": "Idle · {n} recent",
    "dash.live.reading": "Reading the gateway…",
    "dash.live.downStopped": "magpie gateway is not running — the config is there; open magpie to connect.",
    "dash.live.downMissing": "magpie gateway is not running — magpie was not detected.",
    "dash.live.headProcessing": "Processing <b>{n}</b> requests",
    "dash.live.headProcessingOne": "Processing <b>{n}</b> request",
    "dash.live.queued": " · {n} queued",
    "dash.live.tools": " · {n} tools waiting",
    "dash.live.toolsOne": " · {n} tool waiting",
    "dash.live.headIdle": "Gateway idle · {n} recent",
    "dash.live.empty": "No requests have gone through the gateway today.",
    "dash.live.firstToken": " · first token {ms}ms",

    "dash.agents.title": "Agent CLI",
    "dash.agents.note": "Local CLI agents only · click a row to configure the gateway · icons from magpie / lobe-icons",
    "dash.agents.levelFull": "Full status",
    "dash.agents.levelBasic": "Basic status",
    "dash.agents.levelLaunch": "Launch only",
    "dash.agents.levelNone": "Not wired",
    "dash.agents.notDetected": "Not detected",
    "dash.agents.macOnly": "macOS/Linux only",
    "dash.agents.sumFull": "{n} full",
    "dash.agents.sumBasic": "{n} basic",
    "dash.agents.sumLaunch": "{n} launch-only",
    "dash.agents.sumNone": "{n} not wired",
    "dash.agents.sumMissing": "{n} not detected",
    "dash.agents.sumRouted": " · {n} through the gateway today",
    "dash.agents.scanning": "Detecting local installs…",
    "dash.agents.listPending": "Agent list has not arrived yet.",
    "dash.agents.installBusy": "Installing…",
    "dash.agents.installScanning": "Checking…",
    "dash.agents.installTitle": "Run the official install command for {name} inside Perch",
    "dash.agents.install": "Install",
    "dash.agents.docsTitle": "Open the official installation notes for {name}",
    "dash.agents.docs": "Install notes",
    "dash.agents.openTitle": "Open a pane running {name} in Perch",
    "dash.agents.open": "Open",
    "dash.agents.stTitleMissing": "Not found in local config dirs or on PATH — this does not mean it is not installed (GUI PATH can be shorter)",
    "dash.agents.stTitleFull": "Shows busy/idle and when it is waiting for an answer or approval",
    "dash.agents.stTitleBasic": "Shows busy/idle; waiting for answers/approvals is not available yet",
    "dash.agents.stTitleLaunch": "Can open a pane in Perch; status is not wired yet",
    "dash.agents.stTitleNone": "Perch has no launch adapter for this agent yet",
    "dash.agents.wired": "Wired into the magpie gateway",
    "dash.agents.notWired": "Not wired into the magpie gateway",
    "dash.agents.configAria": "{name} configuration",
    "dash.agents.detailCli": "CLI · official install · {vendor}",
    "dash.agents.detailPath": "CLI · {path}",
    "dash.agents.calls": " · {n} today",
    "dash.agents.emptyAll": "No local agents detected yet — install one from the list below.",
    "dash.agents.foldHide": "Collapse",
    "dash.agents.foldShow": "Show {n} not detected",
    "dash.agents.groupMissing": "Not detected",

    "chrome.parallel.title": "Parallel view: all agents on one screen",
    "chrome.parallel": "Parallel",
    "chrome.newAgent.title": "Open another parallel agent",
    "chrome.needYou": "Needs you",
    "chrome.expandRight.title": "Show the right sidebar (Ctrl+Shift+B)",
    "chrome.minimize": "Minimize",
    "chrome.maximize": "Maximize",
    "chrome.restore": "Restore",
    "chrome.close": "Close",

    "list.title": "Workspace",
    "list.addProject.title": "Add a project (pick a folder)",
    "list.reload.title": "Rescan the session library",
    "list.search.placeholder": "Search projects, agents…",

    "status.initializing": "Starting",
    "status.connected": "Terminal connected",
    "status.disconnected": "Terminal disconnected",
    "status.connectionError": "Connection error",
    "status.indexPending": "Index: —",
    "status.index": "Index: {sessions} sessions / {projects} projects",
    "status.indexFailed": "Index: failed",
    "status.store": "Session store",
    "status.cwd": "Working directory",
    "status.gridTitle": "Parallel panes × columns per pane",
    "status.dimsTitle": "Terminal columns × rows",
    "status.meter5hTitle": "5-hour usage window (metering not connected yet)",
    "status.meterWeekTitle": "Weekly usage window (metering not connected yet)",
    "status.weekShort": "wk",
    "status.fontFallback": "Fallback font ✗",
    "status.fontTitle": "Monospace font actually used by the terminal (first available in the configured stack)",
    "status.ligatures": "· Ligatures",
    "status.renderTitle": "xterm rendering backend (WebGL first, DOM fallback)",
    "status.renderDom": "· DOM renderer",

    "settings.title": "Settings",
    "settings.intro": "These options belong to Perch. They do not change an agent's model, gateway, or permission configuration. Changes apply immediately and are saved locally.",
    "settings.search.placeholder": "Search settings…",
    "settings.search.aria": "Search settings",
    "settings.search.clear": "Clear search",
    "settings.empty.sub": "Try another word, such as \"font\", \"directory\", or \"confirm\".",
    "settings.empty.clear": "Clear search",
    "settings.section.workspace": "Workspace",
    "settings.section.workspace.note": "Where new panes and the default workspace start. Panes that are already running are not affected.",
    "settings.section.appearance": "Appearance",
    "settings.section.appearance.note": "How the terminal and interface look. Fonts ship with the app; no system install is required.",
    "settings.section.behavior": "Behavior",
    "settings.section.behavior.note": "Which agent is preselected for new panes. Closing the window and ending an agent both stop running work, so Perch asks first by default.",

    "settings.defaultCwd.label": "Default directory",
    "settings.defaultCwd.note": "New agents start here when no project is specified. You can type a path; empty = built-in directory.",
    "settings.defaultCwd.kind.builtin": "Built-in",
    "settings.defaultCwd.kind.custom": "Custom",
    "settings.defaultCwd.placeholder": "Built-in directory",
    "settings.defaultCwd.pick": "Choose folder…",
    "settings.defaultCwd.reset": "Restore default",
    "settings.defaultCwd.resetTitleBuiltIn": "Go back to the built-in <home>\\Documents\\Perch",
    "settings.defaultCwd.resetTitleDraft": "Discard the draft and keep the built-in directory",
    "settings.defaultCwd.resetTitleNow": "The built-in default directory is already in use",
    "settings.defaultCwd.resetAriaNa": "Restore default (the built-in default is already in use)",
    "settings.defaultCwd.resetAria": "Restore default",
    "settings.defaultCwd.noteMissing": "The configured directory is not on disk; new panes fall back to the built-in directory.",
    "settings.defaultCwd.noteMissingPath": "The configured directory is not on disk; new panes fall back to the built-in directory: {path}.",
    "settings.defaultCwd.noteBuiltin": "The built-in default is {path} (click \"Restore default\" to go back).",
    "settings.defaultCwd.pendingError": "The backend did not respond; the directory was not changed.",

    "settings.theme.label": "Theme",
    "settings.theme.note": "Light or dark interface. The light theme is still in progress.",
    "settings.theme.dark": "Dark",
    "settings.theme.light": "Light",
    "settings.theme.lightTitle": "The light theme is not ready; it will arrive in the next release.",
    "settings.theme.lightAria": "Light (not ready; next release)",

    "settings.fontFamily.label": "Terminal font",
    "settings.fontFamily.note": "Both are monospace fonts shipped with the app, with full box-drawing and table glyphs.",
    "settings.fontSize.label": "Terminal font size",
    "settings.fontSize.note": "More panes only makes each pane smaller; the font size stays the same.",
    "settings.fontSize.shrink": "Smaller",
    "settings.fontSize.grow": "Larger",
    "settings.fontSize.min": "Already at the smallest size",
    "settings.fontSize.max": "Already at the largest size",
    "settings.fontSize.toastTitle": "Font size limit",
    "settings.fontSize.toastMin": "12 is the smallest size.",
    "settings.fontSize.toastMax": "18 is the largest size.",

    "settings.resetDefault": "Restore default",
    "settings.switch.on": "on",
    "settings.switch.off": "off",
    "settings.defaultHint": "Default: {value}",
    "settings.defaultAgent.label": "Default agent",
    "settings.defaultAgent.note": "Preselected when you click + to create a pane. Auto picks an installed agent with the most state support.",
    "settings.defaultAgent.auto": "Auto (pick by capability)",
    "settings.defaultAgent.autoShort": "Auto",
    "settings.defaultAgent.missing": "{name} (not installed)",
    "settings.shortcut.label": "New pane shortcut",
    "settings.shortcut.note": "Starts a new pane in the current folder with the last agent, without the picker. Empty = off.",
    "settings.shortcut.unset": "Not set",
    "settings.shortcut.record": "Press a combination…",
    "settings.shortcut.recordTitle": "Press a new combination; Esc cancels, Backspace clears",
    "settings.shortcut.setTitle": "Current: {key}; click to record again",
    "settings.shortcut.emptyTitle": "Click to set a shortcut; empty = off",
    "settings.shortcut.cancelTitle": "Esc cancels; Backspace clears",
    "settings.shortcut.invalidTitle": "That key cannot be a shortcut",
    "settings.shortcut.invalidNote": "Use Ctrl or Alt plus a letter, number, or F1–F12.",
    "settings.shortcut.takenTitle": "That combination is already in use",
    "settings.shortcut.takenNote": "{chord} is already a Perch shortcut; choose another.",

    "settings.confirmClose.label": "Confirm before closing the window",
    "settings.confirmClose.note": "Asks before the window's × is used. Confirming ends every running agent with the window.",
    "settings.confirmEndAgent.label": "Confirm before ending an agent",
    "settings.confirmEndAgent.note": "\"End this agent\" deletes its seat record (session files on disk are untouched); Perch asks first.",
    "settings.startView.label": "Open at startup",
    "settings.startView.note": "Which page Perch opens next time. It does not switch this time.",
    "settings.startView.dash": "Overview",
    "settings.startView.workspace": "Workspace",

    "settings.language.label": "Language",
    "settings.language.note": "Interface language. Auto follows Windows.",
    "settings.language.auto": "Auto (system)",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.foot.html": "Settings are saved to <code>%APPDATA%\\Perch\\settings.json</code>. These options only affect Perch; they do not change an agent's own configuration.",

    "settings.toast.cwdDefaultTitle": "Already the default directory",
    "settings.toast.cwdDefaultNote": "The built-in default directory is in use.",
    "settings.toast.lightTitle": "The light theme is not ready",
    "settings.toast.lightNote": "Only the dark theme is available now; light will come in the next release.",
  },

  zh: {
    "app.title": "Perch · 栖枝",
    "app.nameTitle": "Perch（栖枝）",

    "nav.overview": "总览",
    "nav.workspace": "工作区",
    "nav.settings": "设置",

    "dash.tab.overview": "总览",
    "dash.tab.gateway": "网关",
    "dash.tabs.aria": "总览分区",
    "dash.refresh.title": "重扫会话库（轮次、活跃天数随之刷新）",

    "dash.wd.mon": "一",
    "dash.wd.wed": "三",
    "dash.wd.fri": "五",
    "dash.wd.sun": "日",
    "dash.kpi.panes": "{n} 格",
    "dash.kpi.running": "在跑",
    "dash.kpi.runningSub": "{panes} 格 · 在等你 {need}",
    "dash.kpi.turnsToday": "今日轮次",
    "dash.kpi.turnsSub": "近 7 天 {week} · {days} 个活跃日",
    "dash.kpi.requestsToday": "今日请求",
    "dash.kpi.failed": "{n} 失败",
    "dash.kpi.failedRetried": "{n} 失败 · {retried} 重试",
    "dash.kpi.gatewayDown": "网关未运行",
    "dash.kpi.cacheHit": "缓存命中",
    "dash.kpi.cacheSub": "缓存读 {read} / 提示 {prompt}",
    "dash.kpi.context": "上下文",
    "dash.kpi.noRequests": "还没有请求",
    "dash.kpi.windowUnknown": "窗口未知 · {model}",
    "dash.kpi.outputSpeed": "输出速度",
    "dash.kpi.avgFirstToken": "平均首字 {ttft}",

    "dash.heat.title": "每日活动",
    "dash.heat.metricAria": "热力图口径",
    "dash.heat.turns": "轮次",
    "dash.heat.calls": "请求",
    "dash.heat.less": "少",
    "dash.heat.more": "多",
    "dash.heat.pending": "magpie 读数还没到",
    "dash.heat.down": "网关未运行 —— 切回「轮次」仍可看本机会话",
    "dash.heat.callsSub": "累计 {total} 次请求 · {days} 个活跃日 · 来自 magpie",
    "dash.heat.noCalls": "网关还没有请求",
    "dash.heat.turnsSub": "累计 {total} 轮 · {days} 个活跃日 · 含子代理",
    "dash.heat.noTurns": "还没有轮次数据",

    "dash.mix.title": "今日 token",
    "dash.mix.cache": "缓存读",
    "dash.mix.input": "输入",
    "dash.mix.output": "输出",
    "dash.mix.write": "缓存写",
    "dash.mix.pending": "等 magpie 读数",
    "dash.mix.total": "合计 {n} tokens",
    "dash.mix.noUsage": "今天还没有用量",
    "dash.mix.cost": "成本 ${n}",
    "dash.mix.empty": "今天网关还没有处理请求。",

    "dash.lat.title": "最近请求耗时",
    "dash.lat.note": "柱高 = 耗时",
    "dash.lat.sub": "最近 {n} 条 · 平均 {ms}ms",
    "dash.lat.noRequests": "今天还没有请求",

    "dash.status.workspace": "工作区",
    "dash.status.runningLabel": "在跑",
    "dash.status.panesUnit": "格",
    "dash.status.need": "在等你 {n}",
    "dash.status.projectsUnit": "个项目",
    "dash.status.enter": "进入工作区",
    "dash.status.new": "新建工作区",
    "dash.railDivider.title": "拖动调整左栏宽度",

    "dash.need.title": "在等你",
    "dash.need.empty": "现在没有在等你的格子。<br>跑完一轮、挂着提问、要你批权限，都会出现在这里。",
    "dash.need.capWaiting": "在等你 · {n}",
    "dash.need.capIdle": "空闲 · {n} 格（此刻没有在等你）",

    "dash.live.title": "实时",
    "dash.live.pending": "等 magpie 读数",
    "dash.live.processing": "正在处理 {n} 个请求",
    "dash.live.idleRecent": "空闲 · 最近 {n} 条",
    "dash.live.reading": "正在读取网关…",
    "dash.live.downStopped": "magpie 网关未运行 —— 配置在，打开 magpie 就会接上。",
    "dash.live.downMissing": "magpie 网关未运行 —— 还没有检测到 magpie。",
    "dash.live.headProcessing": "正在处理 <b>{n}</b> 个请求",
    "dash.live.queued": " · {n} 个排队",
    "dash.live.tools": " · {n} 个工具等待",
    "dash.live.headIdle": "网关空闲 · 最近 {n} 条",
    "dash.live.empty": "今天还没有请求经过网关。",
    "dash.live.firstToken": " · 首字 {ms}ms",

    "dash.agents.title": "Agent CLI",
    "dash.agents.note": "只列本机 CLI agent · 点一行配置网关 · 图标来自 magpie / lobe-icons",
    "dash.agents.levelFull": "完整状态",
    "dash.agents.levelBasic": "基础状态",
    "dash.agents.levelLaunch": "仅启动",
    "dash.agents.levelNone": "未接入",
    "dash.agents.notDetected": "未检测到",
    "dash.agents.macOnly": "仅 macOS/Linux",
    "dash.agents.sumFull": "{n} 个完整",
    "dash.agents.sumBasic": "{n} 个基础",
    "dash.agents.sumLaunch": "{n} 个仅启动",
    "dash.agents.sumNone": "{n} 个未接入",
    "dash.agents.sumMissing": "{n} 个未检测到",
    "dash.agents.sumRouted": " · 今日经过网关 {n} 个",
    "dash.agents.scanning": "正在探测本机安装情况…",
    "dash.agents.listPending": "Agent 清单还没到。",
    "dash.agents.installBusy": "安装中…",
    "dash.agents.installScanning": "检测中…",
    "dash.agents.installTitle": "在 Perch 里运行 {name} 的官方安装命令",
    "dash.agents.install": "安装",
    "dash.agents.docsTitle": "打开 {name} 的官方安装说明",
    "dash.agents.docs": "安装说明",
    "dash.agents.openTitle": "在 Perch 里开一格 {name}",
    "dash.agents.open": "打开",
    "dash.agents.stTitleMissing": "本机配置目录与 PATH 里都没有找到 —— 不等于没装（GUI 的 PATH 可能更短）",
    "dash.agents.stTitleFull": "能看忙闲，也能看到它在等你回答/批准",
    "dash.agents.stTitleBasic": "能看忙闲；还看不到它在等你回答/批准",
    "dash.agents.stTitleLaunch": "能在 Perch 里开一格；还没有状态接入",
    "dash.agents.stTitleNone": "Perch 还没有这个 agent 的启动适配器",
    "dash.agents.wired": "已接入 magpie 网关",
    "dash.agents.notWired": "未接入 magpie 网关",
    "dash.agents.configAria": "{name} 配置",
    "dash.agents.detailCli": "CLI · 官方安装 · {vendor}",
    "dash.agents.detailPath": "CLI · {path}",
    "dash.agents.calls": " · 今日 {n} 次",
    "dash.agents.emptyAll": "还没有检测到本机安装的 Agent —— 下面的清单可以直接装。",
    "dash.agents.foldHide": "收起",
    "dash.agents.foldShow": "显示 {n} 个未检测到的",
    "dash.agents.groupMissing": "未检测到",

    "chrome.parallel.title": "并行视图：所有 agent 同屏",
    "chrome.parallel": "并行",
    "chrome.newAgent.title": "新开一个并行 agent",
    "chrome.needYou": "需要你",
    "chrome.expandRight.title": "展开右栏 (Ctrl+Shift+B)",
    "chrome.minimize": "最小化",
    "chrome.maximize": "最大化",
    "chrome.restore": "还原",
    "chrome.close": "关闭",

    "list.title": "工作区",
    "list.addProject.title": "添加项目（选一个目录）",
    "list.reload.title": "重扫会话库",
    "list.search.placeholder": "搜索项目、agent…",

    "status.initializing": "初始化",
    "status.connected": "终端已连接",
    "status.disconnected": "终端已断开",
    "status.connectionError": "连接错误",
    "status.indexPending": "索引：—",
    "status.index": "索引：{sessions} 会话 / {projects} 项目",
    "status.indexFailed": "索引：失败",
    "status.store": "会话库",
    "status.cwd": "工作目录",
    "status.gridTitle": "并行格数 × 每格可用列数",
    "status.dimsTitle": "终端的列 × 行",
    "status.meter5hTitle": "5 小时用量窗（待接入真实计量）",
    "status.meterWeekTitle": "周用量窗（待接入真实计量）",
    "status.weekShort": "周",
    "status.fontFallback": "回退字体 ✗",
    "status.fontTitle": "终端实际使用的等宽字体（按设置里的字体栈顺序第一个可用的）",
    "status.ligatures": "· 连字",
    "status.renderTitle": "xterm 的渲染后端（WebGL 优先，失败回退 DOM）",
    "status.renderDom": "· DOM 渲染",

    "settings.title": "设置",
    "settings.intro": "这些选项属于 Perch 自己，不影响 agent 的模型、网关或权限配置。改动即时生效，并保存在本机。",
    "settings.search.placeholder": "搜索设置…",
    "settings.search.aria": "搜索设置",
    "settings.search.clear": "清空搜索",
    "settings.empty.sub": "换个词试试，比如「字体」「目录」「确认」。",
    "settings.empty.clear": "清空搜索",
    "settings.section.workspace": "工作区",
    "settings.section.workspace.note": "新开的格子和「默认工作区」落在哪个目录。已经跑着的格子不受影响。",
    "settings.section.appearance": "外观",
    "settings.section.appearance.note": "终端和界面的显示方式。字体随应用分发，不依赖系统安装。",
    "settings.section.behavior": "行为",
    "settings.section.behavior.note": "新建格子时预选哪个 Agent；关窗和结束 agent 都是会带走正在运行的东西的动作，默认先问一句。",

    "settings.defaultCwd.label": "默认目录",
    "settings.defaultCwd.note": "没指定项目时，新 agent 从这里开始。可以直接输入路径，留空 = 内置目录。",
    "settings.defaultCwd.kind.builtin": "内置",
    "settings.defaultCwd.kind.custom": "自定义",
    "settings.defaultCwd.placeholder": "内置目录",
    "settings.defaultCwd.pick": "选择目录…",
    "settings.defaultCwd.reset": "恢复默认",
    "settings.defaultCwd.resetTitleBuiltIn": "回到内置的 <用户主目录>\\Documents\\Perch",
    "settings.defaultCwd.resetTitleDraft": "丢掉草稿，继续用内置默认目录",
    "settings.defaultCwd.resetTitleNow": "现在用的就是内置默认目录",
    "settings.defaultCwd.resetAriaNa": "恢复默认（现在用的就是内置默认目录）",
    "settings.defaultCwd.resetAria": "恢复默认",
    "settings.defaultCwd.noteMissing": "设置里的目录现在不在盘上；新格子会回落到内置目录。",
    "settings.defaultCwd.noteMissingPath": "设置里的目录现在不在盘上；新格子会回落到内置目录：{path}。",
    "settings.defaultCwd.noteBuiltin": "内置默认目录是 {path}（点「恢复默认」可以回去）。",
    "settings.defaultCwd.pendingError": "后端没有回应，目录没有改动。",

    "settings.theme.label": "主题",
    "settings.theme.note": "界面的明暗。浅色主题还在做。",
    "settings.theme.dark": "深色",
    "settings.theme.light": "浅色",
    "settings.theme.lightTitle": "浅色主题还没做，下一版提供",
    "settings.theme.lightAria": "浅色（还没做，下一版提供）",

    "settings.fontFamily.label": "终端字体",
    "settings.fontFamily.note": "两套都是随应用分发的等宽字体，方块和制表符字形齐全。",
    "settings.fontSize.label": "终端字号",
    "settings.fontSize.note": "格子多了也只是格子变小，字号保持不变。",
    "settings.fontSize.shrink": "缩小字号",
    "settings.fontSize.grow": "放大字号",
    "settings.fontSize.min": "已经是最小字号",
    "settings.fontSize.max": "已经是最大字号",
    "settings.fontSize.toastTitle": "字号到头了",
    "settings.fontSize.toastMin": "已经是最小字号 12。",
    "settings.fontSize.toastMax": "已经是最大字号 18。",

    "settings.resetDefault": "恢复默认",
    "settings.switch.on": "开",
    "settings.switch.off": "关",
    "settings.defaultHint": "默认：{value}",
    "settings.defaultAgent.label": "默认 Agent",
    "settings.defaultAgent.note": "点 + 新建格子时预选谁。自动 = 优先挑有状态能力的已安装 Agent。",
    "settings.defaultAgent.auto": "自动（按能力挑）",
    "settings.defaultAgent.autoShort": "自动",
    "settings.defaultAgent.missing": "{name}（未安装）",
    "settings.shortcut.label": "新建格快捷键",
    "settings.shortcut.note": "按下后直接在当前文件夹用上次的 Agent 新开一格，不弹选择；没有记忆时用上面的默认 Agent。留空 = 关闭。",
    "settings.shortcut.unset": "未设置",
    "settings.shortcut.record": "按下组合键…",
    "settings.shortcut.recordTitle": "按下新的组合键；Esc 取消，Backspace 清除",
    "settings.shortcut.setTitle": "现在是 {key}；点一下重新录制",
    "settings.shortcut.emptyTitle": "点一下设置快捷键；留空 = 关闭",
    "settings.shortcut.cancelTitle": "Esc 取消；Backspace 清除",
    "settings.shortcut.invalidTitle": "这个键不能当快捷键",
    "settings.shortcut.invalidNote": "需要 Ctrl 或 Alt + 字母、数字或 F1–F12。",
    "settings.shortcut.takenTitle": "这个组合键已被占用",
    "settings.shortcut.takenNote": "{chord} 已经是 Perch 的快捷键；换一个。",

    "settings.confirmClose.label": "关闭窗口前确认",
    "settings.confirmClose.note": "点窗口右上角的 × 时先问一句。确认后所有正在跑的 agent 会随窗口结束。",
    "settings.confirmEndAgent.label": "结束 agent 前确认",
    "settings.confirmEndAgent.note": "「结束这个 agent」会删掉它的座位记录（磁盘上的会话文件不动），动手前先问一句。",
    "settings.startView.label": "启动时打开",
    "settings.startView.note": "下次打开 Perch 先落在哪一页。这一次不会跳。",
    "settings.startView.dash": "总览",
    "settings.startView.workspace": "工作区",

    "settings.language.label": "语言",
    "settings.language.note": "界面语言。自动 = 跟随 Windows。",
    "settings.language.auto": "自动（跟随系统）",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.foot.html": "设置保存在 <code>%APPDATA%\\Perch\\settings.json</code>。这里的选项只影响 Perch，不改 agent 自己的配置。",

    "settings.toast.cwdDefaultTitle": "已经是默认目录",
    "settings.toast.cwdDefaultNote": "现在用的就是内置默认目录。",
    "settings.toast.lightTitle": "浅色主题还没做",
    "settings.toast.lightNote": "现在只有深色主题；浅色会在下一版提供。",
  },
};

let PERCH_LANG_PREF = "auto";
let PERCH_LOCALE = "en";

function perchResolveLocale(pref) {
  const v = String(pref || "auto").toLowerCase();
  if (v === "en" || v === "zh") return v;
  const langs = (navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || ""];
  for (const l of langs) {
    if (/^zh(?:-|$)/i.test(String(l))) return "zh";
  }
  return "en";
}

function perchCachedLanguage() {
  try {
    const raw = JSON.parse(localStorage.getItem("perch.settings.v1") || "null");
    const v = raw && raw.language;
    return (v === "en" || v === "zh" || v === "auto") ? v : "auto";
  } catch (_) {
    return "auto";
  }
}

function t(key, vars) {
  const k = String(key || "");
  const dict = PERCH_I18N[PERCH_LOCALE] || PERCH_I18N.en;
  let s = dict[k];
  if (s === undefined) s = PERCH_I18N.en[k];
  if (s === undefined) s = PERCH_I18N.zh[k];
  if (s === undefined) return k;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
  }
  return s;
}

/* 带数量的句子：n === 1 时优先用 `${base}One`（只在当前语言里存在才用）。
   中文不需要单复数，所以 zh 的 One 键写同一句；英文才真正换词。 */
function tCount(base, n, vars) {
  const dict = PERCH_I18N[PERCH_LOCALE] || PERCH_I18N.en;
  const key = Number(n) === 1 && dict[base + "One"] !== undefined ? base + "One" : base;
  const v = Object.assign({}, vars || {});
  if (v.n === undefined) v.n = n;
  return t(key, v);
}

/* 只替换元素开头的直接文本节点，保留后面的 <em> 等子元素。
   设置页的说明行是「说明文字 + 默认值提示」的结构，不能用 textContent 整块覆盖。 */
function perchSetLeadingText(el, text) {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) el.removeChild(n);
  }
  el.insertBefore(document.createTextNode(text), el.firstChild);
}

function applyStaticI18n(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll("[data-i18n]")) {
    const key = el.getAttribute("data-i18n");
    const v = t(key);
    if (v !== key) el.textContent = v;
  }
  for (const el of scope.querySelectorAll("[data-i18n-text]")) {
    const key = el.getAttribute("data-i18n-text");
    const v = t(key);
    if (v !== key) perchSetLeadingText(el, v);
  }
  for (const el of scope.querySelectorAll("[data-i18n-html]")) {
    const key = el.getAttribute("data-i18n-html");
    const v = t(key);
    if (v !== key) el.innerHTML = v;
  }
  const attrs = [
    ["title", "data-i18n-title"],
    ["placeholder", "data-i18n-placeholder"],
    ["aria-label", "data-i18n-aria-label"],
    ["alt", "data-i18n-alt"],
  ];
  for (const [attr, marker] of attrs) {
    for (const el of scope.querySelectorAll(`[${marker}]`)) {
      const key = el.getAttribute(marker);
      const v = t(key);
      if (v !== key) el.setAttribute(attr, v);
    }
  }
}

function setLocale(pref) {
  const p = String(pref || "auto").toLowerCase();
  PERCH_LANG_PREF = (p === "en" || p === "zh") ? p : "auto";
  const next = perchResolveLocale(PERCH_LANG_PREF);
  PERCH_LOCALE = next;
  const lang = next === "zh" ? "zh-CN" : "en";
  if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
  document.title = t("app.title");
  applyStaticI18n(document);
  if (typeof onLocaleChanged === "function") {
    try {
      onLocaleChanged();
    } catch (e) {
      if (typeof jserr === "function") jserr("onLocaleChanged", e);
      else console.error("[perch] onLocaleChanged", e);
    }
  }
}

// 首帧：settings 载荷还没到，先用本地缓存/系统语言把静态文案画对。
setLocale(perchCachedLanguage());
