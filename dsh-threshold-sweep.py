#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-threshold-sweep.py — 注入过阈门限的离线扫描(cl-263)。

起因(2026-09-12 03:1x 行动帧): 单条注入占比 53%→46% 的成因已查明 —— 84% 来自"过阈候选只有 1 个"
(overThreshold==1), 即 ``directSimilarityThreshold``(默认 0.5) 这道门。若门限偏严, 可排序集(>=2 候选)
就被压在天花板上, 而排序质量的离线指标又只能在可排序集上算 ⇒ 两者是同一个旋钮的两面。本工具把这个
旋钮**离线扫一遍**, 给出"门限 ↔ 可排序集占比 ↔ A/B 档 MRR/top-1"的对照表, 供预登记判据裁决。

口径纪律:
  · 复用 dsh-library-replay.py 的加载与标签函数(**同一口径**), 不另写一套, 否则两个读数不可比;
  · 相关性标签用 **valence**(非自证): gain 对 B 档是同义反复(cl-219 实测), cited 当前算不出(合格记录 0);
  · 只在**可排序集**(幸存候选 >=2)上算 MRR —— 单候选集没有排序可言, 不能算进去充数。

**预登记裁决规则(写在此处, 先于看结果)**:
  R1 若存在门限 t*, 使可排序集占比比当前门限下**提高 >=10 个百分点**, 且 A 档 MRR 不低于当前值 -0.02、
     top-1 不低于当前值 -0.02 ⇒ 判 `widen-gate`: 改配置前先写预登记判据(在线复核窗口 + 回滚条件)。
  R2 若可排序集占比随门限放松而上升、但 A 档 MRR/top-1 同步下降超过 0.02 ⇒ 判 `tradeoff-ceiling`:
     这是质量↔可排序集的真实权衡, 不是配置缺陷, 记入 library-replay-history 并停止在此旋钮上反复试。
  R3 其余情况(含"门限放松后占比几乎不动") ⇒ 判 `no-headroom`: 天花板不在门限上, 转去查候选召回端。

用法: dsh-threshold-sweep.py [--grid 0.35,0.40,...] [--label valence|gain] [--json]
退出码: 0 正常; 1 缺预登记/数据不足(不当成通过); 2 读不到审计。
"""
from __future__ import annotations

import argparse
import datetime
import importlib.util
import json
import os
import sys

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
REPLAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dsh-library-replay.py')
OUT = os.path.join(D, 'threshold-sweep.json')
CURRENT_GATE = 0.5          # directSimilarityThreshold 默认值(cognitive-inject:153)
PREREG = ('R1 widen-gate: 可排序集占比 +>=10pp 且 A 档 MRR/top-1 不降 >0.02 ⇒ 预登记判据后改配置; '
          'R2 tradeoff-ceiling: 占比升但 A 档质量降 >0.02 ⇒ 真实权衡, 停止在此旋钮上试; '
          'R3 no-headroom: 占比不随门限变化 ⇒ 天花板不在门限上; '
          'R0 inconclusive: 审计未记阈下候选 ⇒ 本数据上不可判, 先补埋点; '
          'R-1 insufficient-post-instrumentation: 埋点后样本回合不足 ⇒ 只报数不出裁决; '
          'R-2 insufficient-belowgate-capped: 阈下记录顶满上限 ⇒ 记录被截断, 需先抬高上限')


def load_replay():
    """以模块方式加载 replay 工具, 复用它的加载/标签函数(同一口径)。

    2026-09-12 04:0x 实测踩到: 两个脚本的 D 都是 `expanduser('~/.dsh/cognitive-pipeline')` **硬编码**,
    于是 `DSH_COG_DIR=<tmp>` 的沙箱测试**根本没读到沙箱数据** —— 它读的是真库, 却把合成的判读写进了
    真实的 threshold-sweep.json(合成污染真产物, cl-243 家族)。故这里显式支持 DSH_COG_DIR, 并让 OUT 也随之走沙箱。
    """
    spec = importlib.util.spec_from_file_location('dsh_library_replay', REPLAY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)   # 该脚本 main() 受 __main__ 保护, 不会被执行
    override = os.environ.get('DSH_COG_DIR')
    if override:
        mod.D = override
        mod.AUDIT = os.path.join(override, 'retrieval-audit.jsonl')
        mod.EXP = os.path.join(override, 'experiences.jsonl')
        mod.EXP_FRAMES = os.path.join(override, 'experiences-frames.jsonl')
    return mod


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--grid', default='0.30,0.35,0.40,0.45,0.50,0.55,0.60')
    ap.add_argument('--label', default='valence', choices=('valence', 'gain'))
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(REPLAY):
        print('缺 replay 工具(口径来源): ' + REPLAY, file=sys.stderr)
        return 1
    mod = load_replay()
    out = os.path.join(os.environ.get('DSH_COG_DIR') or D, 'threshold-sweep.json')
    try:
        util = mod.utility_map()
        labels = mod.label_map(args.label)
        records = []
        for line in open(mod.AUDIT, encoding='utf8'):
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get('stage') != 'injected':
                continue
            cands = r.get('preTop') or r.get('candidateScores')
            if not cands:
                continue
            # cl-263: 把**阈下候选**(belowGate, 2026-09-12 03:5x 起由审计落盘)并进候选集 —— 门限扫描要问的
            # 正是"门限放到 t 时这些被丢掉的候选会不会回来"; 没有它们就只能如实报 inconclusive。
            cands = list(cands) + list(r.get('belowGate') or [])
            # 只保留有相似度且在我们的效用表里可用的候选 —— 与 replay 的候选可用性口径一致
            c2 = [c for c in cands if isinstance(c.get('similarity'), (int, float)) and c.get('expId') in util]
            if not c2:
                continue
            r['candidateScores'] = c2
            records.append(r)
    except Exception as exc:  # noqa: BLE001
        print('读不到审计: %s' % exc, file=sys.stderr)
        return 2
    if len(records) < 30:
        print('数据不足(%d 条注入回合), 不下结论' % len(records), file=sys.stderr)
        return 1

    grid = [float(x) for x in args.grid.split(',')]
    # 诊断(cl-263 关键前提): 审计里记的候选清单**是不是含阈下候选**? 若不含(全部 >= 当前门限),
    # 那么"离线扫门限"在这份数据上根本做不了 —— 必须先把阈下候选记下来, 否则只能在线试错。
    allsims = [c['similarity'] for r in records for c in r['candidateScores']]
    below = [s for s in allsims if s < CURRENT_GATE]
    # 2026-09-12 04:3x **自查补闸(与 exp_298 同型: 先验总体定义再优化)**: 埋点 04:30 才上线, 而审计里
    # 绝大多数回合是**上线前写的老行(根本没有 belowGate 字段)** ⇒ 只拿少数几行当全体, 会得出"阈下只占 1%,
    # 所以门限不是瓶颈"这种**用截断样本冒充总体**的结论。故: 有 belowGate 的回合数不足(默认 <10)时,
    # 一律报 insufficient-post-instrumentation, 只报数, 不出裁决。
    rounds_with_bg = sum(1 for r in records if 'belowGate' in r)
    # 2026-09-12 05:0x 实测: 前两轮记录**都恰好等于当时的上限(5)** ⇒ 上限被顶满 = 样本被截断, 此时连
    # "阈下有多少候选"都答不出, 更谈不上扫门限(上限已抬到 20, 若仍顶满则同样判为截断)。
    BELOW_GATE_CAP = 20
    capped_rounds = sum(1 for r in records
                        if isinstance(r.get('belowGate'), list) and len(r['belowGate']) >= BELOW_GATE_CAP)

    diag = {'cappedRounds': capped_rounds, 'cap': BELOW_GATE_CAP,
            'candidates': len(allsims), 'min': min(allsims) if allsims else None,
            'max': max(allsims) if allsims else None,
            'belowGate': len(below), 'belowGateShare': round(len(below) / len(allsims), 4) if allsims else None}

    def mrr_at(threshold: float, arm: str) -> tuple[float | None, float | None, int, int]:
        """返回 (mrr, top1, 可排序集数, 幸存回合数)。"""
        vals, hits, rankable, kept = [], 0, 0, 0
        for rec in records:
            surv = [c for c in rec['candidateScores'] if c['similarity'] >= threshold]
            if not surv:
                continue
            kept += 1
            if len(surv) < 2:
                continue
            rankable += 1
            if arm == 'A':
                key = lambda c: c['similarity']                                  # noqa: E731
            else:
                key = lambda c: c['similarity'] * (0.7 + 0.06 * util[c['expId']])  # noqa: E731
            ranked = sorted(surv, key=key, reverse=True)
            # 相关性必须**独立于排序**定义(replay 同口径): 取候选集内标签最大者为相关项,
            # 再去数它排在第几。2026-09-12 03:2x 第一版把"排在最前的有标签候选"当相关项 ⇒ MRR 恒 1.000,
            # 那种写法把排序质量变成了同义反复(正是 cl-219 那类自证缺陷的翻版), 已修。
            lab = [c for c in ranked if c['expId'] in labels]
            if not lab:
                continue
            best = max(labels[c['expId']] for c in lab)
            for idx, c in enumerate(ranked, start=1):
                if labels.get(c['expId']) == best:
                    vals.append(1.0 / idx)
                    if idx == 1:
                        hits += 1
                    break
        if not vals:
            return None, None, rankable, kept
        return sum(vals) / len(vals), hits / len(vals), rankable, kept

    table = []
    for t in sorted(set(grid + [CURRENT_GATE])):
        a_mrr, a_top1, rankable, kept = mrr_at(t, 'A')
        b_mrr, b_top1, _, _ = mrr_at(t, 'B')
        table.append({'threshold': t, 'rankable': rankable, 'keptTurns': kept,
                      'rankableShare': round(rankable / len(records), 4),
                      'armA_mrr': a_mrr, 'armA_top1': a_top1,
                      'armB_mrr': b_mrr, 'armB_top1': b_top1})
    cur = next(row for row in table if row['threshold'] == CURRENT_GATE)
    # 前提检验优先于结论(cl-263 实测): 审计只记**过阈后**的候选(426 个候选中阈下 0 个, 最小相似度 0.502),
    # 于是"放松门限能不能多出可排序集"在这份数据上**根本算不出来** —— 表格里那行平坦的 75% 是数据结构的
    # 产物, 不是关于门限的证据。此时必须报 inconclusive 而不是 no-headroom(后者会把"没数据"讲成"没空间")。
    POST_MIN_ROUNDS = 10
    if capped_rounds > 0:
        payload = {'ts': datetime.datetime.now().astimezone().isoformat(),
                   'label': args.label, 'currentGate': CURRENT_GATE, 'turns': len(records),
                   'subGateDiagnostics': diag, 'roundsWithBelowGate': rounds_with_bg,
                   'table': table, 'verdict': 'insufficient-belowgate-capped',
                   'reason': ('有 %d 轮记录的阈下候选顶满上限(%d) ⇒ 记录本身被截断, "阈下有多少候选"不可知, '
                              '扫门限会系统性低估; 需先把上限抬高并等新一轮数据(现上限已抬到 %d)'
                              % (capped_rounds, BELOW_GATE_CAP, BELOW_GATE_CAP)),
                   'bestRow': None, 'prereg': PREREG}
        json.dump(payload, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
            return 0
        print('注入回合 %d | 埋点后回合 %d | 顶满上限的回合 %d' % (len(records), rounds_with_bg, capped_rounds))
        print('判读: %s —— %s' % (payload['verdict'], payload['reason']))
        return 0
    if rounds_with_bg < POST_MIN_ROUNDS:
        payload = {'ts': datetime.datetime.now().astimezone().isoformat(),
                   'label': args.label, 'currentGate': CURRENT_GATE, 'turns': len(records),
                   'subGateDiagnostics': diag, 'roundsWithBelowGate': rounds_with_bg,
                   'table': table, 'verdict': 'insufficient-post-instrumentation',
                   'reason': ('埋点(04:30 上线)之后只有 %d 个回合带 belowGate(需 >=%d) ⇒ 现在扫门限等于'
                              '拿截断样本冒充总体: 表里"阈下仅占 %d/%d"是老行没有该字段造成的, 不是真相。'
                              '按实测注入速率(近一小时约 5 分钟一次)约 %d 分钟后可裁决。'
                              % (rounds_with_bg, POST_MIN_ROUNDS, diag['belowGate'], diag['candidates'],
                                 max(1, (POST_MIN_ROUNDS - rounds_with_bg)) * 5)),
                   'bestRow': None, 'prereg': PREREG}
        json.dump(payload, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
            return 0
        print('注入回合 %d | 埋点后回合 %d(需 >=%d) | 标签=%s' % (len(records), rounds_with_bg, POST_MIN_ROUNDS, args.label))
        print('判读: %s —— %s' % (payload['verdict'], payload['reason']))
        return 0
    if diag['belowGate'] == 0:
        payload = {'ts': datetime.datetime.now().astimezone().isoformat(),
                   'label': args.label, 'currentGate': CURRENT_GATE, 'turns': len(records),
                   'subGateDiagnostics': diag, 'table': table,
                   'verdict': 'inconclusive-subgate-not-recorded',
                   'reason': ('审计只记过阈后的候选(阈下 %d 个 / 共 %d, 最小相似度 %.3f) ⇒ 门限放松能否增加'
                              '可排序集在本数据上不可判; 表中占比不随门限变化是数据结构产物, 不得当作证据。'
                              '要判必须先采集阈下候选(审计加 belowGate 字段或放宽 preTop 捕获)'
                              % (diag['belowGate'], diag['candidates'], diag['min'] or 0)),
                   'bestRow': None, 'prereg': PREREG}
        json.dump(payload, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        if args.json:
            print(json.dumps(payload, ensure_ascii=False))
            return 0
        print('注入回合 %d | 标签=%s | 当前门限 %.2f' % (len(records), args.label, CURRENT_GATE))
        print('  诊断: 记录候选 %d 个, 相似度 %.3f~%.3f, **阈下候选 %d 个**'
              % (diag['candidates'], diag['min'] or 0, diag['max'] or 0, diag['belowGate']))
        print('判读: %s —— %s' % (payload['verdict'], payload['reason']))
        return 0
    verdict, reason, best = 'no-headroom', '', None
    for row in table:
        if row['armA_mrr'] is None:
            continue
        if (row['rankableShare'] - cur['rankableShare'] >= 0.10
                and row['armA_mrr'] >= (cur['armA_mrr'] or 0) - 0.02
                and row['armA_top1'] >= (cur['armA_top1'] or 0) - 0.02):
            verdict, best = 'widen-gate', row
            reason = ('门限 %.2f: 可排序集占比 %.0f%%→%.0f%%, A 档 MRR %.3f→%.3f, top-1 %.3f→%.3f'
                      % (row['threshold'], 100 * cur['rankableShare'], 100 * row['rankableShare'],
                         cur['armA_mrr'], row['armA_mrr'], cur['armA_top1'], row['armA_top1']))
            break
    if verdict == 'no-headroom':
        lower = [row for row in table if row['threshold'] < CURRENT_GATE and row['armA_mrr'] is not None]
        if lower and any((row['rankableShare'] - cur['rankableShare'] >= 0.05
                          and row['armA_mrr'] < (cur['armA_mrr'] or 0) - 0.02) for row in lower):
            verdict = 'tradeoff-ceiling'
            reason = '放松门限可提可排序集占比, 但 A 档 MRR 同步下降 >0.02 ⇒ 质量↔可排序集的真实权衡'
        else:
            reason = '门限放松对可排序集占比没什么影响 ⇒ 天花板不在门限上, 转查候选召回端'
    payload = {'ts': datetime.datetime.now().astimezone().isoformat(),
               'label': args.label, 'currentGate': CURRENT_GATE, 'turns': len(records),
               'subGateDiagnostics': diag, 'roundsWithBelowGate': rounds_with_bg,
               'table': table, 'verdict': verdict, 'reason': reason, 'bestRow': best,
               'prereg': PREREG}
    json.dump(payload, open(out, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('注入回合 %d | 标签=%s | 当前门限 %.2f' % (len(records), args.label, CURRENT_GATE))
    print('  诊断: 记录候选 %d 个, 相似度 %.3f~%.3f, **阈下候选 %d 个(%.0f%%)**'
          % (diag['candidates'], diag['min'] or 0, diag['max'] or 0, diag['belowGate'],
             100 * (diag['belowGateShare'] or 0)))
    print('  %-9s %-9s %-9s %-9s %-9s %-9s' % ('门限', '可排序集', '占比', 'A_MRR', 'A_top1', 'B_MRR'))
    for row in table:
        print('  %-9.2f %-9d %-9s %-9s %-9s %-9s'
              % (row['threshold'], row['rankable'],
                 '%.0f%%' % (100 * row['rankableShare']),
                 '%.3f' % row['armA_mrr'] if row['armA_mrr'] is not None else '-',
                 '%.3f' % row['armA_top1'] if row['armA_top1'] is not None else '-',
                 '%.3f' % row['armB_mrr'] if row['armB_mrr'] is not None else '-'))
    print('判读: %s —— %s' % (verdict, reason))
    return 0


if __name__ == '__main__':
    sys.exit(main())
