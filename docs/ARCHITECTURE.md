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
│   ├── dsh/                  DeepSeek Harness 的 dsh-tui profile / 官方 hook 桥接入
│   ├── files/                只读 fs.list / fs.read 与路径护栏
│   ├── history/              Claude 会话索引、每日活动（轮次/回复/token/按模型）、历史尾部
│   ├── install/              安装器引擎（配方数据来自 agentcatalog）
│   ├── panes/                PaneStore 持久化（独立、无 session 依赖）
│   ├── project/              项目池、默认工作区、归属与 wire
│   ├── providers/            模型提供商 + 每个 agent 的配置：providers.json、DPAPI、按格注入、测试连接
│   ├── session/              tabs / titles / resume / hooks / registry / spawn
│   ├── settings/             Perch 偏好 store（纯）
│   ├── stream/               PTY 原始流、首帧尺寸握手、调试探针
│   ├── term/                 ConPTY + OSC 颜色应答（明暗跟主题：SetLight / Colors / ColorFGBG）
│   ├── transcript/           Claude 转录跟随/流水/改动（Live 注入）
│   ├── uimsg/                用户可见消息的稳定 code + params + 原文（见 I18N.md）
│   ├── winproc/              Job Object、进程存活、单实例、打开路径、Exe 发现/Shim
│   └── workspacebrief/       项目共享 brief：.perch/workspace.md + AGENTS.md 标记段
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
cmd/perch ──> ctl, stream, session, project, settings, providers,
              install, agentcatalog, agent, dsh, winproc, term,
              panes, transcript, appdir
ctl        ──> session, project, settings, providers, install, files,
                history, agentcatalog, panes, term, transcript,
                workspacebrief, uimsg
stream     ──> 无领域依赖：只认 Conn / Terminal 接口与回调
session    ──> agent, panes, term, workspacebrief
transcript ──> 无领域依赖：Live func() []View 与 Push 注入
providers  ──> 标准库（+ x/sys/windows 做 DPAPI）
install    ──> agentcatalog, uimsg
project    ──> history, appdir, uimsg
settings   ──> agentcatalog（只用静态 Has / LaunchIDs，不调 Defs()）, appdir, uimsg
agentcatalog ──> agent, dsh, winproc
agent      ──> term, transcript, winproc
dsh        ──> winproc
files      ──> uimsg
叶子：panes, history, term, uimsg, winproc, appdir, providers, workspacebrief
```

禁止的边（`go list -deps` 可查）：`session` 不 import `project/history/stream/ctl/providers`
（提供商注入走组合根给的 `SetWireProfile` 闭包）；`stream` 不 import `session/term/ctl`；
`agentcatalog` 不 import `install`；`settings` 不 import `project`；`providers` 不 import
任何 `internal/*`。

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
- `internal/ctl/handlers_*.go`：37 个消息类型按域分组——tabs / files / install / settings /
  providers / workspacebrief / projects / window / misc。新增消息放进对应域，不要回填成一个
  大 switch。
- `internal/ctl/handlers_providers.go`：`providers.get` / `provider.save` / `provider.delete` /
  `provider.test` / `agent.config.set`；推回 `providers`（不含密钥的视图 + 各 agent 能吃的协议 +
  强度档位）、`provider.result`（每次改动的回执）、`provider.test`（测试连接结果，成功时把
  模型列表记进 store）。新填 key 的 `provider.save` 会顺手测一次。
- `internal/ctl/payload.go`：`ShellPayload` 的组合（history + 每日活动 + project + settings +
  `catalog` + titles），以及 `poolReply` / `bootAgentCards` / `settingsWire` 这些只在协议层
  成立的拼装。`history` 只负责扫描，聚合在 ctl。Agent 名单（`agentcatalog.Cards`）有自己的
  路：shell 载荷的 `catalog`、安装/接入完成后的 `catalog` 推送、冷恢复应答里的 `agents`。
- `term.theme`（misc 域）：前端把解析好的有效明暗（dark / light）告诉 Go，`term.SetLight`
  只影响之后的 OSC 10/11 应答和新起进程的 `COLORFGBG`。
- `internal/ctl/closeguard.go`：关窗确认的原子状态，`WindowClosing` hook 与 `window.close`
  消息共享；30 秒未确认自动取消。

`settings.set` 的编排也在 ctl：`settings.Patch` → 推设置 → 若 `DefaultCWD` 变了，
再 `project.EnsureDefaultWorkspace()` + pool reply。`settings` 包本身保持纯。

## 一次启动/请求经过哪里

1. `cmd/perch/main.go` 按固定顺序构造 stateDir、titles、settings、providers store、
   project pool、单实例锁、panes、Job Object、session.Manager。
2. `agent.SetHost(mgr)` 之后才构造 `agentcatalog.Defs(stateDir)` 并交给 manager ——
   `Def` 会解析可执行文件，顺序不能倒。随后 `mgr.SetWireProfile(agentWireProfile)`：
   开格前组合根用 `providers.Resolve` + `providers.Build` 算出这一格的 env 与参数；
   没配 = 按 agent 自己的登录/配置启动；配了但接不上（协议不对、缺模型、key 解不开）=
   `StageProfile` 报错、这一格不启动（fail-closed，不静默回退到 agent 自己的登录）。
3. install / transcript / files / Wails app / ctl.Server 依次构造；
   `ctl` 的 `CreateTab` 闭包负责**先** `app.HandleStream`、再返回 tab。
4. 前端连上后发 `shell` 请求，ctl 返回 `ShellPayload`；之后状态变化走 `Push`。
5. 建格：`tab.new` → `session.Create` → Wails 流 → `stream.Serve` 首帧尺寸握手 →
   `session.StartTab` 起 ConPTY；读循环只有一条，`Send` 前复制字节。
6. 状态三条腿：转录（磁盘 JSONL）、hook（`perch-hook.exe` 落盘）、屏幕（终端缓冲）。
   三者互相印证，不单独下结论。hook 有两个生产者：Claude 的 `--settings` 每格一份；
   DSH 的官方桥是全局一份，接收器按环境变量 `PERCH_AGENT_PANE` 分流到同一个
   `hook-events/t<N>.jsonl`（变量名不含 KEY/TOKEN，避免被 DSH 的 shell 剥掉）。

启动顺序里每一条都是实测/源码约束（titles 先于 settings、settings 先于 project、锁先于
panes、Job Object 早于 Wails/PTY、`SetWireProfile` 晚于 `SetDefs`、`WindowClosing` 同步
flush 登记表、`OnShutdown` 只写内存记录、WebView2 检查早于 `app.Run`），调整时逐条核对。

## 边界与数据

- **Perch 的设置只放自己的偏好**（默认目录、终端外观、主题 `system|dark|light`、确认、
  启动落点、界面语言），落 `%APPDATA%\Perch\settings.json`。Go 是默认目录与设置的唯一事实；
  前端 `localStorage` 只做首帧缓存。
- **模型提供商与每个 agent 的配置**单独落 `%APPDATA%\Perch\providers.json`
  （`internal/providers/store.go`）：提供商 = 名称 + Anthropic / OpenAI 兼容接口地址 + key；
  每个 agent = 选哪个提供商、默认模型、推理强度、原始环境变量。key 与环境变量的值用 DPAPI
  （当前用户范围）加密落盘，非 Windows 只有标明 `plain:` 的 base64（测试 / macOS 移植用）；
  推给前端的视图只有末四位，表单只写不读。
- **注入只落在 Perch 起的这一格**（`internal/providers/inject.go`），不写 `~/.claude`、
  `~/.codex`、`~/.pi`、OpenCode 的全局配置：
  - Claude：env 并进这一格的 `--settings`（它压得住用户 settings.json 的 env），同时把
    旧的模型别名 / `ANTHROPIC_API_KEY` 置空。这是唯一把 key 明文写进文件的一条：
    `%TEMP%\perch-claude-settings\<格>.json`，0600、每格一份；
  - Codex：`-c model_provider="perch"` + `model_providers.perch.*`（`wire_api="responses"`、
    `env_key="PERCH_PROVIDER_KEY"`），参数与 key 同时交给这一格的 app-server；
  - Pi：复制 `~/.pi/agent` 到临时目录，用 `PI_CODING_AGENT_DIR` 指过去，models.json 里的 key
    写成 `"$PERCH_PROVIDER_KEY"`；
  - OpenCode：一份很小的覆盖文件经 `OPENCODE_CONFIG` 与用户配置合并，key 写成
    `"{env:PERCH_PROVIDER_KEY}"`。
  其余 agent 只能写原始环境变量。
- 测试连接（`internal/providers/probe.go`）问 OpenAI 兼容的 `/models`，没有就问 Anthropic 的
  `/v1/models`；先直连，网络层失败再按系统代理重试一次。拿到的模型 id 是 Agents 一栏的候选。
- **使用层只收 CLI agent**。没有安装配方不等于桌面应用；Perch 不安装、不启动、不停止桌面客户端。
- API key、账号密钥、提示词原文不进日志、不回显；key 只在 `provider.save` 这一条消息里过一次
  内存。日志只记 agent、提供商名与环境变量名，不记值。
- 安装器只在用户明确点击后运行，跑的是 `agentcatalog` 配方里写死的官方安装命令或 npm 包
  （系统代理以 `HTTP(S)_PROXY` 传给整棵安装进程树）。安装完成顺序：先推新的 `catalog`，
  再推 `install.done`。
- **2026-10-28 移除了内嵌的 magpie 网关**（`internal/gateway`、`internal/agentprofile` 及其
  前端页）。旧版本留下的 `%LOCALAPPDATA%\Perch\magpie`、`%LOCALAPPDATA%\Perch\gateway\home`，
  以及 `%APPDATA%\Perch` 下的 `magpie-web.key`、`engine-agents.json`、`agent-profiles.json`
  不再被读写，可以手动删除；Perch 不自动迁移它们。

## 验证

```powershell
gofmt -l .
go build ./...
go test ./...
go vet ./...
go list -deps ./cmd/perch > $null
go list -f '{{.ImportPath}} {{join .Imports " "}}' ./... |
  Select-String 'wailsapp|internal/(session|stream|agentcatalog|settings|install|providers)'
```

- `cmd/perch` 是唯一 import `github.com/wailsapp/wails/v3/pkg/application` 的包。
- 根 `package perch` 只含 `embed.go`；`package main` 只出现在 `cmd/*` 与 `tools/*`。
- 真机集成测试默认跳过（`PERCH_CODEX_LIVE=1` 才跑）；其余测试一律落在 `t.TempDir()`
  （`providers` 的 store / Pi 复制目录、`CODEX_HOME` 指空目录），不碰真实 agent 配置。
