#!/usr/bin/env bash
# dsh-guard-t209-probe.sh — T209「开火声明不许是装饰」的开火探针
# 语义: 造一份**含新增纯文本声明**的登记册(不在冻结清单里、也没有 exempt 理由), 判据必须判红。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import json, os, sys
T = sys.argv[1]
reg = {"guards": [
    {"guard": "T900", "mustFire": [{"assertion": "旧条目(冻结)", "note": "x"}]},
    {"guard": "T901", "mustFire": [{"assertion": "新条目(装饰性, 无命令无豁免)", "note": "我声称能开火"}]},
]}
reg["textOnlyBaseline"] = {"entries": [{"guard": "T900", "assertion": "旧条目(冻结)"}]}
json.dump(reg, open(os.path.join(T, "guard-fire.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
MK
if DSH_GUARD_FIRE="$TMP/guard-fire.json" python3 -c '
import json, os
reg = json.load(open(os.environ["DSH_GUARD_FIRE"], encoding="utf8"))
base = reg.get("textOnlyBaseline") or {}
frozen = {(e["guard"], e["assertion"]) for e in (base.get("entries") or [])}
assert frozen, "没有冻结基线"
new_decorative, still = [], set()
for g in reg["guards"]:
    for f in (g.get("mustFire") or []):
        if f.get("command"): continue
        key = (g["guard"], f.get("assertion"))
        if str(f.get("exempt") or "").strip(): continue
        if key in frozen:
            still.add(key); continue
        new_decorative.append("%s/%s" % key)
assert not new_decorative, ("新增的纯文本开火声明(不可执行=没被证明过): %s" % new_decorative[:5])
' 2>/dev/null; then
  echo "新增的纯文本开火声明被判绿了 —— 登记册可以继续堆'我声称能开火'" >&2
  exit 4
fi
echo "[guard-fire] FIRED T209: 新增装饰性声明被判红" >&2
exit 1
