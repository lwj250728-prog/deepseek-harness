#!/usr/bin/env bash
# dsh-guard-t237-probe.sh — T237「改动覆盖(行为)」的开火探针(**双臂**)
# 变异臂: 把冻结基线清空(`failingSpecs: []`, 备份后改、跑完复原并按哈希核验) ⇒ 那两个**已知**失败会被当成
#   "新破损" ⇒ T237 必须判红。这证明判据对"基线错/失效"有区分力(基线是它的输入, 输入坏了它必须喊)。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T237 必须判绿。
set -uo pipefail
NAME="改动覆盖(行为): 改动过的包必须跑过 spec——新破损才红, 存量债与零 spec 包冻结"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
BASE="$HOME/.dsh/cognitive-pipeline/change-coverage-baseline.json"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T237 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$BASE" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
trap 'cp -p "$BAK" "$BASE"; rm -f "$BAK"' EXIT
python3 - "$BASE" <<'MK' || exit 3
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding="utf8"))
d["failingSpecs"] = []          # MUTANT: 冻结基线失效
with open(p, "w", encoding="utf8") as fh:
    json.dump(d, fh, ensure_ascii=False, indent=1)
MK
if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "基线清空后判据仍判绿 —— 存量失败会被当成新破损却无人喊" >&2
  exit 4
fi
cp -p "$BAK" "$BASE"
[ "$(sha256sum "$BASE" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败(哈希不符)" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
echo "[guard-fire] FIRED T237: 冻结基线失效(存量失败被当成新破损)被判据抓住" >&2
exit 1
