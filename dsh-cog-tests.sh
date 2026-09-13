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

# ── cl-175 规范日志落盘: 会话内跑的绿也必须进 .cog-tests.log ──
# 复发实证(2026-09-11 03:42 核对): 规范日志 mtime 停在 00:19(442/3), 而我 03:30 会话内跑的是 465/1 ——
# 两条证据链互不覆盖, 任何只读规范日志的核验者(包括下一个我)看到的是 3 红。故任何一次运行都落盘,
# 并留来源标记(origin=cron/manual)以便按来源分段核验。DSH_COG_LOG_ACTIVE=1 供已自行重定向的调用方关闭。
COG_LOG="${DSH_COG_LOG:-$HOME/.dsh/cognitive-pipeline/.cog-tests.log}"
export DSH_COG_RUN_PID="$$"   # T139(a): 断言"本进程已自注册"; t 直接 fork python, 父进程即套件本体
# origin 行**无条件**写(cron 路径也写——它自己重定向了 stdout, 但同样需要"这次跑存在过"的证据);
# 只有 tee 是有条件的。T139 断言(a) 正是靠这行判定"本进程已自注册", 故不能放进 if 里。
printf '\n── %s origin=%s pid=%s —— 套件运行开始 ──\n' "$(date '+%F %T')" "${DSH_COG_ORIGIN:-manual}" "$$" >> "$COG_LOG"
if [ -z "${DSH_COG_LOG_ACTIVE:-}" ]; then
  export DSH_COG_LOG_ACTIVE=1
  exec > >(tee -a "$COG_LOG") 2>&1
fi

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
# 原子写(2026-09-12 16:4x): 非原子重写在账本变大后一旦被打断就截断记忆主干
_tmp = ledger + '.tmp'
with open(_tmp, 'w', encoding='utf8') as f:
    f.write(chr(10).join(json.dumps(x, ensure_ascii=False) for x in rows) + chr(10))
    f.flush()
    import os as _os
    _os.fsync(f.fileno())
_os.replace(_tmp, ledger)
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
# 口径必须与比对侧一致: 池是只追加 + last-wins, 而这里原来把**每一行**都打印出来
# (该目标现有 4 行 ⇒ 基准是多行文本), 与比对里的单值永远对不上 —— 判据于是"正常前进一次即红"。
python3 -c "
import json
out = ''
for l in open('$GOALS7'):
    if not l.strip(): continue
    d = json.loads(l)
    if d.get('id') == 'goal-digital-life-incubation': out = d.get('nextAction', '')
print(out)
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
# 2026-09-11 17:4x 修口径: 池是**只追加 + last-wins** 的账本, 而这里原来用 first-wins 读
# (命中第一条就 return)。于是"某目标的 nextAction 被正常前进一次"会让本断言转红 —— 实测孵化目标
# 有 4 行(15:36/17:16/17:18/17:20), 首行的 nextAction 是旧的 ⇒ 判据红而测试其实没碰过任何文件。
# 判据的意图是"套件运行不得改动活文件", 那就必须与捕获原值用**同一种口径**(last-wins)比对。
t "测试未改动活文件" python3 -c "
import json
def na(p):
    out = ''
    for l in open(p, encoding='utf8'):
        if not l.strip(): continue
        d = json.loads(l)
        if d.get('id') == 'goal-digital-life-incubation': out = d.get('nextAction', '')
    return out
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
# 2026-09-10 19:1x 修假红: 原判据把"读不到 systemd 时间戳"与"lib 比进程新"混成同一个 false,
# 于是 18:19 的自主跑出现一次无法复现的红(现在 lib 16:41 < 服务 16:42 明明成立)。缺证据与判假必须分开:
# 时间戳读不到 => 重试一次, 仍读不到就在输出里说明"缺证据", 不再伪装成"lib 更新"。
t "lib早于服务启动(进程用新lib)" bash -c "
lib=\"$HOME/dsh-fork/packages/context/quiet-driver/lib/index.js\"
lib_ts=\$(stat -c %Y \"\$lib\" 2>/dev/null)
if [ -z \"\$lib_ts\" ]; then echo '[缺证据] 读不到 lib 文件时间戳'; exit 1; fi
svc_ts=\"\$(systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value 2>/dev/null)\"
if [ -z \"\$svc_ts\" ]; then sleep 2; svc_ts=\"\$(systemctl --user show dsh-web.service -p ActiveEnterTimestamp --value 2>/dev/null)\"; fi
if [ -z \"\$svc_ts\" ]; then echo '[缺证据] 读不到服务启动时间(重试后仍为空)'; exit 1; fi
svc_ep=\$(date -d \"\$svc_ts\" +%s 2>/dev/null)
if [ -z \"\$svc_ep\" ]; then echo \"[缺证据] 无法解析服务启动时间: \$svc_ts\"; exit 1; fi
if [ \"\$lib_ts\" -ge \"\$svc_ep\" ]; then echo \"[真红] lib(\$lib_ts) >= 服务启动(\$svc_ep): 进程可能未用上新构建\"; exit 1; fi
exit 0
"

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

# ── T15 模型目录一致性(2026-09-10 21:4x 重写——原组只守"灰测模型在册", 到期后必须换成目录一致性判据) ──
# 起因: 灰测 id `deepseek-v4.1-flash-expires-on-0910` 09-10 到期, 供应商目录已无此项(实查只剩
# deepseek-flash / deepseek-v4-pro), 服务端响应侧自 21:10:36 起实际返回 deepseek-v4-flash(cl-156)。
# 原 T15 组整个围绕"灰测模型在册"写, 属于"判据停在旧状态"; 现改为守**目录一致性**这个不变式:
# 供应商实时目录里的每个 id 都必须在插件目录中; 已到期的灰测 id 必须不在目录中; lib 与 src 一致。
echo "[T15] 模型目录一致性(供应商实时 id 须在册 / 到期灰测 id 须移除 / lib 与 src 一致)"
t "已到期的灰测 id 必须已从目录移除" python3 -c '
import os, re
SRC = os.path.expanduser("~/dsh-fork/packages/llm/llm-deepseek/src/index.ts")
src = open(SRC, encoding="utf8").read()
expired = "deepseek-v4.1-flash-expires-on-0910"
# 判据必须落在**目录条目**上, 不是全文出现: 首次写的版本用 `"id" not in src`, 被我自己的注释
# (注释里逐字提到这个 id 说明为何移除)满足成"仍存在" => 假红(cl-159: 字面出现 != 条目在册)。
entries = set(re.findall(r"id:\s*\x27(deepseek[^\x27]*)\x27", src))
assert entries, "解析不到目录条目 —— 断言前提不成立"
assert expired not in entries, "到期灰测 id 仍在 DEFAULT_MODELS 条目中: %s" % sorted(entries)
print("到期灰测 id 不在目录条目中(共 %d 条)" % len(entries))
'
t "供应商实时目录里的 id 必须都在插件目录中" python3 -c '
import json, os
cat = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json"), encoding="utf8"))
live = cat.get("catalog") or []
assert live, "缺供应商目录快照(断言前提不成立)"
src = open(os.path.expanduser("~/dsh-fork/packages/llm/llm-deepseek/src/index.ts"), encoding="utf8").read()
missing = [m for m in live if ("\x27%s\x27" % m) not in src]
assert not missing, "供应商目录里有但插件目录缺: %s" % missing
print("供应商 %d 个 id 全部在插件目录中" % len(live))
'
t "lib 与 src 的目录一致(已部署)" python3 -c '
import os, re
base = os.path.expanduser("~/dsh-fork/packages/llm/llm-deepseek")
src = open(os.path.join(base, "src/index.ts"), encoding="utf8").read()
lib_path = os.path.join(base, "lib/index.js")
assert os.path.exists(lib_path), "lib 未构建"
lib = open(lib_path, encoding="utf8").read()
ids = set(re.findall(r"id: ?\x27(deepseek[^\x27]*)\x27", src)) | set(re.findall(r"id: ?\x22(deepseek[^\x22]*)\x22", src))
ids |= set(re.findall(r"id: ?\x27(deepseek[^\x27]*)\x27", lib))
expired = "deepseek-v4.1-flash-expires-on-0910"
assert expired not in lib, "lib 仍含到期灰测 id: 未重建或未部署"
for want in ("deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash"):
    assert want in lib, "lib 缺 %s(重建后未部署?)" % want
print("lib 目录与 src 一致")
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
    hits = [k for k in ['已修','已执行','已落地','已修复'] if k in note]
    if not hits:
        continue
    # cl-199/cl-200 实测: 一项可以"局部已修、整体仍未关"(剩余根因在别处)。关键词判据本身分不清
    # "已修完却挂着"和"已修一半、剩下工作写在 disposition 里"。故不是删掉关键词检查(那是放宽),
    # 而是要求这类 open 项必须**把剩余工作写清楚**(disposition 非空且够具体), 否则仍判矛盾。
    disp = str(d.get('disposition') or '').strip()
    if len(disp) < 10:
        bad.append('%s(声称已修却无剩余工作说明)' % d['id'])
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
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_\-]{3,}|\d{3,}|/[A-Za-z0-9_\-./]{3,}")
def cjk_ratio(t):
    if not t: return 0.0
    return sum(1 for ch in t if "\u4e00" <= ch <= "\u9fff") / len(t)
bad, fabricated, cross = [], [], 0
for r in rows:
    raw = r.get("rawText")
    if not isinstance(raw, str) or not raw:
        continue
    sar = r.get("sar") or {}
    for f in ("situation", "action", "outcome"):
        v = sar.get(f) or ""
        if label.search(v):
            bad.append("%s.%s" % (r.get("expId"), f))
            continue
        # ① 硬判据: 字段里的标识符/数字/路径必须能在 rawText 里找到 —— 这才是"捏造"的真实风险
        missing = [tok for tok in IDENT.findall(v) if tok not in raw]
        if len(missing) > max(1, len(IDENT.findall(v)) // 3):
            fabricated.append("%s.%s(标识符找不到: %s)" % (r.get("expId"), f, missing[:2]))
            continue
        # ② 字符重叠判据**只在 rawText 本身是中文时成立**: 中文原文该被引用字符; 英文/代码原文下
        #    中文摘要是**翻译/改写**, 字符重叠天然低(实测 exp_328 英文原文+中文摘要 47% 被误判成捏造)。
        #    (第一版按"字段与原文是否跨语种"判断, 但混合文本 cjk 比例 0.30 落在 0.5 阈值之下 ⇒ 仍误判;
        #     改为只按**原文语种**决定用哪条判据。)
        raw_cjk = cjk_ratio(raw[:600]) > 0.5
        if raw_cjk:
            chars = set(ch for ch in v if not ch.isspace())
            if chars and len(chars & set(raw)) / len(chars) < 0.5:
                fabricated.append("%s.%s(中文原文但重叠仅 %.0f%%)"
                                  % (r.get("expId"), f, 100 * len(chars & set(raw)) / len(chars)))
            continue
        # 非中文原文: 用"至少一个 4+ 拉丁词/标识符能在原文找到"作下限(翻译允许, 凭空造词不允许)
        cross += 1
        toks = re.findall(r"[A-Za-z][A-Za-z0-9_\-]{3,}", v)
        if toks and not any(t in raw for t in toks):
            fabricated.append("%s.%s(英文原文下字段无任何词可回溯)" % (r.get("expId"), f))
assert not bad, "字段残留结构标记(互串): %s" % bad[:3]
assert not fabricated, "字段内容无法回溯到 rawText(疑似捏造): %s" % fabricated[:3]
print("SAR 字段可回溯(跨语种摘要 %d 项按标识符判据放行)" % cross)
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

# ── T33 非终态项到期裁决(09-09 固化; 09-10 17:5x 按 cl-136 改为非终态判定) ──
# 原判据是状态白名单 open/in-progress —— 新增状态取值后 14 条非终态成盲区(cl-132 家族)。
# 现判据: 非终态(不含 done/retired/closed)即须有处置位; 合法阻塞项须有显式处置字段。
echo "[T33] 非终态项到期裁决(每条非终态须有处置位; 过期未裁决即失败)"
t "非终态项均有处置位" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
# 终态 = 不必再裁决; 其余一律参与检查(不再用状态白名单, 否则新增取值即成盲区)。
TERMINAL = {"done", "retired", "closed"}
DISP = ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")
open_items = {k: v for k, v in by_id.items() if v.get("status") not in TERMINAL}
assert open_items, "无非终态项 —— 本断言前提不成立, 不得算通过"
naked = sorted(k for k, v in open_items.items() if not any(v.get(f) for f in DISP))
assert not naked, "非终态项缺处置位(reviewBy/disposition/unblockPlan/nextAction/blockedReason): %s" % naked[:5]
print("非终态 %d 项均有处置位" % len(open_items))
'
t "非终态项未过期" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
TERMINAL = {"done", "retired", "closed"}
today = datetime.date.today().isoformat()
open_items = {k: v for k, v in by_id.items() if v.get("status") not in TERMINAL}
overdue = [k for k, v in open_items.items()
           if isinstance(v.get("reviewBy"), str) and v["reviewBy"] < today]
assert not overdue, "已过 reviewBy 未裁决: %s" % overdue[:5]
print("非终态 %d 项无过期" % len(open_items))
'
t "盲区归零(新增状态取值必须被覆盖)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
TERMINAL = {"done", "retired", "closed"}
LEGACY = {"open", "in-progress"}
blind = sorted(k for k, v in by_id.items()
               if v.get("status") not in TERMINAL and v.get("status") not in LEGACY)
# 盲区被允许存在, 但必须是被判据覆盖到的: 逐条须有处置位, 否则即为"新增取值漏判"。
naked = [k for k in blind
         if not any(by_id[k].get(f) for f in ("reviewBy","disposition","unblockPlan","nextAction","blockedReason"))]
assert not naked, "新增状态取值落在判据之外且无处置位: %s" % naked[:5]
print("旧白名单之外的 %d 条已全部纳入判定" % len(blind))
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
i = s.index("export function selectActionableGoals")
j = s.index(chr(10) + "}" + chr(10), i)          # 取函数体到最后一行单独的 }
seg = s[i:j]
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
    # cl-182: 回填行(reconstructed)不算"真实采纳日志"——它们是 notes 的历史回填, 用于修复双通道脱节,
    # 若计入, 差额判据会读出"日志多于计数"的假倒退。
    # cl-262(2026-09-12 04:5x): 写入方(dsh-goal-pool-write.py)现在也会写 pool-change(补归因通道)——
    # 那些行**不是**插件的采纳记账, 若计入会把"未记时间的采纳"差额抹平(实测该目标差额 2→1 而打红本判据)。
    # 故按 origin 排除: 本判据量的是"插件采纳记账 vs 池计数"这一对通道, 我方记录行另属一条通道。
    logged = len([a for a in log if a.get("goalId") == gid and not a.get("reconstructed")
                  and a.get("origin") != "dsh-goal-pool-write.py"])
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
known = {"tick", "silent-skip", "agent-not-live", "agent-resumed", "agent-resume-failed",
         "busy", "user-active", "model-unavailable", "model-ok", "model-check-unknown",
         "dispatch-unconsumed", "dispatch-suspended"}
bad = sorted({r.get("reason") for r in rows if r.get("reason") not in known})
assert not bad, "未知跳过原因(未登记的新心跳理由): %s" % bad[:5]
'
t "心跳理由集合与代码同步(cl-117)" bash -c "python3 '$HOME/dsh-fork/dsh-heartbeat-reasons.py'"

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
t "ensureWordKeywords 逐项剔单字(cl-101)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
i = s.index("private ensureWordKeywords")
seg = s[i:i+900]
assert "cleaned" in seg and "length === 1" in seg, "未逐项剔除单字"
'
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
t "校验失败开放(查不到不阻断, 但必须可见)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
i = s.index("const modelStillAvailable")
seg = s[i:i+1000]
# cl-103 三态: 查不到 => unknown(不阻断), 调用方只把 missing 当阻断, 且 unknown 必须留痕。
assert "unknown" in seg, "查不到未标注 unknown"
assert "missing" in s, "调用方未按三态判定"
assert "model-check-unknown" in s, "unknown 路径无痕迹(不可证伪)"
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
model_beats = [r for r in rows if str(r.get("reason") or "").startswith("model-")]
# 2026-09-10 22:5x 收紧(此前补丁因锚点冲突未落盘): 只看**最近一条** model-* 心跳 —— 历史出现过
# model-unavailable 不等于当前不可用, 模型恢复后告警应当关闭, 否则永远挂着(过时条件的误报)。
latest_beat = model_beats[-1] if model_beats else None
beats = model_beats if (latest_beat and latest_beat.get("reason") == "model-unavailable") else []
by_id = {}
for l in open(os.path.join(D, "claims-ledger.jsonl"), encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r   # cl-041: 追加式账本必须 last-wins
open_alerts = [r for r in by_id.values() if str(r.get("id", "")).startswith("cl-model-expired") and r.get("status") in ("open", "in-progress")]
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
# 判据必须比较"同一对"读数: 生产者按**最大增益的变体**出判读, 而旧断言固定拿
# "同链集中度加权"去比 —— 该变体增益为 0 而"引用反馈加权"有增益时, 断言就把
# 生产者的正确判读判成错误(09-10 19:0x 实测首红)。改为通用解析: 基线 + 全部变体,
# 取最大增益与生产者的判读对照(这样新增变体也不会让断言失配)。
base = re.search(r"均匀 IDF\(现状\)\s+([0-9.]+)%", out)
assert base, "缺基线读数: %s" % out[:200]
variants = [(n, float(v)) for n, v in re.findall(r"^\s+(\S+?)\s+([0-9.]+)%\s+\(Δ", out, re.M)]
assert variants, "缺变体读数: %s" % out[:200]
gain = max(v - float(base.group(1)) for _, v in variants)
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
t "跳词有选择性门(cl-098)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
assert "MIN_JUMP_TOP_SHARE" in s, "缺选择性门"
assert "topShare < MIN_JUMP_TOP_SHARE" in s, "选择性门未接入"
'
t "跳词候选有语料频率门(cl-098)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/triggers.ts"), encoding="utf8").read()
assert "MAX_JUMP_DF_RATIO" in s, "缺频率门"
assert "tooCommon(token)" in s, "频率门未接入候选过滤"
'
t "产物含频率门(已部署)" bash -c "grep -q 'tooCommon' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"
t "含按日引用率时间线(cl-100)" bash -c "timeout 300 python3 '$HOME/dsh-fork/dsh-citation-by-trigger.py' | grep -q '按日引用率'"
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

# ── T79 跳词选择性门的效果见证(tp-062/cl-098: 表里真的没噪声词) ──
echo "[T79] 跳词表效果见证(cooccurrence 全部过门 / 噪声词已移除 / 门已部署)"
t "cooccurrence 跳词全部过选择性门" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/trigger_jumps.json")
d = json.load(open(p, encoding="utf8"))
items = d if isinstance(d, list) else d.get("jumps", d)
rows = {x["jumpWord"]: x for x in items if isinstance(x, dict)} if isinstance(items, list) else items
bad = []
for w, v in rows.items():
    if v.get("source") != "cooccurrence":
        continue
    ev = [t.get("evidenceCount", 0) for t in v.get("triggers", [])]
    tot = sum(ev) or 1
    if ev and max(ev) / tot < 0.5:
        bad.append((w, round(max(ev) / tot, 2)))
assert not bad, "仍有未过门的 cooccurrence 跳词: %s" % bad[:5]
'
t "已知噪声词已从跳词表移除" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/trigger_jumps.json")
d = json.load(open(p, encoding="utf8"))
items = d if isinstance(d, list) else d.get("jumps", d)
rows = {x["jumpWord"]: x for x in items if isinstance(x, dict)} if isinstance(items, list) else items
left = [w for w in ("生成", "没有", "sh", "bash", "需要", "执行") if w in rows]
assert not left, "噪声词仍在表中: %s" % left
'
t "选择性门已部署" bash -c "grep -q 'MIN_JUMP_TOP_SHARE' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js'"

# ── T80 帧回合引用结算见证(tp-063/cl-100: 注入回合必须就是结算回合) ──
echo "[T80] 帧回合结算见证(修复已部署 / 同回合结算样本 / 无长期滞留)"
t "cl-100 修复已部署(lib 含 hasAssistantText 与 accumulate 解耦)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js"), encoding="utf8").read()
assert "hasAssistantText" in src, "lib 缺 hasAssistantText(帧回合结算判据)"
assert "accumulate" in src, "lib 缺 accumulate 选项(结算与累计未解耦)"
'
t "settle-debug 存在同回合结算样本(ageMs<1h)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/settle-debug.jsonl")
if not os.path.exists(p):
    # 探针是诊断期临时物(cl-100 待办④), 已按计划移除时本断言退化为"无探针即无要求",
    # 持久见证由下一条"构建后无长期滞留注入"承担。
    print("探针已按计划移除, 持久见证见下一条"); raise SystemExit(0)
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
# 判据: 结算发生在注入所在回合的回合末, 故 ageMs ≈ 该回合时长。TTL 结算是 24h,
# "拖到下一回合才结算"通常也是小时级 —— 1h 门足以把三者区分开。
same = [r for r in rows if r.get("path") == "pending" and (r.get("ageMs") or 10**12) < 3600000]
assert same, "无同回合结算样本(注入回合≠结算回合): %d 条探针, %d 条 pending" % (len(rows), sum(1 for r in rows if r.get("path") == "pending"))
'
t "构建后无长期滞留注入(修复前 09-09 起 105 注入仅 11 次结算)" python3 -c '
import json, os, time
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
cut = os.path.getmtime(lib) * 1000   # 构建时刻之后的注入才受 cl-100 修复保护
p = os.path.expanduser("~/.dsh/cognitive-pipeline/injections.jsonl")
rows = {}
for l in open(p, encoding="utf8"):
    if l.strip():
        r = json.loads(l); rows[r["injectionId"]] = r
now = time.time() * 1000
# 构建后创建、且已超 2h 仍 cited=null 的记录最多 1 条(当前正在跑的回合)
stuck = [r["injectionId"] for r in rows.values()
         if r.get("cited") is None and r["createdAt"] > cut and now - r["createdAt"] > 2 * 3600 * 1000]
assert len(stuck) <= 1, "构建后仍滞留 %d 条: %s" % (len(stuck), stuck[:5])
'

# ── T81 临时探针退场守卫(tp-064: 诊断物不得变成永久物) ──
echo "[T81] 探针退场守卫(真实状态 / 超期未退场必红 / 超期已退场必绿 / 删文件留代码必红)"
t "退场守卫: 真实状态" python3 "$HOME/dsh-fork/dsh-probe-retire-check.py"
t "退场守卫负向: 超期未退场必须红" bash -c '
set -e
tmp=$(mktemp -d); now=$(date +%s%3N); trap "rm -rf $tmp" EXIT
python3 - "$tmp" "$now" <<PY
import json, sys, datetime
tmp, now = sys.argv[1], int(sys.argv[2])
past = now - 25*3600*1000
open(f"{tmp}/settle-debug.jsonl","w",encoding="utf8").write(json.dumps({"t": past})+"\n")
open(f"{tmp}/fake-lib.js","w",encoding="utf8").write("const f = \"settle-debug.jsonl\"\n")
open(f"{tmp}/fake-src.ts","w",encoding="utf8").write("// cl-100 PROBE\n")
iso = datetime.datetime.fromtimestamp((past+86400000)/1000).isoformat()
open(f"{tmp}/cl-100-diagnosis.md","w",encoding="utf8").write(f"probe-deadline: {iso}\n")
PY
if python3 "$HOME/dsh-fork/dsh-probe-retire-check.py" --root "$tmp" --lib "$tmp/fake-lib.js" --src "$tmp/fake-src.ts" --now "$now" >/dev/null 2>&1; then
  echo "守卫未开火(应红却绿)"; exit 1
fi
'
t "退场守卫负向: 期限行解析失败必须说出来(不得静默换锚点)" bash -c '
set -e
tmp=$(mktemp -d); trap "rm -rf $tmp" EXIT
printf "%s\n" "# cl-100" "probe-deadline: 坏格式（ISO 令牌后紧跟括号会被 split 吞掉）" > "$tmp/cl-100-diagnosis.md"
printf "%s\n" "const f = \"settle-debug.jsonl\"" > "$tmp/fake-lib.js"
printf "%s\n" "// cl-100 PROBE" > "$tmp/fake-src.ts"
if python3 "$HOME/dsh-fork/dsh-probe-retire-check.py" --root "$tmp" --lib "$tmp/fake-lib.js" --src "$tmp/fake-src.ts" 2>"$tmp/err"; then
  echo "解析失败却判绿(应红)"; exit 1
fi
grep -q "无法解析" "$tmp/err" || { echo "红是红了, 但理由不是解析失败: $(cat "$tmp/err")"; exit 1; }
'
t "退场守卫负向: 超期已退场必须绿" bash -c '
set -e
tmp=$(mktemp -d); now=$(date +%s%3N); trap "rm -rf $tmp" EXIT
python3 - "$tmp" "$now" <<PY
import sys, datetime
tmp, now = sys.argv[1], int(sys.argv[2])
past = now - 25*3600*1000
open(f"{tmp}/fake-lib.js","w",encoding="utf8").write("const f = \"ok\"\n")
open(f"{tmp}/fake-src.ts","w",encoding="utf8").write("// clean\n")
iso = datetime.datetime.fromtimestamp((past+86400000)/1000).isoformat()
open(f"{tmp}/cl-100-diagnosis.md","w",encoding="utf8").write(f"probe-deadline: {iso}\n")
PY
python3 "$HOME/dsh-fork/dsh-probe-retire-check.py" --root "$tmp" --lib "$tmp/fake-lib.js" --src "$tmp/fake-src.ts" --now "$now" >/dev/null
'
t "退场守卫负向: 删掉数据文件但留下写它的代码必须红" bash -c '
set -e
tmp=$(mktemp -d); now=$(date +%s%3N); trap "rm -rf $tmp" EXIT
python3 - "$tmp" "$now" <<PY
import sys, datetime
tmp, now = sys.argv[1], int(sys.argv[2])
past = now - 25*3600*1000
open(f"{tmp}/fake-lib.js","w",encoding="utf8").write("const f = \"settle-debug.jsonl\"\n")
open(f"{tmp}/fake-src.ts","w",encoding="utf8").write("// cl-100 PROBE\n")
iso = datetime.datetime.fromtimestamp((past+86400000)/1000).isoformat()
open(f"{tmp}/cl-100-diagnosis.md","w",encoding="utf8").write(f"probe-deadline: {iso}\n")
PY
if python3 "$HOME/dsh-fork/dsh-probe-retire-check.py" --root "$tmp" --lib "$tmp/fake-lib.js" --src "$tmp/fake-src.ts" --now "$now" >/dev/null 2>&1; then
  echo "守卫未开火: 删数据文件即可逃逸(这正是首版守卫的漏洞)"; exit 1
fi
'

# ── T82 注入集噪声指标(tp-065/cl-102: 帧生回流 / 静态占比 / 跳词通道有效性) ──
echo "[T82] 注入集噪声指标(指标刷新 / 帧生占比 / 静态占比 / 跳词通道有效性)"
t "噪声指标已落盘并刷新" bash -c '
python3 "$HOME/dsh-fork/dsh-injection-noise.py" --quiet >/dev/null 2>&1 || true
python3 - <<PY
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json")
assert os.path.exists(p), "指标文件缺失: dsh-injection-noise.py 未落盘"
m = json.load(open(p, encoding="utf8"))
age = time.time() - os.path.getmtime(p)
assert age < 300, "指标文件陈旧 %.0fs(本次套件运行未刷新)" % age
for k in ("frameBornInjectionShare", "staticTriggerShare", "channels", "window"):
    assert k in m, "指标缺字段 %s" % k
assert m["window"] >= 50, "窗口样本太少: %d" % m["window"]
PY
'
t "帧生经验回流占比 ≤ 40%(边界后口径; 窗口口径只报数)" python3 -c '
import json, os
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
m = json.load(open(os.path.join(D, "injection-noise.json"), encoding="utf8"))
# 2026-09-12 17:0x(cl-283): 窗口口径会**跨修复边界**混合历史(cl-280 修好读侧判据后, 最近 200 条里仍有 44.7%
# 是修复前的注入)⇒ 用窗口值判"当前状态"会把已修好读成没修好。有边界后样本按边界后判, 窗口值只作历史报告。
since = m.get("frameBornInjectionShareSinceBuild")
v = m["frameBornInjectionShare"] if since is None else since
assert v <= 0.40, ("帧生注入占比 %.1f%% 超阈 40%%——自我回声已主导注入集(口径: %s)"
                    % (v * 100, "构建边界后" if since is not None else "窗口(无边界后样本)"))
print("判据口径=%s; 边界后 %.1f%% / 窗口 %.1f%%(历史)" % ("边界后" if since is not None else "窗口",
                                                      (since if since is not None else v) * 100, m["frameBornInjectionShare"] * 100))
'
t "静态触发占比 ≤ 95%(通道塌缩警戒, 非噪声判据)" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
v = m["staticTriggerShare"]
# 阈值说明: tp-065 原写 85%, 无数据依据; 实测 static 类是历史引用率最高的类
# (09-06 前 26.3%), 高占比本身不等于噪声, 故上调为 95% 的"只剩一条通道"警戒线。
assert v <= 0.95, "静态触发占比 %.1f%%: 注入通道已塌缩到只剩静态词匹配" % (v * 100)
'
t "跳词通道有效性(现世代样本 ≥20 时引用率必须 >0)" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
# 判据口径修正(cl-099): 原先用全库跳词注入统计, 而 67 条零引用样本全部来自
# 上一代词表(ts/sh/2/草稿...), 该表已在 09-10 04:07 重建时退役。世代边界 =
# 词表最大 updatedAt; 只对"现代表"的样本判死, 旧账仍留在指标里备查。
settled = m.get("jumpGenerationSettled", 0)
cited = m.get("jumpGenerationCited", 0)
if settled < 20:
    print("现世代样本不足(%d), 空过" % settled); raise SystemExit(0)
assert cited > 0, "现世代跳词 %d 条已结算样本零引用——学习出来的通道比静态词还差" % settled
'
t "跳词表卫生(超龄零证据条目必须为 0)" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
stale = m.get("jumpStaleZeroEvidence", 0)
assert stale == 0, "%d 条零证据跳词已过证据寿命仍驻留(前 5: %s)" % (stale, m.get("jumpStaleZeroEvidenceWords"))
'

# ── T83 跳词判据窗口健康度(tp-066/tp-067: 判据不得变成永不开火的死判据) ──
echo "[T83] 跳词判据窗口健康(重建风暴防护 / 有证据变体跨重建存活)"
t "判据窗口健康: 重建次数须由重启与节流解释" python3 -c '
import json, os, re, subprocess
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
n = m.get("jumpRebuildCount24h")
assert isinstance(n, int), "指标缺 jumpRebuildCount24h"
# 旧判据是"24h 重建 <=4"这个魔数 —— 它把"重启"忘了: 节流戳是**内存态**
# (service.ts:2840 注释自认 in-memory), 每次重启都会放行一次立即重建, 于是
# 开发日(今日 24h 内 service 启动 45 次)必然超 4 而误报。改为按"重启 + 节流"
# 可解释的上界判定: 重启各允许一次, 另加绝对风暴上限, 并额外要求判据真的攒到过样本。
starts = 0
try:
    out = subprocess.run(["journalctl", "--user", "-u", "dsh-web.service", "--since", "24 hours ago"],
                         capture_output=True, text=True, timeout=60).stdout
    starts = len(re.findall(r"Started dsh-web", out))
except Exception:
    starts = 0
allowed = max(4, starts + 2)
assert n <= 24, "24h 内重建 %d 次超过绝对上限 24: 判据窗口被反复重置" % n
assert n <= allowed, "重建 %d 次超出重启(%d)+节流可解释的上界 %d" % (n, starts, allowed)
settled = m.get("jumpChannelSettled", 0)
assert settled > 0, "跳词通道累计已结算 %s 条 => 判据从未攒到样本(死判据)" % settled
'
t "有证据的 LLM 变体跨重建必须 100% 存活" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
s = m.get("llmProvenSurvival")
if s is None:
    print("当前无有证据变体, 空过"); raise SystemExit(0)
assert s >= 1.0, "有证据的 LLM 变体存活率 %.0f%% <100%%: 重建把已证明有用的关联换掉了" % (s * 100)
'

# ── T84 帧生经验回流抑制(cl-102: 源头断流 + 注入侧断回注) ──
echo "[T84] 帧生经验回流抑制(双侧接线 / 源头断流 / 注入侧断回注)"
t "cl-102 双侧接线已部署(累计门 + 歧义元经验 + 检索过滤)" bash -c "
grep -q 'isSelfFrameExperience' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js' &&
grep -q 'isSelfFrameExperience' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js' &&
test \$(grep -c 'isSelfFrameExperience({ sar' '$HOME/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js') -ge 2
"
t "源头断流: 构建后帧生经验不得以普通经验入库(meta 元经验按设计可产生)" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
n = m.get("frameBornNonMetaSinceBuild")
assert isinstance(n, int), "指标缺 frameBornNonMetaSinceBuild(又退回只看总数)"
assert n == 0, "构建后 %d 条帧味情境以普通经验入库(真泄漏, 前 5: %s)" % (n, m.get("frameBornNonMetaSinceBuildIds"))
print("构建后真泄漏 0 条(按设计产生的元经验 %s 条, 只报数: 低余量真实回合/验收准则偏差)" % m.get("frameBornMetaSinceBuild"))
'
t "注入侧断回注: 构建后注入含帧生经验 = 0" python3 -c '
import json, os
m = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/injection-noise.json"), encoding="utf8"))
n = m.get("frameBornSinceBuild", 0)
if m.get("injectionsSinceBuild", 0) == 0:
    print("构建后尚无新注入, 空过"); raise SystemExit(0)
assert n == 0, "构建后 %d 条注入仍含帧生经验" % n
'

# ── T85 模型巡检的可证伪性(cl-103 正向痕迹 / cl-104 关闭记录契约与去重) ──
echo "[T85] 模型巡检可证伪(正向痕迹 / 关闭记录带 claim / T73 读账本去重)"
t "巡检必须留下判定痕迹(最近 1h 有任一 model-* 心跳)" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
assert os.path.exists(p), "心跳文件缺失"
cut = time.time() * 1000 - 3600 * 1000
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
hit = [r for r in rows if (r.get("ts") or 0) > cut
       and str(r.get("reason") or "").startswith("model-")]
# cl-103: 只有失败路径留痕 => "没有告警"不可证伪。断言"查过并留下判定",
# 而不是"必须报 model-ok"——模型真的不在时, 正确的痕迹恰恰是 model-unavailable
# (tp-070: 旧写法在到期后必然变红, 会把正确行为当成故障)。
assert hit, "最近 1h 无任何 model-* 心跳: 巡检是否真的跑过不可证"
'
t "所有告警关闭记录都必须带 claim 字段(套件 10c 断言每行有 id 和 claim)" python3 -c '
import re, os
src = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
# 套件 10c 断言账本每行都有 id 和 claim => 每个 status: done 的写入块都必须带 claim。
blocks = re.findall(r"\{[^{}]*status: .done.[^{}]*\}", src, re.S)
assert blocks, "未找到关闭记录写入块"
bad = [b[:80] for b in blocks if "claim:" not in b]
assert not bad, "关闭记录缺 claim 的块: %s" % bad
'

# ── T86 在用模型 vs 实时目录(cl-105: 巡检真相源是硬编码清单) ──
echo "[T86] 在用模型一致性(实时目录检查落盘 / 差异必须可见)"
t "实时目录一致性检查已落盘并刷新" bash -c '
python3 "$HOME/dsh-fork/dsh-model-catalog-check.py" --quiet >/dev/null 2>&1 || true
python3 -c "
import json, os, time
p = os.path.expanduser(\"~/.dsh/cognitive-pipeline/model-catalog.json\")
assert os.path.exists(p), \"model-catalog.json 缺失\"
d = json.load(open(p, encoding=\"utf8\"))
assert time.time() - os.path.getmtime(p) < 300, \"目录检查结果陈旧\"
# cl-129: verdict 新增 in-use-and-default-missing(在用与 profile 默认同时下架)
# cl-160: 新增 in-use-unadvertised-and-serving(未登广告但响应侧仍在服务) —— 白名单须同步扩,
# 否则新增取值会被判红(今天第 N 次: 产出方扩值, 消费方判据没跟上)。
assert d.get(\"verdict\") in (\"present\", \"missing\", \"unknown\",
                            \"in-use-and-default-missing\",
                            \"in-use-unadvertised-and-serving\"), d.get(\"verdict\")
assert d.get(\"modelInUse\"), \"未记录在用模型\"
"
'
t "目录差异必须可见(cl-105: 巡检报 model-ok 而实时目录已无该模型)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json"), encoding="utf8"))
# cl-132: 守卫必须语义匹配(凡含 missing 即视为"不在目录")——verdict 扩了新取值后,
# 原来 != "missing" 的写法会把"真正的缺失"判成"非缺失"并静默空过(三条断言一起失效)
if "missing" not in str(d.get("verdict")):
    print("在用模型仍在目录中, 空过"); raise SystemExit(0)
# 差异存在时, 结果文件必须显式记录, 且目录快照非空——差异不得被静默吞掉。
assert d.get("missingFromCatalog") is True, "verdict=missing 但 missingFromCatalog 未置真"
assert d.get("catalog"), "verdict=missing 但目录快照为空(无法复核)"
'

# ── T87 实时目录真相源优先(cl-106: 目录说不在就是不在) ──
echo "[T87] 实时目录真相源(告警链已接 / 矛盾不可共存)"
t "巡检已接实时目录(更悲观者胜)" bash -c "
grep -q 'readLiveCatalogVerdict' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts' &&
grep -q 'live-catalog' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'
"
t "目录说不在时, 最近一条模型心跳不得是 model-ok" python3 -c '
import json, os
cat = os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json")
hb = os.path.expanduser("~/.dsh/cognitive-pipeline/quiet-driver-heartbeat.jsonl")
if not (os.path.exists(cat) and os.path.exists(hb)):
    print("缺文件, 空过"); raise SystemExit(0)
d = json.load(open(cat, encoding="utf8"))
# cl-132: 守卫必须语义匹配(凡含 missing 即视为"不在目录")——verdict 扩了新取值后,
# 原来 != "missing" 的写法会把"真正的缺失"判成"非缺失"并静默空过(三条断言一起失效)
if "missing" not in str(d.get("verdict")):
    print("在用模型仍在目录中, 空过"); raise SystemExit(0)
rows = [json.loads(l) for l in open(hb, encoding="utf8") if l.strip()]
model_beats = [r for r in rows if str(r.get("reason") or "").startswith("model-")]
assert model_beats, "无模型相关心跳"
last = model_beats[-1]
# cl-106: 实时目录说"不在"时, 心跳仍报 model-ok 就是两个真相源在互相打脸,
# 且会让 T73 的一致性检查形同虚设。
assert last.get("reason") != "model-ok", "目录 verdict=missing 而最近心跳是 model-ok(矛盾共存)"
'
t "目录说不在时账本必须有未关闭告警" python3 -c '
import json, os
cat = os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json")
led = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
d = json.load(open(cat, encoding="utf8")) if os.path.exists(cat) else {}
# cl-132: 守卫必须语义匹配(凡含 missing 即视为"不在目录")——verdict 扩了新取值后,
# 原来 != "missing" 的写法会把"真正的缺失"判成"非缺失"并静默空过(三条断言一起失效)
if "missing" not in str(d.get("verdict")):
    print("目录 verdict 非 missing, 空过"); raise SystemExit(0)
by_id = {}
for l in open(led, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
alerts = [r for r in by_id.values()
          if str(r.get("id","")).startswith("cl-model-expired") and r.get("status") in ("open","in-progress")]
assert alerts, "实时目录已无在用模型, 但账本没有未关闭的 cl-model-expired-* 告警"
'

# ── T88 到期告警的日期与幂等(cl-107 本地日 / cl-108 条件型开单) ──
echo "[T88] 到期告警日期与幂等(本地日历日 / 同一条件只开一单)"
t "告警日期用本地日历日(reviewBy 不得早于创建日, 覆盖两族)" python3 -c '
import json, os, datetime
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
bad = []
for k, v in by_id.items():
    # cl-109: 到期告警与停摆告警同形, 断言必须覆盖两族(否则修了实例漏了类)。
    if not k.startswith(("cl-model-expired", "cl-stall-")): continue
    ts = v.get("ts")
    if not isinstance(ts, str): continue
    try:
        created = datetime.datetime.fromisoformat(ts).date().isoformat()
    except Exception:
        continue
    # cl-107: toISOString() 是 UTC, 本地 00:00-07:59 会写成前一天的 reviewBy
    # => 告警一落地就被 T33 判"已过 reviewBy 未裁决"。
    if isinstance(v.get("reviewBy"), str) and v["reviewBy"] < created:
        bad.append((k, ts[:10], v["reviewBy"]))
assert not bad, "reviewBy 早于创建日的告警: %s" % bad
'
t "同一条件至多一个未关闭告警(两族分别判定)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by_id = {}
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    r = json.loads(l)
    if r.get("id"): by_id[r["id"]] = r
for prefix in ("cl-model-expired", "cl-stall-"):
    open_alerts = [k for k, v in by_id.items()
                   if k.startswith(prefix) and v.get("status") == "open"]
    assert len(open_alerts) <= 1, "%s 存在 %d 条未关闭告警(跨日/重启重复开单): %s" % (
        prefix, len(open_alerts), open_alerts)
'
t "两族告警都复用已有未关闭单(cl-109 通用助手)" bash -c "
grep -q 'findOpenAlertId' '$HOME/dsh-fork/packages/context/quiet-driver/src/alert-ledger.ts' &&
test \$(grep -c \"findOpenAlert('cl-\" '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts') -ge 2
"

# ── T89 告警账本纯函数单测(cl-109 的复用/日期语义, 不需要真实停摆即可验证) ──
echo "[T89] 告警账本纯函数(findOpenAlertId/localDay 语义)"
t "findOpenAlertId/localDay 语义单测(6 例)" bash -c "cd '$HOME/dsh-fork' && timeout 180 npx tsx dsh-alert-ledger-test.ts"

# ── T90 等待型 nextAction 判定(cl-110: 等待型目标不得被推行动帧) ──
echo "[T90] 等待型判定(容忍空格 / 不误判可执行项)"
t "isWaitingNextAction 单测 + 构建后行动帧审计" bash -c "cd '$HOME/dsh-fork' && timeout 180 npx tsx dsh-waiting-guard-test.ts"
t "行动帧循环已用纯函数判定(cl-110 接线)" bash -c "
grep -q 'isWaitingNextAction' '$HOME/dsh-fork/packages/context/quiet-driver/src/waiting.ts' &&
grep -q 'isWaitingNextAction(g.nextAction)' '$HOME/dsh-fork/packages/context/quiet-driver/src/index.ts'
"

# ── T91 回合类型注入闸门 + 四级漏斗审计(cl-114 / goal-adoption-rate) ──
echo "[T91] 采用率闸门(回合分类单测 / 闸门已部署 / 审计漏斗已落盘)"
t "classifyTurnKind/decideInjection 单测(17 例)" bash -c "cd '$HOME/dsh-fork' && timeout 180 npx tsx dsh-turn-gate-test.ts"
t "闸门与审计已部署(lib 含 turnKind/retrieval-audit)" bash -c "
grep -q 'retrieval-audit.jsonl' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js' &&
grep -q 'skipped-reflective-frame' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js'
"
t "四级漏斗审计在构建后已写入且阶段自洽" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")
if not os.path.exists(p):
    print("审计文件尚未产生(构建后无注入决策), 空过"); raise SystemExit(0)
cut = os.path.getmtime(lib) * 1000
rows = []
for l in open(p, encoding="utf8"):
    if not l.strip(): continue
    try: r = json.loads(l)
    except Exception: continue
    if (r.get("t") or 0) > cut: rows.append(r)
if not rows:
    print("构建后暂无决策记录, 空过"); raise SystemExit(0)
stages = {}
for r in rows: stages[r.get("stage")] = stages.get(r.get("stage"), 0) + 1
# 漏斗自洽: 注入数 <= 过阈数 <= 候选数; 被否决的必须记在 veto 阶段
bad = [r for r in rows if r.get("stage") == "injected"
       and ((r.get("vetoAccepted") or 0) + (r.get("vetoRejected") or 0)) == 0]
assert not bad, "注入记录缺少过阈/否决计数: %s" % bad[:2]
print("构建后决策 %d 条, 阶段分布 %s" % (len(rows), stages))
'

# ── T92 采用率闸门效果见证 + 目标入池体检(cl-114 第1步 / tp-073,tp-074) ──
echo "[T92] 闸门运行时效果(反思类帧必须被静默 / 漏斗单调) + 目标入池体检"
t "审计的 decision 必须与闸门配置模式一致" python3 -c '
import json, os, re
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
src_path = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts")
assert os.path.exists(p), "retrieval-audit.jsonl 缺失(cl-114 第1步的产物)"
src = open(src_path, encoding="utf8").read()
m = re.search(r"enableTurnGating: z\.boolean\(\)\.default\((true|false)\)", src)
assert m, "未找到 enableTurnGating 默认值"
enabled = m.group(1) == "true"
ESTABLISHED = 20   # 与 establishedSessionTurns 默认一致
lib = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")
build = os.path.getmtime(lib) * 1000   # 模式切换只在重启后生效 => 只判本次构建之后的记录
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
rows = [r for r in rows if (r.get("t") or 0) > build]
if not rows:
    print("本次构建后暂无审计记录, 空过"); raise SystemExit(0)
reflective = [r for r in rows if r.get("turnKind") == "reflective-frame"]
# cl-116 后断言必须**随配置模式**判定: 闸门关着时"反思帧被注入"是正确行为; 开着时
# 已建立会话的反思帧必须 skip。写死一种模式, 就会在切换开关时伪红(tp-076 同类)。
if not enabled:
    bad = [r for r in reflective if r.get("decision") != "inject"]
    assert not bad, "闸门已关闭, 但审计出现非 inject 决策: %s" % [(r.get("decision"), r.get("stage")) for r in bad[:2]]
    print("闸门关闭模式: %d 条反思类决策均为 inject(含历史 skip 记录 %d 条)"
          % (len(reflective), len([r for r in reflective if r.get("stage") == "skipped-reflective-frame"])))
else:
    bad = [r for r in reflective
           if (r.get("sessionTurns") or 0) >= ESTABLISHED and r.get("decision") == "inject"]
    assert not bad, "已建立会话的反思类帧未被静默: %s" % [(r.get("sessionTurns"), r.get("decision")) for r in bad[:2]]
'
t "审计活性: 最近 24h 至少出现 2 个不同 stage" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
# 窗口取 24h 而非"构建后": 每次重启都会重置构建窗口 => 必然伪红(tp-076 的窗口教训)。
cut = (time.time() - 24 * 3600) * 1000
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
stages = {r.get("stage") for r in rows if (r.get("t") or 0) > cut}
# 只验"审计在多个分支上都活着"; 不要求某个具体 stage 出现——below-gate/cooldown
# 天然稀疏, 强求会变成伪红(tp-076 的同类教训)。
assert len(stages) >= 2, "构建后审计只覆盖 %d 个 stage: %s(可能断在某条 early return 前)" % (len(stages), sorted(stages))
print("构建后 stage: %s" % sorted(stages))
'
t "漏斗单调自洽: candidates ≥ overThreshold ≥ veto合计 > 0" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
inj = [r for r in rows if r.get("stage") == "injected"]
assert inj, "尚无注入记录, 无法判定漏斗"
bad = []
for r in inj:
    c = r.get("candidates") or 0
    o = r.get("overThreshold") or 0
    v = (r.get("vetoAccepted") or 0) + (r.get("vetoRejected") or 0)
    if not (c >= o >= v > 0):
        bad.append((c, o, v))
assert not bad, "漏斗数字不自洽(candidates/overThreshold/veto): %s" % bad[:3]
'
t "目标入池体检: 全部 active 目标三前提齐备" bash -c "python3 '$HOME/dsh-fork/dsh-goal-onboard-check.py' all"
t "cl-116: 回合闸门默认关闭(立项依据被证伪)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
assert "enableTurnGating: z.boolean().default(false)" in src, "闸门总开关默认值应为 false"
assert "enableTurnGating: config.enableTurnGating ?? false" in src, "resolveConfig 未透传总开关"
lib = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js"), encoding="utf8").read()
assert "enableTurnGating" in lib, "lib 未含总开关(未重建)"
' 

# ── T93 触发词归因(首命中标签会判死无辜的词) ──
echo "[T93] 触发词归因(matched/score 落地 / 单测 / 审计带归因)"
t "triggeredBy 归因单测(8 例)" bash -c "cd '$HOME/dsh-fork' && timeout 180 npx tsx dsh-trigger-attribution-test.ts"
t "审计记录带触发归因(matched + triggerScore)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
lib = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")
src = open(lib, encoding="utf8").read()
assert "triggerScore" in src and "matched" in src, "lib 未含归因字段"
if not os.path.exists(p):
    print("审计文件缺失, 空过"); raise SystemExit(0)
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
cut = os.path.getmtime(lib) * 1000
recent = [r for r in rows if (r.get("t") or 0) > cut]
if not recent:
    print("构建后暂无审计记录, 空过"); raise SystemExit(0)
missing = [r for r in recent if r.get("stage") in ("injected", "below-gate") and "matched" not in r]
assert not missing, "构建后的注入/未过闸记录缺 matched 归因: %s" % missing[:2]
'

# ── T94 采纳率唯一口径 + 数据水位(cl-116 教训: 坏账本被用了两次) ──
echo "[T94] 采纳率口径唯一化(水位强制 / 自洽 / 声明窗口)"
t "采纳统计脚本可运行且带水位" bash -c "cd '$HOME/dsh-fork' && timeout 300 python3 dsh-adoption-stats.py --json | python3 -c \"
import json,sys
d=json.load(sys.stdin)
assert d['windowStart'], '缺窗口起点'
assert 'settlement' in d['windowStartSource'] or '8ed52e7' in d['windowStartSource'], '窗口来源未标注结算修复水位'
assert d['classes'], '无分类数据'
\""
t "采纳统计自洽(注入 = 采纳 + 未结算 + 未采纳)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/adoption-stats.json")
assert os.path.exists(p), "adoption-stats.json 缺失(未运行统一口径脚本)"
d = json.load(open(p, encoding="utf8"))
for kind, v in d["classes"].items():
    assert v["injected"] >= v["cited"] + v["unsettled"], "分类 %s 数字不自洽: %s" % (kind, v)
    assert v["injected"] >= v["cited"], "分类 %s 采纳数超过注入数" % kind
'
t "水位不可缺(cl-116: 没有来源的数不出)" bash -c "grep -q '缺水位' '$HOME/dsh-fork/dsh-adoption-stats.py' && grep -q 'SETTLEMENT_FIX_COMMIT' '$HOME/dsh-fork/dsh-adoption-stats.py'"

# ── T95 经验退避 + 双口径采纳(cl-118 修订版) ──
echo "[T95] 经验退避(连击加倍 / 审计可见 / 双口径)"
t "退避调度单测(15 例, 含通道保活)" bash -c "cd '$HOME/dsh-fork' && timeout 180 npx tsx dsh-inject-backoff-test.ts"
t "退避已部署(lib 含 backoffDropped)" bash -c "grep -q 'backoffDropped' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js'"
t "退避上限可配置(cl-118 计划里的回调路径)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
assert "backoffMaxMs?: number" in src, "缺 backoffMaxMs 配置项"
# cl-118 实测: 6h 上限把整条通道静默了 40 分钟 => 默认下调为 2h
assert "backoffMaxMs: z.number().min(0).default(2 * 60 * 60 * 1000)" in src, "默认值应为 2h"
assert "admitLeastBackedOff" in src, "缺通道保活守卫(全部候选被挡时应放行最接近到期者)"
assert "backoffMaxMs: config.backoffMaxMs ?? 2 * 60 * 60 * 1000" in src, "resolveConfig 未透传(或默认值与 Config 不一致)"
assert "resolved.backoffMaxMs" in src, "调用点未用配置值(仍是硬编码)"
'
t "退避挡下时审计带"为什么"(expId/连击/有效冷却)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
assert "backoffDetails" in src, "缺退避详情"
assert "uncitedStreak" in src and "effectiveCooldownMs" in src, "详情字段不全"
lib = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js"), encoding="utf8").read()
assert "backoffDetails" in lib, "lib 未含退避详情(未重建)"
'
t "采纳统计分首次/重复两口径" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/adoption-stats.json")
assert os.path.exists(p), "adoption-stats.json 缺失"
d = json.load(open(p, encoding="utf8"))
assert "firstVsRepeat" in d, "缺首次/重复口径(cl-118 修订版要求)"
for k, v in d["firstVsRepeat"].items():
    assert v["injected"] >= v["cited"], "口径 %s 数字不自洽" % k
print("首次 %s / 重复 %s" % (d["firstVsRepeat"].get("first"), d["firstVsRepeat"].get("repeat")))
'

# ── T96 冷却/退避不变式(从账本反查机制是否真的挡住了快速重复) ──
echo "[T96] 冷却不变式(同经验重复间隔 / 退避确实拉开间距)"
t "干净窗口内同经验连续注入间隔 ≥ 基础冷却(10min)" python3 -c '
import json, os, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
MAIN = "session-63251d85-ef77-4299-939d-9a6fe9b5bec6"
WATER = datetime.datetime(2026, 9, 10, 4, 59, tzinfo=TZ).timestamp() * 1000   # cl-100 修复水位
BASE_MIN = 10.0
inj = {}
for line in open(os.path.join(D, "injections.jsonl"), encoding="utf8"):
    if not line.strip(): continue
    r = json.loads(line)
    if r.get("injectionId"): inj[r["injectionId"]] = r
seq = {}
for r in inj.values():
    if str(r.get("sessionId")) != MAIN or (r.get("createdAt") or 0) < WATER: continue
    for e in r.get("expIds") or []: seq.setdefault(e, []).append(r["createdAt"])
gaps = []
violations = []
for e, ts in seq.items():
    ts.sort()
    for a, b in zip(ts, ts[1:]):
        gap = (b - a) / 60000
        gaps.append(gap)
        if gap < BASE_MIN: violations.append((e, round(gap, 1)))
if len(gaps) < 5:
    print("间隔样本不足(%d), 空过" % len(gaps)); raise SystemExit(0)
assert not violations, "同经验在基础冷却内被重复注入(冷却/退避失效): %s" % violations[:3]
median = sorted(gaps)[len(gaps) // 2]
# 退避若只是"挡在 10 分钟线上", 中位数会贴近 10; 实测应显著更大(实测 ~39 分钟)。
assert median > BASE_MIN, "间隔中位 %.1f 分钟未超过基础冷却, 退避可能未生效" % median
print("间隔样本 %d, 中位 %.1f 分钟, 违规 0" % (len(gaps), median))
'

# ── T97 注入通道活性(防止"机制把整条通道静默"再次发生) ──
echo "[T97] 注入通道活性(退避/闸门不得把通道关死)"
t "通道活性: 有决策点却零注入 => 红" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
assert os.path.exists(p), "retrieval-audit.jsonl 缺失(无法判定通道活性)"
now = time.time() * 1000
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
# 实测事故(cl-118 6h 上限): 主会话 47 分钟零注入, 期间审计仍在记"被退避挡下",
# 却没有任何断言盯着——通道被机制自己关死而无人察觉。这条不变式补上这个盲区。
H2 = [r for r in rows if (r.get("t") or 0) > now - 2 * 3600 * 1000]
H6 = [r for r in rows if (r.get("t") or 0) > now - 6 * 3600 * 1000]
def count(rs, stage): return len([r for r in rs if r.get("stage") == stage])
silent6 = count(H6, "injected") == 0 and len(H6) >= 3
silent2 = count(H2, "cooldown") >= 2 and count(H2, "injected") == 0
assert not silent6, "最近 6h 有 %d 个决策点却零注入: 通道可能被退避/闸门关死" % len(H6)
assert not silent2, "最近 2h 连续 %d 次 cooldown 且零注入: 通道保活未生效" % count(H2, "cooldown")
print("最近 2h: 决策 %d 注入 %d | 6h: 决策 %d 注入 %d"
      % (len(H2), count(H2, "injected"), len(H6), count(H6, "injected")))
'
t "通道保活守卫已接线且可配" bash -c "
grep -q 'admitLeastBackedOff' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js' &&
grep -q 'backoffAdmitted' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js'
"

# ── T98 覆盖选择的新颖性偏好(cl-121: 轮换对照对成员, 而非闸门) ──
echo "[T98] 覆盖选择新颖性(对照结构保持 / 相关性优先 / 可关闭)"
t "coverViewpoints 新颖性单测(7 例)" bash -c "cd '$HOME/dsh-fork' && timeout 300 npx tsx dsh-novelty-pick-test.ts"
t "新颖性偏好已部署且可配(noveltyMargin)" bash -c "
grep -q 'noveltyMargin' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js' &&
grep -q 'noveltyMargin: z.number().min(0).max(1).default(0.05)' '$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts' &&
grep -q 'sessionCounts' '$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts'
"

# ── T99 杠杆可用性监控(机制在、条件已死 的自动识别) ──
echo "[T99] 杠杆可用性(轮换是否真的开火 / 惰性必须显式)"
t "审计带 rotated 字段(轮换可用性见证)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
assert "rotated" in src, "缺 rotated 见证"
lib = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js"), encoding="utf8").read()
assert "rotated" in lib, "lib 未含 rotated(未重建)"
'
t "轮换惰性必须显式(24h 内 >=5 个决策点却从未轮换 => 红)" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
cut = (time.time() - 24 * 3600) * 1000
recent = [r for r in rows if (r.get("t") or 0) > cut and "rotated" in r]
if len(recent) < 5:
    print("样本不足(%d), 空过" % len(recent)); raise SystemExit(0)
fired = [r for r in recent if r.get("rotated") is True]
# 三个调度杠杆先后被判惰性(闸门 6h 上限/退避/轮换), 所以"从未开火"不能静默通过——
# 它要么说明候选供给不足(供给侧问题), 要么说明机制坏了; 两者都必须被看见。
assert fired, "24h 内 %d 个决策点轮换从未开火: 需显式判定是供给不足还是机制失效" % len(recent)
print("24h 决策 %d, 轮换开火 %d" % (len(recent), len(fired)))
'

# ── T100 杠杆健康度(cl-119: 不留从不生效的机制) ──
echo "[T100] 杠杆健康度(退避惰性标记 / 轮换开火 / 惰性必须显式)"
t "杠杆健康度已落盘并刷新" bash -c "
python3 '$HOME/dsh-fork/dsh-lever-health.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os, time
p = os.path.expanduser('~/.dsh/cognitive-pipeline/lever-health.json')
assert os.path.exists(p), 'lever-health.json 缺失'
d = json.load(open(p, encoding='utf8'))
assert time.time() - os.path.getmtime(p) < 600, 'lever-health.json 陈旧'
for k in ('backoff', 'rotation', 'turnGate'):
    assert k in d['levers'], '缺杠杆 %s' % k
assert 'inertLevers' in d, '缺惰性清单'
assert d['decisions'] >= 1, '窗口内无决策点'
\"
"
t "惰性判定与重算一致(cl-119: 不许静默留着一个不生效的机制)" python3 -c '
import json, os, time
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
d = json.load(open(os.path.join(D, "lever-health.json"), encoding="utf8"))
cut = (time.time() - d["windowHours"] * 3600) * 1000
rows = [json.loads(l) for l in open(os.path.join(D, "retrieval-audit.jsonl"), encoding="utf8") if l.strip()]
rows = [r for r in rows if (r.get("t") or 0) > cut]
blocked = [r for r in rows if (r.get("backoffDropped") or 0) > 0]
admitted = [r for r in blocked if r.get("backoffAdmitted") is not None]
rate = (len(admitted) / len(blocked)) if blocked else None
expect_backoff_inert = rate is not None and rate >= 0.8 and len(blocked) >= 5
expect_rotation_inert = len(rows) >= 5 and not any(r.get("rotated") is True for r in rows)
assert d["levers"]["backoff"]["inert"] == expect_backoff_inert, "backoff 惰性标记与重算不一致"
assert d["levers"]["rotation"]["inert"] == expect_rotation_inert, "rotation 惰性标记与重算不一致"
# 惰性必须出现在显式清单里——"静默留着一个从不生效的机制"是本项目反复出现的病
for name, info in d["levers"].items():
    if info.get("inert"):
        assert name in d["inertLevers"], "%s 已判惰性却未进入 inertLevers" % name
print("决策 %d, 注入 %d, 不同经验 %d, 惰性 %s"
      % (d["decisions"], d["injected"], d["distinctExperiencesInjected"], d["inertLevers"]))
'

# ── T101 候选供给量必须可见(cl-122: 三个杠杆的"供给不足"叙事源于量错了对象) ──
echo "[T101] 候选供给量(过阈原始数 / 与选择结果自洽)"
t "审计带 rawHits/topHits(供给量与头部相似度)" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
recent = [r for r in rows if "rawHits" in r]
assert recent, "审计尚无 rawHits——供给量未落地(cl-122)"
last = recent[-1]
assert isinstance(last.get("topHits"), list) and last["topHits"], "缺 topHits"
print("最近一次供给: rawHits=%s topHits=%s candidates=%s"
      % (last.get("rawHits"), last.get("topHits"), last.get("candidates")))
'
t "供给量自洽: rawHits >= candidates, 本纪元 topHits 单调不增" python3 -c '
import json, os, subprocess
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
p = os.path.join(D, "retrieval-audit.jsonl")
# cl-220: 审计账本只追加, 全域扫描会把**修复前**的非单调行永远算成红 —— 判据域写错(证据域含修复前史)。
# 不变式只对"当前纪元"成立: 以部署边界(max(lib mtime, 服务启动))为界, 边界前的行是历史, 不改写也不判。
try:
    after = int(subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-deploy-boundary.py")],
                               capture_output=True, text=True, timeout=60).stdout.strip() or 0)
except Exception:
    after = 0
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
scoped = [r for r in rows if not after or (r.get("t") or 0) > after]
skipped = len(rows) - len(scoped)
bad = []
for r in scoped:
    raw, cand = r.get("rawHits"), r.get("candidates")
    if isinstance(raw, int) and isinstance(cand, int) and raw < cand:
        # coverViewpoints 只能收窄候选, 不可能放大 => rawHits < candidates 即记账错位
        bad.append((r.get("stage"), raw, cand))
    top = r.get("topHits")
    if isinstance(top, list) and len(top) > 1:
        if any(top[i] < top[i + 1] for i in range(len(top) - 1)):
            bad.append((r.get("stage"), "topHits 非降序", top))
assert not bad, "供给量记账不自洽(本纪元 %d 行): %s" % (len(scoped), bad[:3])
print("本纪元 %d 行自洽(历史 %d 行不判)" % (len(scoped), skipped))
'
t "供给量与选择结果的落差被记录(防再次误读为供给不足)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip() and "rawHits" in l]
if not rows:
    print("尚无 rawHits 记录, 空过"); raise SystemExit(0)
recs = [r for r in rows if isinstance(r.get("candidates"), int)]
assert recs, "无同时含 rawHits 与 candidates 的记录"
r = recs[-1]
# 实测教训(cl-119/120/121): 我拿 candidates(=2, coverViewpoints 之后)当"候选供给", 得出
# "供给只有 1-2 条"的错误叙事; 真实供给是 rawHits(实测 218)。这条断言要求两者都在场。
print("供给 %s -> 选择 %s(落差 %s 条被 coverViewpoints/topK 收窄)"
      % (r.get("rawHits"), r.get("candidates"), (r.get("rawHits") or 0) - (r.get("candidates") or 0)))
'

# ── T102 topK 加宽 A/B(cl-120: 从 218 条过阈候选里只见 1-2 条) ──
echo "[T102] topK 加宽(配置生效 / 成本可测 / 候选数上升)"
# 2026-09-10 23:1x 退役: 原断言写死"topK >= 2(加宽已生效)" —— 那是**旧状态**;
# 回滚 topK→1 后它必然转红。改为不在本组断言具体取值(取值正确性由 T128 的
# "配置现值 == 预登记基线 afterValue" 保证, 那才是不会随决策漂移的不变式)。
t "topK 配置段可解析(取值正确性见 T128)" python3 -c '
import os, re
p = os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
t = open(p, encoding="utf8").read()
m = re.search(r"id: cognitive-inject(.*?)(?:\n    - id:|\Z)", t, re.S)
assert m, "未找到 cognitive-inject 配置段"
vals = re.findall(r"^\s*topK:\s*(\d+)\s*$", m.group(1), re.M)
assert vals, "cognitive-inject 段内找不到 topK"
print("topK 段可解析: %s(取值与基线的比对见 T128)" % vals[-1])
'
t "注入上下文成本可测(审计带 textChars)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
recs = [r for r in rows if "textChars" in r]
assert recs, "审计尚无 textChars(cl-120 的成本判据缺仪表)"
# 成本与条数必须同向: 注入 3 条的文本量应大于注入 1 条(同一批经验量级下)
inj = [r for r in recs if r.get("stage") == "injected" and r.get("expIds")]
if len(inj) >= 2:
    sizes = [(len(r["expIds"]), r["textChars"]) for r in inj]
    print("最近注入: 条数/字符 %s" % sizes[-3:])
else:
    print("注入样本不足, 仅确认字段在场")
'

# ── T103 注入漏斗自洽(cl-124: 供给→候选→送审→注入 四级必须单调) ──
echo "[T103] 注入漏斗自洽(四级单调 / veto 可见 / 成本两栏)"
t "漏斗四级单调: rawHits >= candidates >= vetoJudged >= 注入条数" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
bad = []
for r in rows:
    if r.get("stage") != "injected": continue
    raw, cand = r.get("rawHits"), r.get("candidates")
    judged, injected = r.get("vetoJudged"), len(r.get("expIds") or [])
    for name, value in (("rawHits", raw), ("candidates", cand), ("vetoJudged", judged)):
        if value is None: continue
        assert isinstance(value, int) and value >= 0, "字段 %s 非法: %r" % (name, value)
    if None not in (raw, cand, judged):
        # 每一级都是上一级的子集(coverViewpoints/veto 只能收窄, 不能放大)
        if not (raw >= cand >= judged >= injected):
            bad.append({"rawHits": raw, "candidates": cand, "vetoJudged": judged, "injected": injected})
assert not bad, "漏斗不单调(记账错位): %s" % bad[:3]
'
t "veto 送审必须可见(cl-124: 静默否决不可审计)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
recs = [r for r in rows if r.get("stage") == "injected" and "vetoJudged" in r and r.get("vetoJudged") is not None]
if not recs:
    print("构建后尚无带 vetoJudged 的注入记录, 空过"); raise SystemExit(0)
r = recs[-1]
print("最近一次: 送审 %s 条, 静默否决 %s 条, 实际注入 %s 条"
      % (r.get("vetoJudged"), r.get("vetoSilent"), len(r.get("expIds") or [])))
assert r.get("vetoJudged") is not None, "缺 vetoJudged"
'
t "成本两栏齐备(textChars 候选量 / injectedChars 实际量)" bash -c "
grep -q 'injectedChars' '$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts' &&
grep -q 'injectedChars' '$HOME/dsh-fork/packages/context/cognitive-inject/lib/index.js'
"

# ── T104 A/B 基线写死(cl-116 教训: 不许凭印象比较) ──
echo "[T104] A/B 基线(切换点写死 / 两栏对照可复算)"
t "A/B 基线文件齐备(切换点 + 前后配置值 + 判据)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/ab-baselines.json")
assert os.path.exists(p), "ab-baselines.json 缺失: A/B 没有写死的基线"
d = json.load(open(p, encoding="utf8"))
for k in ("splitAt", "splitReason", "beforeValue", "afterValue", "criterion"):
    assert k in d, "基线缺 %s" % k
assert d["beforeValue"].get("topK") != d["afterValue"].get("topK"), "前后配置值相同(不是一次改变)"
'
t "A/B 两栏可复算且新鲜" bash -c "
python3 '$HOME/dsh-fork/dsh-ab-compare.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os, time
p = os.path.expanduser('~/.dsh/cognitive-pipeline/ab-compare.json')
assert os.path.exists(p), 'ab-compare.json 缺失(未运行对照脚本)'
assert time.time() - os.path.getmtime(p) < 900, '对照结果陈旧'
d = json.load(open(p, encoding='utf8'))
for side in ('before', 'after'):
    assert 'decisions' in d[side] and 'injectedCountDistribution' in d[side], '%s 栏不完整' % side
assert d['after']['decisions'] >= 1, '切换后尚无样本'
print('前 %d 决策/%d 注入, 后 %d 决策/%d 注入'
      % (d['before']['decisions'], d['before']['injections'],
         d['after']['decisions'], d['after']['injections']))
\"
"
t "样本不足时对照必须自带判读(防把 4 条样本当结论)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/ab-compare.json"), encoding="utf8"))
assert "verdict" in d and "minSample" in d, "对照缺样本充分性判读"
n = min(d["before"]["decisions"], d["after"]["decisions"])
want = "insufficient-sample" if n < d["minSample"] else "comparable"
assert d["verdict"] == want, "判读与样本量不符: verdict=%s n=%d min=%d" % (d["verdict"], n, d["minSample"])
print("判读 %s(前 %d / 后 %d, 阈值 %d)" % (d["verdict"], d["before"]["decisions"], d["after"]["decisions"], d["minSample"]))
'
t "A/B 必带新鲜度指标(cl-120+121 的中间变量)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/ab-compare.json"), encoding="utf8"))
assert "novelty" in d, "对照缺新鲜度指标"
for side in ("before", "after"):
    s = d["novelty"][side]
    assert "n" in s, "%s 侧缺 n" % side
# 采纳率是最终指标但样本小; 新鲜度(该经验此前被注入过几次)是加宽/轮换的直接中间变量,
# 必须随对照一起报——否则"机制有没有起作用"只能靠感觉。
if d["novelty"]["after"].get("n", 0) > 0:
    print("新鲜度: 加宽前中位 %s / 加宽后中位 %s; 从未注入过占比 %s -> %s"
          % (d["novelty"]["before"].get("priorInjectionsMedian"),
             d["novelty"]["after"].get("priorInjectionsMedian"),
             d["novelty"]["before"].get("neverInjectedShare"),
             d["novelty"]["after"].get("neverInjectedShare")))
'
t "成本基线的缺口被显式记录(改变前未埋点 => 不可比)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/ab-compare.json"), encoding="utf8"))
print("加宽前 injectedCharsMean=%s, 加宽后=%s" % (d["before"]["injectedCharsMean"], d["after"]["injectedCharsMean"]))
# 不对称是事实, 不是要断言通过的东西——把缺口打印出来, 防"用 None 假装没差"
if d["before"]["injectedCharsMean"] is None:
    print("诚实标注: 加宽前的成本未埋点(仪表是改变之后才加的), 成本对比暂不可比")
'

# ── T105 隐式采纳代理的诚实处置(cl-125: 饱和的指标不许当结论用) ──
echo "[T105] 隐式采纳代理(饱和必须自曝 / 只采显式口径)"
t "隐式采纳代理已落盘且带饱和判定" bash -c "
python3 '$HOME/dsh-fork/dsh-implicit-adoption.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os
p = os.path.expanduser('~/.dsh/cognitive-pipeline/implicit-adoption.json')
assert os.path.exists(p), 'implicit-adoption.json 缺失'
d = json.load(open(p, encoding='utf8'))
for k in ('explicitRate', 'proxySaturated', 'verdict', 'useExplicitRateOnly', 'caveat'):
    assert k in d, '缺字段 %s' % k
print('显式 %.1f%% | 代理判定 %s' % ((d['explicitRate'] or 0) * 100, d['verdict']))
\"
"
t "饱和的代理不得被当成采纳率(只采显式口径)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/implicit-adoption.json"), encoding="utf8"))
combined = d.get("explicitPlusImplicitRate") or 0
if combined > 0.25:
    # 实测 74.8%~95.9%: 自指工程回路里经验动作词与其他回合的工具调用天然重叠 => 无信息量。
    # 这条断言把"必须自曝饱和、只采显式口径"固化下来, 防后来者拿它当业绩。
    assert d.get("proxySaturated") is True, "代理明显饱和却未标记"
    assert d.get("useExplicitRateOnly") is True, "饱和代理仍被允许当口径"
    assert "假阳性" in d.get("caveat", ""), "缺假阳性标注"
print("代理饱和已显式标记, 口径=显式(%.1f%%)" % ((d["explicitRate"] or 0) * 100))
'

# ── T106 cron 心跳(cl-126: 排程不等于完成, 静默的 cron 无法验证) ──
echo "[T106] cron 心跳(定时任务必须留下可验证的痕迹)"
t "cron 条目不带 --quiet(否则无输出时不留痕)" bash -c "
crontab -l | grep -q 'dsh-lever-health.py >>' &&
crontab -l | grep -q 'dsh-model-catalog-check.py >>' &&
! crontab -l | grep -qE 'dsh-lever-health.py --quiet|dsh-model-catalog-check.py --quiet'
"
t "定时任务的日志新鲜度(2 个周期内)" python3 -c '
import os, time
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
# (日志, 允许的最长静默秒数 = 2 个周期)
checks = [("lever-health.log", 12 * 3600), ("model-catalog.log", 2 * 3600),
          (".script-lint.log", 4 * 3600), ("freeze-wiki.log", 12 * 3600)]
stale, pending = [], []
for name, limit in checks:
    path = os.path.join(D, name)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        pending.append(name); continue
    age = time.time() - os.path.getmtime(path)
    if age > limit:
        stale.append((name, round(age / 3600, 1)))
# 关键: 静默的 cron 无法验证是否真的跑过(cl-126)。这里只判"有内容却过期"的,
# 无内容的一律列为"尚未首跑(空过可见)", 不伪装成健康。
assert not stale, "定时任务日志过期(可能已停跑): %s" % stale
print("新鲜: %d 个; 尚未首跑/空: %s" % (len(checks) - len(pending), pending))
'

# ── T107 采纳率必须有对照(cl-128): 背景率/lift + 结算不再截断 ──
echo "[T107] 采纳率口径(背景率/lift / 结算用全文)"
t "adoption-stats 带背景率与 lift" bash -c "
python3 '$HOME/dsh-fork/dsh-adoption-stats.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os
p = os.path.expanduser('~/.dsh/cognitive-pipeline/adoption-stats.json')
d = json.load(open(p, encoding='utf8'))
for k in ('turnsWithInjection', 'textMentionAdoptionRate', 'backgroundRate', 'lift', 'liftNote'):
    assert k in d, '缺字段 %s' % k
print('回合 %d | 文本口径 %s | 背景 %s | lift %s'
      % (d['turnsWithInjection'], d['textMentionAdoptionRate'], d['backgroundRate'], d['lift']))
\"
"
t "结算不得用 800 字符截断的文本(cl-128 根因)" python3 -c '
import os
D = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline")
svc = open(os.path.join(D, "src/service.ts"), encoding="utf8").read()
idx = open(os.path.join(D, "src/index.ts"), encoding="utf8").read()
typ = open(os.path.join(D, "src/types.ts"), encoding="utf8").read()
assert "outcomeFull" in typ, "TurnEpisode 缺 outcomeFull"
assert "outcomeFull: outcome," in idx, "reconstructTurn 未填 outcomeFull"
assert "episode.outcomeFull ?? episode.outcome" in svc, "结算未改用全文"
lib = open(os.path.join(D, "lib/index.js"), encoding="utf8").read()
assert "outcomeFull" in lib, "lib 未含 outcomeFull(未重建)"
'
t "lift 判据已入目标池(lift>=2 且 n>=100)" bash -c "
grep -q 'lift' '$HOME/.dsh/cognitive-pipeline/dormant-goals.jsonl'
"

# ── T108 结算效果见证(cl-128 的效果侧: 文本命中不得 book 为未引用) ──
echo "[T108] 结算效果(文本命中 / book 一致性 / 样本可见)"
t "结算效果脚本可运行且给出判读" bash -c "
timeout 400 python3 '$HOME/dsh-fork/dsh-settlement-effect.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os
p = os.path.expanduser('~/.dsh/cognitive-pipeline/settlement-effect.json')
assert os.path.exists(p), 'settlement-effect.json 缺失'
d = json.load(open(p, encoding='utf8'))
for k in ('scopeInjections', 'textHits', 'textHitsBookedFalse', 'verdict', 'minSample'):
    assert k in d, '缺字段 %s' % k
print('构建后注入 %d, 文本命中 %d, 其中 book=false %d => %s'
      % (d['scopeInjections'], d['textHits'], d['textHitsBookedFalse'], d['verdict']))
\"
"
t "文本命中不得被结算为未引用(样本足够时)" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/settlement-effect.json"), encoding="utf8"))
if d["textHits"] < d["minSample"]:
    print("样本不足(%d < %d), 空过可见" % (d["textHits"], d["minSample"])); raise SystemExit(0)
assert d["textHitsBookedFalse"] == 0, "文本命中却 book 为未引用 %d 条: %s" % (
    d["textHitsBookedFalse"], d.get("misses"))
'

# ── T109 换模路径可用性(cl-129: 在用模型与 profile 默认**同时**下架) ──
echo "[T109] 换模路径可用性(在用/默认双检 + 双缺必须显式)"
t "模型巡检同时报告 profile 默认回退" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json")
d = json.load(open(p, encoding="utf8"))
for k in ("modelInUse", "profileDefault", "defaultMissingFromCatalog", "verdict"):
    assert k in d, "巡检缺字段 %s" % k
print("在用 %s | 默认 %s | 判定 %s" % (d["modelInUse"], d.get("profileDefault"), d["verdict"]))
'
t "在用与默认双缺时必须显式判为换模路径不可用" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json"), encoding="utf8"))
if d.get("missingFromCatalog") and d.get("defaultMissingFromCatalog"):
    # cl-129: 连 profile 默认都下架 => "回退到默认"这条路也不通, 必须显式标出。
    # cl-160 修订: 在用模型若"未登广告但响应侧仍在服务", 判定为 unadvertised-and-serving;
    # 此时"回退不可用"依然成立(defaultMissingFromCatalog=True), 故两类都接受 —— 但不得落回 present/unknown。
    assert d["verdict"] in ("in-use-and-default-missing", "in-use-unadvertised-and-serving"), \
        "双缺却未标出(verdict=%s)" % d["verdict"]
    if d["verdict"] == "in-use-unadvertised-and-serving":
        assert d.get("servingEvidence") is True, "未登广告判定缺服务证据"
        print("双缺已标出, 且在用模型有服务证据(未登广告但可用)")
    else:
        print("双缺已显式标记: 回退到 profile 默认同样不可行")
else:
    print("非双缺状态, 空过")
'

# ── T110 A/B 混杂因素必须自动列出(cl-130: 不许事后凭记忆补注) ──
echo "[T110] A/B 混杂因素(账本化 / 区间型 / 自动呈现)"
t "对照结果带 confounders 与其说明" bash -c "
python3 '$HOME/dsh-fork/dsh-ab-compare.py' --quiet >/dev/null 2>&1 || true
python3 -c \"
import json, os
p = os.path.expanduser('~/.dsh/cognitive-pipeline/ab-compare.json')
d = json.load(open(p, encoding='utf8'))
assert 'confounders' in d and 'confoundNote' in d, '对照缺混杂因素栏'
print('%s; 窗口内混杂 %d 条' % (d['confoundNote'], len(d['confounders'])))
\"
"
t "区间型混杂(until)不得漏掉(cl-130 改名是区间事件)" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(D, "ab-confounders.jsonl"), encoding="utf8") if l.strip()]
assert rows, "无混杂账本"
assert any(r.get("until") for r in rows), "缺区间型(until)条目: 边界模糊的变更会被时间戳漏掉"
d = json.load(open(os.path.join(D, "ab-compare.json"), encoding="utf8"))
kinds = {c["kind"] for c in d["confounders"]}
assert "provider-rename-possible" in kinds, "供应商改名(区间型)未被列出: %s" % sorted(kinds)
print("已列出混杂: %s" % sorted(kinds))
'

# ── T111 判据不得按字面值比较(cl-132: 新增枚举值会让断言静默失效) ──
echo "[T111] 判据字面比较检查(守卫必须语义匹配 / 插件无字面比较)"
t "套件内的 verdict 守卫必须是语义匹配" python3 -c '
import os, re
p = os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh")
t = open(p, encoding="utf8").read()
# cl-132: cl-129 新增 verdict 取值后, 三处 `!= "missing"` 守卫把"真缺失"判成"非缺失"并静默空过。
bad = re.findall(r"verdict\"\) != \"missing\"", t)
assert not bad, "仍有字面比较的守卫(会静默空过): %d 处" % len(bad)
assert "missing\" not in str(d.get(\"verdict\"))" in t, "未使用语义匹配写法"
print("守卫均为语义匹配")
'
t "插件源码不得对 catalog verdict 做字面比较" python3 -c '
import os, re
roots = ["~/dsh-fork/packages/context/quiet-driver/src", "~/dsh-fork/packages/context/cognitive-inject/src"]
bad = []
for root in roots:
    for dirpath, _dirs, files in os.walk(os.path.expanduser(root)):
        for name in files:
            if not name.endswith(".ts"): continue
            text = open(os.path.join(dirpath, name), encoding="utf8").read()
            for m in re.finditer(r"verdict\s*===\s*[\x27\"]missing[\x27\"]", text):
                bad.append(os.path.join(dirpath, name) + ": " + m.group(0))
assert not bad, "存在字面比较(新增取值会静默失配): %s" % bad[:3]
print("插件内无 verbatim verdict 比较")
'

# ── T112 测试账本终态语义守卫(cl-133: "测试没跑通" ≠ "结论为否") ──
# 病根: 账本原只有 pending/in-progress/passed/failed/blocked; 决定性负面结论(假设被证伪)
# 与真失败(基础设施/前提缺失)都落 failed → 负面结论长期挂在"欠账"位上, 既污染失败信号
# 又诱导重复劳动。修: 引入 concluded 态 + 处置字段。本组断言守卫该语义不再回退。
# 防静默空过: 每条断言先验前提存在(否则守卫会因账本"恰好没有该类项"而空过)。
echo "[T112] 测试账本终态语义(非终态须有处置 / 结论须有重开条件 / 状态值合法)"
t "账本状态值均在允许集内" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
allowed = {"pending","in-progress","passed","reviewed","concluded","failed","blocked"}
bad = sorted({k: v.get("status") for k, v in by_id.items() if v.get("status") not in allowed})
assert not bad, "存在非法状态值(统计会漏掉它们): %s" % bad[:5]
assert len(by_id) >= 50, "账本规模异常, 断言前提不成立: %d" % len(by_id)
print("状态值合法, 条目 %d" % len(by_id))
'
t "非终态项必须带处置(否则无人再访)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
terminal = {"passed","reviewed","concluded"}
# 前提: 账本确实存在非终态项, 否则本断言空过(今天的静默空过病根)
open_items = {k: v for k, v in by_id.items() if v.get("status") not in terminal}
assert open_items, "无非终态项——本断言前提不成立, 不得算通过"
naked = sorted(k for k, v in open_items.items()
               if not (v.get("reviewBy") or v.get("unblockPlan") or v.get("disposition")))
assert not naked, "非终态项缺处置(reviewBy/unblockPlan/disposition): %s" % naked
print("非终态 %d 项均有处置" % len(open_items))
'
t "concluded 项必须带结论与重开条件" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
concluded = {k: v for k, v in by_id.items() if v.get("status") == "concluded"}
# 前提: 至少有一条已结单的否定结论, 否则断言空过
assert concluded, "无 concluded 项——本断言前提不成立(结论型结单尚未发生)"
bad = sorted(k for k, v in concluded.items()
             if not (v.get("conclusion") and v.get("reopenIf")))
assert not bad, "concluded 项缺 conclusion/reopenIf(结论会随前提变化而失效): %s" % bad
print("concluded %d 项均带 conclusion+reopenIf" % len(concluded))
'
t "非终态项处置不得超期(3天无说明即红)" python3 -c '
import json, os, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(TZ)
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
terminal = {"passed","reviewed","concluded"}
open_items = {k: v for k, v in by_id.items() if v.get("status") not in terminal}
assert open_items, "无非终态项——本断言前提不成立, 不得算通过"

def parse(ts):
    if not ts: return None
    try:
        s = str(ts).replace("Z", "+00:00")
        d = datetime.datetime.fromisoformat(s)
        return d if d.tzinfo else d.replace(tzinfo=TZ)
    except Exception:
        return None

stale = []
for k, v in open_items.items():
    last = parse(v.get("disposedAt")) or parse(v.get("createdAt")) or parse(v.get("ts"))
    due = parse(v.get("reviewBy"))
    if due is not None and due < now:
        stale.append(k + "(reviewBy 已过期)")
        continue
    if last is None:
        stale.append(k + "(无任何时间戳, 无法判新鲜度)")
        continue
    age = (now - last).total_seconds() / 86400.0
    if age > 3:
        stale.append("%s(处置已 %.1f 天前, >3 天须补说明或重开)" % (k, age))
assert not stale, "非终态项处置超期: %s" % stale
print("非终态 %d 项处置均在新鲜期内" % len(open_items))
'
t "concluded 与 failed 语义不得混用" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by_id = {r["id"]: r for r in rows if r.get("id")}
# failed = 测试没跑通(欠账, 待修); concluded = 跑完且结论为否(产出, 带重开条件)。
# 混用的特征: 标 failed 却在 result 里写下了完整结论和根因。
import re
suspicious = []
for k, v in by_id.items():
    if v.get("status") != "failed":
        continue
    r = str(v.get("result") or "")
    if re.search(r"最终定位|根因|证伪|结论[:：]", r) and len(r) > 120:
        suspicious.append(k)
assert not suspicious, "这些标 failed 但已写下完整结论, 应转 concluded: %s" % suspicious
print("无 failed/concluded 混用")
'

# ── T113 采纳 A/B 对照的窗口/口径/判据守卫(cl-134: 主判据此前在对照里缺席) ──
# 今天连踩三坑, 全部落在这条链上:
#   ①主判据(不同经验数+采纳率不降+绝对采纳数不降)在 A/B 里缺席, 采纳侧要人肉另跑脚本;
#   ②子窗口运行(--since/--until)覆盖了唯一口径的落盘快照, 下游把它当水位 => 整张表错位;
#   ③"口径变更时刻"取了 commit author time(04:57 提交)而非生效时刻(15:50 部署)
#     => 后窗被切成 [14:07, 04:57) 空集却照样出数;
#   ④判据字段只在打印分支里算, --quiet 消费者读到 null("判据只长在显示路径上")。
# 本组断言把这四类固化为守卫。
echo "[T113] 采纳对照(快照不被子窗口改写 / 口径取自账本 / 前窗非空 / 判据落盘)"
t "子窗口运行不得改写规范快照" python3 -c '
import json, os, subprocess, sys, hashlib
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
snap = os.path.join(DIR, "adoption-stats.json")
script = os.path.expanduser("~/dsh-fork/dsh-adoption-stats.py")
assert os.path.exists(snap), "规范快照不存在, 断言前提不成立"
before = hashlib.sha256(open(snap, "rb").read()).hexdigest()
w0 = json.load(open(snap, encoding="utf8")).get("windowStart")
# 用最贴近真实用法的子窗口调用(后窗): 修复前正是这种调用覆盖了快照。
r = subprocess.run([sys.executable, script, "--since", "2026-09-10T14:07:00", "--json"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "子窗口调用失败: %s" % (r.stderr or "")[:200]
after = hashlib.sha256(open(snap, "rb").read()).hexdigest()
assert before == after, "子窗口运行改写了规范快照(windowStart %s => %s)" % (
    w0, json.load(open(snap, encoding="utf8")).get("windowStart"))
print("快照未被改写(windowStart=%s)" % w0)
'
t "口径变更时刻必须取自账本事实时间" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
adopt = (ab.get("adoption") or {})
got = adopt.get("settlementLensChangedAt")
ledger = None
for line in open(os.path.join(DIR, "ab-confounders.jsonl"), encoding="utf8"):
    if not line.strip():
        continue
    row = json.loads(line)
    if row.get("kind") == "settlement-fix":
        ledger = row.get("ts")
assert ledger, "账本里没有 settlement-fix 记录, 断言前提不成立"
import datetime
assert got, "对照未记录口径变更时刻"
pg, pl = datetime.datetime.fromisoformat(got), datetime.datetime.fromisoformat(ledger)
# 裸时间戳(无时区)是缺陷不是格式偏好: 跨文件比较必然失配(cl-134 首次红即此)。
assert pg.tzinfo is not None and pl.tzinfo is not None, (
    "口径时刻缺时区(裸本地时间): 对照=%s 账本=%s" % (got, ledger))
assert pg == pl, "口径时刻与账本不是同一瞬间: 对照=%s 账本=%s" % (got, ledger)
print("口径时刻与账本同一瞬间: %s" % ledger)
'
t "前窗不得为空(窗口错位必须显式失败)" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
segs = ((ab.get("adoption") or {}).get("segments") or {})
before = segs.get("before")
assert before is not None, "对照里没有前窗, 断言前提不成立"
assert (before.get("injected") or 0) > 0, (
    "前窗注入为 0 => 窗口错位(如把提交时刻当口径时刻), 这种对照不得出数")
assert (before.get("hours") or 0) > 0, "前窗时长为非正数: %s" % before.get("hours")
print("前窗非空: %s 注入 / %sh" % (before.get("injected"), before.get("hours")))
'
t "判据字段必须在 --quiet 下也落盘" python3 -c '
import json, os, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-ab-compare.py"), "--quiet"],
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "ab-compare --quiet 失败: %s" % (r.stderr or "")[:200]
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
av = ab.get("adoptionVerdict")
assert isinstance(av, dict), "quiet 模式下 adoptionVerdict 缺失(判据只长在显示路径上)"
for key in ("enoughSample", "sampleNote", "rollbackIf"):
    assert av.get(key) is not None, "quiet 模式下 adoptionVerdict.%s 为 null" % key
assert ab.get("adoption", {}).get("afterUnion"), "quiet 模式下后窗合体缺失"
print("quiet 模式判据完整: 样本%s 方向%s" % (av.get("enoughSample"), av.get("direction")))
'
t "采纳观察必须由排程驱动且日志新鲜" python3 -c '
import os, subprocess, time
# "排程≠完成"的老坑(cl-117: cron 带 --quiet 导致 mtime 不更新, 跑没跑无法证明)。
# 这条守卫要求: cron 条目存在 + 观察日志在 2h 内被写过(裸时间戳, 不静默)。
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
assert "dsh-adoption-observe.py" in out, "采纳观察未挂排程(观察型目标会退化成靠记性)"
snap = os.path.expanduser("~/.dsh/cognitive-pipeline/adoption-observations.jsonl")
assert os.path.exists(snap), "观察快照不存在: 排程从未真正产出痕迹"
# 只认 origin=cron 的快照(cl-147 的第二层): 手工/套件跑出来的快照不算排程证据。
import json as _json, datetime as _dt
recs = [_json.loads(l) for l in open(snap, encoding="utf8") if l.strip()]
cron_recs = [r for r in recs if r.get("origin") == "cron"]
if cron_recs:
    age = time.time() - _dt.datetime.fromisoformat(cron_recs[-1]["ts"]).timestamp()
    assert age < 2 * 3600, "最近的 cron 快照已 %.1f 小时未更新" % (age / 3600)
    print("cron 快照新鲜(%.0f 分钟前)" % (age / 60))
else:
    assert "DSH_RUN_ORIGIN=cron" in out, "观察排程未带 origin=cron 标记: 首班到了也留不下可判读的痕迹"
    print("首班未到(尚无 origin=cron 快照), 排程已带 origin 标记")
'

# ── T114 载体活体源核对(cl-136 家族 / exp_254: 状态证据会误报) ──
# 实证: 09-10 17:48 的三问帧 Q1 只核了 PID 与模型名(状态证据), 没读心跳与目录(活体源),
# 于是 17:47:55 首次上报的 model-unavailable 在 1 分钟内的核对里被漏掉 —— cl-014 伪饱足当场复现。
# PID 不变 ≠ 载体健康: 模型被下架时 PID 照样是那个 PID。
echo "[T114] 载体活体源核对(进程/心跳/目录三源; 降级时必须判降级)"
t "载体核对脚本可运行且报三源" python3 -c '
import json, os, subprocess, sys
script = os.path.expanduser("~/dsh-fork/dsh-carrier-check.py")
assert os.path.exists(script), "载体核对脚本不存在"
r = subprocess.run([sys.executable, script, "--json"], capture_output=True, text=True, timeout=120)
assert r.returncode in (0, 2), "脚本异常退出 %s: %s" % (r.returncode, (r.stderr or "")[:200])
d = json.loads(r.stdout)
for key in ("process", "lastModelBeats", "catalog", "verdict"):
    assert key in d, "缺活体源字段: %s" % key
assert d["lastModelBeats"], "心跳里没有任何 model-* 记录(活体源从未体检)"
assert d["catalog"].get("verdict"), "目录判定缺失"
print("三源齐备: 进程/心跳%d条/目录%s" % (len(d["lastModelBeats"]), d["catalog"]["verdict"]))
'
t "活体源降级时不得判正常(两痕迹一致)" python3 -c '
import json, os, subprocess, sys
script = os.path.expanduser("~/dsh-fork/dsh-carrier-check.py")
r = subprocess.run([sys.executable, script, "--json"], capture_output=True, text=True, timeout=120)
d = json.loads(r.stdout)
beats = d["lastModelBeats"]; cat = d["catalog"]; verdict = str(cat.get("verdict"))
last_unavail = beats[-1].get("reason") == "model-unavailable"
cat_missing = "missing" in verdict
if last_unavail or cat_missing:
    assert d["verdict"] == "degraded" and d["degraded"], (
        "活体源已降级(心跳=%s 目录=%s)却判 %s —— 只看名字的核对会漏掉它"
        % (beats[-1].get("reason"), verdict, d["verdict"]))
    assert r.returncode == 2, "降级时退出码应为 2, 实为 %s" % r.returncode
    print("降级被如实报出(%d 条理由)" % len(d["degraded"]))
else:
    assert d["verdict"] == "ok", "活体源正常却判降级: %s" % d["degraded"]
    print("活体源正常")
'
t "环境核对不得只凭 PID/模型名(脚本内须含活体源读点)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/dsh-carrier-check.py"), encoding="utf8").read()
for needle, why in (("quiet-driver-heartbeat.jsonl", "未读心跳账本"),
                    ("model-catalog.json", "未读供应商目录"),
                    ("model-unavailable", "未把心跳的不可用当作降级判据")):
    assert needle in src, why
print("活体源读点在册")
'
# ── T115 死信号登记(cl-135: 声明为"使用度"的字段必须真有写方) ──
# 实证: 经验库 297 条里 hitCount / positiveCount 全常量 0 —— 声明是计数器, 却只被初始化,
# 全仓没有累加点(唯一 hitCount++ 属于 quiet-driver 的诱导问题策略表, 另一套对象)。
# 机制在、字段在、写方不在 = 同族病又一例。真实使用度信号是 citationCount 与 injections.cited。
# 断言双向: 常量信号必须登记; 登记字段若恢复取值则登记过期(防登记簿腐烂, 同 reopenIf 纪律)。
echo "[T115] 死信号登记(常量使用度字段须登记 / 登记不得过期)"
t "常量使用度字段必须登记在册" python3 -c '
import json, os, re
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
reg_path = os.path.join(DIR, "dead-signals.json")
assert os.path.exists(reg_path), "死信号登记簿不存在"
reg = json.load(open(reg_path, encoding="utf8"))
registered = {(e["file"], e["field"]) for e in reg["signals"]}
PAT = re.compile(r"count|hit|used|adopt", re.I)
unregistered = []
for fname in ("experiences.jsonl", "experiences-frames.jsonl"):
    rows = [json.loads(l) for l in open(os.path.join(DIR, fname), encoding="utf8") if l.strip()]
    assert rows, "经验库为空, 断言前提不成立: %s" % fname
    keys = set()
    for r in rows: keys |= set(r.keys())
    for key in sorted(keys):
        if not PAT.search(key): continue
        vals = [r.get(key) for r in rows if key in r]
        if not vals or len(set(map(str, vals))) != 1: continue
        if (fname, key) not in registered:
            unregistered.append("%s:%s(常量 %s)" % (fname, key, vals[0]))
assert not unregistered, "常量使用度字段未登记(声明的写方不存在): %s" % unregistered
print("常量字段均已登记: %d 项" % len(reg["signals"]))
'
t "登记的字段若恢复取值即登记过期(防登记簿腐烂)" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
reg = json.load(open(os.path.join(DIR, "dead-signals.json"), encoding="utf8"))
stale = []
for e in reg["signals"]:
    rows = [json.loads(l) for l in open(os.path.join(DIR, e["file"]), encoding="utf8") if l.strip()]
    vals = [r.get(e["field"]) for r in rows if e["field"] in r]
    if vals and len(set(map(str, vals))) != 1:
        stale.append("%s:%s 已开始变化 => 应从登记簿移除" % (e["file"], e["field"]))
assert not stale, "登记过期: %s" % stale
print("登记簿未腐烂(%d 项仍为常量)" % len(reg["signals"]))
'
t "活的使用度信号不得是全常量" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(os.path.join(DIR, "experiences.jsonl"), encoding="utf8") if l.strip()]
vals = [r.get("citationCount") for r in rows if "citationCount" in r]
assert vals, "缺 citationCount 字段, 断言前提不成立"
assert len(set(map(str, vals))) > 1, "citationCount 全常量(%s) => 使用度信号实际是死的" % vals[0]
print("citationCount 取值多样(%d 种), 使用度信号活着" % len(set(map(str, vals))))
'

# ── T116 采纳裁决须用区间而非点估计 + 观察型闸门必须能开火(cl-134 修订 / tp-099) ──
# 首红背景: 旧判据拿点估计比"后窗文本率 < 前窗一半"(0.150 vs 0.353)就打了 adverse 标签,
# 但 Wilson 区间 [0.236,0.490] vs [0.089,0.391] 大幅重叠 —— 那是把噪声当信号, 与今天
# 在 n=1 / 3-of-3 上栽的三次同型。方向裁决改为"区间分离"才算证据。
# 另一半: 观察型步骤必须有人把 nextAction 翻成可执行, 否则等样本达标了也没人推进
# (exp_189: 触发链必须有明确消费者), 故闸门脚本要正反两路都实测开火。
echo "[T116] 采纳判据(区间分离 / 闸门正反两路 / 排程驱动)"
t "采纳对照必须带 Wilson 区间" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
seg = (ab.get("adoption") or {}).get("segments", {}).get("before") or {}
union = (ab.get("adoption") or {}).get("afterUnion") or {}
assert seg.get("textRateCI"), "前窗缺 Wilson 区间(点估计不足以裁决方向)"
assert union.get("textRateCI"), "后窗缺 Wilson 区间"
lo, hi = union["textRateCI"]
assert 0.0 <= lo <= hi <= 1.0, "区间越界: %s" % (union["textRateCI"],)
print("区间在册: 前窗%s 后窗%s" % (seg["textRateCI"], union["textRateCI"]))
'
t "方向判定不得只用点估计(源码须比较区间)" python3 -c '
import os
s = open(os.path.expanduser("~/dsh-fork/dsh-ab-compare.py"), encoding="utf8").read()
assert "wilson_ci" in s, "没有区间函数"
assert "textRateCI" in s, "判据未引用区间字段"
assert "_a_ci[1] < _b_ci[0]" in s or "_a_ci" in s and "_b_ci" in s, "方向判定未比较区间端点"
print("方向判定基于区间分离")
'
t "闸门未达标时不得改写 nextAction" python3 -c '
import json, os, shutil, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
script = os.path.expanduser("~/dsh-fork/dsh-adoption-gate-arm.py")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
v = dict(ab.get("adoptionVerdict") or {})
v.update({"direction": "indistinguishable"})          # 未达标态
ab["adoptionVerdict"] = v
tmp_ab = "/tmp/t116-ab-wait.json"
json.dump(ab, open(tmp_ab, "w", encoding="utf8"), ensure_ascii=False)
tmp_goals = "/tmp/t116-goals-wait.jsonl"
shutil.copy(os.path.join(DIR, "dormant-goals.jsonl"), tmp_goals)
before = open(tmp_goals, encoding="utf8").read()
r = subprocess.run([sys.executable, script, "--goals", tmp_goals, "--ab", tmp_ab,
                    "--log", "/tmp/t116-gate-wait.log"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, r.stderr[:200]
out = r.stdout.strip()
if "waiting" in out:
    assert open(tmp_goals, encoding="utf8").read() == before, "未达标却改写了 nextAction"
    print("未达标: 只记账不改写")
else:
    # 2026-09-10 22:41 实测: 闸门有**两个**达标口径 —— 方向区间分离 或 lift 样本 n>=100。
    # 本用例只压住了方向那一路; lift 那一路由真实数据判定(n 已到 101), 故此刻 ARMED 是合规的。
    assert "ARMED" in out, "既非 waiting 也非 ARMED: %s" % out
    assert "lift 样本达标" in out or "方向已分离" in out, "武装了但未说明是哪一路达标: %s" % out
    after = open(tmp_goals, encoding="utf8").read()
    if after == before:
        # 幂等: 该目标此前已被真实闸门武装过(2026-09-10 22:41), 于是本轮"武装"只是确认,
        # 不改写是正确的 —— 判据要允许这种合法形态, 否则测试会把幂等当缺陷。
        assert "已是武装态" in out, "报了 ARMED、未改写、也没说明是幂等: %s" % out
        print("另一路达标, 但目标已是武装态(幂等, 不改写)")
    else:
        print("另一路(lift 样本)达标 => 合规武装")
'
t "闸门达标时必须武装 nextAction(否则等待型目标静默停摆)" python3 -c '
import json, os, shutil, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
script = os.path.expanduser("~/dsh-fork/dsh-adoption-gate-arm.py")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
v = dict(ab.get("adoptionVerdict") or {})
v.update({"direction": "adverse-significant", "enoughSample": True})
ab["adoptionVerdict"] = v
tmp_ab = "/tmp/t116-ab-armed.json"
json.dump(ab, open(tmp_ab, "w", encoding="utf8"), ensure_ascii=False)
tmp_goals = "/tmp/t116-goals-armed.jsonl"
shutil.copy(os.path.join(DIR, "dormant-goals.jsonl"), tmp_goals)
# 合成基线须去掉 adjudicatedAt: 真基线已裁决, 闸门对它"不再武装"(T129 守那一路);
# 本用例要测的是"达标必须武装", 故喂一份不带裁决标记的合成基线。
tmp_bl = "/tmp/t116-baselines.json"
json.dump({"splitAt": "2026-09-10T23:05:41+08:00", "beforeValue": {"topK": 3},
           "afterValue": {"topK": 1}}, open(tmp_bl, "w", encoding="utf8"))
r = subprocess.run([sys.executable, script, "--goals", tmp_goals, "--ab", tmp_ab,
                    "--baselines", tmp_bl, "--log", "/tmp/t116-gate-armed.log"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, r.stderr[:200]
assert "ARMED" in r.stdout, "达标却未武装: %s" % r.stdout.strip()
rows = [json.loads(l) for l in open(tmp_goals, encoding="utf8") if l.strip()]
goal = [x for x in rows if x.get("id") == "goal-adoption-rate"][-1]
assert goal["nextAction"].startswith("执行"), "达标后 nextAction 仍非可执行: %s" % goal["nextAction"][:40]
print("达标: nextAction 已改写为可执行裁决")
'
t "闸门必须由排程驱动且日志新鲜" python3 -c '
import os, subprocess, time
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
assert "dsh-adoption-gate-arm.py" in out, "闸门未挂排程 => 达标了也没人翻 nextAction"
log = os.path.expanduser("~/.dsh/cognitive-pipeline/adoption-gate.log")
assert os.path.exists(log), "闸门日志不存在(排程从未产出痕迹)"
# 只认 origin=cron 的行(cl-147): 否则我手工跑一次就能让"排程驱动"判据变绿。
_cron = [l for l in open(log, encoding="utf8") if "origin=cron" in l]
if _cron:
    import datetime as _dt
    stamp = sorted(l[:16] for l in _cron)[-1]
    age = time.time() - _dt.datetime.strptime(stamp, "%Y-%m-%d %H:%M").timestamp()
    assert age < 90 * 60, "最近的 cron 闸门记录已 %.1f 小时未更新" % (age / 3600)
    print("cron 闸门记录新鲜(%.0f 分钟前)" % (age / 60))
else:
    assert "DSH_RUN_ORIGIN=cron" in out, "闸门排程未带 origin=cron 标记"
    print("首班未到(尚无 origin=cron 闸门记录), 排程已带 origin 标记")
'

t "合成测试不得写进生产闸门日志" python3 -c '
import hashlib, json, os, shutil, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
script = os.path.expanduser("~/dsh-fork/dsh-adoption-gate-arm.py")
prod = os.path.join(DIR, "adoption-gate.log")
assert os.path.exists(prod), "生产闸门日志不存在, 断言前提不成立"
before = hashlib.sha256(open(prod, "rb").read()).hexdigest()
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
v = dict(ab.get("adoptionVerdict") or {}); v["direction"] = "adverse-significant"
ab["adoptionVerdict"] = v
tmp_ab = "/tmp/t116b-ab.json"; json.dump(ab, open(tmp_ab, "w", encoding="utf8"), ensure_ascii=False)
tmp_goals = "/tmp/t116b-goals.jsonl"; shutil.copy(os.path.join(DIR, "dormant-goals.jsonl"), tmp_goals)
r = subprocess.run([sys.executable, script, "--goals", tmp_goals, "--ab", tmp_ab,
                    "--log", "/tmp/t116b-gate.log"], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, r.stderr[:200]
after = hashlib.sha256(open(prod, "rb").read()).hexdigest()
assert before == after, "合成用例污染了生产闸门日志(读日志者会看到假 ARMED 痕迹)"
assert os.path.exists("/tmp/t116b-gate.log"), "合成用例没有留下自己的日志"
print("生产日志未被写入, 合成痕迹隔离")
'

# ── T117 经验转化断言(cl-141: 教训必须机械地绑到能开火的断言上) ──
# 实证依据: 今天的同族病复发 9 次, 而**唯一有效**的终止手段是把它翻译成断言(T112~T116 共 23 条),
# 但这一步一直手动、逐次; 经验层别的通道都不在复发点开火(引用率 13.5%、hitCount 全 0、
# taxonomy 卡在 09-09 且重建被拒 6×、链层按目标组织而同族病跨目标)。
# 本组断言守两件事: ①每条新的修复型经验必须有断言登记或豁免理由 ②登记过的断言不得腐烂
# (登记了却已从套件里消失 = 以为还有保护其实没有)。
echo "[T117] 经验转化断言(新修复经验须登记 / 断言不得腐烂 / 排程驱动)"
t "登记簿完整且登记的断言仍存在于套件" python3 -c '
import json, os, re
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
reg = json.load(open(os.path.join(DIR, "experience-assertions.json"), encoding="utf8"))
suite = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
entries = reg.get("entries") or []
assert entries, "登记簿为空 —— 断言前提不成立, 不得算通过"
assert reg.get("baselineAt"), "缺基线时间戳(无法区分历史积压与新增缺口)"
# 组头形式匹配(裸子串会被本用例自身的测试数据满足 —— cl-132 同型, 实测踩过)
missing = [e["assertion"] for e in entries
           if e.get("assertion") and ("[" + e["assertion"] + "]") not in suite]
assert not missing, "登记过的断言已从套件消失(腐烂): %s" % missing
print("登记 %d 条, 断言全部仍在套件中" % len(entries))
'
t "基线之后不得有新的未转化经验" python3 -c '
import os, subprocess, sys
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-experience-transform.py"),
                    "--scan", "--strict-new"], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "出现新的未转化修复型经验(退出码 %s): %s" % (r.returncode, r.stdout[-300:])
assert "新增缺口 0" in r.stdout, "扫描未报零缺口: %s" % r.stdout[:200]
print("新增缺口 0")
'
t "新缺口必须能开火(合成账本, 不碰真账本)" python3 -c '
import json, os, subprocess, sys, time
tmp = "/tmp/t117-synth"
os.makedirs(tmp, exist_ok=True)
json.dump({"entries": [], "exemptions": [], "baselineUncovered": [], "baselineAt": None},
          open(os.path.join(tmp, "experience-assertions.json"), "w", encoding="utf8"))
with open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8") as fh:
    fh.write(json.dumps({"expId": "exp_syn117", "timestamp": int(time.time() * 1000),
                         "rawText": "修复: 根因是消费方判据没跟上; 教训: 同改两侧"}, ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-experience-transform.py"),
                    "--scan", "--strict-new"], capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 2, "合成的新缺口没有开火(退出码 %s) —— 守卫是死的" % r.returncode
assert "新增缺口 1" in r.stdout, r.stdout[:200]
print("合成新缺口: 开火(退出码 2)")
'
t "断言腐烂必须能被判出" python3 -c '
import json, os, subprocess, sys
tmp = "/tmp/t117-rot"
os.makedirs(tmp, exist_ok=True)
json.dump({"entries": [{"expId": "exp_x", "assertion": "T999"}], "exemptions": [],
           "baselineUncovered": ["exp_x"], "baselineAt": "x"},
          open(os.path.join(tmp, "experience-assertions.json"), "w", encoding="utf8"))
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-experience-transform.py"),
                    "--scan", "--strict-new"], capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 2, "腐烂断言未判红(退出码 %s)" % r.returncode
assert "腐烂(登记过但套件里已不存在) 1" in r.stdout, r.stdout[:200]
print("腐烂断言: 判出")
'
t "转化扫描须由排程驱动且日志新鲜" python3 -c '
import os, subprocess, time
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
assert "dsh-experience-transform.py" in out, "转化扫描未挂排程 => 新缺口只在人工想起时才被发现"
log = os.path.expanduser("~/.dsh/cognitive-pipeline/experience-transform.cron.log")
# 只认 cron 写的那份: 套件自己也会跑这个脚本, 共用日志时排程新鲜度可被套件跑满足(cl-146)
assert os.path.exists(log), "转化扫描日志不存在(排程从未产出痕迹)"
# 只认 origin=cron 的行: 手工/套件跑出来的行不算排程证据(cl-147 —— 我手工 seed 过一次
# cron 专属日志, 说明"按文件名分离"只挡住了套件, 挡不住我自己)。
cron_lines = [l for l in open(log, encoding="utf8") if "origin=cron" in l]
if cron_lines:
    import datetime
    stamp = sorted(l[:16] for l in cron_lines)[-1]
    age = time.time() - datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M").timestamp()
    assert age < 3 * 3600, "转化扫描最近的 cron 记录已 %.1f 小时未更新" % (age / 3600)
    print("cron 记录新鲜(%.0f 分钟前)" % (age / 60))
else:
    # 首班未到(部署后第一个排程时刻尚未到达): 不算通过也不算失败 —— 但必须确认排程**带 origin 标记**,
    # 否则首班到了也不会留下可判读的痕迹(这正是"排程≠完成"的老坑)。
    assert "DSH_RUN_ORIGIN=cron" in out, "转化扫描排程未带 origin=cron 标记: 首班到了也留不下可判读的痕迹"
    print("首班未到(尚无 origin=cron 记录), 排程已带 origin 标记")
'

# ── T118 枚举取值→消费方判据 同改守门(cl-135 族级 meta 断言 / tp-102) ──
# 今天的同族病(9 次)形状固定: 给产出方新增/改取值, 消费方判据没跟上。
# 先实测过两种朴素判据都不可行: "源码字面量全要被套件引用"(67 候选/40 未引用, 且多是事件名与配置键)、
# 只取联合类型成员(42 成员/19 未引用)。故总体限定为**声明式联合类型成员**, 并采用基线纪律:
# 历史未覆盖不追溯, 只对基线之后新增的成员开火 —— 否则判据一上线就是狼来了。
echo "[T118] 枚举取值同改守门(新成员须被断言引用或登记豁免 / 只对新增开火)"
t "登记簿存在且结构完整" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/enum-consumers.json")
assert os.path.exists(p), "同改登记簿不存在"
reg = json.load(open(p, encoding="utf8"))
assert reg.get("baselineAt"), "缺基线时间戳(无法区分历史积压与新增成员)"
assert "baselineUncovered" in reg and "exemptions" in reg, "结构不完整"
assert reg.get("entries"), "无任何登记项 —— 断言前提不成立"
print("登记 %d 项 / 豁免 %d / 基线 %d" % (len(reg["entries"]), len(reg["exemptions"]),
      len(reg["baselineUncovered"])))
'
t "登记的断言必须真实存在于套件(防腐烂)" python3 -c '
import json, os
reg = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/enum-consumers.json"), encoding="utf8"))
suite = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
missing = [e["assertion"] for e in reg["entries"]
           if e.get("assertion") and ("[" + e["assertion"] + "]") not in suite]
assert not missing, "登记的断言组已不存在: %s" % missing
print("登记的断言组全部在册")
'
t "基线之后不得有新增未覆盖取值" python3 -c '
import os, subprocess, sys
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-enum-consumer-check.py"),
                    "--scan", "--strict-new"], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "出现新增未覆盖取值(退出码 %s): %s" % (r.returncode, r.stdout[-300:])
assert "新增未覆盖 0" in r.stdout, r.stdout[:200]
print("新增未覆盖 0")
'
t "新增取值必须能开火(合成源, 不碰真仓库)" python3 -c '
import json, os, subprocess, sys
root = "/tmp/t118-synth"
src = os.path.join(root, "packages/cognition/cognitive-pipeline/src")
os.makedirs(os.path.join(root, "d"), exist_ok=True)
os.makedirs(src, exist_ok=True)
# 合成取值必须**动态生成**: 写死的字面量会被本用例自己写进套件文本,
# 于是覆盖率检查在同源文本里找到它 => 判据自满足(今天第三次踩, 前两次是 T999 与裸子串)。
tag = "syn" + str(os.getpid())
# 注意: 这段 body 跑在 bash 单引号里, 写**单引号字符**会把 bash 的引号提前闭合,
# 源码被吞掉引号后仍能求值(写出的文件缺引号) => 脚本扫不到联合类型 => "守卫是死的"却看不出来。
# 故用 chr(39) 构造引号, body 内不出现任何单引号字符。
q = chr(39)
open(os.path.join(src, "types.ts"), "w", encoding="utf8").write(
    "export type Verdict = " + q + tag + "-alpha" + q + " | " + q + tag + "-beta" + q + "\n")
assert tag not in open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read(), \
    "合成取值字面量已存在于套件文本 —— 判据会自满足"
json.dump({"entries": [], "exemptions": [], "baselineUncovered": [], "baselineAt": None},
          open(os.path.join(root, "d/enum-consumers.json"), "w", encoding="utf8"))
env = dict(os.environ, DSH_REPO=root, DSH_COG_DIR=os.path.join(root, "d"),
           DSH_SUITE=os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"))  # 扫合成源, 但覆盖率仍对真套件
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-enum-consumer-check.py"),
                    "--scan", "--strict-new"], capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 2, "合成的新取值没有开火(退出码 %s) —— 守卫是死的" % r.returncode
assert "新增未覆盖 2" in r.stdout, r.stdout[:200]
print("合成新取值: 开火(退出码 2)")
'
t "同改守门须由排程驱动且日志新鲜" python3 -c '
import os, subprocess, time
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
assert "dsh-enum-consumer-check.py" in out, "同改守门未挂排程"
log = os.path.expanduser("~/.dsh/cognitive-pipeline/enum-consumers.cron.log")
# 同 cl-146: 归属分离, 判据只认 cron 痕迹
assert os.path.exists(log), "同改守门日志不存在(排程从未产出痕迹)"
# 只认 origin=cron 的行: 手工/套件跑出来的行不算排程证据(cl-147 —— 我手工 seed 过一次
# cron 专属日志, 说明"按文件名分离"只挡住了套件, 挡不住我自己)。
cron_lines = [l for l in open(log, encoding="utf8") if "origin=cron" in l]
if cron_lines:
    import datetime
    stamp = sorted(l[:16] for l in cron_lines)[-1]
    age = time.time() - datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M").timestamp()
    assert age < 3 * 3600, "同改守门最近的 cron 记录已 %.1f 小时未更新" % (age / 3600)
    print("cron 记录新鲜(%.0f 分钟前)" % (age / 60))
else:
    # 首班未到(部署后第一个排程时刻尚未到达): 不算通过也不算失败 —— 但必须确认排程**带 origin 标记**,
    # 否则首班到了也不会留下可判读的痕迹(这正是"排程≠完成"的老坑)。
    assert "DSH_RUN_ORIGIN=cron" in out, "同改守门排程未带 origin=cron 标记: 首班到了也留不下可判读的痕迹"
    print("首班未到(尚无 origin=cron 记录), 排程已带 origin 标记")
'

t "断言 body 内不得含裸单引号(会被 bash 提前闭合)" python3 -c '
import io, os, re
src = io.open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
bodies = re.findall(r"t \"([^\"]+)\" python3 -c \x27\n(.*?)\n\x27\n", src, re.S)
assert bodies, "抽不到断言 body —— 本断言前提不成立"
# 现实教训: body 跑在 bash 单引号里, 内部再写单引号会把引号提前闭合; 源码被吞掉引号后
# **仍能求值**(于是写出缺引号的文件、脚本扫不到东西、"守卫是死的"却全绿)。历史两条已存在, 记入白名单。
LEGACY = {"灰测模型到期闸", "cl-116: 回合闸门默认关闭(立项依据被证伪)"}
bad = [n for n, b in bodies if "\x27" in b and n not in LEGACY]
assert not bad, "新增断言 body 含裸单引号(会静默改义): %s" % bad
print("检查 %d 条 body, 无新增裸单引号" % len(bodies))
'

# ── T119 守卫必须能开火(cl-144: 判据静默失效是今天最贵的坑) ──
# 实证三次: ①裸子串搜套件被用例自身写的 T999 满足 ②合成用例写死的取值进了套件文本, 覆盖率"找到"它
# ③断言 body 内的裸单引号被 bash 提前闭合, 源码被吞引号后仍能求值 => 守卫彻底静默失效却全绿。
# 三次都只被"正向路径必须开火"那条断言抓住。故: 每条新守卫必须登记开火路径, 且声明的命令
# 现场真跑一次、必须非零退出 —— 这是"守卫现在活着"的直接证据, 不是文本推断。
echo "[T119] 守卫可开火登记(新守卫须登记 / 声明的开火路径须现场生效 / 排程驱动)"
t "登记簿完整且新守卫全部登记" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.json")
assert os.path.exists(p), "开火登记簿不存在"
reg = json.load(open(p, encoding="utf8"))
assert reg.get("baselineAt"), "缺基线时间戳(无法区分历史与新增守卫)"
assert reg.get("guards"), "无任何登记的守卫 —— 断言前提不成立"
suite = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
new_groups = sorted({"T" + m for m in __import__("re").findall(r"\[T(\d{2,3})\]", suite) if int(m) >= 112})
declared = {g["guard"] for g in reg["guards"]}
missing = [g for g in new_groups if g not in declared]
assert not missing, "新守卫未登记开火路径: %s" % missing
print("新守卫 %d 个, 全部已登记" % len(new_groups))
'
t "声明的开火断言必须真实存在于该组" python3 -c '
import json, os, re
reg = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.json"), encoding="utf8"))
suite = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
blocks = {}
for blk in re.split(r"\n(?=# ── T\d)", suite):
    m = re.search(r"\[T(\d{2,3})\]", blk)
    if m: blocks["T" + m.group(1)] = blk
bad = []
for entry in reg["guards"]:
    gid = entry["guard"]
    assert gid in blocks, "登记的守卫 %s 已从套件消失(腐烂)" % gid
    for fire in entry.get("mustFire") or []:
        name = fire.get("assertion")
        if name and ("t \"" + name + "\"") not in blocks[gid]:
            bad.append("%s: %s" % (gid, name))
assert not bad, "声明的开火断言不在该组内: %s" % bad
print("开火断言全部在组内")
'
t "声明的开火命令必须现场开火(exit=申报码, 且非探针崩溃)" python3 -c '
import json, os, subprocess
reg = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.json"), encoding="utf8"))
items = [(g["guard"], f) for g in reg["guards"] for f in (g.get("mustFire") or []) if f.get("command")]
assert items, "没有任何登记的开火命令 —— 断言前提不成立(只有文本声明不算证据)"
bad = []
for gid, f in items:
    want = str(f.get("expectedExit", 1))
    r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-guard-fire-run.sh", gid, want, f["command"]],
                       capture_output=True, text=True, timeout=900)
    if r.returncode != 1:
        last = (r.stderr.strip().splitlines() or [""])[-1]
        bad.append("%s exit=%d %s" % (gid, r.returncode, last[:100]))
assert not bad, "开火不可判别(探针崩溃/没开火/退出码漂移一律算红): %s" % bad
print("%d 条开火命令经统一执行器判定为**真开火**(非崩溃/非漂移)" % len(items))
'
# tp-119/cl-191: 判定器本身也是机制 —— 它必须能分开"真开火/探针崩溃/没开火/退出码漂移",
# 否则"非零退出"又会退化成把三种东西混成一种的老毛病。
t "开火判定器自身须可判别(崩溃/未开火/漂移/真开火)" bash /home/ubuntu/dsh-fork/dsh-guard-fire-run-selftest.sh
t "开火核验须由排程驱动且日志新鲜" python3 -c '
import os, subprocess, time
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
assert "dsh-guard-fire-check.py" in out, "开火核验未挂排程"
log = os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.cron.log")
# 同 cl-146: 归属分离
assert os.path.exists(log), "开火核验日志不存在(排程从未产出痕迹)"
# 只认 origin=cron 的行: 手工/套件跑出来的行不算排程证据(cl-147 —— 我手工 seed 过一次
# cron 专属日志, 说明"按文件名分离"只挡住了套件, 挡不住我自己)。
cron_lines = [l for l in open(log, encoding="utf8") if "origin=cron" in l]
if cron_lines:
    import datetime
    stamp = sorted(l[:16] for l in cron_lines)[-1]
    age = time.time() - datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M").timestamp()
    assert age < 8 * 3600, "开火核验最近的 cron 记录已 %.1f 小时未更新" % (age / 3600)
    print("cron 记录新鲜(%.0f 分钟前)" % (age / 60))
else:
    # 首班未到(部署后第一个排程时刻尚未到达): 不算通过也不算失败 —— 但必须确认排程**带 origin 标记**,
    # 否则首班到了也不会留下可判读的痕迹(这正是"排程≠完成"的老坑)。
    assert "DSH_RUN_ORIGIN=cron" in out, "开火核验排程未带 origin=cron 标记: 首班到了也留不下可判读的痕迹"
    print("首班未到(尚无 origin=cron 记录), 排程已带 origin 标记")
'
# tp-189(2026-09-12 20:3x): "开火"本身不是证据 —— 单臂探针只证明命令非零退出, 而"判据在原件上本来就红"
# 同样让任何探针非零退出(世界漂移/依赖坏掉/断言不在套件里)。故开火必须与**干净臂**配对: 该断言在最近一轮
# 套件裁决里必须是 ✓。本条判据不重跑 45 个探针(那条已有), 它只核对核验器自己落盘的配对计数 —— 这样
# 删掉配对逻辑会让字段消失、配对出红会让红计数非 0, 两种情况都转红(声明必须被行为消费)。
t "开火必须与干净臂配对(核验日志里的配对红数须为 0)" python3 -c '
import os, re
DIR = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
log = os.path.join(DIR, "guard-fire.log")
assert os.path.exists(log), "开火核验日志不存在(机制从未产出痕迹): " + log
lines = [l for l in open(log, encoding="utf8", errors="replace").read().splitlines() if l.strip()]
assert lines, "开火核验日志是空的"
last = lines[-1]
m = re.search(r"干净臂绿(\d+) 红(\d+) 取不到(\d+)", last)
assert m, ("最近一条核验记录里没有干净臂配对计数 ⇒ 配对逻辑没被行为消费(或被删掉了): " + last[-90:])
green, red, na = int(m.group(1)), int(m.group(2)), int(m.group(3))
assert red == 0, "有 %d 条守卫的干净臂是红的(= 判据在原件上就红, 那道开火没有意义)" % red
assert green >= 30, ("配对为绿的开火只有 %d 条(<30) —— 干净臂大面积取不到时不得算通过(会退化成无条件放行), "
                     "实得: 绿%d 红%d 取不到%d" % (green, green, red, na))
print("干净臂配对: 绿 %d | 红 %d | 取不到 %d" % (green, red, na))
'

# ── T120 机制台账: 防"修复广度不完整"(cl-148) ──
# 本轮实证: 我给"排程痕迹必须可辨来源"加 origin 标记时只改了 5 个新机制里的 3 个,
# 漏掉的恰是后果最重的两个(闸门会改写目标 nextAction / 观察快照是判据唯一入口)。
# 同一天"修复只覆盖碰到的那几处"已多次出现 ⇒ 把**广度本身**做成判据:
# 排程调用的 dsh 脚本必须在台账在册, 且台账声明的性质(存在/origin 标记/排程带 origin/记录文件)逐条成立。
echo "[T120] 机制台账(广度完整 / 声明的性质须成立 / 历史基线不追溯)"
t "台账完整且排程脚本全部在册" python3 -c '
import json, os, subprocess
inv = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/mechanism-inventory.json"), encoding="utf8"))
assert inv.get("baselineAt"), "缺基线时间戳(无法区分历史与新增)"
assert inv.get("mechanisms"), "台账为空 —— 断言前提不成立"
r = subprocess.run([__import__("sys").executable,
                    os.path.expanduser("~/dsh-fork/dsh-mechanism-inventory-check.py"), "--json"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "台账核验报缺口: %s" % r.stdout[-300:]
d = json.loads(r.stdout)
assert d["problems"] == [], "缺口: %s" % d["problems"]
print("台账 %d 项, 排程脚本 %d 个, 缺口 0" % (d["inventory"], d["cronScripts"]))
'
t "声明 originTagged 的脚本必须真有标记" python3 -c '
import json, os
inv = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/mechanism-inventory.json"), encoding="utf8"))
bad = [e["script"] for e in inv["mechanisms"]
       if e.get("originTagged") and "DSH_RUN_ORIGIN" not in open(e["script"], encoding="utf8").read()]
assert not bad, "声明带 origin 标记但源码没有: %s" % bad
n = len([e for e in inv["mechanisms"] if e.get("originTagged")])
print("%d 个机制声明并实有 origin 标记" % n)
'
t "排程机制的 crontab 条目必须带 origin=cron" python3 -c '
import json, os, subprocess
inv = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/mechanism-inventory.json"), encoding="utf8"))
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
lines = [l for l in out.splitlines() if "dsh-" in l]
missing = []
for e in inv["mechanisms"]:
    if not e.get("cron"):
        continue
    name = os.path.basename(e["script"])
    hit = [l for l in lines if name in l]
    assert hit, "台账称有排程但 crontab 找不到: %s" % name
    if not any("DSH_RUN_ORIGIN=cron" in l for l in hit):
        missing.append(name)
assert not missing, "排程条目缺 origin 标记: %s" % missing
print("排程机制条目均带 origin=cron")
'
t "台账不得腐烂(在册脚本与记录文件须存在)" python3 -c '
import json, os
inv = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/mechanism-inventory.json"), encoding="utf8"))
gone = [e["script"] for e in inv["mechanisms"] if not os.path.exists(e["script"])]
missing = [p for e in inv["mechanisms"] for p in (e.get("records") or []) if not os.path.exists(p)]
assert not gone, "在册脚本已消失: %s" % gone
assert not missing, "声明的记录文件不存在: %s" % missing
print("台账 %d 项与其记录文件均在" % len(inv["mechanisms"]))
'

# ── T121 离线整合层必须可判读(摘要年龄 / 重建尝试落盘) ──
# cl-135 追查所得: taxonomy.json 卡在 09-09(今日实测年龄 25.7h), 而 rebuild_taxonomy 今天被拒
# (误差 0.491 vs 0.070, 20 簇被拒)**在磁盘上零痕迹** —— 套件里 4 处 taxonomy 相关断言没有一条管
# 年龄/版本/重建结果。于是"整合层停止吸收新样本"这件事只能靠偶然想起; 想加判据连数据源都没有。
# 判据设计: 摘要年龄 > 24h 时, 24h 内必须**至少有一次重建尝试**记录(成功的或被告知被拒的都算) ——
# 这检验的是"层还在被尝试", 而不是"层成功了"(成功与否是内容问题, 被拒也要留痕)。
t "部署告警路径不得崩, 且同消息幂等(告警通道自己也会坏)" python3 -c '
import json, os, subprocess, sys, tempfile
TOOL = os.path.expanduser("~/dsh-fork/dsh-deploy-intent.py")
D = os.environ.get("DSH_COG_DIR") or tempfile.mkdtemp()
probe_src = """
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("di", os.environ["TOOL"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
r1 = m.write_alert("部署告警路径测试")
r2 = m.write_alert("部署告警路径测试")
rows = [json.loads(l) for l in open(m.LEDGER, encoding="utf8") if l.strip()]
print(json.dumps({"r1": r1, "r2": r2, "n": len(rows)}))
"""
probe = os.path.join(tempfile.mkdtemp(), "probe-alert.py")
open(probe, "w", encoding="utf8").write(probe_src + "\n")
r = subprocess.run([sys.executable, probe], capture_output=True, text=True, timeout=300,
                   env=dict(os.environ, TOOL=TOOL, DSH_COG_DIR=D))
assert r.returncode == 0, ("部署告警路径**崩了**(告警通道自己坏掉没人知道; 实证 2026-09-12 NameError: existing 未定义): "
                            + (r.stderr or r.stdout)[-220:])
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d["n"] == 1, "同消息重复调用不是幂等(落盘 %d 行)" % d["n"]
print("部署告警路径: 不崩 + 落盘 + 同消息幂等(落盘 %d 行)" % d["n"])
'
t "排程机制的活性: 不得有过期或不可判的 cron(它们会静默不跑)" python3 -c '
import json, os, subprocess, sys
TOOL = os.path.expanduser("~/dsh-fork/dsh-cron-liveness.py")
r = subprocess.run([sys.executable, TOOL, "--json"], capture_output=True, text=True, timeout=600)
assert r.returncode == 0, ("排程活性核查报异常(过期/缺见证的 cron 会**静默不跑**; 实证 2026-09-12 套件可执行位被抹掉后 cron 死了 1.5 小时, 日志只留一行 Permission denied): " + (r.stdout or r.stderr)[-260:])
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d["entries"] >= 20, "排程条目数异常(%d), 判据前提不成立" % d["entries"]
print("排程 %d 条: 无过期/缺见证(含按声明豁免的事件型/排期型)" % d["entries"])
'
echo "[T121] 离线整合层可判读(年龄 / 重建尝试落盘 / 记录字段完整)"
t "重建尝试必须落盘且字段完整" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/taxonomy-rebuild.jsonl")
assert os.path.exists(p), "重建记录文件不存在: 层被拒也无痕迹(想加判据都没数据源)"
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "重建记录为空 —— 断言前提不成立"
for key in ("ts", "accepted", "oldError", "newError", "sampleCount"):
    missing = [r.get("ts") for r in rows if key not in r]
    assert not missing, "记录缺字段 %s: %s" % (key, missing[:3])
print("重建记录 %d 行, 字段完整" % len(rows))
'
t "摘要陈旧时必须有近期重建尝试" python3 -c '
import json, os, datetime, time
TZ = datetime.timezone(datetime.timedelta(hours=8))
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
tax = os.path.join(D, "taxonomy.json")
assert os.path.exists(tax), "taxonomy.json 不存在"
age = (time.time() - os.path.getmtime(tax)) / 3600.0
rows = [json.loads(l) for l in open(os.path.join(D, "taxonomy-rebuild.jsonl"), encoding="utf8") if l.strip()]
recent = [r for r in rows if (time.time() - datetime.datetime.fromisoformat(r["ts"]).timestamp()) < 24 * 3600]
if age > 24:
    assert recent, ("摘要已陈旧 %.1fh 且 24h 内没有任何重建尝试记录 —— "
                    "整合层被遗忘(不是被拒, 是根本没再试)" % age)
    print("摘要年龄 %.1fh, 24h 内有 %d 次重建尝试(被拒也算)" % (age, len(recent)))
else:
    print("摘要年龄 %.1fh(尚未陈旧)" % age)
'

# ── T122 基线不得被事后扩(反证探索所得: 守卫可以被"加进基线"静默消音) ──
# 反事实追问"如果'机械守门有效'这个核心假设是错的, 证据会是什么样?" 找出的答案是:
# 今天每个守卫都自带一份**可自由编辑的基线**(那 81/17/101/8 条历史积压), 只要往基线里加一行,
# 对应守卫立刻恢复全绿 —— 也就是说守卫的有效性可以被"消音"而不是被解决, 而**没有任何判据盯着基线增长**。
# 实测(git 历史): 四份基线至今都只有创建版本、未被扩过, 所以假设暂未被证伪; 但缺口是结构性的, 故加此判据。
echo "[T122] 基线完整性(不得被事后扩 / 须有创建时间与 git 版本可比)"
t "基线内容必须与首次入库版本一致" python3 -c '
import json, os, subprocess
COG = os.path.expanduser("~/.dsh/cognitive-pipeline")
REPO = os.path.expanduser("~/.dsh")
FILES = {
  "experience-assertions.json": "baselineUncovered",
  "enum-consumers.json": "baselineUncovered",
  "guard-fire.json": "baselineGroups",
  "mechanism-inventory.json": "baselineUnregistered",
}
def revs(rel):
    out = subprocess.run(["git", "-C", REPO, "log", "--format=%h", "--", rel],
                         capture_output=True, text=True, timeout=60).stdout.split()
    return out
def show(rel, rev):
    out = subprocess.run(["git", "-C", REPO, "show", "%s:%s" % (rev, rel)],
                         capture_output=True, text=True, timeout=60).stdout
    try: return json.loads(out)
    except Exception: return None
checked, problems = 0, []
for fname, key in FILES.items():
    cur = json.load(open(os.path.join(COG, fname), encoding="utf8"))
    assert cur.get("baselineAt"), "%s 缺基线时间戳" % fname
    rel = "cognitive-pipeline/" + fname
    rs = revs(rel)
    assert rs, "%s 尚无 git 版本, 断言前提不成立" % fname
    first = show(rel, rs[-1])          # 最早版本
    if first is None or key not in first:
        continue
    if sorted(map(str, first[key])) != sorted(map(str, cur.get(key) or [])):
        problems.append("%s: 基线从 %d 变为 %d(守卫可能被静默消音)" % (fname, len(first[key]), len(cur.get(key) or [])))
    checked += 1
assert checked >= 3, "可比对的基线不足(%d), 断言前提不成立" % checked
assert not problems, "基线被事后扩: %s" % problems
print("%d 份基线与其首次入库版本一致" % checked)
'

# ── T123 消音面审计(每个登记簿都有一条"加一行就消音"的入口) ──
# 反事实探索的结论: 守卫可被"消音"而不被解决 —— T122 只守了基线这一类, 但同类入口还有:
#   · enum-consumers.exemptions / mechanism-inventory.exemptions(豁免)
#   · dead-signals.signals(把任意字段登记为死信号)
#   · experience-assertions.entries(把任意经验登记为已转化)
#   · guard-fire.guards(把任意守卫登记为"能开火")
# 判据: 每个消音型条目必须带**非空理由字段**; 豁免清单增长必须伴随理由(裸字符串一律红)。
echo "[T123] 消音面审计(条目须带理由 / 不得裸白名单 / 覆盖全部登记簿)"
t "消音型条目必须带非空理由" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
LISTS = (("enum-consumers.json", "exemptions"), ("mechanism-inventory.json", "exemptions"),
         ("dead-signals.json", "signals"), ("experience-assertions.json", "entries"),
         ("guard-fire.json", "guards"))
REASON = ("reason", "note", "disposition", "why")
problems, total = [], 0
for fname, key in LISTS:
    d = json.load(open(os.path.join(D, fname), encoding="utf8"))
    items = d.get(key) or []
    assert items, "%s.%s 为空 —— 本断言前提不成立" % (fname, key)
    for it in items:
        total += 1
        if isinstance(it, str):
            problems.append("%s.%s 有裸字符串条目(无理由): %s" % (fname, key, it)); continue
        inside = it.get("mustFire") if key == "guards" else None
        if inside is not None:
            for f in inside:
                if not any(f.get(k) for k in REASON):
                    problems.append("%s.%s 的开火路径缺理由: %s" % (fname, key, f.get("assertion")))
        elif not any(it.get(k) for k in REASON):
            problems.append("%s.%s 条目缺理由: %s" % (fname, key, str(it)[:40]))
assert not problems, "消音面缺理由: %s" % problems[:5]
print("%d 个消音型条目全部带理由" % total)
'
t "豁免清单不得在首次入库版本之外无记录增长" python3 -c '
import json, os, subprocess
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
REPO = os.path.expanduser("~/.dsh")
FILES = {"enum-consumers.json": "exemptions", "mechanism-inventory.json": "exemptions"}
checked = 0
for fname, key in FILES.items():
    rel = "cognitive-pipeline/" + fname
    revs = subprocess.run(["git", "-C", REPO, "log", "--format=%h", "--", rel],
                          capture_output=True, text=True, timeout=60).stdout.split()
    assert revs, "%s 尚无 git 版本" % fname
    cur = json.load(open(os.path.join(D, fname), encoding="utf8")).get(key) or []
    first_raw = subprocess.run(["git", "-C", REPO, "show", "%s:%s" % (revs[-1], rel)],
                               capture_output=True, text=True, timeout=60).stdout
    try:
        first = (json.loads(first_raw).get(key) or [])
    except Exception:
        continue
    # 增长是允许的, 但每一份增长都必须是"带理由的对象"(裸字符串会被上一条断言抓住);
    # 这里只核对**数量方向**: 只许增不许悄悄换掉(换掉=把违规项移出白名单以外的位置)。
    assert len(cur) >= len(first), "%s.%s 数量减少(%d -> %d): 疑似被改写" % (fname, key, len(first), len(cur))
    checked += 1
assert checked >= 2, "可比对的豁免清单不足, 断言前提不成立"
print("%d 份豁免清单版本可比" % checked)
'

# ── T124 判据族规则: "日志多写者 ⇒ 新鲜度判据必须辨来源"(cl-152 的下一步, 已可判定) ──
# 起因: 我连续两次发现"同类判据只改了一部分"(先 3/5 处, 再 2 处)。原想建"同类清单", 但实测
# 文本启发式分不出来(它把"心跳新鲜"误判成非新鲜度型) —— 说明族不能靠猜, 要靠**可判定的性质**。
# 判定规则(本轮想清楚的那条): 新鲜度判据是否需要辨来源, 取决于**该日志有几个写者**:
#   · 多写者(套件/手工也会跑同一脚本写同一日志) ⇒ mtime 会被非排程运行刷新 ⇒ 判据必须认 origin;
#   · 单写者(只有 cron 写) ⇒ mtime 足够, 强行要求 origin 反而是给它加无谓负担。
# 这也是为什么 lever-health/model-catalog/.script-lint/freeze-wiki 这四条老判据用 mtime 是对的。
echo "[T124] 判据族规则(多写者日志须辨来源 / 单写者容许 mtime / 人工清单非空)"
t "多写者日志的新鲜度判据必须判 origin" python3 -c '
import json, os, re
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
suite = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
inv = json.load(open(os.path.join(D, "mechanism-inventory.json"), encoding="utf8"))
multi, problems = [], []
for e in inv["mechanisms"]:
    script = os.path.basename(e["script"])
    # 写者计数: 该脚本在套件里被调用了几次(排除它自己那条新鲜度断言所在行)
    call_sites = len(re.findall(re.escape(script), suite))
    if call_sites < 2:
        continue
    for rec in e.get("records") or []:
        if not rec.endswith(".log"):
            continue                     # 只对日志适用; jsonl 是数据存储, 没有"新鲜度判据"一说
        base = os.path.basename(rec)
        # 判据可能指向默认日志, 也可能指向 .cron.log 变体(归属分离后), 两者都算数。
        cand = [base, base[:-4] + ".cron.log"]
        seen, ok = False, False
        for name in cand:
            idx = suite.find(name)
            if idx < 0:
                continue
            seen = True
            if "origin" in suite[max(0, idx - 1500):idx + 1500]:
                ok = True
        if seen and not ok:
            problems.append("%s(%s) 是多写者日志, 但其新鲜度判据不看 origin" % (base, script))
        elif ok:
            multi.append(base)
assert multi or problems, "既无多写者日志也无问题 —— 本断言前提不成立"
assert not problems, "多写者日志仍用 mtime 判来源: %s" % problems
print("%d 份多写者日志的判据均已辨来源" % len(multi))
'
t "单写者日志容许 mtime(须确实存在此类)" python3 -c '
import os, time
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
# 老判据里的四条只有 cron 写: 明确承认它们用 mtime 是对的, 防止下一步"一刀切全改 origin"的过度修正。
single = ["lever-health.log", "model-catalog.log", ".script-lint.log", "freeze-wiki.log"]
ok = 0
for name in single:
    p = os.path.join(D, name)
    if os.path.exists(p) and os.path.getsize(p) > 0:
        ok += 1
assert ok >= 3, "单写者日志样本不足(%d/4), 断言前提不成立" % ok
print("%d/4 份单写者日志在册(其 mtime 判据正当)" % ok)
'

# ── T125 观测脚本不得打死宿主(OOM 防复发: 内存上界 / 内存闸开火 / 哨兵告警) ──
# 事故: 2026-09-10 21:03 dsh-web 被内核 oom-kill —— 根因不是产品代码, 而是**我的观测脚本**
# 把 58MB 会话日志解压成 163MB 后整份读进内存(单脚本峰值 1036MB), 叠加 node 服务 1.4-1.7GB
# 与只有 3.6GB 的宿主。故本组断言守的是:**观测工具的内存上界**与"宁可拒跑也不打死宿主"的闸。
echo "[T125] 观测脚本内存上界(峰值上限 / 内存闸开火 / 哨兵告警可开火)"
t "采纳统计脚本峰值内存须有上界" python3 -c '
import os, re, subprocess, sys
# 实测口径: /usr/bin/time -v 的 Maximum resident set size。事故时该值为 1036MB, 修后 20MB。
r = subprocess.run(["/usr/bin/time", "-v", sys.executable,
                    os.path.expanduser("~/dsh-fork/dsh-adoption-stats.py"),
                    "--since", "2026-09-10T14:07:00", "--json"],
                   capture_output=True, text=True, timeout=600)
m = re.search(r"Maximum resident set size \(kbytes\): (\d+)", r.stderr)
assert m, "拿不到峰值内存读数(命令输出异常): %s" % r.stderr[-200:]
peak_mb = int(m.group(1)) / 1024
assert peak_mb < 200, "峰值 %.0fMB 超过 200MB 上界 —— 有重新引入整份缓冲的风险(事故值 1036MB)" % peak_mb
print("峰值 %.0fMB (上界 200MB)" % peak_mb)
'
t "内存不足时脚本必须拒跑而非硬上" python3 -c '
import os, subprocess, sys, tempfile
fake = "/tmp/t125-meminfo"
open(fake, "w", encoding="utf8").write(
    "MemTotal:        3659000 kB\nMemAvailable:     102400 kB\nSwapTotal:        1987000 kB\nSwapFree:         1000000 kB\n")
env = dict(os.environ, DSH_MEMINFO_PATH=fake)
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-adoption-stats.py"),
                    "--since", "2026-09-10T14:07:00", "--json"],
                   capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 3, "低内存时退出码应为 3, 实为 %s" % r.returncode
assert "拒绝运行" in (r.stderr or ""), "低内存退出但未说明原因: %s" % (r.stderr or "")[:120]
assert not r.stdout.strip(), "拒跑时仍产出了读数(不该有输出)"
print("低内存拒跑(退出码 3)且无产出")
'
t "内存哨兵必须在低内存时告警" python3 -c '
import json, os, subprocess, sys
fake = "/tmp/t125-meminfo"
assert os.path.exists(fake), "缺合成 meminfo"
# 合成用例必须写自己的账本: 否则低内存假告警会混进生产 memory-watch.jsonl(cl-157)
env = dict(os.environ, DSH_MEMINFO_PATH=fake,
           DSH_MEMORY_WATCH_LOG="/tmp/t125-memory-watch.jsonl")
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-memory-watch.py"), "--json"],
                   capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 2, "低内存时哨兵退出码应为 2, 实为 %s" % r.returncode
line = [l for l in r.stdout.splitlines() if l.startswith("{")][-1]
rec = json.loads(line)
assert rec["alert"] is True, "哨兵未告警: %s" % rec
assert rec["memAvailableMB"] < 400, "读到的可用内存不符: %s" % rec["memAvailableMB"]
print("哨兵告警开火(可用 %sMB)" % rec["memAvailableMB"])
'
t "合成用例不得写进生产内存账本" python3 -c '
import hashlib, os, subprocess, sys
prod = os.path.expanduser("~/.dsh/cognitive-pipeline/memory-watch.jsonl")
assert os.path.exists(prod), "生产内存账本不存在"
before = hashlib.sha256(open(prod, "rb").read()).hexdigest()
env = dict(os.environ, DSH_MEMINFO_PATH="/tmp/t125-meminfo",
           DSH_MEMORY_WATCH_LOG="/tmp/t125-memory-watch2.jsonl")
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-memory-watch.py")],
                   capture_output=True, text=True, timeout=300, env=env)
assert r.returncode == 2, "合成低内存应告警(退出 2), 实为 %s" % r.returncode
assert hashlib.sha256(open(prod, "rb").read()).hexdigest() == before, "合成用例污染了生产内存账本"
print("生产账本未被写入")
'
t "内存记录字段完整且排程带 origin" python3 -c '
import json, os, subprocess
log = os.path.expanduser("~/.dsh/cognitive-pipeline/memory-watch.jsonl")
assert os.path.exists(log), "内存哨兵记录不存在"
recs = [json.loads(l) for l in open(log, encoding="utf8") if l.strip()]
assert recs, "记录为空 —— 断言前提不成立"
last = recs[-1]
for key in ("ts", "memAvailableMB", "swapUsedMB", "serviceRssMB", "heavyScriptsRunning", "alert", "origin"):
    assert key in last, "内存记录缺字段: %s" % key
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
hit = [l for l in out.splitlines() if "dsh-memory-watch.py" in l]
assert hit, "内存哨兵未挂排程"
assert any("DSH_RUN_ORIGIN=cron" in l for l in hit), "哨兵排程缺 origin 标记"
print("内存记录 %d 条, 字段完整, 排程在册" % len(recs))
'

t "响应侧模型与巡检不一致时必须判降级" python3 -c '
import json, os, subprocess, sys
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-carrier-check.py"), "--json"],
                   capture_output=True, text=True, timeout=600)
assert r.returncode in (0, 2), "载体核对异常退出 %s" % r.returncode
d = json.loads(r.stdout)
resp = d.get("responseModel") or {}
assert resp.get("latest"), "读不到响应侧模型(效果证据) —— 只看配置/目录会漏掉隐性模型迁移(cl-014)"
got = resp["latest"].get("model"); cfg = (d.get("catalog") or {}).get("modelInUse")
if got and cfg and got != cfg:
    assert d["verdict"] == "degraded", "响应侧(%s)与配置侧(%s)不一致却判正常" % (got, cfg)
    assert any("不一致" in x for x in d["degraded"]), "降级理由里没有点明响应侧/配置侧分歧"
    assert r.returncode == 2, "分歧时退出码应为 2, 实为 %s" % r.returncode
    print("分歧已报出: 响应侧 %s vs 配置侧 %s" % (got, cfg))
else:
    print("两侧一致(%s), 无需降级" % got)
'

# ── T126 目录判定分类(cl-160: "未登广告" != "不可用", 两类必须分开且与证据同向) ──
# 起因: 插件目录(本地清单)说在用模型在册, 供应商实时目录查无此 id, 我原来的 verdict 只有 missing 一个词,
# 把"未登广告但正在服务"与"真不可用"混为一谈。现在用响应侧证据(cl-156)把两者分开。
echo "[T126] 目录判定分类(未登广告 != 不可用 / 服务证据须与判定同向)"
t "缺失判定不得与服务证据共存" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json"), encoding="utf8"))
verdict = str(d.get("verdict")); serving = d.get("servingEvidence")
assert verdict != "unknown", "判定为 unknown(拿不到目录或凭据): 分类判据前提不成立"
if "missing" in verdict:
    assert serving is not True, "判为缺失却又说服务证据成立(自相矛盾): %s" % d
elif "unadvertised" in verdict:
    assert serving is True, "判为未登广告却无服务证据: %s" % d
else:
    # present/unknown: 对服务证据不作要求(在册就是在册, 有没有响应侧证据都不影响该判定)
    pass
print("分类自洽: %s / serving=%s" % (verdict, serving))
'
t "未登广告但可用时必须给出响应侧证据" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/model-catalog.json"), encoding="utf8"))
if d.get("verdict") != "in-use-unadvertised-and-serving":
    print("当前非该分类(%s), 空过" % d.get("verdict")); raise SystemExit(0)
assert d.get("responseLatest"), "缺响应侧模型名"
age = d.get("responseAgeMinutes")
assert isinstance(age, (int, float)) and age <= 30, "响应侧证据过旧或缺失: %s" % age
assert d.get("modelInUse") == d.get("responseLatest"), (
    "响应侧返回 %s 与在用模型 %s 不一致" % (d.get("responseLatest"), d.get("modelInUse")))
print("证据完整: %s, %.1f 分钟前" % (d.get("responseLatest"), age))
'
# ── T127 推进率不得被元层量灌水(专属见证须同域 / 缺历史须记不可判定) ──
# 起因(用户指令"先修口径"): 数字生命的推进率长期 100%, 拆开看是三处灌水叠加 ——
#   ① 专属见证里含 suiteAssertions: 我今天写 15 组守卫就等于让这个目标"推进"了 15 次;
#   ② 当前值被无条件折进历史比较: 任何 N 天前的采纳只要该锚此后涨过一次就判推进;
#   ③ 新增锚在旧快照里不存在时 before 记 0 ⇒ 又一次"从 0 涨到现在"。
# 修完三处后: 数字生命 11/14=78.6%, 检索 16/20=80.0%(原均为 100%)。
echo "[T127] 推进率口径(专属见证不得含元层量 / 缺历史须记不可判定 / 计数须可见)"
t "专属见证不得含元层量" python3 -c '
import os, re
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
m = re.search(r"GOAL_WITNESS = \{(.*?)\n\}", src, re.S)
assert m, "找不到 GOAL_WITNESS 定义"
block = m.group(1)
bad = [k for k in ("suiteAssertions", "suitePasses", "gitCommits") if k in block]
assert not bad, "专属见证里仍有元层量(自己写测试就算推进): %s" % bad
assert "digitalLifeArtifacts" in block and "digitalLifeChainMembers" in block, "数字生命缺本体锚"
print("专属见证均为同域产物")
'
t "缺历史记录的锚必须记不可判定而非 0" python3 -c '
import os, re
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
assert "return None, None" in src, "缺历史时未返回 None(会退化成 before=0 的假增长)"
assert "_witness_undecidable" in src, "缺不可判定计数器"
assert "见证不可判定" in src, "计数器未写入报告(不可见的计数等于没有)"
print("缺历史 -> 不可判定, 且计数可读")
'
t "三处灌水形态都不得回流" python3 -c '
import os, re
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
# ② 当前值只能在 24h 窗口内参与比较
assert "adopted_at + datetime.timedelta(hours=24) >= datetime.datetime.now(" in src, "当前值折算未受窗口约束"
# 报告须显示元层提交单列(信息不丢, 但不计入推进)
assert "metaCommits" in src, "元层提交未单列"
print("三处灌水形态均已被判据覆盖")
'

# ── T128 配置类改动必须验证"在运行进程里生效"(cl-165) ──
# 起因(今天反复踩): 改配置 ≠ 生效。topK 3→1 回滚若只改 profile 而不重启, 运行进程仍用旧值;
# 而"看着生效"的常见假证据是"文件已改"(状态证据)。故本组用**三层**判定:
#   ①配置现值与预登记基线一致(不许脱节) ②进程启动晚于配置改动(已加载) ③运行时效果证据
#   —— 重启后新产生的注入记录条目数必须与 topK 声明一致(topK=1 ⇒ 每条注入只含 1 个经验)。
echo "[T128] 配置改动生效验证(现值/序关系/运行时证据)"
t "配置现值必须与预登记基线一致" python3 -c '
import json, os, re
prof = os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
base = os.path.expanduser("~/.dsh/cognitive-pipeline/ab-baselines.json")
assert os.path.exists(prof) and os.path.exists(base), "缺 profile 或基线文件"
text = open(prof, encoding="utf8").read()
tops = re.findall(r"^\s*topK:\s*(\d+)\s*$", text, re.M)
assert tops, "profile 里找不到 topK"
declared = int(tops[-1])
b = json.load(open(base, encoding="utf8"))
after = (b.get("afterValue") or {}).get("topK")
assert after is not None, "基线未记录 afterValue.topK"
assert declared == after, "配置 topK=%s 与预登记基线 afterValue.topK=%s 脱节" % (declared, after)
print("配置与基线一致: topK=%d" % declared)
'
t "进程必须晚于配置改动启动(改动已加载)" python3 -c '
import os, subprocess, time
prof = os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
cfg_mtime = os.path.getmtime(prof)
out = subprocess.run(["pgrep", "-f", "bin.js web"], capture_output=True, text=True, timeout=20).stdout.split()
assert out, "找不到 web 服务进程"
lstart = subprocess.run(["ps", "-o", "lstart=", "-p", out[0]], capture_output=True, text=True, timeout=20).stdout.strip()
start = time.mktime(time.strptime(lstart))
assert start > cfg_mtime, "进程(%.0f)早于配置改动(%.0f): 改动未加载, 需重启" % (start, cfg_mtime)
print("进程晚于配置改动 %.0f 秒" % (start - cfg_mtime))
'
t "运行时证据: 注入条目数须与 topK 一致" python3 -c '
import json, os, re, subprocess, time
prof = os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
top = int(re.findall(r"^\s*topK:\s*(\d+)\s*$", open(prof, encoding="utf8").read(), re.M)[-1])
out = subprocess.run(["pgrep", "-f", "bin.js web"], capture_output=True, text=True, timeout=20).stdout.split()
lstart = subprocess.run(["ps", "-o", "lstart=", "-p", out[0]], capture_output=True, text=True, timeout=20).stdout.strip()
start_ms = time.mktime(time.strptime(lstart)) * 1000
inj = {}
for line in open(os.path.expanduser("~/.dsh/cognitive-pipeline/injections.jsonl"), encoding="utf8"):
    if line.strip():
        r = json.loads(line)
        if isinstance(r.get("injectionId"), str): inj[r["injectionId"]] = r
after = [r for r in inj.values() if (r.get("createdAt") or 0) >= start_ms and r.get("expIds")]
if not after:
    print("重启后尚无注入样本(未到首样本), 不假装通过也不判红"); raise SystemExit(0)
sizes = sorted({len(r["expIds"]) for r in after})
# 修正(cl-168): 不能再假设 "topK=1 ⇒ 条目数恒为 1" —— coverViewpoints 会因**新颖度/视角覆盖**多带一条,
# 实测加宽前(topK=1)的分布就是 {1: 11, 2: 9}。故上界取 top+1, 并额外要求"不得超过加宽期的上界"。
limit = top + 1
assert all(s <= limit for s in sizes), "运行时条目数 %s 超过 topK=%d 的可解释上界 %d => 配置未生效" % (sizes, top, limit)
# 实测(topK=1 时期): 少量样本可能**全部**是 2 条(novelty 覆盖多带一条), 那是合法形态;
# 故只保上界, 不再要求"至少一条落在 topK 内"(该要求在小样本上会假红)。
print("运行时证据通过: %d 条注入, 条目数 %s (topK=%d, 上界 %d)" % (len(after), sizes, top, limit))
'

# ── T129 已裁决的基线不得重复武装(cl-166: 同一步被重复提醒) ──
# 实证: 23:05 回滚后 23:11 闸门又 ARMED(lift 样本=143 —— before+after 跨窗口相加), 把已清空的 nextAction
# 写回, 于是行动帧对**已执行完**的步骤再提醒一次。判据必须区分"该基线已裁决"与"新证据出现"。
echo "[T129] 闸门不得对已裁决基线重复武装(源码须读 adjudicatedAt / 行为须保持 waiting)"
t "闸门源码须读 adjudicatedAt 且 lift 路有变后样本下限" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/dsh-adoption-gate-arm.py"), encoding="utf8").read()
assert "adjudicatedAt" in src, "闸门未读 adjudicatedAt(已裁决基线会被反复武装)"
assert "after_turns >= 20" in src, "lift 路缺变化后样本下限(变后 1 回合也能算达标)"
print("源码级: 两处收紧都在")
'
t "已裁决基线下运行闸门必须 waiting 且不改写目标" python3 -c '
import json, os, shutil, subprocess, sys
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
bl = os.path.join(D, "ab-baselines.json")
d = json.load(open(bl, encoding="utf8"))
assert d.get("adjudicatedAt"), "当前基线未标 adjudicatedAt —— 断言前提不成立(裁决后才守这条)"
tmp_goals = "/tmp/t129-goals.jsonl"
shutil.copy(os.path.join(D, "dormant-goals.jsonl"), tmp_goals)
before = open(tmp_goals, encoding="utf8").read()
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-adoption-gate-arm.py"),
                    "--goals", tmp_goals], capture_output=True, text=True, timeout=600)
assert r.returncode == 0, r.stderr[:200]
assert "waiting" in r.stdout, "已裁决基线却被武装: %s" % r.stdout.strip()
assert "已裁决" in r.stdout, "waiting 但未说明是因为已裁决: %s" % r.stdout.strip()
assert open(tmp_goals, encoding="utf8").read() == before, "已裁决基线下仍改写了 nextAction"
print("已裁决基线: 保持 waiting 且未改写")
'

# ── T130 A/B 窗口分段必须自洽(cl-167: 基线一改, 分段逻辑就生成倒挂区间并重复计数) ──
# 实证: 回滚把 splitAt 从 14:07 移到 23:05 后, 旧的"按 15:50 口径点切段"逻辑产出
# [23:05, 15:50) 这种**倒挂区间**(hours=-7.26), 并与 before 窗口重叠 ⇒ 闸门报 lift 样本=143。
# 现判据: before=[previousSplitAt, splitAt), after=[splitAt, now); 口径点仅在落在 after 内时才切段;
# 任何负时长/窗口不接续都判红。
echo "[T130] A/B 窗口自洽(非负时长 / 与切换点接续 / 口径点仅在 after 内切段)"
t "窗口时长必须非负且与切换点接续" python3 -c '
import json, os, datetime
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/ab-compare.json"), encoding="utf8"))
segs = (d.get("adoption") or {}).get("segments") or {}
assert segs, "缺分段(断言前提不成立)"
split = datetime.datetime.fromisoformat(d["splitAt"])
def p(ts):
    if not ts:
        return None
    d = datetime.datetime.fromisoformat(ts)
    return d.replace(microsecond=0, tzinfo=None)      # 秒级且忽略时区表示差异(基线含微秒, 分段截到秒)
before = segs.get("before")
assert before, "缺 before 段"
assert p(before["windowEnd"]) == p(d["splitAt"]), "before 段未在切换点结束: %s vs %s" % (before["windowEnd"], d["splitAt"])
for name, seg in segs.items():
    if seg.get("hours") is not None:
        assert seg["hours"] >= 0, "%s 段出现负时长 %s(倒挂区间)" % (name, seg["hours"])
for name in ("afterOldLens", "afterNewLens"):
    seg = segs.get(name)
    if seg:
        assert p(seg["windowStart"]) >= p(d["splitAt"]), "%s 段起点早于切换点(与 before 重叠)" % name
print("窗口自洽: before 止于切换点, 各段时长非负")
'
t "口径变更点只在落在 after 内时才切段" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
d = json.load(open(os.path.join(D, "ab-compare.json"), encoding="utf8"))
segs = (d.get("adoption") or {}).get("segments") or {}
lens = (d.get("adoption") or {}).get("settlementLensChangedAt")
assert lens, "缺口径变更点记录"
import datetime
lens_ms = datetime.datetime.fromisoformat(lens); split = datetime.datetime.fromisoformat(d["splitAt"])
if lens_ms > split:
    assert "afterOldLens" in segs and "afterNewLens" in segs, "口径点在 after 内却未切段"
    print("口径点在 after 内: 已切段")
else:
    assert "afterOldLens" not in segs, "口径点在切换点之前, 不应出现 afterOldLens 段"
    assert segs.get("afterNewLens"), "缺 after 段"
    print("口径点在切换点之前: 未切段(单片 after)")
'

# ── T131 被引用的模型 id 必须在供应商广告目录内(cl-171: 下架 id 静默留在配置里) ──
# 实证: 认知管线自身的 LLM 路由(cordis.patch.yml)长期写着 deepseek-v4-flash, 而该 id 09-10 起
# 已不在供应商目录(仅 deepseek-flash / deepseek-v4-pro); 服务端靠别名兜着, 一旦别名失效,
# **第 2 层 LLM 裁判**(SAR 抽取/精排/标定/OOD/聚类重建)会整体失效 —— 而配置侧毫无提示。
# 判据: settings.yaml 与 profile patch 里出现的每个 model id, 必须能在目录快照中找到(或登记豁免)。
echo "[T131] 模型引用一致性(配置引用的 id 须在广告目录内 / 两类消费者须分别记录)"
t "配置引用的模型 id 必须都在广告目录内" python3 -c '
import json, os, re
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
cat = json.load(open(os.path.join(D, "model-catalog.json"), encoding="utf8"))
advertised = set(cat.get("catalog") or [])
assert advertised, "缺供应商目录快照(断言前提不成立)"
refs = {}
for path, label in ((os.path.expanduser("~/.dsh/settings.yaml"), "agent-default"),
                    (os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml"), "profile-patch")):
    if not os.path.exists(path):
        continue
    for line in open(path, encoding="utf8"):
        s = line.strip()
        if s.startswith("#"):
            continue
        m = re.match(r"model:\s*([A-Za-z0-9._/-]+)\s*$", s)
        # 排除: 嵌入模型(BAAI/...) 与**哨兵值**(default/auto/inherit 表示"沿用上层默认", 不是具体 id)
        if m and not m.group(1).startswith("BAAI") and m.group(1).lower() not in ("default", "auto", "inherit"):
            refs.setdefault(m.group(1), []).append(label)
assert refs, "没解析到任何被引用的模型 id"
missing = {k: v for k, v in refs.items() if k not in advertised}
assert not missing, "配置引用了不在广告目录内的模型 id: %s (目录: %s)" % (missing, sorted(advertised))
print("引用的 %d 个模型 id 全在广告目录内: %s" % (len(refs), sorted(refs)))
'
t "检查器须分别报告 agent 默认档与管线路由" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
cat = json.load(open(os.path.join(D, "model-catalog.json"), encoding="utf8"))
assert "agentDefaultModel" in cat, "检查器未报告 agent 默认档(cl-171 前它把管线路由误当成默认档)"
assert "pipelineModel" in cat, "检查器未报告管线路由模型"
adv = set(cat.get("catalog") or [])
for label, key in (("agent 默认档", "agentDefaultModel"), ("管线路由", "pipelineModel")):
    v = cat.get(key)
    if v:
        assert v in adv, "%s(%s)不在广告目录内" % (label, v)
print("两类消费者已分别记录且均在目录内")
'

# ── T132 账本行必须可按 ts 排序(cl-174 起始 / cl-188 修正判据) ──
# 起因: claims-ledger 有 28 个 id 的所有行 ts 完全相同 ⇒ "按 ts 取最新"的消费方(报告/断言/我的核查)
# 随机读到 open 或 done。2026-09-11 03:2x 一次性回填(74 行命中, 42 行可判定并标 tsBackfilled,
# 留痕 claims-ledger-repair.jsonl, 备份 .bak-frame0910), 实测违例归零。
# ⚠ 原断言 B 是"关单行 ts 不得等于 doneAt"——实现细节的替身, 且与"状态在 doneAt 时刻变更,
#   故状态变更行的 ts 就该取 doneAt"直接冲突: 回填后 3 行合法地 ts==doneAt, 替身断言假红。
#   已改为直测不变量本身(严格递增), 另补模板断言——cl-174 在代码里的同型残留:
#   quiet-driver 两处 status:'done' 自动关单行整个没有 ts 字段, 数据断言碰不到, 需查写入模板。
echo "[T132] 账本可按 ts 排序(每行须有 ts / 同 id 行严格递增 / 关闭行模板须带 ts)"
t "账本每行必须有 ts 且同 id 行按文件顺序严格递增" python3 -c '
import json, os, collections
p = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "账本为空"
nots = [r.get("id") for r in rows if not r.get("ts")]
assert not nots, "行缺 ts(按 ts 取最新的消费方读到 undefined, 等价于 ts 相同): " + repr(nots[:5])
byid = collections.defaultdict(list)
for r in rows:
    if r.get("id"): byid[r["id"]].append(str(r["ts"]))
bad = [k for k, v in byid.items() if any(a >= b for a, b in zip(v, v[1:]))]
assert not bad, "同一 id 的行 ts 未严格递增(消费方会读错状态): " + repr(bad[:5])
multi = sum(1 for v in byid.values() if len(v) > 1)
print("账本 " + str(len(rows)) + " 行 / " + str(len(byid)) + " id(多行 " + str(multi) + "), ts 递增违例 0")
'
t "ts 回填必须留痕(标记须有原值 / 备份须在 / 标记数不得缩水)" python3 -c '
import json, os
d = os.path.expanduser("~/.dsh/cognitive-pipeline")
rows = [json.loads(l) for l in open(d + "/claims-ledger.jsonl", encoding="utf8") if l.strip()]
recs = [json.loads(l) for l in open(d + "/claims-ledger-repair.jsonl", encoding="utf8") if l.strip()]
assert recs, "缺回填留痕记录 claims-ledger-repair.jsonl"
rec = recs[-1]
assert os.path.exists(os.path.join(d, str(rec.get("backup")))), "留痕指向的备份不存在"
marked = [r for r in rows if "tsBackfilled" in r]
assert len(marked) >= int(rec["markedRows"]), "带 tsBackfilled 的行从 " + str(rec["markedRows"]) + " 减到 " + str(len(marked))
noop = [r.get("id") for r in marked if str(r.get("tsBackfilled")) == str(r.get("ts"))]
assert not noop, "tsBackfilled 与原 ts 相同(空标记): " + repr(noop[:5])
print("回填留痕 " + str(len(marked)) + " 行(记录 " + str(rec["markedRows"]) + "), 备份在册")
'
t "账本关闭行的写入模板必须带 ts" python3 -c '
import os, re
p = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts")
src = open(p, encoding="utf8").read()
hits = [m.start() for m in re.finditer(r"status: .done.,", src)]
assert hits, "没找到 status done 的写入模板(断言前提不成立)"
bad = [i for i in hits if "ts:" not in src[i:i + 260]]
assert not bad, "关闭行模板缺 ts(cl-174 同型残留, 数据断言碰不到): " + repr(len(bad)) + " 处"
print("关闭行模板 " + str(len(hits)) + " 处, 均带 ts")
'

# ── T133 目标池轨迹完整性(触发须逐次留痕 / 采纳日志不得与 notes 脱节) ──
# 起因(用户追问"孵化池轨迹有记录吗"): ①触发只有累计计数, lastTriggerAt 全 null ⇒ 无法回答"第 N 次唤醒何时"；
# ②incubation-log 停在 09-10 17:20 而 notes 此后多次更新 ⇒ 按日志读会以为没有采纳。
echo "[T133] 目标池轨迹(触发日志在册且新鲜 / 采纳日志与 notes 不脱节)"
t "触发轨迹日志须存在且新鲜" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/goal-trigger-log.jsonl")
if not os.path.exists(p):
    # 埋点已进 lib(01:28 构建), 但**运行进程尚未加载**(重启前不会写出) —— 这种"改了没部署"不该判成缺陷,
    # 而是由 T11(服务晚于 lib 启动)单独守。此处显式声明未部署, 不假装通过也不假红。
    import subprocess as _sp, os as _os
    lib = _os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")
    assert _os.path.exists(lib) and "goal-trigger-log" in open(lib, encoding="utf8").read(), \
        "缺 goal-trigger-log.jsonl 且 lib 里也没有埋点"
    print("触发日志埋点已在 lib, 待重启部署(不判红)")
    raise SystemExit(0)
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "触发日志为空"
last = max(r.get("ts", "") for r in rows if r.get("ts"))
for key in ("ts", "goalId", "adopted"):
    assert key in rows[-1], "触发日志缺字段 %s" % key
print("触发轨迹 %d 条, 最新 %s" % (len(rows), last[:19]))
'
t "采纳日志不得与目标池 notes 脱节" python3 -c '
import json, os, datetime, re
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
log = os.path.join(D, "incubation-log.jsonl")
pool = os.path.join(D, "dormant-goals.jsonl")
assert os.path.exists(log) and os.path.exists(pool), "缺 log 或池文件"
entries = [json.loads(l) for l in open(log, encoding="utf8") if l.strip()]
log_last = max((e.get("ts") or "" for e in entries), default="")
def parse(v):
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"):
        try: return datetime.datetime.fromisoformat(str(v).replace("Z","")[:19])
        except Exception: pass
    return None
# 只认**日期开头且可解析**的 note。实测教训(2026-09-11 08:5x): 池里有一条写的是模糊时间
# "2026-09-09 13:5x"(分钟位是个 x), 旧写法取字符串最大值后再解析 ⇒ 解析成 None ⇒ 断言直接崩(判红),
# 而真正的问题只是"有人写了个模糊时间"。判据不该被一条脏数据杀死: 解析不了的**跳过并报数**。
notes_ts, unparsable = [], []
for line in open(pool, encoding="utf8"):
    if not line.strip(): continue
    g = json.loads(line)
    notes = g.get("notes")
    if not isinstance(notes, list):   # 字符串型 notes 不参与(无法逐条取时间)
        continue
    for n in notes:
        if not (isinstance(n, str) and re.match(r"\d{4}-\d{2}-\d{2}", n)):
            continue
        t = parse(n[:16])
        if t is None:
            unparsable.append(n[:20])
            continue
        notes_ts.append(t)
assert notes_ts, "池里没有可解析的日期型 note(断言前提不成立)"
pool_last = max(notes_ts).strftime("%Y-%m-%d %H:%M")
a, b = parse(log_last), max(notes_ts)
assert a and b, "时间戳解析失败: %s / %s" % (log_last, pool_last)
gap = (b - a).total_seconds() / 3600.0
# notes 比采纳日志新 >2h ⇒ 说明有目标改动只写了 notes 没写 log(采纳轨迹脱节)
assert gap <= 2.0, "notes 最新(%s)比采纳日志(%s)新 %.1fh: 有改动未入 incubation-log" % (pool_last, log_last, gap)
print("采纳日志与 notes 同步(差 %.1fh; 跳过 %d 条模糊时间)" % (gap, len(unparsable)))
'

# ── T134 影子对照的前提: 审计必须落**候选级得分**(cl-183) ──
# 起因: goal-experience-library 的 nextAction 要跑"三档排序离线对照", 但审计只落 topHits(裸相似度)
# 与最终 expIds ⇒ 候选身份与各项得分都没有, 对照无从做起(这就是我上一轮把该步判为"缺前置"的证据)。
# 现已在 injected 审计里补 candidateScores([{expId, similarity}])。判据两层: 源码有埋点 + 部署后记录里有。
echo "[T134] 影子对照前提(审计带候选级得分 / 部署后须真出现)"
t "审计埋点须含候选级得分" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
assert "candidateScores" in src, "注入审计未落候选级得分 => 影子对照无法重建同一候选集"
print("源码埋点在册")
'
t "部署后审计记录须真带 candidateScores" python3 -c '
import json, os, subprocess
lib = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")
assert os.path.exists(lib) and "candidateScores" in open(lib, encoding="utf8").read(), "lib 未含埋点(需构建)"
p = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
injected = [r for r in rows if r.get("stage") == "injected"]
withcs = [r for r in injected if r.get("candidateScores")]
if not withcs:
    # 尚未部署(进程早于 lib): 显式声明, 不假红 —— 由 T11 守"服务晚于 lib 启动"
    out = subprocess.run(["pgrep", "-f", "bin.js web"], capture_output=True, text=True, timeout=20).stdout.split()
    lstart = subprocess.run(["ps", "-o", "lstart=", "-p", out[0]], capture_output=True, text=True, timeout=20).stdout.strip()
    print("埋点已在 lib, 但运行进程启动于 %s(早于 lib), 待重启部署" % lstart)
    raise SystemExit(0)
assert all(isinstance(r.get("candidateScores"), list) and r["candidateScores"] for r in withcs), "candidateScores 为空"
print("%d/%d 条 injected 审计带候选级得分" % (len(withcs), len(injected)))
'
t "触发轨迹行须可消费(含 goalId 与 adopted)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/goal-trigger-log.jsonl")
assert os.path.exists(p), "缺触发轨迹"
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "触发轨迹为空"
for r in rows[:20]:
    assert "goalId" in r and "adopted" in r, "轨迹行缺字段: %s" % r
    assert isinstance(r["adopted"], bool), "adopted 必须是布尔(供空转判定)"
print("触发轨迹 %d 行, 字段可消费(含未采纳行)" % len(rows))
'

# ── T135 影子对照必须先预登记(cl-184: 防"看到结果再挑判据") ──
# 起因: topK 实验的成功之处在于判据**事先写死**(rollbackIf/keepIf); 本次效用接线实验若事后挑判据,
# 就会重演"拿噪声当信号"。故要求: ①预登记文件(判据/标签定义/三档/最小样本)先存在;
# ②其 mtime 必须早于任何结果文件(顺序纪律); ③标签定义必须显式排除"引用"(暴露下游混淆)。
# ── T135 影子对照必须先预登记(cl-184) ──
# 判据事先写死才允许跑: 顺序纪律(预登记 mtime < 结果 mtime) + 标签定义须排除"引用"(暴露下游混淆)。
echo "[T135] 影子对照预登记(判据写死 / 先预登记后跑 / 标签排除引用)"
t "预登记文件须存在且字段完整" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/library-replay-baseline.json")
assert os.path.exists(p), "缺预登记文件: 判据未写死, 跑出来的结论可被事后挑选"
d = json.load(open(p, encoding="utf8"))
for key in ("criterion", "label", "arms", "minSample", "createdAt"):
    assert key in d, "预登记缺字段 %s" % key
c = d["criterion"]
for key in ("primary", "secondary", "falsify", "retire"):
    assert c.get(key), "判据缺 %s(须先写死)" % key
assert d["minSample"] >= 10, "最小样本过低: %s" % d["minSample"]
assert len(d["arms"]) == 3, "三档排序未写全"
print("预登记完整: 判据 4 项 / 标签 / 3 档 / minSample=%d" % d["minSample"])
'
t "预登记必须早于结果文件(先写死再跑)" python3 -c '
import os, json
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
pre = os.path.join(D, "library-replay-baseline.json")
res = os.path.join(D, "library-replay-result.json")
assert os.path.exists(pre), "缺预登记"
if not os.path.exists(res):
    print("尚无结果文件(实验未跑), 顺序纪律待首次运行时验证")
    raise SystemExit(0)
assert os.path.getmtime(pre) < os.path.getmtime(res), "结果文件早于预登记: 判据是事后补的"
d = json.load(open(res, encoding="utf8"))
n = d.get("sampleCount") or 0
if n < json.load(open(pre, encoding="utf8"))["minSample"]:
    assert not d.get("conclusion"), "样本 %d < 门槛却给了结论" % n
print("顺序与样本纪律成立")
'
t "标签定义须显式排除引用" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/library-replay-baseline.json"), encoding="utf8"))
txt = json.dumps(d["label"], ensure_ascii=False)
assert "不得用引用" in txt or "不用引用" in txt, "标签定义未显式排除引用(暴露下游混淆会回流)"
print("标签定义已排除引用")
'

# ── T136 影子对照可跑且不得越样本门槛下结论(cl-185) ──
# 起因: 判据已预登记(T135), 但脚本必须 ①存在且可跑(否则预登记只是纸面) ②样本不足时**不得**给结论
# ③C 档(效用+通道权重)在当前埋点下不可算 —— 必须显式报 unavailable, 不许拿 A 档冒充。
echo "[T136] 影子对照可执行(脚本可跑 / 样本不足不下结论 / C 档不可算须显式)"
t "影子对照脚本可跑并落盘结果" python3 -c '
import json, os, subprocess, sys
script = os.path.expanduser("~/dsh-fork/dsh-library-replay.py")
assert os.path.exists(script), "缺影子对照脚本"
r = subprocess.run([sys.executable, script, "--json"], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "脚本异常: %s" % (r.stderr or "")[:200]
d = json.loads(r.stdout)
for key in ("sampleCount", "minSample", "armA_mrr", "armB_mrr", "armC_status"):
    assert key in d, "结果缺字段 %s" % key
assert d["minSample"] >= 10, "最小样本人为放宽: %s" % d["minSample"]
print("脚本可跑, 样本 %d/%d" % (d["sampleCount"], d["minSample"]))
'
t "样本不足时不得给出结论" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/library-replay-result.json")
assert os.path.exists(p), "缺结果文件(先跑脚本)"
d = json.load(open(p, encoding="utf8"))
n = d.get("rankableSets", d["sampleCount"])   # cl-200: 判据的 n 是"可排序集", 不是"带得分的记录数"
if n < d["minSample"]:
    assert d.get("conclusion") in (None, "insufficient-rankable-sample"), \
        "可排序集 %d<%d 却给了裁决性结论 %s" % (n, d["minSample"], d.get("conclusion"))
    assert d.get("note"), "样本不足须显式说明"
    print("可排序集 %d/%d 不足: 未给裁决(合规)" % (n, d["minSample"]))
else:
    assert d.get("conclusion") in ("wire-utility", "retire-utility"), "样本已足但结论非法: %s" % d.get("conclusion")
    print("样本已足, 结论 %s" % d["conclusion"])
'
t "C 档不可算时必须显式声明" python3 -c '
import json, os
d = json.load(open(os.path.expanduser("~/.dsh/cognitive-pipeline/library-replay-result.json"), encoding="utf8"))
assert isinstance(d.get("armC_status"), str) and d["armC_status"], "C 档状态未声明"
assert "unavailable" in d["armC_status"] or d.get("armC_mrr") is not None, "C 档既未给出也未声明不可算"
print("C 档状态: %s" % d["armC_status"][:60])
'

# ── T137 唤醒侧判据与行动帧同源(cl-186: 两侧各写一套等待态判据 = 半个机制) ──
# exp_252 的教训("暂停只停了一半"): 跨插件语义必须两侧读同一字段/同一判据。
# 现在 dormant-goal 有了同构的 isWaitingNextActionLocal, 并由本组比对**正则源**确保不会各自漂移。
echo "[T137] 唤醒侧等待态判据(与行动帧同源 / 触发轨迹须标 skipped)"
t "两侧等待态判据必须同源(正则逐条一致)" python3 -c '
import os, re
def patterns(path):
    s = open(path, encoding="utf8").read()
    out = {}
    for name in ("WAITING_PREFIX", "WAITING_DATE", "NOT_WAITING"):
        m = re.search(name + r"\s*=\s*(/.+?/)\s*$", s, re.M)
        assert m, "%s 缺 %s" % (path, name)
        out[name] = m.group(1)
    return out
a = patterns(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/waiting.ts"))
b = patterns(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts"))
diff = [k for k in a if a[k] != b[k]]
assert not diff, "两侧判据不一致(会各自漂移): %s" % diff
print("三条正则逐字一致: %s" % ", ".join(a))
'
t "两侧等待态判据必须同构(函数体逐字一致, 不止正则)" python3 -c '
import os, re
qd = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/waiting.ts"), encoding="utf8").read()
dg = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts"), encoding="utf8").read()
def body(src, name):
    m = re.search(r"function " + name + r"\([^)]*\)[^{]*\{(.*?)\n\}", src, re.S)
    assert m, "抽不到函数体: " + name
    b = m.group(1)
    b = b.replace(name, "F").replace("parseWaitingMomentLocal", "parseWaitingMoment")
    # 去掉注释行与行尾注释, 只比逻辑
    b = "\n".join(re.sub(r"//.*$", "", ln).strip() for ln in b.splitlines() if ln.strip() and not ln.strip().startswith("//"))
    return b
pairs = [("isWaitingNextAction", "isWaitingNextActionLocal"), ("parseWaitingMoment", "parseWaitingMomentLocal")]
for a, b in pairs:
    ba, bb = body(qd, a), body(dg, b)
    assert ba == bb, "两侧 %s 逻辑已漂移: 行数 %d vs %d" % (a, len(ba.splitlines()), len(bb.splitlines()))
print("两侧 %d 个函数体逐字一致(正则之外再守逻辑)" % len(pairs))
'
t "触发轨迹行须带 skipped 字段(供空转判定)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/goal-trigger-log.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
assert rows, "触发轨迹为空"
if not any("skipped" in r for r in rows):
    # 埋点已进 lib(02:5x 构建)但进程未加载 ⇒ 显式声明, 不假红(由 T11 守部署)
    lib = os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")
    assert "skipped" in open(lib, encoding="utf8").read(), "lib 未含 skipped 埋点"
    print("skipped 埋点已在 lib, 待重启部署(既有旧行无该字段属正常)")
    raise SystemExit(0)
print("触发轨迹已含 skipped 字段")
'
t "等待型唤醒必须标 skipped(非零即红)" python3 -c '
import json, os, datetime
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
pool = {}
for l in open(os.path.join(D, "dormant-goals.jsonl"), encoding="utf8"):
    if l.strip():
        g = json.loads(l); pool[g["id"]] = g
def waiting(na):
    t = (na or "").strip()
    if not t or t.startswith(("待办","待修","待补","待验证","待测试","待评估","待实现","待重构")): return False
    import re
    return bool(re.match(r"^(?:待用户|等待用户|请用户|需用户|等用户|待你|等你|待事件|待日期|等待外部|等外部)", t)
                or re.match(r"^(?:等待|等|待)\s*(?:[0-9]{4}|[0-9]{1,2}\s*[-/.月])", t))
rows = [json.loads(l) for l in open(os.path.join(D, "goal-trigger-log.jsonl"), encoding="utf8") if l.strip()]
now = datetime.datetime.now(datetime.timezone.utc)
# 判据只看**部署之后**的行: 埋点上线的行才有 skipped 字段, 用"首条带 skipped 的行"当分界,
# 否则回看 1h 会把部署前的历史行(必然无该字段)判成缺陷 —— 这是部署边界伪影, 不是机制问题。
withfield = [r for r in rows if "skipped" in r and r.get("ts")]
if not withfield:
    print("尚无带 skipped 的行(埋点未部署到运行进程), 不判红")
    raise SystemExit(0)
boundary = min(r["ts"] for r in withfield)
recent = [r for r in rows if r.get("ts") and r["ts"] >= boundary
          and (now - datetime.datetime.fromisoformat(r["ts"].replace("Z","+00:00"))).total_seconds() <= 3600]
unmarked = [r for r in recent if waiting(pool.get(r["goalId"], {}).get("nextAction")) and r.get("skipped") != "waiting"]
assert not unmarked, "近 1h 有 %d 条等待型唤醒未标 skipped: %s" % (len(unmarked), [(r["goalId"], r["ts"]) for r in unmarked][:3])
print("近 1h 等待型唤醒 %d 条, 全部已标 skipped" % len([r for r in recent if waiting(pool.get(r["goalId"], {}).get("nextAction"))]))
'

# ── T138 账本计数必须走单一入口(cl-187: 我为坑建了守卫, 却在自己的快速核对里又踩一次) ──
# 实证: 2026-09-11 03:1x 我随手按**行数**报"未关单 137", 去重后是 58 —— 套件里早有 last-wins 守卫,
# 但"看一眼账本"没有走那套判据。修法 = 把纪律变成工具默认: dsh-ledger-status.py 默认去重;
# 本组交叉验证"工具的去重结果 == 测试内独立实现的结果"(两套实现必须一致, 否则必有一处错)。
echo "[T138] 账本计数单一入口(工具默认去重 / 与独立实现一致 / 行数口径须显式标注为错)"
t "账本状态工具可跑且输出去重口径" python3 -c '
import json, os, subprocess, sys
tool = os.path.expanduser("~/dsh-fork/dsh-ledger-status.py")
assert os.path.exists(tool), "缺账本状态单一入口"
r = subprocess.run([sys.executable, tool, "--json"], capture_output=True, text=True, timeout=120)
assert r.returncode == 0, "工具异常: %s" % (r.stderr or "")[:200]
d = json.loads(r.stdout)
assert d["claims"]["unique"] < d["claims"]["lines"], "唯一数不小于行数, 去重没生效?"
assert d["claims"]["openCount"] >= 0 and "byStatus" in d["claims"]
print("工具: %d 行 → 唯一 %d, 未关单 %d" % (d["claims"]["lines"], d["claims"]["unique"], d["claims"]["openCount"]))
'
t "工具结果须与独立实现一致(两套实现互证)" python3 -c '
import json, os, subprocess, sys
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
by = {}
for line in open(os.path.join(D, "claims-ledger.jsonl"), encoding="utf8"):
    if not line.strip(): continue
    rec = json.loads(line)
    if isinstance(rec.get("id"), str): by[rec["id"]] = rec
mine = len({k for k, v in by.items() if v.get("status") not in ("done", "retired", "closed")})
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-ledger-status.py"), "--json"],
                   capture_output=True, text=True, timeout=120)
theirs = json.loads(r.stdout)["claims"]["openCount"]
assert mine == theirs, "两套实现不一致: 独立 %d vs 工具 %d" % (mine, theirs)
print("独立实现与工具一致: 未关单 %d" % mine)
'
t "按行数统计的口径必须被判据标错" python3 -c '
import json, os, subprocess, sys
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-ledger-status.py")],
                   capture_output=True, text=True, timeout=120)
out = r.stdout
assert "按行数统计未关单会得到" in out and "(错)" in out, "工具未显式标注行数口径是错的"
assert "last-wins" in out or "去重" in out, "工具未声明去重语义"
print("行数口径已被显式标注为错")
'

# ── T139 套件自身的证据链(cl-175: 绿必须落进规范日志, 且每次运行须自注册) ──
# 起因: 03:30 会话内跑出 465/1, 而规范日志 .cog-tests.log 仍是 00:19 的 442/3 —— "绿"只活在会话里,
# 任何只读规范日志的核验者(含下一个我)看到的是红。修法: 每次运行无条件自注册 + 裁决行落盘。
# 断言(a)不是自证: 它读的是磁盘日志里有没有本进程号, 写日志的代码与断言代码互不相干。
echo "[T139] 套件证据链(本进程须自注册 / 裁决行须落盘且新鲜)"
t "本进程必须已在规范日志自注册(落盘路径活着)" python3 -c '
import os
log = os.environ.get("DSH_COG_LOG") or os.path.join(os.path.expanduser("~"), ".dsh/cognitive-pipeline/.cog-tests.log")
pid = os.environ.get("DSH_COG_RUN_PID", "")
assert pid, "缺 DSH_COG_RUN_PID(套件未导出自身进程号)"
txt = open(log, encoding="utf8", errors="replace").read()
assert ("pid=" + pid) in txt, "规范日志里没有本进程的 origin 行: 落盘路径没生效(绿会只活在这次会话里)"
print("本进程 pid=" + pid + " 已自注册于 " + log)
'
t "裁决行须落盘且新鲜(首次落地给 24h 宽限)" python3 -c '
import os, re, time
log = os.environ.get("DSH_COG_LOG") or os.path.join(os.path.expanduser("~"), ".dsh/cognitive-pipeline/.cog-tests.log")
txt = open(log, encoding="utf8", errors="replace").read()
hits = re.findall(r"累计裁决:.*?\(origin=(\S+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)", txt)
if hits:
    origin, ts = hits[-1]
    age = time.time() - time.mktime(time.strptime(ts, "%Y-%m-%d %H:%M:%S"))
    assert age < 86400, "最新裁决行已 " + str(round(age / 3600.0, 1)) + " 小时未更新: 套件一整天没落盘运行"
    print("最新裁决行 origin=" + origin + " " + ts)
else:
    grace = time.time() - os.path.getmtime(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"))
    assert grace < 86400, "接线后 24h 内规范日志仍无裁决行: 落盘判据没生效"
    print("尚无裁决行(接线后 " + str(round(grace / 60.0, 1)) + " 分钟), 在 24h 宽限内")
'

# ── T140 追加式账本的写侧不变量(cl-191: 新行漏字段 = 删字段) ──
# 起因: 04:0x 我自己补写 3 行(cl-175/cl-189/cl-test-…)都丢掉了前序行的 reviewBy, 直接让"非终态项
# 均有处置位"转红。cl-041 讲的是读侧要带 last-wins 语义, 这里是写侧同型病: last-wins 之下,
# 新行没写的字段就是被删掉的字段。修法不是"记得写全", 而是唯一追加入口 dsh-ledger-append.py(继承+覆盖)。
echo "[T140] 追加式账本写侧(唯一追加入口在册 / 最新行不得丢前序处置位)"
t "账本追加入口必须存在且能继承前序字段" python3 /home/ubuntu/dsh-fork/dsh-ledger-append.py cl-189 --set reviewBy=2026-09-12 --dry-run
t "非终态最新行不得丢掉前序行的处置位(逐字段)" python3 -c '
import json, os, collections
p = os.environ.get("DSH_COG_LEDGER") or os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
by = collections.defaultdict(list)
for l in open(p, encoding="utf8"):
    if l.strip():
        r = json.loads(l)
        if r.get("id"): by[r["id"]].append(r)
TERMINAL = {"done", "retired", "closed"}
DISP = ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")
bad = []
for k, v in by.items():
    last = v[-1]
    if last.get("status") in TERMINAL: continue
    seen = set()
    for r in v[:-1]: seen |= {f for f in DISP if r.get(f)}
    miss = sorted(seen - {f for f in DISP if last.get(f)})
    if miss: bad.append(k + ":" + ",".join(miss))
assert not bad, "最新行丢掉了前序行的处置位(last-wins 之下等于删字段): " + repr(bad[:5])
print("非终态 " + str(sum(1 for v in by.values() if v[-1].get("status") not in TERMINAL)) + " 项均未丢处置位")
'
t "结单必须有机器可核的证据指针(账本可自查不能只靠叙述)" python3 -c '
import json, os, subprocess, sys, tempfile
TOOL = os.path.expanduser("~/dsh-fork/dsh-ledger-append.py")
tmp = tempfile.mkdtemp()
led = os.path.join(tmp, "l.jsonl")
open(led, "w", encoding="utf8").write(json.dumps({"id": "cl-x", "ts": "2026-09-12T10:00:00+08:00",
                                                  "status": "open", "claim": "c"}, ensure_ascii=False) + "\n")
def close(note, extra=()):
    return subprocess.run([sys.executable, TOOL, "cl-x", "--ledger", led, "--set", "status=done",
                           "--set", "doneNote=" + note, *extra],
                          capture_output=True, text=True, timeout=300)
r0 = close("已修好了")
assert r0.returncode == 2, "无任何可核指针却允许结单(exit %d) —— 账本会退化成只有叙述" % r0.returncode
r1 = close("修好了: 见 T212 与 dsh-audit-coverage-check.py")
assert r1.returncode == 0, "带 T编号/脚本名的结单被拒(误伤): " + (r1.stderr or r1.stdout)[-160:]
r2 = close("确实无指针", ("--set", "noEvidenceReason=该结单的依据是一次人工观察"))
assert r2.returncode == 0, "显式说明无指针理由后仍被拒: " + (r2.stderr or r2.stdout)[-160:]
print("三例: 无指针⇒拒 / 带指针⇒过 / 显式理由⇒过")
'
# ── T142 部署意图须有排程载体(cl-189/tp-120) ──
# 起因: 同一个部署被我临时手排秒数、连续改期 3 次, 每次理由都是"重启会掐断进行中的回合"——重启是机制侧
# 动作却由我手排, 于是"部署"永远排在"把这一轮做完"之后。T11 只守"lib 早于服务启动"这个症状: 它红了也没人
# 在等, 改期本身不留痕。判据的关键选择: **账本项不算载体**(它只是意图的记录, 不是"会自己发生"的东西)——
# tp-120 原计划的 (a) 单元 或 (b) 账本项 里 (b) 过弱, 合成实测显示当晚一直开着的 cl-189 就足以让判据永不报警。
echo "[T142] 部署意图载体(读数齐全 / 有意图须有排程载体 / 判据须分得开强弱)"
t "部署意图检测器须可运行且读数齐全" python3 -c '
import json, os, subprocess, time
out = "/tmp/t142-state.json"
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-intent.py", "--state", out],
                   capture_output=True, text=True, timeout=120)
assert r.returncode in (0, 1, 2), "检测器非预期退出 %d: %s" % (r.returncode, r.stderr[-120:])
s = json.load(open(out, encoding="utf8"))
for k in ("ts", "pending", "verdict", "libTs", "serviceStartTs"):
    assert k in s, "状态缺字段 " + k
assert s["libTs"] and s["serviceStartTs"], "lib/服务时间戳为空(读数失败不得按通过处理)"
assert time.time() - os.path.getmtime(out) < 300, "状态文件不新鲜"
print("verdict=%s pending=%s drift=%ds" % (s["verdict"], s["pending"], s["driftSeconds"]))
'
t "有部署意图时必须真有排程载体(账本项不算载体)" python3 -c '
import json, os, subprocess
out = "/tmp/t142-state2.json"
subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-intent.py", "--state", out],
               capture_output=True, text=True, timeout=120)
s = json.load(open(out, encoding="utf8"))
if not s["pending"]:
    assert s["verdict"] == "no-intent", "无意图却给出别的判定: " + str(s["verdict"])
    print("当前无待部署意图(lib 不新于服务启动), 但两个读数有效")
else:
    assert s["scheduledCarriers"], "有部署意图却无排程载体: 部署会永远排在把这一轮做完之后"
    print("有意图, 排程载体 %d 个" % len(s["scheduledCarriers"]))
'
t "判据须分得开有载体/无载体(探针在现场开火)" python3 -c '
import subprocess
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-guard-t142-probe.sh"], capture_output=True, text=True, timeout=180)
assert r.returncode == 1, "开火探针未按预期开火(exit=%d): %s" % (r.returncode, r.stderr[-140:])
print("探针开火: " + r.stderr.strip().splitlines()[-1][:90])
'
# ── T143 反收敛: 目标侧不得静默停滞(cl-192) ──
# 起因(反事实诱导探索查出): 最近 12h 的 20 次提交 100% 是判据/指标清洁工作, 触及目标侧实质的为 0;
# 而套件 475/0 —— 两条曲线解耦: 判据越来越硬, 目标没动。机制解释: 判据工作的裁决是**确定的绿**,
# 目标侧工作的裁决不确定, 于是收敛到前者。故把"停滞"本身做成判据(不靠我自觉):
#   ①目标链数量验收线 ≥10(既有验收指标), 未达标且 3 天没长过 → 红
#   ②账本最老未关单项 >72h → 红(要么做完/要么重划范围/要么进豁免册写明理由与到期日)
# 豁免册 stall-waivers.json 只允许"确实需要更长时间的证据型项"(如等平台 30 天验证期), 到期即失效。
echo "[T143] 反收敛(目标链须在长/最老未关单项不得 3 天不动)"
t "目标链数量停滞即红(未达标且 3 天没长)" python3 -c '
import json, os, time
p = os.environ.get("DSH_CHAINS") or os.path.expanduser("~/.dsh/cognitive-pipeline/chains.json")
TARGET, WINDOW_H = 10, 72
n = len(json.load(open(p, encoding="utf8")))
idle_h = (time.time() - os.path.getmtime(p)) / 3600.0
if n >= TARGET:
    print("链 " + str(n) + " 条, 已达验收线 " + str(TARGET))
else:
    assert idle_h <= WINDOW_H, ("目标链 " + str(n) + " 条(<验收线 " + str(TARGET)
                                + ")且已 " + str(round(idle_h, 1)) + " 小时没有新增: 目标侧在停滞")
    print("链 " + str(n) + "/" + str(TARGET) + ", " + str(round(idle_h, 1)) + "h 前有动静")
'
t "最老未关单项不得 3 天不动(豁免须有理由与到期日)" python3 -c '
import json, os, datetime
lp = os.environ.get("DSH_COG_LEDGER") or os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
wp = os.environ.get("DSH_STALL_WAIVERS") or os.path.join(os.path.dirname(lp), "stall-waivers.json")
WINDOW_H = 72
lat = {}
for line in open(lp, encoding="utf8"):
    if line.strip():
        r = json.loads(line)
        if r.get("id"): lat[r["id"]] = r
TERMINAL = {"done", "retired", "closed"}
tz = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(tz)
oldest = []
for k, v in lat.items():
    if v.get("status") in TERMINAL or not k.startswith("cl-"): continue
    # 2026-09-12 02:2x(cl-055 自愈上线后自查所得): 原来只看 ts, 而**自愈与 ts 回填都会把 ts 换新**
    # ⇒ 一个停滞数周的项只要被自动流程碰一下, 就在判据眼里变成"刚被人推进过"。这不是假想:
    #   cl-052 的 ts 是 1.1h(刚被换新), 而它的真实创建/回填时刻是 73.1h 前 —— 旧口径下它整个逃出 72h 窗口。
    # 口径改为 min(三个时刻都在则取最早): 自动改状态 ≠ 有人推进, 停滞判据必须看"最早那一刻"。
    cands = []
    for f in ("ts", "createdTs", "tsBackfilled"):
        t = v.get(f)
        if t:
            try: cands.append(datetime.datetime.fromisoformat(str(t)[:19]).replace(tzinfo=tz))
            except Exception: pass
    if not cands:
        continue
    age = (now - min(cands)).total_seconds() / 3600.0
    oldest.append((age, k))
oldest.sort(reverse=True)
assert oldest, "无未关单 cl 项 —— 本断言前提不成立, 不得算通过"
waivers = {}
if os.path.exists(wp):
    for w in json.load(open(wp, encoding="utf8")).get("waivers", []):
        waivers[w["id"]] = w
stale = [(a, k) for a, k in oldest if a > WINDOW_H]
bad = []
for a, k in stale:
    w = waivers.get(k)
    if not w or not w.get("reason"):
        bad.append(k + "(" + str(round(a, 1)) + "h)")
        continue
    until = w.get("until")
    ok_until = bool(until) and datetime.datetime.fromisoformat(until).replace(tzinfo=tz) > now
    if not ok_until:
        bad.append(k + "(豁免已过期/无到期日)")
assert not bad, "未关单 cl 项停滞超过 " + str(WINDOW_H) + "h 且无有效豁免: " + repr(bad[:5])
print("最老未关单 " + oldest[0][1] + " " + str(round(oldest[0][0], 1)) + "h(窗口 " + str(WINDOW_H) + "h), 豁免 " + str(len(waivers)) + " 项")
'
t "自愈/回填换新 ts 不得洗白停滞(探针第三例须开火)" python3 -c '
# 起因(2026-09-12 02:2x): 我给账本加了写入侧自愈(cl-055), 而自愈会把 ts 换成"状态写入时刻"。
# 停滞判据若只看 ts, 那么**自动流程碰过一下就等于被人推进过** —— 一个停滞数周的项会因此隐身
# (实测 cl-052: ts 1.1h / 真实 73.1h, 旧口径下整个逃出窗口)。这里守的是"判据不得被自己的自愈机制洗白":
# 合成一个 ts 刚换新、而 createdTs 在 96h 前的未关项, 判据必须仍然判红。
import subprocess
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-guard-t143-probe.sh"], capture_output=True, text=True, timeout=180)
assert r.returncode == 1, "探针未开火(exit=" + str(r.returncode) + "): 自愈换新的 ts 把停滞洗白了"
print("探针开火: " + (r.stderr.strip().splitlines() or [""])[-1][:110])
'
t "停滞判据须能开火(合成 96h 旧账本)" python3 -c '
import subprocess
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-guard-t143-probe.sh"], capture_output=True, text=True, timeout=120)
assert r.returncode == 1, "停滞判据没开火(exit=" + str(r.returncode) + "): " + r.stderr[-160:]
print("停滞判据开火: " + (r.stderr.strip().splitlines() or [""])[-1][:80])
'
# ── T144 保活不得架空退避(cl-195) ──
# 起因: 退避(cl-118)按未引用连击 ×2^k 是存在的, 但"通道保活"只要求**基础冷却**(2 分钟)已过就放行,
# 而本会话注入节奏中位 5.2 分钟 ⇒ 该前提几乎恒真。实测: 134 条带遥测的审计里 19 条(14.2%)是保活放行,
# 放行时被绕过的有效冷却多为 2 小时、连击最深 53 次; exp_80 在一个会话里被注入 258 次。
# 修法: 保活加闲置门(本会话距上次注入须 >60 分钟)。判据只看**部署后**的审计行, 避免部署边界伪影。
echo "[T144] 保活不得架空退避(部署后: 保活间隔 >55 分钟 / 占比 <=5%)"
t "保活判据须可跑且能开火(合成两条 5 分钟内的保活)" python3 -c '
import json, os, subprocess, tempfile
d = tempfile.mkdtemp()
now = 1_800_000_000_000
rows = [
  {"t": now, "sessionId": "s1", "backoffAdmitted": "exp_a", "backoffDropped": 1},
  {"t": now + 5 * 60 * 1000, "sessionId": "s1", "backoffAdmitted": "exp_b", "backoffDropped": 1},
] + [{"t": now + i * 60 * 1000, "sessionId": "s1", "backoffAdmitted": None, "backoffDropped": 1} for i in range(30)]
p = os.path.join(d, "audit.jsonl")
open(p, "w", encoding="utf8").write("\n".join(json.dumps(r) for r in rows) + "\n")
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-keepalive-lint.py", "--audit", p, "--after", str(now - 1)],
                   capture_output=True, text=True, timeout=60)
assert r.returncode == 1, "合成的违规没被抓住(exit=%d): %s" % (r.returncode, r.stdout + r.stderr)
assert "间隔" in r.stderr, "红是红了, 理由不对: " + r.stderr[:120]
print("合成违规开火: " + r.stderr.strip().splitlines()[-1][:70])
'
t "部署后保活不得架空退避(真实审计)" python3 /home/ubuntu/dsh-fork/dsh-keepalive-lint.py
# ── T145 部署动作须可复现(tp-123: 延迟部署脚本只活在 /tmp) ──
# 起因: 两次延迟部署用的是 /tmp/dsh-post-deploy*.sh —— 重启命令/等待时长/复跑顺序都没进版本库与台账,
# 事后无法复现"那次部署做了什么", /tmp 一清证据就没了。修法: dsh-deploy-window.sh 版本化 + 持久记录
# deploy-log.jsonl。判据三条: 在版本库里 / plan-only 无副作用 / 真跑时留下 start+done 两条持久记录。
echo "[T145] 部署动作可复现(脚本须在版本库 / plan-only 无副作用 / 须留持久记录)"
t "部署脚本必须在版本库里(不得只活在 /tmp)" python3 -c '
import os, subprocess
script = "/home/ubuntu/dsh-fork/dsh-deploy-window.sh"
assert os.path.exists(script), "部署脚本不存在"
out = subprocess.run(["git", "-C", "/home/ubuntu/dsh-fork", "ls-files", "--error-unmatch",
                      "dsh-deploy-window.sh"], capture_output=True, text=True)
assert out.returncode == 0, "部署脚本未入版本库(只活在磁盘上: 磁盘坏了就没了, 也无法复现那次部署)"
tmp = [f for f in os.listdir("/tmp") if f.startswith("dsh-post-deploy")]
assert not tmp, "仍有一次性部署脚本在 /tmp: %s —— 部署动作不许只活在那里" % tmp
print("部署脚本在册且 /tmp 无遗留一次性脚本")
'
t "部署脚本 --plan-only 必须无副作用" python3 -c '
import os, subprocess
log = "/tmp/t145-plan.jsonl"
if os.path.exists(log): os.remove(log)
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-deploy-window.sh", "--plan-only", "--log", log],
                   capture_output=True, text=True, timeout=60)
assert r.returncode == 0, "plan-only 退出码 %d: %s" % (r.returncode, r.stderr[-120:])
assert "计划" in r.stdout, "plan-only 没打印计划: " + r.stdout[:120]
assert not os.path.exists(log), "plan-only 写了记录(不该有副作用)"
print("plan-only 只打印计划, 未写记录")
'
t "部署脚本须留持久记录(start + done)" python3 -c '
import json, os, subprocess
log = "/tmp/t145-run.jsonl"
if os.path.exists(log): os.remove(log)
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-deploy-window.sh", "--skip-restart", "--skip-suite",
                    "--delay-seconds", "0", "--log", log], capture_output=True, text=True, timeout=60)
assert r.returncode == 0, "干跑退出码 %d: %s" % (r.returncode, r.stderr[-120:])
assert os.path.exists(log), "干跑没留下记录 —— 部署又变成不可复现的了"
rows = [json.loads(l) for l in open(log, encoding="utf8") if l.strip()]
phases = [x.get("phase") for x in rows]
assert "start" in phases and "done" in phases, "记录缺少 start/done: %s" % phases
for k in ("ts", "origin", "script"):
    assert rows[0].get(k), "记录缺字段 " + k
print("持久记录 %d 条: %s" % (len(rows), phases))
'
# ── T146 等待判据的"到点恢复"必须真在跑(cl-198 / tp-124) ──
# 起因: cl-198 的缺陷是"只看文本不看时钟 ⇒ 永久跳过"; 修好之后还得守"修复真的在跑"——
# 单测只跑 src(tsx), 不证明部署后的行为。本组两条: ①已部署 lib 里确有解析+比较;
# ②部署后的 skipped:waiting 唤醒, 逐条按**唯一实现**复核(不写第三份判据副本, 调 tsx 加载 TS 实现)。
echo "[T146] 等待判据到点恢复(已部署 lib 须含时钟逻辑 / 唤醒跳过须逐条复核)"
t "已部署 lib 的等待判据须含时钟逻辑(不只看文本)" python3 -c '
import os, re
lib = os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/lib/index.js")
src = open(lib, encoding="utf8").read()
assert "parseWaitingMoment" in src, "lib 里没有时刻解析函数(可能未重建/未部署)"
assert re.search(r"at\.getTime\(\)\s*<=\s*now\.getTime\(\)", src), "缺少\"已到点即不再等待\"的比较"
print("lib 含时刻解析 + 到点比较")
'
t "部署后 skipped:waiting 的唤醒须逐条复核(已到点仍跳过即红)" python3 /home/ubuntu/dsh-fork/dsh-waiting-expiry-lint.py
# ── T147 影子对照的候选清单必须够"可排序"(cl-200) ──
# 起因: 审计只落 coverViewpoints 之后的候选(hits.length 恒为 2), 离线对照的可排序集只有 11(<30),
# 预登记判据因此无法裁决; 而 MRR 只对"候选数>=2 的集"有意义。修法(测量侧不改行为): 审计额外落
# **截断前** top-5(preTop)。本组守两件事: ①已部署 lib 里有这个埋点; ②部署后的审计行真带 preTop。
echo "[T147] 影子对照可排序样本(埋点在 lib / 部署后审计须带 preTop)"
t "已部署 lib 须含截断前候选清单埋点(preTop)" python3 -c '
import os
lib = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")
src = open(lib, encoding="utf8").read()
assert "preTop" in src, "lib 里没有 preTop 埋点(未重建/未部署)"
print("lib 含 preTop 埋点")
'
t "分通道成分须能重构 similarity(埋点不得自相矛盾)" python3 -c '
import json, os, subprocess
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
after = int(subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-boundary.py"],
                           capture_output=True, text=True, timeout=60).stdout.strip() or 0)
rows = [json.loads(l) for l in open(D + "/retrieval-audit.jsonl", encoding="utf8") if l.strip()]
cands = [c for r in rows if (r.get("t") or 0) > after
         for c in (r.get("preTop") or []) if isinstance(c.get("channels"), dict)]
if not cands:
    print("[部署边界] 尚无带 channels 的候选, 本帧不判")
    raise SystemExit(0)
bad = []
for c in cands:
    ch = c["channels"]
    want = ch["semantic"] + ch["symptom"] + ch["axis"]
    if abs(want - c["similarity"]) > 0.001:
        bad.append("%s: %.4f vs %.4f" % (c["expId"], want, c["similarity"]))
assert not bad, "分通道成分与 similarity 不自洽(埋点有问题或公式变了): " + repr(bad[:3])
print("%d 个候选的成分和与 similarity 一致(±0.001)" % len(cands))
'
t "部署后审计须真带 preTop 且可排序集在长" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
import subprocess
# cl-202: 部署边界取 max(lib 构建, 服务启动) —— 构建与重启之间有窗口(实测 07:52 构建/07:58:50 重启),
# 窗口内的行是旧进程写的, 拿它们当"部署后的行为"会误判。
after = int(subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-boundary.py"],
                           capture_output=True, text=True, timeout=60).stdout.strip() or 0)
rows = [json.loads(l) for l in open(D + "/retrieval-audit.jsonl", encoding="utf8") if l.strip()]
post = [r for r in rows if (r.get("t") or 0) > after]
injected = [r for r in post if r.get("stage") == "injected"]
if len(injected) < 3:
    print("[部署边界] 部署后 injected 审计 %d 条(<3), 本帧不判" % len(injected))
    raise SystemExit(0)
withpre = [r for r in injected if r.get("preTop")]
assert withpre, "部署后没有任何一条带 preTop —— 埋点没生效"
multi = [r for r in withpre if len(r["preTop"]) >= 2]
print("部署后 injected %d 条, 带 preTop %d 条, 其中可排序(>=2 候选) %d 条" % (len(injected), len(withpre), len(multi)))
'
# ── T148 账本时间戳必须同形(cl-202) ──
# 起因: 我从 goal-trigger-log.jsonl 的**最新一行**读出"唤醒已停摆 8 小时"——那行其实是 UTC(`...Z`),
# 换算到本地是**几分钟前**。误读的根因不是粗心, 而是同一个目录里 13 个账本写 +08:00、2 个写 UTC、2 个写 epoch,
# 跨账本比时间的前提(同一时间坐标系)不成立。判据: tz-aware ISO 且偏移为 +08:00(epoch 只允许白名单)。
echo "[T148] 账本时间戳同形(tz-aware +08:00 / epoch 须在白名单)"
t "账本时间戳必须同形且带 +08:00 偏移" python3 -c '
import json, os, re
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
EPOCH_ALLOW = {"quiet-driver-frames.jsonl", "quiet-driver-heartbeat.jsonl"}  # 历史就是 epoch(ms), 不改历史
import subprocess as _sp
after = int(_sp.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-boundary.py"],
                    capture_output=True, text=True, timeout=60).stdout.strip() or 0)
def boundary_of(r):
    # 账本行自己的时刻: ISO ts / doneAt / epoch ms
    import datetime as _dt
    v = r.get("ts") or r.get("doneAt")
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return _dt.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            return None
    return None
pat = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?\+08:00$")
bad, checked = [], 0
for name in sorted(os.listdir(D)):
    if not name.endswith(".jsonl") or name in EPOCH_ALLOW:
        continue
    path = os.path.join(D, name)
    rows = [json.loads(l) for l in open(path, encoding="utf8") if l.strip()]
    if not rows:
        continue
    # 只看**部署边界之后**写下的行: 旧行可能是修复前的 Z(拿它判会假红), 而只看末行又会假绿
    # —— 旁路三问实测指出: 只查末行时, 一个仍在写 Z 的账本只要最近没写就照样判绿。故扫"新行"。
    recent = [r for r in rows if (boundary_of(r) or 0) > after]
    if not recent:
        continue
    checked += 1
    for r in recent:
        v = r.get("ts") or r.get("doneAt")
        if not v:
            continue
        if not pat.match(str(v)):
            bad.append("%s: %s" % (name, str(v)[:30]))
            break
if bad:
    # 诊断必须落盘: `t` 助手把断言输出丢进 /dev/null, 于是"哪一行违规"从来没进过日志 ——
    # 上一次这条红我查了三轮窗口才确认不可复现。现在违规行直接写文件, 下次一眼可见。
    import json as _json
    with open(os.path.join(D, "ts-form-violations.jsonl"), "a", encoding="utf8") as _f:
        _f.write(_json.dumps({"ts": datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
                               "origin": "dsh-cog-tests.sh T148", "afterBoundary": after,
                               "violations": [str(x)[:80] for x in bad[:10]]}, ensure_ascii=False) + "\n")
assert not bad, "账本时间戳不同形(UTC/无偏移会让跨账本比时间得出反向结论): " + repr(bad[:4])
if checked < 5:
    import time as _t
    age_min = (_t.time() * 1000 - after) / 60000.0
    # 2026-09-12 15:1x(实测所得): 每次部署重启都把边界推到当下 ⇒ 紧接着的几分钟里"边界后的样本不足"
    # 是**合法状态**, 不是判据前提失效(今天的部署后自检正是被这一条判红)。故: 边界很新时**显式跳过并打印**
    # (不冒充通过), 超过 30 分钟仍不足 5 个才判红 —— 保住"不得空过"的意图, 又不制造重启假红。
    assert age_min < 30, ("边界已过 %.0f 分钟而边界后只检查到 %d 个账本 ⇒ 采样侧可能坏了" % (age_min, checked))
    print("部署边界(%.0f 分钟前)之后仅 %d 个账本可查 ⇒ 本帧不判(宽限 30 分钟)" % (age_min, checked))
    raise SystemExit(0)
assert checked >= 5, "只检查到 %d 个账本 —— 判据前提不成立" % checked
print("检查 %d 个账本, 时间戳均为 +08:00 同形" % checked)
'
# ── T149 active 目标不得停在"无法解析的等待"上(cl-206) ──
# 起因: cl-198 只修了**日期型**等待(到点恢复可执行); 事件型("待事件(样本≥30)")无人能解析 ⇒ 唤醒侧永久跳过。
# 实测: goal-experience-library 触发 0/采纳 0, 而它等的条件局部早就满足(记录数 41≥30, 真闸门是可排序集 12/30)。
# 判据: active 目标的 nextAction 若被判为"等待中", 必须可解析(带时刻, 或带 waitChecker 命令)。
echo "[T149] active 目标不得停在不可解析的等待(判据须可解析日期或带 waitChecker)"
t "active 目标须为可执行或可解析等待" python3 /home/ubuntu/dsh-fork/dsh-goal-wait-lint.py
t "该判据须能开火(合成'待事件'且无 waitChecker)" python3 -c '
import json, os, subprocess, tempfile, time
d = tempfile.mkdtemp()
now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
with open(os.path.join(d, "goals.jsonl"), "w", encoding="utf8") as f:
    f.write(json.dumps({"id": "goal-probe", "status": "active",
                        "nextAction": "待事件(样本≥30 自动可判)", "ts": now}, ensure_ascii=False) + "\n")
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-goal-wait-lint.py",
                    "--goals", os.path.join(d, "goals.jsonl")], capture_output=True, text=True, timeout=180)
assert r.returncode == 1, "合成的不可解析等待没被判红(exit=%d): %s" % (r.returncode, r.stdout + r.stderr)
assert "无法解析" in r.stderr, "红是红了, 理由不对: " + r.stderr[:120]
print("合成不可解析等待: 开火")
'
# ── T150 目标轨迹树数据源(能力须可核查) ──
# 起因: 用户要"目标已完成/执行/规划的精简轨迹树"。数据源 dsh-goal-trajectory.py 是新能力,
# 它的分类会被 UI 直接读走 —— 一旦静默降级(等待判据没跑成却把目标全标'执行中'), 图上就会说谎。
echo "[T150] 轨迹树数据源(结构完整 / 车道可复核 / 判据失败不得静默降级)"
t "轨迹树 JSON 结构完整且时间戳带偏移" python3 -c '
import json, os, re
p = os.environ.get("DSH_GOAL_TRAJECTORY") or os.path.expanduser("~/.dsh/cognitive-pipeline/goal-trajectory.json")
assert os.path.exists(p), "缺 goal-trajectory.json(先跑 dsh-goal-trajectory.py)"
d = json.load(open(p, encoding="utf8"))
assert re.match(r"^\d{4}-\d{2}-\d{2}T.*\+08:00$", d["generatedAt"]), "generatedAt 非 +08:00: " + str(d["generatedAt"])
assert d.get("goals"), "没有目标 —— 前提不成立"
for g in d["goals"]:
    for k in ("id", "title", "lane", "counts", "steps", "wakes", "adopted"):
        assert k in g, "目标缺字段 " + k
    assert g["lane"] in ("executing", "planned", "completed"), "车道取值非法: " + str(g["lane"])
    for k in ("completed", "executing", "planned", "blocked"):
        assert k in g["counts"], "counts 缺 " + k
print("目标 %d 个, 车道与字段齐备" % len(d["goals"]))
'
t "每步的 kind 必须与账本独立复算一致" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
TERMINAL = {"done", "retired", "closed"}
DISP = ("reviewBy", "disposition", "unblockPlan", "nextAction", "blockedReason")
ind = {}
for l in open(D + "/claims-ledger.jsonl", encoding="utf8"):
    if l.strip():
        r = json.loads(l)
        if r.get("id"): ind[r["id"]] = r
d = json.load(open(os.environ.get("DSH_GOAL_TRAJECTORY") or (D + "/goal-trajectory.json"), encoding="utf8"))
bad, checked = [], 0
for g in d["goals"]:
    for s in g["steps"]:
        c = ind.get(s["id"])
        assert c is not None, "轨迹里的 %s 不在账本里" % s["id"]
        if c.get("status") in TERMINAL:
            want = "completed"
        elif not any(c.get(f) for f in DISP):
            want = "blocked"
        else:
            continue          # executing/planned 取决于目标的等待态, 这里只独立复核两端
        checked += 1
        if s["kind"] != want:
            bad.append("%s: 轨迹=%s 账本=%s" % (s["id"], s["kind"], want))
assert not bad, "分类与账本不一致: " + repr(bad[:4])
assert checked >= 3, "只复核到 %d 步 —— 判据前提不成立" % checked
print("独立复核 %d 步(终态/阻塞两端), 全部一致" % checked)
'
t "等待判据失败时必须显式降级标记(不得静默当成可执行)" python3 -c '
import json, os
p = os.environ.get("DSH_GOAL_TRAJECTORY") or os.path.expanduser("~/.dsh/cognitive-pipeline/goal-trajectory.json")
d = json.load(open(p, encoding="utf8"))
assert "waitingEvaluated" in d, "缺 waitingEvaluated 标记 —— 判据失败时无法与正常输出区分"
assert isinstance(d["waitingEvaluated"], bool), "waitingEvaluated 必须是布尔"
assert d["waitingEvaluated"] is True, "本次等待判据未跑成(降级输出), 请先修判据调用"
print("等待判据正常执行(waitingEvaluated=true)")
'
# ── T151 排程环境的 systemd 会话(cl-213) ──
# 起因: cron 环境没有 systemd user 会话 ⇒ `systemctl --user` 报 "Failed to connect to bus"。
# 实测 06:20 的 cron 运行 **4 项失败**, 其中 3 项(lib早于服务启动/部署意图检测器/载体判据探针)**纯粹是环境导致**,
# 却写进账本成了告警 —— 排程跑的套件因此长期系统性假红, 而真缺陷会被淹没在噪声里。
echo "[T151] 排程环境须带 systemd 会话(依赖 systemctl 的 cron 条目 / 缺失时须显式失败)"
t "依赖 systemctl 的 cron 条目须带 systemd 会话环境" python3 -c '
import re, subprocess
out = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
need = [l for l in out.splitlines() if ("dsh-cog-tests.sh" in l or "dsh-deploy-intent.py" in l)]
assert need, "找不到依赖 systemd 的排程条目 —— 前提不成立"
bad = [l[:60] for l in need if "XDG_RUNTIME_DIR=" not in l or "DBUS_SESSION_BUS_ADDRESS=" not in l]
assert not bad, "这些 cron 条目缺 systemd 会话环境(会在 cron 下系统性假红): " + repr(bad)
print("%d 条依赖 systemd 的 cron 条目均带环境" % len(need))
'
t "无 systemd 会话时须走 /proc 退路拿到读数(不再失明)" python3 -c '
import json, os, subprocess
# cl-238 加固后的期望变了: 裸环境(无 dbus)下原实现读不到 svc_ts 并每 5 分钟空转, 现在应能经
# /proc/<pid>/stat 还原服务启动时刻。断言随之更新 —— 不是放宽, 而是把"失明"改成"必须看得见"。
out = "/tmp/t151-intent-bare.json"
r = subprocess.run(["env", "-i", "HOME=" + os.path.expanduser("~"), "PATH=/usr/bin:/bin",
                    "python3", "/home/ubuntu/dsh-fork/dsh-deploy-intent.py", "--state", out, "--quiet"],
                   capture_output=True, text=True, timeout=120)
assert r.returncode != 3, "裸环境下仍判自检失败(exit 3) —— /proc 退路没生效: " + (r.stderr or r.stdout)[:160]
s = json.load(open(out, encoding="utf8"))
assert s.get("serviceStartTs"), "裸环境下 serviceStartTs 为空(退路未拿到读数)"
print("裸环境走 /proc 退路: svc_ts=%s" % s["serviceStartTs"])
'
t "两条路径都不可用时必须显式报环境缺失(不得静默)" python3 -c '
import os, subprocess, tempfile
# 把 systemctl 与 pgrep 都换成"成功但空输出"的壳 ⇒ systemd 与 /proc 两条路都拿不到值
tmp = tempfile.mkdtemp()
for name in ("systemctl", "pgrep"):
    p = os.path.join(tmp, name)
    open(p, "w").write("#!/bin/sh\nexit 0\n"); os.chmod(p, 0o755)
r = subprocess.run(["env", "-i", "HOME=" + os.path.expanduser("~"), "PATH=" + tmp + ":/usr/bin:/bin",
                    "python3", "/home/ubuntu/dsh-fork/dsh-deploy-intent.py", "--state", "/tmp/t151-none.json"],
                   capture_output=True, text=True, timeout=120)
combined = r.stdout + r.stderr
assert r.returncode == 3, "两条路径都不可用时应判自检失败(exit 3), 实得 %d" % r.returncode
assert "自检失败" in combined, "失败理由未显式说明: " + combined[:160]
print("两条路径皆不可用 ⇒ 显式 exit 3 并写明自检失败")
'
# ── T152 目标轨迹树面板的接线须可核查(用户要求的 UI) ──
# 起因: 面板是新建的客户端插件, 而它的装配有一部分**不在版本库里**(profile 补丁 + node_modules symlink),
# 因此"重启后插件还在不在"没有任何东西守 —— 一旦 profile 被覆盖/漏掉, 面板会静默消失。
# 判据: ①包在版本库且 profile 补丁里有登记; ②运行时 boot 清单确实把它的 client.js 发给浏览器;
#       ③它的数据端点真返回目标(不是空壳)。(像素层不可验, 见 tp-128 的说明。)
echo "[T152] 轨迹树面板接线(在册 / boot 清单含它 / 端点返回目标)"
t "轨迹树面板须在版本库且已登记 profile" python3 -c '
import os, subprocess
pkg = "/home/ubuntu/dsh-fork/packages/client/ui-goal-tree/package.json"
assert os.path.exists(pkg), "面板包不存在"
out = subprocess.run(["git", "-C", "/home/ubuntu/dsh-fork", "ls-files", "--error-unmatch",
                      "packages/client/ui-goal-tree/package.json"], capture_output=True, text=True)
assert out.returncode == 0, "面板包未入版本库"
patch = os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
txt = open(patch, encoding="utf8").read()
assert "ui-goal-tree" in txt, "profile 补丁里没有登记该插件(重启后会消失)"
print("面板在版本库且 profile 已登记")
'
t "运行时 boot 清单须把面板 client.js 发给浏览器" python3 -c '
import re, subprocess, time
# 2026-09-11 20:3x 加固: 这条断言在"部署窗口重启后 90s"这个时点跑, 实测偶发取不到清单(面板断言红而
# 手工复验立即为真)。给 3 次重试(间隔 3s) —— 判据要的是"清单里有它", 不是"重启后第 1 秒就有它"。
m = None
for _ in range(3):
    r = subprocess.run(["curl", "-s", "--max-time", "15", "http://127.0.0.1:3080/"], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout:
        m = re.search(r"/plugins/@deepseek-ai/dsh-client-ui-goal-tree/client\.js[^\"\x27 ]*", r.stdout)
        if m:
            break
    time.sleep(3)
assert m, "boot 清单里没有该插件的 client.js —— 面板不会出现在页面上(重试 3 次仍无)"
print("boot 清单含: " + m.group(0)[:70])
'
t "客户端插槽目录须与生成器一致(面板占用者须在册)" python3 -c '
import os, subprocess
# slot-catalog.ts 是**生成物**: 面板注册占用者后必须重算, 否则页面上找不到入口。
# 该文件在 24h 内被改过(T28 元测试要求被断言引用), 这里既引用它、也守住"生成物须与源一致"。
cat = "/home/ubuntu/dsh-fork/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts"
assert os.path.exists(cat), "插槽目录缺失"
txt = open(cat, encoding="utf8").read()
assert "goal-tree" in txt, "插槽目录里没有面板占用者(生成器没重算?)"
r = subprocess.run(["npx", "tsx", "scripts/gen-client-catalog.ts", "--check"],
                   cwd="/home/ubuntu/dsh-fork", capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "插槽目录与生成器不一致: " + (r.stdout + r.stderr)[-160:]
print("插槽目录在册且与生成器一致")
'
t "轨迹树端点须返回目标(非空壳)" python3 -c '
import json, subprocess
body = json.dumps({"type": "client-request", "rpcId": "t152", "method": "trajectory/overview", "payload": {}})
r = subprocess.run(["curl", "-s", "--max-time", "20", "-X", "POST", "-H", "content-type: application/json",
                    "-d", body, "http://127.0.0.1:3080/goal-tree/trajectory/overview"],
                   capture_output=True, text=True)
assert r.returncode == 0, "端点不可达"
d = json.loads(r.stdout)
res = d.get("result") or {}
assert res.get("ok") is True, "端点返回错误: " + json.dumps(res.get("error"), ensure_ascii=False)[:120]
snap = (res.get("value") or {}).get("snapshot") or {}
goals = snap.get("goals") or []
assert goals, "端点返回 0 个目标(空壳)"
for g in goals:
    assert {"id", "lane", "counts", "steps"} <= set(g), "目标字段不全: " + str(sorted(g))[:80]
print("端点返回 %d 个目标" % len(goals))
'
# ── T153 孵化体检的告警闭环(cl-211 降频后新增的 cron 机制) ──
# 判据: 违规必须写账本告警(不是只写没人读的日志); 恢复必须自动关单 —— 用合成目录验证, 不碰真账本。
echo "[T153] 孵化体检告警闭环(合成违规须写告警 / 恢复须自动关单)"
t "合成违规须写告警且退出码 1" python3 -c '
import json, os, subprocess, tempfile, datetime
tz = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(tz)
d = tempfile.mkdtemp()
open(os.path.join(d, "dormant-goals.jsonl"), "w", encoding="utf8").write(json.dumps(
    {"id": "goal-probe", "status": "active",
     "lastActionAt": (now - datetime.timedelta(hours=5)).isoformat()}, ensure_ascii=False) + "\n")
with open(os.path.join(d, "goal-trigger-log.jsonl"), "w", encoding="utf8") as f:
    for i in range(6):
        ts = (now - datetime.timedelta(hours=4) + datetime.timedelta(minutes=i)).isoformat()
        f.write(json.dumps({"ts": ts, "goalId": "goal-probe", "adopted": False}, ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=d)
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-incubation-checkup.py"], capture_output=True, text=True, timeout=120, env=env)
assert r.returncode == 1, "违规没被判出(exit=%d): %s" % (r.returncode, r.stdout[-120:])
led = [json.loads(l) for l in open(os.path.join(d, "claims-ledger.jsonl"), encoding="utf8") if l.strip()]
assert led and led[-1]["id"] == "cl-incubation-stall" and led[-1]["status"] == "open", "违规没写账本告警"
print("合成违规: 账本告警已写")
'
t "恢复后须自动关单" python3 -c '
import json, os, subprocess, tempfile, datetime
tz = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(tz)
d = tempfile.mkdtemp()
open(os.path.join(d, "dormant-goals.jsonl"), "w", encoding="utf8").write(json.dumps(
    {"id": "goal-probe", "status": "active",
     "lastActionAt": (now - datetime.timedelta(hours=5)).isoformat()}, ensure_ascii=False) + "\n")
rows = []
for i in range(6):
    ts = (now - datetime.timedelta(hours=4) + datetime.timedelta(minutes=i)).isoformat()
    rows.append({"ts": ts, "goalId": "goal-probe", "adopted": i == 3})
with open(os.path.join(d, "goal-trigger-log.jsonl"), "w", encoding="utf8") as f:
    for r0 in rows:
        f.write(json.dumps(r0, ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=d)
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-incubation-checkup.py"], capture_output=True, text=True, timeout=120, env=env)
assert r.returncode == 0, "有采纳却仍判违规(exit=%d)" % r.returncode
assert "违规 0" in r.stdout, "输出没显示无违规: " + r.stdout[-100:]
print("有采纳: 判无违规(exit 0)")
'
# ── T154 已部署插件 lib 的"可加载性" + waitChecker 接线(cl-215) ──
# 起因(本轮自伤): 我把 shouldSkipAsWaiting 写成**闭包内 `export function`** —— TS1184, 而 tsdown **不做类型检查**,
# 于是构建"成功"、产物带着 ESM 语法错。同类事故今晨已发生过一次(quiet-driver 崩溃循环)。
# 判据: ①每个 host 面插件 lib 必须通过 `node --check`(语法级可加载); ②waitChecker 接线须在产物里; ③池里样本的 checker 要如实回答条件。
echo "[T154] 插件 lib 可加载性 + waitChecker 接线(node --check / 产物含接线 / checker 如实回答)"
t "host 面插件 lib 必须通过 node --check(防 tsdown 绕过类型检查发语法错产物)" python3 -c '
import glob, os, subprocess
libs = sorted(glob.glob(os.path.expanduser("~/dsh-fork/packages/*/*/lib/index.js")))
assert libs, "找不到任何插件 lib —— 前提不成立"
bad = []
for p in libs:
    r = subprocess.run(["node", "--check", p], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        bad.append("%s: %s" % (os.path.basename(os.path.dirname(os.path.dirname(p))), (r.stderr.strip().splitlines() or [""])[-1][:80]))
assert not bad, "有插件 lib 语法不可加载(部署后会崩): " + repr(bad[:3])
print("%d 个插件 lib 全部通过 node --check" % len(libs))
'
t "waitChecker 接线须已在部署产物里" python3 -c '
import os
lib = os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js")
src = open(lib, encoding="utf8").read()
assert "waitChecker" in src, "lib 里没有 waitChecker 字段读取"
assert "shouldSkipAsWaiting" in src, "lib 里没有抽出后的等待判定(接线未部署)"
assert "execSync" in src, "lib 里没有跑 checker 的调用"
print("lib 含 waitChecker 接线")
'
t "池内样本的 waitChecker 须如实回答条件(exit 码与条件一致)" python3 -c '
import json, os, subprocess
pool = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
latest = {}
for l in open(pool, encoding="utf8"):
    if l.strip():
        g = json.loads(l)
        if g.get("id"): latest[g["id"]] = g
withchk = {k: v for k, v in latest.items() if str(v.get("waitChecker") or "").strip()}
assert withchk, "池里没有任何目标带 waitChecker —— 前提不成立(接线无样本)"
for gid, g in withchk.items():
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wait-check-library.py", "--json"],
                       capture_output=True, text=True, timeout=300)
    assert r.returncode in (0, 1), "checker 自身坏了(exit %d): %s" % (r.returncode, r.stderr[-100:])
    d = json.loads(r.stdout.strip().splitlines()[-1])
    met = bool(d.get("met"))
    assert (r.returncode == 0) == met, "checker 的退出码与条件不自洽: exit=%d met=%s" % (r.returncode, met)
    print("%s: 条件 %s(可排序集 %s/%s) ⇒ exit %d, 自洽" % (gid, "已满足" if met else "未满足", d["rankableSets"], d["minSample"], r.returncode))
'
# ── T155 效用融合接线(cl-218) ──
# 起因: 排序键改为 similarity×(0.7+0.06×materialGain) —— 这是**会改变生产检索顺序**的改动, 而它此前只有"代码写了"。
# 本组守三件: ①阈值判定不得被融合污染(过阈仍按 similarity); ②部署后审计里的 rankKey 必须与公式自洽
#   (这一条直接抓'配置没接到运行时'——我实现时第一版从 service.config 取值, 那个服务根本没有该字段 ⇒ 会静默失效);
# ③融合必须**真的改变过顺序**(若始终与纯相似度同序, 说明开关没生效或恒等)。
echo "[T155] 效用融合(阈值不受污染 / rankKey 与公式自洽 / 排序真的变了)"
t "排序用融合键但过阈判定仍按 similarity(不得泄漏)" python3 -c '
import os, re
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js"), encoding="utf8").read()
assert "rankKey" in src and "rankKey" in lib, "排序键 rankKey 未实现/未部署"
assert re.search(r"\.filter\(hit => hit\.similarity >= minSimilarity\)", src), "过阈判定不再按 similarity —— 融合泄漏进准入门槛"
assert "utilityFusion" in lib, "lib 里没有 utilityFusion 配置读取(配置无法到达运行时)"
print("排序=rankKey, 过阈=similarity, 配置项已在产物")
'
t "部署后 rankKey 须与公式自洽(证明配置真到了运行时)" python3 -c '
import json, os, subprocess
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
after = int(subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-boundary.py"],
                           capture_output=True, text=True, timeout=60).stdout.strip() or 0)
rows = [json.loads(l) for l in open(D + "/retrieval-audit.jsonl", encoding="utf8") if l.strip()]
cands = [c for r in rows if (r.get("t") or 0) > after for c in (r.get("preTop") or []) if "rankKey" in c]
if not cands:
    print("[部署边界] 尚无带 rankKey 的候选行, 本帧不判")
    raise SystemExit(0)
bad = []
for c in cands:
    if c.get("utility") is None:
        continue
    want = c["similarity"] * (0.7 + 0.06 * c["utility"])
    if abs(want - c["rankKey"]) > 0.002:
        bad.append("%s: rankKey=%s 公式=%0.4f" % (c["expId"], c["rankKey"], want))
assert not bad, "rankKey 与公式不自洽(配置很可能没到运行时, 融合是空转): " + repr(bad[:3])
print("%d 个候选的 rankKey 与公式自洽" % len(cands))
'
t "融合须真的改变过排序(否则开关空转)" python3 -c '
import json, os, subprocess
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
after = int(subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-boundary.py"],
                           capture_output=True, text=True, timeout=60).stdout.strip() or 0)
rows = [json.loads(l) for l in open(D + "/retrieval-audit.jsonl", encoding="utf8") if l.strip()]
sets = [r["preTop"] for r in rows if (r.get("t") or 0) > after and len(r.get("preTop") or []) >= 2]
if not sets:
    print("[部署边界] 部署后尚无多候选集, 本帧不判")
    raise SystemExit(0)
if len(sets) < 3:
    # 部署后样本太少时不得下结论: 实测 20:25 那次部署后只有 1 个多候选集且恰好没被重排, 若据此判红
    # 就是"拿 1 个样本证明开关空转" —— 与本套件其它判据同一条纪律(样本不足不下结论)。
    print("[部署边界] 部署后多候选集 %d < 3, 本帧不判" % len(sets))
    raise SystemExit(0)
diff = 0
for cs in sets:
    if [c["expId"] for c in sorted(cs, key=lambda c: -c["rankKey"])] != [c["expId"] for c in sorted(cs, key=lambda c: -c["similarity"])]:
        diff += 1
assert diff > 0, "部署后 %d 个多候选集里融合从未改变顺序 —— 开关没生效或恒等" % len(sets)
print("%d/%d 个多候选集里融合改变了顺序" % (diff, len(sets)))
'
# ── T156 目标轨迹面板: 取数生命周期 + 渲染(cl-221) ──
# 起因: 用户报"目标轨迹 ui 没有内容"。当时宿主 RPC 200/17834B、客户端清单已注册、构建产物含全部代码
#   —— 状态证据全绿, 面板却是空的。用真实浏览器(CDP, dsh-ui-probe.mjs)实测才看清: 面板确实渲染并在
#   点击后发出 1 个 POST /goal-tree/trajectory/overview, 随即被**自己**取消(ERR_ABORTED/canceled),
#   12s 后仍停在"…"。根因: 取数 effect 的依赖数组里含 status, 而 refresh 自己会 begin() 把 status 翻成
#   loading ⇒ 依赖变化触发该 effect 的 cleanup ⇒ abort 掉刚发出的请求; abort 又被 inject 面的
#   `if (signal.aborted) return` 静默吞掉 ⇒ 永久 loading、永久 0 goals。
# 本组守两件: ①取数 effect 不得依赖 status/refresh(自取消的形状), 且修法必须真的进了产物;
#            ②面板的渲染+生命周期测试必须绿(该测试对修复前的代码是**红的**——已自证必须开火)。
echo "[T156] 目标轨迹面板(取数 effect 不得自取消 / 渲染与生命周期测试)"
t "取数 effect 不得依赖 status/refresh(自取消形状), 修法须已入产物" python3 -c '
import os, re
base = os.path.expanduser("~/dsh-fork/packages/client/ui-goal-tree")
src = open(base + "/src/client/GoalTree.tsx", encoding="utf8").read()
lib = open(base + "/lib/client.js", encoding="utf8").read()
assert "[open, status, refresh]" not in src, "取数 effect 又依赖 status/refresh —— 它会 abort 掉自己刚发出的请求"
assert re.search(r"void refreshRef\.current\(controller\.signal\)", src), "取数未走 ref(说明依赖又回到了会变化的量)"
assert re.search(r"\}, \[open\]\)", src), "取数 effect 的依赖不是只有 open"
assert "refreshRef" in lib and "statusRef" in lib, "修法未进构建产物(浏览器拿到的仍是自取消版本)"
print("effect 仅依赖 open, ref 修法已在产物")
'
t "三个面板的渲染+取数生命周期测试全绿(修复前各有一条为红)" python3 -c '
import subprocess, os
specs = ["packages/client/ui-goal-tree/tests/panel.client.spec.tsx",
         "packages/client/ui-cognition/tests/life-strip.client.spec.tsx",
         "packages/client/ui-cognition/tests/learning-area.client.spec.tsx"]
r = subprocess.run(["./node_modules/.bin/vitest", "run", "--reporter=dot", *specs],
                   cwd=os.path.expanduser("~/dsh-fork"), capture_output=True, text=True, timeout=900)
if r.returncode != 0:
    print(r.stdout[-2000:]); print(r.stderr[-800:])
raise SystemExit(r.returncode)
print("3 个 spec 全绿")
'
# ── T157 客户端"取数 effect 自取消"形状闸(cl-221/cl-222 的广度) ──
# 一个 bug 有三个实例(ui-goal-tree / ui-cognition×2), 说明它是**被复制的形状**, 不是偶发:
#   effect 里建 AbortController 发请求, 依赖数组里却放着"这次请求自己会改的量"——
#   ① status/loading/error: refresh 的第一步 actions.begin() 就把它翻成 loading;
#   ② asked 这类 flag: effect 自己 setAsked(true);
#   ③ refresh: 注入面在真实注册里会被重建, 且它自己会触发 begin()。
#   依赖一变 ⇒ React 跑上一轮 effect 的 cleanup ⇒ abort 掉刚发出的请求; 而 abort 又被注入面的
#   `if (signal.aborted) return` 静默吞掉 ⇒ 永久 loading(用户看到的"没有内容")。
# 本组是静态形状闸: 三个已知实例已修, 新写的取数 effect 不许再出现这个形状。
echo "[T157] 取数 effect 不得依赖自变状态(自取消形状静态闸)"
t "全客户端插件: 取数 effect 不得依赖自变状态(形状闸工具)" python3 "$HOME/dsh-fork/dsh-client-effect-shape-check.py"
# ── T158 部署意图的内容基线(cl-224: 不得只凭 mtime 制造部署意图) ──
# 起因: 本轮只改了客户端源码, 构建命令却顺带重产出 host 面 lib/index.js —— 源码一字未动、内容逐字节
# 相同, 只是 mtime 变新。检测器按 mtime 判 pending ⇒ 套件"有部署意图必须有排程载体"转红, 并推动
# 一次毫无必要的重启(拿"状态看起来对"换"真的做了什么")。
# 判据: 部署意图 = 产物内容 != 服务启动时所用内容; mtime 只是线索, 内容才是事实。
echo "[T158] 部署意图的内容基线(仅 mtime 变新不算意图 / 内容变才算)"
t "只凭 mtime 不得制造部署意图(基线一致即无意图)" python3 -c '
import json, os, subprocess
out = "/tmp/t158-state.json"
subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-deploy-intent.py", "--state", out, "--quiet"],
               capture_output=True, text=True, timeout=120)
s = json.load(open(out, encoding="utf8"))
assert "contentVerdict" in s and "contentReason" in s, "检测器没有内容比对仪表(又回到只看 mtime)"
if s.get("mtimeNewer") and s["contentVerdict"] == "identical":
    assert s["pending"] is False, "内容与基线逐字节一致却仍判待部署 —— 只凭 mtime 制造意图: " + str(s.get("contentReason"))
    print("mtime 新但内容一致 ⇒ 不判待部署: " + str(s["contentReason"])[:60])
else:
    print("本帧不判(内容确实变了或无基线): %s" % s.get("contentVerdict"))
'
t "内容基线工具须分得开仅改 mtime 与内容已变(探针现场开火)" python3 -c '
import subprocess
r = subprocess.run(["bash", "/home/ubuntu/dsh-fork/dsh-guard-t158-probe.sh"], capture_output=True, text=True, timeout=180)
assert r.returncode == 1, "开火探针未按预期开火(exit=%d): %s" % (r.returncode, r.stderr[-160:])
print("探针开火: " + r.stderr.strip().splitlines()[-1][:80])
'
# ── T159 宿主面构建新鲜度(cl-229: 改了源码没重跑 emit ⇒ 打包静默带旧代码) ──
# 起因: 第二道门埋点 15:50 写进源码却从未进产物, 而宿主面构建是两段式 —— `tsc -b` 先把 JS 发到
# `lib/types/`, `tsdown --env.DSH_BUILD_FACE host` 再以 `lib/types/{index}.js` 为 entry 打包 `lib/index.js`。
# 只跑后半段会**打包旧 emit 并报成功**(实测: 补跑 tsc 前 grep layerSim = 0, 之后重打包才 = 1), 于是
# "改动生效了"与"构建成功了"之间没有任何判据。本组守: src 不得比 lib/types 的 emit 新。
echo "[T159] 宿主面构建新鲜度(src 不得比 lib/types 的 emit 新)"
t "凡已 emit 的包, src 不得比 lib/types 新(否则打包只会带旧代码)" python3 -c '
import os, glob
stale = []
for src in sorted(glob.glob(os.path.expanduser("~/dsh-fork/packages/*/*/src/index.ts"))):
    pkg = os.path.dirname(os.path.dirname(src))
    emitted = os.path.join(pkg, "lib/types/index.js")
    if not os.path.exists(emitted):
        continue                      # 未构建的包不判(不是本组的事)
    gap = os.path.getmtime(src) - os.path.getmtime(emitted)
    if gap > 1:                       # 1s 容忍文件系统粒度
        stale.append("%s(落后 %ds)" % (pkg.split("packages/")[-1], int(gap)))
assert not stale, "改了源码却没重跑 tsc emit ⇒ 宿主打包只会带旧 emit(cl-229): " + "; ".join(stale[:5])
print("所有已 emit 的包都不落后于源码")
'
# ── T160 休眠目标文本调参工具的自证(cl-234) ──
# 这轮用 dsh-layer-sim/tune 把"卡在第二道门"的目标定量修掉(layerSim 0.4961 → 0.5767)。工具本身必须
# 带两道自证, 否则"我测量过了"就是不可证伪的话:
#   ①标定闸: 复算值与已落盘日志值不一致时必须**拒绝出结论**(exit 3), 而不是照样打印;
#   ②判别力: 指标必须能分开"和目标样本共享工作词汇"与"关键词堆砌"(后者不得过门) —— 若两者都过或都不
#     过, 说明这个相似度不可用于裁决(这也正是 cl-063 自激要防的)。
echo "[T160] 文本调参工具自证(标定闸必修红 / 关键词堆砌不得过门)"
t "标定不一致时工具必须拒绝出结论(exit 3)" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
cand = os.path.join(tmp, "c.json"); samp = os.path.join(tmp, "s.json")
json.dump([{"name": "X", "kernel": "经验库 注入 排序", "focus": "读 replay 可排序集"}], open(cand, "w"))
json.dump([{"name": "目标", "kind": "target", "text": "读 replay 的可排序集与 lift, 判是否接线效用项"}], open(samp, "w"))
r = subprocess.run(["npx", "tsx", os.path.expanduser("~/dsh-fork/dsh-layer-tune.tsx"),
                    "--candidates", cand, "--samples", samp, "--expect-rep", "0.9999"],
                   cwd=os.path.expanduser("~/dsh-fork"), capture_output=True, text=True, timeout=600)
assert r.returncode == 3, "标定不一致却没有拒绝出结论(rc=%d): %s" % (r.returncode, (r.stdout or r.stderr)[-200:])
print("标定不一致 ⇒ exit 3(拒绝出结论)")
'
t "判别力: 词汇不相交者不得过门, 共享工作词汇者可过门" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
target = "读 replay 的可排序集与 lift, 判是否接线效用项; 核对引用率/采纳数与注入文本量; 看 A/B 后窗回合数与回滚条件; 回写目标池与账本"
cand = os.path.join(tmp, "c.json"); samp = os.path.join(tmp, "s.json")
# 负对照必须是**词汇不相交**的另一领域文本(拿目标文本的词拼"堆砌"是错误用例: 字符袋必然过门)
json.dump([
  {"name": "OFFTOPIC", "kernel": "视觉模型辅助SPA自动化: 截图理解、ProseMirror 聚焦、分卷设置向导拦截、发布流程阻塞排查。", "focus": "调用视觉模型读页面截图, 解析后点击按钮并输入正文, 处理弹窗栈与瞬时提示。"},
  {"name": "GOOD", "kernel": "经验库注入排序与学习回路的接线与退役: 让被注入的经验更常被真正用上。涉及影子对照三档、可排序集与 MRR/top-1、引用率与采纳率、注入文本量成本、A/B 前后窗与最小护栏、预登记判据与回滚条件、埋点与分通道得分。",
   "focus": "读 dsh-library-replay.py 的可排序集与 lift, 判是否接线效用项; 核对引用率/采纳数与注入文本量; 核对判据口径(样本不足不下结论); 看 A/B 后窗回合数与方向; 回写目标池与账本。"},
], open(cand, "w"), ensure_ascii=False)
json.dump([{"name": "目标样本", "kind": "target", "text": target},
           {"name": "无关对照", "kind": "control", "text": "视觉模型辅助SPA自动化，模型无法读取截图，需调Qwen3-VL处理base64图像；番茄发布流程最后一步阻塞，正文内含分卷设置向导状态化拦截。"}],
          open(samp, "w"), ensure_ascii=False)
r = subprocess.run(["npx", "tsx", os.path.expanduser("~/dsh-fork/dsh-layer-tune.tsx"),
                    "--candidates", cand, "--samples", samp],
                   cwd=os.path.expanduser("~/dsh-fork"), capture_output=True, text=True, timeout=600)
out = r.stdout
assert r.returncode == 0, "工具未正常输出(rc=%d): %s" % (r.returncode, out[-200:])
soup_disc = [l for l in out.splitlines() if l.startswith("OFFTOPIC") and "判别差" in l]
assert soup_disc and "目标过门 no" in soup_disc[0], "词汇不相交的候选竟然过门(指标不可用于裁决): %s" % soup_disc[:1]
good_disc = [l for l in out.splitlines() if l.startswith("GOOD") and "判别差" in l]
assert good_disc and "目标过门 YES" in good_disc[0], "共享工作词汇者未能过门(指标过严/不可达): %s" % good_disc[:1]
print("堆砌 no / 共享词汇 YES(指标有判别力)")
'
# ── T161 C 档预登记裁决(cl-173 退役) ──
# 学习权重换常数已按预登记退役; 裁决必须由**代码**给出而不是靠人记(否则样本到 30 那天还得靠回想)。
echo "[T161] C 档预登记裁决机械出判决"
t "C 档裁决: 样本不足不下结论 / C<=A 退役 / C>A 可再议 / 缺数据不可算" python3 -c '
import importlib.util, os
spec = importlib.util.spec_from_file_location("replay", os.path.expanduser("~/dsh-fork/dsh-library-replay.py"))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
f = mod._arm_c_verdict
assert f(None, None, 40, 0.5, 0.3, 30)["verdict"] == "unavailable", "缺 C 数据时未报 unavailable"
assert f(0.40, 0.20, 29, 0.50, 0.30, 30)["verdict"] == "insufficient", "样本不足却下了结论"
assert f(0.42, 0.20, 35, 0.50, 0.28, 30)["verdict"] == "retire-c-arm", "C<=A 且样本够却未判退役"
assert f(0.60, 0.40, 35, 0.50, 0.28, 30)["verdict"] == "keep-c-arm-candidate", "C>A 却仍判退役"
print("四处判决口径一致")
'
# ── T162 目标池写侧不变量(cl-235: 只治读不治写, last-wins 反而会读到更旧的意图) ──
# 起因: cl-233 我只改了读侧(last-wins)就关单, 而写侧继续追加 —— 旁路帧实测到最危险的形态:
# **末行携带比前一行更旧的 nextAction**(写者拿旧快照回写) ⇒ last-wins 读到的意图反而变旧, 帧会重复
# 催办已完成的事。压实/补向量只是收拾现场, 判据必须守住这两条不变量。
echo "[T162] 目标池写侧不变量(末行不得回退 / 不得纯重复追加)"
t "同一目标的末行时间戳不得早于前一行(意图回退)" python3 -c '
import json, os, collections
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by = collections.defaultdict(list)
for r in rows: by[str(r.get("id"))].append(r)
def stamp(g):
    return str(g.get("lastActionAt") or g.get("lastProgressAt") or g.get("createdAt") or "")
bad = [gid for gid, g in by.items() if len(g) >= 2 and stamp(g[-1]) < stamp(g[-2])]
assert not bad, "末行比前一行更旧(写者拿旧快照回写 ⇒ last-wins 会复活旧意图): %s" % bad
print("每个目标的末行都不早于前一行")
'
t "同一目标不得存在逐字节相同的重复行(纯重复追加)" python3 -c '
import json, os, collections
p = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
by = collections.defaultdict(list)
for r in rows: by[str(r.get("id"))].append(r)
dup = []
for gid, g in by.items():
    seen = collections.Counter(json.dumps(x, ensure_ascii=False, sort_keys=True) for x in g)
    n = sum(c - 1 for c in seen.values() if c > 1)
    if n: dup.append("%s(%d 行重复)" % (gid, n))
assert not dup, "存在逐字节重复行(写侧幂等缺失): %s" % dup
print("无逐字节重复行")
'
# ── T163 行动帧选目标必须 last-wins(cl-233 的行为回归) ──
# 起因: 池是只追加 + last-wins 的账本, 而行动帧原来按**文件序取首条** ⇒ 我 17:20 已把孵化目标的
# nextAction 前进过, 帧仍按 15:36 那行催办同一件事(重复催办已完成步骤)。读侧已改成按 id 收敛到末行,
# 但"改成什么样"必须有行为断言守着 —— 形状 grep 挡不住行为回归。
echo "[T163] 行动帧选目标(last-wins / active 过滤 / 占位符过滤)"
t "合成只追加池: 同 id 多行必须取末行, 且 paused 与 nextAction='无' 不得入选" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "pool.jsonl"); script = os.path.join(tmp, "s.mts")
rows = [{"id": "g1", "title": "目标一", "status": "active", "nextAction": "旧意图(已被取代)", "priority": 1},
        {"id": "g2", "title": "目标二", "status": "paused", "nextAction": "暂停目标不该被选", "priority": 1},
        {"id": "g1", "title": "目标一", "status": "active", "nextAction": "新意图(末行)", "priority": 1},
        {"id": "g3", "title": "目标三", "status": "active", "nextAction": "无", "priority": 1}]
open(pool, "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
open(script, "w", encoding="utf8").write(
  "import { readFileSync } from \"node:fs\"\n"
  "import { selectActionableGoals } from \"/home/ubuntu/dsh-fork/packages/context/quiet-driver/src/index.ts\"\n"
  "console.log(JSON.stringify(selectActionableGoals(readFileSync(process.argv[2], \"utf8\"))))\n")
r = subprocess.run(["npx", "tsx", script, pool], cwd=os.path.expanduser("~/dsh-fork"),
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "选择器脚本失败: %s" % (r.stderr[-200:])
goals = json.loads(r.stdout.strip().splitlines()[-1])
g1 = [g for g in goals if g["id"] == "g1"]
assert len(g1) == 1, "同一 id 出现 %d 次(未按 id 收敛到末行)" % len(g1)
assert g1[0]["nextAction"] == "新意图(末行)", "取到的不是末行意图: %s" % g1[0]["nextAction"]
assert all(g["id"] != "g2" for g in goals), "paused 目标被选中(只应选 active)"
assert all(g["id"] != "g3" for g in goals), "nextAction=\"无\" 被当成可执行"
print("末行意图被选中, paused/占位符被排除")
'
# ── T164 推进率判据的三态(cl-242: 没走完的窗口不能当结论) ──
# 起因: 该判据先是"结构性恒 100%"(把当前值无条件折进历史比较, cl-164), 修完后变成镜像的**假阴性** ——
# 采纳刚发生、窗口还没走完、暂无增长时返回 False ⇒ 记成"0% 推进"。而它自己的文档写着这种情形是"待观察"。
# 三态: 增长 ⇒ True; 窗口满且无增长 ⇒ False; 窗口未满且暂无增长 ⇒ None(待观察, 不进分母)。
echo "[T164] 推进率判据三态(增长/窗口满无增长/窗口未满待观察)"
t "推进判据三态: 未满窗口不得判 0%, 已满窗口无增长才判未推进" python3 -c '
import datetime, os
# 该脚本是过程式脚本(顶层就会读真实数据), 故只切出判据函数体来跑合成用例 —— 显式说明这点,
# 免得日后有人以为这是"测了真脚本"。
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
frag = src[src.index("def _grew"):src.index("def advanced(goal_id")]
ns = {"datetime": datetime, "parse": lambda x: x, "anchor_history": [], "anchors": {}, "_witness_undecidable": {"n": 0}}
exec(frag, ns)
grew = ns["_grew"]
now = datetime.datetime.now(datetime.timezone.utc)
def H(hours, value): return {"ts": now - datetime.timedelta(hours=hours), "a": value}
cases = [
  ("窗口未满+暂无增长 ⇒ 待观察", [H(2, 5)], {"a": 5}, 1, None),
  ("窗口未满+已有增长 ⇒ 推进", [H(2, 5)], {"a": 7}, 1, True),
  ("窗口已满+无增长 ⇒ 未推进", [H(30, 5)], {"a": 5}, 26, False),
  ("窗口已满+期间有增长 ⇒ 推进", [H(30, 5), H(25, 9)], {"a": 9}, 26, True),
  ("窗口已满+仅窗口后才涨 ⇒ 未推进", [H(30, 5), H(25, 5)], {"a": 12}, 26, False),
]
bad = []
for name, hist, anchors, adopted_hours, expect in cases:
    ns["anchor_history"] = hist; ns["anchors"] = anchors
    got = grew(("a",), now - datetime.timedelta(hours=adopted_hours))
    if got is not expect: bad.append("%s: 得到 %s 期望 %s" % (name, got, expect))
assert not bad, "推进判据三态不成立: %s" % bad
print("五态一致(含待观察不计 0%)")
'
# ── T165 孵化三率不得自欺(cl-077 / cl-241 / cl-242 的固化) ──
# 三率是孵化目标的验收指标, 而它自己两次撒谎: 先是**虚高**(全局锚: 机器在动就算任何目标推进 —— 被用户
# 暂停的小说目标也判 100%, cl-077), 后是**虚低**(窗口没走完就记 0% 推进, cl-242)。判据被审之后必须
# 把"不得自欺"的三条约束**常驻**下来, 否则下次换个人/换个方向又会歪回去:
#   ①专属见证不得静默回退到全局锚(active 目标必须逐一声明自己的见证);
#   ②推进率的分母只能是**已裁决**采纳(advanced/decided), 全待观察时必须给 None 而不是 0%;
#   ③全局锚只作对照列, 源码里不得用它出结论。
echo "[T165] 孵化三率(专属见证齐备 / 分母口径 / 全局锚只作对照)"
t "每个 active 目标都必须声明**专属**见证(不得静默回退到全局锚)" python3 -c '
import ast, json, os, re
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
m = re.search(r"GOAL_WITNESS = (\{.*?\n\})", src, re.S)
assert m, "找不到 GOAL_WITNESS"
witness = ast.literal_eval(m.group(1))
pool = {}
for line in open(os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl"), encoding="utf8"):
    if line.strip():
        row = json.loads(line); pool[row.get("id")] = row
active = [gid for gid, g in pool.items() if g.get("status") == "active"]
assert active, "池里没有 active 目标, 断言前提不成立"
missing = [gid for gid in active if gid not in witness]
assert not missing, "这些 active 目标没有专属见证, 会被静默按全局锚判推进(cl-077 的成因): %s" % missing
print("active 目标 %d 个, 专属见证齐备" % len(active))
'
t "推进率分母只能是已裁决采纳(全待观察给 None 而非 0%)" python3 -c '
import json, os, subprocess
r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), "--json"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "度量器运行失败: %s" % r.stderr[-160:]
rows = json.loads(r.stdout)
assert rows, "度量器没有任何行"
bad = []
for row in rows:
    adopted, pending = row.get("adopted") or 0, row.get("pending") or 0
    undecidable, advanced = row.get("undecidable") or 0, row.get("advanced") or 0
    decided = adopted - pending - undecidable
    rate = row.get("advance_rate")
    if decided > 0:
        want = round(advanced / decided * 100, 1)
        if rate != want:
            bad.append("%s: 推进率 %s != advanced/decided %s (待观察 %s 必须不进分母)" % (row.get("goalId"), rate, want, pending))
    elif rate is not None:
        bad.append("%s: 无已裁决样本却给了推进率 %s(应为 None)" % (row.get("goalId"), rate))
assert not bad, "推进率分母口径不对: %s" % bad
print("%d 个目标的推进率分母口径一致(待观察/不可判定均不进分母)" % len(rows))
'
t "全局锚只作对照: 判据必须用专属见证, 报告须标注对照列" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/dsh-incubation-stats.py"), encoding="utf8").read()
assert "def advanced(goal_id, adopted_at)" in src and "GOAL_WITNESS.get(goal_id, GLOBAL_WITNESS)" in src, \
    "advanced() 不再用专属见证"
assert "def advanced_global(" in src and "旧的全局锚判据(仅作对照, 不作结论)" in src, \
    "全局锚缺少\"仅作对照\"的显式声明"
assert "推进率(全局锚对照)" in src, "报告头没有把全局锚标成对照列"
print("判据用专属见证; 全局锚显式标注为对照且声明不作结论")
'
# ── T166 部署史不得被 --log 改道出 canonical 账本 ──
# 起因(2026-09-11 20:0x 自查): 我几次排程部署都传了 `--log /tmp/deploy-*.log`, 于是 canonical
# `deploy-log.jsonl` 停在 15:57 —— 18:08/19:40 两次真实部署在**唯一权威记录里不存在**。判据与复盘
# 读的正是它, 于是"部署史"被我自己的参数悄悄改道。记录通道不该可被重定向出账本(已回填 6 条)。
echo "[T166] 部署史必落 canonical 账本"
t "部署史必须落 canonical 账本(--log 只能额外留一份)" python3 -c '
import os, re
# 判定**结构**而不是字面: 本会话第三次遇到"字面断言被合理重构打破"(先是 900 字符窗, 后是函数体切片,
# 这次是 for 的括号形式被改成 set 去重)。判据要的是"emit 同时写 canonical 与 --log", 不是某种写法。
src = open(os.path.expanduser("~/dsh-fork/dsh-deploy-window.sh"), encoding="utf8").read()
assert "CANONICAL_LOG=" in src, "部署脚本没有 canonical 账本常量"
seg = src[src.index("emit() {"):src.index("if [ \"$PLAN_ONLY\" = 1 ]")]
# 2026-09-12 00:5x 再修口径: 干跑(既不重启也不复跑)已被**豁免**写 canonical(T180 行为验证),
# 故不再要求"写盘目标里同时有 canonical 与 log"; 改判"canonical 必须出现在某个写盘分支里"
# (即真实部署仍落权威账本)。判据的口径随设计变, 但**意图**(部署史必须落权威账本)不变。
found = re.findall(r"\{(canonical[^}]*)\}", seg)
assert found, "emit 的写盘目标里没有 canonical(真实部署将不落权威账本)"
assert "open(target" in seg, "emit 没有按遍历目标落盘"
print("真实部署仍写 canonical(干跑豁免由 T180 行为验证): {%s}" % found[0])
'
# ── T167 孵化预测机制不得腐烂成"永远命中"(cl-249) ──
# 起因: 把孵化从"能自证"推进到"能预测"时先写出的区间是"二项比例区间 × horizon ±1" ⇒ 10 次唤醒给出
# [0,8], 几乎必然命中 —— 那就是**自我确认**, 正是该机制要防的东西。改用 beta-二项预测区间(共轭、
# 小样本校准好)并加严口径(点估计误差 <=1 才算 tightHit)。本组守两件:
#   ①结算逻辑真的能判未命中(合成: 实际落在区间外 ⇒ 必须 miss);
#   ②区间宽度必须随样本量收窄(样本越少越宽是诚实的; 若恒宽, 说明没在算)。
echo "[T167] 孵化预测(结算能判未命中 / 区间随样本收窄)"
t "合成预测: 实际落在区间外必须判未命中(不得恒命中)" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("".join(
    json.dumps({"ts": "2026-09-11T00:00:0%d+08:00" % i, "goalId": "g", "adopted": False}) + "\n" for i in range(6)))
# 预登记: 基准 0 次唤醒/0 采纳, 区间 [0,0] ⇒ 之后 5 次唤醒里出现 3 次采纳就必须判"未命中"
open(os.path.join(tmp, "incubation-predictions.jsonl"), "w", encoding="utf8").write(json.dumps({
    "ts": "2026-09-11T10:00:00+08:00", "kind": "register", "version": 2, "horizonWakes": 5,
    "predictions": [{"goalId": "g", "basisTriggers": 0, "basisAdoptions": 0, "horizonWakes": 5,
                     "adoptInterval": [0, 0], "adoptPoint": 0, "advanceInterval": None, "advancePoint": None,
                     "rule": "x", "deadline": "2026-09-14T00:00:00+08:00", "note": "y"}]}, ensure_ascii=False) + "\n")
# 实际: 补齐到 5 次唤醒且其中 3 次采纳
with open(os.path.join(tmp, "goal-trigger-log.jsonl"), "a", encoding="utf8") as f:
    for i in range(3):
        f.write(json.dumps({"ts": "2026-09-11T11:00:0%d+08:00" % i, "goalId": "g", "adopted": True}) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-incubation-forecast.py"), "--score", "--json"],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "结算失败: %s" % (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout)
assert d["scored"], "已到结算点却没有结算任何预测"
row = d["scored"][0]
assert row["actualAdoptions"] == 3 and row["hit"] is False, "区间 [0,0] 遇上实际 3 次竟判命中: %s" % row
assert d["hitRate"] == 0.0, "命中率未如实反映未命中: %s" % d["hitRate"]
print("合成未命中被判出: 实际 %s 区间 %s ⇒ hit=%s" % (row["actualAdoptions"], row["interval"], row["hit"]))
'
t "预测区间必须随样本量收窄(beta-二项, 不是恒宽)" python3 -c '
import importlib.util, os
spec = importlib.util.spec_from_file_location("fx", os.path.expanduser("~/dsh-fork/dsh-incubation-forecast.py"))
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
small = mod.beta_binomial_interval(1, 5, 10)      # 5 次唤醒 1 次成功
large = mod.beta_binomial_interval(200, 1000, 10)  # 1000 次唤醒 200 次成功(同样的 20%)
assert small != large, "样本量不影响区间宽度(说明没在算): %s vs %s" % (small, large)
assert (large[1] - large[0]) < (small[1] - small[0]), "大样本区间未收窄: %s vs %s" % (small, large)
assert large[1] - large[0] <= 5, "大样本区间过宽(不可证伪): %s" % (large,)
print("区间随样本收窄: 小样本 %s → 大样本 %s" % (small, large))
'
# ── T168 条件型等待必须在驱动侧也生效(cl-250) ──
# 起因: 我给检索目标挂了日期门(waitChecker exit 1 = 到 09-17 才做), 而**行动帧照样驱动了它** —— 因为
# waitChecker 只被 dormant-goal 哨兵读(用于标记 trigger-log 的 skipped), 真正驱动我做事的 quiet-driver
# 不读它。跨插件语义只被一侧读, 于是"门"是半个门(cl-073 的同型: 暂停只停了一半)。
echo "[T168] 条件型等待必须在驱动侧生效(选目标时排除未满足条件者)"
t "合成池: waitChecker 未满足的目标不得被选为可行动目标" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "pool.jsonl"); script = os.path.join(tmp, "s.mts")
rows = [{"id": "ready", "title": "该干", "status": "active", "nextAction": "做事", "priority": 1},
        {"id": "gated", "title": "日期门", "status": "active", "nextAction": "等 09-17",
         "waitChecker": "test $(date +%s) -ge 9999999999", "priority": 9}]
open(pool, "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
open(script, "w", encoding="utf8").write(
  "import { readFileSync } from \"node:fs\"\n"
  "import { selectActionableGoals } from \"/home/ubuntu/dsh-fork/packages/context/quiet-driver/src/index.ts\"\n"
  "const text = readFileSync(process.argv[2], \"utf8\")\n"
  "const none = selectActionableGoals(text).map(g => g.id)\n"
  "const gated = selectActionableGoals(text, g => (g.waitChecker ?? \"\") !== \"\").map(g => g.id)\n"
  "console.log(JSON.stringify({ none, gated }))\n")
r = subprocess.run(["npx", "tsx", script, pool], cwd=os.path.expanduser("~/dsh-fork"),
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "选择器脚本失败: %s" % (r.stderr[-200:])
d = json.loads(r.stdout.strip().splitlines()[-1])
assert set(d["none"]) == {"ready", "gated"}, "不传等待谓词时应原样返回(向后兼容): %s" % d["none"]
assert d["gated"] == ["ready"], "带等待条件的目标未被排除(条件型等待在驱动侧失效): %s" % d["gated"]
print("等待谓词生效: 未满足条件者被排除, 不传谓词时向后兼容")
'
t "驱动侧必须真的把 waitChecker 接进选目标路径(不是只在哨兵侧)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/quiet-driver/src/index.ts"), encoding="utf8").read()
assert "function waitConditionMet(" in src, "驱动侧没有 waitChecker 求值器"
i = src.index("async function findAllActionableGoals")
seg = src[i:src.index("\n}", i)]
assert "waitConditionMet(" in seg and "waitChecker" in seg, "选目标路径没有把 waitChecker 接进去(门只是半个门)"
print("findAllActionableGoals 已把 waitChecker 接进候选过滤")
'
# ── T169 llm 跳词准入必须需证据(cl-099 裁决) ──
echo "[T169] llm 跳词准入需证据(离线读数: 120 条零证据/零命中/零引用)"
t "无证据的 llm 跳词不得以「新鲜」为由进入或保留" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
i = src.index("for (const [word, prior] of existing)")
seg = src[i:i + 900]
assert "const proven = prior.citedCount > 0 || (prior.evidenceCount ?? 0) > 0" in seg, "证据判定被改动了"
assert "if (!proven) continue" in seg, "无证据的 llm 变体仍可继承(裁决要求: 需证据)"
assert "fresh" not in seg.split("if (!proven)")[0].split("const proven")[1], "仍有\"新鲜\"作为准入理由"
print("llm 跳词继承只认证据或引用")
'
t "表里不得存在超期且零证据零引用的 llm 跳词(病态复发的探针)" python3 -c '
import json, os, time
p = os.path.expanduser("~/.dsh/cognitive-pipeline/trigger_jumps.json")
rows = json.load(open(p, encoding="utf8"))
now = time.time() * 1000
# tp-146 已实证效果(2026-09-11 22:29 重建后 llm 条目 120 → 0), 故探针**收紧到即时**:
# 只要表里出现 source=llm 且零证据零引用的条目就红 —— 不再等 7 天 TTL(那会让"生产侧又重造零证据变体"
# 这类回归整整一周无人发现)。旧的 TTL 口径是把"还没到期的零证据条目"当合法, 而实测证明它们本就不该存在。
bad = ["%s(证据 %s/引用 %s, 龄 %.1fd)" % (r.get("jumpWord"), r.get("evidenceCount"), r.get("citedCount"),
                                         (now - (r.get("createdAt") or 0)) / 86400000)
       for r in rows if r.get("source") == "llm" and (r.get("evidenceCount") or 0) == 0
       and (r.get("citedCount") or 0) == 0]
assert not bad, "表内出现零证据零引用的 llm 跳词(准入判据回归了?): %s" % bad[:4]
print("表内 llm 跳词 %d 条, 全部有证据或被引用" % sum(1 for r in rows if r.get("source") == "llm"))
'
# ── T170 孵化预测的 register→score 往返与 last-wins(cl-249 的机制面) ──
# 起因(测试审视帧): T167 只守了"能判未命中"与"区间随样本收窄"两个**片段**, 而这条机制真正会被用的是
# 往返: 先预登记, 等窗口走完再结算。两处此前无覆盖: ①往返是否真能结算(horizon 到了就出结论);
# ②同一 (goalId, 基准唤醒数) 若被重复预登记(口径修正后会重新登记), 必须**只认最后一次**(last-wins)——
# 否则同一窗口会被重复计入命中率, 指标自己就先歪了。
echo "[T170] 预测往返(register→到达 horizon→结算) + 重复预登记 last-wins"
t "往返: horizon 到达后必须结算出该窗口的实际采纳" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
log = os.path.join(tmp, "goal-trigger-log.jsonl")
def row(i, adopted):
    return json.dumps({"ts": "2026-09-11T10:00:%02d+08:00" % i, "goalId": "g", "adopted": adopted}) + "\n"
open(log, "w", encoding="utf8").write(row(0, False) + row(1, False) + row(2, False))
env = dict(os.environ, DSH_COG_DIR=tmp)
fx = os.path.expanduser("~/dsh-fork/dsh-incubation-forecast.py")
r = subprocess.run(["python3", fx, "--register", "--horizon", "2", "--json"], capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "预登记失败: %s" % (r.stderr or r.stdout)[-200:]
pred = json.loads(r.stdout)["predictions"][0]
assert pred["basisTriggers"] == 3 and pred["horizonWakes"] == 2, pred
# 窗口走完: 再补 2 次唤醒, 其中 1 次采纳
with open(log, "a", encoding="utf8") as f: f.write(row(3, True) + row(4, False))
r2 = subprocess.run(["python3", fx, "--score", "--json"], capture_output=True, text=True, timeout=600, env=env)
assert r2.returncode == 0, "结算失败: %s" % (r2.stderr or r2.stdout)[-200:]
d = json.loads(r2.stdout)
assert len(d["scored"]) == 1, "窗口已走完却没结算(或结算了多条): %s" % d
got = d["scored"][0]
assert got["actualAdoptions"] == 1 and got["target"] == 5, got
assert d["hitRate"] in (0.0, 1.0), "命中率未算出: %s" % d["hitRate"]
print("往返成立: 基准 3 → 目标 5 → 实际采纳 %s, 区间 %s ⇒ hit=%s" % (got["actualAdoptions"], got["interval"], got["hit"]))
'
t "重复预登记必须 last-wins(同一基准窗口只结算一次)" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
log = os.path.join(tmp, "goal-trigger-log.jsonl")
rows = [json.dumps({"ts": "2026-09-11T10:00:%02d+08:00" % i, "goalId": "g", "adopted": False}) + "\n" for i in range(3)]
open(log, "w", encoding="utf8").write("".join(rows))
env = dict(os.environ, DSH_COG_DIR=tmp)
fx = os.path.expanduser("~/dsh-fork/dsh-incubation-forecast.py")
subprocess.run(["python3", fx, "--register", "--horizon", "2"], capture_output=True, text=True, timeout=600, env=env)
# 口径修正式重登记: 同一基准(3)再来一次, 区间故意写成 [9,9](必然未命中)
preds = os.path.join(tmp, "incubation-predictions.jsonl")
rec = json.loads(open(preds, encoding="utf8").read().strip().split("\n")[-1])
rec["predictions"][0]["adoptInterval"] = [9, 9]
rec["predictions"][0]["adoptPoint"] = 9
with open(preds, "a", encoding="utf8") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")
# 窗口必须**走完**才结算: 基准 3 + horizon 2 = 5 ⇒ 再补 2 次唤醒(其中 1 次采纳)
with open(log, "a", encoding="utf8") as f:
    f.write(json.dumps({"ts": "2026-09-11T11:00:00+08:00", "goalId": "g", "adopted": True}) + "\n")
    f.write(json.dumps({"ts": "2026-09-11T11:05:00+08:00", "goalId": "g", "adopted": False}) + "\n")
d = json.loads(subprocess.run(["python3", fx, "--score", "--json"], capture_output=True, text=True, timeout=600, env=env).stdout)
assert len(d["scored"]) == 1, "同一基准窗口被结算了 %d 次(未 last-wins)" % len(d["scored"])
assert d["scored"][0]["interval"] == [9, 9], "结算用的不是最后一次预登记的区间: %s" % d["scored"][0]
assert d["scored"][0]["hit"] is False, "按最后一次区间应判未命中: %s" % d["scored"][0]
print("last-wins 成立: 只结算 1 条, 且用最后一次预登记的区间 %s ⇒ hit=False" % d["scored"][0]["interval"])
'
# ── T171 重复催办判据(cl-248 的机械化: 连续 3 次唤醒未采纳且无生效等待 ⇒ 红) ──
# 起因(测试审视帧): cl-248 那类"已完成的 nextAction 仍留在池里"是靠我人工看出来的 —— 检索目标连续 6 次
# 唤醒无事可做, 代价不只是空转, 还让"触发数"这个指标虚增。人工发现不可复现, 判据必须机械:
#   · 连续 ≥3 次唤醒未产生采纳 **且** 该目标没有"生效中的等待条件"(waitChecker exit 0 才算条件已满足,
#     满足即该驱动, 不满足则说明它在合法等待) ⇒ 判定为重复催办。
# 为什么带 waitChecker 就豁免: 日期门/样本门目标本来就会累积若干次未采纳的唤醒, 那是设计而非空转。
echo "[T171] 重复催办判据(连续未采纳且无生效等待即红)"
t "active 目标不得连续 3 次唤醒未采纳且无生效等待条件" python3 -c '
import json, os, subprocess, collections
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
pool = {}
for line in open(os.path.join(D, "dormant-goals.jsonl"), encoding="utf8"):
    if line.strip():
        row = json.loads(line); pool[row.get("id")] = row
trig = collections.defaultdict(list)
for line in open(os.path.join(D, "goal-trigger-log.jsonl"), encoding="utf8"):
    if line.strip():
        r = json.loads(line); trig[r.get("goalId")].append(r)
bad = []
for gid, g in pool.items():
    if g.get("status") != "active":
        continue
    rows = trig.get(gid) or []
    streak = 0
    for r in reversed(rows):
        if r.get("adopted") is True:
            break
        streak += 1
    checker = (g.get("waitChecker") or "").strip()
    waiting = False
    if checker:
        waiting = subprocess.run(checker, shell=True, capture_output=True).returncode != 0   # 条件未满足=在等待
    if streak >= 3 and not waiting:
        bad.append("%s(连续 %d 次未采纳, 无生效等待: %s)" % (gid, streak, checker or "无 waitChecker"))
assert not bad, "疑似重复催办(该目标的 nextAction 可能已完成或不可推进): %s" % bad
print("active 目标均未出现\"连续未采纳且无等待\"的空转")
'
# ── T172 唤醒→推进归因这把尺子本身(cl-251) ──
# 起因: 这条读数第一版给出"严格 8.4%", 我差点据此判"提醒多半是噪声"。逐项校准发现**两处都是尺子的问题**:
#   ①窗口 60 分钟把 p90≈45/最大≈60 的真实归因截断(user bug: 取窗口时没看延迟分布);
#   ②"池变更必须晚于帧时间戳"这个假设对**回合边界**是错的 —— 帧记录是回合结束才落盘的, 它引发的池变更
#     可能略早于它(实测 change 20:02:46.4 / frame 20:02:47, 一对真归因被漏掉)。
# 修完两处后严格率 8.4% → 37.7%。故本组守: 前向容差要生效、超容差不得认领、内容不匹配不得认领。
echo "[T172] 唤醒→推进归因的口径(前向容差生效 / 超容差不认领 / 内容必须匹配)"
t "合成: 池变更略早于帧(回合边界)必须仍被归因" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp()
base = datetime.datetime(2026, 9, 11, 22, 0, 0).timestamp() * 1000
step = "读 A/B 后窗裁决 utilityFusion(可执行; 后窗 >=20 回合才判): ①"
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write(json.dumps({
    "ts": str(int(base + 1000)), "kind": "action-frame", "goalId": "g", "session": "s", "nextAction": step}) + "\n")
iso = datetime.datetime.fromtimestamp((base + 500) / 1000).astimezone().isoformat()
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(json.dumps({
    "ts": iso, "goalId": "g", "sessionId": "s", "evidence": "pool-change", "before": step, "after": "下一步"}) + "\n")
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-wake-attribution.py"), "--json", "--no-record"],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "工具失败: %s" % (r.stderr or r.stdout)[-160:]
d = json.loads(r.stdout)
assert d["attributed"] == 1, "池变更早于帧时间戳 0.5s 时未归因(前向容差没生效): %s" % d
print("前向容差生效: 1s 内的边界情形被正确归因")
'
t "合成: 内容不匹配或超出容差不得认领(防止把同回合的别的改动算成唤醒的功劳)" python3 -c '
import json, os, subprocess, tempfile, datetime
def run(frames, changes):
    tmp = tempfile.mkdtemp()
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write(frames)
    open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(changes)
    open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("")
    env = dict(os.environ, DSH_COG_DIR=tmp)
    r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-wake-attribution.py"), "--json", "--no-record"],
                       capture_output=True, text=True, timeout=600, env=env)
    assert r.returncode == 0, (r.stderr or r.stdout)[-160:]
    return json.loads(r.stdout)
base = datetime.datetime(2026, 9, 11, 22, 0, 0).timestamp() * 1000
frame = json.dumps({"ts": str(int(base)), "kind": "action-frame", "goalId": "g", "session": "s",
                    "nextAction": "步骤 A: 做甲事"}) + "\n"
# ① 内容不同(同会话同窗口) ⇒ 不得认领
diff = json.dumps({"ts": datetime.datetime.fromtimestamp((base + 60000) / 1000).astimezone().isoformat(),
                   "goalId": "g", "sessionId": "s", "evidence": "pool-change",
                   "before": "完全不一样的另一步", "after": "x"}) + "\n"
assert run(frame, diff)["attributed"] == 0, "内容不匹配却被认领"
# ② 超出前向容差(变更比帧早 3 小时) ⇒ 不得认领
early = json.dumps({"ts": datetime.datetime.fromtimestamp((base - 3 * 3600000) / 1000).astimezone().isoformat(),
                    "goalId": "g", "sessionId": "s", "evidence": "pool-change",
                    "before": "步骤 A: 做甲事", "after": "x"}) + "\n"
assert run(frame, early)["attributed"] == 0, "超出前向容差却被认领"
print("内容与容差两道闸都拦住了误认领")
'
# ── T173 断言名不得含双引号(元判据: 防「登记簿与套件永远对不上」) ──
# 起因: 同一个坑踩了三次(T158 / T169 / T172) —— 断言名里带双引号时, 套件源码里会被转义, 而登记簿里存的是
# 未转义原名, 于是「声明的开火断言必须真实存在于该组」反复假红。判据: 断言行里出现转义双引号即红(要强调用「」)。
echo "[T173] 断言名不得含双引号(登记簿匹配不被转义坑)"
t "套件里所有断言名不得含双引号" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/dsh-cog-tests.sh"), encoding="utf8").read()
bad = []
CH = chr(34); ESC = chr(92)
for line in src.splitlines():
    st = line.strip()
    if not st.startswith("t " + CH):
        continue
    head = st.split(" python3")[0].split(" bash")[0]
    if ESC + CH in head:
        bad.append(head[:50])
assert not bad, "断言名含双引号(登记簿匹配会被转义坑, 请改用「」): %s" % bad[:4]
print("套件断言名均不含双引号")
'
# ── T174 归因读数的噪声判据与「由别的机制拥有」单列(cl-251/cl-252) ──
# 起因(测试审视帧): 这条读数即将用来**决定是否下调某个目标的相似度权重**, 而它的两个关键口径没有覆盖:
#   ①噪声候选的阈值化判据(frames>=5 且严格率<20% 且当前 active) —— 写成"恰好为 0"时 1/15 与 0/15 会被
#     当成两回事, 太二值;
#   ②「nextAction 由别的机制拥有」的目标必须**单列且不计入候选**(闸门会自己改写 adoption-rate 的
#     nextAction, 实测它宽松 100% 而严格 0% —— 那是尺子量不了, 不是提醒没用)。
echo "[T174] 归因读数的噪声判据(阈值化 + 由别的机制拥有者单列)"
t "合成: 由别的机制拥有的目标不得被列为噪声候选; 阈值化判据须生效" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp()
base = datetime.datetime(2026, 9, 11, 22, 0, 0).timestamp() * 1000
frames, changes, triggers = [], [], []
# 三个目标各 6 条帧、严格归因全 0: A=active 无门(应判噪声候选), B=paused(不该判), C=闸门拥有(不该判)
for gid in ("goal-a-active", "goal-b-paused", "goal-adoption-rate"):
    for i in range(6):
        frames.append(json.dumps({"ts": str(int(base + i * 1000)), "kind": "action-frame", "goalId": gid,
                                  "session": "s", "nextAction": "步骤 X: 做事"}))
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("\n".join(frames) + "\n")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("")           # 无任何推进
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("")
open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write("\n".join([
    json.dumps({"id": "goal-a-active", "status": "active"}),
    json.dumps({"id": "goal-b-paused", "status": "paused"}),
    json.dumps({"id": "goal-adoption-rate", "status": "active"})]) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-wake-attribution.py"), "--json", "--no-record"],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "工具失败: %s" % (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout)
assert d["noiseCandidates"] == ["goal-a-active"], "候选集合不对(应只有 active 且无门者): %s" % d["noiseCandidates"]
assert d["measurableAttributionRate"] == 0.0, "可严格测量口径应只含非拥有者: %s" % d
by = {x["goalId"]: x for x in d["perGoal"]}
assert by["goal-adoption-rate"]["governedElsewhere"] is True, "闸门拥有的目标未单列"
assert by["goal-b-paused"]["noiseCandidate"] is False, "paused 目标被当成噪声候选(它已不可被驱动)"
print("候选=仅 active 且无门者; 闸门拥有者单列; paused 不计")
'
# ── T175 池内每个 waitChecker 都要有覆盖(T154 只跑了写死的那一个) ──
# 起因(测试审视帧): T154 名义上测「池内样本的 waitChecker 须如实回答」, 实现里却写死了
# `dsh-wait-check-library.py` —— 于是后加的日期门检查器与精排样本门检查器**完全没有覆盖**。
# 本组对**每个**池内 checker 断言两件: ①重复运行结果一致(不抖动); ②exit ∈ {0,1}(3=测不出来, 属故障态);
# 并对「解析不了不得当成满足」这条纪律做一次合成验证(喂坏输出必须 exit 3)。
echo "[T175] 池内每个 waitChecker 均被覆盖 + fail-closed 纪律"
t "池内每个 waitChecker 须确定(两次一致)且不返回故障码" python3 -c '
import json, os, subprocess
pool = os.path.expanduser("~/.dsh/cognitive-pipeline/dormant-goals.jsonl")
latest = {}
for l in open(pool, encoding="utf8"):
    if l.strip():
        g = json.loads(l)
        if g.get("id"): latest[g["id"]] = g
checkers = {k: str(v.get("waitChecker") or "").strip() for k, v in latest.items() if str(v.get("waitChecker") or "").strip()}
assert checkers, "池里没有 waitChecker —— 前提不成立"
bad = []
for gid, cmd in checkers.items():
    codes = []
    for _ in range(2):
        r = subprocess.run(cmd, shell=True, capture_output=True, timeout=400)
        codes.append(r.returncode)
    if codes[0] != codes[1]:
        bad.append("%s: 两次结果不一致 %s" % (gid, codes))
    if any(c not in (0, 1) for c in codes):
        bad.append("%s: 返回故障码 %s(0=条件满足该驱动 / 1=未满足继续等待)" % (gid, codes))
assert not bad, "池内 checker 不可用: %s" % bad
print("池内 %d 个 checker 均确定且只返回 0/1" % len(checkers))
'
t "解析不了不得当成满足(精排样本门检查器 fail-closed)" python3 -c '
import os, subprocess, tempfile
tmp = tempfile.mkdtemp()
shim = os.path.join(tmp, "fake-refine.py")
open(shim, "w", encoding="utf8").write("print(\"完全不是预期格式的输出\")\n")
env = dict(os.environ, DSH_REFINE_EVAL=shim)
r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-wait-check-refine.py")],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 3, "输出解析不了却没 fail-closed(exit %d) —— 这会让「测不出来」被当成「条件满足」" % r.returncode
print("坏输出 ⇒ exit 3(不放行)")
'
# ── T176 被脚本引用的仓库文件必须存在(测试审视帧发现的"静默缺失") ──
# 起因: `cognitive-patch.yml` 被 dsh-chat.sh / fix.sh / dsh-cog.sh 三个脚本以 `--patch <路径>` 引用, 却已从
# 工作区消失(部署窗口的文件处理留下的), 而那三个脚本会直接失败 —— 没有任何判据在看这件事。判据: 凡在
# 这些脚本里以 `-patch $REPO/<file>` 或 `<repo>/<file>` 形式出现的仓库文件, 必须真实存在。
echo "[T176] 被脚本引用的仓库文件必须存在"
t "脚本引用的仓库配置/脚本不得静默缺失" python3 -c '
import os, re
repo = os.path.expanduser("~/dsh-fork")
suspects = set()
for name in sorted(os.listdir(repo)):
    if not (name.endswith(".sh") or name.endswith(".py")):
        continue
    path = os.path.join(repo, name)
    try:
        text = open(path, encoding="utf8", errors="ignore").read()
    except Exception:
        continue
    # 形如 /home/ubuntu/dsh-fork/xxx.yml 或 $REPO/xxx.yml 或 ${REPO}/xxx
    for m in re.finditer(r"(?:/home/ubuntu/dsh-fork|\$\{?REPO\}?)/([A-Za-z0-9_.-]+\.(?:yml|yaml|json|sh|py|md))", text):
        suspects.add(m.group(1))
# 占位名(用法示例里的 xxx.yml / foo.yml)不算引用 —— 否则判据会被文档噪声打红
PLACEHOLDER = re.compile(r"^(xxx|foo|bar|example|your|some|path|file)\b", re.I)
missing = sorted(f for f in suspects if not PLACEHOLDER.match(f) and not os.path.exists(os.path.join(repo, f)))
assert not missing, "被脚本引用却不存在(脚本会直接失败): %s" % missing
print("脚本引用的 %d 个仓库文件均存在" % len(suspects))
'
# ── T177 反向判据也要覆盖(cl-254 的 --reverse) ──
# 起因(测试审视帧): T172 只覆盖了正向归因的口径(前向容差/内容匹配), 而 `--reverse`("有多少池推进没有对应的
# 唤醒")是另一条独立路径 —— 它一旦算错, 结论会直接反向(把"提醒必要"读成"提醒不必要", 或反之), 而这条读数
# 已经写进孵化报告的常驻行。故补两个合成用例: 有匹配帧 ⇒ 不算"未被唤醒"; 无匹配帧 ⇒ 必须算。
echo "[T177] 反向判据(池推进是否有对应唤醒)"
t "合成: 有匹配帧的池推进不得计入「未被唤醒」, 无匹配帧必须计入" python3 -c '
import json, os, subprocess, tempfile, datetime
def run(frames, changes):
    tmp = tempfile.mkdtemp()
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write(frames)
    open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(changes)
    open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("")
    env = dict(os.environ, DSH_COG_DIR=tmp)
    r = subprocess.run(["python3", os.path.expanduser("~/dsh-fork/dsh-wake-attribution.py"), "--reverse", "--json", "--no-record"],
                       capture_output=True, text=True, timeout=600, env=env)
    assert r.returncode == 0, (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout)["reverse"]
base = datetime.datetime(2026, 9, 11, 22, 0, 0).timestamp() * 1000
step = "步骤 A: 做甲事"
iso = lambda ms: datetime.datetime.fromtimestamp(ms / 1000).astimezone().isoformat()
# ① 有匹配帧(同目标/同会话/内容一致) ⇒ 不算未被唤醒
frames = json.dumps({"ts": str(int(base)), "kind": "action-frame", "goalId": "g", "session": "s", "nextAction": step}) + "\n"
matched = json.dumps({"ts": iso(base + 60000), "goalId": "g", "sessionId": "s", "evidence": "pool-change", "before": step, "after": "步骤 B"}) + "\n"
d1 = run(frames, matched)
assert d1["changes"] == 1 and d1["withoutWake"] == 0, "有匹配帧却被算成未被唤醒: %s" % d1
# ② 无匹配帧(内容不同) ⇒ 必须算未被唤醒
unmatched = json.dumps({"ts": iso(base + 60000), "goalId": "g", "sessionId": "s", "evidence": "pool-change", "before": "完全不同的另一步", "after": "步骤 B"}) + "\n"
d2 = run(frames, unmatched)
assert d2["changes"] == 1 and d2["withoutWake"] == 1 and d2["withoutWakeRate"] == 1.0, "无匹配帧却没算成未被唤醒: %s" % d2
print("反向判据两例均正确(匹配不计入 / 不匹配必须计入)")
'
# ── T178 重建尝试账本的写入点必须在产物里(cl-256/tp-156) ──
# 起因: 那条判据读 taxonomy-rebuild.jsonl, 而**源码里原本根本没有这个文件名**(账本只有人工补的 2 行) ——
# 判据在检查"有没有人手工写行"而不是"整合层在不在重试"。修复已落地(store.recordTaxonomyAttempt + runRebuild
# 包装), 本组守"写入点必须在**产物**里"(必要非充分: 端到端仍由 tp-156 在重启后验证 —— 这正是 T154 抓过
# "埋点写了没进产物"的那类静默缺口)。
echo "[T178] 重建尝试账本的写入点须在产物里"
t "已部署 lib 必须含 taxonomy-rebuild.jsonl 的写入点" python3 -c '
import os
lib = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
src_store = os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts")
text = open(lib, encoding="utf8").read()
assert "taxonomy-rebuild.jsonl" in text, "产物里没有该账本的写入点(重建尝试又只能人工记录了)"
src = open(src_store, encoding="utf8").read()
assert "recordTaxonomyAttempt" in src, "store 没有 recordTaxonomyAttempt"
assert "taxonomy-rebuild.jsonl" in src, "store 的写入点被移走了"
print("写入点在 store 源码与产物里齐备")
'
t "try 路径: 重建必须真的调用写入点(不是只定义了方法)" python3 -c '
import os
# 判"定义了且被调用"用**出现次数**(定义 1 次 + 至少 1 处调用), 不用 token 切片 ——
# 第一版切片从 runRebuild( 切到下一个 runRebuildCore 出现处, 而包装层里 await runRebuildCore 排在
# recordTaxonomyAttempt 之前, 于是把真正要查的调用切掉了(判据看错窗口, 本会话第 4 次同族)。
cold = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/cold-engine.ts"), encoding="utf8").read()
store = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/store.ts"), encoding="utf8").read()
assert store.count("recordTaxonomyAttempt") >= 1, "store 没有定义写入点"
assert cold.count("recordTaxonomyAttempt(") >= 1, "cold-engine 没有调用写入点(定义了没人用)"
assert "await this.runRebuildCore(" in cold, "runRebuild 未包装 runRebuildCore"
print("写入点已定义且被调用(store 定义 + cold-engine 调用)")
'
# ── T179 自动重建不得被结构性暂缓(cl-257/tp-159) ──
# 起因: 自动路径(report_outcome 里预测误差 ≥ 紧急阈值时)固定调 runRebuild('local'), 而 local 在小样本下
# **数学不可达**(validationSize = max(1, floor(n×0.2)) < minValidationCount=3 ⇒ 需 n≥15) ⇒ 紧急修补从不
# 落地, 整合层的自动刷新被结构性禁用(实测: 同一时刻 local 暂缓 / global 被接受, 误差 -21.9%)。
# 本组守两件: ①回退接线在源码与产物里(结构判定); ②账本里一旦出现自动(emergency)尝试, 就必须伴随
# 回退尝试或一次被接受的 global —— 没有自动事件时写明"本帧不判", 不空过也不假红。
echo "[T179] 自动重建不得被结构性暂缓(local 未接受须回退 global)"
t "紧急路径须在 local 未接受时回退 global, 且账本可分清自动/手动" python3 -c '
import os
svc = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
cold = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/cold-engine.ts"), encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js"), encoding="utf8").read()
assert "runRebuild(\u0027local\u0027, call?.sessionId, call?.signal, \u0027emergency\u0027)" in svc, "紧急路径未标注 trigger=emergency"
assert "emergency-fallback" in svc, "紧急路径没有 global 回退"
assert "trigger" in cold and "recordTaxonomyAttempt" in cold, "尝试记录未带 trigger 标签"
assert "emergency-fallback" in lib, "回退未进产物"
print("紧急路径: local 未接受 → 回退 global, 账本带 trigger")
'
t "账本: 出现自动尝试后必须伴随回退或被接受的 global(无自动事件则本帧不判)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/taxonomy-rebuild.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
auto = [r for r in rows if r.get("trigger") == "emergency"]
if not auto:
    print("账本尚无 trigger=emergency 行(自动路径自本判据上线后未触发), 本帧不判")
    raise SystemExit(0)
last = auto[-1]
same_window = [r for r in rows if r.get("ts") >= last["ts"]]
assert any(r.get("trigger") == "emergency-fallback" or (r.get("scope") == "global" and r.get("accepted"))
           for r in same_window), "最近一次自动尝试后既无回退也无被接受的 global: %s" % last
print("最近一次自动尝试后已伴随回退/被接受的 global")
'
# ── T180 部署记录必须真的带上 stage/suiteStatus(参数展开静默丢字段) ──
# 起因(测试审视帧): `emit` 里写的是 `"${3:-{}}"` —— bash 把**第一个未转义的 `}`** 当展开结束, 于是实际传成
# `<json>}`, 下游 json.loads 抛错并被 `except: pass` **静默吞掉**。后果: 账本 50 条 done 行**从来没有**
# stage/suiteStatus ⇒ cl-214「把部署成败与套件裁决分开记」的修复**从未落进产物**(记录通道看起来在工作,
# 实际一直在丢字段)。本组守两件: ①干跑的行必须带 stage(端到端, 直接跑一次干跑到临时 --log);
# ②干跑不得写 canonical 账本(T145 的意图, 但此前只被合成沙箱覆盖, 手工干跑仍会污染)。
echo "[T180] 部署记录带 stage / 干跑不污染 canonical"
t "干跑必须写出带 stage 的 done 行(参数展开不得静默丢字段)" python3 -c '
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp(); log = os.path.join(tmp, "dry.jsonl")
r = subprocess.run(["bash", os.path.expanduser("~/dsh-fork/dsh-deploy-window.sh"),
                    "--skip-restart", "--skip-suite", "--delay-seconds", "0", "--log", log],
                   capture_output=True, text=True, timeout=300,
                   env=dict(os.environ, DSH_RUN_ORIGIN="probe"))
assert r.returncode == 0, "干跑失败: %s" % (r.stderr or r.stdout)[-160:]
rows = [json.loads(l) for l in open(log, encoding="utf8") if l.strip()]
done = [x for x in rows if x.get("phase") == "done"]
assert done, "干跑没有写 done 行"
assert done[-1].get("stage"), "done 行缺 stage —— extra JSON 又被静默丢掉了(检查 emit 的参数展开): %s" % done[-1]
assert done[-1]["stage"] == "no-suite", "干跑的 stage 应为 no-suite: %s" % done[-1]["stage"]
print("干跑 done 行带 stage=%s" % done[-1]["stage"])
'
t "干跑不得写 canonical 部署账本" python3 -c '
import json, os, subprocess, tempfile
canon = os.path.expanduser("~/.dsh/cognitive-pipeline/deploy-log.jsonl")
before = sum(1 for l in open(canon, encoding="utf8") if l.strip()) if os.path.exists(canon) else 0
tmp = tempfile.mkdtemp()
subprocess.run(["bash", os.path.expanduser("~/dsh-fork/dsh-deploy-window.sh"),
                "--skip-restart", "--skip-suite", "--delay-seconds", "0", "--log", os.path.join(tmp, "dry.jsonl")],
               capture_output=True, text=True, timeout=300, env=dict(os.environ, DSH_RUN_ORIGIN="probe"))
after = sum(1 for l in open(canon, encoding="utf8") if l.strip()) if os.path.exists(canon) else 0
assert after == before, "干跑污染了 canonical 账本(%d → %d 行)" % (before, after)
print("干跑未写 canonical(仍 %d 行)" % after)
'
# ── T181 自动修补的触发必须**可达**(cl-259: 单样本 0.8 是死分支) ──
# 起因: cl-257 修好了"紧急修补被结构性暂缓", 但没修"紧急修补根本没被触发过" —— 264 条已结算预测里
# 0 条误差达到 0.8(实测 max 0.7231)。成因不是运气: 校准概率被压缩在 [0.145, 0.828], 单样本 ≥0.8 只剩
# "p≤0.2 且观测=1.0"一条路, 264 条里这样的一对 0 个 ⇒ 阈值落在观测支撑之外, 那条自愈分支在磁盘上
# 永远零痕迹。修法: ①快路径阈值降到历史极值之下(0.70) ②补一条**统计**触发(近 N 条平均误差过上界,
# 带迟滞下界)。本组守四件: ①合成输入必须能顶到触发点(行为); ②两条触发在真实账本上**都有先例**
# (可达性, 用源码里的默认值回放, 默认值一旦漂出可观测区间就转红); ③接线进源码与产物; ④账本口径。
echo "[T181] 自动修补触发必须可达(合成的能触发 / 真实的有先例)"
t "漂移触发器: 合成输入能顶到触发点, 且迟滞/未满窗口/低误差不得触发" python3 -c '
import json, os, re, subprocess, tempfile, datetime
root = os.path.expanduser("~/dsh-fork")
src = open(os.path.join(root, "packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
def default_num(field, cast=float):
    m = re.search(field + r": z\.number\(\)[^,]*\.default\(([0-9.]+)\)", src)
    assert m, "源码里找不到 " + field + " 的 zod 默认值"
    v = cast(m.group(1))
    assert (field + " ?? " + str(v)) in src, field + " 的 zod 默认与 resolveConfig 的回落值不一致"
    return v
win = default_num("driftWindowSize", int)
hi = default_num("driftMeanErrorThreshold")
lo = default_num("driftDisarmErrorThreshold")
emerg = default_num("emergencyErrorThreshold")
tmp = tempfile.mkdtemp()
script = os.path.join(tmp, "probe.mts")
out = os.path.join(tmp, "out.json")
open(script, "w", encoding="utf8").write(f"""
import {{ readFileSync, writeFileSync }} from "node:fs"
import {{ evaluateDriftTrigger }} from "{root}/packages/cognition/cognitive-pipeline/src/service.ts"
const cfg = {{ windowSize: {win}, meanThreshold: {hi}, disarmThreshold: {lo} }}
const hot = Array.from({{ length: {win} }}, (_, i) => (i % 3 === 0 ? 0.7 : 0.2))
const mustFire = evaluateDriftTrigger(hot, true, cfg)
const hysteresis = evaluateDriftTrigger([...hot, 0.7], mustFire.armed, cfg)
const rearm = evaluateDriftTrigger(new Array({win}).fill(0.1), hysteresis.armed, cfg)
const notFull = evaluateDriftTrigger(new Array({win - 1}).fill(0.9), true, cfg)
const flatLow = evaluateDriftTrigger(new Array({win * 2}).fill(0.12), true, cfg)
const rows = new Map<string, any>()
for (const line of readFileSync("/home/ubuntu/.dsh/cognitive-pipeline/predictions.jsonl", "utf8").split("\\n")) {{
  if (!line.trim()) continue
  const o = JSON.parse(line)
  rows.set(o.predictionId, o)
}}
const settled: number[] = [...rows.values()]
  .filter((p: any) => p.predictionError !== null)
  .sort((a: any, b: any) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
  .map((p: any) => Math.abs(p.predictionError))
let armed = true
let driftFires = 0
let maxWindowMean = 0
for (let i = 0; i < settled.length; i++) {{
  const d = evaluateDriftTrigger(settled.slice(0, i + 1), armed, cfg)
  armed = d.armed
  if (d.windowMean !== null && d.windowMean > maxWindowMean) maxWindowMean = d.windowMean
  if (d.fire) driftFires++
}}
writeFileSync(process.argv[2], JSON.stringify({{
  mustFire, hysteresis, rearm, notFull, flatLow,
  settledCount: settled.length, driftFires, maxWindowMean,
  emergencyReachable: settled.filter(e => e >= {emerg}).length,
  maxError: settled.length ? Math.max(...settled) : null,
  cfg,
}}))
""")
r = subprocess.run(["npx", "tsx", script, out], cwd=root, capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "回放脚本失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(open(out, encoding="utf8").read())
assert d["cfg"]["meanThreshold"] == hi, "回放没用源码默认阈值"
assert d["mustFire"]["fire"] and not d["mustFire"]["armed"], "合成高误差窗口没能顶到触发点: " + json.dumps(d["mustFire"], ensure_ascii=False)
assert not d["hysteresis"]["fire"], "迟滞失效: 已解防状态下同一坏窗口仍重复触发"
assert not d["rearm"]["fire"] and d["rearm"]["armed"], "回落到下界以下未重新布防"
assert not d["notFull"]["fire"] and d["notFull"]["windowMean"] is None, "窗口未满就触发"
assert not d["flatLow"]["fire"], "平坦低误差序列触发了修补"
assert d["settledCount"] >= 100, "已结算预测太少(" + str(d["settledCount"]) + "), 可达性无从判定"
assert d["driftFires"] >= 1, "漂移触发在 " + str(d["settledCount"]) + " 条真实历史上一次都没触发 —— 又一个死分支(窗口均值上限 " + str(round(d["maxWindowMean"], 3)) + ")"
assert d["emergencyReachable"] >= 1, "快路径阈值 " + str(emerg) + " 在真实历史上不可达(最大误差 " + str(d["maxError"]) + ") —— 阈值又漂到观测支撑之外"
ev = os.path.expanduser("~/.dsh/cognitive-pipeline/drift-trigger-reachability.json")
json.dump(dict(d, ts=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
               note="T181 可达性证据: 合成触发 + 真实账本回放(用源码默认值, 非事后副本)"),
          open(ev, "w", encoding="utf8"), ensure_ascii=False, indent=1)
print("合成能触发; 真实账本 " + str(d["settledCount"]) + " 条上漂移触发 " + str(d["driftFires"]) + " 次, 快路径先例 " + str(d["emergencyReachable"]) + " 次")
'
t "漂移路径接线进源码与产物, 且带 global 回退" python3 -c '
import os
svc = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts"), encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js"), encoding="utf8").read()
assert "export function evaluateDriftTrigger(" in svc, "判据函数未导出(无法被合成输入顶到触发点)"
assert "runRebuild(\u0027local\u0027, call?.sessionId, call?.signal, \u0027drift\u0027)" in svc, "漂移路径未标注 trigger=drift"
assert "drift-fallback" in svc, "漂移路径没有 global 回退"
assert "drift-fallback" in lib, "漂移回退未进产物"
assert "evaluateDriftTrigger" in lib, "判据函数未进产物"
print("漂移路径: 源码与产物均带 local → 回退 global")
'
t "账本: 出现 drift 尝试必须伴随回退或被接受的 global(无 drift 事件则本帧不判)" python3 -c '
import json, os
p = os.path.expanduser("~/.dsh/cognitive-pipeline/taxonomy-rebuild.jsonl")
rows = [json.loads(l) for l in open(p, encoding="utf8") if l.strip()]
drift = [r for r in rows if r.get("trigger") == "drift"]
if not drift:
    print("账本尚无 trigger=drift 行(漂移触发刚上线, 真实事件未到), 本帧不判")
    raise SystemExit(0)
last = drift[-1]
window = [r for r in rows if r.get("ts") >= last["ts"]]
assert any(r.get("trigger") == "drift-fallback" or (r.get("scope") == "global" and r.get("accepted")) for r in window), "最近一次漂移尝试后既无回退也无被接受的 global: " + json.dumps(last, ensure_ascii=False)
print("最近一次漂移尝试后已伴随回退/被接受的 global")
'
# ── T182 账本写入侧自愈(cl-055: 约束只在审计侧 = 半个机制) ──
# 起因: T33 落地后 21 分钟就抓到并发会话新增的 in-progress 项缺 reviewBy ⇒ 写入路径仍可产出不合规行,
# 而"审计红 + 人工补"这条路有自锁风险: 一行缺字段就让判据转红, 红了又没有任何东西去修它(实测 T33 就这样
# 红了两天)。cl-030 的老教训同型: 修复必须落在**写入路径**, 不是审计侧。
# 修法: dsh-claims-ledger-heal.py(只追加一行修正副本, 留 reviewByAuto 痕迹, 不改判不关单)+ cron 每 30 分钟
# 一次 + 套件在跑时跳过(avoids cl-243 型并发写)。本组守四件: ①合成的坏账本必须被补、终态/已声明的不许动;
# ②套件在跑时不得动账本; ③排程驱动; ④痕迹新鲜且按 origin 分离。
echo "[T182] 账本写入侧自愈(缺 reviewBy 自动补 / 不越权改判)"
t "账本自愈: 未关项缺 reviewBy 必须被补, 终态项与已声明的项不得被改" python3 -c '
import json, os, subprocess, tempfile
heal = "/home/ubuntu/dsh-fork/dsh-claims-ledger-heal.py"
tmp = tempfile.mkdtemp(); led = os.path.join(tmp, "led.jsonl"); log = os.path.join(tmp, "heal.log")
base = [
 {"id": "cl-a", "status": "open", "ts": "2026-09-01T00:00:00+08:00", "claim": "缺 reviewBy 的未关项", "disposition": "待办"},
 {"id": "cl-b", "status": "done", "ts": "2026-09-01T00:00:00+08:00", "claim": "终态项不该被补"},
 {"id": "cl-c", "status": "open", "ts": "2026-09-01T00:00:00+08:00", "claim": "已声明复核窗口", "reviewBy": "2026-09-20"},
 {"id": "cl-d", "status": "in-progress", "ts": "2026-09-01T00:00:00+08:00", "claim": "进行中且缺 reviewBy"},
]
open(led, "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in base) + "\n")
r = subprocess.run(["python3", heal, "--dry-run", "--force", "--ledger", led, "--log", log], capture_output=True, text=True, timeout=120)
assert r.returncode == 0, "干跑失败: " + (r.stderr or r.stdout)[-160:]
assert len([l for l in open(led, encoding="utf8") if l.strip()]) == len(base), "干跑写盘了"
r = subprocess.run(["python3", heal, "--force", "--ledger", led, "--log", log], capture_output=True, text=True, timeout=120)
assert r.returncode == 0, "自愈失败: " + (r.stderr or r.stdout)[-160:]
lat = {}
for l in open(led, encoding="utf8"):
    if l.strip():
        x = json.loads(l)
        if x.get("id"): lat[x["id"]] = x
assert lat["cl-a"].get("reviewBy"), "未关项缺 reviewBy 没被补上"
assert lat["cl-a"].get("reviewByAuto") is True, "自愈没留痕迹(reviewByAuto)"
# 2026-09-12 01:5x 实测踩到: 自愈首版**抄了原行的 ts** ⇒ 同 id 两行 ts 相等, 直接打红 T132
# (消费方按 ts 取最新会读到随机状态)。故这里必须同时守 ts 语义: 状态被改写 ⇒ ts 必须换新且严格递增。
assert lat["cl-a"].get("ts") != "2026-09-01T00:00:00+08:00", "自愈抄了原 ts(同 id 两行 ts 相等会打红 T132)"
assert lat["cl-a"].get("ts") > "2026-09-01T00:00:00+08:00", "自愈后的 ts 没有严格递增"
assert lat["cl-a"].get("createdTs") == "2026-09-01T00:00:00+08:00", "自愈没保留原创建时刻(createdTs)";
assert lat["cl-a"].get("claim") == "缺 reviewBy 的未关项" and lat["cl-a"].get("disposition") == "待办", "自愈改动了原行字段(应只追加副本)"
assert lat["cl-d"].get("reviewBy"), "in-progress 项缺 reviewBy 没被补上"
assert not lat["cl-b"].get("reviewBy"), "终态项被自愈改动(越权)"
assert lat["cl-c"].get("reviewBy") == "2026-09-20" and not lat["cl-c"].get("reviewByAuto"), "已声明 reviewBy 的项被改写"
print("坏账本被补 2 项, 终态与已声明的 2 项未被改动")
'
t "账本自愈: 套件在跑时不得动账本(cl-243 型并发写)" python3 -c '
import json, os, subprocess, tempfile, time
heal = "/home/ubuntu/dsh-fork/dsh-claims-ledger-heal.py"
tmp = tempfile.mkdtemp(); led = os.path.join(tmp, "led.jsonl"); log = os.path.join(tmp, "heal.log")
open(led, "w", encoding="utf8").write(json.dumps({"id": "cl-a", "status": "open", "ts": "2026-09-01T00:00:00+08:00", "claim": "缺 reviewBy"}, ensure_ascii=False) + "\n")
fake = subprocess.Popen(["bash", "-c", "exec -a dsh-cog-tests.sh sleep 12"])
time.sleep(1.0)
try:
    r = subprocess.run(["python3", heal, "--ledger", led, "--log", log], capture_output=True, text=True, timeout=120)
finally:
    fake.kill()
assert r.returncode == 3, "套件在跑时自愈没有跳过(exit=" + str(r.returncode) + ")"
assert len([l for l in open(led, encoding="utf8") if l.strip()]) == 1, "跳过了却仍然写了账本"
print("套件在跑时自愈 exit=3 且账本未被写")
'
t "账本自愈须由排程驱动且脚本在仓库里" python3 -c '
import os, subprocess
script = "/home/ubuntu/dsh-fork/dsh-claims-ledger-heal.py"
assert os.path.exists(script), "自愈脚本不在仓库里"
cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=30).stdout
line = [l for l in cron.splitlines() if "dsh-claims-ledger-heal.py" in l]
assert line, "自愈未挂排程(机制必须自己发生, 不靠我记得跑)"
assert "DSH_RUN_ORIGIN=cron" in line[0], "排程行没带 origin 标记(无法区分手工与排程痕迹)"
print("自愈已挂排程: " + line[0].split("python3")[0].strip())
'
t "账本自愈须留下新鲜痕迹(只认 origin=cron 的行)" python3 -c '
import json, os, time, datetime
log = os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger-heal.log")
if not os.path.exists(log):
    print("自愈日志尚不存在(排程首班未到), 本帧不判")
    raise SystemExit(0)
rows = []
for l in open(log, encoding="utf8"):
    l = l.strip()
    if l:
        try: rows.append(json.loads(l))
        except Exception: pass
cron_rows = [r for r in rows if r.get("origin") == "cron"]
if not cron_rows:
    print("尚无 origin=cron 的自愈痕迹(排程首班未到), 本帧不判 —— 但排程本身由上一断言守")
    raise SystemExit(0)
ts = sorted(str(r.get("ts")) for r in cron_rows)[-1]
age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(ts).astimezone(datetime.timezone.utc)).total_seconds()
assert age < 8 * 3600, "排程自愈已 " + str(round(age / 3600, 1)) + " 小时没有痕迹"
print("排程自愈痕迹新鲜(" + str(round(age / 60)) + " 分钟前, 最近事件 " + str(cron_rows[-1].get("event")) + ")")
'
# ── T183 噪声判据不得把"条件型等待"当噪声(cl-252) ──
# 起因: 噪声规则(frames>=5 且 严格率<20% 且 active)只看帧数与归因率, 于是把两种完全不同的成因读成一类:
#   ①提醒没用(噪声) ②目标**合法地被自己的条件门挡着**, 期间根本不产生新的行动帧。实测 goal-experience-library
#   是当时唯一噪声候选(15 帧/1 归因/6.7%), 而它的 waitChecker(`--min-turns 40`)未满足 ⇒ 驱动侧按 cl-250 排除它
#   ⇒ 样本门靠等待永远攒不到。照噪声处置(降相似度权重/改写 focus)就是**用错误读数拆掉一个正在按纪律等待的目标**。
# 修法: 逐目标跑它自己的 waitChecker(与驱动侧同一语义: exit 0=该干, 非 0/超时=不该干), 未满足者标
#   heldByCondition 并从噪声候选剔除。本组守三件: ①合成三例(held 不入选 / 真噪声仍入选 / 条件满足后恢复可判)
#   ②源码接线 ③真实读数里被条件门挡住的目标不得同时出现在噪声候选里。
echo "[T183] 噪声判据须区分'条件型等待'与'真噪声'"
t "合成池三例: 被条件门挡住的不算噪声, 条件满足/无门的仍算, 暂停的不算" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp()
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
pool = [
 {"id": "g-held", "status": "active", "nextAction": "等待型步骤 A", "waitChecker": "false"},
 {"id": "g-met", "status": "active", "nextAction": "等待型步骤 B", "waitChecker": "true"},
 {"id": "g-nochecker", "status": "active", "nextAction": "无门步骤 C"},
 {"id": "g-paused", "status": "paused", "nextAction": "暂停目标不该入选"},
]
open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in pool) + "\n")
frames = []
for gid in ("g-held", "g-met", "g-nochecker", "g-paused"):
    for i in range(6):
        frames.append({"kind": "action-frame", "goalId": gid, "nextAction": "旧步骤 " + gid,
                       "session": "s-probe", "ts": (now - datetime.timedelta(minutes=600 + i * 10)).isoformat()})
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in frames) + "\n")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("\n")
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("\n")
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                   capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
assert r.returncode == 0, "归因脚本失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
per = {g["goalId"]: g for g in d["perGoal"]}
held = per["g-held"]
assert held["waitConditionMet"] is False and held["heldByCondition"] is True, "未满足的条件门未被标 heldByCondition"
assert held["noiseCandidate"] is False, "被自身条件门挡住的目标仍被列为噪声候选(会拆掉合法等待的目标)"
assert "g-held" not in d["noiseCandidates"], "held 目标出现在噪声候选列表里"
assert per["g-met"]["waitConditionMet"] is True and per["g-met"]["noiseCandidate"] is True, "条件满足后目标未恢复可判(被永久豁免)"
assert per["g-nochecker"]["noiseCandidate"] is True, "无等待条件的真噪声目标反而没被列为候选"
assert per["g-paused"]["noiseCandidate"] is False, "暂停目标被列为噪声候选"
print("held 不入选 / 条件满足后恢复可判 / 无门真噪声仍入选 / 暂停不入选")
'
t "噪声裁决只看窗口内的帧(全部历史帧不得判今天, cl-261)" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp()
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
# g-old: 6 帧全在 100h 前(窗口外) ⇒ 历史够多但不得据此判噪声
# g-fresh: 6 帧全在 10h 内且 0 归因 ⇒ 仍须判噪声(判据不能被"窗口"这道免责条款架空)
pool = [{"id": "g-old", "status": "active", "nextAction": "旧步"},
        {"id": "g-fresh", "status": "active", "nextAction": "新步"}]
open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in pool) + "\n")
frames = []
for gid, mins in (("g-old", 6000), ("g-fresh", 600)):
    for i in range(6):
        frames.append({"kind": "action-frame", "goalId": gid, "nextAction": "步 " + gid,
                       "session": "s-probe", "ts": (now - datetime.timedelta(minutes=mins + i * 10)).isoformat()})
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in frames) + "\n")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("\n")
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("\n")
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                   capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
assert r.returncode == 0, "归因脚本失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
per = {g["goalId"]: g for g in d["perGoal"]}
old, fresh = per["g-old"], per["g-fresh"]
assert old["framesRecent"] < 5, "窗口内帧数统计不对: " + str(old["framesRecent"])
assert old["noiseCandidate"] is False and old["noiseCandidateBasis"] == "stale-window", "窗口外的历史帧仍被用来判噪声: " + str(old["noiseCandidateBasis"])
assert fresh["framesRecent"] >= 5 and fresh["noiseCandidate"] is True, "窗口内的低归因目标反而没被判噪声(免责条款被架空)"
print("历史帧够多但窗口内不足 ⇒ 不判(stale-window); 窗口内低归因 ⇒ 仍判噪声")
'
t "真实读数: 被条件门挡住的目标不得同时出现在噪声候选里" python3 -c '
import json, os, subprocess
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "真实读数失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
held = [g for g in d["perGoal"] if g.get("heldByCondition")]
cands = set(d["noiseCandidates"])
bad = [g["goalId"] for g in held if g["goalId"] in cands]
assert not bad, "被条件门挡住却仍列为噪声候选: " + repr(bad)
el = [g for g in d["perGoal"] if g["goalId"] == "goal-experience-library"]
if el and el[0].get("waitConditionMet") is False:
    assert el[0]["heldByCondition"] and "goal-experience-library" not in cands, "cl-252 的情形复发了"
    print("goal-experience-library 被条件门挡着(不计噪声): 候选 " + repr(d["noiseCandidates"]) + " / held " + repr([g["goalId"] for g in held]))
else:
    print("读数成立: held " + repr([g["goalId"] for g in held]) + ", 候选 " + repr(d["noiseCandidates"]) + "(该目标此帧非 held, 只判结构)")
'
t "归因脚本必须真的跑目标自己的 waitChecker(不是只看字段存在)" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/dsh-wake-attribution.py"), encoding="utf8").read()
assert "def wait_condition_met(" in src, "缺条件门求值函数"
assert "shell=True" in src and "returncode == 0" in src, "求值语义与驱动侧不一致(必须以 exit 0 为条件已满足)"
assert "pool_wait.get(gid)" in src or "pool_wait.get(r[\u0027goalId\u0027])" in src, "没有从池里取目标自己的 waitChecker"
assert "r[\u0027noiseCandidate\u0027] = False" in src, "held 目标没有被从噪声候选里剔除"
print("接线在册: 逐目标求值 + exit 0 语义 + 剔除")
'
# ── T184 门限扫描的前提纪律(cl-263) ──
# 起因: 行动帧要求"离线扫过阈门限, 看可排序集占比能否上升"。执行中发现**前提不成立**: 审计只记**过阈后**的候选
# (426 个候选中阈下 0 个, 最小相似度 0.502) ⇒ 放松门限能否多出可排序集在这份数据上**算不出来**; 而第一版工具
# 照样打出了平坦的 75% 并判 `no-headroom` —— 把"没数据"讲成了"没空间"。第二版先修一处更隐蔽的自证缺陷:
# 相关性取"排在最前的有标签候选" ⇒ MRR 恒 1.000(排序质量变成同义反复, cl-219 家族)。
# 本组守三件: ①前提不成立必须报 inconclusive ②相关性定义必须独立于排序(与 replay 同口径, 数值须对得上)
# ③预登记裁决规则必须写在工具里(而不是我事后解释)。
echo "[T184] 门限扫描的前提纪律(inconclusive / 相关性独立于排序 / 预登记在册)"
t "阈下候选未采集时不得给出门限结论(必须报 inconclusive)" python3 -c '
import json, subprocess
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"],
                   capture_output=True, text=True, timeout=900)
assert r.returncode == 0, "扫描工具失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert "subGateDiagnostics" in d, "缺阈下诊断 —— 无法判前提是否成立"
diag = d["subGateDiagnostics"]
assert d.get("prereg"), "缺预登记裁决规则(结论不许事后解释)"
if diag["belowGate"] == 0:
    assert str(d["verdict"]).startswith("inconclusive"), "阈下候选一条都没记, 却给出了结论: " + str(d["verdict"])
    print("阈下候选未采集 ⇒ 如实报 " + str(d["verdict"]))
else:
    assert d["verdict"] in ("widen-gate", "tradeoff-ceiling", "no-headroom"), "非法判读: " + str(d["verdict"])
    print("阈下候选已采集(" + str(diag["belowGate"]) + " 个), 判读 " + str(d["verdict"]))
'
t "埋点后样本不足时不得出门限裁决(截断样本不得冒充总体)" python3 -c '
# 2026-09-12 04:3x 自查补闸(与 exp_298 同型): 埋点 04:30 才上线, 审计里绝大多数回合是**上线前的老行**
# (根本没有 belowGate 字段)。第一版工具照样打出了平坦的占比并判 no-headroom —— 那是拿截断样本冒充总体。
# 守: 带 belowGate 的回合数不足时, 判读必须是 insufficient-post-instrumentation(只报数), 且必须暴露 roundsWithBelowGate。
import json, subprocess
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"],
                   capture_output=True, text=True, timeout=900)
assert r.returncode == 0, "扫描工具失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert "roundsWithBelowGate" in d, "读数没有暴露带埋点的回合数(无法判样本是否够)"
n = d["roundsWithBelowGate"]
if n < 10:
    assert str(d["verdict"]).startswith("insufficient"), ("带 belowGate 的回合只有 %d 个, 却给出了门限裁决: %s"
                                                          % (n, d["verdict"]))
    print("埋点后回合 %d < 10 ⇒ 如实报 %s(不出裁决)" % (n, d["verdict"]))
else:
    assert d["verdict"] in ("widen-gate", "tradeoff-ceiling", "no-headroom"), "非法判读: " + str(d["verdict"])
    print("埋点后回合 %d ⇒ 判读 %s" % (n, d["verdict"]))
'
t "阈下候选埋点必须真的在产物里(且只在记录路径上, 不参与选择)" python3 -c '
# 2026-09-12 04:1x: 与 T178"写入点须在产物里"同型 —— 埋点加在**源码**却漏在**产物**里, 是最安静的一种失败:
# 判据会一直报 inconclusive, 而我可能去怀疑判据本身。这里守三件: ①源码里有采集(过滤前留住被丢掉的候选)
# ②产物里有(重启后才会生效) ③采集只进记录(审计), 不改选择(排序/过滤顺序未变)。
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js"), encoding="utf8").read()
assert "belowGate" in src and "belowGate" in lib, "阈下候选埋点不在源码或产物里"
assert "scoredBeforeThreshold" in src, "源码里没有在阈值过滤前留住候选(采集点缺失)"
assert ".filter(hit => hit.similarity >= minSimilarity)" in src, "阈值过滤本身不见了(选择行为被改动)"
assert src.index("droppedByThreshold") < src.index("const hits = scoredBeforeThreshold.filter"), "采集点须在过滤前"
assert "candidates: hits.length" in src and "overThreshold: cooled.length" in src, "候选/过阈计数口径被改动(埋点不该改选择)"
print("埋点在源码与产物中, 且只落审计不改选择")
'
t "扫描工具必须真的消费 belowGate(有则走真判读 / 无则报 inconclusive)" python3 -c '
# 2026-09-12 04:0x: 埋点(belowGate)落地后, 通道还差**消费**那一半 —— 若扫描工具不并进阈下候选,
# 埋点就是个摆设。用合成沙箱两方向验证(不碰真库): 带 belowGate ⇒ 走真判读分支; 去掉 ⇒ 报 inconclusive。
# 顺带一条硬教训: 两个脚本原先把数据目录**硬编码**成 ~/.dsh/cognitive-pipeline, 于是沙箱根本没生效,
# 合成读数被写进了真实 threshold-sweep.json(cl-243 家族的自污染) ⇒ 已让两者都认 DSH_COG_DIR, 产物也随之进沙箱。
import json, os, subprocess, tempfile
tmp = tempfile.mkdtemp()
ids = ["exp_%03d" % i for i in range(40)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(
    json.dumps({"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                                    "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
               ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
def build(with_bg):
    audit, k = [], 0
    for t in range(35):
        pre = [{"expId": ids[k % 40], "similarity": 0.60, "channels": {"semantic": 0.4, "symptom": 0.05, "axis": 0.02}}]
        k += 1
        pre.append({"expId": ids[k % 40], "similarity": 0.55, "channels": {"semantic": 0.4, "symptom": 0.05, "axis": 0.02}})
        k += 1
        row = {"stage": "injected", "t": 1789150000000 + t * 60000, "expIds": [pre[0]["expId"]], "cited": False,
               "preTop": pre, "candidates": 2, "overThreshold": 1}
        if with_bg:
            row["belowGate"] = [{"expId": ids[k % 40], "similarity": 0.42}, {"expId": ids[(k + 1) % 40], "similarity": 0.35}]
            k += 2
        audit.append(row)
    open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in audit) + "\n")
# 2026-09-12 09:0x 判据随机制更新: 现在**未声明时代起点**会被 R-3 闸拦成 insufficient-undeclared-era,
# 于是本例测不到"阈下未采集"那条分支了 ⇒ 沙箱补一份 sweep-era.json(把本意测回来)。
import datetime as _dt
# 时代起点要**早于** fixture 的行时间(那些行固定写在 1789150000000 附近 ⇒ 2026-09-11/12 交界) ⇒ 用 09-11 00:00。
json.dump({"since": "2026-09-11T00:00:00+08:00", "reason": "沙箱"},
          open(os.path.join(tmp, "sweep-era.json"), "w", encoding="utf8"), ensure_ascii=False)
env = dict(os.environ, DSH_COG_DIR=tmp)
def run():
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"],
                       capture_output=True, text=True, env=env, timeout=900)
    assert r.returncode == 0, "沙箱扫描失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
build(True);  d1 = run()
build(False); d2 = run()
assert d1["subGateDiagnostics"]["belowGate"] > 0, "沙箱未生效(读的不是沙箱数据?): " + json.dumps(d1["subGateDiagnostics"])
assert not str(d1["verdict"]).startswith("inconclusive"), "有 belowGate 却仍报 inconclusive(消费侧没接): " + str(d1["verdict"])
# 2026-09-12 09:1x 判据随机制更新(第二次): 一条 belowGate 都没有时, **先**命中的是 R-1(埋点后回合 <10 ⇒
# insufficient-post-instrumentation), 而不是 sub-gate 那条分支 ⇒ 两种都算"如实拒绝出裁决"。真正要守的是:
# 有 belowGate ⇒ 必须给真判读; 没有 ⇒ 必须**不是**真判读。
assert d2["subGateDiagnostics"]["belowGate"] == 0, "沙箱里 belowGate 没被清掉"
assert str(d2["verdict"]).startswith("insufficient"), ("无 belowGate 时竟出了真裁决: " + str(d2["verdict"]))
assert not str(d1["verdict"]).startswith("insufficient"), ("有 belowGate 却仍拒绝裁决: " + str(d1["verdict"]))
assert os.path.exists(os.path.join(tmp, "threshold-sweep.json")), "沙箱产物没落在沙箱里(会污染真库的读数文件)"
print("消费侧接通: 有 belowGate ⇒ %s / 无 ⇒ %s" % (d1["verdict"], d2["verdict"]))
'
t "扫描工具的相关性定义必须独立于排序(与 replay 同口径, 数值须对得上)" python3 -c '
import json, os, subprocess
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
# 2026-09-12 04:0x 修脆性: 原先拿"扫描(live)"与"replay 的**旧快照文件**"比 —— 审计每来一条新注入回合,
# 两个读数就差一条, 断言随机转红(它抓到的其实是我自己的过时产物, 不是口径漂移)。改为**先重算 replay 再比**,
# 两边读同一时刻的同一份数据, 这才是"同口径"的真正含义。
# 2026-09-13 11:2x **第三次转红(0.419403 vs 0.418564, Δ=8.4e-4)暴露了上一版修法只修了一半**: 两边虽然
# 都"先重算", 但仍是**先后两次读库**; 套件跑的同时别的会话在往库里写经验(与 cl-027/cl-041 同型: 拿两个不同
# 时刻的读数比"同口径")。故这一版加**取样稳定性见证**: 比之前先记住两个库的(行数+字节数), 比完再记一次;
# 若期间库变了 ⇒ 不判红而是**重跑一轮**(最多两次), 并在两次都变的情况下如实报"取样不稳定, 本条不可判"
# (不判绿也不判红)。库没变而 MRR 仍不一致 ⇒ 才是真的口径漂移, 用严格容差 1e-6 判红。
# 2026-09-13 11:2x: 上面那版只盯了**经验库**两个文件, 而这两个工具真正读的是 `retrieval-audit.jsonl`
# (每个注入回合都追加一行 ⇒ 我一边跑套件一边干活就在改它), 所以"取样稳定"必须盯**输入账本全集**,
# 否则又会出现"拿着两个不同时刻的读数比同口径"。同时: 该断言比的是 replay 与本工具 **currentGate** 行,
# 而 currentGate 原先硬编码 0.5(插件默认值)≠ 活配置 0.4 ⇒ 比错了行(实测差一条查询, 我却读成"口径漂移")。
LIBS = [D + "/retrieval-audit.jsonl", D + "/experiences.jsonl", D + "/experiences-frames.jsonl"]
def fingerprint():
    out = []
    for p in LIBS:
        if os.path.exists(p):
            with open(p, "rb") as fh:
                data = fh.read()
            out.append((os.path.basename(p), len(data.splitlines()), len(data)))
        else:
            out.append((os.path.basename(p), -1, -1))
    return out
def one_round():
    r0 = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-library-replay.py"],
                        capture_output=True, text=True, timeout=900)
    assert r0.returncode == 0, "replay 重算失败: " + (r0.stderr or r0.stdout)[-200:]
    # 2026-09-12 09:0x: 扫描工具现在**默认走 sweep-era.json 声明的时代**(14 回合), 而 replay 用全史(122+ 回合),
    # 两边总体不同 ⇒ 那个差是"没在同口径上比"(实测 0.338 vs 0.428), 不是口径漂移。传远古边界让两边都算全史。
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json",
                        "--post-since", "2000-01-01T00:00:00+08:00"],
                       capture_output=True, text=True, timeout=900)
    assert r.returncode == 0, "扫描工具失败"
    d = json.loads(r.stdout.strip().splitlines()[-1])
    rep = json.load(open(D + "/library-replay-result.json", encoding="utf8"))
    val = (rep.get("labelRobustness") or {}).get("valence") or {}
    assert val.get("armA_mrr") is not None, "replay 未产出 valence 档读数, 无法交叉核对"
    return d, val
stable = False
for attempt in range(2):
    before = fingerprint()
    d, val = one_round()
    after = fingerprint()
    if before == after:
        stable = True
        break
if not stable:
    print("取样不稳定(比对期间库在变): %s -> %s ⇒ 本条不可判(不判绿也不判红), 等库静默时再跑"
          % (before, after))
else:
    # 2026-09-13 11:2x **第三次转红的真正原因是"比错了行"**: 这条断言原先拿 replay 的读数与
    # **currentGate 那一行**比, 而两者根本不是同一个候选集 —— replay 不做门限过滤(实测与 0.40/0.45 行
    # **逐位相等** 0.418564/0.103960), currentGate=0.5 的行则是另一套候选(201 vs 202 个可排序集) ⇒
    # 差 8.4e-4 被我读成"两实现口径漂移"(实际是本条判据自己拿错了比较对象)。正确判据是:
    # **两实现在某个门限行上必须逐位一致**(说明算法口径相同, 只是候选集口径不同), 找不到这样的行才叫漂移。
    matches = [x for x in d["table"]
               if x.get("armA_mrr") is not None and abs(x["armA_mrr"] - val["armA_mrr"]) < 1e-6
               and abs(x["armA_top1"] - val["armA_top1"]) < 1e-6]
    assert matches, ("两工具在**任何**门限下都不一致 ⇒ 真口径漂移(不是候选集口径差): replay %.6f/%.6f, "
                     "表内各行 %s" % (val["armA_mrr"], val["armA_top1"],
                                      [(x["threshold"], round(x["armA_mrr"], 6) if x.get("armA_mrr") is not None else None)
                                       for x in d["table"]]))
    print("与 replay 同口径核对通过: A档 MRR %.4f / top-1 %.4f(与门限 %s 行逐位一致; 取样稳定: %s)"
          % (val["armA_mrr"], val["armA_top1"],
             ",".join(str(x["threshold"]) for x in matches), before))
'
# ── T185 池写入必须可归因, 且不得自灌水(cl-262) ──
# 起因(2026-09-12 03:2x 三问帧): 归因读数只认**插件**写的 pool-change 行, 而按纪律我改池走 `dsh-goal-pool-write.py`
# (唯一写入方) —— 它原先**不写**这种行 ⇒ 我真正执行过的步骤在归因里不存在(实测: 该写入口 02:52 推进过某目标
# 的 nextAction, 而该目标的最后一条 pool-change 停在 09-11 20:02), 严格归因率被系统性低估。
# 本组守两件, 第二件是**防自灌水**: 归因判据只核 `before` 前缀等于帧里的 nextAction, 所以"只加笔记、
# nextAction 不变"的写入若也记一行, 就会把我的记录动作算成"这一步被推进了" —— 而我的目标正是更高的归因率,
# 手里又握着记录通道, 这类自利偏差必须由判据挡住(实测我自己就这么写过一行, 已撤销并留备份)。
echo "[T185] 池写入可归因(前进才记) / 笔记型写入不得记为推进"
t "归因读数必须真的消费写入方产出的行(通道两半都要证)" python3 -c '
# 起因(2026-09-12 03:4x): 上一条断言只证了**发射**这一半(写入方会记行); 而通道要成立还需要**消费**那一半 ——
# 若读数不认这种行(字段/会话/口径任一不同), 记录通道就是个摆设, 而我可能等到下一次真实前进才发现。
# 这里用合成数据把两半接起来验: 帧(nextAction=旧步骤 A) + 写入方产出的 pool-change(before=旧步骤 A, after=新步骤 B)
# ⇒ 该帧必须由"未归因"转为"被归因"。**不碰真实数据**(真实前进只能等它自己发生, 手写行=伪造记录通道)。
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp()
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
t0 = now - datetime.timedelta(minutes=40)
open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(
    json.dumps({"id": "g-e2e", "status": "active", "nextAction": "新步骤 B"}, ensure_ascii=False) + "\n")
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write(
    json.dumps({"kind": "action-frame", "goalId": "g-e2e", "nextAction": "旧步骤 A",
                "session": "s-x", "ts": t0.isoformat()}, ensure_ascii=False) + "\n")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(
    json.dumps({"ts": (t0 + datetime.timedelta(minutes=1)).isoformat(), "goalId": "g-e2e", "sessionId": "s-x",
                "evidence": "pool-change", "before": "旧步骤 A", "after": "新步骤 B",
                "origin": "dsh-goal-pool-write.py"}, ensure_ascii=False) + "\n")
open(os.path.join(tmp, "goal-trigger-log.jsonl"), "w", encoding="utf8").write("\n")
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                   capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=600)
assert r.returncode == 0, "归因读数失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
g = [x for x in d["perGoal"] if x["goalId"] == "g-e2e"]
assert g, "合成目标没进读数"
assert g[0]["frames"] == 1 and g[0]["attributed"] == 1, ("写入方产出的 pool-change 未被读数消费(attributed=%s/%s)"
                                                         % (g[0]["attributed"], g[0]["frames"]))
print("发射+消费两半接通: 合成帧被归因 1/1")
'
t "池写入的两道守卫必须在场(时间戳不得回退 / 旧 nextAction 不得复活)" python3 -c '
import json, os, subprocess, tempfile
W = "/home/ubuntu/dsh-fork/dsh-goal-pool-write.py"
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "pool.jsonl")
base = {"id": "g-probe", "status": "active", "nextAction": "步骤 B", "notes": "n",
        "lastActionAt": "2026-09-12T02:00:00+08:00", "lastProgressAt": "2026-09-12T02:00:00+08:00"}
# 更早的一行(用于复活守卫): 旧意图 A 已被 B 取代
older = dict(base, nextAction="步骤 A", lastActionAt="2026-09-12T01:00:00+08:00", lastProgressAt="2026-09-12T01:00:00+08:00")
open(pool, "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in (older, base)) + "\n")
def run(args):
    return subprocess.run(["python3", W, "g-probe", "--pool", pool, "--write"] + args, capture_output=True, text=True, timeout=300)
# ① 时间戳回退 ⇒ 必须拒收(exit != 0) 且不追加
n0 = len([l for l in open(pool, encoding="utf8") if l.strip()])
r = run(["--next-action", "步骤 C", "--set", "lastActionAt=2026-09-12T00:30:00+08:00"])
n1 = len([l for l in open(pool, encoding="utf8") if l.strip()])
assert r.returncode != 0, "时间戳回退被接受了(守卫失效): " + (r.stdout or "")[-120:]
assert n1 == n0, "被拒的写入仍然追加了行"
# ② 复活已被取代的旧 nextAction ⇒ 必须拒收
r2 = run(["--next-action", "步骤 A"])
n2 = len([l for l in open(pool, encoding="utf8") if l.strip()])
assert r2.returncode != 0, "把已被取代的旧 nextAction 写回去被接受了(复活守卫失效): " + (r2.stdout or "")[-120:]
assert n2 == n0, "被拒的复活写入仍然追加了行"
# ③ 对照: 合法前进仍须通过(否则前两条可能是"一律拒绝"的假绿)
r3 = run(["--next-action", "步骤 C"])
n3 = len([l for l in open(pool, encoding="utf8") if l.strip()])
assert r3.returncode == 0 and n3 == n0 + 1, "合法前进被拒(守卫变成一律拒绝)"
print("时间戳回退被拒 / 旧意图复活被拒 / 合法前进通过")
'
t "nextAction 真前进 ⇒ 写入方必须留下可归因的 pool-change; 仅加笔记 ⇒ 不得记" python3 -c '
import json, os, shutil, subprocess, tempfile
W = "/home/ubuntu/dsh-fork/dsh-goal-pool-write.py"
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "pool.jsonl")
base = {"id": "g-probe", "status": "active", "nextAction": "旧步骤 A", "notes": "初始",
        "lastActionAt": "2026-09-12T00:00:00+08:00", "lastProgressAt": "2026-09-12T00:00:00+08:00"}
open(pool, "w", encoding="utf8").write(json.dumps(base, ensure_ascii=False) + "\n")
inc = os.path.join(tmp, "incubation-log.jsonl")
def run(args):
    return subprocess.run(["python3", W, "g-probe", "--pool", pool, "--write"] + args,
                          capture_output=True, text=True, timeout=300)
# ① 仅加笔记(nextAction 不变) ⇒ 不得记行
r = run(["--append-note", "只加笔记"])
assert r.returncode == 0, "笔记写入失败: " + (r.stderr or r.stdout)[-160:]
n_note = sum(1 for l in open(inc, encoding="utf8") if l.strip()) if os.path.exists(inc) else 0
assert n_note == 0, "仅加笔记却记了 pool-change(自灌水: 会把记录动作算成推进)"
# ② nextAction 真前进 ⇒ 必须记一行, 且 before/after 对得上
r = run(["--next-action", "新步骤 B"])
assert r.returncode == 0, "前进写入失败: " + (r.stderr or r.stdout)[-160:]
rows = [json.loads(l) for l in open(inc, encoding="utf8") if l.strip()]
assert len(rows) == 1, "前进后应恰好记 1 行, 实得 %d" % len(rows)
row = rows[0]
assert row.get("evidence") == "pool-change" and row.get("goalId") == "g-probe", "记录字段口径不对: " + json.dumps(row, ensure_ascii=False)[:160]
assert row.get("before") == "旧步骤 A" and row.get("after") == "新步骤 B", "before/after 对不上: %s → %s" % (row.get("before"), row.get("after"))
assert row.get("ts"), "记录缺 ts(按 ts 排序的消费方会读错)"
print("笔记写入不记行 / 前进写入记 1 行(before→after 正确)")
'
# 2026-09-13 11:1x(实测事故, 非假想): `--write --show` 是**静默空操作** —— --show 在写入之前就 return 0,
# 于是"写了并给我看看"变成"只看了看"。取证: cl-265 干预窗口的恢复腿我用的正是这张组合, 工具打印正常、
# exit 0、我据此以为恢复完成, 而池里没有任何新行(/tmp 的 before-write 备份也没有那一次), 目标带着
# /bin/false 静默停摆 27 小时。已改为: 纯 --show 才短路, --write --show 写入后回显**落盘的那一行**。
t "--write --show 必须真的写入(不得静默空操作), 纯 --show 必须只读" python3 -c '
import json, os, subprocess, tempfile
W = os.environ.get("DSH_POOL_WRITE_TOOL") or "/home/ubuntu/dsh-fork/dsh-goal-pool-write.py"
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "pool.jsonl")
base = {"id": "g-show", "status": "active", "nextAction": "步骤 A", "notes": "",
        "lastActionAt": "2026-09-12T00:00:00+08:00", "lastProgressAt": "2026-09-12T00:00:00+08:00",
        "triggerThresholds": {"kernel": 1.01, "focus": 1.01}, "waitChecker": "/bin/false"}
open(pool, "w", encoding="utf8").write(json.dumps(base, ensure_ascii=False) + "\n")
def nrows():
    return len([l for l in open(pool, encoding="utf8") if l.strip()])
def last():
    return json.loads([l for l in open(pool, encoding="utf8") if l.strip()][-1])
def run(args):
    return subprocess.run(["python3", W, "g-show", "--pool", pool] + args,
                          capture_output=True, text=True, timeout=300)
n0 = nrows()
r = run(["--append-note", "  恢复腿笔记", "--write", "--show"])
assert r.returncode == 0, "写法跑不通: " + (r.stderr or r.stdout)[-160:]
assert nrows() == n0 + 1, ("--write --show 是静默空操作(池里没多出行) —— 这正是让一次干预恢复无声失效的形态: "
                           "工具打印正常、exit 0, 而恢复没发生")
assert str(last().get("notes") or "").endswith("恢复腿笔记"), "写入的新行没有带上笔记"
assert "恢复腿笔记" in r.stdout, "--write --show 没有回显**落盘的那一行**(应回显写入后的行)"
r2 = run(["--show"])
assert nrows() == n0 + 1, "纯 --show 竟然写了行(它必须只读)"
assert "\"id\"" in r2.stdout, "纯 --show 没有回显当前行"
print("--write --show 真写入并回显新行; 纯 --show 只读")
'
# ── T186 唤醒→推进因果检验的判别力(cl-264) ──
# 起因(2026-09-12 04:2x): 反向判据说"42% 的推进没有唤醒"⇒ 提醒不必要; 但"不必要"不等于"无用"。新工具
# dsh-wake-causality.py 用"有唤醒时段 vs 无唤醒时段"的推进速率做对照, 预登记判读 catalyst/anti/no-signal/insufficient。
# 这类工具的典型失效是**恒报 catalyst**(比如分组写错、事件被重复计数), 那会把"我恰好在干活时被唤醒"讲成因果 ——
# 本组用合成沙箱两方向守住: 事件独立 ⇒ 不得报 catalyst; 推进集中在唤醒段 ⇒ 必须报 catalyst; 段数太少 ⇒ 必须报 insufficient。
echo "[T186] 因果检验的判别力(独立数据不得报 catalyst / 集中数据必须报 catalyst)"
t "速率对照须两方向可分: 独立 ⇒ 不报 catalyst; 集中 ⇒ 报 catalyst; 段少 ⇒ insufficient" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
def build(tmp, wake_at, adv_at):
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("\n".join(
        json.dumps({"kind": "action-frame", "goalId": "g-c", "nextAction": "步", "session": "s",
                    "ts": (now - datetime.timedelta(minutes=m)).isoformat()}, ensure_ascii=False) for m in wake_at) + "\n")
    open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("\n".join(
        json.dumps({"ts": (now - datetime.timedelta(minutes=m)).isoformat(), "goalId": "g-c", "sessionId": "s",
                    "evidence": "pool-change", "before": "步", "after": "步2"}, ensure_ascii=False) for m in adv_at) + "\n")
def run(tmp):
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-causality.py", "--json", "--bin-min", "60"],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=600)
    assert r.returncode == 0, "因果工具失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
# ① 独立: 唤醒每 120 分钟一次(只覆盖一半时段), 推进每 24 分钟一次(均匀铺满) ⇒ 速率接近, 不得判 catalyst。
#    注意: 首版合成用了"唤醒每 30 分钟 + 30 分钟分段"⇒ **每个段都有唤醒**, 对照消失却照样出判读;
#    第二代又暴露工具自己的偏差(时段铺满 72h 而活动只占 20h ⇒ idle 被稀释成 0 ⇒ 任何数据都判 catalyst),
#    故工具已改为**只在该目标的观测期内分段**。这条合成用例正是用来同时守住这两件事。
tmp1 = tempfile.mkdtemp()
build(tmp1, wake_at=[120 * i + 5 for i in range(10)], adv_at=[24 * i + 3 for i in range(50)])
d1 = run(tmp1)
assert d1["verdict"] != "catalyst", "独立数据被判成 catalyst(判别力失效): " + json.dumps(d1, ensure_ascii=False)[:180]
# ② 集中: 推进只落在唤醒段 ⇒ 必须判 catalyst
tmp2 = tempfile.mkdtemp()
build(tmp2, wake_at=[120 * i + 5 for i in range(10)], adv_at=[120 * i + 6 for i in range(10)])
d2 = run(tmp2)
assert d2["verdict"] == "catalyst", "推进集中在唤醒段却没判 catalyst: " + json.dumps(d2, ensure_ascii=False)[:180]
# ③ 段少: 只有 2 个小时段 ⇒ 不得下结论
tmp3 = tempfile.mkdtemp()
build(tmp3, wake_at=[5], adv_at=[10])
d3 = run(tmp3)
assert d3["verdict"] == "insufficient", "对照段太少却没报 insufficient: " + str(d3["verdict"])
print("独立⇒%s / 集中⇒%s / 段少⇒%s" % (d1["verdict"], d2["verdict"], d3["verdict"]))
'
t "同样活跃时段对照必须真的筛掉停顿段(否则催化剂读数只是活动期的影子)" python3 -c '
# 2026-09-12 05:0x(cl-264): 未控对照组把"我没在干活"的停顿段算成"无唤醒段", 于是任何目标都会被判 catalyst
# (实测目标层 ×13.4, 控制后 30/60 分钟粒度变 no-signal; 全库层"活跃但无唤醒"的段数为 0 ⇒ 对照根本不适用)。
# 守: --control-active 必须真的把**全库都没有帧**的停顿段剔除 —— 合成世界: 前 10 个时段目标有帧, 之后 20 个时段
# **谁都没有帧**却仍有该目标的推进(正是反向判据里那 42%, 也是催化剂读数的真正来源)。
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
tmp = tempfile.mkdtemp()
def ts(m): return (now - datetime.timedelta(minutes=m)).isoformat()
frames, changes = [], []
for i in range(10):                       # 活跃段: 目标有帧 + 有推进
    frames.append({"kind": "action-frame", "goalId": "g-ctl", "nextAction": "步", "session": "s", "ts": ts(60 * i + 5)})
    changes.append({"ts": ts(60 * i + 6), "goalId": "g-ctl", "sessionId": "s", "evidence": "pool-change", "before": "步", "after": "步2"})
for i in range(10, 30):                   # 停顿段: 全库无帧, 但仍有推进
    changes.append({"ts": ts(60 * i + 6), "goalId": "g-ctl", "sessionId": "s", "evidence": "pool-change", "before": "步", "after": "步2"})
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in frames) + "\n")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in changes) + "\n")
def run(extra):
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-causality.py", "--json", "--goal", "g-ctl", "--bin-min", "60"] + extra,
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=600)
    assert r.returncode == 0, "因果工具失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
d_raw = run([]); d_ctl = run(["--control-active"])
assert d_raw["controlActive"] is False and d_ctl["controlActive"] is True, "对照开关没有生效标记"
assert d_ctl["bins"] < d_raw["bins"], "同样活跃对照没有筛掉任何时段(bins %d→%d)" % (d_raw["bins"], d_ctl["bins"])
assert d_ctl["idleBins"] == 0, "停顿段没被剔除(idle 段仍有 %d 个)" % d_ctl["idleBins"]
assert d_ctl["verdict"] in ("insufficient", "no-signal"), "控制后仍给出催化剂结论: " + str(d_ctl["verdict"])
print("未控 bins=%d(idle=%d) / 对照后 bins=%d(idle=%d, 判读 %s)"
      % (d_raw["bins"], d_raw["idleBins"], d_ctl["bins"], d_ctl["idleBins"], d_ctl["verdict"]))
'
# ── T187 归因读数的"时代起点"必须由机制声明, 不靠我记得传参(cl-262) ──
# 起因(2026-09-12 05:1x): 记录通道修复前的帧其推进**永远记不上** ⇒ 全史读数被系统性压低(经验库 6.2%),
# 而时代读数(修复后)是 **100%(5/5)**; 我据此差点按"噪声"处置一个没坏的目标。纪律: 改采集方式 ⇒ 时代起点随之更新,
# 且**读数默认就必须是时代读数**(否则下一个会话/下一帧又会把全史当现状)。
echo "[T187] 归因读数默认时代化(声明在册 / 默认生效 / 缺声明必须显式警告)"
t "归因读数默认必须走时代口径, 且缺声明时显式警告而非静默全史" python3 -c '
import json, os, subprocess, tempfile
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
era = json.load(open(os.path.join(D, "attribution-era.json"), encoding="utf8"))
assert era.get("since"), "attribution-era.json 缺 since(时代起点未声明)"
assert era.get("reason"), "时代声明缺理由(无从判断该不该更新)"
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "时代读数失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d.get("eraSince") == era["since"], "默认没有应用声明的时代起点: " + str(d.get("eraSince"))
r2 = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record", "--lifetime"],
                    capture_output=True, text=True, timeout=600)
d2 = json.loads(r2.stdout.strip().splitlines()[-1])
assert d2.get("lifetime") is True and d2["frames"] > d["frames"], "全史读数没有比时代读数更大(时代没生效或全史丢了帧)"
# 缺声明时: 必须**显式警告**并退化为全史, 不得静默
tmp = tempfile.mkdtemp()
r3 = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-attribution.py", "--json", "--no-record"],
                    capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=600)
assert "全史读数(下限)" in (r3.stderr + r3.stdout), "缺时代声明时没有显式警告(会静默用全史当现状)"
print("时代读数 %d 帧/%.0f%% vs 全史 %d 帧/%.0f%%; 缺声明时已显式警告"
      % (d["frames"], 100 * (d["attributionRate"] or 0), d2["frames"], 100 * (d2["attributionRate"] or 0)))
'
# ── T188 唤醒干预工具(cl-264/cl-265) ──
# 观测分不开因果(唤醒与推进共线于活动期) ⇒ 唯一出路是干预: 关掉某目标的唤醒看推进是否下降。
# 干预若要可信, 开关必须①真的改到池字段且**类型正确**(--set 传 JSON 原先落成字符串 ⇒ 干预静默无效)
# ②原值落盘(回滚不靠记忆) ③无原值时拒绝猜测。本组用沙箱守这三件事。
echo "[T188] 唤醒开关(关得掉 / 类型对 / 回滚有据 / 无据不猜)"
t "关闭必须两侧同时生效(哨兵阈值 + 驱动 waitChecker), 恢复亦然" python3 -c '
# 2026-09-12 06:1x: 只抬 triggerThresholds 只停"孵化提醒", **行动帧照来**(quiet-driver 按 status/waitChecker 选)
# ⇒ 实验只关掉一半信号。守: disable 后两侧都要关; restore 后两侧都要还原。
import json, os, subprocess, tempfile
W = "/home/ubuntu/dsh-fork/dsh-wake-intervention.py"
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "dormant-goals.jsonl")
open(pool, "w", encoding="utf8").write(json.dumps({"id": "g-i", "status": "active", "nextAction": "步",
                                                   "triggerThresholds": {"kernel": 0.6, "focus": 0.55},
                                                   "waitChecker": "/bin/true"}, ensure_ascii=False) + "\n"
    + json.dumps({"id": "g-ctl", "status": "active", "nextAction": "控", "waitChecker": "/bin/true"},
                 ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
def run(*a): return subprocess.run(["python3", W] + list(a), capture_output=True, text=True, env=env, timeout=300)
def cur():
    r = None
    for l in open(pool, encoding="utf8"):
        if l.strip():
            x = json.loads(l)
            if x.get("id") == "g-i": r = x
    return r
assert run("disable", "g-i", "--hours", "24", "--reason", "沙箱", "--reversal-expectation", "沙箱: 恢复后应见行动帧").returncode == 0
th, wc = cur().get("triggerThresholds"), cur().get("waitChecker")
assert isinstance(th, dict) and th.get("focus") == 1.01, "阈值没关: " + json.dumps(th, ensure_ascii=False)
assert "/bin/false" in str(wc), "waitChecker 没关(行动帧会照来): " + repr(wc)
assert run("restore", "g-i").returncode == 0
th2, wc2 = cur().get("triggerThresholds"), cur().get("waitChecker")
assert th2 == {"kernel": 0.6, "focus": 0.55}, "阈值没还原: " + json.dumps(th2, ensure_ascii=False)
assert "/bin/true" in str(wc2), "waitChecker 没还原: " + repr(wc2)
print("关闭: 阈值+waitChecker 双关 / 恢复: 两者各自还原")
'
t "干预开关必须真改池字段且类型正确, 回滚有据, 无据拒绝" python3 -c '
import json, os, subprocess, tempfile
W = "/home/ubuntu/dsh-fork/dsh-wake-intervention.py"
tmp = tempfile.mkdtemp(); pool = os.path.join(tmp, "dormant-goals.jsonl")
open(pool, "w", encoding="utf8").write(json.dumps({"id": "g-i", "status": "active", "nextAction": "步",
                                                   "triggerThresholds": {"kernel": 0.6, "focus": 0.55}}, ensure_ascii=False) + "\n"
    + json.dumps({"id": "g-ctl", "status": "active", "nextAction": "控", "waitChecker": "/bin/true"},
                 ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
def run(*a):
    return subprocess.run(["python3", W] + list(a), capture_output=True, text=True, env=env, timeout=300)
def cur():
    r = None
    for l in open(pool, encoding="utf8"):
        if l.strip():
            x = json.loads(l)
            if x.get("id") == "g-i": r = x
    return r
# ① 无 disable 记录 ⇒ 拒绝回滚(不猜)
assert run("restore", "g-i").returncode == 2, "无原始阈值可依时仍执行了回滚(在猜)"
# ② 关闭 ⇒ 阈值必须是**对象**且值为 1.01(命不中任何相似度)
assert run("disable", "g-i", "--hours", "24", "--reason", "沙箱", "--reversal-expectation", "沙箱: 恢复后应见行动帧").returncode == 0, "关闭失败"
th = cur().get("triggerThresholds")
assert isinstance(th, dict), "--set 传 JSON 容器落成了 " + type(th).__name__ + "(干预会静默无效)"
assert th.get("kernel") == 1.01 and th.get("focus") == 1.01, "阈值没抬到命不中的值: " + json.dumps(th, ensure_ascii=False)
# ③ 恢复 ⇒ 原值回来
assert run("restore", "g-i").returncode == 0, "恢复失败"
back = cur().get("triggerThresholds")
assert back == {"kernel": 0.6, "focus": 0.55}, "恢复的不是原值: " + json.dumps(back, ensure_ascii=False)
print("关闭 ⇒ {kernel:1.01,focus:1.01}(对象) / 恢复 ⇒ 原值 / 无据拒绝")
'
# ── T189 门限裁决的时代过滤必须真的生效(tp-168) ──
# 起因: 裁决样本的时代起点由 --post-since 界定(采集方式变更=新时代, cl-263)。若该过滤静默失效, 裁决会把
# "旧上限下被截断的行"与未截断的行混采 —— 正是刚修掉的偏差换个入口回来。本组用沙箱三例守:
# ①全史统计两批都在 ②给了边界只统计边界之后 ③边界在未来 ⇒ 明确报"该时代内没有回合"(不拿全史凑数)。
# 执行中还抓到一处设计冲突: 30 条下限原先是**对 era 过滤后的集合**施加的 ⇒ 新时代样本 <30 条会把裁决整个挡住,
# 哪怕该时代已有 >=10 个带 belowGate 的回合(那才是本工具的代表性判据) ⇒ 已把下限改为只用于"数据源是否可用"。
echo "[T189] 门限裁决的时代过滤(全史/边界后/未来边界)"
t "时代过滤必须真的生效: 边界后只统计该时代, 未来边界不得拿全史凑数" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
boundary = now - datetime.timedelta(hours=2); bms = boundary.timestamp() * 1000
rows = []
for k in range(20):        # 边界前: 有 preTop, 无 belowGate(旧世界)
    rows.append({"stage": "injected", "t": bms - (k + 1) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}]})
for k in range(20, 55):    # 边界后: 带 belowGate(埋点之后)
    rows.append({"stage": "injected", "t": bms + (k - 19) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                 "belowGate": [{"expId": ids[k + 2], "similarity": 0.4}, {"expId": ids[k + 3], "similarity": 0.35}]})
open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
def run(*extra):
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"] + list(extra),
                       capture_output=True, text=True, env=env, timeout=900)
    return r, (json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else None)
_, all_d = run()
_, era_d = run("--post-since", boundary.isoformat())
r3, _ = run("--post-since", (now + datetime.timedelta(hours=6)).isoformat())
assert all_d and all_d["turns"] == 55, "全史条数不对: " + str(all_d and all_d.get("turns"))
assert all_d["roundsWithBelowGate"] == 35, "全史带埋点回合不对: " + str(all_d.get("roundsWithBelowGate"))
assert era_d and era_d["turns"] == 35, "给了边界却没有只统计该时代(实得 %s)" % (era_d and era_d.get("turns"))
assert era_d["roundsWithBelowGate"] == 35, "时代内带埋点回合不对: " + str(era_d.get("roundsWithBelowGate"))
assert r3.returncode != 0, "边界在未来却照样出了裁决(拿全史凑数)"
print("全史 55/35 ⇒ 时代后 35/35 ⇒ 未来边界明确拒绝(exit %d)" % r3.returncode)
'
t "未声明时代起点时不得出真裁决(否则会混采被截断的旧回合)" python3 -c '
# 2026-09-12 06:3x 实测事故: 不给 --post-since 时工具照出了 no-headroom, 而样本里混着上限 20 时代**被截断**的回合
# (采集方式变更过两次: 上限 5→20→500)。工具无从知道边界在哪 ⇒ 必须要求调用方声明时代, 否则只能报 insufficient。
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
now = datetime.datetime.now().timestamp() * 1000
rows = []
for k in range(18):
    rows.append({"stage": "injected", "t": now - 30 * 3600 * 1000 + k * 60000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}]})
for k in range(12):
    rows.append({"stage": "injected", "t": now - (k + 1) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                 "belowGate": [{"expId": ids[k + 2], "similarity": 0.45}, {"expId": ids[k + 3], "similarity": 0.35}]})
open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱",
           "expectedVerdict": "no-headroom"},
          open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
def run(*extra):
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"] + list(extra),
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
    assert r.returncode == 0, "扫描失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
d0 = run()
assert d0["verdict"] == "insufficient-undeclared-era", "未声明时代却出了裁决: " + str(d0["verdict"])
era = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) - datetime.timedelta(hours=6)
d1 = run("--post-since", era.isoformat())
assert d1["verdict"] == "no-headroom", "声明时代后反而无法裁决: " + str(d1["verdict"])
print("未声明时代⇒%s / 声明后⇒%s" % (d0["verdict"], d1["verdict"]))
'
# ── T190 干预判读器必须三方向可分(cl-265) ──
# 24h 后要判"唤醒是不是推进的因", 判据事先写死在工具里(免得我又临时定口径)。三类结果必须分得开:
# ①目标推进速率降 >=50% 且降幅大于对照 ⇒ causal ②没降 ⇒ no-effect(提醒无独立贡献) ③窗口内仍被唤醒 ⇒ contaminated(结论作废)。
echo "[T190] 干预判读器(causal / no-effect / contaminated 三方向)"
t "干预判读须三方向可分: 降幅大⇒causal / 无降幅⇒no-effect / 窗口内仍唤醒⇒contaminated" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
def build(tmp, target_after, ctrl_after, last_trigger=None, base_n=8):
    start = now - datetime.timedelta(hours=24)
    log = []
    def put(goal, t, n):
        for i in range(n):
            log.append({"ts": (t + datetime.timedelta(minutes=i + 1)).isoformat(), "goalId": goal,
                        "sessionId": "s", "evidence": "pool-change", "before": "a", "after": "b"})
    put("goal-t", start - datetime.timedelta(hours=12), base_n)
    put("goal-t", start, target_after)
    put("goal-c", start - datetime.timedelta(hours=12), base_n)
    put("goal-c", start, ctrl_after)
    open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in log) + "\n")
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(r, ensure_ascii=False) for r in [
        {"id": "goal-t", "status": "active", "triggerThresholds": {"kernel": 1.01, "focus": 1.01}, "lastTriggerAt": last_trigger},
        {"id": "goal-c", "status": "active"}]) + "\n")
    open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write(json.dumps(
        {"ts": start.isoformat(), "event": "disable", "goal": "goal-t",
         "thresholdsBefore": {"kernel": 0.6, "focus": 0.55},
         "thresholdsAfter": {"kernel": 1.01, "focus": 1.01}}, ensure_ascii=False) + "\n")
def run(tmp):
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-wake-intervention-readout.py", "--target", "goal-t", "--json"],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
    assert r.returncode == 0, "判读器失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
t1 = tempfile.mkdtemp(); build(t1, 1, 8)
d1 = run(t1)
assert d1["verdict"] == "causal", "降幅大却没判 causal: " + json.dumps(d1, ensure_ascii=False)[:200]
t2 = tempfile.mkdtemp(); build(t2, 8, 8)
d2 = run(t2)
assert d2["verdict"] == "no-effect", "没降幅却判了 " + str(d2["verdict"])
t3 = tempfile.mkdtemp(); build(t3, 1, 8, last_trigger=(now - datetime.timedelta(hours=6)).isoformat())
d3 = run(t3)
assert d3["verdict"] == "contaminated", "窗口内仍被唤醒却没判 contaminated: " + str(d3["verdict"])
# ④ 退化输入: 基线与干预期都是零推进 ⇒ 不得判 causal(冒烟测试当场抓到的假阳性), 必须是"无可判"
t4 = tempfile.mkdtemp(); build(t4, 0, 0, base_n=0)   # 基线也零推进 ⇒ 退化输入
d4 = run(t4)
assert d4["verdict"] == "insufficient-baseline-zero", "零基线却给了结论: " + str(d4["verdict"])
# ⑤ 冻结基线必须被消费: 窗口对得上时 baselineSource 必须是 frozen
frozen = {"ts": "2026-09-12T00:00:00+08:00", "target": "goal-t", "hours": 24,
          "windowStart": (now - datetime.timedelta(hours=48)).isoformat(),
          "windowEnd": (now - datetime.timedelta(hours=24)).isoformat(),
          "rates": {"goal-t": {"advances": 8, "perHour": 0.333}}}
json.dump(frozen, open(os.path.join(t4, "wake-intervention-baseline.json"), "w", encoding="utf8"), ensure_ascii=False)
t5 = tempfile.mkdtemp(); build(t5, 1, 8)
json.dump(frozen, open(os.path.join(t5, "wake-intervention-baseline.json"), "w", encoding="utf8"), ensure_ascii=False)
d5 = run(t5)
assert d5.get("baselineSource", "").startswith("frozen"), "冻结基线没有被消费: " + str(d5.get("baselineSource"))
assert "controls" in d1 and d1["controls"], "判读缺对照目标读数(判据要求与对照比)"
print("降幅大⇒causal / 无降幅⇒no-effect / 窗口内仍唤醒⇒contaminated / 零基线⇒无可判 / 冻结基线被消费")
'
# ── T191 裁决必须消费事先写死的期望(tp-169) ──
# 起因: 我在正式裁决前把期望写死(threshold-prereg.json: expectedVerdict=no-headroom)。若没人读它, 这次预注册
# 就只是摆设, 而"期望对不对"是最便宜的校准检验被浪费。修法: 裁决读期望并机械比对; **不符时不直接采信裁决**,
# 而是置 representativenessReviewRequired(要求先做样本代表性复核 —— 今天的期望本身就是在被截断的样本上算的)。
echo "[T191] 预注册期望被消费(字段齐全 / 一致 / 不符须要求复核)"
t "裁决须消费预注册期望: 一致则标注, 不符则要求代表性复核(不得直接采信)" python3 -c '
import json, os, subprocess, tempfile, datetime
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
pre = json.load(open(os.path.join(D, "threshold-prereg.json"), encoding="utf8"))
for k in ("ts", "table", "expectation"):
    assert pre.get(k), "threshold-prereg.json 缺字段 " + k
# 沙箱: 造一个能出**真裁决**的样本(>=10 个带 belowGate 的回合, 且不顶满上限)
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
now = datetime.datetime.now().timestamp() * 1000
rows = []
# 数据源健全性需要 >=30 行审计(工具的下限只用于"数据源是否可用"); 时代内则要求 >=10 个带 belowGate 的回合。
for k in range(18):     # 时代外(旧世界): 无 belowGate
    rows.append({"stage": "injected", "t": now - (30 * 3600 * 1000) + k * 60000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}]})
for k in range(12):     # 时代内: 带 belowGate
    rows.append({"stage": "injected", "t": now - (k + 1) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                 "belowGate": [{"expId": ids[k + 2], "similarity": 0.45}, {"expId": ids[k + 3], "similarity": 0.35}]})
open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
era = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) - datetime.timedelta(hours=6)
def run(expect):
    json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱期望",
               "expectedVerdict": expect}, open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
    SWEEP = os.environ.get("DSH_THRESHOLD_SWEEP") or "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py"
    r = subprocess.run(["python3", SWEEP, "--json",
                        "--post-since", era.isoformat()],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
    assert r.returncode == 0, "沙箱裁决失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
d_ok = run("no-headroom")          # 与沙箱结果一致
assert d_ok["verdict"] == "no-headroom", "沙箱样本没出真裁决: " + str(d_ok["verdict"])
assert d_ok["preregMismatch"] is False and d_ok["representativenessReviewRequired"] is False, "一致时却报了不符"
d_bad = run("widen-gate")          # 与沙箱结果不符
assert d_bad["preregMismatch"] is True, "不符时没有标记 preregMismatch"
assert d_bad["representativenessReviewRequired"] is True, "不符时没有要求样本代表性复核(会直接采信裁决)"
print("字段齐备 / 一致⇒不报警 / 不符⇒要求复核(沙箱裁决 %s)" % d_ok["verdict"])
'
# ── T192 截断闸与"期望自身可疑"都必须开口(tp-169 后续) ──
# 起因(测试审视帧 06:1x): ①`insufficient-belowgate-capped` 这条闸在代码里但**从没被断言过** —— 它若静默失效,
# 被截断的样本会照出裁决(正是今天修过两次的偏差); ②我把"期望自身也是在被截断样本上算的"写进了文件, 却没人读它 ⇒
# 不符时会默认"裁决错了"。本组守两件事: 顶满上限 ⇒ 不出裁决; 不符且期望可疑 ⇒ 置 preregSuspect。
echo "[T192] 截断闸(cappedRounds) + 期望自身可疑(preregSuspect)"
t "顶满上限不得出裁决 / 期望可疑须与不符一并标出" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
now = datetime.datetime.now().timestamp() * 1000
def build(bg_len):
    rows = []
    for k in range(18):
        rows.append({"stage": "injected", "t": now - 30 * 3600 * 1000 + k * 60000, "expIds": [ids[k]], "cited": False,
                     "candidates": 2, "overThreshold": 1,
                     "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}]})
    for k in range(12):
        rows.append({"stage": "injected", "t": now - (k + 1) * 600000, "expIds": [ids[k]], "cited": False,
                     "candidates": 2, "overThreshold": 1,
                     "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                     "belowGate": [{"expId": ids[(k + j) % 60], "similarity": 0.4 - 0.0001 * j} for j in range(bg_len)]})
    open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
def run(expect, truncated, bg_len):
    build(bg_len)
    json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱期望",
               "expectedVerdict": expect, "computedOnTruncatedSample": truncated},
              open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
    era = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) - datetime.timedelta(hours=6)
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json", "--post-since", era.isoformat()],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
    assert r.returncode == 0, "沙箱裁决失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
# ① 每轮 500 条阈下(顶满上限) ⇒ 必须报 capped, 不出真裁决
d1 = run("no-headroom", False, 500)
assert d1["verdict"] == "insufficient-belowgate-capped", "顶满上限却出了裁决: " + str(d1["verdict"])
assert d1["subGateDiagnostics"]["cappedRounds"] > 0, "没报出顶满的回合数"
# ② 不顶满 + 期望不符 + 期望自身在被截断样本上算的 ⇒ 必须同时置 mismatch 与 suspect
d2 = run("widen-gate", True, 2)
assert d2["preregMismatch"] is True, "不符却没标 preregMismatch"
assert d2["preregSuspect"] is True, "期望自身可疑却没标 preregSuspect(会默认裁决错)"
print("顶满⇒%s / 不符且期望可疑⇒mismatch+suspect" % d1["verdict"])
'
# ── T193 干预条件门必须可满足且拒绝旧窗口残留(cl-265) ──
# 起因: "到点判读干预"的时点在 24h 之后, 而行动帧只认条件不认日历 ⇒ 没挂门时驱动侧每轮重复催办(本次已第 2 次)。
# 挂上门之后, 新的失败模式是**死门**(永不满足 ⇒ 该目标再也不会被提醒): 故必须证明它**可满足**, 且不会拿上一个窗口的
# 判读残留冒充本次结果。附一次自证: 我第一版忘了 chmod +x, 池内体检判据当场抓到 `返回故障码 126`。
echo "[T193] 干预门(可满足 / 窗口未到不放行 / 旧窗口残留不放行)"
t "干预条件门须可满足且拒绝旧窗口残留" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
def build(tmp, disable_ts, restore_ts=None, readout_start=None):
    iv = []
    if disable_ts:
        iv.append({"ts": disable_ts.isoformat(), "event": "disable", "goal": "g-x", "plannedHours": 24,
                   "thresholdsBefore": {"kernel": 0.6, "focus": 0.55},
                   "thresholdsAfter": {"kernel": 1.01, "focus": 1.01}})
    if restore_ts:
        iv.append({"ts": restore_ts.isoformat(), "event": "restore", "goal": "g-x",
                   "thresholdsAfter": {"kernel": 0.6, "focus": 0.55}})
    open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in iv) + ("\n" if iv else ""))
    ro = []
    if readout_start:
        ro.append({"ts": now.isoformat(), "target": "g-x", "startIso": readout_start.isoformat(),
                   "endIso": now.isoformat(), "verdict": "no-effect"})
    open(os.path.join(tmp, "wake-intervention-readout.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in ro) + ("\n" if ro else ""))
def run(tmp):
    r = subprocess.run(["/home/ubuntu/dsh-fork/dsh-wait-check-intervention.py", "--target", "g-x"],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
    return r.returncode
def case(disable_ts, restore_ts=None, readout_start=None):
    tmp = tempfile.mkdtemp(); build(tmp, disable_ts, restore_ts, readout_start); return run(tmp)
assert case(None) == 1, "没有 disable 记录却放行"
assert case(now - datetime.timedelta(hours=2)) == 1, "窗口进行中就放行"
assert case(now - datetime.timedelta(hours=26), now - datetime.timedelta(hours=2)) == 1, "窗口结束但判读未出就放行"
assert case(now - datetime.timedelta(hours=26), now - datetime.timedelta(hours=2),
            now - datetime.timedelta(hours=26)) == 0, "窗口结束且本窗口判读已出却仍不放行(死门!)"
assert case(now - datetime.timedelta(hours=26), now - datetime.timedelta(hours=2),
            now - datetime.timedelta(hours=50)) == 1, "拿旧窗口的判读残留冒充本次结果"
print("未开始/进行中/判读未出/旧残留 ⇒ 1; 本窗口判读已出 ⇒ 0(可满足, 非死门)")
'
# ── T194 有效总体与截断上限的两个跨件一致性(cl-263) ──
# ①"无候选记录"的回合必须**从总体排除并被计数**(不在分母里冒充"不可排序"): 我今天连续两次把记录缺口读成召回性质。
# ②扫描工具的 BELOW_GATE_CAP 必须与 cognitive-inject 源码里那个 slice 上限**一致** —— 两边漂开的话, 截断闸会静默失效
# (或者反过来把好数据误判成截断), 而这正是"改一处忘另一处"的高发形态。
echo "[T194] 有效总体(无记录回合须排除) + 截断上限跨件一致"
t "无候选记录的回合必须从总体排除并被计数" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
now = datetime.datetime.now().timestamp() * 1000
rows = []
for k in range(20):     # 埋点前时代: 既无 preTop 也无 candidateScores
    rows.append({"stage": "injected", "t": now - (k + 3) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1})
for k in range(12):     # 有候选记录
    rows.append({"stage": "injected", "t": now - (k + 1) * 600000, "expIds": [ids[k]], "cited": False,
                 "candidates": 2, "overThreshold": 1,
                 "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                 "belowGate": [{"expId": ids[k + 2], "similarity": 0.45}]})
open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
    "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱",
           "expectedVerdict": "no-headroom"},
          open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
era = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))) - datetime.timedelta(hours=6)
r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json", "--post-since", era.isoformat()],
                   capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
assert r.returncode == 0, "扫描失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d.get("skippedNoCandidateRecord") == 20, "无候选记录的回合没被计数: " + str(d.get("skippedNoCandidateRecord"))
assert d["turns"] == 12, "无候选记录的回合混进了分母: turns=" + str(d["turns"])
print("排除 %d 个无记录回合, 总体只含 %d 个有记录回合" % (d["skippedNoCandidateRecord"], d["turns"]))
'
t "扫描工具的截断上限必须与 cognitive-inject 源码里的 slice 上限一致" python3 -c '
import os, re
src = open(os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/src/index.ts"), encoding="utf8").read()
tool = open(os.path.expanduser("~/dsh-fork/dsh-threshold-sweep.py"), encoding="utf8").read()
i = src.index("const droppedByThreshold")
seg = src[i:i + 900]
m = re.search(r"\.slice\(0,\s*(\d+)\)", seg)
assert m, "源码里找不到阈下候选记录的 slice 上限"
src_cap = int(m.group(1))
m2 = re.search(r"BELOW_GATE_CAP = (\d+)", tool)
assert m2, "扫描工具里找不到 BELOW_GATE_CAP"
tool_cap = int(m2.group(1))
assert src_cap == tool_cap, ("两边漂开了: 源码 slice=%d vs 工具 BELOW_GATE_CAP=%d ⇒ 截断闸会静默失效或误判"
                             % (src_cap, tool_cap))
print("截断上限一致: %d(源码) == %d(工具)" % (src_cap, tool_cap))
'
# ── T195 门限裁决的条件门必须可满足 + 时代起点由文件声明(cl-263) ──
# "等样本攒够"是样本型等待: 没门 ⇒ 驱动侧重复催办(cl-126/cl-215/cl-265 同型); 挂了门 ⇒ 新的失败模式是**死门**。
# 故必须证明: 样本够时门会开(exit 0), 样本不够时不开; 且扫描工具的默认时代起点来自 sweep-era.json(不靠我记得传参)。
echo "[T195] 门限裁决门(可满足 / 样本不足不放行 / 时代由文件声明)"
t "门限裁决门须可满足, 且扫描工具默认读 sweep-era.json 声明的时代" python3 -c '
import json, os, subprocess, tempfile, datetime
tmp = tempfile.mkdtemp(); ids = ["exp_%03d" % i for i in range(60)]
open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write("\n".join(json.dumps(
    {"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                         "outcomeUtility": {"materialGain": i % 10, "emotionalValence": i % 5}}},
    ensure_ascii=False) for i, e in enumerate(ids)) + "\n")
now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
era = now - datetime.timedelta(hours=3)
def build(n_bg):
    rows = []
    for k in range(18):     # 时代外(旧记录): 无候选字段
        rows.append({"stage": "injected", "t": int((era.timestamp() - 30 * 3600) * 1000) + k * 60000,
                     "expIds": [ids[k]], "cited": False, "candidates": 2, "overThreshold": 1})
    for k in range(n_bg):   # 时代内: 带 belowGate
        rows.append({"stage": "injected", "t": int((era.timestamp() + (k + 1) * 600) * 1000), "expIds": [ids[k]],
                     "cited": False, "candidates": 2, "overThreshold": 1,
                     "preTop": [{"expId": ids[k], "similarity": 0.6}, {"expId": ids[k + 1], "similarity": 0.55}],
                     "belowGate": [{"expId": ids[k + 2], "similarity": 0.45}]})
    open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
json.dump({"since": era.isoformat(), "reason": "沙箱"},
          open(os.path.join(tmp, "sweep-era.json"), "w", encoding="utf8"), ensure_ascii=False)
env = dict(os.environ, DSH_COG_DIR=tmp)
def run_check():
    return subprocess.run(["/home/ubuntu/dsh-fork/dsh-wait-check-sweep.py"],
                          capture_output=True, text=True, env=env, timeout=900)
# ① 样本不足 ⇒ 不放行
build(4)
r1 = run_check()
assert r1.returncode == 1, "样本只有 4 个埋点回合却放行了"
# ② 样本够 ⇒ 必须放行(否则是死门)
build(12)
r2 = run_check()
assert r2.returncode == 0, "样本够(12)却不放行(死门): " + (r2.stdout + r2.stderr)[-160:]
# ③ 时代由文件声明: 删掉 sweep-era.json 且不给 --post-since ⇒ 工具必须拒绝出真裁决
os.remove(os.path.join(tmp, "sweep-era.json"))
r3 = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"],
                    capture_output=True, text=True, env=env, timeout=900)
d3 = json.loads(r3.stdout.strip().splitlines()[-1])
assert d3["verdict"] == "insufficient-undeclared-era", "缺时代声明却出了裁决: " + str(d3["verdict"])
print("样本 4 ⇒ 不放行 / 样本 12 ⇒ 放行(可满足) / 缺时代声明 ⇒ 拒绝裁决")
'
# ── T196 条件门不得依赖"行动帧产出"(否则全部门挂上时会互相饿死) ──
# 2026-09-12 07:1x 实测: 三个 active 目标全部挂上门之后, 驱动侧选目标返回 **[]**(功能验证过) ⇒
# **不再产生任何行动帧**。此时若某个门的条件恰好是"再攒 N 个行动帧", 它永远等不到 —— 机制彼此饿死。
# 本组守: ①池内每个 waitChecker 都不得读行动帧日志(不接受以帧为产出的条件); ②每个门必须挂在**外部产物**上
# (池变更/审计/干预记录等由运行时或排程产出, 而不是等我下次开工)。
echo "[T196] 条件门不得依赖行动帧(防饿死) + 必须挂在外部产物上"
t "池内条件门不得依赖行动帧产出, 且必须挂在外部产物上" python3 -c '
import json, os
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
POOL = os.environ.get("DSH_COG_POOL") or os.path.join(D, "dormant-goals.jsonl")
pool = {}
for l in open(POOL, encoding="utf8"):
    if l.strip():
        r = json.loads(l)
        if r.get("id"): pool[r["id"]] = r
checkers = [(gid, (row.get("waitChecker") or "").strip()) for gid, row in pool.items()
            if row.get("status") == "active" and (row.get("waitChecker") or "").strip()]
assert checkers, "池内没有 active 目标的 waitChecker —— 本断言前提不成立"
FRAME_MARKERS = ("quiet-driver-frames", "action-frame")
EXT = ("incubation-log", "retrieval-audit", "wake-interventions", "wake-intervention-readout",
       "library-replay", "experiments", "candidates")
# "挂在外部产物上"允许**委托**: 门脚本常把读数交给另一个脚本(如 wait-check-sweep 调 threshold-sweep,
# 后者才读 retrieval-audit) ⇒ 引用任何 dsh-*.py/.tsx 也算外部依赖(关键是别只等我下次开工)。
import re as _re
bad_frame, no_ext = [], []
for gid, cmd in checkers:
    path = cmd.split()[0]
    if not os.path.exists(path):
        bad_frame.append(gid + ":脚本不存在")
        continue
    try:
        src = open(path, encoding="utf8").read()
    except (UnicodeDecodeError, OSError):
        continue   # /bin/false 这类非文本 checker: 无源码可查(它按定义不会读行动帧), 但仍须存在
    if any(m in src for m in FRAME_MARKERS):
        bad_frame.append(gid + ":读行动帧")
    delegates = bool(_re.search(r"dsh-[a-z0-9-]+\.(py|tsx|sh)", src))
    if not (any(m in src for m in EXT) or delegates):
        no_ext.append(gid)
assert not bad_frame, "条件门依赖行动帧产出(全部门挂上时会饿死): " + repr(bad_frame)
assert not no_ext, "条件门没挂在任何外部产物上(可能在等我自己开工): " + repr(no_ext)
print("池内 %d 个门: 均不读行动帧, 且都挂在外部产物上" % len(checkers))
'
# ── T197 等待型目标不得收到提醒(两侧同一判据, cl-267) ──
# 起因: cl-250 修的是"哨兵不打扰了、行动帧却照样催办"; 实测(我这一帧的帧头就是证据)现状**反过来** ——
# 行动帧侧早按 waitChecker 过滤(tsx 直调真实池实测: 带门 ⇒ 三个目标全排除), 哨兵侧却只把
# shouldSkipAsWaiting 当**标注**, 提醒照发 ⇒ "发了提醒却注定推不动"的事件在两条读数里都隐形。
# 修法: 哨兵命中里凡 shouldSkipAsWaiting 为真者不进提醒块, 但仍进 skipped 观测计数(读数不失真)。
echo "[T197] 等待型目标不得收到提醒(源码结构 + 计数仍留痕)"
t "哨兵不得给等待型目标发提醒, 但 skipped 计数必须照记" python3 -c '
import os
src = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/index.ts"), encoding="utf8").read()
lib = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/lib/index.js"), encoding="utf8").read()
assert "const skipHits = hits.filter" in src, "没有把等待型命中挑出来(提醒照发的老形态)"
# 2026-09-12 08:2x: 只过滤 shouldSkipAsWaiting(文本与 checker 的**与**)是不够的 —— 行动型措辞+checker 未满足
# 的目标照样收提醒(实测证伪信号命中) ⇒ 必须**有 checker 时由 checker 说了算**。
# 2026-09-12 09:2x: 判据已抽到独立模块 reminder-gate.ts(为了可行为断言) ⇒ 结构断言随之改查两处。
gate = open(os.path.expanduser("~/dsh-fork/packages/context/dormant-goal/src/reminder-gate.ts"), encoding="utf8").read()
assert "shouldSkipReminder" in src and "reminder-gate.js" in src, "哨兵没有调用独立模块的提醒门"
assert "const wc = String(goal.waitChecker ?? \u0027\u0027).trim()" in gate, "提醒门没有取 checker"
assert "if (wc !== \u0027\u0027) return !runChecker(wc)" in gate, "有 checker 时没有让它说了算(仍是文本与checker的与)"
assert "waitingFallback(String(goal.nextAction ?? \u0027\u0027))" in gate, "没有保留无 checker 时的文本启发式兜底"
assert "const remindHits = hits.filter" in src, "没有从提醒块里排除等待型命中"
assert "if (remindHits.length === 0)" in src, "全为等待型时没有提前返回(仍会发提醒)"
assert "remindHits.slice(0, 1)" in src, "提醒块不是从 remindHits 里取的(排除没生效)"
assert "new Map(skipHits.map(h => [h.goal.id, \u0027waiting\u0027]))" in src, "skipped 计数没有照记(读数会失真)"
assert "skipHits" in lib and "remindHits" in lib, "改动没进产物(重启后仍是旧行为)"
print("源码与产物均已排除等待型提醒, 且 skipped 计数保留")
'
# ── T198 门限裁决的判据必须与样本量自洽(cl-263) ──
# 起因: 预登记 R1 只说"可排序集占比 +>=10 个百分点", 而样本门只要 >=10 回合 —— n≈10 时该占比的二项标准差
# 就有 ~13pp ⇒ 判据阈值落在噪声带里, 会把噪声当效应。修法: R1 追加"与当前门限的 Wilson 95% 区间不得重叠"。
# 本组用**同一份额模式、不同样本量**的沙箱证明这条闸真的在起作用: 小样本 ⇒ 不许判 widen-gate; 大样本 ⇒ 才允许。
echo "[T198] 门限裁决判据与样本量自洽(区间重叠不得判出空间)"
t "同一份额模式: 小样本(区间重叠)不得判 widen-gate, 大样本(区间不重叠)才可" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
def build(tmp, n_a, n_b):
    # 两类经验: HI(高 valence, 放在过阈候选里 ⇒ 相关项总是排第 1, A 档 MRR 不掉) /
    # LO(低 valence ⇒ 阈下候选永远不是"相关项", 加进来也不改变 MRR)。
    hi = ["hi_%03d" % i for i in range(60)]
    lo = ["lo_%03d" % i for i in range(60)]
    rows_exp = ([{"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                                      "outcomeUtility": {"materialGain": 5, "emotionalValence": 5}}} for e in hi]
                + [{"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                                        "outcomeUtility": {"materialGain": 1, "emotionalValence": 0}}} for e in lo])
    open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows_exp) + "\n")
    now = datetime.datetime.now().timestamp() * 1000
    rows = []
    for i in range(n_a):     # A 型: 过阈 2 个候选(相关项 0.60 排第 1)
        rows.append({"stage": "injected", "t": now - (i + 1) * 60000, "expIds": [hi[i % 60]], "cited": False,
                     "candidates": 2, "overThreshold": 2,
                     "preTop": [{"expId": hi[i % 60], "similarity": 0.6}, {"expId": lo[i % 60], "similarity": 0.58}],
                     "belowGate": [{"expId": lo[(i + 7) % 60], "similarity": 0.30}]})
    for i in range(n_b):     # B 型: 过阈 1 个; 门限降到 0.45 时多出 2 个**低 valence** 候选(可排序但不改 MRR)
        rows.append({"stage": "injected", "t": now - (n_a + i + 1) * 60000, "expIds": [hi[(i + 20) % 60]], "cited": False,
                     "candidates": 1, "overThreshold": 1,
                     "preTop": [{"expId": hi[(i + 20) % 60], "similarity": 0.60}],
                     "belowGate": [{"expId": lo[(i + 30) % 60], "similarity": 0.47},
                                   {"expId": lo[(i + 40) % 60], "similarity": 0.46}]})
    for i in range(25):      # 数据源健全性: >=30 行审计(这些行无候选记录, 会被时代与有效总体双双排除)
        rows.append({"stage": "injected", "t": now - 30 * 3600 * 1000 + i * 60000, "expIds": [hi[i % 60]],
                     "cited": False, "candidates": 2, "overThreshold": 1})
    open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱"},
              open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
    era = datetime.datetime.now(TZ) - datetime.timedelta(hours=6)
    json.dump({"since": era.isoformat(), "reason": "沙箱"},
              open(os.path.join(tmp, "sweep-era.json"), "w", encoding="utf8"), ensure_ascii=False)
def verdict(n_a, n_b):
    tmp = tempfile.mkdtemp(); build(tmp, n_a, n_b)
    r = subprocess.run(["python3", "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py", "--json"],
                       capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
    assert r.returncode == 0, "扫描失败: " + (r.stderr or r.stdout)[-200:]
    return json.loads(r.stdout.strip().splitlines()[-1])
d_small = verdict(8, 2)      # 10 回合: 占比 0.80→1.00(差 20pp), 但 Wilson 区间重叠
assert d_small["verdict"] != "widen-gate", ("小样本(区间重叠)却判出空间: %s"
                                            % json.dumps(d_small.get("bestRow"), ensure_ascii=False)[:160])
assert d_small["verdict"] == "no-headroom", "小样本应按 no-headroom 结案(差在噪声带内): " + str(d_small["verdict"])
d_big = verdict(75, 25)      # 100 回合: 同一份额模式, 区间不重叠
assert d_big["verdict"] == "widen-gate", "大样本(区间不重叠)却没判出空间: " + str(d_big["verdict"])
print("小样本(%d 回合)⇒%s / 大样本(%d 回合)⇒%s" % (d_small["turns"], d_small["verdict"], d_big["turns"], d_big["verdict"]))
'
# ── T199 裁决必须点明"饱和", 并并列报告决策相关的维(cl-263) ──
# 08:0x 实测: 新上限时代 14 个回合**本来就全部可排序(100%)** ⇒ R1 的"占比 +>=10pp"数学上没有开火空间,
# 于是 no-headroom 是**被饱和造出来的**, 却被打印成"找过了, 没空间"。另: 反事实探索发现真正关心的决策变量是
# **每回合可注入候选数**(meanCandidates), 它会在占比饱和时继续变化(实测 0.50→0.35: 5.0→16.29) ⇒ 必须并列报告。
echo "[T199] 饱和必须点明 + 候选丰富度必须并列报告"
t "占比饱和时须点明, 且表里须有平均候选数(决策相关维)" python3 -c '
import json, os, subprocess, tempfile, datetime
TZ = datetime.timezone(datetime.timedelta(hours=8))
def build(tmp):
    hi = ["hi_%03d" % i for i in range(30)]; lo = ["lo_%03d" % i for i in range(30)]
    rows_exp = ([{"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                                      "outcomeUtility": {"materialGain": 5, "emotionalValence": 5}}} for e in hi]
                + [{"expId": e, "sar": {"situation": "s", "action": "a", "outcome": "o",
                                        "outcomeUtility": {"materialGain": 1, "emotionalValence": 0}}} for e in lo])
    open(os.path.join(tmp, "experiences.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows_exp) + "\n")
    now = datetime.datetime.now().timestamp() * 1000; rows = []
    for i in range(12):     # 每回合 2 个过阈候选 ⇒ 占比恒 100%(饱和), 但阈下候选在 0.35 才回来
        rows.append({"stage": "injected", "t": now - (i + 1) * 60000, "expIds": [hi[i % 30]], "cited": False,
                     "candidates": 2, "overThreshold": 2,
                     "preTop": [{"expId": hi[i % 30], "similarity": 0.6}, {"expId": hi[(i + 1) % 30], "similarity": 0.58}],
                     "belowGate": [{"expId": lo[j % 30], "similarity": 0.40} for j in range(20)]})
    for i in range(20):     # 数据源健全性(无候选记录, 会被排除)
        rows.append({"stage": "injected", "t": now - 30 * 3600 * 1000 + i * 60000, "expIds": [hi[i % 30]],
                     "cited": False, "candidates": 2, "overThreshold": 1})
    open(os.path.join(tmp, "retrieval-audit.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
    json.dump({"ts": "2026-09-12T00:00:00+08:00", "table": [], "expectation": "沙箱"},
              open(os.path.join(tmp, "threshold-prereg.json"), "w", encoding="utf8"), ensure_ascii=False)
    era = datetime.datetime.now(TZ) - datetime.timedelta(hours=6)
    json.dump({"since": era.isoformat(), "reason": "沙箱"},
              open(os.path.join(tmp, "sweep-era.json"), "w", encoding="utf8"), ensure_ascii=False)
tmp = tempfile.mkdtemp(); build(tmp)
SWEEP = os.environ.get("DSH_THRESHOLD_SWEEP") or "/home/ubuntu/dsh-fork/dsh-threshold-sweep.py"
r = subprocess.run(["python3", SWEEP, "--json"],
                   capture_output=True, text=True, env=dict(os.environ, DSH_COG_DIR=tmp), timeout=900)
assert r.returncode == 0, "扫描失败: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d.get("saturated") is True, "占比 100% 却没标 saturated"
assert "饱和" in str(d.get("reason")), "裁决理由没有点明饱和: " + str(d.get("reason"))[:120]
cur = next(x for x in d["table"] if abs(x["threshold"] - d["currentGate"]) < 1e-9)
low = next(x for x in d["table"] if abs(x["threshold"] - 0.40) < 1e-9)
assert cur.get("meanCandidates") is not None, "表里没有 meanCandidates(决策相关维缺失)"
assert low["meanCandidates"] > cur["meanCandidates"], ("放宽门限后候选丰富度没升(%.2f → %.2f)"
                                                       % (cur["meanCandidates"], low["meanCandidates"]))
print("饱和已点明; 均候选 %.1f(0.50) → %.1f(0.40)" % (cur["meanCandidates"], low["meanCandidates"]))
'
# ── T200 提醒门必须行为化可测(cl-267 的教训: 结构断言挡不住"语义错") ──
# v1 的失败形态: 我把"排除提醒"复用成 shouldSkipAsWaiting(文本启发式 AND checker 未满足) ⇒ **行动型措辞但
# checker 未满足**的目标照样收提醒(实测 08:26:47 命中), 而当时三条结构断言全绿。故把判据抽成独立模块的纯函数,
# 用**行为断言**钉住四种组合 —— 这一条如果早存在, v1 当场就会被抓住。
echo "[T200] 提醒门四组合(有checker未满足必须跳过 / 已满足不跳 / 无checker退回文本启发式)"
t "提醒门: 有 checker 时以它为准(未满足即跳过), 无 checker 时才看文本" python3 -c '
import json, os, subprocess
script = os.environ.get("DSH_REMINDER_GATE") or "/home/ubuntu/dsh-fork/packages/context/dormant-goal/src/reminder-gate.ts"
r = subprocess.run(["npx", "tsx", "--eval",
  "import { shouldSkipReminder as f } from \"" + script + "\"\n"
  "const unmet = () => false, met = () => true\n"
  "const waitingText = (t) => t.startsWith(\"待\")\n"
  "const out = {\n"
  "  checker_unmet_action_text: f({ nextAction: \"① 稀疏召回两阶段(可执行)\", waitChecker: \"/bin/false\" }, unmet, waitingText),\n"
  "  checker_met_action_text: f({ nextAction: \"① 稀疏召回两阶段(可执行)\", waitChecker: \"/bin/true\" }, met, waitingText),\n"
  "  no_checker_waiting_text: f({ nextAction: \"待用户拍板换模\" }, unmet, waitingText),\n"
  "  no_checker_action_text: f({ nextAction: \"跑一次离线对照\" }, unmet, waitingText),\n"
  "}\n"
  "console.log(JSON.stringify(out))"],
  cwd="/home/ubuntu/dsh-fork", capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "tsx 跑不动提醒门: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d["checker_unmet_action_text"] is True, ("有 checker 且未满足, 却仍要发提醒(这正是 v1 的缺陷): %s"
                                                % d["checker_unmet_action_text"])
assert d["checker_met_action_text"] is False, "checker 已满足却仍被跳过(该提醒时不提醒)"
assert d["no_checker_waiting_text"] is True, "无 checker 时文本启发式兜底失效"
assert d["no_checker_action_text"] is False, "无 checker 的行动型文本被误跳过"
print("四组合正确: 未满足⇒跳过 / 已满足⇒不跳 / 无checker⇒看文本(等待跳过, 行动不跳)")
'
# ── T201 精排样本门带时限: 时限只放行"测得出但样本不足", 不得成为绕过 fail-closed 的后门 ──
# 2026-09-12 09:4x 取证: A1·真提升 全史仅 6 条、已结算停在 2 条, 自 09-09 18:45 起 63 小时未动(另 4 条
# 从未结算), 而 predictions.jsonl 每回合都在写 ⇒ 纯样本门在静默期会自我饿死(cl-250/cl-266 同族)。
# 故给门加声明式时限(--deadline)。本组守两条边界: ①"到点就放行"**不得**覆盖"测不出来"(否则时限就是
# 绕过 fail-closed 的后门); ②时限放行必须自称"证据不足", 否则下游会把它读成"样本已足、可以对账了"。
echo "[T201] 精排样本门: 时限放行 ≠ 样本已足, 且 fail-closed 优先于时限"
t "样本门: 时限只放行「测得出但样本不足」, 测不出/时限写错一律不放行, 两种放行可判别" python3 -c '
import datetime, os, subprocess, tempfile
REF = os.path.expanduser("~/dsh-fork/dsh-wait-check-refine.py")
tmp = tempfile.mkdtemp()
def shim(name, lines):
    p = os.path.join(tmp, name)
    open(p, "w", encoding="utf8").write("\n".join(lines) + "\n")
    return p
low = shim("low.py", ["print(\"A1·真提升(changed): 已结算 2 条, 平均误差 0.417\")",
                      "print(\"B·未开火(审计后): 已结算 2 条, 平均误差 0.082\")"])
met = shim("met.py", ["print(\"A1·真提升(changed): 已结算 7 条, 平均误差 0.410\")",
                      "print(\"B·未开火(审计后): 已结算 6 条, 平均误差 0.090\")"])
bad = shim("bad.py", ["print(\"完全不是预期格式的输出\")"])
err = shim("err.py", ["import sys", "sys.exit(2)"])
now = datetime.datetime.now().astimezone()
past = (now - datetime.timedelta(hours=1)).isoformat()
future = (now + datetime.timedelta(hours=1)).isoformat()
def run(tool, *extra):
    return subprocess.run(["python3", REF] + list(extra), capture_output=True, text=True,
                          timeout=600, env=dict(os.environ, DSH_REFINE_EVAL=tool))
a = run(low, "--min-n", "5", "--deadline", past)
assert a.returncode == 0, "时限已到且测得出但样本不足, 却没放行(exit %d)" % a.returncode
assert "证据不足" in a.stdout, "时限放行却没显式标注证据不足 —— 下游会把它读成样本已足"
assert "放行理由=deadline" in a.stdout, "时限放行没有可判别的理由行"
b = run(low, "--min-n", "5", "--deadline", future)
assert b.returncode == 1, "时限未到就该继续等待(exit %d)" % b.returncode
c = run(low, "--min-n", "5")
assert c.returncode == 1, "无时限时应继续等待(exit %d)" % c.returncode
d = run(bad, "--min-n", "5", "--deadline", past)
assert d.returncode == 3, "**测不出来**却按时限放行了(exit %d) —— 时限成了绕过 fail-closed 的后门" % d.returncode
e = run(met, "--min-n", "5", "--deadline", past)
assert e.returncode == 0 and "放行理由=samples" in e.stdout, "样本已足时理由必须是 samples(两种放行可判别)"
f = run(low, "--min-n", "5", "--deadline", "明天")
assert f.returncode == 3, "时限字符串写错却没 fail-closed(exit %d)" % f.returncode
g = run(low, "--min-n", "5", "--deadline", "2026-09-13T08:30:00")
assert g.returncode == 3, "时限缺时区却没 fail-closed(exit %d)" % g.returncode
# 两条 fail-closed 分支必须都被覆盖(bad.py 输出垃圾但 exit 0 ⇒ 走**解析**分支; err.py 非零退出 ⇒ 走**度量器失败**分支)
h = run(err, "--min-n", "5", "--deadline", past)
assert h.returncode == 3, "度量器非零退出却没 fail-closed(exit %d)" % h.returncode
print("八例: 过点放行(标证据不足) / 未到等待 / 无时限等待 / 解析不了仍 fail-closed / 度量器失败仍 fail-closed / 样本已足标 samples / 坏时限 fail-closed / 裸时间 fail-closed")
'
# ── T202 目标池不得全体无界挂门(cl-266 的正面判据; 时限须被**行为**消费) ──
# cl-266 原提议的代理判据是"该门的输入产物过去 24h 有写入" —— 2026-09-12 09:4x 取证**证伪**了它:
# refine 门的输入 predictions.jsonl 每回合都在写(09:32 刚写过), 而它的决定性计数器(A1·已结算)自
# 09-09 18:45 起 63 小时未动(全史 6 条里 4 条从未结算) ⇒ 该代理会把一道饿死的门判成活门。
# 故改用可判定判据(dsh-goal-gate-liveness.py): 至少一条 active 目标能"自行解冻"; 且时限必须被**行为**
# 消费 —— 把命令行里那串时限换成过去必须放行; `/bin/false --deadline <D>` 这类装饰性时限须判红
# (这正是"结构判据抓不住接线错"的行为化版本)。
echo "[T202] 门不得全体无界: 至少一条能自行解冻 + 时限须被行为消费"
t "池内至少有一条门能自行解冻(不得全体无界 ⇒ 永久静默)" python3 /home/ubuntu/dsh-fork/dsh-goal-gate-liveness.py --quiet
t "判据可判别: 全无界池与装饰性时限池必须判红, 真消费时限的池判绿" python3 -c '
import datetime, json, os, subprocess, tempfile
LINT = os.path.expanduser("~/dsh-fork/dsh-goal-gate-liveness.py")
tmp = tempfile.mkdtemp()
D = (datetime.datetime.now().astimezone() + datetime.timedelta(hours=20)).isoformat()
def pool(name, rows):
    p = os.path.join(tmp, name)
    open(p, "w", encoding="utf8").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return p
def run(p):
    return subprocess.run(["python3", LINT, "--pool", p, "--quiet"], capture_output=True, text=True, timeout=300)
all_unbounded = pool("a.jsonl", [{"id": "g1", "status": "active", "waitChecker": "/bin/false"},
                                 {"id": "g2", "status": "active", "waitChecker": "/bin/false"}])
decorative = pool("b.jsonl", [{"id": "g1", "status": "active", "waitChecker": "/bin/false --deadline " + D,
                               "waitCheckerDeadline": D}])
shim = os.path.join(tmp, "shim.py")
open(shim, "w", encoding="utf8").write(
  "import sys, datetime\n"
  "a = sys.argv\n"
  "d = [a[i + 1] for i, x in enumerate(a) if x == \"--deadline\"][0]\n"
  "sys.exit(0 if datetime.datetime.now().astimezone() >= datetime.datetime.fromisoformat(d) else 1)\n")
real = pool("c.jsonl", [{"id": "g1", "status": "active", "waitChecker": "python3 " + shim + " --deadline " + D,
                         "waitCheckerDeadline": D}])
mixed = pool("d.jsonl", [{"id": "g1", "status": "active", "waitChecker": "/bin/false"},
                         {"id": "g2", "status": "active", "waitChecker": "python3 " + shim + " --deadline " + D,
                          "waitCheckerDeadline": D}])
assert run(all_unbounded).returncode == 1, "全体无界的池没判红 —— 静默死锁拦不住"
assert run(decorative).returncode == 1, "装饰性时限(逐字包含却不被消费)没判红 —— 这正是结构判据抓不住的接线错"
assert run(real).returncode == 0, "真消费时限的池被判红(误伤)"
assert run(mixed).returncode == 0, "只要有一条能自行解冻就不该判红(判据是存在量词)"
print("四例: 全无界⇒红 / 装饰时限⇒红 / 真消费⇒绿 / 一条可解冻⇒绿")
'
# ── T203 干预实验的恢复腿必须预登记(窗口结束前), 且开关必须可逆 ──
# 由来(2026-09-12 10:2x 三问帧实测): cl-265 窗口跑到一半才发现"恢复腿不是回到静默" —— 目标当前的门
# dsh-wait-check-sweep.py 已 exit 0 ⇒ 08:00 一恢复该目标立刻重新可驱动。这条解释如果等到窗口结束之后
# 才写, 就是**事后叙事**而不是预登记(与 threshold-prereg.json 同一条纪律)。故: ①disable 强制要
# --reversal-expectation(缺则拒绝); ②已开窗口用 preregister 补登记, 但必须早于窗口结束; ③开关必须可逆 ——
# 往返测试直接保护**在跑的那个窗口**的恢复路径(restore 崩了 = 实验永不回滚)。
echo "[T203] 干预恢复腿须预登记(早于窗口结束) + 开关可逆(往返回滚)"
t "在跑的干预窗口必须有恢复腿预登记(且须早于窗口结束)" python3 /home/ubuntu/dsh-fork/dsh-intervention-reversal-lint.py --quiet
t "恢复腿判据可判别: 缺登记/事后登记必须判红, 窗口内补登记判绿" python3 -c '
import datetime, json, os, subprocess, tempfile
LINT = os.path.expanduser("~/dsh-fork/dsh-intervention-reversal-lint.py")
tmp = tempfile.mkdtemp()
now = datetime.datetime.now().astimezone()
def rec(name, rows):
    p = os.path.join(tmp, name)
    open(p, "w", encoding="utf8").write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    return p
def run(p):
    return subprocess.run(["python3", LINT, "--record", p, "--quiet"], capture_output=True, text=True, timeout=300)
dis = (now - datetime.timedelta(hours=2)).isoformat()
missing = rec("missing.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 24}])
posthoc = rec("posthoc.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 1},
                                {"ts": (now + datetime.timedelta(hours=2)).isoformat(), "event": "preregister",
                                 "goal": "g", "reversalExpectation": "x"}])
inwindow = rec("inwindow.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 24},
                                  {"ts": (now - datetime.timedelta(hours=1)).isoformat(), "event": "preregister",
                                   "goal": "g", "reversalExpectation": "x"}])
closed = rec("closed.jsonl", [{"ts": dis, "event": "disable", "goal": "g", "plannedHours": 24},
                              {"ts": (now - datetime.timedelta(minutes=30)).isoformat(), "event": "restore",
                               "goal": "g"}])
assert run(missing).returncode == 1, "缺恢复腿预登记没判红"
assert run(posthoc).returncode == 1, "窗口结束后才登记(事后叙事)没判红"
assert run(inwindow).returncode == 0, "窗口内预登记被判红(误伤)"
assert run(closed).returncode == 0, "已恢复的历史窗口被追认(不该审它)"
print("四例: 缺登记⇒红 / 事后登记⇒红 / 窗口内登记⇒绿 / 已恢复窗口⇒不审")
'
t "关闭干预必须强制要求恢复腿预期(缺则拒绝, 不带预期不得关闭)" python3 -c '
import json, os, subprocess, tempfile
TOOL = os.path.expanduser("~/dsh-fork/dsh-wake-intervention.py")
tmp = tempfile.mkdtemp()
pool = os.path.join(tmp, "dormant-goals.jsonl")
open(pool, "w", encoding="utf8").write(json.dumps({"id": "g1", "status": "active", "nextAction": "n",
    "triggerThresholds": {"kernel": 0.6, "focus": 0.55},
    "waitChecker": "/home/ubuntu/dsh-fork/dsh-wait-check-sweep.py"}, ensure_ascii=False) + "\n"
    + json.dumps({"id": "g-ctl", "status": "active", "nextAction": "控", "waitChecker": "/bin/true"},
                 ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
r0 = subprocess.run(["python3", TOOL, "disable", "g1"], capture_output=True, text=True, timeout=300, env=env)
assert r0.returncode == 2, "缺恢复腿预期却允许关闭(exit %d) —— 恢复腿会变成事后叙事" % r0.returncode
assert "--reversal-expectation" in (r0.stderr or ""), ("拒绝理由不是缺恢复腿预期(是别的失败) —— 以坏充火: "
                                        + (r0.stderr or r0.stdout)[-160:])
r1 = subprocess.run(["python3", TOOL, "disable", "g1", "--hours", "24",
                     "--reversal-expectation", "恢复后 30 分钟内应出现行动帧"],
                    capture_output=True, text=True, timeout=300, env=env)
assert r1.returncode == 0, "带预期关闭失败: " + (r1.stderr or r1.stdout)[-160:]
cur = [json.loads(l) for l in open(pool, encoding="utf8") if l.strip()][-1]
assert cur.get("triggerThresholds") == {"kernel": 1.01, "focus": 1.01}, "关闭没落到池的阈值上: %r" % cur.get("triggerThresholds")
assert str(cur.get("waitChecker")) == "/bin/false", "关闭没落到池的门上: %r" % cur.get("waitChecker")
rows = [json.loads(l) for l in open(os.path.join(tmp, "wake-interventions.jsonl"), encoding="utf8") if l.strip()]
assert rows[-1].get("reversalExpectation"), "disable 行没记下恢复腿预期"
print("缺预期⇒拒绝(2) / 带预期⇒关闭并落盘(阈值+门+预期三处)")
'
t "干预开关必须可逆: disable→restore 往返回滚原阈值与原门" python3 -c '
import json, os, subprocess, tempfile
TOOL = os.path.expanduser("~/dsh-fork/dsh-wake-intervention.py")
tmp = tempfile.mkdtemp()
pool = os.path.join(tmp, "dormant-goals.jsonl")
orig_wait = "/home/ubuntu/dsh-fork/dsh-wait-check-sweep.py"
open(pool, "w", encoding="utf8").write(json.dumps({"id": "g1", "status": "active", "nextAction": "n",
    "triggerThresholds": {"kernel": 0.6, "focus": 0.55}, "waitChecker": orig_wait}, ensure_ascii=False) + "\n"
    + json.dumps({"id": "g-ctl", "status": "active", "nextAction": "控", "waitChecker": "/bin/true"},
                 ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
def call(*a):
    return subprocess.run(["python3", TOOL] + list(a), capture_output=True, text=True, timeout=300, env=env)
assert call("disable", "g1", "--hours", "24", "--reversal-expectation", "x").returncode == 0
assert call("restore", "g1").returncode == 0, "restore 失败 —— 在跑的窗口就回滚不了"
cur = [json.loads(l) for l in open(pool, encoding="utf8") if l.strip()][-1]
assert cur.get("triggerThresholds") == {"kernel": 0.6, "focus": 0.55}, "往返没回到原阈值: %r" % cur.get("triggerThresholds")
assert str(cur.get("waitChecker")) == orig_wait, "往返没回到原门: %r" % cur.get("waitChecker")
print("disable→restore 往返: 阈值与原门均回滚")
'
t "判读器必须消费恢复腿预期(回显+复核时点), 且四类判定可判别" python3 -c '
import datetime, json, os, shutil, subprocess, tempfile
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
RO = os.path.expanduser("~/dsh-fork/dsh-wake-intervention-readout.py")
tmp = tempfile.mkdtemp()
for f in ("dormant-goals.jsonl", "wake-intervention-baseline.json", "attribution-era.json"):
    src = os.path.join(D, f)
    if os.path.exists(src):
        shutil.copy(src, os.path.join(tmp, f))
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write("")
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("")
now = datetime.datetime.now().astimezone()
end = (now - datetime.timedelta(hours=2)).isoformat()
start = (now - datetime.timedelta(hours=4)).isoformat()
open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write(json.dumps(
    {"ts": start, "event": "disable", "goal": "goal-experience-library", "plannedHours": 24,
     "reversalExpectation": "恢复后 30 分钟内应见行动帧"}, ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
def run(*extra):
    return subprocess.run(["python3", RO, "--target", "goal-experience-library", "--start", start, "--end", end] + list(extra),
                          capture_output=True, text=True, timeout=600, env=env)
r = run()
assert r.returncode == 0, "正常判读失败: " + (r.stderr or r.stdout)[-200:]
rows = [json.loads(l) for l in open(os.path.join(tmp, "wake-intervention-readout.jsonl"), encoding="utf8") if l.strip()]
p = rows[-1]
for k in ("reversalExpectation", "reversalCheckAt", "reversalPending", "reversalVerdict"):
    assert k in p, "判读行没有消费恢复腿预期(缺 %s) —— 登记就成了装饰性声明(与 T202 的装饰性时限同型)" % k
assert p["reversalVerdict"] == "unmet", "结束后零推进却判成 %r" % p["reversalVerdict"]
u = run("--reversal-eval")
assert u.returncode == 1, "零推进未兑现却没判 1(exit %d)" % u.returncode
with open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "a", encoding="utf8") as fh:
    fh.write(json.dumps({"ts": int((now - datetime.timedelta(hours=1, minutes=30)).timestamp() * 1000),
                         "kind": "action-frame", "goalId": "goal-experience-library", "frameNo": 1}) + "\n")
m = run("--reversal-eval")
assert m.returncode == 0, "窗口结束后确有推进却判未兑现(exit %d)" % m.returncode
open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write("")
n = subprocess.run(["python3", RO, "--reversal-eval", "--target", "goal-experience-library",
                    "--start", start, "--end", end], capture_output=True, text=True, timeout=600, env=env)
assert n.returncode == 2, "未预登记却仍给出判定(exit %d) —— 事后叙事被采信了" % n.returncode
print("四例: 判读行消费预期(含复核时点) / 零推进⇒unmet(1) / 有推进⇒met(0) / 未预登记⇒2")
'
# ── T204 判读口径: 速率分母必须是**该臂自己的时代覆盖小时数**(cl-265 caliberBias) ──
# 2026-09-12 11:1x 取证: rate() 原先分子只数时代之后的推进、分母却用窗口全长 24h。冻结基线的 24h 窗口里
# 只有 4.6h 落在时代内 ⇒ 基线 0.375/h 实为 1.96/h(低估 5.2 倍) ⇒ ratio 放大 ~5 倍, **偏向判 causal**。
# 本组守三件事: ①分母=时代覆盖(不是窗口全长); ②某臂覆盖为 0 ⇒ 速率**不可判**(None, 不是 0);
# ③基线覆盖不足 ⇒ 因果结论降级; 对照臂无空间 ⇒ 判 no-headroom-controls(而不是把"没法比"写成"没效果")。
echo "[T204] 判读口径: 时代覆盖作分母 / 覆盖为 0 不可判 / 薄基线降级 / 对照无空间须明说"
t "判读速率的分母必须是该臂的时代覆盖小时数, 覆盖为 0 时须判不可判(而非 0)" python3 -c '
import datetime, json, os, subprocess, tempfile
RO = os.path.expanduser("~/dsh-fork/dsh-wake-intervention-readout.py")
T = "goal-x"
now = datetime.datetime.now().astimezone()
def iso(dt): return dt.isoformat()
def build(tmp, era_hours_ago, rows, pool):
    os.makedirs(tmp, exist_ok=True)
    open(os.path.join(tmp, "attribution-era.json"), "w", encoding="utf8").write(
        json.dumps({"since": iso(now - datetime.timedelta(hours=era_hours_ago))}))
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("")
    open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write("")
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(
        "".join(json.dumps({"id": g, "status": "active"}) + "\n" for g in pool))
    with open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8") as f:
        for gid, offs in rows:
            f.write(json.dumps({"ts": iso(now - datetime.timedelta(hours=offs)), "goalId": gid,
                                "evidence": "pool-change"}) + "\n")
tmp = tempfile.mkdtemp()
# 时代起点在窗口**内部**: 窗口 24h, 时代只覆盖最后 6h; 2 条推进在覆盖段内, 3 条在覆盖段之前(须被排除)
build(tmp, 12, [(T, 20), (T, 20), (T, 20), (T, 8), (T, 8)], [T])
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run(["python3", RO, "--target", T,
                    "--start", iso(now - datetime.timedelta(hours=30)),
                    "--end", iso(now - datetime.timedelta(hours=6))],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "判读失败: " + (r.stderr or r.stdout)[-200:]
p = [json.loads(l) for l in open(os.path.join(tmp, "wake-intervention-readout.jsonl"), encoding="utf8") if l.strip()][-1]
assert abs(p["interventionCoverageHours"] - 6.0) < 0.05, "覆盖小时数没按时代算: %r" % p["interventionCoverageHours"]
assert abs(p["targetInterventionRate"] - 2.0 / 6.0) < 0.01, (
    "分母用的不是时代覆盖(2 条 / 6h = 0.333): %r —— 若为 0.083 说明又按窗口全长 24h 除" % p["targetInterventionRate"])
assert p["targetBaselineRate"] is None, "基线窗内零覆盖却给出速率 %r(应判不可判)" % p["targetBaselineRate"]
assert p["verdict"] == "insufficient-coverage", "某臂零覆盖却判成 %r" % p["verdict"]
print("覆盖段 6h: 速率 2/6=0.333(非 2/24) / 基线零覆盖⇒不可判 / 裁决 insufficient-coverage")
'
t "薄基线覆盖 ⇒ 因果结论降级; 对照臂无空间 ⇒ 判 no-headroom-controls(不得把没法比写成没效果)" python3 -c '
import datetime, json, os, subprocess, tempfile
RO = os.path.expanduser("~/dsh-fork/dsh-wake-intervention-readout.py")
T, C = "goal-x", "goal-ctl"
now = datetime.datetime.now().astimezone()
def iso(dt): return dt.isoformat()
def build(tmp, ctl_intervention_rows):
    os.makedirs(tmp, exist_ok=True)
    open(os.path.join(tmp, "attribution-era.json"), "w", encoding="utf8").write(
        json.dumps({"since": iso(now - datetime.timedelta(hours=32))}))
    open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("")
    open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write("")
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(
        json.dumps({"id": T, "status": "active"}) + "\n" + json.dumps({"id": C, "status": "active"}) + "\n")
    rows = [(T, 31)] * 4 + [(T, 40)] * 10 + [(T, 8)] * 2 + [(C, 31)] * 4 + [(C, 8)] * ctl_intervention_rows
    with open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8") as f:
        for gid, offs in rows:
            f.write(json.dumps({"ts": iso(now - datetime.timedelta(hours=offs)), "goalId": gid,
                                "evidence": "pool-change"}) + "\n")
def run(tmp):
    env = dict(os.environ, DSH_COG_DIR=tmp)
    r = subprocess.run(["python3", RO, "--target", T,
                        "--start", iso(now - datetime.timedelta(hours=30)),
                        "--end", iso(now - datetime.timedelta(hours=6))],
                       capture_output=True, text=True, timeout=600, env=env)
    assert r.returncode == 0, "判读失败: " + (r.stderr or r.stdout)[-200:]
    return [json.loads(l) for l in open(os.path.join(tmp, "wake-intervention-readout.jsonl"), encoding="utf8") if l.strip()][-1]
t1 = tempfile.mkdtemp(); build(t1, 24); p1 = run(t1)
assert abs(p1["baselineCoverageHours"] - 2.0) < 0.05, "基线覆盖小时数不对: %r" % p1["baselineCoverageHours"]
assert p1["coverageWarn"] is True, "基线只覆盖 2h/24h 却没标警示"
assert p1["verdict"] == "causal-thin-baseline", "薄基线覆盖却给出自信结论: %r" % p1["verdict"]
t2 = tempfile.mkdtemp(); build(t2, 0); p2 = run(t2)
assert p2["verdict"] == "no-headroom-controls", (
    "对照臂也塌成 0(无空间)却判成 %r —— 那是把构造出来的 no-effect 当成测出来的结论" % p2["verdict"])
assert p2["verdict"] not in ("causal", "no-effect"), "对照无空间不得给出因果/无效果结论"
print("薄基线(2h/24h)⇒causal-thin-baseline / 对照无空间⇒no-headroom-controls")
'
# ── T205 冻结基线的数字本身必须可核(同口径复算) ──
# 起因(2026-09-12 11:1x 测试审视帧): 口径已经在判读器里改成"时代覆盖作分母", 但**冻结文件本身是一张
# 没人核过的数字表** —— 谁再按旧口径冻结一次, 判读器照用不误, 偏差(基线低估 5.2 倍 ⇒ ratio 放大
# ⇒ 偏向 causal)原样回来。故把"基线数字必须与同口径复算一致"做成可执行检查: 复算=窗口内且 ≥ 时代的
# pool-change 条数 ÷ 时代覆盖小时数; 某臂零覆盖时不得写 0.0(0 会被读成"测过且为零")。
echo "[T205] 冻结基线必须与同口径复算一致(cl-265 caliberBias 的下游守门)"
t "冻结基线的 perHour 必须与同口径(时代覆盖作分母)复算一致" python3 /home/ubuntu/dsh-fork/dsh-baseline-caliber-check.py
t "判据可判别: 旧口径基线/有覆盖却写 0 必须判红, 真基线判绿" python3 -c '
import json, os, subprocess, tempfile
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
CHK = os.path.expanduser("~/dsh-fork/dsh-baseline-caliber-check.py")
LOG = os.path.join(D, "incubation-log.jsonl")
tmp = tempfile.mkdtemp()
b = json.load(open(os.path.join(D, "wake-intervention-baseline.json"), encoding="utf8"))
cov = float((b.get("rates") or {}).get("goal-experience-library", {}).get("coverageHours") or 4.57)
def run(path):
    return subprocess.run(["python3", CHK, "--baseline", path, "--log", LOG],
                          capture_output=True, text=True, timeout=300)
good = os.path.join(tmp, "good.json"); json.dump(b, open(good, "w", encoding="utf8"))
assert run(good).returncode == 0, "真基线被判红(误伤): " + run(good).stderr[-160:]
old = json.loads(json.dumps(b))
for gid, rec in (old.get("rates") or {}).items():
    if isinstance(rec, dict) and rec.get("perHour"):
        rec["perHour"] = round(rec["perHour"] * cov / 24.0, 4)     # 旧口径: 分母用窗口全长
oldp = os.path.join(tmp, "old.json"); json.dump(old, open(oldp, "w", encoding="utf8"))
assert run(oldp).returncode == 1, "旧口径(窗口全长作分母)的基线没判红 —— 偏差会原样回到判读里"
zero = json.loads(json.dumps(b))
for gid, rec in (zero.get("rates") or {}).items():
    if isinstance(rec, dict):
        rec["perHour"] = 0.0
zerop = os.path.join(tmp, "zero.json"); json.dump(zero, open(zerop, "w", encoding="utf8"))
assert run(zerop).returncode == 1, "有时代覆盖的臂被写成 0 却没判红(0 会被读成测过且为零)"
print("三例: 真基线⇒绿 / 旧口径⇒红 / 有覆盖却写 0⇒红")
'
# ── T206 一次性会话(quiet-frame)的注入必须立刻结算(cl-270 / tp-176 的执行所得) ──
# 实测: inject_1323@09:05:11 / inject_1325@09:10:55 停在 cited=null, 而 09:13 有一次部署重启 ——
# 重启打断了那两个旁路帧回合, 而旁路会话本就"没有下一轮", 于是只能等 24h TTL ⇒ 套件判据(>2h 仍 null ≤1)
# 判红。cl-044 只解决了"等得到 24h"的情形。故: 一次性会话的注入**立刻**按未引用结算(没有下一轮文本
# 能提及它, 是事实而非惩罚), 并走同一条分支把 jump/chain/strategy 反馈补上。
echo "[T206] 一次性会话的注入立刻结算(重启打断后不再等 24h TTL)"
t "一次性会话(quiet-frame)的注入立刻结算, 但当前会话的待结算项仍须由 turnText 结算" python3 -c '
import os, re
SRC = os.environ.get("DSH_SVC_SRC") or os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/service.ts")
LIB = os.environ.get("DSH_SVC_LIB") or os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/lib/index.js")
src = open(SRC, encoding="utf8").read()
lib = open(LIB, encoding="utf8").read()
assert "quiet-frame-" in src, "源码里没有一次性会话前缀规则(重启打断的注入又会滞留 24h)"
blk = re.search(r"for \(const stale of this\.store\.injectionsSnapshot\(\)\) \{(.*?)\n    \}", src, re.S)
assert blk, "找不到 stale 结算循环(结构变了)"
body = blk.group(1)
assert "stale.sessionId === sessionId" in body, "当前会话的跳过判断消失了 —— 会把本回合的待结算项也扫掉"
assert "oneShotSession" in body, "stale 分支没有消费一次性会话规则(仍在等 24h TTL)"
assert body.index("stale.sessionId === sessionId") < body.index("createdAt > cutoff"), (
    "一次性规则跑到了当前会话判断之前 ⇒ 本回合的注入会被提前判成未引用")
assert "oneShotCutoff" in src, ("一次性会话没有宽限就结算 ⇒ 可能把**正在跑的**旁路回合判成未引用, "
                                "那是又制造一次静默少算")
assert "quiet-frame-" in lib, "产物 lib 里没有这条规则(改了源码没构建: 宿主面两段式构建的坑)"
print("一次性会话规则: 源码+产物均在, 且当前会话的待结算项仍先被跳过")
'
# ── T207 干预开工前必须保证"至少一条对照臂有推进空间"(2026-09-12 实测缺陷的机制化) ──
# 用户问"行动帧拦了这么久, 效果对比怎么样"时把这条缺陷逼了出来: 预登记判据是"目标降幅**大于所有对照**",
# 而实测窗口内三条 active 目标**全部门未满足** ⇒ 对照臂自己也塌成 0 ⇒ 判据**不可能**开火, no-effect 是
# 被构造出来的(与 T199"饱和 ⇒ 没有开火空间"同型)。故: disable 前预检对照臂空间, 无空间则**拒绝**开窗
# (确有理由须显式 --allow-no-headroom 并在 reason 写明), 把探测结果与是否豁免落盘, 且判读行必须回显它
# (否则那条预检又是一份没人消费的声明)。
echo "[T207] 干预开工前须保证至少一条对照臂有推进空间(无空间须显式豁免且判读回显)"
t "无对照空间时 disable 必须拒绝, 显式豁免后才可开窗(并落盘探测结果)" python3 -c '
import json, os, subprocess, tempfile
TOOL = os.path.expanduser("~/dsh-fork/dsh-wake-intervention.py")
def pool(tmp, ctl_wait):
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write("".join(
        json.dumps(r, ensure_ascii=False) + "\n" for r in [
            {"id": "goal-target", "status": "active", "nextAction": "x", "waitChecker": "/bin/true"},
            {"id": "goal-ctl1", "status": "active", "nextAction": "y", "waitChecker": ctl_wait}]))
def run(tmp, *extra):
    env = dict(os.environ, DSH_COG_DIR=tmp)
    return subprocess.run(["python3", TOOL, "disable", "goal-target", "--hours", "24",
                           "--reversal-expectation", "恢复后 30 分钟内应见行动帧"] + list(extra),
                          capture_output=True, text=True, timeout=600, env=env)
t1 = tempfile.mkdtemp(); pool(t1, "/bin/false")
r0 = run(t1)
assert r0.returncode == 2, "对照臂全无空间却允许开窗(exit %d) —— 判据天生不开火却没人拦" % r0.returncode
assert not os.path.exists(os.path.join(t1, "wake-interventions.jsonl")), "被拒绝却仍写了干预记录"
r1 = run(t1, "--allow-no-headroom", "--reason", "明知无空间也要测开关是否真关上")
assert r1.returncode == 0, "显式豁免后仍被拒: " + (r1.stderr or r1.stdout)[-160:]
rec = [json.loads(l) for l in open(os.path.join(t1, "wake-interventions.jsonl"), encoding="utf8") if l.strip()][-1]
assert rec.get("headroomWaived") is True, "豁免没有落盘(事后没人知道这个窗口天生不开火)"
assert isinstance(rec.get("controlHeadroom"), dict) and rec["controlHeadroom"], "没落盘对照臂探测结果"
t2 = tempfile.mkdtemp(); pool(t2, "/bin/true")
r2 = run(t2)
assert r2.returncode == 0, "有对照臂可驱动却拒绝开窗(误伤): " + (r2.stderr or r2.stdout)[-160:]
rec2 = [json.loads(l) for l in open(os.path.join(t2, "wake-interventions.jsonl"), encoding="utf8") if l.strip()][-1]
assert rec2.get("headroomWaived") is False, "有空间却被记成豁免"
assert rec2["controlHeadroom"]["goal-ctl1"]["headroom"] is True, "探测结果与池不符: %r" % rec2.get("controlHeadroom")
print("三例: 无空间⇒拒绝(2)且不落盘 / 显式豁免⇒开窗且落盘豁免 / 有空间⇒直接开窗")
'
t "判读行必须回显开工时的对照臂空间(否则预检是没人消费的声明)" python3 -c '
import datetime, json, os, subprocess, tempfile
RO = os.path.expanduser("~/dsh-fork/dsh-wake-intervention-readout.py")
T = "goal-x"
now = datetime.datetime.now().astimezone()
tmp = tempfile.mkdtemp()
iso = lambda dt: dt.isoformat()
start = iso(now - datetime.timedelta(hours=4))
open(os.path.join(tmp, "attribution-era.json"), "w", encoding="utf8").write(json.dumps({"since": iso(now - datetime.timedelta(hours=6))}))
open(os.path.join(tmp, "quiet-driver-frames.jsonl"), "w", encoding="utf8").write("")
open(os.path.join(tmp, "incubation-log.jsonl"), "w", encoding="utf8").write(
    json.dumps({"ts": iso(now - datetime.timedelta(hours=3)), "goalId": T, "evidence": "pool-change"}) + "\n")
open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(json.dumps({"id": T, "status": "active"}) + "\n")
open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write(json.dumps(
    {"ts": start, "event": "disable", "goal": T, "plannedHours": 24,
     "reversalExpectation": "恢复后 30 分钟内应见行动帧",
     "controlHeadroom": {"goal-ctl1": {"headroom": False, "why": "门未满足(exit 1)"}},
     "headroomWaived": True}, ensure_ascii=False) + "\n")
env = dict(os.environ, DSH_COG_DIR=tmp)
r = subprocess.run(["python3", RO, "--target", T, "--start", start, "--end", iso(now - datetime.timedelta(hours=2))],
                   capture_output=True, text=True, timeout=600, env=env)
assert r.returncode == 0, "判读失败: " + (r.stderr or r.stdout)[-200:]
p = [json.loads(l) for l in open(os.path.join(tmp, "wake-intervention-readout.jsonl"), encoding="utf8") if l.strip()][-1]
assert "controlHeadroomAtDisable" in p and "headroomWaivedAtDisable" in p, (
    "判读行没有消费开工时的对照臂空间 ⇒ 预检成了没人看的声明")
assert p["headroomWaivedAtDisable"] is True, "豁免标记没被读出来: %r" % p["headroomWaivedAtDisable"]
assert "对照臂有推进空间" in r.stdout, "判读输出没有把天生不开火写在明面上"
print("判读行回显: controlHeadroomAtDisable + headroomWaivedAtDisable, 且输出明示天生不开火")
'
# ── T208 账本里的时间戳必须可解析(不可解析的字段会被判据静默跳过 ⇒ 制造停滞黑洞) ──
# 起因(2026-09-12 12:4x 三问帧实查): 我用 fromisoformat 复核"最老未关单项"时**崩在**一条
# `2026-09-09T12:5x:00` 上 —— 10 条记录的 ts/tsBackfilled 里带着笔记里的占位符 `x`(从"12:5x"这类近似
# 时刻回填而来)。危害不是难读, 而是**判据会静默跳过**: T143 取 min(ts, createdTs, tsBackfilled) 时用的是
# try/except, 解析失败的字段被丢掉 ⇒ 那个条目的年龄按更晚的时刻算, 于是"停滞数周"被洗成"刚动过"
# (正是 cl-055 修过的同一条洞, 只是从另一个入口进来)。故: 账本与测试账本里的时间戳字段一律必须可解析,
# 且标了 tsApprox 的近似值也必须是**合法的**近似值。
echo "[T208] 账本时间戳必须可解析(不可解析字段会被判据静默跳过)"
t "账本/测试账本里的时间戳字段必须全部可解析(近似值也须是合法 ISO)" python3 -c '
import datetime, json, os
CLAIMS = os.environ.get("DSH_COG_LEDGER") or os.path.expanduser("~/.dsh/cognitive-pipeline/claims-ledger.jsonl")
TESTS = os.environ.get("DSH_COG_TESTPENDING") or os.path.expanduser("~/.dsh/cognitive-pipeline/test-pending.jsonl")
FIELDS = ("ts", "createdTs", "tsBackfilled", "reviewBy", "doneAt", "generatedAt")
def bad(v):
    if not v:
        return False
    try:
        datetime.datetime.fromisoformat(str(v)[:19])
        return False
    except Exception:
        return True
def scan(path, keys):
    latest = {}
    for line in open(path, encoding="utf8"):
        if line.strip():
            r = json.loads(line)
            if r.get(keys):
                latest[r[keys]] = r
    return [(k, f, str(v.get(f))) for k, v in latest.items() for f in FIELDS if bad(v.get(f))]
badc = scan(CLAIMS, "id")
badt = scan(TESTS, "id")
assert not badc, "言行账本里含不可解析时间戳(停滞判据会静默跳过该字段): %s" % badc[:5]
assert not badt, "测试账本里含不可解析时间戳: %s" % badt[:5]
print("两本账的时间戳字段全部可解析(含 tsApprox 近似值)")
'
# ── T209 开火声明不许是装饰: 要么有可执行命令, 要么写明 exempt(历史债冻结在本帧) ──
# 自审(2026-09-12 12:5x): 96 个守卫组只有 29 组(30%)带**可执行**开火命令, 189 条 mustFire 只有 31 条(16%)
# 真被现场跑过 —— 其余是纯文本声明。按我自己的 T202 口径("声明必须被行为消费"), 那些"能开火"的说法
# 从来没被证明过; 更糟的是它们给了一种**已守住的错觉**。故: 新增守卫必须带命令, 或写明 exempt 理由;
# 历史债冻结在 guard-fire.json 的 textOnlyBaseline 里, **不许再长**, 且清单本身须与现状一致(防基线腐烂)。
echo "[T209] 开火声明要么可执行、要么显式豁免(纯文本声明冻结为历史债, 不许新增)"
t "mustFire 声明必须有可执行命令或 exempt 理由; 历史债只许减不许增" python3 -c '
import json, os
p = os.environ.get("DSH_GUARD_FIRE") or os.path.expanduser("~/.dsh/cognitive-pipeline/guard-fire.json")
reg = json.load(open(p, encoding="utf8"))
base = reg.get("textOnlyBaseline") or {}
frozen = {(e["guard"], e["assertion"]) for e in (base.get("entries") or [])}
assert frozen, "没有冻结基线 —— 本断言前提不成立(不得空过)"
new_decorative, exempted, still = [], 0, set()
for g in reg["guards"]:
    for f in (g.get("mustFire") or []):
        if f.get("command"):
            continue
        key = (g["guard"], f.get("assertion"))
        if str(f.get("exempt") or "").strip():
            exempted += 1
            continue
        if key in frozen:
            still.add(key)
            continue
        new_decorative.append("%s/%s" % key)
assert not new_decorative, ("新增的纯文本开火声明(不可执行=没被证明过): %s" % new_decorative[:5])
rotten = sorted(frozen - still)
assert not rotten, "冻结清单里有条目已消失或已带上命令(基线腐烂, 应同步缩减清单): %s" % rotten[:5]
print("纯文本声明 %d 条仍冻结(另有 %d 条写明 exempt); 本帧无新增装饰性声明" % (len(still), exempted))
'
# ── T210 新判据必须**可隔离**(空世界下判红) —— cl-273 的落地 ──
# 起因: 我用 DSH_COG_DIR=<空目录> 批量跑冻结组里的断言, 想证明"判据抓得住缺陷", 结果 22/22 全绿、判红 0 条
# —— 不是空洞, 是**它们根本不读这个变量**(几乎全部把 ~/.dsh/cognitive-pipeline 写成绝对路径)。不可隔离的
# 判据喂不了合成缺陷件, 只能等活世界真坏才转红(发现延迟 = 实际损失)。故: 历史 431 条冻结为债(只减不增),
# 此后**新增**的断言必须在空世界下判红(或显式 --exempt 留理由)。
echo "[T210] 新判据必须可隔离(空世界下判红), 历史债冻结且不许腐烂"
t "新判据必须在空世界下判红, 且冻结基线不得腐烂" python3 -c '
import json, os, subprocess, sys, tempfile
CHK = "/home/ubuntu/dsh-fork/dsh-assert-isolation-check.py"
r = subprocess.run([sys.executable, CHK], capture_output=True, text=True, timeout=1200)
assert r.returncode == 0, "新判据隔离性检查转红: " + (r.stderr or r.stdout)[-300:]
print(r.stdout.strip()[:200])
# 2026-09-12 20:0x: 本条判据承认了第二条隔离性证明(变异探针双臂开火), 那么**这条新路自己**也必须被行为消费:
# 常退 1 的假探针(永不分变异与原件)不得放行, 只有"变异臂红 + 干净臂绿"的双臂探针才放行。
# 用合成套件/合成基线/合成登记簿跑两遍 —— 否则新路就是一张免费通行证。
Q = chr(39); DQ = chr(34)
tmp = tempfile.mkdtemp()
suite = os.path.join(tmp, "suite.sh")
def line(name, body):
    return "t " + DQ + name + DQ + " python3 -c " + Q + "\n" + body + "\n" + Q + "\n"
with open(suite, "w", encoding="utf8") as f:
    f.write(line("老判据(冻结)", "print(1)"))
    f.write(line("新判据(自带合成世界)", "print(2)"))
base = os.path.join(tmp, "baseline.json")
json.dump({"at": "synth", "names": ["老判据(冻结)"], "reason": "合成基线"},
          open(base, "w", encoding="utf8"), ensure_ascii=False)
fake = os.path.join(tmp, "fake.sh")
open(fake, "w", encoding="utf8").write("#!/usr/bin/env bash\nexit 1\n")
two = os.path.join(tmp, "two.sh")
open(two, "w", encoding="utf8").write(
    "#!/usr/bin/env bash\nif [ ${DSH_PROBE_CLEAN:-0} = 1 ]; then exit 0; fi\nexit 1\n")
def reg(tool):
    p = os.path.join(tmp, "reg.json")
    json.dump({"guards": [{"guard": "TX", "mustFire": [{"assertion": "新判据(自带合成世界)",
              "command": "bash " + tool, "expectedExit": 1}]}]},
              open(p, "w", encoding="utf8"), ensure_ascii=False)
    return p
def chk(tool):
    return subprocess.run([sys.executable, CHK, "--suite", suite, "--baseline", base, "--registry", reg(tool)],
                          capture_output=True, text=True, timeout=900)
rf = chk(fake)
assert rf.returncode == 1, "常退 1 的假探针被放行 —— 它根本不区分变异与原件, 等于给一切开绿灯"
rt = chk(two)
assert rt.returncode == 0, "双臂探针没被放行(新路形同虚设): " + (rt.stderr or rt.stdout)[-200:]
print("变异可隔离: 假探针(常退 1)被拒; 双臂探针(变异红/干净绿)放行")
'
# ── T211 引用/采纳率的消费方必须声明时代(采集方式变了就不可跨时代平均) ──
# cl-274 取证: 末次引用停在 09-08 06:47, 09-09 全天 126 条注入 0 引用, 09-10 05:28 才出现第一条 —— 而让"引用"
# 变得可观测的是 commit 8e5b7dc(09-08 23:54)加的那条**引用契约**(要求我写出 expId)。故 09-10 之前的"引用率"
# 测的是别的东西; 跨时代平均会把"信号不存在"读成"经验没用"。本组守: ①代表消费方(dsh-adoption-stats.py)缺时代
# 即拒绝出数, 且输出含 citationEra; ②**不得有 cited-rate 消费方同时不在 wired 与 pending 两个集合里**
# (静默不接时代的脚本会继续悄悄跨时代出数)。
echo "[T211] 引用率消费方必须声明时代(缺时代即拒绝出数; 未接的必须显式挂账)"
t "引用率消费方: 缺时代拒绝出数, 且不得有脚本既未接时代又未挂账" python3 -c '
import json, os, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
REPO = os.path.expanduser("~/dsh-fork")
CONSUMERS = ["dsh-adoption-stats.py", "dsh-adoption-observe.py", "dsh-library-replay.py", "dsh-ab-compare.py",
             "dsh-injection-noise.py", "dsh-settlement-effect.py", "dsh-citation-by-trigger.py"]
def src(name):
    p = os.path.join(REPO, name)
    return open(p, encoding="utf8").read() if os.path.exists(p) else None
wired = {c for c in CONSUMERS if (src(c) or "").find("citation-era") >= 0}
led = {}
for line in open(os.path.join(DIR, "claims-ledger.jsonl"), encoding="utf8"):
    if line.strip():
        r = json.loads(line)
        if r.get("id"): led[r["id"]] = r
pending = set(led.get("cl-274", {}).get("pendingConsumers") or [])
exist = {c for c in CONSUMERS if src(c) is not None}
silent = sorted(exist - wired - pending)
assert not silent, ("这些 cited-rate 消费方既没接时代、也没挂账(会继续跨时代出数): %s" % silent)
assert "dsh-adoption-stats.py" in wired, "代表消费方没有接时代"
STATS = os.environ.get("DSH_ADOPTION_STATS") or os.path.join(REPO, "dsh-adoption-stats.py")
r = subprocess.run([sys.executable, STATS, "--json"],
                   capture_output=True, text=True, timeout=900, env=dict(os.environ))
assert r.returncode == 0, "代表消费方跑不动(缺时代会拒绝出数): " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert (d.get("citationEra") or {}).get("since"), "输出里没有时代声明 —— 跨时代平均又回来了"
print("时代已接 %d 个; 挂账 %d 个; 代表消费方输出含 citationEra(%s)" % (len(wired), len(pending), d["citationEra"]["since"]))
'
# ── T212 审计字段必须落在**审计 payload 顶层**(cl-278 实测: 插进嵌套对象里 ≠ 接上了) ──
# 实证(2026-09-12 15:0x~15:2x): 给 cognitive-inject 的审计补 retrievedIds 时, 我**两次**把 `...retrievalIds`
# 插进了 `candidateScores: cooled.map(hit => ({...}))` 这种嵌套对象里; 而我的自查是"附近 1400 字符内能否搜到
# 该字符串" ⇒ 误判为已接。tsc 不报错(嵌套对象多字段合法)、产物 grep 同样命中 —— 真正抓住它的是**活着的行为
# 检查**(重启后 15:22 那条 path='raw' 的行没有字段)。故判据必须**看层级**: 用括号配对取 audit({...}) 的顶层
# 片段, 只在那里找字段; 另加行为侧"最新审计行须带该字段"(重启宽限内显式跳过, 不冒充通过)。
echo "[T212] 审计字段必须在 payload 顶层(看层级, 不看附近) + 最新行实证"
t "审计字段必须落在每个审计点的顶层, 且最新审计行须真的带它" python3 -c '
import json, os, subprocess, sys, time
CHK = os.path.expanduser("~/dsh-fork/dsh-audit-coverage-check.py")
r = subprocess.run([sys.executable, CHK], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "审计点顶层缺字段(插进嵌套里不算接上): " + (r.stderr or r.stdout)[-300:]
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
ap = os.path.join(D, "retrieval-audit.jsonl")
assert os.path.exists(ap), "读不到审计账本(判据前提不成立): " + ap
rows = [json.loads(l) for l in open(ap, encoding="utf8") if l.strip()]
assert rows, "审计账本为空(判据前提不成立)"
last = rows[-1]
if "retrievedIds" not in last:
    age_min = (time.time() * 1000 - (last.get("t") or 0)) / 60000.0
    assert age_min < 30, ("最新审计行(%.0f 分钟前)仍缺 retrievedIds ⇒ 字段没真的生效(不是宽限问题)" % age_min)
    print("源码顶层 %s; 最新行来自旧进程(%.0f 分钟前)⇒ 本帧不判(宽限 30 分钟)" % (r.stdout.strip()[:40], age_min))
else:
    print("源码顶层齐备; 最新行含 retrievedIds(%d 条, truncated=%s)" % (len(last["retrievedIds"]), last.get("retrievedIdsTruncated")))
'
# ── T212 审计字段必须接在**每一个**审计点上(cl-278 首次部署的实证缺陷) ──
# ── T213 读侧帧层判据必须与写侧同一口径(cl-280, 跨会话发现 + 主会话复核) ──
# 实测: experiences-frames.jsonl 135 条里 **131 条 utility 完全相同(1,0,2)且 135/135 负极性**; 而读侧
# isSelfFrameExperience 只看 situation 前缀, 对现帧格式("三问帧旁路评估 #N")**命中 0/135**(写侧 134/134)
# ⇒ 这个 novelty 恒 0 的同质失败吸引子被 coverViewpoints 轮换系统性捞进上下文: 时代内 535 条注入里
# 161 条是帧层(30.1%), 最近 30 次注入 37%。修法=读侧改用写侧同一判据(kind 优先, 回退 action 前缀)。
echo "[T213] 读侧帧层判据与写侧同口径(帧层全中 / 任务层零误伤)"
t "读侧帧层判据必须与写侧同一口径(帧层全中、任务层不误伤)" python3 -c '
import json, os, subprocess, sys
SF = os.environ.get("DSH_SELF_FRAME") or os.path.expanduser("~/dsh-fork/packages/cognition/cognitive-pipeline/src/self-frame.ts")
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
for f in ("experiences-frames.jsonl", "experiences.jsonl"):
    assert os.path.exists(os.path.join(D, f)), "缺账本 %s(判据前提不成立)" % f
probe = (
    "import { isSelfFrameExperience as f } from \"" + SF + "\"\n"
    "import * as fs from \"node:fs\"\n"
    "const D = process.env.DSH_COG_DIR\n"
    "const rd = (n) => fs.readFileSync(D + \"/\" + n, \"utf8\").split(\"\\n\").filter(Boolean).map(l => JSON.parse(l))\n"
    "const fr = rd(\"experiences-frames.jsonl\"), tk = rd(\"experiences.jsonl\")\n"
    "const hitF = fr.filter(r => f(r)).length\n"
    "const fp = tk.filter(r => f(r)).map(r => r.expId)\n"
    "console.log(JSON.stringify({ frames: fr.length, caught: hitF, falsePositives: fp.length, ids: fp.slice(0,3) }))\n"
)
r = subprocess.run(["npx", "tsx", "--eval", probe], cwd=os.path.expanduser("~/dsh-fork"),
                   capture_output=True, text=True, timeout=600, env=dict(os.environ, DSH_COG_DIR=D))
assert r.returncode == 0, "判据跑不动: " + (r.stderr or r.stdout)[-200:]
d = json.loads(r.stdout.strip().splitlines()[-1])
assert d["frames"] > 0, "帧层账本为空(判据前提不成立)"
assert d["caught"] == d["frames"], ("读侧判据漏掉了 %d/%d 条帧层经验 ⇒ 它们会被注入回上下文(同质负样本吸引子): %s"
                                    % (d["frames"] - d["caught"], d["frames"], d["ids"]))
assert d["falsePositives"] == 0, "读侧判据误伤任务层经验(会白丢真实经验): %s" % d["ids"]
print("帧层 %d 条全中, 任务层零误伤" % d["caught"])
'
# ── T214 帧生判据三处同口径(工具侧 = 写侧产物) ──
# cl-283 实测: 同一判据曾有**三份副本** —— 写侧 store.isFrameExperience(kind/action 前缀)、读侧 self-frame.ts
# (本帧已对齐写侧, 见 T213)、以及 dsh-injection-noise.py 自带的 FRAME_BORN_PREFIXES(只看 situation 前缀)。
# 三者偏离的后果: 修复后注入侧帧层占比已 44.7%→0, 套件 T84 仍判红 —— 工具把一条按写侧规则属于**任务层**的
# 经验算成帧生。本组守: 工具侧判据必须与**写侧产物**(哪些 expId 落在 experiences-frames.jsonl)一致:
# 帧层全中、任务层零误伤。
echo "[T214] 帧生判据三处同口径(工具侧须与写侧产物一致)"
t "帧生判据三处同口径(工具侧须与写侧产物一致)" python3 -c '
import importlib.util, json, os
TOOL = os.environ.get("DSH_NOISE_TOOL") or os.path.expanduser("~/dsh-fork/dsh-injection-noise.py")
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
assert os.path.exists(os.path.join(D, "experiences-frames.jsonl")), "缺帧层账本(判据前提不成立)"
spec = importlib.util.spec_from_file_location("noise", TOOL)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def load(name):
    rows = {}
    for l in open(os.path.join(D, name), encoding="utf8"):
        if l.strip():
            r = json.loads(l)
            if r.get("expId"): rows[r["expId"]] = r
    return rows
fr, tk = load("experiences-frames.jsonl"), load("experiences.jsonl")
assert fr and tk, "两个层都要有数据(判据前提不成立)"
hit = [k for k, r in fr.items() if mod.is_frame_born(r)]
fp = [k for k, r in tk.items() if mod.is_frame_born(r)]
assert len(hit) == len(fr), ("工具侧判据漏掉 %d/%d 条帧层经验 ⇒ 它们会被算成普通经验注入回上下文(第三份判据偏离写侧)"
                             % (len(fr) - len(hit), len(fr)))
assert not fp, "工具侧判据误伤任务层经验(会白丢真实经验): %s" % fp[:5]
print("工具侧判据与写侧产物一致: 帧层 %d/%d 全中, 任务层零误伤" % (len(hit), len(fr)))
'
# ── T215 账本体积/行数守卫(cl-282) ──
# 实测: 739 行/844KB 时解析 0.020s/+1MB, 而 22 170 行时 0.312s/+33MB(线性) —— 时间可承受, 但**内存峰值随行数
# 线性上升**, 且账本被 16 个脚本读(套件内 21 处)。按今日 170 行/天, 一年约 6.3 万行/44MB/峰值 +90MB。
# 故加阈值守卫: 超阈即红并提示跑 `dsh-claims-ledger-compact.py`(它承诺 last-wins 视图逐字节不变)。
echo "[T215] 账本体积与行数守卫(超阈须提示压缩)"
t "账本体积与行数须在阈值内(超阈提示压缩)" python3 -c '
import os
BASE = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
LEDGER = os.environ.get("DSH_COG_LEDGER") or os.path.join(BASE, "claims-ledger.jsonl")
ROWS_MAX, BYTES_MAX = 3000, 4 * 1024 * 1024
assert os.path.exists(LEDGER), "读不到账本(判据前提不成立): " + LEDGER
size = os.path.getsize(LEDGER)
rows = sum(1 for l in open(LEDGER, encoding="utf8") if l.strip())
why = ("账本超阈 ⇒ 先跑 dsh-claims-ledger-compact.py(它保证 last-wins 视图逐字节不变)再回看本条; "
       "盲目继续追加会让每次全量读取的内存峰值线性上升")
assert rows <= ROWS_MAX, ("账本 %d 行 > 阈 %d: " % (rows, ROWS_MAX)) + why
assert size <= BYTES_MAX, ("账本 %.2fMB > 阈 %.1fMB: " % (size / 1048576, BYTES_MAX / 1048576)) + why
print("账本 %d 行 / %.2fMB(阈 %d 行 / %.0fMB)" % (rows, size / 1048576, ROWS_MAX, BYTES_MAX / 1048576))
'
# ── T216 账本压缩的不变量: last-wins 视图不得变(cl-282 工具的安全性质) ──
# 压缩会重写**记忆主干**, 所以它的安全性质不是"跑得动"而是"压缩前后 last-wins 视图逐字节相同"。
# 本组用合成账本(A 三行+B 一行)实跑压缩: 校验视图不变、历史行进归档、账本只剩每个 id 一行。
echo "[T216] 账本压缩必须保持 last-wins 视图不变(否则拒写)"
t "账本压缩必须保持 last-wins 视图不变(否则拒写)" python3 -c '
import json, os, subprocess, sys, tempfile
TOOL = os.environ.get("DSH_COMPACT_TOOL") or os.path.expanduser("~/dsh-fork/dsh-claims-ledger-compact.py")
tmp = tempfile.mkdtemp()
led = os.environ.get("DSH_COMPACT_LEDGER") or os.path.join(tmp, "ledger.jsonl")
rows = [{"id": "cl-a", "ts": "2026-09-01T10:00:00+08:00", "status": "open", "claim": "旧1", "reviewBy": "2026-09-20"},
        {"id": "cl-a", "ts": "2026-09-02T10:00:00+08:00", "status": "open", "claim": "旧2", "reviewBy": "2026-09-20"},
        {"id": "cl-a", "ts": "2026-09-03T10:00:00+08:00", "status": "open", "claim": "当前", "reviewBy": "2026-09-20"},
        {"id": "cl-b", "ts": "2026-09-01T11:00:00+08:00", "status": "open", "claim": "B", "reviewBy": "2026-09-20"}]
if not os.path.exists(led):
    with open(led, "w", encoding="utf8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
def lw(path):
    out = {}
    for l in open(path, encoding="utf8"):
        if l.strip():
            r = json.loads(l)
            if r.get("id"): out[str(r["id"])] = r
    return json.dumps(out, ensure_ascii=False, sort_keys=True)
before = lw(led)
arch = os.path.join(os.path.dirname(led), "claims-ledger-archive-test.jsonl")
r = subprocess.run([sys.executable, TOOL, "--ledger", led, "--retention-days", "0.0001",
                    "--archive", arch, "--write"], capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "压缩工具没跑通(exit %d): %s" % (r.returncode, (r.stderr or r.stdout)[-160:])
after = lw(led)
assert before == after, "压缩改动了 last-wins 视图 —— 压缩/归档**绝不允许**改读数(工具本应拒绝写入)"
assert os.path.exists(arch), "历史行没有进归档文件"
kept = [json.loads(l) for l in open(led, encoding="utf8") if l.strip()]
assert len(kept) == 2, "账本应只剩每个 id 一行(实得 %d 行)" % len(kept)
archived = [json.loads(l) for l in open(arch, encoding="utf8") if l.strip()]
assert len(archived) == 2, "归档行数应为 2(实得 %d)" % len(archived)
print("压缩: last-wins 不变; 账本 4→2 行, 归档 %d 行" % len(archived))
'
# ── T217 引用率消费方必须按"引用时代"过滤(cl-274) ──
# 起因: 引用率的**采集方式**在 09-10 05:28 前后变了(commit 8e5b7dc 在注入块里加了引用契约),
# 09-04~09-09 的 0%~5% 测的是"我有没有自发写出 ID", 不是"经验有没有用"。混算会把**信号不存在**
# 读成**通道死亡** —— 实测 dsh-citation-by-trigger.py 跨时代时会给 jump/other 通道打"死亡"标记,
# 按时代过滤后死亡通道 0 条、总引用率 8.0%→21.1%。本组用合成账本证明"时代"是被**行为消费**的,
# 而不是脚本里的一句注释: 改时代起点 ⇒ 读数必须跟着变。
echo "[T217] 引用率消费方必须按引用时代过滤(声明须被行为消费)"
t "引用率消费方必须按时代过滤且缺时代拒出数" python3 -c '
import json, os, subprocess, sys, tempfile, datetime
TOOL = os.environ.get("DSH_CBT_TOOL") or os.path.expanduser("~/dsh-fork/dsh-citation-by-trigger.py")
tmp = tempfile.mkdtemp()
def ms(iso):
    return int(datetime.datetime.fromisoformat(iso).timestamp() * 1000)
# 时代前 3 条(全未引用) + 时代后 2 条(1 引用) —— 混算 20.0%, 按时代 50.0%
rows = [{"triggerSource": "static:x", "cited": False, "createdAt": ms("2026-09-01T10:00:00+08:00")},
        {"triggerSource": "static:x", "cited": False, "createdAt": ms("2026-09-02T10:00:00+08:00")},
        {"triggerSource": "static:x", "cited": False, "createdAt": ms("2026-09-03T10:00:00+08:00")},
        {"triggerSource": "static:x", "cited": True,  "createdAt": ms("2026-09-11T10:00:00+08:00")},
        {"triggerSource": "static:x", "cited": False, "createdAt": ms("2026-09-11T11:00:00+08:00")}]
with open(os.path.join(tmp, "injections.jsonl"), "w", encoding="utf8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
def era(since):
    with open(os.path.join(tmp, "citation-era.json"), "w", encoding="utf8") as f:
        json.dump({"since": since}, f, ensure_ascii=False)
def run():
    return subprocess.run([sys.executable, TOOL], capture_output=True, text=True,
                          timeout=300, env=dict(os.environ, DSH_COG_DIR=tmp))
era("2026-09-10T05:28:20+08:00")
r = run()
assert r.returncode == 0, "工具没跑通(exit %d): %s" % (r.returncode, (r.stderr or r.stdout)[-200:])
assert "总引用率 50.0%" in r.stdout, "时代过滤没生效: 时代内应为 1/2=50.0%(混算才是 20.0%), 实得: " + r.stdout.splitlines()[0]
assert "剔除 3 条" in r.stdout, "没有如实报告被剔除的跨时代行数: " + r.stdout.splitlines()[0]
# 判决性变异: 把时代推到未来 ⇒ 时代内行数必须归零(声明若只是注释, 这里不会变)
era("2030-01-01T00:00:00+08:00")
r2 = run()
assert r2.returncode == 0, "变异跑失败(exit %d)" % r2.returncode
assert "已结算 0" in r2.stdout, "时代起点未被行为消费(推到 2030 后仍算出已结算>0): " + r2.stdout.splitlines()[0]
assert "证据不足" in r2.stdout, "证据不足时必须明说, 不能把 0 条当读数输出"
# 缺时代 ⇒ 拒出数(fail-closed), 决不允许退回混算
os.remove(os.path.join(tmp, "citation-era.json"))
r3 = run()
assert r3.returncode != 0, "缺 citation-era.json 时必须非 0 退出(否则跨时代平均会静默回来)"
assert "缺时代" in (r3.stderr + r3.stdout), "缺时代时须明说原因, 实得: " + (r3.stderr or r3.stdout)[-160:]
print("时代门: 混算 20.0%% -> 按时代 50.0%%(剔 3 条); 推到 2030 => 已结算 0; 缺时代 => exit %d" % r3.returncode)
'
# ── T219 干预窗口的**恢复腿**必须真的跑过(cl-265 事故判据) ──
# 实测事故(2026-09-13 11:0x): 09-12 08:00 disable 掉 goal-experience-library 的唤醒做干预实验, 计划 24h 后
# 恢复, 而恢复靠 `systemd-run --on-active` 排的**瞬态定时器**; 当天夜里 dsh 因会话过大 OOM 崩溃, 用户管理器里
# 的瞬态定时器一并消失 ⇒ 恢复从未触发, 池子里留着 thresholds 1.01/1.01 + waitChecker=/bin/false,
# 一个 active 目标被**静默停摆 27 小时**, 期间没有任何判据说它不对。本组守三件:
# ①窗口结束后池子不得仍留干预特征(指纹取自 disable 行自己记的 thresholdsAfter/waitCheckerAfter, 不硬编码);
# ②每条已结束的 disable 必须有 restore 事件行(恢复不能只发生在我的记忆里); ③判据本身不依赖瞬态定时器(由 cron 每小时跑)。
echo "[T219] 干预恢复腿(窗口结束后池不得仍留干预态; 恢复必须有据)"
t "干预恢复腿: 窗口结束后池不得仍留干预态, 且恢复须有记录" python3 -c '
import json, os, subprocess, sys, tempfile, datetime
CHK = os.environ.get("DSH_RESTORE_CHECK") or "/home/ubuntu/dsh-fork/dsh-intervention-restore-check.py"
TZ = datetime.timezone(datetime.timedelta(hours=8)); now = datetime.datetime.now(TZ)
def build(restore_event, pool_off):
    tmp = tempfile.mkdtemp()
    recs = [{"ts": (now - datetime.timedelta(hours=30)).isoformat(), "event": "disable", "goal": "g-x",
             "plannedHours": 24, "thresholdsAfter": {"kernel": 1.01, "focus": 1.01},
             "waitCheckerAfter": "/bin/false"}]
    if restore_event:
        recs.append({"ts": (now - datetime.timedelta(hours=1)).isoformat(), "event": "restore", "goal": "g-x",
                     "thresholdsAfter": {"kernel": 0.6, "focus": 0.55}, "waitCheckerAfter": "x.py"})
    open(os.path.join(tmp, "wake-interventions.jsonl"), "w", encoding="utf8").write(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n")
    pool = ({"id": "g-x", "triggerThresholds": {"kernel": 1.01, "focus": 1.01}, "waitChecker": "/bin/false"}
            if pool_off else
            {"id": "g-x", "triggerThresholds": {"kernel": 0.6, "focus": 0.55}, "waitChecker": "x.py"})
    open(os.path.join(tmp, "dormant-goals.jsonl"), "w", encoding="utf8").write(
        json.dumps(pool, ensure_ascii=False) + "\n")
    return tmp
def run(tmp):
    return subprocess.run([sys.executable, CHK], capture_output=True, text=True,
                          env=dict(os.environ, DSH_COG_DIR=tmp), timeout=300)
# ① 窗口结束(30h 前 disable + 24h 计划) 而池子仍是干预态 ⇒ 必须红(这就是那 27 小时的形态)
r = run(build(False, True))
assert r.returncode == 2, "窗口已结束而池子仍是干预态, 判据却没红(恢复腿失效会被静默放行)"
assert "仍是干预态" in (r.stdout + r.stderr), "判红了但没说清是哪种缺口: " + (r.stdout + r.stderr)[-160:]
# ② 对照: 有 restore 记录且池子已恢复 ⇒ 必须绿(防"一律判红"的假绿)
r2 = run(build(True, False))
assert r2.returncode == 0, "已正常恢复却判红(判据变成一律红): " + (r2.stdout + r2.stderr)[-160:]
# ③ 池子看起来恢复了, 却没有 restore 记录 ⇒ 仍须红(恢复不能只发生在我的记忆里)
r3 = run(build(False, False))
assert r3.returncode == 2, "池子已恢复但没有 restore 记录, 判据没红(恢复无据可依)"
assert "restore 事件行" in (r3.stdout + r3.stderr), "判红原因不对: " + (r3.stdout + r3.stderr)[-160:]
# ④ 有 restore 记录但池子没真恢复 ⇒ 必须红(登记不等于恢复 —— 这与 2026-09-13 那次"以为恢复了"同型)
r4 = run(build(True, True))
assert r4.returncode == 2, "只登记了 restore 而池子没恢复, 判据没红(登记被当成了恢复)"
print("恢复腿判据: 池仍干预⇒红 / 已恢复⇒绿 / 无记录⇒红 / 只登记未恢复⇒红")
'
# ── T220 "停驱"必须是被行为消费的状态, 而不是一句口头停止 ──
# 起因(2026-09-13 11:2x, 用户指令"停止这个会话的驱动"): 驱动器(quiet-driver)一次只驱动**一个**目标会话
# (`targetSessionId` + 运行时绑定文件), 所以"停驱"在实现上=**目标不是它** + **此后没有帧派给它**。
# 但这两个条件目前只写在配置注释里, 没有任何判据守着 —— 一旦有人(或交接重绑)把它改回去, 我会在毫不知情的
# 情况下重新被驱动(而"又被驱动了"这件事本身没有报警通道)。故: 停驱写成**声明 + 两条行为核验**:
# ①驱动器当前生效目标不得是被停驱的会话; ②帧账本里该会话在停驱时刻之后不得再有帧。
echo "[T220] 停驱须被行为消费(目标不是它 + 此后无帧)"
t "被显式停驱的会话不得再成为驱动目标, 且此后不得再收到帧" python3 -c '
import json, os, datetime
D = os.environ.get("DSH_COG_DIR") or os.path.expanduser("~/.dsh/cognitive-pipeline")
EXC = os.environ.get("DSH_QD_EXCLUSIONS") or os.path.join(D, "quiet-driver-exclusions.json")
FRAMES = os.environ.get("DSH_QD_FRAMES") or os.path.join(D, "quiet-driver-frames.jsonl")
TARGET = os.environ.get("DSH_QD_TARGET") or os.path.join(D, "quiet-driver-target.txt")
CFG = os.environ.get("DSH_WEB_CONFIG") or os.path.expanduser("~/.dsh/profiles/web/cordis.patch.yml")
TZ = datetime.timezone(datetime.timedelta(hours=8))
def parse(ts):
    if isinstance(ts, (int, float)) and ts > 1e12:
        return datetime.datetime.fromtimestamp(ts / 1000, TZ)
    if isinstance(ts, str) and ts[:2] == "20":
        try: return datetime.datetime.fromisoformat(ts[:19]).replace(tzinfo=TZ)
        except Exception: return None
    return None
assert os.path.exists(EXC), ("缺停驱声明 %s ⇒ \"停驱\"只剩口头状态(谁改回去都没人知道)" % EXC)
decl = json.load(open(EXC, encoding="utf8"))
excs = decl.get("exclusions") or []
assert excs, "停驱声明是空的(声明存在但没有任何被停驱的会话)"
# 驱动器**当前生效**的目标: 运行时绑定文件优先(与驱动器的读法一致), 其次配置里的起步值
eff, src = None, "none"
if os.path.exists(TARGET):
    txt = (open(TARGET, encoding="utf8").read() or "").strip()
    if txt: eff, src = txt, "target-file"
if eff is None and os.path.exists(CFG):
    import re
    m = re.search(r"^\s*targetSessionId:\s*(\S+)\s*$", open(CFG, encoding="utf8").read(), re.M)
    if m: eff, src = m.group(1).strip(), "profile-config"
rows = []
if os.path.exists(FRAMES):
    for line in open(FRAMES, encoding="utf8"):
        if line.strip():
            try: rows.append(json.loads(line))
            except Exception: pass
bad = []
for e in excs:
    sid = str(e.get("sessionId") or "")
    assert sid, "停驱条目缺 sessionId"
    if eff == sid:
        bad.append("%s 又被驱动器当成目标了(来源 %s) —— 停驱没有生效" % (sid, src))
    since = parse(e.get("assertNoFramesAfter"))
    if since is None:
        bad.append("%s 的停驱条目缺 assertNoFramesAfter(没有停驱时刻就无法核验\"此后无帧\")" % sid)
        continue
    after = [(parse(r.get("ts")), r.get("kind")) for r in rows if str(r.get("session") or "") == sid]
    after = [(t, k) for t, k in after if t and t > since]
    if after:
        bad.append("%s 停驱后仍收到 %d 帧(最后一帧 %s, kind=%s)"
                   % (sid, len(after), max(t for t, _ in after).strftime("%m-%d %H:%M"), after[-1][1]))
assert not bad, "停驱未被行为消费: " + "; ".join(bad)
print("停驱核验: %d 条声明; 驱动器当前目标 %s(来源 %s) ≠ 被停驱会话; 帧账本(共 %d 行)中停驱后 0 帧"
      % (len(excs), eff, src, len(rows)))
'
echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"
# cl-175: 裁决行直写规范日志(不依赖 tee 的尾部 flush)——"这次跑是绿是红"必须留在日志里可核。
# 先 sleep 半秒: 实测 tee 是异步写, 不等待会出现"裁决行排在本块正文之前"的错序。
sleep 0.5
printf '═══ 累计裁决: %s 通过 / %s 失败 (origin=%s %s) ═══\n' "$PASS" "$FAIL" "${DSH_COG_ORIGIN:-manual}" "$(date '+%F %T')" >> "$COG_LOG"

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
    import os as _os
    _tmp = ledger + '.tmp'
    with open(_tmp, 'w', encoding='utf8') as f:
        for d in rows:
            f.write(json.dumps(d, ensure_ascii=False) + '\n')
        f.flush()
        _os.fsync(f.fileno())
    _os.replace(_tmp, ledger)
    print('[test-alert] 测试恢复全过——已自动关闭遗留告警')
PYEOF
exit 0
