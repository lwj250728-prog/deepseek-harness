/**
 * Succession numbering for inherited sessions: `<MMDD>-<n>`.
 *
 * A session that continues another one is named by its place in that day's
 * sequence — `0913-2` is the second succession of September 13 — instead of by
 * the text it happens to carry. Both alternatives are misleading for a handover:
 * the checkpoint summary it inherits reads as the predecessor's own title or as
 * a wall of summary text, so two generations of one conversation look alike in
 * the session list. A serial is short, unique within the day, and states the
 * order outright.
 *
 * The stamp comes from the successor's `createdAt`, so a session titled later
 * (a cold session opened the next morning) still carries the date it was born.
 * The counter is durable and per-day: losing the file restarts the ordinal at 1,
 * which is cosmetic, but a restart must never re-issue an ordinal it already
 * used, which is why the state is written through a temp file and a rename.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'

/** Durable per-day counter behind the succession titles. */
export interface SequenceState {
  /** Local-day stamp (`MMDD`) the counter belongs to. */
  readonly date: string
  /** Ordinal the NEXT succession of that day will receive. */
  readonly next: number
}

/** Local-day stamp `MMDD` for one timestamp. */
export function sequenceStamp(createdAt: number): string {
  const at = new Date(createdAt)
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${month}${day}`
}

/**
 * Advance the counter and produce one title.
 * @param previous - persisted state, when it exists and is well-formed.
 * @param stamp - local-day stamp the succession belongs to.
 * @returns the next state to persist plus the title it implies.
 */
export function advanceSequence(
  previous: SequenceState | undefined,
  stamp: string,
): { state: SequenceState; title: string } {
  const carried = previous !== undefined
    && previous.date === stamp
    && Number.isInteger(previous.next)
    && previous.next >= 1
    ? previous.next
    : 1
  return { state: { date: stamp, next: carried + 1 }, title: `${stamp}-${carried}` }
}

/** Read the counter, treating a missing or damaged file as "start of day". */
export async function readSequenceState(path: string): Promise<SequenceState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const { date, next } = parsed as { date?: unknown; next?: unknown }
    if (typeof date !== 'string' || typeof next !== 'number') return undefined
    return { date, next }
  } catch {
    return undefined
  }
}

/** Persist the counter atomically; this file is ours alone, so rename is safe. */
export async function writeSequenceState(path: string, state: SequenceState): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(temporary, path)
}

/** Where the counter lives when the configuration does not name a path. */
export function defaultSequencePath(): string | undefined {
  const home = process.env['DSH_HOME']
  return home === undefined || home.length === 0 ? undefined : `${home}/session-handover-sequence.json`
}

/**
 * Reserve the next succession title.
 * @param path - counter file, or a path-less configuration.
 * @param createdAt - the successor's creation timestamp.
 * @returns the title, or undefined when numbering is unavailable (no path).
 */
export async function nextSuccessorTitle(
  path: string | undefined,
  createdAt: number,
): Promise<string | undefined> {
  const resolved = path ?? defaultSequencePath()
  if (resolved === undefined) return undefined
  const stamp = sequenceStamp(createdAt)
  const { state, title } = advanceSequence(await readSequenceState(resolved), stamp)
  await writeSequenceState(resolved, state)
  return title
}
