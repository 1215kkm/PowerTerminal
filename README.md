# 🚀 PowerTerminal

**Run Claude Code from your browser — on your PC and your phone, at the same time.**

Open multiple Claude Code sessions side by side, watch them work, and send requests from anywhere. Sessions keep running on your PC; your phone is just a window into them.

> It uses the real Claude Code CLI on your machine — same behavior, same usage. Just a much better view.

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

To use it on your phone, click the **📱 QR** button and scan the code. Done.

## Features

- **Multi-session grid** — several projects at once, auto-arranged (1 full / 2 side-by-side / 3–4 grid)
- **Phone = same screen** — sessions live on your PC; check and control them from anywhere
- **Green border** when a session finishes its work — click to dismiss
- **👁 Live preview** of the page you're building, inside the panel
- **Drag to reorder · double-click to rename** panels
- **Usage bars** — your Claude plan usage (session / weekly), same numbers as the official app
- **New Project** — folder + git + private GitHub repo + Claude, in one click *(needs [GitHub CLI](https://cli.github.com), `gh auth login`)*
- **Any AI per session** — Claude Code, Codex, plain PowerShell, or a custom command
- **5 languages** — English, 한국어, 日本語, 中文, Español

## Optional

- **Access from outside your Wi-Fi (LTE):** download [cloudflared.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe) into the PowerTerminal folder. The server will create a public URL automatically.

## Security

- Access requires a private token (auto-generated on first run). Anyone with your URL/QR can control your sessions — share only with people you trust.
- Revoke access anytime: delete `config.json` and restart.

## Updates

`start.bat` auto-updates on every launch. Running instances show a 🔄 chip when a new version is out.
