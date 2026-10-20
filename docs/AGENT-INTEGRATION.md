# Agent 接入：七步链路与「完整 / 可用」

这份文档回答一个用户会问的问题：**我把一个 agent 装上了、也点开过了，为什么总览还
说我“没接完”？下一步到底是什么？**

答案不是一个“完整状态”的开关，而是七步里的每一步各自有记录、有证据。总览和配置
抽屉读同一份记录（`internal/agentstate`），不再从静态能力表推“完整”。

## 七步

| 步 | 用户看到的 | 完成证据 |
|---|---|---|
| 检测 | 未检测到 | 配置目录或 exe 真实存在（Go 每次现扫） |
| 安装 | 安装 | 官方 recipe 跑完并重新扫描到 |
| 启动 | 打开 | 这一格真的起了 PTY（记录 `pane=`） |
| 就绪 / 登录 | 登录 | `whoami` / 首屏分类 / hooks 给出 ready |
| 状态 | 状态 | 收到第一条真实状态事件（hook / HTTP / app-server / 扩展） |
| 续接 | 续接 | 启动参数已接（exact / latest），必要时真实续接过 |
| 网关 | 接入网关 | magpie 回读 `wired=true`；不支持则如实写 unsupported |

每一步的状态是 `todo / doing / done / failed / unsupported / not_applicable`，
带 `mechanism`、`source`、`errorCode`、`evidence`、`verified`。**“打开过一次”只算
启动这一步**，不会自动把其余步骤写成完成。

记录落在 `%APPDATA%\Perch\agent-state.json`，只存分类和短证据，不存 prompt、工具参数、
key、token 或响应正文。

## 四种结论

- **完整（网关）**：七步全部 done。
- **可用（原生）**：1–6 步 done，第 7 步 unsupported（例如普通 Cursor CLI 不能被
  magpie 路由）。用户仍可完整使用，只是不走网关。
- **待处理**：有可执行的下一步（登录、装状态钩子、接网关…），卡片和抽屉都给出动作。
- **仅启动 · 无状态源**：产品确实没有这个 agent 的状态来源；给原因、原生入口和说明，
  不假装完成。
- **未检测到**：本机没找到；给安装/官方说明。

分组是互斥的：一个 agent 只出现在一个组里。旧版按三个独立布尔过滤，会把同一个 agent
同时列进「完整」和「仅启动」。

## 每个 agent 从零怎么走

| Agent | 状态来源 | 续接 | 网关 | 备注 |
|---|---|---|---|---|
| Claude Code | hooks（内置） | exact | magpie | 默认开格即接 |
| Codex | app-server（内置） | exact | magpie | 默认开格即接 |
| Pi | 观察扩展（内置） | exact | magpie | 默认开格即接 |
| OpenCode | 自带 HTTP（内置） | 待补 | magpie | 默认开格即接 |
| DeepSeek Harness | 官方 hooks 桥（点击接入） | exact | magpie | 未装桥时如实降级，行内给「接入状态」 |
| Antigravity CLI | 生命周期 hooks（点击接入） | `--conversation` / `--continue` | magpie | 标题不可用（实测是 exe 路径）；hooks 未接时状态为无来源 |
| Cursor | **无** | `--resume` / `--continue` | **不支持普通 CLI** | 首屏识别登录；网关给出原生路径与 Cursor Private Inference |
| 其余 CLI | 无（先用标题/无来源审计） | 待审计 | magpie 未注册则不假装 | 卡片给原因和官方说明 |
| ZCode | 无 | — | — | 只探测，不安装/启动 |

## Antigravity hooks 细节

`internal/agy` 只写 `~/.gemini/config/hooks.json` 里的命名条目 `perch-status`：

- 事件：`SessionStart` / `PreInvocation` / `Stop`。
- **不订阅 `PreToolUse`**：它是权限门，空输出可能改变默认 allow/ask；观察型 hook 不能
  替用户放行。因此 agy 的“等待批准”仍不可见。
- 写入前备份；坏 JSON 拒绝覆盖；其它命名条目原样保留。
- 命令形如
  `"<perch-hook.exe>" --agy "<hook-events>" SessionStart`，格子归属由
  `PERCH_AGENT_PANE` 决定（`AgyDef.Prepare` 注入）。
- `perch-hook --agy` 把 camelCase payload 归一成 `AgySessionStart` / `AgyWorking` /
  `AgyIdle`，stdout 永远输出 `{}`（不注入、不阻止 Stop）。
- 全局 hooks 对 Perch 之外的 agy 会话也会运行；没有 `PERCH_AGENT_PANE` 时接收器直接
  exit 0，不写任何事件。

## 网关边界

- 普通 Cursor CLI：magpie 的 `cursor` agent 只有 `model=auto`，`connect()` 直接返回
  `Cursor CLI can't be connected to magpie`。Perch 在 POST 之前 preflight，界面给灰按钮
  + 原因 + 原生路径，不发 400。
- magpie 没装/没跑：网关腿是「未运行/未安装」，不是 agent 坏了；原生使用不受影响。
- magpie 没注册这个 agent：网关腿 unsupported，不假装能接。
- 写操作（接入/断开/改字段）只在用户点击后发生；不静默改用户配置。

## 怎么验收（从零）

1. 全新 Windows 用户 / VM，不预置任何 agent 配置。
2. 在 Perch 里安装 → 打开 → 看卡片是否从「已安装」走到「下一步：登录/接入状态」。
3. agy：点击「接入状态」→ `hooks.json` 出现 `perch-status` → 重新打开一格 →
   完成登录 → 第一条 `PreInvocation` 后状态腿变成 hooks。
4. Cursor：打开后首屏是登录页 → 记录 `needs-login` → 登录后 `cursor-agent whoami`
   给出 ready → 网关腿保持「不支持」并给原生路径。
5. magpie 未安装/未运行/不支持/可接四种情况分别验一遍。
6. 重启 Perch：记录还在，卡片仍显示上次走到哪一步。

## 已知边界

- 标题不是 agy/Cursor 的状态源：实测 agy 的 OSC 标题是可执行文件路径，Cursor 的
  `cursor ready` / `cursor - action required` 是 Orca 用 hooks 合成的，不是 CLI 原生输出。
  产品不把这两者写成 Title 能力。
- Cursor 的会话 id 目前没有可靠来源，跨重启的精确 `--resume <id>` 仍待补；`--continue`
  参数已接。
- agy 的等待批准不可见（见上）。
- 无状态源的 agent 不可能“完整”；产品只承诺说清原因、原生入口和下一步。
