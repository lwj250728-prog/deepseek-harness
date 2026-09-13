/**
 * dsh-chain-key-audit.mjs — 链检索键的**离线对照**: 目标/原则键让多少"原本不服务"的情境变成服务?(cl-356)
 *
 * 背景: cl-355 把链自己的语义(goal + distilledPrinciple)纳入准入打分, 修掉了"换个说法就找不到"的召回缺口。
 * 但链的目标文本很短 ⇒ **单个词重合就可能过阈**, 存在过度服务风险。修缺口不能靠感觉, 要量:
 * 用库里 210 条经验的**情境文本**当查询集, 对 7 条链逐对算"成员键(旧)"与"成员+目标+原则键(新)"的分数,
 * 看新增了多少对过阈, 并从新增对里抽样人读, 判断是"真找到"还是"撞词"。
 *
 * 口径与实现一致: 只用 hash/词面向量(`situationVector`/`actionVector`), 与 retrieveChain 同一套 ——
 * 不额外调用 embedding。**这一限制本身也是结论的一部分**: 经验检索在有 embedder 时走语义向量, 而链键只走词面。
 *
 * 用法: npx tsx dsh-chain-key-audit.mjs [--threshold 0.4] [--json]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { actionVector, situationVector, cosine } from './packages/cognition/cognitive-pipeline/src/vectorizer.ts'

const COG = join(homedir(), '.dsh', 'cognitive-pipeline')
const args = process.argv.slice(2)
const threshold = Number((args.find(a => a.startsWith('--threshold')) ?? '--threshold=0.4').split('=')[1] ?? 0.4)
const asJson = args.includes('--json')
const goalMargin = Number((args.find(a => a.startsWith('--goal-margin')) ?? '--goal-margin=0.05').split('=')[1] ?? 0.05)

// 夹具注入点(cl-357): 判据要能喂合成数据 —— 否则"加余量后不许比不加更宽"这条单调性只能在会漂移的真实库上测。
const chainsPath = process.env.DSH_CHAIN_AUDIT_CHAINS || join(COG, 'chains.json')
const expsPath = process.env.DSH_CHAIN_AUDIT_EXPS || join(COG, 'experiences.jsonl')
const chains = JSON.parse(readFileSync(chainsPath, 'utf8'))
const exps = readFileSync(expsPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const byId = new Map(exps.map(e => [e.expId, e]))

const pairs = []
for (const chain of chains) {
  const members = (chain.memberExpIds ?? []).map(id => byId.get(id)).filter(Boolean)
  const goalVec = situationVector(String(chain.goal ?? ''))
  const principleVec = chain.distilledPrinciple ? situationVector(String(chain.distilledPrinciple)) : null
  const memberVecs = members.map(m => ({
    action: m.actionVector ?? actionVector(String(m.sar?.action ?? ''), []),   // 夹具可省 actionVector
    situation: situationVector(String(m.sar?.situation ?? '')),
  }))
  for (const query of exps) {
    const q = situationVector(String(query.sar?.situation ?? ''))
    const memberScore = memberVecs.reduce((best, v) => Math.max(best, cosine(q, v.action), cosine(q, v.situation)), 0)
    const goalScore = cosine(q, goalVec)
    const principleScore = principleVec === null ? 0 : cosine(q, principleVec)
    pairs.push({
      chainId: chain.chainId,
      queryExpId: query.expId,
      queryText: String(query.sar?.situation ?? '').slice(0, 60),
      member: Number(memberScore.toFixed(4)),
      goal: Number(goalScore.toFixed(4)),
      principle: Number(principleScore.toFixed(4)),
      oldHit: memberScore >= threshold,
      newHit: Math.max(memberScore, goalScore, principleScore) >= threshold,
      policyHit: memberScore >= threshold || Math.max(goalScore, principleScore) >= threshold + goalMargin,
    })
  }
}

const oldHits = pairs.filter(p => p.oldHit)
const newHits = pairs.filter(p => p.newHit)
const added = pairs.filter(p => !p.oldHit && p.newHit)
const bySource = {
  goalOnly: added.filter(p => p.member < threshold && p.goal >= threshold && p.principle < threshold).length,
  principleOnly: added.filter(p => p.member < threshold && p.principle >= threshold && p.goal < threshold).length,
  both: added.filter(p => p.member < threshold && p.goal >= threshold && p.principle >= threshold).length,
}
// "每个情境是否至少有 1 条链被服务" —— 过度服务的直接读数
const situations = new Set(pairs.map(p => p.queryExpId))
const servedOld = new Set(oldHits.map(p => p.queryExpId))
const servedNew = new Set(newHits.map(p => p.queryExpId))

// **决策层**口径: 真实系统每个情境只服务 1 条链(top-1) ⇒ 真正要量的是"赢家变了吗", 不是"多过阈几对"。
const perQuery = new Map()
for (const p of pairs) {
  const cur = perQuery.get(p.queryExpId) ?? { queryText: p.queryText, old: null, new: null, policy: null }
  if (cur.old === null || p.member > cur.old.score) cur.old = { chainId: p.chainId, score: p.member }
  const newScore = Math.max(p.member, p.goal, p.principle)
  if (cur.new === null || newScore > cur.new.score) cur.new = { chainId: p.chainId, score: newScore, by: p.member >= p.goal && p.member >= p.principle ? 'member' : (p.goal >= p.principle ? 'goal' : 'principle') }
  if (p.policyHit && (cur.policy === null || Math.max(p.member, p.goal, p.principle) > cur.policy.score)) {
    cur.policy = { chainId: p.chainId, score: Math.max(p.member, p.goal, p.principle) }
  }
  perQuery.set(p.queryExpId, cur)
}
const changed = [...perQuery.values()].filter(q => q.old.chainId !== q.new.chainId)
const changedToNonMember = changed.filter(q => q.new.by !== 'member')
// 加了 goalMargin 之后: 新增过阈对与赢家改变应各自归零或大幅缩小(策略是否真的挡住薄边)
const policyAdded = pairs.filter(p => !p.oldHit && p.policyHit)
const policyChanges = [...perQuery.values()].filter(q => q.old.chainId !== (q.policy?.chainId ?? q.old.chainId))

const report = {
  threshold,
  policyGoalMargin: goalMargin,
  policy: {
    addedPairs: policyAdded.length,
    winnerChanged: policyChanges.length,
    // 策略下"有链被服务"的情境数 —— 用它断言"成员路不受余量影响"(余量只该管链自身语义路)
    served: new Set(pairs.filter(p => p.policyHit).map(p => p.queryExpId)).size,
  },
  decision: {
    queries: perQuery.size,
    winnerChanged: changed.length,
    winnerChangedToGoalOrPrinciple: changedToNonMember.length,
    samples: changedToNonMember.slice(0, 6).map(q => ({ query: q.queryText.slice(0, 50), from: q.old.chainId.slice(0, 26), to: q.new.chainId.slice(0, 26), by: q.new.by, newScore: Number(q.new.score.toFixed(3)), oldScore: Number(q.old.score.toFixed(3)) })),
  },
  chains: chains.length,
  queries: exps.length,
  pairs: pairs.length,
  hitPairs: { old: oldHits.length, new: newHits.length, added: added.length },
  addedBySource: bySource,
  situationsServed: { total: situations.size, old: servedOld.size, new: servedNew.size,
    oldRate: servedOld.size / situations.size, newRate: servedNew.size / situations.size },
  addedSamples: added.sort((a, b) => Math.max(b.goal, b.principle) - Math.max(a.goal, a.principle)).slice(0, 8)
    .map(p => ({ chain: p.chainId.slice(0, 30), query: p.queryText, member: p.member, goal: p.goal, principle: p.principle })),
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`[chain-key] 阈值 ${threshold} | ${chains.length} 条链 × ${exps.length} 个情境查询 = ${pairs.length} 对`)
  console.log(`  过阈对: 旧(仅成员) ${oldHits.length} → 新(+目标/原则) ${newHits.length} (新增 ${added.length})`)
  console.log(`  新增来源: 仅目标 ${bySource.goalOnly} / 仅原则 ${bySource.principleOnly} / 两者 ${bySource.both}`)
  console.log(`  被服务的情境: 旧 ${servedOld.size}/${situations.size} (${(report.situationsServed.oldRate * 100).toFixed(1)}%)`
    + ` → 新 ${servedNew.size}/${situations.size} (${(report.situationsServed.newRate * 100).toFixed(1)}%)`)
  console.log(`  加 goalMargin=${report.policyGoalMargin} 后: 新增过阈对 ${report.policy.addedPairs} | 赢家改变 ${report.policy.winnerChanged}/${report.decision.queries}`)
  console.log(`  决策层(每情境只服务 1 条): 赢家改变 ${report.decision.winnerChanged}/${report.decision.queries}`
    + ` | 其中改由目标/原则键决定 ${report.decision.winnerChangedToGoalOrPrinciple}`)
  for (const d of report.decision.samples) {
    console.log(`    ${d.from} → ${d.to} (${d.by}) 旧 ${d.oldScore} 新 ${d.newScore} | ${d.query}`)
  }
  console.log('  新增抽样的最大 8 对(人读: 真找到还是撞词?):')
  for (const s of report.addedSamples) {
    console.log(`    ${s.chain.padEnd(30)} | 成员 ${s.member.toFixed(3)} 目标 ${s.goal.toFixed(3)} 原则 ${s.principle.toFixed(3)} | ${s.query}`)
  }
}
