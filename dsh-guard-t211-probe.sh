#!/usr/bin/env bash
# dsh-guard-t211-probe.sh — T211「引用率消费方必须声明时代」的开火探针
# 语义: 把代表消费方**变异**成"不读时代"(回退到跨时代出数), 再用**同一条断言**审它 ⇒ 必须转红。
#   为此 T211 的断言接受 `DSH_ADOPTION_STATS` 注入点(默认指真脚本)。
#   exit 1 = FIRED / exit 4 = 漂移 / exit 3 = 探针自身失效
set -uo pipefail
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'MK' || exit 3
import os, sys
T = sys.argv[1]
src = open(os.path.expanduser("~/dsh-fork/dsh-adoption-stats.py"), encoding="utf8").read()
# 变异必须落在**读取**上, 而不是失败分支上(第一版只改失败分支 ⇒ 读取照常成功、变异根本没生效,
# 探针把"没测到"报成了漂移; 与 T201 第一版同型): 时代路径指向不存在的文件 + 不再拒绝出数。
a = "era_path = os.path.join(os.environ.get('DSH_COG_DIR') or DIR, 'citation-era.json')"
b = "era_path = '/nonexistent/citation-era.json'   # 变异: 从不读时代"
c = ("        print('缺时代: 读不到/解析不了 citation-era.json(%s) ⇒ 拒绝出数(跨时代平均会把\"信号不存在\"读成\"经验没用\")' % exc,\n"
     "              file=sys.stderr)\n        return 1")
d = "        era_since = ''\n        era_ms = 0   # 变异: 不拒绝出数"
assert src.count(a) == 1 and src.count(c) == 1, "结构变了(探针自身失效)"
mut = src.replace(a, b).replace(c, d)
open(os.path.join(T, "mutant-adoption-stats.py"), "w", encoding="utf8").write(mut)
MK
if DSH_ADOPTION_STATS="$TMP/mutant-adoption-stats.py" python3 /home/ubuntu/dsh-fork/dsh-assert-runner.py --name "引用率消费方: 缺时代拒绝出数, 且不得有脚本既未接时代又未挂账" >/dev/null 2>&1; then
  echo "不读时代的变异消费方被判绿 —— 跨时代平均又回来了" >&2
  exit 4
fi
echo "[guard-fire] FIRED T211: 不读时代的变异消费方被同一条断言判红" >&2
exit 1
