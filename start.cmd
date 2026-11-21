@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "OPEN_BROWSER=1"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server\index.mjs
) else (
  node server\index.mjs
)
pause
