#!/usr/bin/env python3
"""dsh-wait-check-library.py — 经验库目标的"条件型等待"检查器(waitChecker 首个样本, cl-215)

语义(唤醒侧约定): **exit 0 = 条件已满足**(不再算等待, 唤醒应推行动帧); 非零 = 仍未满足。
条件: `dsh-library-replay.py` 输出里的**可排序集 >= minSample(30)**。
用法: dsh-wait-check-library.py [--json]
"""
import json
import os
import subprocess
import sys

REPO = os.path.expanduser("~/dsh-fork")
RESULT = os.path.expanduser("~/.dsh/cognitive-pipeline/library-replay-result.json")


def main() -> int:
    r = subprocess.run(["python3", os.path.join(REPO, "dsh-library-replay.py")],
                       cwd=REPO, capture_output=True, text=True, timeout=300)
    if r.returncode not in (0, 1):
        print("[wait-check] 无法跑 replay: " + r.stderr[-120:], file=sys.stderr)
        return 2
    try:
        d = json.load(open(RESULT, encoding="utf8"))
    except Exception as e:
        print("[wait-check] 读不到结果文件: %s" % e, file=sys.stderr)
        return 2
    n = int(d.get("rankableSets") or 0)
    need = int(d.get("minSample") or 30)
    if "--json" in sys.argv:
        print(json.dumps({"rankableSets": n, "minSample": need, "met": n >= need}, ensure_ascii=False))
    else:
        print("[wait-check] 可排序集 %d/%d ⇒ %s" % (n, need, "已满足" if n >= need else "仍未满足"))
    return 0 if n >= need else 1


if __name__ == "__main__":
    raise SystemExit(main())
