/**
 * dsh-layer-tune.tsx — 用真实情境样本给休眠目标调 kernel/focus 文本(离线, 不改运行时)。
 *
 * 背景: 唤醒是两道门(gate1 rep >= 0.48, gate2 layer sim >= focus 0.55 / kernel 0.62)。
 * goal-experience-library 长期卡在 gate2(实测 layerSim 0.4961 < 0.55)。向量器是**哈希字符袋**
 * (CJK 按单字切分), 所以"文本是否够像真实情境"= 字符重合度。要诚实地提高它, 只能用**该目标真正
 * 出现时的工作词汇**去写 kernel/focus —— 因此本工具同时报**判别力**: 目标样本(该目标工作时真实
 * 出现的情境)必须上去, 无关样本不得一起上去(否则就是把所有情境都拉近的自激)。
 *
 * 用法: npx tsx dsh-layer-tune.tsx --candidates P.json [--expect-rep 0.4961]
 *   P.json = [{ "name": "...", "kernel": "...", "focus": "..." }, ...]
 * 输出: 每个候选 × 每个样本的 rep/kernelSim/focusSim/layerSim/layerPass 表 + 判别差。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cosine, situationVector } from './packages/cognition/cognitive-pipeline/src/vectorizer.ts'

const arg = (n: string, f?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : f
}
const GOAL = arg('goal', 'goal-experience-library') as string
const CANDIDATES = arg('candidates') as string
if (CANDIDATES === undefined) { console.error('缺 --candidates'); process.exit(2) }
const KERNEL_NEED = Number(arg('kernel-need', '0.62'))
const FOCUS_NEED = Number(arg('focus-need', '0.55'))
const expectRep = arg('expect-rep')

const pool = new Map<string, Record<string, unknown>>()
for (const line of readFileSync(join(homedir(), '.dsh/cognitive-pipeline/dormant-goals.jsonl'), 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const row = JSON.parse(line) as Record<string, unknown>
  pool.set(String(row.id), row)   // last-wins: 池是只追加账本
}
const goal = pool.get(GOAL)
if (goal === undefined) { console.error(`池里没有 ${GOAL}`); process.exit(2) }

/** 样本: 目标样本(该目标工作时的真实情境) 与 无关样本(判别力对照)。
 *  --samples <json> 可直接内联样本([{name,kind,text}]), 供测试自带样本、不依赖会话临时文件。 */
const samplesArg = arg('samples')
interface SampleRow { name: string; kind: 'target' | 'control'; file?: string; text?: string }
const INLINE_SAMPLES: SampleRow[] = samplesArg === undefined ? [] : JSON.parse(readFileSync(samplesArg, 'utf8'))
const SAMPLES: SampleRow[] = INLINE_SAMPLES.length > 0 ? INLINE_SAMPLES : [
  { name: '帧-1749(真实情境, 已用日志 rep 标定)', kind: 'target', file: '/tmp/sit-1749.txt' },
  { name: '无关-SPA发布(exp_35 原文)', kind: 'control', file: '/tmp/sit-control-spa.txt' },
  { name: '无关-小说目标 kernel', kind: 'control', file: '/tmp/sit-control-novel.txt' },
]

const score = (kernelText: string, focusText: string): { rep: number; k: number; f: number; layer: string; sim: number; need: number; pass: boolean } => {
  const repV = situationVector(`${kernelText} ${focusText}`)
  const kV = situationVector(kernelText)
  const fV = situationVector(focusText)
  return { rep: 0, k: 0, f: 0, layer: '', sim: 0, need: 0, pass: false, repV, kV, fV } as never
}

interface Candidate { name: string; kernel: string; focus: string }
const candidates: Candidate[] = JSON.parse(readFileSync(CANDIDATES, 'utf8'))

// 基准(池中现值)
const baseline: Candidate = {
  name: 'BASELINE(池中现值)',
  kernel: String(goal.kernel ?? ''),
  focus: String(goal.focus ?? ''),
}
const all: Candidate[] = [baseline, ...candidates]

const rows: Array<Record<string, unknown>> = []
for (const cand of all) {
  const repV = situationVector(`${cand.kernel} ${cand.focus}`)
  const kV = situationVector(cand.kernel)
  const fV = situationVector(cand.focus)
  for (const s of SAMPLES) {
    let text = s.text ?? ''
    if (text === '' && s.file !== undefined) { try { text = readFileSync(s.file, 'utf8') } catch { continue } }
    if (text === '') continue
    const sVec = situationVector(text)
    const rep = cosine(sVec, repV)
    const k = cosine(sVec, kV)
    const f = cosine(sVec, fV)
    let layer = 'focus'
    let sim = rep
    if (k > sim) { sim = k; layer = 'kernel' }
    if (f > sim) { sim = f; layer = 'focus' }
    const need = layer === 'kernel' ? KERNEL_NEED : FOCUS_NEED
    rows.push({
      candidate: cand.name, sample: s.name, kind: s.kind,
      rep: Number(rep.toFixed(4)), kernelSim: Number(k.toFixed(4)), focusSim: Number(f.toFixed(4)),
      layer, layerSim: Number(sim.toFixed(4)), layerNeed: need, layerPass: sim >= need,
    })
  }
}

for (const r of rows) {
  console.log(`${String(r.candidate).padEnd(26)} | ${String(r.sample).padEnd(34)} | rep ${r.rep} k ${r.kernelSim} f ${r.focusSim} | ${r.layer} ${r.layerSim}/${r.layerNeed} ${r.layerPass ? 'PASS' : 'fail'}`)
}
console.log('\n-- 判别差(目标样本 layerSim − 无关样本 layerSim 最大值; 越大越有判别力) --')
for (const cand of all) {
  const mine = rows.filter(r => r.candidate === cand.name)
  const t = Math.max(...mine.filter(r => r.kind === 'target').map(r => Number(r.layerSim)), 0)
  const c = Math.max(...mine.filter(r => r.kind === 'control').map(r => Number(r.layerSim)), 0)
  console.log(`${cand.name.padEnd(26)} | 目标 ${t.toFixed(4)} | 无关 ${c.toFixed(4)} | 判别差 ${(t - c).toFixed(4)} | 目标过门 ${t >= FOCUS_NEED ? 'YES' : 'no'}`)
}

if (expectRep !== undefined) {
  const base = rows.find(r => r.candidate === baseline.name && r.kind === 'target')
  const ok = base !== undefined && Math.abs(Number(base.rep) - Number(expectRep)) < 0.0002
  console.log(`\n标定自校: baseline rep ${base?.rep} vs 日志 ${expectRep} ⇒ ${ok ? '一致(样本文本可用)' : '不一致(样本文本取错, 结论作废)'}`)
  if (!ok) process.exit(3)
}
