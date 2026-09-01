#!/usr/bin/env node
/**
 * Full re-clustering baseline (设计验证 · §6.1 第1步 实施前验证).
 *
 * 模拟 `clusterVectorSource='embedding'` 下的完整重建流程，回答：
 *   1. 覆盖危机（3.7%）是否解决——327 条能否全入簇
 *   2. 簇内一致性 / 簇间可分性对比 outcome 现状
 *   3. exp_56/57 判别维度是否恢复（新手/资深是否分离）
 *
 * 流程与 cold-engine.runRebuild 对齐：
 *   agglomerate(embedding, mergeCosine=0.75) → 组≥evidenceMinCount(3)
 *   → LLM 锚定跳过（本脚本只验证确定性部分）→ 证据校验（两两距离≤0.85）
 *   → matchCosine=0.65 成员归属 → 质心/纯度统计
 *
 * 用法：node colddomain-test/baseline-recluster.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MERGE = 0.75
const MATCH = 0.65
const MIN_COUNT = 3
const MAX_DIST = 0.85

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
const byId = new Map(exps.map(e => [e.expId, e]))
console.log(`有嵌入经验 ${exps.length} 条\n`)

// 1. agglomerate → 组（≥3 才够 evidenceMinCount）
const groups = agglomerate(all, MERGE)
const validGroups = groups.filter(g => g.length >= MIN_COUNT)
const small = groups.length - validGroups.length
console.log(`=== 1. agglomerate(merge=${MERGE}) ===`)
console.log(`簇数 ${groups.length}，有效簇(≥${MIN_COUNT}条) ${validGroups.length}，小簇/孤组 ${small}\n`)

// 2. 证据校验（两两距离 ≤ MAX_DIST），对齐 verifyEvidence
const verified = validGroups.filter(g => {
  let maxDist = 0
  for (let i = 0; i < g.length; i += 1)
    for (let j = i + 1; j < g.length; j += 1)
      maxDist = Math.max(maxDist, 1 - cosine(all[g[i]], all[g[j]]))
  return maxDist <= MAX_DIST
})
console.log(`=== 2. 证据校验（两两距离≤${MAX_DIST}） ===`)
console.log(`通过 ${verified.length} / ${validGroups.length}（${(verified.length / validGroups.length * 100).toFixed(0)}%）\n`)

// 3. 成员归属（matchCosine=0.65）+ 覆盖统计
const covered = new Set()
const clusterStats = verified.map((g, gi) => {
  const cent = centroidOf(g.map(i => all[i]))
  const members = g.filter(i => cosine(all[i], cent) >= MATCH)
  const extra = []
  for (let i = 0; i < all.length; i += 1) {
    if (g.includes(i)) continue
    if (cosine(all[i], cent) >= MATCH) extra.push(i)
  }
  for (const i of members) covered.add(i)
  return { gi, cent, size: g.length, members, extra }
})

const orphanCount = exps.length - covered.size
const sizes = verified.map(c => c.size).sort((a, b) => b - a)
console.log(`=== 3. 覆盖（match=${MATCH}） ===`)
console.log(`簇内成员去重覆盖 ${covered.size}/${exps.length} (${(covered.size / exps.length * 100).toFixed(1)}%)`)
console.log(`孤儿 ${orphanCount}（对比现状 315 条孤儿 / 96.3%）`)
console.log(`簇大小分布: 最大 ${sizes[0] ?? 0}，中位 ${sizes[Math.floor(sizes.length / 2)] ?? 0}，簇数 ${sizes.length}`)

// 4. 簇间可分性 + exp_56/57 判别验证
console.log(`\n=== 4. 簇间可分性（质心余弦，越小越可分） ===`)
const cents = clusterStats.map(c => ({ id: c.gi, cent: c.cent, size: c.size }))
let interSum = 0, interCount = 0, overlaps = []
for (let i = 0; i < cents.length; i += 1) {
  for (let j = i + 1; j < cents.length; j += 1) {
    const sim = cosine(cents[i].cent, cents[j].cent)
    interSum += sim
    interCount += 1
    overlaps.push({ pair: `簇${cents[i].id}(${cents[i].size})↔簇${cents[j].id}(${cents[j].size})`, sim })
  }
}
console.log(`簇间平均余弦 ${(interSum / interCount).toFixed(4)}（outcome 现状 0.8219，语义 0.7084 已证更可分）`)
console.log(`重叠(≥0.85): ${overlaps.filter(o => o.sim >= 0.85).length} 对 / ${overlaps.length} 对`)
for (const o of overlaps.filter(o => o.sim >= 0.85).sort((a, b) => b.sim - a.sim).slice(0, 5)) {
  console.log(`  ⚠ ${o.pair}: ${o.sim.toFixed(3)}`)
}

// 5. exp_56/57 判别样本落簇情况
const noviceIds = ['exp_39', 'exp_40', 'exp_44', 'exp_45']
const expertIds = ['exp_41', 'exp_42', 'exp_43', 'exp_46', 'exp_47']
const clusterOfExp = new Map()
verified.forEach((g, gi) => { for (const i of g) clusterOfExp.set(exps[i].expId, gi) })
console.log(`\n=== 5. exp_56/57 判别样本落簇 ===`)
const noviceClusters = new Set(noviceIds.map(id => clusterOfExp.get(id)).filter(v => v !== undefined))
const expertClusters = new Set(expertIds.map(id => clusterOfExp.get(id)).filter(v => v !== undefined))
console.log(`新手经验落簇: ${[...noviceClusters].map(c => `簇${c}`).join(', ') || '无'}`)
console.log(`资深经验落簇: ${[...expertClusters].map(c => `簇${c}`).join(', ') || '无'}`)
const overlap = [...noviceClusters].filter(c => expertClusters.has(c)).length
console.log(`是否分离: ${noviceClusters.size > 0 && expertClusters.size > 0 && overlap === 0 ? '✅ 完全分离' : overlap > 0 ? `⚠ 重叠 ${overlap} 个簇` : '无法判断（样本未入有效簇）'}`)
