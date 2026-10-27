@echo off
rem ================================================================
rem  PowerTerminal - everyday launcher for the ROUTINES build
rem  (branch feature/routines, main already merged in)
rem
rem  Runs on the normal address http://localhost:7777 with the normal
rem  data folder %USERPROFILE%\.powerterminal, so every session, memo,
rem  login vault entry and account window stays exactly as it was.
rem
rem  Unlike start.bat it never runs "git fetch / reset --hard":
rem  that would wipe this branch back to main and the routines with it.
rem  Updates are pulled in by merging main into this branch on purpose.
rem ================================================================
setlocal
cd /d "%~dp0"
title PowerTerminal (routines)
if "%~1"=="waitopen" goto WAITOPEN
set "PT_DATA_DIR="
set "PORT="
set "PT_BROWSER_PORT="
set "PT_CDP_PROXY_PORT="
set "PT_NO_TUNNEL="
netstat -an | findstr ":7777" | findstr /i "LISTENING" >nul 2>nul
if errorlevel 1 goto RUN
if /i "%~1"=="restart" goto RUN
echo   PowerTerminal is already running - opening the browser only.
call :OPENCHROME
exit /b
:RUN
for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BR=%%b"
echo.
echo   PowerTerminal (routines build) - branch: %BR%
echo   http://localhost:7777   data: %USERPROFILE%\.powerterminal
echo.
if /i not "%~1"=="restart" start "" /min cmd /c call "%~f0" waitopen
node server.js
set EC=%errorlevel%
if "%EC%"=="75" (
  echo   Restart requested - starting again...
  start "" cmd /c call "%~f0" restart
  exit /b
)
if not "%EC%"=="0" (
  echo.
  echo   === Server stopped ^(exit code %EC%^) - the reason is printed above. ===
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
set "PF86=%ProgramFiles(x86)%"
set "CHROME="
for %%p in ("%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%PF86%\Google\Chrome\Application\chrome.exe" "%LocalAppData%\Google\Chrome\Application\chrome.exe") do @if not defined CHROME @if exist "%%~p" set "CHROME=%%~p"
if not defined CHROME ( start "" "http://localhost:7777/" & exit /b )
if "%PT_TAB%"=="1" ( start "" "%CHROME%" --new-window http://localhost:7777/ ) else ( start "" "%CHROME%" --app=http://localhost:7777/ )
exit /b
