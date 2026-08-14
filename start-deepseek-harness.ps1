$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root 'data'
$logDir = Join-Path $root 'logs'
$stdoutLog = Join-Path $logDir 'server.out.log'
$stderrLog = Join-Path $logDir 'server.err.log'
$url = 'http://127.0.0.1:3080/'

New-Item -ItemType Directory -Force -Path $dataDir, $logDir | Out-Null

function Test-HarnessReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

if (Test-HarnessReady) {
    Write-Host 'DeepSeek Harness is already running. Opening the Web UI...'
    Start-Process $url
    exit 0
}

$runningProcess = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -like '*apps/cli/lib/bin.js*web*' -or
        $_.CommandLine -like '*apps/cli/src/bin.ts*web*'
    } |
    Select-Object -First 1

if ($null -eq $runningProcess) {
    $env:DSH_HOME = $dataDir
    Write-Host 'Starting DeepSeek Harness. The first startup may take 1-2 minutes...'
    $process = Start-Process -FilePath 'node.exe' `
        -ArgumentList @('apps/cli/lib/bin.js', 'web') `
        -WorkingDirectory $root `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -WindowStyle Hidden `
        -PassThru
}
else {
    Write-Host 'DeepSeek Harness is still starting. Waiting for the Web UI...'
    $process = Get-Process -Id $runningProcess.ProcessId -ErrorAction SilentlyContinue
}

for ($attempt = 1; $attempt -le 60; $attempt++) {
    if (Test-HarnessReady) {
        Write-Host 'DeepSeek Harness is ready. Opening the Web UI...'
        Start-Process $url
        exit 0
    }

    if ($null -ne $process) {
        $process.Refresh()
        if ($process.HasExited) {
            Write-Host "DeepSeek Harness exited with code $($process.ExitCode)." -ForegroundColor Red
            if (Test-Path $stderrLog) {
                Write-Host "Error log: $stderrLog"
                Get-Content $stderrLog -Tail 30
            }
            exit 1
        }
    }

    Write-Progress -Activity 'Starting DeepSeek Harness' -Status "Waiting for Web UI ($attempt/60)" -PercentComplete (($attempt / 60) * 100)
    Start-Sleep -Seconds 2
}

Write-Progress -Activity 'Starting DeepSeek Harness' -Completed
Write-Host 'Startup timed out after 2 minutes.' -ForegroundColor Red
Write-Host "Logs: $logDir"
exit 1
