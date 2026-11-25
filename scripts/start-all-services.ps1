[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$NoDocChat,
  [switch]$NoWorkbench,
  [switch]$NoBridge,
  [switch]$NoDeid,
  [switch]$NoModels,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\project\company\ec-clinical-dsh'
$Node = 'D:\package\Nvm\nodejs\node.exe'
$LlamaServer = 'D:\llm\llama\llama-server.exe'
$DocModel = 'D:\llm\Qwen3-4B-Q4_K_M.gguf'
$BridgeDir = Join-Path $Root '.runtime\wuxigpt-bridge'
$LogDir = Join-Path $Root '.runtime\service-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-Port([int]$Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-IfMissing([string]$Name, [int]$Port, [scriptblock]$Start) {
  if (Test-Port $Port) {
    Write-Host "[skip] $Name already listening on $Port" -ForegroundColor DarkYellow
    return
  }
  Write-Host "[start] $Name ($Port)"
  & $Start
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-Port $Port) {
      Write-Host "[ ok ] $Name listening on $Port" -ForegroundColor Green
      return
    }
  } while ((Get-Date) -lt $deadline)
  throw "$Name did not start listening on port $Port within $TimeoutSeconds seconds. Check $LogDir."
}

if (-not $NoModels) {
  Start-IfMissing '脱敏模型 8817' 8817 {
    $modelPidFile = 'D:\local-llm\logs\server.pid'
    if (Test-Path $modelPidFile) {
      Remove-Item -Force $modelPidFile
    }
    Start-Process -WindowStyle Hidden -WorkingDirectory 'D:\local-llm' -FilePath 'cmd.exe' `
      -ArgumentList '/c', 'D:\local-llm\scripts\start_server.cmd', 'fast' `
      -RedirectStandardOutput (Join-Path $LogDir 'model-8817.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'model-8817.err.log') | Out-Null
  }
  if (-not $NoDocChat) {
    if (-not (Test-Path $LlamaServer)) { throw "文档问答模型启动程序不存在: $LlamaServer" }
    if (-not (Test-Path $DocModel)) { throw "文档问答模型不存在: $DocModel" }
    Start-IfMissing '文档问答模型 8080' 8080 {
      Start-Process -WindowStyle Hidden -WorkingDirectory 'D:\llm' -FilePath $LlamaServer `
        -ArgumentList '-m', $DocModel, '-t', '4', '-tb', '4', '-c', '8192', '--parallel', '1', '--host', '127.0.0.1', '--port', '8080', '-ngl', '0', '--jinja' `
        -RedirectStandardOutput (Join-Path $LogDir 'doc-chat-8080.out.log') `
        -RedirectStandardError (Join-Path $LogDir 'doc-chat-8080.err.log') | Out-Null
    }
  }
}

if (-not $NoBridge) {
  Start-IfMissing 'WorkMate 桥接 8787' 8787 {
    if (-not (Test-Path (Join-Path $BridgeDir 'server.mjs'))) { throw '找不到 WorkMate bridge server.mjs' }
    Start-Process -WindowStyle Hidden -WorkingDirectory $BridgeDir -FilePath $Node `
      -ArgumentList '--use-system-ca', (Join-Path $BridgeDir 'server.mjs') `
      -RedirectStandardOutput (Join-Path $LogDir 'bridge-8787.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'bridge-8787.err.log') | Out-Null
  }
}

if (-not $NoWorkbench) {
  Start-IfMissing 'DSH 控制面 3096' 3096 {
    Start-Process -WindowStyle Hidden -WorkingDirectory $Root -FilePath 'powershell.exe' `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root '.runtime\start-control.ps1') `
      -RedirectStandardOutput (Join-Path $LogDir 'control-3096.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'control-3096.err.log') | Out-Null
  }
  Start-IfMissing 'DSH 工作台 WebUI 3095' 3095 {
    Start-Process -WindowStyle Hidden -WorkingDirectory $Root -FilePath 'powershell.exe' `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root '.runtime\start-web-current.ps1') `
      -RedirectStandardOutput (Join-Path $LogDir 'web-3095.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'web-3095.err.log') | Out-Null
  }
}

if (-not $NoDeid) {
  Start-IfMissing '脱敏工作台 8818' 8818 {
    $deid = 'D:\local-llm\tools\deid\ui.mjs'
    if (-not (Test-Path $deid)) { throw "脱敏工作台入口不存在: $deid" }
    Start-Process -WindowStyle Hidden -WorkingDirectory 'D:\local-llm\tools\deid' -FilePath $Node `
      -ArgumentList $deid `
      -RedirectStandardOutput (Join-Path $LogDir 'deid-8818.out.log') `
      -RedirectStandardError (Join-Path $LogDir 'deid-8818.err.log') | Out-Null
  }
}

Write-Host "`n服务启动完成。日志目录: $LogDir" -ForegroundColor Cyan
Write-Host '地址:'
@(
  'http://127.0.0.1:8818/',
  'http://127.0.0.1:8817/health',
  'http://127.0.0.1:8787/health',
  'http://127.0.0.1:3096/',
  'http://127.0.0.1:3095/',
  'http://127.0.0.1:8080/health'
) | ForEach-Object { Write-Host "  $_" }
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8818/' }
