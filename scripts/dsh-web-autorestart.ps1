# Self-contained DSH Web auto-restart: kill the 3080 listener, wait for the
# port to free, relaunch `apps/cli/lib/bin.js web`, and poll until ready.
# Designed to run as an independent process (Start-Process -WindowStyle Hidden)
# so it completes even when the current GUI session dies with the old host.
# Writes a machine-readable result to logs/restart-result.json.

$ErrorActionPreference = 'Stop'
$root = 'D:\DeepSeek-Harness'
$resultPath = Join-Path $root 'logs\restart-result.json'
$logPath = Join-Path $root 'logs\dsh-web-autorestart.log'

function Write-Log([string]$msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Add-Content -Path $logPath -Value $line -Encoding utf8
}

function Find-PortPid([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { return $conn.OwningProcess }
  return $null
}

$started = Get-Date
$result = @{ ok = $false; oldPid = $null; newPid = $null; port = 3080; startedAt = $started.ToString('o') }

try {
  # 1. Find and kill the current 3080 listener.
  $oldPid = Find-PortPid 3080
  $result.oldPid = $oldPid
  Write-Log "old listener pid=$oldPid"
  if ($oldPid) {
    Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
    Write-Log "stopped $oldPid"
  }

  # 2. Wait for the port to free (up to 30s).
  $deadline = (Get-Date).AddSeconds(30)
  while ((Find-PortPid 3080) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $still = Find-PortPid 3080
  if ($still) { throw "port 3080 still held by pid $still after 30s" }
  Write-Log 'port 3080 free'

  # 3. Relaunch the web host detached from this script's console.
  $proc = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentList @('apps/cli/lib/bin.js', 'web') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru
  $result.newPid = $proc.Id
  Write-Log "launched new host pid=$($proc.Id)"

  # 4. Poll until the port listens again (up to 60s).
  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $pid2 = Find-PortPid 3080
    if ($pid2) { $ready = $true; $result.newPid = $pid2; break }
  }
  if (-not $ready) { throw 'new host did not bind port 3080 within 60s' }
  $result.ok = $true
  Write-Log "ready on 3080 pid=$($result.newPid)"
} catch {
  $result.error = $_.Exception.Message
  Write-Log "FAILED: $($_.Exception.Message)"
}

$result.finishedAt = (Get-Date).ToString('o')
$result | ConvertTo-Json | Set-Content -Path $resultPath -Encoding utf8
Write-Log "result ok=$($result.ok)"
