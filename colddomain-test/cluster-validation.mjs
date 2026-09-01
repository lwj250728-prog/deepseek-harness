#!/usr/bin/env node
/**
 * Full-cluster validation (设计验证 · 13-cluster-dynamic-library-design.md §7 第1/4/5项).
 *
 * 目标：为 C 形态（簇离线演化 → 判别权重表）落地提供全量数据：
 *   1. 全部簇的纯度统计（簇内 pairwise 距离分布）→ 分裂候选
 *   2. 效用空间 vs 语义空间全簇对比 → 换聚类空间（L1）的全量证据
 *   3. 簇间质心重叠检测 → §4.2 触发信号阈值（重叠 0.85 是否合理）
 *   4. 未入簇经验占比 → 孤儿池规模（簇新增的原料）
 *
 * 用法：node colddomain-test/cluster-validation.mjs
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

function centroid(vectors) {
  const dim = vectors[0].length
  const sum = new Array(dim).fill(0)
  for (const v of vectors) for (let i = 0; i < dim; i += 1) sum[i] += v[i]
  return sum.map(x => x / vectors.length)
}

/** Pairwise cosine distances (1 - cosine) within a set; returns sorted list. */
function pairwiseDistances(vectors) {
  const distances = []
  for (let i = 0; i < vectors.length; i += 1)
    for (let j = i + 1; j < vectors.length; j += 1) distances.push(1 - cosine(vectors[i], vectors[j]))
  return distances.sort((a, b) => a - b)
}

function stats(distances) {
  if (distances.length === 0) return { n: 0, mean: null, median: null, max: null, min: null }
  const mid = Math.floor(distances.length / 2)
  const mean = distances.reduce((s, d) => s + d, 0) / distances.length
  return {
    n: distances.length,
    mean,
    median: distances.length % 2 === 1 ? distances[mid] : (distances[mid - 1] + distances[mid]) / 2,
    min: distances[0],
    max: distances[distances.length - 1],
  }
}

const clusters = JSON.parse(readFileSync(join(root, 'data/cognitive-pipeline/clusters.json'), 'utf8'))
const exps = loadJsonl('data/cognitive-pipeline/experiences.jsonl')
const byId = new Map(exps.map(e => [e.expId, e]))

// 簇成员 = supportingEvidenceIds 中的真实经验（有嵌入的）
const memberships = new Map() // expId -> clusterIds
const clusterMembers = clusters.map(c => ({
  cluster: c,
  members: c.supportingEvidenceIds
    .map(id => byId.get(id))
    .filter(e => e !== undefined && e.embedding !== undefined),
}))
for (const { cluster, members } of clusterMembers) {
  for (const m of members) {
    if (!memberships.has(m.expId)) memberships.set(m.expId, [])
    memberships.get(m.expId).push(cluster.clusterId)
  }
}

const inClusters = new Set(exps.filter(e => memberships.has(e.expId)).map(e => e.expId))
const orphans = exps.filter(e => e.embedding !== undefined && !inClusters.has(e.expId))

console.log(`总经验 ${exps.length}，有嵌入 ${exps.filter(e => e.embedding !== undefined).length}`)
console.log(`簇数 ${clusters.length}，簇成员经验 ${inClusters.size}，孤儿(未入任何簇) ${orphans.length}\n`)

console.log('=== 1. 簇纯度（语义空间 pairwise 距离，1-cos；越大越分散） ===')
for (const { cluster, members } of clusterMembers) {
  if (members.length < 2) {
    console.log(`簇 ${cluster.clusterId} (${cluster.name.slice(0, 24)}…): 成员 ${members.length}，无法算纯度`)
    continue
  }
  const d = stats(pairwiseDistances(members.map(m => m.embedding)))
  const u = stats(pairwiseDistances(members.map(m => m.outcomeVector)))
  console.log(
    `簇 ${cluster.clusterId} [${cluster.name.slice(0, 20)}…] 成员${members.length}: ` +
    `语义中位距 ${d.median.toFixed(3)} (min ${d.min.toFixed(3)}/max ${d.max.toFixed(3)}) | ` +
    `效用中位距 ${u.median.toFixed(3)}`
  )
}

console.log('\n=== 2. 全簇质心对比：效用空间 vs 语义空间 ===')
for (const space of ['outcomeVector', 'embedding']) {
  const cents = clusterMembers
    .filter(({ members }) => members.length > 0)
    .map(({ cluster, members }) => ({ id: cluster.clusterId, cent: centroid(members.map(m => m[space])) }))
  let totalInter = 0, count = 0
  const overlaps = []
  for (let i = 0; i < cents.length; i += 1) {
    for (let j = i + 1; j < cents.length; j += 1) {
      const sim = cosine(cents[i].cent, cents[j].cent)
      totalInter += sim
      count += 1
      overlaps.push({ pair: `${cents[i].id}↔${cents[j].id}`, sim })
    }
  }
  console.log(`\n[${space}] 簇间质心平均相似度 ${(totalInter / count).toFixed(4)}（越小越可分）`)
  for (const o of overlaps.sort((a, b) => b.sim - a.sim)) {
    console.log(`  簇${o.pair}: ${o.sim.toFixed(4)} ${o.sim >= 0.85 ? '⚠ ≥0.85 重叠阈值' : ''}`)
  }
}

console.log('\n=== 3. 孤儿经验（簇新增原料） ===')
if (orphans.length === 0) {
  console.log('无孤儿（所有有嵌入经验都入了簇）')
} else {
  console.log(`孤儿 ${orphans.length} 条，按结果极性分布：`)
  const byPolarity = {}
  for (const o of orphans) {
    const g = o.sar.outcomeUtility.materialGain ?? 5
    const key = g >= 7 ? '高收益(≥7)' : g >= 4 ? '中(4-6.9)' : '低(<4)'
    byPolarity[key] = (byPolarity[key] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(byPolarity)) console.log(`  ${k}: ${v}`)
  console.log('样例：')
  for (const o of orphans.slice(0, 3)) console.log(`  ${o.expId}: ${o.sar.situation.slice(0, 40)}…`)
}
