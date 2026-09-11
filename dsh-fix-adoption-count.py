#!/usr/bin/env python3
"""dsh-fix-adoption-count.py — 修复"采纳计数丢更新"(cl-079)造成的不变量漂移。

不变量: adoptedCount - incubation-log 条数 == incubation-baseline.json 里的存量残差。
新采纳同时进计数器与日志, 差额恒定; 差额缩小=丢了一次 bump(计数器被覆盖)。
本脚本按 日志条数 + 基线残差 重算 adoptedCount(幂等), 读-改-写之间不留窗口。

用法: python3 dsh-fix-adoption-count.py [--dry-run]
"""
import json, os, sys

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
pool_path = os.path.join(D, 'dormant-goals.jsonl')
log_path = os.path.join(D, 'incubation-log.jsonl')
base_path = os.path.join(D, 'incubation-baseline.json')
dry = '--dry-run' in sys.argv

base = json.load(open(base_path, encoding='utf8')).get('goals', {})
logged = {}
for line in open(log_path, encoding='utf8'):
    line = line.strip()
    if line:
        entry = json.loads(line)
        # cl-182: 回填行(reconstructed)是 notes 的历史回填, 不计入真实采纳计数比对
        if entry.get('reconstructed'):
            continue
        # cl-262(2026-09-12 04:5x): 目标池写入方补了归因通道后会写 pool-change —— 那些行不是插件的采纳记账,
        # 计入会把"未记时间的采纳"差额抹平(实测该目标差额 2→1, 本脚本于是想把 adoptedCount 34→35 平账)。
        # 判据侧(套件"计数与日志不倒退")已按同一 origin 排除; 本脚本必须同口径, 否则两侧会互相打架。
        if entry.get('origin') == 'dsh-goal-pool-write.py':
            continue
        gid = entry.get('goalId')
        logged[gid] = logged.get(gid, 0) + 1

rows = []
for line in open(pool_path, encoding='utf8'):
    line = line.strip()
    if line:
        rows.append(json.loads(line))

changed = []
for g in rows:
    gid = g.get('id')
    if gid not in base:
        continue
    want = logged.get(gid, 0) + base[gid]['undecidableAdoptions']
    if g.get('adoptedCount') != want:
        changed.append((gid, g.get('adoptedCount'), want))
        g['adoptedCount'] = want

if changed and not dry:
    with open(pool_path, 'w', encoding='utf8') as f:
        f.write('\n'.join(json.dumps(x, ensure_ascii=False) for x in rows) + '\n')
print('[fix-adoption] %s: %s' % ('dry-run' if dry else 'applied',
                                 ', '.join('%s %s→%s' % c for c in changed) or '无漂移'))
