# 认知管线 F1/F2 修复验证脚本（PowerShell）
# 前提：在 D:\DeepSeek-Harness 仓库根目录以 PowerShell 运行
# 用途：编译 src→lib（让宿主加载修复）+ 运行回归测试 + 检查 lib 产物
# 说明：回归测试使用 cognition-test provider 的固定 JSON 响应，无需 API 密钥。

$ErrorActionPreference = 'Stop'
Set-Location 'D:\DeepSeek-Harness\packages\cognition\cognitive-pipeline'

Write-Host '=== [1/4] 编译 src → lib（tsc 项目引用构建） ===' -ForegroundColor Cyan
pnpm exec tsc -b tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Host '编译失败' -ForegroundColor Red; exit 1 }

Write-Host '=== [2/4] 验证 lib 已包含修复 ===' -ForegroundColor Cyan
$lib = Get-Content 'lib\types\hot-engine.js' -Raw
if ($lib -match 'enforcePointInInterval' -and $lib -match "coverage === 'gap'") {
  Write-Host 'OK: lib 已包含 F1(enforcePointInInterval) 与 F2(gap 复审)' -ForegroundColor Green
} else {
  Write-Host 'FAIL: lib 缺少修复，请检查编译' -ForegroundColor Red; exit 1
}

Write-Host '=== [3/4] 运行回归测试（hot-engine + pipeline） ===' -ForegroundColor Cyan
# vitest 4.1.8 无内置 basic reporter（--reporter=basic 会导致启动失败）；
# 且须从仓库根用完整路径运行（包内相对路径不匹配 include glob）。
Set-Location 'D:\DeepSeek-Harness'
pnpm exec vitest run packages/cognition/cognitive-pipeline/tests/hot-engine.spec.ts packages/cognition/cognitive-pipeline/tests/pipeline.spec.ts
if ($LASTEXITCODE -ne 0) { Write-Host '回归测试失败' -ForegroundColor Red; exit 1 }

Write-Host '=== [4/4] 提醒 ===' -ForegroundColor Yellow
Write-Host '宿主进程需重启后才会加载新的 lib（exp_258 教训：改完代码不重启 = 修复不生效）。'
Write-Host '重启后可用 predict_outcome 复测：深海水下机器人维护场景（pred_75 对照），'
Write-Host '预期修复后行为：is_novel=true（F2）且 calibrated ∈ [confidenceLow, confidenceHigh]（F1）。'

Write-Host '全部完成 ✓' -ForegroundColor Green
