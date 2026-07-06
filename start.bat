@echo off
cd /d "%~dp0"
echo [PowerTerminal] checking for updates...
git pull --ff-only 2>nul
call npm install --silent 2>nul
start /min "PowerTerminal" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
for /f "usebackq tokens=2 delims=:," %%t in (`type config.json ^| findstr token`) do set TK=%%t
set TK=%TK:"=%
set TK=%TK: =%
start "" "http://localhost:7777/?token=%TK%"
