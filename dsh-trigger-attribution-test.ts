/**
 * 触发词归因单测（tp-075 / T93）。
 *
 * 动机：`triggerSource` 只记**第一个**命中的词。实测 `static:异常` 出现在 239 条
 * 注入上、0 采纳——但这个词标签并不意味着"异常"单独开了闸门（弱静态词权重 0.4，
 * 要累积到 0.6）。按首命中词归因，会把无辜的词判死、放过真正的元凶。所以
 * `triggeredBy` 额外返回全部命中项(matched)与总分(score)，供真正的归因。
 *
 * 用法：npx tsx dsh-trigger-attribution-test.ts
 * 退出码：0 = 通过；1 = 有失败。
 */
import { triggeredBy } from './packages/context/cognitive-inject/src/index.ts'

const cases: Array<[string, boolean]> = []
const msg = (text: string): never => ([{
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
}] as never)

const fakeService = {
  resolved: { triggerJumpWeightScale: 0.5 },
  triggerJumps: () => [],
  store: { experiencesSnapshot: () => [] },
} as never

const run = (text: string): ReturnType<typeof triggeredBy> => triggeredBy(msg(text), fakeService, 1)

// ① 强词单独开闸, matched 记录该词与权重
const strong = run('服务崩溃了')
cases.push(['强词单独开闸', strong.fired === true])
cases.push(['强词 matched 含该词(kind=static)',
  strong.matched.some(m => m.word.includes('崩溃') && m.kind === 'static' && m.weight > 0.5)])

// ② 单个弱词不开闸(权重 0.4 < 阈值 0.6)
const weakOne = run('我有个计划')
cases.push(['单弱词不开闸', weakOne.fired === false])
cases.push(['未开闸也记录 matched 与 score(可查为什么没开)',
  weakOne.matched.length >= 1 && weakOne.score > 0 && weakOne.score < 0.6])

// ③ 两个弱词累积开闸, matched 必须同时含两个词(首命中标签只反映第一个)
const weakTwo = run('我有个计划, 需要验证一下')
cases.push(['两弱词累积开闸', weakTwo.fired === true])
cases.push(['matched 含全部命中词(非仅首命中)',
  weakTwo.matched.length >= 2 && new Set(weakTwo.matched.map(m => m.word)).size >= 2])

// ④ 无触发词: 不开闸且 matched 为空
const none = run('今天天气不错')
cases.push(['无触发词不开闸', none.fired === false && none.matched.length === 0 && none.score === 0])

// ⑤ triggerSource 仍是首命中词(向后兼容: 账本历史字段语义不变)
cases.push(['triggerSource 仍为首命中词', weakTwo.triggerSource === `static:${weakTwo.matched[0]?.word}`])

const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
