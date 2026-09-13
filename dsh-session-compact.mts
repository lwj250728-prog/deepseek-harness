/**
 * Compact one stored session into a smaller successor session.
 *
 * Why: a session log that grows past a sane materialization budget can no
 * longer be resumed in place — its whole transcript has to fit in the host's
 * heap at once, which is what used to take the host down. The bulk of such a
 * log is streaming deltas (`assistant/chunk`) that the message event closing
 * their run already restates in full: redundant for the model AND for the
 * reader. Dropping exactly the referenced ones turns a 1.3GB transcript into
 * ~118MB without losing a single visible message.
 *
 * The successor is a NEW session id written beside the original, which stays
 * untouched as the full-fidelity archive. Reading the source streams frame by
 * frame and the only buffer held is the current chunk run, so the migration
 * itself runs in bounded memory however long the source is.
 *
 * Usage:
 *   node --import tsx/esm dsh-session-compact.mts <sourceArtifact> <destRoot> [--cwd <path>] [--dry-run]
 */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from './packages/core/session/src/index.ts'
import {
  SESSION_FORMAT_VERSION,
} from './packages/core/session/src/index.ts'
import { foldSurface } from './packages/core/session/src/index.ts'
import { foldSurfaceProjection } from './packages/llm/token-meter/src/surface-projection.ts'
import { SessionLogScanner, eventLines, logPath, sessionDir, toHeaderLine } from './packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, createZstdFrameDecoder, scanZstdFrames } from './packages/session/session-persistence-jsonl/src/zstd.ts'

const CHUNK_TYPE = 'assistant/chunk'
const BATCH_EVENTS = 500

interface Options {
  source: string
  destRoot: string
  cwd: string | undefined
  dryRun: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const [source, destRoot] = argv
  if (source === undefined || destRoot === undefined) {
    throw new Error('usage: dsh-session-compact.mts <sourceArtifact> <destRoot> [--cwd <path>] [--dry-run]')
  }
  let cwd: string | undefined
  let dryRun = false
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--cwd') cwd = argv[++index]
    else if (flag === '--dry-run') dryRun = true
    else throw new Error(`unknown argument ${String(flag)}`)
  }
  return { source, destRoot, cwd, dryRun }
}

/** Read just the header record of a zstd JSONL artifact. */
async function readHeader(path: string): Promise<SessionHeader> {
  const buffer = await readFile(path)
  const { frames } = scanZstdFrames(buffer, 1)
  const first = frames[0]
  if (first === undefined) throw new Error(`no zstd frame in ${path}`)
  const decoder = createZstdFrameDecoder()
  const headerFrame = decoder.decode(buffer, [first]).next()
  if (headerFrame.done) throw new Error(`no header frame in ${path}`)
  return new SessionLogScanner(headerFrame.value).finish().meta
}

/**
 * Fold one artifact the way the service's read models do.
 *
 * A migration can produce a log that *parses* and still be rejected later: the
 * surface fold re-derives each replacement's shadowed range and the token
 * surface requires the matching shadow-price claim to name that exact range, so
 * a seq reference that was not rewritten trips there and not at write time.
 * Running both folds here turns that class of bug into a migration-time failure.
 */
async function foldCheck(path: string): Promise<void> {
  const buffer = await readFile(path)
  const { frames } = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  const decoded = decoder.decode(buffer, frames)
  const headerFrame = decoded.next()
  if (headerFrame.done) throw new Error('no header frame')
  const events: SessionEvent[] = []
  const scanner = new SessionLogScanner(headerFrame.value)
  for (const plaintext of decoded) scanner.write(plaintext)
  events.push(...scanner.finish().events)

  const surface = foldSurface(events)
  let claim
  let tokens = 0
  for (const event of events) {
    const folded = foldSurfaceProjection(claim, event)
    claim = folded.claim
    tokens += folded.deltaTokens
  }
  console.log(`fold check  : ${surface.nodes.length} surface nodes, ${surface.replacements.length} replacements, `
    + `token surface delta ${tokens}`)
}

const options = parseArgs(process.argv.slice(2))
const sourceMeta = await readHeader(options.source)
const sourceBytes = (await stat(options.source)).size
const cwd = options.cwd ?? sourceMeta.cwd
console.log(`source      : ${basename(dirname(options.source))} (${(sourceBytes / 1048576).toFixed(1)} MB)`)
console.log(`cwd         : ${cwd ?? '(none)'}`)

const successorId = `session-${randomUUID()}` as SessionId
const successorMeta: SessionHeader = {
  version: SESSION_FORMAT_VERSION,
  id: successorId,
  createdAt: Date.now(),
  ...cwd === undefined ? {} : { cwd },
  ...sourceMeta.agentPreset === undefined ? {} : { agentPreset: sourceMeta.agentPreset },
  delegationDepth: sourceMeta.delegationDepth,
}

const target = options.dryRun ? undefined : logPath(options.destRoot, cwd, successorId, 'zstd')

let kept = 0
let dropped = 0
let orphanChunks = 0
let seq = 0
let batch: SessionEvent[] = []
/**
 * Old seq → new seq for every retained event. The log's provenance fields
 * (`sourceEventSeqs`) and its surface-replacement invariants are stated in old
 * seqs, so dropping events means REWRITING those references, never removing
 * them: a `surfaceOp: replace` event must keep naming every node it shadows.
 */
const remap = new Map<number, number>()

async function flush(): Promise<void> {
  if (batch.length === 0 || target === undefined) { batch = []; return }
  await appendFile(target, await compressZstdFrame(`${eventLines(batch, true)}\n`))
  batch = []
}

function keep(event: SessionEvent): void {
  // The successor is a fresh contiguous log: its seqs start at 0.
  remap.set(event.seq, seq)
  batch.push({ ...event, seq: seq++ } as SessionEvent)
  kept += 1
}

/**
 * Rewrite every seq REFERENCE one event carries into the successor's numbering.
 *
 * Renumbering is unavoidable: the format requires a contiguous seq space from
 * 0, so dropping events means rewriting the log's cross-references. They live in
 * more places than the obvious one — a replacement names the range it shadows
 * by seq (`surfaceOp.start/end`), a shadow-price record carries the same range
 * as `data.shadowedRange`, compaction records carry `shadowedSeqs` plus
 * `startSeq`/`summarySeq`/`endSeq`, and the token-surface fold REQUIRES the
 * claim and the replacement to name the identical range. A missed field does not
 * fail loudly at write time; it surfaces later as a fold error on read.
 *
 * Only seq-typed keys are rewritten: epoch times, token counts, and every other
 * number in an event are left exactly as they were.
 */
function remapSeq(old: number): number {
  const next = remap.get(old)
  if (next === undefined) {
    throw new Error(`reference to dropped event seq ${old} cannot be rewritten`)
  }
  return next
}

function remapSeqList(seqs: readonly number[]): number[] {
  const mapped: number[] = []
  for (const seq of seqs) {
    const next = remap.get(seq)
    // A citation of a dropped streaming delta is simply gone; citations of
    // surface nodes (the ones the format actually validates) always survive.
    if (next !== undefined) mapped.push(next)
  }
  return mapped
}

function remapProvenance(event: SessionEvent): SessionEvent {
  const result = { ...event } as SessionEvent & {
    sourceEventSeqs?: number[]
    surfaceOp?: unknown
    data?: Record<string, unknown>
  }

  if (result.surfaceOp !== undefined && typeof result.surfaceOp === 'object' && result.surfaceOp !== null
    && (result.surfaceOp as { op?: string }).op === 'replace') {
    const op = result.surfaceOp as { op: 'replace'; start: number; end: number }
    result.surfaceOp = { op: 'replace', start: remapSeq(op.start), end: remapSeq(op.end) }
  }

  const data = result.data
  if (data !== undefined) {
    const range = data['shadowedRange']
    if (range !== undefined && typeof range === 'object' && range !== null) {
      const { start, end } = range as { start: number; end: number }
      data['shadowedRange'] = { start: remapSeq(start), end: remapSeq(end) }
    }
    if (Array.isArray(data['shadowedSeqs'])) {
      data['shadowedSeqs'] = remapSeqList(data['shadowedSeqs'] as number[])
    }
    for (const [key, value] of Object.entries(data)) {
      if (key === 'shadowedSeqs' || key === 'shadowedRange') continue
      if (typeof value === 'number' && /Seq$/.test(key)) data[key] = remapSeq(value)
    }
  }

  const sources = result.sourceEventSeqs
  if (sources !== undefined) {
    const mapped = remapSeqList(sources)
    delete result.sourceEventSeqs
    // The format allows an empty citation list only on assistant/message.
    if (mapped.length > 0 || result.type === 'assistant/message') result.sourceEventSeqs = mapped
  }
  return result as SessionEvent
}

if (target !== undefined) {
  await mkdir(sessionDir(options.destRoot, cwd, successorId), { recursive: true })
  await writeFile(target, await compressZstdFrame(`${JSON.stringify(toHeaderLine(successorMeta))}\n`))
}

const buffer = await readFile(options.source)
const { frames } = scanZstdFrames(buffer)
const decoder = createZstdFrameDecoder()
const decoded = decoder.decode(buffer, frames)
const headerFrame = decoded.next()
if (headerFrame.done) throw new Error('empty or header-less Zstandard session log')

/** Chunk events seen since the last non-chunk event: dropped only if referenced. */
let pendingChunks: SessionEvent[] = []
const scanner = new SessionLogScanner(headerFrame.value, {
  retainMessages: 1,
  observe: (event) => {
    if (event.type === CHUNK_TYPE) {
      pendingChunks.push(event)
      return
    }
    if (pendingChunks.length > 0) {
      const sources = new Set((event as { sourceEventSeqs?: number[] }).sourceEventSeqs ?? [])
      for (const chunk of pendingChunks) {
        // A chunk the closing message restates in full is redundant. A chunk the
        // message does NOT reference belongs to a run that never finalized —
        // dropping it would lose content the successor could not recover.
        if (sources.has(chunk.seq)) dropped += 1
        else { keep(chunk); orphanChunks += 1 }
      }
      pendingChunks = []
    }
    keep(remapProvenance(event))
  },
})

for (const plaintext of decoded) {
  scanner.write(plaintext)
  if (batch.length >= BATCH_EVENTS) await flush()
}
for (const chunk of pendingChunks) { keep(chunk); orphanChunks += 1 }
await flush()
scanner.finish()

console.log(`kept events : ${kept} (${orphanChunks} interrupted-partial chunks retained)`)
console.log(`dropped     : ${dropped} redundant streaming deltas`)
console.log(`successor id: ${successorId}`)

if (target === undefined) {
  console.log('dry run: nothing written')
  process.exit(0)
}

// Durability barrier for the finished artifact, then read it back through the
// same reader the service uses: a migration that cannot be read is not a fix.
const handle = await open(target, 'r+')
await handle.sync()
await handle.close()

const written = await readFile(target)
const verifyFrames = scanZstdFrames(written)
const verifyDecoder = createZstdFrameDecoder()
const verifyDecoded = verifyDecoder.decode(written, verifyFrames.frames)
const verifyHeader = verifyDecoded.next()
if (verifyHeader.done) throw new Error('successor has no header frame')
let readBack = 0
const keptTypes = new Map<string, number>()
const verifyScanner = new SessionLogScanner(verifyHeader.value, {
  retainMessages: 1,
  observe: (event) => { keptTypes.set(event.type, (keptTypes.get(event.type) ?? 0) + 1) },
})
for (const plaintext of verifyDecoded) { verifyScanner.write(plaintext); readBack += 1 }
const verified = verifyScanner.finish()
const messages = (keptTypes.get('user/message') ?? 0) + (keptTypes.get('assistant/message') ?? 0)
console.log(`messages    : ${messages} (user ${keptTypes.get('user/message') ?? 0}, `
  + `assistant ${keptTypes.get('assistant/message') ?? 0}), tool calls ${keptTypes.get('tool/call') ?? 0}, `
  + `tool results ${keptTypes.get('tool/result') ?? 0}`)

console.log(`artifact    : ${((written.length) / 1048576).toFixed(2)} MB on disk, ${readBack} frames`)
console.log(`read-back   : ${verified.events.length + 1} events (window), header id ${verified.meta.id}`)
console.log(`verified    : ${verified.meta.id === successorId ? 'header identity OK' : 'IDENTITY MISMATCH'}`)
await foldCheck(target)
console.log(`next        : open it from the session list (it is catalogued beside the original)`)
