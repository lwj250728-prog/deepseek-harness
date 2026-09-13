/**
 * verify-deployed-chain.mjs — **对构建产物**做经验链检索的端到端校验(cl-353)。
 *
 * 为什么需要它: spec 跑的是 `src`(vitest 用 tsconfig paths 把包名指向 src), 而载体加载的是
 * `lib`。今晚反复出现的病就是"声明在, 行为不在" —— 源码绿了不等于产物绿, 更不等于载体在跑它。
 * 这个脚本只碰产物: `../lib/index.js`(本包)与本包 node_modules 里解析到的 pipeline lib。
 * 它把"链能不能被找到/被注入/引用能不能回填"三件事在**产物层**再证一次, 于是"载体加载后可用"
 * 里唯一剩下的未知数就只有**加载时刻**本身。
 *
 * 注入点(给判据/探针):
 *   DSH_VERIFY_INJECT_ARTIFACT  用别的 inject 产物文件替代 ../lib/index.js(探针喂缺陷件用)
 *
 * 用法: node packages/context/cognitive-inject/scripts/verify-deployed-chain.mjs [--json]
 * 退出码: 0 = 产物层三项全通; 1 = 有断言失败; 3 = 环境不成立(产物缺失/依赖解析不了)。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as cognitivePipeline from '@deepseek-ai/dsh-cognitive-pipeline'
import { actionVector, outcomeVector } from '@deepseek-ai/dsh-cognitive-pipeline/src/vectorizer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ARTIFACT = join(HERE, '..', 'lib', 'index.js')
const ARTIFACT = process.env.DSH_VERIFY_INJECT_ARTIFACT || DEFAULT_ARTIFACT
const SIGNAL = new AbortController().signal
const json = process.argv.includes('--json')

if (!existsSync(ARTIFACT)) {
  console.error(`[verify] 产物不存在: ${ARTIFACT} ⇒ 环境不成立`)
  process.exit(3)
}
// **只加载产物**: 用 file URL 动态 import, 绕开 tsconfig alias/vitest 的 src 解析。
const cognitiveInject = await import(pathToFileURL(ARTIFACT).href)

function stubAgent(rawId) {
  const session = Session.create(SessionId(rawId))
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return 'running' },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session }
}

function seed(store, expId, situation, action, outcome, chainId) {
  const utility = { materialGain: 6, emotionalValence: 6, energyCost: 4 }
  store.addExperience({
    expId,
    sar: { situation, action, outcome, actionKeywords: [], outcomeUtility: utility },
    actionVector: actionVector(action, []),
    outcomeVector: outcomeVector(utility, outcome),
    clusterId: null,
    strategyLabel: null,
    timestamp: Date.now(),
    predictionError: null,
    cumulativeError: 0,
    hitCount: 0,
    positiveCount: 0,
    simulated: false,
    verification: 'verified',
    evidenceScore: 0,
    chainId,
  })
}

async function fire(ctx, agent, turn, step, text) {
  const proposed = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'verify-deployed-chain' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter', messages: [proposed] }),
  )
  const injected = []
  if (decision.kind === 'enter') {
    for (const message of decision.messages) {
      if (message === proposed) continue
      agent.session.append('user/message', message, { surfaceOp: 'append' })
      injected.push(message.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return injected
}

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }

const root = mkdtempSync(join(tmpdir(), 'verify-deployed-'))
const ctx = new Context()
let teardown = async () => { rmSync(root, { recursive: true, force: true }) }
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(cognitivePipeline, { enabled: false, root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(cognitiveInject, { topK: 1, minSimilarity: 0.4 })

  const store = ctx.cognitivePipeline.store
  const SIT = '服务重启后需要验证恢复'
  seed(store, 'exp_1', SIT, '重启服务并验证', '恢复成功', 'chain-restart')
  seed(store, 'exp_2', SIT, '查看日志确认', '确认无异常', 'chain-restart')
  seed(store, 'exp_3', SIT, '跑一次冒烟', '通过', 'chain-restart')
  const chain = await ctx.cognitivePipeline.consolidateChain('chain-restart', '服务重启后验证恢复')
  check('链已合成(3 成员过门)', chain !== null && store.chainsSnapshot().length === 1,
    `chains=${store.chainsSnapshot().length}`)

  const { agent, session } = stubAgent('verify-deployed')
  session.append('turn/start', { turn: 1 })
  const injected = await fire(ctx, agent, 1, 1, SIT)

  const chainText = injected.find(t => t.includes('【经验链参考】'))
  check('产物把链树注入进上下文', chainText !== undefined, `注入段落数=${injected.length}`)
  check('注入文本点名 chainId(引用契约)', chainText !== undefined && chainText.includes('chain-restart'))
  check('注入文本含链的目标行(真的渲染了树)',
    chainText !== undefined && chainText.includes('目标：服务重启后验证恢复'))

  const records = store.injectionsSnapshot()
  const withChain = records.filter(r => r.chainId === 'chain-restart')
  check('注入记录带 chainId(结算侧才有得折)', withChain.length === 1, `带链记录=${withChain.length}`)

  const settled = await ctx.cognitivePipeline.settleInjectionCitations(
    String(session.id), '按 chain-restart 这条链的骨架来做')
  const after = store.getChain('chain-restart')
  check('引用结算把 chainId 折进链账本', settled.cited >= 1 && after?.hitCount === 1 && after?.citedCount === 1,
    `cited=${settled.cited} hit=${after?.hitCount} citedCount=${after?.citedCount}`)
} catch (error) {
  check('执行未抛异常', false, String(error && error.message ? error.message : error).slice(0, 200))
} finally {
  await teardown().catch(() => {})
}

const failed = checks.filter(c => !c.ok)
if (json) {
  console.log(JSON.stringify({ artifact: ARTIFACT, passed: checks.length - failed.length, total: checks.length, checks }, null, 2))
} else {
  console.log(`[verify] 产物: ${ARTIFACT}`)
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`)
  console.log(`[verify] ${failed.length === 0 ? '产物层全通' : '**产物层判红**'}: ${checks.length - failed.length}/${checks.length}`)
}
process.exit(failed.length === 0 ? 0 : 1)
