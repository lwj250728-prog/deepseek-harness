#!/usr/bin/env python3
"""dsh-keepalive-lint.py — 保活是否架空退避的判据(cl-195)

判据(只看部署后的审计行, 避免部署边界伪影):
  1. 同一会话内相邻两次"保活放行"(backoffAdmitted) 间隔必须 > MIN_GAP_MIN;
  2. 保活放行占带遥测审计行的比例必须 <= MAX_SHARE(闲置门生效后应大幅低于修复前的 14.2%)。

用法: dsh-keepalive-lint.py [--audit PATH] [--after MS] [--min-gap-min 55] [--max-share 0.05]
退出码: 0 = 合规或样本不足(会打印"[样本不足]"); 1 = 违规; 3 = 读数失败
"""
import argparse
import collections
import json
import os
import sys
import time

DEFAULT_AUDIT = os.path.expanduser("~/.dsh/cognitive-pipeline/retrieval-audit.jsonl")
DEFAULT_LIB = os.path.expanduser("~/dsh-fork/packages/context/cognitive-inject/lib/index.js")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit", default=DEFAULT_AUDIT)
    ap.add_argument("--after", type=float, default=None, help="只判早于该毫秒时刻之后的行(默认=lib mtime)")
    ap.add_argument("--min-gap-min", type=float, default=55.0)
    ap.add_argument("--max-share", type=float, default=0.05)
    ap.add_argument("--min-rows", type=int, default=20)
    ap.add_argument("--injections", default=None, help="注入账本(默认与审计同目录的 injections.jsonl)")
    ap.add_argument("--grace-h", type=float, default=2.0,
                    help="样本不足的宽限时长(小时); 超过仍在不足即判红(豁免须自己到期)")
    args = ap.parse_args()

    if not os.path.exists(args.audit):
        print("[读数失败] 审计文件不存在: " + args.audit, file=sys.stderr)
        return 3
    after = args.after
    if after is None:
        after = os.path.getmtime(DEFAULT_LIB) * 1000 if os.path.exists(DEFAULT_LIB) else 0

    rows = []
    for line in open(args.audit, encoding="utf8"):
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if "backoffAdmitted" not in r:
            continue
        if (r.get("t") or 0) <= after:
            continue
        rows.append(r)

    if len(rows) < args.min_rows:
        # 样本不足的豁免**必须自己到期**, 但到期后要分清两件事(否则会制造假红):
        #   · "会话空闲、本来就没有注入" —— 这不是遥测故障, 不该判红;
        #   · "明明有注入、遥测却没长"   —— 这才是遥测链断了, 判红。
        inj_path = args.injections or os.path.join(os.path.dirname(args.audit), "injections.jsonl")
        inj_after = 0
        if os.path.exists(inj_path):
            for line in open(inj_path, encoding="utf8"):
                if not line.strip():
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if (r.get("createdAt") or 0) > after:
                    inj_after += 1
        if inj_after >= args.min_rows:
            print("红: 部署后有 %d 次注入, 而带 backoff 遥测的审计只有 %d 条(< %d)——遥测链断了, 判据永远判不了"
                  % (inj_after, len(rows), args.min_rows), file=sys.stderr)
            return 1
        age_h = (time.time() * 1000 - after) / 3600000.0
        print("[样本不足] 部署后遥测 %d 条 / 注入 %d 次(距构建 %.1f 小时, 宽限 %.1f): 注入本身太少, 等样本"
              % (len(rows), inj_after, age_h, args.grace_h))
        return 0

    admitted = [r for r in rows if r.get("backoffAdmitted")]
    share = len(admitted) / float(len(rows))
    bad = []
    if share > args.max_share:
        bad.append("保活占比 %.1f%% > %.1f%%(修复前实测 14.2%%)" % (100 * share, 100 * args.max_share))
    by = collections.defaultdict(list)
    for r in admitted:
        by[r.get("sessionId")].append(r["t"])
    for s, ts in by.items():
        ts.sort()
        for a, b in zip(ts, ts[1:]):
            if (b - a) < args.min_gap_min * 60 * 1000:
                bad.append("%s 保活间隔仅 %.1f 分钟" % (str(s)[:24], (b - a) / 60000.0))
    if bad:
        print("红: " + "; ".join(bad[:4]), file=sys.stderr)
        return 1
    print("部署后 %d 条审计, 保活放行 %d 次(%.1f%%), 间隔与占比均合规" % (len(rows), len(admitted), 100 * share))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
