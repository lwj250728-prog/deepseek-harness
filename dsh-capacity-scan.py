#!/usr/bin/env python3
"""dsh-capacity-scan.py — 容量/准入/退出参数的规模敏感性扫描（goal-retrieval-optimization 第 ③ 项）。

问题：现有 173 条经验，检索池/窗口/IDF 准入这些参数是**在小库上标定的**。
库长大以后它们还成立吗？本脚本用"子采样模拟不同库规模"回答，不写管线状态：

  · 对 N ∈ {50, 100, 150, 全部} 各取一个固定随机种子子样本；
  · 子样本内按同链 ground truth 算留一法 recall@5；
  · 同时报词表规模(去重元素数)、平均文档长度、以及"查询词在库中的中位 df"
    ——df 是 IDF 的输入，库长大时 df 上升会让判别力下降。

判据（写死，防事后解释）：
  · recall@5 随 N 增长**下降 >5pp** → 需要重标定（窗口/准入/衰减）；
  · 下降 ≤5pp → 当前参数仍可用，等更大库再扫。

用法: python3 dsh-capacity-scan.py
"""
import json, math, os, random, re, statistics, sys
from collections import Counter, defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
SEED = 20260910
NS = [50, 100, 150, 0]  # 0 = 全量


def load():
    path = os.path.join(D, 'experiences.jsonl')
    return [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]


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
    def __init__(self, docs):
        self.tok = [bigrams(d) for d in docs]
        self.tf = [Counter(d) for d in self.tok]
        self.df = Counter()
        for d in self.tok:
            for w in set(d):
                self.df[w] += 1
        self.N = len(self.tok)
        self.avgdl = sum(len(d) for d in self.tok) / max(self.N, 1)

    def score(self, q, i, k1=1.5, b=0.75):
        s = 0.0
        dl = len(self.tok[i]) or 1
        for w in set(q):
            f = self.tf[i].get(w, 0)
            if f == 0:
                continue
            idf = math.log(1 + (self.N - self.df[w] + 0.5) / (self.df[w] + 0.5))
            s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / self.avgdl))
        return s


def evaluate(rows, docs, k=5):
    by_chain = defaultdict(list)
    for i, r in enumerate(rows):
        if r.get('chainId'):
            by_chain[r['chainId']].append(i)
    targets = [i for ch, mem in by_chain.items() if len(mem) > 1 for i in mem]
    if not targets:
        return None
    bm = BM25(docs)
    hit = 0
    for i in targets:
        q = bigrams(docs[i])
        scored = sorted(((bm.score(q, j), j) for j in range(len(rows)) if j != i), reverse=True)
        if any(rows[j].get('chainId') == rows[i].get('chainId') for _, j in scored[:k]):
            hit += 1
    vocab = len(bm.df)
    med_df = statistics.median([bm.df.get(w, 0) for w in set(bigrams(docs[targets[0]]))]) if targets else 0
    return {'n': len(rows), 'targets': len(targets), 'recall': hit / len(targets),
            'vocab': vocab, 'avgdl': bm.avgdl, 'median_df': med_df}


def main() -> int:
    rows = load()
    rnd = random.Random(SEED)
    print(f'经验 {len(rows)} 条（种子 {SEED}）')
    print(f"{'N':>6} {'同链样本':>8} {'recall@5':>9} {'词表':>7} {'平均长度':>8} {'查询词中位df':>12}")
    results = []
    for n in NS:
        sample = rows if n == 0 or n >= len(rows) else rnd.sample(rows, n)
        r = evaluate(sample, [text(x) for x in sample])
        if r is None:
            print(f'{len(sample):>6}  (无同链样本, 跳过)')
            continue
        results.append(r)
        print(f"{r['n']:>6} {r['targets']:>8} {r['recall'] * 100:>8.1f}% {r['vocab']:>7} "
              f"{r['avgdl']:>8.1f} {r['median_df']:>12.1f}")
    # ── 修正版: 固定目标集, 只加"干扰文档" ──
    # 上面的子采样把目标集和干扰集一起换, 结果被样本组成主导(50 条时 recall 100% 是
    # 小池假象)。这里固定全部同链目标, 只按 K 递增地掺入随机干扰文档, 隔离"库变大"的净效应。
    by_chain = defaultdict(list)
    for i, r in enumerate(rows):
        if r.get('chainId'):
            by_chain[r['chainId']].append(i)
    fixed_targets = [i for ch, mem in by_chain.items() if len(mem) > 1 for i in mem]
    pool_rest = [i for i in range(len(rows)) if i not in set(fixed_targets)]
    print(f"\n固定目标集 {len(fixed_targets)} 条, 只增干扰文档(隔离库规模效应):")
    print(f"{'干扰数':>7} {'总库':>6} {'recall@5':>9}")
    fixed_results = []
    for extra in (0, 50, 100, 200):
        rnd2 = random.Random(SEED)
        distr = rnd2.sample(pool_rest, min(extra, len(pool_rest)))
        idx = fixed_targets + distr
        sub_rows = [rows[i] for i in idx]
        docs2 = [text(x) for x in sub_rows]
        r2 = evaluate(sub_rows, docs2)
        if r2:
            fixed_results.append(r2)
            print(f"{extra:>7} {r2['n']:>6} {r2['recall'] * 100:>8.1f}%")
    if len(fixed_results) >= 2:
        loss = (fixed_results[0]['recall'] - fixed_results[-1]['recall']) * 100
        print(f"\n固定目标集口径: 干扰从 {fixed_results[0]['n'] - len(fixed_targets)} 增到 "
              f"{fixed_results[-1]['n'] - len(fixed_targets)} 条, recall@5 损失 {loss:.1f}pp")
        if loss > 5:
            print('判读: 干扰增加导致召回损失 >5pp → 库规模再翻倍时需重标定窗口/准入/衰减参数(当前仍可用)')
        else:
            print('判读: 容量敏感性 ≤5pp → 当前参数可用')

    if len(results) >= 2:
        drop = (results[0]['recall'] - results[-1]['recall']) * 100
        print(f"\n[子采样口径] 最小库({results[0]['n']}) → 最大库({results[-1]['n']}): {drop:+.1f}pp"
              f"（注意: 该口径下目标集也在变, 主要反映样本组成而非容量）")
        print('判读: 以"固定目标集 + 只增干扰"那一栏为准; 子采样栏仅作对照。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
