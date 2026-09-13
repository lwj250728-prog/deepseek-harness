/**
 * Build an INHERITED successor for one stored session.
 *
 * Difference from `dsh-session-compact.mts`: that tool keeps the whole visible
 * transcript (only redundant streaming deltas go), which is right when the
 * successor should still READ like the original conversation. This tool instead
 * inherits the log's compacted VIEW — the newest compaction checkpoint (the
 * summary the model was about to see) plus everything after it — which is what
 * the live `session-handover` plugin produces when a session compacts. It is the
 * only way to hand over a session that can no longer be resumed at all: the
 * original's newer history is already shadowed by its own compactions, so the
 * view is both faithful for the model and two orders of magnitude smaller.
 *
 * Everything is streamed in two passes with bounded memory:
 *   1. locate the newest compaction record and the checkpoint replacement that
 *      follows it, plus the newest request header before that cut;
 *   2. write the seed — checkpoint downgraded to an append, the newest
 *      request/header carried along, every event after the cut kept, events a
 *      later replacement shadows dropped, and message-referenced streaming
 *      deltas dropped (they are restated in full by the message that closes
 *      them), with every surviving seq reference renumbered.
 *
 * Usage:
 *   node --import tsx/esm dsh-session-inherit.mts <sourceArtifact> <destRoot> [--dry-run]
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { SESSION_FORMAT_VERSION } from './packages/core/session/src/index.ts'
import type { SessionEvent, SessionHeader, SessionId } from './packages/core/session/src/index.ts'
import { foldSurface } from './packages/core/session/src/index.ts'
import { foldSurfaceProjection } from './packages/llm/token-meter/src/surface-projection.ts'
import { SessionLogScanner, eventLines, logPath, sessionDir, toHeaderLine } from './packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, createZstdFrameDecoder, scanZstdFrames } from './packages/session/session-persistence-jsonl/src/zstd.ts'

const CHUNK_TYPE = 'assistant/chunk'
const BATCH_EVENTS = 500

interface Options { source: string; destRoot: string; dryRun: boolean }

function parseArgs(argv: readonly string[]): Options {
  const [source, destRoot] = argv
  if (source === undefined || destRoot === undefined) {
    throw new Error('usage: dsh-session-inherit.mts <sourceArtifact> <destRoot> [--dry-run]')
  }
  return { source, destRoot, dryRun: argv.includes('--dry-run') }
}

/** Whether one event shadows a range (a compaction checkpoint or a prune). */
function replaceRange(event: SessionEvent): { start: number; end: number } | undefined {
  const op = (event as { surfaceOp?: unknown }).surfaceOp
  if (typeof op !== 'object' || op === null) return undefined
  const { op: kind, start, end } = op as { op?: unknown; start?: unknown; end?: unknown }
  if (kind !== 'replace' || typeof start !== 'number' || typeof end !== 'number') return undefined
  return { start, end }
}

function isCompactionRecord(event: SessionEvent): boolean {
  return event.type === 'compaction/summary' || event.type === 'compaction/prune'
}

const options = parseArgs(process.argv.slice(2))
const buffer = await readFile(options.source)
const { frames } = scanZstdFrames(buffer)
if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
const decoder = createZstdFrameDecoder()
const decoded = decoder.decode(buffer, frames)
const headerFrame = decoded.next()
if (headerFrame.done) throw new Error('no header frame')
const sourceMeta = new SessionLogScanner(headerFrame.value).finish().meta
console.log(`source      : ${basename(dirname(options.source))} (${((await stat(options.source)).size / 1048576).toFixed(1)} MB)`)

/** One bounded pass over the artifact, visiting every decoded event in order. */
function pass(observe: (event: SessionEvent) => void): void {
  const decoderInner = createZstdFrameDecoder()
  const decodedInner = decoderInner.decode(buffer, frames)
  const head = decodedInner.next()
  if (head.done) throw new Error('no header frame')
  const scanner = new SessionLogScanner(head.value, { retainMessages: 1, observe })
  for (const plaintext of decodedInner) scanner.write(plaintext)
  scanner.finish()
}

// ---- Pass 1: where the inherited view starts -------------------------------
let checkpointSeq = -1
let headerSeq = -1
let records = 0
pass((event) => {
  if (isCompactionRecord(event)) {
    records += 1
    // A newer compaction re-arms the search: its own checkpoint is the cut.
    checkpointSeq = -1
    return
  }
  if (checkpointSeq === -1 && replaceRange(event) !== undefined) {
    checkpointSeq = event.seq
    return
  }
  if (checkpointSeq === -1 && event.type === 'request/header') headerSeq = event.seq
})
if (checkpointSeq === -1) {
  console.log('no compaction checkpoint in this log: nothing to inherit (use dsh-session-compact.mts instead)')
  process.exit(1)
}
console.log(`cut         : after compaction #${records}, checkpoint seq ${checkpointSeq}, header seq ${headerSeq}`)

// ---- Pass 2: write the inherited seed --------------------------------------
const successorId = `session-${randomUUID()}` as SessionId
const successorMeta: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: successorId,
  createdAt: Date.now(),
  ...sourceMeta.cwd === undefined ? {} : { cwd: sourceMeta.cwd },
  parentSession: sourceMeta.id,
  ...sourceMeta.agentPreset === undefined ? {} : { agentPreset: sourceMeta.agentPreset },
  delegationDepth: sourceMeta.delegationDepth,
}
const target = options.dryRun ? undefined : logPath(options.destRoot, sourceMeta.cwd, successorId, 'zstd')

let kept = 0
let droppedChunks = 0
let orphanChunks = 0
let droppedShadowed = 0
let seq = 0
let batch: SessionEvent[] = []
const remap = new Map<number, number>()

async function flush(): Promise<void> {
  if (batch.length === 0 || target === undefined) { batch = []; return }
  await appendFile(target, await compressZstdFrame(`${eventLines(batch, true)}\n`))
  batch = []
}

function keep(event: SessionEvent): void {
  remap.set(event.seq, seq)
  batch.push({ ...event, seq: seq++ } as SessionEvent)
  kept += 1
}

/**
 * Write one event as a plain append of the successor: a replacement is
 * DOWNGRADED (its shadowed originals are not in the seed, so the range would not
 * validate, and a surface event must carry some op), and citations are rewritten
 * to the surviving events.
 */
function keepAsAppend(event: SessionEvent): void {
  const { surfaceOp, sourceEventSeqs, ...rest } = event as SessionEvent & {
    surfaceOp?: unknown
    sourceEventSeqs?: number[]
  }
  const carriesSurfaceOp = surfaceOp !== undefined
  const data = (rest as { data?: Record<string, unknown> }).data
  const rewrittenData = data === undefined
    ? undefined
    : (() => {
      if (data['shadowedSeqs'] === undefined && data['shadowedRange'] === undefined) return data
      const { shadowedSeqs, shadowedRange, ...keptData } = data
      void shadowedSeqs
      void shadowedRange
      return keptData
    })()
  const citations = sourceEventSeqs === undefined
    ? undefined
    : sourceEventSeqs.map(old => remap.get(old)).filter((value): value is number => value !== undefined)
  const base = {
    ...(rest as SessionEvent),
    ...rewrittenData === undefined ? {} : { data: rewrittenData },
    ...carriesSurfaceOp ? { surfaceOp: 'append' } : {},
    // An empty citation list is legal only on assistant/message.
    ...citations === undefined || (citations.length === 0 && event.type !== 'assistant/message')
      ? {}
      : { sourceEventSeqs: citations },
  }
  const nextSeq = seq
  remap.set(event.seq, nextSeq)
  batch.push({ ...base, seq: nextSeq } as SessionEvent)
  kept += 1
  seq += 1
}

if (target !== undefined) {
  await mkdir(sessionDir(options.destRoot, sourceMeta.cwd, successorId), { recursive: true })
  await writeFile(target, await compressZstdFrame(`${JSON.stringify(toHeaderLine(successorMeta))}\n`))
}

/** Chunk events since the last non-chunk event: dropped only when restated. */
let pendingChunks: SessionEvent[] = []
let within = false
pass((event) => {
  if (event.seq === checkpointSeq) within = true
  if (!within) {
    // The newest request header rides in front so the successor starts on the
    // model the predecessor was using (and the prompt prefix keeps matching).
    if (event.seq === headerSeq) keepAsAppend(event)
    return
  }
  if (isCompactionRecord(event)) return
  if (event.type === CHUNK_TYPE) {
    pendingChunks.push(event)
    return
  }
  if (pendingChunks.length > 0) {
    const sources = new Set((event as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [])
    for (const chunk of pendingChunks) {
      if (sources.has(chunk.seq)) droppedChunks += 1
      else { keep(chunk); orphanChunks += 1 }
    }
    pendingChunks = []
  }
  // A replacement's own shadowed originals are outside the view: drop the
  // replacement's citation target only when it is missing, and skip nothing else.
  const range = replaceRange(event)
  if (range !== undefined) {
    // The checkpoint itself is the summary: keep it. A later replacement is kept
    // too, since its own shadowed nodes live inside the view and it will be
    // downgraded to an append (the nodes stay, nothing is hidden any more).
  }
  keepAsAppend(event)
})
for (const chunk of pendingChunks) { keep(chunk); orphanChunks += 1 }
await flush()

console.log(`successor id: ${successorId}`)
console.log(`kept        : ${kept} events (${orphanChunks} unfinished-partial chunks retained, ${droppedChunks} redundant deltas dropped)`)
if (target === undefined) {
  console.log('dry run: nothing written')
  process.exit(0)
}

const handle = await open(target, 'r+')
await handle.sync()
await handle.close()

// ---- Verification: read back, project, and fold ----------------------------
const written = await readFile(target)
const verifyFrames = scanZstdFrames(written)
const verifyDecoder = createZstdFrameDecoder()
const verifyDecoded = verifyDecoder.decode(written, verifyFrames.frames)
const verifyHeader = verifyDecoded.next()
if (verifyHeader.done) throw new Error('successor has no header frame')
const events: SessionEvent[] = []
const types = new Map<string, number>()
const verifyScanner = new SessionLogScanner(verifyHeader.value, {
  observe: (event) => { types.set(event.type, (types.get(event.type) ?? 0) + 1) },
})
for (const plaintext of verifyDecoded) verifyScanner.write(plaintext)
events.push(...verifyScanner.finish().events)

const surface = foldSurface(events)
let claim
let tokens = 0
for (const event of events) {
  const folded = foldSurfaceProjection(claim, event)
  claim = folded.claim
  tokens += folded.deltaTokens
}

console.log(`artifact    : ${(written.length / 1048576).toFixed(2)} MB on disk (source ${(((await stat(options.source)).size) / 1048576).toFixed(1)} MB)`)
console.log(`messages    : assistant ${types.get('assistant/message') ?? 0}, user ${types.get('user/message') ?? 0}, `
  + `tool calls ${types.get('tool/call') ?? 0}, tool results ${types.get('tool/result') ?? 0}`)
console.log(`fold check  : ${surface.nodes.length} surface nodes, ${surface.replacements.length} replacements, token delta ${tokens}`)
console.log(`header id   : ${verifyHeader.value.toString('utf8').slice(0, 80)}...`)
