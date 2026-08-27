@echo off
setlocal
rem --- Run from a copy in TEMP, so a self-update cannot rewrite the script that is executing.
rem     cmd re-reads a .bat from disk line by line, by byte offset. When git replaces start.bat
rem     mid-run the next line is read from the wrong offset and the launcher runs garbage and dies
rem     ("'shell' is not recognized" and similar) - from the outside that looks like it simply
rem     refused to start, with no reason shown anywhere.
if defined PT_CHILD goto RUN
set "PT_CHILD=1"
set "PT_APP=%~dp0"
copy /y "%~f0" "%TEMP%\pt-launch.bat" >nul 2>nul
if not exist "%TEMP%\pt-launch.bat" goto RUN
cmd /c ""%TEMP%\pt-launch.bat" %*"
exit /b
:RUN
if not defined PT_APP set "PT_APP=%~dp0"
set "APP=%PT_APP%"
cd /d "%APP%"
title PowerTerminal

if "%~1"=="waitopen" goto WAITOPEN

rem --- every run appends to a log, so a window that closes on its own still leaves the reason behind ---
set "PTLOG=%USERPROFILE%\.powerterminal\start.log"
if not exist "%USERPROFILE%\.powerterminal" mkdir "%USERPROFILE%\.powerterminal" >nul 2>nul
>>"%PTLOG%" echo.
>>"%PTLOG%" echo ==== %date% %time%  start from %APP%

rem --- Downloads collects duplicate copies (PowerTerminal (1), (2)...) and gets auto-cleaned ---
set "DL=%USERPROFILE%\Downloads\"
call set "REST=%%APP:%DL%=%%"
if /i not "%REST%"=="%APP%" call :DLWARN

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
rem force-match remote so a dirty tree (autocrlf churn etc.) never blocks the update. gitignored data is untouched.
git fetch --depth 1 origin main >nul 2>nul
git reset --hard FETCH_HEAD >nul 2>nul
goto AFTERUP

:ZIPUP
rem No git installed: fall back to overlaying the latest release ZIP (Node/PowerShell only).
where powershell >nul 2>nul && powershell -NoProfile -ExecutionPolicy Bypass -File "%APP%update.ps1"
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
rem If the shortcut points at a folder that no longer exists (this folder was moved), repoint it here.
if exist "%USERPROFILE%\Desktop\PowerTerminal.lnk" powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $p=[Environment]::GetFolderPath('Desktop')+'\PowerTerminal.lnk'; $l=$ws.CreateShortcut($p); if(-not (Test-Path $l.TargetPath)){ $l.TargetPath='%APP%start.bat'; $l.WorkingDirectory='%APP%'; $l.Save(); Write-Host '  Desktop shortcut now points at this folder.' }" 2>nul
if not exist "%USERPROFILE%\Desktop\PowerTerminal.lnk" powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $l=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\PowerTerminal.lnk'); $l.TargetPath='%APP%start.bat'; $l.WorkingDirectory='%APP%'; $l.IconLocation='C:\Windows\System32\shell32.dll,18'; $l.Save()" 2>nul

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set PTVER=%%v

rem --- if already running on 7777, don't start a second node ---
netstat -an | findstr ":7777" | findstr /i "LISTENING" >nul 2>nul
if errorlevel 1 goto PORTFREE
if /i "%~1"=="restart" exit /b

rem --- The port is taken. Healthy PowerTerminal, or a frozen one still holding it? A frozen server
rem     answers nothing, so the launcher used to open the browser at a dead page and quit silently -
rem     from the outside that looks like "it just will not start". Ask the server itself, with a timeout.
set "PTPID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr /i "LISTENING"') do if not defined PTPID set "PTPID=%%a"
set "PING=%TEMP%\pt-ping.txt"
del "%PING%" >nul 2>nul
where curl >nul 2>nul && curl -s -m 5 "http://localhost:7777/api/ping?fmt=txt" -o "%PING%" >nul 2>nul
if not exist "%PING%" powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://localhost:7777/api/ping?fmt=txt' -TimeoutSec 5 -UseBasicParsing).Content|Out-File -Encoding ascii '%PING%'}catch{}" >nul 2>nul
findstr /c:"PT-OK" "%PING%" >nul 2>nul
if errorlevel 1 goto STUCK
echo   PowerTerminal is already running - opening the browser only.
for /f "usebackq delims=" %%v in ("%PING%") do echo      %%v
>>"%PTLOG%" echo   already running and healthy
call :OPENCHROME
exit /b

:STUCK
echo.
echo   [!] Port 7777 is taken, but nothing answers there.
echo       PowerTerminal is frozen, or another program holds the port.
echo       ^(This is why starting it seemed to do nothing at all.^)
echo.
if not defined PTPID goto STUCKNOPID
for /f "tokens=1 delims=," %%a in ('tasklist /FI "PID eq %PTPID%" /FO CSV /NH 2^>nul') do echo       holder: %%~a  ^(PID %PTPID%^)
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=%PTPID%').CommandLine" 2^>nul`) do echo       started as: %%p
>>"%PTLOG%" echo   port busy, no answer, holder PID %PTPID%
echo.
set /p k="   Force-close it and start a fresh one? (Y/N): "
if /i not "%k%"=="Y" (
  echo       Left running. Log: %PTLOG%
  pause
  exit /b
)
taskkill /PID %PTPID% /F >nul 2>nul
>>"%PTLOG%" echo   killed PID %PTPID%
timeout /t 2 /nobreak >nul
echo   Closed it. Starting fresh...
goto PORTFREE

:STUCKNOPID
echo       Could not identify the process holding the port.
echo       Restart the PC, or run PowerTerminal on another port:  set PORT=7788 ^&^& node server.js
>>"%PTLOG%" echo   port busy, holder unknown
echo.
pause
exit /b

:PORTFREE

echo   Starting PowerTerminal v%PTVER% ...
rem open the browser once the server responds. Skipped after a restart - the existing tab reloads itself.
if /i not "%~1"=="restart" (
  start "" /min cmd /c call "%APP%start.bat" waitopen
)

node server.js
set EC=%errorlevel%
if "%EC%"=="75" (
  rem 75 = restart requested (update banner). Relaunch as a fresh process so the just-updated
  rem      start.bat is read cleanly from disk (a running .bat can misbehave if it edits itself).
  echo   Update requested - restarting with the latest version...
  set "PT_CHILD="
  start "" cmd /c call "%APP%start.bat" restart
  exit /b
)
if not "%EC%"=="0" (
  echo.
  echo   === Server stopped ^(exit code %EC%^) - the reason is printed above. ===
  echo   === This run was also logged to: %PTLOG% ===
  >>"%PTLOG%" echo   server exited with code %EC%
  pause
)
exit /b

:WAITOPEN
set /a _t=0
:WAITSRV
netstat -an | findstr ":7777" | findstr /i "LISTENING" >nul 2>nul
if not errorlevel 1 goto SRVUP
set /a _t+=1
if %_t% geq 30 goto SRVUP
timeout /t 1 /nobreak >nul
goto WAITSRV
:SRVUP
call :OPENCHROME
exit /b

:OPENCHROME
rem Chrome as a standalone app window (no tab bar) so PowerTerminal looks and behaves like its own
rem program - and every "open in a new window" from inside it becomes a separate window too.
rem Set PT_TAB=1 before running to get a normal browser tab instead.
set "PF86=%ProgramFiles(x86)%"
set "CHROME="
for %%p in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%PF86%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do @if not defined CHROME @if exist "%%~p" set "CHROME=%%~p"
if not defined CHROME ( start "" "http://localhost:7777/" & exit /b )
if "%PT_TAB%"=="1" ( start "" "%CHROME%" --new-window http://localhost:7777/ ) else ( start "" "%CHROME%" --app=http://localhost:7777/ )
exit /b


:DLWARN
echo.
echo   [!] This copy is running from your Downloads folder:
echo       %APP%
echo       Downloads fills up with duplicate copies and gets auto-cleaned, so the copy you
echo       start may not be the one you think. Move this folder somewhere permanent
echo       ^(for example C:\PowerTerminal^) and run start.bat from there. Your sessions and
echo       settings live in %USERPROFILE%\.powerterminal and are not affected by the move.
>>"%PTLOG%" echo   [!] running from Downloads
echo.
exit /b
