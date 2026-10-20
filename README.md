<div align="center">

<img src="docs/images/perch-mark.png" width="80" height="80" alt="Perch logo">

# Perch

**A desktop workspace for agent terminals.**<br>
Run several agents side by side in one window — one real terminal per pane. Collapse the terminals and it becomes a work board that shows who is waiting on you.

![Windows 11](https://img.shields.io/badge/Windows%2011-0078D4?logo=windows&logoColor=white)
![Go](https://img.shields.io/badge/Go-1.27%2B-00ADD8?logo=go&logoColor=white)
![Wails](https://img.shields.io/badge/Wails-v3-DF0000)
![License](https://img.shields.io/badge/license-MIT-111111)

</div>

<p align="center">
  <a href="docs/images/overview.png"><img src="docs/images/overview.png" alt="Perch overview: workspace status, gateway usage, and the agent catalog" width="960"></a>
</p>

Perch is a Windows desktop gateway for agent terminals, in the same **agent development environment** category as Orca.
The terminal is the main interface: every pane is a live ConPTY, and the agent runs inside it normally. The layer around it exists to **keep many such panes visible and manageable, and to make it obvious when one stops and waits for you**.
It is not "run N copies of one vendor's agent": the agent is your choice. This layer owns the terminal and the workspace.

## Why Perch

Every agent has its own sessions, its own state, and its own idea of "waiting for you". Open three terminals and you spend the day switching between them. Perch brings them into one window:

- **One real terminal per pane** — parallel grid, independent tabs, status dots; scrollback stays local and is still there when you switch back.
- **Attention first** — whoever is waiting for you comes first. Answer selection prompts from the "Needs you" panel; permission prompts can be allowed or denied from the work board after the terminals are collapsed.
- **Collapse terminals into a work board** — one fixed-height row per agent; the row does not render the transcript; click a row to enter that pane.
- **The gateway is not rebuilt** — providers, routing, usage, and plugins use magpie's native pages. Perch embeds them and wires agents into them; it does not keep a second copy.

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Parallel agent grid

Each pane is a live ConPTY with its own scrollback, tab, and status dot. Switching tabs does not lose output, and the grid keeps the whole team visible at a glance.

</td>
<td width="50%">
  <a href="docs/images/overview.png"><img src="docs/images/overview.png" alt="Workspace status, activity, and the agent catalog in the Perch overview" width="100%"></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent wiring and model selection

Connect, disconnect, re-apply, or keep the current configuration. Long model lists become a searchable popover; the current value is brought into view automatically. Configuration comes from magpie's `/api/state`, and writes go through the same API — Perch does not keep a second copy.

</td>
<td width="50%">
  <a href="docs/images/agent-wiring.png"><img src="docs/images/agent-wiring.png" alt="Agent configuration drawer with gateway wiring and model selection" width="100%"></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Embedded magpie gateway

Providers, routing, usage, and plugins use magpie's own pages; the version and update bar is hosted by Perch. Updates use magpie's own `check → install`; after re-exec, Perch claims the new process by port.

</td>
<td width="50%">
  <a href="docs/images/gateway.png"><img src="docs/images/gateway.png" alt="Embedded magpie gateway showing usage, sessions, projects, and models" width="100%"></a>
</td>
</tr>
</table>

**Also in the box:**

- **Attention-first work board** — the "Needs you" panel puts the pane that is waiting in front. Selection prompts can be answered there; permission requests can be handled from the work board after the terminal is collapsed.
- **Exact resume, honest fallbacks** — a pane restores the exact session while its file is still on disk. If the session is gone, the seat is kept and a new conversation starts with a banner that explains why.
- **Real terminals, three-legged state** — ConPTY plus xterm.js with local scrollback. State is read from transcripts, agent hooks, and the screen; the three corroborate each other, and a weak signal is never allowed to conclude alone.
- **Read-only file rail** — a file tree and preview beside the active agent. Perch reads files and never edits them behind your back.
- **Close is not delete** — closing a pane stops the run but keeps the record. The agent appears as "closed" in the left rail and can be resumed later under the same pane ID.
- **Install recipes built in** — the agent catalog detects what is installed, runs the official installer or npm package on request, and rescans immediately after installation.
- **Gateway lifecycle** — Perch observes a running magpie, can start its own control plane when needed, follows updates through re-exec, and never stops the desktop magpie.

## Supported agents

Perch's catalog contains CLI agents only. Desktop and web clients are not installed or launched by Perch; they belong to magpie's gateway layer. The catalog ships with 14 CLI agents, grouped by integration depth.

### Full integration

These four have dedicated adapters: structured status and exact session resume. They are also installable and launchable through the same Agent CLI list.

<table align="center">
<tr>
<td align="center" width="25%"><img src="assets/icons/agents/claudecode-color.svg" width="32" height="32" alt="Claude Code"><br><sub>Claude Code</sub></td>
<td align="center" width="25%"><img src="assets/icons/agents/codex-color.svg" width="32" height="32" alt="Codex"><br><sub>Codex</sub></td>
<td align="center" width="25%"><img src="assets/icons/agents/pi.svg" width="32" height="32" alt="Pi"><br><sub>Pi</sub></td>
<td align="center" width="25%"><img src="assets/icons/agents/opencode.svg" width="32" height="32" alt="OpenCode"><br><sub>OpenCode</sub></td>
</tr>
</table>

### Install and launch

The other nine have a one-click install recipe — the official installer or an npm package — and can be started in a Perch pane. They share the same icon, detection, install, and launch path.

<table align="center">
<tr>
<td align="center" width="20%"><img src="assets/icons/agents/antigravity-color.svg" width="32" height="32" alt="Antigravity CLI"><br><sub>Antigravity CLI</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/cursor.svg" width="32" height="32" alt="Cursor"><br><sub>Cursor</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/codebuddy-color.svg" width="32" height="32" alt="CodeBuddy Code"><br><sub>CodeBuddy Code</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/kimi.svg" width="32" height="32" alt="Kimi Code"><br><sub>Kimi Code</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/meta-color.svg" width="32" height="32" alt="Muse Code"><br><sub>Muse Code</sub></td>
</tr>
<tr>
<td align="center" width="20%"><img src="assets/icons/agents/geminicli-color.svg" width="32" height="32" alt="Gemini CLI"><br><sub>Gemini CLI</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/githubcopilot.svg" width="32" height="32" alt="Copilot CLI"><br><sub>Copilot CLI</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/qwen-color.svg" width="32" height="32" alt="Qwen Code"><br><sub>Qwen Code</sub></td>
<td align="center" width="20%"><img src="assets/icons/agents/crush.png" width="32" height="32" alt="Crush"><br><sub>Crush</sub></td>
</tr>
</table>

<p align="center">
  <img src="assets/icons/agents/zcode.png" width="24" height="24" alt="ZCode" valign="middle">
  <sub><b>ZCode</b> — detected and listed in the catalog, but not installed or launched by Perch.</sub>
</p>

**Install** means Perch runs the agent's official installer or npm package after you click "Install". **Launch** means Perch can start it in a pane. Desktop clients are outside this list; any client that can point at a custom base URL can use the magpie gateway.

## Where the data comes from

Three legs, from hardest to softest — the order is deliberate:

1. **Transcript** — the session JSONL on disk. What was said and whether a tool call is still pending are structured facts.
2. **Hooks** — the agent's own hook events; state changes arrive fastest here.
3. **Screen** — the terminal buffer. A fallback, and the only source for some facts (for example, which question of a multi-question prompt you are on) — the transcript only lands after the whole prompt is answered.

The three corroborate each other. A single weak leg is not allowed to conclude on its own: "answered No" is not the same as done, and "still spinning" has a synthetic fallback that is explicitly labeled as synthetic.

## Build

Requires Windows 11 (ConPTY) and Go 1.27+. The frontend has no bundler: one `index.html` plus assets, embedded with `go:embed`.

```powershell
go build -o build\perch.exe ./cmd/perch
go build -o build\perch-hook.exe ./cmd/perch-hook   # hook receiver: the name is hard-coded
.\build\perch.exe
```

Two binaries are required: the main app and a separate hook receiver (the agent's hook events are written by it, and the main app reads them). The receiver's file name is hard-coded (`hookExeName` in the hook code) and both executables must sit side by side in the same directory. If one is missing, features disappear silently.

## Status

- **Experimental**; interfaces will change.
- Windows only (ConPTY and Job Objects).
- Status parsing is currently sampled from Claude Code's terminal output. The rule table is extensible; other agents need their own rules.
- Process names, the state directory, and the hook receiver are all `perch` / `Perch`; there are no machine-specific absolute paths. On another machine Perch uses that machine's own state root (`CLAUDE_CONFIG_DIR`, or `~/.claude` when unset).

## For contributors

Why the frontend uses classic scripts with `defer`, what belongs in each file, icon rules, and why assets require a rebuild — see [docs/FRONTEND.md](docs/FRONTEND.md). Backend layers and dependency direction are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Interface languages, translation keys, backend message codes, and the CI guard are in [docs/I18N.md](docs/I18N.md).

## Acknowledgements

This project learned from two open-source implementations, mostly at the level of concrete process (terminal pane layout, status-dot glyphs, the one-agent-per-line activity stream, the auto-scroll state machine). The architecture and data plane are our own. [THIRD-PARTY.md](THIRD-PARTY.md) lists each item and its license.

- [Orca](https://github.com/stablyai/orca) (MIT) — UI styling and a set of implementation details
- [Magpie](https://github.com/yetone/magpie) (MIT) — desktop feel and the information architecture of the usage panel

And [xterm.js](https://github.com/xtermjs/xterm.js), [Wails](https://github.com/wailsapp/wails), [Cascadia](https://github.com/microsoft/cascadia-code), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), and [Geist](https://github.com/vercel/geist-font).

## License

MIT © 2026 yu7dan. Third-party components and reference implementations are covered in [THIRD-PARTY.md](THIRD-PARTY.md).
