# 第三方组件与致谢

本项目的代码与界面是我们自己写的，但里面有若干**第三方**的部件与工序，逐项列在这里。
（这一页不是为了免责，是为了把"哪些是我们的、哪些是别人的"说清楚。）

## 运行时依赖 / 打包进来的资产

| 部件 | 用途 | 许可 | 许可全文 |
|---|---|---|---|
| [Wails v3](https://github.com/wailsapp/wails) | 桌面外壳（WebView2 承载前端） | MIT | 随 Go 模块分发（`go.mod`） |
| [xterm.js](https://github.com/xtermjs/xterm.js) + 官方 addon（fit / webgl / image / ligatures / serialize / unicode11 / web-links） | 终端渲染 | MIT | `licenses/MIT-xterm.txt` |
| [ConPTY](https://github.com/UserExistsError/conpty) | Windows 伪终端 | MIT | 随 Go 模块分发 |
| [lobe-icons](https://github.com/lobehub/lobe-icons) | Agent 品牌图标（`assets/agent-icons/`） | MIT | `licenses/MIT-lobe-icons.txt` |
| [Lucide](https://lucide.dev/) | 文件类型与界面图标 | ISC | `licenses/ISC-lucide.txt` |
| Cascadia Code / Cascadia Mono | 界面等宽字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |
| JetBrains Mono | 终端等宽字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |
| Geist | 界面无衬线字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |

⚠️ 发布**二进制**时，上面这些许可的全文要一并带上（OFL 明确要求随字体分发许可；
MIT 要求保留版权声明与许可文本）。源码仓库里它们已经在 `licenses/` 下。

## 设计与实现上参考过的开源项目

| 项目 | 参考了什么 | 许可 |
|---|---|---|
| [Orca](https://github.com/stablyai/orca) | 界面样式与一批实现细节（终端面板的排版、状态点的字形、活动流"一个 agent 一行"的降噪合同、自动滚动状态机等）。源码注释里逐处写明了出处。 | MIT（Copyright (c) 2026 Lovecast Inc.，全文见 `licenses/MIT-Orca.txt`） |
| [Magpie](https://github.com/yetone/magpie) | 桌面质感与用量面板的信息怎么组织（用它当品质参照，**没有**把它的代码放进本仓库） | MIT（Copyright (c) 2026 yetone） |

数据面（转录 / hook / 屏幕三路的优先级与护栏）、看板形态、状态判定、以及这个网关本身的
架构是我们自己定的；上表说的是**我们读着别人的开源实现学来的那些具体工序**。
