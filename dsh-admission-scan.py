#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-admission-scan.py — cl-053 三参数(容量/准入/退出)在当前库规模下的**同口径**复算。

为什么重写(2026-09-13 11:2x 自我纠正): 本脚本第一版把"元素"错当成**索引词表**(把词表裁到 k 个词),
于是 idf-topk 档命中率恒为 0%, 判出"cl-053 准入不再拟合、退出规则无判别力"——**两条结论都错**,
错在**总体定义**而不是库变了: cl-053 的"元素"是**当前情境文本抽出的查询元素**(检索池), 不是索引词表。
正是 exp_298 的教训(指标要先验证总体定义, 再拿去做结论)。本版逐条对齐
`~/.dsh/cognitive-pipeline/experiment-lexical-channel-20260909.md` 的口径:

  · 库 = experiences.jsonl(任务经验); ground truth = 同 chainId; 留一法; 判据 = **top-1** 是否落在同链;
  · 词元素通道 = **单字** BM25(该文档结论③: 单字粒度足够), 另跑 bigram 一列作对照;
  · 池 = 查询元素里被准入的那部分(准入前候选 = 该行文本的去重元素);
  · 三张表: 容量扫描(准入=按 IDF 取前 k) / 准入规则(统一 k=150) / 退出策略(容量压力 k=60)。

判据(先写死, 防事后解释):
  · 容量: 命中率随 k 基本单调上升且"全部"档最高 ⇒ 仍拟合"容量由成本定不由精度定";
  · 准入: k=150 下 `IDF 前150` 须为各规则最高; 落后最佳替代规则 >2pp ⇒ 需重标定;
  · 退出: 该档 cl-053 是「保留最近 73% > 内容词 69%」, 复算看是否仍成立(以数说话)。

用法: python3 dsh-admission-scan.py [--query situation|full]
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
from collections import Counter

D = os.environ.get('DSH_COG_DIR') or os.path.expanduser('~/.dsh/cognitive-pipeline')
KS = [3, 5, 10, 20, 40, 80, 150]
ADMIT_K = 150
EVICT_K = 60
FIT_TOL_PP = 2.0


def load():
    path = os.path.join(D, 'experiences.jsonl')
    if not os.path.exists(path):
        print('[admission] 读不到经验库: %s' % path, file=sys.stderr)
        return None
    return [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]


def full_text(r):
    s = r.get('sar') or {}
    return f"{s.get('situation', '')} {s.get('action', '')} {s.get('outcome', '')}"


def situation_text(r):
    return str((r.get('sar') or {}).get('situation') or '')


def chars(t):
    """单字元素(cl-053 主表口径): 中文按字, 英文/数字按词。"""
    out = []
    for m in re.finditer(r'[\u4e00-\u9fff]+|[a-zA-Z0-9_]+', t):
        seg = m.group(0)
        if re.match(r'[a-zA-Z0-9_]', seg):
            out.append(seg.lower())
        else:
            out.extend(seg)
    return out


def bigrams(t):
    out = []
    for m in re.finditer(r'[\u4e00-\u9fff]+|[a-zA-Z0-9_]+', t):
        seg = m.group(0)
        if re.match(r'[a-zA-Z0-9_]', seg):
            out.append(seg.lower())
        elif len(seg) > 1:
            out.extend(seg[i:i + 2] for i in range(len(seg) - 1))
        else:
            out.append(seg)
    return out


class BM25:
    def __init__(self, docs, tok):
        self.tok = [tok(d) for d in docs]
        self.tf = [Counter(d) for d in self.tok]
        self.df = Counter()
        for d in self.tok:
            for w in set(d):
                self.df[w] += 1
        self.N = len(self.tok)
        self.avgdl = sum(len(d) for d in self.tok) / max(self.N, 1)

    def idf(self, w):
        return math.log(1 + (self.N - self.df[w] + 0.5) / (self.df[w] + 0.5))

    def score(self, q, i, k1=1.5, b=0.75):
        s = 0.0
        dl = len(self.tok[i]) or 1
        for w in q:
            f = self.tf[i].get(w, 0)
            if f == 0:
                continue
            s += self.idf(w) * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / self.avgdl))
        return s

    def top1_same_chain_rate(self, rows, pool_fn):
        targets = []
        for i, r in enumerate(rows):
            if not r.get('chainId'):
                continue
            if any(j != i and rows[j].get('chainId') == r['chainId'] for j in range(len(rows))):
                targets.append(i)
        if not targets:
            return None
        hit = 0
        for i in targets:
            q = pool_fn(i)
            if not q:
                continue
            best_j, best_s = None, float('-inf')
            for j in range(len(rows)):
                if j == i:
                    continue
                s = self.score(q, j)
                if s > best_s:
                    best_s, best_j = s, j
            if best_j is not None and rows[best_j].get('chainId') == rows[i].get('chainId'):
                hit += 1
        return {'targets': len(targets), 'hit': hit, 'rate': hit / len(targets)}


def stale_tests(rows, ns=(0, 50, 100, 200, 400), cap=150, mode='idf'):
    """cl-053 §3b/3c **陈旧元素污染**复算(2026-09-13 12:4x, 由 cl-296.nextAction ① 驱动)。

    原实验(09-09, 130 条库)的两张表:
      (b) 池 = 本情境 150 个 IDF 元素 + N 个来自**其他情境**的陈旧元素 → 76/78/73/76/**69**(N=400 才掉);
      (c) 容量**固定 150**、陈旧元素只能挤入剩余空间 → 50/100/200 个陈旧元素时命中恒为 76%。
    结论曾是"陈旧污染自限 ⇒ 退出策略不需要时间衰减机制"。本函数把它放到**当前库**上复算, 判据先写死:
      · (b) 若 N=400 相对 N=0 的降幅 >5pp ⇒ 污染**不自限**(旧结论作废, 需要衰减或更强的挤出规则);
      · (c) 若各 N 相对 N=0 的偏差 >±2pp ⇒ "只剩剩余空间时自限"不成立。

    口径与前面的表一致(单字 BM25 · 全文查询 · 留一法 top-1 同链), 陈旧元素取自**异链**行的全文;
    为保持确定性, 陈旧元素按 IDF 降序取(不随机抽样)。
    → ({'b': [(N, rate, targets)], 'c': [...], 'room': 有剩余空间的目标数/目标总数}, 说明)
    """
    docs = [full_text(r) for r in rows]
    bm = BM25(docs, chars)
    elems = [chars(d) for d in docs]
    chains = [r.get('chainId') for r in rows]

    # 2026-09-13 13:2x **考古所得(cl-053 §3b 的原始构造)**: 旧实验的脚本(逐字取自 09-09 备份的会话日志,
    # turn 966)用的是 **随机抽一行、取它的前 5 个元素**(random.seed(0)) —— 不是按 IDF 取异链罕见元素。
    # 两者测的不是同一个强度: 原版 ≈ "随手掺进旧元素"(句首多为常见词, 区分度低), 本脚本默认 ≈ 最坏情况
    # (IDF 最高的异链元素)。故支持两种构造, 让"旧数字能否复现"成为可判的问题而不是猜测。
    import random as _r

    def legacy_stale(i, noise):
        _r.seed(0)
        out = []
        others = [j for j in range(len(rows)) if j != i]
        guard = 0
        while len(out) < noise and guard < noise * 50:
            j = _r.choice(others)
            out.extend(elems[j][:5])
            guard += 1
        return out[:noise]

    def foreign_pool(i):
        acc = set()
        for j, e in enumerate(elems):
            if j != i and chains[j] != chains[i]:
                acc.update(e)
        return sorted(acc, key=lambda w: (-bm.idf(w), w))

    out_b, out_c = [], []
    room_ok = 0
    targets = 0
    for n in ns:
        hitb = totb = 0
        hitc = totc = 0
        room_ok = 0
        targets = 0
        for i in range(len(rows)):
            if not chains[i] or not any(j != i and chains[j] == chains[i] for j in range(len(rows))):
                continue
            targets += 1
            own = list(dict.fromkeys(elems[i]))
            own_top = sorted(own, key=lambda w: (-bm.idf(w), w))[:cap]
            if n == 0:
                stale = []
            elif mode == 'legacy-random':
                stale = legacy_stale(i, n)
            else:
                stale = foreign_pool(i)[:n]
            # (b) 本情境 IDF 前150 + N 个陈旧元素(总量可超过 cap)
            b = _top1_is_same_chain(bm, rows, i, set(own_top) | set(stale))
            if b is not None:
                totb += 1
                hitb += 1 if b else 0
            # (c) 容量固定 cap: 陈旧元素只能填**剩余空间**
            room = cap - len(own_top)
            if room > 0:
                room_ok += 1
                c = _top1_is_same_chain(bm, rows, i, set(own_top) | set(stale[:room]))
                if c is not None:
                    totc += 1
                    hitc += 1 if c else 0
        out_b.append((n, hitb / totb if totb else float('nan'), totb))
        out_c.append((n, hitc / totc if totc else float('nan'), totc))
    return {'b': out_b, 'c': out_c, 'room': room_ok, 'targets': targets}, \
        '库 %d 条, 目标 %d; 有剩余空间(own<%d)的目标 %d' % (len(rows), targets, cap, room_ok)


def _top1_is_same_chain(bm, rows, i, pool):
    """给第 i 行一个查询池, 看留一法 top-1 是否落在同链 → True/False/None(池空)。"""
    if not pool:
        return None
    best_j, best_s = None, float('-inf')
    for j in range(len(rows)):
        if j == i:
            continue
        sc = bm.score(pool, j)
        if sc > best_s:
            best_s, best_j = sc, j
    if best_j is None:
        return None
    return rows[best_j].get('chainId') == rows[i].get('chainId')


def bootstrap(rows, seeds=(1, 2, 3, 4, 5), frac=0.8):
    """稳定性检查(2026-09-13 12:2x, 由 cl-296.nextAction ① 驱动): 本脚本是**确定性**的, 所以"再跑一遍"
    只会得到同一串数字 —— 那不叫稳定性。真正要回答的是"截断劣势是不是单次抽样的偶然": 故对库做
    N 次 80% 子抽样, 每次重算 同一批 k 档下 `IDF 前 k` 与 `全收` 的命中率差, 报分布。

    → ([(k, [gap...])], 说明)。gap = 全收命中率 − IDF 前 k 命中率(正 = 截断更差)。
    """
    import random as _rnd
    gaps = {k: [] for k in (20, 40, 60)}
    for sd in seeds:
        rr = _rnd.Random(sd)
        sub = rr.sample(rows, max(10, int(len(rows) * frac)))
        docs = [full_text(r) for r in sub]
        bm = BM25(docs, chars)
        elems = [chars(full_text(r)) for r in sub]
        base = bm.top1_same_chain_rate(sub, lambda i: set(elems[i]))
        if base is None:
            continue
        for k in gaps:
            r2 = bm.top1_same_chain_rate(sub, lambda i, k=k: set(sorted(dict.fromkeys(elems[i]),
                                                                        key=lambda w: (-bm.idf(w), w))[:k]))
            if r2 is not None:
                gaps[k].append(base['rate'] - r2['rate'])
    return gaps, '库 %d 条, %d 次 80%% 子抽样' % (len(rows), len(seeds))


def main() -> int:
    rows = load()
    if not rows:
        return 3
    mode = 'full'
    if '--query' in sys.argv:
        idx = sys.argv.index('--query')
        if idx + 1 < len(sys.argv):
            mode = sys.argv[idx + 1]
    docs = [full_text(r) for r in rows]
    queries = docs if mode == 'full' else [situation_text(r) for r in rows]
    print('经验 %d 条 | 查询口径 = %s | 判据 = 留一法 top-1 同链'
          % (len(rows), '全文(可与 cl-053 的 76% 直接对照)' if mode == 'full' else 'situation 段(更接近生产语义)'))
    print('对照文档 experiment-lexical-channel-20260909.md(当时库 130 条 / 同链样本 49)')

    for tok, label in ((chars, '单字'), (bigrams, 'bigram')):
        bm = BM25(docs, tok)
        elems = [tok(q) for q in queries]
        print('\n=== 粒度 %s ===' % label)
        print('容量扫描(准入 = 按 IDF 取前 k):')
        rates = []
        for k in KS + [10 ** 9]:
            labelk = '全部' if k > 10 ** 8 else str(k)
            r = bm.top1_same_chain_rate(rows, lambda i, k=k: set(sorted(dict.fromkeys(elems[i]),
                                                                       key=lambda w: (-bm.idf(w), w))[:k]))
            if r is None:
                print('  无同链样本')
                return 3
            rates.append(r['rate'])
            print('  %-6s 命中率 %5.1f%%  (目标 %d 条)' % (labelk, r['rate'] * 100, r['targets']))
        mono = all(rates[i] <= rates[i + 1] + 0.02 for i in range(len(rates) - 1))
        print('  判读: %s(cl-053: 3→53%%, 40→67%%, 150→73%%, 全部→76%%)'
              % ('基本单调上升 ⇒ 容量仍由成本定' if mono else '**明显非单调 ⇒ 该结论不再成立**'))

        print('准入规则(统一 k=%d):' % ADMIT_K)
        def by_idf(i, k=ADMIT_K):
            return set(sorted(dict.fromkeys(elems[i]), key=lambda w: (-bm.idf(w), w))[:k])
        rules = [
            ('全收(去重)', lambda i: set(elems[i])),
            ('丢 df>50%', lambda i: {w for w in set(elems[i]) if bm.df[w] / max(bm.N, 1) <= 0.50}),
            ('丢 df>30%', lambda i: {w for w in set(elems[i]) if bm.df[w] / max(bm.N, 1) <= 0.30}),
            ('只收 df>=2', lambda i: {w for w in set(elems[i]) if bm.df[w] >= 2}),
            ('IDF 前%d' % ADMIT_K, by_idf),
        ]
        scored = {}
        for name, fn in rules:
            r = bm.top1_same_chain_rate(rows, fn)
            scored[name] = r['rate']
            print('  %-12s 命中率 %5.1f%%  lift(对全收) %.3f'
                  % (name, r['rate'] * 100, r['rate'] / max(scored['全收(去重)'], 1e-9)))
        # 2026-09-13 11:2x: k=150 **对该口径是退化的** —— 查询行的去重元素数本身常在 150 以下,
        # 于是"IDF 前150"=全收, 各规则给出**同一个集合**、同一串数字(实测五档全等 69.3%)。那不是
        # "IDF 排序最优"的证据, 而是"没比"。真正的准入比较必须落在 k < 池大小 的档位上, 故补一张表。
        pool_sizes = [len(set(e)) for e in elems]
        pool_sizes.sort()
        med_pool = pool_sizes[len(pool_sizes) // 2] if pool_sizes else 0
        print('  查询元素去重数: 中位 %d, 最大 %d, <150 的行 %d/%d ⇒ k=150 该表%s'
              % (med_pool, pool_sizes[-1] if pool_sizes else 0,
                 sum(1 for s in pool_sizes if s < ADMIT_K), len(pool_sizes),
                 '退化(各规则同一集合), 不作为证据' if med_pool < ADMIT_K else '有判别空间'))
        print('准入规则(按容量档, 只在 k < 池大小 处才有判别力):')
        for kk in (20, 40, 60):
            cells = []
            for name, fn in (('全收', None), ('丢df>50%', lambda i, kk=kk: {w for w in set(elems[i])
                                                                          if bm.df[w] / max(bm.N, 1) <= 0.50}),
                             ('IDF前%d' % kk, lambda i, kk=kk: by_idf(i, kk)),
                             ('最近%d' % kk, lambda i, kk=kk: set(elems[i][-kk:]))):
                r = bm.top1_same_chain_rate(rows, fn if fn else (lambda i: set(elems[i])))
                cells.append('%s %5.1f%%' % (name, r['rate'] * 100))
            print('  k=%-4d %s' % (kk, ' | '.join(cells)))
        print('  判读: 看同一 k 下 IDF 排序是否≥其它档(cl-053 的准入结论要在**这个**表上验, 不是上面那张)。')

        best_other = max(v for k2, v in scored.items() if k2 != 'IDF 前%d' % ADMIT_K)
        gap = (best_other - scored['IDF 前%d' % ADMIT_K]) * 100
        print('  判读: IDF 排序 %s(cl-053: IDF 76%% > 丢df>50%% 73%% > 全收 71%%)'
              % ('仍为最优 ⇒ 准入参数仍拟合' if gap <= FIT_TOL_PP
                 else '**落后最佳替代规则 %.1fpp ⇒ 需重标定**' % gap))

        print('退出策略(容量压力 k=%d):' % EVICT_K)
        def content(i, k=EVICT_K):
            tf = Counter(elems[i])
            return set(sorted(tf, key=lambda w: (-(bm.idf(w) * tf[w]), w))[:k])
        ev = [('挤出最低 IDF(=IDF 前%d)' % EVICT_K, lambda i: by_idf(i, EVICT_K)),
              ('保留最近出现(文本尾部)', lambda i: set(elems[i][-EVICT_K:])),
              ('保留最早出现(文本头部)', lambda i: set(elems[i][:EVICT_K])),
              ('保留内容词(IDF×频次)', content)]
        for name, fn in ev:
            r = bm.top1_same_chain_rate(rows, fn)
            print('  %-24s 命中率 %5.1f%%' % (name, r['rate'] * 100))
        print('  判读: cl-053 在该档是「保留最近 73%% > 内容词 69%%」; 是否仍成立以上面的数说话。')

    print('\n未复算(明确标注, 不假装覆盖): 陈旧元素污染测试(cl-053 §3b/3c) —— 需跨情境注入陈旧元素, 本脚本不做。')
    if '--stale' in sys.argv:
        # --stale-ns 允许自定义 N 档(2026-09-13 12:5x: 检验"伤害 ∝ N/库规模"这条密度假说 —— 固定 N 时
        # 小库的每条文档摊到的异链陈旧元素更多, 故要把 N 按库规模缩放后再比)。
        ns = (0, 50, 100, 200, 400)
        if '--stale-ns' in sys.argv:
            ns = tuple(int(x) for x in sys.argv[sys.argv.index('--stale-ns') + 1].split(','))
        mode = 'idf'
        if '--stale-mode' in sys.argv:
            mode = sys.argv[sys.argv.index('--stale-mode') + 1]
        st, note = stale_tests(rows, ns=ns, mode=mode)
        print('\n=== cl-053 §3b/3c 陈旧元素污染复算(%s; 构造=%s) ===' % (note, mode))
        print('(b) 本情境 IDF 前150 + N 个异链陈旧元素:')
        base_b = None
        for n, rate, tot in st['b']:
            if n == 0:
                base_b = rate
            print('   N=%-4d 命中率 %5.1f%%  (目标 %d)%s'
                  % (n, rate * 100, tot, '' if n == 0 else '  相对 N=0: %+.1fpp' % (100 * (rate - (base_b or rate)))))
        worst = min(rate for n, rate, _ in st['b'] if n == 400) if any(n == 400 for n, _, _ in st['b']) else None
        if worst is not None and base_b is not None:
            drop = 100 * (base_b - worst)
            print('   判读: N=400 相对 N=0 降 %.1fpp ⇒ %s(cl-053: 76%%→69%%, 掉 7pp 但仍"可用")'
                  % (drop, '**>5pp: 污染不自限, 旧结论作废, 需要衰减/更强挤出**' if drop > 5
                     else '≤5pp: 与 cl-053 同向(自限)'))
        print('(c) 容量固定 150, 陈旧元素只填剩余空间:')
        base_c = None
        for n, rate, tot in st['c']:
            if n == 0:
                base_c = rate
            print('   N=%-4d 命中率 %5.1f%%  (有空间的目标 %d)%s'
                  % (n, rate * 100, tot, '' if n == 0 else '  相对 N=0: %+.1fpp' % (100 * (rate - (base_c or rate)))))
        devs = [abs(100 * (rate - (base_c or rate))) for n, rate, _ in st['c'] if n != 0]
        if devs:
            print('   判读: 各 N 相对 N=0 的最大偏差 %.1fpp ⇒ %s(cl-053: 恒 76%%, 即偏差≈0)'
                  % (max(devs), '"仅剩剩余空间"时自限 **不成立**' if max(devs) > 2 else '与 cl-053 同向(自限)'))
        print('   覆盖说明: 本库查询元素去重数中位已 >150, 只有 %d/%d 个目标真有"剩余空间" ⇒ (c) 的样本比原实验薄, 读数要按这个分母读。'
              % (st['room'], st['targets']))
    if '--bootstrap' in sys.argv:
        gaps, note = bootstrap(rows)
        print('\n=== 稳定性(截断劣势是不是单次抽样偶然): %s ===' % note)
        for k in sorted(gaps):
            g = gaps[k]
            if not g:
                continue
            worse = sum(1 for x in g if x > 0)
            print('  k=%-4d 全收−IDF前k 的差: 中位 %+.1fpp, 最小 %+.1fpp, 最大 %+.1fpp; **%d/%d 次截断更差**'
                  % (k, 100 * statistics.median(g), 100 * min(g), 100 * max(g), worse, len(g)))
        allworse = all(sum(1 for x in gaps[k] if x > 0) == len(gaps[k]) for k in gaps if gaps[k])
        print('  判读: %s' % ('每一次抽样里截断都更差 ⇒ cl-296 的"任何截断都更差"**不是单次噪声**'
                              if allworse else '存在抽样中截断不更差的情形 ⇒ cl-296 该条需按分布重述(不得写成普遍结论)'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
