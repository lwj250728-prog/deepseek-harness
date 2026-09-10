/**
 * 等待型 nextAction 判定单测（tp-072 / T90）。
 *
 * cl-110: 旧守卫正则 `待[0-9]{4}` 不匹配 `待 09-11 06:5x 复核`（待后有空格），
 * 于是等待型目标照样被推行动帧——实测同一目标在 08:00-09:00 被推了 4 次。
 * 空白是排版不是意图，判定必须容忍它；同时要避免把 `待办`/`待修` 这类
 * "看起来像待"的可执行项误判为等待(那会让可执行目标永远不被推)。
 *
 * 用法：npx tsx dsh-waiting-guard-test.ts
 * 退出码：0 = 全部通过；1 = 有失败。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isWaitingNextAction } from './packages/context/quiet-driver/src/waiting.ts'

const cases: Array<[string, string, boolean]> = [
  // [用例名, nextAction, 期望]
  ['待用户前缀', '待用户拍板换模(cl-094 ①②)', true],
  ['等待用户前缀', '等待用户确认发布', true],
  ['日期(无空格)', '待09-11 06:5x 复核 cl-102 窗口占比', true],
  ['日期(有空格) — cl-110 回归', '待 09-11 06:5x 复核(等待型): ①cl-102 帧生占比', true],
  ['日期(等待+空格)', '等待 09-11 复核跳词表', true],
  ['事件等待', '待事件: 用户下次上线时确认发布 A/B', true],
  ['外部等待', '等外部数据到齐后重算引用率', true],
  ['可执行(执行型前缀)', 'cl-100: 重算 09-06 之后引用率', false],
  ['可执行(待办) — 不得误判', '待办: 补齐 T88 的两族断言', false],
  ['可执行(待修) — 不得误判', '待修: 巡检真相源改查实时目录', false],
  ['可执行(待验证)', '待验证: 帧生占比是否降到 5% 以下', false],
  ['空串', '   ', false],
]

const failed: string[] = []
for (const [name, action, want] of cases) {
  const got = isWaitingNextAction(action)
  if (got !== want) failed.push(`${name}(got=${got} want=${want})`)
}

// ── 效果见证: 修复之后不得再有"等待型目标被推行动帧" ──────────────────────────
// 判据锚在产物构建时刻(而不是"最近 N 小时"), 否则修复前的旧轰炸会长期压红;
// 同时打印审计条数, 让"空过"是可见的而不是藏起来的。
const LIB = join(homedir(), 'dsh-fork/packages/context/quiet-driver/lib/index.js')
const FRAMES = join(homedir(), '.dsh/cognitive-pipeline/quiet-driver-frames.jsonl')
let audited = 0
try {
  const cutoff = statSync(LIB).mtimeMs
  const rows = readFileSync(FRAMES, 'utf8').split('\n').filter(line => line.trim().length > 0)
  for (const line of rows) {
    let record: { kind?: unknown, ts?: unknown, nextAction?: unknown, goalId?: unknown }
    try { record = JSON.parse(line) } catch { continue }
    if (record.kind !== 'action-frame') continue
    if (typeof record.ts !== 'number' || record.ts <= cutoff) continue
    audited += 1
    if (typeof record.nextAction === 'string' && isWaitingNextAction(record.nextAction)) {
      failed.push(`构建后仍有等待型目标收到行动帧: ${String(record.goalId)} → ${record.nextAction.slice(0, 40)}`)
    }
  }
} catch (error) {
  failed.push(`行动帧审计无法执行: ${String(error)}`)
}
console.log(`效果见证: 构建后行动帧审计 ${audited} 条`)
if (failed.length > 0) {
  console.error(`失败 ${failed.length}/${cases.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`通过 ${cases.length}/${cases.length}`)
