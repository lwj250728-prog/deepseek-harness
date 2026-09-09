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
BAK7=$(mktemp); cp "$GOALS7" "$BAK7"
# 原始 nextAction(还原保真的比对基准)——2026-09-09 08:5x 修正: 原断言写死"以'待'开头",
# 而该目标 nextAction 已按 cl-059 改写为可执行子步, 故改为"还原后与原始一致"。
NA7_ORIG=$(python3 -c "
import json
for l in open('$GOALS7'):
    d=json.loads(l)
    if d.get('id')=='goal-digital-life-incubation': print(d.get('nextAction',''))
")
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
t "还原后与原始nextAction一致" bash -c "[[ '$NA7B' == '$NA7_ORIG' ]]"
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
# 21e. 运行时锚文件存在且非空(机制真跑过)
t "运行时锚文件非空" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/chain_anchors.json")))
assert isinstance(d, dict) and len(d) > 0, "链锚文件为空"
'
# 21f. 最新任务经验带 chainId(自动锚定真生效, 非仅代码存在)
t "最新经验已锚定目标" python3 -c '
import json, os
rows = [json.loads(l) for l in open(os.path.expanduser("~/.dsh/cognitive-pipeline/experiences.jsonl")) if l.strip()]
newest = max(rows, key=lambda r: r.get("timestamp") or 0)
cid = newest.get("chainId")
assert isinstance(cid, str) and cid != "", "最新经验未锚定: %s" % newest.get("expId")
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
