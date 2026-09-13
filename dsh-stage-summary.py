#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-stage-summary.py — **阶段总结**: 从上层看整体活动效果(为"阶段总结帧"提供不靠嘴说的底稿)。

为什么要有它(2026-09-13 12:3x, 用户要求"增加一个阶段总结帧, 从上层观察整体的活动效果, 还可以增加一个
外部的观察进行打分"): 在此之前"整体效果"只散在若干个局部读数里(孵化三率、注入引用率、覆盖率归因…
各自口径不同、各自有时代), 没有一处能回答"**这半天/这一天, 这一整套机制到底产出了什么、代价是什么、
哪些结论其实没证据**"。而这类"总览"最容易变成自我表扬: 挑好看的数、把与活动期共线的量当因果。
故本脚本的三条硬约束(**写在代码里, 不由我临场决定**):
  ① **口径必须先声明**: 每个数都带出来源账本与口径行; 缺任何一份必需账本就 exit 3, 不出数(不许静默少算);
  ② **不报"效果"而报"产物与代价"**: 帧数/回合消耗 ↔ 落地产物(提交/账本行/测试/断言/脚本)的对照,
     并显式列出**哪些指标与活动期共线、不得当因果**(实测: 帧与"我在干活"共线, 活跃匹配后差异消失 p=0.5);
  ③ **未证项单列**: "有动作但没有外部产物结局"的项必须在 F 段列出来, 不许被好看的计数盖掉。

产物: ~/.dsh/cognitive-pipeline/stage-summary.jsonl(追加行, last-wins) + stage-summary.md(渲染稿, 原子写)
用法: python3 dsh-stage-summary.py [--hours 12] [--since ISO] [--json]
退出码: 0 出数; 3 缺必需账本/时间不可解析。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
REPO = os.environ.get('DSH_REPO') or os.path.expanduser('~/dsh-fork')
TZ = datetime.timezone(datetime.timedelta(hours=8))
REQUIRED = ('quiet-driver-frames.jsonl', 'dormant-goals.jsonl', 'goal-trigger-log.jsonl',
            'claims-ledger.jsonl', 'test-pending.jsonl')
PARKED_NOTE = ('口径: 帧的"投递/停泊/未投递"三分沿用 2026-09-13 12:0x 修正后的孵化体检口径 —— '
               '未投递(skipped)与目标停泊期(池里挂 waitChecker)内的帧**不进"有效活动"分母**'
               '(它们注定不能转化; 旧口径把它们当唤醒, 曾造成 12 次误报)')


def dt(s):
    try:
        v = datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
        return (v if v.tzinfo else v.replace(tzinfo=TZ)).astimezone(TZ)
    except Exception:
        return None


def ms(t):
    if isinstance(t, (int, float)):
        return datetime.datetime.fromtimestamp(t / 1000, TZ)
    return dt(t)


def load(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        return None
    out = []
    with open(p, encoding='utf8') as fh:
        for line in fh:
            if line.strip():
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def git(*args):
    try:
        r = subprocess.run(['git', *args], cwd=REPO, capture_output=True, text=True, timeout=60)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=float, default=12.0)
    ap.add_argument('--since', default=None)
    ap.add_argument('--json', action='store_true')
    # 2026-09-13 12:1x(外部评审逼出的设计缺陷): 本脚本原来**只有"算完就落盘"一条路** —— 落一行账、
    # 重写一次 md。于是任何外部评审者想"重跑一遍核对数字"就必须**改动被评审对象的状态**(那位评审者
    # 因此刻意不跑, 改用独立复算, 并把这一点写进了它的报告)。这就把最强的验证形式(自己重跑对账)关掉了。
    # 故加 --dry-run: 只算、只打印, 不写账本、不重写 md。
    ap.add_argument('--dry-run', action='store_true', help='只算并打印, 不落账、不重写 md(供外部核对)')
    args = ap.parse_args()

    data = {}
    for name in REQUIRED:
        v = load(name)
        if v is None:
            print('[stage-summary] 缺必需账本: %s ⇒ 不出数(不许静默少算)' % name, file=sys.stderr)
            return 3
        data[name] = v
    prev = load('stage-summary.jsonl') or []
    now = datetime.datetime.now(TZ)
    if args.since:
        start = dt(args.since)
        if start is None:
            print('[stage-summary] --since 不可解析: %r' % args.since, file=sys.stderr)
            return 3
    elif prev and prev[-1].get('periodEnd'):
        start = dt(prev[-1]['periodEnd']) or (now - datetime.timedelta(hours=args.hours))
    else:
        start = now - datetime.timedelta(hours=args.hours)

    # ── A. 帧活动(投递/停泊/未投递三分) ──
    pool_rows = data['dormant-goals.jsonl']
    latest_goal = {}
    gate_hist = defaultdict(list)
    for r in pool_rows:
        gid = r.get('goalId') or r.get('id')
        if not gid:
            continue
        latest_goal[gid] = r
        t = dt(r.get('lastActionAt') or r.get('ts'))
        if t:
            gate_hist[gid].append((t, bool(str(r.get('waitChecker') or '').strip())))
    for v in gate_hist.values():
        v.sort()

    def parked(gid, when):
        h = [x for x in gate_hist.get(gid, []) if x[0] <= when]
        return h[-1][1] if h else False

    frames = [(ms(r.get('ts')), r) for r in data['quiet-driver-frames.jsonl']]
    frames = [(t, r) for t, r in frames if t and start <= t <= now]
    trig = [(ms(r.get('ts')), r) for r in data['goal-trigger-log.jsonl']]
    trig = [(t, r) for t, r in trig if t and start <= t <= now]
    by_kind = Counter(r.get('kind') or '(无kind)' for _, r in frames)
    delivered = [r for _, r in trig if not r.get('skipped')]
    skipped = [r for _, r in trig if r.get('skipped')]
    parked_trig = [r for _, r in trig if parked(r.get('goalId'), ms(r.get('ts')))]

    # ── B. 落地产物 ──
    commits = [l for l in git('log', '--since', start.isoformat(), '--pretty=%H|%ad|%s', '--date=format:%H:%M').splitlines() if l]
    # 2026-09-13 外部评审抓出的口径缺陷: 原实现用 startswith 判**首个**文件 ⇒ 漏计"首个不在 packages/ 但别的在"的
    # 提交(实测 0e565bc: 改 5 个 packages 文件却因首个文件是 .mts 被漏掉)。改为**任一文件**在 packages/ 即算。
    def touches_packages(sha: str) -> bool:
        return any(l.strip().startswith('packages/')
                   for l in git('show', '--name-only', '--pretty=format:', sha).splitlines())
    prod_commits = [l for l in commits if touches_packages(l.split('|')[0])]
    cl = data['claims-ledger.jsonl']
    cl_latest = {}
    for r in cl:
        if r.get('id'):
            cl_latest[r['id']] = r
    cl_new, cl_closed = [], []
    for k, v in cl_latest.items():
        t = dt(v.get('ts'))
        if not t or not (start <= t <= now):
            continue
        (cl_closed if str(v.get('status')) in ('done', 'closed', 'retired') else cl_new).append(k)
    # 2026-09-13 12:0x 自查修正: 原实现按"最新行的 ts 落在本期"计数 ⇒ 一个 id 只要被更新过就算"新入账"
    # (实测虚报 127 条)。测试账本是追加式且同 id 多行, 必须按**首次出现时刻**判"新"(exp_256 的教训: 读追加式
    # 账本自带 last-wins 语义, 否则把历史行读成当前状态)。故先求每个 id 的最早 ts, 再与窗口比。
    tp = data['test-pending.jsonl']
    tp_first = {}
    for r in tp:
        k = r.get('id')
        t = dt(r.get('ts'))
        if k and t and (k not in tp_first or t < tp_first[k]):
            tp_first[k] = t
    tp_new = [k for k, t in tp_first.items() if start <= t <= now]

    # ── C. 目标推进与停滞 ──
    goal_adv, goal_idle = {}, {}
    for gid, r in latest_goal.items():
        if r.get('status') != 'active':
            continue
        hist = []
        for rr in pool_rows:
            if (rr.get('goalId') or rr.get('id')) == gid:
                hist.append(rr)
        adv = 0
        prevna = None
        for rr in hist:
            na = str(rr.get('nextAction') or '')
            t = dt(rr.get('lastActionAt') or rr.get('ts'))
            if prevna is not None and na and na != prevna and t and start <= t <= now:
                adv += 1
            prevna = na
        la = dt(r.get('lastActionAt'))
        goal_adv[gid] = adv
        goal_idle[gid] = round((now - la).total_seconds() / 3600, 1) if la else None

    # ── E. 外部锚(机器可核) ──
    head = git('log', '-1', '--pretty=%h %s')[:120]
    suite, suite_trend, suite_fail_ids = '', [], []
    log = os.path.join(D, '.cog-tests.log')
    if os.path.exists(log):
        lines = open(log, encoding='utf8', errors='replace').read().splitlines()
        verdicts = [l.strip() for l in lines if '累计裁决' in l]
        suite = verdicts[-1][:90] if verdicts else ''
        for v in verdicts:
            m = re.search(r'(\d+) 通过 / (\d+) 失败.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})', v)
            if not m:
                continue
            t = dt(m.group(3))
            if t and start <= t <= now:
                suite_trend.append({'ts': t.strftime('%m-%d %H:%M'), 'pass': int(m.group(1)), 'fail': int(m.group(2))})
        tail = lines[max(0, len(lines) - 400):]
        suite_fail_ids = sorted({l.strip()[2:].strip() for l in tail if l.strip().startswith('✗')})
    pid = ''
    try:
        pid = subprocess.run(['systemctl', '--user', 'show', 'dsh-web.service', '-p', 'MainPID',
                              '--value'], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception:
        pass

    # ── F. 未证项(有动作、无外部产物结局) ──
    unproven = []
    # 外部评审 2026-09-13 的反面例: "最严重的外部红(套件从 6 涨到 9 失败)没被当轮处理, 总结里也没有身份清单"。
    # 故: 期内只要套件有失败, 就必须进"未证/未处理"清单, 不许只贴裁决字符串。
    if suite_trend and suite_trend[-1]['fail'] > 0:
        unproven.append('**外部红未处理**: 套件期内失败 %d→%d(%d 次裁决); 失败项身份: %s'
                        % (suite_trend[0]['fail'], suite_trend[-1]['fail'], len(suite_trend),
                           '; '.join(suite_fail_ids[:6]) or '(本窗口日志里取不到身份)'))
    if by_kind.get('stage-summary-frame'):
        unproven.append('阶段总结帧自身的效果(它才刚上线, 没有前后对照)')
    unproven.append('帧的**因果**作用: 本脚本只报产物与代价; 帧与"我在干活"共线(活跃匹配后 p=0.5), '
                    '任何"帧数↑⇒推进↑"的读法都无效')
    unproven.append('采纳率/引用率类读数只覆盖"已注入/已唤醒"的子总体, 不含未发生的暴露')
    if any(v is None for v in goal_idle.values()):
        unproven.append('部分目标的停滞时长为 None(缺 lastActionAt)')

    row = {
        'ts': now.isoformat(), 'periodStart': start.isoformat(), 'periodEnd': now.isoformat(),
        'hours': round((now - start).total_seconds() / 3600, 2),
        'frames': {'total': len(frames), 'byKind': dict(by_kind)},
        'triggers': {'total': len(trig), 'delivered': len(delivered), 'skipped': len(skipped),
                     'parkedAnyTime': len(parked_trig)},
        'artifacts': {'commits': len(commits), 'productCommits': len(prod_commits),
                      'claimsOpenedOrTouched': sorted(cl_new), 'claimsClosed': sorted(cl_closed),
                      'testEntriesNew': sorted(tp_new)},
        'goals': {'advances': goal_adv, 'idleHours': goal_idle},
        'cost': {'turnsConsumedByFrames': len(frames),
                 'artifactsPerFrame': round((len(commits) + len(cl_new) + len(cl_closed)) / max(len(frames), 1), 3)},
        'externalAnchors': {'gitHead': head, 'suiteVerdict': suite, 'mainPid': pid,
                            'suiteTrendInPeriod': suite_trend, 'suiteFailureNames': suite_fail_ids},
        'eras': {'frameThreeWayCaliberEffectiveFrom': '2026-09-13T12:05:00+08:00',
                 'note': ('帧三分口径(投递/停泊/未投递)自 12:05 起生效; 本期 periodEnd 若早于该时刻, 读数属'
                          '**旧口径时代**, 不可与新口径直接比 —— 这条由外部评审 2026-09-13 抓出')},
        'unproven': unproven,
        'caliber': PARKED_NOTE,
    }
    if not args.dry_run:
        with open(os.path.join(D, 'stage-summary.jsonl'), 'a', encoding='utf8') as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + '\n')
    else:
        print('[stage-summary] --dry-run: 未落账、未重写 md(供外部核对; 本期底座如下)')

    md = ['# 阶段总结 %s → %s (%.1fh)' % (start.strftime('%m-%d %H:%M'), now.strftime('%m-%d %H:%M'), row['hours']), '',
          '## A 帧活动(三分口径)', '',
          '| 帧形态 | 条数 |', '|---|---|']
    for k, v in sorted(by_kind.items(), key=lambda kv: -kv[1]):
        md.append('| %s | %d |' % (k, v))
    md += ['', '| 项 | 值 |', '|---|---|',
           '| 帧总数 | %d |' % len(frames),
           '| 目标触发行 | %d |' % len(trig),
           '| 其中投递 | %d |' % len(delivered),
           '| 其中未投递(skipped) | %d |' % len(skipped),
           '| 落在停泊期 | %d |' % len(parked_trig),
           '', '## B 落地产物', '',
           '| 项 | 值 |', '|---|---|',
           '| 提交 | %d(其中触及 packages/ %d) |' % (len(commits), len(prod_commits)),
           '| 账本新开/变动 | %d |' % len(cl_new),
           '| 账本结单 | %d |' % len(cl_closed),
           '| 测试入账 | %d |' % len(tp_new),
           '', '## C 目标推进', '',
           '| 目标 | 本期推进 | 停滞(h) |', '|---|---|---|']
    for gid in sorted(goal_adv):
        md.append('| %s | %d | %s |' % (gid, goal_adv[gid], goal_idle.get(gid)))
    md += ['', '- C 节口径: "本期推进" = dormant-goals.jsonl 里该目标 nextAction 的**文本变化次数**。'
           '它只说明"指令被改写", **不等于**世界状态前进了(外部评审 2026-09-13 指出该列原先没有口径注, 而它是本报告最吃重的一列)。',
           '', '## D 成本', '', '- 帧消耗回合 %d; 每帧落地产物 %.3f 件' % (
        row['cost']['turnsConsumedByFrames'], row['cost']['artifactsPerFrame']),
        '- 口径: %s' % PARKED_NOTE,
        '', '## E 外部锚(机器可核)', '',
        '- git HEAD: %s' % head, '- 套件最近裁决: %s' % (suite or '(无)'), '- dsh-web MainPID: %s' % (pid or '(未知)'),
        '- 套件期内趋势: %s' % ('; '.join('%s %d通过/%d失败' % (x['ts'], x['pass'], x['fail']) for x in suite_trend) or '(本窗口内无裁决)'),
        '- 失败项身份(%d 条): %s' % (len(suite_fail_ids), '; '.join(suite_fail_ids) or '(无)'),
        '', '## F 本期**未证**项(不得被上面的计数盖掉)', '']
    md += ['- %s' % u for u in unproven]
    text = '\n'.join(md) + '\n'
    if not args.dry_run:
        with open(os.path.join(D, 'stage-summary.md.tmp'), 'w', encoding='utf8') as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(os.path.join(D, 'stage-summary.md.tmp'), os.path.join(D, 'stage-summary.md'))
    print('(md 渲染稿见上; --dry-run 不写盘)')
    print(text)
    if args.json:
        print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
