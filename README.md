<div align="center">

<img src="docs/images/perch-mark.png" width="88" height="88" alt="Perch">

# Perch

**Run your agents side by side. See who needs you.**

Perch is a Windows desktop workspace for agent CLIs: one real terminal per pane, one place to see status, and a local gateway for models.

![Windows 10/11](https://img.shields.io/badge/Windows%2010%2F11-0078D4?logo=windows&logoColor=white)
![Private beta](https://img.shields.io/badge/private-beta-8A8A8A)
![Go 1.27+](https://img.shields.io/badge/Go-1.27%2B-00ADD8?logo=go&logoColor=white)
![MIT](https://img.shields.io/badge/license-MIT-111111)

</div>

<p align="center">
  <a href="docs/images/overview.png"><img src="docs/images/overview.png" alt="Perch running Claude Code, Codex and OpenCode in one workspace" width="960"></a>
</p>

Perch is an agent development environment, not a chat client. It owns the terminals and the workspace; each agent runs normally inside its own pane, and the gateway connects models without taking over the agent.

## Why Perch

- **One real terminal per pane.** Every pane is a live ConPTY with its own scrollback and status dot. Switching does not lose output.
- **Attention first.** Whoever is waiting for you is visible at a glance, in the grid or on the work board.
- **A gateway with a boundary.** Model profiles are applied per pane. Perch does not rewrite your global agent configuration, and it never stops the desktop magpie.

## A work board, not a tab graveyard

Collapse the terminal grid and each agent becomes one fixed-height row: what it last said, whether it is idle or waiting, and one click back into its pane. The row is a summary, not a second transcript.

<p align="center">
  <a href="docs/images/work-board.png"><img src="docs/images/work-board.png" alt="Perch work board with one fixed row per agent" width="860"></a>
</p>

## Agent setup in one place

Install, configure, and open an agent from the same list. Perch detects what is installed, runs the official installer or npm package when you ask, and applies each agent's model and effort settings per pane, where the agent exposes them. The gateway's model lists and provider choices are read from the running engine, not kept as a second copy.

<p align="center">
  <a href="docs/images/agent-setup.png"><img src="docs/images/agent-setup.png" alt="Perch agent setup with model and effort controls" width="860"></a>
</p>

## A local gateway you can inspect

Providers, routing, usage, and plugins use magpie's own console, embedded in Perch. The engine runs locally, its data stays on this machine, and the console keeps magpie's own wording and attribution.

<p align="center">
  <a href="docs/images/gateway.png"><img src="docs/images/gateway.png" alt="Perch agent panes connected through a local magpie gateway to providers" width="860"></a>
</p>

**Also included:** exact session resume with an honest fallback, close-is-not-delete, and a read-only file rail beside the active agent.

## Supported agents

Perch ships with nine CLI agents. All of them can be installed and launched in a pane; the depth of status support depends on what each agent exposes.

| Agent | Install | Status | Resume | Notes |
|---|:---:|:---:|:---:|---|
| <img src="docs/images/agents/claudecode-color.svg" width="18" height="18" alt=""> Claude Code | Official installer | Full | Exact | Hooks; reference adapter |
| <img src="docs/images/agents/codex-color.svg" width="18" height="18" alt=""> Codex | Official installer | Full | Exact | Per-pane app-server |
| <img src="docs/images/agents/pi.svg" width="18" height="18" alt=""> Pi | npm package | Full | Exact | Observer extension |
| <img src="docs/images/agents/opencode.svg" width="18" height="18" alt=""> OpenCode | npm package | Full | Exact | Local HTTP API |
| <img src="docs/images/agents/qoder.svg" width="18" height="18" alt=""> Qoder | Official installer | Full | Exact | Claude-shaped hooks; sign-in required |
| <img src="docs/images/agents/deepseek-color.svg" width="18" height="18" alt=""> DeepSeek Harness | Community TUI | Full | Exact | Official hook bridge; upstream caveat |
| <img src="docs/images/agents/antigravity-color.svg" width="18" height="18" alt=""> Antigravity CLI | Official installer | Full | Exact | Transcript-backed status |
| <img src="docs/images/agents/cursor.svg" width="18" height="18" alt=""> Cursor | Official installer | Status only | Exact | No tool actions |
| <img src="docs/images/agents/githubcopilot.svg" width="18" height="18" alt=""> Copilot CLI | Official installer | Full | Exact | Sign in with `/login` |

Desktop and web clients are outside this list. Any client that accepts a custom base URL can use the gateway. Agent names and logos belong to their respective owners.

## Getting started

Private beta builds are portable zips. Extract the zip, keep `perch.exe` and `perch-hook.exe` together, and run `perch.exe`. The build is unsigned, so Windows SmartScreen may ask you to confirm. See [START-HERE.txt](docs/START-HERE.txt) for the first-run walkthrough (Chinese).

From source:

```powershell
git clone https://github.com/yu7dan/perch.git
cd perch

go build -o build\perch.exe .\cmd\perch
go build -o build\perch-hook.exe .\cmd\perch-hook
.\build\perch.exe
```

Both executables are required. The agent hooks are written by `perch-hook.exe` and read by the main app; if it is missing, hook-backed status silently disappears.

Build a portable beta zip with:

```powershell
.\scripts\package.ps1 -Version 0.1.0-beta.1
# -> dist\Perch-0.1.0-beta.1-win-x64.zip
```

## How it works

- **ConPTY + xterm.js.** The terminal is the product surface; the grid, tabs, and scrollback are local.
- **Evidence, not guesswork.** Status is read from the session transcript, agent hooks, and the visible screen. The three corroborate each other; a weak signal is not allowed to conclude alone.
- **Gateway isolation.** Perch's engine and its per-agent profiles live under Perch's own data directories (`%APPDATA%\Perch` and `%LOCALAPPDATA%\Perch`). The desktop magpie and the agent's global configuration are left alone.

More detail: [architecture](docs/ARCHITECTURE.md) · [frontend](docs/FRONTEND.md) · [i18n](docs/I18N.md).

## Beta notes

- Windows 10/11 x64 with the WebView2 Runtime; ConPTY and Job Objects are required.
- Portable unsigned beta; no installer or code signing yet.
- Qoder, Copilot, and Cursor use their own sign-in; DeepSeek Harness tool execution is upstream-dependent.
- Agent installers and the magpie engine are downloaded from their official sources; neither is bundled in the zip. Agent installers run only after you click Install.
- Perch has no account system and sends no telemetry of its own. Agent CLIs and magpie may have their own policies.

## Acknowledgements

[Magpie](https://github.com/yetone/magpie) (MIT) provides the gateway engine and the information architecture of its console. [Orca](https://github.com/stablyai/orca) (MIT) was the reference for terminal layout and a number of concrete interaction details. Perch also uses [xterm.js](https://github.com/xtermjs/xterm.js), [Wails](https://github.com/wailsapp/wails), [Cascadia Code](https://github.com/microsoft/cascadia-code), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), and [Geist](https://github.com/vercel/geist-font). See [THIRD-PARTY.md](THIRD-PARTY.md) for licenses.

## License

MIT © 2026 yu7dan. Third-party components and reference implementations are covered in [THIRD-PARTY.md](THIRD-PARTY.md).
