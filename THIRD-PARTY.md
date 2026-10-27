# 第三方组件与致谢

本项目的代码与界面是我们自己写的，但里面有若干**第三方**的部件与工序，逐项列在这里。
（这一页不是为了免责，是为了把"哪些是我们的、哪些是别人的"说清楚。）

## 运行时依赖 / 打包进来的资产

| 部件 | 用途 | 许可 | 许可全文 |
|---|---|---|---|
| [Wails v3](https://github.com/wailsapp/wails) | 桌面外壳（WebView2 承载前端） | MIT | `licenses/modules/wails-v3.txt` |
| [xterm.js](https://github.com/xtermjs/xterm.js) + 官方 addon（fit / webgl / image / ligatures / serialize / unicode11 / web-links） | 终端渲染 | MIT | `licenses/MIT-xterm.txt`；`addon-image.js` 另带 `assets/vendor/addon-image.js.LICENSE.txt` |
| [ConPTY](https://github.com/UserExistsError/conpty) | Windows 伪终端 | MIT | `licenses/modules/conpty.txt` |
| [coder/websocket](https://github.com/coder/websocket) | Codex app-server 的 WebSocket 客户端 | ISC | `licenses/modules/coder-websocket.txt` |
| [golang.org/x/sys](https://pkg.go.dev/golang.org/x/sys) | Windows 系统调用 | BSD-3-Clause | `licenses/modules/x-sys.txt` |
| [adrg/xdg](https://github.com/adrg/xdg) | 配置目录（间接依赖） | MIT | `licenses/modules/adrg-xdg.txt` |
| [go-ole](https://github.com/go-ole/go-ole) | COM（间接依赖） | MIT | `licenses/modules/go-ole.txt` |
| [go-colorable](https://github.com/mattn/go-colorable) | Windows 控制台颜色（间接依赖） | MIT | `licenses/modules/go-colorable.txt` |
| [go-isatty](https://github.com/mattn/go-isatty) | 终端探测（间接依赖） | MIT | `licenses/modules/go-isatty.txt` |
| [godbus](https://github.com/godbus/dbus) | Linux 构建的间接依赖（Windows 二进制不链接） | BSD-2-Clause | `licenses/modules/godbus.txt` |
| [lobe-icons](https://github.com/lobehub/lobe-icons) | Agent 品牌图标（`assets/icons/agents/`） | MIT | `licenses/MIT-lobe-icons.txt` |
| [Lucide](https://lucide.dev/) | 文件类型与界面图标 | ISC | `licenses/ISC-lucide.txt` |
| Cascadia Code / Cascadia Mono | 界面等宽字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |
| JetBrains Mono | 终端等宽字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |
| Geist | 界面无衬线字体 | SIL OFL 1.1 | `licenses/OFL-1.1.txt` |

⚠️ 发布**二进制**时，上面这些许可的全文要一并带上（OFL 明确要求随字体分发许可；
MIT 要求保留版权声明与许可文本）。源码仓库里它们已经在 `licenses/` 下。
`scripts/package.ps1` 打包时会连同 `licenses/` 一起复制。

Perch 本身不做遥测；模型请求由各个 agent 直接发往用户在「设置 › 模型提供商」里配置的提供商，
不经过 Perch。

`assets/vendor/` 里的第三方 JS 保持上游原样分发；上游包未附带 source map，本仓库也不分发。
`addon-image.js` 的 banner 指向的 `addon-image.js.LICENSE.txt` 原先没有随包发布，
这里按它实际打包的组件（@xterm/addon-image、sixel、inwasm、xterm-wasm-parts、
VS Code base/common）补齐了许可全文。

## 设计与实现上参考过的开源项目

| 项目 | 参考了什么 | 许可 |
|---|---|---|
| [Orca](https://github.com/stablyai/orca) | 界面样式与一批实现细节（终端面板的排版、状态点的字形、活动流"一个 agent 一行"的降噪合同、自动滚动状态机等）。源码注释里逐处写明了出处。 | MIT（Copyright (c) 2026 Lovecast Inc.，全文见 `licenses/MIT-Orca.txt`） |
| [Magpie](https://github.com/yetone/magpie) | 前端几处小部件的做法（图标解析、分段控件的滑块、热力图骨架；源码注释里写明了出处） | MIT（Copyright (c) 2026 yetone，全文见 `licenses/MIT-magpie.txt`） |

数据面（转录 / hook / 屏幕三路的优先级与护栏）、看板形态、状态判定、模型提供商的注入方式
是我们自己定的；上表说的是**我们读着别人的开源实现学来的那些具体工序**。
