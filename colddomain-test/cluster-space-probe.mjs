#!/usr/bin/env node
/**
 * Cluster-space discrimination probe (设计验证 · 13-cluster-dynamic-library-design.md §7).
 *
 * 目标：回答"是否需要用 LLM 做语义聚类"——先量化现有两个聚类空间在
 * exp_56/57 判别维度（新手 vs 资深）上的可分性：
 *   · 效用空间（当前聚类所用 outcomeVector，clusterVectorOf）
 *   · 语义空间（已有 bge-m3 embedding）
 *
 * 若语义空间质心距离显著大于效用空间，则"换聚类空间"（嵌入语义聚类，
 * 零新增 LLM 成本）即足以解决 exp_56/57；若仍然接近，才需要考虑 LLM
 * 语义聚类。数据说话，先验证后实施。
 *
 * 用法：node colddomain-test/cluster-space-probe.mjs
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

function meanPairwiseCosine(vectors) {
  if (vectors.length < 2) return null
  let sum = 0, count = 0
  for (let i = 0; i < vectors.length; i += 1)
    for (let j = i + 1; j < vectors.length; j += 1) {
      sum += cosine(vectors[i], vectors[j])
      count += 1
    }
  return sum / count
}

const clusters = JSON.parse(readFileSync(join(root, 'data/cognitive-pipeline/clusters.json'), 'utf8'))
const exps = loadJsonl('data/cognitive-pipeline/experiences.jsonl')
const byId = new Map(exps.map(e => [e.expId, e]))

// 簇 8 = 新手安全指引（exp_39/40/44/45）；簇 9 = 熟练资深例行推送（exp_41/42/43/46/47）
const novice = clusters.find(c => c.clusterId === 8)
const expert = clusters.find(c => c.clusterId === 9)
if (!novice || !expert) {
  console.error('未找到簇 8/9，检查 clusters.json')
  process.exit(1)
}

const groups = {
  '新手(簇8)': novice.supportingEvidenceIds.map(id => byId.get(id)).filter(Boolean),
  '资深(簇9)': expert.supportingEvidenceIds.map(id => byId.get(id)).filter(Boolean),
}

console.log('=== 两组证据样本 ===')
for (const [name, members] of Object.entries(groups)) {
  console.log(`${name}: ${members.map(e => `${e.expId}(${(e.sar.outcomeUtility.materialGain ?? 0).toFixed(1)}收益)`).join(', ')}`)
}

const spaces = {
  '效用空间(outcomeVector)': e => e.outcomeVector,
  '语义空间(bge-m3 embedding)': e => e.embedding,
}

console.log('\n=== 空间可分性对比 ===')
for (const [spaceName, pick] of Object.entries(spaces)) {
  const nVec = groups['新手(簇8)'].map(pick)
  const eVec = groups['资深(簇9)'].map(pick)
  const nC = centroid(nVec)
  const eC = centroid(eVec)
  const inter = cosine(nC, eC)
  const intraN = meanPairwiseCosine(nVec)
  const intraE = meanPairwiseCosine(eVec)
  const sep = 1 - inter // 距离；越大越可分
  console.log(`\n[${spaceName}]`)
  console.log(`  组间质心余弦: ${inter.toFixed(4)}  → 距离 ${sep.toFixed(4)}`)
  console.log(`  组内质心余弦: 新手 ${(intraN ?? 0).toFixed(4)} / 资深 ${(intraE ?? 0).toFixed(4)}`)
  console.log(`  可分性(组间距离/组内距离): ${intraN && intraE ? ((sep / ((1 - intraN + 1 - intraE) / 2))).toFixed(2) : '—'}x`)
}

console.log('\n=== 解读 ===')
console.log('· 若语义空间组间距离显著大于效用空间 → 换聚类空间即可，无需 LLM')
console.log('· 若两者都接近 → 该判别维度两个空间都不可分，需 LLM 语义聚类或判别词增强')
