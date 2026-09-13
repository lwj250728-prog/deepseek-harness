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
// cl-366: 参数解析必须同时认 `--thr=0.95` 与 `--thr 0.95` —— 第一版只认前者, 于是 `--thr 0.95` **静默用了默认值**
// (判据当场抓到: 门槛本该 0.95 却按 0.4 算, 命中 3 对而不是 2 对)。静默忽略参数比报错更危险。
const num = (flag, dflt) => {
  const i = args.findIndex(a => a === flag || a.startsWith(`${flag}=`))
  if (i < 0) return dflt
  const inline = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1]
  const v = Number(inline)
  if (!Number.isFinite(v)) {
    console.error(`[semantic-audit] 参数 ${flag} 的值读不出来(${inline}) ⇒ 环境不成立`)
    process.exit(3)
  }
  return v
}
const SAMPLE = num('--sample', 30)
const THRESHOLD = num('--thr', 0.4)
const COG = join(homedir(), '.dsh', 'cognitive-pipeline')
// 夹具注入点(cl-366): 判据要在**无网络/无 key**下也能测这个脚本 —— 否则它永远没有判据,
// 而它的读数支撑着设计决定(cl-361/362/363)。注入点只替代**输入与传输**, 不改变判定逻辑。
const CRED = process.env.DSH_SEMANTIC_AUDIT_CRED || join(homedir(), '.dsh', '.credentials.yaml')
const STUB = process.env.DSH_SEMANTIC_AUDIT_STUB || ''

function apiKey() {
  try {
    for (const line of readFileSync(CRED, 'utf8').split('\n')) {
      const m = /^\s*SILICONFLOW_API_KEY\s*:\s*["']?([^"'\s#]+)/.exec(line)
      if (m) return m[1]
    }
  } catch { /* 读不到就走下面的环境不成立分支 */ }
  return null
}

let transport
if (STUB !== '') {
  // stub transport: 文本→向量 由夹具给定(缺向量的文本视为嵌入失败 ⇒ null, 与真实失败同一条路径)
  let table
  try {
    table = JSON.parse(readFileSync(STUB, 'utf8'))
  } catch (error) {
    console.error(`[semantic-audit] stub 读不了(${STUB}): ${String(error).slice(0, 120)} ⇒ 环境不成立`)
    process.exit(3)
  }
  transport = { embed: async text => table[text] ?? null }
} else {
  const key = apiKey()
  if (key === null) {
    // **fail-closed**: 拿不到 key 就必须退出 3, 绝不静默退回词面 —— 那会让"语义标定"的结论变成假的。
    console.error('[semantic-audit] 拿不到 SILICONFLOW_API_KEY ⇒ 环境不成立(不静默退回词面, 那会让结论失真)')
    process.exit(3)
  }
  transport = new HttpEmbeddingTransport('https://api.siliconflow.cn/v1', 'BAAI/bge-m3', key)
}

const chainsPath = process.env.DSH_SEMANTIC_AUDIT_CHAINS || join(COG, 'chains.json')
const expsPath = process.env.DSH_SEMANTIC_AUDIT_EXPS || join(COG, 'experiences.jsonl')
const chains = JSON.parse(readFileSync(chainsPath, 'utf8'))
const exps = readFileSync(expsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
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
    if (!e) continue
    needed.add(String(e.sar?.situation ?? ''))   // 作为查询(留一法的问)
    needed.add(String(e.sar?.action ?? ''))      // 作为成员(生产口径比的是成员 **action** 的嵌入)
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

// cl-362: **留一法**造"相关但新"的样本 —— 同一条链内, 用成员 m 的情境当查询, 只比**其它**成员的 action 嵌入
// (与生产打分公式完全一致: 情境查询 vs 成员 action 嵌入)。它回答上一轮缺的那个问题: 真相关但文本不同的对, 分数落在哪里?
const loo = []
for (const c of chains) {
  const members = (c.memberExpIds ?? []).map(id => byId.get(id)).filter(Boolean)
  for (const m of members) {
    const q = vec(String(m.sar?.situation ?? ''))
    if (q === null) continue
    let best = 0
    for (const other of members) {
      if (other.expId === m.expId) continue
      const v = vec(String(other.sar?.action ?? ''))
      if (v !== null && v !== undefined) best = Math.max(best, cosine(q, v))
    }
    // 对照 arm: **同字段**比较(情境 vs 情境) —— 用来判断"情境 vs 成员 action"这种跨字段比较是不是分离度差的真因。
    let bestSit = 0
    for (const other of members) {
      if (other.expId === m.expId) continue
      const v = vec(String(other.sar?.situation ?? ''))
      if (v !== null && v !== undefined) bestSit = Math.max(bestSit, cosine(q, v))
    }
    if (best > 0) loo.push({ chainId: c.chainId, expId: m.expId, score: best, scoreSituation: bestSit })
  }
}
const looSit = loo.map(x => x.scoreSituation).filter(v => v > 0).sort((a, b) => a - b)

// cl-363: **相对排名口径**的经验依据 —— 对"相关但新"的查询(留一法), 它的**真身链**是否明显领先次佳?
// 若领先足够大 ⇒ "要求最佳链领先次佳 minLead"这道闸门能在保住真相关的同时拒掉"选谁都差不多"的情境。
const looLead = []
for (const item of loo) {
  const qExp = byId.get(item.expId)
  if (!qExp) continue
  const qv = vec(String(qExp.sar?.situation ?? ''))
  if (qv === null) continue
  const perChain = []
  for (const c of chains) {
    const sits = (c.memberExpIds ?? []).map(id => byId.get(id)).filter(Boolean).map(e => String(e.sar?.situation ?? ''))
    // 排除自身那条, 否则"真身链"必然拿满分(那是自我匹配, 不是检索能力)
    const others = (c.memberExpIds ?? []).filter(id => id !== item.expId).map(id => byId.get(id)).filter(Boolean).map(e => String(e.sar?.situation ?? ''))
    perChain.push({ chainId: c.chainId, self: sits.includes(String(qExp.sar?.situation ?? '')), score: maxCos(qv, others) })
  }
  perChain.sort((a, b) => b.score - a.score)
  const mine = perChain.find(x => x.self)
  const rival = perChain.find(x => !x.self)?.score ?? 0
  looLead.push({ chainId: item.chainId, ownScore: mine?.score ?? 0, rivalScore: rival, lead: (mine?.score ?? 0) - rival,
    ownWins: (mine?.score ?? 0) > rival })
}
// cl-363b: 排名信号对照 —— 成员文本(同字段) vs 链键(目标+蒸馏原则)。哪个更能认出"自己的链"?
const looKeyLead = []
for (const item of loo) {
  const qExp = byId.get(item.expId)
  if (!qExp) continue
  const qv = vec(String(qExp.sar?.situation ?? ''))
  if (qv === null) continue
  const perChain = chains.map(c => ({
    chainId: c.chainId,
    self: (c.memberExpIds ?? []).includes(item.expId),
    key: maxCos(qv, keyTexts.get(c.chainId) ?? []),
  })).sort((a, b) => b.key - a.key)
  const mine = perChain.find(x => x.self)
  const rival = perChain.find(x => !x.self)?.key ?? 0
  looKeyLead.push({ own: mine?.key ?? 0, rival, wins: (mine?.key ?? 0) > rival })
}
const keyWinRate = looKeyLead.length === 0 ? null : looKeyLead.filter(x => x.wins).length / looKeyLead.length
const leadSorted = looLead.map(x => x.lead).sort((a, b) => a - b)
const ownWinRate = looLead.length === 0 ? null : looLead.filter(x => x.ownWins).length / looLead.length
// 域外对照也用同字段算一遍: 别的链成员的**情境**对当前查询
const outDomSit = []
for (const c of chains) {
  const memberSituations = (c.memberExpIds ?? []).map(id => byId.get(id)).filter(Boolean).map(e => String(e.sar?.situation ?? ''))
  for (const q of queries) {
    const memberIds = new Set(c.memberExpIds ?? [])
    if (memberIds.has(q.expId)) continue
    const qv = vec(String(q.sar?.situation ?? ''))
    if (qv === null) continue
    outDomSit.push(maxCos(qv, memberSituations))
  }
}
outDomSit.sort((a, b) => a - b)
const looSorted = loo.map(x => x.score).sort((a, b) => a - b)

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
    // 留一法(相关但新): 与域外分布对照即可看出"门槛能不能抬"
    leaveOneOut: { n: looSorted.length, p01: pct(looSorted, 0.01), p10: pct(looSorted, 0.1), p50: pct(looSorted, 0.5), min: looSorted[0] === undefined ? null : Number(looSorted[0].toFixed(3)) },
    // 字段对齐对照(cl-362): 生产口径=情境查询 vs 成员 **action** 嵌入(跨字段); 同字段=情境 vs 情境
    fieldAlignment: {
      relatedNew_situationVsAction: { n: looSorted.length, min: pct(looSorted, 0), p10: pct(looSorted, 0.1), p50: pct(looSorted, 0.5) },
      relatedNew_situationVsSituation: { n: looSit.length, min: pct(looSit, 0), p10: pct(looSit, 0.1), p50: pct(looSit, 0.5) },
      unrelated_situationVsSituation: { n: outDomSit.length, p50: pct(outDomSit, 0.5), p90: pct(outDomSit, 0.9), p99: pct(outDomSit, 0.99) },
    },
    relativeRanking: {
      n: leadSorted.length,
      ownChainWins: ownWinRate,
      leadP10: pct(leadSorted, 0.1), leadP25: pct(leadSorted, 0.25), leadP50: pct(leadSorted, 0.5), leadP90: pct(leadSorted, 0.9),
      // 各 minLead 门槛下: 真相关查询还能过闸的比例(召回) —— 用它判断"要求领先"是否安全
      keepRateAt: Object.fromEntries([0, 0.02, 0.05, 0.1, 0.15].map(t => [t, leadSorted.length === 0 ? null : Number((leadSorted.filter(v => v >= t).length / leadSorted.length).toFixed(3))])),
      // 排名信号对照: 用**链键(目标+蒸馏原则)**排名时, 真身链胜率是多少(与成员路 0.714 对比)
      ownChainWinsByKey: keyWinRate,
    },
    separation: {
      // 域外 p99 与留一法 p10/min 之间的关系: p99 < min(LOO) ⇒ 存在能"全收相关、几乎不收不相关"的门槛
      outOfDomainP99: pct(outDom, 0.99),
      looMin: looSorted[0] === undefined ? null : Number(looSorted[0].toFixed(3)),
      looP10: pct(looSorted, 0.1),
    },
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
  const rr = d.relativeRanking
  console.log(`  **相对排名**(相关但新的查询, 真身链 vs 次佳): 真身链胜率 ${rr.ownChainWins} | 领先量 p10=${rr.leadP10} p25=${rr.leadP25} p50=${rr.leadP50} p90=${rr.leadP90}`)
  console.log(`  各 minLead 下真相关查询的保留率(召回): ${JSON.stringify(rr.keepRateAt)}`)
  console.log(`  排名信号对照: 成员路真身胜率 ${rr.ownChainWins} vs **链键(目标+原则)路** ${rr.ownChainWinsByKey}`)
  const fa = d.fieldAlignment
  console.log(`  字段对拍照: 相关但新 情境vs成员action → min ${fa.relatedNew_situationVsAction.min} p50 ${fa.relatedNew_situationVsAction.p50}` +
    ` | 相关但新 情境vs情境 → min ${fa.relatedNew_situationVsSituation.min} p50 ${fa.relatedNew_situationVsSituation.p50}` +
    ` | 域外 情境vs情境 → p50 ${fa.unrelated_situationVsSituation.p50} p99 ${fa.unrelated_situationVsSituation.p99}`)
  const l = d.leaveOneOut
  console.log(`  **相关但新**(留一法) n=${l.n}: min=${l.min} p01=${l.p01} p10=${l.p10} p50=${l.p50}`)
  console.log(`  分离度: 域外 p99=${d.separation.outOfDomainP99} vs 留一法 min=${d.separation.looMin} p10=${d.separation.looP10}` +
    (d.separation.outOfDomainP99 !== null && d.separation.looMin !== null && d.separation.looMin > d.separation.outOfDomainP99 ? ' ⇒ **存在把两者分开的门槛**' : ' ⇒ 分布有重叠, 单一门槛无法完全分开'))
  console.log(`  成员不达标时键分的分布: p50=${report.keyScoreWhenMemberBelowThreshold.p50} p90=${report.keyScoreWhenMemberBelowThreshold.p90} max=${report.keyScoreWhenMemberBelowThreshold.max}`)
  for (const m of margins) {
    const b = byMargin[m]
    console.log(`  margin=${m}: 新增过阈对 ${b.addedPairs} | 赢家改变 ${b.winnerChanged}` +
      (b.addedSamples.length ? ` | 最大: ${b.addedSamples.map(s => `${s.chain}(成员${s.member}/键${s.key})`).join(', ')}` : ''))
  }
}
