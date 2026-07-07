# 🚀 PowerTerminal

**Run Claude Code from your browser — on your PC and your phone, at the same time.**

Open multiple Claude Code sessions side by side, watch them work, and send requests from anywhere. Sessions keep running on your PC; your phone is just a window into them.

> It uses the real Claude Code CLI on your machine — same behavior, same usage. Just a much better view.

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

- **Multi-session grid** — several projects at once, side by side (1 full / 2 half / 3+ in one row, wraps to 2 rows when narrow). ⛶ expands one pane in place; 5+ sessions can spill into a second browser window (nice with dual monitors)
- **Phone = same screen** — sessions live on your PC; check and control them from anywhere
- **Touch-first on tablets** — iPad and iPad mini too; drag the center of any terminal to scroll its history, and small screens drop to the phone layout
- **Status borders** — sky-blue while a session is working, thick green when it's done (stays green until you send the next request)
- **🔊 Done alerts you hear** — flip on the speaker button and each finished session is announced out loud: a *ding-dong* chime, then "session two done", spoken by the browser (built-in speech, no install, works offline). It only fires when a request truly finishes — not on Claude's intermediate steps — and plays while the tab is open (mobile suspends background tabs)
- **👁 Live preview** of the page you're building, in a new tab
- **⇄ Mode button** — cycle Claude Code's auto / accept-edits / plan modes with one tap (the button shows the current mode)
- **Paste anything** — images and long text collapse into small chips like `[Image #1]` / `[Text #1 · 597 chars]` and are delivered to Claude on send; the input box grows as you type (Shift+Enter = new line, Ctrl+Z undo)
- **Usage bars** — your Claude plan usage (session / weekly) with time left until reset, same numbers as the official app
- **New Project** — folder + git + private GitHub repo + Claude, in one click *(needs [GitHub CLI](https://cli.github.com), `gh auth login`)*
- **Any AI per session** — Claude Code, Codex, plain PowerShell, or a custom command
- **10 languages** — English, 한국어, 日本語, 中文, Español, Deutsch, Français, Português, Русский, हिन्दी

## Screenshots

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/grid.jpg" alt="Multiple sessions on PC"><br><sub>Several Claude Code sessions side by side on your PC — each with its own folder, model and status.</sub></td>
<td width="50%"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/mobile.jpg" alt="On your phone"><br><sub>The same workspace on your phone in one column — tap a session tab to jump to it.</sub></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/add.jpg" alt="Add a session"><br><sub>Add a session: reopen a previous folder from the grid, browse, or start a new project.</sub></td>
<td><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/qr.jpg" alt="QR access"><br><sub>Scan the QR to open it on your phone — over Wi-Fi, or anywhere via the external link.</sub></td>
</tr>
</table>

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
