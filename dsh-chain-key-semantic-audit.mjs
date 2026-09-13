/**
 * dsh-chain-key-semantic-audit.mjs — 在**真 embedding**(SiliconFlow bge-m3)下重标定链键的门槛(cl-361)
 *
 * 缺口(上一轮如实标注): `goalMargin=0.05` 是用**词面 hash 空间**的离线对照定的; 而 cl-360 让链键在有 embedder 时走
 * **语义空间**。语义空间的余弦分布整体更高(相关文本常 0.6~0.8), 同样 +0.05 的相对严格度完全不同 ⇒ 需要真实数据重标。
 *
 * 怎么算(与实现同一口径): 查询=经验的情境文本; 链的成员分=该链成员情境的语义余弦最大; 链键分=goal/distilledPrinciple
 * 的语义余弦最大。判据与离线词面版一致: 新增过阈对(member<T 而 key>=T+margin) 与**决策层赢家改变**(每情境只服务 1 条)。
 * 标定目标: 找出"新增过阈对≈0 且赢家改变≈0"的最小 margin —— 与词面空间 0.05 的结果对齐或给出新值。
 *
 * 成本控制: 只嵌入**需要的文本**(链键 + 抽样情境 + 这些链的成员情境), 去重 + 并发 5 + 失败即报(不静默退化)。
 *
 * 用法: npx tsx dsh-chain-key-semantic-audit.mjs [--sample 30] [--json] [--thr 0.4]
 * 退出码: 0 有可判读数; 3 环境不成立(没 key / 网络不通 / 账本缺失) —— **不静默退回词面**, 否则结论是假的。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HttpEmbeddingTransport } from './packages/cognition/cognitive-pipeline/src/embedding.ts'
import { cosine } from './packages/cognition/cognitive-pipeline/src/vectorizer.ts'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const num = (flag, dflt) => Number((args.find(a => a.startsWith(flag)) ?? `${flag}=${dflt}`).split('=')[1] ?? dflt)
const SAMPLE = num('--sample', 30)
const THRESHOLD = num('--thr', 0.4)
const COG = join(homedir(), '.dsh', 'cognitive-pipeline')
const CRED = join(homedir(), '.dsh', '.credentials.yaml')

function apiKey() {
  try {
    for (const line of readFileSync(CRED, 'utf8').split('\n')) {
      const m = /^\s*SILICONFLOW_API_KEY\s*:\s*["']?([^"'\s#]+)/.exec(line)
      if (m) return m[1]
    }
  } catch { /* 读不到就走下面的环境不成立分支 */ }
  return null
}

const key = apiKey()
if (key === null) {
  console.error('[semantic-audit] 拿不到 SILICONFLOW_API_KEY ⇒ 环境不成立(不静默退回词面, 那会让结论失真)')
  process.exit(3)
}
const transport = new HttpEmbeddingTransport('https://api.siliconflow.cn/v1', 'BAAI/bge-m3', key)

const chains = JSON.parse(readFileSync(join(COG, 'chains.json'), 'utf8'))
const exps = readFileSync(join(COG, 'experiences.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const byId = new Map(exps.map(e => [e.expId, e]))

// 需要嵌入的文本集合: 链键 + 成员情境 + 抽样查询情境
const needed = new Set()
const keyTexts = new Map()
for (const c of chains) {
  const texts = [String(c.goal ?? '')]
  if (c.distilledPrinciple) texts.push(String(c.distilledPrinciple))
  keyTexts.set(c.chainId, texts.filter(t => t.length > 0))
  for (const t of keyTexts.get(c.chainId)) needed.add(t)
  for (const id of c.memberExpIds ?? []) {
    const e = byId.get(id)
    if (e) needed.add(String(e.sar?.situation ?? ''))
  }
}
const queries = exps.slice(-SAMPLE)
for (const e of queries) needed.add(String(e.sar?.situation ?? ''))
needed.delete('')

const cache = new Map()
let calls = 0
const list = [...needed]
const CONC = 5
let cursor = 0
async function worker() {
  while (cursor < list.length) {
    const text = list[cursor++]
    try {
      const v = await transport.embed(text)
      cache.set(text, v)
      calls += 1
    } catch (error) {
      console.error(`[semantic-audit] 嵌入失败(${text.slice(0, 20)}...): ${String(error).slice(0, 120)} ⇒ 环境不成立`)
      process.exit(3)
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker))

const vec = t => cache.get(t) ?? null
const maxCos = (q, texts) => {
  let best = 0
  for (const t of texts) {
    const v = vec(t)
    if (v !== null && v !== undefined) best = Math.max(best, cosine(q, v))
  }
  return best
}

const pairs = []
for (const c of chains) {
  const memberSituations = (c.memberExpIds ?? []).map(id => byId.get(id)).filter(Boolean).map(e => String(e.sar?.situation ?? ''))
  const kTexts = keyTexts.get(c.chainId) ?? []
  for (const q of queries) {
    const query = String(q.sar?.situation ?? '')
    const qv = vec(query)
    if (qv === null) continue
    const member = maxCos(qv, memberSituations)
    const keyScore = maxCos(qv, kTexts)
    pairs.push({ chainId: c.chainId, queryExpId: q.expId, member, key: keyScore,
      // 域内=这条情境就是该链的成员之一(真相关); 域外=不是 ⇒ 两者的分布差给出了"门槛该定在哪"的经验依据。
      inDomain: (c.memberExpIds ?? []).includes(q.expId),
      oldHit: member >= THRESHOLD, keyOnly: member < THRESHOLD && keyScore >= THRESHOLD })
  }
}

// 每个 margin 下的"新增过阈对"与"决策层赢家改变"
const margins = [0, 0.05, 0.1, 0.15, 0.2]
const byMargin = {}
for (const m of margins) {
  const hit = p => p.member >= THRESHOLD || p.key >= THRESHOLD + m
  const added = pairs.filter(p => !p.oldHit && hit(p))
  const winners = new Map()
  for (const p of pairs) {
    const prev = winners.get(p.queryExpId)
    const score = Math.max(p.member, hit(p) ? p.key : 0)
    if (prev === undefined || score > prev.score) winners.set(p.queryExpId, { chainId: p.chainId, score })
  }
  const oldWinners = new Map()
  for (const p of pairs) {
    const prev = oldWinners.get(p.queryExpId)
    if (prev === undefined || p.member > prev.member) oldWinners.set(p.queryExpId, { chainId: p.chainId, member: p.member })
  }
  let changed = 0
  for (const [q, w] of winners) if (oldWinners.get(q)?.chainId !== w.chainId) changed += 1
  byMargin[m] = { margin: m, addedPairs: added.length, winnerChanged: changed,
    addedSamples: added.sort((a, b) => b.key - a.key).slice(0, 4).map(p => ({ chain: p.chainId.slice(0, 28), member: Number(p.member.toFixed(3)), key: Number(p.key.toFixed(3)) })) }
}

const keyOnlyScores = pairs.filter(p => !p.oldHit).map(p => p.key).sort((a, b) => a - b)
const pct = (arr, p) => (arr.length === 0 ? null : Number(arr[Math.min(arr.length - 1, Math.floor(p * arr.length))].toFixed(3)))
const inDom = pairs.filter(p => p.inDomain).map(p => p.member).sort((a, b) => a - b)
const outDom = pairs.filter(p => !p.inDomain).map(p => p.member).sort((a, b) => a - b)
// 每个查询: 最佳链与次佳链的差 —— 差小说明"选谁都差不多", 这是排名是否有意义的直接读数。
const best2 = []
for (const q of new Set(pairs.map(p => p.queryExpId))) {
  const scores = pairs.filter(p => p.queryExpId === q).map(p => p.member).sort((a, b) => b - a)
  if (scores.length >= 2) best2.push(scores[0] - scores[1])
}
best2.sort((a, b) => a - b)
const admitters = {}
for (const t of [0.4, 0.5, 0.6, 0.7, 0.8]) {
  admitters[t] = pairs.filter(p => p.member >= t).length
}

const report = {
  transport: 'siliconflow/BAAI/bge-m3', threshold: THRESHOLD, queries: queries.length,
  distribution: {
    inDomain: { n: inDom.length, p10: pct(inDom, 0.1), p50: pct(inDom, 0.5), p90: pct(inDom, 0.9) },
    outOfDomain: { n: outDom.length, p50: pct(outDom, 0.5), p90: pct(outDom, 0.9), p99: pct(outDom, 0.99) },
    bestMinusSecond: { p50: pct(best2, 0.5), p90: pct(best2, 0.9) },
    pairsClearingAt: admitters,
  },
  chains: chains.length, embeddedTexts: calls, pairs: pairs.length,
  memberHitPairs: pairs.filter(p => p.oldHit).length,
  keyOnlyPairs: pairs.filter(p => p.keyOnly).length,
  keyScoreWhenMemberBelowThreshold: { p50: pct(keyOnlyScores, 0.5), p90: pct(keyOnlyScores, 0.9), max: pct(keyOnlyScores, 0.999) },
  byMargin,
}

if (asJson) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`[semantic-audit] 真 embedding(bge-m3) | 嵌入 ${calls} 段文本 | ${chains.length} 链 × ${queries.length} 情境 = ${report.pairs} 对 | 阈值 ${THRESHOLD}`)
  console.log(`  成员路命中 ${report.memberHitPairs} 对; 仅键命中(未加余量) ${report.keyOnlyPairs} 对`)
  const d = report.distribution
  console.log(`  域内成员分(真是这条链的情境) n=${d.inDomain.n}: p10=${d.inDomain.p10} p50=${d.inDomain.p50} p90=${d.inDomain.p90}`)
  console.log(`  域外成员分(不是这条链的)     n=${d.outOfDomain.n}: p50=${d.outOfDomain.p50} p90=${d.outOfDomain.p90} p99=${d.outOfDomain.p99}`)
  console.log(`  每查询"最佳-次佳"差: p50=${d.bestMinusSecond.p50} p90=${d.bestMinusSecond.p90} | 各阈值下的过阈对数: ${JSON.stringify(d.pairsClearingAt)}`)
  console.log(`  成员不达标时键分的分布: p50=${report.keyScoreWhenMemberBelowThreshold.p50} p90=${report.keyScoreWhenMemberBelowThreshold.p90} max=${report.keyScoreWhenMemberBelowThreshold.max}`)
  for (const m of margins) {
    const b = byMargin[m]
    console.log(`  margin=${m}: 新增过阈对 ${b.addedPairs} | 赢家改变 ${b.winnerChanged}` +
      (b.addedSamples.length ? ` | 最大: ${b.addedSamples.map(s => `${s.chain}(成员${s.member}/键${s.key})`).join(', ')}` : ''))
  }
}
