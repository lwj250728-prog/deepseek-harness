#!/usr/bin/env bash
# dsh-chain-readiness-record.sh — 把一次链就绪读数落成滚动数据的一行(cl-367)
#
# 为什么单独一个脚本: 套件里内联它需要三层引号(bash→python→JSON), 我第一次就写坏了套件语法。
# 职责: ①跑一次 --record; ②核对真实读数列确实有行; ③打印摘要(供套件日志留痕)。
# 退出码: 0 = 已记录且有行; 1 = 记录后仍无行(接线没生效)。
set -uo pipefail
R="${DSH_REPO:-$HOME/dsh-fork}"
LEDGER="${DSH_CHAIN_READINESS_LEDGER:-$HOME/.dsh/cognitive-pipeline/chain-readiness.jsonl}"
python3 "$R/dsh-chain-readiness.py" --record --json >/dev/null 2>&1 || true
python3 - "$LEDGER" <<'PY'
import json, os, sys
path = sys.argv[1]
rows = [json.loads(x) for x in open(path, encoding='utf8') if x.strip()] if os.path.exists(path) else []
if not rows:
    print('[record] 就绪读数列仍为空 ⇒ 留痕没落地: %s' % path, file=sys.stderr)
    sys.exit(1)
last = rows[-1]
print('[record] 就绪读数 %d 行 | 末行 state=%s | 待加载 %d 个包 | ts=%s'
      % (len(rows), last.get('state'), len(last.get('pending') or []), str(last.get('ts'))[:19]))
PY
