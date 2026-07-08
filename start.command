#!/bin/bash
# PowerTerminal launcher for macOS / Linux — double-click (macOS) or run: ./start.command
cd "$(dirname "$0")" || exit 1

openurl(){ command -v open >/dev/null 2>&1 && open "$1" || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$1"); }

# --- Node.js check (one-time; the app can't install this itself) ---
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

# --- Claude Code check (one-time; installable via npm now that Node exists) ---
if ! command -v claude >/dev/null 2>&1; then
  echo
  read -p "  Claude Code is not installed. Install it now with npm? (y/N): " c
  case "$c" in
    y|Y) echo "  Installing Claude Code... this can take a minute."; npm install -g @anthropic-ai/claude-code ;;
  esac
fi

# Chrome in its own new window (a draggable tab), else default browser
launch_ui() {
  url="http://localhost:7777/"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --new-window "$url" >/dev/null 2>&1 && return
  fi
  for c in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then "$c" --new-window "$url" >/dev/null 2>&1 & return; fi
  done
  (command -v open >/dev/null 2>&1 && open "$url") || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$url")
}

FIRST_RUN=1
while true; do
  echo "[PowerTerminal] Updating..."
  # self-update. gitignored files (config.json, sessions.json, node_modules...) are always preserved.
  if [ -d .git ]; then
    # force-match remote so a dirty tree never blocks the update. gitignored data is untouched.
    git fetch --depth 1 origin main >/dev/null 2>&1
    git reset --hard FETCH_HEAD >/dev/null 2>&1
  elif command -v git >/dev/null 2>&1; then
    # ZIP download + git present: wire up the repo once so it can git-pull from now on.
    echo "  Enabling git auto-update (one-time setup)..."
    git init -q
    git remote add origin https://github.com/1215kkm/PowerTerminal.git
    git fetch --depth 1 origin main >/dev/null 2>&1
    git reset --hard origin/main >/dev/null 2>&1
    git branch -M main >/dev/null 2>&1
    git branch --set-upstream-to=origin/main main >/dev/null 2>&1
  else
    # No git: overlay the latest release ZIP (curl + unzip are built into macOS).
    if command -v curl >/dev/null 2>&1 && command -v unzip >/dev/null 2>&1; then
      loc=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)
      latest=$(curl -fsSL https://raw.githubusercontent.com/1215kkm/PowerTerminal/main/banner.json 2>/dev/null | sed -n 's/.*"latestVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
      if [ -n "$latest" ] && [ "$latest" != "$loc" ]; then
        echo "  Updating v$loc -> v$latest ..."
        tmp=$(mktemp -d 2>/dev/null || echo "/tmp/ptupd$$")
        mkdir -p "$tmp"
        if curl -fsSL https://github.com/1215kkm/PowerTerminal/releases/latest/download/PowerTerminal.zip -o "$tmp/pt.zip" 2>/dev/null && unzip -oq "$tmp/pt.zip" -d "$tmp" 2>/dev/null; then
          # overlay tracked files; skip the launcher scripts so we don't overwrite this running file
          if command -v rsync >/dev/null 2>&1; then
            rsync -a --exclude='start.command' --exclude='start.bat' "$tmp/PowerTerminal/" . 2>/dev/null
          else
            cp -R "$tmp/PowerTerminal/." . 2>/dev/null
          fi
          echo "  Updated to v$latest."
        else
          echo "  Update download failed - keeping current version."
        fi
        rm -rf "$tmp"
      fi
    fi
  fi

  npm install --silent >/dev/null 2>&1

  ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -1)

  # 이미 7777에서 실행 중이면 두 번째로 켜지 말고(포트 충돌) 브라우저만 열고 끝
  if command -v lsof >/dev/null 2>&1 && lsof -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; then
    if [ "$FIRST_RUN" = "1" ]; then
      echo "  PowerTerminal이 이미 실행 중입니다 — 브라우저만 엽니다."
      launch_ui
    fi
    break
  fi

  # 첫 실행에서만 브라우저를 새로 연다 — 재시작(업데이트) 후에는 기존 탭이 스스로 새로고침됨
  if [ "$FIRST_RUN" = "1" ]; then
    FIRST_RUN=0
    ( for i in $(seq 1 30); do
        if curl -s -o /dev/null "http://localhost:7777/" 2>/dev/null || (command -v lsof >/dev/null 2>&1 && lsof -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1); then break; fi
        sleep 1
      done
      launch_ui ) &
  fi

  echo "  Starting PowerTerminal v$ver ..."
  node server.js
  EC=$?
  if [ "$EC" = "75" ]; then
    echo "  Update requested - restarting with the latest version..."
    continue
  fi
  if [ "$EC" != "0" ]; then
    echo
    echo "  === Server stopped unexpectedly (exit $EC) - see the message above. ==="
    read -p "  Press Enter to close..." _
  fi
  break
done
