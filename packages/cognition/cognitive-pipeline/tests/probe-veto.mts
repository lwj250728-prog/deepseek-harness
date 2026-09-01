// veto 门实测：闲聊假阳性拦截率 + 业务真阳性误杀率
// 用真实 LLM（deepseek）跑 template 7 refineRetrieval
import * as fs from 'node:fs'
const keyLine = fs.readFileSync('D:/DeepSeek-Harness/data/.credentials.yaml', 'utf8').split('\n').find(l => l.includes('DEEPSEEK_API_KEY'))
process.env.DEEPSEEK_API_KEY = keyLine.split(': ')[1].trim()

const { Context } = await import('@deepseek-ai/cordis')
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
const deepseekMod = await import('../../../llm/llm-deepseek/src/index.ts')
const { refineRetrieval } = await import('../src/llm.ts')
const { CognitiveStore } = await import('../src/store.ts')

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await deepseekMod.apply(ctx, {})
const store = new CognitiveStore('D:/DeepSeek-Harness/data/cognitive-pipeline')
await store.load()

// 从磁盘重建：expId -> text（与 retrieve 的 text 格式一致）
const byId = new Map()
for (const line of fs.readFileSync('D:/DeepSeek-Harness/data/cognitive-pipeline/experiences.jsonl', 'utf8').split('\n').filter(Boolean)) {
  const e = JSON.parse(line)
  if (e.simulated && e.verification === 'unverified') continue
  byId.set(e.expId, `${e.sar.situation}。${e.sar.action}。${e.sar.outcome}`)
}

// 测试案例：(消息, 命中的expId, 类型, 期望)
// 期望：chitchat 应被 veto（拦截），business 应保留
const cases = [
  // 闲聊假阳性（0.45+ 或高相似）——期望 veto 拦截
  { msg: '衣服洗好了吗', expId: 'exp_95', type: 'chitchat', expect: 'reject' },
  { msg: '新发型怎么样', expId: 'exp_51', type: 'chitchat', expect: 'reject' },
  { msg: '推荐一部好看的电影', expId: 'exp_169', type: 'chitchat', expect: 'reject' },
  { msg: '空调开多少度合适', expId: 'exp_78', type: 'chitchat', expect: 'reject' },
  { msg: '你吃饭了吗', expId: 'exp_82', type: 'chitchat', expect: 'reject' },
  { msg: '帮我找个停车场', expId: 'exp_323', type: 'chitchat', expect: 'reject' },
  // 业务真阳性（0.45+ 或明显相关）——期望 veto 保留
  { msg: '测试脚本挂起需要排查原因', expId: 'exp_301', type: 'business', expect: 'keep' },
  { msg: '发酵罐诱导期温度异常', expId: 'exp_278', type: 'business', expect: 'keep' },
  { msg: '深海推进器振动异常需要调整参数', expId: 'exp_178', type: 'business', expect: 'keep' },
  { msg: '服务重启后需要验证恢复情况', expId: 'exp_315', type: 'business', expect: 'keep' },
  { msg: '之前的排查经验参考一下', expId: 'exp_67', type: 'business', expect: 'keep' },
  { msg: '日志滚动太快需要检查', expId: 'exp_1', type: 'business', expect: 'keep' },
]

let rejectChitchat = 0, keepChitchat = 0, keepBusiness = 0, rejectBusiness = 0
console.log('=== veto 门实测（真实 LLM）===')
for (const c of cases) {
  const text = byId.get(c.expId) ?? `[缺] ${c.expId}`
  const decision = await refineRetrieval(ctx, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, {
    situation: c.msg, action: c.msg,
  }, [{ expId: c.expId, text, similarity: 0.45 }], { sessionId: 'probe' })
  const action = decision.shouldKeep ? 'KEEP' : 'REJECT'
  if (c.type === 'chitchat') { if (decision.shouldKeep) keepChitchat++; else rejectChitchat++ }
  else { if (decision.shouldKeep) keepBusiness++; else rejectBusiness++ }
  const ok = (c.expect === 'keep' && decision.shouldKeep) || (c.expect === 'reject' && !decision.shouldKeep)
  console.log(`${ok ? '✅' : '❌'} [${c.type}] ${action.padEnd(6)} "${c.msg.slice(0, 14)}" → ${c.expId} | ${decision.reason ? '理由:' + decision.reason.slice(0, 40) : ''}`)
}
console.log(`\n=== 汇总 ===`)
console.log(`闲聊假阳性拦截率: ${rejectChitchat}/${rejectChitchat + keepChitchat} (${(rejectChitchat / (rejectChitchat + keepChitchat) * 100).toFixed(0)}%)`)
console.log(`业务真阳性保留率: ${keepBusiness}/${keepBusiness + rejectBusiness} (${(keepBusiness / (keepBusiness + rejectBusiness) * 100).toFixed(0)}%)`)
