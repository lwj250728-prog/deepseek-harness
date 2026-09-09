#!/usr/bin/env bash
# dsh-script-lint.sh — 工具脚本语法闸（2026-09-09 13:3x 建立，cl-072）
#
# 由来：我这一轮三次把 dsh-cog-tests.sh 改坏（T46 断言的 docstring 剥离、块替换边界），
# 每次都是靠 bash -n 或套件自跑才发现的——而**测试脚本本身有语法错时，它根本跑不起来**，
# 也就无法用"套件内的断言"保护自己。所以需要一道独立于套件的闸：
#   · 对 dsh-*.sh 跑 bash -n
#   · 对 dsh-*.py 跑 py_compile
# 失败即写入言行账本（帧头有机制保证的通道），恢复后自动关闭。
#
# 用法: dsh-script-lint.sh [--quiet]
set -uo pipefail

ROOT="${DSH_ROOT:-/home/ubuntu/dsh-fork}"
DIR="$HOME/.dsh/cognitive-pipeline"
LEDGER="$DIR/claims-ledger.jsonl"
QUIET="${1:-}"

failures=()
for script in "$ROOT"/dsh-*.sh; do
  [ -f "$script" ] || continue
  if ! bash -n "$script" 2>/tmp/dsh-lint-err.txt; then
    failures+=("$(basename "$script"): $(head -1 /tmp/dsh-lint-err.txt)")
  fi
done
for script in "$ROOT"/dsh-*.py; do
  [ -f "$script" ] || continue
  if ! python3 -m py_compile "$script" 2>/tmp/dsh-lint-err.txt; then
    failures+=("$(basename "$script"): $(tail -1 /tmp/dsh-lint-err.txt)")
  fi
done

now=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat())")

if [ "${#failures[@]}" -gt 0 ]; then
  echo "[script-lint] ✗ ${#failures[@]} 个脚本语法错误:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  python3 - "$LEDGER" "$now" "${failures[*]}" << 'PYEOF'
import json, sys, datetime
ledger, now, detail = sys.argv[1], sys.argv[2], sys.argv[3]
rows = []
try:
    rows = [json.loads(l) for l in open(ledger, encoding='utf8') if l.strip()]
except Exception:
    rows = []
if any(r.get('id','').startswith('cl-lint-') and r.get('status') in ('open','in-progress') for r in rows):
    print('[script-lint] 已有未关闭的语法告警, 跳过')
    sys.exit(0)
tz = datetime.timezone(datetime.timedelta(hours=8))
entry = {
    'id': 'cl-lint-' + datetime.datetime.now(tz).strftime('%Y%m%d-%H%M'),
    'ts': now,
    'claim': '工具脚本存在语法错误(dsh-script-lint 检出): ' + detail[:200],
    'source': 'dsh-script-lint.sh 自动汇报(cl-072)',
    'status': 'open',
    'reviewBy': (datetime.datetime.now(tz) + datetime.timedelta(days=1)).strftime('%Y-%m-%d'),
    'reviewBasis': '自动告警: 修复后本脚本下次运行自动关闭',
    'note': '自动入账: 语法错误会让脚本根本跑不起来, 且无法用脚本内断言自保。修复后重跑 dsh-script-lint.sh。',
}
with open(ledger, 'a', encoding='utf8') as f:
    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
print('[script-lint] 已写入言行账本:', entry['id'])
PYEOF
  exit 1
fi

echo "[script-lint] ✓ 全部脚本语法通过"
# 恢复: 关闭遗留语法告警
python3 - "$LEDGER" "$now" << 'PYEOF'
import json, sys
ledger, now = sys.argv[1], sys.argv[2]
try:
    rows = [json.loads(l) for l in open(ledger, encoding='utf8') if l.strip()]
except Exception:
    sys.exit(0)
changed = False
for r in rows:
    if r.get('id','').startswith('cl-lint-') and r.get('status') in ('open','in-progress'):
        r['status'] = 'done'
        r['doneAt'] = now
        r['doneNote'] = 'dsh-script-lint 复查通过, 自动关闭'
        changed = True
if changed:
    with open(ledger, 'w', encoding='utf8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    print('[script-lint] 已自动关闭遗留语法告警')
PYEOF
