# 原生凭据 + 可选网关：数据模型与归属规则

> ⚠️ 2026-10-22 最终形态：Perch 随产品分发一个**无头网关引擎**，网关页由 Perch
> 原生实现，引擎的 Web UI 不加载、不反代。实现边界见
> [GATEWAY-ENGINE.md](GATEWAY-ENGINE.md)。本文的 P0 范围与能力矩阵已不适用；
> Provider / Credential / RoutePlan / AgentRoute 这几个数据模型仍保留作参考。

## 0. 目标与非目标

**目标**

- 用户不安装、不打开任何外部应用，也能在 Perch 里配置 provider / API key / 模型，直接使用 agent。
- 网关引擎随产品分发：统一 provider、模型、路由、用量；没有单独的引擎安装/打开步骤。
- 底层不绑死某一个引擎；以后替换引擎时，只改适配层，不改产品模型。
- 每个 agent 在任意时刻只有一个配置所有者（原生 / agent 自己 / 网关），切换可预览、可还原。

**P0 非目标**

- 不做 OAuth / 订阅账号切换（Claude、Codex、Gemini 的登录账号）——P1。
- 不做需要改配置文件的 agent（OpenCode、dsh、Pi、agy）——P1。
- 不做跨协议翻译（例如用 DeepSeek 跑 Claude Code）——那是网关的价值，不是原生层。
- 不做多网关并存 / 自动 failover。

## 1. 四个对象

### 1.1 Provider（原生上游）

用户自己添加的一条上游连接。**只存公开信息，不存密钥。**

```go
type Provider struct {
    ID          string        // 稳定 slug，例如 "anthropic-work"、"deepseek"
    Kind        string        // 协议：anthropic | openai | gemini （P0）
    Name        string        // 显示名
    BaseURL     string        // 空 = 该 kind 的官方地址；自定义地址必须 http(s)
    Models      []ModelOption // id / label / context / maxOutput / capabilities
    ModelSource string        // static | fetched | manual
    CreatedAt   time.Time
    UpdatedAt   time.Time
}

type ModelOption struct {
    ID       string // 传给 agent 的模型 id，例如 "claude-sonnet-4-5"
    Label    string
    Context  int
    MaxOut   int
    ToolCall bool
}
```

- `Kind` 决定**线协议**，不是厂商标识。OpenAI 兼容的上游统一是 `openai`。
- 同一 `Kind` 可以有多条 Provider（公司 key / 个人 key）。
- 模型列表可以先静态内置常用项，再支持“从上游拉取”（OpenAI `/models`、Gemini
  `models.list`、Anthropic 无公开 list 则静态）。

### 1.2 Credential（凭据）

一条 Provider 下可有多枚凭据。**密钥本体永远不进 JSON、不进前端、不进日志。**

```go
type Credential struct {
    ID         string // "cred_..."
    ProviderID string
    Kind       string // api_key（P0）；oauth/cookie/account 预留
    Label      string // 用户备注，例如 "工作 key"
    SecretRef  string // DPAPI blob 的文件名/句柄；不是密钥本身
    Last4      string // 只用于 UI 识别
    Status     string // untested | ok | invalid | expired
    LastError  string // 分类后的错误，不含响应正文/密钥
    CreatedAt  time.Time
    UpdatedAt  time.Time
    LastUsedAt *time.Time
}
```

前端只拿公开投影：

```ts
type CredentialPublic = {
  id: string; providerId: string; kind: string; label: string;
  last4: string; status: string; lastError?: string;
  hasSecret: true; createdAt: string; updatedAt: string;
}
```

**安全规则**

- Windows 用 DPAPI（`CryptProtectData`，当前用户作用域）加密后落盘：
  `%APPDATA%\Perch\secrets\<credId>.bin`；`credentials.json` 只存 `SecretRef`。
- 渲染层只看到 `hasSecret / last4 / status`；保存、替换、清除都走 Go IPC，
  已保存的密钥永远不会再回传 DOM（参考 Orca 的 OpenCode Go 凭据组件）。
- 日志只记 provider/credential id 与错误分类；测试连接失败也不打印 key 或响应正文。
- 备份/还原文件若包含用户原配置里的密钥，备份目录同样用 DPAPI 保护。

### 1.3 RoutePlan（一次路由的计算结果）

`RoutePlan` 是**运行期计算出来的、不持久化**的方案：给定 agent + 来源 + provider +
凭据 + 模型，算出要注入什么。

```go
type RoutePlan struct {
    AgentID     string
    Source      AgentRouteSource // native（P0）| gateway（转发给网关实现）
    ProviderID  string
    CredentialID string
    Model       string

    Env         map[string]string // 实际值只在内存；含密钥，绝不序列化
    Args        []string
    Config      []ConfigPatch     // P1：需要改文件的 agent

    RequiresRestart bool
    Supported       bool
    Reason          string // 不支持时给用户看的原因，例如“Claude Code 只认 Anthropic 协议”
    Evidence        map[string]string // 兼容性/版本证据
}

type ConfigPatch struct {
    Path      string // 目标文件
    KeyPath   string // 例如 "model.name"、"providers.magpie.apiKey"
    Value     string // Secret=true 时从 Credential 解析，写盘前不落 JSON
    Secret    bool
}
```

- **P0 的 RoutePlan 只有 Env + Args，不写任何文件。** 原生路线的“应用”就是下一次
  启动时注入 env/args；切回 agent 自己的配置就是不再注入。可逆、无备份负担。
- 只有 P1 的 agent 才需要 `ConfigPatch` + 备份 + drift 检测。
- `Supported=false` 时抽屉显示原因，不提供假按钮。

### 1.4 AgentRouteSource / AgentRoute（谁拥有这个 agent 的配置）

```go
type AgentRouteSource string

const (
    RouteAgentOwn AgentRouteSource = "agent_own" // agent 自己的登录/配置，Perch 只读
    RouteNative   AgentRouteSource = "native"    // Perch 原生凭据（P0：env+args）
    RouteGateway  AgentRouteSource = "gateway"   // 某个网关拥有（当前 magpie）
)

type AgentRoute struct {
    AgentID string
    Source  AgentRouteSource

    Native  *NativeRouteRef  // ProviderID / CredentialID / Model
    Gateway *GatewayRouteRef // GatewayID / 网关侧的 agent 标识

    Applied  *AppliedConfig  // 原生/P1 改了哪些字段、hash、备份引用
    Drift    *DriftInfo      // 配置被别人改过
    UpdatedAt time.Time
    VerifiedAt *time.Time
}
```

- 每个 agent **恰好一个** `AgentRoute`；它是 Perch 的“谁拥有”事实来源。
- `agent_own` 是**枢轴状态**：原生和网关的切换都必须先回到它，避免两边同时写。
- `Applied` 只存字段名、hash、备份引用，不存密钥值。

## 2. 归属与切换规则

```text
            apply native                  gateway connect
agent_own ───────────────► native ───────────────────────► gateway
    ▲                        │  ▲                              │
    │     restore            │  │  native apply                │ gateway disconnect
    └────────────────────────┘  └──────────────────────────────┘
```

**唯一所有者**

- `native` 与 `gateway` 不能同时为真。切换前必须让当前所有者退出。
- 切换统一走 `agent_own` 枢轴：
  1. `native → gateway`：先 restore native（P0 = 下一次启动不再注入；P1 = 还原文件），
     再让网关 connect。网关快照到的是 agent 自己的配置，不会把原生 key 写进网关。
  2. `gateway → native`：先让网关 disconnect（用它的 preview/restore），回到
     `agent_own`，再 apply native。
  3. `native A → native B`：直接替换路由引用；P0 无文件写入，下一次启动生效。
- **切换是一次事务**：preview → snapshot（P1）→ apply → read-back/verify → 记录。
  任一步失败就保持原状态并报错，不留下半套配置。
- 每个 agent 一把锁（Go 侧 mutex + 前端 busy）：同一时间只允许一个切换。
- 如果 agent 正在运行：
  - 首启/空闲/已停止 → 自动重开（沿用现有 `agentReopenDecision` 表）。
  - working / ask → 不杀进程，标 `stale`，给“重开并续接”的可见动作。
  - 原生 env 路由的“生效”本来就是下一次开格；在跑的进程不会被热改。
- **drift**：`Applied` 记下字段 hash；发现文件被外部改写时标 `drift`，提供
  reapply / keep / restore，不静默覆盖。

## 3. 存储布局

```text
%APPDATA%\Perch\
  providers.json          # Provider[]（公开）
  credentials.json        # Credential[]（公开元数据 + SecretRef）
  agent-routes.json       # AgentID -> AgentRoute
  secrets\<credId>.bin    # DPAPI 加密的密钥
  backups\native\<agent>\<ts>\...  # P1，受 DPAPI 保护
  magpie-web.key          # 现有
  panes.json              # 现有
```

- JSON 原子写（临时文件 + rename），带 `version`；未来版本只读；损坏文件重命名
  `.bad-<ts>` 后重建。
- `secrets` 目录 ACL 只给当前用户；DPAPI 作用域为当前用户。
- 原生密钥**绝不**写入 `settings.json`、`localStorage` 或会话记录。

## 4. Go 接口与前端协议

### 4.1 Go 侧

```go
type ProviderStore interface { List/Save/Remove }
type CredentialStore interface { List/Save/Clear/Test } // Test 调 provider adapter
type RouteStore interface { Get/Set/Preview/Restore }
type NativeApplier interface {
    Plan(agentID string, target NativeTarget) (RoutePlan, error)
    Verify(plan RoutePlan) error
}
type Gateway interface { // magpie 是第一个实现
    ID() string
    Ensure(ctx context.Context) error
    Agents(ctx context.Context) ([]GatewayAgent, error)
    Set(ctx context.Context, agentID, field, value string) error
    Action(ctx context.Context, op, agentID string) error
    LaunchEnv(ctx context.Context, agentID string) (env map[string]string, args []string, ok bool)
    EmbedPage() (http.Handler, error)
}
```

- agent 的 `Def` 增加原生能力：`NativeKinds()` 与 `BuildNativePlan(target)`；
  不支持就返回 `Supported=false + Reason`。
- `ctl` 只依赖接口，不依赖具体 magpie 结构体。

### 4.2 ctl 消息

```text
native.providers.list / save / remove
native.credential.list / save / clear / test
native.route.get / preview / set / restore
native.routes.snapshot        # 推送：每个 agent 的 source + 可用来源
```

### 4.3 前端视图

保留现有 `agentRouteView` 的 `route` 字段（兼容），新增：

```ts
type AgentRouteView = {
  route: 'native-managed' | 'agent-own' | 'gateway' | 'unconfigured' | ...
  sources: Array<{
    kind: 'native' | 'gateway'
    label: string
    model?: string
    active: boolean
    supported: boolean
    reason?: string
  }>
  primaryAction: { action, label, disabled, reason }
}
```

抽屉里的形态：

- 顶部只有一条 `当前来源`：`本机凭据 · anthropic-work / sonnet`、`网关 · magpie /
  deepseek/flash`、或 `agent 自己的配置`。
- 分区：`本机`（provider + 模型 + 切换）、`网关`（magpie 字段 + 模型 + 切换）。
- 从另一来源选模型 = 一次路由切换（preview 弹层），不是“选完直接写”。
- 原生不支持某协议时，显示原因（“Claude Code 只认 Anthropic；要走其它模型请用网关”）。

## 5. 能力矩阵（P0 / P1）

| agent | 原生 kind | 应用方式 | 阶段 | 备注 |
|---|---|---|---|---|
| Claude Code | anthropic | env + args | P0 | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`；模型用 `--model`；需实测与订阅登录的优先级 |
| Gemini CLI | gemini | env + args | P0 | `GEMINI_API_KEY`；官方地址不需要 base URL；模型用 `--model`；需实测 |
| Codex | openai | env + args | P0/P1 | `OPENAI_API_KEY` + `--model`；若 API key 需要 config 里指定 auth 方式，则降为 P1 |
| OpenCode | openai-compatible | config | P1 | provider 块写入 `opencode.json` |
| dsh | openai-compatible / deepseek | config | P1 | profile patch + `.env` |
| Pi | openai-compatible | config | P1 | `models.json` |
| agy | gemini | env + settings | P1 | 与 Gemini 类似，另有 launch 参数 |
| Cursor | 原生登录 / `CURSOR_API_KEY` | env | P1 | 普通 CLI 不能被 magpie 路由 |

> 原生层只做 agent **自己支持**的协议。跨协议翻译是网关的职责，不伪装成原生。

## 6. P0 范围与验收

**范围**

- Provider：Anthropic、Google Gemini、OpenAI（三种 kind）。
- Agent：Claude Code、Gemini CLI、Codex（若 env 方式实测成立）。
- 功能：设置页添加 provider / 凭据、测试连接、选模型；抽屉显示来源并切换；
  原生路由 = 启动时注入 env/args；切回 agent-own = 不再注入。
- 不改 magpie 任何现有流程；magpie 仍可作为另一个来源。

**验收**

1. 机器上没有 magpie（或 magpie 完全不运行）：添加 Anthropic key → 打开 Claude Code →
   真实回答；切回 agent-own → 下一次打开不再注入。
2. 同上，Gemini CLI + Google key；Codex + OpenAI key（若 P0 成立）。
3. 渲染层任何时刻都拿不到完整 key；日志/截图无 key。
4. 正在干活的格子切来源 → defer + 可见 stale，不杀进程。
5. 与 magpie 同时存在时：每个 agent 只有一个来源；从网关切原生会先 disconnect，
   反之先 restore；两边不打架。

## 7. 待确认 / 待实测

- Claude Code / Codex 在已有订阅登录时，env API key 的优先级与切换语义。
- Codex 的 API key 是否必须写 `config.toml`；若是，P0 是否接受一次受控写入。
- 模型列表：静态内置 vs 启动时拉取；Anthropic 无公开 list。
- 原生 provider 的 base URL 校验（只允许 http/https、禁止非本机明文？SSRF 边界）。
- provider 级凭据 vs agent 级覆盖：P0 先按 provider 级；以后是否允许“这个 agent 用另一枚 key”。
- 多网关：等第二个网关出现时再实现 `Gateway` 接口；现在只留缝。

## 8. Orca 参考（只借 IA/安全模式，不直接搬代码）

- `src/renderer/src/components/settings/AccountsPane.tsx`：按 provider 分 section。
- `src/renderer/src/components/settings/accounts-pane-opencode-credentials.tsx`：
  key 只提交不回显；状态只显示 saved / not saved；Save / Replace / Clear。
- `src/renderer/src/components/settings/provider-account-scope.ts`：
  host scope（本机 / WSL / 远程）与“凭据由谁拥有”的说明。
- Orca 是 TypeScript/Electron；Perch 是 Go/Wails。借的是交互与安全边界，
  agent 配置格式仍以上游 vendor 和 magpie 的 Go 实现为准。
