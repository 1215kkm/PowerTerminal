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
    y|Y)
      # On macOS npm's global folder is /usr/local/lib/node_modules, owned by root, so `npm install -g`
      # fails with EACCES. Letting it fail first buries the screen in npm's error dump before we recover,
      # so check whether that folder is actually writable and pick the right target up front.
      gp=$(npm config get prefix 2>/dev/null)
      if [ -n "$gp" ] && [ -w "$gp/lib/node_modules" ] 2>/dev/null; then
        echo "  Installing Claude Code... this can take a minute."
        npm install -g @anthropic-ai/claude-code || echo "  [!] Install failed. Try manually:  npm install -g @anthropic-ai/claude-code"
      else
        # No permission for the system-wide folder — install into the user's home instead of asking a
        # double-clicked script for sudo.
        echo "  Installing Claude Code into your home folder (~/.npm-global)... this can take a minute."
        npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1
        export PATH="$HOME/.npm-global/bin:$PATH"
        if npm install -g @anthropic-ai/claude-code; then
          # Keep it on PATH for future terminals too, so PowerTerminal's sessions can find `claude`.
          for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
            [ -e "$rc" ] || continue
            grep -q '.npm-global/bin' "$rc" 2>/dev/null || printf '\n# added by PowerTerminal\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> "$rc"
          done
          echo "  Installed. (added ~/.npm-global/bin to your PATH)"
        else
          echo "  [!] Install failed. Try manually:  npm install -g @anthropic-ai/claude-code"
        fi
      fi
      ;;
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

  # PowerTerminal's own dependencies. This was fully silenced, which hid the one failure that matters:
  # node-pty ships prebuilt binaries per Node version, and on a brand-new Node there may be none yet, so npm
  # falls back to compiling — which needs Xcode Command Line Tools on macOS. When that fails the app used to
  # start anyway and die later with a confusing module error. Say it plainly and stop instead.
  if ! npm install --silent >/tmp/pt-npm-$$.log 2>&1; then
    echo
    echo "  [!] Could not install PowerTerminal's dependencies."
    tail -n 15 "/tmp/pt-npm-$$.log" 2>/dev/null | sed 's/^/      /'
    echo
    if [ "$(uname)" = "Darwin" ]; then
      echo "      Most often this is a missing compiler. Run this once, then start again:"
      echo "        xcode-select --install"
    fi
    echo "      Node version in use: $(node -v 2>/dev/null)"
    echo "      A very new Node release can also be the cause — Node LTS is the safe choice."
    rm -f "/tmp/pt-npm-$$.log"
    read -p "  Press Enter to close..." _
    exit 1
  fi
  rm -f "/tmp/pt-npm-$$.log"

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
  # macOS ships a 256 file-descriptor limit per process. PowerTerminal holds one pty per session plus
  # sockets and short-lived git/gh/ccusage processes, and once it runs out every spawn fails with EBADF.
  # Raise it as high as the system allows before starting; harmless where the limit is already high.
  ulimit -n 4096 2>/dev/null || ulimit -n unlimited 2>/dev/null || true
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
