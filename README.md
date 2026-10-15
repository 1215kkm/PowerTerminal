# 🚀 PowerTerminal

**Run Claude Code from your browser — on your PC and your phone, at the same time.**

[![Latest release](https://img.shields.io/github/v/release/1215kkm/PowerTerminal?label=release&color=8a38f5)](https://github.com/1215kkm/PowerTerminal/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

Open multiple Claude Code sessions side by side, watch them work, and send requests from anywhere. Sessions keep running on your PC; your phone is just a window into them.

> It uses the real Claude Code CLI on your machine — same behavior, same usage, same subscription. Just a much better view.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/grid.jpg" alt="Multiple Claude Code sessions side by side" width="820"></p>

▶ **[Video guide](https://pominal.com/#videos)** — 17 one-minute videos in English and Korean, each also as a vertical short: install, sessions side by side, phone, new project, faster requests, memo pad, note mode, auto-run, code editor, GitHub upload, mind map, the AI browser, the login vault, the on-screen helper, and three for mobile.

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

  *macOS blocks scripts it downloaded. If you see “cannot be opened because it is from an unidentified
  developer”, run this once in Terminal (right-click → Open no longer works on macOS 15 and later):*

  ```
  xattr -dr com.apple.quarantine ~/Downloads/PowerTerminal && open ~/Downloads/PowerTerminal
  ```
  *Adjust the path if you unzipped somewhere else.*

That's it 🎉 — the launcher auto-updates (if you cloned with git), starts the server, and opens your browser.

To use it on your phone, click the **QR** button, read the warning, and scan the code.

> **Tip:** either way works — even a ZIP download stays current, because on the first run the launcher wires up git and auto-updates (as long as git is installed).

## Features

Every feature below has a screenshot and a one-minute video (▶). All 18 videos are also on the site: **[pominal.com → Video guide](https://pominal.com/#videos)**.

| # | Feature | # | Feature |
|---|---|---|---|
| 1 | [Sessions side by side](#1-sessions-side-by-side) | 8 | [A real browser for the AI](#8-a-real-browser-for-the-ai) |
| 2 | [Add a session · new project in one go](#2-add-a-session--new-project-in-one-go) | 9 | [Login vault](#9-login-vault) |
| 3 | [Use it on your phone](#3-use-it-on-your-phone) | 10 | [On-screen helper](#10-on-screen-helper) |
| 4 | [Faster requests](#4-faster-requests) | 11 | [Code editor](#11-code-editor) |
| 5 | [Memo pad & Q&A log](#5-memo-pad--qa-log) | 12 | [Upload to GitHub](#12-upload-to-github) |
| 6 | [Note mode](#6-note-mode) | 13 | [Mind map & schedule](#13-mind-map--schedule) |
| 7 | [Auto-run](#7-auto-run) | 14 | [Status, alerts & usage](#14-status-alerts--usage) |

### 1. Sessions side by side

One AI per project, all on one screen. 1 session fills the screen, 2 split it, 3+ sit in one row and wrap to two rows when narrow; ⛶ expands one pane in place, and 5+ sessions can spill into a second window (nice with two monitors).

- **Any AI per session** — Claude Code, Codex, plain PowerShell or your own command; switch the model from the session header
- **Claude and GPT side by side** — hover a session number and click ＋ to open the same project again in its own git worktree (🌿 badge), switch that one to GPT, give each its own job, then click 🌿 to merge. Or ask Claude to call GPT (Codex) for the images and build the rest itself
- **Status borders** — sky-blue while working, thick green when done (stays green until your next request)
- **☀ / 🌙 light & dark** — the whole screen *including the terminals*

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/01-sessions.jpg" alt="Four Claude Code sessions side by side" width="820"></p>

▶ [Video: Sessions side by side](https://pominal.com/video/player.html?l=en&v=grid#share-en) · [Install and open your first session](https://pominal.com/video/player.html?l=en&v=start#share-en) · [Claude and GPT together](https://pominal.com/video/player.html?l=en&v=duo#share-en)

### 2. Add a session · new project in one go

**＋ Session** reopens a recent folder in one click, browses to any folder, or clones from GitHub. **New (folder+GitHub)** creates the folder, runs `git init`, makes a private GitHub repo and starts the AI — one name, one button *(needs [GitHub CLI](https://cli.github.com), `gh auth login`)*.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/02-add-session.jpg" alt="Add Session dialog" width="49%"> <img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/02-new-project.jpg" alt="New project: folder, git and GitHub repo in one go" width="49%"></p>

▶ [Video: New project in one go](https://pominal.com/video/player.html?l=en&v=newproj#share-en)

### 3. Use it on your phone

Sessions keep running on your PC; the phone is just another window into them. Scan the QR on the same Wi-Fi, or anywhere over a private Cloudflare link. The phone gets its own layout: session tabs on top, one session at a time, big buttons, drag the terminal to scroll back.

> ⚠️ Anyone with that QR or link can run commands on your PC — PowerTerminal asks you to confirm before it shows it. Share it only with people you trust.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/03-phone-qr.jpg" alt="QR with the security warning" width="62%"> <img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/03-phone.jpg" alt="PowerTerminal on a phone" width="22%"></p>

▶ [Video: Continue on your phone](https://pominal.com/video/player.html?l=en&v=phone#share-en) · [Using it on a phone](https://pominal.com/video/player.html?l=en&v=m-start#share-en)

### 4. Faster requests

- **💬 One-click words** — `Continue`, `Done?`, `Did it`, `You do it`, `1` `2` `3` … send in one tap; add your own with ＋
- **Paste or drop anything** — images and long text become small chips (`[Image #1]`, `[Text #1 · 597 chars]`) and go out with the request
- **🎤 Voice input** — speak, check the text, send
- **📜 Requests** — everything you sent, with a status stamp (⏳ running · ✅ done · ⛔ stopped); click one to jump to that spot in the terminal. Your own requests are highlighted in the terminal, so you can find them between walls of output
- **⛔ Cancel** — one tap stops the request in progress

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/04-requests.jpg" alt="Request box and the request history panel" width="340"></p>

▶ [Video: Faster requests](https://pominal.com/video/player.html?l=en&v=input#share-en) · [Photo and voice requests on a phone](https://pominal.com/video/player.html?l=en&v=m-input#share-en)

### 5. Memo pad & Q&A log

A memo pad per project folder, the same on PC and phone (stored on your PC in `~/.powerterminal`).

- **New memos** — jot ideas; **Send** turns a memo into a request, and it moves itself to *Done* when the work finishes
- **Questions & answers** — start a request with "Question…" and the AI's answer is saved here
- **Requests you sent** — the full, searchable log for the project; export to Excel

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/05-memo.jpg" alt="Memo pad with notes, Q&A and the request log" width="820"></p>

▶ [Video: Memo pad & Q&A log](https://pominal.com/video/player.html?l=en&v=memo#share-en)

### 6. Note mode

Read a long conversation page by page, like a book: each request with the AI's answer, the work it did and the files it changed. It remembers your page, and you can search, change the text size, export the whole thing, paste images and ask the session right from the page. On a phone, swipe down to search and touch the text with two fingers to have it read aloud.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/06-note-mode.jpg" alt="Note mode on a PC" width="66%"> <img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/06-note-mode-phone.jpg" alt="Note mode on a phone" width="22%"></p>

▶ [Video: Note mode](https://pominal.com/video/player.html?l=en&v=book#share-en) · [Note mode on a phone](https://pominal.com/video/player.html?l=en&v=m-book#share-en)

### 7. Auto-run

Send a request to a session **at a set time**, **on an interval**, or **the moment your usage limit resets** — so long jobs carry on while you sleep. It waits while the session is busy, and watching costs no AI usage. Open it from **⏱ Auto-run** in the header.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/07-auto-run.jpg" alt="Auto-run page" width="820"></p>

▶ [Video: Auto-run](https://pominal.com/video/player.html?l=en&v=auto#share-en)

### 8. A real browser for the AI

Press 🌐 on a session and its AI gets its own Chrome: it reads pages, clicks, types and checks the result itself. *Normal window* keeps sign-ins for next time; *Incognito window* is wiped when it closes. Each tab title carries the session's name, and you can write rules the AI must follow (e.g. "ask before paying or sending").

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/08-ai-browser.jpg" alt="Choosing the AI browser for a session" width="820"></p>

▶ [Video: Let the AI use a browser](https://pominal.com/video/player.html?l=en&v=browser#share-en)

### 9. Login vault

Save a login once. When the AI reaches a login page it only says the login's *name*; PowerTerminal checks the page is really on the saved address and types the username and password itself — the AI never sees the password, and a fake login page gets nothing. Passwords are encrypted on your PC. **⬇ Import from Chrome** brings in your Chrome passwords (all at once or one by one) from Chrome's own export file.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/09-login-vault.jpg" alt="Login vault" width="820"></p>

▶ [Video: Login vault](https://pominal.com/video/player.html?l=en&v=vault#share-en)

### 10. On-screen helper

Not sure how to use what the AI just built? Ask the session to *guide you with the helper*: a pointer and a speech bubble walk you through each step — in your own browser or on the desktop — and move on as you do it. **Stuck?** Type in the bubble ("I can't see a green box") and press Enter: it goes to that session together with the step you're on, so the AI can look again and fix the guide. Windows; install it with **🧭 Install helper** in the header (also works on another PC that opens your PowerTerminal).

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/10-helper.png" alt="Helper bubble with the ask box" width="323"></p>

▶ [Video: On-screen helper](https://pominal.com/video/player.html?l=en&v=helper#share-en)

### 11. Code editor

Open a project as a small IDE: the session on the left, the file tree on the right, the editor in the middle. Search across files, preview the page, open it in a new window, and save — while the AI keeps working next to you.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/11-code-editor.jpg" alt="Code editor with the session beside it" width="820"></p>

▶ [Video: Code editor](https://pominal.com/video/player.html?l=en&v=code#share-en)

### 12. Upload to GitHub

The line under each terminal shows the branch and how many files changed. Right-click it → **Upload to GitHub (pull request)**: PowerTerminal commits, pushes and opens the pull request, with a progress bar. It stops if a secret file (keys, `.env`, cookies) is about to go up.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/12-github.jpg" alt="Upload to GitHub menu" width="820"></p>

▶ [Video: Upload to GitHub](https://pominal.com/video/player.html?l=en&v=git#share-en)

### 13. Mind map & schedule

Plan on a mind map: drag to move, add branches in eight directions, connect nodes, copy and paste. The to-do list sits on the left, and the **Schedule** tab is a calendar you can subscribe to from Google Calendar or your phone.

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/13-mind-map.jpg" alt="Mind map with a to-do list" width="820"></p>

▶ [Video: Mind map](https://pominal.com/video/player.html?l=en&v=mind#share-en)

### 14. Status, alerts & usage

- **Usage bars** — your Claude plan usage (session / weekly) with time left until reset, the same numbers as the official app
- **🔊 Done alerts** — turn on the speaker and each finished session is announced: a chime, then "session two done"
- **Memory meter** — how much RAM is left, under the logo
- **10 languages** — English, 한국어, 日本語, 中文, Español, Deutsch, Français, Português, Русский, हिन्दी

<p align="center"><img src="https://raw.githubusercontent.com/1215kkm/powerterminal-site/main/shots/features/14-header.png" alt="Header with usage bars and buttons" width="820"></p>

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
