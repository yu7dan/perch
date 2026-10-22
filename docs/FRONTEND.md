# Perch 前端

这份文档回答：**新代码该放哪个文件**、**为什么前端是一个个 `defer` 而不是模块**、
**CSS 的层叠顺序**、**图标从哪来**、**改完为什么必须重建**。

## 目录

```
assets/
  index.html              唯一页面：DOM 结构 + 按序 defer 的 classic script
  css/                    00-base … 70-gateway（按域拆分，链接顺序即层叠顺序）
  js/                     20 个前端域文件（classic script，共享全局作用域）
  vendor/                 xterm.js、xterm.css 与官方 addon（原样分发）
  fonts/                  等宽与界面字体（@font-face，随应用走）
  icons/agents/           agent / 供应商 / 产品图标（SVG 或 PNG）
  icons/magpie.svg        引擎品牌图标（许可归属保留；Perch 界面不显示）
  icons/perch-logo.png    Perch 产品标（透明 PNG，不重绘）
```

## 为什么是 classic script + defer

Wails 的运行时是 ESM，而业务代码共享一份全局状态。拆文件时选了**不打包**的路线：

1. `index.html` 里先有一个 `type="module"` 的脚本，只做一件事：`import` Wails 运行时并挂到
   `window.__wails`。
2. 其余 20 个文件都是 `<script defer src="/js/…">` 的 **classic script**，按顺序执行。
3. 它们共享同一个全局词法作用域。`const` / `let` / `function` 在后面的文件里直接可见。

因此：

- **编号就是加载顺序**。调换 `index.html` 里的顺序可能报 `ReferenceError`：`const` 有 TDZ，
  函数声明只在**同一个**脚本内提升，不跨脚本。
- **classic script 里不能有顶层 `await`**。需要异步的启动工作放在 `10-term.js` 的
  `fontsReady` promise 里，或放进末尾的启动 IIFE（`await fontsReady;` 之后）。
- 每个文件顶部有 `"use strict";` 和一段注释：本文件的域、以及它负责的那一块界面。
- 不拆子目录：这些文件不是模块，拆目录只会制造"可以单独加载"的错觉。

## 文件与归属

| 文件 | 负责什么 | 新代码放这里的情况 |
|---|---|---|
| `05-prefs.js` | 设置的前端缓存 / 生效值（字号、字体、启动落点、默认目录读数）、终端外观应用 | 设置项的前端默认值与首帧行为 |
| `10-term.js` | 终端工厂 `createTab`、流、尺寸、标签、状态点、图标 | 与 xterm / PTY 前端直接相关 |
| `20-ctl.js` | ctl 控制流、建格请求/应答、冷恢复、`sendCtrl` / `bootFact` | 新的后端消息类型、启动握手 |
| `30-pages.js` | 并行网格与独立页、标签拖拽、关格/新格、选会话面板、IME 锚点 | 网格布局、页签交互 |
| `40-chrome.js` | 自绘标题栏、左右栏宽度、终端收起、启动建格、群组看板 | 窗口 chrome、左栏、群组 |
| `50-ask.js` | AskUserQuestion：选择器、点选项作答、按题跳转 | 提问 UI |
| `55-perm.js` | 权限框就地作答：读终端里的批准框，点允许 / 拒绝或条件选项 | 权限框的字形与按键/点击映射 |
| `60-shell.js` | 壳层数据、导航、项目/agent/已关闭行、菜单、重命名、卡片 | 左栏列表与项目池 |
| `70-flow.js` | 会话卡片 HTML、右下对话流（live/历史）、跟随与折叠 | 对话流渲染 |
| `80-live.js` | 复接/分叉动作、shell 推送应用、右栏「需要你/改动/流水/子代理」、实时读数 | shell 推送落点 |
| `81-newspace.js` | 新建工作区卡片：文件夹选择器、Agent 选择、系统选择器回执 | 新建工作区的表单与手势 |
| `82-file-icons.js` | 文件类型图标表：后缀 / 文件名 / 复合后缀 → 图标（Lucide） | 文件图标选型规则 |
| `83-files.js` | 右栏「文件」：改动视图、目录树（`fs.list`）、只读预览（`fs.read`） | 文件模块的呈现与浏览 |
| `84-settings-search.js` | 设置搜索的纯评分函数（节/标题/描述/关键词四档，不碰 DOM） | 搜索匹配规则、评分权重 |
| `85-settings.js` | 设置页交互（搜索显隐、行、默认目录草稿、单选组方向键 / 漫游 tabindex）、确认框单例 `askConfirm`、关窗确认 | 设置页的行与手势、通用确认框 |
| `86-dash.js` | 总览（本地读数、热力图、在等你、Agent 工作台、网关用量卡）与图标 resolver | 总览页的任何 UI |
| `87-gateway.js` | 原生网关页（状态条、已添加供应商、供应商目录、右侧编辑器、key 测试/删除）+ 网关推送的落点（`applyGw` / `applyGwProviders` / `applyGwProviderSaved` / `applyMagpie` / `applyGwUsage` / `applyGwAgents`） | 网关页的任何 UI；新的网关推送消息 |
| `88-install.js` | 安装进度台：阶段、计时、进度条、最后一行日志、可展开日志与收尾 | 安装进度与收尾 |
| `89-agent-cfg.js` | 行内详情（总览 Agent 工作台点一行）：接入/断开/字段/预览/保留现状、漂移轮询、可搜索模型选择器 | Agent 接线的呈现与手势 |
| `99-boot.js` | 总览事件绑定 + 首帧证据 | 启动顺序、首屏 |

一条经验：**推送落点（`apply*`）只做「把数据放进状态 + 决定重画哪几块」**，具体 HTML
留在对应域的文件里。这样"什么时候重画"和"画成什么样"不会缠在一起。

## 总览 / 网关的分工

- 总览是工作台：Agent 的安装、打开、选模型、接入、行内详情都在这里；右栏是
  网关用量和在等你。不要再把它拆成单独的 Agents 页或右侧抽屉。
- 网关是模型来源：只放引擎状态、已添加供应商、供应商目录、右侧编辑器。
  不要再加 Agents / Usage 标签页。
- 供应商目录始终陈列；点 tile 预填编辑器，保存后不关，模型 chips / 测试 /
  删除都在同一个 sheet 里。

重画契约（避免 2.5s 推送冲掉正在输入的表单/选择器）：

- `MG_CAT_SIG` 只算安装身份（id / installed / icon / name / path / install /
  url / caps.launch），今日 calls 不进签名。
- `MG_GW_SIG` 只在供应商/模型身份变化时重画工作台表头的「N 个供应商 ·
  M 个模型」；否则保存供应商后表头会停在 0 个模型。
- 选择器开着或行内详情有输入焦点时，`renderDashAgents` 置
  `AGENT_RENDER_PENDING`，关闭后再画。
- `applyMagpie` 的今日用量变化只重画用量卡；网关页的 `#gw-body` 可以自由
  重画，编辑器是独立的 `#gw-edit`，需要 `isConnected` 守卫挡住“重画后点击
  目标已脱离文档”的误关。

## 界面语言

界面文案不走 `innerHTML` 拼中文，统一用 `01-i18n.js` 的 `t()` / `tCount()` /
`tMsg()`；静态节点用 `data-i18n*` 属性。两条最容易踩的规则：

- 局部变量 `const t = activeTab` 会遮住全局 `t()`，要调用翻译的函数先把局部变量改名。
- 增量渲染的签名必须把 `PERCH_LOCALE` 算进去，否则切语言后旧文案留在屏上。

完整约定（字典、后端 `uimsg` code、CI 守卫）见 [I18N.md](I18N.md)。

## CSS

| 文件 | 域 |
|---|---|
| `00-base.css` | 字体、颜色/尺寸 token、全局 reset、标题栏 |
| `10-nav.css` | 导航栏、总览（读数、热力图、图标规则） |
| `20-list.css` | 会话列表、卡片、行内 Agent 详情、打开面板、toast |
| `30-workspace.css` | 主区、标签、终端、网格、xterm patch、对话流、群组/提问/权限 |
| `40-sidebar.css` | 右栏、状态栏 |
| `50-settings.css` | 设置页 |
| `60-pages.css` | 确认框、铃铛、文件、新工作区、左栏 override |
| `70-gateway.css` | 原生网关页（状态条、已添加供应商行、目录 tiles、右侧编辑器 sheet） |

`index.html` 的 `<link>` 顺序就是层叠顺序：基础 token → 各区域 → 第三方/网关覆盖。新增样式
放进对应的域文件；不要恢复第二份全局样式表，也不要在 `index.html` 里写 inline style。

## 图标规则

- **终端面板 / 标签页的身份**用星芒，代表"agent 终端"这个形态。
- **目录、名单、列表、卡片**用各产品的官方图标，从 `assets/icons/agents/` 取。
- 网关页是 Perch 原生页面，**不放引擎品牌入口**；状态条只显示引擎状态/版本/地址。
- 图标一律用上游现成的 SVG/PNG，**不要手画**，不要用 emoji 顶替。
- 同一个图标名只对应一个文件；PNG 图标在 `isPngIcon()` 里登记，其余默认 `.svg`。
- 图标 id 可能来自 magpie 的运行时状态，**不要按静态引用删文件**。文件缺失时，
  `86-dash.js` 的 `error` 监听会换成带底色的「?」，不会留 404 空白。

## 改完必须做的事

`assets/` 是 `go:embed` 进 exe 的。**任何 `assets/` 改动都要 `go build` 并且重启进程**，
否则测的是旧代码（最坏会把真护栏测成"没生效"）。前端没有打包器，也不需要 `npm install`。

```powershell
go build -o build\perch.exe ./cmd/perch
go build -o build\perch-hook.exe ./cmd/perch-hook
```
