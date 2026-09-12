#!/usr/bin/env bash
# dsh-guard-t205-probe.sh — T205「冻结基线必须与同口径一致」的开火探针
# 语义: 把基线按**旧口径**(分母用窗口全长 24h 而非时代覆盖 4.57h)改写一份, 判据必须判红。
#   这正是 2026-09-12 11:1x 实测到的偏差(基线被低估 5.2 倍 ⇒ ratio 放大 ⇒ 偏向判 causal)。
#   exit 1 = FIRED(判据能抓住口径错误的基线)
#   exit 4 = 漂移(错口径的基线被判绿 ⇒ 守卫是死的)
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
D = os.path.expanduser("~/.dsh/cognitive-pipeline")
b = json.load(open(os.path.join(D, "wake-intervention-baseline.json"), encoding="utf8"))
cov = b["rates"]["goal-experience-library"].get("coverageHours") or 4.57
k = 24.0 / cov                      # 旧口径 = 除以窗口全长 24h ⇒ 数字缩小 k 倍
for gid, rec in (b.get("rates") or {}).items():
    if isinstance(rec, dict) and rec.get("perHour"):
        rec["perHour"] = round(rec["perHour"] / k, 4)
json.dump(b, open(os.path.join(T, "baseline-old-caliber.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
if python3 /home/ubuntu/dsh-fork/dsh-baseline-caliber-check.py --baseline "$TMP/baseline-old-caliber.json" >/dev/null 2>&1; then
  echo "错口径(旧口径=窗口全长作分母)的基线被判绿了 —— 偏差会原样回到判读里" >&2
  exit 4
fi
echo "[guard-fire] FIRED T205: 旧口径基线(缩小 $(python3 -c "print('%g' % (24/4.57))") 倍)被判红" >&2
exit 1
