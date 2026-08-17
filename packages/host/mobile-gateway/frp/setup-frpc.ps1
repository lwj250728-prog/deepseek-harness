# setup-frpc.ps1 — one-shot frpc (client) setup on this Windows machine.
# Downloads the frp Windows build, writes frpc.toml pointing at your frps
# server, starts frpc (optionally as a scheduled task for auto-start), and
# verifies the tunnel with a local probe round-trip.
#
# Usage:
#   .\setup-frpc.ps1 -ServerIp 1.2.3.4 -Token <same-token-as-frps> [-RemotePort 4080] [-LocalPort 4080] [-AutoStart]
#
# The frps side must already be running (see frp/README.md and install-frps.sh).

param(
    [Parameter(Mandatory = $true)][string]$ServerIp,
    [Parameter(Mandatory = $true)][string]$Token,
    [int]$ServerPort = 7000,
    [int]$RemotePort = 4080,
    [int]$LocalPort = 4080,
    [string]$Version = 'v0.61.1',
    [string]$WorkDir = (Join-Path $env:LOCALAPPDATA 'dsh-mobile-frp'),
    [switch]$AutoStart,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$frpDir = Join-Path $WorkDir "frp_$($Version.Substring(1))_windows_amd64"
$frpcExe = Join-Path $frpDir 'frpc.exe'
$configPath = Join-Path $WorkDir 'frpc.toml'

if (-not (Test-Path $frpcExe)) {
    Write-Host "==> downloading frp $Version (Windows amd64)..."
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $zip = Join-Path $WorkDir "frp_$($Version.Substring(1))_windows_amd64.zip"
    $url = "https://github.com/fatedier/frp/releases/download/$Version/frp_$($Version.Substring(1))_windows_amd64.zip"
    # curl -4 with retries is far more reliable than Invoke-WebRequest for the
    # GitHub asset CDN on flaky networks (IPv4 + resume + retry).
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -4 -L --retry 5 --retry-delay 3 --connect-timeout 15 -o $zip $url
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zip)) { throw "download failed: $url" }
    } else {
        Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
    }
    Expand-Archive -Path $zip -DestinationPath $WorkDir -Force
}
Write-Host "==> frpc: $frpcExe"

@"
serverAddr = "$ServerIp"
serverPort = $ServerPort
auth.token = "$Token"
log.to = '$WorkDir\frpc.log'
log.level = "info"

[[proxies]]
name = "dsh-mobile"
type = "tcp"
localIP = "127.0.0.1"
localPort = $LocalPort
remotePort = $RemotePort
"@ | Set-Content -Path $configPath -Encoding ascii
Write-Host "==> config written: $configPath"

# Validate the config with frp's own verifier before starting.
& $frpcExe verify -c $configPath
if ($LASTEXITCODE -ne 0) { throw 'frpc config verification failed' }
Write-Host '==> config verified (frpc verify)'

if ($AutoStart) {
    # Register a scheduled task that starts frpc at logon.
    $action = New-ScheduledTaskAction -Execute $frpcExe -Argument "-c `"$configPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName 'DSH Mobile frpc' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host '==> scheduled task "DSH Mobile frpc" registered (auto-start at logon)'
}

Write-Host '==> starting frpc...'
$process = Start-Process -FilePath $frpcExe -ArgumentList "-c `"$configPath`"" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
if ($process.HasExited) {
    Write-Host "ERROR: frpc exited early (code $($process.ExitCode)) — check $WorkDir\frpc.log and the token/server."
    exit 1
}
Write-Host "==> frpc running (PID $($process.Id))"

if (-not $SkipVerify) {
    # Probe: frps -> tunnel -> this local port. If the gateway is up, the
    # remote port answers with the gateway's health JSON.
    try {
        $health = Invoke-RestMethod "http://$ServerIp`:$RemotePort/__mobile/health" -TimeoutSec 10
        Write-Host "==> tunnel verified: http://$ServerIp`:$RemotePort/__mobile/health -> $($health | ConvertTo-Json -Compress)"
    } catch {
        Write-Host "==> NOTE: tunnel probe failed from here (frpc may still be connecting): $($_.Exception.Message)"
        Write-Host "    If frps just started, wait a few seconds and re-check:"
        Write-Host "    Invoke-RestMethod http://$ServerIp`:$RemotePort/__mobile/health"
    }
}

Write-Host ''
Write-Host '==> done. Phones use:'
Write-Host "    http://$ServerIp`:$RemotePort/   (login with gateway user + token)"
Write-Host '    For HTTPS without warnings, add Caddy on the server (see frp/README.md).'
