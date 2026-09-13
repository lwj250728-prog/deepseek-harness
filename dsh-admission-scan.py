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
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
