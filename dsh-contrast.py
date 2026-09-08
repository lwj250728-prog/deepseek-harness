#!/usr/bin/env python3
"""dsh-contrast.py — 对照挖掘器（2026-09-09 00:2x 建立，cl-047）

用户类比：勇士们积累了一份"可食用清单"，进一步触发思考——为什么这些品种可食、
另一些不可食？这是从**枚举**到**因果**的一步，原料不是更多同类样本，而是**对照样本**
（可食 vs 不可食，且结果标签可信）。

本工具回答一个问题：**当前经验库里，有没有能支撑"为什么"的材料？**
它做三件事：
  1. 按行动关键词把经验归入"同类"（成对交集 ≥2 词，并查集连通）；
  2. 找出同类内极性相反的**对照对**；
  3. 报告**类内效用极差**与**锚定率**——若类内极差 ≈ 全库极差，说明标签方差吞掉了
     结构信号，此时提炼出的"为什么"只会是叙事风格的产物。

用法: python3 dsh-contrast.py [经验文件路径]
"""
import json, os, sys
from collections import defaultdict

D = os.path.expanduser('~/.dsh/cognitive-pipeline')
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(D, 'experiences.jsonl')
rows = [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]

def kws(r): return set((r.get('sar') or {}).get('actionKeywords') or [])
def mg(r): return ((r.get('sar') or {}).get('outcomeUtility') or {}).get('materialGain')
def pol(r):
    g = mg(r)
    if g is None: return None
    return 'success' if g >= 6 else ('failure' if g <= 3 else 'neutral')
def anchored(r):
    """锚定 = 结果由外部见证判定（原始文本可回溯 / 被引用 / 预测误差回填）。"""
    return bool(r.get('rawText')) or (r.get('citationCount') or 0) > 0 or r.get('predictionError') is not None

par = list(range(len(rows)))
def find(x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x
def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb: par[rb] = ra
for i in range(len(rows)):
    for j in range(i + 1, len(rows)):
        if len(kws(rows[i]) & kws(rows[j])) >= 2: union(i, j)

cls = defaultdict(list)
for i, r in enumerate(rows): cls[find(i)].append(r)

pairs = []
for members in cls.values():
    for a in range(len(members)):
        for b in range(a + 1, len(members)):
            pa, pb = pol(members[a]), pol(members[b])
            if pa and pb and {pa, pb} == {'success', 'failure'}:
                pairs.append((members[a], members[b]))

print(f"=== 对照挖掘 ===")
print(f"经验 {len(rows)} 条 | 同类组 {len(cls)} | 极性相反的对照对 {len(pairs)}")
print(f"对照对中双方均锚定的: {sum(1 for a, b in pairs if anchored(a) and anchored(b))}")
print(f"全库锚定率: {sum(1 for r in rows if anchored(r))}/{len(rows)}")

allu = [mg(r) for r in rows if mg(r) is not None]
if allu:
    print(f"\n全库效用极差 {max(allu) - min(allu):.1f} | 均值 {sum(allu)/len(allu):.2f}")

spreads = []
for members in cls.values():
    us = [mg(r) for r in members if mg(r) is not None]
    if len(us) >= 3:
        spreads.append((max(us) - min(us), len(us), sorted(us), members))
spreads.sort(key=lambda x: -x[0])
print(f"\n类内效用极差（前 8，极差 ≈ 全库极差 ⇒ 标签无判别力）:")
for sp, n, us, members in spreads[:8]:
    tag = ' ← 类内极差已接近全库' if allu and sp >= 0.8 * (max(allu) - min(allu)) else ''
    print(f"  极差 {sp:.1f} | {n} 条 | 效用 {us}{tag}")

print(f"\n=== 裁决 ===")
if not allu or not spreads:
    print("样本不足，无法回答'为什么'")
else:
    ratio = spreads[0][0] / (max(allu) - min(allu))
    print(f"最大类内极差 / 全库极差 = {ratio:.2f}")
    if ratio >= 0.8:
        print("→ 标签方差吞掉结构信号：当前材料**不能**支撑因果提炼；"
              "应先给结果加外部锚（机检/文件/退出码），再重问'为什么'。")
    else:
        print("→ 类内方差明显小于全库：可尝试提炼判别特征（对照对已具备信息量）。")
