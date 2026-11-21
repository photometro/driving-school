$ErrorActionPreference = 'Stop'
$applicationRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $applicationRoot 'work\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host '没有找到项目运行记录。若在启动窗口中运行，请在该窗口按 Ctrl+C。'
    exit 0
}
$pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($pidText -notmatch '^\d+$') { throw '运行记录无效，未停止任何进程。' }
$serverProcessId = [int]$pidText
$serverProcess = Get-Process -Id $serverProcessId -ErrorAction SilentlyContinue
if (-not $serverProcess) { Write-Host '系统当前未运行。'; exit 0 }
$expectedExecutable = Join-Path $applicationRoot 'runtime\node.exe'
if ($serverProcess.Path -ne $expectedExecutable) { throw '进程路径与本项目运行时不符，未停止任何进程。' }
Stop-Process -Id $serverProcessId -Force
Write-Host '启程驾校服务已停止。数据保存在项目的 data 文件夹。'
