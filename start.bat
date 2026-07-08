@echo off
cd /d "%~dp0"
echo [PowerTerminal] Updating...
rem --- self-update. gitignored files (config.json, sessions.json, node_modules...) are always preserved. ---
if exist ".git" goto GITPULL
where git >nul 2>nul && goto GITINIT
goto ZIPUP

:GITINIT
rem ZIP download + git present: wire up the repo once so it can git-pull from now on.
echo   Enabling git auto-update (one-time setup)...
git init -q
git remote add origin https://github.com/1215kkm/PowerTerminal.git
git fetch --depth 1 origin main
git reset --hard origin/main
git branch -M main
git branch --set-upstream-to=origin/main main >nul 2>nul
goto AFTERUP

:GITPULL
git pull --ff-only >nul 2>nul
goto AFTERUP

:ZIPUP
rem No git installed: fall back to overlaying the latest release ZIP (Node/PowerShell only).
where powershell >nul 2>nul && powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
goto AFTERUP

:AFTERUP

rem --- Node.js check (the app cannot install this itself - it needs Node to run) ---
where node >nul 2>nul && goto NODEOK
echo.
echo   [!] Node.js is not installed - PowerTerminal needs it to run.
echo       Get the LTS installer from https://nodejs.org , install it, then run this again.
echo.
set /p n="   Open the download page now? (Y/N): "
if /i "%n%"=="Y" start "" "https://nodejs.org/en/download/prebuilt-installer"
echo.
pause
exit /b
:NODEOK

call npm install --silent >nul 2>nul

rem --- Claude Code check (can be installed via npm now that Node exists) ---
where claude >nul 2>nul && goto CLAUDEOK
echo.
set /p c="   Claude Code is not installed. Install it now with npm? (Y/N): "
if /i "%c%"=="Y" (
  echo   Installing Claude Code... this can take a minute.
  call npm install -g @anthropic-ai/claude-code
)
:CLAUDEOK

rem --- desktop shortcut on first run ---
if not exist "%USERPROFILE%\Desktop\PowerTerminal.lnk" powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $l=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\PowerTerminal.lnk'); $l.TargetPath='%~dp0start.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='C:\Windows\System32\shell32.dll,18'; $l.Save()" 2>nul

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set PTVER=%%v

rem --- if already running on 7777, do not start a second node - just open the browser ---
netstat -an | findstr ":7777" | findstr /i "LISTENING" >nul 2>nul
if errorlevel 1 (
  echo   Starting PowerTerminal v%PTVER% ...
  rem Quit button exits node with code 0 -> window closes. A crash exits non-zero -> pause keeps it visible.
  start "PowerTerminal server" cmd /c "node server.js || pause"
) else (
  echo   PowerTerminal is already running - opening the browser only.
)

rem --- wait up to 30s until the server actually responds (first run can be slow: npm install) ---
set /a _t=0
:WAITSRV
netstat -an | findstr ":7777" | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 goto SRVUP
set /a _t+=1
if %_t% geq 30 goto SRVUP
timeout /t 1 /nobreak >nul
goto WAITSRV
:SRVUP

rem --- open Chrome in app mode (own window) if present, else the default browser ---
set "PF86=%ProgramFiles(x86)%"
set "CHROME="
for %%p in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%PF86%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do @if not defined CHROME @if exist "%%~p" set "CHROME=%%~p"
if defined CHROME ( start "" "%CHROME%" --app=http://localhost:7777/ ) else ( start "" "http://localhost:7777/" )
