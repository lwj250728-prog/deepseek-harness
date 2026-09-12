/**
 * Bounded tail reads: the retention window that lets a transcript page be read
 * without materializing the whole log.
 *
 * The property under test is not just "fewer events come back" — it is that what
 * comes back is a SUFFIX OF WHOLE MESSAGES, so a paginator cutting its page off
 * the tail lands on the same boundary it would have found in the full log.
 */
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionMaterializationLimitError } from '@deepseek-ai/dsh-session-persistence'
import { SessionLogScanner, scanLog, toHeaderLine } from '../src/format.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-jsonl-tail-'))
  dirs.push(dir)
  return dir
}

/** One turn's events: a user group and an assistant group whose chunks precede its message. */
function turnEvents(turn: number, baseSeq: number): SessionEvent[] {
  const chunkSeqs = [baseSeq + 3, baseSeq + 4]
  return [
    { type: 'turn/start', seq: baseSeq, time: baseSeq, data: { turn } },
    { type: 'user/message', seq: baseSeq + 1, time: baseSeq + 1, data: freezeMessage({
      id: MessageId(`user-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: `q${turn}` }],
      source: { kind: 'user' },
    }), surfaceOp: 'append' },
    { type: 'step/start', seq: baseSeq + 2, time: baseSeq + 2, data: { turn, step: 1 } },
    ...chunkSeqs.map((seq, index) => ({
      type: 'assistant/chunk' as const,
      seq,
      time: seq,
      data: { turn, step: 1, chunk: { type: 'text-delta' as const, index: 0, text: `a${index}` } },
    })),
    { type: 'assistant/message', seq: baseSeq + 5, time: baseSeq + 5, data: {
      turn,
      step: 1,
      message: freezeMessage({
        id: MessageId(`assistant-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text: `a${turn}` }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
    }, surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
    { type: 'step/end', seq: baseSeq + 6, time: baseSeq + 6, data: { turn, step: 1 } },
    { type: 'turn/end', seq: baseSeq + 7, time: baseSeq + 7, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** A log of `turns` closed turns, contiguous from seq 0. */
function turnLog(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn++) events.push(...turnEvents(turn, events.length))
  return events
}

/** The seq where the Nth-from-last message group starts, as the paginator computes it. */
function groupStart(event: SessionEvent): number {
  const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
  return sources === undefined || sources.length === 0 ? event.seq : Math.min(event.seq, ...sources)
}

/** Seq offset where the newest `keep` message groups begin. */
function windowStart(events: readonly SessionEvent[], keep: number): number {
  const starts: number[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if ((event as { surfaceOp?: string }).surfaceOp !== 'append') continue
    starts.push(groupStart(event))
  }
  return starts[starts.length - keep] as number
}

function scan(body: readonly SessionEvent[], options?: { retainMessages?: number; dropFromSeq?: number }) {
  const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('bounded-tail')))}`)
  const scanner = new SessionLogScanner(Buffer.concat([header, Buffer.from('\n')]), options)
  scanner.write(Buffer.from(`${body.map(event => JSON.stringify(event)).join('\n')}\n`))
  return scanner.finish()
}

describe('SessionLogScanner: bounded retention', () => {
  it('retains only the newest message groups plus the boundary that proves an older page exists', () => {
    const log = turnLog(4)
    const bounded = scan(log, { retainMessages: 3 })
    const full = scanLog(Buffer.concat([
      Buffer.from(`${JSON.stringify(toHeaderLine(meta('bounded-tail')))}\n`),
      Buffer.from(`${log.map(event => JSON.stringify(event)).join('\n')}\n`),
    ]))

    expect(bounded.truncated).toBe(true)
    // Four retained groups: the three asked for, plus one older to cut against.
    const start = windowStart(log, 4)
    expect(bounded.events).toEqual(full.events.slice(start))
    expect(bounded.events[0]?.seq).toBe(start)
    expect(bounded.events.at(-1)?.seq).toBe(log.at(-1)?.seq)
    expect(bounded.events.map(event => event.seq)).toEqual(
      Array.from({ length: (log.at(-1)?.seq ?? 0) - start + 1 }, (_, index) => start + index),
    )
  })

  it('never cuts inside a message: every retained group keeps its own chunks', () => {
    const log = turnLog(4)
    const bounded = scan(log, { retainMessages: 3 })
    const start = bounded.events[0]?.seq as number
    const messages = bounded.events.filter(
      event => event.type === 'user/message' || event.type === 'assistant/message',
    )

    expect(messages.length).toBeGreaterThan(0)
    // No retained group begins before the window: nothing is served half-cut.
    for (const message of messages) expect(groupStart(message)).toBeGreaterThanOrEqual(start)

    // A retained assistant group whose chunks precede its message event keeps them all.
    const chunked = messages.find(event =>
      event.type === 'assistant/message'
      && ((event as { sourceEventSeqs?: number[] }).sourceEventSeqs?.length ?? 0) > 0)
    expect(chunked).toBeDefined()
    const retainedSeqs = new Set(bounded.events.map(event => event.seq))
    for (let seq = groupStart(chunked as SessionEvent); seq <= (chunked as SessionEvent).seq; seq++) {
      expect(retainedSeqs.has(seq)).toBe(true)
    }
  })

  it('retains the whole log, and reports no truncation, without a retention request', () => {
    const log = turnLog(3)
    const unbounded = scan(log)

    expect(unbounded.truncated).toBe(false)
    expect(unbounded.events).toEqual(log)
  })

  it('still refuses a seq gap once trimming has begun', () => {
    const log = turnLog(4)
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('bounded-tail')))}`)
    const scanner = new SessionLogScanner(Buffer.concat([header, Buffer.from('\n')]), { retainMessages: 2 })
    const mutated = log.map(event => event.seq === log.at(-1)?.seq
      ? { ...event, seq: (log.at(-1)?.seq ?? 0) + 5 }
      : event)

    expect(() => { scanner.write(Buffer.from(`${mutated.map(event => JSON.stringify(event)).join('\n')}\n`)) })
      .toThrow(/seq gap in committed region/)
  })

  it('drops the region above an exclusive bound while still validating its contiguity', () => {
    const log = turnLog(4)
    const bound = log[Math.floor(log.length / 2)]?.seq as number
    const bounded = scan(log, { dropFromSeq: bound })

    expect(bounded.truncated).toBe(true)
    expect(bounded.events.every(event => event.seq < bound)).toBe(true)
    expect(bounded.events.at(-1)?.seq).toBe(bound - 1)
    // A gap ABOVE the cut is still refused: dropping events to save memory must
    // not turn a corrupt log into a silently shorter one.
    const header = Buffer.from(`${JSON.stringify(toHeaderLine(meta('bounded-tail')))}`)
    const scanner = new SessionLogScanner(Buffer.concat([header, Buffer.from('\n')]), { dropFromSeq: bound })
    const mutated = log.map(event => event.seq === (log.at(-1)?.seq as number)
      ? { ...event, seq: (log.at(-1)?.seq as number) + 3 }
      : event)
    expect(() => { scanner.write(Buffer.from(`${mutated.map(event => JSON.stringify(event)).join('\n')}\n`)) })
      .toThrow(/seq gap in committed region/)
  })
})

describe('JsonlSessionPersistence: bounded tail reads', () => {
  async function mounted(compression: 'zstd' | 'none'): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: await freshRoot(), compression })
    return ctx
  }

  it('serves a bounded window that is the exact suffix of the stored log', async () => {
    const ctx = await mounted('zstd')
    const header = meta('tail-window', '/work')
    const log = turnLog(6)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, log)

    const full = await ctx.sessionPersistence.load(header.id)
    const tail = await ctx.sessionPersistence.readTail(header.id, { retainMessages: 3 })

    expect(tail.truncated).toBe(true)
    expect(tail.events).toEqual(full.events.slice(windowStart(log, 4)))
  })

  it('serves the whole log, untruncated, when the window covers it', async () => {
    const ctx = await mounted('none')
    const header = meta('tail-whole', '/work')
    const log = turnLog(2)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, log)

    const full = await ctx.sessionPersistence.load(header.id)
    const tail = await ctx.sessionPersistence.readTail(header.id, { retainMessages: 50 })

    expect(tail.truncated).toBe(false)
    expect(tail.events).toEqual(full.events)
  })

  it('honours a backwards page bound and reads nothing at or above it', async () => {
    const ctx = await mounted('zstd')
    const header = meta('tail-bound', '/work')
    const log = turnLog(5)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, log)

    const bound = log[Math.floor(log.length / 2)]?.seq as number
    const tail = await ctx.sessionPersistence.readTail(header.id, { retainMessages: 2, beforeSeq: bound })

    expect(tail.truncated).toBe(true)
    expect(tail.events.every(event => event.seq < bound)).toBe(true)
    expect(tail.events.length).toBeGreaterThan(0)
    expect(tail.meta.id).toBe(SessionId('tail-bound'))
  })

  it('reports a missing session instead of inventing one', async () => {
    const ctx = await mounted('zstd')
    await expect(ctx.sessionPersistence.readTail(meta('absent', '/work').id, { retainMessages: 1 }))
      .rejects.toThrow(/not found/)
  })
})

describe('JsonlSessionPersistence: whole-log materialize budget', () => {
  async function mounted(budget: number): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, {
      root: await freshRoot(),
      compression: 'zstd',
      maxMaterializeBytes: budget,
    })
    return ctx
  }

  it('refuses a whole-log read past the budget while bounded reads still serve', async () => {
    // Zstandard compresses these synthetic turns hard, so the budget is set
    // below any artifact this fixture can produce.
    const ctx = await mounted(64)
    const header = meta('over-budget', '/work')
    const log = turnLog(4)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, log)

    // The operations that must hold the whole transcript refuse ...
    await expect(ctx.sessionPersistence.load(header.id)).rejects.toBeInstanceOf(SessionMaterializationLimitError)
    await expect(ctx.sessionPersistence.inspect(header.id)).rejects.toBeInstanceOf(SessionMaterializationLimitError)
    await expect(ctx.sessionPersistence.load(header.id)).rejects.toThrow(/too large to load whole/u)

    // ... while the transcript itself still serves, bounded.
    const tail = await ctx.sessionPersistence.readTail(header.id, { retainMessages: 3 })
    expect(tail.events.length).toBeGreaterThan(0)
    expect(tail.events.at(-1)?.seq).toBe(log.at(-1)?.seq)
    await expect(ctx.sessionPersistence.contains(header.id, event => event.type === 'turn/start'))
      .resolves.toBe(true)
  })

  it('loads a log inside the budget and can opt out of the ceiling entirely', async () => {
    const inside = await mounted(1024 * 1024)
    const header = meta('inside-budget', '/work')
    const log = turnLog(2)
    await inside.sessionPersistence.create(header)
    await inside.sessionPersistence.append(header.id, log)
    await expect(inside.sessionPersistence.load(header.id)).resolves.toMatchObject({ meta: { id: 'inside-budget' } })

    // 0 disables the ceiling: an explicit operator opt-out, not a silent default.
    const unlimited = await mounted(0)
    const other = meta('unlimited', '/work')
    await unlimited.sessionPersistence.create(other)
    await unlimited.sessionPersistence.append(other.id, turnLog(3))
    await expect(unlimited.sessionPersistence.load(other.id)).resolves.toBeDefined()
  })
})

describe('JsonlSessionPersistence: bounded existence checks', () => {
  it('answers a single-fact question without materializing the log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A budget far below the log size: only a bounded scan can answer.
    await ctx.plugin(JsonlSessionPersistence, {
      root: await freshRoot(),
      compression: 'zstd',
      maxMaterializeBytes: 512,
    })
    const header = meta('presence', '/work')
    const log = turnLog(5)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, log)

    const lastAssistant = log.filter(event => event.type === 'assistant/message').at(-1)
    const targetId = (lastAssistant as { data: { message: { id: string } } }).data.message.id
    const seen: string[] = []

    await expect(ctx.sessionPersistence.contains(header.id, (event) => {
      seen.push(event.type)
      return event.type === 'assistant/message'
        && (event as { data: { message: { id: string } } }).data.message.id === targetId
    })).resolves.toBe(true)
    // Every scanned event stays bounded: nothing above the 1-group window is retained.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).toContain('turn/start')

    await expect(ctx.sessionPersistence.contains(header.id, () => false)).resolves.toBe(false)
    await expect(ctx.sessionPersistence.contains(SessionId('absent'), () => true))
      .rejects.toThrow(/not found/u)
  })
})
