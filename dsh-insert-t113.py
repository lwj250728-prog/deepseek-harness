#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""插入 T113: 采纳 A/B 对照的窗口/口径/判据守卫(cl-134)。"""
import io, os, sys

P = os.path.expanduser('~/dsh-fork/dsh-cog-tests.sh')
ANCHOR = 'echo "═══ 结果: $PASS 通过 / $FAIL 失败 ═══"'

BLOCK = r'''# ── T113 采纳 A/B 对照的窗口/口径/判据守卫(cl-134: 主判据此前在对照里缺席) ──
# 今天连踩三坑, 全部落在这条链上:
#   ①主判据(不同经验数+采纳率不降+绝对采纳数不降)在 A/B 里缺席, 采纳侧要人肉另跑脚本;
#   ②子窗口运行(--since/--until)覆盖了唯一口径的落盘快照, 下游把它当水位 => 整张表错位;
#   ③"口径变更时刻"取了 commit author time(04:57 提交)而非生效时刻(15:50 部署)
#     => 后窗被切成 [14:07, 04:57) 空集却照样出数;
#   ④判据字段只在打印分支里算, --quiet 消费者读到 null("判据只长在显示路径上")。
# 本组断言把这四类固化为守卫。
echo "[T113] 采纳对照(快照不被子窗口改写 / 口径取自账本 / 前窗非空 / 判据落盘)"
t "子窗口运行不得改写规范快照" python3 -c '
import json, os, subprocess, sys, hashlib
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
snap = os.path.join(DIR, "adoption-stats.json")
script = os.path.expanduser("~/dsh-fork/dsh-adoption-stats.py")
assert os.path.exists(snap), "规范快照不存在, 断言前提不成立"
before = hashlib.sha256(open(snap, "rb").read()).hexdigest()
w0 = json.load(open(snap, encoding="utf8")).get("windowStart")
# 用最贴近真实用法的子窗口调用(后窗): 修复前正是这种调用覆盖了快照。
r = subprocess.run([sys.executable, script, "--since", "2026-09-10T14:07:00", "--json"],
                   capture_output=True, text=True, timeout=300)
assert r.returncode == 0, "子窗口调用失败: %s" % (r.stderr or "")[:200]
after = hashlib.sha256(open(snap, "rb").read()).hexdigest()
assert before == after, "子窗口运行改写了规范快照(windowStart %s => %s)" % (
    w0, json.load(open(snap, encoding="utf8")).get("windowStart"))
print("快照未被改写(windowStart=%s)" % w0)
'
t "口径变更时刻必须取自账本事实时间" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
adopt = (ab.get("adoption") or {})
got = adopt.get("settlementLensChangedAt")
ledger = None
for line in open(os.path.join(DIR, "ab-confounders.jsonl"), encoding="utf8"):
    if not line.strip():
        continue
    row = json.loads(line)
    if row.get("kind") == "settlement-fix":
        ledger = row.get("ts")
assert ledger, "账本里没有 settlement-fix 记录, 断言前提不成立"
import datetime
norm = lambda s: datetime.datetime.fromisoformat(s).replace(microsecond=0).isoformat()
assert got and norm(got) == norm(ledger), "口径时刻与账本不符: 对照=%s 账本=%s" % (got, ledger)
print("口径时刻与账本一致: %s" % ledger)
'
t "前窗不得为空(窗口错位必须显式失败)" python3 -c '
import json, os
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
segs = ((ab.get("adoption") or {}).get("segments") or {})
before = segs.get("before")
assert before is not None, "对照里没有前窗, 断言前提不成立"
assert (before.get("injected") or 0) > 0, (
    "前窗注入为 0 => 窗口错位(如把提交时刻当口径时刻), 这种对照不得出数")
assert (before.get("hours") or 0) > 0, "前窗时长为非正数: %s" % before.get("hours")
print("前窗非空: %s 注入 / %sh" % (before.get("injected"), before.get("hours")))
'
t "判据字段必须在 --quiet 下也落盘" python3 -c '
import json, os, subprocess, sys
DIR = os.path.expanduser("~/.dsh/cognitive-pipeline")
r = subprocess.run([sys.executable, os.path.expanduser("~/dsh-fork/dsh-ab-compare.py"), "--quiet"],
                   capture_output=True, text=True, timeout=600)
assert r.returncode == 0, "ab-compare --quiet 失败: %s" % (r.stderr or "")[:200]
ab = json.load(open(os.path.join(DIR, "ab-compare.json"), encoding="utf8"))
av = ab.get("adoptionVerdict")
assert isinstance(av, dict), "quiet 模式下 adoptionVerdict 缺失(判据只长在显示路径上)"
for key in ("enoughSample", "sampleNote", "rollbackIf"):
    assert av.get(key) is not None, "quiet 模式下 adoptionVerdict.%s 为 null" % key
assert ab.get("adoption", {}).get("afterUnion"), "quiet 模式下后窗合体缺失"
print("quiet 模式判据完整: 样本%s 方向%s" % (av.get("enoughSample"), av.get("direction")))
'

'''

def main():
    src = io.open(P, encoding='utf8').read()
    if 'T113 采纳 A/B 对照' in src:
        print('T113 已存在')
        return 0
    if src.count(ANCHOR) != 1:
        print('锚点 %d 次, 拒绝插入' % src.count(ANCHOR)); return 1
    io.open(P, 'w', encoding='utf8').write(src.replace(ANCHOR, BLOCK + ANCHOR))
    print('T113 已插入(4 断言)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
