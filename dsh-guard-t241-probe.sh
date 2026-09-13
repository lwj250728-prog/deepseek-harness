#!/usr/bin/env bash
# dsh-guard-t241-probe.sh — T241「债基线棘轮」的开火探针(**双臂**)
# 变异臂: ①把棘轮变成空操作(`write_atomic(path, data)` 那行短路) ②并**人工造出松弛**(noSpecCount = 现值+1, 备份后改)
#   ⇒ 没有棘轮 ⇒ check 判红 ⇒ T241 必须红。两处都在 finally 里按哈希复原。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T241 必须判绿。
set -uo pipefail
NAME="债基线必须棘轮: 现实好于基线须写回, 差于须红, 且全部基线有分类与理由"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-debt-baseline-ratchet.py"
BASE="$HOME/.dsh/cognitive-pipeline/change-coverage-baseline.json"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T241 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
BASESUM=$(sha256sum "$BASE" | cut -d' ' -f1)
BASEEK=$(mktemp); cp -p "$BASE" "$BASEEK"
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
trap 'cp -p "$BAK" "$SRC"; cp -p "$BASEEK" "$BASE"; rm -f "$BAK" "$BASEEK"' EXIT
python3 - "$SRC" "$BASE" <<'MK' || exit 3
import json, sys
src, base = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf8").read()
old = """                    write_atomic(path, data)
                    acts.append"""
new = """                    pass  # MUTANT: 棘轮变空操作(不写回)
                    acts.append"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(src, "w", encoding="utf8").write(s.replace(old, new))
d = json.load(open(base, encoding="utf8"))
d["noSpecCount"] = int(d.get("noSpecCount") or 0) + 1     # 人工造松弛: 基线比现实松
with open(base, "w", encoding="utf8") as fh:
    json.dump(d, fh, ensure_ascii=False, indent=1)
MK
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
cp -p "$BAK" "$SRC"; cp -p "$BASEEK" "$BASE"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "探针脚本复原失败" >&2; exit 3; }
[ "$(sha256sum "$BASE" | cut -d' ' -f1)" = "$BASESUM" ] || { echo "基线复原失败" >&2; exit 3; }
trap - EXIT; rm -f "$BAK" "$BASEEK"
if [ "$rc" -eq 0 ]; then
  echo "棘轮空操作 + 基线松弛后判据仍判绿 —— 改善没被锁住这件事不会被抓" >&2
  exit 4
fi
if [ "$rc" -eq 3 ]; then
  echo "变异臂拿到 exit 3(前提不成立/取不到断言) ⇒ 探针自身失效, 不算开火" >&2
  exit 3
fi
echo "[guard-fire] FIRED T241: 棘轮空操作(基线比现实松却不写回)被判据抓住" >&2
exit 1
