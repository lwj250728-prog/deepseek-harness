#!/usr/bin/env node
/**
 * clusterMatchCosine calibration for embedding mode (§7 第5项 延伸).
 *
 * clusterMatchCosine 语义：`cosine(exp, cluster.centroid) >= threshold` 判定成员。
 * embedding 空间下，取 mergeCosine=0.75 的 agglomerative 分组，统计
 * 簇内成员与质心的余弦分布，定一个合理的 membership 阈值（低于簇内下界
 * 的会被漏掉，过高会把簇内成员拒之门外）。
 *
 * 用法：node colddomain-test/calibrate-match.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadJsonl(rel) {
  return readFileSync(join(root, rel), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const n = Math.sqrt(na) * Math.sqrt(nb)
  return n < 1e-12 ? 0 : dot / n
}

function centroidOf(vectors) {
  const dim = vectors[0].length
  const sum = new Array(dim).fill(0)
  for (const v of vectors) for (let i = 0; i < dim; i += 1) sum[i] += v[i]
  const mean = sum.map(x => x / vectors.length)
  let norm = 0
  for (const x of mean) norm += x * x
  norm = Math.sqrt(norm)
  return norm < 1e-9 ? mean : mean.map(x => x / norm)
}

function agglomerate(vectors, mergeCosine) {
  const clusters = vectors.map(v => ({ members: [v], centroid: v }))
  const memberSets = vectors.map((_, i) => [i])
  for (;;) {
    let bestI = -1, bestJ = -1, bestScore = mergeCosine
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const score = cosine(clusters[i].centroid, clusters[j].centroid)
        if (score >= bestScore) { bestScore = score; bestI = i; bestJ = j }
      }
    }
    if (bestI < 0 || bestJ < 0) break
    const merged = [...memberSets[bestI], ...memberSets[bestJ]]
    memberSets.splice(bestJ, 1, merged)
    memberSets.splice(bestI, 1)
    clusters.splice(bestJ, 1)
    clusters.splice(bestI, 1)
    const vecs = merged.map(i => vectors[i])
    clusters.push({ members: vecs, centroid: centroidOf(vecs) })
  }
  return memberSets
}

const exps = loadJsonl('data/cognitive-pipeline/experiences.jsonl')
  .filter(e => e.embedding !== undefined)
const all = exps.map(e => e.embedding)

const groups = agglomerate(all, 0.75)
console.log(`mergeCosine=0.75 → ${groups.length} 簇\n`)

// 簇内成员-质心余弦分布（只统计 ≥2 的簇，单例簇无意义）
const memberCos = []
for (const g of groups) {
  if (g.length < 2) continue
  const cent = centroidOf(g.map(i => all[i]))
  for (const i of g) memberCos.push(cosine(all[i], cent))
}
memberCos.sort((a, b) => a - b)
const q = (p) => memberCos[Math.min(memberCos.length - 1, Math.floor(p * memberCos.length))]

console.log(`簇内成员-质心余弦分布（${memberCos.length} 个成员）:`)
console.log(`  min: ${memberCos[0].toFixed(3)} | p5: ${q(0.05).toFixed(3)} | p10: ${q(0.1).toFixed(3)} | p25: ${q(0.25).toFixed(3)} | 中位: ${q(0.5).toFixed(3)}`)

// 不同 match 阈值的成员召回率（在 0.75 分组下）
console.log('\n=== match 阈值候选与成员召回率 ===')
for (const t of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  const kept = memberCos.filter(c => c >= t).length
  console.log(`  match≥${t.toFixed(2)}: 保留 ${kept}/${memberCos.length} (${(kept / memberCos.length * 100).toFixed(0)}%)`)
}

// 同时看：不同 match 阈值下，把 0.75 分组当作"真值"，全库 327 条按质心归属，
// 每簇得到的成员数与原始分组差异（过宽会把别的簇成员拉进来）
console.log('\n=== match 阈值 vs 簇间串扰（平均每簇额外吸进的非本簇成员） ===')
for (const t of [0.45, 0.5, 0.55, 0.6, 0.65]) {
  let extraTotal = 0, clusters = 0
  for (const g of groups) {
    if (g.length < 2) continue
    const cent = centroidOf(g.map(i => all[i]))
    const trueMembers = new Set(g)
    let extra = 0
    for (let i = 0; i < all.length; i += 1) {
      if (trueMembers.has(i)) continue
      if (cosine(all[i], cent) >= t) extra += 1
    }
    extraTotal += extra
    clusters += 1
  }
  console.log(`  match≥${t.toFixed(2)}: 平均每簇串扰 ${(extraTotal / clusters).toFixed(1)} 条（越少越好）`)
}
