#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-wake-intervention-readout.py — 唤醒干预实验的判读器(cl-265)。

背景: 观测分不开因果(唤醒与推进共线于活动期), 故做了干预: 把目标 goal-experience-library 的
triggerThresholds 抬到 1.01(不再被唤醒)24 小时, 次日自动恢复。本工具按**事先预登记**的判据机械判读,
免得 24 小时后我又临时定口径(那正是今天反复踩的"事后解释"坑)。

预登记判据(cl-265):
  指标 = 该目标的**推进次数/小时**(池变更行 evidence=pool-change, 时代起点取 attribution-era.json)
  基线 = 干预窗口**之前等长**的窗口; 对照 = 同期未被干预的 active 目标(各自算自己的前后比)
  · 目标速率比 <= 0.5 且 目标的降幅大于**所有**对照目标的降幅 ⇒ `causal`(唤醒确实是推进的因, 恢复阈值)
  · 目标速率比 > 0.5, 或降幅不超过对照 ⇒ `no-effect`(提醒对该目标无独立贡献 ⇒ 按噪声处置: 改写 focus/降权重)
  · 干预窗口内该目标**仍被唤醒过**(triggerCount 增长) ⇒ `contaminated`(开关没真关上, 结论作废)

用法: dsh-wake-intervention-readout.py [--target ID] [--start ISO] [--end ISO] [--json]
退出码: 0 正常; 1 参数/前置不足(窗口未结束等); 2 读不到账本。
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import sys

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
LOG = os.path.join(D, 'incubation-log.jsonl')
POOL = os.path.join(D, 'dormant-goals.jsonl')
ERA = os.path.join(D, 'attribution-era.json')
OUT = os.path.join(D, 'wake-intervention-readout.jsonl')
TERMINAL = {'done', 'retired', 'closed'}


def ms_of(v) -> float | None:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        try:
            return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp() * 1000
        except Exception:
            try:
                return float(v)
            except Exception:
                return None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='goal-experience-library')
    ap.add_argument('--start', default=None, help='干预窗口开始(ISO); 缺省=wake-interventions.jsonl 里最后一次 disable')
    ap.add_argument('--end', default=None, help='干预窗口结束(ISO); 缺省=该次 disable 之后最近一次 restore, 或现在')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--reversal-eval', action='store_true',
                    help='只做恢复腿复核: 判定窗口结束后 N 分钟内该目标是否真被推进(0=兑现 / 1=未兑现 / 2=未预登记 / 3=复核时点未到)')
    ap.add_argument('--reversal-window-min', type=float, default=30.0)
    args = ap.parse_args()

    recs = []
    iv = os.path.join(D, 'wake-interventions.jsonl')
    if os.path.exists(iv):
        for line in open(iv, encoding='utf8'):
            if line.strip():
                recs.append(json.loads(line))
    start_ms = ms_of(args.start) if args.start else None
    if start_ms is None:
        dis = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'disable']
        if not dis:
            print('没有 disable 记录且未给 --start ⇒ 无法判读', file=sys.stderr)
            return 1
        start_ms = ms_of(dis[-1].get('ts'))
    end_ms = ms_of(args.end) if args.end else None
    if end_ms is None:
        res = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'restore'
               and (ms_of(r.get('ts')) or 0) > (start_ms or 0)]
        end_ms = ms_of(res[-1].get('ts')) if res else datetime.datetime.now().timestamp() * 1000
    if end_ms <= start_ms:
        print('窗口不合法(end <= start)', file=sys.stderr)
        return 1
    span = end_ms - start_ms
    base_start, base_end = start_ms - span, start_ms

    era_since = None
    try:
        era_since = (json.load(open(ERA, encoding='utf8')) or {}).get('since')
    except Exception:
        era_since = None
    era_ms = ms_of(era_since) if era_since else None

    pool = {}
    for line in open(POOL, encoding='utf8'):
        if line.strip():
            r = json.loads(line)
            if r.get('id'):
                pool[str(r['id'])] = r
    try:
        changes = [json.loads(l) for l in open(LOG, encoding='utf8') if l.strip()]
    except Exception as exc:  # noqa: BLE001
        print('读不到账本: %s' % exc, file=sys.stderr)
        return 2
    changes = [c for c in changes if c.get('evidence') == 'pool-change']
    if era_ms is not None:
        changes = [c for c in changes if (ms_of(c.get('ts')) or 0) >= era_ms]

    def coverage_hours(lo: float, hi: float) -> float:
        """窗口里**落在时代内**的小时数。

        2026-09-12 11:1x (cl-265 caliberBias): 原先分子只数时代之后的推进, 分母却一律用窗口全长
        ⇒ 两臂口径不对称。实测: 冻结基线的 24h 窗口里只有 4.6h 落在时代内(03:26 起), 9 条推进
        除以 24h 记成 0.375/h, 而同口径实算是 9/4.6h ≈ 1.96/h —— **基线被低估约 5.2 倍**, 使
        ratio 放大 ~5 倍, **偏向判 causal**。分母改为按各臂自己的时代覆盖度算。
        """
        a = lo if era_ms is None else max(lo, era_ms)
        return max(0.0, (hi - a) / 3600000.0)

    def rate(goal: str, lo: float, hi: float):
        cov = coverage_hours(lo, hi)
        if cov <= 0:
            return None          # 该臂在这个窗口里**没有**时代内的观测 ⇒ 不可判, 不是 0
        n = sum(1 for c in changes if str(c.get('goalId')) == goal and lo <= (ms_of(c.get('ts')) or 0) < hi)
        return n / cov

    hours = span / 3600000.0
    t_rate_i = rate(args.target, start_ms, end_ms)
    # 2026-09-12 07:3x (与 tp-169 同一条教训: 预注册的东西必须被**消费**, 否则只是摆设):
    # 干预开始前我已把基线冻结在 wake-intervention-baseline.json(写入时刻早于实验) ⇒ 判读**优先用冻结基线**,
    # 而不是此刻重算 —— 重算会随日志裁剪/时代变化而漂移, 等于事后重定基准。窗口对不上才回退重算并标注来源。
    baseline_src = 'recomputed'
    t_rate_b = rate(args.target, base_start, base_end)
    frozen = None
    try:
        frozen = json.load(open(os.path.join(D, 'wake-intervention-baseline.json'), encoding='utf8'))
    except Exception:
        frozen = None
    def _near(a, b) -> bool:
        return a is not None and b is not None and abs(a - b) < 1000.0   # 1s 容差: ISO 往返的浮点差

    if frozen and _near(ms_of(frozen.get('windowStart')), base_start) and _near(ms_of(frozen.get('windowEnd')), base_end) \
            and (frozen.get('rates') or {}).get(args.target):
        t_rate_b = float(frozen['rates'][args.target]['perHour'])
        baseline_src = 'frozen(wake-intervention-baseline.json)'
    cov_b, cov_i = coverage_hours(base_start, base_end), coverage_hours(start_ms, end_ms)
    # 覆盖率警示(cl-265 caliberBias 的第二半): 分母修好之后两臂仍可能**证据量悬殊** —— 例如基线只有
    # 2 小时落在时代内却要撑起 24 小时的比较。此时不是"算错", 而是**不足以支撑一个自信的因果判断**,
    # 故把它标出来, 并把 causal 降级成 causal-thin-baseline(宁可弱结论, 不可强因果)。
    coverage_warn = cov_b < 0.5 * (span / 3600000.0)
    if t_rate_i is None or t_rate_b is None:
        ratio = None
    elif t_rate_b > 0:
        ratio = t_rate_i / t_rate_b
    else:
        ratio = 0.0 if t_rate_i == 0 else float('inf')
    controls = {}
    for gid, row in pool.items():
        if gid == args.target or row.get('status') in TERMINAL or row.get('status') != 'active':
            continue
        b, i = rate(gid, base_start, base_end), rate(gid, start_ms, end_ms)
        if frozen and baseline_src.startswith('frozen') and (frozen.get('rates') or {}).get(gid):
            b = float(frozen['rates'][gid]['perHour'])
        controls[gid] = {'baseline': (round(b, 3) if b is not None else None),
                         'intervention': (round(i, 3) if i is not None else None),
                         'ratio': (round(i / b, 3) if (b and i is not None) else None)}
    ctrl_ratios = [c['ratio'] for c in controls.values() if c['ratio'] is not None]
    target_row = pool.get(args.target) or {}
    # 污染检查: 干预窗口内该目标是否仍被唤醒(triggerCount 只能查现值, 故同时看触发日志的时间戳)
    contaminated = False
    trig = [r for r in recs if r.get('goal') == args.target and r.get('event') == 'disable']
    live_after = target_row.get('lastTriggerAt')
    lm = ms_of(live_after)
    if lm is not None and start_ms <= lm < end_ms:
        contaminated = True
    # 2026-09-12 06:1x 补: 关闭必须**两侧同时**生效 —— 抬 triggerThresholds 只停哨兵提醒, 行动帧由
    # quiet-driver 按 status/waitChecker 选(实测查证), 故窗口内若仍出现该目标的行动帧 ⇒ 开关没关全, 结论作废。
    frames_in_window = 0
    try:
        for line in open(os.path.join(D, 'quiet-driver-frames.jsonl'), encoding='utf8'):
            if not line.strip():
                continue
            f = json.loads(line)
            if f.get('kind') != 'action-frame' or str(f.get('goalId')) != args.target:
                continue
            fm = ms_of(f.get('ts'))
            if fm is not None and start_ms <= fm < end_ms:
                frames_in_window += 1
    except Exception:
        frames_in_window = -1
    if frames_in_window > 0:
        contaminated = True

    dropped_more_than_controls = all((ratio is not None and ratio <= r) for r in ctrl_ratios) if ctrl_ratios else True
    # 对照臂**有没有可比空间**(2026-09-12 11:2x 模拟 09-13 判读时发现的设计缺陷): 干预窗口内三条 active 目标
    # 全部门未满足(目标 /bin/false; 孵化的干预判读门; 检索的样本门) ⇒ 对照自己也塌成 0 ⇒ "降幅大于所有对照"
    # 这条判据**不可能**成立, 于是 no-effect 是被构造成出来的、不是测出来的(与 T199"饱和 ⇒ 判据没有开火空间"
    # 同型)。故: 目标确实掉了却没有任何对照有可比空间时, 只能说"对照无效", 不得宣称"提醒无独立贡献"。
    controls_with_headroom = [c['ratio'] for c in controls.values() if c['ratio'] not in (None, 0)]
    # 2026-09-12 07:3x **冒烟测试当场抓到的假阳性**: 基线与干预期都是 0 推进时, ratio=0.0 <= 0.5 且"降幅大于所有对照"
    # 都成立 ⇒ 会判 causal。零推进不是"唤醒有效"的证据, 而是**无可判**(基线里没有可比较的推进)。
    if contaminated:
        verdict, reason = 'contaminated', ('干预窗口内该目标仍被唤醒过(lastTriggerAt=%s / 窗口内行动帧 %d 条) '
                                           '⇒ 开关没真关上, 结论作废' % (live_after, frames_in_window))
    elif t_rate_i is None or t_rate_b is None:
        verdict, reason = 'insufficient-coverage', (
            '有一臂在窗口内**没有**时代内的观测(基线覆盖 %.1fh / 干预覆盖 %.1fh)⇒ 速率不可判 '
            '(注意: 不是"没效果", 而是"没数据")' % (cov_b, cov_i))
    elif t_rate_b == 0:
        verdict, reason = 'insufficient-baseline-zero', ('基线期该目标零推进 ⇒ 无可比较的基线, 判不出唤醒的作用'
                                                         '(零推进不是"唤醒有效"的证据)')
    elif ratio is not None and ratio <= 0.5 and not controls_with_headroom:
        verdict, reason = 'no-headroom-controls', (
            '目标推进速率 %s→%s 次/h(比 %.2f)确实降了, 但**没有任何对照臂有可比空间**'
            '(对照各自也塌到 0: %s)⇒ 对照组无效, 本窗口判不出唤醒的作用 —— 不是"没效果", 而是"没法比"'
            % ('不可判' if t_rate_b is None else format(t_rate_b, '.3f'),
               '不可判' if t_rate_i is None else format(t_rate_i, '.3f'), ratio,
               json.dumps({k: v.get('ratio') for k, v in controls.items()}, ensure_ascii=False)))
    elif ratio is not None and ratio <= 0.5 and dropped_more_than_controls and coverage_warn:
        # 因果方向成立, 但基线证据覆盖不足(见上) ⇒ 不给自信的因果结论
        verdict, reason = 'causal-thin-baseline', (
            '目标推进速率 %.3f→%.3f 次/h(比 %.2f, 降幅大于所有对照 %s), **但基线在时代内只覆盖 %.1fh** '
            '(占窗口 %.0f%%)⇒ 证据量不足以支撑自信的因果结论, 降级为弱结论(cl-265 caliberBias)'
            % (t_rate_b, t_rate_i, ratio, ctrl_ratios, cov_b, 100.0 * cov_b / (span / 3600000.0)))
    elif ratio is not None and ratio <= 0.5 and dropped_more_than_controls:
        verdict, reason = 'causal', ('目标推进速率 %.3f→%.3f 次/h(比 %.2f, 降幅大于所有对照 %s) ⇒ 唤醒是推进的因'
                                     % (t_rate_b, t_rate_i, ratio, ctrl_ratios))
    else:
        verdict, reason = 'no-effect', ('目标推进速率 %.3f→%.3f 次/h(比 %s) 未达 >=50%% 降幅或未超过对照 %s '
                                        '⇒ 提醒对该目标无独立贡献' % (t_rate_b, t_rate_i, ratio, ctrl_ratios))
    # ── 恢复腿预登记的**消费方**(2026-09-12 10:5x; T203 的另一半) ──
    # 上一步给 disable 加了强制的 reversalExpectation(预登记), 但**没有任何东西评估它是否兑现** ——
    # 这与 T202 判红的"装饰性时限"同型, 只是升了一层: 声明在账本里, 无人消费。故判读行必须回显预期
    # 并给出复核时点; `--reversal-eval` 时给出兑现判定(窗口结束 + N 分钟内的推进证据)。
    exp_rows = [r for r in recs if r.get('goal') == args.target and str(r.get('reversalExpectation') or '').strip()]
    expectation = str(exp_rows[-1]['reversalExpectation']) if exp_rows else ''
    check_at = end_ms + float(args.reversal_window_min) * 60000.0

    def counts_in(lo: float, hi: float) -> tuple[int, int]:
        af = 0
        try:
            for line in open(os.path.join(D, 'quiet-driver-frames.jsonl'), encoding='utf8'):
                if not line.strip():
                    continue
                f = json.loads(line)
                if f.get('kind') != 'action-frame' or str(f.get('goalId')) != args.target:
                    continue
                m = ms_of(f.get('ts'))
                if m is not None and lo <= m < hi:
                    af += 1
        except Exception:  # noqa: BLE001
            pass
        pc = sum(1 for c in changes if str(c.get('goalId')) == args.target
                 and (ms_of(c.get('ts')) or -1) >= lo and (ms_of(c.get('ts')) or -1) < hi)
        return af, pc

    now_ms = datetime.datetime.now().timestamp() * 1000.0
    if not expectation:
        rev = {'verdict': 'none', 'reason': '未预登记恢复腿预期 ⇒ 无从评估(事后叙事不予采信)'}
    elif now_ms < check_at:
        rev = {'verdict': 'pending', 'reason': '复核时点未到(结束 + %g 分钟)' % args.reversal_window_min}
    else:
        af, pc = counts_in(end_ms, check_at)
        rev = {'verdict': 'met' if (af + pc) > 0 else 'unmet',
               'actionFrames': af, 'poolChanges': pc,
               'reason': ('窗口结束后 %g 分钟内该目标有 %d 条行动帧 + %d 条池变更 ⇒ 恢复腿兑现'
                          % (args.reversal_window_min, af, pc)) if (af + pc) > 0 else
                         ('窗口结束后 %g 分钟内该目标零行动帧、零池变更 ⇒ 恢复腿未兑现'
                          '(门→可驱动这条链可能断了, 与唤醒机制无关)' % args.reversal_window_min)}

    if args.reversal_eval:
        row = {'ts': datetime.datetime.now().astimezone().isoformat(), 'event': 'reversal', 'target': args.target,
               'startIso': datetime.datetime.fromtimestamp(start_ms / 1000).astimezone().isoformat(),
               'endIso': datetime.datetime.fromtimestamp(end_ms / 1000).astimezone().isoformat(),
               'checkAt': datetime.datetime.fromtimestamp(check_at / 1000).astimezone().isoformat(),
               'expectation': expectation[:300], 'verdict': rev['verdict'], 'detail': rev}
        with open(OUT, 'a', encoding='utf8') as f:
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
        print('恢复腿复核 %s | 结束 %s + %g 分钟 ⇒ %s' % (args.target, row['endIso'][11:16],
                                                         args.reversal_window_min, rev['verdict']))
        print('  预期: %s' % (expectation[:160] or '(未登记)'))
        print('  %s' % rev['reason'])
        return {'met': 0, 'unmet': 1, 'none': 2, 'pending': 3}[rev['verdict']]

    payload = {'ts': datetime.datetime.now().astimezone().isoformat(), 'target': args.target,
               'baselineSource': baseline_src,
               'startIso': datetime.datetime.fromtimestamp(start_ms / 1000).astimezone().isoformat(),
               'endIso': datetime.datetime.fromtimestamp(end_ms / 1000).astimezone().isoformat(),
               'hours': round(hours, 2), 'eraSince': era_since,
               'targetBaselineRate': (round(t_rate_b, 3) if t_rate_b is not None else None),
               'targetInterventionRate': (round(t_rate_i, 3) if t_rate_i is not None else None),
               'targetRatio': ratio if ratio is None else (round(ratio, 3) if ratio != float('inf') else 'inf'),
               'framesInWindow': frames_in_window,
               'baselineCoverageHours': round(cov_b, 2), 'interventionCoverageHours': round(cov_i, 2),
               'coverageWarn': coverage_warn,
               'reversalExpectation': expectation[:300],
               'reversalCheckAt': datetime.datetime.fromtimestamp(check_at / 1000).astimezone().isoformat(),
               'reversalPending': rev['verdict'] == 'pending',
               'reversalVerdict': rev['verdict'],
               'controls': controls, 'verdict': verdict, 'reason': reason}
    with open(OUT, 'a', encoding='utf8') as f:
        f.write(json.dumps(payload, ensure_ascii=False) + '\n')
    if args.json:
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    print('干预判读 %s | 窗口 %s → %s(%.1fh, 时代起点 %s)'
          % (args.target, payload['startIso'][11:16], payload['endIso'][11:16], hours, era_since))
    print('  目标推进速率: 基线 %s → 干预 %s 次/h(比 %s) | 基线来源: %s'
          % ('不可判' if t_rate_b is None else format(t_rate_b, '.3f'),
             '不可判' if t_rate_i is None else format(t_rate_i, '.3f'), payload['targetRatio'], baseline_src))
    print('  时代覆盖: 基线 %.1fh / 干预 %.1fh(窗口 %.1fh)%s'
          % (cov_b, cov_i, span / 3600000.0, '  ⚠ 基线覆盖不足 ⇒ 因果结论降级' if coverage_warn else ''))
    print('  对照: %s' % json.dumps(controls, ensure_ascii=False))
    print('判读: %s —— %s' % (verdict, reason))
    return 0


if __name__ == '__main__':
    sys.exit(main())
