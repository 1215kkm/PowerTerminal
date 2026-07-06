@echo off
cd /d "%~dp0"
start /min "CommandCenter" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:7777/?token=03d94773"
