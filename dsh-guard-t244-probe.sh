#!/usr/bin/env bash
# dsh-guard-t244-probe.sh — T244「活跃度模型」的开火探针(**双臂**)
# 变异臂: 让**复习不参与计分**(`reh_w = sum(...)` → `reh_w = 0.0`) ⇒ "复习必须真的提升活跃度"这条不变式必红
#   (= 复现我今晚真实踩过的 no-op 缺陷: tanh 饱和 / ISO 时间戳没解析, 两次都让复习推不动分数)。
# 干净臂(DSH_PROBE_CLEAN=1): 不改 ⇒ T244 必须判绿。
set -uo pipefail
NAME="活跃度模型: 关联/孤立/复习三路可复算 + 复习必须真的提升活跃度"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-activity-model.py"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T244 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
trap 'cp -p "$BAK" "$SRC"; rm -f "$BAK"' EXIT
python3 - "$SRC" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = """    reh_w = sum(0.5 ** ((t - _ms(r.get("ts"))) / 86400.0 / HALFLIFE_DAYS) for r in reh.get(exp_id, []))"""
new = """    reh_w = 0.0  # MUTANT: 复习不参与计分(复习变成装饰)"""
assert s.count(old) == 1, "结构变了, 探针自身失效"
open(p, "w", encoding="utf8").write(s.replace(old, new))
assert "MUTANT: 复习不参与计分" in open(p, encoding="utf8").read(), "变异没落盘"
MK
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
cp -p "$BAK" "$SRC"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "复原失败" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
if [ "$rc" -eq 0 ]; then echo "复习不参与计分后判据仍判绿 —— 装饰性复习不会被抓" >&2; exit 4; fi
if [ "$rc" -eq 3 ]; then echo "变异臂拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2; exit 3; fi
echo "[guard-fire] FIRED T244: 复习不参与计分(装饰性复习)被判据抓住" >&2
exit 1
