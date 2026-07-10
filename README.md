# 🚀 PowerTerminal

**Run Claude Code from your browser — on your PC and your phone, at the same time.**

[![Latest release](https://img.shields.io/github/v/release/1215kkm/PowerTerminal?label=release&color=8a38f5)](https://github.com/1215kkm/PowerTerminal/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

Open multiple Claude Code sessions side by side, watch them work, and send requests from anywhere. Sessions keep running on your PC; your phone is just a window into them.

> It uses the real Claude Code CLI on your machine — same behavior, same usage, same subscription. Just a much better view.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/grid.jpg" alt="Multiple Claude Code sessions side by side" width="820"></p>

## Why PowerTerminal?

- **Not a cloud service.** Everything runs on *your* machine with *your* Claude subscription. Nothing is sent anywhere except the private tunnel you choose to open.
- **Made for humans, not just devs.** No tmux keybindings to learn — big buttons, status colors, sounds, and a phone layout your thumb can drive.
- **Walk away from your desk.** Kick off a long task, then check it from the sofa, the subway, or another PC. The session never stops.

## ⚠️ Read this first — security

PowerTerminal exposes a terminal on your machine to your browser, and (optionally) to the internet via a private link/QR. **Anyone who has that URL or scans that QR can run commands on your computer** — the same as sitting at it.

- **Share the QR / link only with people you trust.** Treat it like your password.
- Access needs a token that's generated on first run. To revoke everyone instantly: delete `config.json` and restart.
- External (LTE) access uses a Cloudflare quick tunnel whose address changes every restart. Don't post it publicly.
- **You are responsible for what happens if your link leaks.**

## Requirements

- **[Node.js](https://nodejs.org) (LTS)** — required to run. *PowerTerminal can't install this for you; install it first.* (On the first run, the launcher checks for it and points you to the download.)
- **[Claude Code](https://claude.com/claude-code)**, signed in. The launcher offers to install it for you if it's missing:
  ```
  npm install -g @anthropic-ai/claude-code
  claude        # sign in once
  ```

## Quick Start

```
git clone https://github.com/1215kkm/PowerTerminal.git
cd PowerTerminal
npm install
```

Then launch:

- **Windows:** double-click **`start.bat`**
- **macOS / Linux:** double-click **`start.command`** (macOS) or run `./start.command`
  *(first time on macOS: right-click → Open, to get past Gatekeeper)*

That's it 🎉 — the launcher auto-updates (if you cloned with git), starts the server, and opens your browser.

To use it on your phone, click the **QR** button, read the warning, and scan the code.

> **Tip:** either way works — even a ZIP download stays current, because on the first run the launcher wires up git and auto-updates (as long as git is installed).

## Features

### Sessions
- **Multi-session grid** — several projects at once, side by side (1 full / 2 half / 3+ in one row, wraps to 2 rows when narrow). ⛶ expands one pane in place; 5+ sessions can spill into a second browser window (nice with dual monitors)
- **Any AI per session** — Claude Code, Codex, plain PowerShell, or a custom command; switch a session's AI or model from its header
- **Status borders** — sky-blue while a session is working, thick green when it's done (stays green until you send the next request)
- **🔊 Done alerts you hear** — flip on the speaker button and each finished session is announced out loud: a *ding-dong* chime, then "session two done" (built-in browser speech, no install)
- **☀ / 🌙 Light & dark mode** — the whole UI *including the terminals*, with a readable light ANSI palette

### Requests
- **Your requests stand out** — everything you send gets a violet highlight in the terminal, so you can scroll back and instantly spot what *you* asked between walls of output
- **📜 Request history** — every request is logged automatically with a zero-token status stamp (⏳ running · ✅ done · ⛔ stopped · 🔌 cut off). Toggle the panel next to any terminal and click an entry to jump to that spot in the scrollback
- **⛔ Cancel button** — one tap stops the request in progress (sends ESC), on PC and phone
- **Paste or drop anything** — images and long text collapse into small chips like `[Image #1]` / `[Text #1 · 597 chars]` and are delivered on send; drag & drop images works too
- **Select = copy** — drag-select terminal text and it's copied automatically; incoming output pauses while you select, so the highlight doesn't get wiped mid-drag

### Memo pad
- **📝 Per-project memo pad** — free-form notes keyed to the folder, stored on your PC (`~/.powerterminal`), same notes on phone and PC
- **Send a memo to the terminal** — 📤 sends the note as a request; when the work finishes it moves itself to the *Completed* column
- **Full request log inside** — the memo pad shows everything you've asked in that project, with ↑ jump-to-terminal on each entry

### Phone & tablet
- **Phone = same screen** — sessions live on your PC; check and control them from anywhere via QR (same Wi-Fi) or a private Cloudflare tunnel (LTE, anywhere)
- **Touch-first** — drag the center of any terminal to scroll its history; big bouncy send button with haptics; the header folds away as you scroll so the terminal gets the room
- **👁 Live preview** — see the page you're building in a new tab; if the folder has no `index.html`, you get a clickable file listing instead

### Workflow
- **Usage bars** — your Claude plan usage (session / weekly) with time left until reset, same numbers as the official app
- **New Project** — folder + git + private GitHub repo + Claude, in one click *(needs [GitHub CLI](https://cli.github.com), `gh auth login`)*
- **10 languages** — English, 한국어, 日本語, 中文, Español, Deutsch, Français, Português, Русский, हिन्दी

## Screenshots

**Add a session** — reopen a previous folder from the grid, browse, or start a new project.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/add.jpg" alt="Add a session" width="820"></p>

**Open it on your phone** — scan the QR, over Wi-Fi or anywhere via the external link.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/qr.jpg" alt="QR access" width="820"></p>

**On your phone** — the same workspace in one column; tap a session tab to jump to it.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/mobile.jpg" alt="On your phone" width="300"></p>

## Choosing an AI model (the dropdown in each session)

| Option | What it does |
|---|---|
| **Auto** | Doesn't pick a model at all — Claude Code runs with **your account's default model** (whatever you set with `/model` or your plan's default). |
| **Opus / Sonnet / Haiku / Fable** | Pins the session to that model. Aliases always map to the **latest version** of each model. |
| **Opus Plan** | Starts on Opus, then **automatically falls back to Sonnet** when you approach your usage limit — the only option that switches by itself. |

Changing the dropdown while a session is running switches the model live (it sends `/model` for you) — no restart needed.

## FAQ

**Can I continue a session from a different computer?**
Yes — as long as *this* PC stays on. Sessions run here; any browser (phone, laptop, another PC) that opens your access URL sees and controls the very same session. What does **not** transfer is Claude Code's conversation memory if you move the project folder to another machine — Claude Code stores conversations locally per PC.

**Two sessions on the same folder — are they separate?**
Yes. The second session on a folder starts a fresh conversation instead of resuming the first one's, so they don't talk over each other.

**The preview button shows a file list, not my app.**
The built-in preview serves static files and looks for `index.html` in the project folder. If your app needs a dev server (React, Vite, Next…), start it and enter its address (e.g. `http://localhost:3000`) in the preview prompt instead.

**It's not updating.**
The launcher updates via `git pull` on every start (with a ZIP fallback). If you're stuck on an old version, the usual causes are: git not installed, or several copies of PowerTerminal running — close them all and start just one.

## Security

- Access requires a private token (auto-generated on first run). Anyone with your URL/QR can control your sessions — share only with people you trust.
- Revoke access anytime: delete `config.json` and restart.

## Updates

`start.bat` auto-updates on every launch — just restart to get the newest version.

## License

[MIT](LICENSE)
