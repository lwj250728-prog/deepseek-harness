#!/usr/bin/env bash
# dsh-guard-t224-probe.sh — T224「时代声明必须绑定采集代码指纹」的开火探针(**双臂**)
# 语义(证伪信号要求的那一刀): 把**引用契约文本改一个字符**(expId → expID), 指向改过的副本
#       (DSH_FP_INJECT_SRC, 不碰真源码) ⇒ 指纹变 ⇒ 判据必须判红。
# 干净臂(DSH_PROBE_CLEAN=1)另验两条: ①真源码判绿; ②era 里**缺指纹**时也必须判红(不许"没声明就默认通过")。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效 / exit 0 = 干净臂
set -uo pipefail
NAME="时代声明必须绑定采集代码指纹(三块片段; 不符即红)"
RUNNER=/home/ubuntu/dsh-fork/dsh-assert-runner.py
COG="${DSH_COG_DIR:-$HOME/.dsh/cognitive-pipeline}"
SRC="$HOME/dsh-fork/packages/context/cognitive-inject/src/index.ts"

if [ "${DSH_PROBE_CLEAN:-}" = "1" ]; then
  if ! python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "干净臂: 真源码被判红(判据在原件上就红, 对变异无区分力)" >&2
    exit 3
  fi
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  python3 - "$T" "$COG" <<'MK' || exit 3
import json, os, shutil, sys
T, COG = sys.argv[1], sys.argv[2]
era = json.load(open(os.path.join(COG, "citation-era.json"), encoding="utf8"))
era.pop("collectionFingerprint", None)          # 合成: 声明里没有指纹
json.dump(era, open(os.path.join(T, "citation-era.json"), "w", encoding="utf8"), ensure_ascii=False)
MK
  if DSH_COG_DIR="$T" python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
    echo "干净臂: era 缺指纹时仍判绿 ⇒ '没绑定的声明'被默认放行(那正是本条要防的)" >&2
    exit 3
  fi
  echo "[guard-fire] T224 干净臂: 真源码判绿; era 缺指纹时判红(应然)" >&2
  exit 0
fi

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp "$SRC" "$T/mutant.ts" || { echo "取不到源码, 探针自身失效" >&2; exit 3; }
python3 - "$T/mutant.ts" <<'MK' || exit 3
import sys
p = sys.argv[1]
s = open(p, encoding="utf8").read()
old = "（引用契约：若本轮确实采用了其中某条经验，请在回复中写出它的 expId——"
new = "（引用契约：若本轮确实采用了其中某条经验，请在回复中写出它的 expID——"
assert s.count(old) == 1, "找不到契约文本(结构变了, 探针自身失效)"
open(p, "w", encoding="utf8").write(s.replace(old, new))
MK
if DSH_FP_INJECT_SRC="$T/mutant.ts" python3 "$RUNNER" --name "$NAME" >/dev/null 2>&1; then
  echo "改了契约文本一个字符后判据仍判绿 —— 时代声明没有绑定采集代码(本条失败)" >&2
  exit 4
fi
echo "[guard-fire] FIRED T224: 契约文本改一字 ⇒ 采集指纹不符 ⇒ 判据抓住" >&2
exit 1
