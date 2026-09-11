#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-claims-ledger-heal.py — 言行账本的写入侧自愈(cl-055)。

起因(cl-055, 2026-09-09): T33 落地后 **21 分钟内**就抓到并发会话新增的 in-progress 项缺 reviewBy ——
说明约束只存在于**审计侧**, 写入路径仍可产出无 reviewBy 的 open 项(与 cl-030「修复须落在写入路径」
同型)。而"审计红 + 人工补"这条路本身有自锁风险: 账本里任何一条缺 reviewBy 的 open 项都会让 T33 转红,
红了又不会有任何东西去修它(实测 T33 就这样红了两天)。

本脚本把"补 reviewBy"从人工动作变成**机制**:
  ① 读账本(last-wins: 同一 id 只认末行 —— 账本是只追加的);
  ② 找 status ∈ {open, in-progress} 且 reviewBy 为空/缺失的项;
  ③ 只追加**一行修正副本**(不原地改写文件: 与全库 last-wins 纪律一致, 也保留"曾被写入方漏写"的痕迹),
     reviewBy = 今天 + 默认窗口(3 天), 并标注 `reviewByAuto: true` / `reviewByAutoAt` /
     `reviewByAutoNote` —— 自愈必须留痕, 否则日后无从区分"声明的复核窗口"与"系统补的";
  ④ 只报告不改判: 自愈不改 status、不改 claim、不关单。

用法: dsh-claims-ledger-heal.py [--dry-run] [--window-days N] [--ledger PATH] [--log PATH]
退出码: 0 正常(含无事可做); 2 账本不可读; 3 套件在跑(本轮跳过, 避免与判据读同一份账本, cl-243)。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

DIR = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
LEDGER_DEFAULT = os.path.join(DIR, 'claims-ledger.jsonl')
LOG_DEFAULT = os.path.join(DIR, 'claims-ledger-heal.log')
TERMINAL = {'done', 'retired', 'closed'}
HEAL_STATUSES = {'open', 'in-progress'}
DEFAULT_WINDOW_DAYS = 3


def now_iso() -> str:
    return datetime.datetime.now().astimezone().isoformat()


def today_plus(days: int) -> str:
    return (datetime.datetime.now().astimezone() + datetime.timedelta(days=days)).strftime('%Y-%m-%d')


def suite_running() -> bool:
    """套件在跑时不动账本: 它有好几条断言正在读同一份文件(cl-243: 并发写会把读数搞成伪影)。"""
    try:
        r = subprocess.run(['pgrep', '-f', 'dsh-cog-tests.sh'], capture_output=True, text=True, timeout=30)
    except Exception:
        return False
    return r.returncode == 0


def read_ledger(path: str) -> list[dict]:
    rows: list[dict] = []
    with open(path, encoding='utf8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue  # 坏行不阻塞自愈(它自己的判据在别处)
    return rows


def latest_by_id(rows: list[dict]) -> dict[str, dict]:
    lat: dict[str, dict] = {}
    for r in rows:
        rid = r.get('id')
        if rid:
            lat[rid] = r
    return lat


def find_missing(lat: dict[str, dict]) -> list[str]:
    out = []
    for rid, r in lat.items():
        if r.get('status') in TERMINAL or r.get('status') not in HEAL_STATUSES:
            continue
        if not str(r.get('reviewBy') or '').strip():
            out.append(rid)
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--window-days', type=int, default=DEFAULT_WINDOW_DAYS)
    ap.add_argument('--ledger', default=LEDGER_DEFAULT)
    ap.add_argument('--log', default=LOG_DEFAULT)
    ap.add_argument('--force', action='store_true', help='套件在跑时也照样自愈(默认跳过)')
    args = ap.parse_args()

    if not os.path.exists(args.ledger):
        print('[heal] 账本不存在: %s' % args.ledger)
        return 2
    if suite_running() and not args.force and not args.dry_run:
        _log(args.log, {'ts': now_iso(), 'event': 'skipped', 'reason': 'suite-running'})
        print('[heal] 测试套件在跑, 本轮跳过(不自愈, 不改账本)')
        return 3

    try:
        rows = read_ledger(args.ledger)
    except Exception as e:  # noqa: BLE001
        print('[heal] 账本不可读: %s' % e)
        return 2

    lat = latest_by_id(rows)
    targets = find_missing(lat)
    if not targets:
        _log(args.log, {'ts': now_iso(), 'event': 'clean', 'openItems': len(lat)})
        print('[heal] 无需自愈: %d 条账本项中, 未关单项都带 reviewBy' % len(lat))
        return 0

    until = today_plus(args.window_days)
    healed = []
    for rid in targets:
        src = lat[rid]
        row = dict(src)
        # ts 是"该行状态被写入的时刻"(消费方按同 id 末行 + ts 严格递增取最新, 见 T132):
        # 自愈确实改写了状态 ⇒ 必须换新的 ts, 否则同 id 两行 ts 相等, 判据会红、消费方会读错。
        # 原创建时刻另存 createdTs(首次自愈时记下, 之后各次沿用), 免得"何时开单"这条信息丢失。
        row['createdTs'] = src.get('createdTs') or src.get('ts')
        row['ts'] = now_iso()
        row['reviewBy'] = until
        row['reviewByAuto'] = True
        row['reviewByAutoAt'] = now_iso()
        row['reviewByAutoNote'] = ('写入方未声明复核窗口, 由 dsh-claims-ledger-heal.py 自动补(默认 %d 天); '
                                   '自愈不改判、不关单 —— 到期仍由 T33/T143 判' % args.window_days)
        healed.append(row)
    if not args.dry_run:
        with open(args.ledger, 'a', encoding='utf8') as f:
            for row in healed:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
    _log(args.log, {'ts': now_iso(), 'event': 'healed' if not args.dry_run else 'dry-run',
                    'ids': targets, 'reviewBy': until, 'windowDays': args.window_days})
    print('[heal] %s %d 项: %s → reviewBy=%s' % ('干跑' if args.dry_run else '已补', len(targets),
                                                 ','.join(targets[:6]), until))
    return 0


def _log(path: str, rec: dict) -> None:
    # 归属分离(cl-146 家族): 只认 origin=cron 的行才算"排程在跑", 我手工跑的不算。
    rec.setdefault('origin', os.environ.get('DSH_RUN_ORIGIN', 'manual'))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'a', encoding='utf8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass


if __name__ == '__main__':
    sys.exit(main())
