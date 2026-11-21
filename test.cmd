@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" tools\check.mjs
  if errorlevel 1 goto end
  "%~dp0runtime\node.exe" --test tests\*.test.mjs
) else (
  node tools\check.mjs
  if errorlevel 1 goto end
  node --test tests\*.test.mjs
)
:end
pause
