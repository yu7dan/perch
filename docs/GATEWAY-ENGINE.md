# Gateway engine

Perch 的网关页是 Perch 自己的原生页面。页面背后跑着一个**无头网关引擎**，
它只监听回环、只有 API、没有可被用户打开的界面。Perch 通过
`internal/gateway` 的薄适配层管理它：

```text
Perch UI (87-gateway.js)
   │  ctl messages
   ▼
internal/gateway  ──HTTP──▶  engine control plane (127.0.0.1:<random>)
   │                              │
   │                              └── /v1/*  gateway (127.0.0.1:<stable>)
   └── process lifecycle
```

产品边界：**体验归 Perch，引擎归引擎**。Perch 不 import 引擎的源码，也不
复制它的页面；引擎可以替换，替换时只改适配层。

## 目录与进程

```text
%LOCALAPPDATA%\Perch\gateway\
  magpie.exe       随安装包分发的引擎（MIT，LICENSE.magpie 同目录）
  gateway.port     写进 agent 配置的稳定网关端口
  data\            引擎私有配置与缓存（XDG_CONFIG_HOME / XDG_CACHE_HOME）
```

控制面端口每次启动随机；网关端口从 `gateway.port` 复用（被占用时才换），
所以 agent 配置里的 `http://127.0.0.1:<port>` 跨重启稳定。

生命周期：

- Perch 启动时异步拉起引擎；起不来不阻塞窗口，网关页显示状态。
- 关窗 / `App.Quit` 时停止 Perch 自己拉起的引擎；它继承 Perch 的 Job Object，
  进程树随 Perch 退出。
- 网关页的「重启引擎」= 停掉当前进程再起一个；控制面 key 复用。
- 引擎缺失时页面给明确状态，不静默重试成"运行中"。

## 隔离

引擎环境固定，不读取用户的桌面网关/订阅登录：

```text
MAGPIE_ADDR=127.0.0.1:<stable gateway port>
MAGPIE_WEB_KEY=<random; only in Go>
XDG_CONFIG_HOME=<data dir>
XDG_CACHE_HOME=<data dir>\cache
MAGPIE_NO_ACCOUNTS=1
MAGPIE_PLUGIN_MARKET=off
MAGPIE_NO_STATS=1
MAGPIE_UPDATE_FEED=off
DO_NOT_TRACK=1
```

- 引擎自带自动更新：不关掉时，每次启动都会从上游下载一个新的 `magpie.exe.new`
  （2026-10-22 实测）。v1 固定随 Perch 分发的那个构建，Perch 不校验下载物，
  所以更新源明确关闭，并在拉起前删掉遗留的 `.new`，不执行任何下载来的二进制。

- 控制面只绑 `127.0.0.1`，key 只存在 Go 进程里；前端地址栏/DOM/日志都没有 key。
- 引擎的 Web UI 不加载、不反代、不暴露。Perch 只调用白名单里的 `/api/*`。
- 引擎 stdout/stderr 丢弃：它们可能带控制面链接和 key。

## Provider / key

`internal/gateway/providers.go` 是原生供应商接口：

- `GET /api/providers` 一次返回 `providers + presets`。`ProviderInfo` 归一化
  `keyConfigured` / `keyMasked` / `keyStatus`、模型 `on`、使用它的 agent 和
  `keyOptional`，**没有完整 key**；`ProviderPresetInfo` 是供应商模板
  （kind / icon / note / endpoints / regions / noKey / noList / models）。
- 目录只收 v1 能配的模板：`kind = vendor | relay | local`，排除 sponsored、
  Vertex、只有 decide 的模板和没有端点的项。排除要在 Go 侧做，前端不猜。
- 保存：`POST /api/provider/save`，分两条路：
  - 预设：`{id, name, preset, new, key, endpoints?}`。不发送 `baseAPI/chat`，
    端点交给引擎的 preset；非默认 region 或 Azure 类资源才带 `endpoints`。
    新建时 key 必填（`noKey` 的本机服务除外）；编辑时 key 留空 = 保留原 key。
  - 自定义：`{id, name, baseAPI, chat|responses|anthropic|gemini, key, models}`。
- 保存后按 id 读回，找不到再按 preset/name 匹配；返回归一化 `ProviderInfo`，
  不把 HTTP 2xx 当成功。
- 测试：`POST /api/provider/test`。引擎即使 key 错也会回 HTTP 200，错误在
  `results[].ok/status` 里 —— 不能把 2xx 当成功。
- 上游错误正文可能包含 key（例如 "Incorrect API key provided: sk-..."），
  所以**原始正文既不进 UI 也不进日志**；按状态码归一成稳定 code
  （`msg.gw.keyRejected` / `keyRateLimited` / ...），前端按当前语言渲染。
  保存/测试的 HTTP 失败只给 `gw.providerSaveFailed` / `gw.keyTestRequestFailed`。
- 删除：`POST /api/provider/delete`，只在用户确认后执行。

## Agent 接线

`internal/gateway/agents.go` 转发引擎的 `/api/state`、`/api/set`、
`/api/agents/{connect,disconnect,reapply,keep}/{id}`、`/api/agents/preview/{id}`、
`/api/drift`、`/api/agents/rescan`。

- 写操作只由用户在总览的 Agent 工作台/行内详情里点击触发；没有后台自动 connect。
- 配置写回以 `/api/state` 读回为准，不把 HTTP 2xx 当成功。
- 运行中的 agent 在行内详情里明确提示"重开才生效"。
- 预览里的配置行可能带 token/key；进 DOM 前打码。
- `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex`：Codex 的模型请求由它的
  app-server 发出；不固定 originator 时引擎会按终端程序把它记成 "perch"，
  用量页的「按 Agent」就看不到 Codex（2026-10-22 实测）。这只改客户端名字，
  不改路由/鉴权。

## 用量

`internal/gateway/usage.go` 读引擎**网关端口**的 `/v1/magpie/usage`，
归一化成 camelCase 的 `UsageView`（`cacheRead` / `ttftMs` / `agents` / `models`）。

- `Usage(period)` 只接受 `today | 7d | 30d | all`；非法周期给
  `gw.usageBadPeriod`，不把它拼进引擎查询。
- ctl 消息是 `{type:"gw.usage", period}`；**必须在 `server.go` 的网关
  消息白名单里**，否则处理器写了也收不到（2026-10-22 就是这个漏项让 7 天卡
  一直转圈）。
- 结果推 `{type:"gw.usage", period, usage}`；前端按周期缓存。
- `today` 还走 2.5s 的 MAGPIE 快照，保持实时；其余周期按需请求。

## 前端

`assets/js/86-dash.js` + `87-gateway.js` + `89-agent-cfg.js`：

- 总览：Agent 工作台（行内选模型 / 接入 / 打开 / 展开详情）、右栏网关用量卡、
  在等你、全宽 53 周热力图。Agent 的安装、接线、配置都在总览，不再有单独的
  Agents 页或右侧抽屉。
- 网关页只回答"模型从哪里来"：
  - 状态条：引擎状态、版本、网关地址、启动/重启。
  - 已添加供应商：一行一个，key pill、使用它的 agent 图标；点行开编辑器。
  - 供应商目录：始终陈列，按厂商直连/中转/本机分组；搜索框在稳定页壳里。
  - 编辑器：右侧 sheet，预设填 key（或 region/endpoint），自定义填协议+地址；
    保存后不关，模型 chips / 测试 / 删除都在这里。
- 供应商目录的 data/state 全部是归一化字段；前端不读引擎 HTML，不猜模板。
- 用量卡：今天 / 7 天 / 30 天 / 全部，按 Agent / 按模型；切非 today 周期
  每次都重取，避免新请求后停在旧数字。

密钥单向：表单 → ctl → Go → 引擎。页面之后只显示 `configured/masked/status`。

## 打包与许可

- 仓库**不提交** `magpie.exe`；分发时放进 Perch 安装包。
- `LICENSE.magpie`（MIT）与引擎同目录；README / THIRD-PARTY 保留归属。
- 版本固定、升级时替换二进制；引擎数据目录和 `gateway.port` 保留。

## 验收

- `go build ./...`、`go vet ./...`、`go test ./...`、`node --check` 所有改动的
  classic JS、`node scripts/i18n-check.mjs`。
- 空数据目录启动：引擎自动起来，供应商目录可见，总览 Agent 行能看到可选模型。
- 保存预设/自定义 provider → 列表显示掩码，不显示 key；错误 key 测试给分类提示。
- 点供应商目录的 tile → 预填编辑器；保存后不关，模型 chips 可点、测试可点。
- 总览 Agent 行选模型 → 接入 → 打开 → 发一句 → 本地 OpenAI 兼容 stub 收到并回包；
  用量卡 today 出现请求，7d/30d/all 切换无报错。
- 重启 Perch：网关端口、provider、接入状态、用量周期保持。
- 关窗：引擎进程随之退出，没有遗留。
- DOM/日志/URL 搜索不到 key；引擎 Web UI 不可从 Perch 前端访问。
