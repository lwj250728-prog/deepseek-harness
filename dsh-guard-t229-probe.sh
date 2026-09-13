#!/usr/bin/env bash
# dsh-guard-t229-probe.sh — T229「δ 门: 基线之后新增的 lib 必须可见, 且三处 CWD 判决逐字一致」的开火探针(**双臂**)
#
# tp-198 要求的三条: ①键洞(基线之后新增的 lib 对门不可见) ②CWD(相对键按调用方 CWD 解析 ⇒ 换目录判决就变)
# ③变异 `resolve_lib_key` 退回 `os.path.expanduser` ⇒ CWD 那条必须转红。本探针再加一条"假阳性"变异:
# 把"内容变了的才算变更"改成"一律都报" ⇒ 第③条(未变更的键不许被算作变更)必须转红 —— 否则"全报"
# 这种假修复也能通过 ①②。
#
#   exit 1 = FIRED(每个变异臂都被判据抓住) / exit 4 = 漂移(某臂变异后判据仍绿) /
#   exit 3 = 探针自身失效(找不到待变异的行/变异没落盘/还原后仍有残留) / exit 0 = 干净臂
set -uo pipefail
NAME="δ 门: 基线之后新增的 lib 必须可见, 且三处 CWD 判决逐字一致"
RUNNER="$HOME/dsh-fork/dsh-assert-runner.py"
SRC="$HOME/dsh-fork/dsh-wait-check-diversity-arm.py"

judge() { python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; }

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if judge; then
    echo "[guard-fire] T229 干净臂: 未变异时判绿(应然)" >&2
    exit 0
  fi
  echo "干净臂: 未变异时就判红 —— 判据对变异无区分力" >&2
  exit 3
fi

BAK=$(mktemp); cp "$SRC" "$BAK" || exit 3
# 备份活到 EXIT 才删(初版在 restore 里顺手 rm 备份 ⇒ 第二次还原 cp 失败、变异被带出探针)。
restore() { cp "$BAK" "$SRC"; }
cleanup() { restore; rm -f "$BAK"; }
trap cleanup EXIT

mutate() {
python3 - "$1" <<'MK' || exit 3
import os, sys
mid = sys.argv[1]
path = os.path.expanduser("~/dsh-fork/dsh-wait-check-diversity-arm.py")
M = {
  "A": ("        for path in current_lib_keys():",
        "        for path in []:  # MUTANT-A 基线之后新增的 lib 不可见"),
  "B": ("    return p if os.path.isabs(p) else os.path.join(REPO, p)",
        "    return p  # MUTANT-B 退回按调用方 CWD 解析"),
  "C": ("        if cur != want:",
        "        if True:  # MUTANT-C 未变的键也被算作变更"),
}
old, new = M[mid]
s = open(path, encoding="utf8").read()
assert s.count(old) == 1, "找不到待变异的行(" + mid + "): 结构变了, 探针自身失效"
open(path, "w", encoding="utf8").write(s.replace(old, new, 1))
assert "MUTANT-" + mid in open(path, encoding="utf8").read(), "变异没落盘"
print("mutated " + mid + " in " + os.path.basename(path))
MK
}

DRIFT=""
for M in A B C; do
  mutate "$M" || exit 3
  if judge; then
    DRIFT="$DRIFT $M"
  fi
  restore
  if grep -q "MUTANT-" "$SRC"; then
    echo "还原失败: 变异残留在门里 ⇒ 探针污染了世界" >&2
    exit 3
  fi
done

if [ -n "$DRIFT" ]; then
  echo "变异臂$DRIFT 之后判据仍判绿 —— 键洞/CWD 依赖/假阳性可以静默回来而没人抓" >&2
  exit 4
fi
echo "[guard-fire] FIRED T229: 三处变异(新增不可见/CWD 解析/未变也报)全部被判据抓住" >&2
exit 1
