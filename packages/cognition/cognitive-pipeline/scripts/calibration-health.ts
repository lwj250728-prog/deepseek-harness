/**
 * Calibration health dashboard: reads the prediction log and reports whether
 * prediction error is actually falling as experience accumulates (the
 * "learning curve" a reviewer would demand, and the pipeline's own health
 * metric). Run any time to see the current trend:
 *   pnpm exec tsx packages/cognition/cognitive-pipeline/scripts/calibration-health.ts
 * @module @deepseek-ai/dsh-cognitive-pipeline/scripts/calibration-health
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_COGNITIVE_ROOT ?? 'data/cognitive-pipeline'
const predFile = join(root, 'predictions.jsonl')
const expFile = join(root, 'experiences.jsonl')

interface PredRow {
  predictionId: string
  resolvedAt?: number
  predictionError?: number
  calibratedProbability?: number
  timestamp: number
}
interface ExpRow {
  timestamp: number
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0)
  } catch {
    return []
  }
}

const preds = readLines(predFile)
  .map((line) => {
    try { return JSON.parse(line) as PredRow } catch { return null }
  })
  .filter((row): row is PredRow => row !== null)
const exps = readLines(expFile)
  .map((line) => {
    try { return JSON.parse(line) as ExpRow } catch { return null }
  })
  .filter((row): row is ExpRow => row !== null)

const resolved = preds
  .filter(p => typeof p.resolvedAt === 'number' && typeof p.predictionError === 'number')
  .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))

const N = resolved.length
if (N === 0) {
  console.log(`calibration-health: no resolved predictions in ${predFile}`)
  process.exit(0)
}

// Cumulative average error: falls when learning is happening.
let acc = 0
const cumulative: number[] = []
for (let i = 0; i < resolved.length; i += 1) {
  acc += resolved[i]?.predictionError as number
  cumulative.push(acc / (i + 1))
}
const firstHalf = cumulative.slice(0, Math.max(1, Math.floor(N / 2)))
const secondHalf = cumulative.slice(Math.max(1, Math.floor(N / 2)))
const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / Math.max(1, firstHalf.length)
const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / Math.max(1, secondHalf.length)
const trend = avgSecond < avgFirst ? 'improving' : avgSecond > avgFirst * 1.1 ? 'worsening' : 'flat'

// Recent window (last 5): the current state, not the lifetime average.
const recent = resolved.slice(-5).map(p => p.predictionError as number)
const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length

console.log('=== calibration health dashboard ===')
console.log(`predictions: ${preds.length} | resolved: ${N} | experiences: ${exps.length}`)
console.log(`lifetime avg |cal−obs|: ${(acc / N).toFixed(3)}`)
console.log(`first-half avg: ${avgFirst.toFixed(3)} → second-half avg: ${avgSecond.toFixed(3)} (${trend})`)
console.log(`recent-window (n=${recent.length}) avg: ${recentAvg.toFixed(3)}`)
console.log('')
console.log('learning curve (cumulative avg error by resolved prediction):')
const step = Math.max(1, Math.floor(N / 10))
const maxErr = Math.max(...cumulative, 0.001)
for (let i = 0; i < N; i += step) {
  // Bar length scales with the error relative to the worst observed: as the
  // curve falls, the bar shrinks — the improvement is visible, not buried in
  // the 0.7-0.8 tail of (1 - err).
  const bar = '█'.repeat(Math.max(1, Math.round((cumulative[i] / maxErr) * 25)))
  console.log(`  n=${String(i + 1).padStart(3)} | ${cumulative[i].toFixed(3)} ${bar}`)
}
if (N - 1 >= 0 && (N - 1) % step !== 0) {
  const i = N - 1
  const bar = '█'.repeat(Math.max(1, Math.round((cumulative[i] / maxErr) * 25)))
  console.log(`  n=${String(i + 1).padStart(3)} | ${cumulative[i].toFixed(3)} ${bar}`)
}
console.log('')
console.log(`verdict: prediction error is ${trend === 'improving' ? 'FALLING as experiences accumulate (learning is real)' : trend === 'worsening' ? 'RISING (drift or noise — investigate)' : 'FLAT (no measurable learning yet)'}`)
