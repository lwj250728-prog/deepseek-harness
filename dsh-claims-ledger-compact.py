#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-claims-ledger-compact.py — 言行账本压缩(把"历史"与"活的账"分开; cl-282)

为什么需要(cl-282 实测): 账本 739 行 / 844 KB / 330 个存活 id(平均 **2.2 行/id**), 今日新增 **170 行**;
解析+last-wins 严格线性(实测 739 行 0.020s/+1MB、7 390 行 0.096s/+15MB、22 170 行 0.312s/+33MB)⇒ 按今日速率
一年约 **6.3 万行 / 44 MB / 单次全量 ~0.9s / 峰值 +90MB**, 而它被 16 个脚本读、套件内读 21 处、cron 每 20~30
分钟各有一读者。增长来自**历史行**, 不来自存活条目 —— 所以压缩的目标不是"删证据", 而是把被取代的历史行
挪到归档文件(只追加、不被判据读)。

**不变量(本工具的核心承诺)**: 压缩前后 **last-wins 视图必须逐字节相同** —— 因为所有读者都是按 last-wins
读的, 只要每个 id 的**最新行**原样保留在原地, 读数就不可能变。工具自己会做这个校验, 不通过就**拒绝写入**。

用法:
  dsh-claims-ledger-compact.py [--retention-days 7] [--dry-run|--write] [--archive P] [--json]
退出码: 0 成功/无变化; 2 校验不过(拒绝写入); 3 读不到账本。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import sys

DEFAULT_LEDGER = os.path.expanduser('~/.dsh/cognitive-pipeline/claims-ledger.jsonl')


def load(path: str):
    rows, order = [], []
    for line in open(path, encoding="utf8"):
        if line.strip():
            r = json.loads(line)
            rows.append(r)
            if r.get("id"):
                order.append(str(r["id"]))
    return rows


def last_wins(rows):
    out = {}
    for r in rows:
        if r.get("id"):
            out[str(r["id"])] = r
    return out


def ts_of(row: dict) -> float | None:
    for f in ("ts", "createdTs", "tsBackfilled", "doneAt"):
        v = row.get(f)
        if isinstance(v, str) and v:
            try:
                return datetime.datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
            except Exception:  # noqa: BLE001
                continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=DEFAULT_LEDGER)
    ap.add_argument("--retention-days", type=float, default=7.0)
    ap.add_argument("--archive", default=None)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(args.ledger):
        print("[compact] 读不到账本: %s" % args.ledger, file=sys.stderr)
        return 3
    rows = load(args.ledger)
    current = last_wins(rows)
    latest_index = {}
    for i, r in enumerate(rows):
        if r.get("id"):
            latest_index[str(r["id"])] = i          # 最后一次出现的位置
    cutoff = datetime.datetime.now().timestamp() - args.retention_days * 86400
    keep, moved = [], []
    for i, r in enumerate(rows):
        ident = str(r.get("id") or "")
        superseded = ident and latest_index.get(ident) != i
        old = (ts_of(r) or 0) < cutoff
        if superseded and old:
            moved.append(r)
        else:
            keep.append(r)
    # **不变量校验**: last-wins 视图必须逐字节相同
    before = json.dumps(current, ensure_ascii=False, sort_keys=True)
    after = json.dumps(last_wins(keep), ensure_ascii=False, sort_keys=True)
    ok = before == after
    payload = {"rowsBefore": len(rows), "rowsAfter": len(keep), "archived": len(moved),
               "bytesBefore": os.path.getsize(args.ledger), "lastWinsUnchanged": ok,
               "retentionDays": args.retention_days}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
    if not ok:
        print("[compact] 拒绝写入: last-wins 视图会变(压缩会改读数) —— 这是不该发生的事, 请查 keep/moved 判定",
              file=sys.stderr)
        return 2
    if not moved:
        if not args.json:
            print("[compact] 无可压缩: 账本 %d 行, 全部要么是最新行、要么在保留窗口内(%g 天内)"
                  % (len(rows), args.retention_days))
        return 0
    archive = args.archive or os.path.join(os.path.dirname(args.ledger),
                                           "claims-ledger-archive-%s.jsonl" % datetime.datetime.now().strftime("%Y%m"))
    if not args.write:
        print("[dry-run] 将归档 %d 行(> %g 天且已被取代)到 %s; 账本 %d → %d 行; last-wins 校验通过"
              % (len(moved), args.retention_days, archive, len(rows), len(keep)))
        return 0
    shutil.copy(args.ledger, args.ledger + ".bak-precompact-%s" % datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    with open(archive, "a", encoding="utf8") as fh:
        for r in moved:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    tmp = args.ledger + ".tmp-compact"
    with open(tmp, "w", encoding="utf8") as fh:
        for r in keep:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, args.ledger)            # 原子替换(与 7a61e1d 同一条纪律)
    print("[compact] 已归档 %d 行 → %s; 账本 %d → %d 行(last-wins 校验通过)"
          % (len(moved), archive, len(rows), len(keep)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
