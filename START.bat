@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "E:\node.exe" (
  "E:\node.exe" server.js
) else (
  node server.js
)
pause
