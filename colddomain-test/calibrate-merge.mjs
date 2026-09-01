#!/usr/bin/env node
/**
 * Embedding-space agglomerative threshold calibration (设计验证 · §7 第5项).
 *
 * 目标：标定 embedding 空间的 clusterMergeCosine（agglomerative 合并阈值）。
 * 方法：对 327 条经验的 embedding 做全量 pairwise 余弦，看同语义邻居的分布，
 * 并用不同阈值跑 agglomerative，观察簇数/覆盖/孤儿的权衡。
 *
 * 用法：node colddomain-test/calibrate-merge.mjs
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

/** Agglomerative with centroid linkage, mirroring cold-engine.agglomerate. */
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
console.log(`有嵌入经验 ${exps.length} 条\n`)

// 1. 全局 pairwise 余弦分布（抽样 2000 对）
const all = exps.map(e => e.embedding)
const pairs = []
for (let i = 0; i < all.length && pairs.length < 2000; i += 1) {
  for (let j = i + 1; j < all.length && pairs.length < 2000; j += 1) {
    pairs.push(cosine(all[i], all[j]))
  }
}
pairs.sort((a, b) => b - a)
const q = (p) => pairs[Math.min(pairs.length - 1, Math.floor(p * pairs.length))]
console.log('=== 全局 pairwise 余弦分布（抽样对） ===')
console.log(`  样本 ${pairs.length} 对`)
console.log(`  top1%: ${q(0.01).toFixed(3)} | top5%: ${q(0.05).toFixed(3)} | top10%: ${q(0.1).toFixed(3)}`)
console.log(`  top25%: ${q(0.25).toFixed(3)} | 中位: ${q(0.5).toFixed(3)} | 底25%: ${q(0.75).toFixed(3)}\n`)

// 2. 不同阈值跑 agglomerative，看权衡
console.log('=== mergeCosine 阈值扫描 ===')
for (const threshold of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
  const groups = agglomerate(all, threshold)
  const sizes = groups.map(g => g.length).sort((a, b) => b - a)
  const big = sizes.filter(s => s >= 3).length
  const covered = sizes.filter(s => s >= 3).reduce((sum, s) => sum + s, 0)
  const orphans = exps.length - covered
  const largest = sizes[0] ?? 0
  console.log(
    `  t=${threshold.toFixed(2)}: 簇数=${groups.length} 大簇(≥3)=${big} ` +
    `覆盖=${covered}/${exps.length} 孤儿=${orphans} 最大簇=${largest}`
  )
}
