/**
 * dsh-layer-sim.tsx — 离线复算"两道门"的相似度(cl-215 / cl-216 第二版)。
 *
 * 为什么需要它: 唤醒是两道门 —— 先 `rep = cos(situation, repVector) >= repThreshold(0.48)`,
 * 再 `layer sim = max(rep, cos(situation, kernelVector), cos(situation, focusVector)) >= need`
 * (kernel 0.62 / focus 0.55)。第二道的**阈值更高**, 所以"rep 已越线却不唤醒"只能由第二道解释,
 * 而部署中的 lib 还没有第二道的埋点(源码 15:50 有、产物 15:43 没有) —— 于是用本脚本在**不改运行时**
 * 的前提下把它算出来: 用与插件同一个 `situationVector` 实现, 并用一条**已落盘的日志值**做自校
 * (算出的 rep 必须等于日志里的 rep, 否则说明向量空间/情境文本取错, 结论一律不算)。
 *
 * 用法:
 *   npx tsx dsh-layer-sim.tsx [--situation-file P | --situation TEXT] [--pool P] [--expect-rep 0.5207]
 * 输出: JSON {rep, repThreshold, repPass, kernelSim, focusSim, layerSim, layer, layerNeed, layerPass, selfCheck}
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cosine, situationVector } from './packages/cognition/cognitive-pipeline/src/vectorizer.ts'

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const GOAL = arg('goal', 'goal-experience-library') as string
const POOL = arg('pool', join(homedir(), '.dsh/cognitive-pipeline/dormant-goals.jsonl')) as string
const REP_THRESHOLD = Number(arg('rep-threshold', '0.48'))
const KERNEL_NEED = Number(arg('kernel-need', '0.62'))
const FOCUS_NEED = Number(arg('focus-need', '0.55'))
const expectRep = arg('expect-rep')

/** last-wins pool read: the file is append-only, one goal id may appear many times. */
const pool = new Map<string, Record<string, unknown>>()
for (const line of readFileSync(POOL, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const row = JSON.parse(line) as Record<string, unknown>
  pool.set(String(row.id), row)
}
const goal = pool.get(GOAL)
if (goal === undefined) {
  console.error(`池里没有目标 ${GOAL}`)
  process.exit(2)
}

let situation = arg('situation')
if (situation === undefined) {
  const file = arg('situation-file')
  if (file !== undefined) situation = readFileSync(file, 'utf8')
  else {
    // 默认取情境链最新节点(与插件在提交后评估时用的文本同源)
    const chain = JSON.parse(readFileSync(join(homedir(), '.dsh/situational-state/chain.json'), 'utf8')) as {
      nodes: Array<{ situation?: string }>
    }
    situation = chain.nodes[chain.nodes.length - 1]?.situation ?? ''
  }
}

const sVec = situationVector(situation ?? '')
const repVector = goal.repVector as number[] | undefined
const kernelVector = goal.kernelVector as number[] | undefined
const focusVector = goal.focusVector as number[] | undefined
if (repVector === undefined) {
  console.error('该目标没有 repVector(会被唤醒循环跳过)')
  process.exit(2)
}

const rep = cosine(sVec, repVector)
const kernelSim = kernelVector === undefined ? null : cosine(sVec, kernelVector)
const focusSim = focusVector === undefined ? null : cosine(sVec, focusVector)

let layer = 'focus'
let layerSim = rep
if (kernelSim !== null && kernelSim > layerSim) { layerSim = kernelSim; layer = 'kernel' }
if (focusSim !== null && focusSim > layerSim) { layerSim = focusSim; layer = 'focus' }
const layerNeed = layer === 'kernel' ? KERNEL_NEED : FOCUS_NEED

const selfCheck = expectRep === undefined ? null : {
  expected: Number(expectRep),
  got: Number(rep.toFixed(4)),
  pass: Math.abs(rep - Number(expectRep)) < 0.0002,
}

console.log(JSON.stringify({
  goal: GOAL,
  situationChars: (situation ?? '').length,
  situationHead: (situation ?? '').slice(0, 90),
  rep: Number(rep.toFixed(4)), repThreshold: REP_THRESHOLD, repPass: rep >= REP_THRESHOLD,
  kernelSim: kernelSim === null ? null : Number(kernelSim.toFixed(4)),
  focusSim: focusSim === null ? null : Number(focusSim.toFixed(4)),
  layerSim: Number(layerSim.toFixed(4)), layer, layerNeed, layerPass: layerSim >= layerNeed,
  selfCheck,
}, null, 1))

if (selfCheck !== null && !selfCheck.pass) {
  console.error('自校失败: 算出的 rep 与日志值不一致 —— 情境文本或向量空间取错, 本结论作废')
  process.exit(3)
}
