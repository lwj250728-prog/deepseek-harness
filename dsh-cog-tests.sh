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

# ── T7 数据链路防复发(2026-09-08 08:2x 固化——tp-010: oq010-probe 解锁逻辑) ──
echo "[T7] 数据链路(oq010-probe 解锁: 数据入→nextAction 去'待'前缀→行动帧可推)"
GOALS7="$DIR/dormant-goals.jsonl"
BAK7=$(mktemp); cp "$GOALS7" "$BAK7"
# 7a. 解锁段执行: 模拟 probe 检测到数据的分支逻辑(与 dsh-oq010-probe.sh 相同)
UNLOCK7=$(python3 - "$GOALS7" << 'PYEOF'
import json, sys
p = sys.argv[1]
rows = []
changed = False
for line in open(p, encoding='utf8'):
    d = json.loads(line)
    if d.get('id') == 'goal-digital-life-incubation':
        d['nextAction'] = ('执行 oq-010 解读: 读 oq010-data-ready.json(刚入中心的细粒度数据), '
                           '按 world-model 读者层基线解读, 结论回写 world-model + 决定发布节奏')
        changed = True
    rows.append(d)
if changed:
    with open(p, 'w', encoding='utf8') as f:
        for d in rows:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    print('unlocked')
PYEOF
)
# 7b. 断言解锁: nextAction 不以"待"开头且含"执行 oq-010"
NA7=$(python3 -c "
import json
for l in open('$GOALS7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
")
t "解锁段执行成功(模拟数据入中心)" test -n "$UNLOCK7"
t "解锁后 nextAction 去'待'前缀" bash -c "! [[ '$NA7' == 待* ]]"
t "解锁后含'执行 oq-010'(行动帧可推)" bash -c "[[ '$NA7' == *'执行 oq-010'* ]]"
# 7c. 还原
cp "$BAK7" "$GOALS7"
NA7B=$(python3 -c "
import json
for l in open('$GOALS7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
")
t "还原后回到'待事件'待命态" bash -c "[[ '$NA7B' == 待* ]]"
rm -f "$BAK7"

# ── T8 probe 404 误判防复发(2026-09-08 08:3x 固化——tp-011) ──
echo "[T8] probe 404 误判防复发(页异常≠数据未入)"
# 8a. read_platform_signal.py 含 404/错误页检测逻辑(不静默吞错误页)
t "signal工具含错误页检测" bash -c "grep -q 'detail-error' '$HOME/.dsh/novel-tools/read_platform_signal.py'"
# 8b. probe 三态判定: detail-error 单独分支(不再并入'数据未入')
t "probe区分页异常与数据未入" bash -c "grep -q 'detail-error' '$HOME/dsh-fork/dsh-oq010-probe.sh' && grep -q '页异常' '$HOME/dsh-fork/dsh-oq010-probe.sh'"
# 8c. probe 日志已记录页异常(非静默'数据未入')
t "probe日志有页异常记录" bash -c "grep -q '页异常' '$DIR/oq010-probe.log'"

# ── T9 probe 指纹去重(2026-09-08 09:3x 固化——tp-012: 同数据不得重复解锁) ──
echo "[T9] probe 指纹去重(数据无变化不重复解锁)"
# 9a. probe 含指纹去重逻辑(比较上次指纹)
t "probe含指纹比较逻辑" bash -c "grep -q 'oq010-fingerprint' '$HOME/dsh-fork/dsh-oq010-probe.sh' && grep -q '数据无变化' '$HOME/dsh-fork/dsh-oq010-probe.sh'"
# 9b. 指纹文件存在(首次探测后建立)
t "指纹文件已建立" test -f "$DIR/.oq010-fingerprint"
# 9c. 去重真实生效: log 中"无变化"记录存在且同一指纹段内"已解锁"次数不暴增
t "去重已生效(有无变化记录)" bash -c "grep -q '数据无变化' '$DIR/oq010-probe.log'"
t "解锁次数有限(无轰炸)" bash -c "n=\$(grep -c '数据变化, 已解锁' '$DIR/oq010-probe.log' 2>/dev/null || echo 0); [ \"\$n\" -le 5 ]"

# ── T10 认知饥饿机制保证(2026-09-08 10:0x 固化——tp-013: 帧头言行账本提示) ──
echo "[T10] 认知饥饿机制保证(帧头言行账本提示——核对每帧可见, 防上下文遗忘)"
# 10a. src frameHeader 含言行账本条目(机制保证源头)
t "src frameHeader 含言行账本" bash -c "grep -q '言行账本' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts' && grep -q 'claims-ledger' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 10b. lib 已重建含该行(部署生效)
t "lib 含言行账本(已部署)" bash -c "grep -q '言行账本' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
# 10c. claims-ledger 存在且每行可解析
t "claims-ledger 存在且可解析" bash -c "test -f '$DIR/claims-ledger.jsonl' && python3 -c \"import json; rows=[json.loads(l) for l in open('$DIR/claims-ledger.jsonl')]; assert all(d.get('id') and d.get('claim') for d in rows)\""

# ── T11 入账纪律(2026-09-08 11:0x 固化——tp-014: 帧头'先入账再回答'子句) ──
echo "[T11] 入账纪律子句(宣称入账不依赖自觉——帧头'先入账再回答')"
# 11a. src 言行账本行含"先入账再回答"子句
t "src含入账纪律子句" bash -c "grep -q '先入账再回答' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 11b. lib 已重建含子句(部署生效)
t "lib含入账纪律子句(已部署)" bash -c "grep -q '先入账再回答' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
# 11c. lib 早于服务启动(当前进程跑的是新 lib)
t "lib早于服务启动(进程用新lib)" bash -c "lib_ts=\$(stat -c %Y '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'); svc_ts=\$(systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value 2>/dev/null); svc_ep=\$(date -d \"\$svc_ts\" +%s 2>/dev/null); [ -n \"\$svc_ep\" ] && [ \"\$lib_ts\" -lt \"\$svc_ep\" ]"

# ── T12 异模型盲审通道(2026-09-08 12:0x 固化——tp-015: oq-022 effectiveness 外部判定源) ──
echo "[T12] 异模型盲审通道(oq-022——effectiveness 外部判定源可用)"
# 12a. 盲审脚本存在且语法有效
t "盲审脚本存在且语法有效" bash -c "test -f '$HOME/dsh-fork/dsh-oq022-blind-audit.py' && python3 -m py_compile '$HOME/dsh-fork/dsh-oq022-blind-audit.py'"
# 12b. SILICONFLOW key 存在
t "SILICONFLOW key 存在" bash -c "grep -q 'SILICONFLOW_API_KEY' '$HOME/.dsh/.credentials.yaml'"

# ── T13 触发词分级(2026-09-08 13:1x 固化——tp-016: 强词单独触发/弱词需叠加, 数据驱动修正'想当然') ──
echo "[T13] 触发词分级(数据驱动: 失败/崩溃强触发, 怎么/异常弱触发)"
TRIG13="$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/triggers.ts"
INJ13="$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts"
# 13a. 分级结构存在
t "triggers.ts 含强/弱分级" bash -c "grep -q 'STRONG_STATIC_TRIGGERS' '$TRIG13' && grep -q 'WEAK_STATIC_TRIGGERS' '$TRIG13'"
# 13b. 语义归类(失败/崩溃强, 怎么/异常弱)
t "强/弱词归类正确(语义)" python3 -c "
import re
src = open('$TRIG13').read()
m = re.search(r'STRONG_STATIC_TRIGGERS: ReadonlySet<string> = new Set\(\[(.*?)\]\)', src, re.S)
strong = set(re.findall(r\"'([^']+)'\", m.group(1)))
m2 = re.search(r'STATIC_TRIGGERS: ReadonlySet<string> = new Set\(\[(.*?)\]\)', src, re.S)
weak = set(re.findall(r\"'([^']+)'\", m2.group(1))) - strong
assert '失败' in strong and '崩溃' in strong, '强词缺失'
assert '怎么' in weak and '异常' in weak, '弱词分类错'
"
# 13c. 注入逻辑用分级权重
t "注入逻辑用分级权重" bash -c "grep -q 'STRONG_STATIC_TRIGGERS.has' '$INJ13' && grep -q 'WEAK_STATIC_WEIGHT' '$INJ13'"
# 13d. lib 已部署
t "lib已部署分级" bash -c "grep -q 'STRONG_STATIC_TRIGGERS' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js' && grep -q 'STRONG_STATIC_TRIGGERS' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/types/triggers.js'"

# ── T14 帧统计口径(2026-09-08 15:2x 固化——tp-017: 统计今日帧须限日期, 防历史帧虚高) ──
echo "[T14] 帧统计口径(限日期+限评估帧类型——防'473帧'式误判)"
# 14a. 今日评估帧远小于全历史(口径正确)
t "今日帧远小于历史总数" bash -c "today=\$(python3 -c \"
import json, datetime
n = 0
for l in open('$DIR/quiet-driver-frames.jsonl'):
    d = json.loads(l)
    t = datetime.datetime.fromtimestamp(d.get('ts',0)/1000)
    if t.date() == datetime.date(2026,9,8) and d.get('kind') in ('direct-frame','epistemic-frame'): n += 1
print(n)
\"); total=\$(python3 -c \"
import json
print(sum(1 for l in open('$DIR/quiet-driver-frames.jsonl')))
\"); [ \"\$today\" -lt \$((total / 2)) ]"
# 14b. 今日评估帧合理区间(单小时≤20, 防'59帧/时'误判)
t "单小时评估帧≤20" python3 -c "
import json, datetime
hourly = {}
for l in open('$DIR/quiet-driver-frames.jsonl'):
    d = json.loads(l)
    t = datetime.datetime.fromtimestamp(d.get('ts',0)/1000)
    if t.date() == datetime.date(2026,9,8) and d.get('kind') in ('direct-frame','epistemic-frame'):
        hourly[t.hour] = hourly.get(t.hour, 0) + 1
assert all(v <= 20 for v in hourly.values()), f'超频: {hourly}'
print('OK')
"

# ── T15 灰测模型目录(2026-09-08 16:5x 固化——tp-019: v4.1 灰测模型可选可见) ──
echo "[T15] 灰测模型目录(v4.1-flash-expires-on-0910——到期09-10后须移除并更新本组)"
# 15a. src DEFAULT_MODELS 含灰测模型
t "src含灰测模型" bash -c "grep -q 'deepseek-v4.1-flash-expires-on-0910' '$HOME/dsh-fork/packages/llm/llm-deepseek/src/index.ts'"
# 15b. lib 已重建含灰测模型(部署生效)
t "lib含灰测模型(已部署)" bash -c "grep -q 'deepseek-v4.1-flash-expires-on-0910' '$HOME/dsh-fork/packages/llm/llm-deepseek/lib/index.js'"
# 15c. 到期标注存在(清理锚点)
t "到期标注(expires-on-0910)" bash -c "grep -q 'expires-on-0910' '$HOME/dsh-fork/packages/llm/llm-deepseek/src/index.ts'"

echo ""
echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"
if [ "$FAIL" -gt 0 ]; then
  echo "失败项:"; for f in "${FAILED_TESTS[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
