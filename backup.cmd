@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" tools\backup.mjs
) else (
  node tools\backup.mjs
)
pause
