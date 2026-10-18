# Perch 前端与仓库结构

这份文档回答三个问题：**某一类代码该放哪个文件**、**为什么前端是一个个 `defer` 而不是模块**、
**图标从哪来、用在哪**。新增代码之前先看这里，别把新东西塞进已经满载的文件。

## 目录

```
term/
  main.go                  进程入口、ctl 消息分发、PTY 启动
  *.go                     后端按职责分文件（见下）
  assets/
    index.html             唯一页面：DOM 结构 + 按序 defer 的经典脚本
    app.css                应用样式表（主界面）
    gw.css                 网关页外壳（iframe 尺寸 + 未接入时的安装卡）
    js/                    前端域文件（经典脚本，共享全局作用域）
    js/gw/                 网关页（00-frame：内嵌 magpie 自己的界面）
    agent-icons/           agent / 供应商 / 产品图标（SVG 或 PNG）
    fonts/                 等宽字体
    xterm.js, addon-*.js   xterm 与官方 addon（原样引入）
    magpie.svg             magpie 品牌图标（仅网关页标识使用）
  docs/                    结构说明（本文件）与 README 截图（images/）
  _tools/                  构建、截图、点击、按键等验证脚本
```

## 前端：为什么是 classic script + defer

Wails 的运行时是 ESM，而业务代码原来是单文件、顶层 `await`。拆文件时选了**不打包**的路线：

1. `index.html` 里先有一个 `type="module"` 的脚本，只做一件事：`import` Wails 运行时并挂到
   `window.__wails`。
2. 其余 14 个文件都是 `<script defer src="/js/…">` 的**经典脚本**，按顺序执行。
3. 它们共享同一个全局词法作用域。`const`/`let`/`function` 在后面的文件里直接可见。

因此：

- **加载顺序就是依赖顺序**。把文件在 `index.html` 里的顺序调换，可能报 `ReferenceError`
  （`const` 有 TDZ，函数声明只在**同一个**脚本内提升，不会跨脚本提升）。
- **经典脚本里不能有顶层 `await`**。需要异步的启动工作放在 `10-term.js` 的 `fontsReady`
  promise 里，或放进末尾的启动 IIFE（`await fontsReady;` 之后）。
- 每个文件顶部有 `"use strict";` 和一段注释：本文件的域、以及从旧 `app.js` 切出来的源行范围。
  改完代码后如果行范围失去意义，把注释里的"源行"删掉，别留错误的行号。

### 文件与归属

| 文件 | 负责什么 | 新代码放这里的情况 |
|---|---|---|
| `10-term.js` | 终端工厂 `createTab`、流、尺寸、标签、状态点、图标 | 与 xterm / PTY 前端直接相关 |
| `20-ctl.js` | ctl 控制流、建格请求/应答、冷恢复、`sendCtrl` / `bootFact` | 新的后端消息类型、启动握手 |
| `30-pages.js` | 并行网格与独立页、标签拖拽、关格/新格、选会话面板、IME 锚点 | 网格布局、页签交互 |
| `40-chrome.js` | 自绘标题栏、左右栏宽度、终端收起、启动建格、群组看板 | 窗口 chrome、左栏、群组 |
| `50-ask.js` | AskUserQuestion：选择器、点选项作答、按题跳转 | 提问/权限 UI |
| `60-shell.js` | 壳层数据、导航、项目/agent/已关闭行、菜单、重命名、卡片 | 左栏列表与项目池 |
| `70-flow.js` | 会话卡片 HTML、右下对话流（live/历史）、跟随与折叠 | 对话流渲染 |
| `80-live.js` | 复接/分叉动作、shell 推送应用、右栏「需要你/改动/流水/子代理」、实时读数 | shell 推送落点 |
| `85-dash.js` | 总览（读数、热力图、Agent 名单） | 总览页的任何 UI |
| `gw/00-frame.js` | 网关壳：控制面自动接入、安装卡、版本/更新条、iframe 生命周期 | 网关的壳与安装/接入/更新流程 |
| `86-install.js` | 行内安装控制台（agent 与 magpie 共用同一流式通道） | 安装日志与收尾 |
| `87-gw-apply.js` | 网关/控制面推送的落点（`applyGw` / `applyMagpie` / `applyGwAgents` / `applyGwAgentsDrift`） | 新的推送消息应用 |
| `88-agent-cfg.js` | Agent 配置抽屉（总览名单点一行）：接入/断开/字段/预览/保留现状、漂移轮询、可搜索模型选择器 | Agent 接线的呈现与手势 |
| `99-boot.js` | 总览事件绑定 + 首帧证据 | 启动顺序、首屏 |

一条经验：**推送落点（apply\*）只做「把数据放进状态 + 决定重画哪几块」**，具体 HTML 留在对应域的
文件里。这样"什么时候重画"和"画成什么样"不会缠在一起。

## 图标规则（用户 2026-10-17 定）

- **终端面板 / 标签页的身份**用星芒（Claude Code 的官方标记），因为那里代表"agent 终端"这个形态。
- **目录、名单、列表、卡片**用各产品的官方图标，从 `assets/agent-icons/` 取。
- **品牌入口**（网关页的 magpie 标识）用 `magpie.svg`，官方形态。
- 图标一律用上游现成的 SVG/PNG，**不要手画**，不要用 emoji 顶替。
- 同一个图标名只对应一个文件；PNG 图标在 `isPngIcon()` 里登记，其余默认 `.svg`。

## 后端文件

| 文件 | 职责 |
|---|---|
| `main.go` | 进程入口、ctl 分发、PTY 启动与尺寸握手、窗口 |
| `panes.go` | 格子/会话记录、冷恢复、标题与状态 |
| `projects.go` | 项目池与归属 |
| `store.go` | 会话库扫描与持久化 |
| `transcript.go` | 转录文件跟踪与增量读取 |
| `magpie.go` | magpie 快照、状态、Agent 目录 |
| `magpie_web.go` | 控制面 sidecar（`magpie web`）的启停、探活、HTTP；更新后按端口认领 re-exec 的进程 |
| `magpie_update.go` | magpie 本体的版本/更新：转发它自己的 `GET /api/update`、check → install，进度推回前端 |
| `agent_cfg.go` | Agent 接线：读 `/api/state`、改字段、接入/断开/重新应用/保留现状、漂移轮询（`/api/drift`）、断开预览 |
| `gwui.go` | 网关页的内嵌界面：本地反代（127.0.0.1，token + cookie）→ magpie；只留网关导航（注入裁剪，见下） |
| `install.go` | 固定配方的安装器（agent / magpie），流式日志；magpie 走官方 feed + SHA-256 |
| `hooks.go` | hook 接收与 agent 状态 |
| `resume.go` | `--resume` 计划与证据 |
| `titles.go` | 左栏命名表 |
| `status.go` | agent 状态机 |
| `job_windows.go` / `process_windows.go` / `instance_windows.go` | Windows 进程与单实例 |
| `osc_color.go` / `pty_windows.go` | 终端颜色、ConPTY |

`main.go` 仍然偏大（约 84KB）。下一步可以按 `app / ctl / window / sessions` 再切，但**切之前先
确认调用关系**，别为了行数把一件事拆到两个文件里。

## 改完必须做的事

`assets/` 是 `go:embed` 进 exe 的。**任何 `assets/` 改动都要 `go build` 并且重启进程**，
否则测的是旧代码（最坏会把真护栏测成"没生效"）。

构建与验证脚本在 `_tools/`：`capture.ps1`（截图）、`z-drive.ps1`（按客户区坐标点击）、
`keys.ps1`（按键/文本）、`crop.ps1`（放大看像素）。

写操作的沙盒验收（**只测 codex，绝不碰 claude**）：
`_tools/magpie-sandbox-test.ps1` 用隔离的 `USERPROFILE/APPDATA` + 显式清空
`CLAUDE_CONFIG_DIR`/`CODEX_HOME` 起一个控制面，写之前先用只读 `/api/state`
证明看不到 claude，再跑 `agent_cfg_sandbox_test.go` 的整圈
（接入 → 改字段 → 重应用 → 预览 → 断开）。`install_magpie_sandbox_test.go`
在隔离的 `LOCALAPPDATA` 里验安装脚本（feed + SHA-256，不执行下载物）。

## 两条边界

- API key、账号密钥、提示词原文**不进日志、不回显、不落盘**；供应商表单只把 key 交给 magpie。
- 网关页**不手写** magpie 的页面：`gwui.go` 在 127.0.0.1 的固定端口段上反代
  它的页面与 `/api/*`，key 由 Go 逐请求注入。本地监听用一次性 token 换 cookie，
  本机其他进程拿不到 token 会得到 403。
- 内嵌页**只留网关的导航**（供应商 / 路由 / 网关 / 用量 / 插件）：`gwUIEmbed`
  在反代这一层把 `magpie.navLayout` 固定成顶部标签，并隐藏 Agents / Sessions /
  Library / Settings。那些页面与 Perch 自己的总览、Agent 重复（用户 2026-10-18）。
  不改 magpie 源码，也不写第二份前端。
- 安装器只在用户**明确点击**后运行；下载物当不可信数据处理，装进 Perch 自己的目录，不就地执行。
- Agent 配置（总览名单 → 右侧抽屉）**不另存一份**：读 magpie 的 `/api/state`，
  写走 `/api/set` 与 `/api/agents/{connect,disconnect,reapply}`；每个写动作都由
  用户点出来。断开前的 dry run（`/api/agents/preview`）只展示，且配置行进 DOM
  前把 `TOKEN/KEY/SECRET/PASSWORD` 的值打码。日志只记 agent 与字段名，不记值。
