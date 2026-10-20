# Perch 架构

这份文档回答三个问题：**代码分在哪几层**、**依赖只能朝哪个方向走**、**一次前端请求/一条推送
经过哪些包**。改结构之前先看这里；前端脚本与 CSS 的规则见 [FRONTEND.md](FRONTEND.md)，
界面语言与 `uimsg` 的约定见 [I18N.md](I18N.md)。

## 顶层布局

```
perch/
├── embed.go                  package perch；只有 //go:embed assets
├── assets/                   前端（见 FRONTEND.md）
├── cmd/
│   ├── perch/                组合根 + Wails 适配（main.go / wails.go）
│   └── perch-hook/           hook 接收器（单独构建）
├── internal/
│   ├── agent/                agent 适配器运行时（Def / Host / Codex / Pi / OpenCode）
│   ├── agentcatalog/         身份、元数据、安装配方、LaunchIDs、Defs()、Cards()
│   ├── appdir/               Perch 配置目录、Claude 状态根、Documents\Perch
│   ├── ctl/                  ctl 协议、按域拆分的 handlers、ShellPayload、关窗守卫
│   ├── files/                只读 fs.list / fs.read 与路径护栏
│   ├── gateway/              magpie 快照/客户端/更新/内嵌页反代/Agent 接线
│   ├── history/              Claude 会话索引、活动、历史尾部
│   ├── install/              安装器引擎（配方数据来自 agentcatalog）
│   ├── panes/                PaneStore 持久化（独立、无 session 依赖）
│   ├── project/              项目池、默认工作区、归属与 wire
│   ├── session/              tabs / titles / resume / hooks / registry / spawn
│   ├── settings/             Perch 偏好 store（纯）
│   ├── stream/               PTY 原始流、首帧尺寸握手、调试探针
│   ├── term/                 ConPTY + OSC 颜色应答
│   ├── transcript/           Claude 转录跟随/流水/改动（Live 注入）
│   ├── uimsg/                用户可见消息的稳定 code + params + 原文（见 I18N.md）
│   └── winproc/              Job Object、进程存活、单实例、打开路径、Exe 发现/Shim
├── tools/                    hookprobe / jobtest
├── docs/                     本文档与 FRONTEND.md、I18N.md、README 截图
├── licenses/                 第三方许可全文
└── scripts/                  build.ps1（两个 exe）；i18n-check.mjs（CI 守卫）
```

根目录不是程序入口：`cmd/perch` 才是。根上的 `embed.go` 保留 `package perch`，只是为了
让 `//go:embed assets` 的相对路径仍落在模块根，并让 `cmd/perch` 通过 import 拿到 `Assets`。

## 依赖方向

依赖是单向的，箭头表示 "import"：

```
cmd/perch ──> ctl, stream, gateway, session, project, settings,
              install, history, agentcatalog, agent, winproc, term,
              panes, transcript, appdir
ctl        ──> session, project, settings, gateway, install, files,
                history, agentcatalog, uimsg
stream     ──> 无领域依赖：只认 Conn / Terminal 接口与回调
session    ──> agent, panes, term, winproc, appdir
transcript ──> 无领域依赖：Live func() []View 与 Push 注入
gateway    ──> agentcatalog, appdir, uimsg
install    ──> agentcatalog, winproc, appdir, uimsg
project    ──> settings, history, appdir, uimsg
settings   ──> agentcatalog（只用静态 Has / LaunchIDs，不调 Defs()）, uimsg
agentcatalog ──> agent, winproc, appdir
agent      ──> winproc
uimsg      ──> 标准库
叶子：panes, history, files, term, uimsg, winproc, appdir
```

禁止的边（`go list -deps` 可查）：`session` 不 import `project/history/stream/ctl`；
`stream` 不 import `session/term/ctl`；`agentcatalog` 不 import `install`；
`settings` 不 import `project`；`install` 不 import `gateway`。

### 两条可检查的不变量

1. **只有 `cmd/perch` import Wails**（`application` / `events`）。`ctl` 与 `stream` 通过
   少量方法的 `Conn` / `UI` 接口拿能力，Wails 实现留在 `cmd/perch/wails.go`。
2. **没有可变包级单例**。所有 store/service 都是构造出来的结构体，依赖从组合根注入。
   `agent.SetHost` 是唯一保留的组合期注入点（`internal/agent/host.go`），测试不调用时
   使用无操作的 `defaultHost`。

## ctl：控制协议

- `internal/ctl/protocol.go`：`Msg` 的字段与 JSON tag 就是前后端契约；改字段等于改协议。
- `internal/ctl/server.go`：连接循环、每条连接自己的 `tabReqCache`（`tab.new` 去重/重放）、
  推送连接、`CloseGuard`。流在 Wails 的 `HandleStream` 里创建，必须早于前端连接和 `tab.ok`。
- `internal/ctl/handlers_*.go`：42 个消息类型按域分组——tabs / files / gateway / install /
  settings / projects / window / misc。新增消息放进对应域，不要回填成一个大 switch。
- `internal/ctl/payload.go`：`ShellPayload` 的组合（history + project + settings + gateway
  snapshot + titles），以及 `poolReply` / `bootAgentCards` / `settingsWire` 这些只在协议层
  成立的拼装。`history` 只负责扫描，聚合在 ctl。
- `internal/ctl/closeguard.go`：关窗确认的原子状态，`WindowClosing` hook 与 `window.close`
  消息共享；30 秒未确认自动取消。

`settings.set` 的编排也在 ctl：`settings.Patch` → 推设置 → 若 `DefaultCWD` 变了，
再 `project.EnsureDefaultWorkspace()` + pool reply。`settings` 包本身保持纯。

## 一次启动/请求经过哪里

1. `cmd/perch/main.go` 按固定顺序构造 stateDir、titles、settings、project pool、单实例锁、
   panes、Job Object、session.Manager。
2. `agent.SetHost(mgr)` 之后才构造 `agentcatalog.Defs(stateDir)` 并交给 manager ——
   `Def` 会解析可执行文件，顺序不能倒。
3. gateway / install / transcript / files / Wails app / ctl.Server 依次构造；
   `ctl` 的 `CreateTab` 闭包负责**先** `app.HandleStream`、再返回 tab。
   gateway 建好后组合根调用 `mgr.SetWireLaunch(gw.Launch)`：magpie 的
   `/api/state` 对 agy 这类 agent 给一条 `launch` 命令，gateway 只解析其中
   固定形状的 `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `--model`，
   开格时由 `agent.AgyDef` 取用；`agent` 不认识 gateway，方向不变。
4. 前端连上后发 `shell` 请求，ctl 返回 `ShellPayload`；之后状态变化走 `Push`。
5. 建格：`tab.new` → `session.Create` → Wails 流 → `stream.Serve` 首帧尺寸握手 →
   `session.StartTab` 起 ConPTY；读循环只有一条，`Send` 前复制字节。
6. 状态三条腿：转录（磁盘 JSONL）、hook（`perch-hook.exe` 落盘）、屏幕（终端缓冲）。
   三者互相印证，不单独下结论。

启动顺序里每一条都是实测/源码约束（titles 先于 settings、settings 先于 project、锁先于
panes、Job Object 早于 Wails/PTY、watcher 先同步扫一次再 Probe、`WindowClosing` 先 flush
再停网关、`OnShutdown` 反过来、`StartUI` 早于 `app.Run`），调整时逐条核对。

## 边界与数据

- **Perch 的设置只放自己的偏好**（默认目录、终端外观、确认、启动落点），落
  `%APPDATA%\Perch\settings.json`。agent 的模型/网关/权限留在 magpie 的 `/api/state`，不互抄。
  Go 是默认目录与设置的唯一事实；前端 `localStorage` 只做首帧缓存。
- **使用层只收 CLI agent**。没有安装配方不等于桌面应用；桌面客户端由 magpie 管理，
  Perch 只透传/只读，不安装、不启动、不停止桌面 magpie。
- API key、账号密钥、提示词原文不进日志、不回显、不落盘；供应商表单只把 key 交给 magpie。
  断开预览进 DOM 前把 `TOKEN/KEY/SECRET/PASSWORD` 打码，日志只记 agent 与字段名。
- 网关页不手写 magpie 页面：`gateway/ui.go` 在 127.0.0.1 固定端口段反代，key 逐请求注入；
  本地监听用一次性 token 换 cookie，其他进程拿不到 token 会得到 403。
  内嵌页只保留网关导航（供应商/路由/网关/用量/插件），Agents / Sessions / Library /
  Settings 在反代层裁掉 —— 它们与 Perch 的总览、Agent 重复。
- 安装器只在用户明确点击后运行；下载物当不可信数据处理，装进 Perch 自己的目录，
  不就地执行。安装完成顺序：先 `install.done`，再 `OnInstalled("magpie")` 触发网关接入。

## 验证

```powershell
gofmt -l .
go build ./...
go test ./...
go vet ./...
go list -deps ./cmd/perch > $null
go list -f '{{.ImportPath}} {{join .Imports " "}}' ./... |
  Select-String 'wailsapp|internal/(session|stream|agentcatalog|settings|install)'
```

- `cmd/perch` 是唯一 import `github.com/wailsapp/wails/v3/pkg/application` 的包。
- 根 `package perch` 只含 `embed.go`；`package main` 只出现在 `cmd/*` 与 `tools/*`。
- 真机集成测试默认跳过（`PERCH_CODEX_LIVE=1` 才跑）；写操作沙盒只测 codex/pi，
  显式清空 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，不碰真实 agent 配置。
