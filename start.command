#!/bin/bash
# PowerTerminal launcher for macOS / Linux — double-click (macOS) or run: ./start.command
cd "$(dirname "$0")" || exit 1
echo "[PowerTerminal] Updating..."
git pull --ff-only >/dev/null 2>&1

# --- Node.js check (the app needs Node to run; it cannot install Node itself) ---
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [!] Node.js is not installed - PowerTerminal needs it to run."
  echo "      Install it, then run this again:"
  echo "        macOS:  brew install node      (or download from https://nodejs.org )"
  echo "        Linux:  use your package manager, or https://nodejs.org"
  echo
  read -p "  Press Enter to exit..." _
  exit 1
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
