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

# ── T0 套件自检 + 工具脚本语法闸前置(cl-072: 脚本自身语法错时无法自保) ──
# 2026-09-09 13:3x 实测: bash 按行解析执行, 文件后半段语法错时前半段照跑,
# 于是"套件跑完了"可能掩盖"文件已损坏"。所以先整文件 bash -n, 语法错直接 FATAL,
# 不产出任何误导性的绿; 再前置工具脚本语法闸(编辑后未校验的脚本不该让套件看起来全绿)。
if ! bash -n "$0" 2>/tmp/dsh-cog-tests-selfcheck.err; then
  echo "[FATAL] 套件自身语法错误, 未执行任何测试:"
  sed 's/^/    /' /tmp/dsh-cog-tests-selfcheck.err
  python3 - "$DIR/claims-ledger.jsonl" <<'PYINNER'
import json, sys, datetime
ledger = sys.argv[1]
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()
rid = 'cl-test-selfcheck-' + datetime.datetime.now().strftime('%Y%m%d-%H%M')
try:
    rows = [json.loads(l) for l in open(ledger, encoding='utf8') if l.strip()]
except Exception:
    rows = []
rows.append({'id': rid, 'ts': now,
             'claim': '认知测试套件自身语法错误——无法自保, 本轮未执行任何断言',
             'source': 'dsh-cog-tests.sh T0 自检', 'status': 'open',
             'reviewBy': now[:10], 'reviewBasis': '修复语法后自动恢复',
             'note': '修法: bash -n 整文件后再执行; 修复后重跑套件, 该告警由恢复逻辑关闭。'})
with open(ledger, 'w', encoding='utf8') as f:
    f.write(chr(10).join(json.dumps(x, ensure_ascii=False) for x in rows) + chr(10))
PYINNER
  exit 2
fi
# tp-059/cl-092: 套件对自身完整性的断言——结果汇总行曾被补丁当锚点吞掉, 两次运行无人察觉。
if ! grep -q '结果: \$PASS 通过 / \$FAIL 失败' "$0"; then
  echo "[FATAL] 套件缺少结果汇总行(被补丁误吞?)——未执行任何测试"
  exit 2
fi
if ! bash "$HOME/dsh-fork/dsh-script-lint.sh" >/tmp/dsh-cog-lint.out 2>&1; then
  echo "[FATAL] 工具脚本语法闸未过, 未执行测试:"
  tail -20 /tmp/dsh-cog-lint.out | sed 's/^/    /'
  exit 2
fi

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
# 3a. 最近帧有实质内容(平均>200字; 窗口样本<3则跳过=待积累, 防重启后误报)
# 2026-09-09 09:5x 修正: 原判据用正则匹配三位数(帧平均 200-999 时代), 帧变长到四位数即误红
# ——同 T7/T15 家族(断言写死旧状态的范围)。改为数值比较。
t "近帧平均长度≥200字(样本≥3)" bash -c "
out=\$('$HOME/dsh-fork/dsh-verify-frames.sh' --minutes 30 2>/dev/null)
n=\$(echo \"\$out\" | grep -oP '窗口帧数: \K[0-9]+')
if [ \"\${n:-0}\" -lt 3 ]; then echo '样本不足跳过'; exit 0; fi
avg=\$(echo \"\$out\" | grep -oP '平均长度: \K[0-9]+')
[ \"\${avg:-0}\" -ge 200 ]
"

# ── T4 存续保护(数据不会丢) ───────────────────────────────────
echo "[T4] 存续保护(四层在跑)"
t "备份cron存在" bash -c "crontab -l 2>/dev/null | grep -q 'dsh-cognitive-backup'"
t "git提交存在" bash -c "git -C '$HOME/.dsh' log --oneline 2>/dev/null | grep -q ."
# 4b2. 提交腿须"在驱动"而非"存在"(2026-09-09 00:3x 固化——cl-049: crontab 未转义 % 致
#      自动提交停摆 25h, 而旧断言只看历史任意提交, 套件全绿而存续腿已死。窗口取 6h 以容忍
#      夜间无变更导致的"nothing to commit"。)
t "git提交未停摆(6h内)" python3 -c '
import subprocess, time
out = subprocess.run(["git", "-C", __import__("os").path.expanduser("~/.dsh"),
                      "log", "-1", "--format=%ct"], capture_output=True, text=True).stdout.strip()
assert out.isdigit(), "取不到提交时间"
age = time.time() - int(out)
assert age < 6 * 3600, "最近提交距今 %.1f 小时(>6h, 提交腿可能停摆)" % (age / 3600)
'
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
# 2026-09-09 12:3x 修正: 原实现直接改**活文件**再还原——运行中的服务会 bump() 重写同一文件,
# 与测试抢写, 还原后偶发不一致(连续两次误红)。改为改副本: 活文件全程只读。
WORK7=$(mktemp); cp "$GOALS7" "$WORK7"
BAK7="$WORK7"
# 原始 nextAction(还原保真的比对基准)——2026-09-09 08:5x 修正: 原断言写死"以'待'开头",
# 而该目标 nextAction 已按 cl-059 改写为可执行子步, 故改为"还原后与原始一致"。
NA7_ORIG_FILE=$(mktemp)
python3 -c "
import json
for l in open('$GOALS7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
" > "$NA7_ORIG_FILE"
# 7a. 解锁段执行: 模拟 probe 检测到数据的分支逻辑(与 dsh-oq010-probe.sh 相同)
UNLOCK7=$(python3 - "$WORK7" << 'PYEOF'
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
for l in open('$WORK7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
")
t "解锁段执行成功(模拟数据入中心)" test -n "$UNLOCK7"
t "解锁后 nextAction 去'待'前缀" bash -c "! [[ '$NA7' == 待* ]]"
t "解锁后含'执行 oq-010'(行动帧可推)" bash -c "[[ '$NA7' == *'执行 oq-010'* ]]"
# 7c. 活文件未被改动(测试只动副本)
NA7B=$(python3 -c "
import json
for l in open('$GOALS7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
")
rm -f "$WORK7"
# 2026-09-09 12:3x 修正: nextAction 文本含单引号, 塞进 bash 插值会语法崩 → 用 Python 比对
t "测试未改动活文件" python3 -c "
import json
def na(p):
    for l in open(p, encoding='utf8'):
        d = json.loads(l)
        if d.get('id') == 'goal-digital-life-incubation': return d.get('nextAction', '')
    return ''
orig = open('$NA7_ORIG_FILE', encoding='utf8').read().strip()
assert na('$GOALS7') == orig, '活文件 nextAction 被测试改动'
"
rm -f "$NA7_ORIG_FILE"
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
# 15d. 时间闸(2026-09-09 09:5x 固化——三问帧 Q3: 到期日写进注释不构成约束, 状态变了断言仍停在旧状态)
#      到期前: 模型必须在目录; 到期后: 模型必须已移除(否则本组转红, 强制清理)。
t "灰测模型到期闸" python3 -c '
import os, re, datetime
expiry = datetime.date(2026, 9, 10)
today = datetime.date.today()
src = open(os.path.expanduser("~/dsh-fork/packages/llm/llm-deepseek/src/index.ts")).read()
present = "deepseek-v4.1-flash-expires-on-0910" in src
if today <= expiry:
    assert present, "到期前模型应仍在目录"
else:
    assert not present, "灰测模型已于 %s 到期, 必须从目录移除并更新 T15 组" % expiry
'  

# ── T16 经验写入字段名一致性(2026-09-08 18:0x 固化——tp-020: 驼峰字段防 80 条效用丢失) ──
echo "[T16] 经验写入字段名(quiet-driver utility 须驼峰——下划线曾致 80 条效用读不到)"
# 16a. src 代码层用驼峰(排除注释)
t "src 代码层 utility 驼峰" bash -c "grep -q 'materialGain: 1' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts' && ! grep -v '^\s*//' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts' | grep -q 'material_gain'"
# 16b. lib 已部署
t "lib 含驼峰字段(已部署)" bash -c "grep -q 'materialGain: 1' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
# 16c. action 破同质化(含帧号)
t "action 破同质化(含帧号)" bash -c "grep -q '旁路三问帧 #' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 16d. 重启后新经验字段名正确(无新经验则跳过=待验证)
t "重启后经验字段名正确" python3 -c "
import json, datetime, subprocess
ts = subprocess.run(['systemctl','--user','show','dsh-web.service','-p','ActiveEnterTimestamp','--value'], capture_output=True, text=True).stdout.strip()
restart = datetime.datetime.strptime(ts.replace('CST','').strip(), '%a %Y-%m-%d %H:%M:%S').timestamp() if ts else 0
exps = [json.loads(l) for l in open('$DIR/experiences.jsonl')]
after = [e for e in exps if (e.get('timestamp') or 0)/1000 > restart]
bad = [e['expId'] for e in after if 'material_gain' in e.get('sar',{}).get('outcomeUtility',{})]
assert not bad, f'下划线字段残留: {bad}'
print(f'OK ({len(after)} 条重启后经验)')
"

echo ""

# ── T17 校准外部锚(2026-09-08 18:5x 固化——cl-016/017/018/019 重设计) ──
echo "[T17] 校准外部锚(α降+自适应 / 帧预测无锚不填值 / 双尾)"
# 17a. α 默认已降 50→5
t "α默认已降(5)" bash -c "grep -q 'shrinkageAlpha: z.number().min(0).default(5)' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts'"
# 17b. α 自适应公式在
t "α自适应公式在" bash -c "grep -q 'base / Math.sqrt' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts'"
# 17c. 帧预测无外部锚不填值(cl-019)
t "帧预测无锚不结算" bash -c "grep -q 'no-external-anchor' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 17d. lib 已部署两项
t "lib含α自适应+无锚不结算" bash -c "grep -q 'base / Math.sqrt' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js' && grep -q 'no-external-anchor' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"


# ── T18 验收标准机制(2026-09-08 19:3x 固化——tp-022: acceptance 从空转→可用) ──
echo "[T18] 验收标准机制(3标准激活/trigger单词/工具层可更新/audit已应用)"
# 18a. 3 条 active 标准
t "3条标准active" python3 -c "
import json
d = json.load(open('$DIR/acceptance.json'))
assert len([c for c in d if c.get('status')=='active']) >= 3
"
# 18b. trigger 均为单词(无竖线——字面 includes 匹配)
t "trigger均为单词" python3 -c "
import json
d = json.load(open('$DIR/acceptance.json'))
bad = [c['checkId'] for c in d if c.get('status')=='active' and '|' in (c.get('trigger') or '')]
assert not bad, f'含竖线: {bad}'
"
# 18c. 工具层传递 trigger(cl-022 修复)
t "工具层传递trigger" bash -c "grep -q 'args.trigger' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts'"
# 18d. audit 有 applied 非空(机制真被应用)
t "audit有applied记录" python3 -c "
import json
rows = [json.loads(l) for l in open('$DIR/claim_audits.jsonl')]
assert any(r.get('appliedCheckIds') for r in rows), '无applied记录'
"

echo ""

# ── T19 验收标准锚线(2026-09-08 19:5x 固化——tp-023: 锚线接通/check_2/3开火/P0告警通道) ──
echo "[T19] 验收标准锚线(command_anchor配置/锚验证记录/check_2-3开火/P0告警通道)"
# 19a. 配置开启
t "acceptanceCommandExecution开启" bash -c "grep -q 'acceptanceCommandExecution: true' '$HOME/.dsh/profiles/web/cordis.patch.yml'"
# 19b. 有锚验证记录
t "有anchorVerified记录" python3 -c "
import json
n = sum(1 for l in open('$DIR/claim_audits.jsonl') if json.loads(l).get('anchorVerified'))
assert n >= 1, f'anchorVerified={n}'
"
# 19c. check_2/3 开火且机器验证
t "check_2/3开火+机器验证" python3 -c "
import json
d = {c['checkId']: c for c in json.load(open('$DIR/acceptance.json'))}
for cid in ('check_2','check_3'):
    c = d.get(cid, {})
    assert c.get('invokedCount',0) > 0 and c.get('machineVerifiedCount',0) > 0, f'{cid}未开火'
"
# 19d. P0 失败自动汇报通道在
t "P0告警通道在" bash -c "grep -q 'test-alert' '$HOME/dsh-fork/dsh-cog-tests.sh'"


# ── T20 关单纪律(2026-09-08 20:1x 固化——tp-024: cl-020 帧头机制保证) ──
echo "[T20] 关单纪律(帧头提示'已完成未关单'+'即时标done' + 无矛盾open项)"
# 20a. src 含关单提示
t "src含关单提示" bash -c "grep -q '已完成未关单' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 20b. lib 已部署
t "lib含关单提示(已部署)" bash -c "grep -q '已完成未关单' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
# 20c. 无矛盾 open 项(note说已修但状态open)——按 id last-wins 去重后再判
#      (2026-09-09 00:2x 修正: 首版遍历全部行, 旧记录会把已关闭项判成矛盾——与 cl-041 同族)
t "无矛盾open项" python3 -c "
import json
by_id = {}
for l in open('$DIR/claims-ledger.jsonl'):
    d = json.loads(l)
    if d.get('id'): by_id[d['id']] = d
bad = []
for d in by_id.values():
    if d['status'] not in ('open','in-progress'): continue
    note = (d.get('note') or '') + (d.get('doneNote') or '')
    if any(k in note for k in ['已修','已执行','已落地','已修复']):
        bad.append(d['id'])
assert not bad, f'矛盾项: {bad}'
"

# ── T21 目标锚定自动化(2026-09-08 21:2x 固化——cl-031: 离线实验语义链0条/目标锚定链4条) ──
echo "[T21] 目标锚定自动化(remember_experience 自动取活目标/会话粘性锚, 不依赖逐条记忆)"
# 21a. src 含链锚解析
t "src含链锚解析" bash -c "grep -q 'resolveChainAnchor' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts'"
# 21b. 解析优先级: 活目标 > 会话锚(顺序断言)
t "活目标优先于会话锚" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")).read()
q = chr(39)
i = src.index("source: " + q + "goal" + q)
j = src.index("source: " + q + "session" + q)
assert i < j, "goal 分支必须在 session 分支之前"
'
# 21c. 会话锚持久化
t "会话锚持久化文件" bash -c "grep -q 'chain_anchors.json' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts'"
# 21d. lib 已部署
t "lib含链锚(已部署)" bash -c "grep -q 'chain_source' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
# 21e. 链锚机制真跑过(cl-076: 原判据=锚文件非空, 是状态证据——合法清空陈旧锚后
#      必然变红(2026-09-09 14:41 实测)。改成效果证据: 至少一条经验真的带了 chainId,
#      以及锚文件本身可读(机制写得出这个文件)。
t "链锚机制真跑过" python3 -c '
import json, os
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
d = json.load(open(os.path.join(base, "chain_anchors.json")))
assert isinstance(d, dict), "链锚文件不是对象"
rows = [json.loads(l) for l in open(os.path.join(base, "experiences.jsonl"), encoding="utf8") if l.strip()]
anchored = [r for r in rows if isinstance(r.get("chainId"), str) and r.get("chainId")]
assert anchored, "无任何经验带 chainId——锚定机制没有效果证据"
'
# 21f. 锚定证据=每个已声明锚都有经验继承(tp-057/cl-085: 原判据"最新一条必须有锚"会因
#      旁路会话合法无锚而长期变红, 掩盖真正的新失败; 且它测的是"最新"这个偶然位置, 不是机制)
t "已声明锚均有经验继承" python3 -c '
import json, os
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
try:
    anchors = json.load(open(os.path.join(base, "chain_anchors.json"), encoding="utf8"))
except Exception:
    anchors = {}
if not isinstance(anchors, dict) or not anchors:
    raise SystemExit(0)  # 无声明锚时不适用
rows = [json.loads(l) for l in open(os.path.join(base, "experiences.jsonl"), encoding="utf8") if l.strip()]
have = {r.get("chainId") for r in rows if r.get("chainId")}
missing = [gid for gid in set(anchors.values()) if gid not in have]
assert not missing, "已声明锚无任何经验继承(锚定写入可能失效): %s" % missing
'
# 21g. 帧经验不参与锚定(帧层保持无 chainId, 防污染链)
t "帧经验不带链锚" python3 -c '
import json, os
rows = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/experiences-frames.jsonl")) if l.strip()]
bad = [r.get("expId") for r in rows if isinstance(r.get("chainId"), str) and r.get("chainId")]
assert not bad, "帧经验被锚定: %s" % bad[:3]
'

# ── T22 经验分层 provenance(2026-09-08 21:3x 固化——tp-025 实测发现 exp_221 被文本嗅探误判) ──
echo "[T22] 经验分层provenance(显式kind优先, 文本嗅探只作旧行回退——防'引用模板即被误判')"
# 22a. src 显式 kind 判定
t "src显式kind判定" bash -c "grep -q \"exp.kind === 'frame'\" '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts'"
# 22b. 旧行回退用前缀匹配(非 includes)
t "旧行回退用前缀匹配" bash -c "grep -q \"startsWith('quiet-driver 旁路三问帧')\" '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts'"
# 22c. 写入方声明 kind
t "quiet-driver声明kind=frame" bash -c "grep -q \"kind: 'frame'\" '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 22d. lib 已部署(bundler 会把单引号规范化为双引号)
t "lib含kind判定(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "kind === \"frame\"" in s, "lib 未部署 kind 判定"
'
# 22e. 运行时分层不变量(帧层全为帧/任务层无帧)
t "运行时分层不变量" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
def rows(f): return [json.loads(l) for l in open(os.path.join(d, f)) if l.strip()]
frames, tasks = rows("experiences-frames.jsonl"), rows("experiences.jsonl")
bad = [r.get("expId") for r in frames
       if r.get("kind") != "frame"
       and not (r.get("sar") or {}).get("action", "").startswith("quiet-driver 旁路三问帧")]
assert not bad, "帧层混入非帧经验: %s" % bad[:3]
bad2 = [r.get("expId") for r in tasks if r.get("kind") == "frame"]
assert not bad2, "任务层混入帧经验: %s" % bad2[:3]
'
# 22f. 回归个案: 引用模板字符串的任务经验(exp_221)必须留在任务层
t "引用模板的任务经验留任务层" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
ids = [json.loads(l).get("expId") for l in open(os.path.join(d, "experiences.jsonl")) if l.strip()]
assert "exp_221" in ids, "exp_221 不在任务层(文本嗅探误判复发)"
'

# ── T23 SAR provenance 不变量(2026-09-08 21:5x 固化——cl-035: cl-033/cl-034 同属写入路径文本层缺陷) ──
echo "[T23] SAR provenance不变量(结构标记权威切分 + rawText可回溯 + 字段不互串)"
# 23a. src 含确定性结构切分
t "src含结构标记切分" bash -c "grep -q 'splitStructuredSar' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/llm.ts'"
# 23b. 抽取提示词含结构/防捏造规则
t "提示词含结构切分规则" bash -c "grep -q '标记是权威切分' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/prompts.ts'"
# 23c. rawText 持久化(可回溯)
t "src持久化rawText" bash -c "grep -q 'rawText: input.rawText' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts'"
# 23d. lib 已部署
t "lib含结构切分(已部署)" bash -c "grep -q 'splitStructuredSar' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
# 23e. 运行时: 至少一条经验携带 rawText(机制真跑过)
t "有经验携带rawText" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(d, "experiences.jsonl")) if l.strip()]
assert any(isinstance(r.get("rawText"), str) and r["rawText"] for r in rows), "无任何经验携带 rawText"
'
# 23f. 运行时不变量: 带 rawText 的行——字段不以结构标记开头, 且字段字符 ≥50% 可在 rawText 中找到
t "SAR字段不互串且可回溯" python3 -c '
import json, os, re
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(d, "experiences.jsonl")) if l.strip()]
label = re.compile(r"^\s*(?:情境|situation|动作|行动|action|结果|outcome)\s*[:：]", re.I)
bad, fabricated = [], []
for r in rows:
    raw = r.get("rawText")
    if not isinstance(raw, str) or not raw:
        continue
    sar = r.get("sar") or {}
    for f in ("situation", "action", "outcome"):
        v = sar.get(f) or ""
        if label.search(v):
            bad.append("%s.%s" % (r.get("expId"), f))
        chars = set(ch for ch in v if not ch.isspace())
        if chars and len(chars & set(raw)) / len(chars) < 0.5:
            fabricated.append("%s.%s" % (r.get("expId"), f))
assert not bad, "字段残留结构标记(互串): %s" % bad[:3]
assert not fabricated, "字段内容无法回溯到 rawText(疑似捏造): %s" % fabricated[:3]
'

# ── T24 L1 可重抽(2026-09-08 22:1x 固化——cl-038: 抽取失败回退绕过结构标记, 启动时按 rawText 修复) ──
echo "[T24] L1编码层可从L0重抽(回退分支也遵守结构标记 + 启动修复错位SAR)"
# 24a. 回退分支也应用结构标记
t "回退分支遵守结构标记" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/llm.ts")).read()
i = s.index("SAR extraction degraded to fallback")
seg = s[i:i+600]
assert "structured === null ? sarFallback(rawText) : { ...sarFallback(rawText), ...structured }" in seg, "回退分支未应用 structured"
'
# 24b. 启动修复存在
t "src含启动修复" bash -c "grep -q 'repairStructuredSar' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts'"
# 24c. lib 已部署
t "lib含启动修复(已部署)" bash -c "grep -q 'repairStructuredSar' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
# 24d. 运行时: 带结构标记 rawText 的行, 其 SAR 必须与确定性切分一致(修复生效/未再错位)
t "结构化rawText的SAR与切分一致" python3 -c '
import json, os, re
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(d, "experiences.jsonl")) if l.strip()]
pat_s = re.compile(r"(?:情境|situation)\s*[:：]", re.I)
pat_a = re.compile(r"(?:动作|行动|action)\s*[:：]", re.I)
pat_o = re.compile(r"(?:结果|outcome)\s*[:：]", re.I)
strip = re.compile(r"^\s*(?:情境|situation|动作|行动|action|结果|outcome)\s*[:：]\s*", re.I)
bad = []
for r in rows:
    raw = r.get("rawText")
    if not isinstance(raw, str) or not raw:
        continue
    ms, ma, mo = pat_s.search(raw), pat_a.search(raw), pat_o.search(raw)
    if not (ms and ma and mo and ms.start() < ma.start() < mo.start()):
        continue
    want = [strip.sub("", raw[ms.start():ma.start()]).strip(),
            strip.sub("", raw[ma.start():mo.start()]).strip(),
            strip.sub("", raw[mo.start():]).strip()]
    got = [(r.get("sar") or {}).get(f) or "" for f in ("situation", "action", "outcome")]
    if want != got:
        bad.append(r.get("expId"))
assert not bad, "SAR 与 rawText 切分不一致(修复未生效): %s" % bad[:3]
'
# 24e. 回归个案: exp_228(回退错位受害行)必须已被修复
t "exp_228已按rawText修复" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(d, "experiences.jsonl")) if l.strip()]
r = [x for x in rows if x.get("expId") == "exp_228"]
assert r, "exp_228 不在任务层"
sar = r[0].get("sar") or {}
assert sar.get("situation", "").startswith("2026-09-08 22:1x"), "exp_228 situation 仍是回退切分: %s" % sar.get("situation", "")[:40]
assert sar.get("action", "").startswith("先查证工作区"), "exp_228 action 仍错位: %s" % sar.get("action", "")[:40]
'

# ── T25 产出物存续(2026-09-08 22:3x 固化——小说工作区此前不在任何备份/版本控制范围) ──
echo "[T25] 产出物存续(小说草稿/设定/账本须进每日备份与异地冗余)"
# 25a. 备份脚本覆盖小说工作区
t "备份脚本含小说工作区" bash -c "grep -q 'dsh-workshop/novels' '$HOME/dsh-fork/dsh-cognitive-backup.sh'"
# 25b. 最新备份归档确实含正文
t "最新归档含小说正文" python3 -c '
import glob, os, tarfile
files = sorted(glob.glob(os.path.expanduser("~/backups/cognitive-daily/cognitive-*.tar.gz")), key=os.path.getmtime)
assert files, "无备份归档"
with tarfile.open(files[-1], "r:gz") as tf:
    names = tf.getnames()
assert any(n.startswith("dsh-workshop/novels/") and n.endswith(".md") for n in names), "归档内无小说 md"
'
# 25c. 异地推送配置在
t "异地推送配置在" bash -c "grep -q 'REMOTE_HOST=' '$HOME/dsh-fork/dsh-cognitive-backup.sh'"
# 25d. 草稿编号连续无缺号(防静默丢章)
t "草稿编号无缺号" python3 -c '
import glob, os, re
d = os.path.expanduser("~/dsh-workshop/novels/qizhongjiyi/drafts")
nums = sorted(int(re.search(r"(\d+)", os.path.basename(p)).group(1)) for p in glob.glob(os.path.join(d, "00*.md")))
assert nums, "无草稿"
missing = [n for n in range(nums[0], nums[-1] + 1) if n not in nums]
assert not missing, "草稿缺号: %s" % missing
'
# 25e. 每章均过机检字数标尺
t "各章字数在标尺内" python3 -c '
import glob, os, re
d = os.path.expanduser("~/dsh-workshop/novels/qizhongjiyi/drafts")
bad = []
for p in sorted(glob.glob(os.path.join(d, "00*.md"))):
    t = open(p, encoding="utf8").read()
    n = len(re.sub(r"\s", "", re.sub(r"^# .*", "", t, flags=re.M)))
    if not (2200 <= n <= 2800):
        bad.append("%s=%d" % (os.path.basename(p), n))
assert not bad, "字数超范围: %s" % bad[:3]
'
# 25f. 账本自报累计字数 = 机算总和(防"账本自己说谎"——本轮发现漂移 4,668 字)
t "账本累计字数与机算一致" python3 -c '
import re, glob, os
d = os.path.expanduser("~/dsh-workshop/novels/qizhongjiyi")
txt = open(os.path.join(d, "audit/progress.md"), encoding="utf8").read().replace("*", "")
m = re.findall(r"累计正文\s*([\d,]+)\s*字", txt)
assert m, "progress.md 无累计正文记录"
ledger = int(m[-1].replace(",", ""))
total = 0
for p in glob.glob(os.path.join(d, "drafts/00*.md")):
    t = open(p, encoding="utf8").read()
    total += len(re.sub(r"\s", "", re.sub(r"^# .*", "", t, flags=re.M)))
assert ledger == total, "账本累计 %d != 机算 %d (漂移 %d)" % (ledger, total, ledger - total)
'

# ── T26 测试选择器 last-wins(2026-09-08 22:4x 固化——追加式账本未去重, 已通过测试被反复复活) ──
echo "[T26] 测试选择器last-wins(追加式账本同id多状态: 先pending后passed 不得复活)"
# 26a. src 含按 id 去重
t "src按id取最后一条" bash -c "grep -q 'byId.set(item.id' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'"
# 26b. lib 已部署
t "lib含last-wins(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")).read()
assert "byId.set(" in s, "lib 未部署 last-wins 去重"
'
# 26c. 账本确为追加式(同 id 多状态) —— 断言前提真实存在
t "账本为追加式(同id多状态)" python3 -c '
import json, os
from collections import Counter
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
c = Counter(r.get("id") for r in rows)
multi = [k for k, v in c.items() if v > 1 and k and k.startswith("tp-")]
assert multi, "无同 id 多记录, 本断言前提不成立"
'
# 26d. 模拟新旧选择逻辑: 新逻辑挑中的必为真 pending; 旧逻辑若挑到不同 id 则该 id 已被推进
t "去重后不复活已通过测试" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
by_id = {}
for r in rows:
    if r.get("id"): by_id[r["id"]] = r
def pick(dedupe):
    if dedupe:
        cands = [k for k, v in by_id.items() if v.get("status") == "pending" and v.get("title")]
    else:
        cands = sorted({r["id"] for r in rows if r.get("status") == "pending" and r.get("title")})
    return sorted(cands)[0] if cands else None
new, old = pick(True), pick(False)
assert new is None or by_id[new].get("status") == "pending", "新逻辑挑中非 pending: %s" % new
if old is not None and old != new:
    assert by_id[old].get("status") != "pending", "旧逻辑挑到 %s 但其最后状态仍为 pending" % old
print("new=%s old=%s" % (new, old))
'

# ── T27 引用结算存活(2026-09-08 23:5x 固化——cl-044: 引用率 50%→0.5%, 学习信号停摆两天) ──
echo "[T27] 引用结算存活(注入块带引用契约 + 未结算注入不得超期滞留)"
# 27a. 注入块含引用契约
t "src注入块含引用契约" bash -c "grep -q '引用契约' '$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts'"
# 27b. lib 已部署
t "lib含引用契约(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")).read()
assert "引用契约" in s, "lib 未部署引用契约"
'
# 27c. TTL 结算在源码与 lib
t "TTL结算已部署" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
lib = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "INJECTION_SETTLE_TTL_MS" in src and "INJECTION_SETTLE_TTL_MS" in lib, "TTL 结算未部署"
'
# 27d. 运行时: 未结算注入不得有超过 48h 的(TTL=24h + 余量)
t "无超期未结算注入" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/injections.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
now = time.time()
def age_h(r):
    v = r.get("createdAt") or 0
    v = float(v) if v else 0
    return (now - (v / 1000 if v > 1e11 else v)) / 3600
stale = [r.get("injectionId") for r in rows if r.get("cited") is None and age_h(r) > 48]
assert not stale, "超期未结算注入: %s" % stale[:3]
'
# 27e. 引用率非零(近 7 天至少一条被引用)
t "近7天有引用记录" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/injections.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
now = time.time()
def ts(r):
    v = r.get("createdAt") or 0
    v = float(v) if v else 0
    return v / 1000 if v > 1e11 else v
recent = [r for r in rows if ts(r) > now - 7 * 86400]
cited = [r for r in recent if r.get("cited")]
assert cited, "近 7 天零引用——学习信号停摆"
'

# ── T28 改动覆盖元测试(2026-09-09 00:0x 固化——把"审视帧第一问"机器化) ──
echo "[T28] 改动覆盖元测试(24h 内改动的 src 文件必须被断言引用——防'改了机制没加测试')"
t "24h改动文件均有断言覆盖" python3 -c '
import subprocess, os
root = os.path.expanduser("~/dsh-fork")
suite = open(os.path.join(root, "dsh-cog-tests.sh"), encoding="utf8").read()
out = subprocess.run(
    ["git", "-C", root, "log", "--since=24 hours ago", "--name-only", "--pretty=format:", "--", "packages"],
    capture_output=True, text=True).stdout
files = [f for f in sorted(set(out.split())) if f.endswith(".ts") and "/src/" in f]
assert files, "24h 内无 src 改动(元测试前提不成立)"
missing = [f for f in files
           if "/".join(f.split("/")[:3]) not in suite and f.split("/")[-1] not in suite]
assert not missing, "改动但无断言引用: %s" % missing[:3]
'

# ── T29 经验样本二次处理(2026-09-09 00:1x 固化——cl-045: 81 条帧经验效用因 snake_case 键名恒为 None) ──
echo "[T29] 经验样本二次处理(字段键名无损迁移: snake_case 效用须归一为驼峰并恢复数值)"
# 29a. src 含迁移函数
t "src含效用键名迁移" bash -c "grep -q 'normalizeUtilityKeys' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts'"
# 29b. lib 已部署
t "lib含键名迁移(已部署)" bash -c "grep -q 'normalizeUtilityKeys' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
# 29c. 运行时: 无任何经验效用缺失
t "无效用缺失经验" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
missing = []
for f in ("experiences.jsonl", "experiences-frames.jsonl"):
    for l in open(os.path.join(d, f)):
        if not l.strip(): continue
        r = json.loads(l)
        u = ((r.get("sar") or {}).get("outcomeUtility") or {})
        if u.get("materialGain") is None:
            missing.append(r.get("expId"))
assert not missing, "效用仍缺失: %s" % missing[:3]
'
# 29d. 运行时: outcomeUtility 内不得再有 snake_case 键(按 JSON 键判定, 非文本匹配——
#      首版用文本匹配被 exp_98 正文里提到的字段名误伤, 属断言设计缺陷)
t "无snake_case效用键残留" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
bad = []
for f in ("experiences.jsonl", "experiences-frames.jsonl"):
    for l in open(os.path.join(d, f)):
        if not l.strip(): continue
        r = json.loads(l)
        keys = ((r.get("sar") or {}).get("outcomeUtility") or {}).keys()
        if any(k in keys for k in ("material_gain", "emotional_valence", "energy_cost")):
            bad.append(r.get("expId"))
assert not bad, "outcomeUtility 内 snake_case 键残留: %s" % bad[:3]
'

# ── T30 外推机制(2026-09-09 00:2x 固化——cl-046: 一处修复须外推扫描同型点) ──
echo "[T30] 外推机制(meta 子类用显式标记 + 外推扫描器可用——防'修一处就停')"
# 30a. 读取侧用显式 metaKind 标记
t "meta子类用显式标记" bash -c "grep -q \"metaKind === 'acceptance-deviation'\" '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts'"
# 30b. 读取侧不再用 situation 文本嗅探
t "不再用文本嗅探找meta" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
assert "exp.sar.situation.includes(\"验收准则持续被违反\")" not in s, "仍在用文本嗅探"
'
# 30c. lib 已部署
t "lib含metaKind(已部署)" bash -c "grep -q 'acceptance-deviation' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
# 30d. 外推扫描器存在且可执行
t "外推扫描器可用" bash -c "test -x '$HOME/dsh-fork/dsh-extrapolate.sh' && bash '$HOME/dsh-fork/dsh-extrapolate.sh' 'ZZZ_NO_MATCH' '$HOME/dsh-fork/packages/cognition' | grep -q '孤例'"
# 30e. 运行时: 带该短语的 meta 经验必须带 metaKind(无第二判别器)
t "meta标记与文本一致" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
bad = []
for f in ("experiences.jsonl", "experiences-frames.jsonl"):
    for l in open(os.path.join(d, f)):
        if not l.strip(): continue
        r = json.loads(l)
        sit = ((r.get("sar") or {}).get("situation") or "")
        if r.get("meta") and "验收准则持续被违反" in sit and not r.get("metaKind"):
            bad.append(r.get("expId"))
assert not bad, "带该短语的 meta 经验无显式标记: %s" % bad[:3]
'

# ── T31 对照挖掘器(2026-09-09 00:2x 固化——cl-047: "为什么"的原料是对照样本+可信标签) ──
echo "[T31] 对照挖掘器(同类对照对/锚定率/类内极差裁决——回答'能否提炼因果')"
t "对照挖掘器可用" bash -c "test -f '$HOME/dsh-fork/dsh-contrast.py' && python3 '$HOME/dsh-fork/dsh-contrast.py' | grep -q '最大类内极差'"
t "报告锚定率与裁决" python3 -c '
import subprocess, os
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-contrast.py")],
                     capture_output=True, text=True).stdout
assert "全库锚定率" in out, "未报告锚定率"
assert ("不能" in out or "可尝试提炼" in out), "未给出裁决"
'

# ── T32 crontab 转义守卫(2026-09-09 00:4x 固化——cl-049: 未转义 % 让提交腿停摆 25h) ──
echo "[T32] crontab转义守卫(命令中的 % 必须转义为 \\%——cron 在首个 % 处截断命令)"
t "crontab无未转义%" python3 -c '
import subprocess
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
bad = []
for i, l in enumerate(out.split("\n"), 1):
    if not l.strip() or l.strip().startswith("#"): continue
    if "%" in l.replace("\\%", ""):
        bad.append((i, l[:70]))
assert not bad, "存在未转义 %%: %s" % bad[:2]
'
# 32b. 提交腿的 cron 行确实被修好(含转义)
t "提交cron行已转义" python3 -c '
import subprocess
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
line = [l for l in out.split("\n") if "cognitive update" in l]
assert line, "找不到提交 cron 行"
assert "\\%H" in line[0] or "%" not in line[0], "提交行仍未转义: %s" % line[0][:80]
'

# ── T33 open 项到期裁决(2026-09-09 00:5x 固化——账本滞留 18 条一天无人裁决, 同 cl-037 家族) ──
echo "[T33] open项到期裁决(每条 open/in-progress 须有 reviewBy; 过期未裁决即失败)"
t "open项均有reviewBy" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
bad = [k for k, v in by_id.items()
       if v.get("status") in ("open", "in-progress") and not v.get("reviewBy")]
assert not bad, "无 reviewBy 的 open 项: %s" % bad[:3]
'
t "open项未过期" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
today = datetime.date.today().isoformat()
overdue = [k for k, v in by_id.items()
           if v.get("status") in ("open", "in-progress")
           and isinstance(v.get("reviewBy"), str) and v["reviewBy"] < today]
assert not overdue, "已过 reviewBy 未裁决: %s" % overdue[:3]
'

# ── T34 目标池 nextAction 滞留(cl-054, 2026-09-09 01:1x——T33 只管账本, 目标池仍无滞留锚) ──
echo "[T34] 目标池 nextAction 滞留(active 目标须有 watch 记录; 超 maxDays 且无未来 reviewBy 即失败)"
t "目标watch脚本可运行" bash /home/ubuntu/dsh-fork/dsh-goal-watch.sh
t "active目标均有watch记录" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
goals = [json.loads(l) for l in open(D + "/dormant-goals.jsonl", encoding="utf8") if l.strip()]
active = [g["id"] for g in goals if g.get("status") == "active"]
watch = json.load(open(D + "/goal-watch.json", encoding="utf8"))
missing = [g for g in active if g not in watch]
assert not missing, "无 watch 记录的 active 目标: %s" % missing
'
t "active目标nextAction未超期" python3 -c '
import json, os, datetime
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
goals = [json.loads(l) for l in open(D + "/dormant-goals.jsonl", encoding="utf8") if l.strip()]
active = [g["id"] for g in goals if g.get("status") == "active"]
watch = json.load(open(D + "/goal-watch.json", encoding="utf8"))
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
today = now.date().isoformat()
stale = []
for gid in active:
    r = watch.get(gid, {})
    try:
        days = (now - datetime.datetime.fromisoformat(r["lastChanged"])).total_seconds() / 86400.0
    except Exception:
        stale.append(gid + "(无lastChanged)")
        continue
    maxd = r.get("maxDays", 2)
    rb = r.get("reviewBy")
    if days > maxd and not (isinstance(rb, str) and rb >= today):
        stale.append("%s(%.1fd>%sd)" % (gid, days, maxd))
assert not stale, "滞留未裁决: %s" % stale
'

# ── T35 词级关键词守卫(2026-09-09 01:4x 固化——cl-058: 结构化输入使 LLM 省略关键词, 回退成单字) ──
echo "[T35] 词级关键词(行动关键词须为词级元素, 单字关键词会饿死词元素通道与 actionVector)"
t "src含元素抽取器" bash -c "grep -q 'export function elements' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/src/vectorizer.ts'"
t "src含关键词兜底与修复" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
assert "ensureWordKeywords" in s and "repairCharKeywords" in s, "缺兜底/修复"
'
t "lib含词级关键词(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "ensureWordKeywords" in s and "repairCharKeywords" in s, "lib 未部署"
'
t "无字符级关键词经验" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
bad = []
for f in ("experiences.jsonl", "experiences-frames.jsonl"):
    for l in open(os.path.join(d, f)):
        if not l.strip(): continue
        r = json.loads(l)
        kw = ((r.get("sar") or {}).get("actionKeywords") or [])
        if not kw: continue
        singles = sum(1 for k in kw if len(k) == 1)
        if singles / len(kw) > 0.5: bad.append(r.get("expId"))
assert not bad, "字符级关键词残留: %s" % bad[:3]
'

# ── T36 章-账本一致性(2026-09-09 08:2x 固化——exp_238: 账本写入被中断, 章落盘而账本漏记) ──
echo "[T36] 章-账本一致性(最新章须出现在账本末轮; 全部新标尺章须被账本提及)"
t "最新章已在账本末轮" python3 -c '
import glob, os, re
d = os.path.expanduser("~/dsh-workshop/novels/qizhongjiyi")
drafts = sorted(glob.glob(os.path.join(d, "drafts/00*.md")))
assert drafts, "无草稿"
maxch = int(re.search(r"(\d+)", os.path.basename(drafts[-1])).group(1))
prog = open(os.path.join(d, "audit/progress.md"), encoding="utf8").read()
tail = "\n".join(prog.splitlines()[-12:])
assert ("ch%d" % maxch) in tail, "最新章 ch%d 未出现在账本末轮(写入可能被中断)" % maxch
'
t "全部新标尺章均被账本提及" python3 -c '
import glob, os, re
d = os.path.expanduser("~/dsh-workshop/novels/qizhongjiyi")
drafts = sorted(glob.glob(os.path.join(d, "drafts/00*.md")))
maxch = int(re.search(r"(\d+)", os.path.basename(drafts[-1])).group(1))
prog = open(os.path.join(d, "audit/progress.md"), encoding="utf8").read()
missing = [n for n in range(15, maxch + 1) if ("ch%d" % n) not in prog]
assert not missing, "账本漏记章节: %s" % missing[:5]
'

# ── T37 词元素检索通道(2026-09-09 08:4x 固化——cl-052 接入: 离线 76% vs 三通道融合 65%) ──
echo "[T37] 词元素检索通道(BM25 通道已接入融合, 权重可学习, 全文可见)"
t "src含BM25通道" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts")).read()
assert "lexicalScore" in s and "lexicalCorpus" in s, "缺 BM25 通道实现"
assert "\x27semantic\x27, \x27situational\x27, \x27symptom\x27, \x27outcome\x27, \x27lexical\x27" in s, "融合键未含 lexical"
'
t "ChannelWeights含lexical" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/types.ts")).read()
assert "readonly lexical: number" in s, "类型缺 lexical"
'
t "lib含词元素通道(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "lexicalScore" in s and "lexicalCorpus" in s, "lib 未部署"
'
t "运行时权重含lexical" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/channel_weights.json")
d = json.load(open(p))
assert "lexical" in d, "运行时 channel_weights 缺 lexical: %s" % list(d)
assert 0.2 <= d["lexical"] <= 3, "lexical 权重越界: %s" % d["lexical"]
'

# ── T38 载体剥离三问机制化 + 词元素通道回归(2026-09-09 10:0x 固化——cl-002 证伪信号 + cl-052 前提) ──
echo "[T38] 载体剥离三问(新设计文档借人类概念须附三问) + 词元素通道离线回归"
t "新设计文档须附载体剥离三问" python3 -c '
import glob, os, re, time
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
CUTOFF = time.mktime(time.strptime("2026-09-09 10:00", "%Y-%m-%d %H:%M"))
concept = re.compile(r"贝叶斯|认知科学|类比|熟悉感|遗忘曲线|多巴胺|注意力机制|情绪")
mechanism = re.compile(r"机制|设计|通道|管线")
missing = []
for p in glob.glob(os.path.join(d, "*.md")):
    if os.path.getmtime(p) < CUTOFF: continue
    t = open(p, encoding="utf8").read()
    if concept.search(t) and mechanism.search(t) and "载体剥离" not in t:
        missing.append(os.path.basename(p))
assert not missing, "借用人类概念的新设计文档缺载体剥离三问: %s" % missing
'
t "词元素通道仍优于现有多通道融合" python3 -c '
import subprocess, os, re
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-bayes-retrieval-experiment.py")],
                     capture_output=True, text=True, timeout=300).stdout
def pct(label):
    m = re.search(re.escape(label) + r".*?(\d+)%", out)
    assert m, "未找到 %s 的输出" % label
    return int(m.group(1))
lex = pct("词元素通道(单字BM25·全文)")
fuse = pct("融合(语义+结果+行动, 等权)")
assert lex >= fuse, "词元素通道 %d%% < 现有多通道融合 %d%%（cl-052 前提失效，需重估）" % (lex, fuse)
'

# ── T39 目标孵化哨兵可用性(2026-09-09 10:3x 固化——cl-060: 池向量 1024 维 vs 运行时 384 维, cosine 恒 0, 机制从未触发) ──
echo "[T39] 目标孵化哨兵(向量维度自愈 + 阈值在哈希袋可达区间 + 触发计数会动)"
t "src含维度自愈" bash -c "grep -q '维度不符' '$HOME/dsh-fork/packages/context/dormant-goal/src/index.ts'"
t "lib含维度自愈(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")).read()
assert "维度不符" in s, "lib 未部署自愈逻辑"
'
t "阈值在哈希袋可达区间" python3 -c '
import re, os
t = open(os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")).read()
m = re.search(r"repThreshold:\s*([0-9.]+)", t)
k = re.search(r"kernelThreshold:\s*([0-9.]+)", t)
f = re.search(r"focusThreshold:\s*([0-9.]+)", t)
assert m and k and f, "阈值未找到"
# 哈希袋实测: 目标文本 vs 134 条情境最高 0.561, p95 0.42-0.46 → 阈值须 ≤ 0.55 才可能触发
for name, val in (("rep", float(m.group(1))), ("kernel", float(k.group(1))), ("focus", float(f.group(1)))):
    assert val <= 0.55, "%s 阈值 %.2f 超出哈希袋可达区间(实测最高 0.561)" % (name, val)
'
# 2026-09-09 11:3x 加固: 原断言只要字段存在(死机制也能过) → 改为要求真实触发>0 且采纳字段可观测
t "哨兵真实触发且采纳可观测" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
goals = [json.loads(l) for l in open(p) if l.strip()]
assert all("triggerCount" in g and "adoptedCount" in g for g in goals), "trigger/adopted 字段缺失"
total = sum(g.get("triggerCount") or 0 for g in goals)
assert total > 0, "哨兵累计触发为 0——机制可能又死了(cl-060 复发)"
print("累计触发 %d | 累计采纳 %d" % (total, sum(g.get("adoptedCount") or 0 for g in goals)))
'

# ── T40 目标池向量维度一致(2026-09-09 11:5x 固化——cl-060 根因: 池向量 1024 维 vs 运行时 384 维) ──
echo "[T40] 目标池向量维度(池内向量须等于源码 ACTION_VECTOR_DIM——防维度错配再次让哨兵静默死亡)"
t "池向量维度与源码一致" python3 -c '
import json, os, re
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/vectorizer.ts")).read()
m = re.search(r"ACTION_VECTOR_DIM\s*=\s*(\d+)", src)
assert m, "取不到 ACTION_VECTOR_DIM"
dim = int(m.group(1))
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
bad = []
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    g = json.loads(l)
    for key in ("repVector", "kernelVector", "focusVector"):
        v = g.get(key)
        if v is not None and len(v) != dim:
            bad.append("%s.%s=%d" % (g.get("id"), key, len(v)))
assert not bad, "维度错配(源码 %d): %s" % (dim, bad[:3])
'

# ── T41 预测环未停摆(2026-09-09 11:4x 固化——cl-062: 预测只在用户活跃窗产, 用户离场期校准冻结) ──
echo "[T41] 预测环存活(24h 内须有新预测——预测是校准/通道权重的唯一反馈源)"
t "24h内有新预测" python3 -c '
import json, os, time, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/predictions.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
def ts(r):
    v = float(r.get("timestamp") or r.get("createdAt") or 0)
    return v/1000 if v > 1e11 else v
newest = max((ts(r) for r in rows), default=0)
age = (time.time() - newest) / 3600
assert age < 24, "最新预测距今 %.1f 小时——预测环可能停摆(校准与通道权重将冻结)" % age
print("最新预测距今 %.1f 小时" % age)
'

# ── T42 孵化三指标自动化(2026-09-09 12:0x 固化——行动帧: 推进率从人工核对改为结构化判据) ──
echo "[T42] 孵化三指标(触发/采纳/推进 自动统计 + 采纳时刻落盘)"
t "采纳时刻落盘已部署" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts")).read()
lib = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")).read()
assert "incubation-log.jsonl" in src and "incubation-log.jsonl" in lib, "采纳时刻未落盘"
'
t "三指标脚本可跑出三列" python3 -c '
import subprocess, os
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py")],
                     capture_output=True, text=True, timeout=60).stdout
assert "触发" in out and "采纳" in out and "推进" in out, "缺少三列"
assert "goal-digital-life-incubation" in out, "未统计到目标"
assert os.path.exists(os.path.expanduser("~/.dsh/cognitive-pipeline/incubation-stats.md")), "未产出统计文件"
'
t "变更历史在积累" python3 -c '
import os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/goal-watch-history.jsonl")
assert os.path.exists(p) and os.path.getsize(p) > 0, "goal-watch 变更历史为空(推进率无从判定)"
'

# ── T43 孵化指标有效性(2026-09-09 12:1x 固化——cl-063: 注入块自激 + 关键词采纳必中) ──
echo "[T43] 孵化指标有效性(自激抑制 + 结构性采纳证据)"
t "src抑制自激" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts")).read()
assert "source?.plugin !== name" in s, "未排除本插件注入块(自激)"
'
t "lib含结构性采纳(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")).read()
assert "pool-change" in s and "poolSnapshot" in s, "lib 未部署结构性采纳"
'
t "采纳须结构性证据" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts")).read()
assert "structural" in s and "keywordFallback" in s, "采纳判据未改为结构性+兜底"
'

# ── T44 检索精排可提升(2026-09-09 12:5x 固化——cl-068: 从"只剔除"扩展为"可排序") ──
echo "[T44] 检索精排(候选窗口 5 + best_exp_id 提升, 头寸来自 recall@10=95% vs top-1=76%)"
t "src含bestExpId提升" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts")).read()
assert "bestExpId" in s and "精排提升" in s, "未见提升逻辑"
assert ".slice(0, 5)" in s, "候选窗口未放宽到 5"
'
t "提示词含best_exp_id" python3 -c '
import os
s = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/prompts.ts")
t = open(s).read()
assert "best_exp_id" in t, "提示词未要求返回 best_exp_id"
'
t "lib含精排提升(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "bestExpId" in s and "best_exp_id" in s, "lib 未部署精排提升"
'

# ── T45 精排门控可用性(2026-09-09 13:0x 固化——cl-070: 原门控依赖 no-taxonomy 永假) ──
echo "[T45] 精排门控(须有与分类体系无关的触发条件——否则精排永远空转)"
t "src含相对分差门控" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts")).read()
assert "refineRelativeGap" in s and "relativeGap" in s, "未见相对分差门控"
'
t "配置项已定义" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
assert "refineRelativeGap: z.number()" in s, "配置 schema 缺 refineRelativeGap"
'
t "lib含相对分差(已部署)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")).read()
assert "refineRelativeGap" in s, "lib 未部署"
'

# ── T46 推进判据用外部产物锚(2026-09-09 13:2x 固化——cl-069: 记账动作曾被计成推进) ──
echo "[T46] 推进判据=外部产物锚(小说字数/git 提交数/套件通过数; 记账动作改不动)"
t "外部锚采集在脚本里" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py")).read()
for key in ("draftsChars", "gitCommits", "suitePasses"):
    assert key in s, "缺外部锚 %s" % key
'
t "外部锚账本在积累" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/external-anchors.jsonl")
rows = [json.loads(l) for l in open(p) if l.strip()]
assert rows, "外部锚账本为空"
last = rows[-1]
for key in ("draftsChars", "gitCommits", "suitePasses"):
    assert key in last, "快照缺 %s" % key
assert last["draftsChars"] > 0, "小说字数为 0, 锚不可用"
'
# 判据: advanced() 的**代码**不得再读 changeCount(注释里提及历史不算)
t "推进判据不再读changeCount" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py")).read()
seg = s[s.index("def advanced("):s.index("rows = []")]
# 旧实现读 watch[...].get("changeCount", 0); 新实现只读外部锚
assert "changeCount\", 0" not in seg.replace(chr(39), chr(34)), "推进判据仍读 changeCount"
assert "draftsChars" in seg and "gitCommits" in seg and "suitePasses" in seg, "推进判据未用外部锚"
'

# ── T47 工具脚本语法闸(2026-09-09 13:3x 固化——cl-072: 测试脚本自身语法错时无法自保) ──
echo "[T47] 工具脚本语法闸(dsh-script-lint: bash -n + py_compile, 独立于套件)"
t "语法闸脚本存在且可执行" bash -c "test -x '$HOME/dsh-fork/dsh-script-lint.sh'"
t "语法闸覆盖套件自身" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-script-lint.sh")).read()
assert "dsh-*.sh" in s and "bash -n" in s, "未覆盖 .sh 语法检查"
assert "py_compile" in s, "未覆盖 .py 语法检查"
'
t "语法闸当前全绿" bash -c "bash '$HOME/dsh-fork/dsh-script-lint.sh' | grep -q '全部脚本语法通过'"
t "语法闸已挂cron" bash -c "crontab -l 2>/dev/null | grep -q dsh-script-lint"

# ── T48 精排审计落盘(2026-09-09 13:3x 固化——cl-071: 精排门控挂在旧前提, 提升项质量无法事后评估) ──
# 根因: refineRetrieval 只回传 note 文本, 被提升项/原首位都随进程丢弃 → "提升得准不准"永远无从统计。
# 验收: 类型有字段 + 两处写入点都落盘 + 编译产物新鲜 + 运行时账本真的出现该键(外部锚, 非自报)。
echo "[T48] 精排审计落盘(cl-071: 类型/写入点/产物/运行时账本四层)"
t "Prediction类型含精排审计字段" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/types.ts")).read()
seg = s[s.index("export interface Prediction"):s.index("export interface TempStrategy") if "export interface TempStrategy" in s else len(s)]
for key in ("retrievalNote", "promotedExpId", "originalTopExpId"):
    assert key in seg, "Prediction 缺字段 %s" % key
'
t "两处addPrediction均落盘审计" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts")).read()
assert s.count("retrievalNote: refine.note") == 2, "写入点不足两处: %d" % s.count("retrievalNote: refine.note")
assert "promotedExpId: refine.promotedExpId" in s and "originalTopExpId: refine.originalTopExpId" in s, "缺提升项/原首位落盘"
assert s.count("this.store.addPrediction(") == 2, "addPrediction 调用点数变了(%d), 需同步落盘" % s.count("this.store.addPrediction(")
'
t "编译产物含审计字段" bash -c "grep -q retrievalNote '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js' && grep -q promotedExpId '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "运行时账本已出现审计键" python3 -c '
import json, os, subprocess
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
build_ms = os.path.getmtime(lib) * 1000
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
assert ep.isdigit(), "无法解析服务启动时间: %r" % svc
svc_ms = int(ep) * 1000
# 判据锚点=当前进程开始运行的时刻(而非构建时刻): 构建后、重启前由旧进程写下的预测
# 天然缺字段, 拿它判红会把"进程未更新"和"代码未落盘"两件事混在一起。
cutoff = max(build_ms, svc_ms)
keys = ("retrievalNote", "promotedExpId", "originalTopExpId")
rows = [json.loads(l) for l in open(os.path.join(base, "predictions.jsonl")) if l.strip()]
assert rows, "预测账本为空"
newer = [r for r in rows if r.get("timestamp", 0) > cutoff]
if newer:
    bad = [r for r in newer if not all(k in r for k in keys)]
    assert not bad, "当前进程写出的 %d 条预测缺审计键" % len(bad)
else:
    # 无新预测(预测只在用户活跃窗创建, cl-062) → 退化为进程新鲜度锚。
    assert svc_ms > build_ms, "服务启动早于构建(未加载新字段)"
'

# ── T49 暂停目标两侧同时停(2026-09-09 13:4x 固化——cl-073: 用户暂停写作后孵化提醒照样打扰) ──
# 根因: quiet-driver 的 findAllActionableGoals 只选 status==='active', 但 dormant-goal 的
#       唤醒循环只按相似度触发, 不读 status → "暂停"只停了一半(行动帧停、孵化提醒不停)。
echo "[T49] 暂停目标两侧同时停(status 门: 行动帧 + 孵化提醒)"
t "dormant-goal含status门" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts")).read()
assert "goal.status !== " in s and chr(39) + "active" + chr(39) in s, "唤醒循环未读 status"
i = s.index("for (const goal of pool)")
seg = s[i:i+600]
assert "status" in seg, "status 门不在唤醒循环内"
'
t "dormant-goal产物含status门(已部署)" bash -c "grep -q 'goal.status' '$HOME/dsh-fork/packages/context/dormant-goal/lib/index.js'"
t "行动帧侧只选active" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts")).read()
i = s.index("findAllActionableGoals")
seg = s[i:i+900]
assert "status === " in seg and chr(39) + "active" + chr(39) in seg, "行动帧选择器未限定 active"
'
t "小说目标处于paused" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
g = [x for x in rows if x.get("id") == "goal-novel-60w"]
assert g, "小说目标不在池里"
assert g[0].get("status") == "paused", "状态未暂停: %r" % g[0].get("status")
assert g[0].get("pauseReason") and g[0].get("resumeCondition"), "缺暂停理由/恢复条件"
'
t "paused目标无行动帧可选中" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
def actionable(g):
    na = (g.get("nextAction") or "").strip()
    return g.get("title") and g.get("status") == "active" and na and na not in ("无", "none")
picked = [g["id"] for g in rows if actionable(g)]
assert "goal-novel-60w" not in picked, "暂停的小说目标仍会被行动帧选中"
'

# ── T50 陈旧链锚守卫(2026-09-09 14:4x 固化——cl-075: 暂停目标仍吸收新经验, exp_253 被锚到已 paused 的目标) ──
echo "[T50] 陈旧链锚守卫(粘性锚指向非 active 目标 → 清除, 失败开放)"
t "resolveChainAnchor含池状态校验" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")).read()
assert "poolGoalStatus" in s, "缺池状态读取"
assert "setChainAnchor(sessionId, null)" in s, "缺清除动作"
i = s.index("const status = await poolGoalStatus(anchored)")
seg = s[i:i+400]
assert "!== " in seg and "active" in seg, "守卫判据未比对 active"
'
t "链锚解析已改异步(调用点带await)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")).read()
assert s.count("await resolveChainAnchor(") == 2, "调用点未全部 await: %d" % s.count("await resolveChainAnchor(")
'
t "产物含池状态守卫(已部署)" bash -c "grep -q poolGoalStatus '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "守卫规则对真实数据生效" python3 -c '
import json, os
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
pool = {}
for l in open(os.path.join(base, "dormant-goals.jsonl"), encoding="utf8"):
    if l.strip():
        g = json.loads(l)
        if g.get("id"): pool[g["id"]] = g.get("status")
try:
    anchors = json.load(open(os.path.join(base, "chain_anchors.json"), encoding="utf8"))
except Exception:
    anchors = {}
# 复刻守卫逻辑: 锚指向的目标存在且非 active → 应被清除
stale = {s: g for s, g in anchors.items() if g in pool and pool[g] != "active"}
assert not stale, "存在会被守卫清除的陈旧锚: %s" % stale
'
t "停机窗口脚本就位" bash -c "test -x '$HOME/dsh-fork/dsh-reanchor.sh' && bash -n '$HOME/dsh-fork/dsh-reanchor.sh' && test -x '$HOME/dsh-fork/dsh-reanchor-apply.py'"

# ── T51 编辑期语法闸(cl-072: 编辑动作与校验动作之间无强制绑定) ──
echo "[T51] 编辑期语法闸(套件自检 + 工具脚本前置 + 编辑后立即校验helper)"
t "套件开头有自检块" bash -c "grep -q '套件自身语法错误' '$HOME/dsh-fork/dsh-cog-tests.sh'"
t "自检能抓出语法错" python3 -c '
import subprocess, tempfile, shutil, os
src = os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh")
good = subprocess.run(["bash", "-n", src], capture_output=True, text=True)
assert good.returncode == 0, "原文件本身语法错"
fd, bad = tempfile.mkstemp(suffix=".sh")
os.close(fd)
shutil.copy(src, bad)
with open(bad, "a", encoding="utf8") as f:
    f.write(chr(10) + "if then" + chr(10))
r = subprocess.run(["bash", "-n", bad], capture_output=True, text=True)
assert r.returncode != 0, "注入语法错后 bash -n 仍通过——自检无效"
os.unlink(bad)
'
t "语法闸已前置到套件开头" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
i = s.index("dsh-script-lint.sh")
j = s.index("=== 认知有效性测试")
assert i < j, "语法闸不在测试执行之前"
'
t "编辑后立即校验helper就位" bash -c "test -x '$HOME/dsh-fork/dsh-edit-check.sh'"
t "helper能抓出坏文件" python3 -c '
import subprocess, tempfile, os
fd, bad = tempfile.mkstemp(suffix=".sh"); os.close(fd)
open(bad, "w", encoding="utf8").write("if then" + chr(10))
r = subprocess.run([os.path.expanduser("~/dsh-fork/dsh-edit-check.sh"), bad], capture_output=True, text=True)
os.unlink(bad)
assert r.returncode != 0, "坏文件未被抓出"
'
t "helper放行好文件" bash -c "'$HOME/dsh-fork/dsh-edit-check.sh' '$HOME/dsh-fork/dsh-cog-tests.sh' | grep -q '全部通过'"

# ── T52 存量采纳基线(cl-078: 无时间戳的采纳不该默默消失, 也不该永久挂"待观察") ──
echo "[T52] 存量采纳基线(不可判定项单列, 不进推进率分母)"
t "基线文件存在且结构正确" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/incubation-baseline.json")
d = json.load(open(p, encoding="utf8"))
assert d.get("ts") and isinstance(d.get("goals"), dict), "基线结构不对"
for gid, v in d["goals"].items():
    assert isinstance(v.get("undecidableAdoptions"), int) and v["undecidableAdoptions"] >= 0, gid
'
t "统计脚本支持不可判定列" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
for key in ("incubation-baseline.json", "undecidable", "adopted_counter"):
    assert key in s, "缺 %s" % key
assert "不可判定" in s, "缺表头/说明"
'
t "指标报告含不可判定列" bash -c "grep -q '不可判定' '$DIR/incubation-stats.md'"
# 差额必须恒定 = 基线存量残差: 新采纳同时进计数器与日志, 差额不变;
# 差额缩小=丢了一次 bump(计数器被覆盖), 差额增大=丢了一条日志。两种都是缺陷, 不是"旧状态"。
# (2026-09-09 15:2x 实测差额 2→1, 该断言正是对的——问题在数据, 不在断言。)
t "基线记录自身自洽" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
base = json.load(open(os.path.join(D, "incubation-baseline.json"), encoding="utf8")).get("goals", {})
for gid, v in base.items():
    c, l, u = v.get("adoptedCountAtBaseline"), v.get("loggedAtBaseline"), v.get("undecidableAdoptions")
    assert isinstance(c, int) and isinstance(l, int) and isinstance(u, int), gid
    assert u == max(0, c - l), "%s 基线不自洽: counter %s - logged %s != %s" % (gid, c, l, u)
'
t "计数与日志不倒退(丢更新检测)" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
goals = [json.loads(l) for l in open(os.path.join(D, "dormant-goals.jsonl"), encoding="utf8") if l.strip()]
log = [json.loads(l) for l in open(os.path.join(D, "incubation-log.jsonl"), encoding="utf8") if l.strip()]
base = json.load(open(os.path.join(D, "incubation-baseline.json"), encoding="utf8")).get("goals", {})
bad = []
for g in goals:
    gid = g["id"]
    logged = len([a for a in log if a.get("goalId") == gid])
    counter = g.get("adoptedCount") or 0
    if gid in base:
        assert logged >= base[gid]["loggedAtBaseline"], "%s 日志条数倒退" % gid
        assert counter >= base[gid]["adoptedCountAtBaseline"], "%s 计数器倒退" % gid
    if gid in base:
        want = base[gid]["undecidableAdoptions"]
        got = max(0, counter - logged)
        assert got == want, "%s 差额漂移: 当前 %d vs 基线 %d(缩小=丢bump/增大=丢日志)" % (gid, got, want)
'

# ── T53 停机修复工具可离线验证(cl-076 后续: 修复脚本本身要能在临时目录上跑通, 不靠"停机时祈祷") ──
echo "[T53] 链锚修复工具(临时目录跑通 + 幂等 + 不动真实数据)"
t "修复工具在临时副本上生效" python3 -c '
import json, os, shutil, subprocess, tempfile
base = tempfile.mkdtemp(prefix="reanchor-")
src = os.path.expanduser("~/.dsh/cognitive-pipeline")
for name in ("experiences.jsonl", "dormant-goals.jsonl"):
    shutil.copy(os.path.join(src, name), base)
# 构造: 一条待修经验 + 一个指向已暂停目标的粘性锚
exp = os.path.join(base, "experiences.jsonl")
rows = [json.loads(l) for l in open(exp, encoding="utf8") if l.strip()]
rows[0]["expId"] = "exp_test"
rows[0].pop("chainId", None)
open(exp, "w", encoding="utf8").write(chr(10).join(json.dumps(r, ensure_ascii=False) for r in rows) + chr(10))
json.dump({"sess-test": "goal-novel-60w"}, open(os.path.join(base, "chain_anchors.json"), "w", encoding="utf8"))
open(os.path.join(base, "reanchor-pending.jsonl"), "w", encoding="utf8").write(
    json.dumps({"expId": "exp_test", "chainId": "goal-digital-life-incubation"}) + chr(10))
tool = os.path.expanduser("~/dsh-fork/dsh-reanchor-apply.py")
r = subprocess.run(["python3", tool, "--base", base], capture_output=True, text=True)
assert r.returncode == 0, r.stderr
after = [json.loads(l) for l in open(exp, encoding="utf8") if l.strip()]
got = [x.get("chainId") for x in after if x.get("expId") == "exp_test"]
assert got == ["goal-digital-life-incubation"], got
anchors = json.load(open(os.path.join(base, "chain_anchors.json"), encoding="utf8"))
assert anchors == {}, anchors
r2 = subprocess.run(["python3", tool, "--base", base], capture_output=True, text=True)
assert r2.returncode == 0 and "应用 0 条" in r2.stdout, r2.stdout
shutil.rmtree(base)
'
t "待修链锚不超期(防'机制在条件已死')" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/reanchor-pending.jsonl")
if not os.path.exists(p):
    raise SystemExit(0)
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
if not rows:
    raise SystemExit(0)
now = datetime.datetime.now(datetime.timezone.utc)
stale = []
for r in rows:
    ts = r.get("ts")
    if not ts:
        continue
    try:
        at = datetime.datetime.fromisoformat(ts)
    except ValueError:
        continue
    if at.tzinfo is None:
        at = at.replace(tzinfo=datetime.timezone.utc)
    if now - at > datetime.timedelta(hours=24):
        stale.append(r.get("expId"))
assert not stale, "待修链锚超 24h 未应用(需一次停机窗口): %s" % stale
'
t "修复工具不改真实数据" python3 -c '
import json, os
src = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(src, "experiences.jsonl"), encoding="utf8") if l.strip()]
assert not any(r.get("expId") == "exp_test" for r in rows), "测试数据污染了真实库"
'

# ── T54 精排收益度量器(tp-050: 度量器本身错了就没人发现, 而它是"精排是否有益"的唯一判据) ──
echo "[T54] 精排收益度量器(refine-eval: A/B 分组 + 小样本保护 + cron)"
t "度量器存在且可执行" bash -c "test -x '$HOME/dsh-fork/dsh-refine-eval.py'"
t "度量器可运行且输出A1/A2/B分组" bash -c "python3 '$HOME/dsh-fork/dsh-refine-eval.py' | grep -q 'A1·真提升' && python3 '$HOME/dsh-fork/dsh-refine-eval.py' | grep -q 'A2·身份提升' && python3 '$HOME/dsh-fork/dsh-refine-eval.py' | grep -q 'B·未开火'"
t "小样本不给结论" python3 -c '
import re, subprocess, os
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-refine-eval.py")], capture_output=True, text=True).stdout
a = re.search(r"A1·真提升\(changed\): 已结算 (\d+) 条", out); b = re.search(r"B·未开火\(审计后\): 已结算 (\d+) 条", out)
assert a and b, "缺 A1/B 计数"
na, nb = int(a.group(1)), int(b.group(1))
if min(na, nb) < 5:
    assert "样本不足" in out, "小样本未保护: A=%d B=%d" % (na, nb)
else:
    assert "样本不足" not in out, "样本已足仍拒给结论: A=%d B=%d" % (na, nb)
'
t "度量器已挂cron" bash -c "crontab -l 2>/dev/null | grep -q dsh-refine-eval"

# ── T55 偏离元经验继承链锚(tp-051: cl-074 接线 + 条件性运行时见证) ──
echo "[T55] 偏离元经验继承链锚(cl-074: 接线/产物/条件性见证)"
t "verify_claim调用点透传链锚" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")).read()
assert "claimAnchor" in s and "chainId: claimAnchor.chainId" in s, "未透传链锚"
i = s.index("claimAnchor")
assert "resolveChainAnchor" in s[:i] or "resolveChainAnchor" in s[i:i+200], "锚未先解析"
'
t "偏离分支把链锚交给rememberMeta" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
i = s.index("metaKind: " + chr(39) + "acceptance-deviation" + chr(39))
seg = s[max(0, i-600):i+200]
assert "chainId" in seg, "偏离分支未接链锚"
j = s.index("chainId?: string")
assert j > 0, "rememberMeta 入参缺 chainId"
'
t "产物含偏离链锚透传(已部署)" bash -c "grep -q 'chainId: input.chainId' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "条件性见证: 构建后偏离经验必须带锚" python3 -c '
import json, os
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
cut = os.path.getmtime(lib) * 1000
rows = [json.loads(l) for l in open(os.path.join(base, "experiences.jsonl"), encoding="utf8") if l.strip()]
dev = [r for r in rows if r.get("metaKind") == "acceptance-deviation" and (r.get("timestamp") or 0) > cut]
bad = [r["expId"] for r in dev if not r.get("chainId")]
assert not bad, "构建后的偏离经验无链锚: %s" % bad
'

# ── T56 自主回合预测闭环(cl-062: 用户离场期校准与精排样本冻结——模型不调用工具就没有预测) ──
echo "[T56] 自主回合预测闭环(判定/创建/客观结算/冷却)"
t "含自主回合判定" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/index.ts")).read()
assert "function autonomousFrame" in s, "缺自主回合判定"
i = s.index("function autonomousFrame")
seg = s[i:i+700]
assert "kind === " in seg and "user" in seg and "plugin" in seg, "判定未区分真实用户与插件帧"
assert "messages.length - 1" in seg, "判定未按最后一条带来源的消息(历史含真实用户消息时会误判)"
'
t "pre-step创建预测" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/index.ts")).read()
assert "agent/pre-step" in s, "未挂 pre-step"
i = s.index("agent/pre-step")
seg = s[i:i+1600]
assert "service.predict(" in seg, "pre-step 内未创建预测"
'
t "turn/end用产物指纹结算" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/index.ts")).read()
assert "artifactFingerprint" in s and "service.report(" in s, "未做客观结算"
i = s.index("const pending = pendingAutonomous.get")
seg = s[i:i+900]
assert "after !== pending.before" in seg, "结算判据不是指纹变化"
'
t "有冷却限流" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")).read()
assert "autonomousPredictionCooldownMs" in s, "缺冷却配置"
i = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/index.ts")
assert "autonomousPredictionCooldownMs" in open(i).read(), "冷却未接线"
'
t "产物含自主预测(已部署)" bash -c "grep -q 'autonomousPrediction' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "条件性见证: 自主预测必须带审计键并结算" python3 -c '
import json, os, subprocess, time
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
# 只查"当前进程"创建的预测: 之前的悬空项是 cl-081 的历史实例, 不该让断言长期变红。
cut = max(os.path.getmtime(lib) * 1000, int(ep) * 1000) if ep.isdigit() else os.path.getmtime(lib) * 1000
rows = [json.loads(l) for l in open(os.path.join(base, "predictions.jsonl"), encoding="utf8") if l.strip()]
auto = [r for r in rows if str(r.get("situation", "")).startswith("自主回合") and (r.get("timestamp") or 0) > cut]
for r in auto:
    assert "originalTopExpId" in r, "自主预测缺审计键: %s" % r.get("predictionId")
aged = [r for r in auto if time.time() * 1000 - (r.get("timestamp") or 0) > 15 * 60 * 1000]
assert all(r.get("actualOutcome") is not None for r in aged), "自主预测超15分钟未结算"
'
t "结算兜底: 有超龄扫描" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/index.ts"), encoding="utf8").read()
assert "sweepAutonomous" in s and "AUTONOMOUS_SETTLE_TTL_MS" in s, "缺兜底扫描"
i = s.index("settleAutonomous(String(session.id))")
j = s.index("reason !== " + chr(39) + "completed" + chr(39))
assert i < j, "结算仍在原因过滤之后(非 completed 回合会漏结算)"
'

# ── T57 推进判据=目标专属见证(cl-077: 全局锚只回答"机器在动吗", 会把暂停目标的采纳也判成推进) ──
echo "[T57] 推进判据=目标专属见证(映射覆盖/双判据对照/区分性)"
t "每个active目标都有专属见证" python3 -c '
import json, os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
i = s.index("GOAL_WITNESS = {")
block = s[i:s.index("}", i)]
pool = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl"), encoding="utf8") if l.strip()]
for g in pool:
    if g.get("status") == "active":
        assert g["id"] in block, "active 目标 %s 无专属见证" % g["id"]
'
t "advanced用专属见证" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
i = s.index("def advanced(goal_id, adopted_at):")
seg = s[i:i+300]
assert "GOAL_WITNESS" in seg, "advanced 未用专属映射"
assert "def advanced_global(" in s, "缺全局对照判据"
'
t "统计输出含专属与全局两列" bash -c "grep -q '推进率(专属)' '$DIR/incubation-stats.md' && grep -q '推进率(全局锚对照)' '$DIR/incubation-stats.md'"
t "判据区分性: 暂停目标的专属率与全局率不同" python3 -c '
import json, os
s = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
pool = {json.loads(l)["id"]: json.loads(l).get("status") for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl"), encoding="utf8") if l.strip()}
import subprocess
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), "--json"], capture_output=True, text=True).stdout
rows = json.loads(out)
for r in rows:
    if pool.get(r["goalId"]) == "paused" and r["witness"] == ["draftsChars"]:
        assert r["advanced"] <= r["advanced_global"], "专属判据比全局更宽, 方向反了"
'

# ── T58 度量器同源问题隔离(tp-052: cl-062 让自主预测混进精排 A/B, 两个问题被平均成一个数) ──
echo "[T58] 精排度量器同源隔离(自主回合预测单列, 不并入 A/B)"
t "源码含自主预测分类" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-refine-eval.py"), encoding="utf8").read()
assert "def is_autonomous" in s and "自主回合" in s, "缺分类"
assert "已排除自主回合预测" in s, "输出未标注排除数"
'
t "输出数字与账本自算一致" python3 -c '
import json, os, re, subprocess, statistics
rows = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/predictions.jsonl"), encoding="utf8") if l.strip()]
auto = [r for r in rows if str(r.get("situation", "")).startswith("自主回合")]
ret = [r for r in rows if not str(r.get("situation", "")).startswith("自主回合")]
prom = [r for r in ret if r.get("promotedExpId")]
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-refine-eval.py")], capture_output=True, text=True).stdout
m = re.search(r"带审计键 (\d+)；精排提升 (\d+)（真提升 (\d+) / 身份提升 noop (\d+)）", out)
assert m, "输出格式变了: %s" % out[:240]
assert int(m.group(2)) == len(prom), "提升总数不符: 输出 %s vs 实算 %d" % (m.group(2), len(prom))
noop = [r for r in prom if r.get("promotedExpId") == r.get("originalTopExpId")]
assert int(m.group(4)) == len(noop), "noop 计数不符: 输出 %s vs 实算 %d" % (m.group(4), len(noop))
m2 = re.search(r"已排除自主回合预测 (\d+)", out)
assert m2 and int(m2.group(1)) == len(auto), "排除数不符: %s vs %d" % (m2.group(1) if m2 else "?", len(auto))
assert "自主回合预测(另一问题, 单列)" in out, "自主预测未单列"
'
t "B组须带审计键(防时代混淆)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-refine-eval.py"), encoding="utf8").read()
assert "L·审计前历史行" in s and "B·未开火(审计后)" in s, "未区分审计前后"
i = s.index("no_refine = ")
seg = s[i:i+400]
assert "originalTopExpId" in seg and "promotedExpId" in seg, "B 组未要求审计键+未提升"
'
t "A组均值只用同源样本" python3 -c '
import json, os, re, subprocess, statistics
rows = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/predictions.jsonl"), encoding="utf8") if l.strip()]
ret = [r for r in rows if not str(r.get("situation", "")).startswith("自主回合")]
prom = [r for r in ret if r.get("promotedExpId") and r.get("actualOutcome") is not None and isinstance(r.get("predictionError"), (int, float))]
if not prom:
    raise SystemExit(0)
changed = [r for r in prom if r.get("promotedExpId") != r.get("originalTopExpId")]
if not changed:
    raise SystemExit(0)
want = statistics.mean(r["predictionError"] for r in changed)
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-refine-eval.py")], capture_output=True, text=True).stdout
m = re.search(r"A1·真提升\(changed\): 已结算 (\d+) 条, 平均误差 ([0-9.]+)", out)
assert m, "A1 组输出缺失"
assert int(m.group(1)) == len(changed), "A1 组结算数不符: 输出 %s vs 实算 %d" % (m.group(1), len(changed))
assert abs(float(m.group(2)) - want) < 1e-3, "A1 组均值不符: 输出 %s vs 实算 %.3f" % (m.group(2), want)
'

# ── T59 采纳计数原子化(tp-053/cl-079: 同回合多目标采纳时并发读-改-写丢更新) ──
echo "[T59] 采纳计数原子化(一次读-改-写 + 数据不变量 + 修复脚本)"
t "源码合并为一次读-改-写" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts"), encoding="utf8").read()
assert "const bumpMany" in s, "缺 bumpMany"
i = s.index("const bumpMany")
seg = s[i:i+1200]
assert seg.count("writeFile(") == 1, "bumpMany 内不止一次写"
assert "bumpMany(adopted)" in s, "采纳路径未合并调用"
assert "bumpMany(new Map(hits" in s, "触发路径未合并调用"
'
t "产物含原子实现(已部署)" bash -c "grep -q bumpMany '$HOME/dsh-fork/packages/context/dormant-goal/lib/index.js'"
t "修复脚本幂等且当前无漂移" bash -c "python3 '$HOME/dsh-fork/dsh-fix-adoption-count.py' --dry-run | grep -q '无漂移'"

# ── T60 自主驱动看门狗(cl-080: 15:31 重启后 GUI 断开+用户离场 → 87 分钟 0 帧且无任何痕迹) ──
echo "[T60] 自主驱动看门狗(心跳打点/产物/停摆可测)"
t "源码含心跳打点" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "quiet-driver-heartbeat.jsonl" in s, "缺心跳账本路径"
q = chr(39)
for reason in ("tick", "agent-not-live", "busy", "silent-skip", "user-active"):
    assert "beat(" + q + reason + q in s, "缺打点 %s" % reason
'
t "产物含心跳(已部署)" bash -c "grep -q quiet-driver-heartbeat '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "心跳新鲜(进程已跑够一个周期)" python3 -c '
import json, os, subprocess, time
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
assert ep.isdigit(), "无法解析服务启动时间"
uptime_ms = time.time() * 1000 - int(ep) * 1000
THRESH = 20 * 60 * 1000
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
if int(ep) * 1000 < os.path.getmtime(lib) * 1000:
    raise SystemExit(0)  # 进程还没加载含心跳的 lib(需重启)
if uptime_ms < THRESH:
    raise SystemExit(0)  # 进程刚起, 还没到该有心跳的时候
assert os.path.exists(hb), "心跳账本不存在(定时器未跑或机制未加载)"
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
assert rows, "心跳账本为空"
newest = max(r.get("ts", 0) for r in rows)
assert time.time() * 1000 - newest < THRESH, "自主驱动停摆: 最新心跳 %.0f 分钟前" % ((time.time() * 1000 - newest) / 60000)
'
t "源码含主动唤醒+停摆告警" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "ctx.agents.resume(" in s, "缺主动唤醒"
assert "wakeTargetAgent" in s and "noteStall(" in s, "唤醒/停摆计数未接线"
assert "cl-stall-" in s and "raiseStallAlert" in s, "缺停摆告警"
assert "clearStallAlert" in s, "缺恢复关单"
'
t "产物含唤醒与告警(已部署)" bash -c "grep -q 'agent-resumed' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js' && grep -q 'cl-stall' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "停摆原因分布可查(实测agent-not-live)" python3 -c '
import json, os, time, subprocess
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
if not ep.isdigit() or int(ep) * 1000 < os.path.getmtime(lib) * 1000:
    raise SystemExit(0)  # 未加载新 lib
if not os.path.exists(hb):
    raise SystemExit(0)
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
assert rows, "心跳为空"
assert all(r.get("reason") for r in rows), "心跳缺 reason"
'
t "心跳含跳过原因分类" python3 -c '
import json, os, time, subprocess
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
if int(ep) * 1000 < os.path.getmtime(lib) * 1000:
    raise SystemExit(0)
if int(ep) * 1000 + 20 * 60 * 1000 > time.time() * 1000:
    raise SystemExit(0)
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
known = {"tick", "silent-skip", "agent-not-live", "agent-resumed", "agent-resume-failed", "busy", "user-active"}
bad = [r.get("reason") for r in rows if r.get("reason") not in known]
assert not bad, "未知跳过原因: %s" % bad[:3]
'

# ── T61 inspect_memory 输出 schema 完备性(cl-082: 加 lexical 通道后输出多键, schema additionalProperties:false 未同步 → 工具自 12:5x 起调用即报错, 无人调用故无人发现) ──
echo "[T61] inspect_memory 输出 schema 完备(输出键必须全部在 schema 声明, 防'没人调用就没人发现')"
t "输出键全部在 schema 声明" python3 -c '
import re, os
p = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")
s = open(p, encoding="utf8").read()
# schema 段: 第一个 channel_weights 的 properties
i = s.index("channel_weights: {")
j = s.index("properties: {", i)
seg = s[j:s.index("},", s.index("lexical: {", j)) + 2]
declared = set(re.findall(r"(\w+): \{ type: .number., required: true \}", seg))
# 输出段: 最后一个 channel_weights 对象(带 result.channelWeights.*)
outseg = s[s.rindex("channel_weights: {"):]
outseg = outseg[:outseg.index("},", outseg.index("lexical"))]
emitted = set(re.findall(r"(\w+): result\.channelWeights\.(\w+)", outseg))
emitted = {a for a, b in emitted}
missing = emitted - declared
assert not missing, "schema 未声明输出键: %s" % sorted(missing)
assert "lexical" in declared, "schema 缺 lexical"
'
t "schema 与输出同源(无 additionalProperties 冲突)" python3 -c '
import re, os
p = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/tools.ts")
s = open(p, encoding="utf8").read()
i = s.index("channel_weights: {")
seg = s[i:i+800]
assert "additionalProperties: false" in seg, "未找到 additionalProperties:false(检查点漂移)"
'

# ── T62 唤醒必须挂存量 preset(cl-084: 2026-09-09 17:34:53 quiet-driver 裸 resume 唤醒主会话
# → 该 agent 未加入任何 preset; Web 组合的全局工具层为空(每个面向模型的工具都在 preset 里),
# 于是主会话此后每次 bash 都得到裸 unknown tool "bash", read/write/subagent 同缺, 只剩插件工具) ──
echo "[T62] 目标会话唤醒必须挂存量 preset(防'唤醒即剥光工具')"
t "src 唤醒解析存量 preset 并在 setup 内 mount" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "resolveStoredPreset" in s, "缺存量 preset 解析"
assert "presets.mount(agentCtx, presetId)" in s, "缺 setup 内的 preset 挂载"
assert "agent-preset/selected" in s, "缺最新选择事件优先于创建头的解析(与 resolveSessionPreset 同义)"
'
t "src 无裸 resume(不带 setup 的唤醒)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "resume({ resumeSessionId: sessionId })" not in s, "仍存在不带 setup 的裸唤醒"
'
t "lib 含 preset 挂载(已部署)" bash -c "grep -q 'presets.mount(agentCtx, presetId)' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "心跳 agent-resumed 必带 preset 字段(旧 lib 无此字段)" python3 -c '
import json, os
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
since = os.path.getmtime(lib) * 1000
rows = []
if os.path.exists(hb):
    for line in open(hb, encoding="utf8"):
        line = line.strip()
        if line:
            try: rows.append(json.loads(line))
            except Exception: pass
bad = [r for r in rows
       if r.get("reason") == "agent-resumed" and r.get("ts", 0) >= since and "preset" not in r]
assert not bad, "修复部署后的 agent-resumed 心跳缺 preset 字段"
'

# ── T63 环路跨重启存活(cl-088: 两次 register_loop 后 inspect_memory.loops 仍是空数组) ──
echo "[T63] 元认知环路持久化(落盘/重放/文件格式)"
t "store 读写 loops.json" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts"), encoding="utf8").read()
assert "loops.json" in s and "saveLoopSpecs" in s and "loopSpecsSnapshot" in s, "缺环路持久化"
'
t "registerLoop 落盘 + ready 重放" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
i = s.index("registerLoop(spec: MetaLoopSpec)")
assert "saveLoopSpecs" in s[i:i+400], "注册未落盘"
j = s.index("async ready()")
assert "loopSpecsSnapshot" in s[j:j+400], "启动未重放"
'
t "产物含环路持久化(已部署)" bash -c "grep -q 'loops.json' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js' && grep -q 'loopSpecsSnapshot' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "loops.json 格式正确(存在时)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/loops.json")
if not os.path.exists(p):
    raise SystemExit(0)  # 尚未注册过环路(重启后注册即出现)
d = json.load(open(p, encoding="utf8"))
assert isinstance(d, list), "loops.json 不是数组"
for spec in d:
    assert isinstance(spec.get("name"), str) and spec.get("name"), "环路缺 name"
    assert isinstance(spec.get("description"), str), "环路缺 description"
'

# ── T64 检索损失与精排选择的分离测量(cl-089: 窗口已含正确项 90%, 精排却跨链改道且更差) ──
echo "[T64] 去混淆测量(检索损失曲线 / 精排链级诊断 / 不写管线状态)"
t "注入上界脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-injection-bound.py' && timeout 300 python3 '$HOME/dsh-fork/dsh-injection-bound.py' | grep -q '检索损失'"
t "报告含 recall@K 曲线与上界" bash -c "timeout 300 python3 '$HOME/dsh-fork/dsh-injection-bound.py' | grep -q 'recall@5' && timeout 300 python3 '$HOME/dsh-fork/dsh-injection-bound.py' | grep -q '上界·按构造'"
t "精排链级诊断已接入度量器" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-refine-eval.py"), encoding="utf8").read()
for key in ("intra-chain", "cross-chain", "链级诊断"):
    assert key in s, "缺 %s" % key
'
t "链级诊断在早退之前输出" python3 -c '
import subprocess, os
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-refine-eval.py")], capture_output=True, text=True).stdout
assert "链级诊断" in out, "诊断未输出(可能被小样本早退跳过)"
'
t "脚本不写管线状态" bash -c "grep -q '不写管线状态' '$HOME/dsh-fork/dsh-injection-bound.py'"
t "条件性见证: 构建后不再出现 noop 提升" python3 -c '
import json, os, subprocess, time
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
cut = max(os.path.getmtime(lib) * 1000, int(ep) * 1000) if ep.isdigit() else os.path.getmtime(lib) * 1000
rows = [json.loads(l) for l in open(os.path.join(base, "predictions.jsonl"), encoding="utf8") if l.strip()]
new = [r for r in rows if (r.get("timestamp") or 0) > cut]
bad = [r["predictionId"] for r in new
       if r.get("promotedExpId") and r.get("promotedExpId") == r.get("originalTopExpId")]
assert not bad, "cl-087 未生效: 构建后仍有 noop 提升 %s" % bad[:3]
'

# ── T65 中文分词质量(tp-056/cl-083 残留: 停用字二元组过滤 + 关键词层限词级) ──
echo "[T65] 中文分词质量(元素层停用字二元组 / 关键词层单字 / 部署)"
t "elements 丢弃两字皆虚词的二元组" bash -c "node -e \"
const m = require('/home/ubuntu/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js');
const out = m.elements('的进了在不');
const bad = out.filter(x => x.length === 2 && [...x].every(c => '的了是在不' .includes(c)));
if (bad.length) { console.error('仍有停用字二元组', bad); process.exit(1); }
\""
# 只看构建之后写入的经验(效果证据): 修复前的历史行保留单字是已知事实, 不该让断言长期红。
t "构建后新经验不落单字CJK关键词" python3 -c '
import json, os
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
cut = os.path.getmtime(lib) * 1000
rows = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/experiences.jsonl"), encoding="utf8") if l.strip()]
new = [r for r in rows if (r.get("timestamp") or 0) > cut]
bad = []
for r in new:
    kw = (r.get("sar") or {}).get("actionKeywords") or []
    if any(len(k) == 1 and not k.isascii() for k in kw):
        bad.append(r.get("expId"))
assert not bad, "构建后仍有单字 CJK 关键词: %s" % bad[:3]
'
t "分词修法已部署(行为见证)" bash -c "node -e \"
const m = require('/home/ubuntu/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js');
if (m.elements('在不').length !== 0) { console.error('两字皆虚词未被过滤'); process.exit(1); }
\""
t "关键词层过滤在源码中" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
assert "cl-083" in s and "element.length < 2" in s, "关键词层未限词级"
'

# ── T66 派帧设链锚 + 语料词典过滤(cl-085 / cl-083 残留) ──
echo "[T66] 行动帧设链锚(经验继承目标) + 关键词语料词典过滤"
t "行动帧派发时设链锚" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "setChainAnchor(String(sessionId), actionable.id)" in s, "行动帧未设链锚"
i = s.index("setChainAnchor(String(sessionId), actionable.id)")
seg = s[max(0, i-900):i]
assert "actionable !== null" in seg, "设锚不在行动帧路径内"
'
t "产物含设链锚(已部署)" bash -c "grep -q 'setChainAnchor' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "关键词语料词典过滤在源码" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
assert "语料自身当词典" in s or "documentFrequency.get(element) ?? 0) < 2" in s, "缺语料词典过滤"
'
t "产物含语料词典过滤(已部署)" bash -c "grep -q 'documentFrequency.get(element)' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"

# ── T67 精排提升须有链证据(cl-089: 0 条链内重排, 跨链改道误差 0.400/0.434 vs 未开火 0.102) ──
echo "[T67] 精排提升策略(off/same-chain/always, 默认 same-chain)"
t "配置项 refinePromotion 已定义" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
assert "refinePromotion" in s, "缺配置项"
assert "default(" + chr(39) + "same-chain" + chr(39) + ")" in s, "默认值不是 same-chain"
'
t "提升按链证据门控" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/hot-engine.ts"), encoding="utf8").read()
i = s.index("const mode = this.config.refinePromotion")
seg = s[i:i+700]
assert "chainId" in seg and "ct === cc" in seg, "未按链比较"
assert "allowed = mode === " in s, "缺 off/always 分支"
'
t "产物含提升门控(已部署)" bash -c "grep -q 'refinePromotion' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "条件性见证: 构建后不再跨链提升" python3 -c '
import json, os, subprocess, time
base = os.path.expanduser("~/.dsh/cognitive-pipeline")
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
svc = os.popen("systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value").read().strip()
ep = subprocess.run(["date", "-d", svc, "+%s"], capture_output=True, text=True).stdout.strip()
cut = max(os.path.getmtime(lib) * 1000, int(ep) * 1000) if ep.isdigit() else os.path.getmtime(lib) * 1000
chain = {}
for l in open(os.path.join(base, "experiences.jsonl"), encoding="utf8"):
    if l.strip():
        e = json.loads(l)
        chain[e.get("expId")] = e.get("chainId")
rows = [json.loads(l) for l in open(os.path.join(base, "predictions.jsonl"), encoding="utf8") if l.strip()]
bad = []
for r in rows:
    if (r.get("timestamp") or 0) <= cut:
        continue
    p, o = r.get("promotedExpId"), r.get("originalTopExpId")
    if not p or p == o:
        continue
    cp, co = chain.get(p), chain.get(o)
    if not (cp and co and cp == co):
        bad.append((r["predictionId"], o, p))
assert not bad, "构建后仍出现跨链提升(cl-089 未生效): %s" % bad[:3]
'

# ── T68 未消费帧守卫(cl-091: 20:30 后 18 条 direct-frame 输出逐字相同 → 帧堆积后一次性涌入) ──
echo "[T68] 未消费帧守卫(输出比对/暂停派帧/可见化)"
t "源码含未消费判定与暂停" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
for key in ("noteDispatchResult", "staleDispatchCount", "suspendDispatchUntil", "dispatch-suspended"):
    assert key in s, "缺 %s" % key
assert "responseText === lastResponseText" in s, "判据不是逐字比对(内存 lastResponseText)"
'
t "派发前检查暂停状态" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
i = s.index("if (dispatchSuspended())")
j = s.index("agent.followup(message)", i)
assert 0 < j - i < 900, "暂停检查不在派发之前"
'
t "产物含守卫(已部署)" bash -c "grep -q 'dispatch-suspended' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "条件性见证: 近期帧输出不再逐字重复" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-frames.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
rows = [r for r in rows if r.get("kind") == "direct-frame" and r.get("output")]
if len(rows) < 3:
    raise SystemExit(0)
# 只看 lib 构建之后的帧(历史重复是已知旧行为, 不该让断言长期红)
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
cut = os.path.getmtime(lib) * 1000
rows = [r for r in rows if (r.get("ts") or 0) > cut]
if len(rows) < 2:
    raise SystemExit(0)
tail = rows[-6:]
dup = [(tail[i].get("ts"), str(tail[i].get("output"))[:40]) for i in range(1, len(tail))
       if tail[i].get("output") == tail[i-1].get("output")]
# 允许存在(守卫尚未加载/正在重启), 但必须被标注 consumed=False
bad = [d for d in dup if tail[[r.get("ts") for r in tail].index(d[0])].get("consumed") is not False]
assert not bad, "重复输出帧未被标注 consumed=False: %s" % bad[:2]
'

# ── T69 唤醒须带模型(cl-092: 00:5x 每轮报 {{model}} 无值 → 帧"投递了却不消费"的根因) ──
echo "[T69] 唤醒带模型(种子+选择监听器/与 Host 同构)"
t "唤醒解析存量模型并传 agentOptions" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "resolveStoredModel" in s, "缺模型解析"
assert "agentOptions: storedModel" in s, "未把模型作为 agentOptions 种子"
assert "request/header" in s, "未从会话日志取 request/header"
assert "event.data?.header?.config" in s, "取错了事件路径(data.header.config, 实测首版取 data.config 恒 undefined)"
'
t "条件性见证: 唤醒心跳带 model(强制)" python3 -c '
import json, os
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
if not os.path.exists(hb):
    raise SystemExit(0)
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
cut = os.path.getmtime(lib) * 1000
recent = [r for r in rows if (r.get("ts") or 0) > cut and r.get("reason") == "agent-resumed"]
if not recent:
    raise SystemExit(0)  # 尚未发生唤醒
assert any(r.get("model") for r in recent), "唤醒心跳 model 为空(resolveStoredModel 未取到模型)"
'
t "唤醒装模型选择监听器" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "installModelSelection(agentCtx" in s, "未装选择监听器"
i = s.index("const wakeTargetAgent")
seg = s[i:i+2400]
assert "installModelSelection" in seg, "监听器不在唤醒路径内"
'
t "产物含唤醒模型接线(已部署)" bash -c "grep -q 'installModelSelection' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js' && grep -q 'agentOptions' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "条件性见证: 唤醒心跳带 model" python3 -c '
import json, os
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
if not os.path.exists(hb):
    raise SystemExit(0)
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
cut = os.path.getmtime(lib) * 1000
recent = [r for r in rows if (r.get("ts") or 0) > cut and r.get("reason") == "agent-resumed"]
if not recent:
    raise SystemExit(0)  # 尚未发生唤醒
assert any(r.get("model") for r in recent), "唤醒心跳缺 model 字段"
'

# ── T71 权重来源模型标签(cl-086 换模清单第2项: 权重不可默认跨模型迁移) ──
echo "[T71] 检索权重来源模型标签(打标脚本/账本/可追溯)"
t "打标脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-weights-provenance.py' && python3 '$HOME/dsh-fork/dsh-weights-provenance.py' >/dev/null 2>&1"
t "来源账本含模型与权重" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/channel-weights-provenance.jsonl")
assert os.path.exists(p), "来源账本不存在"
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "来源账本为空"
last = rows[-1]
assert last.get("model"), "缺 model"
assert isinstance(last.get("weights"), dict) and "lexical" in last["weights"], "缺权重快照"
assert last.get("ts"), "缺时间戳"
'

# ── T72 wiki 冻结快照(cl-086: 换模前须冻结知识层, 否则无法跨模型对照) ──
echo "[T72] wiki 冻结(脚本/快照内容/元信息/已挂cron)"
t "冻结脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-freeze-wiki.sh' && bash '$HOME/dsh-fork/dsh-freeze-wiki.sh' >/dev/null 2>&1"
t "快照含知识层文件与元信息" python3 -c '
import json, os, glob
root = os.path.expanduser("~/.dsh/cognitive-pipeline/snapshots")
snaps = sorted(glob.glob(os.path.join(root, "*")), key=os.path.getmtime)
assert snaps, "无快照"
latest = snaps[-1]
for f in ("chains.json", "taxonomy.json", "channel_weights.json"):
    assert os.path.exists(os.path.join(latest, f)), "快照缺 %s" % f
meta = json.load(open(os.path.join(latest, "meta.json"), encoding="utf8"))
assert meta.get("ts"), "元信息缺时间戳"
'
t "冻结已挂cron" bash -c "crontab -l 2>/dev/null | grep -q dsh-freeze-wiki"
t "快照数量受裁剪控制(<=10)" python3 -c '
import os, glob
root = os.path.expanduser("~/.dsh/cognitive-pipeline/snapshots")
n = len([d for d in glob.glob(os.path.join(root, "*")) if os.path.isdir(d)])
assert n <= 10, "快照未裁剪: %d" % n
'

# ── T73 唤醒前校验模型可用性(cl-094: 灰测模型今日到期, 不可照搬已下线的 id 唤醒) ──
echo "[T73] 模型可用性校验(目录查询/失败开放/心跳可见)"
t "唤醒前校验模型在目录" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "modelStillAvailable" in s, "缺可用性校验"
assert "model-unavailable" in s, "缺心跳打点"
i = s.index("const wakeTargetAgent")
seg = s[i:i+1400]
assert "modelStillAvailable" in seg, "校验不在唤醒路径内"
'
t "校验失败开放(查不到不阻断)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
i = s.index("const modelStillAvailable")
seg = s[i:i+800]
assert "return true" in seg, "未失败开放"
'
t "产物含可用性校验(已部署)" bash -c "grep -q 'modelStillAvailable' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "巡检查的是会话实际模型(cl-096)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "const sessionModel = " in s, "缺 sessionModel"
i = s.index("const checkModelAvailability")
seg = s[i:i+700]
assert "sessionModel() ?? resolveModel()" in seg, "巡检仍只看全局默认(监控错对象)"
'
t "模型可用性巡检已接线" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "checkModelAvailability" in s, "缺巡检"
assert "cl-model-expired-" in s, "缺告警入账"
i = s.index("const timer = setInterval")
assert "checkModelAvailability()" in s[i:i+900], "巡检未接入 tick"
'
t "巡检产物已部署" bash -c "grep -q 'cl-model-expired' '$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js'"
t "条件性见证: 巡检双痕迹一致(tp-060)" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
hb = os.path.join(D, "quiet-driver-heartbeat.jsonl")
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()] if os.path.exists(hb) else []
beats = [r for r in rows if r.get("reason") == "model-unavailable"]
led = [json.loads(l) for l in open(os.path.join(D, "claims-ledger.jsonl"), encoding="utf8") if l.strip()]
open_alerts = [r for r in led if str(r.get("id", "")).startswith("cl-model-expired") and r.get("status") in ("open", "in-progress")]
if beats:
    assert open_alerts, "心跳报了 model-unavailable 但账本无未关闭的 cl-model-expired-* 告警(巡检漏入账)"
if open_alerts:
    assert beats, "账本有 cl-model-expired-* 但心跳无 model-unavailable 痕迹(告警来源不明)"
'

# ── T74 学习式稀疏权重实验(cl-095: 离线无增益则不上线) ──
echo "[T74] 学习式稀疏权重实验(可运行/两方案对照/判读诚实)"
t "实验脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-learned-sparse.py' && timeout 600 python3 '$HOME/dsh-fork/dsh-learned-sparse.py' | grep -q 'recall@5'"
t "含两种信号对照(引用/同链集中度)" bash -c "timeout 600 python3 '$HOME/dsh-fork/dsh-learned-sparse.py' | grep -q '引用反馈加权' && timeout 600 python3 '$HOME/dsh-fork/dsh-learned-sparse.py' | grep -q '同链集中度加权'"
t "无增益即明确判读不上线" python3 -c '
import subprocess, os, re
out = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-learned-sparse.py")],
                     capture_output=True, text=True, timeout=600).stdout
m = re.search(r"均匀 IDF\(现状\)\s+([0-9.]+)%", out)
w = re.search(r"同链集中度加权\s+([0-9.]+)%", out)
assert m and w, "缺读数: %s" % out[:200]
gain = float(w.group(1)) - float(m.group(1))
if gain <= 0:
    assert "不上线" in out, "无增益却未判不上线"
else:
    assert "值得进下一步" in out, "有增益却未判可进"
'

# ── T75 容量敏感性扫描(cl-097: 参数是小库上标的, 库长大还成立吗) ──
echo "[T75] 容量敏感性扫描(固定目标集口径/只增干扰/判读写死)"
t "扫描脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-capacity-scan.py' && timeout 600 python3 '$HOME/dsh-fork/dsh-capacity-scan.py' | grep -q '固定目标集口径'"
t "只增干扰(隔离库规模效应)" bash -c "timeout 600 python3 '$HOME/dsh-fork/dsh-capacity-scan.py' | grep -q '只增干扰'"
t "判读阈值写死(>5pp 即需重标定)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-capacity-scan.py"), encoding="utf8").read()
assert "loss > 5" in s and "需重标定" in s, "判读阈值未写死"
'

# ── T76 实验脚本定期重跑(tp-061: 挂了 cron 却没断言 → 路径写错/改名即静默失效) ──
echo "[T76] 检索实验定期重跑(条目/路径/脚本存在)"
t "cron 含三项实验重跑条目" bash -c "crontab -l 2>/dev/null | grep -q 'retrieval-scans.log' && crontab -l 2>/dev/null | grep -q dsh-injection-bound.py"
t "条目覆盖三脚本且路径有效" python3 -c '
import os, subprocess
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
line = [l for l in out.splitlines() if "retrieval-scans.log" in l]
assert line, "无重跑条目"
l = line[0]
for s in ("dsh-injection-bound.py", "dsh-learned-sparse.py", "dsh-capacity-scan.py"):
    assert s in l, "条目缺 %s" % s
    assert os.path.exists(os.path.expanduser("~/dsh-fork/" + s)), "脚本不存在: %s" % s
'
t "三脚本各自可跑" bash -c "cd '$HOME/dsh-fork' && timeout 300 python3 dsh-injection-bound.py >/dev/null && timeout 300 python3 dsh-learned-sparse.py >/dev/null && timeout 300 python3 dsh-capacity-scan.py >/dev/null"

# ── T77 死注入通道诊断(cl-098: jump 通道 67 条已结算、引用率 0%) ──
echo "[T77] 注入通道引用率诊断(按触发源/死亡通道标记)"
t "诊断脚本存在且可运行" bash -c "test -x '$HOME/dsh-fork/dsh-citation-by-trigger.py' && timeout 300 python3 '$HOME/dsh-fork/dsh-citation-by-trigger.py' | grep -q '总引用率'"
t "按触发源拆分" bash -c "timeout 300 python3 '$HOME/dsh-fork/dsh-citation-by-trigger.py' | grep -q 'static' && timeout 300 python3 '$HOME/dsh-fork/dsh-citation-by-trigger.py' | grep -q 'jump'"
t "死亡通道会被标记" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-citation-by-trigger.py"), encoding="utf8").read()
assert "死亡通道" in s and "MIN_SETTLED" in s, "缺死亡通道判据"
'

# ── T78 换模 runbook(cl-094 的可执行子步: 阻塞项也要有"一条命令就能做"的路径) ──
echo "[T78] 换模 runbook(步骤齐全/判据写死/回滚路径)"
t "runbook 存在且含三步" python3 -c '
import os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/model-switch-runbook.md")
s = open(p, encoding="utf8").read()
for key in ("dsh-freeze-wiki.sh", "dsh-weights-provenance.py", "rebuild_taxonomy"):
    assert key in s, "缺步骤 %s" % key
'
t "判据与回滚写死" python3 -c '
import os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/model-switch-runbook.md")
s = open(p, encoding="utf8").read()
assert "判据" in s and "回滚" in s, "缺判据/回滚"
assert "不低于基线" in s or "不得下降" in s, "判据未量化"
'
t "runbook 引用的脚本都存在" python3 -c '
import os, re
p = os.path.expanduser("~/.dsh/cognitive-pipeline/model-switch-runbook.md")
s = open(p, encoding="utf8").read()
for m in re.findall(r"dsh-[a-z-]+\.(?:sh|py)", s):
    assert os.path.exists(os.path.expanduser("~/dsh-fork/" + m)), "runbook 引用了不存在的脚本: %s" % m
'

echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"

# ── P0 失败自动汇报(2026-09-08 19:4x, design-spec-wire-up-verification) ──
# 根因: cron 输出重定向到日志 → 失败静默无人看(18:17 有2项失败未被发现)。
# 改法: 失败写入有机制保证的通道(言行账本, 帧头已提示"Q3 前先查它");
#       防噪: 连续 2 次失败才入账, 全过时自动清理。
STREAK_FILE="$DIR/.test-fail-streak"
if [ "$FAIL" -gt 0 ]; then
  echo "失败项:"; for f in "${FAILED_TESTS[@]}"; do echo "  - $f"; done
  # 记录连续失败次数
  prev=$(cat "$STREAK_FILE" 2>/dev/null || echo 0)
  streak=$((prev + 1))
  echo "$streak" > "$STREAK_FILE"
  # 连续 ≥2 次 → 写入言行账本(唯一有帧头机制保证的通道)
  if [ "$streak" -ge 2 ]; then
    python3 - "$DIR/claims-ledger.jsonl" "$FAIL" "${FAILED_TESTS[*]}" << 'PYEOF'
import json, sys, datetime
ledger, fail_count, failed = sys.argv[1], sys.argv[2], sys.argv[3]
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()
# 已存在未关闭的测试告警则不重复写
try:
    existing = [json.loads(l) for l in open(ledger, encoding='utf8')]
except Exception:
    existing = []
if any(d.get('id','').startswith('cl-test-') and d.get('status') in ('open','in-progress') for d in existing):
    print('[test-alert] 已有未关闭的测试告警, 跳过')
    sys.exit(0)
entry = {
    'id': f"cl-test-{datetime.datetime.now().strftime('%Y%m%d-%H%M')}",
    'ts': now,
    'claim': f'认知测试套件连续失败({fail_count}项): {failed[:200]}',
    'source': 'dsh-cog-tests.sh 自动汇报(design-spec-wire-up-verification P0)',
    'status': 'open',
    # 2026-09-09 09:5x 修复自锁死循环: 告警条目自身缺 reviewBy → T33(open 项须有 reviewBy)转红
    # → 套件继续失败 → 告警无法自动关闭。给告警自身一个到期日(+1天)。
    'reviewBy': (datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) + datetime.timedelta(days=1)).strftime('%Y-%m-%d'),
    'reviewBasis': '自动告警: 测试恢复全过时自动关闭; 到期未关闭则人工查证',
    'note': '自动入账: 测试失败连续≥2次。需查证是真失败还是时序噪声(如重启后lib未生效), 修复后本条目应关闭。'
}
with open(ledger, 'a', encoding='utf8') as f:
    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
print(f'[test-alert] 已写入言行账本: {entry["id"]}')
PYEOF
    echo "[test-alert] 连续失败 $streak 次——已写入言行账本(帧自查可见)"
  fi
  exit 1
fi
# 全过: 清理告警状态 + 关闭遗留测试告警
rm -f "$STREAK_FILE"
python3 - "$DIR/claims-ledger.jsonl" << 'PYEOF'
import json, sys, datetime
ledger = sys.argv[1]
try:
    rows = [json.loads(l) for l in open(ledger, encoding='utf8')]
except Exception:
    sys.exit(0)
changed = False
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()
for d in rows:
    if d.get('id','').startswith('cl-test-') and d.get('status') in ('open','in-progress'):
        d['status'] = 'done'
        d['doneAt'] = now
        d['doneNote'] = '测试套件恢复全过, 自动关闭(design-spec-wire-up-verification P0)'
        changed = True
if changed:
    with open(ledger, 'w', encoding='utf8') as f:
        for d in rows:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
    print('[test-alert] 测试恢复全过——已自动关闭遗留告警')
PYEOF
exit 0
