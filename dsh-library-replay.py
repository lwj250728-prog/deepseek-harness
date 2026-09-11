#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""经验库排序影子对照(tp-115 / cl-185): 同一候选集内比较三档排序。

判据**预登记**在 library-replay-baseline.json(先写死再跑, T135 守顺序纪律):
  · primary: 候选集内 MRR 提升 ≥10% 才把效用项接进注入排序
  · secondary: top-1 命中率不得下降
  · falsify: 三档 MRR 差 ≈0 ⇒ 排序非瓶颈, 转经验生成侧
  · retire: 效用项 MRR 升 <10% ⇒ 退役效用通道
标签 = **外生量**(效用分档), 不用引用(引用在暴露下游, 会与 B4 塌缩混淆)。

数据来源: retrieval-audit.jsonl 的 injected 记录里的 candidateScores([{expId, similarity}])。
样本不足(minSample=30)时**只报计数不下结论**。

用法: dsh-library-replay.py [--json]
退出码: 0 = 出数(含样本不足时的计数报告); 1 = 缺前置。
"""
from __future__ import annotations

import json
import os
import sys

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
AUDIT = os.path.join(D, 'retrieval-audit.jsonl')
EXP = os.path.join(D, 'experiences.jsonl')
BASE = os.path.join(D, 'library-replay-baseline.json')
EXP_FRAMES = os.path.join(D, 'experiences-frames.jsonl')
OUT = os.path.join(D, 'library-replay-result.json')


def channel_weights() -> dict:
    """学习到的通道权重(cl-173 的消费对象; 由引用反馈训练)。"""
    p = os.path.join(D, 'channel_weights.json')
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding='utf8'))
    except Exception:
        return {}


def label_map(kind: str) -> dict:
    """相关性标签。**必须与排序特征分离**, 否则指标自证(cl-219 实测的缺陷)。

    · gain   = materialGain —— B 档的特征里就含它 ⇒ **同义反复**, 只能当占位, 不能当证据;
    · valence= emotionalValence —— 同一自陈家族但不进 B 档特征, 非自证;
    · cited  = 结果侧(该经验真实被引用) —— 预登记明确排除作**主标签**(下游混淆), 但作为独立稳健性检查可用。
    """
    out = {}
    for path in (EXP, EXP_FRAMES):
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf8'):
            if not line.strip():
                continue
            r = json.loads(line)
            ou = (r.get('sar') or {}).get('outcomeUtility') or {}
            v = ou.get('materialGain' if kind == 'gain' else 'emotionalValence')
            if isinstance(v, (int, float)):
                out[r['expId']] = float(v)
    return out


def utility_map() -> dict:
    """效用映照: **任务经验 + 帧层经验都要收**。
    cl-200 实测: 39 条带得分记录里, 只查任务经验时只有 18 条"候选全有效用", 可排序集 5;
    并入帧层经验(experiences-frames.jsonl)后 39/39 全覆盖, 可排序集 5→11。
    少查一半经验库, 判据的样本就被凭空砍掉一半。"""
    out = {}
    for path in (EXP, EXP_FRAMES):
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf8'):
            if not line.strip():
                continue
            r = json.loads(line)
            ou = (r.get('sar') or {}).get('outcomeUtility') or {}
            g = ou.get('materialGain')
            if isinstance(g, (int, float)):
                out[r['expId']] = float(g)
    return out


def main() -> int:
    args = sys.argv[1:]
    if not os.path.exists(BASE):
        print('缺预登记: %s(判据必须先写死)' % BASE, file=sys.stderr)
        return 1
    base = json.load(open(BASE, encoding='utf8'))
    util = utility_map()
    records = []
    for line in open(AUDIT, encoding='utf8'):
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get('stage') != 'injected':
            continue
        # cl-200: 优先用**截断前**的候选清单(preTop, 部署后才有); 旧行回退到 candidateScores。
        cands = r.get('preTop') or r.get('candidateScores')
        if cands:
            r['candidateScores'] = cands
            records.append(r)

    def mrr(arm: str, L: dict, label_kind: str) -> tuple[float | None, float | None]:
        """候选集内 MRR / top-1 命中率。相关性来自 L(与排序特征分离的标签)。"""
        vals, hits, n = [], 0, 0
        for rec in records:
            cands = [c for c in rec['candidateScores'] if c.get('expId') in util]  # 效用表决定候选可用性
            if arm == 'C':
                cands = [c for c in cands if isinstance(c.get('channels'), dict)]
            if len(cands) < 2:
                continue          # 单候选集无排序可言
            if label_kind == 'cited':
                # 结果侧标签: 该记录里**真实被引用**的那条经验才是相关项; 只算被引用者恰在候选集内的记录。
                if rec.get('cited') is not True:
                    continue
                inj = [e for e in (rec.get('expIds') or []) if any(c['expId'] == e for c in cands)]
                if len(inj) != 1:
                    continue
                n += 1
                ranked = sorted(cands, key=(lambda c: c['similarity']) if arm == 'A'
                                else (lambda c: c['similarity'] * (0.7 + 0.06 * util[c['expId']])))
                for idx, c in enumerate(ranked, start=1):
                    if c['expId'] == inj[0]:
                        vals.append(1.0 / idx)
                        if idx == 1:
                            hits += 1
                        break
                continue
            n += 1
            if arm == 'A':
                key = lambda c: c['similarity']
            elif arm == 'B':
                key = lambda c: c['similarity'] * (0.7 + 0.06 * util[c['expId']])   # 效用项(线性加权)
            else:
                # C 档(cl-173/cl-185): 用**学习到的通道权重**替换注入路径里写死的常数。
                # 现行打分 = semantic + symptom + axis(三个成分直接相加); 这里给前两个成分各乘上
                # channel_weights 里对应的学习权重(axis 不是学习通道, 保持原样)。
                key = lambda c: (
                    c['channels']['semantic'] * float(W.get('semantic', 1.0))
                    + c['channels']['symptom'] * float(W.get('symptom', 1.0))
                    + c['channels']['axis']
                )
            ranked = sorted(cands, key=key, reverse=True)
            best = max(L[c['expId']] for c in cands)
            for idx, c in enumerate(ranked, start=1):
                if L[c['expId']] == best:
                    vals.append(1.0 / idx)
                    if idx == 1:
                        hits += 1
                    break
        if not n:
            return None, None
        return sum(vals) / n, hits / n

    W = channel_weights()
    LABELS = {'gain': label_map('gain'), 'valence': label_map('valence')}
    a, a1 = mrr('A', LABELS['gain'], 'gain')      # 兼容旧结果字段
    b, b1 = mrr('B', LABELS['gain'], 'gain')
    c_arm, c1 = mrr('C', LABELS['gain'], 'gain')
    label_reports = {}
    for lk in ('gain', 'valence', 'cited'):
        L = LABELS.get(lk) or LABELS['gain']
        ra, ra1 = mrr('A', L, lk)
        rb, rb1 = mrr('B', L, lk)
        label_reports[lk] = {'armA_mrr': ra, 'armA_top1': ra1, 'armB_mrr': rb, 'armB_top1': rb1,
                             'lift': (round((rb - ra) / ra, 4) if ra and rb is not None else None),
                             'tautological': lk == 'gain'}
    c_rankable = sum(1 for rec in records
                     if len([x for x in rec['candidateScores']
                             if x.get('expId') in util and isinstance(x.get('channels'), dict)]) >= 2)
    # cl-200: 可排序集 = 候选数>=2 且效用已知的集。**这才是 MRR 的 n**；
    # 之前把"带 candidateScores 的记录数"当成样本量打印(39/30), 而真正的可排序集只有 5 —— 口径错了整整一个数量级。
    rankable = sum(1 for rec in records
                   if len([c for c in rec['candidateScores'] if c.get('expId') in util]) >= 2)
    payload = {
        'rankableSets': rankable,
        'sampleCount': len(records),
        'minSample': base['minSample'],
        'armA_mrr': a, 'armA_top1': a1,
        'armB_mrr': b, 'armB_top1': b1,
        'armC_mrr': c_arm, 'armC_top1': c1, 'armC_rankableSets': c_rankable,
        'armC_status': ('ok' if c_rankable >= base['minSample']
                        else 'insufficient: 带分通道得分的可排序集 %d < %d(埋点已于 2026-09-11 09:0x 上线, 等部署后累积)'
                             % (c_rankable, base['minSample'])),
        'channelWeights': W,
        'lift': (round((b - a) / a, 4) if a and b is not None else None),
        'labelRobustness': label_reports,
        'conclusion': None,
    }
    # 判据必须挂在**可排序集**上: 记录数够但可排序集不够时, MRR 是 5 个集上的估计(实测 lift 的
    # bootstrap 95% 区间 [0.00, 0.33]、只有 41% 的重采样能达到 0.10 门槛) —— 那种"达标"不该接线。
    if rankable < base['minSample']:
        payload['conclusion'] = 'insufficient-rankable-sample'
        payload['note'] = ('可排序集 %d < %d: 记录数 %d 看似够, 但每回合只落了一个候选(topK=1) ⇒ '
                           '排名无从比较, 判据无法裁决; lift %s 仅供参考' % (rankable, base['minSample'], len(records), payload['lift']))
    else:
        payload['conclusion'] = ('wire-utility' if (payload['lift'] or 0) >= 0.10 else 'retire-utility')
        payload['note'] = '可排序集 %d >= %d' % (rankable, base['minSample'])
    json.dump(payload, open(OUT, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
    if '--json' in args:
        print(json.dumps(payload, ensure_ascii=False))
    else:
        print('带得分记录 %d | **可排序集 %d**/%d | A档 MRR %s top1 %s | B档 MRR %s top1 %s | lift %s'
              % (payload['sampleCount'], rankable, payload['minSample'], a, a1, b, b1, payload['lift']))
        print('结论: %s | %s' % (payload['conclusion'], payload.get('note', '')))
        print('C 档(学习权重替换常数): MRR %s top1 %s(可排序集 %d) | %s'
              % (c_arm, c1, c_rankable, payload['armC_status']))
        print('标签稳健性(关键: gain 标签对 B 档是**同义反复**, 只有非 gain 标签才算证据):')
        for lk, v in label_reports.items():
            print('  label=%-7s A %s/%s  B %s/%s  lift %s%s'
                  % (lk, v['armA_mrr'], v['armA_top1'], v['armB_mrr'], v['armB_top1'], v['lift'],
                     '  ← 自证(特征含标签)' if v['tautological'] else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
