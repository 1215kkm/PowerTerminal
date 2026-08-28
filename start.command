#!/bin/bash
# PowerTerminal launcher for macOS / Linux — double-click (macOS) or run: ./start.command
cd "$(dirname "$0")" || exit 1

openurl(){ command -v open >/dev/null 2>&1 && open "$1" || (command -v xdg-open >/dev/null 2>&1 && xdg-open "$1"); }

# 창이 스스로 닫혀도 이유가 남게 — 실행할 때마다 한 줄씩 쌓는다
PTLOG="$HOME/.powerterminal/start.log"
mkdir -p "$HOME/.powerterminal" 2>/dev/null
log(){ printf '%s\n' "$1" >>"$PTLOG" 2>/dev/null; }
log ""
log "==== $(date '+%Y-%m-%d %H:%M:%S')  start from $PWD"

# 다운로드 폴더에서 돌리면 사본이 쌓인다 — 맥에서는 "PowerTerminal 2", "PowerTerminal 3" 이 되고
# 브라우저가 받은 파일이라 격리(quarantine) 딱지도 붙는다. 어느 사본이 도는지 헷갈리는 게 진짜 문제.
case "$PWD/" in
  "$HOME/Downloads/"*)
    echo
    echo "  [!] 지금 다운로드 폴더에서 실행 중입니다:"
    echo "      $PWD"
    echo "      받을 때마다 사본이 쌓여(PowerTerminal 2, 3 …) 어느 게 도는지 헷갈리고,"
    echo "      정리 도구가 지우기도 합니다. 한 번만 옮겨 두세요:"
    echo "        mkdir -p ~/Applications && mv \"$PWD\" ~/Applications/PowerTerminal"
    echo "      세션·메모·설정은 ~/.powerterminal 에 따로 있어 옮겨도 그대로입니다."
    log "  [!] running from Downloads"
    echo
    ;;
esac

# This script runs under #!/bin/bash, non-interactively, so it reads no ~/.zshrc or ~/.bash_profile — the
# PATH additions those files carry are simply absent. Claude Code installed into ~/.local/bin was therefore
# invisible here and the launcher asked to install it on every single start, and Homebrew's own bin can be
# missing too when the launcher is opened by double-click. Put the usual places back before anything looks
# for a program.
for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] || continue
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH

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
    # 포트는 잡혀 있다. 멀쩡한 PowerTerminal 인가, 굳은 채 포트만 붙들고 있는 것인가?
    # 굳은 서버는 아무 대답도 못 하는데, 예전에는 그것도 "이미 실행 중" 으로 보고 브라우저만 열어
    # 죽은 화면을 띄우고 끝났다 — 밖에서 보면 "그냥 안 켜진다" 로만 보인다. 서버에게 직접 물어본다.
    PING=$(curl -s -m 5 "http://127.0.0.1:7777/api/ping?fmt=txt" 2>/dev/null)
    case "$PING" in
      PT-OK*)
        if [ "$FIRST_RUN" = "1" ]; then
          echo "  PowerTerminal이 이미 실행 중입니다 — 브라우저만 엽니다."
          echo "     $PING"
          log "  already running and healthy"
          launch_ui
        fi
        break
        ;;
    esac
    HOLDER=$(lsof -iTCP:7777 -sTCP:LISTEN -t 2>/dev/null | head -1)
    echo
    echo "  [!] 7777 포트는 잡혀 있는데 아무 응답이 없습니다."
    echo "      PowerTerminal이 멈췄거나, 다른 프로그램이 그 포트를 쓰고 있습니다."
    echo "      (그래서 실행해도 아무 일도 안 일어나는 것처럼 보였습니다.)"
    echo
    if [ -n "$HOLDER" ]; then
      echo "      붙들고 있는 것: $(ps -p "$HOLDER" -o comm= 2>/dev/null)  (PID $HOLDER)"
      log "  port busy, no answer, holder PID $HOLDER"
      echo
      read -p "  강제 종료하고 새로 시작할까요? (y/N): " k
      case "$k" in
        y|Y)
          kill -9 "$HOLDER" 2>/dev/null
          log "  killed PID $HOLDER"
          sleep 2
          echo "  정리했습니다. 새로 시작합니다..."
          ;;
        *)
          echo "      그대로 두었습니다. 기록: $PTLOG"
          read -p "  Press Enter to close..." _
          exit 0
          ;;
      esac
    else
      echo "      어떤 프로세스인지 확인하지 못했습니다. 다른 포트로 띄우려면:  PORT=7788 node server.js"
      log "  port busy, holder unknown"
      read -p "  Press Enter to close..." _
      exit 0
    fi
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
    echo "  === 서버가 멈췄습니다 (종료 코드 $EC) — 위 메시지에 이유가 있습니다. ==="
    echo "  === 이번 실행 기록: $PTLOG ==="
    log "  server exited with code $EC"
    read -p "  Press Enter to close..." _
  fi
  break
done
