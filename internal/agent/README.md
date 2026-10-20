# internal/agent — agent 适配器集合

这里放「怎么启动一个 agent」和「怎么知道它在忙、在等、在做什么」。
主程序不在这里：它只负责窗口、标签、PTY 和持久化，通过 `Host` 接口把这三样能力借给适配器。

Claude 的状态腿（hook / 登记表 / 转录）仍住在主程序里 —— 它是最早、最深的一条，
暂不搬动；这个包的边界是**新增 agent** 和**非 Claude 适配器**。

## 文件

| 文件 | 职责 |
|---|---|
| `def.go` | `Def` / `ResumeIntent`：把续接意图翻译成命令行；`GenericDef` 与各 agent 的构造函数 |
| `host.go` | `Host`：适配器需要主程序提供的最小表面（绑定会话、写状态、推前端、找 exe） |
| `status.go` | 能力矩阵、归一化事件、OpenCode 适配器 |
| `codex.go` | Codex：每格一个 app-server，TUI 通过 `--remote` 连它 |
| `pi.go` | Pi：每格一个观察扩展（`-e`）写 JSONL，Go 侧 tail |
| `pi/observer.ts` | 随二进制分发的 Pi 扩展源码（`go:embed`） |
| `env.go` | 子 agent 的终端环境：剥掉宿主身份，再按事实声明 |
| `util.go` | id 白名单、日志截断等无状态小工具 |

## 能力矩阵（只登记已经落地的）

| agent | 机制 | 启动 | 续接 | 忙闲 | 在等你 | 动作 |
|---|---|:--:|:--:|:--:|:--:|:--:|
| Claude | hook | ✓ | ✓ | ✓ | ✓ | ✓ |
| OpenCode | HTTP | ✓ |  | ✓ | ✓ |  |
| Pi | extension | ✓ | ✓ | ✓ | ✓ |  |
| Codex | app-server | ✓ | ✓ | ✓ | ✓ |  |
| 其它有 `Bin` 的 | terminal | ✓ |  |  |  |  |

「能启动」和「有状态」是两件事：`CapsFor` 的 `Launch` 由主程序传入的完整名单决定，
其余列只看这张表。不要把计划中的适配器提前写进来 —— 前端会把表当成事实。

## 加一个 agent

1. 在 `def.go` 里写构造函数（`GenericDef(bin)` 起步，需要时补 `Args` / `Prepare`）。
2. 需要状态就在 `status.go` 的矩阵里登记，并通过 `Host.Push` 发归一化事件。
3. 在 `main.go` 的 `init()` 里用构造函数覆盖 `agentDefs[id]`。
4. 需要续接判据时，在 `pi.go` 底部那种分派口上加一个分支。

## 事件协议

所有适配器最终都归一到：

```json
{"type":"agent","tab":1,"agent":"pi","status":"busy|idle|waiting",
 "state":"working|blocked|waiting|done","kind":"ask|perm","text":"…",
 "session":"…","evidence":"hook|registry|extension|http|app-server|resync"}
```

`state` 是权威，`status` 是给现有 UI 的兼容层；`evidence` 让前端区分活事件和
冷恢复时的重放。字段只增不改。
