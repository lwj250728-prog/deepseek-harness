/**
 * 经验退避单测（tp-079 / T95）。
 *
 * cl-118 修订版：不是"未引用 3 次就停"，而是**按未引用连击加倍冷却**。
 * 依据：记录里仅有的两次采纳发生在 exp_126 的**第 68 次**注入与 exp_264 的**第 6 次**
 * ——硬抑制会把这两次掐掉（指标更好看，价值归零）。退避保留"某次终于落地"的通道，
 * 只削体积；一旦被引用过，连击清零（证明这条提醒能落地，不该继续处罚它）。
 *
 * 用法：npx tsx dsh-inject-backoff-test.ts
 * 退出码：0 = 通过；1 = 有失败。
 */
import { admitLeastBackedOff, backoffDelayMs, backoffState } from './packages/context/cognitive-inject/src/inject-backoff.ts'

const cases: Array<[string, boolean]> = []
const BASE = 10 * 60 * 1000        // 10 分钟
const MAX = 6 * 60 * 60 * 1000     // 6 小时

// ① 连击 0 → 基础冷却
cases.push(['连击 0 = 基础冷却', backoffDelayMs(0, BASE, MAX) === BASE])
// ② 指数增长
cases.push(['连击 1 = 2×', backoffDelayMs(1, BASE, MAX) === 2 * BASE])
cases.push(['连击 3 = 8×', backoffDelayMs(3, BASE, MAX) === 8 * BASE])
// ③ 上限封顶(连击 76 也不能溢出成 Infinity/巨大数)
cases.push(['连击 76 封顶 6h', backoffDelayMs(76, BASE, MAX) === MAX])
cases.push(['连击 1000 仍有限且等于上限', Number.isFinite(backoffDelayMs(1000, BASE, MAX)) && backoffDelayMs(1000, BASE, MAX) === MAX])
// ④ base=0 → 不退避(可关闭)
cases.push(['base=0 时退避关闭', backoffDelayMs(5, 0, MAX) === 0])
// ⑤ 负数/小数连击按 0 处理
cases.push(['负数连击按 0', backoffDelayMs(-3, BASE, MAX) === BASE])

const now = Date.now()
const state = backoffState([
  // exp_a: 连续 3 次未引用 → 8× 冷却
  { expId: 'exp_a', injectedAt: now - 3 * 3600_000, cited: false },
  { expId: 'exp_a', injectedAt: now - 2 * 3600_000, cited: false },
  { expId: 'exp_a', injectedAt: now - 1 * 3600_000, cited: false },
  // exp_b: 最近一次被引用 → 连击清零 → 基础冷却
  { expId: 'exp_b', injectedAt: now - 7200_000, cited: false },
  { expId: 'exp_b', injectedAt: now - 3600_000, cited: true },
  // exp_c: 只有一次未结算(待结) → 记为未引用连击 1
  { expId: 'exp_c', injectedAt: now - 600_000, cited: null },
], now, BASE, MAX)

cases.push(['exp_a 连击 3 → 8×', state.get('exp_a')?.uncitedStreak === 3
  && state.get('exp_a')?.effectiveCooldownMs === 8 * BASE])
cases.push(['exp_b 被引用过 → 连击清零、基础冷却',
  state.get('exp_b')?.uncitedStreak === 0 && state.get('exp_b')?.effectiveCooldownMs === BASE])
cases.push(['exp_c 未结算计 1 次连击', state.get('exp_c')?.uncitedStreak === 1])
cases.push(['lastInjectedAt 取最近一次', state.get('exp_a')?.lastInjectedAt === now - 1 * 3600_000])

// ── 通道保活守卫(cl-118 实测: 6h 上限把整条通道静默了 40 分钟) ──
const MIN = 60 * 1000
// ① 全部候选都在退避中, 但基础冷却已过 → 放行最接近到期的那个
// a 距到期 70min(120-50), b 距到期 380min(480-100) => 应放行 a(最接近到期)
cases.push(['保活: 放行最接近到期者', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 50 * MIN, effectiveCooldownMs: 120 * MIN },
  { expId: 'b', lastInjectedAt: now - 100 * MIN, effectiveCooldownMs: 480 * MIN },
], now, 10 * MIN) === 'a'])
// ② 基础冷却都没过 → 就该静默(不能破坏"10 分钟内不重复"的不变式)
cases.push(['保活: 基础冷却未过则静默', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 3 * MIN, effectiveCooldownMs: 120 * MIN },
], now, 10 * MIN) === null])
// ③ 空集合 → null
cases.push(['保活: 无候选返回 null', admitLeastBackedOff([], now, 10 * MIN) === null])
// ④ 部分候选基础冷却已过 → 只在合格者里挑
cases.push(['保活: 只在不破坏基础冷却的候选里挑', admitLeastBackedOff([
  { expId: 'fresh', lastInjectedAt: now - 2 * MIN, effectiveCooldownMs: 60 * MIN },
  { expId: 'old', lastInjectedAt: now - 200 * MIN, effectiveCooldownMs: 240 * MIN },
], now, 10 * MIN) === 'old'])
// ⑤ cl-195 闲置门: 会话 5 分钟前刚注入过(实测节奏中位 5.2 分钟) → 保活不得开火
cases.push(['闲置门: 会话刚注入过则保活静默', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 50 * MIN, effectiveCooldownMs: 120 * MIN },
], now, 10 * MIN, now - 5 * MIN, 60 * MIN) === null])
// ⑥ 闲置门: 会话真的闲置超阈值(原始事故: 40 分钟零注入) → 保活照常放行
cases.push(['闲置门: 真闲置超阈值则保活照常', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 50 * MIN, effectiveCooldownMs: 120 * MIN },
], now, 10 * MIN, now - 90 * MIN, 60 * MIN) === 'a'])
// ⑦ 闲置门关闭(idleMs=0) → 退回旧行为(便于复现"被架空的退避")
cases.push(['闲置门关闭时退回旧行为', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 50 * MIN, effectiveCooldownMs: 120 * MIN },
], now, 10 * MIN, now - 5 * MIN, 0) === 'a'])
// ⑧ 无注入历史(lastAnyInjectionAt=0) → 闲置门不阻断(不该因"没有历史"而静默)
cases.push(['闲置门: 无注入历史时不阻断', admitLeastBackedOff([
  { expId: 'a', lastInjectedAt: now - 50 * MIN, effectiveCooldownMs: 120 * MIN },
], now, 10 * MIN, 0, 60 * MIN) === 'a'])

const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
