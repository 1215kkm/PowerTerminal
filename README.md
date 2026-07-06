# 🚀 PowerTerminal

**Claude Code on your phone — the work runs on your Windows PC.**

Open multiple Claude Code sessions side by side, watch them work, and send requests from anywhere. Sessions keep running on your PC; your phone (or any browser) is just a window into them.

> It uses the real Claude Code CLI on your machine — same behavior, same usage. Just a much better view.

[한국어 README](README.ko.md)

<!-- Demo: record a 15–30s clip of a phone controlling a PC session (see docs/LAUNCH.md for the shot list), export a GIF ≤ 10MB, save it as docs/demo.gif, then remove this comment. -->
![PowerTerminal demo — multi-session grid on PC, same sessions on a phone](docs/demo.gif)

## Why PowerTerminal?

Plenty of tools wrap Claude Code — most are Mac/Linux desktop apps or heavyweight agent orchestrators. PowerTerminal takes a different spot:

|  | PowerTerminal | opcode (Claudia) | CloudCLI (claudecodeui) | Vibe Kanban |
|---|---|---|---|---|
| **Windows-first** | ✅ built for Windows | Mac/Linux | cross-platform | cross-platform |
| **Phone = same live session** | ✅ your phone mirrors and controls the PC session | ❌ desktop only | ✅ remote sessions | ❌ board UI |
| **Setup** | `git clone` + double-click `start.bat` | build/install desktop app | install + configure | install + configure |
| **Runtime** | plain Node.js server, no build step | Tauri app | Node/web app | Rust + web app |
| **Claude plan usage bars** | ✅ same numbers as the official app | partial | ❌ | ❌ |
| **One-click new project** (folder + git + private GitHub repo + Claude) | ✅ | ❌ | ❌ | ❌ |

If you live on Windows and want to fire off requests from your bed or your commute while your PC does the work, this is the gap PowerTerminal fills.

## Requirements

- **Server: Windows** (it drives real `powershell.exe` terminals). Mac/Linux support isn't there yet — but any phone, tablet, or Mac **browser** can connect as a client.
- [Node.js](https://nodejs.org) (LTS) and [Claude Code](https://claude.com/claude-code) on the Windows PC.

## Quick Start

1. Install [Node.js](https://nodejs.org) (LTS)
2. Install and sign in to [Claude Code](https://claude.com/claude-code):
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
3. Get PowerTerminal:
   ```
   git clone https://github.com/1215kkm/PowerTerminal.git
   cd PowerTerminal
   npm install
   ```
4. **Double-click `start.bat` — that's it.** 🎉
   It auto-updates, starts the server, and opens your browser.

To use it on your phone, click the **QR** button and scan the code. Done.

## Features

- **Multi-session grid** — several projects at once, side by side (1 full / 2 half / 3+ in one row, wraps to 2 rows when narrow). ⛶ expands one pane in place; 5+ sessions can spill into a second browser window (nice with dual monitors)
- **Phone = same screen** — sessions live on your PC; check and control them from anywhere
- **Status borders** — sky-blue while a session is working, thick green when it's done (stays green until you send the next request)
- **👁 Live preview** of the page you're building, in a new tab
- **⇄ Mode button** — cycle Claude Code's auto / accept-edits / plan modes with one tap (the button shows the current mode)
- **Paste anything** — images and long text collapse into small chips like `[Image #1]` / `[Text #1 · 597 chars]` and are delivered to Claude on send; the input box grows as you type (Shift+Enter = new line, Ctrl+Z undo)
- **Usage bars** — your Claude plan usage (session / weekly) with time left until reset, same numbers as the official app
- **New Project** — folder + git + private GitHub repo + Claude, in one click *(needs [GitHub CLI](https://cli.github.com), `gh auth login`)*
- **Any AI per session** — Claude Code, Codex, plain PowerShell, or a custom command
- **10 languages** — English, 한국어, 日本語, 中文, Español, Deutsch, Français, Português, Русский, हिन्दी

## Choosing an AI model (the dropdown in each session)

Each Claude session has a model dropdown on its folder row:

| Option | What it does |
|---|---|
| **Auto** | Doesn't pick a model at all — Claude Code runs with **your account's default model** (whatever you set with `/model` or your plan's default). It does *not* switch models per question. |
| **Opus / Sonnet / Haiku / Fable** | Pins the session to that model. Aliases always map to the **latest version** of each model. |
| **Opus Plan** | Starts on Opus, then **automatically falls back to Sonnet** when you approach your usage limit — the only option that switches by itself. |

Changing the dropdown while a session is running switches the model live (it sends `/model` for you) — no restart needed.

## Optional

- **Access from outside your Wi-Fi (LTE):** PowerTerminal downloads [cloudflared](https://github.com/cloudflare/cloudflared) automatically on first run and creates a public URL. The QR dialog shows both the external and same-Wi-Fi addresses.

## Security

- Access requires a private token (auto-generated on first run). Anyone with your URL/QR can control your sessions — share only with people you trust.
- Revoke access anytime: delete `config.json` and restart.

## Updates

`start.bat` auto-updates on every launch — just restart to get the newest version.
