/**
 * 告警账本纯函数单测（tp-071 / T89）。
 *
 * cl-109 把"复用已有未关闭告警"与"本地日历日"抽成纯函数，正是为了能在**不等待
 * 真实停摆/到期**的情况下验证它们——真实触发一次停摆需要系统真的坏掉，而这两条
 * 语义（last-wins、前缀隔离、坏行容错、日期偏移）本来就可以离线判定。
 *
 * 用法：npx tsx dsh-alert-ledger-test.ts
 * 退出码：0 = 全部通过；1 = 有失败（打印失败用例名）。
 */
import { findOpenAlertId, localDay } from './packages/context/quiet-driver/src/alert-ledger.ts'

const ledger = (rows: readonly Record<string, unknown>[]): string =>
  rows.map(row => JSON.stringify(row)).join('\n') + '\n'

const cases: Array<[string, boolean]> = []
const alerts = (status: string, ids: readonly string[]): string =>
  ledger(ids.map(id => ({ id, status })))

// ① 单条 open => 返回该 id
cases.push(['单条 open 返回其 id',
  findOpenAlertId(alerts('open', ['cl-stall-1']), 'cl-stall-') === 'cl-stall-1'])

// ② open 之后写了 done（last-wins）=> 视为已关闭
cases.push(['open 后 done 视为关闭',
  findOpenAlertId(ledger([{ id: 'cl-stall-1', status: 'open' }, { id: 'cl-stall-1', status: 'done' }]),
    'cl-stall-') === null])

// ③ done 之后又开新单 => 返回新的那条
cases.push(['关闭后再开单返回新单',
  findOpenAlertId(ledger([{ id: 'cl-stall-1', status: 'done' }, { id: 'cl-stall-2', status: 'open' }]),
    'cl-stall-') === 'cl-stall-2'])

// ④ 前缀隔离：停摆族的 open 不影响到期族查询（两族各自幂等）
cases.push(['前缀隔离',
  findOpenAlertId(alerts('open', ['cl-stall-9']), 'cl-model-expired') === null])

// ⑤ 坏行不炸 + localDay(plusDays) 是本地日历日偏移
const withBadLine = alerts('open', ['cl-stall-1']) + 'not json\n'
const diffDays = Math.round(
  (new Date(`${localDay(3)}T00:00:00`).getTime() - new Date(`${localDay(0)}T00:00:00`).getTime()) / 86400000)
cases.push(['坏行容错 + localDay 偏移 3 天',
  findOpenAlertId(withBadLine, 'cl-stall-') === 'cl-stall-1' && diffDays === 3])

// ⑥ 跨 UTC 日边界：本地 00:30 时, toISOString 会给前一天, localDay 必须给当天
const localMidnight = new Date('2026-09-10T00:30:00+08:00')
cases.push(['本地 00:30 取本地日(非 UTC 前一日)',
  localDay(0, localMidnight) === '2026-09-10'
  && localMidnight.toISOString().slice(0, 10) === '2026-09-09'])

const failed = cases.filter(([, ok]) => !ok).map(([name]) => name)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
