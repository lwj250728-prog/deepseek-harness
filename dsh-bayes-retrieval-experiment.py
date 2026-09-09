#!/usr/bin/env python3
"""贝叶斯/词元素检索通道可行性实验（2026-09-09 01:1x，用户提案驱动）

用户提案：主对话持续抽取单字与词语元素入检索池 → 用池中元素组合去匹配经验库；
经验库收录时由 LLM 抽出"特征词组"作为匹配对象。

检验方法（离线、留一法、不写管线状态）：
  · ground truth = chainId（同链=真相关；5 条链共 49 条经验）
  · 三个通道各自取 top-1，看是否落在同链：
      A. embedding 余弦（现状语义通道，bge-m3 1024 维）
      B. 词级 BM25（中文 bigram + 英文词，覆盖 情境+行动+结果 全文）
      C. 存储的 actionKeywords 词级匹配（仅词级关键词的记录参与）
      D. 混合 A+B
  · 另测：字符级 BM25（单字，即用户说的"单字元素"）——验证单字是否够用
"""
import json, math, os, re
from collections import defaultdict, Counter

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
rows = [json.loads(l) for l in open(f'{D}/experiences.jsonl', encoding='utf8') if l.strip()]
print(f"经验 {len(rows)} 条")

def sar(r): return r.get('sar') or {}
def text(r):
    s = sar(r)
    return f"{s.get('situation','')} {s.get('action','')} {s.get('outcome','')}"

# ── 分词 ─────────────────────────────────────────────
def bigrams(t):
    """中文 bigram + 英文/数字词——中文检索的标准做法"""
    out = []
    for m in re.finditer(r'[\u4e00-\u9fff]+|[a-zA-Z0-9_]+', t):
        seg = m.group(0)
        if re.match(r'[a-zA-Z0-9_]', seg):
            out.append(seg.lower())
        else:
            out.extend(seg[i:i+2] for i in range(len(seg)-1)) if len(seg) > 1 else out.append(seg)
    return out

def chars(t):
    return [c for c in t if '\u4e00' <= c <= '\u9fff'] + re.findall(r'[a-zA-Z0-9_]+', t.lower())

# ── BM25 ────────────────────────────────────────────
class BM25:
    def __init__(self, docs, tokenizer):
        self.tok = tokenizer
        self.docs = [tokenizer(d) for d in docs]
        self.tf = [Counter(d) for d in self.docs]
        self.df = Counter()
        for d in self.docs:
            for w in set(d): self.df[w] += 1
        self.N = len(self.docs)
        self.avgdl = sum(len(d) for d in self.docs) / max(self.N, 1)
    def score(self, q, i, k1=1.5, b=0.75):
        s = 0.0
        dl = len(self.docs[i]) or 1
        for w in set(q):
            f = self.tf[i].get(w, 0)
            if f == 0: continue
            idf = math.log(1 + (self.N - self.df[w] + 0.5) / (self.df[w] + 0.5))
            s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * dl / self.avgdl))
        return s

def cos(a, b):
    if not a or not b or len(a) != len(b): return 0.0
    d = sum(x*y for x, y in zip(a, b))
    na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(x*x for x in b))
    return d/(na*nb) if na and nb else 0.0

texts = [text(r) for r in rows]
b25_bigram = BM25(texts, bigrams)
b25_char = BM25(texts, chars)

# 关键词通道（仅词级关键词的记录）
word_kw_idx = [i for i, r in enumerate(rows)
               if (sar(r).get('actionKeywords') or []) and
               sum(len(k) for k in sar(r)['actionKeywords'])/len(sar(r)['actionKeywords']) > 1.6]
b25_kw = BM25([ ' '.join(sar(rows[i]).get('actionKeywords') or []) for i in range(len(rows))], bigrams)

# ── ground truth: chainId ───────────────────────────
by_chain = defaultdict(list)
for i, r in enumerate(rows):
    if r.get('chainId'): by_chain[r['chainId']].append(i)
targets = [i for ch, mem in by_chain.items() if len(mem) > 1 for i in mem]
print(f"带链且有同链兄弟的样本: {len(targets)} 条 (链: {[(k[:20], len(v)) for k, v in by_chain.items() if len(v) > 1]})\n")

def top1_same_chain(score_fn, name):
    hit = 0
    for i in targets:
        best_j, best_s = None, -1e9
        for j in range(len(rows)):
            if j == i: continue
            s = score_fn(i, j)
            if s > best_s: best_s, best_j = s, j
        if best_j is not None and rows[best_j].get('chainId') == rows[i].get('chainId'):
            hit += 1
    print(f"  {name:<28} top-1 同链命中 {hit}/{len(targets)} = {hit/len(targets)*100:.0f}%")
    return hit/len(targets)

print("留一法 top-1 检索（ground truth = 同链）:")
r_emb = top1_same_chain(lambda i, j: cos(rows[i].get('embedding') or rows[i].get('actionVector'), rows[j].get('embedding') or rows[j].get('actionVector')), "A. embedding 余弦")
r_bi = top1_same_chain(lambda i, j: b25_bigram.score(bigrams(texts[i]), j), "B. 词级 BM25(bigram)")
r_ch = top1_same_chain(lambda i, j: b25_char.score(chars(texts[i]), j), "C. 单字 BM25(用户'单字元素')")
def hybrid(i, j):
    return 0.5*cos(rows[i].get('embedding') or [], rows[j].get('embedding') or []) + 0.5*b25_bigram.score(bigrams(texts[i]), j)
r_hy = top1_same_chain(hybrid, "D. 混合(0.5A+0.5B)")

print(f"\n判定: 词级BM25 {'优于' if r_bi > r_emb else '不优于'} embedding "
      f"({r_bi:.0%} vs {r_emb:.0%}); 单字BM25 {'可用' if r_ch >= r_bi*0.8 else '明显弱于词级'}")

# ── 追加(2026-09-09 10:0x): 现有多通道融合 vs 词元素通道(cl-052 前提回归) ──
def _cos(a, b):
    if not a or not b or len(a) != len(b): return 0.0
    d = sum(x*y for x, y in zip(a, b)); na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(x*x for x in b))
    return d/(na*nb) if na and nb else 0.0

class _BM25:
    def __init__(self, docs):
        self.docs = [chars(d) for d in docs]
        self.tf = [Counter(d) for d in self.docs]
        self.df = Counter()
        for d in self.docs:
            for w in set(d): self.df[w] += 1
        self.N = len(self.docs); self.avgdl = sum(len(d) for d in self.docs)/max(self.N, 1)
    def score(self, q, i, k1=1.5, b=0.75):
        s = 0.0; dl = len(self.docs[i]) or 1
        for w in set(q):
            f = self.tf[i].get(w, 0)
            if not f: continue
            idf = math.log(1 + (self.N - self.df[w] + 0.5)/(self.df[w] + 0.5))
            s += idf * f * (k1 + 1)/(f + k1 * (1 - b + b * dl/self.avgdl))
        return s

_full = [text(r) for r in rows]
_bm = _BM25(_full)

def _top1(fn):
    hit = 0
    for i in targets:
        bj, bs = None, -1e9
        for j in range(len(rows)):
            if j == i: continue
            s = fn(i, j)
            if s > bs: bs, bj = s, j
        if bj is not None and rows[bj].get('chainId') == rows[i].get('chainId'): hit += 1
    return round(hit/len(targets)*100)

_fuse = lambda i, j: (_cos(rows[i].get('embedding') or [], rows[j].get('embedding') or [])
                      + _cos(rows[i].get('outcomeVector') or [], rows[j].get('outcomeVector') or [])
                      + _cos(rows[i].get('actionVector') or [], rows[j].get('actionVector') or []))
print("\n多通道 vs 词元素通道:")
print("  融合(语义+结果+行动, 等权)  %d%%" % _top1(_fuse))
print("  词元素通道(单字BM25·全文)   %d%%" % _top1(lambda i, j: _bm.score(chars(_full[i]), j)))
