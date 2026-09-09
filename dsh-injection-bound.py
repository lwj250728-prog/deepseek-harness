#!/usr/bin/env python3
"""dsh-injection-bound.py — WikiSkill 式去混淆：把"知识好不好"与"检索得到吗"分开量。

参照：WikiSkill (arXiv 2608.27454) 刻意用 full-injection（把候选知识全部注入）把
"检索/触发失败"排除为混淆变量，只研究知识本身的质量。我们的对应实验：

  ① 检索损失(recall 侧)：留一法下，同链真相关项是否落在 top-K。
     K 越大 → 越接近"全量注入"。K=all 时 recall 恒为 100%（上界按构造）。
     检索损失 = 1 − recall@K —— 这是"检索没送到"造成的损失。
  ② 知识缺口(knowledge 侧)：同链兄弟不存在时，再好的检索器也无能为力。
     本脚本按链规模统计"有多少经验根本没有任何同链兄弟"= 知识缺口下界。
  ③ 上界对照：把 K 从 1 拉到 all 时 recall 的增益 = "扩窗能拿回多少"；
     拿不回的部分（= 知识缺口）只能靠写新知识，不能靠改检索。

只用离线数据（experiences.jsonl 的 embedding/actionVector + chainId），不写管线状态。
用法：python3 dsh-injection-bound.py [--k 1,3,5,10,20,all]
"""
import json, math, os, re, sys
from collections import Counter, defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
KS = [1, 3, 5, 10, 20, 'all']


def load():
    rows = [json.loads(l) for l in open(f'{D}/experiences.jsonl', encoding='utf8') if l.strip()]
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


def cos(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return d / (na * nb) if na and nb else 0.0


def main():
    ks = KS
    if '--k' in sys.argv:
        raw = sys.argv[sys.argv.index('--k') + 1].split(',')
        ks = [int(x) if x != 'all' else 'all' for x in raw]

    rows = load()
    texts = [text(r) for r in rows]
    b25 = BM25(texts)

    by_chain = defaultdict(list)
    for i, r in enumerate(rows):
        if r.get('chainId'):
            by_chain[r['chainId']].append(i)
    targets = [i for ch, mem in by_chain.items() if len(mem) > 1 for i in mem]
    single = [i for i, r in enumerate(rows)
              if r.get('chainId') and len(by_chain[r['chainId']]) == 1]

    print(f'经验 {len(rows)} 条；有同链兄弟 {len(targets)} 条；链内独苗 {len(single)} 条'
          f'；无链 {len(rows) - len(targets) - len(single)} 条')

    # ① recall@K（混合通道：0.5·embedding + 0.5·词级BM25，与既有实验同口径）
    def rank_list(i):
        scored = []
        for j in range(len(rows)):
            if j == i:
                continue
            emb = cos(rows[i].get('embedding') or rows[i].get('actionVector') or [],
                      rows[j].get('embedding') or rows[j].get('actionVector') or [])
            s = 0.5 * emb + 0.5 * b25.score(bigrams(texts[i]), j)
            scored.append((s, j))
        scored.sort(reverse=True)
        return [j for _, j in scored]

    print('\n检索损失（留一法，ground truth = 同链）：')
    ranks = {}
    for i in targets:
        ranks[i] = rank_list(i)
    for k in ks:
        hit = 0
        for i in targets:
            rl = ranks[i]
            window = rl if k == 'all' else rl[:k]
            if any(rows[j].get('chainId') == rows[i].get('chainId') for j in window):
                hit += 1
        rec = hit / len(targets) if targets else 0.0
        loss = 1 - rec
        tag = '（上界·按构造）' if k == 'all' else ''
        print(f'  recall@{k!s:<3} = {rec * 100:5.1f}%   检索损失 = {loss * 100:5.1f}% {tag}')

    # ③ 扩窗增益
    r1 = sum(1 for i in targets if any(rows[j].get('chainId') == rows[i].get('chainId') for j in ranks[i][:1])) / max(len(targets), 1)
    rall = 1.0
    print(f'\n扩窗能拿回: {rall - r1:.0%}（K=1 → all）；'
          f'拿不回的部分只能靠写新知识，不能靠改检索。')

    # ② 知识缺口下界
    total = len(rows)
    if total:
        gap = len(single) / total
        print(f'知识缺口下界（链内独苗，检索器无能为力）: {len(single)}/{total} = {gap:.0%}；'
              f'无链经验 {len(rows) - len(targets) - len(single)} 条无法判定相关性。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
