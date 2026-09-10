/**
 * 覆盖选择的新颖性偏好单测（tp-083 / T98）。
 *
 * cl-121 的依据：用 pipeline 自身 outcomePolarity 判定，干净窗口 43 条注入里 19 条
 * 恰为"一负一正"——面世的不是 top-1 记忆，而是 coverViewpoints 选出的失败/成功对照对；
 * 浓度(top5 占 69% 槽位)的真实含义是**同一对反复被选中**。
 *
 * 修法不是闸门(那会静默通道, cl-118/119 的教训), 而是: 分数在 margin 内时, 改选
 * "本会话注入次数更少"的那一条——保持对照结构, 轮换成员。
 *
 * 用法：npx tsx dsh-novelty-pick-test.ts
 * 退出码：0 = 通过；1 = 有失败。
 */
import { coverViewpoints } from './packages/context/cognitive-inject/src/index.ts'

interface Hit { expId: string, text: string, polarity: 'positive' | 'negative' | 'neutral', similarity: number }
const hit = (expId: string, polarity: Hit['polarity'], similarity: number): Hit =>
  ({ expId, text: expId, polarity, similarity })

const cases: Array<[string, boolean]> = []

// ① 关闭新颖性(margin=0) → 仍取分数最高的失败+成功
const base = coverViewpoints([
  hit('negBest', 'negative', 0.70), hit('negSecond', 'negative', 0.68),
  hit('posBest', 'positive', 0.75), hit('posSecond', 'positive', 0.73),
] as never, 2)
cases.push(['关闭时取最高分对照对(不变)', base.map(h => h.expId).sort().join(',') === 'negBest,posBest'])

// ② 开启新颖性: negBest 已注入 5 次、negSecond 0 次(分数在 margin 内) → 换 negSecond
const rotated = coverViewpoints([
  hit('negBest', 'negative', 0.70), hit('negSecond', 'negative', 0.68),
  hit('posBest', 'positive', 0.75), hit('posSecond', 'positive', 0.73),
] as never, 2, id => ({ negBest: 5, negSecond: 0, posBest: 5, posSecond: 0 }[id] ?? 0), 0.05)
cases.push(['新颖性: 失败侧换人', rotated.some(h => h.expId === 'negSecond')])
cases.push(['新颖性: 成功侧换人', rotated.some(h => h.expId === 'posSecond')])
cases.push(['新颖性: 仍保持一负一正(对照结构不破)',
  rotated.some(h => h.polarity === 'negative') && rotated.some(h => h.polarity === 'positive')])

// ③ 分数差超出 margin → 不换(不为了新颖牺牲相关性)
const outside = coverViewpoints([
  hit('negBest', 'negative', 0.90), hit('negFar', 'negative', 0.50),
  hit('posBest', 'positive', 0.90),
] as never, 2, id => (id === 'negBest' ? 5 : 0), 0.05)
cases.push(['超出 margin 不换(相关性优先)', outside.some(h => h.expId === 'negBest')])

// ④ 单一极性 → 退回按分数切片(不强行凑对照)
const single = coverViewpoints([
  hit('p1', 'positive', 0.80), hit('p2', 'positive', 0.70),
] as never, 1, () => 0, 0.05)
cases.push(['单一极性按分数切片', single.length === 1 && single[0]?.expId === 'p1'])

// ⑤ 同新颖度 → 取分数更高者
const tie = coverViewpoints([
  hit('a', 'negative', 0.70), hit('b', 'negative', 0.68), hit('c', 'positive', 0.75),
] as never, 2, () => 0, 0.05)
cases.push(['同新颖度取高分', tie.some(h => h.expId === 'a')])

const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
