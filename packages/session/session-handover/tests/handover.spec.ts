/**
 * Session handover: the seed a successor inherits, and the moment the switch
 * fires. The point of both is that a long conversation keeps going in a log
 * that starts small again WITHOUT losing what the model would have seen.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageId, createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { buildSuccessorSeed, compactionCount, isCompactionRecord, replaceRange, apply } from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId

/** A user message event, optionally a surface replacement over a range. */
function userMessage(seq: number, text: string, replace?: { start: number; end: number }): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: freezeMessage(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })),
    surfaceOp: replace === undefined ? 'append' : { op: 'replace', ...replace },
    ...replace === undefined ? {} : { sourceEventSeqs: [replace.start, seq] },
  } as SessionEvent
}

/** A log with one compaction: originals, the summary record, the checkpoint, then a tail. */
function compactedLog(): SessionEvent[] {
  return [
    { type: 'request/header', seq: 0, time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    userMessage(2, 'first question'),
    { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: freezeMessage({
      id: MessageId('a-3'),
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
      source: { kind: 'model', ...{ provider: 'p', model: 'm' } },
    }) }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
    { type: 'compaction/summary', seq: 6, time: 6, data: {
      compactionId: 'c-1',
      summary: [{ type: 'text', text: 'SUMMARY OF TURNS 1' }],
      shadowedRange: { start: 2, end: 3 },
      shadowedSeqs: [2, 3],
      shadowedTokenCount: 42,
    } },
    userMessage(7, 'SUMMARY OF TURNS 1', { start: 2, end: 3 }),
    userMessage(8, 'second question'),
    { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

describe('buildSuccessorSeed', () => {
  it('inherits the compacted view: the checkpoint as an append plus everything after it', () => {
    const log = compactedLog()
    const built = buildSuccessorSeed(log)

    expect(built).toBeDefined()
    const seed = built?.seed ?? []
    // The newest request header comes along so the successor starts on the same model.
    expect(seed[0]?.type).toBe('request/header')
    // The checkpoint IS the summary the model was about to see.
    expect(seed[1]?.type).toBe('user/message')
    expect((seed[1]?.data as { content: { text: string }[] }).content[0]?.text).toBe('SUMMARY OF TURNS 1')
    // Only the post-checkpoint tail follows, and no compaction bookkeeping survives.
    expect(seed.map(event => event.type)).toEqual([
      'request/header',
      'user/message',
      'user/message',
      'turn/end',
    ])
    expect(seed.some(isCompactionRecord)).toBe(false)
    // Replacement ops and citations of shadowed originals are gone: their targets
    // are not in the seed, so a range pointing at them could not validate.
    expect(seed.every(event => replaceRange(event) === undefined)).toBe(true)
    expect(seed.every(event => (event as { sourceEventSeqs?: number[] }).sourceEventSeqs === undefined)).toBe(true)
    // Seqs are contiguous from 0, which is what a fresh log requires.
    expect(seed.map(event => event.seq)).toEqual(seed.map((_, index) => index))
  })

  it('drops tail events a later replacement already shadowed', () => {
    const log = compactedLog()
    // A later tool-result-style prune replaces the tail's own message.
    log.push({
      type: 'user/message',
      seq: 10,
      time: 10,
      data: freezeMessage(createUserMessage({
        content: [{ type: 'text', text: 'replacement of the second question' }],
        source: { kind: 'user' },
      })),
      surfaceOp: { op: 'replace', start: 8, end: 8 },
      sourceEventSeqs: [8, 10],
    } as SessionEvent)

    const seed = buildSuccessorSeed(log)?.seed ?? []
    const texts = seed
      .filter(event => event.type === 'user/message')
      .map(event => ((event.data as { content: { text: string }[] }).content[0]?.text))
    expect(texts).toEqual(['SUMMARY OF TURNS 1', 'replacement of the second question'])
    expect(seed.every(event => replaceRange(event) === undefined)).toBe(true)
  })

  it('refuses to inherit a log that never compacted', () => {
    const log = compactedLog().filter(event => !isCompactionRecord(event) && replaceRange(event) === undefined)
    expect(buildSuccessorSeed(log)).toBeUndefined()
    expect(compactionCount(log)).toBe(0)
    expect(compactionCount(compactedLog())).toBe(1)
  })
})

/** Minimal host context: the services the plugin injects, with spies. */
function harness(options: { threshold?: number; dryRun?: boolean } = {}) {
  const ctx = new Context()
  const created: { sessionId: SessionId; seed: readonly SessionEvent[]; meta: Record<string, unknown> }[] = []
  const archived: SessionId[] = []
  const attached: SessionId[] = []
  ctx.provide('agents', {
    get: () => undefined,
    create: vi.fn(async (input: { sessionId: SessionId; seed?: readonly SessionEvent[]; meta?: Record<string, unknown> }) => {
      created.push({ sessionId: input.sessionId, seed: input.seed ?? [], meta: input.meta ?? {} })
      return {}
    }),
  } as never)
  ctx.provide('agentPresets', {
    resolve: async (id: string | undefined) => ({ id: id ?? 'standard' }),
    mount: async () => {},
  } as never)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async () => ({ id: 'ws', attachSession: async (id: SessionId) => { attached.push(id) } }),
    archiveSession: async (id: SessionId) => { archived.push(id) },
  } as never)

  const notices: unknown[] = []
  ctx.on('session/handover', payload => { notices.push(payload) })
  const dispose = apply(ctx, {
    enabled: true,
    compactionsPerSession: options.threshold ?? 1,
    ...options.dryRun === true ? { dryRun: true } : {},
  })

  const session = {
    id: sid('session-predecessor'),
    header: { version: 0, id: sid('session-predecessor'), createdAt: 1, cwd: '/work', agentPreset: 'standard' },
    get events(): readonly SessionEvent[] { return log },
  } as unknown as Session
  let log: SessionEvent[] = []
  return { ctx, dispose, created, archived, attached, notices, session, setLog: (next: SessionEvent[]) => { log = next } }
}

describe('apply: handover timing', () => {
  it('arms on a compaction and moves the session at the next turn boundary', async () => {
    const h = harness()
    h.setLog(compactedLog().slice(0, 7))
    // The compaction record arrives mid-turn: nothing may move yet.
    h.ctx.emit('session/event', h.session, h.session.events[6] as SessionEvent)
    expect(h.created).toHaveLength(0)

    h.setLog(compactedLog())
    h.ctx.emit('session/event', h.session, h.session.events[9] as SessionEvent)
    await vi.waitFor(() => { expect(h.created).toHaveLength(1) })

    const [successor] = h.created
    expect(successor?.sessionId).not.toBe(h.session.id)
    expect(successor?.meta['parentSession']).toBe('session-predecessor')
    expect(successor?.meta['cwd']).toBe('/work')
    expect(successor?.meta['agentPreset']).toBe('standard')
    expect(successor?.meta['seedLength']).toBe(successor?.seed.length)
    expect(successor?.seed.some(isCompactionRecord)).toBe(false)
    expect(h.attached).toEqual([successor?.sessionId])
    expect(h.archived).toEqual([h.session.id])
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]).toMatchObject({
      predecessorId: 'session-predecessor',
      successorId: successor?.sessionId,
      seedLength: successor?.seed.length,
    })
    h.dispose()
  })

  it('stays put below the threshold and never switches in dry-run mode', async () => {
    const below = harness({ threshold: 3 })
    below.setLog(compactedLog())
    below.ctx.emit('session/event', below.session, below.session.events[6] as SessionEvent)
    below.ctx.emit('session/event', below.session, below.session.events[9] as SessionEvent)
    await Promise.resolve()
    expect(below.created).toHaveLength(0)
    expect(below.archived).toHaveLength(0)
    below.dispose()

    const dry = harness({ dryRun: true })
    dry.setLog(compactedLog())
    dry.ctx.emit('session/event', dry.session, dry.session.events[6] as SessionEvent)
    dry.ctx.emit('session/event', dry.session, dry.session.events[9] as SessionEvent)
    await Promise.resolve()
    expect(dry.created).toHaveLength(0)
    expect(dry.notices).toHaveLength(0)
    dry.dispose()
  })
})

describe('the inherited seed is a loadable session log', () => {
  it('passes the same validation a cold resume runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-handover-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
      const built = buildSuccessorSeed(compactedLog())
      expect(built).toBeDefined()
      const successorId = sid('session-successor')
      if (built === undefined) throw new Error('expected a compaction checkpoint to inherit')
      const session = ctx.sessions.create(successorId, {
        seed: built.seed,
        meta: {
          cwd: '/work',
          seedLength: built.seed.length,
          parentSession: sid('session-predecessor'),
        },
      })
      await ctx.sessions.flush(session)

      // A cold resume reads the stored log through exactly this path: if the
      // seed were not a valid log, THIS is where it would fail — not at
      // creation, which is why the migration in this repo is verified the same way.
      const loaded = await ctx.sessionPersistence.load(successorId)
      expect(loaded.meta.id).toBe(successorId)
      expect(loaded.meta.parentSession).toBe('session-predecessor')
      expect(loaded.events.some(isCompactionRecord)).toBe(false)
      // The store appends its own end-of-seed marker; everything before it is
      // exactly the inherited seed, which is what makes the log loadable at all.
      expect(loaded.events.map(event => event.type)).toEqual([
        ...(built?.seed ?? []).map(event => event.type),
        'session/end-seed',
      ])
      expect(loaded.events.every(event => replaceRange(event) === undefined)).toBe(true)
      // The summary the model was about to see is the first message it sees now.
      const firstMessage = loaded.events.find(event => event.type === 'user/message')
      expect((firstMessage?.data as { content: { text: string }[] }).content[0]?.text).toBe('SUMMARY OF TURNS 1')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
