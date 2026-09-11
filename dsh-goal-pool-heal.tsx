/**
 * dsh-goal-pool-heal.tsx — 用插件同一个向量器把目标池缺失的向量补齐(cl-235 收尾)。
 *
 * 为什么需要: 插件对缺失向量是**内存内自愈**(载入时按 kernel/focus 文本重算), 不回写文件; 而池压实
 * 或"清空向量等自愈"之后, 文件里就没有向量了 —— 插件能跑(它自己heal), 但所有**离线**读池的工具
 * (dsh-layer-sim / dsh-layer-tune / 入池体检)会失去输入。本工具按同一实现补回来, 使池自洽、
 * 插件自愈变成空操作。
 *
 * 用法: npx tsx dsh-goal-pool-heal.tsx [--pool P] [--write] [--json]
 * 退出码: 0 无需补齐或已补齐; 2 仍有目标缺文本(kernel 与 focus 都空, 无法造向量)。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { situationVector } from './packages/cognition/cognitive-pipeline/src/vectorizer.ts'

const arg = (n: string, f?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : f
}
const POOL = arg('pool', join(homedir(), '.dsh/cognitive-pipeline/dormant-goals.jsonl')) as string
const WRITE = process.argv.includes('--write')
const rows = readFileSync(POOL, 'utf8').split('\n').filter(l => l.trim() !== '')
  .map(l => JSON.parse(l) as Record<string, unknown>)

const healed: string[] = []
const unhealable: string[] = []
for (const goal of rows) {
  const kernel = String(goal.kernel ?? goal.title ?? '')
  const focus = String(goal.focus ?? goal.title ?? '')
  const missing = (['repVector', 'kernelVector', 'focusVector'] as const)
    .some(k => !Array.isArray(goal[k]) || (goal[k] as number[]).length === 0)
  if (!missing) continue
  if (kernel === '' && focus === '') { unhealable.push(String(goal.id)); continue }
  goal.repVector = situationVector(`${kernel} ${focus}`)
  goal.kernelVector = situationVector(kernel)
  goal.focusVector = situationVector(focus)
  healed.push(String(goal.id))
}

if (WRITE && healed.length > 0) {
  copyFileSync(POOL, `/tmp/dormant-goals.before-heal-${Date.now()}.jsonl`)
  writeFileSync(POOL, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}
const report = { pool: POOL, goals: rows.length, healed, unhealable, written: WRITE && healed.length > 0 }
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 1))
else {
  console.log(`池 ${rows.length} 个目标 | 补齐向量 ${healed.length} 个${healed.length > 0 ? ': ' + healed.join(', ') : ''}${WRITE ? '(已写入)' : '(dry-run)'}`)
  if (unhealable.length > 0) console.log(`无法补齐(kernel 与 focus 皆空): ${unhealable.join(', ')}`)
}
process.exit(unhealable.length > 0 ? 2 : 0)
