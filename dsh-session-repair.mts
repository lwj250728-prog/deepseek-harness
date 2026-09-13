/**
 * Repair the turn/step framing of one stored session log, in two passes.
 *
 * A log can be structurally consistent as a TRANSCRIPT and still be unreadable
 * to the token meter, which pairs every `assistant/message` with the step that
 * was open when it arrived — same turn, same step. A log whose head was cut
 * mid-step (an inherited view that began at a compaction checkpoint, for
 * example) violates that pair exactly once, and because EVERY pressure-based
 * compaction decision reads the meter, such a session can never compact — and so
 * can never hand over either.
 *
 * Pass one audits the source with the meter's own rules and records the exact
 * violations; pass two copies the source and inserts only the frames those
 * violations need, closing a synthesized frame before the source's own
 * structure resumes. Inserting nothing else is what keeps the repair from
 * cascading: an incremental repair that guesses while it streams drifts away
 * from the source and fabricates frames the source never missed.
 *
 * Usage:
 *   node --import tsx/esm dsh-session-repair.mts <sourceArtifact> <destRoot> [--dry-run]
 */
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { SESSION_FORMAT_VERSION } from './packages/core/session/src/index.ts'
import type { SessionEvent, SessionHeader, SessionId } from './packages/core/session/src/index.ts'
import { SessionLogScanner, eventLines, logPath, sessionDir, toHeaderLine } from './packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, createZstdFrameDecoder, scanZstdFrames } from './packages/session/session-persistence-jsonl/src/zstd.ts'

interface Options { source: string; destRoot: string; dryRun: boolean }

function parseArgs(argv: readonly string[]): Options {
  const [source, destRoot] = argv
  if (source === undefined || destRoot === undefined) {
    throw new Error('usage: dsh-session-repair.mts <sourceArtifact> <destRoot> [--dry-run]')
  }
  return { source, destRoot, dryRun: argv.includes('--dry-run') }
}

/** One structural orphan the meter would refuse to fold. */
interface Violation {
  seq: number
  turn: number
  step: number
  /** `message` needs a frame opened before it and closed after; `end` needs one opened before it only. */
  kind: 'message' | 'end'
}


/**
 * Queue an adoption request for the running host.
 *
 * A successor written by this tool is only a log file: the host has no way to
 * learn that a conversation moved, so mechanisms keyed by the predecessor id
 * would keep pointing at it. Appending to the durable queue makes the host adopt
 * the successor on its next sweep — no API call, no live host required here.
 * @param predecessorId - the session whose conversation this file continues.
 * @param successorId - the session this tool just wrote.
 */
function queueAdoption(predecessorId: string, successorId: string): void {
  const home = process.env['DSH_HOME']
  if (home === undefined || home.length === 0) return
  const path = `${home}/session-handover-adoptions.jsonl`
  try {
    appendFileSync(path, `${JSON.stringify({ predecessorId, successorId, at: new Date().toISOString() })}\n`, 'utf8')
    console.log(`adoption  : queued ${successorId} for ${predecessorId}`)
  } catch (error: unknown) {
    console.log(`adoption  : could not queue (run the host adoption by hand): ${String(error)}`)
  }
}

const options = parseArgs(process.argv.slice(2))
const buffer = await readFile(options.source)
const { frames } = scanZstdFrames(buffer)
if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

function pass(observe: (event: SessionEvent) => void): SessionHeader {
  const decoder = createZstdFrameDecoder()
  const decoded = decoder.decode(buffer, frames)
  const head = decoded.next()
  if (head.done) throw new Error('no header frame')
  const scanner = new SessionLogScanner(head.value, { retainMessages: 1, observe })
  for (const plaintext of decoded) scanner.write(plaintext)
  return scanner.finish().meta
}

/** The meter's rules, applied in order. */
function audit(events: (event: SessionEvent) => void): Violation[] {
  const violations: Violation[] = []
  let open: { turn: number; step: number } | undefined
  pass((event) => {
    events(event)
    const data = (event as { data?: { turn?: number; step?: number } }).data
    if (event.type === 'step/start') {
      if (open !== undefined) {
        violations.push({ seq: event.seq, turn: data?.turn ?? 1, step: data?.step ?? 1, kind: 'end' })
      }
      open = { turn: data?.turn ?? 0, step: data?.step ?? 0 }
      return
    }
    if (event.type === 'step/end') {
      if (open === undefined || open.turn !== data?.turn || open.step !== data?.step) {
        violations.push({ seq: event.seq, turn: data?.turn ?? 1, step: data?.step ?? 1, kind: 'end' })
      }
      open = undefined
      return
    }
    if (event.type === 'turn/end') { open = undefined; return }
    if (event.type !== 'assistant/message') return
    if (open === undefined || open.turn !== data?.turn || open.step !== data?.step) {
      violations.push({ seq: event.seq, turn: data?.turn ?? 1, step: data?.step ?? 1, kind: 'message' })
    }
  })
  return violations
}

const violations = audit(() => {})
console.log(`source      : ${basename(dirname(options.source))} (${((await stat(options.source)).size / 1048576).toFixed(1)} MB)`)
console.log(`violations  : ${violations.length}`)
for (const v of violations.slice(0, 6)) console.log(`   seq ${v.seq} needs turn ${v.turn}/step ${v.step}`)
if (violations.length === 0) {
  console.log('nothing to repair: this log already folds')
  process.exit(0)
}

// The source's own next structural event decides how a synthesized frame closes.
const nextStructural = new Map<number, string>()
{
  const ordered: { seq: number; type: string }[] = []
  pass((event) => {
    if (event.type === 'step/start' || event.type === 'step/end'
      || event.type === 'turn/start' || event.type === 'turn/end') {
      ordered.push({ seq: event.seq, type: event.type })
    }
  })
  for (const violation of violations) {
    nextStructural.set(violation.seq, ordered.find(entry => entry.seq > violation.seq)?.type ?? 'turn/end')
  }
}

const sourceMeta = pass(() => {})
const successorId = `session-${(await import('node:crypto')).randomUUID()}` as SessionId
const successorMeta: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: successorId,
  createdAt: Date.now(),
  ...sourceMeta.cwd === undefined ? {} : { cwd: sourceMeta.cwd },
  ...sourceMeta.parentSession === undefined ? {} : { parentSession: sourceMeta.parentSession },
  ...sourceMeta.agentPreset === undefined ? {} : { agentPreset: sourceMeta.agentPreset },
  delegationDepth: sourceMeta.delegationDepth,
}
const target = options.dryRun ? undefined : logPath(options.destRoot, sourceMeta.cwd, successorId, 'zstd')

let seq = 0
let inserted = 0
let kept = 0
let batch: SessionEvent[] = []
const pending = new Map(violations.map(v => [v.seq, v]))
/**
 * Old seq → new seq for everything emitted. Inserted frames shift the whole
 * numbering after them, so every reference the log carries (`sourceEventSeqs`,
 * `surfaceOp.start/end`, `durableRange`, `*Seq` fields) must move with it —
 * otherwise a citation silently points at an unrelated event and the meter
 * refuses the log for a reason that has nothing to do with the repair.
 */
const remap = new Map<number, number>()

/** Rewrite one event's references into the repaired numbering. */
function remapProvenance(event: SessionEvent): SessionEvent {
  const result = { ...event } as SessionEvent & {
    sourceEventSeqs?: number[]
    surfaceOp?: unknown
    data?: Record<string, unknown>
  }
  const op = result.surfaceOp
  if (typeof op === 'object' && op !== null && (op as { op?: string }).op === 'replace') {
    const { start, end } = op as { start: number; end: number }
    const mappedStart = remap.get(start)
    const mappedEnd = remap.get(end)
    if (mappedStart !== undefined && mappedEnd !== undefined) {
      result.surfaceOp = { op: 'replace', start: mappedStart, end: mappedEnd }
    }
  }
  const data = result.data
  if (data !== undefined) {
    const range = data['shadowedRange']
    if (range !== undefined && typeof range === 'object' && range !== null) {
      const { start, end } = range as { start: number; end: number }
      const mappedStart = remap.get(start)
      const mappedEnd = remap.get(end)
      if (mappedStart !== undefined && mappedEnd !== undefined) {
        data['shadowedRange'] = { start: mappedStart, end: mappedEnd }
      }
    }
    if (Array.isArray(data['shadowedSeqs'])) {
      data['shadowedSeqs'] = (data['shadowedSeqs'] as number[])
        .map(old => remap.get(old)).filter((value): value is number => value !== undefined)
    }
    for (const [key, value] of Object.entries(data)) {
      if (key === 'shadowedSeqs' || key === 'shadowedRange') continue
      if (typeof value === 'number' && /Seq$/.test(key)) {
        const mapped = remap.get(value)
        if (mapped !== undefined) data[key] = mapped
      }
    }
  }
  const sources = result.sourceEventSeqs
  if (sources !== undefined) {
    const mapped = sources.map(old => remap.get(old)).filter((value): value is number => value !== undefined)
    delete result.sourceEventSeqs
    if (mapped.length > 0 || result.type === 'assistant/message') result.sourceEventSeqs = mapped
  }
  return result as SessionEvent
}

async function flush(): Promise<void> {
  if (batch.length === 0 || target === undefined) { batch = []; return }
  await appendFile(target, await compressZstdFrame(`${eventLines(batch, true)}\n`))
  batch = []
}

function emit(event: Omit<SessionEvent, 'seq'> & { seq?: number }): void {
  batch.push({ ...event, seq: seq++ } as SessionEvent)
  kept += 1
}

/** Emit one SOURCE event, rewriting its references into the new numbering. */
function emitSource(event: SessionEvent): void {
  remap.set(event.seq, seq)
  batch.push({ ...remapProvenance(event), seq: seq++ } as SessionEvent)
  kept += 1
}

if (target !== undefined) {
  await mkdir(sessionDir(options.destRoot, sourceMeta.cwd, successorId), { recursive: true })
  await writeFile(target, await compressZstdFrame(`${JSON.stringify(toHeaderLine(successorMeta))}\n`))
}

pass((event) => {
  const violation = pending.get(event.seq)
  if (violation !== undefined) {
    pending.delete(event.seq)
    // A SELF-CONTAINED frame around the orphan: opened for the message and closed
    // immediately after it, so the source's own structure can never collide with
    // what the repair inserted (that collision is exactly how an incremental
    // repair cascades).
    emit({ type: 'turn/start', time: event.time, data: { turn: violation.turn } } as SessionEvent)
    emit({ type: 'step/start', time: event.time, data: { turn: violation.turn, step: violation.step } } as SessionEvent)
    emitSource(event)
    // A `step/end` orphan closed itself; only an orphan message needs the trailing close.
    if (violation.kind === 'message') {
      emit({ type: 'step/end', time: event.time, data: { turn: violation.turn, step: violation.step } } as SessionEvent)
      emit({ type: 'turn/end', time: event.time, data: { turn: violation.turn, reason: { kind: 'completed' } } } as SessionEvent)
      inserted += 2
    }
    return
  }
  emitSource(event)
})

if (target !== undefined) await flush()
console.log(`kept        : ${kept} events (${inserted} frames inserted)`)
if (target === undefined) {
  console.log('dry run: nothing written')
  process.exit(0)
}
const handle = await open(target, 'r+')
await handle.sync()
await handle.close()
console.log(`successor   : ${successorId}`)
console.log(`artifact    : ${((await stat(target)).size / 1048576).toFixed(2)} MB`)
queueAdoption(String(sourceMeta.id), String(successorId))
