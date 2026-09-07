#!/usr/bin/env bash
# dsh-cog-tests.sh — 认知有效性测试(治"反复自我怀疑": 用客观测试裁决产出, 不靠内省摇摆)
# 2026-09-07 17:0x 建立。用户点破: "之所以反复自我怀疑自我否定是因为缺乏测试"。
# 思想: 工程测试的断言+可失败——认知产出也应有"通过/失败"裁决, 而非凭感觉。
# 现状: 基础设施测试已有(备份/完整性/重启/帧字数), 本套件测"认知有效性"。
# ⚠ 诚实边界(2026-09-07 17:1x 自审): 本套件测"存在性/活性"(机制有触发帧?模型有内容?),
#    不测"正确性"(内容对不对/产出是否有效)——正确性靠外部锚(用户验收/数据证伪/预测误差)。
#    禁止拿"测试9/9绿"论证"我的判断对"——那正是自欺开始(测试绿=东西存在, 非东西正确)。
set -uo pipefail
DIR="$HOME/.dsh/cognitive-pipeline"
PASS=0; FAIL=0; FAILED_TESTS=()

# 断言helper: 通过/失败计数
t() { # t <描述> <条件>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS+1)); echo "  ✓ $desc";
  else FAIL=$((FAIL+1)); FAILED_TESTS+=("$desc"); echo "  ✗ $desc"; fi
}

echo "=== 认知有效性测试 $(date '+%F %T') ==="

# ── T1 机制驱动测试(非存在≠驱动, R8) ──────────────────────────
echo "[T1] 机制是否真在驱动(有真实触发证据, 非仅存在)"
# 1a. #005候选孵化: 今日有 candidate-hatch 帧落盘(机制真触发过)
t "候选孵化有真实触发帧" bash -c "grep -c '\"kind\": *\"candidate-hatch\"' '$DIR/quiet-driver-frames.jsonl' | grep -q '[1-9]'"
# 1b. 预测闭环: 有 report_outcome 回灌(预测→验证循环在跑)
t "预测有回灌记录" bash -c "grep -c 'predictionId' '$DIR/predictions.jsonl' 2>/dev/null | grep -q '[1-9]'"

# ── T2 世界模型有效性 ─────────────────────────────────────────
echo "[T2] 世界模型有效性(有内容、可查证、非空壳)"
# 2a. 世界模型有实质内容(非骨架)
t "world-model 有操作机制章节" bash -c "grep -q '操作机制' '$DIR/world-model.md'"
# 2b. 迷雾清单在收缩(有点亮的记录)
t "迷雾有点亮记录" bash -c "grep -q '迷雾点亮' '$DIR/world-model.md'"
# 2c. 资产有规则(可被引用的知识)
t "资产含可行规则" bash -c "grep -q 'R1 ' '$DIR/world-model-assets.md'"

# ── T3 校准有效性(帧质量, 呼应今日措辞校准) ──────────────────
echo "[T3] 校准有效性(帧实质产出, 非确认态)"
# 3a. 最近帧有实质内容(平均>200字)
t "近帧平均长度>200字" bash -c "'$HOME/dsh-fork/dsh-verify-frames.sh' --minutes 30 2>/dev/null | grep -q '平均长度: [2-9][0-9][0-9]'"

# ── T4 存续保护(数据不会丢) ───────────────────────────────────
echo "[T4] 存续保护(四层在跑)"
t "备份cron存在" bash -c "crontab -l 2>/dev/null | grep -q 'dsh-cognitive-backup'"
t "git提交存在" bash -c "git -C '$HOME/.dsh' log --oneline 2>/dev/null | grep -q ."
t "完整性基线在" bash -c "test -f '$DIR/.integrity-baseline.sha256'"
# 4d. cron时间语义校验(2026-09-08 06:0x 审视固化——*/2小时=偶数点非"从X起", 曾致oq010探测凌晨空转)
t "oq010探测cron在白天奇数点" bash -c "crontab -l 2>/dev/null | grep dsh-oq010-probe | grep -qE '^7 (7|9|11|13|15|17|19|21),'"

echo ""
# ── T5 机制进化验证(2026-09-07 18:1x 固化——测试要形成机制, 否则触发收敛) ──
echo "[T5] 机制进化(待办测试自动化: 不靠自觉, cron自动跑)"
T5_RESULT=$(python3 "$HOME/dsh-fork/dsh-cog-tests-t5.py" 2>&1)
T5_CODE=$?
if [ "$T5_CODE" -eq 0 ]; then
  PASS=$((PASS+1)); echo "  ✓ T5机制进化全过: $T5_RESULT"
else
  FAIL=$((FAIL+1)); FAILED_TESTS+=("T5机制进化"); echo "  ✗ T5机制进化: $T5_RESULT"
fi

# ── T6 崩溃防复发(2026-09-08 07:3x 固化——88次崩溃循环事故后的回归护栏) ──
echo "[T6] 崩溃防复发(patch格式校验在重启前无条件拦截坏配置)"
SR="$HOME/dsh-fork/dsh-safe-restart.sh"
TMPP=$(mktemp); TMPB1=$(mktemp); TMPB2=$(mktemp)
cat > "$TMPP" << 'TPEOF'
- insert:
    - id: cognitive-pipeline
      name: '@deepseek-ai/dsh-cognitive-pipeline'
      config:
        root: !!js dshHomePath('cognitive-pipeline')
TPEOF
cat > "$TMPB1" << 'TPEOF'
- insert:
    - id: '@deepseek-ai/dsh-repeat-tool-reminder'
      config:
        thresholds: [3, 5, 8]
TPEOF
cat > "$TMPB2" << 'TPEOF'
- id: cognitive-pipeline
  name: '@deepseek-ai/dsh-cognitive-pipeline'
TPEOF
# 6a. 好patch通过校验(exit 0)
t "好patch通过顶层校验" bash -c "PATCH_FILE='$TMPP' '$SR' --verify-only >/dev/null 2>&1"
# 6b. 缺name的insert entry被拦截(上次崩溃根因: id用包名/缺name)
t "缺name的insert被拦截" bash -c "! PATCH_FILE='$TMPB1' '$SR' --verify-only >/dev/null 2>&1"
# 6c. 顶层裸entry(无insert容器)被拦截
t "顶层裸entry被拦截" bash -c "! PATCH_FILE='$TMPB2' '$SR' --verify-only >/dev/null 2>&1"
# 6d. patch校验无条件执行——调用在"无插件改动"早退(return 0)之前
t "patch校验在插件早退之前(无条件)" bash -c "patch_line=\$(grep -n 'if ! verify_patch' '$SR' | head -1 | cut -d: -f1); early_line=\$(grep -n '无最近改动的插件' '$SR' | head -1 | cut -d: -f1); [ -n \"\$patch_line\" ] && [ -n \"\$early_line\" ] && [ \"\$patch_line\" -lt \"\$early_line\" ]"
rm -f "$TMPP" "$TMPB1" "$TMPB2"

echo ""
echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"
if [ "$FAIL" -gt 0 ]; then
  echo "失败项:"; for f in "${FAILED_TESTS[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
