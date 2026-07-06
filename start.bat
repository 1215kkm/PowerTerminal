@echo off
cd /d "%~dp0"
echo [PowerTerminal] checking for updates...
git pull --ff-only 2>nul
call npm install --silent 2>nul

rem create desktop shortcut on first run
if not exist "%USERPROFILE%\Desktop\PowerTerminal.lnk" (
  powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $l=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\PowerTerminal.lnk'); $l.TargetPath='%~dp0start.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='C:\Windows\System32\shell32.dll,18'; $l.Save()" 2>nul
)

start /min "PowerTerminal" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:7777/"
