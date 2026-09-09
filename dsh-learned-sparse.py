#!/usr/bin/env python3
"""dsh-learned-sparse.py — 学习式稀疏权重第一步（SPLADE 思路，用**引用反馈**训练词权重）。

目标池 goal-retrieval-optimization 的第 ② 项：把"词元素通道"的均匀 IDF 权重换成
**由反馈学出来的词权重**。本脚本是它的离线第一步，不写管线状态：

  · 信号：每条经验的 `citationCount`（被注入后被模型引用过几次）——机器可核，非自评。
  · 学到的权重：`w(t) = (1 + 被引用文档数(t)) / (1 + 含 t 的文档数(t))`，再做均值归一化。
    直觉：一个词如果经常出现在"真被用上"的经验里，它对检索的判别力更强。
  · 判据：留一法同链 recall@5（与 dsh-injection-bound.py 同口径）——**加权后不得低于加权前**，
    否则该权重无价值（"离线涨、线上不动"的反面：离线不涨就不上线）。

用法: python3 dsh-learned-sparse.py
"""
import json, math, os, re, sys
from collections import Counter, defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')


def load():
    rows = []
    for name in ('experiences.jsonl',):
        path = os.path.join(D, name)
        if not os.path.exists(path):
            continue
        for line in open(path, encoding='utf8'):
            if line.strip():
                rows.append(json.loads(line))
    return rows


def text(r):
    s = r.get('sar') or {}
    return f"{s.get('situation', '')} {s.get('action', '')} {s.get('outcome', '')}"


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
    def __init__(self, docs, weights=None):
        self.tok = [bigrams(d) for d in docs]
        self.tf = [Counter(d) for d in self.tok]
        self.df = Counter()
        for d in self.tok:
            for w in set(d):
                self.df[w] += 1
        self.N = len(self.tok)
        self.avgdl = sum(len(d) for d in self.tok) / max(self.N, 1)
        self.weights = weights or {}

    def score(self, q, i, k1=1.5, b=0.75):
        s = 0.0
        dl = len(self.tok[i]) or 1
        for w in set(q):
            f = self.tf[i].get(w, 0)
            if f == 0:
                continue
            idf = math.log(1 + (self.N - self.df[w] + 0.5) / (self.df[w] + 0.5))
            tw = self.weights.get(w, 1.0)
            s += tw * idf * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / self.avgdl))
        return s


def recall_at_k(bm, docs, rows, targets, k=5):
    hit = 0
    for i in targets:
        scored = []
        q = bigrams(docs[i])
        for j in range(len(rows)):
            if j == i:
                continue
            scored.append((bm.score(q, j), j))
        scored.sort(reverse=True)
        if any(rows[j].get('chainId') == rows[i].get('chainId') for _, j in scored[:k]):
            hit += 1
    return hit / max(len(targets), 1)


def main() -> int:
    rows = load()
    docs = [text(r) for r in rows]
    by_chain = defaultdict(list)
    for i, r in enumerate(rows):
        if r.get('chainId'):
            by_chain[r['chainId']].append(i)
    targets = [i for ch, mem in by_chain.items() if len(mem) > 1 for i in mem]
    if not targets:
        print('无同链样本，无法评估')
        return 1

    # ── 学权重: 引用率(t) = (1 + 被引用文档数) / (1 + 文档数) ──
    cited_docs = Counter()
    all_docs = Counter()
    for r in rows:
        cited = (r.get('citationCount') or 0) > 0
        for term in set(bigrams(text(r))):
            all_docs[term] += 1
            if cited:
                cited_docs[term] += 1
    raw = {t: (1 + cited_docs[t]) / (1 + all_docs[t]) for t in all_docs}
    mean = sum(raw.values()) / max(len(raw), 1)
    weights = {t: v / mean for t, v in raw.items()}

    # 方案 B: 结构性信号(同链集中度) —— 引用样本仅 27 条时的替代信号。
    term_chains = defaultdict(set)
    term_docs = Counter()
    for i, r in enumerate(rows):
        ch = r.get('chainId')
        for term in set(bigrams(docs[i])):
            term_docs[term] += 1
            if ch:
                term_chains[term].add(ch)
    chain_weights = {}
    for term, df in term_docs.items():
        chains = len(term_chains.get(term, ()))
        chain_weights[term] = 1.0 if chains == 0 else 1.0 + math.log(1 + df / chains) / 3.0
    plain = BM25(docs)
    weighted = BM25(docs, weights)
    chain_weighted = BM25(docs, chain_weights)
    r_plain = recall_at_k(plain, docs, rows, targets)
    r_weighted = recall_at_k(weighted, docs, rows, targets)
    r_chain = recall_at_k(chain_weighted, docs, rows, targets)

    print(f'经验 {len(rows)} 条｜有同链兄弟 {len(targets)} 条｜词表 {len(weights)} 个元素')
    print(f'被引用过的经验 {sum(1 for r in rows if (r.get("citationCount") or 0) > 0)} 条')
    print(f'\n留一法同链 recall@5:')
    print(f'  均匀 IDF(现状)      {r_plain * 100:.1f}%')
    print(f'  引用反馈加权        {r_weighted * 100:.1f}%   (Δ {(r_weighted - r_plain) * 100:+.1f}pp)')
    print(f'  同链集中度加权      {r_chain * 100:.1f}%   (Δ {(r_chain - r_plain) * 100:+.1f}pp)')
    top = sorted(weights.items(), key=lambda kv: -kv[1])[:8]
    bottom = sorted(weights.items(), key=lambda kv: kv[1])[:8]
    print(f'\n加权最高的元素: {[f"{t}×{w:.2f}" for t, w in top]}')
    print(f'加权最低的元素: {[f"{t}×{w:.2f}" for t, w in bottom]}')
    best = max(r_weighted, r_chain)
    verdict = '值得进下一步(离线有增益)' if best > r_plain else '不上线(离线无增益)'
    print(f'\n判读: {verdict}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
