#!/usr/bin/env python3
"""注入集噪声指标（cl-102 / tp-065 / T82）。

cl-100 修正后的真实引用率只有 1.28%，而验收线 25% 在"≈1 次注入/回合"的密度下
不可达——天花板不在结算，而在注入集本身。本脚本把"注入集有多脏"变成可追踪指标：

  · frame_born_injection_share  最近 N 条注入中含"帧生经验"的比例
  · frame_born_expid_share      被注入的 expId 里帧生经验的占比
  · static_trigger_share        触发源为静态词匹配的比例
  · cited_true_with_frame_born  历史 cited=true 里含帧生经验的条数

"帧生经验"= 自主帧自身的产出自述被累计成经验（situation 以「自主回合」/「检索路由歧义」
开头，或含「自主回合(无用户在场)」）。它们是自我回声：帧 → 关于帧的经验 → 注入回帧。

判据来源（cl-102 取证，2026-09-10）：
  · 最近 200 条注入 39 条含帧生经验（19.5%）
  · triggerSource 分布 static:异常 239 / static:怎么 116 / static:测试 84 …
  · 历史 13 条 cited=true 中 0 条含帧生经验

用法：dsh-injection-noise.py [--root DIR] [--window 200] [--quiet]
退出码：0 = 指标已落盘且未超阈；1 = 超阈（帧生 >40% 或 静态 >85%）。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import time

FRAME_BORN_PREFIXES = ('自主回合', '检索路由歧义')
FRAME_BORN_MARKER = '自主回合(无用户在场)'
FRAME_BORN_INJECTION_MAX = 0.40
STATIC_TRIGGER_MAX = 0.95
JUMP_CHANNEL_MIN_SAMPLE = 20
JUMP_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000   # 与 service.ts JUMP_EVIDENCE_TTL_MS 对齐


def load_last_wins(path: str, key: str) -> dict[str, dict]:
    """Read an append-only jsonl ledger with last-wins dedup (cl-041)."""
    rows: dict[str, dict] = {}
    if not os.path.exists(path):
        return rows
    with open(path, encoding='utf8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue
            ident = record.get(key)
            if isinstance(ident, str):
                rows[ident] = record
    return rows


def is_frame_born(exp: dict | None) -> bool:
    if not isinstance(exp, dict):
        return False
    situation = ((exp.get('sar') or {}).get('situation') or '')
    return situation.startswith(FRAME_BORN_PREFIXES) or FRAME_BORN_MARKER in situation


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=os.path.expanduser('~/.dsh/cognitive-pipeline'))
    parser.add_argument('--window', type=int, default=200)
    parser.add_argument('--quiet', action='store_true')
    parser.add_argument('--lib', default=os.path.expanduser(
        '~/dsh-fork/packages/context/cognitive-inject/lib/index.js'),
        help='用于取"构建时刻"的产物路径(cl-102 效果见证的截止线)')
    args = parser.parse_args()

    experiences = load_last_wins(os.path.join(args.root, 'experiences.jsonl'), 'expId')
    frames = load_last_wins(os.path.join(args.root, 'experiences-frames.jsonl'), 'expId')
    injections = load_last_wins(os.path.join(args.root, 'injections.jsonl'), 'injectionId')

    def frame_born(exp_id: str) -> bool:
        return is_frame_born(experiences.get(exp_id)) or is_frame_born(frames.get(exp_id))

    ordered = sorted(injections.values(), key=lambda r: r.get('createdAt') or 0)
    window = ordered[-args.window:] if args.window > 0 else ordered

    total_ids = 0
    frame_ids = 0
    with_frame = 0
    static = 0
    for record in window:
        exp_ids = record.get('expIds') or []
        total_ids += len(exp_ids)
        frame_ids += sum(1 for x in exp_ids if frame_born(x))
        if any(frame_born(x) for x in exp_ids):
            with_frame += 1
        if str(record.get('triggerSource') or '').startswith('static:'):
            static += 1

    def trigger_class(source: object) -> str:
        text = str(source or '')
        if text.startswith('static:'):
            return 'static'
        if text.startswith('derived:'):
            return 'derived'
        if text.startswith('jump:'):
            return 'jump'
        return 'other'

    channels: dict[str, dict[str, object]] = {}
    for record in injections.values():
        bucket = channels.setdefault(trigger_class(record.get('triggerSource')),
                                     {'cited': 0, 'uncited': 0, 'rate': None})
        if record.get('cited') is True:
            bucket['cited'] = int(bucket['cited']) + 1
        elif record.get('cited') is False:
            bucket['uncited'] = int(bucket['uncited']) + 1
    for bucket in channels.values():
        settled = int(bucket['cited']) + int(bucket['uncited'])
        bucket['rate'] = round(int(bucket['cited']) / settled, 4) if settled else None

    # 跳词表的世代边界: 每次重建把 updatedAt 刷成当时时刻 => 取最大值即"上次重建"。
    # cl-099 的关键事实: 67 条零引用跳词注入全部来自上一代表(ts/sh/2/草稿...),
    # 当前表(400 条)在 09-10 03:47 重建后才开火过 2 次——用世代边界把两者分开,
    # 否则"退役词表的旧账"会永远压在现代表上。
    jumps_table: dict[str, dict] = {}
    jumps_path = os.path.join(args.root, 'trigger_jumps.json')
    if os.path.exists(jumps_path):
        raw = json.load(open(jumps_path, encoding='utf8'))
        items = raw if isinstance(raw, list) else raw.get('jumps', [])
        for item in items:
            if isinstance(item, dict) and isinstance(item.get('jumpWord'), str):
                jumps_table[item['jumpWord']] = item
    generation_start = max((j.get('updatedAt') or j.get('createdAt') or 0) for j in jumps_table.values()) if jumps_table else 0
    gen_jump_injections = [r for r in injections.values()
                           if str(r.get('triggerSource') or '').startswith('jump:')
                           and (r.get('createdAt') or 0) > generation_start]
    gen_settled = [r for r in gen_jump_injections if r.get('cited') in (True, False)]
    gen_cited = sum(1 for r in gen_settled if r.get('cited') is True)
    now_ms = int(time.time() * 1000)
    stale_zero_evidence = [j['jumpWord'] for j in jumps_table.values()
                           if (j.get('evidenceCount') or 0) == 0
                           and (j.get('hitCount') or 0) == 0
                           and now_ms - (j.get('createdAt') or now_ms) > JUMP_EVIDENCE_TTL_MS]

    # 判据窗口健康度(cl-099 收尾): 跳词判死按"现世代"计, 而世代起点每次重建都会
    # 前移——若重建过于频繁, 窗口永远攒不到样本, 断言就变成永不开火的死判据。
    generation_age_h = (now_ms - generation_start) / 3600000 if generation_start else None
    history_path = os.path.join(args.root, 'injection-noise-history.jsonl')
    rebuilds: set[int] = set()
    if os.path.exists(history_path):
        for line in open(history_path, encoding='utf8'):
            line = line.strip()
            if not line:
                continue
            try:
                stamp = json.loads(line).get('jumpGenerationStart')
            except Exception:
                continue
            if isinstance(stamp, int) and now_ms - stamp < 24 * 3600 * 1000:
                rebuilds.add(stamp)
    if generation_start and now_ms - generation_start < 24 * 3600 * 1000:
        rebuilds.add(generation_start)

    # LLM 变体的世代存活率: 有证据的变体必须跨重建存活(它们才是"刻意的关联网络"),
    # 零证据的允许换代(实测一次重建换了 82/120)。cohort 快照落盘供下次比对。
    cohort_path = os.path.join(args.root, 'jump-cohort.json')
    current_llm = {j['jumpWord'] for j in jumps_table.values() if j.get('source') == 'llm'}
    current_proven = {j['jumpWord'] for j in jumps_table.values()
                      if j.get('source') == 'llm'
                      and ((j.get('citedCount') or 0) > 0 or (j.get('evidenceCount') or 0) > 0)}
    previous: dict | None = None
    if os.path.exists(cohort_path):
        try:
            previous = json.load(open(cohort_path, encoding='utf8'))
        except Exception:
            previous = None
    survival = None
    proven_survival = None
    if isinstance(previous, dict) and previous.get('llm'):
        prev_llm = set(previous['llm'])
        prev_proven = set(previous.get('proven') or [])
        survival = round(len(current_llm & prev_llm) / len(prev_llm), 4) if prev_llm else None
        proven_survival = (round(len(current_proven & prev_proven) / len(prev_proven), 4)
                           if prev_proven else None)
    with open(cohort_path, 'w', encoding='utf8') as fh:
        json.dump({'generatedAt': now_ms, 'llm': sorted(current_llm),
                   'proven': sorted(current_proven)}, fh, ensure_ascii=False)

    # cl-102 效果见证: 构建时刻之后创建的注入里还有没有帧生经验。用产物 mtime
    # 作截止线, 避免"最近 200 条"窗口里长期混着修复前的旧注入而看不出效果。
    build_ms = int(os.path.getmtime(args.lib) * 1000) if os.path.exists(args.lib) else None
    since_build = [r for r in injections.values()
                   if build_ms is not None and (r.get('createdAt') or 0) > build_ms]
    since_build_with_frame = [r for r in since_build
                              if any(frame_born(x) for x in (r.get('expIds') or []))]

    # cl-102 源头见证: 最近 24h 新写入的经验里还有没有帧生的(cl-100 让帧回合不
    # 累计, cl-102 再在累计门挡一层; 这条是"源头是否真的断了"的效果证据)。
    recent_frame_experiences = [e['expId'] for e in experiences.values()
                                if is_frame_born(e)
                                and now_ms - (e.get('timestamp') or 0) < 24 * 3600 * 1000]
    # 拆开两类(2026-09-11 16:4x 实测): 前缀 '检索路由歧义' 既标记"帧回合自述被存成普通经验"
    # (cl-102 要压制的泄漏), 也标记**按设计**产生的元经验(低余量真实回合 → rememberMeta,
    # meta=True, 且已被累计门排除)。原来的单一计数把后者的正常产生算成泄漏: 构建后只要出现一次
    # 低余量预测, 套件就红 —— 判据比设计更严, 红的原因却不是泄漏。
    since_build_frame_experiences = [e['expId'] for e in experiences.values()
                                     if is_frame_born(e) and build_ms is not None
                                     and (e.get('timestamp') or 0) > build_ms]

    cited_true = [r for r in injections.values() if r.get('cited') is True]
    cited_with_frame = sum(1 for r in cited_true if any(frame_born(x) for x in (r.get('expIds') or [])))

    n = len(window)
    metrics = {
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'generatedAtLocal': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'window': n,
        'injectionTotal': len(injections),
        'experienceTotal': len(experiences),
        'frameLayerTotal': len(frames),
        'frameBornInjectionShare': round(with_frame / n, 4) if n else 0.0,
        'frameBornExpIdShare': round(frame_ids / total_ids, 4) if total_ids else 0.0,
        'staticTriggerShare': round(static / n, 4) if n else 0.0,
        'frameBornExperiencesLast24h': len(recent_frame_experiences),
        'frameBornExperiencesSinceBuild': len(since_build_frame_experiences),
        'frameBornExperiencesSinceBuildIds': since_build_frame_experiences[:10],
        # 真泄漏 = 帧味情境却以**普通经验**入库(meta 非真) —— 这才是 cl-102 要断的源。
        'frameBornNonMetaSinceBuild': len([i for i in since_build_frame_experiences
                                           if experiences[i].get('meta') is not True]),
        'frameBornNonMetaSinceBuildIds': [i for i in since_build_frame_experiences
                                          if experiences[i].get('meta') is not True][:10],
        # 按设计产生的元经验(低余量真实回合 / 验收准则偏差), 只报数不判红。
        'frameBornMetaSinceBuild': len([i for i in since_build_frame_experiences
                                        if experiences[i].get('meta') is True]),
        'frameBornExperiencesLast24hIds': recent_frame_experiences[:10],
        'buildCutoffMs': build_ms,
        'injectionsSinceBuild': len(since_build),
        'frameBornSinceBuild': len(since_build_with_frame),
        'citedTrueCount': len(cited_true),
        'citedTrueWithFrameBorn': cited_with_frame,
        'channels': channels,
        'jumpGenerationStart': generation_start,
        'jumpGenerationAgeHours': round(generation_age_h, 2) if generation_age_h is not None else None,
        'jumpRebuildCount24h': len(rebuilds),
        'llmCohortSize': len(current_llm),
        'llmCohortSurvival': survival,
        'llmProvenSurvival': proven_survival,
        'jumpGenerationSettled': len(gen_settled),
        'jumpGenerationCited': gen_cited,
        'jumpTableSize': len(jumps_table),
        'jumpStaleZeroEvidence': len(stale_zero_evidence),
        'jumpStaleZeroEvidenceWords': stale_zero_evidence[:20],
        'jumpTop': sorted(
            ({'word': j['jumpWord'], 'source': j.get('source'),
              'hitCount': j.get('hitCount') or 0, 'citedCount': j.get('citedCount') or 0}
             for j in jumps_table.values()),
            key=lambda x: (-x['hitCount'], -x['citedCount']))[:10],
        'thresholds': {
            'frameBornInjectionShareMax': FRAME_BORN_INJECTION_MAX,
            'staticTriggerShareMax': STATIC_TRIGGER_MAX,
        },
    }
    jump = channels.get('jump') or {'cited': 0, 'uncited': 0, 'rate': None}
    jump_settled = int(jump['cited']) + int(jump['uncited'])
    # 跳词通道有效性(按当前词表世代计): 跳词是学习出来的通道, 本该比静态词精准。
    # 样本不足时空过; 样本够而引用率 0 => 现代表仍只产噪声。
    jump_dead = len(gen_settled) >= JUMP_CHANNEL_MIN_SAMPLE and gen_cited == 0
    # 表项卫生: 零证据且从未开火、且已过证据寿命的条目必须为 0(防永久驻留)。
    jump_stale = len(stale_zero_evidence) > 0
    metrics['jumpChannelSettled'] = jump_settled
    metrics['jumpChannelCited'] = int(jump['cited'])
    metrics['jumpChannelDead'] = jump_dead
    metrics['jumpStaleOverThreshold'] = jump_stale
    metrics['overThreshold'] = (
        metrics['frameBornInjectionShare'] > FRAME_BORN_INJECTION_MAX
        or metrics['staticTriggerShare'] > STATIC_TRIGGER_MAX
        or jump_dead
        or jump_stale
    )

    out = os.path.join(args.root, 'injection-noise.json')
    with open(out, 'w', encoding='utf8') as fh:
        json.dump(metrics, fh, ensure_ascii=False, indent=2)
    with open(os.path.join(args.root, 'injection-noise-history.jsonl'), 'a', encoding='utf8') as fh:
        fh.write(json.dumps(metrics, ensure_ascii=False) + '\n')

    if not args.quiet:
        print('窗口 %d 条注入：帧生 %.1f%%（阈 40%%）｜静态触发 %.1f%%（阈 95%%）｜'
              'cited=true %d 条中帧生 %d 条' % (
                  n, metrics['frameBornInjectionShare'] * 100, metrics['staticTriggerShare'] * 100,
                  len(cited_true), cited_with_frame))
        print('构建后注入 %d 条(含帧生 %d), 构建后新增帧生经验 %d 条(cl-102 效果见证)'
              % (len(since_build), len(since_build_with_frame), len(since_build_frame_experiences)))
        print('通道引用率: ' + '｜'.join(
            '%s %s(%d/%d)' % (k, ('%.1f%%' % (v['rate'] * 100)) if v['rate'] is not None else 'n/a',
                              int(v['cited']), int(v['cited']) + int(v['uncited']))
            for k, v in sorted(channels.items())))
        print('跳词表世代: 年龄 %.1fh, 24h 内重建 %d 次, LLM 变体 %d 条(存活率 %s, 有证据存活率 %s)'
              % (generation_age_h or 0, len(rebuilds), len(current_llm),
                 'n/a' if survival is None else '%.0f%%' % (survival * 100),
                 'n/a' if proven_survival is None else '%.0f%%' % (proven_survival * 100)))
        print('跳词表: %d 条, 上次重建 %s, 现世代已结算 %d 条(引用 %d), 超龄零证据条目 %d'
              % (len(jumps_table),
                 datetime.datetime.fromtimestamp(generation_start / 1000).strftime('%m-%d %H:%M') if generation_start else 'n/a',
                 len(gen_settled), gen_cited, len(stale_zero_evidence)))
        if jump_stale:
            print('红：%d 条零证据跳词已过证据寿命仍驻留(前 5: %s)'
                  % (len(stale_zero_evidence), stale_zero_evidence[:5]), file=sys.stderr)
        if jump_dead:
            print('红：跳词通道 %d 条已结算样本零引用——学习出来的通道比静态词还差，应剪枝或修复'
                  % jump_settled, file=sys.stderr)
    return 1 if metrics['overThreshold'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
