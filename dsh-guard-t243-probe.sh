#!/usr/bin/env bash
# dsh-guard-t243-probe.sh — T243「子目标申请联锁」的开火探针(**双臂**)
# 变异臂: 往套件里**植入一条未被任何 accepted 申请提到的判据**(echo "[T999] …") ⇒ 联锁必须判红。
# 干净臂(DSH_PROBE_CLEAN=1): 不植入 ⇒ T243 必须判绿。
set -uo pipefail
NAME="子目标必须先向目标孵化池申请: 新判据必须在 accepted 申请里被提到(存量冻结)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
SRC="$HOME/dsh-fork/dsh-cog-tests.sh"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "[guard-fire] T243 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp -p "$SRC" "$BAK" || exit 3
SUM=$(sha256sum "$BAK" | cut -d' ' -f1)
trap 'cp -p "$BAK" "$SRC"; rm -f "$BAK"' EXIT
printf '\necho "[T999] 未申请的判据(探针植入)"   # MUTANT: 未经申请的判据\n' >> "$SRC"
grep -q 'T999' "$SRC" || { echo "植入没落盘" >&2; exit 3; }
python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; rc=$?
cp -p "$BAK" "$SRC"
[ "$(sha256sum "$SRC" | cut -d' ' -f1)" = "$SUM" ] || { echo "套件复原失败" >&2; exit 3; }
trap - EXIT; rm -f "$BAK"
if [ "$rc" -eq 0 ]; then
  echo "植入未申请判据后联锁仍判绿 —— 子目标可以绕过申请" >&2
  exit 4
fi
if [ "$rc" -eq 3 ]; then
  echo "变异臂拿到 exit 3 ⇒ 探针自身失效, 不算开火" >&2
  exit 3
fi
echo "[guard-fire] FIRED T243: 未经申请的判据被联锁抓住" >&2
exit 1
