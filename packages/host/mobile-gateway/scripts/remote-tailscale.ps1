# remote-tailscale.ps1 — one-click Tailscale onboarding for the mobile gateway.
# Goal: the phone reaches the gateway at http://<tailscale-ip>:4080 over an
# encrypted WireGuard tunnel, with zero port forwarding and zero public exposure.
#
# Usage:
#   .\remote-tailscale.ps1                # install if needed, guide login, print the phone URL
#   .\remote-tailscale.ps1 -Port 4080     # different gateway port
#   .\remote-tailscale.ps1 -CheckOnly     # skip install/login; just verify reachability
#
# What it does:
#   1. installs Tailscale via winget when missing
#   2. runs `tailscale up` (a browser login opens — complete it interactively)
#   3. waits for the tailnet IP, then verifies the gateway health endpoint
#   4. prints the phone steps and a recommended ACL snippet
#
# NOTE: `tailscale up` may ask for admin rights on Windows; the login itself
# happens in your browser with YOUR Tailscale account — this script cannot and
# must not authenticate for you.

param(
    [int]$Port = 4080,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Get-TailscaleExe {
    $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = 'C:\Program Files\Tailscale\tailscale.exe'
    if (Test-Path $candidate) { return $candidate }
    return $null
}

function Get-TailscaleIp([string]$exe) {
    try {
        $ip = & $exe ip -4 2>$null | Select-Object -First 1
        if ($ip -match '^\d+\.\d+\.\d+\.\d+$') { return $ip }
    } catch { }
    return $null
}

$exe = Get-TailscaleExe

if (-not $exe -and -not $CheckOnly) {
    Write-Host '==> Tailscale not found; installing via winget (this may take a minute)...'
    winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
    Start-Sleep -Seconds 3
    $exe = Get-TailscaleExe
}
if (-not $exe) {
    Write-Host 'ERROR: Tailscale is not installed and could not be installed automatically.'
    Write-Host '  Install manually from https://tailscale.com/download then re-run this script.'
    exit 1
}
Write-Host "==> Tailscale: $exe"

$ip = Get-TailscaleIp $exe
if (-not $ip) {
    if ($CheckOnly) {
        Write-Host '==> Not logged in yet; run without -CheckOnly to start the login flow.'
        exit 1
    }
    Write-Host '==> Running `tailscale up` — a browser window will open for you to log in.'
    Write-Host '    (If it asks for admin rights, approve the UAC prompt; the login is YOUR account.)'
    & $exe up
    # Poll until the tailnet IP appears (login can take a while).
    $deadline = (Get-Date).AddMinutes(5)
    while (-not $ip -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $ip = Get-TailscaleIp $exe
    }
}
if (-not $ip) {
    Write-Host 'ERROR: login did not complete in 5 minutes. Run `tailscale up` manually and retry.'
    exit 1
}

Write-Host "==> Tailnet IP: $ip"
Write-Host "==> Gateway health via Tailscale:"
$health = "http://$ip`:$Port/__mobile/health"
try {
    $h = Invoke-RestMethod $health -TimeoutSec 8
    Write-Host "    OK  $health -> $($h | ConvertTo-Json -Compress)"
} catch {
    Write-Host "    FAIL $health — is the gateway plugin mounted? (check: Invoke-RestMethod http://127.0.0.1:$Port/__mobile/health)"
    Write-Host "    Note: no admin/port-forward needed; if the host firewall blocks Tailscale, allow tailscale.exe."
}

Write-Host ""
Write-Host '==> Phone steps:'
Write-Host "    1. Install the Tailscale app on the phone and sign in with the SAME account."
Write-Host "    2. Open http://$ip`:$Port/  and log in with the gateway user + token."
Write-Host "    3. (Optional) browser menu -> Add to Home screen for an app icon."
Write-Host ""
Write-Host '==> Recommended ACL (admin console -> Access controls): restrict which devices may reach this node:'
Write-Host '    {'
Write-Host '      "tagOwners": { "tag:phone": ["autogroup:admin"] },'
Write-Host "      \"acls\": [{ \"action\": \"accept\", \"src\": [\"tag:phone\"], \"dst\": [\"$ip:4080\"] }],"
Write-Host '      "nodeAttrs": [{ "target": ["tag:phone"], "attr": ["funnel"] }]'
Write-Host '    }'
Write-Host '    Then tag only your phones with tag:phone in the Machines list.'
