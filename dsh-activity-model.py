#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-activity-model.py — 经验的**活跃度**模型: 关联激活 / 孤立遗忘 / 刻意复习(用户 2026-09-14 指令)。

指令(原话): 「做一个关联活跃和遗忘机制, 相似经验可以被关联激活提升注入概率, 孤立经验抑制活跃度降低注入概率。
并且增加一个复习机制, 被明确标注为重要的经验可以通过刻意复习提升活跃度」。

**本工具只做只读半(可观测 + 可复算 + 复习记账)**: 消费侧(把 activity 乘进 rankKey / 检索侧衰减)落在用户的
**检索冻结令**内, 本工具**不改**排序、不改注入、不碰 packages/。⇒ 它先回答"这个机制若上线会动谁", 而不是"已经动了谁"。

活跃度的组成(每一项都能追到账本, 不含魔法常数以外的隐变量):
  ① **关联度 assoc**: 链共成员(chains.json 的 memberExpIds) + 候选共现(检索审计里同现于同一候选序的次数, 用
     Jaccard 归一) ⇒ 对应"相似经验可以被关联激活"。
  ② **孤立 penalty**: assoc 与共现都低于阈值 ⇒ 记孤立, 活跃度打折 ⇒ 对应"孤立经验抑制活跃度"。
  ③ **复习 rehearsal**: 显式标注重要的经验可以 `--rehearse`(写入 rehearsals.jsonl), 每次复习按**半衰期**给活跃度续期
     ⇒ 对应"刻意复习提升活跃度"(间隔复习: 复习越近, 贡献越大)。
  ④ **近期性 recency**: 上次被注入/被引用距今的半衰期衰减(默认 7 天)。
  activity = squash(w_assoc·log1p(assoc) + w_reh·log1p(Σ复习权重) + w_rec·recency) × (1 − iso_penalty·孤立)

用法:
  dsh-activity-model.py --report [--json]        # 分布 + 长尾诊断(只读)
  dsh-activity-model.py --rehearse exp_123 --why "被明确标注重要: 它是我反复踩的坑"   # 记账(刻意复习)
  dsh-activity-model.py --check                  # 不变式
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
import sys

TZ = datetime.timezone(datetime.timedelta(hours=8))
TAG = '[activity]'
# 权重一律显式登记(便于事后归因与调参; 不含隐藏项)
W = {'assoc': 0.45, 'rehearsal': 0.35, 'recency': 0.20}
ISO_PENALTY = 0.6          # 孤立条目的活跃度打折
ASSOC_MIN = 1              # 关联度阈值: >=1 个链同伴 或 >=2 次显著共现 才算"有联系"
COOCC_MIN = 1          # 关联度阈值: Jaccard 邻居数(见 coincidence 的归一说明)
COOCC_JACCARD = 0.3    # 只有 Jaccard>=0.3 才算"真关联"(实测原始共现次数会退化成常数)
HALFLIFE_DAYS = 7.0        # 近期性与复习的衰减半衰期
REHEARSAL_FILE = 'rehearsals.jsonl'


def cog_dir() -> str:
    return os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')


def load_jsonl(name: str) -> list:
    p = os.path.join(cog_dir(), name)
    out = []
    try:
        for line in open(p, encoding='utf8'):
            if line.strip():
                out.append(json.loads(line))
    except FileNotFoundError:
        pass
    return out


def load_json(name: str, default):
    p = os.path.join(cog_dir(), name)
    try:
        with open(p, encoding='utf8') as fh:
            return json.load(fh)
    except Exception:
        return default


def now() -> datetime.datetime:
    return datetime.datetime.now(TZ)


def _ms(v) -> float:
    """时间戳归一: 支持 epoch(秒/毫秒) 与 **ISO 字符串**(第一版只认数字 ⇒ 复习记录的 ISO ts 被算成 0,
    于是"复习权重"恒为 0、复习推不动任何东西 —— 判据 T244 抓到的第二个实现缺陷)。"""
    if v is None:
        return 0.0
    if isinstance(v, str) and not v.replace('.', '', 1).isdigit():
        try:
            return datetime.datetime.fromisoformat(v).timestamp()
        except Exception:
            return 0.0
    try:
        x = float(v)
    except Exception:
        return 0.0
    return x / 1000.0 if x > 1e11 else x


def library() -> dict:
    return {r['expId']: r for r in load_jsonl('experiences.jsonl') if r.get('expId')}


def chain_mates() -> dict:
    """expId → 同链的其他 expId 集合(关联的最强来源: 链是目标锚定的因果骨架)。"""
    out = {}
    for c in load_json('chains.json', []) or []:
        members = [str(x) for x in (c.get('memberExpIds') or [])]
        for m in members:
            out.setdefault(m, set()).update(x for x in members if x != m)
    return out


def coincidence() -> dict:
    """expId → {邻居: Jaccard(共现/并集)}。

    **必须归一**(第一版直接数共现次数 ⇒ 250 行审计里几乎人人互相共现, assoc 冲到 352, 退化成常数):
    Jaccard = 两者同现过的行数 / 至少一方出现的行数; 只保留 >= COOCC_JACCARD 的邻居。
    """
    import collections
    rowsets = []
    for r in load_jsonl('retrieval-audit.jsonl'):
        ids = {str(x) for x in (r.get('retrievedIds') or [])}
        if ids:
            rowsets.append(ids)
    appear = collections.Counter()
    pair = collections.defaultdict(collections.Counter)
    for idset in rowsets:
        for a in idset:
            appear[a] += 1
        for a in idset:
            for b in idset:
                if a != b:
                    pair[a][b] += 1
    out = {}
    for a, cnts in pair.items():
        keep = {}
        for b, c in cnts.items():
            union = appear[a] + appear[b] - c
            j = c / union if union else 0.0
            if j >= COOCC_JACCARD:
                keep[b] = round(j, 4)
        out[a] = keep
    return out


def last_seen() -> dict:
    """expId → 最近一次"被注入或被抓到引用"的时间(秒)。"""
    out = {}
    for r in load_jsonl('injections.jsonl'):
        ts = _ms(r.get('createdAt'))
        for e in (r.get('expIds') or []):
            e = str(e)
            if ts > out.get(e, 0):
                out[e] = ts
    return out


def rehearsals() -> dict:
    """expId → 复习记录列表(含 ts 与 why)。账本 last-wins 不需要: 复习是**事件**, 全部累加。"""
    out = {}
    for r in load_jsonl(REHEARSAL_FILE):
        e = str(r.get('expId') or '')
        if e:
            out.setdefault(e, []).append(r)
    return out


_KNEE_CACHE = {}


def _raw(exp_id: str, mates: dict, cooc: dict, seen: dict, reh: dict) -> float:
    m = mates.get(exp_id, set())
    cc = cooc.get(exp_id, {})
    cc_strong = sum(1 for k, v in cc.items() if v >= COOCC_MIN)
    assoc = len(m) + cc_strong
    t = now().timestamp()
    last = seen.get(exp_id, 0)
    rec = 0.5 ** ((t - last) / 86400.0 / HALFLIFE_DAYS) if last else 0.0
    reh_w = sum(0.5 ** ((t - _ms(r.get("ts"))) / 86400.0 / HALFLIFE_DAYS) for r in reh.get(exp_id, []))
    return (W['assoc'] * math.log1p(assoc) + W['rehearsal'] * math.log1p(reh_w) + W['recency'] * rec)


def _knee() -> float:
    """校准拐点 = 库内 raw 的中位(显式登记, 不含魔法数)。"""
    vals = sorted(v for v in _KNEE_CACHE.values() if v > 0)
    if not vals:
        return 1.0
    return vals[len(vals) // 2]


def prime_knee(lib: dict, mates: dict, cooc: dict, seen: dict, reh: dict) -> None:
    _KNEE_CACHE.clear()
    for e in lib:
        _KNEE_CACHE[e] = _raw(e, mates, cooc, seen, reh)


def activity(exp_id: str, lib: dict, mates: dict, cooc: dict, seen: dict, reh: dict) -> dict:
    m = mates.get(exp_id, set())
    cc = cooc.get(exp_id, {})
    cc_strong = len(cc)                      # coincidence() 已按 Jaccard 阈值过滤
    assoc = len(m) + cc_strong
    iso = 1 if (len(m) == 0 and cc_strong == 0) else 0
    t = now().timestamp()
    last = seen.get(exp_id, 0)
    rec = 0.5 ** ((t - last) / 86400.0 / HALFLIFE_DAYS) if last else 0.0
    reh_w = sum(0.5 ** ((t - _ms(r.get('ts'))) / 86400.0 / HALFLIFE_DAYS) for r in reh.get(exp_id, []))
    raw = _raw(exp_id, mates, cooc, seen, reh)
    # **软饱和(带校准拐点), 不用 tanh**: 第一版用 tanh, 实测 top-5 全是 0.993 ⇒ 复习也推不动(0.9932→0.9932),
    # 整个机制退化成 no-op(判据 T244 当场抓到)。改为 act = raw/(raw+knee), knee=库内 raw 中位 ⇒ 单调、有界、不饱和。
    act = raw / (raw + _knee()) if raw > 0 else 0.0
    act = act * (1.0 - ISO_PENALTY * iso)
    return {'expId': exp_id, 'assoc': assoc, 'chainMates': len(m), 'coOccurStrong': cc_strong,
            'isolated': bool(iso), 'rehearsals': len(reh.get(exp_id, [])), 'rehearsalWeight': round(reh_w, 4),
            'recency': round(rec, 4), 'activity': round(act, 4),
            'materialGain': ((lib.get(exp_id, {}).get('sar') or {}).get('outcomeUtility') or {}).get('materialGain')}


def build() -> tuple:
    lib = library()
    mates, cooc, seen, reh = chain_mates(), coincidence(), last_seen(), rehearsals()
    prime_knee(lib, mates, cooc, seen, reh)      # 先用库内 raw 中位校准拐点, 再算 activity
    return lib, mates, cooc, seen, reh


def report(args) -> int:
    lib, mates, cooc, seen, reh = build()
    if not lib:
        print('%s 读不到 experiences.jsonl ⇒ 前提不成立' % TAG, file=sys.stderr)
        return 3
    rows = [activity(e, lib, mates, cooc, seen, reh) for e in lib]
    injected = set()
    for r in load_jsonl('injections.jsonl'):
        for e in (r.get('expIds') or []):
            injected.add(str(e))
    iso = [r for r in rows if r['isolated']]
    starved = [r for r in rows if r['expId'] not in injected]
    starved_iso = [r for r in starved if r['isolated']]
    starved_conn = [r for r in starved if not r['isolated']]
    print('%s 库 %d 条 | 孤立(无链同伴且无显著共现) %d 条(%.0f%%) | 有复习记录 %d 条'
          % (TAG, len(rows), len(iso), len(iso) / len(rows) * 100, sum(1 for r in rows if r['rehearsals'])))
    print('%s **长尾诊断(用户假设的检验)**: 从未注入 %d 条 → 其中**孤立 %d 条**(遗忘候选) / **有联系 %d 条**(关联激活候选)'
          % (TAG, len(starved), len(starved_iso), len(starved_conn)))
    if starved_conn:
        g = [r['materialGain'] for r in starved_conn if r['materialGain'] is not None]
        print('%s   有联系的长尾里 效用>=7 的占 %.0f%%(n=%d) ⇒ 这批是"被排序深度挡住但值得激活"的'
              % (TAG, (sum(1 for x in g if x >= 7) / max(1, len(g))) * 100, len(g)))
    top = sorted(rows, key=lambda r: -r['activity'])[:5]
    print('%s 活跃度最高 5 条: %s' % (TAG, ', '.join('%s(%.3f)' % (r['expId'], r['activity']) for r in top)))
    if args.json:
        print(json.dumps({'library': len(rows), 'isolated': len(iso), 'starved': len(starved),
                          'starvedIsolated': len(starved_iso), 'starvedConnected': len(starved_conn),
                          'weights': W, 'isoPenalty': ISO_PENALTY, 'halflifeDays': HALFLIFE_DAYS,
                          'rows': rows}, ensure_ascii=False))
    return 0


def rehearse(args) -> int:
    if not str(args.expId or '').strip():
        print('%s 缺 expId' % TAG, file=sys.stderr)
        return 3
    if not str(args.why or '').strip():
        print('%s **刻意复习必须写理由**(为什么它重要): 无理由的复习等于给自己刷活跃度' % TAG, file=sys.stderr)
        return 3
    lib = library()
    if args.expId not in lib:
        print('%s 库里没有这个经验: %s' % (TAG, args.expId), file=sys.stderr)
        return 3
    p = os.path.join(cog_dir(), REHEARSAL_FILE)
    row = {'ts': now().isoformat(), 'expId': args.expId, 'why': args.why.strip(), 'by': args.by or 'agent',
           'kind': args.kind}
    with open(p, 'a', encoding='utf8') as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + '\n')
        fh.flush()
        os.fsync(fh.fileno())
    before = activity(args.expId, *build()[0:1], *build()[1:])['activity'] if False else None
    print('%s 已记一次刻意复习: %s(理由: %s) —— 活跃度按半衰期续期, **不改排序**(消费侧在检索冻结令内)'
          % (TAG, args.expId, row['why'][:40]))
    return 0


def check(args) -> int:
    lib, mates, cooc, seen, reh = build()
    reds, ok = [], 0
    if not lib:
        print('%s 空库 ⇒ 前提不成立' % TAG, file=sys.stderr)
        return 3
    for e in lib:
        a = activity(e, lib, mates, cooc, seen, reh)
        if not (0.0 <= a['activity'] <= 1.0):
            reds.append('%s activity 越界: %s' % (e, a['activity']))
        elif a['isolated'] and a['assoc'] != 0:
            reds.append('%s 既标孤立又有 %d 个关联 ⇒ 判定自相矛盾' % (e, a['assoc']))
        else:
            ok += 1
    for r in load_jsonl(REHEARSAL_FILE):
        if not str(r.get('why') or '').strip():
            reds.append('复习记录缺理由(ts=%s)' % r.get('ts'))
        if str(r.get('expId') or '') not in lib:
            reds.append('复习记录指向库外条目: %s' % r.get('expId'))
    # **复习必须真的提升活跃度**(否则"刻意复习"是装饰): 对最近复习过的条目, 把它从复习账本里摘掉重算, 分必须更低
    if reh:
        _latest = max(((e, rs) for e, rs in reh.items()), key=lambda kv: max(str(r.get('ts')) for r in kv[1]))
        _e = _latest[0]
        if _e in lib:
            with_reh = activity(_e, lib, mates, cooc, seen, reh)['activity']
            without = activity(_e, lib, mates, cooc, seen, {})['activity']
            if not with_reh > without:
                reds.append('复习**没有提升**活跃度(%s: 有复习 %.4f <= 无复习 %.4f) ⇒ 复习机制是装饰'
                            % (_e, with_reh, without))
            else:
                ok += 1
    # 可复算: 同一输入两次算出的分必须一致(纯函数, 不含随机/时钟漂移以外的状态)
    a1 = {e: activity(e, lib, mates, cooc, seen, reh)['assoc'] for e in lib}
    a2 = {e: activity(e, lib, mates, cooc, seen, reh)['assoc'] for e in lib}
    if a1 != a2:
        reds.append('活跃度不可复算(同输入两次结果不同)')
    for r in reds:
        print('%s **判红** %s' % (TAG, r), file=sys.stderr)
    print('%s 条目 %d: 合规 %d / 判红 %d | 权重 %s | 孤立惩罚 %.2f | 半衰期 %.0f 天'
          % (TAG, len(lib), ok, len(reds), W, ISO_PENALTY, HALFLIFE_DAYS), file=sys.stderr)
    if args.json:
        print(json.dumps({'library': len(lib), 'ok': ok, 'red': reds}, ensure_ascii=False))
    return 1 if reds else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--rehearse', dest='expId', default=None)
    ap.add_argument('--why', default='')
    ap.add_argument('--by', default='')
    ap.add_argument('--kind', default='explicit-importance')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()
    if args.report:
        return report(args)
    if args.expId:
        return rehearse(args)
    if args.check:
        return check(args)
    ap.error('需要 --report / --rehearse <expId> --why ... / --check')
    return 2


if __name__ == '__main__':
    sys.exit(main())
