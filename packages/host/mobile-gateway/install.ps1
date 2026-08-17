# dsh-mobile-gateway 部署脚本（幂等）
# 用法:
#   .\install.ps1                                # 只构建+链接+确保 junction（不写用户）
#   .\install.ps1 -Users "alice:令牌1,bob:令牌2"  # 构建+链接+写入/更新 profile patch 的用户列表
#   .\install.ps1 -Profile web -Port 4080 -Users "alice:<openssl rand -hex 24>"
# 说明:
#   - 把 @deepseek-ai/dsh-mobile-gateway 加入 apps/cli 依赖并 pnpm install（闭包链接）
#   - 在 $DSH_HOME/profiles/node_modules 建立 fallback junction（运行中进程也能热挂载）
#   - 在 profile 的 cordis.patch.yml 写入 mobile-gateway 行（幂等：按 id 覆盖）
#   - 保存 patch 后 config HMR 自动热挂载，无需重启 dsh web

param(
    [string]$Profile = 'web',
    [int]$Port = 4080,
    [string]$Bind = '0.0.0.0',
    [string]$Users = '',
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pkgDir = Join-Path $repo 'packages/host/mobile-gateway'
$cli = Join-Path $repo 'apps/cli/package.json'
$home = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $repo 'data' }
$patchFile = Join-Path $home "profiles/$Profile/cordis.patch.yml"

Write-Host "==> repo: $repo"
Write-Host "==> profile patch: $patchFile"

# 1) apps/cli 依赖（闭包链接进 profiles/node_modules 的 fallback）
$cliJson = Get-Content $cli -Raw | ConvertFrom-Json
if (-not $cliJson.dependencies.'@deepseek-ai/dsh-mobile-gateway') {
    $cliJson.dependencies.'@deepseek-ai/dsh-mobile-gateway' = 'workspace:^'
    # ConvertTo-Json 深度足够保留原有结构；排序键避免无谓 diff
    $sorted = [ordered]@{}
    $cliJson.dependencies.PSObject.Properties | Sort-Object Name | ForEach-Object { $sorted[$_.Name] = $_.Value }
    $cliJson.dependencies = $sorted
    $cliJson | ConvertTo-Json -Depth 20 | Set-Content $cli -Encoding utf8
    Write-Host "==> apps/cli 已加入依赖 @deepseek-ai/dsh-mobile-gateway"
} else {
    Write-Host "==> apps/cli 依赖已存在"
}

# 2) pnpm install（链接新 workspace 包 + devDeps）
if (-not $SkipInstall) {
    Push-Location $repo
    try { pnpm install --prefer-offline | Out-Null } finally { Pop-Location }
    Write-Host "==> pnpm install 完成"
}

# 3) 构建包
Push-Location $pkgDir
try { node "$repo\node_modules\typescript\bin\tsc" -b . ; node scripts/copy-lib.mjs } finally { Pop-Location }
Write-Host "==> 包构建完成"

# 4) fallback junction（运行中进程热挂载需要）
$fallbackDir = Join-Path $home 'profiles\node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path $fallbackDir | Out-Null
$link = Join-Path $fallbackDir 'dsh-mobile-gateway'
$target = Join-Path $repo 'apps\cli\node_modules\@deepseek-ai\dsh-mobile-gateway'
if (Test-Path $link) {
    Write-Host "==> junction 已存在: $((Get-Item $link -Force).Target)"
} else {
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Host "==> junction 已创建"
}

# 5) 写 profile patch 行（幂等：按 id 覆盖）
if (-not (Test-Path $patchFile)) { Set-Content $patchFile -Value '' }
$patch = Get-Content $patchFile -Raw
$rowBlock = @"

- insert:
    - id: mobile-gateway
      name: '@deepseek-ai/dsh-mobile-gateway'
      inject: [webServer]
      config:
        bind: $Bind
        port: $Port
        targetHost: 127.0.0.1
        targetPort: !!js ctx.webServer.port
        sessionTtlSeconds: 604800
        secret: ''
        tlsKeyPath: ''
        tlsCertPath: ''
        users:
"@
if ($Users -ne '') {
    foreach ($pair in ($Users -split ',')) {
        if ($pair -match '^([^:]+):(.+)$') {
            $rowBlock += "`n          - name: $($matches[1])"
            $rowBlock += "`n            token: $($matches[2])"
        }
    }
} else {
    $rowBlock += "`n          []"
}

if ($patch -match '(?ms)^- insert:\s*\n\s*- id: mobile-gateway') {
    $patch = $patch -replace '(?ms)^- insert:\s*\n\s*- id: mobile-gateway.*$', $rowBlock.TrimStart()
} else {
    $patch = $patch.TrimEnd() + "`n" + $rowBlock + "`n"
}
Set-Content $patchFile $patch -Encoding utf8
Write-Host "==> $patchFile 已写入 mobile-gateway 行（保存即热挂载）"

# 6) 打印接入信息
Write-Host ""
Write-Host "部署完成。手机接入:"
Write-Host "  http://<本机局域网IP>:$Port   (用户名+令牌登录，可'添加到主屏幕'装为 PWA)"
Write-Host "  健康检查: http://127.0.0.1:$Port/__mobile/health"
Write-Host "  Android App 工程: $pkgDir\android (见 android/README.md)"
