# Self-contained DSH Web auto-restart: kill the 3080 listener, wait for the
# port to free, relaunch `apps/cli/lib/bin.js web`, and poll until ready.
# Designed to run as an independent process (Start-Process -WindowStyle Hidden)
# so it completes even when the current GUI session dies with the old host.
# Writes a machine-readable result to logs/restart-result.json.
#
# Provenance contract (exp_156 lesson): the result records WHO performed the
# restart — this script's own PID and the launched host's PID + parent chain.
# A verifier can then distinguish "this script relaunched it" from "an external
# actor took over", instead of assuming the parent process auto-revived the
# host. The script itself cannot tell them apart, so it records its identity
# and leaves the verdict to the verifier.

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
$scriptPid = $PID
$result = @{
  ok = $false
  oldPid = $null
  newPid = $null
  scriptPid = $scriptPid
  port = 3080
  startedAt = $started.ToString('o')
}

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
  $result.launcherPid = $scriptPid
  Write-Log "launched new host pid=$($proc.Id) by script pid=$scriptPid"

  # 4. Poll until the port listens again (up to 60s). Track the first PID to
  #    bind: if a DIFFERENT pid than ours takes the port, an external actor
  #    intervened (the exp_156 case) — record it instead of claiming success.
  $deadline = (Get-Date).AddSeconds(60)
  $ready = $false
  $boundPid = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $pid2 = Find-PortPid 3080
    if ($pid2) { $boundPid = $pid2; $ready = $true; break }
  }
  if (-not $ready) { throw 'new host did not bind port 3080 within 60s' }
  $result.newPid = $boundPid
  # Provenance verdict: is the bound process OUR child? (parent chain check)
  $bound = Get-CimInstance Win32_Process -Filter "ProcessId=$boundPid" -ErrorAction SilentlyContinue
  $ourChild = $bound -and $bound.ParentProcessId -eq $scriptPid
  $result.selfPerformed = $ourChild
  $result.ok = $true
  Write-Log "ready on 3080 pid=$boundPid ourChild=$ourChild"
} catch {
  $result.error = $_.Exception.Message
  Write-Log "FAILED: $($_.Exception.Message)"
}

$result.finishedAt = (Get-Date).ToString('o')
$result | ConvertTo-Json | Set-Content -Path $resultPath -Encoding utf8
Write-Log "result ok=$($result.ok) selfPerformed=$($result.selfPerformed)"
