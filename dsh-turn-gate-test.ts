/**
 * 回合类型闸门单测（tp-073 / T91）。
 *
 * cl-114 的证据基础：主会话 852 条已结算注入按回合类别拆——用户回合 5.2%、
 * 行动帧 2.0%、反思类帧 0/501；而同样的反思帧在 1–3 回合的新会话（子代理/旁路）
 * 里采纳率 ~17%。闸门必须在"长会话 + 反思帧"这一格静默，同时**不能**误伤
 * 新会话的反思帧（那是当前采纳数的最大来源）。
 *
 * 用法：npx tsx dsh-turn-gate-test.ts
 * 退出码：0 = 通过；1 = 有失败。
 */
import { classifyTurnKind, decideInjection } from './packages/context/cognitive-inject/src/turn-kind.ts'

type Msg = Parameters<typeof classifyTurnKind>[0][number]
const user = (text: string): Msg => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const frame = (form: string, summary: string, text = ''): Msg => ({
  content: text ? [{ type: 'text', text }] : [],
  source: { kind: 'plugin', plugin: 'quiet-driver', form, summary },
})

const cases: Array<[string, boolean]> = []
const expectKind = (name: string, msgs: Msg[], want: string): void => {
  const got = classifyTurnKind(msgs)
  cases.push([`${name}(got=${got} want=${want})`, got === want])
}
expectKind('用户消息 → user', [user('把采用率提上去')], 'user')
expectKind('行动帧 summary', [frame('notice', '行动帧 #5: 检索算法优化（词元素通道 → 稀疏检索族）')], 'action-frame')
expectKind('行动帧 正文头', [frame('action-frame', '', '【行动帧】(source: plugin/quiet-driver, form: action-frame)')], 'action-frame')
expectKind('三问帧', [frame('epistemic-frame', '【三问帧】(source: plugin/quiet-driver)')], 'reflective-frame')
expectKind('测试审视帧', [frame('test-review-frame', '【测试审视帧】测试账本当前为空')], 'reflective-frame')
expectKind('测试计划帧', [frame('test-plan-frame', '【测试计划帧】待验证的机制推进')], 'reflective-frame')
expectKind('旁路三问', [frame('notice', '旁路三问 #22：检测到风险信号')], 'reflective-frame')
expectKind('未知插件帧 → 反思类', [frame('weird-form', '某种新帧')], 'reflective-frame')
expectKind('无来源 → unknown', [{ content: [{ type: 'text', text: 'hi' }] }], 'unknown')

const expectGate = (name: string, kind: Parameters<typeof decideInjection>[0]['kind'], turns: number, want: string): void => {
  const got = decideInjection({ kind, sessionTurns: turns, establishedSessionTurns: 20 })
  cases.push([`${name}(got=${got} want=${want})`, got === want])
}
expectGate('长会话·用户回合 → 注入', 'user', 1122, 'inject')
expectGate('长会话·行动帧 → 严格注入', 'action-frame', 1122, 'inject-strict')
expectGate('长会话·反思帧 → 静默', 'reflective-frame', 1122, 'skip')
expectGate('新会话·反思帧 → 注入(旁路/子代理是最大来源)', 'reflective-frame', 3, 'inject')
expectGate('新会话·行动帧 → 注入', 'action-frame', 2, 'inject')
expectGate('未知来源 → 保守注入', 'unknown', 1122, 'inject')
expectGate('边界: 恰好 established 阈值 → 静默', 'reflective-frame', 20, 'skip')
expectGate('边界: 阈值下一回合 → 注入', 'reflective-frame', 19, 'inject')

const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
