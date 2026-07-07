#!/bin/bash
# PowerTerminal launcher for macOS / Linux — double-click (macOS) or run: ./start.command
cd "$(dirname "$0")" || exit 1
echo "[PowerTerminal] Updating..."
# if this was a ZIP download (no .git) but git exists, wire it up once so it can auto-update.
# gitignored files (config.json, sessions.json, node_modules...) are untracked and preserved.
if [ ! -d .git ] && command -v git >/dev/null 2>&1; then
  echo "  Enabling auto-update (one-time setup)..."
  git init -q
  git remote add origin https://github.com/1215kkm/PowerTerminal.git
  git fetch --depth 1 origin main >/dev/null 2>&1
  git reset --hard origin/main >/dev/null 2>&1
  git branch -M main >/dev/null 2>&1
fi
git pull --ff-only >/dev/null 2>&1

openurl(){ command -v open >/dev/null 2>&1 && open "$1" || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$1"); }

# --- Node.js check (the app runs on Node, so it can't install Node itself; but we help) ---
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [!] Node.js is not installed - PowerTerminal needs it to run."
  if command -v brew >/dev/null 2>&1; then
    read -p "  Homebrew found. Install Node.js now with 'brew install node'? (Y/n): " a
    case "$a" in n|N) : ;; *) echo "  Installing Node.js via Homebrew..."; brew install node ;; esac
  else
    read -p "  Open the Node.js download page in your browser? (Y/n): " a
    case "$a" in n|N) : ;; *) openurl "https://nodejs.org/en/download" ;; esac
    echo "      Install Node.js (LTS), then run this again."
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "      Node.js still not found - install it, then double-click start.command again."
    read -p "  Press Enter to exit..." _
    exit 1
  fi
fi

npm install --silent >/dev/null 2>&1

# --- Claude Code check (installable via npm now that Node exists) ---
if ! command -v claude >/dev/null 2>&1; then
  echo
  read -p "  Claude Code is not installed. Install it now with npm? (y/N): " c
  case "$c" in
    y|Y) echo "  Installing Claude Code... this can take a minute."; npm install -g @anthropic-ai/claude-code ;;
  esac
fi

# open the browser shortly after the server starts, then run the server in the foreground
( sleep 2; (command -v open >/dev/null 2>&1 && open "http://localhost:7777/") || (command -v xdg-open >/dev/null 2>&1 && xdg-open "http://localhost:7777/") ) &
node server.js
