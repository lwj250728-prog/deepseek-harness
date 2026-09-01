#!/usr/bin/env node
/**
 * High-threshold cluster inspection (补充分析 · calibrate-merge 的延伸).
 *
 * 问题：bge-m3 语料整体相似度高（中位余弦 0.504），低阈值 agglomerative
 * 退化成单巨簇。本脚本用高阈值（0.70）分裂后，检查非巨簇小簇的主题构成，
 * 判断"embedding 聚类 + 高阈值"能否给出可用的组织层，还是必须依赖 LLM 定轴。
 *
 * 用法：node colddomain-test/inspect-clusters.mjs
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

for (const threshold of [0.65, 0.7, 0.75]) {
  const groups = agglomerate(all, threshold)
  const labeled = groups
    .map((g, gi) => ({ gi, members: g.map(i => exps[i]) }))
    .sort((a, b) => b.members.length - a.members.length)

  console.log(`\n========== t=${threshold}：${groups.length} 簇 ==========`)
  // 巨簇单独报告，其余簇逐个看主题
  const giant = labeled[0]
  console.log(`巨簇: ${giant.members.length} 条 (${(giant.members.length / exps.length * 100).toFixed(0)}%) — 样例: ${giant.members.slice(0, 2).map(e => e.sar.situation.slice(0, 30)).join(' | ')}`)
  for (const { members } of labeled.slice(1)) {
    if (members.length < 2) continue
    const sits = members.map(e => e.sar.situation)
    const acts = members.map(e => e.sar.action)
    // 抽取关键词：找两两共现的词（简单启发式——前几个汉字词）
    const text = (sits.join(' ') + ' ' + acts.join(' '))
    const keywords = [...new Set(text.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [])]
      .map(w => ({ w, c: (text.match(new RegExp(w, 'g')) ?? []).length }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 6)
    console.log(`簇 ${members.length} 条: 主题词 ${keywords.map(k => k.w).join('/')}`)
    console.log(`   情境: ${sits[0].slice(0, 60)}`)
    console.log(`   行动: ${acts[0].slice(0, 60)}`)
  }
}
