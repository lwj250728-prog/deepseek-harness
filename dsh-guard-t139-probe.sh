#!/usr/bin/env bash
# dsh-guard-t139-probe.sh — T139「裁决行须落盘且新鲜」的开火探针(cl-175)
#
# 语义：在临时日志里放一条**3 天前**的裁决行，沿用 T139(b) 的判据跑一遍，期望它开火(exit 1)。
# 约定：exit 1 = 守卫开火(判据抓到违规)；其余非零 = 探针自身坏了(必须区分开——
# 第一版探针就是因为正则里把中文写成了 \u 转义而 IndexError 退出 1，看着"开火了"，其实什么都没测)。
set -uo pipefail
LOG=/tmp/t139-fire2.log

python3 - "$LOG" <<'PY'
import sys, datetime
ts = (datetime.datetime.now() - datetime.timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S")
with open(sys.argv[1], "w", encoding="utf8") as f:
    f.write("═══ 累计裁决: 1 通过 / 0 失败 (origin=fireprobe %s) ═══\n" % ts)
PY

DSH_COG_LOG="$LOG" python3 -c '
import os, re, time
log = os.environ["DSH_COG_LOG"]
txt = open(log, encoding="utf8").read()
hits = re.findall(r"累计裁决:.*?\(origin=(\S+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)", txt)
if not hits:
    print("探针自检失败: 陈旧裁决行没被正则认出(坏的是探针, 不是守卫)", flush=True)
    raise SystemExit(3)
age = time.time() - time.mktime(time.strptime(hits[-1][1], "%Y-%m-%d %H:%M:%S"))
assert age < 86400, "陈旧裁决行未被判为不新鲜(age=%.1fh)" % (age / 3600.0)
'
